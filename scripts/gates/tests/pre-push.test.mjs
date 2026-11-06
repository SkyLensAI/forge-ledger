// @ts-check
/**
 * 闸门 4 本机镜像（pre-push）与闸门 3 入口（ci）的测试。
 *
 * pre-push 的输入是 git 的 push 协议：每行 `<local ref> <local sha> <remote ref> <remote sha>`。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PRE_PUSH = fileURLToPath(new URL("../pre-push.mjs", import.meta.url));
const CI = fileURLToPath(new URL("../ci.mjs", import.meta.url));
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const SHA_A = "1111111111111111111111111111111111111111";
const SHA_B = "2222222222222222222222222222222222222222";
const SHA_ZERO = "0000000000000000000000000000000000000000";

/**
 * @param {string} stdin
 * @param {Record<string, string>} [env]
 */
function runPrePush(stdin, env = {}) {
  return spawnSync(process.execPath, [PRE_PUSH], {
    input: stdin,
    encoding: "utf8",
    env: { ...process.env, FORGE_ALLOW_MAIN_PUSH: "", ...env },
  });
}

test("直接推 main —— 拦下", () => {
  const result = runPrePush(`refs/heads/main ${SHA_A} refs/heads/main ${SHA_B}`);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /branch rule/);
});

test("删掉远端 main —— 拦下", () => {
  const result = runPrePush(`(delete) ${SHA_ZERO} refs/heads/main ${SHA_B}`);
  assert.equal(result.status, 1);
});

test("推特性分支 —— 放行", () => {
  const result = runPrePush(`refs/heads/feat/x ${SHA_A} refs/heads/feat/x ${SHA_ZERO}`);
  assert.equal(result.status, 0);
});

test("初次推送特性分支（远端还不存在）—— 放行", () => {
  const result = runPrePush(`refs/heads/feat/x ${SHA_A} refs/heads/feat/x ${SHA_ZERO}`);
  assert.equal(result.status, 0);
});

test("FORGE_ALLOW_MAIN_PUSH=1 是显式逃生舱：放行但留痕", () => {
  const result = runPrePush(`refs/heads/main ${SHA_A} refs/heads/main ${SHA_B}`, {
    FORGE_ALLOW_MAIN_PUSH: "1",
  });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /FORGE_ALLOW_MAIN_PUSH/);
});

test("闸门 3 入口在本仓库上是绿的（harness 完整 + 变更集合规）", () => {
  const result = spawnSync(process.execPath, [CI, "--guard-only"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, CI: "true" },
  });
  assert.equal(
    result.status,
    0,
    `gate:ci 应当为绿，实际输出：\n${result.stdout}\n${result.stderr}`,
  );
});

test("闸门 5 拒绝本机发布（发布只能从 CI 发出）", () => {
  const RELEASE = fileURLToPath(new URL("../release.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [RELEASE], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, CI: "", GITHUB_ACTIONS: "" },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /发布门/);
});
