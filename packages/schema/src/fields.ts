/**
 * 分类法的**代码侧一半**：常量表。
 *
 * 人读的一半在 `schema/taxonomy.yaml`。两者必须一一对应，由闸门机器校验（ADR-0010）：
 * 改一边忘另一边 = CI 红。为什么不让代码直接读 YAML：那样就没有"一致性"可言了——
 * 一致性是两份独立表述之间的事。**机器能判定的漂移**（前缀、字段名、章节名、
 * 新鲜度归属）在这里定死，YAML 那边必须跟上。
 */
export const SCHEMA_VERSION = 1;

/** 资产类型。切法按**写规则**，不是按业务域（ADR-0006）。 */
export const ASSET_TYPES = ["decision", "state", "event", "rule"] as const;

/**
 * 资产类型。
 *
 * 它是**联合类型而不是枚举**：`enum` 在 Node 的类型擦除下不可用（ADR-0011），
 * 而这条约束的执行体不是禁令，是"CI 里 node 真的会跑它"。
 */
export type AssetType = (typeof ASSET_TYPES)[number];

/** 来源层的 ID 前缀：`src_`。来源不是资产类型——它是只读原料。 */
export const SOURCE_PREFIX = "src_";

export const ID_PREFIXES: Readonly<Record<AssetType, string>> = {
  decision: "dec_",
  state: "state_",
  event: "event_",
  rule: "rule_",
};

/**
 * `assets/` 下的分区目录名（directory.md §八.2：按 ID 前缀分区）。
 * 去掉了下划线：目录名里带 `_` 只会在 `ls` 输出里制造噪音。
 */
export const ASSET_DIRS: Readonly<Record<AssetType, string>> = {
  decision: "dec",
  state: "state",
  event: "event",
  rule: "rule",
};

/** 写规则。写规则相同的东西不该是两种类型（ADR-0006）。 */
export const LIFECYCLE: Readonly<Record<AssetType, "append_only" | "replace_in_place">> = {
  decision: "append_only",
  state: "replace_in_place",
  event: "append_only",
  rule: "replace_in_place",
};

/**
 * front-matter 的字段**全集**。
 * `REQUIRED_FIELDS` 里出现不在这里的名字 = 分类法漂移，由一致性闸门拦下（ADR-0010）。
 */
export const ASSET_FIELDS: readonly string[] = [
  "schema_version",
  "id",
  "type",
  "status",
  "created",
  "last_confirmed",
  "supersedes",
  "origin_incident",
  /**
   * 题面：这条资产讲的是**哪一件事**（ADR-0025）。
   *
   * 为什么它必须是结构而不是"从正文猜"：归并（S18）与冲突（S19）都要判
   * "这两条是不是同一件事"，而正文是给人读的自由文本——身份住在正文里
   * 就等于把身份交给排版，且审核侧看不到它。
   *
   * 它对 `state` 是必填的。判据很直接：**题面缺失 = 这条状态不参与冲突判定**，
   * 而"我确认过的状态不会被后续事件挑战"是这个产品最不能出的静默故障。
   */
  "subject",
  "sources",
  "sensitivity",
  "confidence",
];

/**
 * 类型**额外**要求的字段（所有类型都必填的字段不重复列）。
 *
 * `rule → origin_incident` 是这里最重要的一条：它把"A5 每条规则可追溯到一个
 * 具体出过的问题"从文档搬进结构。**原则只有在被 schema 强制时才算数**（反模式 2）。
 * `state → subject` 是 P5 加的那一条：没有题面，状态就不参与冲突判定（ADR-0025）。
 */
export const REQUIRED_FIELDS: Readonly<Record<AssetType, readonly string[]>> = {
  decision: [],
  state: ["last_confirmed", "subject"],
  event: [],
  rule: ["origin_incident"],
};

/** 类型要求的正文章节（二级标题）。 */
export const REQUIRED_SECTIONS: Readonly<Record<AssetType, readonly string[]>> = {
  decision: ["问题", "考虑过的选项", "选定", "后果"],
  state: ["当前状态"],
  event: [],
  rule: ["规则", "强制"],
};

/**
 * 新鲜度窗口（天）。`null` = 这种类型不会过期。
 *
 * 只挂在 `state` 上，这个限制由一致性闸门校验：`decision` 一旦 accepted 就不可变
 * （"过期"对它没有意义），`event` 是发生过的事（更不会过期），
 * `rule` 靠 `origin_incident` 溯源而不靠时间。
 */
export const FRESHNESS_DAYS: Readonly<Record<AssetType, number | null>> = {
  decision: null,
  state: 30,
  event: null,
  rule: null,
};

export const STATUSES: readonly string[] = [
  "proposed",
  "accepted",
  "superseded",
  "active",
  "retired",
  "recorded",
];

export const SENSITIVITIES: readonly string[] = ["public", "internal", "private"];

/**
 * @param {AssetType} type
 * @returns {string}
 */
export function prefixOf(type: AssetType): string {
  return ID_PREFIXES[type];
}

/**
 * @param {AssetType} type
 * @returns {string}
 */
export function assetDirOf(type: AssetType): string {
  return ASSET_DIRS[type];
}

/**
 * @param {AssetType} type
 * @returns {number | null}
 */
export function confirmWithinDays(type: AssetType): number | null {
  return FRESHNESS_DAYS[type];
}

/**
 * @param {unknown} value
 * @returns {value is AssetType}
 */
export function isAssetType(value: unknown): value is AssetType {
  return typeof value === "string" && (ASSET_TYPES as readonly string[]).includes(value);
}
