#!/usr/bin/env node
// @ts-check
/**
 * 闸门 3 的可信引导：**用"基线修订版"的闸门代码，判定"当前工作树"的改动。**
 *
 * 为什么必须有这一层（演练里真实发现）：
 * 如果 CI 直接跑工作树里的 `ci.mjs`，那么"被检查的东西"同时是"检查者"。
 * 演练场景 A 把 `scripts/gates/lib/policy.mjs` 删掉后，CI 不是"判定为红"，
 * 而是 `ERR_MODULE_NOT_FOUND` 崩掉；更糟的是——只要把 policy 改成永远返回 ok，
 * 闸门就会开心地报绿。**这不是漏洞，这是结构错误。**
 *
 * 本脚本只依赖 node 内建模块，做一件事：
 *   1. 把基线修订 checkout 到临时 worktree
 *   2. 用基线里的 `scripts/gates/ci.mjs`，以当前仓库为工作目录去判定
 *   3. 清理 worktree，原样透传退出码
 *
 * 副作用（有意的）：**新规则在合并之后才生效**。PR 里的规则改动不会被自己的新规则判绿——
 * 这正是"不能自己给自己发合格证"。
 *
 * 用法：
 *   node scripts/gates/trusted-ci.mjs                  # 基线取 FORGE_BASE_SHA / merge-base
 *   node scripts/gates/trusted-ci.mjs --base <sha>
 *   node scripts/gates/trusted-ci.mjs --guard-only     # 透传给 ci.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, env?: Record<string, string | undefined> }} [options]
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? process.cwd(),
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

/**
 * @param {string} name
 * @returns {string | undefined}
 */
function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const repo = run("git", ["rev-parse", "--show-toplevel"]).stdout.trim() || process.cwd();

/** @type {string | undefined} */
let base = argValue("--base");
if (base === undefined) {
  const explicit = process.env.FORGE_BASE_SHA;
  if (typeof explicit === "string" && explicit.trim().length > 0) {
    base = explicit.trim();
  } else {
    for (const candidate of ["origin/main", "main"]) {
      const mergeBase = run("git", ["merge-base", "HEAD", candidate], { cwd: repo });
      if (mergeBase.status === 0 && mergeBase.stdout.trim().length > 0) {
        base = mergeBase.stdout.trim();
        break;
      }
    }
  }
}

const passthrough = process.argv.slice(2).filter((arg) => arg.startsWith("--") && arg !== "--base");

/**
 * 基线不可用时退回工作树里的闸门，但必须**显式报警**：这是一次可见的降级。
 * @param {string} reason
 */
function fallback(reason) {
  process.stderr.write(`[gate3] ⚠ ${reason}：退回使用工作树里的闸门代码（降级，非正常路径）\n`);
  const result = run(process.execPath, [join(repo, "scripts", "gates", "ci.mjs"), ...passthrough], {
    cwd: repo,
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.status);
}

if (base === undefined || base.length === 0) {
  fallback("拿不到基线修订（首个提交 / 浅克隆）");
}

const verify = run("git", ["rev-parse", "--verify", `${base}^{commit}`], { cwd: repo });
if (verify.status !== 0) {
  fallback(`基线 ${base} 在本地不存在`);
}
const baseSha = verify.stdout.trim();

const workdir = mkdtempSync(join(tmpdir(), "forge-gate-base-"));
const tree = join(workdir, "base");
/** @type {number | undefined} */
let status;
try {
  const added = run("git", ["worktree", "add", "--detach", "--quiet", tree, baseSha], { cwd: repo });
  if (added.status !== 0) {
    fallback(`无法基于 ${baseSha.slice(0, 8)} 建立 worktree：${added.stderr.trim()}`);
  }

  const trustedEntry = join(tree, "scripts", "gates", "ci.mjs");
  if (!existsSync(trustedEntry)) {
    fallback(`基线 ${baseSha.slice(0, 8)} 里还没有闸门实现`);
  }

  process.stdout.write(
    `[gate3] 可信判定：闸门代码取自基线 ${baseSha.slice(0, 8)}，被判定对象是当前工作树\n`,
  );
  // 关键：脚本来自基线（ESM 的 import 相对脚本自身解析），
  // 而 cwd 是当前工作树 —— 所以判定的是 PR 的内容，用的是 PR 改不到的规则。
  const result = run(process.execPath, [trustedEntry, ...passthrough], {
    cwd: repo,
    env: { FORGE_BASE_SHA: baseSha },
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  status = result.status;
} finally {
  run("git", ["worktree", "remove", "--force", tree], { cwd: repo });
  run("git", ["worktree", "prune"], { cwd: repo });
  rmSync(workdir, { recursive: true, force: true });
}

process.exit(status ?? 1);
