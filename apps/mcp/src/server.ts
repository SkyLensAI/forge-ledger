/**
 * MCP server —— 让 Claude / Cursor **直接调用**资产库（S22）。
 *
 * implement2.md 给 P6 写的北极星只有一句话：
 * **连续 3 天在真实工作里被"调用"，而不是被"打开"。**
 * 这个文件存在的全部理由就是这句话：一个要人先打开终端再复制的知识库，
 * 永远停在"被打开"那一侧。
 *
 * ## 它为什么这么薄
 *
 * 判定**一行都不在这里**。它解析 JSON-RPC、把四个工具的参数收窄、调 `@forge/store`
 * 与 `@forge/core`、把结果包成 MCP 的形状。判定住在 `packages/core`，
 * 于是"CLI 里看到的注入"与"Cursor 里看到的注入"是**同一段字节**——
 * 这条性质由 `apps/cli/test/context.test.ts` 与 `apps/mcp/test/server.test.ts`
 * 各断言一次（同一份输入 → 同一份输出）。
 *
 * ## 四个工具，为什么是这四个
 *
 * | 工具 | 它回答的问题 |
 * |---|---|
 * | `forge_context` | "为了做完这件事，我最少要知道什么？"（预算内的注入，**主路径**） |
 * | `forge_search` | "库里有没有讲过这件事？"（只列条目，不读正文——列表不是注入） |
 * | `forge_get` | "那一条的全文是什么？"（按需读，检索的结果） |
 * | `forge_lint` | "这个库现在是健康的吗？"（读过之后才发现库里全是坏资产，是最坏的一种发现） |
 *
 * `forge_search` 与 `forge_get` 分开，是"检索优先，绝不预加载"这条纪律在**工具形状**上的
 * 落地：一次 `forge_search` 只回 id 与标题，模型据此决定要不要 `forge_get`。
 * 把它们合成一个"返回全文的搜索"，就是把预加载做成默认行为。
 *
 * ## 协议
 *
 * MCP 的 stdio 传输是**换行分隔的 JSON-RPC 2.0**（消息里不许有内嵌换行）。
 * 零依赖实现——这个仓库的依赖数是 1（zod）加 1（yaml），而协议本身只有几个方法。
 */
import { formatViolation, judgeLibrary, type Violation } from "@forge/core";
import { SCHEMA_VERSION, type AssetDoc } from "@forge/schema";
import { buildSpanIndex, openVault } from "@forge/store";

/** 服务端标识。**写成常量而不是从 package.json 读**：输出要逐字节确定。 */
export const SERVER_NAME = "forge";
export const SERVER_VERSION = "0.0.0";

/**
 * 支持的协议版本，**按新到旧**。
 * 客户端给的版本在这个列表里就回它，否则回列表第一项（MCP 规范的做法）。
 */
export const PROTOCOL_VERSIONS = ["2025-06-18", "2024-11-05"] as const;

/** 默认注入预算（token）。与 CLI 的默认值同源：这里不另定一个数。 */
export { DEFAULT_BUDGET_TOKENS, MIN_BUDGET_TOKENS } from "@forge/core";

/**
 * `forge_search` 的预算。
 *
 * 搜索**不受注入预算约束**，因为它不注入——它回的是"有哪些条"，正文一条都不带。
 * 这个数是显式写下来的而不是"随便给个大数"：一个隐藏的魔法数会在某天变成瓶颈，
 * 而写下来之后它是可读的。
 */
export const SEARCH_BUDGET = 1_000_000;

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ServerOptions {
  /** 资产库位置（`--vault`）。 */
  vault: string;
  /** `YYYY-MM-DD`：新鲜度基准日。不给 = **没有校验**新鲜度。 */
  today?: string | null;
}

export interface ForgeMcpServer {
  /** 工具表。**顺序固定**：`tools/list` 的输出会进快照（R6）。 */
  tools: ToolDefinition[];
  /**
   * 处理一条 JSON-RPC 消息。
   *
   * @param request 收到的消息
   * @returns 要回的消息；**通知（notification）返回 null**——JSON-RPC 的通知没有回复。
   */
  handle(request: JsonRpcRequest): JsonRpcResponse | null;
}

