/**
 * Emitter v1 —— 纯函数，零 IO（implement1.md §3.2 的第 7 个 agent）。
 *
 * **本模块的全部价值就是"逐字节确定"**（R6 / ADR-0017）。所以这里的每条规矩都不是风格：
 *
 * - 输出里没有时钟。没有生成时间、没有"最近更新"、没有日期。带时间戳的输出
 *   永远无法做快照测试——它每次都不一样，于是快照只能关掉，于是"确定性"就没有执行体。
 * - 排序键显式写死（资产按类型 → ID；事件按 `occurred_at` 降序 → ID）。
 *   不依赖 `Object.keys`、不依赖 `readdir` 顺序——那些是插入顺序，不是契约。
 * - 换行只有 `\n`，文件以一个换行结尾。CRLF 由 `.gitattributes` 在 git 侧兜底，
 *   但 emit 不把正确性外包给 git 配置。
 * - 截断长度是常量，而且**截断必须说出来**：静默截断会让"最近 20 条"读成"一共 20 条"，
 *   那是在输出里撒谎，比不确定更糟。
 *
 * 投影与资产的区别（ADR-0012）：**投影可以被重新生成，资产不行**。
 * 所以 `AGENTS.md` / `INDEX.md` 不带 front-matter——它们不是资产，
 * 也不该被自己的出处闸门当成资产来审。带 front-matter 的反例见 `adr/`。
 */
import { ASSET_TYPES, type AssetDoc, type AssetType, type EventIR } from "@forge/schema";
import { eventTitleOf, sortAssets } from "./compile.ts";

/** 事件时间线在 `AGENTS.md` 里的条数上限。常量而非配置：它影响输出字节。 */
export const TIMELINE_LIMIT = 20;

export interface EmittedFile {
  /** 相对于输出目录的路径，一律用 `/`。 */
  path: string;
  content: string;
}

/**
 * 投影的输入 = 资产 + 事件。
 *
 * 为什么两个都要：资产是"编译过的知识"（人写或模型抽取），事件是"可重算的原料"（ADR-0016）。
 * 它们住在不同的层（`assets/` 与 `index/`），但都是投影的正当输入——
 * 一个 agent 需要的既有规则，也有"最近发生了什么"。
 * 输入仍然**全是数据**，所以 emit 依旧是纯函数。
 */
export interface EmitInput {
  assets: AssetDoc[];
  events: EventIR[];
}

export interface EmitOptions {
  /** 投影的标题。默认值是常量，**不是**从库里某个字段推出来的——推出来的东西会随库变。 */
  title?: string;
}

/**
 * 一次 emit 的全部产物：`AGENTS.md` + `INDEX.md` + `adr/`。
 *
 * @param {EmitInput} input
 * @param {EmitOptions} [options]
 * @returns {EmittedFile[]}
 */
export function emitLibrary(input: EmitInput, options: EmitOptions = {}): EmittedFile[] {
  const assets = sortAssets(input.assets);
  const files: EmittedFile[] = [
    { path: "AGENTS.md", content: emitAgentsMd({ assets, events: input.events }, options) },
    { path: "INDEX.md", content: emitIndex({ assets, events: input.events }, options) },
  ];
  for (const adr of emitAdrFiles(assets)) files.push(adr);
  return files;
}

/**
 * @param {EmitInput} input
 * @param {EmitOptions} [options]
 * @returns {string}
 */
