#!/usr/bin/env node
// @ts-check
/**
 * 闸门 4 · branch rule 的本机镜像（pre-push）
 *
 * 真正的 branch rule 在 GitHub 上（见 scripts/gates/setup-branch-protection.sh），
 * 这里只是同一个规则的早期反馈：不许直接把 main 推上去，也不许删掉远端 main。
 *
 * 它完全可被绕过（`--no-verify`、直接调 git 库、网页操作），
 * 所以它**不算**一道独立的闸门，只是"尽快失败"。
 */
import { readFileSync } from "node:fs";
import { fail, ok } from "./lib/report.mjs";

const PROTECTED_BRANCHES = new Set(["refs/heads/main", "refs/heads/master"]);
const ZERO_SHA = /^0+$/;

/** @type {string} */
let raw;
try {
  raw = readFileSync(0, "utf8");
} catch {
  raw = "";
}

const allowed = process.env.FORGE_ALLOW_MAIN_PUSH === "1";
/** @type {string[]} */
const blocked = [];

for (const line of raw.split(/\r?\n/)) {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 4) continue;
  const [, localSha, remoteRef, remoteSha] = parts;
  if (remoteRef === undefined || localSha === undefined) continue;
  if (!PROTECTED_BRANCHES.has(remoteRef)) continue;

  if (ZERO_SHA.test(localSha)) {
    blocked.push(`删除远端 ${remoteRef}`);
    continue;
  }
  if (remoteSha !== undefined && !ZERO_SHA.test(remoteSha)) {
    blocked.push(`直接向 ${remoteRef} 推送`);
  }
}

if (blocked.length === 0) {
  ok("✓ 闸门 4（本机镜像）：允许推送");
  process.exit(0);
}

if (allowed) {
  process.stderr.write(`[gate4] ⚠ FORGE_ALLOW_MAIN_PUSH=1 放行：${blocked.join("; ")}\n`);
  process.exit(0);
}

fail(
  [
    "",
    "✗ 闸门 4（本机镜像）拦下了这次推送：",
    ...blocked.map((item) => `  - ${item}`),
    "",
    "  本项目的 branch rule 是：main 只接受 PR，且必须有一个绿灯的 required status check。",
    "  → 开分支 + 推分支 + 提 PR；或（仅限明确知情时）FORGE_ALLOW_MAIN_PUSH=1",
    "",
  ].join("\n"),
);
process.exit(1);
