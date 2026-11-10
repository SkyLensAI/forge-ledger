/**
 * 敌意模型 —— **信任边界的长期探针**（S15/S16 的 `E7` 靠它）。
 *
 * 它与 `null.ts` 是一对，各自钉住一条不同的性质：
 *
 * | 探针 | 它假装成什么 | 钉住的性质 |
 * |---|---|---|
 * | `null` | 一个什么都不做的实现 | 尺子还分得开活的和死的（`E4`） |
 * | `hostile` | 一个**说得很像、出处全是编的**模型 | 信任边界还连着（`E7`） |
 *
 * 为什么需要第二个：`E4` 只证明"分数能把空实现挑出来"。它挑不出下面这一类——
 * 一个产出**看起来很对**（类型对、标题像人话、置信度很高）但**出处是编的**实现。
 * 那种产出最危险的地方在于：它的分数可能很高，而它每一条都不可复核。
 * 分数不是这类失败的判据，**出处是不是真的**才是。
 *
 * 它是一台 `Model` 而不是一台 `Extractor`（**这是有意的**）：
 * 走 `Extractor` 就等于绕过了 `parseExtractionResponse` 与 `sanitizeCandidates`，
 * 而探针要测的恰恰是那条路径。假装成模型，才能真的经过所有检查。
 *
 * 五类敌意，每一类对应一条判据：
 *
 * 1. 编造的事件键 —— 这条必须被**丢掉整个候选**（sanitize 裁掉出处后一条不剩）。
 * 2. `file://` 出处 —— 抽取阶段的证据只能是事件本身，别的 scheme 一律裁掉。
 * 3. 不在受控词表里的类型 —— 整条丢。
 * 4. 空标题 —— 整条丢。
 * 5. **看起来完全合法**的一条（真键、真类型、置信度 1.0）——
 *    它必须活着穿过 sanitize，然后**被守卫挡在资产之外**。
 *    没有第 5 类，这个探针可以被"什么都不放行"的实现骗过去。
 */
import type { Model, ModelRequest } from "../../packages/core/src/model.ts";

/** 从渲染好的请求里读出第一个事件键。假装成"模型读了题再答"。 */
function firstKeyOf(request: ModelRequest): string {
  const match = /^### (.+)$/m.exec(request.user);
  return match?.[1]?.trim() ?? "unknown/0";
}

/** 从渲染好的请求里读出来源 ID。 */
function sourceIdOf(request: ModelRequest): string {
  const match = /^来源 ID：(.+)$/m.exec(request.user);
  return match?.[1]?.trim() ?? "src_unknown";
}

/**
 * @param {ModelRequest} request
 * @returns {string}
 */
function respond(request: ModelRequest): string {
  const key = firstKeyOf(request);
  const sourceId = sourceIdOf(request);
  const hostile = {
    assertions: [
      // 1. 编造的事件键：键的**形状**合法、来源 ID 也对，只有那一条事件不存在。
      {
        type: "decision",
        title: "编造的出处",
        body: "这条看起来很正常。",
        sources: [`src://${sourceId}#k:${key}/fabricated`],
        confidence: 0.9,
      },
      // 2. 非 src:// 的 scheme。
      {
        type: "state",
        title: "用了 file:// 的出处",
        body: "文件阈值之类的理由不能直接当证据。",
        sources: ["file://docs/implement1.md#t:没有产出不等于没有证据"],
        confidence: 0.9,
      },
      // 3. 类型不在受控词表里。
      {
        type: "insight",
        title: "自造的类型",
        body: "受控词表是四选一，不是自由文本。",
        sources: [`src://${sourceId}#k:${key}`],
        confidence: 0.9,
      },
      // 4. 空标题。
      {
        type: "event",
        title: "   ",
        body: "一条指不出内容的断言。",
        sources: [`src://${sourceId}#k:${key}`],
        confidence: 0.9,
      },
      // 5. 看起来完全合法的一条：真键、真类型。它必须活下来，然后被守卫挡住。
      {
        type: "rule",
        title: "看起来合法的敌意产出",
        body: "出处是真的，类型是真的，置信度拉满——但它是模型提的。",
        sources: [`src://${sourceId}#k:${key}`],
        confidence: 1,
      },
      // 6. 一字不差的第二条：它的候选 ID 与上一条相同（候选 ID 是内容寻址的），
      //    所以候选区里只会出现一个文件。探针因此顺带钉住了"重复产出不会变成两份记录"。
      {
        type: "rule",
        title: "看起来合法的敌意产出",
        body: "出处是真的，类型是真的，置信度拉满——但它是模型提的。",
        sources: [`src://${sourceId}#k:${key}`],
        confidence: 1,
      },
      // 7. 表层看起来是数字、实际不是：置信度写成了字符串。
      {
        type: "state",
        title: "置信度不是数字",
        body: "它必须被按「缺失」处理，而不是被 JSON 解析顺手转成数字。",
        sources: [`src://${sourceId}#k:${key}`],
        confidence: "0.99",
      },
    ],
  };
  return `\`\`\`json\n${JSON.stringify(hostile)}\n\`\`\``;
}

/**
 * 一台永远这么答的模型。`id` 会进报告——报告里一眼能看出这次跑的是探针。
 */
export const hostileModel: Model = {
  id: "hostile-probe",
  complete(request) {
    return { text: respond(request) };
  },
};
