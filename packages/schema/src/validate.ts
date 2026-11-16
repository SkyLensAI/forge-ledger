/**
 * 校验结果的**统一形状**。
 *
 * 为什么不让 `@forge/core` 直接用 zod 的类型：core 是纯逻辑包，
 * 不该因为"校验库换了"而重编译；而且 zod 的 issue 形状是它的实现细节，
 * 泄漏出去就等于把 zod 变成了公共 API。
 *
 * 这里只暴露两个形状窄到可以穷举的接口：合法 → 值；不合法 → 问题列表。
 * 没有"部分成功"这一档——半吊子的校验结果和半吊子的 front-matter 一样难查。
 */
import type { ZodType } from "zod";

export interface ValidationIssue {
  path: readonly PropertyKey[];
  message: string;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; issues: ValidationIssue[] };

/**
 * @template T
 * @param {ZodType<T>} schema
 * @param {unknown} value
 * @returns {ValidationResult<T>}
 */
export function validate<T>(schema: ZodType<T>, value: unknown): ValidationResult<T> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
  };
}

/**
 * @param {readonly ValidationIssue[]} issues
 * @returns {string}
 */
export function summarizeIssues(issues: readonly ValidationIssue[]): string {
  return issues
    .map((issue) => `${issue.path.map(String).join(".") || "(根)"}：${issue.message}`)
    .join("；");
}
