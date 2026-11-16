/**
 * 健康检查的测试 —— 四种腐烂，**每一种都要能被单独抓住**（S25）。
 *
 * 这个文件的结构就是那份断言：一组"健康"的语料必须零发现，
 * 而每一组"烂掉"的语料只许报出**它那一种**腐烂。
 *
 * 为什么"只许报它那一种"是重点：一个见到什么都报的实现能让上面所有检查全绿。
 * 与 `E4`（空实现也及格）、`E11`（预加载不会让预算检查变红）是同一条思路——
 * **一条只会变绿的检查不是检查**。
 *
 * 报告那几条测的是另外两件事：**基准日是输入**（同一份库跑两次字节相同），
 * 以及**截断必须说出来**（静默截断会让"一共 20 条"和"只显示 20 条"读成同一句话）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SCHEMA_VERSION, renderAssetDocument, type AssetDoc, type AssetFrontMatter } from "@forge/schema";
import {
  ASSET_CODES,
  HEALTH_CODES,
  renderHealthReport,
  renderWeeklyReport,
  runHealth,
  unchangedExceptLastConfirmed,
  type HealthFinding,
} from "../src/index.ts";

const SPAN_A = "file://docs/implement2.md#t:检索优先，绝不预加载整个大脑";
const SPAN_B = "file://docs/directory.md#t:能重新算出来的东西不要存第二份";
const SPAN_C = "file://docs/positioning.md#t:把痕迹编译成资产";

/**
 * @param {Partial<AssetFrontMatter>} [overrides]
 * @param {string} [body]
 * @returns {AssetDoc}
 */
function asset(overrides: Partial<AssetFrontMatter> = {}, body?: string): AssetDoc {
  const frontMatter: AssetFrontMatter = {
    schema_version: SCHEMA_VERSION,
    id: "state_01M6Q2FD00NVKBVBH80QD63VSX",
    type: "state",
    status: "active",
    created: "2026-01-01",
    last_confirmed: "2026-11-01",
    supersedes: null,
    origin_incident: null,
    subject: "索引层的存储后端",
    sources: [SPAN_A],
    sensitivity: "internal",
    confidence: 0.9,
    ...overrides,
  };
  const text = body ?? "# 存储后端\n\n## 当前状态\n\n索引层用 node:sqlite。\n";
  return {
    path: `assets/${frontMatter.type === "decision" ? "dec" : frontMatter.type}/${frontMatter.id}.md`,
    frontMatter,
    body: text,
    raw: renderAssetDocument(frontMatter, text),
  };
}

/**
 * @param {string} id
 * @param {Partial<AssetFrontMatter>} [overrides]
 * @returns {AssetDoc}
 */
function state(id: string, overrides: Partial<AssetFrontMatter> = {}): AssetDoc {
  return asset({ id, ...overrides });
}

/**
 * @param {HealthFinding[]} findings
 * @returns {string[]}
 */
function codes(findings: HealthFinding[]): string[] {
  return [...new Set(findings.map((finding) => finding.code))].sort();
}

/** 一份"健康"的语料：三条互相连着、窗口内、supersedes 链完整。 */
function healthy(): AssetDoc[] {
  const seed = state("state_01M6Q2FD00NVKBVBH80QD63VSX");
  const next = state("state_01M6Q2FD00NVKBVBH80QD63VSY", {
    supersedes: seed.frontMatter.id,
    created: "2026-10-01",
  });
  const replaced = { ...seed, frontMatter: { ...seed.frontMatter, status: "superseded" } };
  const rule = asset({
    id: "rule_01M6Q2FD00NVKBVBH80QD63VSX",
    type: "rule",
    subject: null,
    status: "active",
    last_confirmed: null,
    origin_incident: SPAN_B,
    sources: [SPAN_B],
  });
  const decision = asset({
    id: "dec_01M6Q2FD00NVKBVBH80QD63VSX",
    type: "decision",
    status: "accepted",
    subject: null,
    last_confirmed: null,
    sources: [SPAN_B],
  });
  return [replaced, next, rule, decision];
}

