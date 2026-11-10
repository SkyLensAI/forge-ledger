/**
 * 第一个连接器：**官方数据导出**（implement2.md · S9）。
 *
 * 为什么第一个来源是导出文件而不是浏览器插件：这个品类第一大差评就是
 * "平台一改版工具就坏"（占全部评价 16%）。插件是最脆弱的一环——
 * 它依赖 DOM 结构，而 DOM 结构是私有实现细节。导出文件是平台**承诺过**的接口，
 * 改起来的代价对它自己也很高。插件放到 Phase 6。
 *
 * 关于"宽容"的边界：字段名认几种常见写法（`messages` / `chat_messages`，
 * `sender` / `author.role`），因为各家的导出格式确实不同；
 * 但**记录级失败一律丢弃并记账**，不猜、不补、不改写原文。
 * 宽容解析字段名 ≠ 宽容编造内容。
 */
import type { RawRecord } from "@forge/core";
import type { ConnectorParseResult, SkippedRecord, SourceConnector } from "../contracts.ts";

export const OFFICIAL_EXPORT_CONNECTOR_ID = "official-export";

/** 认得的会话数组字段名。 */
const CONVERSATION_KEYS = ["conversations", "chats", "threads"] as const;
/** 认得的消息数组字段名。 */
const MESSAGE_KEYS = ["messages", "chat_messages", "turns"] as const;

export const officialExportConnector: SourceConnector = {
  id: OFFICIAL_EXPORT_CONNECTOR_ID,
  mediaType: "application/json",

  accepts(text: string): boolean {
    const parsed = parseJson(text);
    if (parsed === null) return false;
    const list = conversationList(parsed);
    return list !== null && list.length > 0;
  },

  parse(text: string): ConnectorParseResult {
    const parsed = parseJson(text);
    if (parsed === null) {
      return { records: [], skipped: [{ index: 0, reason: "不是合法 JSON：导出文件必须是 JSON，别的格式要各自的连接器" }] };
    }

    const list = conversationList(parsed);
    if (list === null) {
      return {
        records: [],
        skipped: [{ index: 0, reason: `顶层找不到会话数组（认得的字段名：${CONVERSATION_KEYS.join(" / ")}）` }],
      };
    }

    const records: RawRecord[] = [];
    const skipped: SkippedRecord[] = [];
    let index = 0;

    list.forEach((conversation, conversationIndex) => {
      const conversationId = stringOf(conversation, ["id", "uuid", "conversation_id"]);
      if (conversationId === null) {
        skipped.push({ index: conversationIndex, reason: "会话没有 id：没有稳定定位键，它的消息无法被引用" });
        return;
      }

      const messages = messageList(conversation);
      if (messages === null) {
        skipped.push({ index: conversationIndex, reason: `会话 ${conversationId} 里找不到消息数组` });
        return;
      }

      messages.forEach((message) => {
        const localIndex = index;
        index += 1;

        const messageId = stringOf(message, ["id", "uuid", "message_id"]);
        if (messageId === null) {
          skipped.push({ index: localIndex, reason: `会话 ${conversationId} 里有一条消息没有 id` });
          return;
        }

        const occurredAt = isoSecond(textOf(message, ["created_at", "create_time", "timestamp", "created"]));
        if (occurredAt === null) {
          skipped.push({ index: localIndex, reason: `${conversationId}/${messageId} 的时间戳缺失或无法解析` });
          return;
        }

        const body = messageText(message);
        if (body === null) {
          skipped.push({ index: localIndex, reason: `${conversationId}/${messageId} 没有正文` });
          return;
        }

        records.push({
          key: `${conversationId}/${messageId}`,
          occurred_at: occurredAt,
          actor: senderOf(message),
          // 只做行尾归一，**不做任何别的加工**：改写原文等于在采集层污染证据。
          text: body.replace(/\r\n?/g, "\n"),
        });
      });
    });

    return { records, skipped };
  },
};

/**
 * @param {string} text
 * @returns {unknown}
 */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 顶层会话数组。除了"对象里有个数组字段"，也接受**顶层直接是数组**
 * （`conversations.json` 在两个主流导出里就是这个形状）。
 *
 * @param {unknown} parsed
 * @returns {unknown[] | null}
 */
