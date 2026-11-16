/**
 * eval runner —— 尺子的执行体。
 *
 * 它做四件事，而且**只**做这四件事：
 *   1. 读 golden 集，并**先审尺子自己**（用例的出处解析得到吗、事件合 schema 吗）
 *   2. 把用例喂给一个可替换的抽取实现
 *   3. 用 `judgeCandidates` 判产出（那条信任边界）
 *   4. 打分、比阈值、把明细打出来
 *
 * 为什么"先审尺子自己"是第一步：一把量不准的尺子比没有尺子更糟——
 * 它会让"分数还行"看起来像结论。用例的 `span` 解析不到、期望的 key 在输入里不存在，
 * 这两种情况下分数都没有意义，所以它们走 `goldenIssues` 这条**独立的**通道，
 * 而不是被混进"抽取器不及格"。
 *
 * IO 在这里是允许的（`evals/` 是工具目录，不是 `packages/core`）：
 * 判定与打分全在 core 的纯函数里，这里只负责把文件读进来、把结果打出去。
 *
 * 导入用的是**相对路径**而不是 workspace 包名：`evals/` 不是 workspace 成员
 * （ADR-0018 的判据——出现第二个消费者再下沉；这里只是一个开发工具，
 * 没有第二个消费者）。相对路径让 `pnpm install` 不需要为它建一层链接。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertionKeyOf,
  compareToThreshold,
  format,
  formatSpan,
  judgeCandidates,
  parseSpan,
  scoreExtraction,
  type AssertionRef,
  type CandidateAssertion,
  type CaseOutcome,
  type EvalThreshold,
  type ExtractionInput,
  type ExtractionScores,
  type Extractor,
  type ThresholdVerdict,
  type Violation,
} from "../../packages/core/src/index.ts";
import {
  EVENT_SCHEMA_VERSION,
  contentAddressedId,
  normalizeActorName,
  summarizeIssues,
  validateEventIR,
  type AssetType,
  type EventIR,
} from "../../packages/schema/src/index.ts";
import { buildSpanIndex } from "../../packages/store/src/index.ts";
import { baselineExtractor } from "../extractors/baseline.ts";
import { nullExtractor } from "../extractors/null.ts";
import { hostileExtractor, modelReplayExtractor } from "../extractors/model.ts";
import { runTrustProbe, type TrustProbeResult } from "./trust.ts";
import { runConflictProbe, type ConflictProbeResult } from "./conflict.ts";
import { runRetrievalProbe, type RetrievalProbeResult } from "./retrieval.ts";
import { runMaintenanceProbe, type MaintenanceProbeResult } from "./maintenance.ts";
import { runPhase8Probe, type Phase8ProbeResult } from "./phase8.ts";

/** 仓库根：从本文件位置推，不依赖 cwd——CI 里 cwd 未必是仓库根。 */
export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * golden 集的确认记录与指纹住在 `./review.ts`：两把尺子（extraction / conflict）
 * 必须共用同一份机制，而它们各写一份的结局是"确认"这个词在两处含义不同。
 */
export { digestOf, type ReviewRecord } from "./review.ts";
import { digestOf, type ReviewRecord } from "./review.ts";

/** golden 用例的**原始形状**（文件里长什么样）。 */
export interface RawCase {
  id: string;
  about: string;
  span: string;
  /**
   * 这条用例的事件来自哪个来源。**可以省略**——省略时由用例 ID 内容寻址推出来
   * （`sourceIdOf`，ADR-0013：能重算的东西不该有第二个真相）。
   *
   * 什么时候必须显式写：**导出**出来的用例集（`forge emit --evals`）。
   * 那些用例的 ID 取自来源本身，于是"ID 推出 source_id、source_id 又来自 ID"
   * 成了一个环；显式写下来，环就断了，而导出的集合也因此能被这把尺子直接跑。
   */
  source_id?: string;
  events: Array<{ key: string; occurred_at: string; actor: string; text: string }>;
  expected: Array<{ type: AssetType; key: string; why: string }>;
  expected_why?: string;
}

