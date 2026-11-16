/**
 * Emitter v2 —— 多出口：**Skill 导出**与**Eval 导出**（S24）。
 *
 * v1（`emit.ts`）回答的是"怎么把库投影成一份 `AGENTS.md`"。
 * v2 回答的是另一个问题：**同一批资产，喂给不同的消费者要长什么样。**
 *
 * | 出口 | 消费者 | 形状 |
 * |---|---|---|
 * | `AGENTS.md` / `INDEX.md` / `adr/` | 人 + 任意 agent（v1） | 一份读得完的投影 |
 * | Skill | Claude 的 skill 加载器 | `SKILL.md` + 按需读的 `references/` |
 * | Eval 用例集 | 尺子（`evals/runner`） | 从真实事件反着造出来的用例 |
 *
 * 三条纪律，三条都来自已经付过代价的地方：
 *
 * 1. **出口是投影，不是第二个真相。** 每个出口都能从 `assets/` 重算，
 *    谁都不是"作者"。所以它们住在 `index/` 那一侧的分类里（ADR-0015），
 *    而不进 `assets/`——不然下一轮 `forge lint` 会把投影当成资产来审。
 * 2. **逐字节确定**（R6 / ADR-0017）。理由与 v1 一样，做法也一样：
 *    没有时钟、排序键显式写死、换行只有 `\n`、截断必须说出来。
 * 3. **导出的 eval 不许自称"已确认"**（ADR-0020）。它的 `review.status` 永远是
 *    `proposed`，因为**确认是人做的事**：一份自称已确认的导出，就是让机器
 *    给自己出了一套卷子还自己签了字。落进 golden 目录时闸门会因此报 `E2`——那是对的。
 *
 * Skill 出口为什么要把细节拆进 `references/`：implement2.md §3.3 的第一条运行时决策
 * 是"检索优先，绝不预加载"。一个把整库塞进 `SKILL.md` 的 skill 正好违反它——
 * `SKILL.md` 只放**每次都要知道的**（规则与状态），决策的全文按需读。
 */
import type { AssetDoc, AssetType, EventIR } from "@forge/schema";
import { eventTitleOf, sortAssets } from "./compile.ts";
import { sectionBody, slugify, titleOf } from "./emit.ts";
import { stableJson } from "./json.ts";
import { formatSpan, parseSpan } from "./provenance.ts";
import type { EmittedFile } from "./emit.ts";

/** Skill 的名字上限来自 Claude Skills 的规范（小写、连字符）；描述上限 1024 字符。 */
export const SKILL_NAME_MAX = 64;
export const SKILL_DESCRIPTION_MAX = 1024;

/**
 * `SKILL.md` 里每条状态的 `last_confirmed` 之后附带的提醒阈值。
 * 与 `@forge/schema` 的 `FRESHNESS_DAYS` 不同：那是**判定**（过期就不该进上下文），
 * 这是**投影里的一句提醒**，投影没有"今天"，所以它只能比日期本身，不能算天数。
 */
export interface SkillOptions {
  /** Skill 名。默认 `forge-library`。 */
  name?: string;
  /** 一句话描述（会被模型用来决定"要不要加载这个 skill"）。 */
  description?: string;
  /** 投影标题。默认 `资产库`。 */
  title?: string;
}

/**
 * 库 → 一个 Skill 目录：`SKILL.md` + `references/NNNN-<slug>.md`。
 *
 * @param {{assets: AssetDoc[], events: EventIR[]}} input
 * @param {SkillOptions} [options]
 * @returns {EmittedFile[]}
 */
export function emitSkill(
  input: { assets: AssetDoc[]; events: EventIR[] },
  options: SkillOptions = {},
): EmittedFile[] {
  const docs = sortAssets(input.assets);
  const name = options.name ?? "forge-library";
  const title = options.title ?? "资产库";
  const description = options.description ?? defaultDescription(title, docs);

  const files: EmittedFile[] = [{ path: "SKILL.md", content: renderSkillMd(name, description, title, docs, input.events) }];
  for (const reference of skillReferences(docs)) files.push(reference);
  return files;
}

/**
 * 默认描述。**它必须能回答"什么时候该加载这个 skill"**——
 * 描述是模型唯一先看到的东西，而一句"这是一个知识库"等于没说。
 *
 * @param {string} title
 * @param {AssetDoc[]} docs
 * @returns {string}
 */
