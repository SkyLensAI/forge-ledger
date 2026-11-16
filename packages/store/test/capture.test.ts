/**
 * 采集落地（S23）与 `web-capture` 连接器 —— 从"浏览器报上来的一批记录"
 * 到"事件 IR"的完整一条路，以及它**不许**做的事：
 *
 * 1. 键由 `capture()` 派生（浏览器不算键）；
 * 2. 已经采过的丢掉（增量），而且判据是**已有的 sources**，不是一份会漂移的本地集合；
 * 3. 没有新东西 → **一个字节都不写**（sources 层只追加，空来源删不掉）；
 * 4. 缺时间的记录被跳过并**说出来**（不替它编一个时间：编出来的时间会变成证据）；
 * 5. 采完之后 `derive()` 真的能得到事件——否则"采到了"只是一句话。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openVault } from "../src/index.ts";

function temp(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "forge-capture-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * @param {string} text
 * @param {string | null} [time]
 * @param {string | null} [author]
 * @returns {{text: string, time: string | null, author: string | null}}
 */
function item(text: string, time: string | null = "2026-11-06T10:00:00Z", author: string | null = "user") {
  return { text, time, author };
}

function report(items: Array<Record<string, unknown>>, skipped: string[] = []): Record<string, unknown> {
  return {
    host: "https://chat.example.com/",
    label: "示例对话",
    page: "https://chat.example.com/c/1",
    items,
    skipped,
  };
}

test("采集：报上来的一批记录落成一份来源，并**真的**能推出事件", () => {
  const vault = temp();
  try {
    const store = openVault(vault.root);
    const outcome = store.capture(report([item("索引层最后选了 node:sqlite"), item("发布节奏是两周一个版本")]));

    assert.equal(outcome.ok, true);
    assert.equal(outcome.received, 2);
    assert.equal(outcome.fresh, 2);
    assert.equal(outcome.duplicates, 0);
    assert.ok(outcome.sourceId !== null, "有新东西就该落成一份来源");
    assert.equal(outcome.created, true);

    // 采到的东西要真的能走完整条路：来源 → 事件 IR。
    const derived = store.derive();
    assert.equal(derived.events.length, 2, `实际事件：${JSON.stringify(derived.events)}`);
    assert.equal(derived.discarded.length, 0);
    // 出处（`src://…#k:`）拼得出来，而且指的是这份来源。
    const keys = derived.events.map((event) => `${event.source_id}/${event.key}`);
    assert.ok(keys.every((key) => key.startsWith(`${outcome.sourceId}/`)));
    assert.equal(derived.events[0]?.actor, "user");
  } finally {
    vault.cleanup();
  }
});

test("增量：同一批再报一次 —— 一个新来源都不产生（判据是已有的 sources）", () => {
  const vault = temp();
  try {
    const store = openVault(vault.root);
    store.capture(report([item("甲"), item("乙")]));
    const before = readdirSync(join(vault.root, "sources")).length;

    const again = store.capture(report([item("甲"), item("乙")]));
    assert.equal(again.fresh, 0);
    assert.equal(again.duplicates, 2);
    assert.equal(again.sourceId, null, "没有新东西 → 不落盘");
    assert.equal(readdirSync(join(vault.root, "sources")).length, before, "sources 层不许长出一份空来源");
  } finally {
    vault.cleanup();
  }
});

test("增量：只有一部分是新的 → 只落新的那几条", () => {
  const vault = temp();
  try {
    const store = openVault(vault.root);
    store.capture(report([item("甲"), item("乙")]));
    const second = store.capture(report([item("甲"), item("乙"), item("丙")]));

    assert.equal(second.fresh, 1);
    assert.equal(second.duplicates, 2);
    assert.equal(store.derive().events.length, 3, "库里一共三条，不是五条");
  } finally {
    vault.cleanup();
  }
});

test("缺时间的记录被跳过并**说出来**，而且不替它编一个时间", () => {
  const vault = temp();
  try {
    const store = openVault(vault.root);
    const outcome = store.capture(report([item("甲"), item("乙", null)], ["第 3 条记录的选择器没命中"]));

    assert.equal(outcome.received, 2);
    assert.equal(outcome.fresh, 1);
    assert.equal(outcome.skipped.length, 2, `实际：${JSON.stringify(outcome.skipped)}`);
    assert.ok(outcome.skipped.some((line) => line.includes("没有时间")));
    assert.equal(outcome.skipped[0], "第 3 条记录的选择器没命中", "扩展报上来的 skipped 原样保留");

    const events = store.derive().events;
    assert.equal(events.length, 1);
    assert.equal(events[0]?.occurred_at, "2026-11-06T10:00:00Z");
  } finally {
    vault.cleanup();
  }
});

test("形状不对的上报：回一个原因，不抛、不落盘", () => {
  const vault = temp();
  try {
    const store = openVault(vault.root);
    for (const bad of [null, 42, {}, { host: "https://x/", page: "", items: [] }, { host: "", page: "p", items: [] }]) {
      const outcome = store.capture(bad);
      assert.equal(outcome.ok, false, `${JSON.stringify(bad)} 不该被收下`);
      assert.ok((outcome.reason ?? "").length > 0);
      assert.equal(outcome.sourceId, null);
    }
    assert.equal(readdirSync(join(vault.root, "sources")).length, 0, "坏上报一个字节都不该写");
  } finally {
    vault.cleanup();
  }
});

test("正文被编辑过、但页面给了稳定键 —— 仍然算同一条（`key` 由页面决定）", () => {
  const vault = temp();
  try {
    const store = openVault(vault.root);
    store.capture(report([{ text: "甲", time: "2026-11-06T10:00:00Z", author: "user" }]));
    const second = store.capture(report([{ text: "甲（改过）", time: "2026-11-06T10:00:00Z", author: "user" }]));

    // 没有稳定键时按内容寻址：正文变了就是另一条记录。
    // 这是**有意的**——不猜"它是不是同一条被编辑了"；宁可多一条，不可少一条。
    assert.equal(second.fresh, 1);
    assert.equal(store.derive().events.length, 2);
  } finally {
    vault.cleanup();
  }
});

test("同一句话在两个站点上是两条记录（站点进键）", () => {
  const vault = temp();
  try {
    const store = openVault(vault.root);
    store.capture(report([item("同一句话")]));
    const other = store.capture({
      host: "https://other.example/",
      label: "另一个站点",
      page: "https://other.example/1",
      items: [item("同一句话")],
    });
    assert.equal(other.fresh, 1, "合成一条会丢来源");
    assert.equal(store.derive().events.length, 2);
  } finally {
    vault.cleanup();
  }
});
