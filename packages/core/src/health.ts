/**
 * 健康检查 —— 纯函数，零 IO（S25）。
 *
 * 它回答一个问题：**这个库还找得到自己吗？**
 *
 * 四种腐烂方式各有各的形状，所以它们是**四组独立的判据**，不是一条"库好不好"的分数：
 *
 * | 腐烂 | 它的形状 | 为什么它是静默的 |
 * |---|---|---|
 * | 孤儿 | 一条资产没有任何邻居：没人取代它、它没取代谁、没有第二个人引用同一处来源 | 它照样被检索到，只是没人会再碰它 |
 * | 索引漂移 | `index/` 说的与 sources + assets 算出来的不一样 | 读它的人会拿到旧的答案，而旧答案与正确答案长得一样 |
 * | 过期断言 | `state` 超过窗口没被确认 | 过期的状态读起来与新鲜的一模一样 |
 * | 静默被取代 | `supersedes` 链断了，或同一个题面上有两条 `active` | 冲突判定只在**有新候选**时看这个题面（S19），没有新候选时没人看 |
 *
 * **不给库打健康分。** 一个 0–100 的数字会把"哪件事该被处理"变成"怎么把这个数字弄回去"——
 * 而这两件事的方向相反：最省事的提分方式是删掉报错的那几条。所以报告里只有
 * **清单 + 计数**：每一行都指着一个具体的文件，和一个具体的动作。
 *
 * **时钟由调用方注入**（`today`）：core 里没有 `Date.now()`。
 * 一条会因为"时间过去了"而变红的资产是维护任务的活（S26），
 * 不是提交闸门的活——那条边界在 Phase 1 就画好了（`checkFreshness` 一直不进闸门）。
 */
import { confirmWithinDays, type AssetDoc, type AssetType, type EventIR } from "@forge/schema";
import { checkFreshness } from "./asset.ts";
import { AUDIT_GAP_CODES, auditCompleteness, verifyChain, type AuditEntry } from "./audit.ts";
import { emitIndex } from "./emit.ts";
import { linkKeyOf } from "./link.ts";
import { parseSpan } from "./provenance.ts";

/**
 * 健康检查自己的码。与 `ASSET_CODES` 分开一张表：它们是**关于库**的，
 * 不是关于某一条资产的形状的——修法也不同（一个去改资产，一个去做维护）。
 */
export const HEALTH_CODES = {
  /** 一条资产没有任何邻居。**info**：它不是错误，是"没人碰过它"的信号。 */
  ORPHAN: "HEALTH_ORPHAN",
  /** `index/` 与 sources + assets 算出来的对不上（或索引根本不存在）。 */
  INDEX_DRIFT: "HEALTH_INDEX_DRIFT",
  /** `supersedes` 链断了：指向不存在的一代，或者旧那一代还标着 active。 */
  SILENT_SUPERSESSION: "HEALTH_SILENT_SUPERSESSION",
  /** 同一个题面上有多条 `active` 状态——一次替换写了一半，或者有人手写了两条。 */
  DUPLICATE_ACTIVE: "HEALTH_DUPLICATE_ACTIVE",
  /** 审计链断了：缺号、断链、被改、时间倒流。 */
  AUDIT_CHAIN_BROKEN: "HEALTH_AUDIT_CHAIN_BROKEN",
} as const;

export type HealthCode = (typeof HEALTH_CODES)[keyof typeof HEALTH_CODES];

/**
 * 一条健康发现。
 *
 * `severity` 三档里**只有 `info` 不进退出码**：孤儿是"你可以看一眼"，
 * 其余的是"现在就得做点什么"。把孤儿也算成问题，会让报告里长期挂着几十条
 * 不需要动作的行——而**长期挂着的红等于没有红**。
 */
export interface HealthFinding {
  code: string;
  path: string;
  message: string;
  fix: string;
  severity: "info" | "warn" | "error";
}

