/**
 * 自举判定的尺子（S29）。
 *
 * 重点是：**数量不是唯一判据**。一个 30 条 ADR 的仓库如果读不动、没有出处、
 * 尺子没人确认、产物漂移、团队版提前开闸，自举仍然不算成立。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SCHEMA_VERSION,
  renderAssetDocument,
  type AssetDoc,
  type AssetFrontMatter,
} from "@forge/schema";
import {
  BOOTSTRAP_ADR_TARGET,
  BOOTSTRAP_CODES,
  evaluateBootstrap,
  renderBootstrapReport,
  type BootstrapInput,
} from "../src/bootstrap.ts";
import { evaluateTeamEdition } from "../src/team.ts";

/**
 * @param {number} index
 * @param {Partial<AssetFrontMatter>} [overrides]
 * @returns {AssetDoc}
 */
function adr(index: number, overrides: Partial<AssetFrontMatter> = {}): AssetDoc {
  const frontMatter: AssetFrontMatter = {
    schema_version: SCHEMA_VERSION,
    id: `dec_${String(index).padStart(26, "0")}`,
    type: "decision",
    status: "accepted",
    created: "2026-11-06",
    last_confirmed: "2026-11-06",
    supersedes: null,
    origin_incident: null,
    subject: `decision:${String(index)}`,
    sources: ["file://docs/implement2.md#t:把闸门写成 checklist"],
    sensitivity: "internal",
    confidence: 0.8,
    ...overrides,
  };
  const body = `# 决策 ${String(index)}\n\n## 问题\n\n测试。\n`;
  return {
    path: `docs/adr/${String(index).padStart(4, "0")}-decision.md`,
    frontMatter,
    body,
    raw: renderAssetDocument(frontMatter, body),
  };
}

/**
 * @param {Partial<BootstrapInput>} [overrides]
 * @returns {BootstrapInput}
 */
function input(overrides: Partial<BootstrapInput> = {}): BootstrapInput {
  return {
    assets: Array.from({ length: BOOTSTRAP_ADR_TARGET }, (_, index) => adr(index + 1)),
    invalid: [],
    violations: [],
    seedRules: { count: 8, ids: ["R1"], missingOrigin: [], maxRules: 8 },
    evalReview: {
      extraction: { status: "confirmed", reviewed_by: "someone" },
      conflict: { status: "confirmed", reviewed_by: "someone" },
      thresholdsRatifiedBy: "someone",
    },
    team: evaluateTeamEdition({ paymentSignal: null, capabilities: {} }),
    artifacts: [
      { name: "listing", expected: 10, missing: false, drifted: [] },
      { name: "demo", expected: 10, missing: false, drifted: [] },
    ],
    ...overrides,
  };
}

/**
 * @param {BootstrapInput} value
 * @returns {string[]}
 */
function codes(value: BootstrapInput): string[] {
  return evaluateBootstrap(value).findings.map((finding) => finding.code);
}

test("刚好 30 条 ADR 且其余全绿 → 自举成立", () => {
  const result = evaluateBootstrap(input());
  assert.equal(result.ok, true, result.findings.map((finding) => finding.message).join("；"));
  assert.equal(result.adrCount, BOOTSTRAP_ADR_TARGET);
});

test("ADR 不足 30 条 → 红（数量是决策日志被用起来的痕迹）", () => {
  assert.deepEqual(
    codes(input({ assets: Array.from({ length: 29 }, (_, index) => adr(index + 1)) })),
    [BOOTSTRAP_CODES.ADR_TARGET_NOT_MET],
  );
});

test("ADR 目录里混进非 decision 资产 → 红", () => {
  const assets = Array.from({ length: BOOTSTRAP_ADR_TARGET + 1 }, (_, index) => adr(index + 1));
  assets[0] = adr(1, { type: "state", status: "active" });
  assert.deepEqual(codes(input({ assets })), [BOOTSTRAP_CODES.ADR_NOT_DECISION]);
});

test("有文件读不动 / 资产审核不通过 → 红（数量不能靠坏文件凑）", () => {
  assert.deepEqual(
    codes(input({ invalid: [{ path: "docs/adr/0001-x.md", reason: "front-matter 坏了" }] })),
    [BOOTSTRAP_CODES.ASSET_INVALID],
  );
  assert.deepEqual(
    codes(
      input({
        violations: [
          {
            code: "PROV_NO_SOURCES",
            path: "docs/adr/0001-x.md",
            message: "没有出处",
            fix: "补出处",
          },
        ],
      }),
    ),
    [BOOTSTRAP_CODES.ASSET_VIOLATIONS],
  );
});

test("种子规则缺失 / 没出处 / 超过上限 → 红", () => {
  assert.deepEqual(codes(input({ seedRules: null })), [BOOTSTRAP_CODES.SEED_RULES_UNAVAILABLE]);
  assert.deepEqual(
    codes(input({ seedRules: { count: 0, ids: [], missingOrigin: [], maxRules: 8 } })),
    [BOOTSTRAP_CODES.SEED_RULES_MISSING],
  );
  assert.deepEqual(
    codes(input({ seedRules: { count: 3, ids: ["R1"], missingOrigin: ["R1 · 无出处"], maxRules: 8 } })),
    [BOOTSTRAP_CODES.SEED_RULE_NO_ORIGIN],
  );
  assert.deepEqual(
    codes(input({ seedRules: { count: 9, ids: [], missingOrigin: [], maxRules: 8 } })),
    [BOOTSTRAP_CODES.SEED_RULES_TOO_MANY],
  );
});

test("尺子没被人确认 / 阈值没被批准 → 红（自举也要自举质量门）", () => {
  assert.deepEqual(
    codes(
      input({
        evalReview: {
          extraction: { status: "proposed", reviewed_by: null },
          conflict: { status: "confirmed", reviewed_by: "someone" },
          thresholdsRatifiedBy: "someone",
        },
      }),
    ),
    [BOOTSTRAP_CODES.EVAL_NOT_CONFIRMED],
  );
  assert.deepEqual(
    codes(
      input({
        evalReview: {
          extraction: { status: "confirmed", reviewed_by: "someone" },
          conflict: { status: "confirmed", reviewed_by: "someone" },
          thresholdsRatifiedBy: null,
        },
      }),
    ),
    [BOOTSTRAP_CODES.THRESHOLD_NOT_RATIFIED],
  );
});

test("对外产物缺失 / 漂移 → 红（第二份真相一定会漂移）", () => {
  assert.deepEqual(
    codes(
      input({
        artifacts: [
          { name: "listing", expected: 10, missing: true, drifted: [] },
          { name: "demo", expected: 10, missing: false, drifted: ["index.html"] },
        ],
      }),
    ),
    [BOOTSTRAP_CODES.ARTIFACT_DRIFT, BOOTSTRAP_CODES.ARTIFACT_MISSING],
  );
});

test("没有付费信号却开了团队能力 → 红（S30 的顺序）", () => {
  assert.deepEqual(
    codes(
      input({
        team: evaluateTeamEdition({ paymentSignal: null, capabilities: { permissions: true } }),
      }),
    ),
    [BOOTSTRAP_CODES.TEAM_UNGUARDED],
  );
});

test("报告是确定的：同一份输入两次渲染字节相同", () => {
  const first = renderBootstrapReport(evaluateBootstrap(input()));
  const second = renderBootstrapReport(evaluateBootstrap(input()));
  assert.equal(first, second);
  assert.match(first, /38|30 条/);
  assert.doesNotMatch(first, /\r/);
});
