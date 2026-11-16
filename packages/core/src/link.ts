/**
 * 归并 —— 纯函数，零 IO，零模型（S18）。
 *
 * 它回答一个问题：**这条候选说的是不是库里已经有的那件事？**
 * 三条路，各有各的判定者（ADR-0026）：
 *
 * | 判据 | 谁判 | 结论 |
 * |---|---|---|
 * | 证据完全相同（同类型 + 同一组 span） | 代码（确定性） | 同一件事 → 链接 |
 * | 归一化题面相同（`<类型>#<题面>`） | 代码（确定性） | 同一个实体 → 链接 |
 * | 题面不同但**可能**是同一件事 | 模型（提议） | 拿不准 → 队列，等人 |
 * | 其余 | —— | **新建** |
 *
 * 三条设计约束，每一条都对应一个具体的失败：
 *
 * 1. **归并是分组，不是覆盖。** 链接不改写任何字节：它只说"这条候选讲的是
 *    那个实体"。改写用户已有的事实只发生在两处——`promote`（人确认进候选区）
 *    与冲突的 resolve（人确认进队列，ADR-0028）。把"并入"做成"改写"，
 *    就等于给了一条没有人的通路去动用户的库。
 *
 * 2. **模型的提议永远只是提议。** 提议的去向是队列，它也进不了 `links`
 *    （`proposedMergesApplied` 是这条性质的自证）。为什么不给模型一个
 *    "高置信度就直接并"的口子：那个阈值会被调，而"并错了"是不可逆的——
 *    与守卫不给"模型可以直接入库"留旋钮是同一条理由（ADR-0022）。
 *
 * 3. **"拿不准"的默认方向是新建。** 假阴性只是库里多一条；假阳性是两条事实
 *    被压成一条，而且看不出来。两个方向的代价不对称，所以默认取便宜的那一边。
 *
 * 题面（`subject`）本身是 ADR-0025 定义的资产字段；这个模块只做**归一化**与
 * 键的构造，不做语义判断——同义词不是字符串函数的事。
 */
import type { AssetType } from "@forge/schema";
import type { CandidateAssertion } from "./extract.ts";

/**
 * 题面的长度上限。超过它就不是"这件事叫什么"，而是一句话。
 *
 * 为什么拒绝而不是截断：截断会**静默地**把两个不同的题面折成同一个键，
 * 而那正是"并错了"最便宜的发生方式。拒绝只是让这条候选不参与题面归并
 * （走新建），代价小得多。
 */
export const MAX_SUBJECT_LENGTH = 60;

/**
 * 归一化时从两端剥掉的东西：空白，以及 Unicode **标点**类（`\p{P}`）。
 *
 * 用 Unicode 类别而不是手列一张字符表：手列的清单一定会漏（全角括号、
 * 书名号、Markdown 的强调符号…），而漏掉的那一个会让同一个题面有两个键。
 * 只剥**两端**、且只剥标点不剥符号类（`\p{S}`）——`C++` 这样的题面要能活下来。
 */
const EDGE_PUNCTUATION = /^[\s\p{P}]+|[\s\p{P}]+$/gu;

/**
 * 题面的**人读规范形**：NFKC、剥掉两端的空白与标点、折叠空白。
 *
 * 它不折大小写——原因是**这个值会被写进资产**（`subject` 是 front-matter 的字段），
 * 而资产里躺着一个被悄悄改过的大小写是一件说不清的事。机器用的键是另一个函数
 * （`normalizeSubjectKey`），两者的区别只在那一步折叠上。
 *
 * @param {string | null | undefined} raw
 * @returns {string | null} 无法当题面用时返回 null
 */
export function cleanSubject(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;

  // 两端可能套着不止一层（`**「x」**`），所以剥到稳定为止。
  // 循环的终止由"长度严格递减"保证，最多跑原来那么多轮。
  let folded = raw.normalize("NFKC");
  let previous = "";
  while (folded !== previous) {
    previous = folded;
    folded = folded.replace(EDGE_PUNCTUATION, "");
  }

  folded = folded.split(/\s+/).filter((piece) => piece.length > 0).join(" ");
  if (folded.length === 0) return null;
  if (folded.length > MAX_SUBJECT_LENGTH) return null;
  return folded;
}

/**
 * 题面的**机器键**：`cleanSubject` 再折叠大小写。
 *
 * 折叠大小写是有意的：`Postgres` 与 `postgres` 是同一件事的两种写法。
 * 代价（可能把确实靠大小写区分的两个东西并起来）记在 ADR-0026 的残余风险里，
 * 而它的后果被"归并不落盘、只分组"限制住了。
 *
 * 幂等：对已经归一化过的字符串再跑一遍，结果不变（判定侧可以放心地用两次）。
 *
 * @param {string | null | undefined} raw
 * @returns {string | null}
 */