export interface GoldenSet {
  schema_version: number;
  kind: string;
  about: string;
  review: ReviewRecord;
  cases: RawCase[];
}

export interface CaseDetail {
  id: string;
  expected: AssertionRef[];
  produced: AssertionRef[];
  /** 命中的（期望 ∩ 产出）。 */
  hit: AssertionRef[];
  /** 漏掉的：期望里有、产出里没有。这是"模型漏在哪"的直接证据。 */
  missed: AssertionRef[];
  /** 多出来的：产出里有、期望里没有。 */
  extra: AssertionRef[];
}

export interface EvalReport {
  extractor: string;
  scores: ExtractionScores;
  threshold: EvalThreshold;
  verdict: ThresholdVerdict;
  review: ReviewRecord;
  /** 本次实际跑的用例的指纹。**与 `review.cases_sha256` 对不上就说明这份确认过期了。** */
  goldenDigest: string;
  /** 本次实际用的阈值的指纹。同上。 */
  thresholdsDigest: string;
  /** 尺子自身的问题。非空 = 分数不可采信。 */
  goldenIssues: string[];
  /** 违反信任边界的候选（编造出处、没有出处…）。非空 = 这批产出不许往下走。 */
  candidateViolations: Violation[];
  /**
   * 信任边界的探针结果（S15/S16）。**它测的不是分数，是边界还在不在。**
   *
   * 为什么不把它做成一个独立的入口让闸门去调：入口会被人忘掉，而
   * "忘了调它"和"调了它是绿的"在闸门上长得一模一样。
   * 放进报告里，任何一次评测都顺带回答了这个问题——成本是几微秒。
   */
  trust: TrustProbeResult;
  /**
   * 冲突判定的探针（S18–S20）。与 `trust` 同一个形状、同一条理由：
   * **它测的不是分数，是队列还在不在工作、以及它有没有越权。**
   */
  conflict: ConflictProbeResult;
  /**
   * 取用探针（S21）。与前两个同一个形状、同一条理由：
   * **它测的不是分数，是"注入预算"这条边界还在不在**——
   * 而那是 implement2.md 给 P6 写的 CI 强制项。
   */
  retrieval: RetrievalProbeResult;
  /**
   * 维护机器的探针（S25–S28）。与前三个同一个形状、同一条理由：
   * **它测的不是分数，是"每一次写入都有见证人"与"健康检查分得开好坏"这两条边界还在不在**——
   * 而 implement2.md 给 P7 写的那条 CI 强制项正是**审计完整性**。
   */
  maintenance: MaintenanceProbeResult;
  /**
   * Phase 8 的探针（S29–S32）：自举的 ADR 底线、团队版顺序、上架包与 demo
   * 是否是可重生成的投影、以及 demo 是否真的来自自己的库。
   */
  phase8: Phase8ProbeResult;
  details: CaseDetail[];
}

export interface Thresholds {
  version: number;
  extraction: {
    precision: number;
    recall: number;
    ratified_by: string | null;
    ratified_at: string | null;
    /** 被批准的那一组数字的指纹，理由同 `ReviewRecord.cases_sha256`。 */
    thresholds_sha256?: string;
    why: string;
  };
}

/**
 * 可被 runner 驱动的实现。加一个实现 = 在这张表里加一行（Phase 4 的 LLM 版从这里进）。
 *
 * 表里有两台**探针**（`null` / `hostile-probe`），它们的分数都没有意义——
 * 有意义的是闸门拿它们跑的两条检查：`E4`（尺子还分得开活的死的）与
 * `E7`（信任边界还连着）。把它们放在同一张表里，是为了让"探针也在场"这件事
 * 只需要看一个地方。
 */
