#!/usr/bin/env node
// @ts-check
/**
 * 退出条件演练：**一个故意写错的改动，必须被拦住。**
 *
 * 它在**临时克隆**里跑，绝不碰你的工作区（否则演练本身就在制造脏状态）。
 * 每个场景都声明"期望的退出码"，然后如实比对；任何一项与期望不符 → 本脚本红。
 *
 * 这是 Phase 0 的验收脚本，也是后续阶段的模板：
 * 以后每加一道闸门（provenance、emit 快照、eval 阈值），就在这里加一个场景。
 *
 * 用法：
 *   pnpm gate:rehearse            # 需要至少一个提交
 *   pnpm gate:rehearse -- --keep  # 保留克隆目录，便于手工查看
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { repoRoot } from "./lib/git.mjs";

const keep = process.argv.includes("--keep");
const root = repoRoot() ?? process.cwd();

/**
 * 注意 `shell` 只在 pnpm 上开：Windows 上 pnpm 是 .cmd，必须走 shell；
 * 而 git / node 走 shell 会被重新分词，带空格的提交信息会被拆成 pathspec
 * （这正是第一次演练里 A2/C1 假失败的原因）。
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, env?: Record<string, string | undefined> }} [options]
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
    shell: process.platform === "win32" && command === "pnpm",
  });
  return {
    status: result.status ?? 1,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

const head = run("git", ["rev-parse", "--verify", "HEAD"], { cwd: root });
if (head.status !== 0) {
  process.stderr.write("✗ 演练需要至少一个提交（先 git commit，再跑 pnpm gate:rehearse）。\n");
  process.exit(1);
}
const baseSha = head.stdout.trim();

const workdir = mkdtempSync(join(tmpdir(), "forge-rehearse-"));
const clone = join(workdir, "repo");
process.stdout.write(`\n闸门演练 · 退出条件：故意写错的改动必须被拦住\n仓库副本：${clone}\n\n`);

const cloned = run("git", ["clone", "--quiet", "--no-hardlinks", root, clone], { cwd: workdir });
if (cloned.status !== 0) {
  process.stderr.write(`✗ 克隆失败：${cloned.stderr}\n`);
  process.exit(1);
}
run("git", ["config", "core.hooksPath", ".githooks"], { cwd: clone });
run("git", ["config", "user.name", "rehearsal"], { cwd: clone });
run("git", ["config", "user.email", "rehearsal@forge.local"], { cwd: clone });

/** @type {Array<{ title: string, steps: Array<{ name: string, expect: number, expectCode?: string | undefined, observed: number, code?: string | undefined, output: string, note: string }> }>} */
const scenarios = [];

/**
 * @param {string} title
 * @param {Array<{ name: string, expect: number, run: () => { status: number, output: string }, expectCode?: string, note: string }>} steps
 */
function scenario(title, steps) {
  const results = steps.map((step) => {
    /** @type {number} */
    let status;
    /** @type {string} */
    let output;
    try {
      const result = step.run();
      status = result.status;
      output = result.output;
    } catch (error) {
      // 演练脚本自己崩掉不能算"闸门拦住了"：记为未达预期，并保留原因。
      status = -1;
      output = `演练步骤抛异常：${error instanceof Error ? error.message : String(error)}`;
    }
    const code =
      step.expectCode !== undefined && output.includes(step.expectCode) ? step.expectCode : undefined;
    return {
      name: step.name,
      expect: step.expect,
      // expectCode 必须一起带出来：否则断言里读到的永远是 undefined，
      // "理由要对"这条就退化成了假绿灯（第一次写这里就踩了这个坑）。
      expectCode: step.expectCode,
      observed: status,
      code,
      output,
      note: step.note,
    };
  });
  scenarios.push({ title, steps: results });
}

/**
 * 每个场景都从不可变的 baseSha 开一条新分支。
 * 不能 reset 到 HEAD 或 main：场景 A 会提交（--no-verify 那步），
 * 若在 main 上提交，后面的场景就会在一个"被删掉校验的仓库"里跑。
 *
 * @param {string} branch
 */
function resetClone(branch) {
  run("git", ["checkout", "--quiet", "--force", "-B", branch, baseSha], { cwd: clone });
  run("git", ["reset", "--quiet", "--hard", baseSha], { cwd: clone });
  run("git", ["clean", "-qfd"], { cwd: clone });
}

// ── 场景 A：删掉一处校验（受保护路径，且变更集里没有 ADR）────────────────
resetClone("rehearsal/a-delete-check");
scenario("A · 删掉一处校验：git rm scripts/gates/lib/policy.mjs", [
  {
    name: "A1 本地 pre-commit 拦住",
    expect: 1,
    expectCode: "R2_PROTECTED_WITHOUT_ADR",
    note: "闸门 2",
    run: () => {
      run("git", ["rm", "-q", "scripts/gates/lib/policy.mjs"], { cwd: clone });
      const result = run("git", ["commit", "-m", "chore: 删掉一处校验"], { cwd: clone });
      return { status: result.status, output: `${result.stdout}${result.stderr}` };
    },
  },
  {
    name: "A2 --no-verify 能跳过本地闸门（已知绕过方式）",
    expect: 0,
    note: "这正是为什么权威必须在 CI：本地闸门只做早期反馈",
    run: () => {
      const result = run("git", ["commit", "--no-verify", "-m", "chore: 删掉一处校验"], { cwd: clone });
      return { status: result.status, output: `${result.stdout}${result.stderr}` };
    },
  },
  {
    name: "A3 CI（闸门 3·不可信版）连判定都跑不起来",
    expect: 1,
    note: "结构缺陷的实证：工作树里的 policy.mjs 被删 → 检查者自己没了（ERR_MODULE_NOT_FOUND）",
    run: () => {
      const result = run(process.execPath, ["scripts/gates/ci.mjs", "--guard-only"], {
        cwd: clone,
        env: { CI: "true", FORGE_BASE_SHA: baseSha },
      });
      return { status: result.status, output: `${result.stdout}${result.stderr}` };
    },
  },
  {
    name: "A4 CI（闸门 3·可信版）用基线规则判定 → 拦住",
    expect: 1,
    expectCode: "R2_PROTECTED_WITHOUT_ADR",
    note: "闸门代码取自基线修订：被检查者改不到检查者（ADR-0005）",
    run: () => {
      const result = run(process.execPath, ["scripts/gates/trusted-ci.mjs", "--guard-only", "--base", baseSha], {
        cwd: clone,
        env: { CI: "true", FORGE_BASE_SHA: baseSha },
      });
      return { status: result.status, output: `${result.stdout}${result.stderr}` };
    },
  },
]);

