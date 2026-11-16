/**
 * 检索与注入 —— 纯函数，零 IO，零模型（S21）。
 *
 * 它回答一个问题：**为了做完眼前这件事，模型最少需要知道哪几条？**
 *
 * 这个模块的全部纪律只有一条，implement1.md §3.3 把它写成了不能让步的运行时决策：
 *
 * > **检索优先，绝不预加载整个大脑。** 预加载会 context rot，需要"检索 + 新鲜度/出处"两层。
 *
 * 于是这里有一条**可判定的**判据，而不是一句提醒：
 *
 * | 性质 | 怎么被判 |
 * |---|---|
 * | 不许预加载 | 注入的每一条**分数都必须大于 0**（`irrelevant` 是被算出来、没被注入的那些）。把全库塞进去的实现，会连一条都不匹配的条目一起塞进去 |
 * | 预算不许超 | 条目 + 元信息的 token 估算之和 ≤ 预算（`retrievalViolations`） |
 * | 出处是硬约束 | 每一条注入项至少带一条 span（R4）——注进模型的每一句话都要能被点开 |
 * | 过期的不许当现状 | `superseded` / `retired` 的资产与超过新鲜度窗口的 state **根本不进候选**，进了 `excluded` 并说出来 |
 * | 截断必须说出来 | 放不下多少条、截了多少字，都写在注入块自己里面 |
 *
 * 三条刻意的取舍，逐条说明为什么：
 *
 * 1. **打分是确定性的、可解释的**（词法命中 × 类型权重），不是向量、不是模型。
 *    理由与 ADR-0017 同源：它要能被快照、能被 diff、能在没有 API key 的机器上跑。
 *    换成一个 embedding 之后，"为什么这条进来了"就再也回答不了——
 *    而"我不知道它为什么进来"正是 context rot 的起点。
 * 2. **新鲜度只决定进不进，不决定排序。** 排序里多一个因子就多一个说不清的地方；
 *    "过期的一律不进，并报出来"是一条能被复核的判据（implement1.md：过期的事实比没有事实更糟）。
 * 3. **宁少勿多。** 按排序依次放，放不下就**停**，不去挑更小的条目把预算填满。
 *    填空会让"排序就是优先级"这句话失效，而注入给模型的顺序就是它在读的顺序。
 *
 * 时钟由调用方注入（`today`）。不给就是**没有校验新鲜度**——那是"无法校验"，
 * 不是"通过"（ADR-0009 的同一个区分）。
 */
import { ASSET_TYPES, confirmWithinDays, eventId, type AssetDoc, type AssetType, type EventIR } from "@forge/schema";
import { eventTitleOf } from "./compile.ts";
import { titleOf } from "./emit.ts";
import { normalizeText } from "./provenance.ts";

/**
 * 默认注入预算（token）。
 *
 * 它是个常量而不是"看情况"的理由：预算会进输出，而进输出的东西必须确定（R6）。
 * 1200 这个数量级来自使用场景——一次任务的开场上下文要塞进规则、决策与相关状态，
 * 而又不该把八成的窗口吃掉。
 */
export const DEFAULT_BUDGET_TOKENS = 1200;

/**
 * 预算的下限（token）。
 *
 * 它的含义是**这个设计在什么预算下还兑现得了承诺**，而不是一个好看的数字：
 *
 * ```
 *   元信息（"这不是全库、挡住了几条"）   ≤ ~160
 * + 一条注入项的上界（MAX_ITEM_CHARS）   ≤ ~150
 * + 至少还能再放一条（否则"预算内"退化成"什么都不给"）
 * ```
 *
 * 低于它，注入块的**元信息本身**就装不下——而"这不是全库"那几句话是这个模块
 * 存在的前提。与其在预算不够时把它们省掉（那正好省掉了"不许预加载"的可见性），
 * 不如显式拒绝：CLI / 桥 / MCP 用这个常量做参数校验，
 * `retrievalViolations` 继续把那条性质当硬约束。
 *
 * 这个值有两个来源，都不是拍的：
 *
 * - **下限 480**：这是**实测逼出来的**。探针一开始用 240，结果每一个查询都是
 *   "0 条注入"——元信息把它吃光了。那是"预算内"没错，但那不是取用。
 * - **又调到 600**：把语料换成**本仓库自己的 29 条 ADR** 之后，240 与 480 都还是
 *   "0 条注入"（一条 ADR 的摘录就有好几百 token）。于是同时把 `MAX_ITEM_CHARS`
 *   收到 320——**"装不下"的信号先指向条目太大，而不是预算太小**，
 *   因为注入是线索、不是全文。
 */
