/**
 * 冲突判定 —— 纯函数，零 IO，**只出候选 + 证据，永不落库**（S19 / ADR-0027）。
 *
 * 它回答一个问题：**这条新证据是不是推翻了库里那条状态？**
 * 判据只有一条，但它是硬的：**同一个题面 + 归一化后内容不同**。
 *
 * 五条设计约束，每一条都对应一个具体的失败：
 *
 * 1. **候选的形状里没有"应用"这一档。** `ConflictCandidate` 只有"两侧是什么、
 *    依据是什么、证据在哪"。落盘与改写只存在于队列的 `resolve`（人触发的动作）。
 *    把它做成判定函数的副作用，就是让"谁有权改用户的状态"的答案变成
 *    "任何能调到这个函数的地方"（implement1.md 反模式 6）。
 *
 * 2. **证据必须两侧齐全且可解析。** 每条候选至少各带一条来自新证据侧与
 *    现有 state 侧的 span，且都要过 `parseSpan`。站不住的整条丢弃并记账——
 *    一条人核对不了的冲突记录比没有更糟：它会让队列失去信用（ADR-0009 的同一条理由）。
 *
 * 3. **归一化后完全相同的，不是冲突，是再确认。** 新证据把同一件事又说了一遍，
 *    它该进的是"可以刷新 `last_confirmed`"那一档。把这种情况报成冲突，
 *    队列会被正常的重复证据淹掉——而"队列里全是噪音"与"没有队列"在行为上一样。
 *    这个仓库已经吃过一次同形状的教训（`evals/regressions/0003`：把"已经落盘过"
 *    与"被别人改过"当成同一件事，于是一份落过一次的清单永久报假警）。
 *
 * 4. **模型只能加，不能减。** 规则查到的冲突不受任何模型输出影响；模型的输出
 *    唯一的作用是**追加**候选（`basis: "model-proposed"`）。这条由
 *    `missingAfterAdoption` 自证：采纳模型的提议之后，规则查到的那几条一条都不许少。
 *
 * 5. **只有 `state` 会产生冲突。** `decision` 一旦 accepted 不可变（要改是新建
 *    supersedes，那是"另一个决策"而不是"冲突"），`event` 是发生过的事（不能被推翻），
 *    `rule` 靠 `origin_incident` 溯源。冲突是"**现在是什么样**变了"这件事的名字。
 */
import type { CandidateOrigin } from "./extract.ts";
import type { CandidateAssertion } from "./extract.ts";
import { linkKeyOf, type AssetRef } from "./link.ts";
import { formatSpan, normalizeText, parseSpan, type Span } from "./provenance.ts";

/** 冲突的种类。v1 只有一种——多一种就要多一条判据与一套证据要求。 */
export const CONFLICT_KINDS = {
  /** 新证据与现有 state 讲同一件事，但内容不同。 */
  STATE_CONTRADICTS: "state-contradicts",
} as const;

export type ConflictKind = (typeof CONFLICT_KINDS)[keyof typeof CONFLICT_KINDS];

/**
 * 这条候选**是怎么被判定出来的**。
 *
 * 它必须进记录：人核对时第一件想知道的事就是"这是规则查出来的，还是模型猜的"。
 * 两者的核对方式不同——前者核对事实，后者核对"它是不是同一件事"。
 */
export const CONFLICT_BASIS = {
  /** 规则：题面键相同、内容不同。可解释、可复现。 */
  SUBJECT_RULE: "subject-rule",
  /** 模型提议的：题面不同但（模型认为）是同一件事。 */
  MODEL_PROPOSED: "model-proposed",
} as const;

export type ConflictBasis = (typeof CONFLICT_BASIS)[keyof typeof CONFLICT_BASIS];

/** 新来的那一侧。 */
export interface IncomingSide {
  /** 一条候选：还没被任何人确认过的提议。 */
  candidate: CandidateAssertion;
  /** 归一化后的内容。与 `IncumbentSide.value` 的比较就是"值是否相同"的判据。 */
  value: string;
  sources: string[];
  origin: CandidateOrigin;
  title: string;
}

/** 已经落盘的那一侧：现在库里的"事实"。 */
export interface IncumbentSide {
  asset: AssetRef;
  value: string;
  sources: string[];
  /** 资产的 ID 与路径（人会去点开它）。 */
  assetId: string;
  path: string;
}

