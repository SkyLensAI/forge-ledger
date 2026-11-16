/**
 * Extractor 的**接缝** —— 纯类型 + 一条判定，零 IO，零模型。
 *
 * Phase 3 在这里只做一件事：把"抽取器"变成一个**可替换的接口**。
 * 真正会用模型的实现是 Phase 4（S15），而 Phase 3 必须先有尺子——
 * 否则你无法区分"模型在变好"和"模型在制造垃圾"，而垃圾会复利
 * （错误条目变成先验，implement2.md 的 P3 引言）。
 *
 * 为什么"接缝"本身值得单独一个文件：
 *   1. 它让 `eval runner` 可以在**没有任何 API key** 的情况下跑两个实现
 *      （一个词法基线 + 一个永远返回空的假实现），于是"尺子能不能判红"
 *      这件事本身可以被 CI 验证——这是 Phase 3 的退出条件。
 *   2. 它把信任边界写进**代码**而不是提示词：`judgeCandidates` 是那条边界，
 *      "模型负责抽取，代码负责不信任"（implement1.md §3.1，反模式 2）。
 *
 * 接口故意窄到只有两个方法：一个 id、一个 `extract`。
 * 抽取器**不能**写库、不能读文件、不能决定生命周期——那些全是确定性的，
 * 归 `packages/core` 的其余部分。窄接口让"换一个实现"的代价是重新实现一个函数，
 * 而不是重做一次集成。
 */
import type { AssetType, EventIR } from "@forge/schema";
import type { Violation } from "./violation.ts";
import { formatSpan, parseSpan } from "./provenance.ts";

/**
 * 这条提议**是谁提出来的**。
 *
 * 为什么要显式记下来、而不是从"它走的是哪条代码路径"推：
 * 入库守卫（S16）的判定要读它，而守卫拿到的是数据、不是调用栈。
 * 只有两个取值，因为只有两个**真实存在**的生产者——
 * 人不会产出候选（人产出的是资产），所以这里没有 `"human"`。
 */
export type CandidateOrigin = "model" | "code";

/**
 * 一条**候选断言**：抽取器认为"这句话值得记住"。
 *
 * 它不是资产：资产要过出处闸门与人工/守卫审核，候选断言只是提议。
 * 两者用不同的类型而不是"资产加一个 pending 字段"——那个字段迟早会被填错。
 */
export interface CandidateAssertion {
  /** 它会是哪一种资产。判定分支因此可穷举（ADR-0006）。 */
  type: AssetType;
  /** 给人读的措辞。空标题的断言等于没有内容。 */
  title: string;
  /** 正文草稿。v0 不要求它符合模板——那是守卫（S16）与人工审核的事。 */
  body: string;
  /**
   * **题面**：这条断言讲的是哪一件事（ADR-0025）。
   *
   * 它是归并（S18）与冲突（S19）判"这两条是不是同一件事"的键的来源，
   * 所以它的**归一化由代码做**（`normalizeSubjectKey`），不由抽取器做：
   * 抽取器给的是人话，键是机器的。`null` = 没写 / 写了但不可用
   * （空、超长）——那时这条断言不参与题面归并，也（若它是 `state`）
   * 不参与冲突判定。**那是安静的一边**，所以冲突判定会把这种情况单独报出来。
   */
  subject: string | null;
  /**
   * 出处。**必须是 `src://<本次输入里的 source_id>#k:<事件 key>`**。
   * 抽取器只被允许引用"它这一次真的看见过的东西"——见 judgeCandidates。
   */
  sources: string[];
  /** 0..1。低置信度起步是守卫（S16）的强制项，这里只如实记录抽取值。 */
  confidence: number;
  /** 谁提的。`model` 意味着入库守卫不会让它直接进 `assets/`（见 guard.ts）。 */
  origin: CandidateOrigin;
}

/**
 * 一次抽取的**全部输入**。
 *
 * 为什么把 `sourceId` 显式放进来，而不是让抽取器从事件里推：
 * 出处必须能被**独立复核**。如果 source_id 来自抽取器的推理，那它就不是证据，
 * 而是模型对自己说的话的转述（ADR-0009 的同一条理由：腐烂的出处比没有更糟）。
 */
export interface ExtractionInput {
  sourceId: string;
  events: EventIR[];
}

