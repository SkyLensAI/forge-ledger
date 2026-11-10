#!/usr/bin/env node
/**
 * `forge eval` 的雏形 —— 在终端里跑一次尺子。
 *
 * 它和闸门（`scripts/gates/evals.mjs`）跑的是**同一个** `runEval`：
 * 两处各写一份判定，就会出现"本地绿、CI 红"，而这类漂移的结局是所有人
 * 开始认为"闸门就是会偶尔抽风"。闸门只多管两件 CLI 不该管的事——
 * golden 集有没有被人工确认、以及尺子本身还睁不睁着眼。
 *
 * 用法：
 *   node evals/runner/main.ts                          # 默认跑词法基线
 *   node evals/runner/main.ts --extractor null         # 反例：空实现必须不及格
 *   node evals/runner/main.ts --list                    # 列出可驱动的实现
 */
import { EXTRACTORS, REPO_ROOT, formatReport, runEval } from "./run.ts";

/**
 * @param {string} name
 * @returns {string | null}
 */
function argValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value === undefined ? null : value;
}

if (process.argv.includes("--list")) {
  process.stdout.write(`可驱动的抽取实现：\n`);
  for (const id of [...EXTRACTORS.keys()].sort()) process.stdout.write(`  ${id}\n`);
  process.exit(0);
}

const requested = argValue("--extractor") ?? "baseline-lexical";
const extractor = EXTRACTORS.get(requested);
if (extractor === undefined) {
  process.stderr.write(
    `✗ 没有 id 为「${requested}」的抽取实现。可用的：${[...EXTRACTORS.keys()].sort().join(" / ")}\n`,
  );
  process.exit(2);
}

const report = runEval({ repoRoot: REPO_ROOT, extractor });
process.stdout.write(`${formatReport(report)}\n`);

if (report.goldenIssues.length > 0) {
  process.stderr.write(`\n✗ 尺子自身有问题 ${report.goldenIssues.length} 处（分数不可采信）：\n`);
  for (const issue of report.goldenIssues) process.stderr.write(`  - ${issue}\n`);
}
if (report.candidateViolations.length > 0) {
  process.stderr.write(`\n✗ 候选断言违反信任边界 ${report.candidateViolations.length} 处：\n`);
  for (const violation of report.candidateViolations) {
    process.stderr.write(`  [${violation.code}] ${violation.path}\n      ${violation.message}\n`);
  }
}
if (!report.verdict.ok) {
  process.stderr.write(`\n✗ 没够上阈值：${report.verdict.misses.join("；")}\n`);
}
process.stderr.write(`\n· golden 集审核状态：${report.review.status}（${report.review.reviewed_by ?? "无人"}）\n`);

process.exit(
  report.goldenIssues.length === 0 && report.candidateViolations.length === 0 && report.verdict.ok ? 0 : 1,
);