/**
 * 索引层的**事实**（由宿主读出来）。core 不认识 SQLite，也不认识文件。
 *
 * `indexed` 为 null 是"索引不存在"，不是"索引一致"——这两种情况在报告里
 * 必须长得不一样（ADR-0009 的那条理由：无法校验 ≠ 校验通过）。
 */
export interface IndexFacts {
  /** 索引层现在记着的东西。null = 还没编译过 / 索引被删了。 */
  indexed: { sources: number; events: number; assets: number; assetIds: string[] } | null;
  /** 从 sources + assets 重算出来的真值。 */
  actual: { sources: number; events: number };
  /** `index/INDEX.md` 的字节。null = 文件不在。 */
  indexMarkdown: string | null;
}

export interface AuditFacts {
  entries: AuditEntry[];
  /** 读日志时读不动的行（宿主报告）。**不静默跳过**。 */
  problems: string[];
}

export interface HealthInput {
  assets: AssetDoc[];
  /** `YYYY-MM-DD`。**必填**：新鲜度的判据依赖它，而 core 里没有时钟。 */
  today: string;
  /** 索引层的事实。不给 = **本次没查索引**（不是"索引没问题"）。 */
  index?: IndexFacts;
  /** 事件（重算 `INDEX.md` 要比对它的条数）。不给 = 不比对 `INDEX.md` 的字节。 */
  events?: EventIR[];
  /** 审计的事实。不给 = **本次没查审计**。 */
  audit?: AuditFacts;
}

/** 一条到期未确认的状态。周报与定时任务要的就是它。 */
export interface FreshnessDue {
  id: string;
  path: string;
  /** 从 `last_confirmed` 到今天的天数。 */
  ageDays: number;
  /** 窗口天数（来自分类法）。 */
  windowDays: number;
}

export interface HealthReport {
  /** 基准日。它是**输入**，所以报告可以被快照、被 diff（R6）。 */
  today: string;
  findings: HealthFinding[];
  /** 需要动手的（error + warn）。 */
  actionable: HealthFinding[];
  /** 只是看一眼的。 */
  informational: HealthFinding[];
  /** 本次**没有**查的东西。与"查过了，没问题"必须分开。 */
  unchecked: string[];
  due: FreshnessDue[];
  byType: Record<AssetType, number>;
  total: number;
}

/**
 * 跑一次健康检查。**只读**：它不改任何东西，也不因为"发现了问题"就去修。
 *
 * 这条纪律不是风格问题：一个会自己动手的健康检查（"发现 expired 就刷新
 * `last_confirmed`"）会让库永远看起来是新鲜的，而**新鲜度任务的全部价值
 * 就是让"过期"这件事被看见**（ADR-0036）。
 *
 * @param {HealthInput} input
 * @returns {HealthReport}
 */
export function runHealth(input: HealthInput): HealthReport {
  const assets = [...input.assets].sort(byPath);
  const findings: HealthFinding[] = [];
  const unchecked: string[] = [];

  findings.push(...orphanFindings(assets));
  findings.push(...supersessionFindings(assets));
  findings.push(...freshnessFindings(assets, input.today));

  if (input.index === undefined) {
    unchecked.push("索引层（宿主没有提供索引事实——这不是「索引一致」）");
  } else {
    if (input.events === undefined) unchecked.push("`INDEX.md` 的字节比对（宿主没有提供事件）");
    findings.push(...indexFindings(input.index, assets, input.events));
  }

  if (input.audit === undefined) {
    unchecked.push("审计（宿主没有提供审计事实——这不是「审计完整」）");
  } else {
    findings.push(...auditFindings(input.audit, assets));
  }

  const sorted = sortFindings(findings);
  const byType = { decision: 0, state: 0, event: 0, rule: 0 } as Record<AssetType, number>;
  for (const doc of assets) byType[doc.frontMatter.type] += 1;

  return {
    today: input.today,
    findings: sorted,
    actionable: sorted.filter((finding) => finding.severity !== "info"),
    informational: sorted.filter((finding) => finding.severity === "info"),
    unchecked: [...unchecked].sort(),
    due: freshnessBacklog(assets, input.today),
    byType,
    total: assets.length,
  };
}

