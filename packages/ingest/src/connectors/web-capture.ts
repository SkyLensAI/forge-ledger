/**
 * 第二个连接器：**浏览器增量采集**（implement2.md · S23）。
 *
 * 第一个连接器（官方导出）是平台**承诺过**的接口，所以它是 Phase 2 的首选：
 * 插件依赖 DOM，而 DOM 是私有实现细节。现在导出那条路已经端到端跑通，
 * 采集这件事才轮到插件——顺序是"单一来源端到端跑通，再扩来源"，
 * 同时调试两个未知只会得到两个未知。
 *
 * ## 它和一个导出文件的区别：**增量**
 *
 * 一份导出是"到目前为止的全部"；一次采集是"这次新看到的几条"。所以
 * `key` 必须由插件算好（内容寻址，见 `@forge/core` 的 `captureKeyOf`），
 * 而这里**原样收下**：采集端已经判过"这条我没见过"，重算一遍只会得到第二个真相。
 *
 * ## 宽容的边界（与官方导出同一把尺子）
 *
 * 认得出字段的几种常见写法，**但记录级失败一律丢弃并记账**：
 * 没有正文的记录、没有 key 的记录都进 `skipped`。
 * 不猜、不补、不改写原文——改写原文等于在采集层就污染了证据。
 */
import type { RawRecord } from "@forge/core";
import type { ConnectorParseResult, SkippedRecord, SourceConnector } from "../contracts.ts";

export const WEB_CAPTURE_CONNECTOR_ID = "web-capture";

/** 载荷里认得的记录数组字段名。 */
const ITEM_KEYS = ["items", "records", "messages"] as const;

/** 认得的正文字段名。 */
const TEXT_KEYS = ["text", "content", "body"] as const;

export const webCaptureConnector: SourceConnector = {
  id: WEB_CAPTURE_CONNECTOR_ID,
  mediaType: "application/json",

  accepts(text: string): boolean {
    const parsed = parseJson(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const record = parsed as Record<string, unknown>;
    // 判据是**两个都命中**：`capture_version` 是这份格式自己的标记，
    // 而 `host` 是采集的来源。只看字段名会把别的 JSON 认成采集载荷。
    if (typeof record["capture_version"] !== "number") return false;
    if (typeof record["host"] !== "string" || record["host"].length === 0) return false;
    return itemList(record) !== null;
  },

  parse(text: string): ConnectorParseResult {
    const parsed = parseJson(text);
    if (parsed === null) {
      return { records: [], skipped: [{ index: 0, reason: "不是合法 JSON：采集载荷是 JSON" }] };
    }
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      return { records: [], skipped: [{ index: 0, reason: "采集载荷的顶层必须是一个对象" }] };
    }
    const record = parsed as Record<string, unknown>;

    const host = typeof record["host"] === "string" ? record["host"] : "";
    if (host.length === 0) {
      return { records: [], skipped: [{ index: 0, reason: "载荷没有 host：出处要靠它说明「这是哪个站点上说的」" }] };
    }

    const list = itemList(record);
    if (list === null) {
      return {
        records: [],
        skipped: [{ index: 0, reason: `顶层找不到记录数组（认得的字段名：${ITEM_KEYS.join(" / ")}）` }],
      };
    }

    const records: RawRecord[] = [];
    const skipped: SkippedRecord[] = [];

    list.forEach((item, index) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        skipped.push({ index, reason: "这一条不是对象" });
        return;
      }
      const entry = item as Record<string, unknown>;

      // key **不由这里重算**：采集端已经用内容寻址算过一次（`captureKeyOf`）。
      // 在这里再算一遍就是第二个真相，而两份实现漂移的方向永远是更宽松的那份。
      const key = stringOf(entry, ["key"]);
      if (key === null) {
        skipped.push({ index, reason: "这一条没有 key：没有稳定定位键，它无法被引用" });
        return;
      }
      if (!LOCATOR_PATTERN.test(key)) {
        skipped.push({
          index,
          reason: `这一条的 key「${key}」形状不合法（要形如 site/abc123：段里不含空白与反斜杠）——` +
            `它会被拼进 src://…#k: 出处里，形状不对的键在引用时才会炸，离这里很远`,
        });
        return;
      }

      const text = stringOf(entry, [...TEXT_KEYS]);
      if (text === null || text.trim().length === 0) {
        skipped.push({ index, reason: "这一条没有正文（空记录进库只会变成噪音）" });
        return;
      }

      // 时间**必须**由采集端给成绝对的 ISO 8601（UTC、秒）。理由有两层：
      //  1. 事件 IR 的 `occurred_at` 要求这个形状，而"导入的时刻"不是它发生的时间；
      //  2. 页面上的"3 分钟前"只有在**浏览器**里才解得开（那儿有时钟）。
      //     把时钟留在宿主，连接器就仍然是纯函数——纯函数才能被固定字符串测。
      const rawAt = stringOf(entry, ["time", "occurred_at", "timestamp"]);
      if (rawAt === null) {
        skipped.push({ index, reason: `${key} 没有时间：页面上的相对时间要在浏览器里换算成 ISO，缺了它这条进不了事件 IR` });
        return;
      }
      const occurredAt = isoSecond(rawAt);
      if (occurredAt === null) {
        skipped.push({ index, reason: `${key} 的时间「${rawAt}」不是 YYYY-MM-DDTHH:MM:SSZ（UTC、秒精度）` });
        return;
      }

      records.push({
        // 站点已经在 key 里（采集端拼的），所以这里原样收下。
        key,
        occurred_at: occurredAt,
        // 认不出是谁就落 `unknown`，**不丢弃**：丢了会变成"这条没人说过"，
        // 而那是一个比"不知道谁说的"更错的结论（与官方导出同一条）。
        actor: stringOf(entry, ["author", "sender", "from"]) ?? "unknown",
        // 原文**一字不改**：改写原文等于在采集层就污染了证据。
        text: text.replace(/\r\n?/g, "\n"),
      });
    });

    return { records, skipped };
  },
};

/** 事件键的形状，与 `@forge/schema` 的 `KEY_PATTERN` 同一把尺子（出处靠它拼）。 */
const LOCATOR_PATTERN = /^[^\s/\\]+(\/[^\s/\\]+)*$/;

/** ISO 8601，UTC，**秒精度**。带毫秒或带时区偏移的一律不收——形状要统一。 */
const ISO_SECOND_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/**
 * @param {string} raw
 * @returns {string | null}
 */
function isoSecond(raw: string): string | null {
  const text = raw.trim();
  if (!ISO_SECOND_PATTERN.test(text)) return null;
  // 形状对不代表日期存在（`2026-02-31T00:00:00Z`）。`Date.parse` 会把它
  // **静默归一**成 3 月 3 日——所以不能只看 `!Number.isNaN`。判据是
  // "解析再格式化之后必须原样回到同一个字符串"：真实存在的 UTC 秒精度
  // 时间一定满足，被归一过的日期一定不满足。
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) return null;
  const roundTrip = `${new Date(parsed).toISOString().slice(0, 19)}Z`;
  return roundTrip === text ? text : null;
}

/**
 * @param {string} text
 * @returns {unknown | null}
 */
function parseJson(text: string): unknown | null {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * @param {Record<string, unknown>} record
 * @returns {unknown[] | null}
 */
function itemList(record: Record<string, unknown>): unknown[] | null {
  for (const key of ITEM_KEYS) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  return null;
}

/**
 * @param {Record<string, unknown>} record
 * @param {string[]} keys
 * @returns {string | null}
 */
function stringOf(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}
