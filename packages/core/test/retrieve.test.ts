/**
 * 检索与注入的测试 —— 尤其那两条**结构性**的性质（S21）：
 *
 * 1. **绝不预加载全库**：分数为 0 的条目一条都不许进注入。
 *    这一条配了反例——"把所有条目都塞进去"的实现必须被抓住。
 * 2. **预算不许超**：量的是**渲染出来的那一整块**（含元信息），
 *    不是"条目加起来够小"。
 *
 * 其余几条：过期的不许当现状、出处是硬约束、截断必须说出来、产出逐字节确定。
 * 每条判据都配一个"故意弄坏它"的断言——只会变绿的检查不是检查（R8）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SCHEMA_VERSION,
  renderAssetDocument,
  type AssetDoc,
  type AssetFrontMatter,
  type AssetType,
  type EventIR,
} from "@forge/schema";
import {
  DEFAULT_BUDGET_TOKENS,
  MIN_BUDGET_TOKENS,
  NON_INJECTABLE_STATUSES,
  estimateTokens,
  renderInjection,
  retrievalViolations,
  retrieve,
  searchTerms,
} from "../src/index.ts";

const REAL_SPAN = "file://docs/implement2.md#t:检索优先，绝不预加载整个大脑";

/**
 * @param {AssetType} type
 * @param {string} id
 * @param {string} title
 * @param {string} body
 * @param {Partial<AssetFrontMatter>} [overrides]
 * @returns {AssetDoc}
 */
function asset(
  type: AssetType,
  id: string,
  title: string,
  body: string,
  overrides: Partial<AssetFrontMatter> = {},
): AssetDoc {
  const frontMatter: AssetFrontMatter = {
    schema_version: SCHEMA_VERSION,
    id,
    type,
    status: type === "decision" ? "accepted" : "active",
    created: "2026-01-01",
    last_confirmed: type === "state" ? "2026-11-01" : null,
    supersedes: null,
    origin_incident: null,
    subject: type === "state" ? "索引层的存储后端" : null,
    sources: [REAL_SPAN],
    sensitivity: "internal",
    confidence: 0.9,
    ...overrides,
  };
  const fullBody = `# ${title}\n\n${body}`;
  return { path: `assets/${type}/${id}.md`, frontMatter, body: fullBody, raw: renderAssetDocument(frontMatter, fullBody) };
}

/**
 * @param {string} key
 * @param {string} text
 * @returns {EventIR}
 */
function event(key: string, text: string): EventIR {
  return {
    schema_version: 1,
    source_id: "src_01M6Q2FD00P3EVALGATE000000",
    key,
    kind: "message",
    occurred_at: "2026-11-06T10:00:00Z",
    actor: "user",
    text,
  };
}

/** 一个有几条资产的库：只有前三条和"存储后端"这件事有关。 */
function library(): AssetDoc[] {
  return [
    asset("rule", "rule_01M6Q2FD00GRZFQ6K3F6KPGA03", "不许绕过闸门", "## 规则\n\n闸门红了要修问题。\n\n## 强制\n\n闸门 1 直接阻断。\n"),
    asset("state", "state_01M6Q2FD00NVKBVBH80QD63VSX", "存储后端用 SQLite", "## 当前状态\n\n索引层用 node:sqlite。\n"),
    asset("decision", "dec_01M6Q2FD002MW3PYGNRES1PGRW", "分类法只定 4 种资产", "## 问题\n\n少了还是多了。\n\n## 选定\n\n**选四种**。\n\n## 后果\n\n要迁移。\n"),
    // 以下几条与"存储后端"毫无词法交集：它们**一条都不该被注入**。
    asset("decision", "dec_01M6Q2FD00CQS8ZBPRX44R5C3P", "配色方案定成深色", "## 问题\n\n亮还是暗。\n\n## 选定\n\n**深色**。\n\n## 后果\n\n费眼。\n"),
    asset("rule", "rule_01M6Q2FD00QH8S2W1YVK3M9XZP", "提交信息用中文", "## 规则\n\n一律写中文。\n\n## 强制\n\n靠评审。\n"),
    asset("state", "state_01M6Q2FD00Z52A681X6FHS62G7", "发布节奏", "## 当前状态\n\n两周一个版本。\n", {}),
  ];
}

const QUERY = "索引层的存储后端要怎么选";

// ─────────────────────────────────────────────────────────────────────────────
// 性质 1 · 绝不预加载全库
// ─────────────────────────────────────────────────────────────────────────────

