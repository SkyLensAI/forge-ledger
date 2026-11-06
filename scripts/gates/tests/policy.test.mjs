// @ts-check
/**
 * 闸门策略的单元测试。
 *
 * 这些用例就是"闸门本身"的尺子：CI 里跑的不只是"代码合规吗"，
 * 还有"闸门还拦得住吗"。Phase 3 的 S13 不变量测试会沿着这个模式长。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AGENTS_MD_MAX_RULES,
  evaluateBashCommand,
  evaluateChangeset,
  isSecret,
  isUserData,
  protectedReason,
} from "../lib/policy.mjs";

test("R2：改动受保护路径但没有 ADR —— 必须被拦（退出条件的核心用例）", () => {
  const verdict = evaluateChangeset([
    // 这就是"故意写错的改动"：删掉一处 schema 校验。
    { path: "packages/schema/src/validate.ts", status: "deleted" },
  ]);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.violations[0]?.code, "R2_PROTECTED_WITHOUT_ADR");
});

test("R2：同一变更集里带了 ADR —— 放行", () => {
  const verdict = evaluateChangeset([
    { path: "schema/taxonomy.yaml", status: "modified" },
    { path: "docs/adr/0007-add-spec-asset-type.md", status: "added" },
  ]);
  assert.equal(verdict.ok, true);
});

test("R2：提交信息里的 ADR 尾注 —— 放行（CI 侧的第二种通道）", () => {
  const verdict = evaluateChangeset([{ path: ".github/workflows/ci.yml", status: "modified" }], {
    adrRefs: ["0007"],
  });
  assert.equal(verdict.ok, true);
});

test("R2：闸门实现本体也受保护（不能被 agent 随手改松）", () => {
  for (const path of [
    "scripts/gates/lib/policy.mjs",
    ".githooks/pre-commit",
    ".claude/settings.json",
    ".github/workflows/ci.yml",
    "schema/taxonomy.yaml",
    "packages/schema/migrations/0001-init.ts",
  ]) {
    assert.notEqual(protectedReason(path), null, `${path} 应当受保护`);
  }
});

test("R2：普通代码与文档不受保护（否则规则会因为烦人而被绕过）", () => {
  for (const path of [
    "packages/core/src/compile.ts",
    "apps/cli/src/index.ts",
    "docs/adr/0001-x.md",
    "eslint.config.mjs",
    "package.json",
  ]) {
    assert.equal(protectedReason(path), null, `${path} 不该受保护`);
  }
});

test("R1：用户数据进 repo —— 必须被拦", () => {
  const verdict = evaluateChangeset([{ path: "data/assets/dec/dec_01HQ.md", status: "added" }]);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.violations[0]?.code, "R1_USER_DATA_IN_REPO");
  assert.equal(isUserData("data/.gitkeep"), false);
});

test("R3：密钥文件 —— 必须被拦，但 .env.example 放行", () => {
  assert.equal(evaluateChangeset([{ path: ".env", status: "added" }]).ok, false);
  assert.equal(evaluateChangeset([{ path: ".env.local", status: "added" }]).ok, false);
  assert.equal(evaluateChangeset([{ path: ".env.example", status: "added" }]).ok, true);
  assert.equal(isSecret("apps/web/.env.production"), true);
});

test("干净的变更集 —— 放行（闸门不能天天误报）", () => {
  const verdict = evaluateChangeset([
    { path: "packages/core/src/compile.ts", status: "modified" },
    { path: "packages/core/tests/compile.test.ts", status: "added" },
    { path: "docs/handbook/setup.md", status: "added" },
  ]);
  assert.equal(verdict.ok, true);
});

test("Bash 侧的绕过手法 —— 必须被 agent hook 拦下", () => {
  const cases = [
    "git commit --no-verify -m 'quick fix'",
    "git commit -n -m 'quick fix'",
    "git push --force origin main",
    "git push -f origin main",
    "git config core.hooksPath /dev/null",
    "rm -rf .githooks scripts/gates",
  ];
  for (const command of cases) {
    assert.ok(evaluateBashCommand(command).length > 0, `应当拦下：${command}`);
  }
});

test("正常的 Bash 命令 —— 不能被误拦", () => {
  const cases = [
    "git commit -m 'feat: add normalizer'",
    "git push origin feat/normalizer",
    "pnpm test",
    "rm -rf node_modules/.cache",
  ];
  for (const command of cases) {
    assert.deepEqual(evaluateBashCommand(command), [], `不该拦下：${command}`);
  }
});

test("AGENTS.md 规则上限是 8 条（超过就是愿景文档）", () => {
  assert.equal(AGENTS_MD_MAX_RULES, 8);
});
