/**
 * 团队版闸门的尺子（S30）。
 *
 * 这些用例只测一件事：**没有付费信号时，任何一项能力都不许被报告成已启用。**
 * 它们不测团队功能本身——团队功能按 implement2.md 的规矩还不该存在。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TEAM_CAPABILITIES,
  TEAM_CODES,
  evaluateTeamEdition,
  renderTeamStatus,
  teamStatusFromConfig,
} from "../src/team.ts";

test("没有信号、没有能力 → deferred，三项都列为缺失，但不报违规", () => {
  const status = evaluateTeamEdition({ paymentSignal: null, capabilities: {} });
  assert.equal(status.eligibility, "deferred");
  assert.equal(status.eligible, false);
  assert.deepEqual(status.missing, [...TEAM_CAPABILITIES]);
  assert.deepEqual(status.violations, []);
  const rendered = renderTeamStatus(status);
  assert.match(rendered, /deferred/);
  assert.match(rendered, /付费信号：无/);
});

test("没有信号却打开了任何一项能力 → 违规（顺序被反过来了）", () => {
  const status = evaluateTeamEdition({ paymentSignal: null, capabilities: { permissions: true } });
  assert.equal(status.eligibility, "deferred");
  assert.equal(status.violations.length, 1);
  assert.equal(status.violations[0]?.code, TEAM_CODES.CAPABILITY_WITHOUT_SIGNAL);
  assert.match(status.violations[0]?.message ?? "", /权限/);
});

test("空白字符串不是信号 —— 一个空格不能解锁团队版", () => {
  const status = evaluateTeamEdition({ paymentSignal: "   ", capabilities: {} });
  assert.equal(status.paymentSignal, null);
  assert.equal(status.eligibility, "deferred");
});

test("有信号但能力没齐 → partial，缺失项逐项列出", () => {
  const status = evaluateTeamEdition({
    paymentSignal: "PO-2026-001",
    capabilities: { permissions: true, concurrency: false, sensitivity: false },
  });
  assert.equal(status.eligibility, "partial");
  assert.equal(status.eligible, false);
  assert.deepEqual(status.missing, ["concurrency", "sensitivity"]);
  assert.deepEqual(status.violations, []);
});

test("有信号且三项能力齐了 → ready", () => {
  const status = evaluateTeamEdition({
    paymentSignal: "PO-2026-001",
    capabilities: { permissions: true, concurrency: true, sensitivity: true },
  });
  assert.equal(status.eligibility, "ready");
  assert.equal(status.eligible, true);
  assert.deepEqual(status.missing, []);
});

test("teamStatusFromConfig：坏形状一律读成「没有信号 + 能力全关」", () => {
  const status = teamStatusFromConfig({
    payment_signal: 42,
    capabilities: { permissions: "true", concurrency: 1, sensitivity: null },
  });
  assert.equal(status.paymentSignal, null);
  assert.equal(status.eligibility, "deferred");
  assert.deepEqual(status.missing, [...TEAM_CAPABILITIES]);
});

test("teamStatusFromConfig：正确的形状才读成 ready", () => {
  const status = teamStatusFromConfig({
    payment_signal: "PO-2026-001",
    capabilities: { permissions: true, concurrency: true, sensitivity: true },
  });
  assert.equal(status.eligibility, "ready");
});
