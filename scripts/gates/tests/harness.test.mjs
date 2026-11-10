// @ts-check
/**
 * harness 完整性检查的测试。
 *
 * 最有价值的一条是「真实仓库必须通过」：它保证 harness.mjs 的判定
 * 与仓库里实际存在的闸门文件没有漂移。
 * 其余用例是变异测试：把闸门逐个拆掉，检查必须变红。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkHarness } from "../lib/harness.mjs";

const REAL_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const CI_ENV = { CI: "true" };

/** 复制真实 harness 文件到一个临时目录，便于做变异。 */
function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "forge-harness-"));
  for (const entry of [".claude", ".githooks", join(".github", "workflows"), "AGENTS.md"]) {
    cpSync(join(REAL_ROOT, entry), join(root, entry), { recursive: true });
  }
  // 闸门 3 的两个编排入口也要有：harness 会读它们（`G3_EVAL_GATE_MISSING`），
  // 夹具里缺了就会让**每条**变异用例都顺带多报一个码，把真正要测的那个淹掉。
  mkdirSync(join(root, "scripts", "gates"), { recursive: true });
  for (const entry of ["ci.mjs", "evals.mjs"]) {
    cpSync(join(REAL_ROOT, "scripts", "gates", entry), join(root, "scripts", "gates", entry));
  }
  return root;
}

/**
 * @param {string} root
 * @param {string} relativePath
 * @param {(text: string) => string} mutate
 */
function mutate(root, relativePath, mutate) {
  const path = join(root, relativePath);
  writeFileSync(path, mutate(readFileSync(path, "utf8")));
}

const codes = (/** @type {import('../lib/harness.mjs').Finding[]} */ findings) =>
  findings.map((finding) => finding.code);

test("真实仓库：五道闸门齐全，完整性检查通过", () => {
  const findings = checkHarness({ root: REAL_ROOT, env: CI_ENV });
  assert.deepEqual(codes(findings), [], `不应有 findings，实际：${JSON.stringify(findings, null, 2)}`);
});

test("空目录：每一道闸门都被判定为缺失（不能静默通过）", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-empty-"));
  try {
    const found = codes(checkHarness({ root, env: CI_ENV }));
    for (const expected of [
      "G0_AGENTS_MD_MISSING",
      "G1_AGENT_HOOK_MISSING",
      "G2_GIT_HOOK_MISSING",
      "G3_CI_WORKFLOW_MISSING",
      "G3_EVAL_GATE_MISSING",
      "G5_RELEASE_WORKFLOW_MISSING",
    ]) {
      assert.ok(found.includes(expected), `缺少 ${expected}，实际：${found.join(", ")}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("变异：把 agent hook 摘掉 —— 必须变红", () => {
  const root = fixtureRoot();
  try {
    mutate(root, join(".claude", "settings.json"), (text) => {
      const settings = JSON.parse(text);
      settings.hooks.PreToolUse = [];
      return JSON.stringify(settings, null, 2);
    });
    assert.ok(codes(checkHarness({ root, env: CI_ENV })).includes("G1_AGENT_HOOK_UNWIRED"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("变异：把 CI 里 required job 改名 —— 必须变红", () => {
  const root = fixtureRoot();
  try {
    mutate(root, join(".github", "workflows", "ci.yml"), (text) =>
      text.replace(/^ {2}gates:/m, "  tests:"),
    );
    assert.ok(codes(checkHarness({ root, env: CI_ENV })).includes("G3_REQUIRED_JOB_MISSING"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("变异：CI 不再执行 gate:ci —— 必须变红", () => {
  const root = fixtureRoot();
  try {
    mutate(root, join(".github", "workflows", "ci.yml"), (text) =>
      text.replace("pnpm gate:ci", "echo skipped"),
    );
    assert.ok(codes(checkHarness({ root, env: CI_ENV })).includes("G3_CI_ENTRY_MISSING"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("变异：去掉可信判定（判定者变回工作树自己）—— 必须变红", () => {
  const root = fixtureRoot();
  try {
    mutate(root, join(".github", "workflows", "ci.yml"), (text) =>
      text.replace("pnpm gate:trusted", "echo skipped"),
    );
    assert.ok(codes(checkHarness({ root, env: CI_ENV })).includes("G3_TRUSTED_JUDGE_MISSING"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("变异：浅克隆（diff 会为空，闸门静默空转）—— 必须变红", () => {
  const root = fixtureRoot();
  try {
    mutate(root, join(".github", "workflows", "ci.yml"), (text) =>
      text.replace("fetch-depth: 0", "fetch-depth: 1"),
    );
    assert.ok(codes(checkHarness({ root, env: CI_ENV })).includes("G3_SHALLOW_CLONE"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("变异：eval 阈值子闸门被整个删掉 —— 必须变红", () => {
  const root = fixtureRoot();
  try {
    rmSync(join(root, "scripts", "gates", "evals.mjs"), { force: true });
    assert.ok(codes(checkHarness({ root, env: CI_ENV })).includes("G3_EVAL_GATE_MISSING"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("变异：子闸门还在，但 ci.mjs 不再调用它 —— 必须变红（最省事的绕过方式）", () => {
  const root = fixtureRoot();
  try {
    // 只摘掉那一行调用，文件本身留着——这样"文件存在"的检查会放行，
    // 只有"它还在被调用吗"这一条能抓到。这正是这条检查存在的理由。
    mutate(root, join("scripts", "gates", "ci.mjs"), (text) => text.replace('"evals.mjs"', '"assets.mjs"'));
    assert.ok(codes(checkHarness({ root, env: CI_ENV })).includes("G3_EVAL_GATE_MISSING"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("变异：发布门去掉人工审批 environment —— 必须变红", () => {
  const root = fixtureRoot();
  try {
    mutate(root, join(".github", "workflows", "release.yml"), (text) =>
      text.replace(/^\s*environment: release$/m, ""),
    );
    assert.ok(codes(checkHarness({ root, env: CI_ENV })).includes("G5_RELEASE_APPROVAL_MISSING"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("变异：pre-commit 被改成空壳 —— 必须变红", () => {
  const root = fixtureRoot();
  try {
    writeFileSync(join(root, ".githooks", "pre-commit"), "#!/bin/sh\nexit 0\n");
    assert.ok(codes(checkHarness({ root, env: CI_ENV })).includes("G2_GIT_HOOK_UNWIRED"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("变异：AGENTS.md 长出第 9 条规则 —— 必须变红（防愿景文档化）", () => {
  const root = fixtureRoot();
  try {
    const extra = Array.from(
      { length: 12 },
      (_, i) =>
        `### R${i + 1} · 规则\n- **强制**：x\n- **出处**：y\n`,
    ).join("\n");
    writeFileSync(
      join(root, "AGENTS.md"),
      `# AGENTS.md\n\n${extra}`,
    );
    assert.ok(
      codes(checkHarness({ root, env: CI_ENV })).includes("G0_AGENTS_MD_TOO_MANY_RULES"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("变异：规则没有出处 —— 必须变红", () => {
  const root = fixtureRoot();
  try {
    writeFileSync(join(root, "AGENTS.md"), "# AGENTS.md\n\n### R1 · 凭空发明的规则\n- **强制**：无\n");
    assert.ok(codes(checkHarness({ root, env: CI_ENV })).includes("G0_AGENTS_MD_RULE_NO_ORIGIN"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