/** 可替换的抽取实现。Phase 4 的 LLM 版与 Phase 3 的两个确定性版都实现它。 */
export interface Extractor {
  /** 稳定标识，会进评测报告——报告要能回答"这是哪个实现的分数"。 */
  readonly id: string;
  extract(input: ExtractionInput): CandidateAssertion[];
}

/**
 * 候选断言的违规码。
 *
 * 与 `ASSET_CODES` 分开：那一组判"已经进库的资产"，这一组判"还没进库的提议"。
 * 合在一起会让同一个码在两种修法之间摇摆——而闸门输出是行动指令。
 *
 * 分三块，因为**修法不同**（合并码等于合并修法）：
 *
 * | 块 | 谁提出来的 | 人要不要动手 |
 * |---|---|---|
 * | 拒绝（judgeCandidates） | 任何抽取器 | 要：这是越过信任边界的提议 |
 * | 丢弃（sanitizeCandidates） | 模型 | 要：这次产出作废，去调 harness 或换输入 |
 * | 降级（sanitizeCandidates） | 模型 | **不用**：代码已经处理完，只作为痕迹留下 |
 *
 * 第三块单独标出来的理由：一份"报了十条但一条都不用动手"的报告会训练人无视报告。
 * 全部必须出现在 `schema/provenance.md` 里，由一致性闸门机器校验（ADR-0010）。
 */
export const CANDIDATE_CODES = {
  // ── 拒绝：越过信任边界的提议（judgeCandidates）──────────────────────
  /** 候选没有正文标题。 */
  NO_TITLE: "CAND_NO_TITLE",
  /** 候选没有任何出处。 */
  NO_SOURCES: "CAND_NO_SOURCES",
  /** 出处不是合法 span（语法层面）。 */
  SPAN_MALFORMED: "CAND_SPAN_MALFORMED",
  /** 出处不是 `src://`：抽取器只能引用它这一次看见的来源。 */
  SPAN_NOT_SOURCE: "CAND_SPAN_NOT_SOURCE",
  /** 出处指向本次输入里不存在的事件——**编造的出处**。 */
  SPAN_NOT_IN_INPUT: "CAND_SPAN_NOT_IN_INPUT",
  /** 抽取器自己抛了异常。崩掉的评测没有信息量，而"它在第 7 条用例上炸了"有。 */
  EXTRACTOR_THREW: "CAND_EXTRACTOR_THREW",

  // ── 丢弃：整条提议作废（sanitizeCandidates）─────────────────────────
  /** 模型给的类型不在受控词表里（不是四种资产类型之一）。 */
  TYPE_UNKNOWN: "CAND_TYPE_UNKNOWN",
  /** 模型的响应读不成约定的形状：JSON 坏了、根不是对象、没有 assertions。 */
  RESPONSE_UNPARSEABLE: "CAND_RESPONSE_UNPARSEABLE",

  // ── 降级：代码已经处理完，只留下痕迹 ────────────────────────────────
  /** 置信度被压到入库上界。**不需要人动手**，但必须被看见。 */
  CONFIDENCE_FORCED: "CAND_CONFIDENCE_FORCED",
} as const;

export type CandidateCode = (typeof CANDIDATE_CODES)[keyof typeof CANDIDATE_CODES];

/**
 * 审核一批候选断言 —— **这就是那条信任边界**。
 *
 * 判据只有一条，但它是硬的：**候选引用的每一处，都必须是它这一次真的看见过的**
 * （`input.sourceId` + `input.events` 里存在的 key）。抽取器说什么都不算数，
 * 代码只认它指得出位置的那些。
 *
 * 为什么不做"这个类型判得对不对"的判定：那正是 Phase 3 要**度量**而不是**强制**的东西。
 * 强制它会得到一个永远正确的抽取器（把所有东西都判成对的类型），而不是一个更准的。
 * 准确性归尺子，可追溯性归代码——两者不能混（implement1.md §3.2 的分工表）。
 *
 * @param {ExtractionInput} input 这次抽取的输入
 * @param {CandidateAssertion[]} candidates 抽取器的产出
 * @returns {Violation[]} 空的才代表这批候选"可以被下游看见"
 */
