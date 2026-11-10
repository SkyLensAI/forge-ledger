/**
 * 自举（S29）—— 用本项目的 CLI 管本项目的 ADR / 规则 / eval。
 *
 * implement2.md 给 S29 写的目标很朴素：**自己产出 30+ ADR**。
 * 但"数够 30 条"本身不是质量判据：一个把模板抄 30 遍的仓库也能过。
 * 所以这个模块把"自举成功"拆成几件**能被证伪**的事，一起判：
 *
 * | 判据 | 防的是什么 |
 * |---|---|
 * | ADR 数量 ≥ 30 | 决策日志没有真的被用起来 |
 * | 每条资产过 `judgeLibrary` | 数量靠坏资产凑出来 |
 * | 种子规则 ≤ 8 且每条有出处 | `AGENTS.md` 腐化成愿景文档 |
 * | 两把尺子都被人确认、阈值被人批准 | 自举只自举了文档，没自举质量门 |
 * | demo / listing 与库逐字节一致 | 对外产物是手工改过的第二份真相 |
 * | 没有付费信号时团队能力必须全关 | 顺序被反过来：先做团队版，再补信号 |
 *
 * 它**不做 IO**：文件读取、目录比较与 JSON 解析都在 `apps/cli` 这一侧。
 * 这样判定可以拿固定输入做快照，也可以被 `evals/` 的探针复用。
 */
import type { AssetDoc, AssetType } from "@forge/schema";
import { ASSET_TYPES } from "@forge/schema";
import { sortViolations, type Violation } from "./violation.ts";
import { renderTeamStatus, type TeamStatus } from "./team.ts";

/** implement2.md S29 的目标：自己产出 30+ ADR。 */
export const BOOTSTRAP_ADR_TARGET = 30;

/** 自举报告里用到的码。它们不是闸门码；闸门码住在 `evals/runner/gate.ts`。 */
export const BOOTSTRAP_CODES = {
  ADR_TARGET_NOT_MET: "BOOTSTRAP_ADR_TARGET_NOT_MET",
  ADR_NOT_DECISION: "BOOTSTRAP_ADR_NOT_DECISION",
  ASSET_INVALID: "BOOTSTRAP_ASSET_INVALID",
  ASSET_VIOLATIONS: "BOOTSTRAP_ASSET_VIOLATIONS",
  SEED_RULES_UNAVAILABLE: "BOOTSTRAP_SEED_RULES_UNAVAILABLE",
  SEED_RULES_MISSING: "BOOTSTRAP_SEED_RULES_MISSING",
  SEED_RULES_TOO_MANY: "BOOTSTRAP_SEED_RULES_TOO_MANY",
  SEED_RULE_NO_ORIGIN: "BOOTSTRAP_SEED_RULE_NO_ORIGIN",
  EVAL_UNAVAILABLE: "BOOTSTRAP_EVAL_UNAVAILABLE",
  EVAL_NOT_CONFIRMED: "BOOTSTRAP_EVAL_NOT_CONFIRMED",
  THRESHOLD_NOT_RATIFIED: "BOOTSTRAP_THRESHOLD_NOT_RATIFIED",
  ARTIFACT_MISSING: "BOOTSTRAP_ARTIFACT_MISSING",
  ARTIFACT_DRIFT: "BOOTSTRAP_ARTIFACT_DRIFT",
  TEAM_UNGUARDED: "BOOTSTRAP_TEAM_UNGUARDED",
} as const;

/** `AGENTS.md` 解析出来的种子规则。上限来自闸门自己的约定（R2：规则必须很少）。 */
export interface SeedRulesInput {
  count: number;
  ids: string[];
  missingOrigin: string[];
  maxRules: number;
}

/** 两把尺子的确认状态与阈值批准状态。**只看人填过的字段，不替人猜。** */
export interface EvalReviewInput {
  extraction: { status: string; reviewed_by: string | null };
  conflict: { status: string; reviewed_by: string | null };
  thresholdsRatifiedBy: string | null;
}