export const EXTRACTORS: ReadonlyMap<string, Extractor> = new Map(
  [baselineExtractor, nullExtractor, modelReplayExtractor, hostileExtractor].map((extractor) => [
    extractor.id,
    extractor,
  ]),
);

/**
 * 用例的来源 ID：**由用例 ID 内容寻址**。
 *
 * 为什么不写在用例文件里：写死一串 `src_…` 会诱使人手改它，而它一旦被改，
 * 用例里所有 `#k:` 就指向了另一个来源。派生出来的东西不该有第二个真相（ADR-0013）。
 *
 * @param {string} caseId
 * @returns {string}
 */
export function sourceIdOf(caseId: string): string {
  return contentAddressedId("src_", `golden/extraction/${caseId}`);
}

/**
 * 读 golden 集。**读不动就抛**——尺子读不出来时静默给一个空集，
 * 会让"0 条用例、0 分"看起来像一次正常评测。
 *
 * @param {string} repoRoot
 * @returns {GoldenSet}
 */
export function loadGoldenSet(repoRoot: string): GoldenSet {
  const path = join(repoRoot, "evals", "golden", "extraction", "cases.json");
  return JSON.parse(readFileSync(path, "utf8")) as GoldenSet;
}

/**
 * @param {string} repoRoot
 * @returns {Thresholds}
 */
export function loadThresholds(repoRoot: string): Thresholds {
  const path = join(repoRoot, "evals", "thresholds.json");
  return JSON.parse(readFileSync(path, "utf8")) as Thresholds;
}

/**
 * 跑一次评测。
 *
 * @param {{ repoRoot: string, extractor: Extractor }} options
 * @returns {EvalReport}
 */
