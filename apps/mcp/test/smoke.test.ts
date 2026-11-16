/**
 * 通用 MCP stdio 冒烟测试的**执行体**（personal2.md 第五节）。
 *
 * 脚本自己造一个临时库，所以这条测试不依赖本机 `data/`——CI 里也能跑。
 * 它保证"冒烟脚本本身还在、还能过"，而不是只把脚本写在文档里。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const REPO = process.cwd();
const SCRIPT = join(REPO, "scripts", "mcp-smoke.mjs");

test("MCP 冒烟：initialize / tools/list / context / lint / stdout 纯净", () => {
  const result = spawnSync("node", [SCRIPT], {
    cwd: REPO,
    encoding: "utf8",
    env: { PATH: process.env["PATH"] ?? "" },
    timeout: 60_000,
  });
  assert.equal(result.status, 0, `冒烟失败：\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /✓ initialize/);
  assert.match(result.stdout, /✓ tools\/list：4 个工具/);
  assert.match(result.stdout, /✓ forge_context/);
  assert.match(result.stdout, /✓ forge_lint/);
  assert.match(result.stdout, /✓ stdout 只有 JSON-RPC/);
});
