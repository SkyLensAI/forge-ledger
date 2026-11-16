/**
 * 候选断言的构造 —— 两个 Phase 3 抽取器共用的一小段。
 *
 * 放在这里而不是复制两份：出处字符串的拼法（`src://<source_id>#k:<事件 key>`）
 * 是一份**契约**，两份实现各拼各的，迟早会有一份拼错而另一份正确，
 * 于是"出处能不能解析"这件事会随实现漂移。契约只有一份写法。
 */
import type { CandidateAssertion } from "../../packages/core/src/extract.ts";
import { cleanSubject } from "../../packages/core/src/link.ts";
import { LOW_CONFIDENCE } from "../../packages/core/src/model.ts";
import type { AssetType, EventIR } from "../../packages/schema/src/index.ts";

/**
 * 起始置信度。**从 core 借，不在这里写第二遍**：
 * 它与 `newFrontMatter` 的 0.3 是同一个数（那条由 `packages/core/test/model.test.ts` 钉住），
 * 而这个文件里再写一个 0.3 就会多出第三个会各自漂移的真相。
 */
export const STARTING_CONFIDENCE = LOW_CONFIDENCE;

/** 标题的截断长度。常量而非"视情况"：它会进评测报告的输出（R6）。 */
export const TITLE_LIMIT = 40;

/**
 * 词法基线的题面长度。取"原文开头这么多字"当"这件事叫什么"。
 *
 * 36 这个数不神秘：短于它，同一个话题的两种说法会折成不同题面（假阴性）；
 * 长于它，同一件事会因为末尾几个字的差异变成两个实体。它没有最优解——
 * 词法实现本来就猜不出"这件事叫什么"，而**承认这一点**比调它更有价值：
 * 边界写在 `evals/README.md` 与 ADR-0026 的残余风险里。
 */
export const SUBJECT_LIMIT = 36;

/**
 * 词法实现的题面：**原文开头**，归一化之后存。
 *
 * 于是它只在"同一句话出现两次"时认得出同一件事——换个说法就认不出。
 * 这不是缺陷，是这个实现的边界；真正判断"这两条是不是同一件事"的那条路
 * 属于模型提议 + 人确认（ADR-0026）。
 *
 * 清洗在这里就做掉（`cleanSubject`）：抽取器给的是人话，而键在需要的地方现算
 * （`normalizeSubjectKey`，幂等）。
 *
 * @param {EventIR} event
 * @returns {string | null}
 */
export function subjectOf(event: EventIR): string | null {
  return cleanSubject(event.text.slice(0, SUBJECT_LIMIT));
}

/**
 * 从事件造一条候选断言。
 *
 * 出处**只可能**指向这条事件本身——抽取器没有别的证据来源，
 * 而"凭空写出一个别处的出处"正是 `judgeCandidates` 要拦下的那件事。
 *
 * `origin: "code"`：这个实现没有模型。记下来不是为了好看——
 * 入库守卫（S16）读它，而 `"model"` 的那一档永远不会自动进 `assets/`。
 *
 * @param {string} sourceId 本次输入的来源
 * @param {EventIR} event 这条候选依据的事件
 * @param {AssetType} type 抽取器认为它是哪一种资产
 * @returns {CandidateAssertion}
 */
export function candidateFrom(sourceId: string, event: EventIR, type: AssetType): CandidateAssertion {
  return {
    type,
    title: titleOf(event),
    subject: subjectOf(event),
    // 正文先原样带上原文：改写原文等于在采集层污染证据，抽取层同理。
    body: event.text,
    sources: [`src://${sourceId}#k:${event.key}`],
    confidence: STARTING_CONFIDENCE,
    origin: "code",
  };
}

/**
 * 事件的标题草稿：压平成一行后截断。
 *
 * @param {EventIR} event
 * @returns {string}
 */
export function titleOf(event: EventIR): string {
  const flat = event.text.split(/\s+/).filter((piece) => piece.length > 0).join(" ");
  return flat.length > TITLE_LIMIT ? `${flat.slice(0, TITLE_LIMIT)}…` : flat;
}