/**
 * 一条冲突**候选**。它是提议，不是判决：没有任何字段能表达"该改成什么"。
 *
 * 这个"什么都不说"的形状是刻意的（ADR-0027 判据 1）：判定一旦能表达动作，
 * 动作迟早会被某处自动执行——而队列是唯一该动用户资产的地方。
 */
export interface ConflictCandidate {
  /** 内容寻址的键（由 `conflictKeyOf` 派生）。宿主拿它当队列记录的 ID。 */
  key: string;
  /** 它属于哪个实体（`<类型>#<题面>`）。 */
  linkKey: string;
  kind: ConflictKind;
  basis: ConflictBasis;
  incoming: IncomingSide;
  incumbent: IncumbentSide;
  /** 两侧各自的证据 span。**至少一条来自每一侧**，且每条都必须能解析。 */
  evidence: string[];
  /** 人可读的一句话：为什么这是冲突。 */
  why: string;
}

/**
 * 一条"再确认"：同一个题面、归一化后内容相同。
 *
 * 它**不是冲突**，也不进队列。它的用途是让"可以刷新 last_confirmed"这件事
 * 可见——主动确认是 Phase 7（S26）的活，但"有新证据支持它"这个信号
 * 现在就该被记下来，否则它会被当成"又报了一次冲突"。
 */
export interface RefreshRecord {
  linkKey: string;
  candidate: CandidateAssertion;
  asset: AssetRef;
  why: string;
}

/** 一条被丢掉的冲突候选。**丢弃必须说出来**：静默丢弃会让"没查到"与"丢掉了"看起来一样。 */
export interface DroppedConflict {
  /** 定位：能指到候选就写它的题面键，指不到就写标题。 */
  at: string;
  reason: string;
}

/** 一次冲突判定的全部产出。 */
export interface ConflictJudgement {
  conflicts: ConflictCandidate[];
  refreshes: RefreshRecord[];
  dropped: DroppedConflict[];
  /** 判定过程中的旁注（比如"同一个题面有两条 active 状态"）。排序过，可 diff。 */
  notes: string[];
}

/**
 * 模型侧的接缝：问"这条新证据是不是推翻了那条资产"。
 *
 * 与归并的接缝同一个形状（同步、窄、只能追加）——它唯一的用途是补上规则看不见的
 * 那一类（题面不同但其实是同一件事）。**它不能否决规则的产出**（`missingAfterAdoption`）。
 */
export interface ConflictJudge {
  readonly id: string;
  /**
   * @param {CandidateAssertion} incoming 新来的候选
   * @param {AssetRef} incumbent 现有的一条资产
   * @returns {string[]} 依据的文字；**空数组 = 不提议**
   */
  propose(incoming: CandidateAssertion, incumbent: AssetRef): string[];
}

export interface ConflictInput {
  /** 本次的候选（通常来自候选区）。 */
  candidates: CandidateAssertion[];
  /** 已落盘的资产（含归一化题面与状态）。 */
  assets: AssetRef[];
  /** 可选：模型接缝。没有它 = 只跑规则，那条路必须完整可用。 */
  judge?: ConflictJudge;
}

/**
 * 冲突判定的**入口**：规则先判，模型只能追加。
 *
 * 三层分得很清楚，因为它们的可测性不同：
 *
 * | 函数 | 它做什么 | 怎么被钉住 |
 * |---|---|---|
 * | `detectConflicts` | 纯规则，确定性 | 合成集 + 直接断言 |
 * | `proposeModelConflicts` | 问一次模型接缝 | 拿一台探针模型跑 |
 * | `adoptModelConflicts` | 只做并集 | `missingAfterAdoption` 自证 |
 *
 * 分成三层而不是一个函数里三个 if：**"模型能不能否决规则"这个问题
 * 必须能被单独问一遍**，而写在一个函数里时，它只能靠读代码来回答。
 *
 * @param {ConflictInput} input
 * @returns {ConflictJudgement}
 */
export function judgeConflicts(input: ConflictInput): ConflictJudgement {
  const ruled = detectConflicts({ candidates: input.candidates, assets: input.assets });
  if (input.judge === undefined) return ruled;
  return adoptModelConflicts(ruled, proposeModelConflicts(input.candidates, input.assets, input.judge));
}

/**
 * 只跑规则的那一半。零模型、零 IO、结果完全由输入决定。
 *
 * @param {{candidates: CandidateAssertion[], assets: AssetRef[]}} input
 * @returns {ConflictJudgement}
 */