/** JSON-RPC 的错误码。用规范里的那几个，不自己发明。 */
const RPC = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
} as const;

/**
 * 文本结果。MCP 的 `tools/call` 只认 `content` 数组，
 * 而 `isError` 是**工具层面**的错误（区别于协议层面的 `error`）：
 * "查询没命中"是一个正常的结果，"参数不合法"才走协议错误。
 *
 * @param text
 * @param isError
 * @returns
 */
function textResult(text: string, isError = false): unknown {
  return { content: [{ type: "text", text }], isError };
}

/**
 * 建一个 server。**它不碰 stdin/stdout**——传输在 `main.ts` 里。
 *
 * 这条分界让协议层能被直接测：`handle()` 是一个普通函数，
 * 测试不必去解 stdio 的时序问题。
 *
 * @param {ServerOptions} options
 * @returns {ForgeMcpServer}
 */
export function createServer(options: ServerOptions): ForgeMcpServer {
  const vault = openVault(options.vault);
  const today = options.today ?? null;

  const tools: ToolDefinition[] = [
    {
      name: "forge_context",
      description:
        "取用：按查询检索资产库，回一段**预算内**的注入上下文（规则 / 决策 / 状态 / 相关事件），" +
        "每条都带可解析的出处。它**不是全库**：与查询无关的条目一条都不回，" +
        "被预算挡住的条数写在结果里。开始一项任务之前先调它。",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "一句话的任务描述，不是一整篇文档。" },
          budget: { type: "integer", description: "token 预算。默认 1200，下限 240。" },
          types: {
            type: "array",
            items: { type: "string", enum: ["decision", "state", "event", "rule"] },
            description: "只要这几种类型（不给 = 全部）。",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    {
      name: "forge_search",
      description:
        "只列条目，不读正文：回与查询相关的资产/事件的 id、类型、标题、相关度。" +
        "想读全文再用 forge_get——**列表不是注入**，一次把全文都拿回来就是预加载。",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "一句话的查询。" },
          limit: { type: "integer", description: "最多回几条（默认 20）。" },
          types: {
            type: "array",
            items: { type: "string", enum: ["decision", "state", "event", "rule"] },
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    {
      name: "forge_get",
      description: "按资产 ID 读一条资产的原文（含 front-matter：出处、状态、最后确认日期）。",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "形如 dec_01M6Q2FD00… 的资产 ID。" } },
        required: ["id"],
        additionalProperties: false,
      },
    },
    {
      name: "forge_lint",
      description:
        "审核整个库：schema、ID 前缀、出处是否解析得到、必填字段与章节、以及（给了基准日时）state 是否过期。" +
        "读过资产之后才发现库里全是坏资产，是最坏的一种发现——所以这个工具和读资产的工具放在一起。",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
  ];

  return {
    tools,

    handle(request) {
      const id = request.id ?? null;
      const method = typeof request.method === "string" ? request.method : "";

      // 通知：没有 id 的消息按 MCP 规范**不许回**。
      // `notifications/initialized` 就走这条路——回一条 null-id 的响应会让客户端困惑。
      const isNotification = request.id === undefined || request.id === null;
      if (isNotification && method.startsWith("notifications/")) return null;

      if (request.jsonrpc !== "2.0" || method.length === 0) {
        return { jsonrpc: "2.0", id, error: { code: RPC.INVALID_REQUEST, message: "不是合法的 JSON-RPC 2.0 消息" } };
      }

      switch (method) {
        case "initialize": {
          const params = asRecord(request.params);
          const wanted = typeof params["protocolVersion"] === "string" ? params["protocolVersion"] : "";
          const version = (PROTOCOL_VERSIONS as readonly string[]).includes(wanted) ? wanted : PROTOCOL_VERSIONS[0];
          return {
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: version,
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
              instructions:
                "这个服务把一个 forge 资产库暴露给你：带类型、带出处、可维护的决策 / 状态 / 事件 / 规则。" +
                "开始一项任务之前先调 forge_context（它只回与查询相关的那几条，绝不把全库塞给你）。" +
                "需要细节再用 forge_search + forge_get 按需取。",
            },
          };
        }

        case "ping":
          return { jsonrpc: "2.0", id, result: {} };

        case "tools/list":
          return { jsonrpc: "2.0", id, result: { tools } };

        case "tools/call":
          return callTool(vault, today, id, request.params);

        default:
          return { jsonrpc: "2.0", id, error: { code: RPC.METHOD_NOT_FOUND, message: `不认识的方法：${method}` } };
      }
    },
  };
}