export function normalizeSubjectKey(raw: string | null | undefined): string | null {
  const cleaned = cleanSubject(raw);
  return cleaned === null ? null : cleaned.toLowerCase();
}

/**
 * 一条断言（候选或资产）的**题面键**：`<类型>#<归一化题面>`。
 *
 * 类型也进键：`state#索引层的存储后端` 与 `event#索引层的存储后端` 不是同一个实体——
 * 写规则不同的东西不该被并到一起（ADR-0006 的同一条理由）。把类型写进键的形状里，
 * 这条边界就由键保证，不靠调用方记得。
 *
 * @param {AssetType} type
 * @param {string | null} subject 原样的题面（由这里归一化）
 * @returns {string | null} 没有可用题面时返回 null（这条断言不参与题面归并）
 */
export function linkKeyOf(type: AssetType, subject: string | null): string | null {
  const folded = normalizeSubjectKey(subject);
  return folded === null ? null : `${type}#${folded}`;
}

/** 一条已落盘的资产，归并与冲突只需要它这几项。 */
export interface AssetRef {
  id: string;
  /** 相对宿主的路径，`/` 分隔。 */
  path: string;
  type: AssetType;
  /** 归一化后的题面（`normalizeSubjectKey` 的输出），没有题面时是 null。 */
  subject: string | null;
  /** 出处列表。**原样**参与比较：归并只认逐字节相同的那一组。 */
  sources: string[];
  /** 资产的 `status` 原文（`active` / `superseded` / …）。冲突判定只认 `active`。 */
  status: string;
  /** 正文（冲突判定要拿它与新证据比"是不是同一个值"）。 */
  body: string;
}

/**
 * 归并的一条判定。四档，**没有第五档**。
 *
 * 写成四档而不是"链接 / 不链接"两档，是因为"模型提议的归并"与
 * "代码证明的链接"去向完全不同：前者必须进队列（人看），后者直接成立。
 * 把它们压成一档，那个区别迟早会消失——而消失的方向总是"都直接成立"。
 */
export const LINK_KINDS = {
  /** 同一处证据：同一类型 + 同一组 span。最强的判据，纯确定性。 */
  SAME_EVIDENCE: "same-evidence",
  /** 同一个归一化题面。 */
  SAME_SUBJECT: "same-subject",
  /** 模型提议的归并：**进队列**，不自动并。 */
  PROPOSED_MERGE: "proposed-merge",
  /** 新建。 */
  NEW: "new",
} as const;

export type LinkKind = (typeof LINK_KINDS)[keyof typeof LINK_KINDS];

/** 并到哪儿：一个已有的实体（按题面键），或一处已有的证据（按来源列表）。 */
export type LinkTarget =
  | { by: "subject"; key: string; label: string }
  | { by: "evidence"; sources: string[]; type: AssetType };

/** 一条候选的归并结果。 */
export interface LinkDecision {
  candidate: CandidateAssertion;
  kind: LinkKind;
  /** `same-evidence` / `same-subject` / `proposed-merge` 时指向它并到哪儿。 */
  target: LinkTarget | null;
  /** 人可读的一句话。**不含时间与随机**，所以它可以进报告、可以被 diff（R6）。 */
  why: string;
}

/** 一次归并的全部产出。 */
export interface LinkPlan {
  /** 直接成立的链接（同证据 / 同题面）。 */
  links: LinkDecision[];
  /** 模型提议的归并。**一条都不会出现在 `links` 里**（自证见 `proposedMergesApplied`）。 */
  proposals: LinkDecision[];
  /** 新建的候选。"没找到同一件事"不是失败，是默认方向。 */
  fresh: LinkDecision[];
}

/** 模型侧的接缝：窄到只回答"这两条是不是同一件事"。 */
export interface MergeJudge {
  /** 进报告与队列记录：报告要能回答"这条归并是谁提的"。 */
  readonly id: string;
  /**
   * @param {CandidateAssertion} candidate 拿不准的那条候选
   * @param {{label: string, subject: string | null, sources: string[]}} other 候选目标
   * @returns {string[]} 依据的文字；**空数组 = 不提议**
   */
  propose(candidate: CandidateAssertion, other: MergeTargetView): string[];
}

/** 给接缝看的候选目标视图。它拿不到 ID——模型不需要，也不该用 ID 做判断。 */
export interface MergeTargetView {
  label: string;
  subject: string | null;
  sources: string[];
}

/** 归并的输入。 */
export interface LinkInput {
  candidates: CandidateAssertion[];
  /** 已落盘的资产（宿主从 `assets/` 扫出来，附上归一化后的题面）。 */
  assets: AssetRef[];
  /**
   * 可选：模型判断"这两条是不是同一件事"的接缝。
   *
   * 它**只能**产出提议，而提议的去向是队列。不传它就等于"只跑规则"——
   * 那是有意的默认值：没有模型的路径必须完整可用。
   */
  judge?: MergeJudge;
}