test("只注入与查询有关的条目：分数为 0 的一条都不进（**这就是「不预加载」**）", () => {
  const result = retrieve({ query: QUERY, assets: library(), events: [], budget: DEFAULT_BUDGET_TOKENS });
  assert.ok(result.items.length > 0, "至少有 state 与 rule 该进来");
  assert.ok(
    result.items.every((item) => item.score > 0),
    `注入里出现了零分项：${result.items.map((item) => `${item.path}=${String(item.score)}`).join("、")}`,
  );
  assert.ok(result.irrelevant > 0, "这个库里确实有跟查询无关的条目，它们必须被算出来而不是被注入");
  assert.deepEqual(retrievalViolations(result, renderInjection(result)), []);
});

test("反例：把无关条目也塞进去 —— 自证必须报出来（否则「不预加载」只是注释）", () => {
  const result = retrieve({ query: QUERY, assets: library(), events: [], budget: DEFAULT_BUDGET_TOKENS });
  // 手动构造一个"预加载"的结果：把库里的东西全塞进 items。
  const polluted = {
    ...result,
    items: [...result.items, { ...result.items[0]!, id: "dec_别的", path: "assets/dec/别的.md", score: 0 }],
  };
  const problems = retrievalViolations(polluted, renderInjection(polluted));
  assert.ok(
    problems.some((problem) => problem.includes("预加载全库就是这么开始的")),
    `零分项被注入必须被抓住，实际：${problems.join(" | ")}`,
  );
});

test("无关查询 → 一条都不注入，**且不能退化成「给全库」**", () => {
  const result = retrieve({ query: "企鹅的迁徙路线", assets: library(), events: [], budget: DEFAULT_BUDGET_TOKENS });
  assert.deepEqual(result.items, []);
  assert.equal(result.irrelevant, library().length, "全是无关条目");
  assert.match(renderInjection(result), /这不是「库里没有」/);
});

