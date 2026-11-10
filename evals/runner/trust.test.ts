/**
 * 信任边界探针的**自证** —— 一个只会变绿的检查不是检查（R8）。
 *
 * 这个文件里有两条互补的用例，缺一条这个探针就不成立：
 *
 * 1. 拿**真实实现**跑：边界应当连着（一条编造出处的都不许活下来，
 *    而且必须**至少有一条**活到候选区——否则一个"什么都不放行"的实现也能骗过它）。
 * 2. 拿**坏掉的实现**跑（注入一个什么都不裁的 sanitize 与一个什么都放行的守卫）：
 *    探针**必须报红**。这条是整个文件的关键——它证明这个探针不是一盏装饰灯。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ADMISSION,
  ADMISSION_REASONS,
  guardCandidates,
  judgeCandidates,
  sanitizeCandidates,
  type CandidateAssertion,
  type ExtractionInput,
  type GuardResult,
} from "../../packages/core/src/index.ts";
import { runTrustProbe, verdictOf } from "./trust.ts";
import { hostileModel } from "../extractors/hostile.ts";
import { buildExtractionRequest, parseExtractionResponse } from "../../packages/core/src/index.ts";

test("真实实现上：边界连着（编造的一条都不留，合法的进候选区）", () => {
  const result = runTrustProbe();
  assert.equal(result.ok, true, result.detail.join("；"));
  assert.equal(result.violationsAfterSanitize, 0);
  assert.equal(result.admitted, 0);
  assert.ok(result.inboxed > 0, "一条都没活下来时，这次检查不成立");
  assert.ok(result.discarded > 0, "一条都没丢掉时，说明敌意模型没在敌意");
});

test("变异：把 sanitize 换成什么都不裁的实现 —— 探针必须报红", () => {
  const identity = (input: ExtractionInput, items: readonly unknown[]): ReturnType<typeof sanitizeCandidates> => ({
    candidates: items.map((item) => {
      const raw = item as Record<string, unknown>;
      return {
        type: raw["type"] as CandidateAssertion["type"],
        title: String(raw["title"] ?? ""),
        // 变异用例测的是"边界还在不在"，不是题面：恒为 null。
        subject: null,
        body: String(raw["body"] ?? ""),
        sources: Array.isArray(raw["sources"]) ? (raw["sources"] as string[]) : [],
        confidence: typeof raw["confidence"] === "number" ? raw["confidence"] : 0,
        origin: "model",
      };
    }),
    discarded: [],
    notes: [],
  });

  const result = runTrustProbe({ sanitize: identity });
  assert.equal(result.ok, false, "一个什么都不裁的 sanitize 居然通过了信任边界检查");
  assert.ok(result.violationsAfterSanitize > 0);
  assert.ok(result.detail.some((line) => line.includes("CAND_SPAN_NOT_IN_INPUT")));
});

test("变异：把守卫换成什么都放行的实现 —— 探针必须报红", () => {
  const rubberStamp = (_input: ExtractionInput, candidates: CandidateAssertion[]): GuardResult => ({
    admitted: candidates.map((candidate) => ({
      candidate,
      admission: ADMISSION.ADMIT,
      reason: ADMISSION_REASONS.CLEARED,
      violations: [],
    })),
    inboxed: [],
    rejected: [],
  });

  const result = runTrustProbe({ guard: rubberStamp });
  assert.equal(result.ok, false, "一个什么都放行的守卫居然通过了信任边界检查");
  assert.ok(result.admitted > 0);
  assert.ok(result.detail.some((line) => line.includes("放进了 assets/")));
});

test("判定本身：一条都没活下来时不算通过（否则「什么都不放行」能骗过它）", () => {
  const verdict = verdictOf([], [], { admitted: [], inboxed: [], rejected: [] }, 7);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.detail.some((line) => line.includes("什么都不放行")));
});

test("判定本身：三条性质一起看，缺一条都不算通过", () => {
  const candidate = {
    type: "rule" as const,
    title: "t",
    subject: null,
    body: "",
    sources: ["src://src_01M6Q2FD00P3EVALGATE000000#k:a/1"],
    confidence: 0.3,
    origin: "model" as const,
  };
  const clean: GuardResult = {
    admitted: [],
    inboxed: [{ candidate, admission: ADMISSION.INBOX, reason: ADMISSION_REASONS.MODEL_NEVER_AUTO, violations: [] }],
    rejected: [],
  };

  assert.equal(verdictOf([candidate], [], clean, 6).ok, true);

  const violation = {
    code: "CAND_SPAN_NOT_IN_INPUT",
    path: "p",
    message: "m",
    fix: "f",
  };
  assert.equal(verdictOf([candidate], [violation], clean, 6).ok, false);

  const leaky: GuardResult = {
    admitted: [{ candidate, admission: ADMISSION.ADMIT, reason: ADMISSION_REASONS.CLEARED, violations: [] }],
    inboxed: [],
    rejected: [],
  };
  assert.equal(verdictOf([candidate], [], leaky, 6).ok, false);
});

test("敌意模型的产出走的是**真实**路径：解析 → sanitize → judge → guard", () => {
  // 这条用例存在的理由：如果哪天有人把探针改成直接构造候选断言，
  // 它就绕过了真正需要被检查的那几段代码。这里逐步走一遍，钉住路径的形状。
  const input: ExtractionInput = {
    sourceId: "src_01M6Q2FD00P3EVALGATE000000",
    events: [
      {
        schema_version: 1,
        source_id: "src_01M6Q2FD00P3EVALGATE000000",
        key: "probe/0",
        kind: "message",
        occurred_at: "2026-01-01T00:00:00Z",
        actor: "user",
        text: "真事件。",
      },
    ],
  };

  const parsed = parseExtractionResponse(hostileModel.complete(buildExtractionRequest(input)).text);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.items.length, 7, "敌意模型应当吐出七条，少一条说明它被改弱了");

  const sanitized = sanitizeCandidates(input, parsed.items);
  assert.equal(sanitized.candidates.length, 3);
  assert.equal(sanitized.discarded.length, 4);
  assert.deepEqual(judgeCandidates(input, sanitized.candidates), []);

  const guard = guardCandidates(input, sanitized.candidates);
  assert.equal(guard.admitted.length, 0);
  assert.equal(guard.inboxed.length, 3);
});