export function detectConflicts(input: {
  candidates: CandidateAssertion[];
  assets: AssetRef[];
}): ConflictJudgement {
  const conflicts: ConflictCandidate[] = [];
  const refreshes: RefreshRecord[] = [];
  const dropped: DroppedConflict[] = [];
  const notes: string[] = [];

  for (const candidate of input.candidates) {
    if (candidate.type !== "state") continue;

    const linkKey = linkKeyOf(candidate.type, candidate.subject ?? null);
    if (linkKey === null) {
      dropped.push({
        at: candidate.title,
        reason:
          "这条 state 候选没有可用的题面，所以它**不参与冲突判定**——" +
          "而这个方向是安静的那一边：它推翻了什么，没有人会知道。补上题面（ADR-0025）。",
      });
      continue;
    }

    // 现状只认 `active`：被取代的那一代不再是"现在的事实"，把它当现状会让
    // 同一次矛盾在每一代旧状态上重复报一遍（ADR-0028 的口径）。
    const actives = input.assets.filter(
      (asset) => linkKeyOf(asset.type, asset.subject) === linkKey && asset.status === "active",
    );
    if (actives.length > 1) {
      notes.push(
        `题面 ${linkKey} 有 ${String(actives.length)} 条 active 状态（${actives
          .map((asset) => asset.path)
          .sort()
          .join("、")}）：一次替换写了一半，或者有人手写了两条。修法是留一条 active。`,
      );
    }

    for (const incumbent of actives) {
      const value = normalizeValue(candidate.body);
      const incumbentValue = normalizeValue(incumbent.body);

      if (value === incumbentValue) {
        refreshes.push({
          linkKey,
          candidate,
          asset: incumbent,
          why: "归一化后内容相同：这是同一条事实被再说了一遍，不是冲突（可以刷新 last_confirmed）。",
        });
        continue;
      }

      const judgement = judgeEvidence(candidate, incumbent);
      if (!judgement.ok) {
        dropped.push({ at: candidate.title, reason: judgement.reason });
        continue;
      }

      conflicts.push({
        key: conflictKeyOf(linkKey, incumbent.id, candidate.sources),
        linkKey,
        kind: CONFLICT_KINDS.STATE_CONTRADICTS,
        basis: CONFLICT_BASIS.SUBJECT_RULE,
        incoming: incomingSideOf(candidate),
        incumbent: incumbentSideOf(incumbent),
        evidence: judgement.evidence,
        why:
          `题面相同（${linkKey}）但内容不同：` +
          `${incumbent.path} 记的是「${firstLineOf(incumbentValue)}」，` +
          `新证据说的是「${firstLineOf(value)}」。`,
      });
    }
  }

  return {
    conflicts: [...conflicts].sort(byConflict),
    refreshes: [...refreshes].sort((a, b) => (a.linkKey < b.linkKey ? -1 : a.linkKey > b.linkKey ? 1 : 0)),
    dropped: [...dropped].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)),
    notes: [...new Set(notes)].sort(),
  };
}

/**
 * 采纳模型的提议 —— 把两层产出合成一层。
 *
 * 写成"合成"而不是"让判定函数多做一件事"，是为了让**这一条性质**可以单独被测：
 * 采纳之后，规则查到的那几条必须一条都不少（`missingAfterAdoption`）。
 * 一个能删东西的接口，迟早会被用来删东西。
 *
 * @param {ConflictJudgement} ruled 只跑规则的结果
 * @param {ConflictCandidate[]} proposed 模型提议的候选
 * @returns {ConflictJudgement}
 */
export function adoptModelConflicts(ruled: ConflictJudgement, proposed: ConflictCandidate[]): ConflictJudgement {
  const keys = new Set(ruled.conflicts.map((conflict) => conflict.key));
  const extra = proposed.filter((conflict) => !keys.has(conflict.key));
  return {
    conflicts: [...ruled.conflicts, ...extra].sort(byConflict),
    refreshes: ruled.refreshes,
    dropped: ruled.dropped,
    notes: [...new Set([...ruled.notes, ...extra.map((conflict) => `模型提议：${conflict.why}`)])].sort(),
  };
}

/**
 * 自证：**采纳模型提议之后，规则查到的一条都不许少**（ADR-0027 判据 4）。
 *
 * 返回非空 = 冲突判定被改松了（模型的输出有了"否决权"），属于缺陷。
 * 与守卫的 `modelLeaks`、归并的 `proposedMergesApplied` 是同一条思路：
 * **把关键性质写成函数，它才能在每次改动之后被重新问一遍。**
 *
 * @param {ConflictJudgement} ruled 只跑规则的结果
 * @param {ConflictJudgement} adopted 采纳模型提议之后的结果
 * @returns {string[]} 空数组表示性质成立
 */