export const MIN_BUDGET_TOKENS = 600;

/**
 * 单条注入项的正文上限（字符）。它会进输出，所以是常量。
 *
 * 320 这个数**不是"尽量多给"**，而是"注入的是线索，不是全文"这句话的执行体：
 * 一条注入项该回答的是"这件事存在、它在哪、它大概说了什么"，全文按需取
 * （MCP 的 `forge_get`、CLI 的路径、扩展点开的那个文件）。
 * 给得越多的代价是**条数越少**——注入 3 条被截断的相关事实，
 * 好过注入 1 条完整的、而另外两条根本没进来。
 *
 * 它也是 `MIN_BUDGET_TOKENS` 的推导依据之一（见那里）。
 */
export const MAX_ITEM_CHARS = 320;

/** 注入块里回显查询的上限（字符）：查询是人给的一句话，不是一篇文档。 */
export const MAX_QUERY_ECHO_CHARS = 120;

/**
 * 查询词的个数上限。
 *
 * 超过它就取**更长的那几个**（长词更具体）：排序键是显式的 `(长度降序, 字典序)`，
 * 所以"截到哪几个"是可复现的，不依赖查询里谁先出现。
 */
export const MAX_TERMS = 64;

/**
 * 类型权重（十分之一为单位：14 = ×1.4）。
 *
 * 为什么按类型加权而不是纯词法：一次任务开场最该知道的是**不许做什么**（rule）
 * 与**已经定了什么**（decision），然后是**现在是什么样**（state），
 * 最后才是"最近发生了什么"（event，它是背景，不是约束）。
 * 权重是显式的常量，所以"为什么规则排在前面"是能指着说的。
 */
export const TYPE_WEIGHTS: Readonly<Record<AssetType, number>> = {
  rule: 14,
  decision: 12,
  state: 11,
  event: 8,
};

/** 字段权重：题面比正文更能代表"这条讲的是哪件事"。 */
export const FIELD_WEIGHTS = {
  subject: 6,
  title: 4,
  body: 2,
  sources: 1,
} as const;

/** 同一个词在同一个字段里最多算几次。超过 3 次的重复是排版，不是相关性。 */
const MAX_HITS_PER_FIELD = 3;

/**
 * 不该被当成"现在的事实"注入的状态。
 *
 * `superseded` / `retired` 的那一代仍然可读、可核对（ADR-0028 刻意留着两代），
 * 但把它当成现状注入就是**把过期的事实喂给模型**——而这个产品最贵的失败模式
 * 就是"自信地错"。它们进 `excluded`，不静默消失。
 */
export const NON_INJECTABLE_STATUSES: readonly string[] = ["superseded", "retired"];

export interface RetrievalInput {
  /** 一句话的任务描述。不要是一篇文档——它只用来算词法命中。 */
  query: string;
  assets: AssetDoc[];
  events: EventIR[];
  /** token 预算。不给就用 `DEFAULT_BUDGET_TOKENS`。 */
  budget?: number;
  /** `YYYY-MM-DD`。不给 = **没有校验新鲜度**，不是"都新鲜"。 */
  today?: string | null;
  /** 只要这几种类型（不给 = 全部）。 */
  types?: readonly AssetType[];
}

/** 一条被注入的条目。它带着"为什么它在里面"，因为注入块是给人复核的。 */
export interface RetrievedItem {
  kind: "asset" | "event";
  id: string;
  type: AssetType;
  /** 定位：资产的路径，或事件的 `source_id/key`。 */
  path: string;
  title: string;
  subject: string | null;
  /** 注入用的正文（可能被截断，截断由 `truncated` 说出来）。 */
  body: string;
  truncated: boolean;
  sources: string[];
  status: string | null;
  confidence: number | null;
  lastConfirmed: string | null;
  /** 打分结果：词法命中 × 类型权重。**大于 0** 才会被注入。 */
  score: number;
  /** 逐词的命中明细。它是"排序可复核"的执行体。 */
  why: string;
  /** 这一条占的 token（估算）。 */
  tokens: number;
}