/**
 * 工具调用的分派。
 *
 * 参数校验在**每个工具自己的那一小段**里做，而不是"统一 schema 校验"：
 * 这些参数的类型不同、错法的后果也不同（`budget` 太小会让"这不是全库"那句话装不下，
 * `id` 不存在只是查不到）。统一校验器会把这两种错误压成同一种消息，
 * 而修复它们要做的动作完全不一样。
 *
 * @param {import("@forge/store").Vault} vault
 * @param {string | null} today
 * @param {string | number | null} id
 * @param {unknown} params
 * @returns {JsonRpcResponse}
 */
function callTool(
  vault: ReturnType<typeof openVault>,
  today: string | null,
  id: string | number | null,
  params: unknown,
): JsonRpcResponse {
  const record = asRecord(params);
  const name = typeof record["name"] === "string" ? record["name"] : "";
  const args = asRecord(record["arguments"]);

  switch (name) {
    case "forge_context": {
      const query = args["query"];
      if (typeof query !== "string" || query.trim().length === 0) {
        return { jsonrpc: "2.0", id, error: { code: RPC.INVALID_PARAMS, message: "forge_context 需要 query。" } };
      }
      const budget = optionalInteger(args, "budget");
      if (typeof budget === "string") return { jsonrpc: "2.0", id, error: { code: RPC.INVALID_PARAMS, message: budget } };

      const types = optionalTypes(args);
      if (typeof types === "string") return { jsonrpc: "2.0", id, error: { code: RPC.INVALID_PARAMS, message: types } };

      const run = vault.context({
        query,
        ...(budget === undefined ? {} : { budget }),
        today,
        ...(types === undefined ? {} : { types }),
      });
      if (run.violations.length > 0) {
        // 自证失败 = 缺陷。**不回一段夹着问题的注入**：那会让调用方拿到坏上下文而不知道。
        return {
          jsonrpc: "2.0",
          id,
          result: textResult(`✗ 注入块违反了它自己的承诺：\n${run.violations.join("\n")}`, true),
        };
      }
      const warnings =
        run.invalid.length === 0
          ? ""
          : `\n> ⚠ 另有 ${String(run.invalid.length)} 个文件读不成资产，它们**没有参与检索**：` +
            `${run.invalid.map((item) => item.path).join("、")}\n`;
      return { jsonrpc: "2.0", id, result: textResult(`${run.rendered}${warnings}`) };
    }

    case "forge_search": {
      const query = args["query"];
      if (typeof query !== "string" || query.trim().length === 0) {
        return { jsonrpc: "2.0", id, error: { code: RPC.INVALID_PARAMS, message: "forge_search 需要 query。" } };
      }
      const limit = optionalInteger(args, "limit") ?? 20;
      if (typeof limit === "string") return { jsonrpc: "2.0", id, error: { code: RPC.INVALID_PARAMS, message: limit } };

      const types = optionalTypes(args);
      if (typeof types === "string") return { jsonrpc: "2.0", id, error: { code: RPC.INVALID_PARAMS, message: types } };

      const run = vault.context({
        query,
        budget: SEARCH_BUDGET,
        today,
        ...(types === undefined ? {} : { types }),
      });
      const items = run.result.items.slice(0, limit);
      if (items.length === 0) {
        // "没命中"必须与"库里没有"分开说：前者是这一问没问到，后者是库里真没有。
        return {
          jsonrpc: "2.0",
          id,
          result: textResult(
            `没有与「${query}」相关的条目（参与打分 ${String(run.result.considered)} 条，` +
              `其中 ${String(run.result.irrelevant)} 条与查询无关、${String(run.result.excluded.length)} 条状态或新鲜度不合格）。\n` +
              "这是「这一问没问到」，不是「库里没有」。",
          ),
        };
      }
      const lines = items.map(
        (item) =>
          `- [${item.type}] ${item.title}\n  id: ${item.id}\n  定位: ${item.path}\n  ` +
          `相关度: ${String(item.score)}${item.subject === null ? "" : `\n  题面: ${item.subject}`}`,
      );
      return {
        jsonrpc: "2.0",
        id,
        result: textResult(
          `与「${query}」相关的 ${String(items.length)} 条` +
            (run.result.items.length > items.length ? `（共 ${String(run.result.items.length)} 条，按 limit 截断）` : "") +
            `：\n${lines.join("\n")}\n\n· 要看全文用 forge_get <id>。`,
        ),
      };
    }

    case "forge_get": {
      const wanted = args["id"];
      if (typeof wanted !== "string" || wanted.trim().length === 0) {
        return { jsonrpc: "2.0", id, error: { code: RPC.INVALID_PARAMS, message: "forge_get 需要 id。" } };
      }
      const doc = findAsset(vault.assets.scan().docs, wanted.trim());
      if (doc === null) {
        return {
          jsonrpc: "2.0",
          id,
          result: textResult(`库里没有 id 为 ${wanted} 的资产。用 forge_search 找。`, true),
        };
      }
      return { jsonrpc: "2.0", id, result: textResult(doc.raw) };
    }

    case "forge_lint": {
      const scan = vault.assets.scan();
      const index = buildSpanIndex({ sources: null, workspaces: [vault.paths.root] });
      const violations: Violation[] = [
        ...scan.invalid.map((item) => ({
          code: "ASSET_FRONTMATTER_INVALID",
          path: item.path,
          message: `front-matter 读不动：${item.reason}`,
          fix: "补全 front-matter（字段表见 schema/taxonomy.yaml）",
        })),
        ...judgeLibrary(scan.docs, index),
      ];
      if (violations.length === 0) {
        return {
          jsonrpc: "2.0",
          id,
          result: textResult(`✓ 审核通过：${String(scan.docs.length)} 条资产（schema v${String(SCHEMA_VERSION)}）`),
        };
      }
      const lines = violations
        .slice()
        .sort((a, b) => (a.path === b.path ? (a.code < b.code ? -1 : 1) : a.path < b.path ? -1 : 1))
        .map((violation) => formatViolation(violation));
      return {
        jsonrpc: "2.0",
        id,
        result: textResult(`✗ ${String(violations.length)} 处问题（${String(scan.docs.length)} 条资产）：\n${lines.join("\n")}`, true),
      };
    }

    default:
      return { jsonrpc: "2.0", id, error: { code: RPC.METHOD_NOT_FOUND, message: `不认识的工具：${name}` } };
  }
}

