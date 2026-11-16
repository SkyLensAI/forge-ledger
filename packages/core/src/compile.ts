/**
 * 编译 —— 纯函数，零 IO。
 *
 * Phase 2 的编译只做**确定性**的那一半：来源字节 → 事件 IR。
 * 为什么只到这一步：`event` 之外的类型（`state` / `decision` / `rule`）都需要
 * "这句话算不算一条决策"这类判断，而那是 Extractor（Phase 4）的活——Extractor 是模型。
 * 把"模型能做的事"和"必须没有模型也能做的事"分开，才能让"没有 API key 跑通全链路"成立。
 *
 * **事件不进 `assets/`**（ADR-0016）：它是 sources 的纯函数，逐字节可重算，
 * 所以它住在 `index/`。判据是可重算性，不是"看起来像不像产物"。
 * 这条线让资产计数保持是人能读完的规模——闸门的信噪比是它的生命线。
 */
import { normalizeRecords, type DiscardedRecord, type RawRecord } from "./normalize.ts";
import type { EventIR } from "@forge/schema";

/**
 * 一次"来源 → 事件"的输入。
 *
 * `parse` 是函数而不是连接器对象：这样 `@forge/core` 不需要依赖 `@forge/ingest`，
 * 依赖方向保持"边缘依赖核心"。同时它让测试可以喂一个固定字符串的假连接器——
 * 真实导出文件进不了 git（R1/R9），而连接器必须是可测的。
 */
export interface DeriveInput {
  id: string;
  text: string;
  parse(text: string): { records: RawRecord[] };
}

export interface DeriveResult {
  events: EventIR[];
  discarded: DiscardedRecord[];
}

/**
 * @param {DeriveInput[]} inputs
 * @returns {DeriveResult}
 */
export function deriveEvents(inputs: DeriveInput[]): DeriveResult {
  const events: EventIR[] = [];
  const discarded: DiscardedRecord[] = [];

  for (const input of inputs) {
    let records: RawRecord[];
    try {
      records = input.parse(input.text).records;
    } catch (error) {
      // 连接器抛错不能让整次编译静默少一截来源：记成一条丢弃。
      discarded.push({
        index: 0,
        key: input.id,
        reason: `连接器抛错：${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    const normalized = normalizeRecords(input.id, records);
    events.push(...normalized.events);
    discarded.push(...normalized.discarded);
  }

  // 排序：连接器遍历 JSON 的顺序不该出现在编译结果里（R6）。
  // 排序键是显式的 (source_id, key)，不是"谁先被处理"。
  events.sort((a, b) => {
    if (a.source_id !== b.source_id) return a.source_id < b.source_id ? -1 : 1;
    return a.key < b.key ? -1 : 1;
  });

  return { events, discarded };
}

/**
 * 资产的确定性排序：先按类型，再按 ID。
 *
 * 为什么不用"插入顺序"：插入顺序依赖遍历顺序，而遍历顺序是隐式的
 * ——换个文件系统、换个 `readdir` 实现就会变。显式排序键是 R6 要的那个"确定"。
 *
 * @param {import("@forge/schema").AssetDoc[]} docs
 * @returns {import("@forge/schema").AssetDoc[]}
 */
export function sortAssets(docs: import("@forge/schema").AssetDoc[]): import("@forge/schema").AssetDoc[] {
  return [...docs].sort((a, b) => {
    if (a.frontMatter.type !== b.frontMatter.type) {
      return a.frontMatter.type < b.frontMatter.type ? -1 : 1;
    }
    if (a.frontMatter.id !== b.frontMatter.id) return a.frontMatter.id < b.frontMatter.id ? -1 : 1;
    return 0;
  });
}

/**
 * 事件在投影里的标题：原文第一行压平后截断。
 * 截断长度是常量而不是"视情况"——它会进输出（R6）。
 *
 * @param {EventIR} event
 * @returns {string}
 */
export function eventTitleOf(event: EventIR): string {
  const flat = event.text.split(/\s+/).filter((piece) => piece.length > 0).join(" ");
  const head = flat.length > 0 ? flat : event.key;
  return head.length > 80 ? `${head.slice(0, 80)}…` : head;
}

/**
 * @param {string} iso
 * @returns {string} `YYYY-MM-DD`（UTC）
 */
export function dateOf(iso: string): string {
  return iso.slice(0, 10);
}