export interface ExcludedItem {
  id: string;
  path: string;
  reason: string;
}

export interface DroppedItem {
  id: string;
  path: string;
  score: number;
  tokens: number;
}

export interface RetrievalResult {
  query: string;
  budget: number;
  /** 条目占用的 token 估算。 */
  usedTokens: number;
  /** 元信息占用的 token 估算（头部/尾部）。与 `usedTokens` 分开记账。 */
  metaTokens: number;
  items: RetrievedItem[];
  /** 与查询**无关**（分数为 0）的条数。它是"没有预加载"的直接证据。 */
  irrelevant: number;
  /** 进了候选、但被预算挡在外面的。前 `DROPPED_IN_REPORT` 条进报告。 */
  dropped: DroppedItem[];
  /** 状态或新鲜度不合格，**根本不该被注入**的。 */
  excluded: ExcludedItem[];
  /** 参与打分的总数（过滤之后）。 */
  considered: number;
  today: string | null;
  notes: string[];
}

/**
 * 注入的排序：分数降序 → 类型优先级 → 创建时间降序 → ID 升序。
 *
 * 后面三个键都是**显式的**（R6）：一个只按分数排的列表会在分数相同时
 * 把顺序交给输入顺序，而输入顺序来自 `readdir`——那正是"确定"要挡掉的东西。
 *
 * @param {RetrievedItem} a
 * @param {RetrievedItem} b
 * @returns {number}
 */
function byRank(a: RetrievedItem, b: RetrievedItem): number {
  if (a.score !== b.score) return a.score > b.score ? -1 : 1;
  if (TYPE_WEIGHTS[a.type] !== TYPE_WEIGHTS[b.type]) return TYPE_WEIGHTS[a.type] > TYPE_WEIGHTS[b.type] ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/**
 * token 估算 —— **确定性、且宁可高估**。
 *
 * 真实的 tokenizer 因模型而异，而注入预算必须在不加载任何 tokenizer 的前提下可算、
 * 可复现、可快照。规则两条：
 *
 * - 全角字符（CJK 与全角标点）算 1 个 token；
 * - 其余非空白字符 4 个算 1 个 token（向上取整）。
 *
 * 两条都是**上界附近**的值：真实 tokenizer 对中文通常在 0.6–1，对 ASCII 约 0.25。
 * 高估的代价是"少注入一条"，低估的代价是"超窗被静默截断"——
 * 后者的失败模式是悄无声息的，所以取错的那一边贵得多。
 *
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text: string): number {
  let wide = 0;
  let narrow = 0;
  for (const char of normalizeText(text)) {
    if (/\s/.test(char)) continue;
    if (isWide(char)) wide += 1;
    else narrow += 1;
  }
  return wide + Math.ceil(narrow / 4);
}

/**
 * 全角 / CJK 的码点范围。列的是**区间**而不是一张字符表：
 * 手列的清单一定会漏，而漏掉的那一个会让同一句话在两次估算里长度不同。
 *
 * @param {string} char
 * @returns {boolean}
 */
function isWide(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (
    (code >= 0x1100 && code <= 0x115f) || // 谚文字母
    (code >= 0x2e80 && code <= 0x303e) || // CJK 部首、标点
    (code >= 0x3041 && code <= 0x33ff) || // 假名、CJK 兼容
    (code >= 0x3400 && code <= 0x4dbf) || // CJK 扩展 A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK 基本区
    (code >= 0xa000 && code <= 0xa4cf) || // 彝文
    (code >= 0xac00 && code <= 0xd7a3) || // 谚文音节
    (code >= 0xf900 && code <= 0xfaff) || // CJK 兼容表意
    (code >= 0xfe30 && code <= 0xfe4f) || // CJK 兼容形式
    (code >= 0xff00 && code <= 0xff60) || // 全角形式
    (code >= 0xffe0 && code <= 0xffe6)
  );
}

/**
 * 查询词切分：拉丁词 + CJK 二元组。
 *
 * 为什么要二元组而不是"按空白切"：中文没有空格，切出来是一整句，
 * 于是"索引层的存储后端"和"存储后端怎么选"在词法上毫无交集——
 * 那不是"检索没命中"，那是分词器坏了。
 * 二元组是这里最便宜的可复核方案：它不依赖词典，也不依赖任何模型。
 *
 * @param {string} text
 * @returns {string[]} 去重、排序（长度降序 → 字典序）、截到 `MAX_TERMS`
 */
export function searchTerms(text: string): string[] {
  const normalized = text.normalize("NFKC").toLowerCase();
  const terms = new Set<string>();

  for (const run of normalized.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu) ??
    []) {
    if (run.length === 1) terms.add(run);
    for (let i = 0; i + 2 <= run.length; i += 1) terms.add(run.slice(i, i + 2));
  }
  for (const word of normalized.match(/[a-z0-9][a-z0-9_.+-]*/g) ?? []) {
    // 单字母在英文里几乎总是噪音（a、I），而 `c` 这样的语言标记不值得为它破例。
    if (word.length >= 2) terms.add(word);
  }

  return [...terms].sort((a, b) => (a.length !== b.length ? b.length - a.length : a < b ? -1 : 1)).slice(0, MAX_TERMS);
}