export function runEval(options: { repoRoot: string; extractor: Extractor }): EvalReport {
  const set = loadGoldenSet(options.repoRoot);
  const thresholds = loadThresholds(options.repoRoot);
  const threshold: EvalThreshold = {
    precision: thresholds.extraction.precision,
    recall: thresholds.extraction.recall,
  };

  const spanIndex = buildSpanIndex({ sources: null, workspaces: [options.repoRoot] });
  const goldenIssues: string[] = [];
  const candidateViolations: Violation[] = [];
  const outcomes: CaseOutcome[] = [];
  const details: CaseDetail[] = [];

  // 用例 ID 重复 = 两条用例在报告里长得一样，人分不出漏的是哪一条。
  const seenIds = new Set<string>();

  for (const raw of set.cases) {
    if (seenIds.has(raw.id)) goldenIssues.push(`用例 ID 重复：${raw.id}`);
    seenIds.add(raw.id);

    // ── 尺子自身的出处：每条用例的判据必须指得回仓库里的一处原文 ──────────
    const parsedSpan = parseSpan(raw.span ?? "");
    if (!parsedSpan.ok) {
      goldenIssues.push(`${raw.id}：判据的 span 不合法——${parsedSpan.reason}`);
    } else if (spanIndex.lookup(formatSpan(parsedSpan.span)).kind !== "resolved") {
      goldenIssues.push(
        `${raw.id}：判据的 span 解析不到（${formatSpan(parsedSpan.span)}）——` +
          `一条指不回原文的 golden 用例，就是一条凭空发明的标准答案。`,
      );
    }

    // ── 事件必须过事件 IR 的 schema ────────────────────────────────────
    const sourceId = raw.source_id ?? sourceIdOf(raw.id);
    const events: EventIR[] = [];
    for (const event of raw.events ?? []) {
      const validated = validateEventIR({
        schema_version: EVENT_SCHEMA_VERSION,
        source_id: sourceId,
        key: event.key,
        kind: "message",
        occurred_at: event.occurred_at,
        actor: normalizeActorName(event.actor),
        text: event.text,
      });
      if (validated.ok) events.push(validated.value);
      else goldenIssues.push(`${raw.id}：事件 ${event.key} 不合法——${summarizeIssues(validated.issues)}`);
    }

    const eventKeys = new Set(events.map((event) => event.key));
    const expected: AssertionRef[] = [];
    for (const item of raw.expected ?? []) {
      if (!eventKeys.has(item.key)) {
        goldenIssues.push(
          `${raw.id}：期望断言指向 ${item.key}，但这条用例的输入里没有这条事件——` +
            `标准答案对不上题目，分数就没有意义。`,
        );
        continue;
      }
      expected.push({ type: item.type, key: item.key });
    }

    // ── 跑抽取器 + 判信任边界 ─────────────────────────────────────────
    const input: ExtractionInput = { sourceId, events };
    let produced: CandidateAssertion[] = [];
    try {
      produced = options.extractor.extract(input);
    } catch (error) {
      // 抽取器抛错记成一条违规，而不是让整次评测崩掉：崩掉的评测没有任何信息量，
      // 而"它在第 7 条用例上炸了"是一条能修的信息。
      candidateViolations.push({
        code: "CAND_EXTRACTOR_THREW",
        path: raw.id,
        message: `抽取器 ${options.extractor.id} 在用例 ${raw.id} 上抛错：${
          error instanceof Error ? error.message : String(error)
        }`,
        fix: "先修抽取器的异常；让它抛错的那些输入，正是它最该被看见的地方",
      });
      produced = [];
    }
    candidateViolations.push(...judgeCandidates(input, produced));

    // 没有可解析出处的候选不参与比对——它已经被判红了，混进分数只会把两种错揉成一团。
    const producedRefs: AssertionRef[] = [];
    for (const candidate of produced) {
      const key = assertionKeyOf(candidate);
      if (key === null) continue;
      const at = key.indexOf("@");
      producedRefs.push({ type: key.slice(0, at) as AssetType, key: key.slice(at + 1) });
    }

    outcomes.push({ caseId: raw.id, expected, produced: producedRefs });
    details.push(detailOf(raw.id, expected, producedRefs));
  }

  const scores = scoreExtraction(outcomes);
  return {
    extractor: options.extractor.id,
    scores,
    threshold,
    verdict: compareToThreshold(scores, threshold),
    review: set.review,
    goldenDigest: digestOf(set.cases),
    thresholdsDigest: digestOf({ precision: threshold.precision, recall: threshold.recall }),
    goldenIssues: goldenIssues.sort(),
    candidateViolations,
    trust: runTrustProbe(),
    conflict: runConflictProbe(options.repoRoot),
    retrieval: runRetrievalProbe(options.repoRoot),
    maintenance: runMaintenanceProbe(options.repoRoot),
    phase8: runPhase8Probe(options.repoRoot),
    details,
  };
}

/**
 * @param {string} caseId
 * @param {AssertionRef[]} expected
 * @param {AssertionRef[]} produced
 * @returns {CaseDetail}
 */
function detailOf(caseId: string, expected: AssertionRef[], produced: AssertionRef[]): CaseDetail {
  const expectedSet = new Set(expected.map(refKey));
  const producedSet = new Set(produced.map(refKey));
  return {
    id: caseId,
    expected,
    produced,
    hit: produced.filter((ref) => expectedSet.has(refKey(ref))),
    missed: expected.filter((ref) => !producedSet.has(refKey(ref))),
    extra: produced.filter((ref) => !expectedSet.has(refKey(ref))),
  };
}

/**
 * @param {AssertionRef} ref
 * @returns {string}
 */
function refKey(ref: AssertionRef): string {
  return `${ref.type}@${ref.key}`;
}

