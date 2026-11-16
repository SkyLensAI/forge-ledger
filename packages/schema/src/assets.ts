/**
 * 资产 IR —— front-matter + 正文（directory.md §三：第二套 IR）。
 *
 * 两件事在这里被定死，它们是 R6 的执行体：
 *
 * 1. **解析宽容，渲染严格**。解析要容忍人写的东西（日期加不加引号、
 *    缺 `schema_version` 的 v0 资产），因为拒收一份手写资产只会让人绕过形式。
 *    渲染必须逐字节确定：键序写死、引号规则写死、换行只有 `\n`。
 *    用 `yaml.stringify` 渲染是不行的——它的输出取决于对象的**插入顺序**，
 *    而插入顺序来自代码路径，不是契约。
 * 2. **缺 `schema_version` 解析成 0，而不是拒绝**（ADR-0008）。
 *    这样"未迁移的旧资产"是可判定的红（`SCHEMA_VERSION_MISMATCH`，附修法：
 *    跑迁移通道），而不是一个笼统的"front-matter 不合法"。
 *    改一个字段名就说"格式坏了"，等于把修法也一起丢掉。
 */
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { ASSET_TYPES, SCHEMA_VERSION, SENSITIVITIES, STATUSES, ID_PREFIXES } from "./fields.ts";
import { isAssetId } from "./ids.ts";
import { validate, type ValidationResult } from "./validate.ts";

/** ID 形状：`<类型前缀>_<26 位 base32>`。前缀从分类法来，不在这里重复写一遍。 */
const ID_PATTERN = new RegExp(`^(${Object.values(ID_PREFIXES).join("|")})[0-9A-Za-z]{26}$`);

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const AssetFrontMatterSchema = z.object({
  /**
   * 缺版本号 = v0（ADR-0008）。语义上它**就是**分类法版本，只有一个版本号——
   * 两个版本号会立刻产生"哪个才是权威"的问题。
   */
  schema_version: z.number().int().min(0),
  id: z.string().regex(ID_PATTERN, "id 形如 dec_<26 位 base32>（前缀表见 schema/ids.md）"),
  type: z.enum(ASSET_TYPES),
  status: z.enum(STATUSES as unknown as [string, ...string[]]),
  created: z.string().regex(DATE_PATTERN, "created 是 YYYY-MM-DD"),
  last_confirmed: z.string().regex(DATE_PATTERN, "last_confirmed 是 YYYY-MM-DD").nullable(),
  supersedes: z.string().nullable(),
  /** `rule` 型必填（分类法的 `requires_fields`），但形状上允许 null——见 ADR-0009 的码分离。 */
  origin_incident: z.string().nullable(),
  /**
   * 题面：这条资产讲的是**哪一件事**（ADR-0025）。`state` 型必填。
   *
   * 形状上允许 null，理由与 `origin_incident` 相同：必填是**审核**的事
   * （`REQUIRED_FIELD_MISSING`，附的修法是"补上题面"），不是解析的事。
   * 在解析层拒收会让它变成一句笼统的"格式不对"，而修法就此丢失。
   *
   * 它是**索引**，不是证据：出处必须能解析回原文（否则整条资产不许入库），
   * 而题面只由代码做归一化（NFKC / 空白 / 大小写 / 包裹标点）。
   */
  subject: z.string().nullable(),
  /**
   * 出处 span 列表。**允许为空**：空列表由审核报 `PROV_NO_SOURCES`，
   * 而不是在解析层拒收。两个码的修法不同（补证据 vs. 修 span），
   * 合并成一个码等于把修法也合并掉（ADR-0009）。
   */
  sources: z.array(z.string()),
  sensitivity: z.enum(SENSITIVITIES as unknown as [string, ...string[]]),
  /** 0..1。模型产物一律从低置信度起步（implement1.md §3.1），那是入库守卫的事，不是形状的事。 */
  confidence: z.number().min(0).max(1),
});