/**
 * 一个字段里某个词出现了几次（折叠大小写与空白，与 `searchTerms` 同一把尺子）。
 *
 * @param {string} field
 * @param {string} term
 * @returns {number}
 */
function countHits(field: string, term: string): number {
  if (field.length === 0) return 0;
  const haystack = field.normalize("NFKC").toLowerCase();
  let count = 0;
  let from = 0;
  while (count < MAX_HITS_PER_FIELD) {
    const at = haystack.indexOf(term, from);
    if (at < 0) break;
    count += 1;
    from = at + term.length;
  }
  return count;
}

/** 打分用的字段视图。事件与资产套进同一个形状，于是它们可以被同一个函数排序。 */
interface Scorable {
  kind: "asset" | "event";
  id: string;
  type: AssetType;
  path: string;
  title: string;
  subject: string | null;
  body: string;
  sources: string[];
  status: string | null;
  confidence: number | null;
  lastConfirmed: string | null;
  occurredAt: string | null;
}

/**
 * 打分：**词法命中 × 类型权重**，逐项可解释。
 *
 * @param {Scorable} item
 * @param {string[]} terms
 * @returns {{raw: number, score: number, why: string}}
 */
function scoreOf(item: Scorable, terms: readonly string[]): { raw: number; score: number; why: string } {
  let raw = 0;
  const details: string[] = [];

  for (const term of terms) {
    const subject = countHits(item.subject ?? "", term);
    const title = countHits(item.title, term);
    const body = countHits(item.body, term);
    const sources = countHits(item.sources.join(" "), term);
    const hits =
      subject * FIELD_WEIGHTS.subject + title * FIELD_WEIGHTS.title + body * FIELD_WEIGHTS.body + sources * FIELD_WEIGHTS.sources;
    if (hits === 0) continue;
    raw += hits;

    const parts: string[] = [];
    if (subject > 0) parts.push(`题面 ×${String(subject)}`);
    if (title > 0) parts.push(`标题 ×${String(title)}`);
    if (body > 0) parts.push(`正文 ×${String(body)}`);
    if (sources > 0) parts.push(`出处 ×${String(sources)}`);
    details.push(`${term}（${parts.join(" · ")}）`);
  }

  // 整数运算到底，最后才除以 10：浮点累加会让"同样的输入"在某些机器上差一位。
  const score = (raw * TYPE_WEIGHTS[item.type]) / 10;
  return { raw, score, why: details.join(" · ") };
}

/**
 * 检索：**打分 → 排序 → 按预算取前若干条**。
 *
 * 它不做的事，比它做的事更能说明它是什么：不读文件、不调模型、不看时钟（`today` 是参数）、
 * 不预加载、不为了填满预算而下沉到无关的条目。
 *
 * @param {RetrievalInput} input
 * @returns {RetrievalResult}
 */
