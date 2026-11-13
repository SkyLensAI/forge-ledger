/**
 * store 三层的尺子（S8 / ADR-0015）。
 *
 * 这里守的是三条**权限规则**——它们是这个阶段唯一不可逆的东西：
 *   `sources/` 只读、`assets/` 可写、`index/` 删掉能重建。
 * 每条规则都有一个"看着像小事"的破坏方式，用例就是照着那些方式写的。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSION } from "@forge/schema";
import { officialExportConnector } from "@forge/ingest";
import { openVault } from "../src/vault.ts";

const FIXTURE = join(process.cwd(), "evals/fixtures/desensitized-export.json");

/**
 * @returns {{root: string, cleanup: () => void}}
 */
function tempVault() {
  const root = mkdtempSync(join(tmpdir(), "forge-vault-"));
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("导入是内容寻址的：同一份导出导入两次只产生一个来源", () => {
  const vault = tempVault();
  try {
    const store = openVault(vault.root);
    const text = readFileSync(FIXTURE, "utf8");

    const first = store.importText(text, { originalName: "export.json" });
    const second = store.importText(text, { originalName: "export.json" });

    assert.equal(first.created, true);
    assert.equal(second.created, false, "同样的字节不该产生第二份来源——否则事件会翻倍");
    assert.equal(first.meta.id, second.meta.id);
    assert.equal(store.sources.list().length, 1);
  } finally {
    vault.cleanup();
  }
});

test("内容变了 ID 就变：来源层的「不可改」被执行成「改了就是另一份」", () => {
  const vault = tempVault();
  try {
    const store = openVault(vault.root);
    const a = store.importText('{"conversations":[{"id":"c","messages":[]}]}', { originalName: "a.json" });
    const b = store.importText('{"conversations":[{"id":"c","messages":[]}]} ', { originalName: "a.json" });
    assert.notEqual(a.meta.id, b.meta.id);
    assert.equal(store.sources.list().length, 2);
  } finally {
    vault.cleanup();
  }
});

test("sources 层被外部动过时报错，而不是顺手覆盖", () => {
  const vault = tempVault();
  try {
    const store = openVault(vault.root);
    const text = '{"conversations":[{"id":"c","messages":[]}]}';
    const imported = store.importText(text, { originalName: "a.json" });

    // 模拟"有人手改了 meta"——内容寻址下这不可达，真发生了说明目录被外部改过。
    const metaPath = join(vault.root, "sources", imported.meta.id, "meta.json");
    writeFileSync(metaPath, JSON.stringify({ id: imported.meta.id, sha256: "被人改过" }), "utf8");

    assert.throws(
      () => store.importText(text, { originalName: "a.json" }),
      /sources\/ 是只读层/,
      "覆盖来源层是本系统最不可逆的动作，宁可炸掉",
    );
  } finally {
    vault.cleanup();
  }
});

test("compile：事件进 index，不进 assets（ADR-0016）", () => {
  const vault = tempVault();
  try {
    const store = openVault(vault.root);
    store.importText(readFileSync(FIXTURE, "utf8"), { originalName: "export.json" });
    const report = store.compile();

    assert.ok(report.events.length >= 8, `fixture 应该产出多条事件，实际 ${report.events.length}`);
    assert.equal(report.assets.length, 0, "来源的投影不该变成资产：没有人判断过它们值不值得记");
    assert.equal(existsSync(join(vault.root, "assets", "event")), false);
    assert.equal(existsSync(join(vault.root, "index", "forge.sqlite")), true);
    assert.equal(existsSync(join(vault.root, "index", "INDEX.md")), true);
  } finally {
    vault.cleanup();
  }
});

test("compile：丢弃要记账（fixture 里有一条故意缺时间戳的消息）", () => {
  const vault = tempVault();
  try {
    const store = openVault(vault.root);
    store.importText(readFileSync(FIXTURE, "utf8"), { originalName: "export.json" });
    const report = store.compile();
    assert.ok(report.discarded.length >= 1, "静默丢弃会让「导入 1000 条」和「导入 999 条」看起来一样");
    assert.ok(report.discarded.some((item) => item.reason.includes("时间戳")));
  } finally {
    vault.cleanup();
  }
});

test("compile 是幂等的：跑两次，索引层的计数一致", () => {
  const vault = tempVault();
  try {
    const store = openVault(vault.root);
    store.importText(readFileSync(FIXTURE, "utf8"), { originalName: "export.json" });
    const first = store.compile();
    const afterFirst = store.index.counts();
    const second = store.compile();

    assert.equal(second.events.length, first.events.length);
    assert.deepEqual(store.index.counts(), afterFirst);
  } finally {
    vault.cleanup();
  }
});

test("index 层删掉能重建：删了整个目录，重建后计数一样", () => {
  const vault = tempVault();
  try {
    const store = openVault(vault.root);
    store.importText(readFileSync(FIXTURE, "utf8"), { originalName: "export.json" });
    store.compile();
    const before = store.index.counts();
    assert.ok(before !== null);

    // 判据是"删掉它会不会丢东西"——所以这条用例就是真的把它删掉。
    rmSync(join(vault.root, "index"), { recursive: true, force: true });
    assert.equal(openVault(vault.root).index.counts(), null, "索引不存在时应返回 null，而不是假装有空索引");

    openVault(vault.root).compile();
    assert.deepEqual(openVault(vault.root).index.counts(), before);
  } finally {
    vault.cleanup();
  }
});

test("出处解析：src://#k: 指到具体那一条记录，且由**连接器**判定", () => {
  const vault = tempVault();
  try {
    const store = openVault(vault.root);
    const imported = store.importText(readFileSync(FIXTURE, "utf8"), { originalName: "export.json" });
    const index = store.spanIndex([vault.root]);

    const keys = officialExportConnector.parse(readFileSync(FIXTURE, "utf8")).records.map((record) => record.key);
    const firstKey = keys[0];
    assert.ok(firstKey !== undefined);

    assert.equal(index.lookup(`src://${imported.meta.id}#k:${firstKey}`).kind, "resolved");
    assert.equal(index.lookup(`src://${imported.meta.id}#k:conv_cache/msg_9999`).kind, "unresolved");
    // 不存在的来源：解析不了，而不是"没查"。
    assert.equal(index.lookup("src://src_01M6Q2FD002MW3PYGNRES1PGRW#k:a/b").kind, "unresolved");
  } finally {
    vault.cleanup();
  }
});

test("出处解析：没有来源层的宿主报 unavailable ——「无法校验」不是「通过」", async () => {
  const { buildSpanIndex } = await import("../src/spans.ts");
  // 这正是 CI 的处境：`data/` 被 gitignore，所以它根本看不到 sources/。
  // 传 `sources: null` 而不是"一个空 vault"——空 vault 仍然有来源层，
  // 两者的输出必须不同（这正是这条用例要钉住的东西）。
  const ci = buildSpanIndex({ sources: null, workspaces: [process.cwd()] });
  const fact = ci.lookup("src://src_01M6Q2FD002MW3PYGNRES1PGRW#k:a/b");
  assert.equal(fact.kind, "unavailable");
});

test("出处解析：file:// 走工作区，找不到就是 unresolved", () => {
  const vault = tempVault();
  const workspace = mkdtempSync(join(tmpdir(), "forge-workspace-"));
  try {
    // 自包含的工作区：不依赖本仓库里可能被移动或删除的文档。
    writeFileSync(
      join(workspace, "source.md"),
      "# Release gate\n\nA gate must be a checkpoint, not a checklist.\n",
      "utf8",
    );
    const store = openVault(vault.root);
    const index = store.spanIndex([workspace]);
    assert.equal(index.lookup("file://source.md#t:A gate must be a checkpoint").kind, "resolved");
    assert.equal(index.lookup("file://source.md#h:Release gate").kind, "resolved");
    assert.equal(index.lookup("file://source.md#t:this sentence does not exist").kind, "unresolved");
    assert.equal(index.lookup("file://missing.md").kind, "unresolved");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    vault.cleanup();
  }
});

test("assets 层：读不动的文件被记下来，不静默跳过", () => {
  const vault = tempVault();
  try {
    const store = openVault(vault.root);
    const dir = join(vault.root, "assets", "dec");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "broken.md"), "---\nid: 不是合法 ID\n---\n\n# 坏资产\n", "utf8");
    const scan = store.assets.scan();
    assert.equal(scan.docs.length, 0);
    assert.equal(scan.invalid.length, 1);
    assert.match(scan.invalid[0]?.reason ?? "", /id/);
  } finally {
    vault.cleanup();
  }
});

test("仓库里的资产能被读出来：约定即集合（ADR-0012）", async () => {
  const { readRepoAssets } = await import("../src/vault.ts");
  const { docs, invalid } = readRepoAssets(process.cwd());
  assert.deepEqual(invalid, [], `本仓库不该有读不动的资产：${JSON.stringify(invalid)}`);
  assert.ok(docs.length >= 14, `应该至少读到 14 条 ADR，实际 ${docs.length}`);
  // schema/ 是宪法不是资产：它必须被排除在检索范围外。
  assert.equal(docs.some((doc) => doc.path.startsWith("schema/")), false);
  // spec/ 是公开规范仓的导出源，不是本仓库的资产库；示例账本不能混进自举计数。
  assert.equal(docs.some((doc) => doc.path.startsWith("spec/")), false);
  assert.ok(docs.every((doc) => doc.frontMatter.schema_version === SCHEMA_VERSION));
});