/** 一份对外产物与库的比对结果。`missing` 与 `drifted` 是两件事，措辞必须分开。 */
export interface BootstrapArtifact {
  name: string;
  /** 生成器期望的文件数。 */
  expected: number;
  /** 目录根本不存在。 */
  missing: boolean;
  /** 内容与生成结果不一致的文件路径（只列前若干个，计数完整）。 */
  drifted: string[];
}

export interface BootstrapInput {
  assets: AssetDoc[];
  invalid: Array<{ path: string; reason: string }>;
  violations: Violation[];
  seedRules: SeedRulesInput | null;
  evalReview: EvalReviewInput | null;
  team: TeamStatus;
  artifacts: BootstrapArtifact[];
}

export interface BootstrapFinding {
  code: string;
  message: string;
  fix: string;
}

export interface BootstrapResult {
  ok: boolean;
  adrCount: number;
  adrTarget: number;
  counts: Record<AssetType, number>;
  total: number;
  seedRules: SeedRulesInput | null;
  evalReview: EvalReviewInput | null;
  team: TeamStatus;
  artifacts: BootstrapArtifact[];
  findings: BootstrapFinding[];
}

/**
 * 判定一次自举是否成立。
 *
 * @param {BootstrapInput} input
 * @returns {BootstrapResult}
 */