/** 人类可读的报告。**顺序全部排序过**，否则两次运行的 diff 全是噪音（R6）。 */
export function formatReport(report: EvalReport): string {
  const lines: string[] = [];
  lines.push(`抽取评测 · 实现 = ${report.extractor}`);
  lines.push(
    `  用例 ${report.scores.cases} 条 · 期望 ${report.scores.expected} 条 · 产出 ${report.scores.produced} 条`,
  );
  lines.push(
    `  命中 ${report.scores.truePositives} · 误报 ${report.scores.falsePositives} · 漏报 ${report.scores.falseNegatives}`,
  );
  lines.push(
    `  精确率 ${format(report.scores.precision)}（阈值 ${format(report.threshold.precision)}）` +
      ` · 召回率 ${format(report.scores.recall)}（阈值 ${format(report.threshold.recall)}）` +
      ` · F1 ${format(report.scores.f1)}`,
  );

  const missed = report.details.filter((detail) => detail.missed.length > 0);
  if (missed.length > 0) {
    lines.push("  漏报明细：");
    for (const detail of missed) lines.push(`    ${detail.id} 漏：${detail.missed.map(refKey).join("、")}`);
  }
  const extra = report.details.filter((detail) => detail.extra.length > 0);
  if (extra.length > 0) {
    lines.push("  误报明细：");
    for (const detail of extra) lines.push(`    ${detail.id} 多：${detail.extra.map(refKey).join("、")}`);
  }

  // 信任边界的状态**每次都打**，不只是红的时候。一行"边界还连着"是这个产品
  // 最便宜的一份安心；而它缺席的时候，没有人会想起去问。
  lines.push(
    `  信任边界：${report.trust.ok ? "连着" : "**被越过**"}` +
      `（探针存活 ${String(report.trust.inboxed)} 条 · 丢弃 ${String(report.trust.discarded)} 条 · ` +
      `越界 ${String(report.trust.violationsAfterSanitize)} 条 · 自动入库 ${String(report.trust.admitted)} 条）`,
  );
  for (const line of report.trust.detail) lines.push(`    ${line}`);

  // 维护那三条边界同样每次都打（P7 的 CI 强制项：审计完整性）。
  lines.push(
    `  维护：${report.maintenance.ok ? "边界都还在" : "**边界被越过了**"}` +
      `（审计 ${String(report.maintenance.audit.entries)} 条 · 抓住破坏 ${String(report.maintenance.audit.caught.length)}/3 · ` +
      `语料 ${String(report.maintenance.health.corpora)} 组 · 干净组发现 ${String(report.maintenance.health.cleanFindings)} 条 · ` +
      `规模 ${String(report.maintenance.scale.assets)} 条）`,
  );
  for (const line of [
    ...report.maintenance.audit.detail,
    ...report.maintenance.health.detail,
    ...report.maintenance.scale.detail,
  ]) {
    lines.push(`    ${line}`);
  }

  // 取用那两条边界同样每次都打（P6 的 CI 强制项）。
  lines.push(
    `  取用：${report.retrieval.ok ? "预算守住了" : "**边界被越过**"}` +
      `（语料 ${String(report.retrieval.corpus)} 条 · 注入 ${String(report.retrieval.injected)} 条 · ` +
      `无关 ${String(report.retrieval.irrelevant)} 条 · ` +
      `单块最大 ${String(report.retrieval.maxBlockTokens)}/${String(report.retrieval.budget)} token）`,
  );
  for (const line of report.retrieval.detail) lines.push(`    ${line}`);

  // Phase 8：自举 / 团队版顺序 / 上架 / demo，同样每次都打。
  // 团队版的违规单独由 `E16` 负责，所以这里的"绿"要把两边一起看。
  const phase8Green = report.phase8.ok && report.phase8.team.violations.length === 0;
  lines.push(
    `  自举与分发：${phase8Green ? "边界都还在" : "**边界被越过**"}` +
      `（ADR ${String(report.phase8.adrCount)}/${String(report.phase8.adrTarget)} · ` +
      `demo ${String(report.phase8.demoFiles)} 个文件 · listing ${String(report.phase8.listingFiles)} 个文件 · ` +
      `团队版 ${report.phase8.team.eligibility}）`,
  );
  for (const line of report.phase8.detail) lines.push(`    ${line}`);

  return lines.join("\n");
}
