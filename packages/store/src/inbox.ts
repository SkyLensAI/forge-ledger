/**
 * `_inbox/` —— 候选区（S16）。**IO 层**，与 `assets/` 平级。
 *
 * 三条决定，每一条都不是随手定的：
 *
 * 1. **它是 `assets/` 的兄弟目录，不是它的子目录。**
 *    ADR-0012 定的是"约定即集合"：**任何带 front-matter 的 markdown 都是资产**，
 *    而 `assets.scan()` 递归扫整个 `assets/`。候选区若住在里面，它的每一个文件
 *    都会立刻被当成资产——于是要么它必须长成一份合法资产（那就不是候选了），
 *    要么闸门会为一批"还没准备好"的东西报红（那就会训练人无视闸门）。
 *
 * 2. **候选是 JSON，不是 markdown。** 这一条比上一条更硬：
 *    markdown + front-matter 就是资产的写法，而候选**不是资产**。
 *    让它长得像资产，就会有人把它当资产读、当资产引用、最后当资产合并——
 *    而这一切都发生在一个"还没被任何人确认过"的东西上。
 *    用 JSON 之后，"候选区里的东西不可能是资产"这件事**在结构上**成立，
 *    不依赖任何人记得这条规矩（R8：不许把"人会做对"当假设）。
 *
 * 3. **文件名是内容寻址的 ID，记录里没有时间戳。**
 *    `cand_` + SHA-256（ADR-0013 的同一条思路）。于是同一份来源用同一个 harness
 *    抽两次，得到的是**同一个文件、同一份字节**——重跑不产生第二份候选，
 *    也不产生 diff（R6）。"什么时候抽的"不记在这里：那是审计层（Phase 7 / S27）的事，
 *    而把它塞进候选记录会让"跑两次结果一样"这条性质当场消失。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isAssetType, type AssetType } from "@forge/schema";
import { contentAddressedId } from "@forge/schema";
import type { CandidateAssertion, CandidateOrigin } from "@forge/core";
import type { VaultPaths } from "./paths.ts";
import { stableJson } from "./paths.ts";

/** 候选区的 ID 前缀。**刻意不进 `schema/ids.md` 的前缀表**：那些是资产 ID。 */
export const CANDIDATE_PREFIX = "cand_";

/** 候选记录的版本。候选不是资产，所以它不跟 `schema_version` 走（ADR-0008 管的是资产）。 */
export const CANDIDATE_RECORD_VERSION = 1;

export interface CandidateRecord extends CandidateAssertion {
  candidate_version: number;
  /** 内容寻址的 ID。由 `candidateIdOf` 派生，不单独给一个字段去手写。 */
  candidate_id: string;
  /** 抽它的 harness（提示词 + 受控词表 + 分块策略的版本）。换 harness 会换掉它。 */
  harness: string;
  /** 哪个模型答的。回放时来自 cassette，真实调用时来自 API 响应。 */
  model: string;
  /**
   * 提议的来源种类。与 `CandidateAssertion.origin` 是同一个值，
   * 但在这里**必须重命名**：JSON 里的 `origin` 太容易被读成"这条资产从哪来"。
   */
  origin: CandidateOrigin;
}

export interface InvalidCandidate {
  path: string;
  reason: string;
}

export interface CandidateScan {
  records: CandidateRecord[];
  /** 读不动的文件。**不静默跳过**：它们是"看起来进了候选区但没进"的东西。 */
  invalid: InvalidCandidate[];
}

export interface InboxLayer {
  scan(): CandidateScan;
  read(candidateId: string): CandidateRecord | null;
  /**
   * 写一条候选。同 ID 覆盖是**正常**的（同一个 harness 重跑 = 同样的字节），
   * 而且它仍然幂等：内容一样时覆盖后的文件与原来逐字节相同。
   */
  put(record: CandidateRecord): { path: string; created: boolean };
  remove(candidateId: string): boolean;
}

/**
 * 候选的 ID：**内容寻址**，种子是类型 + 出处列表。
 *
 * 不用 ULID（ADR-0007 给人写的东西留的那条路）：候选是**派生**的——
 * 同一份来源 + 同一个 harness 必须得到同一个候选，"何时被抽出"对消费者没有价值，
 * 而时间进 ID 会让重跑产生重复项。
 *
 * @param {CandidateAssertion} candidate
 * @returns {string}
 */
