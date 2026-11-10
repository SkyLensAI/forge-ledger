/**
 * 模型接缝与信任边界的测试。
 *
 * 这个文件里最要紧的一组不是"模型抽得准不准"（那是尺子的事），
 * 而是**模型说错话时会发生什么**：编造的出处会不会溜进去、
 * 置信度会不会被顶到高位、抛错的模型会不会被静默当成"什么都没抽出来"。
 *
 * 每条断言都配了它的**反面**：一个只在正常输入上跑通的信任边界，
 * 与一个不存在的信任边界，在测试报告上长得一模一样（R8）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { newFrontMatter } from "@forge/schema";
import {
  LOW_CONFIDENCE,
  buildExtractionRequest,
  extractFromModel,
  judgeCandidates,
  parseExtractionResponse,
  sanitizeCandidates,
  type CandidateAssertion,
  type ExtractionInput,
  type Model,
} from "../src/index.ts";

const SOURCE_ID = "src_01M6Q2FD00P3EVALGATE000000";

/**
 * 造一个输入。事件顺序**故意是乱的**：提示词的确定性靠排序，
 * 而"输入顺序恰好也是排好的"会让那条性质测不出来。
 *
 * @returns {ExtractionInput}
 */
function input(): ExtractionInput {
  return {
    sourceId: SOURCE_ID,
    events: [
      {
        schema_version: 1,
        source_id: SOURCE_ID,
        key: "conv_b/msg_02",
        kind: "message",
        occurred_at: "2026-01-02T00:00:00Z",
        actor: "assistant",
        text: "第二条。",
      },
      {
        schema_version: 1,
        source_id: SOURCE_ID,
        key: "conv_a/msg_01",
        kind: "message",
        occurred_at: "2026-01-01T00:00:00Z",
        actor: "user",
        text: "第一条。",
      },
    ],
  };
}

/**
 * @param {unknown[]} items
 * @returns {string}
 */
function respondWith(items: unknown[]): string {
  return JSON.stringify({ assertions: items });
}

/**
 * @param {string} text
 * @param {string} [id]
 * @returns {Model}
 */
function modelSaying(text: string, id = "stub"): Model {
  return { id, complete: () => ({ text }) };
}

test("R6：同一份输入渲染两次，提示词逐字节相同（事件顺序不影响）", () => {
  const a = buildExtractionRequest(input());
  const reversed: ExtractionInput = { sourceId: SOURCE_ID, events: [...input().events].reverse() };
  const b = buildExtractionRequest(reversed);
  assert.equal(a.user, b.user);
  assert.equal(a.system, b.system);
  assert.equal(a.max_tokens, b.max_tokens);
  // 排序确实发生了：conv_a 在 conv_b 前面。
  assert.ok(a.user.indexOf("conv_a/msg_01") < a.user.indexOf("conv_b/msg_02"));
});

test("提示词里带上了来源 ID 与全部事件键（模型不该猜键）", () => {
  const request = buildExtractionRequest(input());
  assert.ok(request.user.includes(SOURCE_ID));
  assert.ok(request.user.includes("conv_a/msg_01"));
  assert.ok(request.user.includes("conv_b/msg_02"));
});

test("LOW_CONFIDENCE 与 schema 新建资产时的默认置信度是同一个数", () => {
  // 两个 0.3 分开写就会各自漂移，而"低置信度起步"这条规则判的就是这个数。
  const fresh = newFrontMatter("decision", "dec_01M6Q2FD00P3EVALGATE000000", "2026-11-06");
  assert.equal(fresh.confidence, LOW_CONFIDENCE);
});

test("解析：容忍 Markdown 代码块，但外壳以内一步不让", () => {
  const fenced = parseExtractionResponse('```json\n{"assertions":[]}\n```');
  assert.equal(fenced.ok, true);

  const bare = parseExtractionResponse('前面一句废话 {"assertions":[{"a":1}]} 后面一句废话');
  assert.equal(bare.ok, true);

  for (const broken of ["", "   ", "这不是 JSON", '{"assertions":{}}', '[1,2,3]', '{"items":[]}']) {
    const parsed = parseExtractionResponse(broken);
    assert.equal(parsed.ok, false, `「${broken}」本该解析失败`);
    if (!parsed.ok) assert.ok(parsed.reason.length > 0, "失败必须带原因，否则没人能去调 harness");
  }
});

test("sanitize：编造的出处被裁掉；一条都留不下时整条丢弃", () => {
  const result = sanitizeCandidates(input(), [
    {
      type: "decision",
      title: "编造",
      body: "",
      sources: [`src://${SOURCE_ID}#k:conv_z/msg_99`],
      confidence: 0.9,
    },
  ]);

  assert.equal(result.candidates.length, 0);
  assert.equal(result.discarded.length, 1);
  assert.equal(result.discarded[0]?.code, "CAND_NO_SOURCES");
  // 裁剪本身也要留痕：静默裁剪会让"模型很准"这个印象没有任何反例。
  assert.equal(result.notes.length, 1);
  assert.equal(result.notes[0]?.code, "CAND_SPAN_NOT_IN_INPUT");
});

test("sanitize：出处是**重建**出来的，不是模型写什么就存什么", () => {
  const messy = `  src://${SOURCE_ID}#k:conv_a/msg_01  `;
  const result = sanitizeCandidates(input(), [
    { type: "state", title: "现状", body: "", sources: [messy], confidence: 0.4 },
  ]);

  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.candidates[0]?.sources, [`src://${SOURCE_ID}#k:conv_a/msg_01`]);
});

