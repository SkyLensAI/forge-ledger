/**
 * `content.js` 的 DOM 胶水测试（S23）。
 *
 * 上一版这里只测了**结构**（文件存在、语法合法、没有 import）。结构测不出
 * "相对时间换算对不对"、"选择器没命中时有没有留下原因"——而这两件事恰好是
 * 浏览器一改版就会坏的地方。
 *
 * CI 里没有浏览器，但 `content.js` 本身不依赖浏览器对象的具体实现：
 * 它只用 `document.querySelector(All)`、`textContent`、`getAttribute`
 * 和一个 `chrome.runtime.onMessage` 回调。这里用最小的假 DOM 把它跑起来，
 * 时钟用固定的 `Date` 子类冻住——于是"3 分钟前"有确定答案。
 *
 * 这仍然**不是**真实浏览器测试：布局、Shadow DOM、跨域 iframe 都不在覆盖里。
 * 它覆盖的是纯逻辑那一段，剩下的记账在 `apps/extension/README.md`。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const SRC = join(process.cwd(), "apps", "extension", "src", "content.js");
const NOW = Date.parse("2026-11-06T10:00:00Z");

class FrozenDate extends Date {
  constructor(value?: string | number | Date) {
    super(value === undefined ? NOW : value);
  }
  static override now(): number {
    return NOW;
  }
}

interface FakeEl {
  textContent: string | null;
  getAttribute(name: string): string | null;
  querySelector(selector: string): FakeEl | null;
  querySelectorAll(selector: string): FakeEl[];
}

/**
 * @param {{text?: string, datetime?: string, children?: Record<string, FakeEl>, lists?: Record<string, FakeEl[]>}} options
 */
function el(options: {
  text?: string | null;
  datetime?: string;
  children?: Record<string, FakeEl>;
  lists?: Record<string, FakeEl[]>;
} = {}): FakeEl {
  return {
    textContent: options.text ?? null,
    getAttribute: (name) => (name === "datetime" ? options.datetime ?? null : null),
    querySelector: (selector) => options.children?.[selector] ?? null,
    querySelectorAll: (selector) => options.lists?.[selector] ?? [],
  };
}

type Handler = (message: unknown, sender: unknown, sendResponse: (value: unknown) => void) => boolean;

function load(document: FakeEl): Handler {
  let handler: Handler | null = null;
  const chrome = {
    runtime: {
      onMessage: {
        addListener: (fn: Handler) => {
          handler = fn;
        },
      },
    },
  };
  vm.runInNewContext(readFileSync(SRC, "utf8"), { chrome, document, Date: FrozenDate, console });
  if (handler === null) assert.fail("content.js 没有注册 onMessage 监听器");
  return handler;
}

/**
 * @param {Handler} handler
 * @param {unknown} message
 */
function send(handler: Handler, message: unknown): { called: boolean; value: unknown } {
  let called = false;
  let value: unknown = undefined;
  const returned = handler(message, null, (response) => {
    called = true;
    value = response;
  });
  assert.equal(returned, false, "监听器必须同步 sendResponse，然后返回 false");
  return { called, value };
}

test("content：绝对时间读 datetime 属性，相对时间用宿主的时钟折成 UTC 秒", () => {
  const root = el({
    lists: {
      ".item": [
        el({
          children: {
            ".text": el({ text: "第一条" }),
            ".author": el({ text: "张三" }),
            ".time": el({ text: "10:00", datetime: "2026-11-06T10:00:00+08:00" }),
          },
        }),
        el({
          children: {
            ".text": el({ text: "第二条" }),
            ".time": el({ text: "3 分钟前" }),
          },
        }),
      ],
    },
  });
  const document = el({ children: { ".list": root } });
  const handler = load(document);

  const result = send(handler, {
    type: "forge:read-page",
    host: { list: ".list", item: ".item", fields: { text: ".text", author: ".author", time: ".time" } },
  });

  // `vm` 里的对象与测试文件不是同一个 realm，原型不同；按 JSON 值比较。
  assert.deepEqual(JSON.parse(JSON.stringify(result.value)), {
    items: [
      { text: "第一条", author: "张三", time: "2026-11-06T02:00:00Z" },
      { text: "第二条", author: null, time: "2026-11-06T09:57:00Z" },
    ],
    skipped: [],
  });
});

test("content：选择器没命中时有原因，不是静默返回空", () => {
  const document = el({ children: {} });
  const handler = load(document);

  const missingList = send(handler, {
    type: "forge:read-page",
    host: { list: ".missing", item: ".item", fields: { text: ".text" } },
  });
  assert.equal((missingList.value as { items: unknown[]; skipped: string[] }).items.length, 0);
  assert.match((missingList.value as { skipped: string[] }).skipped.join("\n"), /列表容器.*没找到/);

  const root = el({
    lists: {
      ".item": [
        el({ children: { ".text": el({ text: "   " }) } }),
        el({ children: {} }),
      ],
    },
  });
  const documentWithRoot = el({ children: { ".list": root } });
  const handlerWithRoot = load(documentWithRoot);
  const empty = send(handlerWithRoot, {
    type: "forge:read-page",
    host: { list: ".list", item: ".item", fields: { text: ".text" } },
  });
  const skipped = (empty.value as { skipped: string[] }).skipped.join("\n");
  assert.match(skipped, /正文为空/);
});

test("content：不是 forge 的消息不响应；没有选择器配置时说清楚原因", () => {
  const document = el({});
  const handler = load(document);

  const other = send(handler, { type: "something-else" });
  assert.equal(other.called, false);

  const noHost = send(handler, { type: "forge:read-page", host: null });
  assert.equal(noHost.called, true);
  assert.match((noHost.value as { skipped: string[] }).skipped.join("\n"), /没有配置选择器/);
});

test("content：解不开的时间是 null，不拿「现在」顶替", () => {
  const root = el({
    lists: {
      ".item": [
        el({
          children: {
            ".text": el({ text: "时间解不开" }),
            ".time": el({ text: "昨天 12:03" }),
          },
        }),
      ],
    },
  });
  const document = el({ children: { ".list": root } });
  const handler = load(document);
  const result = send(handler, {
    type: "forge:read-page",
    host: { list: ".list", item: ".item", fields: { text: ".text", time: ".time" } },
  });
  assert.equal((result.value as { items: Array<{ time: string | null }> }).items[0]?.time, null);
});
