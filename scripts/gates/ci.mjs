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
 * 它做三件事：
 *   1. 用与本地完全相同的 policy 重判变更集（这就是 --no-verify 无效的原因）
 *   2. 检查"闸门本身是否还完整"——agent 拆掉自己的 hook，这里会红
 *   3. 跑 lint / typecheck / test
 *
 * 用法：
 *   pnpm gate:ci              完整判定
 *   node scripts/gates/ci.mjs --guard-only   只做 1+2（不需要 node_modules，演练用）
 */
import { spawnSync } from "node:child_process";
import { adrRefsSince, changesBetween, repoRoot, resolveBaseRef } from "./lib/git.mjs";
import { evaluateChangeset } from "./lib/policy.mjs";
import { checkHarness, REQUIRED_CHECK_NAME } from "./lib/harness.mjs";
import { fail, formatFindings, formatViolations, ok } from "./lib/report.mjs";

const guardOnly = process.argv.includes("--guard-only");
const root = repoRoot() ?? process.cwd();
const env = process.env;

let failed = false;

// ── 1. 变更集判定（与 pre-commit 同一套 policy）────────────────────────────
const base = resolveBaseRef({ cwd: root, env });
const harnessFindings = checkHarness({ root, env });
const heavyChecks = guardOnly
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

// ── 3. 重活：lint / typecheck / test ─────────────────────────────────────
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