export function emitAgentsMd(input: EmitInput, options: EmitOptions = {}): string {
  const title = options.title ?? "资产库";
  const docs = sortAssets(input.assets);
  const counts = countByType(docs);
  const lines: string[] = [];

  lines.push(`# ${title}`);
  lines.push("");
  lines.push("> 本文件由 `forge emit` 生成——改动会在下次 emit 时被覆盖。");
  lines.push(`> 资产：${describeCounts(counts)}。`);
  lines.push("");

  lines.push("## 规则");
  lines.push("");
  const rules = docs.filter((doc) => doc.frontMatter.type === "rule");
  if (rules.length === 0) {
    lines.push("（暂无 rule 型资产。规则要从真实踩过的坑长出来——棘轮。）");
    lines.push("");
  }
  for (const rule of rules) lines.push(...ruleBlock(rule));

  lines.push("## 决策");
  lines.push("");
  const decisions = docs.filter((doc) => doc.frontMatter.type === "decision");
  if (decisions.length === 0) lines.push("（暂无）");
  for (const decision of decisions) {
    lines.push(
      `- \`${decision.frontMatter.id}\` **${titleOf(decision)}** —— ${decision.frontMatter.status}，${decision.frontMatter.created}`,
    );
  }
  lines.push("");

  lines.push("## 状态");
  lines.push("");
  const states = docs.filter((doc) => doc.frontMatter.type === "state");
  if (states.length === 0) lines.push("（暂无）");
  for (const state of states) {
    lines.push(
      `- \`${state.frontMatter.id}\` **${titleOf(state)}** —— 最后确认 ${state.frontMatter.last_confirmed ?? "未确认"}`,
    );
  }
  lines.push("");

  lines.push("## 近期事件");
  lines.push("");
  const recent = [...input.events].sort(compareEventsDesc);
  if (recent.length === 0) lines.push("（暂无事件。事件来自官方数据导出，住在索引层——ADR-0016。）");
  for (const event of recent.slice(0, TIMELINE_LIMIT)) {
    lines.push(`- ${event.occurred_at.slice(0, 10)} · ${eventTitleOf(event)}`);
  }
  if (recent.length > TIMELINE_LIMIT) {
    // 截断必须说出来。"最近 20 条"与"一共 20 条"是两句不同的话。
    lines.push("");
    lines.push(`> 以上为最近 ${TIMELINE_LIMIT} 条；库中共 ${recent.length} 条事件。`);
  }
  lines.push("");

  return lines.join("\n");
}

/**
 * 资产库 → `INDEX.md`（directory.md §八.3：每次操作都以更新索引收尾）。
 *
 * @param {EmitInput} input
 * @param {EmitOptions} [options]
 * @returns {string}
 */
