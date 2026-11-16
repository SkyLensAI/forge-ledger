#!/usr/bin/env node
/**
 * MCP server 的**传输层**：stdio，换行分隔的 JSON-RPC 2.0。
 *
 * 它只做四件事：读一行、解析、交给 `createServer().handle()`、写一行。
 * 判定与工具逻辑一行都不在这里——理由写在 `server.ts` 的文件头。
 *
 * 三条纪律：
 *
 * 1. **stdout 只放协议消息。** 任何一行日志混进去都会让客户端解析失败，
 *    而那种失败看起来像"服务端崩了"。诊断信息一律走 stderr。
 * 2. **一条消息解析不动，回一条 JSON-RPC 的 parse error 并继续。**
 *    崩掉整条连接会让"某一次调用写错了"升级成"整个会话没了"。
 * 3. **EOF 就退出**（stdin 关闭 = 客户端走了）。
 *
 * 用法：
 *   node apps/mcp/src/main.ts [--vault <目录>] [--today <YYYY-MM-DD>]
 */
import { createInterface } from "node:readline";
import { createServer, type JsonRpcRequest } from "./server.ts";

/**
 * @param {string[]} argv
 * @returns {{vault: string, today: string | null}}
 */
function parseArgs(argv: string[]): { vault: string; today: string | null } {
  let vault = "data";
  let today: string | null = null;
  const rest = [...argv];
  while (rest.length > 0) {
    const flag = rest.shift() ?? "";
    const value = rest.shift();
    if (value === undefined) {
      process.stderr.write(`✗ 选项 ${flag} 缺少值\n`);
      process.exit(2);
    }
    if (flag === "--vault") vault = value;
    else if (flag === "--today") today = value;
    else {
      process.stderr.write(`✗ 未知选项：${flag}\n`);
      process.exit(2);
    }
  }
  return { vault, today };
}

const { vault, today } = parseArgs(process.argv.slice(2));
const server = createServer({ vault, today });

process.stderr.write(`· forge MCP server 就绪（vault=${vault}，${String(server.tools.length)} 个工具）\n`);

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

lines.on("line", (line) => {
  const text = line.trim();
  if (text.length === 0) return;

  /** @type {JsonRpcRequest} */
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(text) as JsonRpcRequest;
  } catch (error) {
    // 解析失败**不退出**：回一条 parse error，连接继续。
    write({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: `JSON 解析失败：${error instanceof Error ? error.message : String(error)}` },
    });
    return;
  }

  try {
    const response = server.handle(request);
    // 通知没有回复（`handle` 返回 null）。
    if (response !== null) write(response);
  } catch (error) {
    write({
      jsonrpc: "2.0",
      id: request.id ?? null,
      error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
    });
  }
});

lines.on("close", () => {
  process.exit(0);
});

/**
 * 写一条消息。`JSON.stringify` 的输出里不会有多余换行（它转义字符串里的 `\n`），
 * 所以"一行一条消息"这个约定是成立的。
 *
 * @param {unknown} message
 * @returns {void}
 */
function write(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
