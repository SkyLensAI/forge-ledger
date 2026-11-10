/**
 * `_conflicts/` —— 冲突队列（S20）。**IO 层**，与 `assets/`、`_inbox/` 平级。
 *
 * 三条决定，每一条都对应一个具体的失败：
 *
 * 1. **它是文件，不是数据库表。** 一条冲突记录要能被人直接用编辑器打开核对：
 *    它带着两侧的出处、两侧的内容、以及"上一代状态长什么样"。
 *    一条只有 ID 的记录会让人先去写一个查询再开始判断——而队列的价值在于
 *    "看一眼就能判"。
 *
 * 2. **记录一旦写下就不再改**（除了 `status` 与 `resolution` 这两处）。
 *    它是**审计**的一部分：改了它，就等于抹掉"当时我们看到的是什么"。
 *    这也是为什么 `replace` 的落盘方式是新一代 + `supersedes` 链（ADR-0028），
 *    而不是就地覆盖：库里那两代状态与队列里那条记录合起来，
 *    才是一次替换的完整证据。
 *
 * 3. **ID 是内容寻址的，来自 `conflictKeyOf`**（`<题面键> + <资产 ID> + <新证据>`）。
 *    于是同一组矛盾重跑 `forge link` 得到的是**同一个文件**：队列不会因为
 *    多跑了一次而长出第二条。而"什么时候发现的"不记在这里——
 *    时间进产出会让重跑产生 diff（R6），而那是审计层（Phase 7 / S27）的事。
 *
 * 判定在 `@forge/core/src/conflict.ts`，这里只负责读写与不变量：**没有任何一处
 * 会替人做决定**。`resolve` 的入口只接受 Claude/Cursor 之外的显式参数
 * （决议、日期、理由），它们全是人的判断。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { contentAddressedId } from "@forge/schema";
import type {
  CandidateOrigin,
  ConflictBasis,
  ConflictCandidate,
  ConflictKind,
  ConflictJudgement,
} from "@forge/core";
import type { VaultPaths } from "./paths.ts";
import { stableJson } from "./paths.ts";

/** 队列记录的 ID 前缀。与候选区同一条理由：**刻意不进 `schema/ids.md`**——那不是资产 ID。 */
export const CONFLICT_PREFIX = "conf_";

/** 记录的形状版本。候选记录与它各自独立（ADR-0008 管的是资产）。 */
export const CONFLICT_RECORD_VERSION = 1;

/**
 * 一条冲突在队列里的状态。
 *
 * `deferred` 单独一档而不是"open 加一个标记"：**"今天不判"与"还没看"是两件事**，
 * 合并之后队列里就分不出"没读过"和"读过但决定不判"——而后者正是最需要留痕的那一档。
 */
export const CONFLICT_STATUS = {
  OPEN: "open",
  DEFERRED: "deferred",
  RESOLVED: "resolved",
} as const;

export type ConflictStatus = (typeof CONFLICT_STATUS)[keyof typeof CONFLICT_STATUS];

/**
 * 人的三种决定。它们的区别是"动了什么"，所以必须是三档（ADR-0028）：
 *
 * | 决议 | 动什么 |
 * |---|---|
 * | `replace` | 落新一代状态 + 把旧那代标成 `superseded` |
 * | `keep` | **一个字节都不动**（旧的那条仍然成立） |
 * | `defer` | 不动，留在队列里 |
 */
export const RESOLUTIONS = {
  REPLACE: "replace",
  KEEP: "keep",
  DEFER: "defer",
} as const;

export type Resolution = (typeof RESOLUTIONS)[keyof typeof RESOLUTIONS];

/** 冲突的一侧在记录里的快照。"当时我们看到的是什么"必须留在记录里。 */
export interface ConflictSideRecord {
  /** 人读的标签：新证据侧是候选标题，现状侧是资产路径。 */
  label: string;
  /** 归一化后的内容（判定用的就是它）。 */
  value: string;
  sources: string[];
}

export interface ConflictIncumbentRecord extends ConflictSideRecord {
  asset_id: string;
  path: string;
  /** 记录写下时那条资产的状态。它变了说明这份记录过期了。 */
  status: string;
}

export interface ConflictIncomingRecord extends ConflictSideRecord {
  candidate_id: string;
  origin: CandidateOrigin;
}

