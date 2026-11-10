/**
 * 采集层的测试（S9 / S23）。
 *
 * 这两个连接器是**纯解析器**：喂固定字符串、拿记录。所以这里不碰文件系统，
 * 也不碰时钟——`isoSecond` 的每一条断言都是一个固定输入对应一个固定输出。
 *
 * 重点不是"能解析正常文件"，而是**失败时留下什么**：
 *   1. 记录级失败必须进 `skipped`，不能静默丢；
 *   2. 原文不许被改写（只允许行尾归一）；
 *   3. `accepts` 不能把别的 JSON 认成自己的格式。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONNECTORS,
  connectorById,
  detectConnector,
  isoSecond,
  officialExportConnector,
  webCaptureConnector,
  OFFICIAL_EXPORT_CONNECTOR_ID,
  WEB_CAPTURE_CONNECTOR_ID,
} from "../src/index.ts";

// ─────────────────────────────────────────────────────────────────────────────
// official-export
// ─────────────────────────────────────────────────────────────────────────────

const EXPORT = JSON.stringify({
  conversations: [
    {
      id: "conv_1",
      messages: [
        {
          id: "msg_1",
          sender: "user",
          created_at: "2026-10-14T09:12:03.123456+08:00",
          content: { parts: ["第一段", "第二段"] },
        },
        {
          id: "msg_2",
          author: { role: "assistant" },
          timestamp: 1760433123,
          text: "只有一段",
        },
      ],
    },
  ],
});

test("official-export：顶层数组与 conversations/chats/threads 都认", () => {
  for (const payload of [
    JSON.stringify([{ id: "c", messages: [] }]),
    JSON.stringify({ chats: [{ id: "c", messages: [] }] }),
    JSON.stringify({ threads: [{ id: "c", messages: [] }] }),
  ]) {
    assert.equal(officialExportConnector.accepts(payload), true, payload.slice(0, 40));
  }
  assert.equal(officialExportConnector.accepts("{}"), false);
  assert.equal(officialExportConnector.accepts("not json"), false);
});

test("official-export：正常解析——key、时间归一、content.parts 拼接、行尾归一", () => {
  const result = officialExportConnector.parse(EXPORT);
  assert.deepEqual(result.skipped, []);
  assert.equal(result.records.length, 2);

  assert.deepEqual(result.records[0], {
    key: "conv_1/msg_1",
    // 带偏移的时间被折成 UTC、秒精度
    occurred_at: "2026-10-14T01:12:03Z",
    actor: "user",
    text: "第一段\n第二段",
  });
  assert.equal(result.records[1]?.actor, "assistant");
  assert.equal(result.records[1]?.occurred_at, "2025-10-14T09:12:03Z");
});

test("official-export：记录级失败进 skipped，不猜、不静默丢", () => {
  const result = officialExportConnector.parse(
    JSON.stringify({
      conversations: [
        { messages: [{ id: "m", created_at: "2026-01-01T00:00:00Z", text: "没有会话 id" }] },
        { id: "conv_no_messages" },
        {
          id: "conv_bad",
          messages: [
            { created_at: "2026-01-01T00:00:00Z", text: "没有消息 id" },
            { id: "no_time", text: "没有时间" },
            { id: "bad_time", created_at: "not-a-date", text: "坏时间" },
            { id: "no_text", created_at: "2026-01-01T00:00:00Z" },
          ],
        },
      ],
    }),
  );
  assert.equal(result.records.length, 0);
  assert.equal(result.skipped.length, 6);
  assert.match(result.skipped.map((item) => item.reason).join("\n"), /会话没有 id/);
  assert.match(result.skipped.map((item) => item.reason).join("\n"), /找不到消息数组/);
  assert.match(result.skipped.map((item) => item.reason).join("\n"), /消息没有 id/);
  assert.match(result.skipped.map((item) => item.reason).join("\n"), /时间戳缺失或无法解析/);
  assert.match(result.skipped.map((item) => item.reason).join("\n"), /没有正文/);
});

test("official-export：原文只做行尾归一（CRLF → LF）", () => {
  const result = officialExportConnector.parse(
    JSON.stringify({
      conversations: [
        {
          id: "c",
          messages: [{ id: "m", created_at: "2026-01-01T00:00:00Z", text: "a\r\nb\rc" }],
        },
      ],
    }),
  );
  assert.equal(result.records[0]?.text, "a\nb\nc");
});

test("official-export：isoSecond 认得 ISO、epoch 秒与毫秒；坏值返回 null", () => {
  assert.equal(isoSecond("2026-10-14T09:12:03Z"), "2026-10-14T09:12:03Z");
  assert.equal(isoSecond("2026-10-14T09:12:03.999+08:00"), "2026-10-14T01:12:03Z");
  assert.equal(isoSecond("1760433123"), "2025-10-14T09:12:03Z");
  assert.equal(isoSecond("1760433123000"), "2025-10-14T09:12:03Z");
  assert.equal(isoSecond("2024-02-29T00:00:00Z"), "2024-02-29T00:00:00Z");
  // 形状对、日期不存在：不许被静默归一成 3 月 3 日。
  assert.equal(isoSecond("2026-02-31T00:00:00Z"), null);
  assert.equal(isoSecond("  "), null);
  assert.equal(isoSecond("not-a-date"), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// web-capture
// ─────────────────────────────────────────────────────────────────────────────

test("web-capture：accepts 要同时命中 capture_version 与 host", () => {
  assert.equal(webCaptureConnector.accepts(JSON.stringify({ capture_version: 1, host: "x", items: [] })), true);
  assert.equal(webCaptureConnector.accepts(JSON.stringify({ host: "x", items: [] })), false);
  assert.equal(webCaptureConnector.accepts(JSON.stringify({ capture_version: "1", host: "x", items: [] })), false);
  assert.equal(webCaptureConnector.accepts(JSON.stringify({ capture_version: 1, items: [] })), false);
  assert.equal(webCaptureConnector.accepts(JSON.stringify([{ capture_version: 1, host: "x" }])), false);
});

test("web-capture：正常解析——key 原样收下、actor 缺失落 unknown、时间必须严格 UTC 秒", () => {
  const result = webCaptureConnector.parse(
    JSON.stringify({
      capture_version: 1,
      host: "example.com",
      items: [
        {
          key: "example.com/abc123",
          body: "正文",
          occurred_at: "2026-11-06T10:00:00Z",
          author: "user",
        },
        {
          key: "example.com/def456",
          content: "另一条",
          time: "2026-11-06T10:01:00Z",
        },
      ],
    }),
  );
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.records[0], {
    key: "example.com/abc123",
    occurred_at: "2026-11-06T10:00:00Z",
    actor: "user",
    text: "正文",
  });
  assert.equal(result.records[1]?.actor, "unknown");
});

test("web-capture：坏记录进 skipped（key 形状、正文、时间）", () => {
  const result = webCaptureConnector.parse(
    JSON.stringify({
      capture_version: 1,
      host: "example.com",
      items: [
        "不是对象",
        { body: "没有 key", time: "2026-11-06T10:00:00Z" },
        { key: "a b", body: "key 里有空白", time: "2026-11-06T10:00:00Z" },
        { key: "site/ok", body: "   ", time: "2026-11-06T10:00:00Z" },
        { key: "site/ok", body: "没有时间" },
        { key: "site/ok", body: "毫秒不收", time: "2026-11-06T10:00:00.000Z" },
        { key: "site/ok", body: "不存在的日期", time: "2026-02-31T00:00:00Z" },
      ],
    }),
  );
  assert.equal(result.records.length, 0);
  assert.equal(result.skipped.length, 7);
  const reasons = result.skipped.map((item) => item.reason).join("\n");
  assert.match(reasons, /不是对象/);
  assert.match(reasons, /没有 key/);
  assert.match(reasons, /形状不合法/);
  assert.match(reasons, /没有正文/);
  assert.match(reasons, /没有时间/);
  assert.match(reasons, /UTC、秒精度/);
  assert.match(reasons, /形状不合法|不是 YYYY-MM-DDTHH:MM:SSZ/);
});

test("web-capture：原文只做行尾归一", () => {
  const result = webCaptureConnector.parse(
    JSON.stringify({
      capture_version: 1,
      host: "example.com",
      items: [{ key: "site/a", text: "a\r\nb", time: "2026-11-06T10:00:00Z" }],
    }),
  );
  assert.equal(result.records[0]?.text, "a\nb");
});

// ─────────────────────────────────────────────────────────────────────────────
// 注册表与自动识别
// ─────────────────────────────────────────────────────────────────────────────

test("连接器注册表：按 id 找回同一个解析器；自动识别按登记顺序", () => {
  assert.equal(CONNECTORS.size, 2);
  assert.equal(connectorById(OFFICIAL_EXPORT_CONNECTOR_ID), officialExportConnector);
  assert.equal(connectorById(WEB_CAPTURE_CONNECTOR_ID), webCaptureConnector);
  assert.equal(connectorById("missing"), null);

  assert.equal(detectConnector(EXPORT), officialExportConnector);
  assert.equal(
    detectConnector(JSON.stringify({ capture_version: 1, host: "example.com", items: [] })),
    webCaptureConnector,
  );
  assert.equal(detectConnector("{}"), null);
});