const TODAY = "2026-11-06";

test("健康的库：零发现（一个永远报红的检查比没有检查更糟）", () => {
  const report = runHealth({ assets: healthy(), today: TODAY });
  assert.deepEqual(report.findings, []);
  assert.equal(report.actionable.length, 0);
  assert.equal(report.total, 4);
});

test("孤儿：没有任何邻居的资产被报出来，而邻居在的资产不被误报", () => {
  const alone = state("state_01M6Q2FD00NVKBVBH80QD63VSZ", {
    subject: "一件谁都不关心的事",
    sources: [SPAN_C],
  });
  const report = runHealth({ assets: [...healthy(), alone], today: TODAY });
  const orphans = report.findings.filter((finding) => finding.code === HEALTH_CODES.ORPHAN);
  assert.deepEqual(
    orphans.map((finding) => finding.path),
    [alone.path],
    "只有那条孤零零的该被报；共享出处的、同题面的都不算孤儿",
  );
  assert.equal(orphans[0]?.severity, "info", "孤儿是「看一眼」，不是「必须动手」");
  assert.equal(report.actionable.length, 0);
});

test("孤儿：**忽略锚点**——同一份来源的两条断言互为邻居（否则整个库都会被判成孤儿）", () => {
  const a = state("state_01M6Q2FD00NVKBVBH80QD63VSX", {
    subject: "甲题面",
    sources: ["src://src_AAAA#k:messages.0.text"],
  });
  const b = state("state_01M6Q2FD00NVKBVBH80QD63VSY", {
    subject: "乙题面",
    sources: ["src://src_AAAA#k:messages.1.text"],
  });
  const report = runHealth({ assets: [a, b], today: TODAY });
  assert.equal(report.findings.some((finding) => finding.code === HEALTH_CODES.ORPHAN), false);
});

test("孤儿：`event` 不进孤儿清单（时间线会被淹没，而被淹没的清单等于没有清单）", () => {
  const event: AssetDoc = asset({
    id: "event_01M6Q2FD00NVKBVBH80QD63VSX",
    type: "event",
    status: "recorded",
    subject: null,
    last_confirmed: null,
    sources: [SPAN_C],
  });
  const report = runHealth({ assets: [...healthy(), event], today: TODAY });
  assert.equal(report.findings.some((finding) => finding.code === HEALTH_CODES.ORPHAN), false);
});

test("静默被取代：取代者说它取代了一条不在库里的资产 → 链断了", () => {
  const broken = state("state_01M6Q2FD00NVKBVBH80QD63VSZ", { supersedes: "state_01M6Q2FD00NVKBVBH80QD63VS0" });
  const report = runHealth({ assets: [broken], today: TODAY });
  const findings = report.findings.filter(
    (finding) => finding.code === HEALTH_CODES.SILENT_SUPERSESSION && finding.severity === "error",
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.message.includes("库里没有这一条"), true);
});

test("静默被取代：**旧那一代还标着 active** —— 同一个题面上两条「现在的样子」", () => {
  const seed = state("state_01M6Q2FD00NVKBVBH80QD63VSX");
  const next = state("state_01M6Q2FD00NVKBVBH80QD63VSY", { supersedes: seed.frontMatter.id });
  // 故意不把旧那一代标成 superseded：这正是"一次替换写了一半"的形状。
  const report = runHealth({ assets: [seed, next], today: TODAY });
  assert.deepEqual(codes(report.findings), [HEALTH_CODES.SILENT_SUPERSESSION]);
  assert.equal(report.actionable.some((finding) => finding.message.includes("两条")), true);
});

test("静默被取代：标了 superseded 却没有任何一条取代它", () => {
  const retired = state("state_01M6Q2FD00NVKBVBH80QD63VSX", { status: "superseded" });
  const report = runHealth({ assets: [retired], today: TODAY });
  assert.deepEqual(codes(report.findings), [HEALTH_CODES.SILENT_SUPERSESSION]);
  assert.equal(report.findings[0]?.severity, "warn");
});

