#!/usr/bin/env node
// @ts-check
/**
 * 闸门 3 · required status check（CI 的权威判定）
 *
 * 这是**唯一**有权威的闸门。理由（ADR-0001）：
 * 本地钩子全部可被绕过（--no-verify、改 hooksPath、直接调 git 库），
 * 所以本地闸门只负责"尽快失败"，真正的判定必须发生在服务端、
 * 在一条人改不了的路径上。
 *
 * 它做四件事：
 *   1. 用与本地完全相同的 policy 重判变更集（这就是 --no-verify 无效的原因）
 *   2. 检查"闸门本身是否还完整"——agent 拆掉自己的 hook，这里会红
 *   3. 三个补充判定：schema 一致性（S7）、资产出处（S6）、eval 阈值（S12–S14）
 *   4. 跑 lint / typecheck / test
 *
 * 用法：
 *   pnpm gate:ci              完整判定
 *   node scripts/gates/ci.mjs --guard-only   只做 1+2（不需要 node_modules，演练用）
 *   node scripts/gates/ci.mjs --subgates-only 只做 1+2+3（不含 lint/typecheck/test，验判定路径用）
 *
 * 为什么 3 与 4 只在完整模式跑：`--guard-only` 要能在没有依赖的临时克隆里跑得动
 * （Phase 0 的演练靠这一点）。降级是**记账的降级**——三个子闸门自己会打印
 * "本次没查"，而不是安静地返回绿（见 lib/report.mjs 的 degrade）。
 *
 * 为什么 eval 阈值也是**子闸门**而不是散在这里的一段：见脚本自己的注释——
 * 判定住在 `evals/runner/gate.ts`，这里只负责编排与退出码。
 */
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { adrRefsSince, changesBetween, repoRoot, resolveBaseRef } from "./lib/git.mjs";
import { evaluateChangeset } from "./lib/policy.mjs";
import { checkHarness, REQUIRED_CHECK_NAME } from "./lib/harness.mjs";
import { fail, formatFindings, formatViolations, ok } from "./lib/report.mjs";

const guardOnly = process.argv.includes("--guard-only");
const subgatesOnly = process.argv.includes("--subgates-only");
const root = repoRoot() ?? process.cwd();
/**
 * 子闸门（consistency / assets / evals）的**代码根**。
 *
 * `trusted-ci.mjs` 会把它指向基线修订的临时 worktree；数据根仍然是当前工作树。
 * 这样第 3 步的判定者也不是被检查者（bypass-matrix 6.10 / ADR-0043）。
 * 直接跑本文件（本地早期反馈）时两者相同，行为与以前一致。
 */
const judgeRoot = process.env.FORGE_JUDGE_ROOT ? resolve(process.env.FORGE_JUDGE_ROOT) : root;
const env = process.env;

let failed = false;

/**
 * @param {string} script
 * @returns {boolean}
 */
function runGateScript(script) {
  const result = spawnSync("node", [join(judgeRoot, "scripts/gates", script)], {
    cwd: root,
    stdio: "inherit",
    // 数据根显式传下去：子闸门的 import 走 codeRoot，读资产/黄金集走 dataRoot。
    env: { ...env, FORGE_JUDGE_DATA_ROOT: root },
  });
  return result.status === 0;
}

// ── 1. 变更集判定（与 pre-commit 同一套 policy）────────────────────────────
const base = resolveBaseRef({ cwd: root, env });
const harnessFindings = checkHarness({ root, env });
const heavyChecks = guardOnly || subgatesOnly
  ? []
  : [
      { name: "lint", command: "lint" },
      { name: "typecheck", command: "typecheck" },
      { name: "test", command: "test" },
    ];

ok(`[gate3] required check = \`${REQUIRED_CHECK_NAME}\``);

if (base === null) {
  // 不静默跳过：没有基线就说清楚，并把它当成一次可见的降级。
  process.stderr.write(
    "[gate3] ⚠ 找不到比较基线（首个提交 / 浅克隆）：本次只做 harness 完整性检查，" +
      "未判定变更集。CI 里应设置 FORGE_BASE_SHA 或 fetch-depth: 0。\n",
  );
} else {
  const changes = changesBetween(base, "HEAD", { cwd: root });
  const adrRefs = adrRefsSince(base, { cwd: root });
  const verdict = evaluateChangeset(changes, { adrRefs });
  ok(`[gate3] 变更集：${changes.length} 个文件（基线 ${base.slice(0, 8)}）`);
  if (!verdict.ok) {
    fail(formatViolations(verdict.violations));
    failed = true;
  }
}

// ── 2. 闸门本身是否完整 ───────────────────────────────────────────────────
if (harnessFindings.length > 0) {
  fail(formatFindings(harnessFindings));
  failed = true;
}

// ── 3. 补充判定：schema 一致性（S7）· 资产出处（S6）· eval 阈值（S12–S14）──
if (!guardOnly) {
  if (judgeRoot !== root) {
    ok(`[gate3] 子闸门代码取自基线修订 ${judgeRoot}；判定对象是当前工作树 ${root}`);
  }
  for (const script of ["consistency.mjs", "assets.mjs", "evals.mjs"]) {
    ok(`[gate3] node scripts/gates/${script} …`);
    if (!runGateScript(script)) {
      failed = true;
    }
  }
}

// ── 4. 重活：lint / typecheck / test ─────────────────────────────────────
for (const check of heavyChecks) {
  ok(`[gate3] pnpm ${check.command} …`);
  const result = spawnSync("pnpm", ["--silent", check.command], {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    fail(`✗ [gate3] pnpm ${check.command} 未通过`);
    failed = true;
  }
}

if (failed) {
  fail("\n✗ 闸门 3 判定：红。main 不接受这个状态（branch rule 会阻止合并）。\n");
  process.exit(1);
}

ok("\n✓ 闸门 3 判定：绿。\n");
process.exit(0);