export function evaluateBootstrap(input: BootstrapInput): BootstrapResult {
  const counts = countByType(input.assets);
  const adrDocs = input.assets.filter((doc) => doc.path.startsWith("docs/adr/"));
  const adrCount = adrDocs.filter((doc) => doc.frontMatter.type === "decision").length;
  const findings: BootstrapFinding[] = [];

  // ── 数量 ────────────────────────────────────────────────────────────────
  if (adrCount < BOOTSTRAP_ADR_TARGET) {
    findings.push({
      code: BOOTSTRAP_CODES.ADR_TARGET_NOT_MET,
      message: `ADR 只有 ${String(adrCount)} 条，低于 implement2.md S29 的目标 ${String(BOOTSTRAP_ADR_TARGET)} 条。`,
      fix: "把真实发生过的决策补成 ADR——不要用模板凑数。数量是「决策日志被用起来」的痕迹，不是目标本身。",
    });
  }
  const wrongType = adrDocs.filter((doc) => doc.frontMatter.type !== "decision");
  if (wrongType.length > 0) {
    findings.push({
      code: BOOTSTRAP_CODES.ADR_NOT_DECISION,
      message:
        `docs/adr/ 下有 ${String(wrongType.length)} 条资产不是 decision 类型：` +
        `${wrongType.slice(0, 5).map((doc) => doc.path).join("、")}`,
      fix: "ADR 目录只放决策；其它类型请放进对应的资产目录",
    });
  }

  // ── 资产自身 ────────────────────────────────────────────────────────────
  if (input.invalid.length > 0) {
    findings.push({
      code: BOOTSTRAP_CODES.ASSET_INVALID,
      message:
        `${String(input.invalid.length)} 个文件读不成资产：` +
        `${input.invalid.slice(0, 5).map((item) => `${item.path}（${item.reason}）`).join("；")}`,
      fix: "先修 front-matter。自举的第一步是能把自己的文件读进来",
    });
  }
  const violations = sortViolations(input.violations);
  if (violations.length > 0) {
    findings.push({
      code: BOOTSTRAP_CODES.ASSET_VIOLATIONS,
      message:
        `${String(violations.length)} 条资产审核不通过，第一条是 ` +
        `[${violations[0]?.code ?? "?"}] ${violations[0]?.path ?? "?"}：${violations[0]?.message ?? ""}`,
      fix: "跑 `forge lint --repo` 看完整清单；出处是硬约束（R4）",
    });
  }

  // ── 种子规则 ────────────────────────────────────────────────────────────
  if (input.seedRules === null) {
    findings.push({
      code: BOOTSTRAP_CODES.SEED_RULES_UNAVAILABLE,
      message: "读不到 AGENTS.md 的种子规则：自举连自己的规则都没有解析入口。",
      fix: "恢复 AGENTS.md，并保持 `### R<n> · 标题` 的格式",
    });
  } else {
    if (input.seedRules.count === 0) {
      findings.push({
        code: BOOTSTRAP_CODES.SEED_RULES_MISSING,
        message: "AGENTS.md 里没有解析到任何 `### R<n>` 规则块。",
        fix: "按 `### R1 · 标题` 的格式写规则；没有规则的自举只是文档整理",
      });
    }
    if (input.seedRules.count > input.seedRules.maxRules) {
      findings.push({
        code: BOOTSTRAP_CODES.SEED_RULES_TOO_MANY,
        message:
          `AGENTS.md 有 ${String(input.seedRules.count)} 条规则，超过上限 ${String(input.seedRules.maxRules)}：` +
          "它正在变成愿景文档。",
        fix: "删到上限以内；新规则只能由真实错误长出来（棘轮）",
      });
    }
    if (input.seedRules.missingOrigin.length > 0) {
      findings.push({
        code: BOOTSTRAP_CODES.SEED_RULE_NO_ORIGIN,
        message: `这些规则没有「出处」：${input.seedRules.missingOrigin.join("；")}`,
        fix: "每条规则都要能追溯到一个具体出过的问题",
      });
    }
  }

  // ── 尺子 ────────────────────────────────────────────────────────────────
  if (input.evalReview === null) {
    findings.push({
      code: BOOTSTRAP_CODES.EVAL_UNAVAILABLE,
      message: "读不到尺子的确认记录：自举只自举了文档，没有自举质量门。",
      fix: "恢复 evals/golden/ 与 evals/thresholds.json",
    });
  } else {
    for (const [name, review] of [
      ["extraction", input.evalReview.extraction],
      ["conflict", input.evalReview.conflict],
    ] as const) {
      if (review.status !== "confirmed" || review.reviewed_by === null) {
        findings.push({
          code: BOOTSTRAP_CODES.EVAL_NOT_CONFIRMED,
          message: `${name} 的 golden 集还没有被人工确认（status=${review.status}）。`,
          fix: "逐条核对 why 之后把 review 块填上；确认绑在内容指纹上（见 evals/README.md）",
        });
      }
    }
    if (input.evalReview.thresholdsRatifiedBy === null || input.evalReview.thresholdsRatifiedBy.trim().length === 0) {
      findings.push({
        code: BOOTSTRAP_CODES.THRESHOLD_NOT_RATIFIED,
        message: "evals/thresholds.json 的阈值还没有被人工批准。",
        fix: "阈值决定什么算及格，是人的判断，不是 agent 的自选参数",
      });
    }
  }

  // ── 对外产物 ────────────────────────────────────────────────────────────
  for (const artifact of input.artifacts) {
    if (artifact.missing) {
      findings.push({
        code: BOOTSTRAP_CODES.ARTIFACT_MISSING,
        message: `对外产物 ${artifact.name} 不存在（期望 ${String(artifact.expected)} 个文件）。`,
        fix: `重新生成：forge ${artifact.name === "listing" ? "listing" : "demo"} --repo --out ${artifact.name}`,
      });
      continue;
    }
    if (artifact.drifted.length > 0) {
      findings.push({
        code: BOOTSTRAP_CODES.ARTIFACT_DRIFT,
        message:
          `对外产物 ${artifact.name} 与库不一致：${String(artifact.drifted.length)} 个文件漂移（` +
          `${artifact.drifted.slice(0, 5).join("、")}${artifact.drifted.length > 5 ? "…" : ""}）。`,
        fix: "重新生成它。手工改对外产物等于制造第二份真相，而第二份真相一定会漂移",
      });
    }
  }

  // ── 团队版顺序 ──────────────────────────────────────────────────────────
  for (const violation of input.team.violations) {
    findings.push({
      code: BOOTSTRAP_CODES.TEAM_UNGUARDED,
      message: violation.message,
      fix: violation.fix,
    });
  }

  const sorted = [...findings].sort((a, b) =>
    a.code === b.code ? (a.message < b.message ? -1 : 1) : a.code < b.code ? -1 : 1,
  );

  return {
    ok: sorted.length === 0,
    adrCount,
    adrTarget: BOOTSTRAP_ADR_TARGET,
    counts,
    total: input.assets.length,
    seedRules: input.seedRules,
    evalReview: input.evalReview,
    team: input.team,
    artifacts: input.artifacts,
    findings: sorted,
  };
}