/** 人的决议。**四个字段全是人的判断，一个都没有默认值。** */
export interface ConflictResolution {
  decision: Resolution;
  /** `YYYY-MM-DD`：人做这个决定的那天。 */
  date: string;
  /** 为什么信这一侧。必填——没有理由的判定等于一次点击。 */
  rationale: string;
  /** 谁判的（可选：单人模式下没有团队身份可言，字段留着是为了团队版不改变记录形状）。 */
  actor: string | null;
  /** `replace` 时才有：落下去的那一代新状态。 */
  applied: { asset_id: string; path: string; supersedes: string } | null;
}

export interface ConflictRecord {
  conflict_version: number;
  conflict_id: string;
  status: ConflictStatus;
  kind: ConflictKind;
  basis: ConflictBasis;
  /** `<类型>#<归一化题面>`。 */
  link_key: string;
  /** 题面的**原样**写法（不是键）。`replace` 落新一代时就是写它。 */
  subject: string;
  incumbent: ConflictIncumbentRecord;
  incoming: ConflictIncomingRecord;
  evidence: string[];
  why: string;
  /** 写下时**上一代状态**的完整快照。就地覆盖过一次也还能看见原来是什么。 */
  before: { value: string; sources: string[] };
  resolution: ConflictResolution | null;
}

export interface InvalidConflict {
  path: string;
  reason: string;
}

export interface ConflictScan {
  records: ConflictRecord[];
  /** 读不动的文件。**不静默跳过**：它们是"看起来进了队列但没进"的东西。 */
  invalid: InvalidConflict[];
}

export interface ConflictLayer {
  scan(): ConflictScan;
  read(conflictId: string): ConflictRecord | null;
  /** 写一条。同 ID 覆盖是正常的（重跑得到同样的字节），而且它幂等。 */
  put(record: ConflictRecord): { path: string; created: boolean };
  /** 只改状态与决议，其余字节不动（记录一旦写下就不再改）。 */
  markResolved(conflictId: string, resolution: ConflictResolution, status: ConflictStatus): boolean;
  remove(conflictId: string): boolean;
}

/**
 * 冲突记录的 ID：内容寻址，种子是判定的 `key`。
 *
 * 用 `conf_` 而不是 `state_` 之类：队列记录**不是资产**，
 * 它永远不会被 emit、不会被检索、也不该被人引用为事实。
 *
 * @param {ConflictCandidate} candidate
 * @returns {string}
 */
export function conflictIdOf(candidate: ConflictCandidate): string {
  return contentAddressedId(CONFLICT_PREFIX, candidate.key);
}

/**
 * 把一条判定结果变成一条队列记录。
 *
 * `incumbent` 参数是"库里那条现状现在长什么样"——它进 `before` 快照，
 * 于是"这次替换改掉了什么"这个问题在记录里有答案，而不是要靠翻历史。
 *
 * @param {ConflictCandidate} candidate 判定给出的候选
 * @param {ConflictIncumbentRecord} incumbent 现有的那条状态（快照）
 * @param {string} subject 题面的原样写法
 * @param {string} candidateId 新证据那条候选的 ID（人能顺着它回到候选区）
 * @returns {ConflictRecord}
 */
export function recordOf(
  candidate: ConflictCandidate,
  incumbent: ConflictIncumbentRecord,
  subject: string,
  candidateId: string,
): ConflictRecord {
  return {
    conflict_version: CONFLICT_RECORD_VERSION,
    conflict_id: conflictIdOf(candidate),
    status: CONFLICT_STATUS.OPEN,
    kind: candidate.kind,
    basis: candidate.basis,
    link_key: candidate.linkKey,
    subject,
    incumbent,
    incoming: {
      label: candidate.incoming.title,
      value: candidate.incoming.value,
      sources: candidate.incoming.sources,
      candidate_id: candidateId,
      origin: candidate.incoming.origin,
    },
    evidence: candidate.evidence,
    why: candidate.why,
    before: { value: incumbent.value, sources: incumbent.sources },
    resolution: null,
  };
}

/**
 * @param {VaultPaths} paths
 * @returns {ConflictLayer}
 */
