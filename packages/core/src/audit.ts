/**
 * 审计 —— 纯函数，零 IO（S27）。
 *
 * 它回答一个产品最贵的问题：**这条资产是谁、在什么时候、凭什么变成现在这样的？**
 *
 * 三件事在这个文件里被定死，每一条都对应一种具体的失败：
 *
 * 1. **条目逐字节确定**（`hashAuditEntry`）。哈希算的是**规范化之后的条目**，
 *    不是"文件里那几行字"——否则同一份条目经由不同写入路径会得到不同的哈希，
 *    于是"链断了"这件事分不清是"被人改过"还是"写入方式变了"。
 * 2. **链的验证不依赖写入方**。`verifyChain` 只吃条目本身：缺号、换序、
 *    改一个字节、时间倒流，四种都能指出来。它**不认识**"谁写的"，
 *    所以它不能被写入方说服。
 * 3. **"记过"与"记得全"是两件事**，两个码。链完整只说明没人动过日志，
 *    不说明每一次写入都进了日志——后者要拿日志与资产库对账（`auditCompleteness`）。
 *    合并成一个码就等于把两种修法合并掉：一个去修链，一个去修写路径。
 *
 * 为什么要哈希链而不是"一个 append-only 的文件"：append-only 是**约定**，
 * 链是**执行体**。有人删掉一条、调换两条、把某条的理由改一句话，
 * 这三种在纯文本日志里都看不出来，而它们恰好是审计唯一要防的事。
 * 用 `node:crypto` 的 sha256 不违反 R5：它是纯函数，同样的输入必然同样的输出，
 * 没有 IO、没有时钟、没有随机——"自己写一个哈希"才是这里最不该做的事。
 */
import { createHash } from "node:crypto";
import type { AssetDoc, AssetType } from "@forge/schema";
import { stableJsonLine } from "./json.ts";

/**
 * 审计条目的种类。**只有会改写库的动作在这里**。
 *
 * 判据是"它记的东西能不能重算"：`forge compile` 写的索引层是派生的（ADR-0015），
 * 重跑一遍就有，所以不记——记了会让日志被重编译刷屏，
 * 而**被刷屏的日志等于没有日志**：真正那一条被淹没之后，没有人会去翻。
 *
 * 反过来说：凡是不在种类表里的写入，都必须走"可重建"那条路。这条边界由
 * `writeAuthored` 的签名强制（见 `@forge/store` 的 `assets.ts`）——
 * 想写一条资产却给不出条目，代码就不写。
 */
export const AUDIT_KINDS = {
  /** 来源层追加了一份字节。**这是最不可逆的一步**（sources/ 只读、只追加）。 */
  SOURCE_IMPORTED: "source-imported",
  /** 模型跑了一次，往候选区写了东西。这是模型的脚印：它提过什么，必须有记录。 */
  CANDIDATES_RECORDED: "candidates-recorded",
  /** 一条候选**由人**确认成了资产（`forge inbox --promote`）。 */
  ASSET_PROMOTED: "asset-promoted",
  /** 一条冲突**由人**判了（`forge conflicts --resolve`）。改写已有状态的唯一通路。 */
  CONFLICT_RESOLVED: "conflict-resolved",
  /** 一条 state **由人**重新确认仍然成立（`forge confirm`）。只刷新 `last_confirmed`。 */
  STATE_CONFIRMED: "state-confirmed",
} as const;

export type AuditKind = (typeof AUDIT_KINDS)[keyof typeof AUDIT_KINDS];

/** 链的第一条没有前驱。哨兵值要能一眼看出是"没有前驱"，而不是看起来像个哈希。 */
export const GENESIS_HASH = "0".repeat(64);

/**
 * 调用方写一条审计时给的东西。**里面没有 `seq` / `prev` / `hash`**：
 * 那三样由链自己算——让写入方提供哈希，等于让被审计的人自己写自己的账。
 */
export interface AuditDraft {
  /** `YYYY-MM-DDTHH:MM:SS.sssZ`。由调用方注入（core 里没有时钟）。 */
  at: string;
  /** 谁做的。人写名字，进程写进程名，agent 写 agent 名——**不许留空**。 */
  actor: string;
  kind: AuditKind;
  /** 被写的东西：资产 ID / 候选 ID / 来源 ID / 冲突 ID。 */
  subject: string;
  /**
   * 附带的事实：决议、理由、条数、被取代的 ID…
   *
   * 值是字符串字典而不是任意 JSON：审计要能被打印、被 grep、被 diff，
   * 而嵌套结构进日志之后，读它的人得先写一段解析代码。
   */
  detail: Record<string, string>;
}

