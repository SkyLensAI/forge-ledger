/**
 * 选择器与增量采集的尺子（S23）—— 五条性质：
 *
 * 1. **坏配置要能被指出来**：逐条问题，而不是一句"格式不对"。
 *    一份"看起来能跑"的坏配置会在采集时静静地采到空内容，而空内容与
 *    "这个站点没有新东西"长得一模一样。
 * 2. **热更新的方向是确定的**：revision 大的赢，相同则远端赢。
 *    配了反例——"本地永远赢"的实现会让一次扩展更新把远端的热修倒退回去。
 * 3. **站点匹配是最长前缀赢**，而且不依赖配置里的先后顺序。
 * 4. **键是内容寻址的、形状合法**：它会被拼进 `src://…#k:`，形状不对的键在引用时才会炸。
 * 5. **增量只留没见过的**，而且"本条之内重复"也算重复。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CAPTURE_PAYLOAD_VERSION,
  SELECTOR_CONFIG_VERSION,
  buildCapturePayload,
  captureKeyOf,
  chooseSelectorConfig,
  decideSelectorRevision,
  freshItems,
  hostForUrl,
  hostSlugOf,
  parseSelectorConfig,
  type SelectorConfig,
} from "../src/index.ts";

/** 与 `@forge/schema` 的 `KEY_PATTERN` 同一把尺子：键要能拼进 `src://…#k:`。 */
const KEY_PATTERN = /^[^\s/\\]+(\/[^\s/\\]+)*$/;

function config(overrides: Partial<SelectorConfig> = {}): SelectorConfig {
  return {
    config_version: SELECTOR_CONFIG_VERSION,
    revision: 1,
    updated_at: "2026-11-06",
    hosts: [
      { match: "https://chat.example.com/", label: "示例对话", item: ".msg", fields: { text: ".body" } },
    ],
    ...overrides,
  };
}

const RAW = {
  config_version: 1,
  revision: 2,
  updated_at: "2026-11-06",
  hosts: [{ match: "https://a.example/", label: "A", item: ".m", fields: { text: ".t" } }],
};

// ─────────────────────────────────────────────────────────────────────────────
// 1 · 坏配置要能被指出来
// ─────────────────────────────────────────────────────────────────────────────

test("解析：合法配置原样收下（多余的字段忽略，前向兼容）", () => {
  const parsed = parseSelectorConfig({ ...RAW, extra_field: "未来的东西" });
  assert.ok(parsed.ok);
  assert.equal(parsed.value.revision, 2);
  assert.equal(parsed.value.hosts.length, 1);
  assert.equal(parsed.value.hosts[0]?.label, "A");
});

test("解析：坏配置逐条报问题，而不是一句「格式不对」", () => {
  const parsed = parseSelectorConfig({
    config_version: 99,
    revision: -1,
    updated_at: "昨天",
    hosts: [
      { match: "", label: "A", item: ".m", fields: { text: ".t" } },
      { match: "https://b.example/", label: "B", item: ".m", fields: {} },
    ],
  });
  assert.ok(!parsed.ok);
  assert.equal(parsed.issues.length, 5, `实际：${parsed.issues.join(" | ")}`);
  assert.ok(parsed.issues.some((issue) => issue.includes("config_version")));
  assert.ok(parsed.issues.some((issue) => issue.includes("revision")));
  assert.ok(parsed.issues.some((issue) => issue.includes("updated_at")));
  assert.ok(parsed.issues.some((issue) => issue.includes("hosts[0].match")));
  assert.ok(parsed.issues.some((issue) => issue.includes("hosts[1].fields.text")));
});

test("反例：未知的 config_version **不猜**（猜错的表现是采到空内容）", () => {
  const parsed = parseSelectorConfig({ ...RAW, config_version: SELECTOR_CONFIG_VERSION + 1 });
  assert.ok(!parsed.ok);
  assert.ok(parsed.issues.some((issue) => issue.includes("不猜")));
});

// ─────────────────────────────────────────────────────────────────────────────
// 2 · 热更新的方向
// ─────────────────────────────────────────────────────────────────────────────

test("热更新：revision 大的赢，相同则远端赢", () => {
  const bundled = config({ revision: 3 });

  const older = chooseSelectorConfig(bundled, { ...RAW, revision: 2 });
  assert.equal(older.source, "bundled", "远端更旧 → 用本地（免得把远端的热修倒退回去）");

  const same = chooseSelectorConfig(bundled, { ...RAW, revision: 3 });
  assert.equal(same.source, "remote", "一样新 → 用远端（它是活的那一份）");

  const newer = chooseSelectorConfig(bundled, { ...RAW, revision: 4 });
  assert.equal(newer.source, "remote");
  assert.equal(newer.config.revision, 4);
});

test("热更新：远端拿不到 / 坏了 → 退回本地的**同一份**，而且原因写清楚", () => {
  const bundled = config({ revision: 3 });
  const missing = chooseSelectorConfig(bundled, null);
  assert.equal(missing.source, "bundled");
  assert.equal(missing.config, bundled);

  const broken = chooseSelectorConfig(bundled, { config_version: 1, revision: 9 });
  assert.equal(broken.source, "bundled", "一份坏配置不该让采集整个停摆");
  assert.match(broken.why, /解析不动/);
});

