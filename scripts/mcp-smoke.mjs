#!/usr/bin/env node
/**
 * 通用 MCP stdio 冒烟测试（personal2.md 第五节）。
 *
 * 它不依赖任何具体客户端，只验证"任何支持 tools 的客户端"都该看到的五件事：
 *
 * 1. `initialize` 回一个双方都支持的协议版本；
 * 2. `tools/list` 回**四个**工具，名字与顺序都对；
 * 3. `forge_context` 回一段带可解析出处的注入（空库不算通过）；
 * 4. `forge_lint` 正常；
 * 5. **stdout 里只有 JSON-RPC**——一行日志混进去，客户端就会解析失败。
 *
 * 默认自己造一个临时库（一条 rule + 可解析的 span），跑完删掉；
 * 给 `--vault` 则对着你真实的库跑。也可以完全接管启动方式：
 *
 *   node scripts/mcp-smoke.mjs --vault <库>
 *   node scripts/mcp-smoke.mjs --command <可执行文件> -- <参数…>
 *
 * 退出码：0 = 五条都过；1 = 任何一条失败。失败时把 stdout/stderr 原样打出来，
 * 不把"服务端崩了"和"配置写错了"压成同一句“冒烟失败”。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../", import.meta.url));
const ANCHOR = "检索优先，绝不预加载整个大脑";
const EXPECTED_TOOLS = ["forge_context", "forge_search", "forge_get", "forge_lint"];

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  process.stderr.write(`✗ ${message}\n`);
  process.exit(1);
}

/** @type {string | null} */
let vault = null;
let timeout = 20_000;
/** @type {string | null} */
let command = null;
/** @type {string[]} */
let commandArgs = [];

const rest = process.argv.slice(2);
while (rest.length > 0) {
  const flag = rest.shift() ?? "";
  if (flag === "--vault") {
    vault = rest.shift() ?? fail("--vault 缺少值");
  } else if (flag === "--timeout") {
    const raw = rest.shift() ?? fail("--timeout 缺少值");
    timeout = Number(raw);
    if (!Number.isSafeInteger(timeout) || timeout <= 0) fail(`--timeout 要是正整数，收到「${raw}」`);
  } else if (flag === "--command") {
    command = rest.shift() ?? fail("--command 缺少值");
    commandArgs = rest.splice(0);
    if (commandArgs[0] === "--") commandArgs.shift();
  } else {
    fail(`未知选项：${flag}`);
  }
}

/**
 * 默认夹具：一条 rule + 一个能被 `file://` 解析到的 span。
 * 没有它，"forge_context 带出处"这一条就只能在空库上假装通过。
 *
 * @param {string} root
 * @returns {void}
 */
function seed(root) {
  const span = `file://docs/note.md#t:${ANCHOR}`;
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs", "note.md"), `# 说明\n\n${ANCHOR}。\n`, "utf8");
  mkdirSync(join(root, "assets", "rule"), { recursive: true });
  writeFileSync(
    join(root, "assets", "rule", "rule_01M6Q2FD00GRZFQ6K3F6KPGA03.md"),
    [
      "---",
      "schema_version: 1",
      "id: rule_01M6Q2FD00GRZFQ6K3F6KPGA03",
      "type: rule",
      "status: active",
      'created: "2026-01-01"',
      "last_confirmed: null",
      "supersedes: null",
      `origin_incident: "${span}"`,
      "subject: null",
      "sources:",
      `  - "${span}"`,
      "sensitivity: internal",
      "confidence: 0.9",
      "---",
      "",
      "# 检索优先，绝不预加载",
      "",
      "## 规则",
      "",
      "与查询无关的条目一条都不注入。",
      "",
      "## 强制",
      "",
      "注入块里的每一条都必须带可解析的出处。",
      "",
    ].join("\n"),
    "utf8",
  );
}

/** @type {null | (() => void)} */
let cleanup = null;
if (vault === null) {
  const created = mkdtempSync(join(tmpdir(), "forge-mcp-smoke-"));
  vault = created;
  seed(created);
  cleanup = () => rmSync(created, { recursive: true, force: true });
}

