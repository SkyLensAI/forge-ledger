/**
 * 资产审核 —— 纯函数，零 IO。
 *
 * 这一份判定有**三个宿主**：`forge lint`（用户库）、闸门 3（本仓库的资产）、
 * 以及将来的 MCP server / 桌面端。所以它不能读文件、不能碰时钟、
 * 也不能知道"今天是几号"（时间由调用方注入，见 `today` 参数）。
 * 宿主之间的漂移是这类系统最典型的腐烂方式：本地过、CI 挂，
 * 然后所有人开始认为"闸门就是会偶尔抽风"。
 *
 * 判据来自 ADR-0006（4 种类型）/ ADR-0007（ID 前缀）/ ADR-0008（版本）/
 * ADR-0009（出处是 span）/ ADR-0012（带 front-matter 的 markdown 即资产）。
 */
import {
  REQUIRED_FIELDS,
  REQUIRED_SECTIONS,
  SCHEMA_VERSION,
  confirmWithinDays,
  prefixOf,
  typeOfId,
  type AssetDoc,
  type AssetFrontMatter,
  type AssetType,
} from "@forge/schema";
import { formatSpan, parseSpan, type Span } from "./provenance.ts";
import { sortViolations, type Violation } from "./violation.ts";

/**
 * 违规码表。
 *
 * 为什么"不可解析"和"没有出处"必须是两个码（ADR-0009）：修法不同——
 * 前者去修 span，后者去补证据。合并成一个码等于把修法也合并掉，
 * 而闸门输出是行动指令。
 *
 * ADR-0010 要求这张表的每一项都出现在 `schema/provenance.md` 里，
 * 且一致性由闸门机器校验（`scripts/gates/`）—— 码是代码与人之间的契约。
 */
export const ASSET_CODES = {
  /** front-matter 本身不合法（缺字段、类型错、值域外）。 */
  SHAPE: "ASSET_FRONTMATTER_INVALID",
  /** ID 的类型前缀与 `type` 字段不一致。 */
  ID_PREFIX: "ID_PREFIX_MISMATCH",
  /** `schema_version` 与当前分类法版本不一致（ADR-0008：缺版本号 = v0）。 */
  VERSION: "SCHEMA_VERSION_MISMATCH",
  /** 没有 `sources`：断言没有出处。 */
  NO_SOURCES: "PROV_NO_SOURCES",
  /** span 语法不合法，或目标/锚点解析不到。 */
  SPAN_UNRESOLVED: "PROV_SPAN_UNRESOLVED",
  /** 本宿主无法校验这个 scheme（例如 CI 里没有 `data/sources/`）。 */
  SCHEME_UNAVAILABLE: "PROV_SCHEME_UNAVAILABLE",
  /** 类型要求的字段缺失或为空（`rule.origin_incident` / `state.last_confirmed`）。 */
  REQUIRED_FIELD: "REQUIRED_FIELD_MISSING",
  /** 类型要求的正文章节缺失。 */
  REQUIRED_SECTION: "REQUIRED_SECTION_MISSING",
  /** state 型资产超过新鲜度窗口（只报给 lint，不进闸门——见下方 checkFreshness）。 */
  FRESHNESS: "FRESHNESS_EXPIRED",
} as const;

export type AssetCode = (typeof ASSET_CODES)[keyof typeof ASSET_CODES];

/**
 * 一个 span 在一个宿主里的**事实**。
 *
 * 注意这里没有"可能"这一档：判定必须是二值的，否则"看起来解析过了"会混进绿灯。
 * `unavailable` 是第三种输出，专指"本宿主根本没有校验它的能力"（ADR-0009：
 * "本闸门无法校验"和"校验通过"必须是两种不同的输出）。
 */
export type SpanFact =
  | { kind: "resolved"; excerpt: string }
  | { kind: "unresolved"; reason: string }
  | { kind: "unavailable"; reason: string };

/**
 * 出处索引。**这是 IO 与纯函数的分界线**：读文件、解 JSON、建 map 都是边缘的事，
 * 判定侧只问"这个 span 的事实是什么"。
 */
export interface SpanIndex {
  lookup(canonicalSpan: string): SpanFact;
}

/**
 * 给边缘用的一致性实现：一张 map + 一个对未命中者生效的兜底事实。
 *
 * 兜底**必须**显式给定而不是默认成 `unresolved`：
 * "索引里没有"与"目标里找不到"是两件事，把前者默认成后者会掩盖宿主的漏建索引。
 *
 * @param {Map<string, SpanFact>} facts
 * @param {SpanFact} fallback
 * @returns {SpanIndex}
 */
export function createSpanIndex(facts: Map<string, SpanFact>, fallback: SpanFact): SpanIndex {
  return {
    lookup(canonicalSpan: string): SpanFact {
      return facts.get(canonicalSpan) ?? fallback;
    },
  };
}