test("`decideSelectorRevision` 是给浏览器用的那一半：回一个结论，不回比较过程", () => {
  assert.deepEqual(decideSelectorRevision(1, null), {
    use: "local",
    why: "远端没有配置（拿不到 / 没配过）：用你手里那一份",
  });
  const remote = decideSelectorRevision(1, RAW);
  assert.equal(remote.use, "remote");
  assert.equal(remote.use === "remote" ? remote.config.revision : -1, 2);
  assert.equal(decideSelectorRevision(5, RAW).use, "local");
});

// ─────────────────────────────────────────────────────────────────────────────
// 3 · 站点匹配
// ─────────────────────────────────────────────────────────────────────────────

test("站点匹配：最长前缀赢，且不依赖配置里的先后顺序", () => {
  const short = { match: "https://example.com/", label: "根", item: ".m", fields: { text: ".t" } };
  const long = { match: "https://example.com/a/b", label: "深处", item: ".m", fields: { text: ".t" } };

  const straight = config({ hosts: [short, long] });
  const reversed = config({ hosts: [long, short] });
  assert.equal(hostForUrl(straight, "https://example.com/a/b/c")?.label, "深处");
  assert.equal(hostForUrl(reversed, "https://example.com/a/b/c")?.label, "深处");
  assert.equal(hostForUrl(straight, "https://example.com/x")?.label, "根");
  assert.equal(hostForUrl(straight, "https://other.example/"), null, "没命中就是 null，不许兜底到第一条");
});

// ─────────────────────────────────────────────────────────────────────────────
// 4 · 键
// ─────────────────────────────────────────────────────────────────────────────

test("键：内容寻址、形状合法、站点进种子", () => {
  const a = captureKeyOf({ host: "https://chat.example.com/", rawKey: null, text: "两周一个版本。" });
  const b = captureKeyOf({ host: "https://chat.example.com/", rawKey: null, text: "两周一个版本。" });
  const other = captureKeyOf({ host: "https://other.example/", rawKey: null, text: "两周一个版本。" });

  assert.equal(a, b, "同样的站点 + 同样的正文 = 同一条记录");
  assert.notEqual(a, other, "两个站点上的一模一样的一句话是两条独立记录");
  assert.match(a, KEY_PATTERN, "键要能拼进 src://…#k:，形状不对的键在引用时才会炸");
  assert.match(a, /^https-chat-example-com\//, "站点标识进键的第一段");
  // 排版不算内容：空白折叠之后相同就是同一条。
  assert.equal(
    a,
    captureKeyOf({ host: "https://chat.example.com/", rawKey: null, text: "两周一个版本。" }),
  );
});

test("键：页面给了稳定键时用它（正文被编辑之后仍是同一条）", () => {
  const first = captureKeyOf({ host: "https://chat.example.com/", rawKey: "msg_42", text: "甲" });
  const edited = captureKeyOf({ host: "https://chat.example.com/", rawKey: "msg_42", text: "甲（改过）" });
  assert.equal(first, edited, "稳定键优先：编辑过的旧消息不该被当成新记录采一遍");
});

test("站点 slug：只留下能进键的字符，空的有兜底", () => {
  assert.equal(hostSlugOf("https://chat.example.com/"), "https-chat-example-com");
  assert.equal(hostSlugOf("///"), "host");
  assert.match(hostSlugOf(""), KEY_PATTERN);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5 · 增量
// ─────────────────────────────────────────────────────────────────────────────

test("增量：只留没见过的；本次之内的重复也算重复", () => {
  const items = [
    { key: "h/1", text: "甲", author: null, time: null },
    { key: "h/2", text: "乙", author: null, time: null },
    { key: "h/1", text: "甲", author: null, time: null },
  ];
  const first = freshItems(items, []);
  assert.deepEqual(first.fresh.map((item) => item.key), ["h/1", "h/2"]);
  assert.equal(first.duplicates, 1);

  const second = freshItems(items, ["h/1", "h/2"]);
  assert.equal(second.fresh.length, 0);
  assert.equal(second.duplicates, 3);
});

test("载荷：键排序（R6）、空载荷不产生", () => {
  const payload = buildCapturePayload({
    host: "https://chat.example.com/",
    label: "示例对话",
    page: "https://chat.example.com/c/1",
    items: [
      { key: "h/2", text: "乙", author: null, time: null },
      { key: "h/1", text: "甲", author: "user", time: "2026-11-06T10:00:00Z" },
    ],
  });
  assert.ok(payload !== null);
  assert.equal(payload.capture_version, CAPTURE_PAYLOAD_VERSION);
  assert.deepEqual(payload.items.map((item) => item.key), ["h/1", "h/2"]);

  assert.equal(
    buildCapturePayload({ host: "h", label: "l", page: "p", items: [] }),
    null,
    "空载荷不落盘：一份空来源与「这个站点没有新东西」在下游看起来一样",
  );
});