export function missingAfterAdoption(ruled: ConflictJudgement, adopted: ConflictJudgement): string[] {
  const kept = new Set(adopted.conflicts.map((conflict) => conflict.key));
  return ruled.conflicts.filter((conflict) => !kept.has(conflict.key)).map((conflict) => conflict.key);
}

/**
 * 冲突候选的内容寻址键。
 *
 * 种子是"哪个实体 + 和哪条资产 + 新证据是哪几处"：于是**同一组矛盾重跑得到同一个键**，
 * 队列不会因为多跑了一次 `forge link` 而长出第二条记录（幂等），
 * 而换了新证据（另一处 span）就是另一条矛盾——它确实该被单独审理。
 *
 * **不含时间**：时间进键会让重跑产生重复项（与候选区同一条理由，ADR-0013）。
 *
 * @param {string} linkKey
 * @param {string} assetId
 * @param {string[]} incomingSources
 * @returns {string}
 */
export function conflictKeyOf(linkKey: string, assetId: string, incomingSources: readonly string[]): string {
  return `${linkKey}\n${assetId}\n${[...incomingSources].sort().join("\n")}`;
}

/**
 * 内容的归一化：**只折叠排版**（章节标题、空白、行尾），不做语义。
 *
 * 为什么用"归一化后逐字节相同"当"同一个值"的判据：它是唯一能被人复核的判据。
 * 相似度阈值会把"是不是同一个值"变成一个可以拧松的数字，而拧松它的后果是
 * **真的矛盾被当成再确认**——那正是这个产品最贵的失败模式。
 *
 * **章节标题要剥掉**，这一条是实测撞出来的，不是预防性的：两侧的形状本来就不一样——
 * 资产那一侧是 `## 当前状态\n\n两周一个版本。`（标题由模板强制，`REQUIRED_SECTIONS`），
 * 候选那一侧是 `两周一个版本。`（模型抽出来的是一句话，没有理由带标题）。
 * 不剥标题，"同一条事实被再说一遍"会**每一次都报成冲突**，于是队列被正常的重复证据
 * 淹掉——而"队列里全是噪音"与"没有队列"在行为上一样（判据 3 失效）。
 *
 * 剥的是**行首的 ATX 标题**，不是"看起来像标题的句子"：判据必须能被复核，
 * 所以它得是一条能指着说的语法规则，而不是一个猜测。
 * 残余风险记在 ADR-0032：正文里的三级以上标题也会被剥掉，
 * 于是一份"用 `###` 分小节写状态"的资产，它的值会比写作者以为的更扁平。
 * 这是有意的取舍——把这条也做成语义判断，等于把"同一个值"的判据交给模型。
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeValue(text: string): string {
  return normalizeText(stripHeadings(text));
}

/**
 * 剥掉行首的 ATX 标题行（`#` 到 `######`，含结尾的闭合 `#`）。
 *
 * 用 `m` 标志逐行处理，再交给 `normalizeText` 折叠空白——于是"标题被剥掉"
 * 与"标题被换成空行"是同一件事，因为空行本来就会被折叠掉。
 *
 * @param {string} text
 * @returns {string}
 */
function stripHeadings(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => !/^\s{0,3}#{1,6}(\s|$)/.test(line))
    .join("\n");
}

/**
 * 两侧的证据是否站得住。
 *
 * 判据两条，缺一不可：**两侧各至少一条**、且**每条都过 `parseSpan`**。
 * "站不住"与"没查到"必须分开：前者要能被看见（`dropped`），
 * 后者是正常的"这一轮没有矛盾"。
 *
 * @param {CandidateAssertion} candidate
 * @param {AssetRef} incumbent
 * @returns {{ok: true, evidence: string[]} | {ok: false, reason: string}}
 */
export function judgeEvidence(
  candidate: CandidateAssertion,
  incumbent: AssetRef,
): { ok: true; evidence: string[] } | { ok: false; reason: string } {
  if (candidate.sources.length === 0) {
    return { ok: false, reason: "新证据这一侧没有出处：一条核实不了的矛盾不许进队列（R4）。" };
  }
  if (incumbent.sources.length === 0) {
    return {
      ok: false,
      reason: `现有状态 ${incumbent.path} 没有出处：它是"现在的样子"，但没有东西能证明它——先去补它，再谈谁对。`,
    };
  }

  const incoming = sortSpans(candidate.sources);
  const existing = sortSpans(incumbent.sources);
  if (!incoming.ok) return { ok: false, reason: `新证据侧的出处站不住：${incoming.reason}` };
  if (!existing.ok) return { ok: false, reason: `现有状态侧的出处站不住：${existing.reason}` };

  // 新证据侧在前：人读的时候先看到"新说了什么"，再看到"原来是什么"。
  return { ok: true, evidence: [...incoming.canonical, ...existing.canonical] };
}