export function judgeCandidates(input: ExtractionInput, candidates: CandidateAssertion[]): Violation[] {
  const known = new Set(input.events.map((event) => event.key));
  const violations: Violation[] = [];

  candidates.forEach((candidate, index) => {
    const path = `${input.sourceId} · 候选 #${index}（${candidate.title.length > 0 ? candidate.title : "无标题"}）`;

    if (candidate.title.trim().length === 0) {
      violations.push({
        code: CANDIDATE_CODES.NO_TITLE,
        path,
        message: "候选断言没有标题：一条指不出内容的断言无法被审、也无法被引用。",
        fix: "给候选一个能读的标题；没有内容可写说明它本来就不该被抽出来",
      });
    }

    if (candidate.sources.length === 0) {
      violations.push({
        code: CANDIDATE_CODES.NO_SOURCES,
        path,
        message: "候选断言没有 sources：没有源头的提议不能进库（R4）。",
        fix: `补上 span，形如 src://${input.sourceId}#k:<事件 key>`,
      });
    }

    for (const raw of candidate.sources) {
      const parsed = parseSpan(raw);
      if (!parsed.ok) {
        violations.push({
          code: CANDIDATE_CODES.SPAN_MALFORMED,
          path,
          message: `出处「${raw}」不是合法 span：${parsed.reason}`,
          fix: "改成 src://<source_id>#k:<事件 key>；语法见 schema/provenance.md",
        });
        continue;
      }

      if (parsed.span.scheme !== "src") {
        violations.push({
          code: CANDIDATE_CODES.SPAN_NOT_SOURCE,
          path,
          message:
            `出处用了 ${parsed.span.scheme}://：抽取器只能引用它这一次看见的来源（src://）。` +
            `别的 scheme 要由能把那个文件读出来的那一层去写。`,
          fix: `改成 src://${input.sourceId}#k:<事件 key>（抽取阶段的证据就是事件本身）`,
        });
        continue;
      }

      if (parsed.span.target !== input.sourceId) {
        violations.push({
          code: CANDIDATE_CODES.SPAN_NOT_IN_INPUT,
          path,
          message:
            `出处指向来源 ${parsed.span.target}，但这次抽取的输入是 ${input.sourceId}：` +
            `引用一份没看见过的来源，就是在编造出处。`,
          fix: "把出处改成本次输入里的事件",
        });
        continue;
      }

      const key = parsed.span.anchor !== null && parsed.span.anchor.kind === "k" ? parsed.span.anchor.payload : null;
      if (key === null) {
        violations.push({
          code: CANDIDATE_CODES.SPAN_NOT_IN_INPUT,
          path,
          message: `出处 ${formatSpan(parsed.span)} 缺少 #k: 键锚点：事件只有键这一种定位方式。`,
          fix: `写成 src://${input.sourceId}#k:<事件 key>`,
        });
        continue;
      }
      if (!known.has(key)) {
        violations.push({
          code: CANDIDATE_CODES.SPAN_NOT_IN_INPUT,
          path,
          message:
            `出处指向 ${key}，但这次输入里没有这条事件——` +
            `**编造的出处比没有出处更糟**：它看起来像证据（ADR-0009）。`,
          fix: "只引用输入里存在的事件键；引不出来就说明这条候选没有依据",
        });
      }
    }
  });

  return violations;
}

/**
 * 一条**断言的定位键**：`<type>@<事件 key>`。
 *
 * 评测的比对单位是"这件事被抽成了哪种资产"，而不是措辞。
 * 用措辞做比对等于让尺子去判文风，那会逼着 Phase 4 去贴合样例的句子，
 * 而不是把事抽对——而"把事抽对"才是要测的东西。
 *
 * 返回 null 表示这条候选没有可比的定位（没有 src://#k: 出处）——
 * 它已经被 judgeCandidates 判红了，不参与打分。
 *
 * @param {CandidateAssertion} candidate
 * @returns {string | null}
 */
export function assertionKeyOf(candidate: CandidateAssertion): string | null {
  for (const raw of candidate.sources) {
    const parsed = parseSpan(raw);
    if (!parsed.ok) continue;
    if (parsed.span.scheme !== "src") continue;
    const anchor = parsed.span.anchor;
    if (anchor === null || anchor.kind !== "k") continue;
    return `${candidate.type}@${anchor.payload}`;
  }
  return null;
}
