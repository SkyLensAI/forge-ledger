/**
 * Normalizer —— 纯函数，零 IO（implement1.md §3.2 的 7 个窄 agent 之一）。
 *
 * 职责：把连接器吐出的**原始记录**变成合法的**事件 IR**。
 * 强制校验：schema；失败处理：**丢弃 + 记录**，不猜、不补、不改写原文。
 *
 * 为什么丢弃必须留下记录：静默丢弃会让"导入了 1000 条"和"导入了 999 条"
 * 看起来一样。数字对不上是用户唯一能发现采集漏了的信号，
 * 而采集漏了正是这个品类的第一大差评来源。
 *
 * 边界：这里**不做判断**——不判哪句话重要、不判它是不是一条决策。
 * 那是 Extractor（Phase 4）的事，而 Extractor 是模型。这一层必须无模型，
 * 才能在没有任何 API key 的情况下跑通全链路。
 */
import {
  EVENT_SCHEMA_VERSION,
  normalizeActorName,
  summarizeIssues,
  validateEventIR,
  type EventIR,
} from "@forge/schema";

/**
 * 连接器吐出的记录形状。
 *
 * 定义在 core 而不是 ingest：**这是 Normalizer 的输入契约**，
 * 连接器是它的生产者之一（另一个是将来的人工导入）。
 * 契约跟着消费者走，否则第二个消费者出现时就会发现契约长在了别人家里。
 */
export interface RawRecord {
  /** 来源内稳定的定位键（如 `conv_01/turn_03`）——事件 IR 的 `#k:` span 就用它。 */
  key: string;
  /** ISO 8601（UTC，秒精度）。来自导出文件本身，不是"导入的时刻"。 */
  occurred_at: string;
  actor: string;
  /** 原文。**一字不改**——改写原文等于在采集层就污染了证据。 */
  text: string;
}

export interface DiscardedRecord {
  index: number;
  key: string;
  reason: string;
}

export interface NormalizeResult {
  events: EventIR[];
  discarded: DiscardedRecord[];
}

/**
 * @param {string} sourceId `src_` 开头的来源 ID
 * @param {RawRecord[]} records
 * @returns {NormalizeResult}
 */
export function normalizeRecords(sourceId: string, records: RawRecord[]): NormalizeResult {
  const events: EventIR[] = [];
  const discarded: DiscardedRecord[] = [];
  const seen = new Set<string>();

  records.forEach((record, index) => {
    const candidate = {
      schema_version: EVENT_SCHEMA_VERSION,
      source_id: sourceId,
      key: record.key,
      kind: "message",
      occurred_at: record.occurred_at,
      actor: normalizeActor(record.actor),
      text: record.text,
    };

    const parsed = validateEventIR(candidate);
    if (!parsed.ok) {
      discarded.push({ index, key: record.key, reason: summarizeIssues(parsed.issues) });
      return;
    }

    // 同一条来源里 key 重复 = 连接器认错了行。保留第一条并记录，不静默覆盖：
    // 覆盖会让两条不同的原文挤进同一个 ID，而 ID 是引用的锚。
    if (seen.has(parsed.value.key)) {
      discarded.push({
        index,
        key: record.key,
        reason: "来源内 key 重复：定位键必须唯一，否则 span 会指向两个地方",
      });
      return;
    }
    seen.add(parsed.value.key);

    events.push(parsed.value);
  });

  return { events, discarded };
}

/**
 * actor 归一。归一的表在 `@forge/schema`（`normalizeActorName`），
 * 因为它是**连接器契约的一部分**：第二个连接器出现时不能各归各的，
 * 否则同一件事在库里会有两种 actor 写法，而检索会按字符串分组。
 *
 * @param {string} raw
 * @returns {string}
 */
export function normalizeActor(raw: string): string {
  return normalizeActorName(raw);
}