test("静默被取代：同一题面两条 active —— **冲突判定看不见它**，所以健康检查必须报", () => {
  const a = state("state_01M6Q2FD00NVKBVBH80QD63VSX");
  const b = state("state_01M6Q2FD00NVKBVBH80QD63VSY", { created: "2026-10-01" });
  const report = runHealth({ assets: [a, b], today: TODAY });
  // 两条都报：人被指向的是"这个题面有问题"，而不是"后面那条是错的"。
  assert.equal(report.findings.filter((finding) => finding.code === HEALTH_CODES.DUPLICATE_ACTIVE).length, 2);
  assert.equal(report.findings.some((finding) => finding.code === HEALTH_CODES.ORPHAN), false);
});

test("过期断言：窗口内不报，超了才报（同一条资产，只差基准日）", () => {
  const fresh = state("state_01M6Q2FD00NVKBVBH80QD63VSX", { last_confirmed: "2026-11-01" });
  const freshness = (today: string): number =>
    runHealth({ assets: [fresh], today }).findings.filter((finding) => finding.code === ASSET_CODES.FRESHNESS).length;
  // 30 天的窗口：11-01 → 11-06 是 5 天，远没到期。
  assert.equal(freshness("2026-11-06"), 0);
  assert.equal(freshness("2026-12-15"), 1, "44 天，到期了");

  const expired = runHealth({ assets: [fresh], today: "2026-12-15" });
  assert.equal(expired.due.length, 1);
  assert.equal(expired.due[0]?.ageDays, 44);
  assert.equal(expired.due[0]?.windowDays, 30);
});

test("索引漂移：索引不存在 ≠ 索引一致", () => {
  const report = runHealth({
    assets: healthy(),
    today: TODAY,
    index: { indexed: null, actual: { sources: 1, events: 0 }, indexMarkdown: null },
  });
  assert.deepEqual(codes(report.findings), [HEALTH_CODES.INDEX_DRIFT]);
  assert.equal(report.findings[0]?.message.includes("索引层不存在"), true);
  // 这一条只是 warn：索引是派生数据，它坏了不影响正确性，只影响"读到的东西少一截"。
  assert.equal(report.findings[0]?.severity, "warn");
});

test("索引漂移：条数与资产 ID 集合都要比对", () => {
  const assets = healthy();
  const report = runHealth({
    assets,
    today: TODAY,
    events: [],
    index: {
      indexed: { sources: 9, events: 9, assets: 1, assetIds: ["state_不存在的"] },
      actual: { sources: 1, events: 0 },
      indexMarkdown: "错的内容",
    },
  });
  const drift = report.findings.filter((finding) => finding.code === HEALTH_CODES.INDEX_DRIFT);
  // 四件事各报一条：索引层记的东西、INDEX.md 的字节。
  assert.equal(drift.some((finding) => finding.message.includes("来源数 9 ≠ 1")), true);
  assert.equal(drift.some((finding) => finding.message.includes("索引里少了 4 条资产")), true);
  assert.equal(drift.some((finding) => finding.path === "index/INDEX.md"), true);
});

test("**没查**与「查过了没问题」必须分开（ADR-0009 的那条理由）", () => {
  const report = runHealth({ assets: healthy(), today: TODAY });
  assert.equal(report.unchecked.length, 2);
  assert.equal(report.unchecked.some((line) => line.includes("索引层")), true);
  assert.equal(report.unchecked.some((line) => line.includes("审计")), true);
});

test("审计链断掉 → 一个 error，而且**继续对账**（只报链条会让人以为修好链就没事了）", () => {
  const doc = state("state_01M6Q2FD00NVKBVBH80QD63VSX");
  const entries = [
    {
      seq: 3, // 缺号：第一条就该是 1
      at: "2026-11-06T10:00:00.000Z",
      actor: "allentire",
      kind: "asset-promoted" as const,
      subject: "state_01M6Q2FD00NVKBVBH80QD63VSY", // 库里没有这条
      detail: {},
      prev: "0".repeat(64),
      hash: "f".repeat(64),
    },
  ];
  const report = runHealth({ assets: [doc], today: TODAY, audit: { entries, problems: [] } });
  assert.equal(report.findings.some((finding) => finding.code === HEALTH_CODES.AUDIT_CHAIN_BROKEN), true);
  assert.equal(report.findings.some((finding) => finding.code === "AUDIT_DANGLING_SUBJECT"), true);
});