/**
 * 到期未确认的状态，最旧的在前。
 *
 * 它**单独暴露**：S26 的定时任务问的就是这一个问题（"今天该找谁确认"），
 * 而它不需要整份健康报告。
 *
 * @param {AssetDoc[]} assets
 * @param {string} today
 * @returns {FreshnessDue[]}
 */
export function freshnessBacklog(assets: AssetDoc[], today: string): FreshnessDue[] {
  const due: FreshnessDue[] = [];
  for (const doc of assets) {
    const windowDays = confirmWithinDays(doc.frontMatter.type);
    if (windowDays === null) continue;
    const last = doc.frontMatter.last_confirmed;
    // 没有 `last_confirmed` 的 state 由审核报 `REQUIRED_FIELD_MISSING`——
    // 那是"你还没确认过它"，与"它过期了"是两件事，修法也不同。这里不重复报。
    if (last === null) continue;
    const ageDays = daysBetween(last, today);
    if (ageDays === null || ageDays <= windowDays) continue;
    due.push({ id: doc.frontMatter.id, path: doc.path, ageDays, windowDays });
  }
  // 最旧的在前：先处理它，因为"好久没看过"的风险随天数增长。
  // 同一天数按路径——排序键必须完全确定，否则两次运行会打出不同的行（R6）。
  return due.sort((a, b) => (b.ageDays === a.ageDays ? (a.path < b.path ? -1 : 1) : b.ageDays - a.ageDays));
}

/**
 * 孤儿：**一条没有任何邻居的资产**。
 *
 * 三种邻接，任意一种成立都不算孤儿：
 *
 * | 邻接 | 判据 | 它意味着 |
 * |---|---|---|
 * | 取代链 | `supersedes` 指向对方（任一方向） | 这两条讲的是同一件事的两代 |
 * | 题面 | 归一化题面相同 | 它们属于同一个实体（ADR-0025） |
 * | 证据 | 共享同一处**来源目标**（`scheme://target`，不含锚点） | 它们出自同一份材料 |
 *
 * 第三条刻意**忽略锚点**：同一份会话导出的两条断言，锚点当然不同（各指各的那句话），
 * 但它们出自同一份材料——按锚点比会把整个库判成孤儿。
 *
 * 两条**范围**规矩，都是为了不制造噪音：
 *
 * - **只查 `decision` / `state` / `rule`**：`event` 是时间线，它按定义就是一条条独立的事件。
 *   把事件算进来，孤儿清单会被时间线淹没——而**被淹没的清单等于没有清单**。
 * - **已经退休的不查**（`superseded` / `retired`）：一条被取代的状态**本来就该**没人引用它。
 *   把"它退休了"再报一遍"没人引用它"，是在同一件事上收两次噪音。
 *
 * @param {AssetDoc[]} assets
 * @returns {HealthFinding[]}
 */
function orphanFindings(assets: AssetDoc[]): HealthFinding[] {
  const knowledge = assets.filter((doc) => doc.frontMatter.type !== "event" && isLive(doc.frontMatter.status));

  const bySubject = new Map<string, string[]>();
  const byEvidence = new Map<string, string[]>();
  /** 取代关系是**无向**边：两个方向都算有关系——谁先写的与"是不是同一件事的两代"无关。 */
  const neighbours = new Map<string, Set<string>>();

  for (const doc of knowledge) {
    const id = doc.frontMatter.id;
    const subjectKey = linkKeyOf(doc.frontMatter.type, doc.frontMatter.subject);
    if (subjectKey !== null) push(bySubject, subjectKey, id);
    for (const target of evidenceTargets(doc)) push(byEvidence, target, id);
  }

  for (const doc of knowledge) {
    const supersedes = doc.frontMatter.supersedes;
    if (supersedes === null) continue;
    link(neighbours, doc.frontMatter.id, supersedes);
    link(neighbours, supersedes, doc.frontMatter.id);
  }

  const out: HealthFinding[] = [];
  for (const doc of knowledge) {
    const id = doc.frontMatter.id;
    if (hasNeighbour(id, doc, bySubject, byEvidence, neighbours)) continue;
    out.push({
      code: HEALTH_CODES.ORPHAN,
      path: doc.path,
      severity: "info",
      message:
        "这条资产没有任何邻居：没有第二条资产取代它或它取代的、没有第二个人引用同一处来源、" +
        "同一个题面下也只有它一条。它照样会被检索到，但**没有任何一处地方的改动会牵动它**——" +
        "孤儿就是这么开始的：先没人引用，再没人复核。",
      fix:
        "看一眼它值不值得留：值得就把它接起来（补上题面，或用同一处来源的其它断言连上）；" +
        "不值得就删掉——一条没人碰的资产比没有更糟，它会被当成现状用",
    });
  }
  return out;
}