// ── 场景 B：用户数据进 repo ───────────────────────────────────────────────
resetClone("rehearsal/b-user-data");
scenario("B · 把用户数据提交进 repo：git add -f data/assets/dec/x.md", [
  {
    name: "B1 本地 pre-commit 拦住",
    expect: 1,
    expectCode: "R1_USER_DATA_IN_REPO",
    note: "闸门 2",
    run: () => {
      const target = join(clone, "data", "assets", "dec", "x.md");
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, "# 用户的真实决策\n");
      run("git", ["add", "-f", "data/assets/dec/x.md"], { cwd: clone });
      const result = run("git", ["commit", "-m", "chore: 顺手把数据提交了"], { cwd: clone });
      return { status: result.status, output: `${result.stdout}${result.stderr}` };
    },
  },
  {
    name: "B2 CI（闸门 3）仍然拦住",
    expect: 1,
    expectCode: "R1_USER_DATA_IN_REPO",
    note: "required status check",
    run: () => {
      run("git", ["commit", "--no-verify", "-m", "chore: 顺手把数据提交了"], { cwd: clone });
      const result = run(process.execPath, ["scripts/gates/ci.mjs", "--guard-only"], {
        cwd: clone,
        env: { CI: "true", FORGE_BASE_SHA: baseSha },
      });
      return { status: result.status, output: `${result.stdout}${result.stderr}` };
    },
  },
]);

// ── 场景 C：正例（闸门不能天天误报，否则会被绕过）────────────────────────
resetClone("rehearsal/c-legit");
scenario("C · 正例：带 ADR 的正当变更", [
  {
    name: "C1 本地 pre-commit 放行",
    expect: 0,
    note: "同一变更集里有新增 ADR → 受保护路径的改动被允许",
    run: () => {
      writeFileSync(
        join(clone, "docs", "adr", "0099-rehearsal-fixture.md"),
        "---\nid: adr_0099\ntype: decision\n---\n\n## 问题\n演练用占位 ADR。\n",
      );
      writeFileSync(
        join(clone, "scripts", "gates", "lib", "policy.mjs"),
        `${readFileSync(join(clone, "scripts", "gates", "lib", "policy.mjs"), "utf8")}\n// rehearsal touch\n`,
      );
      run("git", ["add", "-A"], { cwd: clone });
      const result = run("git", ["commit", "-m", "feat: 调整闸门策略并记录 ADR"], { cwd: clone });
      return { status: result.status, output: `${result.stdout}${result.stderr}` };
    },
  },
  {
    name: "C2 CI（闸门 3）放行",
    expect: 0,
    note: "正例必须绿，否则闸门会因为烦人而被绕过",
    run: () => {
      const result = run(process.execPath, ["scripts/gates/ci.mjs", "--guard-only"], {
        cwd: clone,
        env: { CI: "true", FORGE_BASE_SHA: baseSha },
      });
      return { status: result.status, output: `${result.stdout}${result.stderr}` };
    },
  },
]);

// ── 报告 ─────────────────────────────────────────────────────────────────
let failures = 0;
for (const item of scenarios) {
  process.stdout.write(`${item.title}\n`);
  for (const step of item.steps) {
    // 两道断言，缺一不可：退出码要对，**且理由要对**。
    // 只看退出码会出现"因为别的原因失败"被当成"闸门拦住了"的假绿灯。
    const codeOk = step.expectCode === undefined || step.code === step.expectCode;
    const pass = step.observed === step.expect && codeOk;
    if (!pass) failures += 1;
    const mark = pass ? "✓" : "✗";
    process.stdout.write(
      `  ${mark} ${step.name}\n      期望 exit=${step.expect}` +
        `${step.expectCode !== undefined ? ` + ${step.expectCode}` : ""}，` +
        `实际 exit=${step.observed}${step.code !== undefined ? ` + ${step.code}` : ""}\n      ${step.note}\n`,
    );
    if (!pass) {
      process.stdout.write(
        `      输出：${step.output.trim().split("\n").slice(0, 8).join("\n      ")}\n`,
      );
    }
  }
  process.stdout.write("\n");
}

const total = scenarios.reduce((sum, item) => sum + item.steps.length, 0);
if (!keep) rmSync(workdir, { recursive: true, force: true });
else process.stdout.write(`（保留副本：${clone}）\n`);

if (failures > 0) {
  process.stderr.write(`✗ 退出条件未满足：${total - failures}/${total} 项符合预期。\n`);
  process.exit(1);
}

process.stdout.write(
  `✓ 退出条件满足：${total}/${total} 项符合预期。\n` +
    "  故意写错的改动被闸门 2 拦住；--no-verify 只跳过了本地闸门，闸门 3 依然拦住。\n\n",
);
process.exit(0);