/** 落盘之后的条目。`prev` 与 `hash` 把它和上一条绑在一起。 */
export interface AuditEntry extends AuditDraft {
  /** 从 1 开始，连续。**断号 = 有人删过一条**。 */
  seq: number;
  prev: string;
  hash: string;
}

/**
 * 条目 → 哈希。**哈希算的是规范化的条目，不是文件里的字节**。
 *
 * 用确定性 JSON（键排序）：否则"字段顺序变了"会与"内容变了"长得一样，
 * 而前者的修法是"别乱重排"，后者是"有人在改历史"——两种修法不该共用一个信号。
 * 单行版而不是缩进版：**哈希覆盖的字符串，最好就是文件里那一行**——
 * 这样"把整行拿去重算一遍"是一个能手工做的核对动作。
 *
 * @param {AuditEntry} entry
 * @returns {string} 64 位十六进制
 */
export function hashAuditEntry(entry: AuditEntry): string {
  return sha256(auditBodyJson(entry));
}

/**
 * **被哈希覆盖的那部分**：除 `hash` 本身以外的全部字段。
 *
 * 一个哈希不能包含它自己——这不是约定，是定义。所以"算哈希的字节"与
 * "落盘的那一行"必须是两个函数，而它们的区别只有 `hash` 这一个键。
 * 上一版把它们合成一个（哈希也把 `hash: ""` 算进去）的后果是：
 * 每一条刚写下的记录**立刻就被判成"内容被改过"**——
 * 一个永远报红的检查，比没有检查更糟（它训练人无视红色）。
 * 这次是 `evals/regressions/0006` 记下的第二个坑，同一个模块里的。
 *
 * @param {AuditEntry} entry
 * @returns {string}
 */
function auditBodyJson(entry: AuditEntry): string {
  return stableJsonLine({
    seq: entry.seq,
    at: entry.at,
    actor: entry.actor,
    kind: entry.kind,
    subject: entry.subject,
    detail: entry.detail,
    prev: entry.prev,
  });
}

/**
 * 把一条草稿接在链尾 —— 链的增长只有这一个函数。
 *
 * @param {AuditEntry | null} tail 当前最后一条；空日志时是 null
 * @param {AuditDraft} draft
 * @returns {AuditEntry}
 */
export function appendAuditEntry(tail: AuditEntry | null, draft: AuditDraft): AuditEntry {
  const body = {
    seq: tail === null ? 1 : tail.seq + 1,
    at: draft.at,
    actor: draft.actor,
    kind: draft.kind,
    subject: draft.subject,
    detail: { ...draft.detail },
    prev: tail === null ? GENESIS_HASH : tail.hash,
  };
  // 先算哈希，再把它拼进条目：`hash` 不参与自己的计算（见 `auditBodyJson`）。
  return { ...body, hash: hashAuditEntry({ ...body, hash: "" }) };
}

export interface ChainVerification {
  ok: boolean;
  /** 读到的条目数。 */
  entries: number;
  /** 问题清单（人可读）。排序过，可 diff。 */
  problems: string[];
}

/**
 * 验链 —— **不认识写入方，只认识条目**。
 *
 * 四种破坏分开报，因为修法不同：
 *
 * | 破坏 | 判据 | 它意味着 |
 * |---|---|---|
 * | 缺号 | `seq` 不是 1..n | 有人删了一整条 |
 * | 断链 | `prev` 对不上上一条的 `hash` | 被删/被插入/被重排 |
 * | 被改 | 重算哈希对不上 | 有条目的**内容**被动过 |
 * | 倒流 | `at` 小于前一条 | 顺序被换过，或时钟被人调了 |
 *
 * "改了内容"与"重排"都要单独判：改一条的内容**同时**会破坏它后面那条的
 * `prev`，所以只看断链的话，报告会指向后面那条无辜的条目。
 *
 * @param {AuditEntry[]} entries 按文件顺序
 * @returns {ChainVerification}
 */
