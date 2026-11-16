/**
 * 信任边界探针 —— **每次 CI 都问一遍"边界还连着吗"**（S15/S16 的 `E7`）。
 *
 * 为什么这件事不能只验证一次（ADR-0024）：
 * `E4_EVAL_RULER_BLIND` 证明了"尺子还分得开活的和死的"。但尺子分得开分数，
 * 分不开**出处是真的还是编的**——一个类型都对、标题像人话、置信度拉满、
 * 出处全是编的实现，分数可能很好看，而它每一条都不可复核。
 * 那是本产品最贵的失败模式："自信地错"（implement1.md §3.1）。
 *
 * 所以这里用一台**敌意模型**（`evals/extractors/hostile.ts`）走完整的真实路径：
 * 渲染请求 → 模型答 → 解析 → sanitize → 守卫。然后断言四条性质：
 *
 * 1. sanitize 的产出**必须**过得了 `judgeCandidates`（否则边界漏了一道）。
 * 2. 编造出处的候选**一条都不许活下来**。
 * 3. 守卫的 `admit` 名单里**一条模型产出都不许有**。
 * 4. 至少要有**一条**敌意候选活着穿过 sanitize 并被判进候选区——
 *    没有这一条，一个"什么都不放行"的实现也能让上面三条全绿。
 *
 * 第 4 条是这个探针里最要紧的一条，也是最容易漏的一条：
 * 一个把一切都丢掉的边界，与一条好的边界，在"有没有漏"这个问题上无法区分。
 *
 * 依赖是**可注入的**（`deps`），所以探针自己可以被测：传一个"什么都不裁"的
 * sanitize 进去，探针必须报红。只会变绿的检查不是检查（R8）。
 */
import {
  buildExtractionRequest,
  guardCandidates,
  judgeCandidates,
  parseExtractionResponse,
  sanitizeCandidates,
  type CandidateAssertion,
  type ExtractionInput,
  type GuardResult,
  type Violation,
} from "../../packages/core/src/index.ts";
import type { EventIR } from "../../packages/schema/src/index.ts";
import { hostileModel } from "../extractors/hostile.ts";

/** 探针用的合成输入。**不依赖 golden 集**：它测的是边界，不是抽取质量。 */
export const PROBE_SOURCE_ID = "src_00000000000000000000000000";
export const PROBE_EVENT_KEY = "probe/0";

/**
 * @returns {ExtractionInput}
 */
export function probeInput(): ExtractionInput {
  const event: EventIR = {
    schema_version: 1,
    source_id: PROBE_SOURCE_ID,
    key: PROBE_EVENT_KEY,
    kind: "message",
    occurred_at: "2026-01-01T00:00:00Z",
    actor: "user",
    text: "这条事件存在的唯一目的：让敌意模型有一个真的键可以引用，一个假的键可以编造。",
  };
  return { sourceId: PROBE_SOURCE_ID, events: [event] };
}

/** 可注入的依赖。默认是真实实现；测试传坏实现，验证探针会红。 */
export interface TrustProbeDeps {
  sanitize?: typeof sanitizeCandidates;
  guard?: typeof guardCandidates;
}

export interface TrustProbeResult {
  ok: boolean;
  /** sanitize 之后仍然违反信任边界的条数。**必须为 0。** */
  violationsAfterSanitize: number;
  /** 守卫判成可直接入库的条数。**必须为 0**——抽取路径的来源恒为 model。 */
  admitted: number;
  /** 活下来并进了候选区的条数。**必须 > 0**，否则这个探针是瞎的。 */
  inboxed: number;
  /** 被丢掉的条数（编造内容、读不成的形状）。 */
  discarded: number;
  /** 人可读的落点明细，进闸门输出。**排序过**（R6）。 */
  detail: string[];
}

/**
 * 跑一次探针。
 *
 * @param {TrustProbeDeps} [deps]
 * @returns {TrustProbeResult}
 */
export function runTrustProbe(deps: TrustProbeDeps = {}): TrustProbeResult {
  const sanitize = deps.sanitize ?? sanitizeCandidates;
  const guard = deps.guard ?? guardCandidates;

  const input = probeInput();
  const parsed = parseExtractionResponse(hostileModel.complete(buildExtractionRequest(input)).text);
  if (!parsed.ok) {
    // 探针自己的题坏了 —— 这是**无法校验**，不是通过（ADR-0009 的同一条区分）。
    return {
      ok: false,
      violationsAfterSanitize: 0,
      admitted: 0,
      inboxed: 0,
      discarded: 0,
      detail: [`敌意探针自己的响应读不成形状：${parsed.reason}`],
    };
  }

  const sanitized = sanitize(input, parsed.items);
  return verdictOf(
    sanitized.candidates,
    judgeCandidates(input, sanitized.candidates),
    guard(input, sanitized.candidates),
    sanitized.discarded.length,
  );
}

/**
 * 探针的判定拆成纯函数，单独可测——与 `evals/runner/gate.ts` 同一条理由：
 * 判定要能在落地之前被测。
 *
 * @param {CandidateAssertion[]} survivors sanitize 之后活下来的候选
 * @param {Violation[]} violations 它们违反信任边界的地方
 * @param {GuardResult} guard 守卫的判定
 * @param {number} discarded sanitize 丢掉了几条
 * @returns {TrustProbeResult}
 */
export function verdictOf(
  survivors: CandidateAssertion[],
  violations: Violation[],
  guard: GuardResult,
  discarded: number,
): TrustProbeResult {
  const admitted = guard.admitted.length;
  const inboxed = guard.inboxed.length;
  const detail: string[] = [];

  for (const violation of violations) {
    detail.push(`sanitize 之后仍有违规：[${violation.code}] ${violation.path}——${violation.message}`);
  }
  for (const decision of guard.admitted) {
    detail.push(
      `守卫把一条 ${decision.candidate.origin} 来源的候选放进了 assets/：` +
        `${decision.candidate.title}（理由码 ${decision.reason}）`,
    );
  }
  if (inboxed === 0) {
    detail.push(
      "探针一条候选都没活下来：一个「什么都不放行」的实现也能让上面两条全绿，" +
        "所以这条为零时这次检查不成立。",
    );
  }

  return {
    ok: violations.length === 0 && admitted === 0 && inboxed > 0,
    violationsAfterSanitize: violations.length,
    admitted,
    inboxed,
    discarded,
    detail: detail.sort(),
  };
}