export function emitIndex(input: EmitInput, options: EmitOptions = {}): string {
  const title = options.title ?? "资产库";
  const docs = sortAssets(input.assets);
  const counts = countByType(docs);
  const lines: string[] = [];

  lines.push(`# ${title} · 索引`);
  lines.push("");
  lines.push("> 派生数据：删掉能重建，成本只是重算时间（directory.md 原则 2）。");
  lines.push("");

  lines.push("| 类型 | 条数 |");
  lines.push("|---|---|");
  for (const type of ASSET_TYPES) lines.push(`| ${type} | ${counts[type]} |`);
  lines.push(`| **资产合计** | **${docs.length}** |`);
  lines.push(`| 事件（索引层，非资产） | ${input.events.length} |`);
  lines.push("");

  for (const type of ASSET_TYPES) {
    const group = docs.filter((doc) => doc.frontMatter.type === type);
    if (group.length === 0) continue;
    lines.push(`## ${type}`);
    lines.push("");
    for (const doc of group) lines.push(`- \`${doc.frontMatter.id}\` ${titleOf(doc)}`);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * decision 资产 → `adr/NNNN-<slug>.md`。
 *
 * 编号来自"按 (created, id) 排序后的位次"，不是从 ULID 里解出来的时间：
 * 位次**可复现**（同样的库必然得到同样的编号），而时间戳解码出来的数字
 * 在插入一条更早的决策时会跳号，人读起来像是丢了东西。
 *
 * @param {AssetDoc[]} docs
 * @returns {EmittedFile[]}
 */
export function emitAdrFiles(docs: AssetDoc[]): EmittedFile[] {
  const decisions = docs
    .filter((doc) => doc.frontMatter.type === "decision")
    .sort((a, b) => {
      if (a.frontMatter.created !== b.frontMatter.created) {
        return a.frontMatter.created < b.frontMatter.created ? -1 : 1;
      }
      return a.frontMatter.id < b.frontMatter.id ? -1 : 1;
    });

  return decisions.map((doc, index) => ({
    path: `adr/${String(index + 1).padStart(4, "0")}-${slugify(titleOf(doc))}.md`,
    // 资产原样重渲染：ADR 是**资产**，所以它带 front-matter（ADR-0012）。
    content: doc.raw,
  }));
}

/**
 * @param {AssetDoc} rule
 * @returns {string[]}
 */
function ruleBlock(rule: AssetDoc): string[] {
  const lines: string[] = [];
  lines.push(`### ${rule.frontMatter.id} · ${titleOf(rule)}`);
  lines.push("");
  const enforcement = sectionBody(rule.body, "强制");
  lines.push(
    `- **强制**：${enforcement.length > 0 ? enforcement : "（没写强制手段——没有执行体的规则等于礼貌建议）"}`,
  );
  lines.push("- **出处**：");
  for (const source of rule.frontMatter.sources) lines.push(`  - \`${source}\``);
  lines.push("");
  return lines;
}

/** 资产标题：正文第一个一级标题；没有就用 ID。 */
export function titleOf(doc: AssetDoc): string {
  for (const line of doc.body.replace(/\r\n?/g, "\n").split("\n")) {
    const match = /^\s{0,3}#\s+(.*)$/.exec(line);
    const title = match?.[1];
    if (title !== undefined) return title.replace(/\s+#+\s*$/, "").trim();
  }
  return doc.frontMatter.id;
}

/**
 * 取某个二级标题下的正文（到下一个二级标题为止），压平成一行。
 *
 * @param {string} body
 * @param {string} heading
 * @returns {string}
 */
export function sectionBody(body: string, heading: string): string {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const collected: string[] = [];
  let inside = false;
  for (const line of lines) {
    const match = /^\s{0,3}##\s+(.*)$/.exec(line);
    if (match !== null) {
      inside = match[1]?.replace(/\s+#+\s*$/, "").trim() === heading;
      continue;
    }
    if (inside && line.trim().length > 0) collected.push(line.trim());
  }
  return collected.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * @param {AssetDoc[]} docs
 * @returns {Record<AssetType, number>}
 */
function countByType(docs: AssetDoc[]): Record<AssetType, number> {
  const counts = { decision: 0, state: 0, event: 0, rule: 0 } as Record<AssetType, number>;
  for (const doc of docs) counts[doc.frontMatter.type] += 1;
  return counts;
}

/**
 * @param {Record<AssetType, number>} counts
 * @returns {string}
 */
function describeCounts(counts: Record<AssetType, number>): string {
  const total = ASSET_TYPES.reduce((sum, type) => sum + counts[type], 0);
  const parts = ASSET_TYPES.filter((type) => counts[type] > 0).map((type) => `${type} ${counts[type]}`);
  return parts.length === 0 ? "空库" : `${total} 条（${parts.join(" · ")}）`;
}

/**
 * 事件按时间降序；同一天按 ID。两个键都是显式的（ADR-0017）。
 *
 * @param {EventIR} a
 * @param {EventIR} b
 * @returns {number}
 */
function compareEventsDesc(a: EventIR, b: EventIR): number {
  if (a.occurred_at !== b.occurred_at) return a.occurred_at > b.occurred_at ? -1 : 1;
  if (a.key !== b.key) return a.key > b.key ? -1 : 1;
  return a.source_id > b.source_id ? -1 : 1;
}

/**
 * 文件名 slug：保留字母数字与汉字，其余折成 `-`。
 * 折法必须**只依赖输入**——`toLowerCase()` 在土耳其语环境下会把 `I` 变成 `ı`，
 * 所以这里做 ASCII 小写，而不是依赖 locale（ADR-0017）。
 *
 * @param {string} title
 * @returns {string}
 */
export function slugify(title: string): string {
  const lowered = title.replace(/[A-Z]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 32));
  const folded = lowered.replace(/[^\p{Letter}\p{Number}]+/gu, "-").replace(/^-+|-+$/g, "");
  return folded.length > 0 ? folded.slice(0, 60) : "untitled";
}