const TYPE_LABELS: Readonly<Record<AssetType, string>> = {
  decision: "decision",
  state: "state",
  event: "event",
  rule: "rule",
};

/**
 * 人可读的自举报告。**排序过**（R6）：同一份输入跑两次要打出同样的行。
 *
 * @param {BootstrapResult} result
 * @returns {string}
 */
export function renderBootstrapReport(result: BootstrapResult): string {
  const lines: string[] = [];
  lines.push(
    `${result.ok ? "✓" : "✗"} 自举：${String(result.adrCount)} 条 ADR（目标 ≥ ${String(result.adrTarget)}）`,
  );
  const byType = ASSET_TYPES.filter((type) => result.counts[type] > 0)
    .map((type) => `${TYPE_LABELS[type]} ${String(result.counts[type])}`)
    .join(" · ");
  lines.push(`  资产：${String(result.total)} 条（${byType.length > 0 ? byType : "空库"}）`);

  if (result.seedRules === null) {
    lines.push("  种子规则：读不到（AGENTS.md 不可解析）");
  } else {
    const origin =
      result.seedRules.missingOrigin.length === 0
        ? "每条都有出处"
        : `${String(result.seedRules.missingOrigin.length)} 条没有出处`;
    lines.push(
      `  种子规则：${String(result.seedRules.count)} 条（上限 ${String(result.seedRules.maxRules)}；${origin}）`,
    );
  }

  if (result.evalReview === null) {
    lines.push("  尺子：读不到确认记录");
  } else {
    lines.push(
      `  尺子：extraction ${result.evalReview.extraction.status}` +
        `（${result.evalReview.extraction.reviewed_by ?? "无人"}）· ` +
        `conflict ${result.evalReview.conflict.status}` +
        `（${result.evalReview.conflict.reviewed_by ?? "无人"}）· ` +
        `阈值批准 ${result.evalReview.thresholdsRatifiedBy ?? "无"}`,
    );
  }

  lines.push(`  ${renderTeamStatus(result.team)}`);

  if (result.artifacts.length > 0) {
    for (const artifact of result.artifacts) {
      const state = artifact.missing
        ? `**不存在**（期望 ${String(artifact.expected)} 个文件）`
        : artifact.drifted.length === 0
          ? `${String(artifact.expected)} 个文件逐字节一致`
          : `${String(artifact.drifted.length)} 个文件漂移`;
      lines.push(`  产物 ${artifact.name}：${state}`);
    }
  }

  if (result.findings.length > 0) {
    lines.push("");
    lines.push(`  ${String(result.findings.length)} 处问题：`);
    for (const finding of result.findings) {
      lines.push(`  [${finding.code}] ${finding.message}`);
      lines.push(`      修法：${finding.fix}`);
    }
  }

  return lines.join("\n");
}

/**
 * @param {AssetDoc[]} docs
 * @returns {Record<AssetType, number>}
 */
function countByType(docs: AssetDoc[]): Record<AssetType, number> {
  const counts = { decision: 0, state: 0, event: 0, rule: 0 } as Record<AssetType, number>;
  for (const doc of docs) counts[doc.frontMatter.type] += 1;
  return counts;
}