test("sanitize：置信度被压到入库上界，且压了几条要留痕", () => {
  const result = sanitizeCandidates(input(), [
    {
      type: "rule",
      title: "拉满",
      body: "",
      sources: [`src://${SOURCE_ID}#k:conv_a/msg_01`],
      confidence: 1,
    },
  ]);

  assert.equal(result.candidates[0]?.confidence, LOW_CONFIDENCE);
  assert.equal(result.notes.filter((note) => note.code === "CAND_CONFIDENCE_FORCED").length, 1);
});

test("sanitize：类型不在受控词表、没有标题、根本不是对象 —— 整条丢", () => {
  const items = [
    { type: "insight", title: "自造类型", body: "", sources: [], confidence: 0.5 },
    { type: "event", title: "  ", body: "", sources: [`src://${SOURCE_ID}#k:conv_a/msg_01`], confidence: 0.5 },
    // 非对象也归到 `CAND_TYPE_UNKNOWN`：它连"是什么类型"都读不出来。
    // 给它们单开一个码会让码表随"输入有多畸形"增长，而修法其实是同一条。
    "字符串不是对象",
    null,
  ];
  const result = sanitizeCandidates(input(), items);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.discarded.length, 4);
  assert.deepEqual(
    result.discarded.map((item) => item.code).sort(),
    ["CAND_NO_TITLE", "CAND_TYPE_UNKNOWN", "CAND_TYPE_UNKNOWN", "CAND_TYPE_UNKNOWN"],
  );
  // 定位优先用**事件键**（它不随响应里条目的顺序变），读不出键时才退回下标。
  // 第 2 条虽然标题为空、被丢掉了，但它的出处指得到一条真事件，所以用键定位。
  assert.deepEqual(
    result.discarded.map((item) => item.at),
    ["#0", "k:conv_a/msg_01", "#2", "#3"],
  );
});

test("sanitize：出处去重并排序（同一处证据说两遍不算两处）", () => {
  const result = sanitizeCandidates(input(), [
    {
      type: "event",
      title: "两处",
      body: "",
      sources: [
        `src://${SOURCE_ID}#k:conv_b/msg_02`,
        `src://${SOURCE_ID}#k:conv_a/msg_01`,
        `src://${SOURCE_ID}#k:conv_b/msg_02`,
      ],
      confidence: 0.5,
    },
  ]);
  assert.deepEqual(result.candidates[0]?.sources, [
    `src://${SOURCE_ID}#k:conv_a/msg_01`,
    `src://${SOURCE_ID}#k:conv_b/msg_02`,
  ]);
});

test("sanitize 的产出**永远**过得了 judgeCandidates（边界不许有第二套标准）", () => {
  const hostile = [
    { type: "rule", title: "a", body: "", sources: [`src://${SOURCE_ID}#k:conv_a/msg_01`], confidence: 1 },
    { type: "state", title: "b", body: "", sources: ["file://x.md#t:一段足够长的片段"], confidence: 0.5 },
    { type: "event", title: "c", body: "", sources: [`src://${SOURCE_ID}#k:不存在`], confidence: 0.5 },
    { type: "event", title: "d", body: "", sources: ["乱写"], confidence: 0.5 },
  ];
  const result = sanitizeCandidates(input(), hostile);
  assert.deepEqual(judgeCandidates(input(), result.candidates), []);
});

test("sanitize 的产出都带 origin=model —— 守卫靠这个值挡住它们", () => {
  const result = sanitizeCandidates(input(), [
    {
      type: "rule",
      title: "合法",
      body: "",
      sources: [`src://${SOURCE_ID}#k:conv_a/msg_01`],
      confidence: 0.5,
    },
  ]);
  assert.equal(result.candidates[0]?.origin, "model");
});

test("extractFromModel：响应读不成形状时整批作废，且**留痕**", () => {
  const extraction = extractFromModel(input(), modelSaying("我拒绝输出 JSON"));
  assert.equal(extraction.candidates.length, 0);
  assert.equal(extraction.discarded.length, 1);
  assert.equal(extraction.discarded[0]?.code, "CAND_RESPONSE_UNPARSEABLE");
  // 原始响应必须留着：它是诊断"该怎么改 harness"的唯一材料。
  assert.equal(extraction.response, "我拒绝输出 JSON");
});

test("extractFromModel：harness 与 model 会进产出（报告要能回答「谁抽的」）", () => {
  const extraction = extractFromModel(input(), modelSaying(respondWith([]), "录像里的模型"));
  assert.equal(extraction.model, "录像里的模型");
  assert.ok(extraction.harness.startsWith("extraction-v"));
});

test("模型抛错不吞：整条链路报错，而不是静默返回空候选", () => {
  const broken: Model = {
    id: "broken",
    complete() {
      throw new Error("端点 500");
    },
  };
  assert.throws(() => extractFromModel(input(), broken), /端点 500/);
});

test("候选的排序是确定的（同一次抽取跑两次，报告字节相同）", () => {
  const items = [
    { type: "state", title: "二", body: "", sources: [`src://${SOURCE_ID}#k:conv_b/msg_02`], confidence: 0.5 },
    { type: "decision", title: "一", body: "", sources: [`src://${SOURCE_ID}#k:conv_a/msg_01`], confidence: 0.5 },
  ];
  const first: CandidateAssertion[] = sanitizeCandidates(input(), items).candidates;
  const second: CandidateAssertion[] = sanitizeCandidates(input(), [...items].reverse()).candidates;
  assert.deepEqual(first, second);
});
