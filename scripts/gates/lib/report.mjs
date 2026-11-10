// @ts-check
/**
 * 闸门输出格式：给人看的时候要能直接照做，给 CI 看的时候要能定位到文件。
 */

/**
 * @param {import('./policy.mjs').Violation[]} violations
 * @returns {string}
 */
export function formatViolations(violations) {
  const lines = ["", `✗ 闸门拦下 ${violations.length} 项：`, ""];
  for (const violation of violations) {
    lines.push(`  [${violation.code}] ${violation.path}`);
    lines.push(`      ${violation.message}`);
    lines.push(`      → ${violation.fix}`);
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * @param {import('./harness.mjs').Finding[]} findings
 * @returns {string}
 */
export function formatFindings(findings) {
  const lines = ["", `✗ harness 完整性检查失败 ${findings.length} 项：`, ""];
  for (const finding of findings) {
    lines.push(`  [${finding.code}] ${finding.message}`);
    lines.push(`      → ${finding.fix}`);
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * @param {string} text
 * @returns {void}
 */
export function fail(text) {
  process.stderr.write(`${text}\n`);
}

/**
 * @param {string} text
 * @returns {void}
 */
export function ok(text) {
  process.stdout.write(`${text}\n`);
}

/**
 * 降级前的留痕。**必须用 stderr**：stdout 是"判定通过了"的通道，
 * 把"这项没查"混进去，管道下游分不出这两件事。
 *
 * @param {string} text
 * @returns {void}
 */
export function warn(text) {
  process.stderr.write(`${text}\n`);
}

/**
 * 明确地**放弃判定**并放行。
 *
 * 为什么单独一个函数而不是直接 `process.exit(0)`：写下来的是"这次没查"这件事本身。
 * 一个静默的 `exit(0)` 在 CI 日志里和"查过了、没问题"长得一模一样——
 * 而"无法校验"和"校验通过"必须是两种不同的输出（ADR-0009 的同一条理由）。
 *
 * @returns {never}
 */
export function degrade() {
  process.stderr.write("[gate] ⚠ 本次判定被跳过（降级）。这不是通过，是没查。\n");
  process.exit(0);
}
