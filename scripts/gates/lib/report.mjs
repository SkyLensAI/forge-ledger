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
