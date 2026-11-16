/**
 * `forge context` 的 CLI 侧（S21）—— 这里测的是**参数与输出通道**，
 * 不是判定（判定在 `packages/core/test/retrieve.test.ts`）。
 *
 * 四条：
 * 1. **stdout 只有那段注入**：它能被原样重定向进上下文，混进一行统计就毁了这个用途；
 * 2. 预算下限不许绕过（低于它，"这不是全库"那句话自己就装不下）；
 * 3. `--types` 收窄类型，不认识的类型**报错而不是忽略**；
 * 4. 注入块在 stdout，计数在 stderr，且退出码为 0。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSION, renderAssetDocument, type AssetFrontMatter } from "@forge/schema";

const REPO = process.cwd();
const CLI = join(REPO, "apps", "cli", "src", "main.ts");
const ANCHOR = "检索优先，绝不预加载整个大脑";

function temp(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "forge-context-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * @param {string} root
 * @param {("state" | "decision")} type
 * @param {string} id
 * @param {string} title
 * @param {string} body
 * @param {string | null} subject
 * @returns {void}
 */
function writeAsset(root: string, type: "state" | "decision", id: string, title: string, body: string, subject: string | null): void {
  const frontMatter: AssetFrontMatter = {
    schema_version: SCHEMA_VERSION,
    id,
    type,
    status: type === "decision" ? "accepted" : "active",
    created: "2026-01-01",
    last_confirmed: type === "state" ? "2026-11-01" : null,
    supersedes: null,
    origin_incident: null,
    subject,
    sources: [`file://docs/note.md#t:${ANCHOR}`],
    sensitivity: "internal",
    confidence: 0.8,
  };
  const dir = join(root, "assets", type === "decision" ? "dec" : "state");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.md`), renderAssetDocument(frontMatter, `# ${title}\n\n${body}`), "utf8");
}

function seeded(): { root: string; cleanup: () => void } {
  const vault = temp();
  mkdirSync(join(vault.root, "docs"), { recursive: true });
  writeFileSync(join(vault.root, "docs", "note.md"), `# 说明\n\n${ANCHOR}。\n`, "utf8");
  writeAsset(
    vault.root,
    "state",
    "state_01M6Q2FD00NVKBVBH80QD63VSX",
    "存储后端用 SQLite",
    "## 当前状态\n\n索引层用 node:sqlite。\n",
    "索引层的存储后端",
  );
  writeAsset(
    vault.root,
    "decision",
    "dec_01M6Q2FD00CQS8ZBPRX44R5C3P",
    "配色定成深色",
    "## 问题\n\n亮还是暗。\n\n## 考虑过的选项\n\n1. 亮\n2. 暗\n\n## 选定\n\n**深色**。\n\n## 后果\n\n费眼。\n",
    null,
  );
  return vault;
}

/**
 * @param {string[]} args
 * @returns {{status: number, stdout: string, stderr: string}}
 */
function forge(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("node", [CLI, ...args], {
    cwd: REPO,
    encoding: "utf8",
    env: { PATH: process.env["PATH"] ?? "" },
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

test("stdout 只有那段注入：计数与提示全部走 stderr", () => {
  const vault = seeded();
  try {
    const result = forge(["context", "索引层的存储后端", "--vault", vault.root, "--today", "2026-11-06"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^# 资产库 · 检索注入/);
    assert.match(result.stdout, /索引层用 node:sqlite/);
    // 注入块自己会写"参与打分的 N 条里…"（那是它的一部分）；统计**行**只能出现在 stderr。
    assert.doesNotMatch(result.stdout, /^· 参与打分/m, "统计行混进 stdout 就没法原样重定向了");
    assert.match(result.stderr, /^· 参与打分/m);
  } finally {
    vault.cleanup();
  }
});

test("预算下限：低于它就应该报错，而不是悄悄给一个默认值", () => {
  const vault = seeded();
  try {
    const result = forge(["context", "索引层", "--vault", vault.root, "--budget", "10"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /预算下限|不小于/);
  } finally {
    vault.cleanup();
  }
});

test("`--types`：能收窄；不认识的类型**报错而不是忽略**", () => {
  const vault = seeded();
  try {
    // 查询会被原样回显在元信息里，所以判据要看**条目**，不看整段文字。
    const narrowed = forge(["context", "索引层 配色", "--vault", vault.root, "--types", "state"]);
    assert.equal(narrowed.status, 0, narrowed.stderr);
    assert.match(narrowed.stdout, /state_01M6Q2FD00NVKBVBH80QD63VSX/);
    assert.doesNotMatch(narrowed.stdout, /dec_01M6Q2FD00CQS8ZBPRX44R5C3P/, "decision 被 --types 挡在外面");

    const unknown = forge(["context", "索引层", "--vault", vault.root, "--types", "state,记忆"]);
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /不认识的类型/);
  } finally {
    vault.cleanup();
  }
});

test("没有查询就报用法（退出码 2），不许默默给一段空上下文", () => {
  const vault = seeded();
  try {
    const result = forge(["context", "--vault", vault.root]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /需要一句查询/);
  } finally {
    vault.cleanup();
  }
});

test("查不到相关条目时：退出码 0（这不是错误），但注入块里写清「不是库里没有」", () => {
  const vault = seeded();
  try {
    const result = forge(["context", "企鹅的迁徙路线", "--vault", vault.root]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /这不是「库里没有」/);
  } finally {
    vault.cleanup();
  }
});

test("emit v2：`--skill` 与 `--evals` 各自产出确定的文件", () => {
  const vault = seeded();
  const out = temp();
  try {
    const result = forge([
      "emit",
      "--vault",
      vault.root,
      "--out",
      out.root,
      "--skill",
      "--evals",
      "--title",
      "测试库",
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /emit 完成/);

    // v1 的三样还在（多出口是**增加**，不是替换）。
    const skill = spawnSync("node", ["-e", `process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(join(out.root, "SKILL.md"))}, "utf8"))`], {
      encoding: "utf8",
    });
    assert.match(skill.stdout, /^---\nname: forge-library/);
    assert.match(skill.stdout, /references\/0001-/, "决策的全文只在 references 里（不预加载）");

    const exported = JSON.parse(
      spawnSync("node", ["-e", `process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(join(out.root, "evals", "extraction", "cases.json"))}, "utf8"))`], {
        encoding: "utf8",
      }).stdout,
    ) as Record<string, any>;
    assert.equal(exported["review"]["status"], "proposed", "机器导出不许自称已确认（ADR-0020）");

    // 逐字节确定：再跑一次，`--check` 必须一致。
    const check = forge(["emit", "--vault", vault.root, "--out", out.root, "--skill", "--evals", "--title", "测试库", "--check"]);
    assert.equal(check.status, 0, check.stderr);
    assert.match(check.stdout, /逐字节相同/);
  } finally {
    vault.cleanup();
    out.cleanup();
  }
});
