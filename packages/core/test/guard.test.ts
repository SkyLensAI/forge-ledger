/**
 * 入库守卫的测试 —— 尤其是那条**不可配置**的判据。
 *
 * 守卫存在的全部理由是：模型产出永远不直接进 `assets/`。
 * 所以这个文件里最要紧的一条断言是"把置信度拉满、把策略放到最松，它仍然进不去"——
 * 如果那条性质只靠 `admit_confidence` 撑着，它就只是一个默认值，
 * 而默认值会被改（implement1.md 反模式 6）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ADMISSION,
  ADMISSION_REASONS,
  DEFAULT_GUARD_POLICY,
  LOW_CONFIDENCE,
  guardCandidates,
  modelLeaks,
  type CandidateAssertion,
  type CandidateOrigin,
  type ExtractionInput,
} from "../src/index.ts";

const SOURCE_ID = "src_01M6Q2FD00P3EVALGATE000000";

/**
 * @returns {ExtractionInput}
 */
function input(): ExtractionInput {
  return {
    sourceId: SOURCE_ID,
    events: [
      {
        schema_version: 1,
        source_id: SOURCE_ID,
        key: "conv_a/msg_01",
        kind: "message",
        occurred_at: "2026-01-01T00:00:00Z",
        actor: "user",
        text: "一条真实存在的事件。",
      },
    ],
  };
}

/**
 * @param {Partial<CandidateAssertion>} [overrides]
 * @returns {CandidateAssertion}
 */
function candidate(overrides: Partial<CandidateAssertion> = {}): CandidateAssertion {
  return {
    type: "rule",
    title: "一条候选",
    subject: null,
    body: "",
    sources: [`src://${SOURCE_ID}#k:conv_a/msg_01`],
    confidence: LOW_CONFIDENCE,
    origin: "code",
    ...overrides,
  };
}

test("默认策略的入库线**必须**高于低置信度起点（否则两道判据塌掉一道）", () => {
  assert.ok(
    DEFAULT_GUARD_POLICY.admit_confidence > LOW_CONFIDENCE,
    "入库线不高于 LOW_CONFIDENCE 时，模型产出会从置信度那道门被放进去",
  );
});

test("模型产出永不自动入库 —— 哪怕置信度拉满、策略放到最松", () => {
  for (const confidence of [LOW_CONFIDENCE, 0.9, 1]) {
    const result = guardCandidates(input(), [candidate({ confidence, origin: "model" })], {
      admit_confidence: 0,
    });
    assert.equal(result.admitted.length, 0, `置信度 ${String(confidence)} 的模型产出被放行了`);
    assert.equal(result.inboxed.length, 1);
    assert.equal(result.inboxed[0]?.reason, ADMISSION_REASONS.MODEL_NEVER_AUTO);
  }
});

test("非模型来源按置信度线分流", () => {
  const admitted = guardCandidates(input(), [candidate({ confidence: 0.9, origin: "code" })]);
  assert.equal(admitted.admitted.length, 1);
  assert.equal(admitted.admitted[0]?.reason, ADMISSION_REASONS.CLEARED);

  const below = guardCandidates(input(), [candidate({ confidence: 0.5, origin: "code" })]);
  assert.equal(below.admitted.length, 0);
  assert.equal(below.inboxed[0]?.reason, ADMISSION_REASONS.BELOW_THRESHOLD);
});

test("出处站不住的一律拒绝，**即使上游没有 sanitize 过**", () => {
  const result = guardCandidates(input(), [
    candidate({ sources: [`src://${SOURCE_ID}#k:编造的键`] }),
    candidate({ sources: ["file://docs/x.md#t:一段足够长的片段"] }),
    candidate({ sources: [] }),
    candidate({ title: "" }),
  ]);
  assert.equal(result.rejected.length, 4);
  assert.equal(result.inboxed.length, 0);
  assert.equal(result.admitted.length, 0);
  for (const decision of result.rejected) {
    assert.equal(decision.reason, ADMISSION_REASONS.PROVENANCE_UNVERIFIED);
    assert.ok(decision.violations.length > 0, "拒绝必须带明细与修法，否则闸门输出退化成"
      + "「报了个错」");
    for (const violation of decision.violations) assert.ok(violation.fix.length > 0);
  }
});

test("类型不在受控词表里的一律拒绝（守卫**自己**查一遍，不靠上游）", () => {
  const alien = { ...candidate(), type: "insight" } as unknown as CandidateAssertion;
  const result = guardCandidates(input(), [alien]);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0]?.violations[0]?.code, "CAND_TYPE_UNKNOWN");
});

test("两条标题一样的候选不会串位（逐条判，不整批判完再配对）", () => {
  const clean = candidate({ title: "同名", confidence: 0.9 });
  const dirty = candidate({ title: "同名", sources: [`src://${SOURCE_ID}#k:不存在`] });

  const result = guardCandidates(input(), [clean, dirty]);
  assert.equal(result.admitted.length, 1);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.admitted[0]?.candidate.sources[0], `src://${SOURCE_ID}#k:conv_a/msg_01`);
  assert.equal(result.rejected[0]?.candidate.sources[0], `src://${SOURCE_ID}#k:不存在`);
});

test("modelLeaks 只在守卫被改松时才非空", () => {
  const good = guardCandidates(input(), [candidate({ origin: "model", confidence: 1 })]);
  assert.deepEqual(modelLeaks(good), []);

  // 造一个"守卫被改松"的结果：直接把模型产出塞进 admitted。
  const leaky = {
    admitted: [
      {
        candidate: candidate({ origin: "model", confidence: 1 }),
        admission: ADMISSION.ADMIT,
        reason: ADMISSION_REASONS.CLEARED,
        violations: [],
      },
    ],
    inboxed: [],
    rejected: [],
  };
  assert.equal(modelLeaks(leaky).length, 1);
});

test("判定的顺序无关：输入顺序反过来，三份名单不变", () => {
  const list = [
    candidate({ title: "甲", confidence: 0.9, origin: "code" }),
    candidate({ title: "乙", confidence: 0.1, origin: "code" }),
    candidate({ title: "丙", origin: "model" }),
  ];
  const forward = guardCandidates(input(), list);
  const backward = guardCandidates(input(), [...list].reverse());
  assert.deepEqual(
    forward.admitted.map((d) => d.candidate.title),
    backward.admitted.map((d) => d.candidate.title),
  );
  assert.deepEqual(
    forward.inboxed.map((d) => d.candidate.title),
    backward.inboxed.map((d) => d.candidate.title),
  );
});

test("origin 只有两个取值：人不会产出候选（人产出的是资产）", () => {
  const origins: CandidateOrigin[] = ["model", "code"];
  assert.deepEqual([...origins].sort(), ["code", "model"]);
});
