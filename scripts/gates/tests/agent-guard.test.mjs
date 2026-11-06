// @ts-check
/**
 * 闸门 1（agent hook）的行为测试：把 hook 当成一个进程来喂输入、看退出码。
 * 退出码 2 = 阻断（契约见 Claude Code hooks 文档）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const GUARD = fileURLToPath(new URL("../agent-guard.mjs", import.meta.url));
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * @param {any} payload
 * @param {Record<string, string>} [env]
 */
function runGuard(payload, env = {}) {
  return spawnSync(process.execPath, [GUARD], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, FORGE_GATE_OVERRIDE: "", ...env },
  });
}

test("写受保护路径 —— 阻断（exit 2）", () => {
  const result = runGuard({
    tool_name: "Edit",
    cwd: ROOT,
    tool_input: { file_path: `${ROOT}schema/taxonomy.yaml` },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /A1_PROTECTED_PATH/);
});

test("删掉一处 schema 校验（Write 到 packages/schema）—— 阻断", () => {
  const result = runGuard({
    tool_name: "Write",
    cwd: ROOT,
    tool_input: { file_path: `${ROOT}packages/schema/src/validate.ts` },
  });
  assert.equal(result.status, 2);
});

test("改自己（闸门实现）—— 阻断：闸门不能被被闸门管的人改松", () => {
  const result = runGuard({
    tool_name: "Edit",
    cwd: ROOT,
    tool_input: { file_path: `${ROOT}scripts/gates/lib/policy.mjs` },
  });
  assert.equal(result.status, 2);
});

test("正常业务代码 —— 放行（exit 0）", () => {
  const result = runGuard({
    tool_name: "Edit",
    cwd: ROOT,
    tool_input: { file_path: `${ROOT}packages/core/src/compile.ts` },
  });
  assert.equal(result.status, 0);
});

test("Bash 绕过手法 —— 阻断", () => {
  const result = runGuard({
    tool_name: "Bash",
    cwd: ROOT,
    tool_input: { command: "git commit --no-verify -m 'skip gates'" },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /B1_SKIP_HOOKS/);
});

test("正常 Bash 命令 —— 放行", () => {
  const result = runGuard({
    tool_name: "Bash",
    cwd: ROOT,
    tool_input: { command: "pnpm test" },
  });
  assert.equal(result.status, 0);
});

test("FORGE_GATE_OVERRIDE 是人给的逃生舱：放行但留痕", () => {
  const result = runGuard(
    {
      tool_name: "Edit",
      cwd: ROOT,
      tool_input: { file_path: `${ROOT}schema/taxonomy.yaml` },
    },
    { FORGE_GATE_OVERRIDE: "Phase 1 立宪，人已批准" },
  );
  assert.equal(result.status, 0);
  assert.match(result.stderr, /FORGE_GATE_OVERRIDE/);
});

test("宿主没给合法 JSON —— fail-open 但留痕（不卡死会话）", () => {
  const result = runGuard("not json at all");
  assert.equal(result.status, 0);
  assert.match(result.stderr, /无法解析/);
});
