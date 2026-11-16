/**
 * 取用探针 —— implement2.md 给 P6 写的那条 CI 强制项：**注入预算**（S21）。
 *
 * 它与另外两个探针同一个形状、同一条理由：**它测的不是分数，是边界还在不在**。
 * 而这两个边界恰好是最容易在"优化检索质量"的名义下被悄悄放开的：
 *
 * | 边界 | 怎么被放开 | 探针怎么抓 |
 * |---|---|---|
 * | **预算不许超** | "还差一点点，就多塞一条吧" | 量**渲染出来的整块**（含元信息），比预算 |
 * | **绝不预加载全库** | "与其漏掉，不如全给它" | 注入里出现**分数为 0** 的条目即红 |
 *
 * ## 语料用的是**本仓库自己的资产**
 *
 * 与冲突探针用合成集同一条思路：**自己不编语料，用自己的库**。
 * 这样探针的每一次运行都在回答一个真实的问题——"我这个库自己，能不能被预算内地取用"，
 * 而不是在回答"玩具语料能不能被取用"。
 *
 * ## 为什么 `today` 是 null
 *
 * 基准日由调用方注入（ADR：core 里没有时钟）。探针**刻意不给**它：
 * 一个会在某天早上突然变红的 CI，比一个不跑 CI 更糟——它会训练人无视红色。
 * "过期的不进上下文"那条性质由 `packages/core/test/retrieve.test.ts` 用一个
 * **固定的** `today` 钉住。
 */
import { readRepoAssets } from "../../packages/store/src/index.ts";
import {
  DEFAULT_BUDGET_TOKENS,
  MIN_BUDGET_TOKENS,
  estimateTokens,
  parseSpan,
  renderInjection,
  retrievalViolations,
  retrieve,
  type AssetDoc,
} from "../../packages/core/src/index.ts";

/** 拿几条资产做查询：数量写死，于是"这一轮量了几条"是可复现的。 */
export const PROBE_QUERIES = 5;

/**
 * 故意与任何资产都无关的查询。它必须**一条都不注入**。
 *
 * **为什么是 ASCII 乱码而不是一句无关的中文**：第一版用的是
 * 「企鹅的迁徙路线与南极冰盖」，结果它命中了 2 条 ADR——中文走二元组切分，
 * 「的迁徙」切出「的迁」，而库里有一条写着「……的迁移……」。这不是缺陷
 * （二元组就是这个代价），但它说明**无关的中文查询不是干净的对照**：
 * 字符级的碰撞会让"无关"变成"看起来无关"。ASCII 乱码则不可能撞上任何东西。
 */
export const CONTROL_QUERY = "xyzzy plugh frobnicate";

/**
 * 探针用的预算：**默认预算**，外加在**下限**上再跑一遍。
 *
 * 两个都要跑，因为它们防的是两件不同的事：
 * - 默认预算上看"注入的东西**是否仍然远小于整个库**"（预加载的日常形状）；
 * - 下限上看"预算被压到最紧时**还成不成立**"（元信息会不会把内容吃光）。
 * 只跑其中一个，另一个方向的退化就没有见证人。
 */
export const PROBE_BUDGET = DEFAULT_BUDGET_TOKENS;

/** 在上限上跑的那一轮里，注入条数的上限（占语料的比例）。超过它就是在预加载。 */
export const MAX_INJECTED_RATIO = 0.5;

export interface RetrievalProbeResult {
  ok: boolean;
  /** 语料里有几条资产。 */
  corpus: number;
  /** 实际跑了几条查询。 */
  queries: number;
  /** 注入的总条数（所有查询之和）。 */
  injected: number;
  /** 参与打分的总条数（所有查询之和）。 */
  considered: number;
  /** 与查询无关（分数 0）的总条数。它的**非零**是"没有预加载"的直接证据。 */
  irrelevant: number;
  /** 单条查询里最大的那一块有多大（token）。 */
  maxBlockTokens: number;
  budget: number;
  /** 预算被撑破 / 注入零分项 / 注入了没出处的条目（`retrievalViolations` 原文）。 */
  violations: string[];
  /** 预加载的迹象。 */
  preloaded: string[];
  /** 尺子瞎了：所有查询一条都没注入。 */
  blind: string[];
  /** 探针自己的问题（语料读不动之类）。非空 = 这次读数不可采信。 */
  goldenIssues: string[];
  detail: string[];
}

/**
 * @param {string} repoRoot
 * @returns {RetrievalProbeResult}
 */