/**
 * @param {string[]} sources
 * @returns {{ok: true, canonical: string[]} | {ok: false, reason: string}}
 */
function sortSpans(sources: readonly string[]): { ok: true; canonical: string[] } | { ok: false; reason: string } {
  const canonical: string[] = [];
  for (const raw of sources) {
    const parsed = parseSpan(raw);
    if (!parsed.ok) return { ok: false, reason: `「${raw}」不是合法 span：${parsed.reason}` };
    canonical.push(formatSpan(parsed.span as Span));
  }
  // 去重后排序：同一处证据说两遍不算两处，顺序要确定（R6）——与 sanitize 同一条理由。
  return { ok: true, canonical: [...new Set(canonical)].sort() };
}

/**
 * 模型提议的那一档：**只对规则看不见的对子**（题面不同、同类型、active、内容不同）。
 *
 * 提议同样要过证据检查：模型说"这两条矛盾"但没有可解析的出处时，
 * 这条提议被丢掉——**边界对模型一视同仁**（与 `sanitizeCandidates` 同一条纪律）。
 *
 * @param {CandidateAssertion[]} candidates
 * @param {AssetRef[]} assets
 * @param {ConflictJudge} judge
 * @returns {ConflictCandidate[]}
 */
export function proposeModelConflicts(
  candidates: CandidateAssertion[],
  assets: AssetRef[],
  judge: ConflictJudge,
): ConflictCandidate[] {
  const out: ConflictCandidate[] = [];

  for (const candidate of candidates) {
    if (candidate.type !== "state") continue;
    const incomingKey = linkKeyOf(candidate.type, candidate.subject ?? null);

    const targets = assets
      .filter(
        (asset) =>
          asset.type === "state" &&
          asset.status === "active" &&
          linkKeyOf(asset.type, asset.subject) !== incomingKey &&
          normalizeValue(asset.body) !== normalizeValue(candidate.body),
      )
      .sort((a, b) => (a.path < b.path ? -1 : 1));

    for (const incumbent of targets) {
      const evidence = judge.propose(candidate, incumbent);
      if (evidence.length === 0) continue;

      const judged = judgeEvidence(candidate, incumbent);
      if (!judged.ok) continue;

      const incumbentKey = linkKeyOf(incumbent.type, incumbent.subject) ?? incumbent.id;
      out.push({
        key: conflictKeyOf(incumbentKey, incumbent.id, candidate.sources),
        linkKey: incumbentKey,
        kind: CONFLICT_KINDS.STATE_CONTRADICTS,
        basis: CONFLICT_BASIS.MODEL_PROPOSED,
        incoming: incomingSideOf(candidate),
        incumbent: incumbentSideOf(incumbent),
        evidence: judged.evidence,
        why: `模型 ${judge.id} 认为它们说的是同一件事：${[...evidence].sort().join("；")}`,
      });
    }
  }

  return out.sort(byConflict);
}

/**
 * @param {CandidateAssertion} candidate
 * @returns {IncomingSide}
 */
function incomingSideOf(candidate: CandidateAssertion): IncomingSide {
  return {
    candidate,
    value: normalizeValue(candidate.body),
    sources: [...candidate.sources].sort(),
    origin: candidate.origin,
    title: candidate.title,
  };
}

/**
 * @param {AssetRef} asset
 * @returns {IncumbentSide}
 */
function incumbentSideOf(asset: AssetRef): IncumbentSide {
  return {
    asset,
    value: normalizeValue(asset.body),
    sources: [...asset.sources].sort(),
    assetId: asset.id,
    path: asset.path,
  };
}

/**
 * @param {string} text
 * @returns {string} 压平后的第一行，供报告显示
 */
function firstLineOf(text: string): string {
  const flat = normalizeText(text);
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
}

/**
 * @param {ConflictCandidate} a
 * @param {ConflictCandidate} b
 * @returns {number}
 */
function byConflict(a: ConflictCandidate, b: ConflictCandidate): number {
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}
