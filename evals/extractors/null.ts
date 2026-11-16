/**
 * 永远返回空的抽取器 —— **Phase 3 退出条件的反例**。
 *
 * 它不是"一个差劲的实现"，它是最省事的那个实现：什么都不做，永远不会错得离谱，
 * 也永远不会说错话。一个分不出它和真实现的尺子，等于没有尺子。
 *
 * 它唯一的用途是被闸门跑一遍，并**要求它不及格**：
 * 闸门里那条 `E4_EVAL_RULER_BLIND` 检查，就是把"尺子还睁着眼"这件事本身变成红绿。
 *
 * 为什么把它放进仓库而不是写在测试里：Phase 4 之后会有人换抽取器、调阈值、
 * 甚至重写 runner。每次改动之后，"空实现仍然不及格"这条性质都必须重新成立。
 * 它是一个**长期存在的探针**，不是一次性的测试夹具。
 */
import type { CandidateAssertion, ExtractionInput, Extractor } from "../../packages/core/src/extract.ts";

/** 有意为空：连 `input` 都不读。 */
function extract(_input: ExtractionInput): CandidateAssertion[] {
  return [];
}

export const nullExtractor: Extractor = {
  id: "null",
  extract,
};