export function runRetrievalProbe(repoRoot: string): RetrievalProbeResult {
  const scanned = readRepoAssets(repoRoot);
  const docs: AssetDoc[] = scanned.docs;

  const violations: string[] = [];
  const preloaded: string[] = [];
  const goldenIssues: string[] = [];
  const detail: string[] = [];

  if (scanned.invalid.length > 0) {
    for (const item of scanned.invalid) goldenIssues.push(`语料里读不动的资产：${item.path}（${item.reason}）`);
  }
  if (docs.length < PROBE_QUERIES) {
    goldenIssues.push(`语料只有 ${String(docs.length)} 条资产，探针要至少 ${String(PROBE_QUERIES)} 条才有意义`);
  }

  // 查询来自资产标题：**语料自己决定问什么**，不由探针手编——
  // 手编的查询会逐渐变成"为当前实现量身的查询"（与 ADR-0020 那条"尺子自己要有人确认"同源）。
  const queries = docs
    .map((doc) => titleOf(doc))
    .filter((title) => title.trim().length >= 2)
    .slice(0, PROBE_QUERIES);

  let injected = 0;
  let considered = 0;
  let irrelevant = 0;
  let maxBlockTokens = 0;
  let sawAnything = false;
  let sawIrrelevant = false;

  for (const query of [...queries, CONTROL_QUERY]) {
    const result = retrieve({ query, assets: docs, events: [], budget: PROBE_BUDGET, today: null });
    const rendered = renderInjection(result);

    const problems = retrievalViolations(result, rendered);
    for (const problem of problems) violations.push(`查询「${query}」：${problem}`);

    const blockTokens = estimateTokens(rendered);
    if (blockTokens > maxBlockTokens) maxBlockTokens = blockTokens;

    // 预加载的两个形状，分开判：一个是"把无关的也塞进去"，一个是"整个库都塞进去"。
    if (result.items.some((item) => item.score <= 0)) {
      preloaded.push(`查询「${query}」：注入里出现了分数为 0 的条目`);
    }
    if (docs.length > 0 && result.items.length > docs.length * MAX_INJECTED_RATIO) {
      preloaded.push(
        `查询「${query}」：注入了 ${String(result.items.length)}/${String(docs.length)} 条` +
          `（超过 ${String(Math.round(MAX_INJECTED_RATIO * 100))}% 就不是检索，是把库倒出来）`,
      );
    }

    if (query === CONTROL_QUERY) {
      if (result.items.length !== 0) {
        preloaded.push(`对照查询「${CONTROL_QUERY}」本该一条都不注入，实际注入了 ${String(result.items.length)} 条`);
      }
      continue;
    }

    injected += result.items.length;
    considered += result.considered;
    irrelevant += result.irrelevant;
    if (result.items.length > 0) sawAnything = true;
    if (result.irrelevant > 0) sawIrrelevant = true;

    // 出处：注进模型的每一句话都要能被点开。这一条在 core 里也是硬约束，
    // 探针在这里**再问一遍**——闸门的判据要能独立于被检查的那份代码成立。
    for (const item of result.items) {
      for (const source of item.sources) {
        if (!parseSpan(source).ok) violations.push(`查询「${query}」：${item.path} 的出处「${source}」不是合法 span`);
      }
    }
  }

  // 最紧的预算上再跑一轮：这一轮防的是"元信息把内容吃光"——
  // 那种实现能让上面所有检查全绿，而它一条内容都没给出去。
  const tight = retrieve({ query: queries[0] ?? "", assets: docs, events: [], budget: MIN_BUDGET_TOKENS, today: null });
  const tightRendered = renderInjection(tight);
  for (const problem of retrievalViolations(tight, tightRendered)) {
    violations.push(`下限预算（${String(MIN_BUDGET_TOKENS)}）上：${problem}`);
  }
  if (estimateTokens(tightRendered) > MIN_BUDGET_TOKENS) {
    violations.push(`下限预算（${String(MIN_BUDGET_TOKENS)}）上：整块 ${String(estimateTokens(tightRendered))} token 超了`);
  }

  const blind: string[] = [];
  if (queries.length > 0 && !sawAnything) {
    // 与 `E4`（"空实现也及格"）同一条思路：一个"什么都注入不出来"的检索器
    // 能让所有预算检查全绿。
    blind.push(
      `拿库里的 ${String(queries.length)} 个资产标题当查询，**一条都没注入**——` +
        `尺子已经分不开"没命中"和"检索坏了"了`,
    );
  }
  if (queries.length > 0 && !sawIrrelevant) {
    blind.push(
      "每一个查询都把整个库判成「有关」：相关性判断已经退化成恒真，于是预算检查什么都保证不了",
    );
  }

  detail.push(
    `语料 ${String(docs.length)} 条（本仓库自己的资产）· 查询 ${String(queries.length)} 条 + 1 条对照 · ` +
      `注入 ${String(injected)} 条 · 参与打分 ${String(considered)} 条 · 无关 ${String(irrelevant)} 条`,
  );
  detail.push(
    `单块最大 ${String(maxBlockTokens)} token（预算 ${String(PROBE_BUDGET)}，含元信息）· ` +
      `下限预算上那一轮：注入 ${String(tight.items.length)} 条 · 整块 ${String(estimateTokens(tightRendered))} token`,
  );

  return {
    ok: violations.length === 0 && preloaded.length === 0 && blind.length === 0 && goldenIssues.length === 0,
    corpus: docs.length,
    queries: queries.length,
    injected,
    considered,
    irrelevant,
    maxBlockTokens,
    budget: PROBE_BUDGET,
    violations,
    preloaded,
    blind,
    goldenIssues,
    detail,
  };
}

/**
 * @param {AssetDoc} doc
 * @returns {string}
 */
function titleOf(doc: AssetDoc): string {
  for (const line of doc.body.replace(/\r\n?/g, "\n").split("\n")) {
    const match = /^\s{0,3}#\s+(.*)$/.exec(line);
    if (match?.[1] !== undefined) return match[1].replace(/\s+#+\s*$/, "").trim();
  }
  return doc.frontMatter.id;
}
