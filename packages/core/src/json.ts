/**
 * 确定性 JSON —— 键递归排序、两空格缩进、LF、末尾一个换行。
 *
 * 为什么不用 `JSON.stringify(value, null, 2)` 直接输出：它保留**插入顺序**，
 * 而插入顺序来自代码路径——同一条数据经由不同路径构造出来会得到不同字节，
 * 于是"同一份数据"在 diff 里看起来变了（R6）。
 *
 * 它原本住在 `@forge/store`（写队列记录时用）。Phase 6 出现了第二个消费者
 * （`forge emit --evals` 要导出确定性的 JSON 用例集），于是按 ADR-0018 的判据下沉到这里：
 * **出现第二个消费者再下沉**。`@forge/store` 仍然从它那里转出去，
 * 所以老的调用点一行都不用改。
 *
 * @param {unknown} value
 * @returns {string}
 */
export function stableJson(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

/**
 * **单行**确定性 JSON：键排序、没有缩进、末尾没有换行。
 *
 * 它存在是因为 JSONL（一行一条）这个格式的名字就是它的契约：
 * 一条记录占一行。把缩进版塞进去，"一行一条"这句话立刻不成立——
 * 而失败的样子很隐蔽：写入看着正常，读的时候每一行都解析失败。
 * 审计日志第一次跑就是这么坏的（`evals/regressions/0006`）。
 *
 * @param {unknown} value
 * @returns {string}
 */
export function stableJsonLine(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value !== "object" || value === null) return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) out[key] = sortKeys(source[key]);
  return out;
}
