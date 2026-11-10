/**
 * 事件 IR —— 规范化后的来源片段（directory.md §三：schema 定义**两套 IR**，这是第一套）。
 *
 * 为什么事件 IR 与资产 IR 是两个东西而不是一个：
 * 事件是**来源的投影**（可重算，住在 `index/`，ADR-0016），
 * 资产是**判断的产物**（不可重算，住在 `assets/`）。它们的生命周期完全不同——
 * 事件随来源一起重导，资产一旦写下就不能被重算覆盖。
 * 用一套 IR 表达两者，就必须在字段里塞"这一条到底算不算资产"的开关，
 * 而那个开关迟早会被填错。
 *
 * 字段集刻意很小。每多一个字段，就要多回答一次"它从哪来、能不能被伪造"。
 */
import { z } from "zod";
import { SCHEMA_VERSION } from "./fields.ts";
import { contentAddressedId } from "./ids.ts";
import { validate, type ValidationResult } from "./validate.ts";

/** v1 只有 `message` 一种。其余种类要等 Phase 6 的连接器。 */
export const EVENT_KINDS = ["message"] as const;

export const EVENT_ACTORS = ["user", "assistant", "system", "unknown"] as const;

/** `YYYY-MM-DDTHH:MM:SSZ` —— 秒精度、UTC。 */
const OCCURRED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/**
 * 键路径：`conv_x/msg_03`。它同时是事件在来源里的定位键，
 * 也是 `src://…#k:` 锚点的载荷——所以形状约束与 provenance 的 keyPath 检查一致。
 */
const KEY_PATTERN = /^[^\s/\\]+(\/[^\s/\\]+)*$/;

export const EventIRSchema = z.object({
  schema_version: z.number().int(),
  /** 这份事件来自哪个来源。出处就是靠它 + key 拼出来的 `src://` span。 */
  source_id: z.string().regex(/^src_[0-9A-Za-z]{26}$/, "source_id 形如 src_<26 位 base32>"),
  key: z.string().regex(KEY_PATTERN, "key 形如 conv_x/msg_03：非空段、不含空白与反斜杠"),
  kind: z.enum(EVENT_KINDS),
  occurred_at: z
    .string()
    .regex(OCCURRED_AT_PATTERN, "occurred_at 必须是 YYYY-MM-DDTHH:MM:SSZ（UTC、秒精度）"),
  actor: z.enum(EVENT_ACTORS),
  /**
   * 原文。**一字不改**——改写原文等于在采集层就污染了证据。
   * 空文本被拒绝：没有内容的记录进库只会变成噪音，而噪音会稀释闸门的信噪比。
   */
  text: z.string().min(1, "事件不能是空文本"),
});

export type EventIR = z.infer<typeof EventIRSchema>;

/**
 * @param {unknown} value
 * @returns {ValidationResult<EventIR>}
 */
export function validateEventIR(value: unknown): ValidationResult<EventIR> {
  return validate(EventIRSchema, value);
}

/**
 * 事件的**内容寻址 ID**（ADR-0013）。
 *
 * 三个部分都要进 seed，且要有分隔：
 * 只用 text 会让两条一模一样的消息撞成一个 ID（它们确实是两条不同的记录）；
 * 不加分隔符会让 `("ab","c")` 与 `("a","bc")` 撞车。
 *
 * @param {EventIR} event
 * @returns {string}
 */
export function eventId(event: EventIR): string {
  return contentAddressedId("event_", `${event.source_id} ${event.key} ${event.text}`);
}

/**
 * actor 归一表。
 *
 * 放在 schema 而不是某个连接器里：它是**连接器契约的一部分**。
 * 第二个连接器出现时不能各归各的，否则同一件事在库里会有两种 actor 写法，
 * 而检索会按字符串分组——于是"用户说过的所有事"会漏掉一半。
 *
 * 认不出的落到 `unknown` 而**不是丢弃**：丢了就变成"这条没人说过"，
 * 而"这条没人说过"是一个比"不知道谁说的"更错的结论。
 *
 * @param {string} raw
 * @returns {string}
 */
export function normalizeActorName(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (value === "user" || value === "human" || value === "human_user") return "user";
  if (value === "assistant" || value === "ai" || value === "bot" || value === "model") return "assistant";
  if (value === "system" || value === "tool") return "system";
  return "unknown";
}

/** 当前分类法版本下新建事件用的版本号。 */
export const EVENT_SCHEMA_VERSION = SCHEMA_VERSION;
