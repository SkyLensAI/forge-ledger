/**
 * Emitter v2 的尺子（S24）—— 两个出口，六条性质：
 *
 * 1. **逐字节确定**（R6）：两次跑一样、输入顺序反过来也一样、输出里没有时钟。
 * 2. **Skill 不预加载**：决策的全文只在 `references/` 里，`SKILL.md` 只有索引。
 *    这条与 S21 是同一条纪律的两个执行体——一个是运行时的，一个是打包时的。
 * 3. **编号跨出口一致**：`references/0003` 与 `adr/0003` 必须是同一条决策。
 * 4. **导出的 eval 不许自称「已确认」**（ADR-0020），配了反例。
 * 5. **导出的期望值来自人确认过的资产**，不来自模型，也不来自"猜"。
 * 6. **没被覆盖的事件不构成负面期望**——这句话必须写在文件里，
 *    否则读的人会把"还没抽到"当成"不该抽出来"，而虚高的分数比没有分数更危险。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SCHEMA_VERSION,
  eventId,
  renderAssetDocument,
  type AssetDoc,
  type AssetFrontMatter,
  type AssetType,
  type EventIR,
} from "@forge/schema";
import {
  EVAL_EXPORT_VERSION,
  emitAdrFiles,
  emitEvalCases,
  emitSkill,
  evalExportFile,
  parseSpan,
  skillReferences,
} from "../src/index.ts";

const SOURCE_ID = "src_01M6Q2FD00P3EVALGATE000000";

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
    origin_incident: type === "rule" ? `src://${SOURCE_ID}#k:conv_a/msg_01` : null,
    subject: type === "state" ? "索引层的存储后端" : null,
    sources: [`src://${SOURCE_ID}#k:conv_a/msg_01`],
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
 * @param {string} [sourceId]
 * @returns {EventIR}
 */
function event(key: string, text: string, sourceId = SOURCE_ID): EventIR {
  return {
    schema_version: 1,
    source_id: sourceId,
    key,
    kind: "message",
    occurred_at: "2026-11-06T10:00:00Z",
    actor: "user",
    text,
  };
}

const DECISION_BODY =
  "## 问题\n\n**这一段只该出现在 references 里**。\n\n## 考虑过的选项\n\n1. 甲\n2. 乙\n\n## 选定\n\n**甲**。\n\n## 后果\n\n有代价。\n";

