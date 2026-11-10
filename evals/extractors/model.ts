/**
 * 模型抽取器的**适配**：把一台 `Model` 变成一台 `Extractor`。
 *
 * 这一层薄得几乎不值得单独一个文件——除了一件事：**它是"换模型"这个动作的全部代价**。
 * implement2.md 说"够不上阈值就调 harness，不是换模型"，而这句话要成立，
 * 前提是"换模型"便宜到不构成诱惑。这里就是把那件事兑现的地方：
 * 换一台 `Model`（换个 cassette 文件、换个端点）不需要动 runner、不需要动尺子、
 * 不需要动任何判定。
 *
 * 两条路径：
 *
 * | id | 从哪来 | 要不要 key | 结果可复现吗 |
 * |---|---|---|---|
 * | `model-replay` | `FORGE_CASSETTE` 指的录像 | 不要 | 是 |
 * | `hostile-probe` | `hostile.ts` 里写死的敌意产出 | 不要 | 是 |
 *
 * **没有"直接调 API"的那一档**，这是有意的：评测要能量"改 harness 之后变好了吗"，
 * 而一个每次答案都可能不同的抽取器给不出那个答案（implement2.md S17）。
 * 真实调用只在 `forge extract --record` 里发生一次，产出是一份录像，
 * 之后所有评测都对着录像跑。
 */
import { extractFromModel, type ExtractionInput, type Extractor, type Model } from "../../packages/core/src/index.ts";
import { readCassette, replayModel } from "../../packages/store/src/index.ts";
import { hostileModel } from "./hostile.ts";

/** 录像路径从环境来。放在函数里读，不在模块加载期——导入期抛会让 runner 起不来。 */
export function cassettePathFromEnv(): string | null {
  const path = process.env["FORGE_CASSETTE"];
  return path === undefined || path.trim().length === 0 ? null : path;
}

/** 登记进 `EXTRACTORS` 的那一台。 */
export const modelReplayExtractor: Extractor = replayExtractor(cassettePathFromEnv);

/**
 * 敌意探针也当成一台抽取器登记：这样 `--list` 看得见它，`--extractor hostile`
 * 也能手动跑。它的分数**没有意义**（它每一条都编造出处），
 * 有意义的是 `E7` 拿它跑的信任边界检查。
 */
export const hostileExtractor: Extractor = modelExtractor(hostileModel, "hostile-probe");

/**
 * 把一台模型包成抽取器。
 *
 * @param {Model} model
 * @param {string} id 进报告的实现标识
 * @returns {Extractor}
 */
export function modelExtractor(model: Model, id: string): Extractor {
  return {
    id,
    extract(input: ExtractionInput) {
      return extractFromModel(input, model).candidates;
    },
  };
}

/**
 * 从环境里拿录像，做成抽取器。
 *
 * 找不到录像时**抛**，而不是返回一个空抽取器。理由与 `readCassette` 同：
 * 一个"永远返回空"的模型路径在报告里与"这个模型什么都没抽出来"长得一样，
 * 而这两件事的修法完全不同。
 *
 * 型号在 `extract()` 里才解析（而不是模块加载时）：`EXTRACTORS` 是在导入期建的，
 * 在导入期抛会让整个 runner 起不来——而"环境变量没设"只该影响这一次跑。
 *
 * @param {() => string | null} locate 返回录像路径；null 表示没有
 * @returns {Extractor}
 */
export function replayExtractor(locate: () => string | null): Extractor {
  return {
    id: "model-replay",
    extract(input: ExtractionInput) {
      const path = locate();
      if (path === null) {
        throw new Error(
          "没有录像：设 FORGE_CASSETTE=<文件>（或先 forge extract --record 录一份）。" +
            `model-replay 不走网络——评测要能量"改了 harness 之后变好了吗"，` +
            `而一个每次答案都可能不同的抽取器给不出那个答案。`,
        );
      }
      return extractFromModel(input, replayModel(readCassette(path))).candidates;
    },
  };
}