export function verifyChain(entries: AuditEntry[]): ChainVerification {
  const problems: string[] = [];
  let previous: AuditEntry | null = null;

  for (const [index, entry] of entries.entries()) {
    const expectedSeq = index + 1;
    if (entry.seq !== expectedSeq) {
      problems.push(
        `第 ${String(index + 1)} 行的 seq 是 ${String(entry.seq)}，应该是 ${String(expectedSeq)}：` +
          `审计日志缺了条目（seq 连续是"没有一条被删掉"的唯一判据）`,
      );
    }

    const expectedPrev = previous === null ? GENESIS_HASH : previous.hash;
    if (entry.prev !== expectedPrev) {
      problems.push(
        `seq ${String(entry.seq)} 的 prev 对不上上一条的 hash（${short(entry.prev)} ≠ ${short(expectedPrev)}）：` +
          `这一条前面被人插入、删除或调换过`,
      );
    }

    const recomputed = hashAuditEntry(entry);
    if (recomputed !== entry.hash) {
      problems.push(
        `seq ${String(entry.seq)} 的内容与它自己的 hash 对不上（重算 ${short(recomputed)} ≠ 记录 ${short(entry.hash)}）：` +
          `这一条的内容被改过——包括把 actor 或理由换一个人`,
      );
    }

    if (previous !== null && entry.at < previous.at) {
      problems.push(
        `seq ${String(entry.seq)} 的 at（${entry.at}）早于前一条（${previous.at}）：时间在倒流，` +
          `说明条目被重排过，或者写入方的时钟不可信`,
      );
    }

    previous = entry;
  }

  return { ok: problems.length === 0, entries: entries.length, problems: problems.sort() };
}

export interface AuditGap {
  code: string;
  subject: string;
  message: string;
}

/** 对账用的码。与链完整性分开，因为修法不同（一个去修链，一个去修写路径/补记录）。 */
export const AUDIT_GAP_CODES = {
  /** 审计提到的资产在库里不存在——一条记录指向了空气。 */
  DANGLING: "AUDIT_DANGLING_SUBJECT",
  /** 库里有一条资产，但审计里没有任何一条提到它（它是怎么来的？）。 */
  UNATTRIBUTED: "AUDIT_UNATTRIBUTED_ASSET",
} as const;

export type AuditGapCode = (typeof AUDIT_GAP_CODES)[keyof typeof AUDIT_GAP_CODES];

/**
 * 对账：**日志说自己记得的东西，和库里实际有的东西，对得上吗？**
 *
 * 两条判据，方向相反：
 *
 * - 日志指向的资产不在了 → `DANGLING`。它意味着有人绕过了 forge 直接删文件
 *   （sources/ 有这条纪律，assets/ 没有写保护）。
 * - 库里的资产在日志里查不到 → `UNATTRIBUTED`。**这条才是审计的边界**：
 *   任何人都可以直接往 `assets/` 里放一个 markdown 文件，文件系统不会问他
 *   "你记了吗"。所以审计不可能"强制每一次写入"——它能做的是**让沉默的写入
 *   在下一个健康检查里被看见**。这是记账，不是假装堵住了。
 *
 * `since` 的存在是为了不误报：审计开启之前就存在的资产不该被追认。
 * 粒度是**天**（`created` 只有日期），所以审计开始那一天的边界上会有假阳性——
 * 那是故意的取舍：边界上多报一条的代价，远小于以后漏掉一条。
 *
 * @param {AuditEntry[]} entries
 * @param {AssetDoc[]} assets
 * @returns {AuditGap[]}
 */
export function auditCompleteness(entries: AuditEntry[], assets: AssetDoc[]): AuditGap[] {
  const gaps: AuditGap[] = [];
  const ids = new Set(assets.map((doc) => doc.frontMatter.id));
  const recorded = new Set<string>();
  for (const entry of entries) recorded.add(entry.subject);

  for (const entry of entries) {
    // 只查"指向资产"的那几类：候选 ID 与来源 ID 不在 assets/ 里，别去库里找。
    if (entry.kind !== AUDIT_KINDS.ASSET_PROMOTED && entry.kind !== AUDIT_KINDS.CONFLICT_RESOLVED) {
      continue;
    }
    if (!ids.has(entry.subject)) {
      gaps.push({
        code: AUDIT_GAP_CODES.DANGLING,
        subject: entry.subject,
        message:
          `审计 seq ${String(entry.seq)} 记的是 ${entry.kind} → ${entry.subject}，` +
          `但这个资产现在不在库里了。审计记过的写入被删掉，是必须先弄清的事。`,
      });
    }
  }

  const since = startDateOf(entries);
  if (since !== null) {
    for (const doc of assets) {
      if (doc.frontMatter.created < since) continue;
      if (recorded.has(doc.frontMatter.id)) continue;
      gaps.push({
        code: AUDIT_GAP_CODES.UNATTRIBUTED,
        subject: doc.frontMatter.id,
        message:
          `${doc.path}（created ${doc.frontMatter.created}）在审计里没有对应的条目——` +
          `它是被直接放进 assets/ 的，绕过了 forge。审计只能记录经过 forge 的写入，` +
          `所以这一条的存在本身就是"有人绕过了它"的证据。`,
      });
    }
  }

  return gaps.sort((a, b) => (a.code === b.code ? (a.subject < b.subject ? -1 : 1) : a.code < b.code ? -1 : 1));
}