/**
 * 按 ID 找一条资产。**先归一再比较**（ADR-0007）：
 * 大小写不一致的 ID 是同一个 ID，否则"我明明看到了它"会变成一次查不到。
 *
 * @param {AssetDoc[]} docs
 * @param {string} id
 * @returns {AssetDoc | null}
 */
function findAsset(docs: AssetDoc[], id: string): AssetDoc | null {
  const wanted = id.toLowerCase();
  return docs.find((doc) => doc.frontMatter.id.toLowerCase() === wanted) ?? null;
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * 可选整数参数。
 *
 * 非法时返回**错误消息字符串**而不是抛：抛出去会被传输层压成一条笼统的
 * "internal error"，而"budget 必须是整数"是一条调用方能直接修的指令。
 *
 * @param {Record<string, unknown>} args
 * @param {string} key
 * @returns {number | undefined | string}
 */
function optionalInteger(args: Record<string, unknown>, key: string): number | undefined | string {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    return `${key} 必须是整数，收到 ${JSON.stringify(value)}`;
  }
  return value;
}

/**
 * @param {Record<string, unknown>} args
 * @returns {import("@forge/schema").AssetType[] | undefined | string}
 */
function optionalTypes(args: Record<string, unknown>): import("@forge/schema").AssetType[] | undefined | string {
  const value = args["types"];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) return "types 必须是数组";
  const out: import("@forge/schema").AssetType[] = [];
  for (const piece of value) {
    if (piece === "decision" || piece === "state" || piece === "event" || piece === "rule") out.push(piece);
    else return `types 里有不认识的类型：${JSON.stringify(piece)}`;
  }
  return out;
}