export function retrieve(input: RetrievalInput): RetrievalResult {
  const budget = input.budget ?? DEFAULT_BUDGET_TOKENS;
  const today = input.today ?? null;
  const types = input.types ?? ASSET_TYPES;
  const terms = searchTerms(input.query);
  const notes: string[] = [];

  if (terms.length === 0) {
    // 空查询不是"什么都要"，是"什么都没问"。返回空并说出来——
    // 一个空查询返回全库的实现，正是"预加载"最省事的写法。
    const empty: RetrievalResult = {
      query: input.query,
      budget,
      usedTokens: 0,
      metaTokens: 0,
      items: [],
      irrelevant: 0,
      dropped: [],
      excluded: [],
      considered: 0,
      today,
      notes: ["查询里没有可用的词（全是空白或标点）：**一条都不注入**。空查询不是「什么都要」。"],
    };
    empty.metaTokens = estimateTokens(renderInjection(empty));
    return empty;
  }

  if (today === null) {
    notes.push(
      "没有给基准日：新鲜度**没有校验**——这是「无法校验」，不是「通过」（ADR-0009）。" +
        "要给的话用 --today <YYYY-MM-DD>。",
    );
  }

  const excluded: ExcludedItem[] = [];
  const candidates: Scorable[] = [];

  for (const doc of input.assets) {
    if (!types.includes(doc.frontMatter.type)) continue;
    const front = doc.frontMatter;

    if (NON_INJECTABLE_STATUSES.includes(front.status)) {
      excluded.push({
        id: front.id,
        path: doc.path,
        reason: `status=${front.status}：它已经不是「现在的事实」了，把它注入等于把被取代的东西当现状（ADR-0028 留着两代是为了可追溯，不是为了继续用）`,
      });
      continue;
    }

    if (front.sources.length === 0) {
      // R4 是入库闸门的事，但**注入这一侧也要再判一次**：闸门可以被绕过、
      // 旧资产可能是在闸门存在之前写下的，而注进模型的每一句话都要能被点开。
      // 边界要对每一层都成立，而不是只对写入口成立。
      excluded.push({
        id: front.id,
        path: doc.path,
        reason: "没有出处（R4）：注进模型的每一句话都要能被点开，没有出处的条目连自己都证明不了",
      });
      continue;
    }

    if (today !== null && front.type === "state") {
      const window = confirmWithinDays("state");
      const confirmed = front.last_confirmed;
      if (confirmed === null) {
        excluded.push({
          id: front.id,
          path: doc.path,
          reason: "state 没有 last_confirmed：没有日期就没有新鲜度，它可能已经过期了而没人知道",
        });
        continue;
      }
      const age = daysBetween(confirmed, today);
      if (age === null) {
        excluded.push({ id: front.id, path: doc.path, reason: `last_confirmed=${confirmed} 不是合法日期` });
        continue;
      }
      if (window !== null && age > window) {
        excluded.push({
          id: front.id,
          path: doc.path,
          reason: `已 ${String(age)} 天没有确认（窗口 ${String(window)} 天）：**过期的事实比没有事实更糟**，所以它不进上下文，等人确认`,
        });
        continue;
      }
    }

    candidates.push({
      kind: "asset",
      id: front.id,
      type: front.type,
      path: doc.path,
      title: titleOf(doc),
      subject: front.subject,
      body: doc.body,
      sources: [...front.sources],
      status: front.status,
      confidence: front.confidence,
      lastConfirmed: front.last_confirmed,
      occurredAt: null,
    });
  }

  for (const event of input.events) {
    if (!types.includes("event")) continue;
    candidates.push({
      kind: "event",
      id: eventId(event),
      type: "event",
      path: `${event.source_id}/${event.key}`,
      title: eventTitleOf(event),
      subject: null,
      body: event.text,
      sources: [`src://${event.source_id}#k:${event.key}`],
      status: null,
      confidence: null,
      lastConfirmed: null,
      occurredAt: event.occurred_at,
    });
  }

  /** 打过分的候选：**分数为 0 的一个都不留**（这就是"不预加载"的执行体）。 */
  const scored: RetrievedItem[] = [];
  let irrelevant = 0;

  for (const candidate of candidates) {
    const { score, why } = scoreOf(candidate, terms);
    if (score <= 0) {
      irrelevant += 1;
      continue;
    }
    scored.push({ ...itemOf(candidate), score, why, tokens: 0 });
  }

  for (const item of scored) item.tokens = estimateTokens(renderItem(item));

  scored.sort(byRank);

  /** 先贪心填：放不下就**停**（不去挑更小的条目把预算填满，理由见文件头取舍 3）。 */
  const items: RetrievedItem[] = [];
  const rejected: RetrievedItem[] = [];
  let used = 0;

  for (const item of scored) {
    if (used + item.tokens > budget) {
      rejected.push(item);
      continue;
    }
    items.push(item);
    used += item.tokens;
  }

  const result: RetrievalResult = {
    query: input.query,
    budget,
    usedTokens: 0,
    metaTokens: 0,
    items,
    irrelevant,
    dropped: [],
    excluded,
    considered: candidates.length,
    today,
    notes,
  };

  /**
   * 再退让：**量的是渲染出来的那一块**，不是预留一个猜出来的常数。
   *
   * 元信息的长短取决于库里有几条、挡住了几条——它与条目选择互相依赖，
   * 用一个"预留 160 token"的上界把它解开看着更简单，但那个上界是个猜，
   * 而这条性质必须每次都成立。所以这里直接渲染、直接量、超了就从**末尾**退一条
   * （末尾是排序里最不相关的那条，退让的代价最小）。
   *
   * 循环一定会停：每轮要么条目数减一，要么直接退出。
   */
  let rendered = "";
  for (;;) {
    result.usedTokens = used;
    result.dropped = [...rejected].sort(byRank).map((item) => ({
      id: item.id,
      path: item.path,
      score: item.score,
      tokens: item.tokens,
    }));
    rendered = renderInjection(result);
    result.metaTokens = Math.max(0, estimateTokens(rendered) - used);
    if (estimateTokens(rendered) <= budget) break;
    const last = items.pop();
    if (last === undefined) break; // 元信息自己就超了：`retrievalViolations` 会把它报出来
    used -= last.tokens;
    rejected.push(last);
  }

  return result;
}