/**
 * 日志的第一天（`YYYY-MM-DD`）。空日志返回 null。
 *
 * @param {AuditEntry[]} entries
 * @returns {string | null}
 */
export function startDateOf(entries: AuditEntry[]): string | null {
  const first = entries[0];
  if (first === undefined) return null;
  return first.at.slice(0, 10);
}

/**
 * 一行 JSONL → 条目。**不合法就返回原因，不返回 null**：
 * "读不动"与"没有这一条"必须能被分开（同一个理由在 ADR-0009 里写过一次）。
 *
 * @param {string} line
 * @returns {{ok: true, entry: AuditEntry} | {ok: false, reason: string}}
 */
export function parseAuditLine(line: string): { ok: true; entry: AuditEntry } | { ok: false; reason: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch (error) {
    return { ok: false, reason: `不是合法 JSON：${error instanceof Error ? error.message : String(error)}` };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "条目必须是一个对象" };
  }
  const record = raw as Record<string, unknown>;

  const seq = record["seq"];
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) {
    return { ok: false, reason: `seq 必须是 >= 1 的整数，收到 ${JSON.stringify(seq)}` };
  }
  for (const key of ["at", "actor", "kind", "subject", "prev", "hash"]) {
    if (typeof record[key] !== "string") return { ok: false, reason: `${key} 必须是字符串` };
  }
  if ((record["actor"] as string).length === 0) {
    return { ok: false, reason: "actor 不能是空串：一条不知道是谁做的记录，审计里没有它的位置" };
  }
  if (!Object.values(AUDIT_KINDS).includes(record["kind"] as AuditKind)) {
    return { ok: false, reason: `不认识的 kind「${String(record["kind"])}」` };
  }

  const detailRaw = record["detail"];
  if (typeof detailRaw !== "object" || detailRaw === null || Array.isArray(detailRaw)) {
    return { ok: false, reason: "detail 必须是字符串字典" };
  }
  const detail: Record<string, string> = {};
  for (const [key, value] of Object.entries(detailRaw as Record<string, unknown>)) {
    if (typeof value !== "string") return { ok: false, reason: `detail.${key} 必须是字符串` };
    detail[key] = value;
  }

  return {
    ok: true,
    entry: {
      seq,
      at: record["at"] as string,
      actor: record["actor"] as string,
      kind: record["kind"] as AuditKind,
      subject: record["subject"] as string,
      detail,
      prev: record["prev"] as string,
      hash: record["hash"] as string,
    },
  };
}

/**
 * 条目 → JSONL 的一行（**不含换行**）。键序写死，与 `hashAuditEntry` 同源——
 * 唯一的区别是它**包含** `hash` 本身（那一行是给人核对用的完整记录）。
 *
 * @param {AuditEntry} entry
 * @returns {string}
 */
export function serializeAuditEntry(entry: AuditEntry): string {
  return stableJsonLine({
    seq: entry.seq,
    at: entry.at,
    actor: entry.actor,
    kind: entry.kind,
    subject: entry.subject,
    detail: entry.detail,
    prev: entry.prev,
    hash: entry.hash,
  });
}

/**
 * 资产类型里哪些是**人写的**（要有审计），哪些是**派生的**（不记）。
 *
 * 这条分界很重要，因为 `compile` 会写事件资产，而那些是能从 sources 重算出来的。
 * 把它们也记进审计，日志会被重编译刷屏；而**一片噪音的日志与没有日志，
 * 在"出事时能不能找到那一条"这件事上是一样的**。
 *
 * @param {AssetType} type
 * @returns {boolean}
 */
export function isAuthoredType(type: AssetType): boolean {
  return type === "decision" || type === "state" || type === "rule";
}

/**
 * @param {string} text
 * @returns {string}
 */
function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * @param {string} value
 * @returns {string} 前 12 位，供报告里指认
 */
function short(value: string): string {
  return value.slice(0, 12);
}