/**
 * @param {string} id
 * @param {AssetDoc} doc
 * @param {Map<string, string[]>} bySubject
 * @param {Map<string, string[]>} byEvidence
 * @param {Map<string, Set<string>>} neighbours
 * @returns {boolean}
 */
function hasNeighbour(
  id: string,
  doc: AssetDoc,
  bySubject: Map<string, string[]>,
  byEvidence: Map<string, string[]>,
  neighbours: Map<string, Set<string>>,
): boolean {
  if ((neighbours.get(id)?.size ?? 0) > 0) return true;
  const subjectKey = linkKeyOf(doc.frontMatter.type, doc.frontMatter.subject);
  if (subjectKey !== null && (bySubject.get(subjectKey) ?? []).some((other) => other !== id)) return true;
  for (const target of evidenceTargets(doc)) {
    if ((byEvidence.get(target) ?? []).some((other) => other !== id)) return true;
  }
  return false;
}

/**
 * 一条资产的证据**目标**集合：`scheme://target`，**丢了锚点**。
 *
 * 解析不了的 span 在这里被跳过（它已经在审核里报过 `PROV_SPAN_UNRESOLVED`）。
 * 跳过的代价是"这条资产的证据邻接变少"，方向是**多报孤儿**——
 * 那比漏报安全：孤儿是 info，多报一条不需要动作。
 *
 * @param {AssetDoc} doc
 * @returns {string[]}
 */
function evidenceTargets(doc: AssetDoc): string[] {
  const targets = new Set<string>();
  for (const raw of doc.frontMatter.sources) {
    const parsed = parseSpan(raw);
    if (!parsed.ok) continue;
    targets.add(`${parsed.span.scheme}://${parsed.span.target}`);
  }
  return [...targets];
}

/**
 * 静默被取代 —— `supersedes` 链上的三种断法，加一种题面塌陷。
 *
 * | 形状 | 它为什么静默 |
 * |---|---|
 * | 指向不存在的一代 | 链断了，但每一份文件自己读起来都正常 |
 * | 旧那一代还标着 `active` | 同一个题面上现在有两条"现在的样子" |
 * | 标了 `superseded` 却没有取代者 | 这条状态退休了，而代替它的东西不在库里 |
 * | 同一题面多条 `active` | 一次替换写了一半，或者有人手写了两条 |
 *
 * 最后一条是**最贵的那一条**：冲突判定（S19）只在"有新候选"时看这个题面，
 * 没有新候选时两条 active 会一直并存——而"两条都说是现在的样子"，
 * 正是这个产品最不能出的静默故障（ADR-0025 的那句话）。
 *
 * @param {AssetDoc[]} assets
 * @returns {HealthFinding[]}
 */