/**
 * 一条候选折成注入项的形状（此时还没有分数与 token）。
 *
 * @param {Scorable} candidate
 * @returns {Omit<RetrievedItem, "score" | "why" | "tokens">}
 */
function itemOf(candidate: Scorable): Omit<RetrievedItem, "score" | "why" | "tokens"> {
  const body = truncateBody(candidate.body);
  return {
    kind: candidate.kind,
    id: candidate.id,
    type: candidate.type,
    path: candidate.path,
    title: candidate.title,
    subject: candidate.subject,
    body: body.text,
    truncated: body.truncated,
    sources: candidate.sources,
    status: candidate.status,
    confidence: candidate.confidence,
    lastConfirmed: candidate.lastConfirmed,
  };
}

/**
 * 正文截断。它与 `emit.ts` 的 `TIMELINE_LIMIT` 是同一条纪律：
 * **截断必须被说出来**，否则读者会把"前 600 字"当成"全文"。
 *
 * @param {string} body
 * @returns {{text: string; truncated: boolean}}
 */
function truncateBody(body: string): { text: string; truncated: boolean } {
  const flat = body.replace(/\r\n?/g, "\n").trim();
  if (flat.length <= MAX_ITEM_CHARS) return { text: flat, truncated: false };
  return { text: flat.slice(0, MAX_ITEM_CHARS), truncated: true };
}

/**
 * 一条注入项的渲染。它是 token 估算与最终输出的**唯一一份**形状——
 * 两处各写一遍的结局是"预算算的是 X、注入的是 Y"。
 *
 * @param {RetrievedItem} item
 * @returns {string}
 */