export function candidateIdOf(candidate: CandidateAssertion): string {
  return contentAddressedId(CANDIDATE_PREFIX, `${candidate.type}\n${[...candidate.sources].sort().join("\n")}`);
}

/**
 * @param {VaultPaths} paths
 * @returns {InboxLayer}
 */
export function openInboxLayer(paths: VaultPaths): InboxLayer {
  return {
    scan() {
      const records: CandidateRecord[] = [];
      const invalid: InvalidCandidate[] = [];
      if (!existsSync(paths.inbox)) return { records, invalid };
      // 排序：`readdirSync` 的顺序不是契约（R6）。
      for (const name of [...readdirSync(paths.inbox)].sort()) {
        if (!name.endsWith(".json")) continue;
        const path = join(paths.inbox, name);
        const parsed = parseCandidate(readFileSync(path, "utf8"));
        if (parsed.ok) records.push(parsed.record);
        else invalid.push({ path: name, reason: parsed.reason });
      }
      return { records, invalid };
    },

    read(candidateId) {
      const path = join(paths.inbox, `${candidateId}.json`);
      if (!existsSync(path)) return null;
      const parsed = parseCandidate(readFileSync(path, "utf8"));
      return parsed.ok ? parsed.record : null;
    },

    put(record) {
      if (!existsSync(paths.inbox)) mkdirSync(paths.inbox, { recursive: true });
      // 文件名由 ID 派生，而不是由 record 里的字段拼——两处拼法迟早会不一致，
      // 而不一致的后果是"同一个候选有两个文件"（ADR-0013 同一条理由）。
      const id = candidateIdOf(record);
      const path = join(paths.inbox, `${id}.json`);
      const created = !existsSync(path);
      writeFileSync(path, stableJson({ ...record, candidate_id: id }), "utf8");
      return { path, created };
    },

    remove(candidateId) {
      const path = join(paths.inbox, `${candidateId}.json`);
      if (!existsSync(path)) return false;
      rmSync(path);
      return true;
    },
  };
}

/**
 * 解析一份候选记录。**不信文件内容**：候选区是人可以手改的地方，
 * 而手改过的候选必须被读出来（哪怕读不动），不能静默丢掉。
 *
 * @param {string} text
 * @returns {{ok: true, record: CandidateRecord} | {ok: false, reason: string}}
 */
function parseCandidate(text: string): { ok: true; record: CandidateRecord } | { ok: false; reason: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: `不是合法 JSON：${error instanceof Error ? error.message : String(error)}` };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "根不是对象" };
  }
  const record = raw as Record<string, unknown>;

  if (!isAssetType(record["type"])) return { ok: false, reason: "type 不在受控词表里" };
  if (typeof record["title"] !== "string" || record["title"].length === 0) {
    return { ok: false, reason: "没有 title" };
  }
  const sources = record["sources"];
  if (!Array.isArray(sources) || sources.some((entry) => typeof entry !== "string")) {
    return { ok: false, reason: "sources 不是字符串数组" };
  }
  const confidence = record["confidence"];
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return { ok: false, reason: "confidence 不在 0..1 内" };
  }
  if (record["origin"] !== "model" && record["origin"] !== "code") {
    return { ok: false, reason: "origin 不是 model / code" };
  }

  return {
    ok: true,
    record: {
      candidate_version: typeof record["candidate_version"] === "number" ? record["candidate_version"] : 0,
      candidate_id: typeof record["candidate_id"] === "string" ? record["candidate_id"] : "",
      type: record["type"] as AssetType,
      title: record["title"],
      // 缺 `subject` 解析成 null，而不是判这份记录读不动：
      // 加一个可选字段不该让**已经躺在候选区里的**记录变成脏数据
      // （与 ADR-0008 的"缺版本号 = v0"同一条思路：缺就是没写，不是格式坏了）。
      subject: typeof record["subject"] === "string" ? record["subject"] : null,
      body: typeof record["body"] === "string" ? record["body"] : "",
      sources: sources as string[],
      confidence,
      origin: record["origin"],
      harness: typeof record["harness"] === "string" ? record["harness"] : "",
      model: typeof record["model"] === "string" ? record["model"] : "",
    },
  };
}
