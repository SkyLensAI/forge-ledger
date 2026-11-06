#!/usr/bin/env node
// @ts-check
/**
 * 闸门 2 · pre-commit
 *
 * 只做两件事，因为它必须在每次提交时都跑得完：
 *   1. 判定暂存区的变更集（与 CI 使用同一套 policy，见 lib/policy.mjs）
 *   2. 对暂存的文件跑 lint（依赖未安装时降级为警告，并在 bypass-matrix 里记账）
 *
 * 它**不是**权威：`git commit --no-verify` 能跳过它。
 * 权威是闸门 3（CI），它用同一套策略重判一次。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { adrRefsFromCommitMessageFile, repoRoot, stagedChanges } from "./lib/git.mjs";
import { evaluateChangeset } from "./lib/policy.mjs";
import { fail, formatViolations, ok } from "./lib/report.mjs";

const root = repoRoot() ?? process.cwd();

const changes = stagedChanges({ cwd: root });
if (changes.length === 0) {
  ok("✓ 闸门 2：暂存区为空，没什么可查的");
  process.exit(0);
}

const adrRefs = adrRefsFromCommitMessageFile({ cwd: root });
const verdict = evaluateChangeset(changes, { adrRefs });

if (!verdict.ok) {
  fail(formatViolations(verdict.violations));
  fail("  本次提交已中止。修好上面的问题，或按提示补 ADR。`--no-verify` 能跳过这里，但跳不过 CI。\n");
  process.exit(1);
}

// lint 暂存文件（有依赖才跑；否则明确记账，不假装通过）
const lintTargets = changes
  .filter((change) => change.status !== "deleted")
  .map((change) => change.path)
  .filter((path) => /\.(mjs|cjs|js|ts|tsx)$/.test(path));

const eslintInstalled = existsSync(join(root, "node_modules", "eslint"));
if (lintTargets.length > 0 && eslintInstalled) {
  const result = spawnSync("pnpm", ["exec", "eslint", ...lintTargets], {
    cwd: root,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    fail(result.stdout ?? "");
    fail(result.stderr ?? "");
    fail("✗ 闸门 2：lint 未通过。\n");
    process.exit(1);
  }
} else if (lintTargets.length > 0) {
  process.stderr.write(
    "[gate2] ⚠ node_modules 未安装，跳过 lint（仅本机降级；CI 会跑全量 lint）\n",
  );
}

ok(`✓ 闸门 2：${changes.length} 个文件通过（策略判定 + lint）`);
process.exit(0);
