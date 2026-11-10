/**
 * span 语法的尺子。
 *
 * 这里每条用例都对应一种**真实会写错的方式**：出处是硬约束，
 * 所以"什么样的出处才算数"必须被固定下来，而不是靠印象判断。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MIN_TEXT_ANCHOR_LENGTH,
  formatSpan,
  matchAnchor,
  normalizeText,
  parseLineRange,
  parseSpan,
} from "../src/provenance.ts";

test("parseSpan：典型 span 解析出 scheme / target / anchor", () => {
  const result = parseSpan("file://docs/implement2.md#t:没有 span 断言的资产不许入库");
  assert.equal(result.ok, true);
  assert.ok(result.ok);
  assert.equal(result.span.scheme, "file");
  assert.equal(result.span.target, "docs/implement2.md");
  assert.deepEqual(result.span.anchor, { kind: "t", payload: "没有 span 断言的资产不许入库" });
});

test("parseSpan：省略 anchor 合法（整份文件作为出处）", () => {
  const result = parseSpan("file://docs/directory.md");
  assert.ok(result.ok);
  assert.equal(result.span.anchor, null);
});

test("parseSpan：src:// 指向不可变来源片段", () => {
  const result = parseSpan("src://src_01M6QE3MZDZ9JE8EFMW27VAVKT#L3-L8");
  assert.ok(result.ok);
  assert.equal(result.span.scheme, "src");
  assert.equal(result.span.target, "src_01M6QE3MZDZ9JE8EFMW27VAVKT");
  assert.deepEqual(result.span.anchor, { kind: "L", payload: "L3-L8" });
});

test("parseSpan：片段里可以含 # 和 · （真实 incident 里就是这样）", () => {
  const result = parseSpan(
    "file://docs/adr/0004-no-speculative-packages-in-phase-0.md#t:implement2.md#Phase 0 · 常见失败",
  );
  assert.ok(result.ok);
  assert.equal(result.span.target, "docs/adr/0004-no-speculative-packages-in-phase-0.md");
  assert.deepEqual(result.span.anchor, {
    kind: "t",
    payload: "implement2.md#Phase 0 · 常见失败",
  });
});

test("parseSpan：拒绝不合法的写法（每一种都对应一个真实的写错方式）", () => {
  // 真注解而不是 JSDoc：`.ts` 文件里的 `@type` 只是注释，推断出来的 `string[][]`
  // 在 noUncheckedIndexedAccess 下会退化成 `string | undefined`（typecheck 实测）。
  const bad: Array<[string, string]> = [
    ["", "空 span"],
    ["docs/implement2.md#t:随便一段", "缺少 scheme://"],
    ["https://example.com/x", "未知 scheme（外部证据必须先落进 sources/）"],
    ["chatgpt://conv_abc123@2026-10-14#turn-7", "未知 scheme（v1 未接会话连接器）"],
    ["file://", "target 为空"],
    ["file://docs/implement2.md#", "anchor 为空"],
    ["file:///etc/passwd", "绝对路径"],
    ["file://C:/x.md", "Windows 绝对路径"],
    ["file://docs/../secret.md", "相对段落"],
    ["file://docs//a.md", "空路径段"],
    ["file://docs/a b.md", "含空白"],
    ["file://docs\\a.md", "反斜杠"],
    ["file://docs/adr/#t:abc", "以 / 结尾"],
    ["file://docs/a.md#x:abc", "未知 anchor 形式"],
    ["file://docs/a.md#t:太短", "片段太短"],
    ["file://docs/a.md#h:", "标题锚点为空"],
    ["file://docs/a.md#L0-L3", "行区间 0 基"],
    ["file://docs/a.md#L9-L3", "start > end"],
    ["file://docs/a.md#L1", "行区间缺结束"],
  ];
  for (const [raw, why] of bad) {
    const result = parseSpan(raw);
    assert.equal(result.ok, false, `本应拒绝：${raw}（${why}）`);
    assert.ok(!result.ok);
    assert.ok(result.reason.length > 0, `拒绝理由不能为空：${raw}`);
  }
});

test("formatSpan：规范化 —— 排版差异不该让同一处证据变成两处", () => {
  const loose = parseSpan("file://docs/a.md#t:多   空格\n与换行");
  const tight = parseSpan("file://docs/a.md#t:多 空格 与换行");
  assert.ok(loose.ok && tight.ok);
  assert.equal(formatSpan(loose.span), formatSpan(tight.span));
  assert.equal(formatSpan(tight.span), "file://docs/a.md#t:多 空格 与换行");
});

test("formatSpan：与 parseSpan 互为逆（canonical 形式逐字符稳定）", () => {
  const canonical = [
    "file://schema/provenance.md#h:Span 语法",
    "file://docs/implement2.md#t:把闸门写成 checklist",
    "file://scripts/gates/rehearse.mjs#L12-L20",
    "src://src_01M6QE3MZDZ9JE8EFMW27VAVKT",
  ];
  for (const raw of canonical) {
    const parsed = parseSpan(raw);
    assert.ok(parsed.ok, `本应合法：${raw}`);
    assert.equal(formatSpan(parsed.span), raw);
  }
});

test("parseLineRange：1 基、闭区间、start ≤ end", () => {
  assert.deepEqual(parseLineRange("L1-L1"), { start: 1, end: 1 });
  assert.deepEqual(parseLineRange("L3-L8"), { start: 3, end: 8 });
  assert.equal(parseLineRange("L0-L1"), null);
  assert.equal(parseLineRange("L8-L3"), null);
  assert.equal(parseLineRange("L1-3"), null);
  assert.equal(parseLineRange("l1-l3"), null);
});

test("matchAnchor #h: 命中标题，空白差异不影响", () => {
  const text = ["# 顶层", "", "## 选定", "内容", "##  后果  "].join("\n");
  assert.ok(matchAnchor({ kind: "h", payload: "选定" }, text).ok);
  assert.ok(matchAnchor({ kind: "h", payload: " 后果 " }, text).ok);
  const missed = matchAnchor({ kind: "h", payload: "考虑过的选项" }, text);
  assert.equal(missed.ok, false);
  assert.ok(!missed.ok);
  assert.match(missed.reason, /没有标题匹配/);
});

test("matchAnchor #t: 跨行片段命中（排版不该决定引用是否有效）", () => {
  const text = ["第一行", "把闸门写成", "checklist——checklist 天生会被跳过", "第四行"].join("\n");
  const hit = matchAnchor({ kind: "t", payload: "把闸门写成 checklist" }, text);
  assert.ok(hit.ok);
  assert.equal(hit.excerpt, "把闸门写成");
});

test("matchAnchor #L: 区间越界必须报红，而不是截断", () => {
  const text = ["a", "b", "c"].join("\n");
  const hit = matchAnchor({ kind: "L", payload: "L2-L3" }, text);
  assert.ok(hit.ok);
  assert.equal(hit.excerpt, "b c");
  const missed = matchAnchor({ kind: "L", payload: "L2-L9" }, text);
  assert.equal(missed.ok, false);
  assert.ok(!missed.ok);
  assert.match(missed.reason, /只有 3 行/);
});

test("matchAnchor：excerpt 有上限，且截断是确定的", () => {
  const long = "x".repeat(500);
  const hit = matchAnchor({ kind: "t", payload: "x".repeat(20) }, long);
  assert.ok(hit.ok);
  assert.equal(hit.excerpt.length, 161);
  assert.ok(hit.excerpt.endsWith("…"));
});

test("normalizeText：CRLF 与连续空白都折叠", () => {
  assert.equal(normalizeText("a\r\n b\t\tc  "), "a b c");
  assert.equal(MIN_TEXT_ANCHOR_LENGTH, 8);
});