/** 正文里的二级标题文字，按出现顺序。 */
export function sectionsOf(body: string): string[] {
  const out: string[] = [];
  for (const line of body.replace(/\r\n?/g, "\n").split("\n")) {
    const match = /^\s{0,3}##\s+(.*)$/.exec(line);
    const title = match?.[1];
    if (title !== undefined) out.push(title.replace(/\s+#+\s*$/, "").trim());
  }
  return out;
}

/**
 * 审核**一份**资产。
 *
 * @param {AssetDoc} doc 已经过 front-matter 解析的资产（解析失败走 parseAssetDocument 的错误分支）
 * @param {SpanIndex} index 出处索引（由宿主构建）
 * @returns {Violation[]}
 */
export function judgeAsset(doc: AssetDoc, index: SpanIndex): Violation[] {
  const front = doc.frontMatter;
  const path = doc.path;
  const violations: Violation[] = [];

  // ── 版本纪律（ADR-0008）────────────────────────────────────────────────
  if (front.schema_version !== SCHEMA_VERSION) {
    violations.push({
      code: ASSET_CODES.VERSION,
      path,
      message:
        `schema_version = ${String(front.schema_version)}，当前分类法版本是 ${SCHEMA_VERSION}。` +
        `版本号就是资产格式：不匹配说明这份资产写在分类法改变之前。`,
      fix: `跑迁移通道把它迁到 v${SCHEMA_VERSION}（forge migrate / packages/schema 的迁移表），不要在闸门里顺手兼容`,
    });
  }

  // ── ID 与类型必须一致（ADR-0007）──────────────────────────────────────
  const idType = typeOfId(front.id);
  if (idType === null) {
    violations.push({
      code: ASSET_CODES.ID_PREFIX,
      path,
      message: `id「${front.id}」不是合法的资产 ID（形如 ${prefixOf(front.type)}<26 位 Crockford base32>）。`,
      fix: "ID 由 forge 铸造，不要手写；前缀表在 schema/ids.md",
    });
  } else if (idType !== front.type) {
    violations.push({
      code: ASSET_CODES.ID_PREFIX,
      path,
      message: `id 前缀说这是 ${idType}，type 字段说是 ${front.type}——类型信息在两处不一致，比只放一处更难查。`,
      fix: `把 id 与 type 改成同一个类型（前缀表见 schema/ids.md）`,
    });
  }

  // ── 出处（R4 / ADR-0009）──────────────────────────────────────────────
  if (front.sources.length === 0) {
    violations.push({
      code: ASSET_CODES.NO_SOURCES,
      path,
      message: "这份资产没有 sources：没有出处的一行不许进 assets/，因为它无法被复核，也无法在源头改变时被发现。",
      fix: "补上 span（形如 file://docs/x.md#t:原文片段 或 src://src_<id>#k:键路径）",
    });
  }
  for (const raw of front.sources) {
    const parsed = parseSpan(raw);
    if (!parsed.ok) {
      violations.push({
        code: ASSET_CODES.SPAN_UNRESOLVED,
        path,
        message: `出处「${raw}」不是合法 span：${parsed.reason}`,
        fix: "改成 scheme://target[#anchor]；语法见 schema/provenance.md",
      });
      continue;
    }
    violations.push(...judgeSpan(path, parsed.span, index));
  }

  // ── 类型要求的字段与章节（ADR-0006）───────────────────────────────────
  for (const field of REQUIRED_FIELDS[front.type]) {
    if (!hasContent(front, field)) {
      violations.push({
        code: ASSET_CODES.REQUIRED_FIELD,
        path,
        message: `${front.type} 型资产必须有 ${field}——这条要求在分类法里，不在文档里（原则只有被 schema 强制时才算数）。`,
        fix: `补上 ${field}`,
      });
    }
  }

  const present = new Set(sectionsOf(doc.body));
  for (const section of REQUIRED_SECTIONS[front.type]) {
    if (!present.has(section)) {
      violations.push({
        code: ASSET_CODES.REQUIRED_SECTION,
        path,
        message: `${front.type} 型资产缺少「## ${section}」章节。`,
        fix: `补上该章节；模板见 schema/asset-types/${front.type}.md`,
      });
    }
  }

  return sortViolations(violations);
}

/**
 * `forge confirm` 的自证：**这次写入只许动 `last_confirmed`**（ADR-0036）。
 *
 * 为什么需要它：ADR-0028 说过"改写已有状态只有一条通路"（冲突的 resolve）。
 * `confirm` 是第二个会写已有资产的地方，所以它必须被限制到**只改一个字段**——
 * 而且这条限制不能靠"写的时候小心点"，要靠一个**能被重新问一遍**的函数。
 * 与 `modelLeaks` / `retrievalViolations` 同一条思路：关键性质写成函数，
 * 它才会在每次改动之后被重新问一遍（R8）。
 *
 * 返回非空 = 这次写入会动到别的东西，调用方**必须拒绝落盘**。
 *
 * @param {AssetFrontMatter} before
 * @param {AssetFrontMatter} after
 * @returns {string[]} 被意外改动的字段名（空数组表示性质成立）
 */
export function unchangedExceptLastConfirmed(before: AssetFrontMatter, after: AssetFrontMatter): string[] {
  const drifted: string[] = [];
  for (const key of Object.keys(before) as Array<keyof AssetFrontMatter>) {
    if (key === "last_confirmed") continue;
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) drifted.push(key);
  }
  return drifted.sort();
}

/**
 * 出处**新鲜度**检查 —— 刻意**不**进闸门。
 *
 * 理由：闸门的判据必须只依赖输入，而新鲜度依赖"今天"。把时钟塞进闸门，
 * 会让一份没动过的资产在某天早上突然变红，而红的原因是"时间过去了"——
 * 那是维护任务（Phase 7 / S26）的职责，不是提交闸门的职责。
 *
 * 所以这里单独暴露，`forge lint` 用它生成健康报告，闸门不用。
 *
 * @param {AssetDoc} doc
 * @param {string} today `YYYY-MM-DD`
 * @returns {Violation[]}
 */
export function checkFreshness(doc: AssetDoc, today: string): Violation[] {
  const window = confirmWithinDays(doc.frontMatter.type);
  if (window === null) return [];

  const last = doc.frontMatter.last_confirmed;
  if (last === null) return [];

  const age = daysBetween(last, today);
  if (age === null || age <= window) return [];

  return [
    {
      code: ASSET_CODES.FRESHNESS,
      path: doc.path,
      message: `state 已 ${age} 天没有确认（窗口 ${window} 天）。过期的事实比没有事实更糟——它会被当成现状用。`,
      fix: "确认它是否仍然成立；仍然成立就更新 last_confirmed，不成立就走一次状态替换",
    },
  ];
}

/**
 * 审核一个库（或本仓库里的全部资产）。
 *
 * @param {AssetDoc[]} docs
 * @param {SpanIndex} index
 * @returns {Violation[]}
 */
export function judgeLibrary(docs: AssetDoc[], index: SpanIndex): Violation[] {
  return sortViolations(docs.flatMap((doc) => judgeAsset(doc, index)));
}

/**
 * @param {string} path
 * @param {Span} span
 * @param {SpanIndex} index
 * @returns {Violation[]}
 */
function judgeSpan(path: string, span: Span, index: SpanIndex): Violation[] {
  const fact = index.lookup(formatSpan(span));

  if (fact.kind === "resolved") return [];

  if (fact.kind === "unavailable") {
    return [
      {
        code: ASSET_CODES.SCHEME_UNAVAILABLE,
        path,
        message: `${formatSpan(span)}：本宿主校验不了它——${fact.reason}`,
        fix: "这是「无法校验」，不是「通过」。要么换成本宿主能校验的 scheme，要么在能校验它的宿主里跑（ADR-0009）",
      },
    ];
  }

  return [
    {
      code: ASSET_CODES.SPAN_UNRESOLVED,
      path,
      message: `${formatSpan(span)}：解析不到——${fact.reason}`,
      fix: "改掉被引用的原文，或把 span 指向仍然存在的那一处；失效的引用必须被看见，不许顺手放宽闸门",
    },
  ];
}

/**
 * `REQUIRED_FIELDS` 里的字段名是分类法里的**字符串**，这里做一次收窄。
 * 不认识的名字是代码错误（分类法漂移），由 schema 一致性闸门拦下；
 * 这里静默当作"没有内容"会让漂移变成误报，所以只认已知字段。
 *
 * @param {import("@forge/schema").AssetFrontMatter} front
 * @param {string} field
 * @returns {boolean}
 */
function hasContent(front: import("@forge/schema").AssetFrontMatter, field: string): boolean {
  switch (field) {
    case "last_confirmed":
      return front.last_confirmed !== null && front.last_confirmed.length > 0;
    case "origin_incident":
      // rule 的溯源是**结构性**要求（ADR-0006）：null 不算填了。
      return front.origin_incident !== null && front.origin_incident.length > 0;
    case "subject":
      // state 的题面是**结构性**要求（ADR-0025）：它缺了，这条状态就不参与冲突判定——
      // 而"我确认过的状态被推翻了却没人知道"是这个产品最不能出的静默故障。
      return front.subject !== null && front.subject.length > 0;
    case "supersedes":
      return front.supersedes !== null;
    case "sources":
      return front.sources.length > 0;
    default:
      return false;
  }
}

/**
 * @param {string} from `YYYY-MM-DD`
 * @param {string} to `YYYY-MM-DD`
 * @returns {number | null} 天数；任一不是合法日期时返回 null
 */
function daysBetween(from: string, to: string): number | null {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.floor((b - a) / 86_400_000);
}

/** 供宿主复用的类型别名。 */
export type { AssetDoc, AssetFrontMatter, AssetType };