test("空查询不是「什么都要」：返回空并说出来", () => {
  const result = retrieve({ query: "   ", assets: library(), events: [], budget: DEFAULT_BUDGET_TOKENS });
  assert.deepEqual(result.items, []);
  assert.equal(result.considered, 0, "空查询连打分都不该打");
  assert.match(result.notes.join("\n"), /空查询不是「什么都要」/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 性质 2 · 预算不许超
// ─────────────────────────────────────────────────────────────────────────────

test("预算：渲染出来的那一整块（含元信息）不超过预算", () => {
  for (const budget of [MIN_BUDGET_TOKENS, 400, 700, DEFAULT_BUDGET_TOKENS]) {
    const result = retrieve({ query: QUERY, assets: library(), events: [], budget });
    const rendered = renderInjection(result);
    assert.ok(
      estimateTokens(rendered) <= budget,
      `预算 ${String(budget)}：整块实际 ${String(estimateTokens(rendered))} token`,
    );
    assert.deepEqual(retrievalViolations(result, rendered), []);
  }
});

test("预算不够时**从末尾退**：高分的留下，低分的进 dropped，而且要写在注入块里", () => {
  // 语料要足够大，小预算才真的装不下——否则这条用例测的是"两条都放得下"，
  // 而它想测的是**退让的方向**。
  const many = [
    ...library(),
    asset(
      "rule",
      "rule_01M6Q2FD00AAAAAAAAAAAAAAAAAA",
      "存储后端的规则甲",
      "## 规则\n\n存储后端一律用内置模块。\n\n## 强制\n\n靠评审。\n",
    ),
    asset(
      "rule",
      "rule_01M6Q2FD00BBBBBBBBBBBBBBBBBB",
      "存储后端的规则乙",
      "## 规则\n\n存储后端不许引第三方库。\n\n## 强制\n\n靠评审。\n",
    ),
    asset("state", "state_01M6Q2FD00CCCCCCCCCCCCCCCCCC", "存储后端的历史", "## 当前状态\n\n存储后端曾经用过 JSON 文件。\n", {
      subject: "索引层的存储后端",
    }),
  ];
  const all = retrieve({ query: QUERY, assets: many, events: [], budget: 3000 });
  const tight = retrieve({ query: QUERY, assets: many, events: [], budget: MIN_BUDGET_TOKENS });

  assert.ok(tight.items.length < all.items.length, "小预算必须真的少给几条");
  assert.ok(tight.dropped.length > 0);
  // 留下的必须是**分数最高的那几条**（退让从末尾开始）。
  const kept = tight.items.map((item) => item.id);
  const expected = all.items.slice(0, tight.items.length).map((item) => item.id);
  assert.deepEqual(kept, expected, "退让的方向错了——它退了高分的那条");

  assert.match(renderInjection(tight), /没有进来/);
});

test("反例：预算被撑破 —— 自证必须报出来", () => {
  const result = retrieve({ query: QUERY, assets: library(), events: [], budget: DEFAULT_BUDGET_TOKENS });
  const rendered = renderInjection(result);
  // 把预算改小 = 模拟一次"注入块比承诺的大"的缺陷。
  const problems = retrievalViolations({ ...result, budget: 10 }, rendered);
  assert.ok(
    problems.some((problem) => problem.includes("超过了预算")),
    `超预算必须被抓住，实际：${problems.join(" | ")}`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 状态与新鲜度：过期的不许当现状
// ─────────────────────────────────────────────────────────────────────────────

test("`superseded` / `retired` 不进注入，但**必须被说出来**（不是静默消失）", () => {
  for (const status of NON_INJECTABLE_STATUSES) {
    const docs = [...library(), asset("state", "state_01M6Q2FD00AA1B2C3D4E5F6G7H", "旧存储后端", "## 当前状态\n\n索引层用 JSON 文件。\n", { status, subject: "索引层的存储后端" })];
    const result = retrieve({ query: QUERY, assets: docs, events: [], budget: DEFAULT_BUDGET_TOKENS });
    assert.ok(
      result.excluded.some((item) => item.reason.includes(status)),
      `status=${status} 的那条必须进 excluded`,
    );
    assert.ok(!result.items.some((item) => item.id === "state_01M6Q2FD00AA1B2C3D4E5F6G7H"));
  }
});

test("过期的 state 不进注入（过期的事实比没有事实更糟），并在 excluded 里带天数", () => {
  const stale = asset("state", "state_01M6Q2FD00AA1B2C3D4E5F6G7H", "存储后端用 SQLite", "## 当前状态\n\n索引层用 node:sqlite。\n", {
    last_confirmed: "2026-01-01",
  });
  const fresh = retrieve({ query: QUERY, assets: [stale], events: [], budget: DEFAULT_BUDGET_TOKENS, today: "2026-01-20" });
  assert.equal(fresh.items.length, 1, "19 天，还在 30 天的窗口里 —— 它该进来");

  const expired = retrieve({ query: QUERY, assets: [stale], events: [], budget: DEFAULT_BUDGET_TOKENS, today: "2026-03-01" });
  assert.deepEqual(expired.items, [], "过期的不许进上下文");
  assert.match(expired.excluded[0]?.reason ?? "", /天没有确认/);
});

test("不给基准日 = **没有校验**新鲜度，不是「都新鲜」", () => {
  const stale = asset("state", "state_01M6Q2FD00AA1B2C3D4E5F6G7H", "存储后端用 SQLite", "## 当前状态\n\n用 node:sqlite。\n", {
    last_confirmed: "2020-01-01",
  });
  const result = retrieve({ query: QUERY, assets: [stale], events: [], budget: DEFAULT_BUDGET_TOKENS });
  assert.equal(result.items.length, 1, "没有基准日就不做新鲜度过滤");
  assert.match(result.notes.join("\n"), /没有校验/);
  assert.match(renderInjection(result), /新鲜度\*\*没有校验\*\*/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 出处 / 截断 / 确定性
// ─────────────────────────────────────────────────────────────────────────────

test("没有出处的资产**不进注入**：R4 在注入这一侧也要成立", () => {
  const naked = asset("state", "state_01M6Q2FD00AA1B2C3D4E5F6G7H", "存储后端用 SQLite", "## 当前状态\n\n用 node:sqlite。\n", {
    sources: [],
  });
  const result = retrieve({ query: QUERY, assets: [naked], events: [], budget: DEFAULT_BUDGET_TOKENS });
  assert.deepEqual(result.items, []);
  assert.match(result.excluded[0]?.reason ?? "", /没有出处/);
  assert.deepEqual(retrievalViolations(result, renderInjection(result)), []);
});

test("反例：真的注入了一条没出处的 —— 自证必须报出来", () => {
  const result = retrieve({ query: QUERY, assets: library(), events: [], budget: DEFAULT_BUDGET_TOKENS });
  const naked = { ...result.items[0]!, sources: [] };
  const polluted = { ...result, items: [naked] };
  const problems = retrievalViolations(polluted, renderInjection(polluted));
  assert.ok(problems.some((problem) => problem.includes("没有出处")));
});

test("长正文被截断，而且**截断必须写在里面**（静默截断 = 在输出里撒谎）", () => {
  const long = asset("rule", "rule_01M6Q2FD00ABCDEFGHJKMNPQRS", "长规则", `## 规则\n\n${"啰嗦。".repeat(400)}\n\n## 强制\n\n靠评审。\n`);
  const result = retrieve({ query: "长规则 啰嗦", assets: [long], events: [], budget: DEFAULT_BUDGET_TOKENS });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.truncated, true);
  assert.match(renderInjection(result), /截断\*\*/);
});

test("事件也能被检索到，而且它的出处是 `src://…#k:` （可解析）", () => {
  const events = [event("conv_a/msg_01", "存储后端最后选了 node:sqlite"), event("conv_a/msg_02", "今天天气不错")];
  const result = retrieve({ query: QUERY, assets: [], events, budget: DEFAULT_BUDGET_TOKENS });
  assert.equal(result.items.length, 1, "只有那条相关的进来");
  assert.equal(result.items[0]?.type, "event");
  assert.equal(result.items[0]?.sources[0], "src://src_01M6Q2FD00P3EVALGATE000000#k:conv_a/msg_01");
  assert.equal(result.irrelevant, 1);
});

test("确定性：同样的输入两次逐字节相同；输入顺序反过来也相同", () => {
  const first = retrieve({ query: QUERY, assets: library(), events: [], budget: DEFAULT_BUDGET_TOKENS });
  const second = retrieve({
    query: QUERY,
    assets: [...library()].reverse(),
    events: [],
    budget: DEFAULT_BUDGET_TOKENS,
  });
  assert.equal(renderInjection(first), renderInjection(second));
  // 输出里没有时钟、没有随机（与 emit 同一条纪律）。
  assert.doesNotMatch(renderInjection(first), /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  assert.doesNotMatch(renderInjection(first), /\r/);
});

test("排序可解释：每条都带「为什么它在里面」的词法明细", () => {
  const result = retrieve({ query: QUERY, assets: library(), events: [], budget: DEFAULT_BUDGET_TOKENS });
  const top = result.items[0];
  assert.ok(top !== undefined);
  assert.match(top.why, /题面|正文|标题/);
  assert.match(renderInjection(result), /这不是全库/);
});

test("同分时按类型权重排：规则排在状态前面（一次任务开场最该知道「不许做什么」）", () => {
  // 两条在词法上**完全对称**（都只在正文里命中一次，题面与标题都不命中），
  // 只有类型不同——于是排出来的顺序只可能来自类型权重。
  const docs = [
    asset("state", "state_01M6Q2FD00AAAAAAAAAAAAAAAAAA", "甲", "## 当前状态\n\n存储后端。\n", { subject: "无关的题面" }),
    asset("rule", "rule_01M6Q2FD00BBBBBBBBBBBBBBBBBB", "乙", "## 规则\n\n存储后端。\n\n## 强制\n\n靠闸门。\n"),
  ];
  const result = retrieve({ query: "存储后端", assets: docs, events: [], budget: DEFAULT_BUDGET_TOKENS });
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0]?.type, "rule");
  // 对称性也要钉住：不是"规则碰巧分高"，是"同样多命中、类型权重更高"。
  // 同一个词法原始分（3 个二元组 × 正文权重 2 = 6）分别乘 14/10 与 11/10。
  assert.equal(result.items[0]?.score, 8.4);
  assert.equal(result.items[1]?.score, 6.6);
});

test("分词：中文走二元组，拉丁词整词——两边都要能对上", () => {
  assert.ok(searchTerms("索引层的存储后端").includes("存储"));
  assert.deepEqual(searchTerms("which sqlite").sort(), ["sqlite", "which"]);
  // 单字母在英文里是噪音；中文单字要留着（"库"这种查询是合理的）。
  assert.deepEqual(searchTerms("a b c").filter((term) => term.length === 1), []);
  assert.ok(searchTerms("库").includes("库"));
});

test("token 估算：宁可高估——中文按字算，ASCII 按 4 字符算", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("   \n  "), 0);
  assert.equal(estimateTokens("中文"), 2);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2, "向上取整：5 个 ASCII 字符按 2 个 token 算");
});