export type AssetFrontMatter = z.infer<typeof AssetFrontMatterSchema>;

export interface AssetDoc {
  /** 相对宿主根的路径，`/` 分隔。 */
  path: string;
  frontMatter: AssetFrontMatter;
  body: string;
  /** 原样的全文。emit 直接用它，避免"重新渲染一遍"引入第二处差异。 */
  raw: string;
}

export type ParseAssetResult = { ok: true; doc: AssetDoc } | { ok: false; reason: string };

const FRONT_MATTER_OPEN = "---";

/**
 * @param {string} path
 * @param {string} text
 * @returns {ParseAssetResult}
 */
export function parseAssetDocument(path: string, text: string): ParseAssetResult {
  const normalized = text.replace(/\r\n?/g, "\n");
  const split = splitFrontMatter(normalized);
  if (split === null) {
    return { ok: false, reason: "找不到 front-matter：文件必须以 `---` 开头，并以单独一行的 `---` 结束" };
  }

  let raw: unknown;
  try {
    raw = parseYaml(split.frontMatter);
  } catch (error) {
    return { ok: false, reason: `front-matter 不是合法 YAML：${error instanceof Error ? error.message : String(error)}` };
  }

  const canonical = canonicalize(raw);
  const validated = validate(AssetFrontMatterSchema, canonical);
  if (!validated.ok) {
    return { ok: false, reason: validated.issues.map((i) => `${i.path.map(String).join(".") || "(根)"}：${i.message}`).join("；") };
  }

  const frontMatter = validated.value;
  // ID 前缀与 type 的一致性**不在这里**判：那是审核的 `ID_PREFIX_MISMATCH`，
  // 附的修法是具体的。在解析层拒收会让它变成一句笼统的"格式不对"。
  return { ok: true, doc: { path, frontMatter, body: split.body, raw: normalized } };
}

/**
 * 渲染成资产文件。**键序、引号、换行全部写死**（R6）。
 *
 * @param {AssetFrontMatter} frontMatter
 * @param {string} body
 * @returns {string}
 */
export function renderAssetDocument(frontMatter: AssetFrontMatter, body: string): string {
  const lines: string[] = [FRONT_MATTER_OPEN];
  lines.push(`schema_version: ${String(frontMatter.schema_version)}`);
  lines.push(`id: ${frontMatter.id}`);
  lines.push(`type: ${frontMatter.type}`);
  lines.push(`status: ${frontMatter.status}`);
  lines.push(`created: ${quote(frontMatter.created)}`);
  lines.push(`last_confirmed: ${frontMatter.last_confirmed === null ? "null" : quote(frontMatter.last_confirmed)}`);
  lines.push(`supersedes: ${frontMatter.supersedes === null ? "null" : frontMatter.supersedes}`);
  lines.push(`origin_incident: ${frontMatter.origin_incident === null ? "null" : quote(frontMatter.origin_incident)}`);
  // 题面紧挨着 sources：一个是"讲的是哪件事"，一个是"凭什么"，而两者都指向内容。
  lines.push(`subject: ${frontMatter.subject === null ? "null" : quote(frontMatter.subject)}`);
  if (frontMatter.sources.length === 0) {
    lines.push("sources: []");
  } else {
    lines.push("sources:");
    for (const source of frontMatter.sources) lines.push(`  - ${quote(source)}`);
  }
  lines.push(`sensitivity: ${frontMatter.sensitivity}`);
  lines.push(`confidence: ${formatNumber(frontMatter.confidence)}`);
  lines.push(FRONT_MATTER_OPEN);

  const bodyText = body.replace(/\r\n?/g, "\n").replace(/\n*$/, "\n");
  return `${lines.join("\n")}\n\n${bodyText}`;
}