/**
 * 归并的执行体。
 *
 * 输出排序过（R6）：它要进报告，也要进队列记录，而那些人会 diff 它。
 *
 * @param {LinkInput} input
 * @returns {LinkPlan}
 */
export function linkCandidates(input: LinkInput): LinkPlan {
  const links: LinkDecision[] = [];
  const proposals: LinkDecision[] = [];
  const fresh: LinkDecision[] = [];

  // 本次候选之间也要能链接：两条引用同一处证据的候选是一个实体，不是两个。
  // 索引按"类型 + 出处集合"建，与资产的判据是同一把尺子（同一个函数算出来的键）。
  const seenEvidence = new Map<string, CandidateAssertion>();

  for (const candidate of input.candidates) {
    const evidenceKey = evidenceKeyOf(candidate);

    const sameEvidenceAsset = input.assets.find(
      (asset) => asset.type === candidate.type && evidenceKeyOf(asset) === evidenceKey,
    );
    if (sameEvidenceAsset !== undefined) {
      links.push({
        candidate,
        kind: LINK_KINDS.SAME_EVIDENCE,
        target: { by: "evidence", sources: [...candidate.sources].sort(), type: candidate.type },
        why: `同一处证据已经是一条资产（${sameEvidenceAsset.path}）：证据相同就是同一件事。`,
      });
      continue;
    }

    const sameEvidenceCandidate = seenEvidence.get(evidenceKey);
    if (sameEvidenceCandidate !== undefined) {
      links.push({
        candidate,
        kind: LINK_KINDS.SAME_EVIDENCE,
        target: { by: "evidence", sources: [...candidate.sources].sort(), type: candidate.type },
        why: `与本次的另一条候选引用了同一处证据（${[...candidate.sources].sort().join("、")}）。`,
      });
      continue;
    }
    seenEvidence.set(evidenceKey, candidate);

    const key = linkKeyOf(candidate.type, candidate.subject ?? null);
    const sameSubjectAsset =
      key === null
        ? undefined
        : input.assets.find((asset) => linkKeyOf(asset.type, asset.subject) === key);
    if (sameSubjectAsset !== undefined && key !== null) {
      links.push({
        candidate,
        kind: LINK_KINDS.SAME_SUBJECT,
        target: { by: "subject", key, label: sameSubjectAsset.path },
        why: `题面相同（${key}）：这条候选讲的是 ${sameSubjectAsset.path} 那件事。`,
      });
      continue;
    }

    // ── 拿不准的那一档：模型只能提议，提议进队列（ADR-0026）──────────────
    const proposal = proposeMerge(input, candidate);
    if (proposal !== undefined) {
      proposals.push({
        candidate,
        kind: LINK_KINDS.PROPOSED_MERGE,
        target: {
          by: "subject",
          key: linkKeyOf(candidate.type, proposal.target.subject) ?? key ?? "",
          label: proposal.target.label,
        },
        why: `模型 ${proposal.by} 认为它可能是同一件事：${proposal.evidence.join("；")}`,
      });
      continue;
    }

    fresh.push({
      candidate,
      kind: LINK_KINDS.NEW,
      target: null,
      why:
        key === null
          ? "这条候选没有可用的题面（未声明 / 太长 / 归一化后为空）：拿不准就新建。"
          : `没有找到讲同一件事的资产或候选（题面键 ${key}）：拿不准就新建。`,
    });
  }

  return {
    links: [...links].sort(byDecision),
    proposals: [...proposals].sort(byDecision),
    fresh: [...fresh].sort(byDecision),
  };
}

/**
 * 一个**实体**：被认定在讲同一件事的那些断言的集合。
 *
 * `assets` 与 `candidates` 分开存：前者是已经落盘的事实，后者是还没被任何人
 * 确认的提议——混在一个数组里会让"哪一侧需要人确认"这个问题在类型上消失。
 */
export interface Entity {
  /** `<类型>#<归一化题面>`。 */
  key: string;
  type: AssetType;
  subject: string | null;
  assets: AssetRef[];
  candidates: CandidateAssertion[];
}

/**
 * 归并结果的**实体视图**：题面键 → 那个实体。
 *
 * 它只由**直接成立的链接**与已有资产建起来——`proposals` 一条都不参与划分，
 * 这是有意的：让提议也进视图，就等于让模型的一条输出悄悄决定了实体边界。
 * 这条性质由 `proposedMergesApplied` 自证。
 *
 * @param {LinkPlan} plan
 * @param {AssetRef[]} assets 已落盘的资产（本次没有候选碰到的实体也要在里面）
 * @returns {Entity[]}
 */