function renderItem(item: RetrievedItem): string {
  const lines: string[] = [];
  lines.push(`### [${item.type}] ${item.title}`);
  lines.push(`- id：\`${item.id}\``);

  const facts: string[] = [`定位：${item.path}`];
  if (item.subject !== null) facts.push(`题面：${item.subject}`);
  if (item.status !== null) facts.push(`状态：${item.status}`);
  if (item.confidence !== null) facts.push(`置信度：${String(item.confidence)}`);
  if (item.lastConfirmed !== null) facts.push(`最后确认：${item.lastConfirmed}`);
  lines.push(`- ${facts.join(" · ")}`);

  lines.push("- 出处：");
  for (const source of item.sources) lines.push(`  - \`${source}\``);

  if (item.body.length > 0) {
    lines.push(item.truncated ? `- 正文（**截断**，全文见 ${item.path}）：` : "- 正文：");
    lines.push(item.body);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * 注入块的元信息。**"这不是全库"必须写在注入块自己里面**：
 * 它会被人原样贴到别的地方去，而一句留在 CLI 报告里的说明会跟着留在那里。
 *
 * 截断的那句话也在这里（而不是在 `notes` 里），因为它是**被量进预算**的：
 * 把它放在事后追加的位置，就会变成"超预算四舍五入一下"。
 *
 * @param {RetrievalResult} result
 * @returns {string}
 */
function renderMeta(result: RetrievalResult): string {
  const query = result.query.length > MAX_QUERY_ECHO_CHARS ? `${result.query.slice(0, MAX_QUERY_ECHO_CHARS)}…` : result.query;
  const lines: string[] = [];
  lines.push(`> 查询：「${query}」`);
  lines.push(
    `> **这不是全库**：参与打分的 ${String(result.considered)} 条里，` +
      `${String(result.irrelevant)} 条与查询无关（分数 0，一条都没注入）、` +
      `${String(result.dropped.length)} 条预算放不下、${String(result.excluded.length)} 条状态或新鲜度不合格。`,
  );
  lines.push(
    `> 预算 ${String(result.budget)} token：条目 ${String(result.usedTokens)} · 元信息 ${String(result.metaTokens)}。`,
  );
  if (result.dropped.length > 0) {
    // 静默截断会让"库里只有这几条"和"只给了这几条"看起来一样。
    lines.push(`> 有 ${String(result.dropped.length)} 条相关条目**没有进来**——要给更多就用更大的预算，或者把查询问窄一点。`);
  }
  if (result.today === null) lines.push("> 没有给基准日：新鲜度**没有校验**。");
  return `${lines.join("\n")}\n`;
}

/**
 * 把检索结果渲染成**一段可以贴进上下文**的文字。
 *
 * 与 `emit.ts` 同一条纪律：没有时钟、没有随机、只有 `\n`、末尾一个换行（R6）。
 * 于是它可以被快照测试钉住——而"注入的东西每次都不一样"是无法审计的。
 *
 * @param {RetrievalResult} result
 * @returns {string}
 */
export function renderInjection(result: RetrievalResult): string {
  const lines: string[] = ["# 资产库 · 检索注入", "", renderMeta(result).trimEnd(), ""];

  if (result.items.length === 0) {
    lines.push("（本次没有注入任何条目。**这不是「库里没有」**——见上面那三行计数。）");
    lines.push("");
    for (const note of result.notes) lines.push(`> ${note}`);
    return `${lines.join("\n")}\n`;
  }

  for (const item of result.items) {
    lines.push(renderItem(item).trimEnd());
    lines.push("");
  }

  for (const note of result.notes) lines.push(`> ${note}`);
  return `${lines.join("\n")}\n`;
}

/**
 * 自证：注入块**有没有违反它自己的承诺**。
 *
 * 返回非空 = 缺陷，不是配置问题——与守卫的 `modelLeaks`、归并的 `proposedMergesApplied`
 * 是同一条思路：**把关键性质写成函数，它才能在每次改动之后被重新问一遍**（R8）。
 *
 * 四条，逐条对应本模块文件头那张表里的一行。
 *
 * @param {RetrievalResult} result
 * @param {string} rendered `renderInjection(result)` 的结果
 * @returns {string[]} 空数组表示性质成立
 */
export function retrievalViolations(result: RetrievalResult, rendered: string): string[] {
  const problems: string[] = [];

  const total = estimateTokens(rendered);
  if (total > result.budget) {
    problems.push(
      `注入块 ${String(total)} token 超过了预算 ${String(result.budget)}` +
        `（条目 ${String(result.usedTokens)} + 元信息 ${String(result.metaTokens)}）——` +
        `注入会撑破使用方的窗口`,
    );
  }

  for (const item of result.items) {
    if (item.score <= 0) {
      problems.push(`${item.path}：分数 ${String(item.score)} 的条目被注入了——预加载全库就是这么开始的`);
    }
    if (item.sources.length === 0) {
      problems.push(`${item.path}：注入了一条没有出处的条目（R4：注进模型的每一句话都要能被点开）`);
    }
  }

  const injectable = new Set(result.items.map((item) => item.id));
  for (const item of result.excluded) {
    if (injectable.has(item.id)) {
      problems.push(`${item.path}：既被排除了又被注入了——两条判据互相矛盾`);
    }
  }

  if (result.usedTokens > result.budget) {
    problems.push(`条目占用 ${String(result.usedTokens)} 已经超过预算 ${String(result.budget)}`);
  }

  return problems.sort();
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