function supersessionFindings(assets: AssetDoc[]): HealthFinding[] {
  const byId = new Map(assets.map((doc) => [doc.frontMatter.id, doc]));
  const supersededBy = new Map<string, string[]>();
  for (const doc of assets) {
    const target = doc.frontMatter.supersedes;
    if (target !== null) push(supersededBy, target, doc.frontMatter.id);
  }

  const out: HealthFinding[] = [];

  for (const doc of assets) {
    const target = doc.frontMatter.supersedes;
    if (target === null) continue;
    const previous = byId.get(target);
    if (previous === undefined) {
      out.push({
        code: HEALTH_CODES.SILENT_SUPERSESSION,
        path: doc.path,
        severity: "error",
        message: `它声称取代了 ${target}，但库里没有这一条。链断在这里，"上一代是什么"因此没有答案。`,
        fix: "恢复那一条，或者把 supersedes 改成真正被取代的那一代——指向空气的链等于没有链",
      });
      continue;
    }
    if (previous.frontMatter.status !== "superseded") {
      out.push({
        code: HEALTH_CODES.SILENT_SUPERSESSION,
        path: doc.path,
        severity: "error",
        message:
          `它取代了 ${previous.path}，但那一代的 status 还是 ${previous.frontMatter.status}。` +
          `同一个题面上现在有两条"现在的样子"——读哪一条都对，而它们说的不一样。`,
        fix: `把 ${previous.path} 的 status 改成 superseded（正文与出处一个字节都别动：它仍然要可读、可核对）`,
      });
    }
  }

  for (const doc of assets) {
    if (doc.frontMatter.status !== "superseded") continue;
    if ((supersededBy.get(doc.frontMatter.id) ?? []).length > 0) continue;
    out.push({
      code: HEALTH_CODES.SILENT_SUPERSESSION,
      path: doc.path,
      severity: "warn",
      message: "它被标成 superseded，但库里没有任何一条取代它。一条退休的状态，没有接班人。",
      fix: "要么把取代它的那一代找回来，要么把 status 改回 active——「退休了但没人接班」会让读者以为现状在别处",
    });
  }

  const actives = new Map<string, AssetDoc[]>();
  for (const doc of assets) {
    if (doc.frontMatter.type !== "state" || doc.frontMatter.status !== "active") continue;
    const key = linkKeyOf(doc.frontMatter.type, doc.frontMatter.subject);
    if (key === null) continue;
    push(actives, key, doc);
  }
  for (const [key, group] of [...actives.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (group.length < 2) continue;
    // 组内**已经有取代关系**的，上面那条检查已经报过了（而且报得更准：
    // 它指得出"哪一代没被标 superseded"）。同一件事报两遍只会让人以为有两处问题。
    // 所以这里管的是另一种形状：两条 active 之间**什么关系都没有**——
    // 有人手写了两条，或者替换写到一半连 supersedes 都没落下去。
    if (hasSupersedeWithin(group)) continue;
    const paths = group.map((doc) => doc.path).sort();
    for (const doc of group) {
      out.push({
        code: HEALTH_CODES.DUPLICATE_ACTIVE,
        path: doc.path,
        severity: "error",
        message:
          `题面「${key}」上有 ${String(group.length)} 条 active 状态（${paths.join("、")}），` +
          `而它们之间**没有取代关系**。而**冲突判定看不见它**：` +
          `S19 只在新候选到来时看这个题面，没有新候选时这几条会一直并存。`,
        fix: "留一条 active，其余走一次状态替换（`supersedes` 链），或者把它们并成一条",
      });
    }
  }

  return out;
}

/**
 * 组内是否已经有取代关系。有的话，`supersedes` 那条检查已经覆盖了这个形状。
 *
 * @param {AssetDoc[]} group
 * @returns {boolean}
 */
function hasSupersedeWithin(group: AssetDoc[]): boolean {
  const ids = new Set(group.map((doc) => doc.frontMatter.id));
  return group.some((doc) => {
    const target = doc.frontMatter.supersedes;
    return target !== null && ids.has(target);
  });
}

/**
 * 这条资产**还算数**吗？孤儿分析只问"还算数的资产里，有没有人碰过它"。
 *
 * @param {string} status
 * @returns {boolean}
 */
function isLive(status: string): boolean {
  return status !== "superseded" && status !== "retired";
}

/**
 * 过期断言。判据复用 `checkFreshness`（Phase 1 就写下的那个窗口），
 * **不在这里再写一遍**：窗口是分类法的一部分（`schema/taxonomy.yaml` 的
 * `confirm_within_days`），两个地方各写一份必然漂移，而漂移的方向是
 * "健康检查报了、审核没报"——那会让人开始不信两边的任何一个。
 *
 * @param {AssetDoc[]} assets
 * @param {string} today
 * @returns {HealthFinding[]}
 */
function freshnessFindings(assets: AssetDoc[], today: string): HealthFinding[] {
  return assets.flatMap((doc) =>
    checkFreshness(doc, today).map((violation) => ({
      code: violation.code,
      path: violation.path,
      message: violation.message,
      fix: violation.fix,
      severity: "warn" as const,
    })),
  );
}

/**
 * 索引漂移 —— `index/` 是可重建的（ADR-0015），所以判据就是"删掉重建会不会一样"。
 *
 * 不比字节，比**它记的东西**：来源数、事件数、资产数、资产 ID 集合。
 * 索引层内部怎么存（SQLite 的表结构、页大小）不是契约，比较它只会制造噪音。
 *
 * `INDEX.md` 是例外——它是投影，投影的正确内容就是"当前库的样子"（R6），
 * 所以它的比对是**逐字节**的。
 *
 * @param {IndexFacts} facts
 * @param {AssetDoc[]} assets
 * @param {EventIR[]} [events]
 * @returns {HealthFinding[]}
 */
function indexFindings(facts: IndexFacts, assets: AssetDoc[], events?: EventIR[]): HealthFinding[] {
  const out: HealthFinding[] = [];
  const indexed = facts.indexed;

  if (indexed === null) {
    out.push({
      code: HEALTH_CODES.INDEX_DRIFT,
      path: "index/",
      severity: "warn",
      message:
        "索引层不存在（或格式版本对不上）。它不影响正确性——索引是派生数据，" +
        "但它会让所有读索引的东西静默地少一截。",
      fix: "跑一次 `forge compile` 重建它",
    });
    return out;
  }

  const expectedIds = assets.map((doc) => doc.frontMatter.id);
  const indexedIds = new Set(indexed.assetIds);
  const expectedSet = new Set(expectedIds);
  const mismatches: string[] = [];
  if (indexed.assets !== assets.length) mismatches.push(`资产数 ${String(indexed.assets)} ≠ ${String(assets.length)}`);
  if (indexed.sources !== facts.actual.sources) {
    mismatches.push(`来源数 ${String(indexed.sources)} ≠ ${String(facts.actual.sources)}`);
  }
  if (indexed.events !== facts.actual.events) {
    mismatches.push(`事件数 ${String(indexed.events)} ≠ ${String(facts.actual.events)}`);
  }
  const missing = expectedIds.filter((id) => !indexedIds.has(id)).sort();
  const extra = [...indexedIds].filter((id) => !expectedSet.has(id)).sort();
  if (missing.length > 0) {
    mismatches.push(`索引里少了 ${String(missing.length)} 条资产（${firstFew(missing)}）`);
  }
  if (extra.length > 0) {
    mismatches.push(`索引里多了 ${String(extra.length)} 条资产（${firstFew(extra)}）`);
  }

  if (mismatches.length > 0) {
    out.push({
      code: HEALTH_CODES.INDEX_DRIFT,
      path: "index/",
      severity: "warn",
      message:
        `索引层与 sources + assets 算出来的对不上：${mismatches.join("；")}。` +
        "它是派生的，所以这不是数据损坏——但**读它的人会拿到旧的答案**，而旧答案与正确答案长得一样。",
      fix: "跑一次 `forge compile` 重建（重建是幂等的：同一份库跑两次得到同样的字节）",
    });
  }

  if (events !== undefined) {
    const expected = emitIndex({ assets, events });
    if (facts.indexMarkdown === null) {
      out.push({
        code: HEALTH_CODES.INDEX_DRIFT,
        path: "index/INDEX.md",
        severity: "warn",
        message: "`INDEX.md` 不在。它是投影，但它是**人读库的唯一入口**——少了它，索引层等于不存在。",
        fix: "跑一次 `forge compile`",
      });
    } else if (facts.indexMarkdown !== expected) {
      out.push({
        code: HEALTH_CODES.INDEX_DRIFT,
        path: "index/INDEX.md",
        severity: "warn",
        message:
          "`INDEX.md` 与库当前的样子不一致（逐字节比对）。投影的正确内容就是「当前库的样子」——" +
          "不一致说明有人在它上面动过手，或者库变了而它没跟上。",
        fix: "跑一次 `forge compile` 覆盖它。**不要手工改它**：它是投影，改它等于制造第二份真相",
      });
    }
  }

  return out;
}

/**
 * 审计：链完整 + 与库对账。**两件事分开报**（见 `./audit.ts` 的文件头）。
 *
 * 链断掉的时候，这个函数**仍然继续对账**：先把"日志本身不可信"这条说出来，
 * 再把"库里哪些写入没有记录"说出来。只报前者的实现会让人以为"修好链就没事了"。
 *
 * @param {AuditFacts} facts
 * @param {AssetDoc[]} assets
 * @returns {HealthFinding[]}
 */
function auditFindings(facts: AuditFacts, assets: AssetDoc[]): HealthFinding[] {
  const out: HealthFinding[] = [];

  for (const problem of [...verifyChain(facts.entries).problems, ...facts.problems].sort()) {
    out.push({
      code: HEALTH_CODES.AUDIT_CHAIN_BROKEN,
      path: "audit/audit.jsonl",
      severity: "error",
      message: `${problem}。审计链断掉之后，**这份日志里的每一条都不能再被相信**——包括那些看起来没问题的。`,
      fix: "从备份恢复日志，或者接受这一段历史不可追溯并把它写下来。**不要**手工调 seq 或重算 hash 把它「修好」",
    });
  }

  const paths = new Map(assets.map((doc) => [doc.frontMatter.id, doc.path]));
  for (const gap of auditCompleteness(facts.entries, assets)) {
    const unattributed = gap.code === AUDIT_GAP_CODES.UNATTRIBUTED;
    out.push({
      code: gap.code,
      path: paths.get(gap.subject) ?? gap.subject,
      severity: unattributed ? "info" : "error",
      message: gap.message,
      fix: unattributed
        ? "如果是手工放进去的，把来源写进它的 sources 就够用了——审计记不了文件系统，但健康检查能看见它。" +
          "若它是 forge 写的，说明有条写路径绕过了审计，去修那条路径"
        : "先弄清这个资产去哪了：审计记过的写入被删掉，是必须先弄清的事",
    });
  }

  return out;
}

/**
 * @param {Map<string, string[]>} map
 * @param {string} key
 * @param {string} value
 * @returns {void}
 */
function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

/**
 * @param {Map<string, Set<string>>} map
 * @param {string} from
 * @param {string} to
 * @returns {void}
 */
function link(map: Map<string, Set<string>>, from: string, to: string): void {
  const set = map.get(from);
  if (set === undefined) map.set(from, new Set([to]));
  else set.add(to);
}

/**
 * @param {string[]} ids
 * @returns {string}
 */
function firstFew(ids: string[]): string {
  const head = ids.slice(0, 3).join("、");
  return ids.length > 3 ? `${head}…` : head;
}

/**
 * @param {AssetDoc} a
 * @param {AssetDoc} b
 * @returns {number}
 */
function byPath(a: AssetDoc, b: AssetDoc): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/**
 * 排序：**先码、再路径、再消息**。码在前是因为人按"哪一类问题"分批处理——
 * 同一类的修法是同一个，混着看会把同一件事想两遍。
 *
 * @param {HealthFinding[]} findings
 * @returns {HealthFinding[]}
 */
function sortFindings(findings: HealthFinding[]): HealthFinding[] {
  return [...findings].sort((a, b) => {
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.message < b.message ? -1 : a.message > b.message ? 1 : 0;
  });
}

/**
 * @param {string} from `YYYY-MM-DD`
 * @param {string} to `YYYY-MM-DD`
 * @returns {number | null}
 */
function daysBetween(from: string, to: string): number | null {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.floor((b - a) / 86_400_000);
}