/**
 * 当前版本下新建资产时的空模板，供 Phase 4 的候选区与人工新增使用。
 *
 * @param {import("./fields.ts").AssetType} type
 * @param {string} id
 * @param {string} created `YYYY-MM-DD`
 * @returns {AssetFrontMatter}
 */
export function newFrontMatter(
  type: import("./fields.ts").AssetType,
  id: string,
  created: string,
): AssetFrontMatter {
  return {
    schema_version: SCHEMA_VERSION,
    id,
    type,
    status: type === "decision" ? "proposed" : type === "event" ? "recorded" : "active",
    created,
    last_confirmed: null,
    supersedes: null,
    origin_incident: null,
    // 题面**没有默认值**：它是这条资产讲的是哪件事，只有提出它的人知道。
    // `state` 缺它会被审核报 REQUIRED_FIELD_MISSING——那是行动指令，不是可以糊过去的东西。
    subject: null,
    sources: [],
    sensitivity: "internal",
    // 低置信度起步：写下的那一刻还没有任何证据支持它（implement1.md §3.1）。
    confidence: 0.3,
  };
}

/**
 * @param {string} text
 * @returns {{frontMatter: string, body: string} | null}
 */
function splitFrontMatter(text: string): { frontMatter: string; body: string } | null {
  // 必须是文件开头的 `---`：**"看起来像 front-matter"不算**。
  // 让任何人能在文档中间随手加一段 `---` 就被当成资产，等于把资产集合的定义交给排版。
  if (!text.startsWith(`${FRONT_MATTER_OPEN}\n`)) return null;
  const rest = text.slice(FRONT_MATTER_OPEN.length + 1);
  const closeMatch = /\n---[ \t]*(\n|$)/.exec(rest);
  if (closeMatch === null) return null;
  const frontMatter = rest.slice(0, closeMatch.index);
  const body = rest.slice(closeMatch.index + closeMatch[0].length);
  return { frontMatter, body };
}

/**
 * 把"人可能写的各种形式"折成规范形状。**只做形状归一，不做语义判断。**
 *
 * @param {unknown} raw
 * @returns {unknown}
 */
function canonicalize(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const record = { ...(raw as Record<string, unknown>) };

  // 缺版本号 = v0（ADR-0008）。这一条让"未迁移"可判定，而不是让它们静默通过。
  if (record["schema_version"] === undefined) record["schema_version"] = 0;

  for (const key of ["created", "last_confirmed"]) {
    record[key] = coerceDate(record[key]);
  }
  // 空字符串也是"没写"：手写 front-matter 时留一个空值比删掉它更常见，
  // 而 `subject:`（空）与缺字段必须是同一件事——否则同一个"没题面"
  // 会在审核里分成两种形状，而其中一种躲过检查。
  for (const key of ["supersedes", "origin_incident", "subject"]) {
    if (record[key] === undefined || record[key] === "") record[key] = null;
  }
  if (record["sources"] === undefined || record["sources"] === null) record["sources"] = [];
  if (typeof record["sources"] === "string") record["sources"] = [record["sources"]];

  return record;
}

/**
 * YAML 的 `2026-11-06` 在不同 schema 下可能是字符串，也可能是 Date。
 * 两种都要收，且都要变成**同一个**字符串——否则同一份日期会因为写法不同
 * 而在库里变成两个值。
 *
 * @param {unknown} value
 * @returns {string | null | unknown}
 */
function coerceDate(value: unknown): string | null | unknown {
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "string") return value.trim();
  return value;
}

/**
 * @param {string} value
 * @returns {string}
 */
function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * @param {number} value
 * @returns {string}
 */
function formatNumber(value: number): string {
  // 不用 `toFixed`：它按固定小数位渲染，会把 0.3 变成 0.30，
  // 于是同一份数据在两次渲染之间可能因为调用方传法不同而不同。
  return String(value);
}

/** 供宿主复用：判断一个字符串是不是本分类法下的资产 ID。 */
export { isAssetId };
