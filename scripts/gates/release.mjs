#!/usr/bin/env node
// @ts-check
/**
 * 闸门 5 · 发布门
 *
 * 纪律：**发布只能从 CI 发出，不能在笔记本上手动发。**
 * 一旦允许"本机 publish"，前面四道闸门全部作废——因为发布者可以不带任何检查地发出产物。
 *
 * 本阶段能真实判定的四项：
 *   1. 必须运行在 CI 里，且是 tag 触发
 *   2. tag 必须与 package.json 的版本一致，且版本不是占位的 0.0.0
 *   3. 自上一个 tag 以来的所有变更，必须重新过一遍 policy（受保护路径要有 ADR）
 *   4. 发布前的包结构检查由 `release-preflight.mjs` 负责（ADR-0044）
 *
 * provenance / emit 快照 / eval 阈值**不在本脚本里重复跑**：`release.yml` 在
 * `gate:release` 之前已经跑过完整的 `gate:ci`。在这里再写一份就是第二个真相；
 * 本脚本只回答发布门的三个问题。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { changesBetween, extractAdrTrailers, git, repoRoot } from "./lib/git.mjs";
import { evaluateChangeset } from "./lib/policy.mjs";
import { fail, formatViolations, ok } from "./lib/report.mjs";

const root = repoRoot() ?? process.cwd();
const env = process.env;
/** @type {string[]} */
const problems = [];

// ── 1. 必须来自 CI ────────────────────────────────────────────────────────
if (env.CI !== "true" && env.CI !== "1") {
  problems.push("不在 CI 环境里运行（CI 未设为 true）：发布门必须由 CI 执行，本机发布等于绕过全部闸门。");
}
if (env.GITHUB_ACTIONS !== "true") {
  problems.push("不在 GitHub Actions 里运行：无法确认 required status check 已经通过。");
}

const refType = env.GITHUB_REF_TYPE;
const refName = env.GITHUB_REF_NAME ?? "";
if (refType !== undefined && refType !== "tag") {
  problems.push(`发布门只接受 tag 触发，当前 GITHUB_REF_TYPE=${refType}。`);
}

// ── 2. tag 与版本一致 ─────────────────────────────────────────────────────
/** @type {string} */
let version = "";
try {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  version = typeof pkg.version === "string" ? pkg.version : "";
} catch {
  problems.push("读不到 package.json 的 version。");
}
if (refName.length > 0 && version.length > 0) {
  const expected = `v${version}`;
  if (refName !== expected) {
    problems.push(`tag ${refName} 与 package.json 版本不一致（应为 ${expected}）。`);
  }
}
if (version === "0.0.0") {
  problems.push(
    "package.json 的版本还是 0.0.0：它是「尚未发布」的占位，不是一次发布。先把版本定下来，再打 tag。",
  );
}

// ── 3. 自上一个 tag 以来的变更重判 ────────────────────────────────────────
const lastTag = git(["describe", "--tags", "--abbrev=0", "HEAD^"], { cwd: root, allowFailure: true });
if (lastTag.ok && lastTag.stdout.trim().length > 0) {
  const from = lastTag.stdout.trim();
  const changes = changesBetween(from, "HEAD", { cwd: root });
  const messages = git(["log", "--format=%B%x00", `${from}..HEAD`], { cwd: root }).stdout;
  const verdict = evaluateChangeset(changes, { adrRefs: extractAdrTrailers(messages) });
  if (!verdict.ok) {
    fail(formatViolations(verdict.violations));
    problems.push(`自 ${from} 以来有 ${verdict.violations.length} 项未合规的变更。`);
  }
} else {
  ok("[gate5] 没有上一个 tag：跳过增量判定（首个版本）");
}

// ── 判定 ─────────────────────────────────────────────────────────────────
if (problems.length > 0) {
  fail(
    ["", "✗ 闸门 5（发布门）拦下了这次发布：", ...problems.map((p) => `  - ${p}`), ""].join("\n"),
  );
  process.exit(1);
}

ok(`✓ 闸门 5：${refName || "(local tag)"} 通过发布门`);
process.exit(0);