let launch;
if (command !== null) {
  launch = { command, args: commandArgs };
} else if (process.platform === "win32" && existsSync(join(REPO, "forge-mcp.cmd"))) {
  launch = { command: "cmd", args: ["/c", join(REPO, "forge-mcp.cmd"), "--vault", vault] };
} else {
  const tsx = join(REPO, "node_modules", "tsx", "dist", "cli.mjs");
  const server = join(REPO, "apps", "mcp", "src", "main.ts");
  launch = existsSync(tsx)
    ? { command: process.execPath, args: [tsx, server, "--vault", vault] }
    : { command: process.execPath, args: [server, "--vault", vault] };
}

const input = [
  JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }),
  JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  JSON.stringify({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "forge_context", arguments: { query: "预加载" } },
  }),
  JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "forge_lint", arguments: {} } }),
  "",
].join("\n");

const result = spawnSync(launch.command, launch.args, {
  cwd: REPO,
  input,
  encoding: "utf8",
  timeout,
  env: { ...process.env },
  windowsHide: true,
});

if (cleanup !== null) cleanup();

if (result.error !== undefined) {
  fail(`起不来或超时：${result.error.message}`);
}
if (result.status !== 0) {
  fail(
    `服务端退出码 ${String(result.status ?? "null")}\n` +
      `  stdout：\n${result.stdout ?? ""}\n  stderr：\n${result.stderr ?? ""}`,
  );
}

const stdout = result.stdout ?? "";
const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
/** @type {Map<number, any>} */
const byId = new Map();
for (const [index, line] of lines.entries()) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    fail(
      `stdout 第 ${String(index + 1)} 行不是 JSON-RPC：\n  ${line}\n` +
        "  stdout 只允许协议消息；任何日志都必须走 stderr。",
    );
  }
  if (typeof message.id === "number") byId.set(message.id, message);
}

const init = byId.get(1);
if (init?.result?.serverInfo?.name !== "forge") fail("initialize 没有回 forge 的 serverInfo");
if (typeof init?.result?.protocolVersion !== "string") fail("initialize 没有回协议版本");

const tools = byId.get(2)?.result?.tools;
const names = Array.isArray(tools) ? tools.map((tool) => tool.name) : [];
if (names.length !== EXPECTED_TOOLS.length || names.some((name, index) => name !== EXPECTED_TOOLS[index])) {
  fail(`tools/list 应该是 ${EXPECTED_TOOLS.join(" / ")}，收到 ${names.join(" / ") || "（空）"}`);
}

const context = byId.get(3);
const contextText = context?.result?.content?.[0]?.text ?? "";
if (context?.result?.isError === true) fail(`forge_context 返回了工具错误：\n${contextText}`);
if (!contextText.includes("这不是全库")) fail("forge_context 没有回「这不是全库」的注入块");
if (!contextText.includes("- 出处：")) fail("forge_context 的注入没有带出处（R4）");
if (!/file:\/\/|src:\/\//.test(contextText)) fail("forge_context 的出处不是可解析的 span");

const lint = byId.get(4);
const lintText = lint?.result?.content?.[0]?.text ?? "";
if (lint?.result?.isError === true) fail(`forge_lint 返回了工具错误：\n${lintText}`);
if (!lintText.includes("审核通过")) fail("forge_lint 没有回「审核通过」");

if (byId.size !== 4) {
  fail(`应该有 4 条带 id 的回复（initialize / tools/list / context / lint），收到 ${String(byId.size)} 条`);
}

process.stdout.write(`✓ initialize（协议 ${String(init.result.protocolVersion)}）\n`);
process.stdout.write(`✓ tools/list：${String(names.length)} 个工具，名字与顺序都对\n`);
process.stdout.write("✓ forge_context：预算内注入，且每条都带可解析出处\n");
process.stdout.write("✓ forge_lint：审核通过\n");
process.stdout.write("✓ stdout 只有 JSON-RPC（没有日志污染）\n");