function conversationList(parsed: unknown): unknown[] | null {
  if (Array.isArray(parsed)) return parsed;
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  for (const key of CONVERSATION_KEYS) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  return null;
}

/**
 * @param {unknown} conversation
 * @returns {unknown[] | null}
 */
function messageList(conversation: unknown): unknown[] | null {
  if (typeof conversation !== "object" || conversation === null) return null;
  const record = conversation as Record<string, unknown>;
  for (const key of MESSAGE_KEYS) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  return null;
}

/**
 * @param {unknown} message
 * @returns {string}
 */
function senderOf(message: unknown): string {
  if (typeof message !== "object" || message === null) return "unknown";
  const record = message as Record<string, unknown>;
  const direct = record["sender"] ?? record["role"];
  if (typeof direct === "string") return direct;
  const author = record["author"];
  if (typeof author === "string") return author;
  if (typeof author === "object" && author !== null) {
    const role = (author as Record<string, unknown>)["role"];
    if (typeof role === "string") return role;
  }
  return "unknown";
}

/**
 * @param {unknown} message
 * @returns {string | null}
 */
function messageText(message: unknown): string | null {
  if (typeof message !== "object" || message === null) return null;
  const record = message as Record<string, unknown>;
  const direct = record["text"];
  if (typeof direct === "string") return direct;
  const content = record["content"];

  // 有些导出把正文藏在 `content.parts` 里（一个字符串数组）。
  if (typeof content === "object" && content !== null) {
    const parts = (content as Record<string, unknown>)["parts"];
    if (Array.isArray(parts)) {
      const pieces = parts.filter((part): part is string => typeof part === "string");
      if (pieces.length > 0) return pieces.join("\n");
    }
  }
  if (typeof content === "string") return content;
  return null;
}

/**
 * @param {unknown} value
 * @param {readonly string[]} keys
 * @returns {string | null}
 */
function stringOf(value: unknown, keys: readonly string[]): string | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const found = record[key];
    if (typeof found === "string" && found.trim().length > 0) return found.trim();
  }
  return null;
}

/**
 * @param {unknown} value
 * @param {readonly string[]} keys
 * @returns {unknown}
 */
function rawOf(value: unknown, keys: readonly string[]): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

/**
 * @param {unknown} value
 * @param {readonly string[]} keys
 * @returns {string | null}
 */
function textOf(value: unknown, keys: readonly string[]): string | null {
  const found = rawOf(value, keys);
  if (typeof found === "string") return found;
  if (typeof found === "number") return String(found);
  return null;
}

/**
 * 时间戳归一：一律变成 `YYYY-MM-DDTHH:MM:SSZ`。
 *
 * 为什么必须归一而不是"原样保留"：两个导出里同一时刻可能写成
 * `2026-10-14T09:12:03.123456+08:00` 和 `1760433123`。不归一，
 * 时间线的排序就会退化成字符串排序，而字符串排序会让"最近"变成假的。
 * 秒精度是够的——这是对话记录，不是审计日志的排序键。
 *
 * @param {string | null} raw
 * @returns {string | null}
 */
export function isoSecond(raw: string | null): string | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  // 纯数字：epoch 秒（10 位）或毫秒（13 位）。不做时区猜测——epoch 本来就是 UTC。
  if (/^\d+$/.test(trimmed)) {
    const value = Number(trimmed);
    const ms = trimmed.length >= 12 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : toSecondIso(date);
  }

  // 形状对不代表日期存在：`Date.parse("2026-02-31T00:00:00Z")` 会把它
  // **静默归一**成 3 月 3 日。带日期的字符串先按日历校验，否则一条不存在的
  // 时间会被折成一个看起来很正常的时刻——那比丢弃它更糟。
  const calendar = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s]|$)/.exec(trimmed);
  if (calendar !== null) {
    const year = Number(calendar[1]);
    const month = Number(calendar[2]);
    const day = Number(calendar[3]);
    const probe = new Date(Date.UTC(year, month - 1, day));
    if (
      probe.getUTCFullYear() !== year ||
      probe.getUTCMonth() !== month - 1 ||
      probe.getUTCDate() !== day
    ) {
      return null;
    }
  }

  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? null : toSecondIso(date);
}

/**
 * @param {Date} date
 * @returns {string}
 */
function toSecondIso(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}
