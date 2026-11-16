/**
 * 迁移通道的尺子（ADR-0008）。
 *
 * 这一组用例守两件事：
 *   1. **机械的部分真的机械**——同样的输入永远得到同样的输出，且幂等；
 *   2. **转不了的部分必须留下痕迹**——安静地跳过等于把"一个月后发现出处是假的"
 *      变成必然事件。ADR-0009 那条 origin_incident 就是这么来的。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { convertV0Span, migrateAssetText, migrateV0ToV1, planMigration } from "../migrate/index.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * fixture 的扩展名**不是** `.md`，这是有意的。
 *
 * ADR-0012 的资产集合判据是"带 front-matter 的 markdown"，而且刻意不留例外
 * （"漏登记的资产不受检查、也不发出信号"）。但这份 fixture 是 v0 的样本——
 * 它**故意**不合规：`schema_version` 缺失、出处置是 v0 写法。
 * 如果它叫 `.md`，仓库级资产闸门会把它当成一条坏资产报红。
 *
 * 解法不是给闸门开一个 `fixtures/` 例外（那会造出一个藏东西的地方），
 * 而是承认：**fixture 是输入，不是资产**——用扩展名把这件事说清楚。
 */
const V0_FIXTURE = join(HERE, "fixtures", "v0-adr.fixture");

test("区间规划：连续区间、空区间、缺口、回退", () => {
  assert.deepEqual(
    planMigration(0, 1).map((step) => `${step.from}->${step.to}`),
    ["0->1"],
  );
  assert.deepEqual(planMigration(1, 1), []);
  assert.throws(() => planMigration(1, 3), /区间缺口/);
  assert.throws(() => planMigration(2, 1), /不能往低版本迁移/);
});

test("v0 的出处写法 → v1 span（相对 docs/ 的路径）", () => {
  assert.equal(convertV0Span("implement2.md#Phase 0 · S3"), "file://docs/implement2.md#t:Phase 0 · S3");
  assert.equal(convertV0Span("directory.md"), "file://docs/directory.md");
});

test("v0 的出处写法 → v1 span（仓库顶层目录的路径不加 docs/）", () => {
  assert.equal(
    convertV0Span("scripts/gates/rehearse.mjs#场景 A 删掉校验后 CI 崩溃"),
    "file://scripts/gates/rehearse.mjs#t:场景 A 删掉校验后 CI 崩溃",
  );
  assert.equal(convertV0Span("packages/core/src/index.ts#L1-L9"), "file://packages/core/src/index.ts#L1-L9");
});

test("转不了的**不猜**：太短的锚点宁可留着报红", () => {
  // `场景 A` 归一化后只有 4 个字符：任何文档里都能命中，等于没有定位能力。
  // 猜一个位置写进去会让一条假出处看起来像真的——那比留着报红糟得多。
  assert.equal(convertV0Span("scripts/gates/rehearse.mjs#场景 A"), null);
  assert.equal(convertV0Span("路径 里 有 空 格.md#随便一段"), null);
});

test("迁移：补 schema_version + 转换能转的出处", () => {
  const v0 = readFileSync(V0_FIXTURE, "utf8");
  const outcome = migrateV0ToV1(v0);
  assert.match(outcome.text, /^---\nschema_version: 1\nid: dec_/);
  assert.match(outcome.text, /file:\/\/docs\/implement2\.md#t:Phase 0 · S3/);
  // 变体的锚点形态（`2.3 把「清单」变成「闸门」`）也要被认出来。
  assert.match(outcome.text, /file:\/\/docs\/implement1\.md#t:2\.3 把「清单」变成「闸门」/);
  assert.deepEqual(outcome.notes, []);
  // 正文一字不动：迁移不该顺手重排资产的正文。
  assert.match(outcome.text, /# 闸门的权威只来自服务端/);
});

test("迁移是幂等的：重复跑不产生第二个 schema_version", () => {
  const v0 = readFileSync(V0_FIXTURE, "utf8");
  const once = migrateV0ToV1(v0).text;
  const twice = migrateV0ToV1(once);
  assert.equal(twice.text, once);
  assert.equal(once.match(/schema_version:/g)?.length, 1);
});

test("自由文本的 origin_incident 只记 note，不被硬塞成假 span", () => {
  const text = [
    "---",
    "id: dec_01M6QE6A1F7ZK2NQ0T8H4WY3VB",
    "type: decision",
    'origin_incident: "Phase 0 演练场景 A：删掉闸门代码后 CI 不是判定为红，而是崩溃"',
    "sources:",
    '  - "implement2.md#Phase 0 · S3"',
    "---",
    "",
    "# 标题",
    "",
  ].join("\n");

  const outcome = migrateV0ToV1(text);
  assert.equal(outcome.notes.length, 1);
  assert.match(outcome.notes[0] ?? "", /自由文本/);
  // 值本身没被改：编造一个引用比留着报红糟得多。
  assert.match(outcome.text, /origin_incident: "Phase 0 演练场景 A：删掉闸门代码后 CI 不是判定为红，而是崩溃"/);
});

test("migrateAssetText：从 v0 一路迁到目标版本", () => {
  const v0 = readFileSync(V0_FIXTURE, "utf8");
  const { text, notes } = migrateAssetText(v0, 0, 1);
  assert.deepEqual(notes, []);
  assert.match(text, /schema_version: 1/);
});
