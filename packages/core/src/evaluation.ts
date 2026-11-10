/**
 * 尺子 —— 纯函数，零 IO。
 *
 * 这个文件只回答两个问题：**"抽得准不准"（打分）** 与 **"够不够格"（比阈值）**。
 * 它不读文件、不碰模型、不看时钟——于是同一把尺子可以量本仓库的 golden 集、
 * 量用户库里的回归集、也可以被 Phase 6 的 Eval 导出（S24）直接复用。
 *
 * 为什么精确率与召回率**都要**卡，而不是卡一个 F1：
 * 这个产品的失败模式是"自信地错"——过期的事实比没有事实更糟。
 * 只看召回率会奖励"什么都抽"的抽取器（把每句话都变成一条 state），
 * 只看精确率会奖励"什么都不抽"的空实现。两个数一起卡，两种退化解都会现形。
 *
 * 为什么分数是**两个数而不是一个综合分**：综合分需要权重，而权重是一个判断，
 * 判断应该发生在人看报告的时候，不该被预先烧进尺子里。
 */
import type { AssetType } from "@forge/schema";

/** 比对单位：这件事被抽成了**哪种**资产，以及它**指回哪个位置**。 */
export interface AssertionRef {
  type: AssetType;
  /** 事件在来源里的定位键。 */
  key: string;
}

export interface CaseOutcome {
  caseId: string;
  expected: AssertionRef[];
  produced: AssertionRef[];
}

export interface ExtractionScores {
  cases: number;
  /** 人工确认过应当被抽出来的断言总数。 */
  expected: number;
  /** 抽取器实际产出的断言总数。 */
  produced: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  /** 0..1。`produced === 0` 时定义为 0——"没产出"不是"没有误报"。 */
  precision: number;
  /** 0..1。`expected === 0` 时定义为 1（没有该抽的，就没漏抽）。 */
  recall: number;
  f1: number;
}

export interface EvalThreshold {
  precision: number;
  recall: number;
}

export interface ThresholdVerdict {
  ok: boolean;
  /** 没够上的项，**排序过**（R6：报告也是产出，也要可 diff）。 */
  misses: string[];
}

/**
 * 逐用例比对后汇总。
 *
 * 同一个 `(type, key)` 在一边出现多次时只算一次（用集合而不是数组）：
 * 抽取器把同一条事件抽成两条类型相同的断言，是措辞问题，不是召回问题。
 * 多出来的条数会体现在产出的**条数**上，而不是被悄悄算成两次命中。
 *
 * @param {CaseOutcome[]} outcomes
 * @returns {ExtractionScores}
 */
export function scoreExtraction(outcomes: CaseOutcome[]): ExtractionScores {
  let expectedTotal = 0;
  let producedTotal = 0;
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;

  for (const outcome of outcomes) {
    const expected = new Set(outcome.expected.map(formatRef));
    const produced = new Set(outcome.produced.map(formatRef));

    expectedTotal += expected.size;
    producedTotal += produced.size;

    for (const ref of produced) {
      if (expected.has(ref)) truePositives += 1;
      else falsePositives += 1;
    }
    for (const ref of expected) {
      if (!produced.has(ref)) falseNegatives += 1;
    }
  }

  const precision = producedTotal === 0 ? 0 : truePositives / producedTotal;
  const recall = expectedTotal === 0 ? 1 : truePositives / expectedTotal;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  return {
    cases: outcomes.length,
    expected: expectedTotal,
    produced: producedTotal,
    truePositives,
    falsePositives,
    falseNegatives,
    precision,
    recall,
    f1,
  };
}

/**
 * 够不够格。
 *
 * **阈值是地板，不是目标**：它回答的是"这个实现是不是坏掉了"，
 * 不是"这个实现够好了吗"。把地板误当目标，就会得到一个刚好卡在阈值上的实现
 * 和一个以为自己在被保护的团队（implement1.md §2.3：绿灯只说明你写的检查通过了）。
 *
 * @param {ExtractionScores} scores
 * @param {EvalThreshold} threshold
 * @returns {ThresholdVerdict}
 */
export function compareToThreshold(scores: ExtractionScores, threshold: EvalThreshold): ThresholdVerdict {
  const misses: string[] = [];
  if (scores.precision < threshold.precision) {
    misses.push(`精确率 ${format(scores.precision)} < 阈值 ${format(threshold.precision)}`);
  }
  if (scores.recall < threshold.recall) {
    misses.push(`召回率 ${format(scores.recall)} < 阈值 ${format(threshold.recall)}`);
  }
  return { ok: misses.length === 0, misses: misses.sort() };
}

/**
 * 四个数字的定点渲染。**不用 `toFixed` 之后直接进输出**：
 * 报告要能被 diff，而 `toFixed` 的行为随参数变（emit.ts 里同一条理由）。
 *
 * @param {number} value
 * @returns {string}
 */
export function format(value: number): string {
  return value.toFixed(3);
}

/**
 * @param {AssertionRef} ref
 * @returns {string}
 */
function formatRef(ref: AssertionRef): string {
  return `${ref.type}@${ref.key}`;
}