test("健康报告：同一份库、同一个基准日跑两次 —— **逐字节相同**（R6）", () => {
  const assets = [...healthy(), state("state_01M6Q2FD00NVKBVBH80QD63VSZ", { subject: "另一件事", sources: [SPAN_C] })];
  const first = renderHealthReport(runHealth({ assets, today: TODAY }));
  const second = renderHealthReport(runHealth({ assets: [...assets].reverse(), today: TODAY }));
  assert.equal(first, second, "输入顺序不该影响报告：排序键必须完全确定");
  assert.equal(first.includes("基准日 2026-11-06"), true);
  assert.equal(first.includes("先做这三件"), false, "没有需要处理的事时不该出现「先做这三件」");
});

test("健康报告：截断必须说出来", () => {
  const many = Array.from({ length: 25 }, (_, index) =>
    state(`state_01M6Q2FD00NVKBVBH80QD63V${String.fromCharCode(65 + index)}`, {
      subject: `第 ${String(index)} 件事`,
      sources: [SPAN_C],
    }),
  );
  const rendered = renderHealthReport(runHealth({ assets: many, today: "2027-01-01" }));
  assert.equal(rendered.includes("共 25 条"), true, "截断了就要说清楚一共有多少");
});

test("周报：**没有审计日志 ≠ 这一周什么都没发生**", () => {
  const report = runHealth({ assets: healthy(), today: TODAY });
  const withoutLog = renderWeeklyReport({ report, audit: null, weekStart: "2026-10-31", weekEnd: TODAY });
  assert.equal(withoutLog.includes("这不等于这一周什么都没发生"), true);

  const withEmptyLog = renderWeeklyReport({ report, audit: [], weekStart: "2026-10-31", weekEnd: TODAY });
  assert.equal(withEmptyLog.includes("这一周确实没有过写入"), true);
  assert.equal(withEmptyLog.includes("这不等于"), false);
});

test("周报：窗口与条目都是输入 —— 同一份数据跑两次字节相同", () => {
  const report = runHealth({ assets: healthy(), today: TODAY });
  const audit = [
    {
      seq: 1,
      at: "2026-11-04T09:00:00.000Z",
      actor: "allentire",
      kind: "state-confirmed" as const,
      subject: "state_01M6Q2FD00NVKBVBH80QD63VSX",
      detail: { note: "仍然是 sqlite" },
      prev: "0".repeat(64),
      hash: "a".repeat(64),
    },
  ];
  const first = renderWeeklyReport({ report, audit, weekStart: "2026-10-31", weekEnd: TODAY });
  const second = renderWeeklyReport({ report, audit, weekStart: "2026-10-31", weekEnd: TODAY });
  assert.equal(first, second);
  assert.equal(first.includes("state-confirmed：1 条"), true);
  assert.equal(first.includes("仍然是 sqlite"), true);
});

test("`confirm` 的自证：只许动 last_confirmed 一个字段", () => {
  const doc = state("state_01M6Q2FD00NVKBVBH80QD63VSX");
  const same = { ...doc.frontMatter, last_confirmed: "2026-12-01" };
  assert.deepEqual(unchangedExceptLastConfirmed(doc.frontMatter, same), []);

  // 顺手改了题面、正文出处、状态：每一种都必须被点名。
  const drifted = unchangedExceptLastConfirmed(doc.frontMatter, {
    ...same,
    subject: "换了个题面",
    status: "superseded",
    sources: [SPAN_B],
  });
  assert.deepEqual(drifted, ["sources", "status", "subject"]);
});
