#!/usr/bin/env node
/**
 * 把已经生成好的 `demo/` 原样发布到 `gh-pages` 分支。
 *
 * 设计约束（ADR-0045）：
 *   - **不重新生成 demo**：发布的是提交里那份通过了 `forge demo --check` 的字节；
 *   - **不碰 `.github/workflows/`**：那是受保护路径；
 *   - 第一次用 orphan 分支，之后走普通快进提交——不用 `--force`。
 *
 * 前置条件：`origin` 已配置；GitHub Pages 的 Source 设为 `gh-pages` / 根目录
 * （一次性仓库设置，见 ADR-0045）。
 *
 * 用法：
 *   pnpm demo && pnpm demo:publish
 */
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = resolve(process.cwd());
const DEMO = join(ROOT, "demo");
const BRANCH = "gh-pages";
const worktree = mkdtempSync(join(tmpdir(), "forge-pages-"));

/**
 * @param {string} command
 * @param {string[]} args
 * @param {string} cwd
 * @returns {string}
 */
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(`${command} ${args.join(" ")} 失败${detail.length > 0 ? `：\n${detail}` : ""}`);
  }
  return result.stdout ?? "";
}

if (!existsSync(join(DEMO, "index.html"))) {
  console.error("✗ 找不到 demo/index.html：先跑一次 `pnpm demo`。");
  process.exit(1);
}

try {
  const hasRemote = spawnSync("git", ["remote", "get-url", "origin"], { cwd: ROOT }).status === 0;
  if (!hasRemote) throw new Error("没有 origin 远程仓库：先把仓库推到 GitHub。");

  const branchExists =
    spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${BRANCH}`], { cwd: ROOT }).status === 0;

  if (branchExists) {
    run("git", ["worktree", "add", worktree, BRANCH], ROOT);
  } else {
    run("git", ["worktree", "add", "--detach", worktree, "HEAD"], ROOT);
    run("git", ["checkout", "--orphan", BRANCH], worktree);
  }

  // 清空 worktree：gh-pages 只应该包含发布产物，不包含源码历史。
  run("git", ["rm", "-rf", "--ignore-unmatch", "."], worktree);
  for (const name of readdirSync(worktree)) {
    if (name === ".git") continue;
    rmSync(join(worktree, name), { recursive: true, force: true });
  }

  cpSync(DEMO, worktree, { recursive: true });
  // 告诉 GitHub Pages 不要跑 Jekyll：这是一份纯静态产物。
  writeFileSync(join(worktree, ".nojekyll"), "");

  run("git", ["add", "-A"], worktree);
  const pending = run("git", ["status", "--porcelain"], worktree).trim();
  if (pending.length === 0) {
    console.log("· demo 已是最新：gh-pages 没有变化，未产生空提交。");
  } else {
    run("git", ["commit", "-m", "deploy: demo (generated)"], worktree);
    const push = spawnSync("git", ["push", "origin", BRANCH], { cwd: worktree, stdio: "inherit" });
    if (push.status !== 0) throw new Error("推送 gh-pages 失败");
    console.log(`✓ 已发布 demo 到 ${BRANCH}。`);
  }
} catch (error) {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  spawnSync("git", ["worktree", "remove", "--force", worktree], { cwd: ROOT });
  rmSync(worktree, { recursive: true, force: true });
}
