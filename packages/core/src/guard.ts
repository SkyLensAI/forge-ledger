/**
 * 入库守卫 —— 决定一条候选断言能不能进正式资产。纯函数，零 IO（S16）。
 *
 * 它是全项目**唯一**的"从提议到资产"的闸口。守卫只回答三选一：
 *
 * | 判定 | 含义 | 去向 |
 * |---|---|---|
 * | `admit` | 结构上有出处、置信度够高、而且**不是模型提的** | `assets/` |
 * | `inbox` | 还拿不准 | 候选区 `_inbox/`，等人确认 |
 * | `reject` | 出处站不住 | 丢掉，并留下带修法的违规 |
 *
 * 三条判据，各自对应一个具体出过的错：
 *
 * 1. **出处先审一遍（`judgeCandidates`）。** 守卫不假设上游一定 sanitize 过。
 *    这一层不是冗余——它是"换个人调用守卫"时的兜底。信任边界写在**判定的内部**，
 *    调用方就无从绕过它（这就是探针 `evals/extractors/hostile.ts` 要测的那件事）。
 * 2. **模型产出永不自动入库。** 与置信度无关、与策略无关，**不可配置**。
 *    把它做成一个配置项，等于给"让模型直接写正式资产"留了一个旋钮，
 *    而那个旋钮迟早会被拧（implement1.md 反模式 6：让运行时的 agent 自动覆盖
 *    用户已有的状态，信任一次崩掉就回不来）。
 * 3. **其余按置信度线。** 这一条才是可配置的，因为"多确定才算确定"是人的判断。
 *
 * 为什么守卫在 `packages/core` 而不是在 CLI 里：第二个消费者（MCP server）
 * 已经写在路线图上（S22），而两份守卫实现漂移的结局是"从一个入口进去的候选
 * 能直接进 assets"——那是本文件第 2 条要防的事，不该从后门回来（R5）。
 */
import { ASSET_TYPES } from "@forge/schema";
import {
  CANDIDATE_CODES,
  judgeCandidates,
  type CandidateAssertion,
  type ExtractionInput,
} from "./extract.ts";
import { sortViolations, type Violation } from "./violation.ts";

/** 守卫的三个判定。 */
export const ADMISSION = {
  /** 进正式资产。 */
  ADMIT: "admit",
  /** 进候选区，等人确认（S16："不确定的一律进候选区"）。 */
  INBOX: "inbox",
  /** 丢掉。 */
  REJECT: "reject",
} as const;

export type Admission = (typeof ADMISSION)[keyof typeof ADMISSION];

/**
 * 判定的**理由码**。与 `Violation.code` 不同：理由码说的是"为什么走到这一格"，
 * 它不需要修法（判定已经做完了），只需要能被统计——
 * "这个库里有多少条候选是因为出处站不住被丢的"是棘轮的输入。
 */
export const ADMISSION_REASONS = {
  /** 提议来自模型：永不自动入库。 */
  MODEL_NEVER_AUTO: "origin-model-never-auto",
  /** 置信度低于自动入库线。 */
  BELOW_THRESHOLD: "confidence-below-threshold",
  /** 出处站不住。 */
  PROVENANCE_UNVERIFIED: "provenance-unverified",
  /** 出处站得住，置信度够，且不是模型提的。 */
  CLEARED: "origin-and-confidence-cleared",
} as const;

export type AdmissionReason = (typeof ADMISSION_REASONS)[keyof typeof ADMISSION_REASONS];

/**
 * 自动入库的**可配置**部分。刻意只有一项：
 * 多一个开关就多一条"谁把这个开关关掉了"的事故。
 */
export interface GuardPolicy {
  /**
   * 自动进 `assets/` 的最低置信度。
   * **只对非模型来源有效**——模型产出走的是 `MODEL_NEVER_AUTO`，与这个数无关。
   */
  admit_confidence: number;
}

/**
 * 默认策略：0.8。
 *
 * 它必须**高于** `LOW_CONFIDENCE`（0.3），否则模型产出会在
 * `admit_confidence` 这一条上被误放行——两道判据里塌掉一道。
 * 这个不等关系由测试钉住（`guard.test.ts`），不是靠注释提醒。
 */
export const DEFAULT_GUARD_POLICY: GuardPolicy = { admit_confidence: 0.8 };

/** 一条候选的去向，连同判定的理由。 */
export interface GuardDecision {
  candidate: CandidateAssertion;
  admission: Admission;
  reason: AdmissionReason;
  /** 只在 `reject` 时非空：出处站不住的具体明细，带修法。 */
  violations: Violation[];
}

export interface GuardResult {
  admitted: GuardDecision[];
  inboxed: GuardDecision[];
  rejected: GuardDecision[];
}

