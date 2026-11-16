/**
 * 词法基线抽取器 —— 确定性、零依赖、**没有模型**。
 *
 * 它存在的理由有三个，缺一个它就不该存在：
 *
 *   1. **"无 API key 也能跑通全链路"**（implement1.md §4）在评测这一环也要成立。
 *      一个必须有 key 才能跑的尺子，等于一条只在某台机器上有效的尺子。
 *   2. 它是阈值的**地板**：阈值的含义是"不许比一个朴素的词法启发式还差"。
 *      没有地板，阈值就是一个拍脑袋的数字。
 *   3. 它证明尺子**分得出好和坏**——Phase 3 的退出条件是"换成一个永远返回空的
 *      假实现，CI 必须变红"，而这句话要成立，前提是存在一个能变绿的东西。
 *
 * **它不是解法，也不假装是。** 它只认几个泛化的词法信号，必然漏掉改写过的说法、
 * 也必然把疑问句当成状态陈述（见 `evals/README.md` 里如实记下的漏报与误报）。
 *
 * 刻意**不**做的事：不按 golden 集的句子去调模式。那样得到的分数只证明
 * "模式是按样例写的"，而 Phase 4 要测的是模型，不是这个文件。
 */
import type { AssetType } from "../../packages/schema/src/index.ts";
import type { CandidateAssertion, ExtractionInput, Extractor } from "../../packages/core/src/extract.ts";
import type { EventIR } from "../../packages/schema/src/index.ts";
import { candidateFrom } from "./candidate.ts";

/**
 * 判定顺序：**禁令 → 取舍 → 现状 → 已发生的事**。
 *
 * 顺序不是风格偏好：一句"以后不许再误提交"同时含禁令与事故词汇，
 * 而它写下的是 rule，不是 event。先匹配更"强"的意图。
 * 反过来，"先匹配更长的模式"这类聪明做法在这里是错的——
 * 它会把可解释的优先级变成一串只有作者看得懂的顺序特例。
 */
const SIGNALS: ReadonlyArray<{ type: AssetType; pattern: RegExp }> = [
  { type: "rule", pattern: /不许|禁止|不得|一律|永不|永远不|没有例外|红线/ },
  {
    type: "decision",
    pattern: /决定|选定|选择|采用|定为|改成|换成|拍板|先不|先就|就这么|只能放在|统一|不加|不拆|不引|不进 assets/,
  },
  { type: "state", pattern: /目前|当前|现在|已经|用的是|落在|住在|生效的是/ },
  { type: "event", pattern: /上线|发布|发生了|事故|误提交|踩坑|暴露出来|翻车/ },
];

/**
 * 每个事件最多产出一条候选，类型取第一个命中的信号。
 *
 * 为什么是"最多一条"：这个实现的每一次产出都声称"我知道这句话是什么"。
 * 让它在拿不准时也硬凑一条，只会把不确定性藏进分数里。空产出至少是诚实的。
 *
 * @param {ExtractionInput} input
 * @returns {CandidateAssertion[]}
 */
function extract(input: ExtractionInput): CandidateAssertion[] {
  const produced: CandidateAssertion[] = [];
  for (const event of input.events) {
    const type = typeOf(event);
    if (type === null) continue;
    produced.push(candidateFrom(input.sourceId, event, type));
  }
  return produced;
}

/**
 * @param {EventIR} event
 * @returns {AssetType | null}
 */
function typeOf(event: EventIR): AssetType | null {
  for (const signal of SIGNALS) {
    if (signal.pattern.test(event.text)) return signal.type;
  }
  return null;
}

export const baselineExtractor: Extractor = {
  id: "baseline-lexical",
  extract,
};