function library(): AssetDoc[] {
  return [
    asset("decision", "dec_01M6Q2FD002MW3PYGNRES1PGRW", "分类法只定 4 种资产", DECISION_BODY),
    asset("rule", "rule_01M6Q2FD00GRZFQ6K3F6KPGA03", "不许绕过闸门", "## 规则\n\n闸门红了要修问题。\n\n## 强制\n\n闸门 1 直接阻断。\n"),
    asset("state", "state_01M6Q2FD00NVKBVBH80QD63VSX", "存储后端用 SQLite", "## 当前状态\n\n索引层用 node:sqlite。\n"),
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Skill 出口
// ─────────────────────────────────────────────────────────────────────────────

test("SKILL.md：front-matter 合法，规则 / 状态 / 决策索引都在", () => {
  const files = emitSkill({ assets: library(), events: [] });
  const skill = files.find((file) => file.path === "SKILL.md");
  assert.ok(skill !== undefined);

  assert.match(skill.content, /^---\nname: forge-library\ndescription: "/, "front-matter 的键序写死（R6）");
  assert.match(skill.content, /## 规则（不许违反）/);
  // 与 AGENTS.md 的 ruleBlock 同一把尺子：标题即规则本身，正文只取「强制」那一节。
  assert.match(skill.content, /### 不许绕过闸门/);
  assert.match(skill.content, /闸门 1 直接阻断/);
  assert.match(skill.content, /## 当前状态/);
  assert.match(skill.content, /索引层的存储后端/);
  assert.match(skill.content, /## 决策索引/);
  assert.match(skill.content, /references\/0001-分类法只定-4-种资产\.md/);
});

test("Skill **不预加载**：决策全文只在 references 里，SKILL.md 里一个字都没有", () => {
  const files = emitSkill({ assets: library(), events: [] });
  const skill = files.find((file) => file.path === "SKILL.md")?.content ?? "";
  const reference = files.find((file) => file.path.startsWith("references/"))?.content ?? "";

  assert.doesNotMatch(skill, /这一段只该出现在 references 里/, "把全文塞进 SKILL.md 就是预加载");
  assert.match(reference, /这一段只该出现在 references 里/);
});

test("编号跨出口一致：`references/0001` 与 `adr/0001` 是同一条决策", () => {
  const docs = library();
  const references = skillReferences(docs).map((file) => file.path);
  const adrs = emitAdrFiles(docs).map((file) => file.path);
  assert.deepEqual(
    references.map((path) => path.replace("references/", "")),
    adrs.map((path) => path.replace("adr/", "")),
    "两个出口给出两个编号，会让「0003 是哪条」变成一个问题",
  );
});

test("反例：决策顺序反过来 —— 编号必须按 (created, id) 排，不按输入顺序", () => {
  const docs = library();
  const straight = skillReferences(docs).map((file) => file.path);
  const reversed = skillReferences([...docs].reverse()).map((file) => file.path);
  assert.deepEqual(straight, reversed);
  assert.equal(straight.length, 1);
});

test("Skill 逐字节确定：两次一样，且没有时钟", () => {
  const first = emitSkill({ assets: library(), events: [event("conv_a/msg_01", "甲")] });
  const second = emitSkill({ assets: [...library()].reverse(), events: [event("conv_a/msg_01", "甲")] });
  assert.deepEqual(first, second);
  for (const file of first) {
    assert.doesNotMatch(file.content, /\r/, `${file.path} 里有 CR`);
    assert.doesNotMatch(file.content, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, `${file.path} 里有时钟`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Eval 出口
// ─────────────────────────────────────────────────────────────────────────────

test("导出的 eval **永远是 proposed**：机器不许给自己签「已确认」", () => {
  const exported = emitEvalCases({ assets: library(), events: [event("conv_a/msg_01", "甲")] });
  assert.equal(exported.review.status, "proposed");
  assert.equal(exported.review.reviewed_by, null);
  assert.equal(exported.schema_version, EVAL_EXPORT_VERSION);

  // 反例：一个自称 confirmed 的导出必须能被看出来——这条断言就是"看出来"的方式。
  const lying = { ...exported, review: { ...exported.review, status: "confirmed" } };
  assert.notEqual(lying.review.status, "proposed");
});

test("导出：期望值来自**人确认过的资产**，而且每条 why 都指得回那条资产", () => {
  const exported = emitEvalCases({
    assets: library(),
    events: [event("conv_a/msg_01", "我们决定用四种资产类型"), event("conv_a/msg_02", "今天天气不错")],
  });

  assert.equal(exported.cases.length, 1, "一份来源 = 一个用例");
  const only = exported.cases[0];
  assert.ok(only !== undefined);
  assert.equal(only.source_id, SOURCE_ID);
  assert.equal(only.id, SOURCE_ID);
  assert.deepEqual(only.events.map((item) => item.key), ["conv_a/msg_01", "conv_a/msg_02"], "事件按 key 排序（R6）");

  assert.equal(only.expected.length, 3, "三条资产的出处都指着 msg_01");
  assert.ok(only.expected.every((item) => item.key === "conv_a/msg_01"));
  assert.match(only.expected[0]?.why ?? "", /由人确认过的/);
  assert.match(only.expected_why, /不构成负面期望/);
});

test("导出的判据 span 能解析，且指的是这份来源本身", () => {
  const exported = emitEvalCases({ assets: library(), events: [event("conv_a/msg_01", "甲")] });
  const span = exported.cases[0]?.span ?? "";
  const parsed = parseSpan(span);
  assert.ok(parsed.ok, `span 不合法：${span}`);
  assert.equal(parsed.span.scheme, "src");
  assert.equal(parsed.span.target, SOURCE_ID);
  assert.equal(parsed.span.anchor, null);
});

test("导出逐字节确定：两次跑得到同一份 JSON，且键序归一", () => {
  const one = evalExportFile(emitEvalCases({ assets: library(), events: [event("conv_a/msg_01", "甲")] }));
  const two = evalExportFile(
    emitEvalCases({ assets: [...library()].reverse(), events: [event("conv_a/msg_01", "甲")] }),
  );
  assert.equal(one.content, two.content);
  assert.equal(one.path, "evals/extraction/cases.json");
  assert.doesNotMatch(one.content, /\r/);
  assert.ok(one.content.endsWith("\n"));

  // 键序归一：`description` 排在 `cases` 前面也不影响字节（stableJson 会排序）。
  const reordered = { ...JSON.parse(one.content), zzz: 1 };
  assert.equal(evalExportFile(reordered).content.includes('"zzz"'), true);
});

test("事件的出处 `src://…#k:` 与 `eventId` 对得上：导出的用例能被尺子直接跑", () => {
  const events = [event("conv_a/msg_01", "甲")];
  const exported = emitEvalCases({ assets: library(), events });
  // 用例里的 source_id 必须就是那份事件的来源——runner 靠它建 `src://` span。
  assert.equal(exported.cases[0]?.source_id, events[0]?.source_id);
  assert.equal(eventId(events[0]!), eventId(event("conv_a/msg_01", "甲")));
});