export function openConflictLayer(paths: VaultPaths): ConflictLayer {
  return {
    scan() {
      const records: ConflictRecord[] = [];
      const invalid: InvalidConflict[] = [];
      if (!existsSync(paths.conflicts)) return { records, invalid };
      // 排序：`readdirSync` 的顺序不是契约（R6）。
      for (const name of [...readdirSync(paths.conflicts)].sort()) {
        if (!name.endsWith(".json")) continue;
        const path = join(paths.conflicts, name);
        const parsed = parseConflict(readFileSync(path, "utf8"));
        if (parsed.ok) records.push(parsed.record);
        else invalid.push({ path: name, reason: parsed.reason });
      }
      return { records, invalid };
    },

    read(conflictId) {
      const path = join(paths.conflicts, `${conflictId}.json`);
      if (!existsSync(path)) return null;
      const parsed = parseConflict(readFileSync(path, "utf8"));
      return parsed.ok ? parsed.record : null;
    },

    put(record) {
      if (!existsSync(paths.conflicts)) mkdirSync(paths.conflicts, { recursive: true });
      // 文件名由 ID 派生，而不是由记录里的字段拼——两处拼法迟早会不一致，
      // 而不一致的后果是"同一条冲突有两个文件"（与候选区同一条理由，ADR-0013）。
      const path = join(paths.conflicts, `${record.conflict_id}.json`);
      const created = !existsSync(path);
      writeFileSync(path, stableJson(record), "utf8");
      return { path, created };
    },

    markResolved(conflictId, resolution, status) {
      const path = join(paths.conflicts, `${conflictId}.json`);
      if (!existsSync(path)) return false;
      const parsed = parseConflict(readFileSync(path, "utf8"));
      if (!parsed.ok) return false;
      writeFileSync(path, stableJson({ ...parsed.record, status, resolution }), "utf8");
      return true;
    },

    remove(conflictId) {
      const path = join(paths.conflicts, `${conflictId}.json`);
      if (!existsSync(path)) return false;
      rmSync(path);
      return true;
    },
  };
}

/**
 * 把一批判定结果写成队列记录，**跳过已经在队列里的 ID**。
 *
 * 幂等靠 ID 的内容寻址：同一组矛盾第二次跑得到同一个 ID，于是它被跳过并计数。
 * 为什么不清掉重写：那会把 `resolution` 抹掉——而"这条我判过了"正是队列
 * 最贵的状态（有它，人不用重复判断同一件事）。
 *
 * @param {ConflictLayer} layer
 * @param {ConflictJudgement} judgement
 * @param {Map<string, {incumbent: ConflictIncumbentRecord; subject: string; candidateId: string}>} context
 * @returns {{written: Array<{path: string; created: boolean}>, existing: ConflictRecord[]}}
 */
export function writeConflicts(
  layer: ConflictLayer,
  judgement: ConflictJudgement,
  context: Map<string, { incumbent: ConflictIncumbentRecord; subject: string; candidateId: string }>,
): { written: Array<{ path: string; created: boolean }>; existing: ConflictRecord[] } {
  const known = new Set(layer.scan().records.map((record) => record.conflict_id));
  const written: Array<{ path: string; created: boolean }> = [];
  const existing: ConflictRecord[] = [];

  for (const candidate of judgement.conflicts) {
    const id = conflictIdOf(candidate);
    if (known.has(id)) {
      const record = layer.read(id);
      if (record !== null) existing.push(record);
      continue;
    }
    const entry = context.get(candidate.key);
    if (entry === undefined) continue;
    written.push(layer.put(recordOf(candidate, entry.incumbent, entry.subject, entry.candidateId)));
  }

  return { written, existing };
}

/**
 * 解析一份队列记录。**不信文件内容**：队列记录是人可以手改的地方，
 * 而手改过的记录必须被读出来（哪怕读不动），不能静默丢掉。
 *
 * @param {string} text
 * @returns {{ok: true, record: ConflictRecord} | {ok: false, reason: string}}
 */
function parseConflict(text: string): { ok: true; record: ConflictRecord } | { ok: false; reason: string } {
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

  const id = record["conflict_id"];
  if (typeof id !== "string" || id.length === 0) return { ok: false, reason: "没有 conflict_id" };
  const linkKey = record["link_key"];
  if (typeof linkKey !== "string" || linkKey.length === 0) return { ok: false, reason: "没有 link_key" };
  const incumbent = record["incumbent"];
  if (typeof incumbent !== "object" || incumbent === null) return { ok: false, reason: "没有 incumbent" };
  const evidence = record["evidence"];
  if (!Array.isArray(evidence) || evidence.some((entry) => typeof entry !== "string")) {
    return { ok: false, reason: "evidence 不是字符串数组" };
  }
  if (evidence.length === 0) {
    // 没有证据的记录不许进队列——一条人核对不了的冲突比没有更糟（ADR-0027）。
    return { ok: false, reason: "evidence 是空的：一条没有证据的冲突记录不该在队列里" };
  }

  return { ok: true, record: record as unknown as ConflictRecord };
}