function defaultDescription(title: string, docs: AssetDoc[]): string {
  const counts = countByType(docs);
  const parts = [
    counts.rule > 0 ? `规则 ${String(counts.rule)} 条` : "",
    counts.decision > 0 ? `决策 ${String(counts.decision)} 条` : "",
    counts.state > 0 ? `状态 ${String(counts.state)} 条` : "",
  ].filter((piece) => piece.length > 0);
  const summary = parts.length === 0 ? "空库" : parts.join("、");
  const head = `${title}（${summary}）`;
  return clampText(
    `${head}。动手改这个项目之前先读它：这里有已经定下来的决策、不能违反的规则、以及当前的状态。` +
      `每条都带可解析的出处。`,
    SKILL_DESCRIPTION_MAX,
  );
}

/**
 * Skill 的入口文件。
 *
 * 结构刻意是"规则 → 状态 → 决策索引 → 按需读的 references"：
 * 前两节是**每次都要知道的**，第三节是**知道有这回事**，
 * 而决策的全文在 `references/` 里——它们只在真的相关时才该进上下文。
 *
 * @param {string} name
 * @param {string} description
 * @param {string} title
 * @param {AssetDoc[]} docs
 * @param {EventIR[]} events
 * @returns {string}
 */
function renderSkillMd(name: string, description: string, title: string, docs: AssetDoc[], events: EventIR[]): string {
  const lines: string[] = [];
  // front-matter 的键序写死（R6）：`name` 在前、`description` 在后，与规范一致。
  lines.push("---");
  lines.push(`name: ${name}`);
  lines.push(`description: ${yamlString(description)}`);
  lines.push("---");
  lines.push("");
  lines.push(`# ${title}`);
  lines.push("");
  lines.push("> 本文件由 `forge emit --skill` 生成——改动会在下次 emit 时被覆盖。");
  lines.push("> 每条资产都带可解析的出处；细节在 `references/` 里，**按需读，不要一次全读进来**。");
  lines.push("");

  lines.push("## 规则（不许违反）");
  lines.push("");
  const rules = docs.filter((doc) => doc.frontMatter.type === "rule");
  if (rules.length === 0) {
    lines.push("（暂无 rule 型资产。规则要从真实踩过的坑长出来——棘轮。）");
  }
  for (const rule of rules) {
    lines.push(`### ${titleOf(rule)}`);
    lines.push("");
    const enforcement = sectionText(rule.body, "强制");
    lines.push(`- 强制：${enforcement.length > 0 ? enforcement : "（没写强制手段——没有执行体的规则等于礼貌建议）"}`);
    lines.push(`- 出处：${rule.frontMatter.sources.map((source) => `\`${source}\``).join(" · ")}`);
    lines.push("");
  }

  lines.push("## 当前状态");
  lines.push("");
  const states = docs.filter((doc) => doc.frontMatter.type === "state");
  if (states.length === 0) lines.push("（暂无）");
  for (const state of states) {
    const subject = state.frontMatter.subject;
    lines.push(
      `- **${subject ?? titleOf(state)}**：${sectionText(state.body, "当前状态") || "（正文里没有「当前状态」章节）"}` +
        `（最后确认 ${state.frontMatter.last_confirmed ?? "未确认"}）`,
    );
  }
  lines.push("");

  lines.push("## 决策索引");
  lines.push("");
  const decisions = docs.filter((doc) => doc.frontMatter.type === "decision");
  if (decisions.length === 0) lines.push("（暂无）");
  decisions.forEach((decision, index) => {
    lines.push(
      `- [${referenceName(index + 1, decision)}](references/${referenceName(index + 1, decision)})` +
        ` —— ${titleOf(decision)}（${decision.frontMatter.status}，${decision.frontMatter.created}）`,
    );
  });
  lines.push("");

  const recent = [...events].sort(compareEventsDesc).slice(0, 10);
  if (recent.length > 0) {
    lines.push("## 近期事件（背景，不是约束）");
    lines.push("");
    for (const event of recent) lines.push(`- ${event.occurred_at.slice(0, 10)} · ${eventTitleOf(event)}`);
    if (events.length > recent.length) {
      // 截断必须说出来。"最近 10 条"与"一共 10 条"是两句不同的话。
      lines.push("");
      lines.push(`> 以上为最近 ${String(recent.length)} 条；库中共 ${String(events.length)} 条事件。`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * 决策的全文：一条一个文件，按 `(created, id)` 排序编号。
 *
 * 编号的算法与 `emitAdrFiles` **同一套**（位次，不是从 ULID 里解时间）：
 * 于是 `references/0003-…` 与 `adr/0003-…` 指的是同一条决策——
 * 两个出口给出两个编号会让"0003 是哪条"变成一个问题。
 *
 * @param {AssetDoc[]} docs
 * @returns {EmittedFile[]}
 */
export function skillReferences(docs: AssetDoc[]): EmittedFile[] {
  const decisions = docs
    .filter((doc) => doc.frontMatter.type === "decision")
    .sort((a, b) => {
      if (a.frontMatter.created !== b.frontMatter.created) return a.frontMatter.created < b.frontMatter.created ? -1 : 1;
      return a.frontMatter.id < b.frontMatter.id ? -1 : 1;
    });

  return decisions.map((doc, index) => {
    const lines: string[] = [];
    lines.push(`# ${titleOf(doc)}`);
    lines.push("");
    lines.push(
      `> 决策 \`${doc.frontMatter.id}\` · ${doc.frontMatter.status} · ${doc.frontMatter.created}` +
        `${doc.frontMatter.last_confirmed === null ? "" : ` · 最后确认 ${doc.frontMatter.last_confirmed}`}`,
    );
    lines.push(">");
    lines.push("> 出处：");
    for (const source of doc.frontMatter.sources) lines.push(`> - \`${source}\``);
    lines.push("");
    // 正文原样搬过来，但**不带 front-matter**：front-matter 是资产格式（ADR-0012），
    // 而 reference 的读者是模型，它需要的是内容本身。
    lines.push(doc.body.replace(/^\s+/, "").replace(/\n*$/, "\n"));
    return { path: `references/${referenceName(index + 1, doc)}`, content: lines.join("\n") };
  });
}

