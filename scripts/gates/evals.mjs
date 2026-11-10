#!/usr/bin/env node
// @ts-check
/**
 * 闸门 3 的补充判定 · eval 阈值（Phase 3 · S12–S14）
 *
 * 它把 `implement1.md` §2.3 那句话变成红绿：
 * **"绿灯只说明你写的检查通过了，不说明需求被满足了"**。
 * lint 通过、类型干净、测试全绿，都不说明抽取器在把事抽对——
 * 只有对着人工确认过的黄金集量出来的分数才说明。
 *
 * 这个文件是**薄壳**：判定在 `evals/runner/gate.ts`，打分在 `packages/core`。
 * 与 `assets.mjs` 同一条理由（判定住在能被复用的那一侧），
 * 外加一条更实在的：判定住在 `evals/` 才能在落地之前被测试——
 * 闸门本体是受保护路径，agent 写不了，它要等人工落盘才会第一次执行，
 * 而"闸门第一次运行"不该发生在它生效的那一刻。
 *
 * 依赖缺失时降级（与 assets.mjs 一致，ADR-0011）。**但依赖一装好，
 * 后面任何失败都是红**——没有第二个降级出口。区别很重要：
 * "没装依赖"是本机事实，"runner 跑不起来"是缺陷。
 *
 * 用法：
 *   node scripts/gates/evals.mjs
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot } from "./lib/git.mjs";
import { degrade, fail, ok, warn } from "./lib/report.mjs";

const root = repoRoot() ?? process.cwd();

if (!existsSync(join(root, "node_modules"))) {
  warn("[evals] node_modules 未安装，跳过 eval 阈值判定（CI 会装依赖并跑全量）");
  degrade();
}

// 依赖已就位：从这里往后没有降级出口，任何失败都是红。
const RUNNER = join(root, "evals", "runner", "run.ts");
const JUDGE = join(root, "evals", "runner", "gate.ts");
if (!existsSync(RUNNER) || !existsSync(JUDGE)) {
  fail(
    `✗ [evals] ${!existsSync(RUNNER) ? "evals/runner/run.ts" : "evals/runner/gate.ts"} 不存在：` +
      "eval 阈值判定没有载体，闸门形同虚设。",
  );
  process.exit(1);
}

/** @type {any} */
let runner;
/** @type {any} */
let judge;
try {
  runner = await import(pathToFileURL(RUNNER).href);
  judge = await import(pathToFileURL(JUDGE).href);
} catch (error) {
  fail(
    `✗ [evals] eval runner 加载失败：${error instanceof Error ? error.message : String(error)}。` +
      "依赖已装好还跑不起来，这是缺陷，不是降级。",
  );
  process.exit(1);
}

const thresholds = runner.loadThresholds(root);
const measured = runner.EXTRACTORS.get("baseline-lexical");
const dead = runner.EXTRACTORS.get("null");
if (measured === undefined || dead === undefined) {
  fail("✗ [evals] 抽取器登记表里缺 baseline-lexical 或 null：退出条件的反例必须一直在场。");
  process.exit(1);
}

const report = runner.runEval({ repoRoot: root, extractor: measured });
const nullReport = runner.runEval({ repoRoot: root, extractor: dead });

ok(`[evals] 被测实现：${report.extractor}`);
ok(runner.formatReport(report));
ok(
  `[evals] 反例（空实现）：精确率 ${nullReport.scores.precision.toFixed(3)}，` +
    `召回率 ${nullReport.scores.recall.toFixed(3)} —— 必须不及格`,
);

const problems = judge.evaluateEvalGate({ report, nullReport, thresholds });

if (problems.length === 0) {
  ok(`\n✓ [evals] ${report.scores.cases} 条人工确认用例，阈值达标，尺子仍然分得开活的和死的。`);
  process.exit(0);
}

fail(`\n✗ [evals] ${problems.length} 处问题：\n`);
for (const line of judge.formatGateProblems(problems)) fail(line);
fail(
  "\n  修**抽取实现**或修**尺子**，不要调低阈值——" +
    "把阈值调低只会让下一次的问题更晚被发现（闸门红了要修问题，不是修闸门）。\n",
);
process.exit(1);