/**
 * 审核一批候选断言，决定各自去哪。
 *
 * 顺序无关（输出不再依赖输入顺序），因为下游要写盘、要进报告（R6）。
 *
 * @param {ExtractionInput} input 这批候选当初的抽取输入（守卫要用它复核出处）
 * @param {CandidateAssertion[]} candidates 候选断言
 * @param {GuardPolicy} policy 自动入库的置信度线
 * @returns {GuardResult}
 */
export function guardCandidates(
  input: ExtractionInput,
  candidates: CandidateAssertion[],
  policy: GuardPolicy = DEFAULT_GUARD_POLICY,
): GuardResult {
  const admitted: GuardDecision[] = [];
  const inboxed: GuardDecision[] = [];
  const rejected: GuardDecision[] = [];

  for (const candidate of candidates) {
    // 第 1 条判据：出处站不住的一律丢。**逐条**判而不是整批判完再配对——
    // 整批判出来的 `Violation.path` 只带下标与标题，两条候选标题一样时就会串位，
    // 而串位在这里的后果是"把一条干净的候选连同脏的一起丢掉"。
    const violations = sortViolations([
      ...judgeCandidates(input, [candidate]),
      ...typeViolations(candidate),
    ]);

    if (violations.length > 0) {
      rejected.push({
        candidate,
        admission: ADMISSION.REJECT,
        reason: ADMISSION_REASONS.PROVENANCE_UNVERIFIED,
        violations,
      });
      continue;
    }

    // 第 2 条判据：**不可配置**的那一条。
    if (candidate.origin === "model") {
      inboxed.push({
        candidate,
        admission: ADMISSION.INBOX,
        reason: ADMISSION_REASONS.MODEL_NEVER_AUTO,
        violations: [],
      });
      continue;
    }

    if (candidate.confidence < policy.admit_confidence) {
      inboxed.push({
        candidate,
        admission: ADMISSION.INBOX,
        reason: ADMISSION_REASONS.BELOW_THRESHOLD,
        violations: [],
      });
      continue;
    }

    admitted.push({
      candidate,
      admission: ADMISSION.ADMIT,
      reason: ADMISSION_REASONS.CLEARED,
      violations: [],
    });
  }

  // 三份名单各自排序：**判定的结果不许依赖输入顺序**（R6）。
  // 上游（sanitize）已经排过一遍，但守卫不该靠"上游会排"——
  // 换个调用方（MCP server）就可能喂进另一个顺序，而报告的顺序是会被 diff 的。
  return {
    admitted: [...admitted].sort(byDecision),
    inboxed: [...inboxed].sort(byDecision),
    rejected: [...rejected].sort(byDecision),
  };
}

/**
 * @param {GuardDecision} a
 * @param {GuardDecision} b
 * @returns {number}
 */
function byDecision(a: GuardDecision, b: GuardDecision): number {
  const left = `${a.candidate.type} ${a.candidate.sources[0] ?? ""} ${a.candidate.title}`;
  const right = `${b.candidate.type} ${b.candidate.sources[0] ?? ""} ${b.candidate.title}`;
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * 守卫的**自证**：模型产出一条都不许出现在 `admitted` 里。
 *
 * 为什么把它写成一个函数而不是一句注释：这是本文件存在的全部理由，
 * 而"这条性质还成立吗"在每次改动守卫之后都该被重新问一遍——
 * 问的人可以是 `evals/` 的探针（S15/S16 的信任边界检查 `E7`）。
 *
 * 返回非空 = 守卫被改松了，**立即是缺陷**，不是"配置问题"。
 *
 * @param {GuardResult} result
 * @returns {string[]} 空数组表示性质成立
 */
export function modelLeaks(result: GuardResult): string[] {
  return result.admitted
    .filter((decision) => decision.candidate.origin === "model")
    .map((decision) => `${decision.candidate.type} · ${decision.candidate.title}`);
}

/**
 * 受控词表：守卫只认这四种类型。
 *
 * `sanitizeCandidates` 里已经有一道同样的判据，这里**再查一遍**是有意的：
 * 上游换一个实现就少一道检查的话，边界就跟着实现走了——
 * 而这道检查要防的正是"上游换了个实现"。
 *
 * @param {CandidateAssertion} candidate
 * @returns {Violation[]}
 */
function typeViolations(candidate: CandidateAssertion): Violation[] {
  if ((ASSET_TYPES as readonly string[]).includes(candidate.type)) return [];
  return [
    {
      code: CANDIDATE_CODES.TYPE_UNKNOWN,
      path: `${candidate.title}（${String(candidate.type)}）`,
      message: `类型「${String(candidate.type)}」不在受控词表里：分类法只有 ${ASSET_TYPES.join(" / ")} 四种（ADR-0006）。`,
      fix: "改成四种之一；不是四种之一说明这条提议不属于本分类法，它不该进库",
    },
  ];
}