export function entitiesOf(plan: LinkPlan, assets: AssetRef[]): Entity[] {
  const entities = new Map<string, Entity>();

  const ensure = (key: string, type: AssetType, subject: string | null): Entity => {
    const existing = entities.get(key);
    if (existing !== undefined) return existing;
    const created: Entity = { key, type, subject, assets: [], candidates: [] };
    entities.set(key, created);
    return created;
  };

  for (const link of plan.links) {
    if (link.target === null) continue;

    if (link.target.by === "subject") {
      const entity = ensure(link.target.key, link.candidate.type, normalizeSubjectKey(link.candidate.subject ?? null));
      entity.candidates.push(link.candidate);
      continue;
    }

    // 同证据链接到的资产：候选归到那个资产所在的实体（如果有题面）。
    // 不这么做的话，"同一处证据"的候选会掉出实体视图，而它讲的事情
    // 恰恰已经有一条资产在讲了。
    const target = assets.find(
      (asset) => asset.type === link.candidate.type && evidenceKeyOf(asset) === evidenceKeyOf(link.candidate),
    );
    if (target === undefined) continue;
    const key = linkKeyOf(target.type, target.subject);
    if (key === null) continue;
    ensure(key, target.type, target.subject).candidates.push(link.candidate);
  }

  for (const asset of assets) {
    const key = linkKeyOf(asset.type, asset.subject);
    if (key === null) continue;
    ensure(key, asset.type, asset.subject).assets.push(asset);
  }

  return [...entities.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * 自证：**提议的归并一条都不许出现在直接成立的链接里**。
 *
 * 这条性质是 ADR-0026 第 3 条的判据，写成函数是为了让它每次改动之后
 * 都能被重新问一遍（守卫的 `modelLeaks` 是同一条思路）。
 * **返回非空 = 归并被改松了，属于缺陷，不是配置问题。**
 *
 * @param {LinkPlan} plan
 * @returns {string[]} 空数组表示性质成立
 */
export function proposedMergesApplied(plan: LinkPlan): string[] {
  const proposed = new Set(plan.proposals.map((decision) => decision.candidate));
  return plan.links
    .filter((decision) => proposed.has(decision.candidate))
    .map((decision) => `${decision.candidate.type} · ${decision.candidate.title}`);
}

/**
 * 一条断言的证据键：`<类型>#<排序后的出处>`。
 *
 * 出处排序后拼——`["a","b"]` 与 `["b","a"]` 是同一处证据，
 * 让它们看起来不同的后果是"同一件事被链接两次"（与 `vault.assetKey` 同一条理由）。
 *
 * @param {CandidateAssertion | AssetRef} value
 * @returns {string}
 */
function evidenceKeyOf(value: { type: AssetType; sources: string[] }): string {
  return `${value.type}#${[...value.sources].sort().join(" ")}`;
}

/**
 * 拿不准的那一档：问一次模型接缝。**没有接缝就是不提议**——
 * 默认路径不依赖任何模型（implement1.md §4 的架构纪律）。
 *
 * 只拿"同类型 + 有题面 + 题面不同"的资产去问：
 * 问"它和一条 `event` 是不是同一件事"没有意义（写规则不同），
 * 而把整个库都拿去问会让一次归并变成 N 次调用。
 *
 * @param {LinkInput} input
 * @param {CandidateAssertion} candidate
 * @returns {{by: string, target: MergeTargetView & {label: string}, evidence: string[]} | undefined}
 */
function proposeMerge(
  input: LinkInput,
  candidate: CandidateAssertion,
): { by: string; target: MergeTargetView; evidence: string[] } | undefined {
  const judge = input.judge;
  if (judge === undefined) return undefined;

  const subject = normalizeSubjectKey(candidate.subject ?? null);
  if (subject === null) return undefined;

  const targets: MergeTargetView[] = input.assets
    .filter((asset) => asset.type === candidate.type && asset.subject !== null && asset.subject !== subject)
    .map((asset) => ({ label: asset.path, subject: asset.subject, sources: [...asset.sources] }))
    .sort((a, b) => (a.label < b.label ? -1 : 1));

  for (const target of targets) {
    const evidence = judge.propose(candidate, target);
    if (evidence.length > 0) return { by: judge.id, target, evidence: [...evidence].sort() };
  }
  return undefined;
}

/**
 * @param {LinkDecision} a
 * @param {LinkDecision} b
 * @returns {number}
 */
function byDecision(a: LinkDecision, b: LinkDecision): number {
  const left = `${a.kind} ${a.candidate.type} ${a.candidate.sources[0] ?? ""} ${a.candidate.title}`;
  const right = `${b.kind} ${b.candidate.type} ${b.candidate.sources[0] ?? ""} ${b.candidate.title}`;
  return left < right ? -1 : left > right ? 1 : 0;
}
