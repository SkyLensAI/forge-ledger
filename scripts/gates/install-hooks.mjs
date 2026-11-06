#!/usr/bin/env node
// @ts-check
/**
 * 安装本地闸门（闸门 2 / 4 的载体）。
 *
 * 为什么用 core.hooksPath 指向仓库内的 .githooks，而不是 husky（ADR-0002）：
 *   - 零依赖：不需要 husky + lint-staged，也不需要它们在 CI 里被安装
 *   - 同一份脚本本地和 CI 都能跑（pre-commit.mjs == ci.mjs 用的 policy）
 *   - 跨平台：Windows 上没有 .sh 执行位的坑
 * 代价：clone 之后必须跑一次 `pnpm install`（prepare 生命周期会调到这里），
 *       否则 core.hooksPath 没设、闸门 2 静默失效 —— 这一条记在 bypass-matrix 里。
 */
import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { git, repoRoot } from "./lib/git.mjs";

const root = repoRoot() ?? process.cwd();
const hooksDir = join(root, ".githooks");

if (!existsSync(hooksDir)) {
  process.stderr.write(`[gates] 找不到 ${hooksDir}，跳过钩子安装\n`);
  process.exit(0);
}

const result = git(["config", "core.hooksPath", ".githooks"], { cwd: root, allowFailure: true });
if (!result.ok) {
  process.stderr.write(`[gates] 设置 core.hooksPath 失败：${result.stderr.trim()}\n`);
  process.exit(1);
}

for (const hook of ["pre-commit", "pre-push"]) {
  const path = join(hooksDir, hook);
  if (!existsSync(path)) continue;
  try {
    chmodSync(path, 0o755);
  } catch {
    // Windows 上 chmod 基本是空操作；git 通过 shebang 识别脚本。
  }
}

process.stdout.write("[gates] ✓ core.hooksPath = .githooks（闸门 2 / 4 本机镜像已生效）\n");
process.exit(0);
