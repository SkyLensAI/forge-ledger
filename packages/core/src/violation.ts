/**
 * 违规的**唯一形状**。
 *
 * 为什么四个字段缺一不可：闸门输出是给人看的行动指令，不是日志。
 * `code` 让机器能统计"哪一类错在反复发生"（棘轮的输入），
 * `path` 指到具体文件，`message` 说清**为什么**这是错的，
 * `fix` 说清**下一步做什么**——只报错不给修法的闸门会被绕过，
 * 因为绕过比重读一遍文档便宜。
 *
 * 这里定义而不是放在 scripts/gates 里：判定的执行体在 `packages/core`（R5），
 * 闸门只是它的一个宿主。形状定义在被复用的那一侧，宿主侧才不会漂移。
 */
export interface Violation {
  code: string;
  path: string;
  message: string;
  fix: string;
}

/**
 * @param {Violation} violation
 * @returns {string}
 */
export function formatViolation(violation: Violation): string {
  return [
    `  [${violation.code}] ${violation.path}`,
    `      ${violation.message}`,
    `      → ${violation.fix}`,
  ].join("\n");
}

/**
 * 判定结果的排序：**确定性**（R6）在错误输出上也成立。
 * 否则两次运行的报告顺序可能不同，diff 会变成噪音。
 *
 * 排序键是 (path, code)，不是插入顺序——插入顺序依赖遍历顺序，而遍历顺序是隐式契约。
 *
 * @param {Violation[]} violations
 * @returns {Violation[]}
 */
export function sortViolations(violations: Violation[]): Violation[] {
  return [...violations].sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    return 0;
  });
}
