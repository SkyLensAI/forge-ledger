/**
 * 对外 demo（S32）的尺子。
 *
 * 最关键的一条不是"页面好看"，而是**它真的来自输入**：
 * 每一条资产都有一页、`library.json` 的计数与输入一致、页面里不出现编造的样例；
 * 同时 HTML 必须转义——演示页不该成为执行库内容里的 `<script>` 的宿主。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SCHEMA_VERSION,
  renderAssetDocument,
  type AssetDoc,
  type AssetFrontMatter,
  type AssetType,
} from "@forge/schema";
import { assetPagePath, emitDemo, renderMarkdown } from "../src/demo.ts";

/**
 * @param {AssetType} type
 * @param {number} index
 * @param {string} [title]
 * @param {string} [body]
 * @returns {AssetDoc}
 */
function asset(type: AssetType, index: number, title = `资产 ${String(index)}`, body = ""): AssetDoc {
  const frontMatter: AssetFrontMatter = {
    schema_version: SCHEMA_VERSION,
    id: `${type === "decision" ? "dec" : type === "rule" ? "rule" : type === "state" ? "state" : "event"}_${String(index).padStart(26, "0")}`,
    type,
    status: type === "decision" ? "accepted" : type === "event" ? "recorded" : "active",
    created: "2026-11-06",
    last_confirmed: type === "state" ? "2026-11-06" : null,
    supersedes: null,
    origin_incident: type === "rule" ? "file://docs/implement2.md#t:把闸门写成 checklist" : null,
    subject: `${type}:${String(index)}`,
    sources: ["file://docs/implement2.md#t:把闸门写成 checklist"],
    sensitivity: "internal",
    confidence: 0.8,
  };
  const fullBody = `# ${title}\n\n${body}`;
  return {
    path: `assets/${type}/${String(index)}.md`,
    frontMatter,
    body: fullBody,
    raw: renderAssetDocument(frontMatter, fullBody),
  };
}

const ASSETS = [asset("decision", 1, "选 SQLite"), asset("state", 2, "索引层"), asset("rule", 3, "不许绕过闸门")];

test("demo 两次生成逐字节相同，且没有 CRLF / 时间戳", () => {
  const first = emitDemo({ assets: ASSETS, events: [] }, { source: "repo" });
  const second = emitDemo({ assets: [...ASSETS].reverse(), events: [] }, { source: "repo" });
  assert.deepEqual(first, second);
  for (const file of first) {
    assert.doesNotMatch(file.content, /\r/, `${file.path} 含 CRLF`);
    assert.doesNotMatch(file.content, /\d{2}:\d{2}:\d{2}/, `${file.path} 里出现了时间戳`);
  }
});

test("每条资产都有一页，index.json 计数与输入一致", () => {
  const files = emitDemo({ assets: ASSETS, events: [] }, { source: "repo" });
  const paths = new Set(files.map((file) => file.path));
  for (const doc of ASSETS) assert.equal(paths.has(assetPagePath(doc)), true, `缺 ${doc.frontMatter.id} 的页面`);

  const library = JSON.parse(files.find((file) => file.path === "library.json")?.content ?? "{}") as {
    source?: string;
    counts?: { total?: number };
    assets?: Array<{ id?: string; sources?: string[] }>;
  };
  assert.equal(library.source, "repo");
  assert.equal(library.counts?.total, ASSETS.length);
  assert.equal(library.assets?.length, ASSETS.length);
  for (const doc of ASSETS) assert.ok(library.assets?.some((item) => item.id === doc.frontMatter.id));
  assert.ok((library.assets?.[0]?.sources ?? []).length > 0, "demo 的条目必须带出处");
});

test("来自自己的库：index.html 里没有编造的样例声明", () => {
  const files = emitDemo({ assets: ASSETS, events: [] }, { source: "repo" });
  const index = files.find((file) => file.path === "index.html")?.content ?? "";
  assert.match(index, /本仓库自己的/);
  assert.match(index, /无外部脚本/);
  assert.equal(index.includes("src=\"http"), false);
  assert.equal(index.includes("href=\"http"), false);
});

test("HTML 转义：标题与正文里的标签都按文本显示", () => {
  const malicious = asset("decision", 9, "<b>标题</b>", "<script>alert(1)</script>\n");
  const files = emitDemo({ assets: [malicious], events: [] }, { source: "repo" });
  for (const file of files) {
    assert.equal(file.content.includes("<script>alert(1)</script>"), false, `${file.path} 原样输出了 script`);
  }
  const page = files.find((file) => file.path === assetPagePath(malicious))?.content ?? "";
  assert.match(page, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test("Markdown 渲染器：标题 / 列表 / 代码 / 安全链接", () => {
  const html = renderMarkdown(
    "# 标题\n\n- 一\n- 二\n\n```ts\nconst x = 1;\n```\n\n[好](https://example.com) [坏](javascript:alert(1))\n",
  );
  assert.match(html, /<h1>标题<\/h1>/);
  assert.match(html, /<ul><li>一<\/li><li>二<\/li><\/ul>/);
  assert.match(html, /<pre><code class="language-ts">const x = 1;<\/code><\/pre>/);
  assert.match(html, /<a href="https:\/\/example.com"/);
  assert.equal(html.includes('href="javascript:'), false);
});

test("空库也能生成一份诚实的空 demo", () => {
  const files = emitDemo({ assets: [], events: [] }, { source: "vault" });
  const index = files.find((file) => file.path === "index.html")?.content ?? "";
  assert.match(index, /共 0 条/);
  assert.equal(files.filter((file) => file.path.startsWith("assets/")).length, 0);
});