/**
 * reference 的文件名：`NNNN-<slug>.md`。
 *
 * @param {number} index 1 基位次
 * @param {AssetDoc} doc
 * @returns {string}
 */
function referenceName(index: number, doc: AssetDoc): string {
  return `${String(index).padStart(4, "0")}-${slugify(titleOf(doc))}.md`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Eval 导出（S24 的第二个出口）
// ─────────────────────────────────────────────────────────────────────────────

/** 导出的用例，形状与 `evals/golden/extraction/cases.json` 的 `cases` 一致。 */
export interface ExportedEvalCase {
  id: string;
  about: string;
  /** 用例的判据：一条**能解析回仓库**的 span。导出时指的是这份事件的来源。 */
  span: string;
  /**
   * 这份事件来自哪个来源。**导出时必须显式写下来**：
   * golden 集的 `source_id` 是由用例 ID 内容寻址**推**出来的（ADR-0013），
   * 而导出的用例 ID 来自来源，两者互相依赖——显式写下来，环就断了。
   */
  source_id: string;
  events: Array<{ key: string; occurred_at: string; actor: string; text: string }>;
  expected: Array<{ type: string; key: string; why: string }>;
  expected_why: string;
}

export interface EvalExport {
  schema_version: number;
  kind: string;
  about: string;
  /**
   * **永远是 `proposed`。**
   *
   * 确认是人做的事（ADR-0020），而这份文件是机器导出的事件 + 人确认过的资产拼出来的。
   * 它够格当"候选用例集"，不够格当"黄金集"——一份自称 confirmed 的导出，
   * 就是让机器给自己出了一套卷子还自己签了字。落进 golden 目录时闸门会报 `E2`。
   */
  review: { status: string; reviewed_by: null; reviewed_at: null; method: string };
  cases: ExportedEvalCase[];
}

/** 导出文件的 schema 版本。它跟着用例形状走，不跟资产的 `SCHEMA_VERSION` 走。 */
export const EVAL_EXPORT_VERSION = 1;

/**
 * 库 → 一份**从真实 trace 反着造的**用例集（implement1.md §3.4）。
 *
 * 一份来源（一次会话导出）= 一个用例：输入是它的事件，期望是**人已经确认过的、
 * 出处指着这些事件的资产**。于是期望值不是标出来的，是**从库里长出来的**——
 * 而"从真实 trace 反向造用例"正是这条线存在的理由 [10][11]。
 *
 * 它诚实地带着一条边界：**没被资产覆盖的事件不构成负面期望**。
 * 一份来源里有一半事件没人确认过，那是"还没抽到"，不是"不该抽出来"。
 * 所以 `expected_why` 会把这件事写在每一条用例里，而不是让读的人自己猜。
 *
 * @param {{assets: AssetDoc[], events: EventIR[]}} input
 * @param {{about?: string}} [options]
 * @returns {EvalExport}
 */
export function emitEvalCases(
  input: { assets: AssetDoc[]; events: EventIR[] },
  options: { about?: string } = {},
): EvalExport {
  const docs = sortAssets(input.assets);
  /** (source_id, key) → 指着它的资产。同一处证据有多条资产时全都要在。 */
  const cited = new Map<string, AssetDoc[]>();

  for (const doc of docs) {
    for (const raw of doc.frontMatter.sources) {
      const parsed = parseSpan(raw);
      if (!parsed.ok) continue;
      // 只有 `src://<来源>#k:<事件 key>` 指得回一条事件；`file://` 指的是文档，
      // 它不构成"这条事件该被抽成什么"的期望。
      if (parsed.span.scheme !== "src" || parsed.span.anchor?.kind !== "k") continue;
      const key = `${parsed.span.target}\n${parsed.span.anchor.payload}`;
      const list = cited.get(key);
      if (list === undefined) cited.set(key, [doc]);
      else list.push(doc);
    }
  }

  /** 来源 → 它的事件。事件按 (source_id, key) 排过序（`deriveEvents` 的键序），这里再排一次不依赖它。 */
  const bySource = new Map<string, EventIR[]>();
  for (const event of input.events) {
    const list = bySource.get(event.source_id);
    if (list === undefined) bySource.set(event.source_id, [event]);
    else list.push(event);
  }

  const cases: ExportedEvalCase[] = [];
  for (const sourceId of [...bySource.keys()].sort()) {
    const events = [...(bySource.get(sourceId) ?? [])].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

    const expected: ExportedEvalCase["expected"] = [];
    for (const event of events) {
      for (const doc of cited.get(`${sourceId}\n${event.key}`) ?? []) {
        expected.push({
          type: doc.frontMatter.type,
          key: event.key,
          why: `由人确认过的 ${doc.frontMatter.id} 的出处指着这条事件（${doc.path}）`,
        });
      }
    }
    expected.sort((a, b) => (a.key === b.key ? (a.type < b.type ? -1 : a.type > b.type ? 1 : 0) : a.key < b.key ? -1 : 1));

    cases.push({
      id: sourceId,
      about: `来源 ${sourceId}：${String(events.length)} 条事件，其中 ${String(new Set(expected.map((item) => item.key)).size)} 条已经有了人确认过的资产`,
      // 判据指的是**这份来源本身**（`src://` 无锚点 = 整份来源）。
      // 导出的时候它一定解析得到：来源就在库里。
      span: formatSpan({ scheme: "src", target: sourceId, anchor: null }),
      source_id: sourceId,
      events: events.map((event) => ({
        key: event.key,
        occurred_at: event.occurred_at,
        actor: event.actor,
        text: event.text,
      })),
      expected,
      expected_why:
        "期望值来自库里**人确认过**的资产（它们的出处指着这些事件）。" +
        "**没被覆盖的事件不构成负面期望**：那是「还没抽到」，不是「不该抽出来」——" +
        "把前者当后者会让分数虚高，而虚高的分数比没有分数更危险。",
    });
  }

  return {
    schema_version: EVAL_EXPORT_VERSION,
    kind: "extraction",
    about:
      options.about ??
      `由 forge emit --evals 从真实事件反着造出来的候选用例集（${String(cases.length)} 个来源）。`,
    review: {
      status: "proposed",
      reviewed_by: null,
      reviewed_at: null,
      method: "机器导出：逐条读 about 与 expected_why，核对 span 指回的原文之后，再由人写 review 块（见 evals/README.md）",
    },
    cases,
  };
}

/**
 * 导出成 `EmittedFile`。路径放在 `evals/` 下而不是 `assets/`：
 * 它是投影，是可重建的（ADR-0015）。
 *
 * @param {EvalExport} exported
 * @returns {EmittedFile}
 */
export function evalExportFile(exported: EvalExport): EmittedFile {
  return { path: "evals/extraction/cases.json", content: stableJson(exported) };
}

// ─────────────────────────────────────────────────────────────────────────────
// 小工具（与 emit.ts 同源的那几个：不重复实现，避免两份会漂移的渲染器）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {AssetDoc[]} docs
 * @returns {Record<AssetType, number>}
 */
function countByType(docs: AssetDoc[]): Record<AssetType, number> {
  const counts: Record<AssetType, number> = { decision: 0, state: 0, event: 0, rule: 0 };
  for (const doc of docs) counts[doc.frontMatter.type] += 1;
  return counts;
}

/**
 * 取某个二级标题下的正文（到下一个二级标题为止），压平成一行。
 *
 * 它**直接借 `emit.ts` 的 `sectionBody`**，不在这里再写一份：
 * 两个出口对"哪一段是「强制」"必须给出同一个答案，而各写一份的结局是
 * `AGENTS.md` 与 `SKILL.md` 在某个边界用例上悄悄分叉。
 *
 * @param {string} body
 * @param {string} heading
 * @returns {string}
 */
function sectionText(body: string, heading: string): string {
  return sectionBody(body, heading);
}

/**
 * YAML 双引号字符串：反斜杠与引号要转义。
 *
 * 它只用于 `description`（一句话，可能含冒号、中文引号）。
 * 不引入 yaml 库来渲染两行：那会让"输出是什么"取决于库的版本。
 *
 * @param {string} value
 * @returns {string}
 */
function yamlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, " ")}"`;
}

/**
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function clampText(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

/**
 * 事件按时间降序；同一天按 key（与 `emit.ts` 同一条显式排序）。
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
