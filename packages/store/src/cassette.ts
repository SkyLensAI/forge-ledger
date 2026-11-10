/**
 * cassette —— 模型响应的**录制与回放**。IO 在边缘，但回放出来的东西是确定的。
 *
 * 为什么需要它（ADR-0021）：`Model` 是同步的，于是整条抽取链路是纯的。
 * 让同步成为可能的那件事就是这里：**响应先被录下来，抽取再对着录像跑**。
 * 三个后果，每一个都是产品级的：
 *
 * 1. **没有 API key 也能跑完整的抽取链路**（implement1.md §4 的架构纪律）。
 *    被录过的那段响应，是这份仓库里唯一能离线复现模型行为的东西。
 * 2. **评测可比。** 换提示词、换分块策略、换受控词表之后，分数的变化是因为
 *    那些改动，而不是因为"这次模型心情不一样"（implement2.md S17：
 *    够不上就调 harness，而"调了之后变好了吗"要有答案）。
 * 3. **证据可复核。** 一条候选能被追溯到**当时那段响应原文**，
 *    而不是一句"模型是这么说的"。这与产品对用户资产的要求是同一条：
 *    出处要指得回具体位置（ADR-0009）。
 *
 * 请求的键是**提示词的指纹**，不是用例 ID：用例改一个字、harness 改一个字，
 * 键就变——于是旧录像对不上新问题时会**报错**，而不是悄悄拿一段
 * 回答另一个问题的文字来充数。
 *
 * 已知不覆盖（明确记账）：录像只验证"这段响应会被怎么处理"，
 * 它**不**证明模型现在还会这么答。所以回放出来的分数不能读成模型的质量——
 * 这条写在 `evals/README.md` 的 Phase 4 一节里，不留给读者自己发现。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Model, ModelRequest } from "@forge/core";
import { stableJson } from "./paths.ts";

export const CASSETTE_VERSION = 1;

export interface CassetteRecord {
  /** `requestDigest(request)`。 */
  request_digest: string;
  /** 响应原文，一字不改。 */
  response: string;
}

export interface Cassette {
  cassette_version: number;
  about: string;
  /** 哪个模型答的。回放出来的候选会带上它。 */
  model: string;
  /** 哪个 harness 问的（提示词 + 受控词表 + 分块策略的版本）。 */
  harness: string;
  records: CassetteRecord[];
}

/**
 * 请求的指纹：system + user + max_tokens 三者一起。
 *
 * 三个都要进：只哈希 user 会让"同一个问题换了系统提示词"命中同一段响应，
 * 于是提示词的改动看起来没有任何效果——而提示词的改动正是 S17 要量的东西。
 *
 * 拼法用 `JSON.stringify` 而不是把几个字段**用某个字符拼起来**：
 * 任何可能出现在提示词里的分隔符都不安全（提示词里有空格、有换行、有引号），
 * 而 JSON 的数组编码是天然无歧义的——`["ab","c"]` 与 `["a","bc"]`
 * 编出来是两个不同的串（ADR-0013 记过这个坑）。
 *
 * @param {ModelRequest} request
 * @returns {string}
 */
export function requestDigest(request: ModelRequest): string {
  const seed = JSON.stringify([request.system, request.user, request.max_tokens]);
  return createHash("sha256").update(seed, "utf8").digest("hex");
}

/**
 * 读一份 cassette。**读不动就抛**：静默给一份空录像会让"模型什么都没抽出来"
 * 看起来像一次正常的抽取。
 *
 * @param {string} path
 * @returns {Cassette}
 */
export function readCassette(path: string): Cassette {
  if (!existsSync(path)) {
    throw new Error(
      `没有 cassette：${path}。` +
        `抽取要么对着录像跑（--cassette <文件>），要么当场录一段（--record <文件>，需要 API key）。` +
        `**不给默认值**：悄悄回放一份不知道从哪来的响应，比没有响应更糟。`,
    );
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Cassette;
  if (parsed.cassette_version !== CASSETTE_VERSION) {
    throw new Error(
      `cassette 版本是 ${String(parsed.cassette_version)}，本版读的是 v${String(CASSETTE_VERSION)}。` +
        `版本号就是格式：重录一份，不要在读取侧顺手兼容（与 ADR-0008 同一条理由）。`,
    );
  }
  return parsed;
}

/**
 * 写一份 cassette。键排序 + LF（R6）：录像也是产出，两次录制同样的响应
 * 必须得到同样的字节，否则 diff 里全是噪音。
 *
 * @param {string} path
 * @param {Cassette} cassette
 * @returns {void}
 */
export function writeCassette(path: string, cassette: Cassette): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stableJson(cassette), "utf8");
}

/**
 * 回放模型：一个同步的 `Model`，从录像里取响应。
 *
 * 录像里没有这次请求时**抛错**，不返回空串。返回空串的后果是
 * "这次抽取什么都没抽出来"，而那与"模型认为这段没有值得记的东西"
 * 在报告里长得一模一样——一次**看起来成功的失败**。
 *
 * @param {Cassette} cassette
 * @returns {Model}
 */
export function replayModel(cassette: Cassette): Model {
  const byDigest = new Map(cassette.records.map((record) => [record.request_digest, record.response]));
  return {
    id: cassette.model,
    complete(request) {
      const response = byDigest.get(requestDigest(request));
      if (response === undefined) {
        throw new Error(
          `cassette「${cassette.model}」里没有这次请求的响应。` +
            `原因通常是提示词或输入变了（harness 改动会让请求指纹变）——` +
            `重录一份录像，或者把这次改动记成一次预期内的口径变化。`,
        );
      }
      return { text: response };
    },
  };
}
