// @ts-check
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { git } from "./git.mjs";
import { AGENTS_MD_MAX_RULES } from "./policy.mjs";

/**
 * @typedef {{ code: string, message: string, fix: string }} Finding
 */

/** 闸门 1 的实现入口，必须在 agent hook 里被引用。 */
export const AGENT_GUARD_ENTRY = "scripts/gates/agent-guard.mjs";
/** 闸门 2 的实现入口。 */
export const PRECOMMIT_ENTRY = "scripts/gates/pre-commit.mjs";
/** 闸门 4 本机镜像的实现入口。 */
export const PREPUSH_ENTRY = "scripts/gates/pre-push.mjs";
/** 闸门 3 的实现入口。 */
export const CI_ENTRY = "scripts/gates/ci.mjs";
/** 闸门 3 的 eval 阈值子闸门入口（Phase 3 · S14）。 */
export const EVAL_GATE_ENTRY = "scripts/gates/evals.mjs";
/** 闸门 5 的实现入口。 */
export const RELEASE_ENTRY = "scripts/gates/release.mjs";
/** 闸门 3 的 required status check 名字，必须与分支保护里的 context 完全一致。 */
export const REQUIRED_CHECK_NAME = "gates";

/**
 * @param {string} path
 * @returns {string | null}
 */
function readTextOrNull(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * 解析 AGENTS.md 的规则块。规则格式固定为 `### R<n> · 标题`，
 * 每个块必须包含 `出处`，否则这条规则是凭空发明的。
 *
 * @param {string} markdown
 * @returns {{ count: number, ids: string[], missingOrigin: string[] }}
 */
export function parseAgentRules(markdown) {
  const blocks = markdown.split(/^### /m).slice(1);
  /** @type {string[]} */
  const ids = [];
  /** @type {string[]} */
  const missingOrigin = [];
  for (const block of blocks) {
    const title = block.split(/\r?\n/, 1)[0] ?? "";
    const idMatch = /^R(\d+)\b/.exec(title.trim());
    if (idMatch === null) continue;
    ids.push(`R${idMatch[1]}`);
    if (!block.includes("出处")) missingOrigin.push(title.trim());
  }
  return { count: ids.length, ids, missingOrigin };
}

/**
 * "闸门本身"的完整性检查。
 *
 * 这是整套 harness 的防拆装置：agent 可以删掉自己的 hook 配置，
 * 但删掉之后 CI 会红——因为 CI 检查"闸门是否还完整"，而不只是"代码是否合规"。
 *
 * @param {{ root: string, env?: Record<string, string | undefined> }} options
 * @returns {Finding[]}
 */
export function checkHarness(options) {
  const root = options.root;
  const env = options.env ?? process.env;
  /** @type {Finding[]} */
  const findings = [];

  // 闸门 1：agent hook
  const settingsPath = join(root, ".claude", "settings.json");
  const settingsText = readTextOrNull(settingsPath);
  if (settingsText === null) {
    findings.push({
      code: "G1_AGENT_HOOK_MISSING",
      message: ".claude/settings.json 不存在：闸门 1（agent hook）没有安装。",
      fix: "恢复 .claude/settings.json 里的 PreToolUse hook",
    });
  } else {
    let wired = false;
    try {
      const settings = /** @type {any} */ (JSON.parse(settingsText));
      const preToolUse = settings?.hooks?.PreToolUse;
      if (Array.isArray(preToolUse)) {
        wired = preToolUse.some(
          (entry) =>
            Array.isArray(entry?.hooks) &&
            entry.hooks.some(
              (/** @type {any} */ handler) =>
                typeof handler?.command === "string" && handler.command.includes(AGENT_GUARD_ENTRY),
            ),
        );
      }
    } catch {
      findings.push({
        code: "G1_AGENT_HOOK_UNPARSEABLE",
        message: ".claude/settings.json 不是合法 JSON：闸门 1 静默失效。",
        fix: "修好 JSON 语法",
      });
    }
    if (!wired && findings.length === 0) {
      findings.push({
        code: "G1_AGENT_HOOK_UNWIRED",
        message: `PreToolUse 里没有任何 hook 调用 ${AGENT_GUARD_ENTRY}：闸门 1 被摘掉了。`,
        fix: "把 agent-guard 重新挂回 PreToolUse",
      });
    }
  }

  // 闸门 2 / 闸门 4（本机镜像）：本地 git 钩子
  /** @type {Array<[string, string]>} */
  const localHooks = [
    ["pre-commit", PRECOMMIT_ENTRY],
    ["pre-push", PREPUSH_ENTRY],
  ];
  for (const [hookName, entry] of localHooks) {
    const hookPath = join(root, ".githooks", hookName);
    const text = readTextOrNull(hookPath);
    if (text === null) {
      findings.push({
        code: "G2_GIT_HOOK_MISSING",
        message: `.githooks/${hookName} 不存在：本地闸门缺一环。`,
        fix: "恢复 .githooks/ 下的钩子脚本",
      });
      continue;
    }
    if (!text.includes(entry)) {
      findings.push({
        code: "G2_GIT_HOOK_UNWIRED",
        message: `.githooks/${hookName} 没有调用 ${entry}：钩子被改成了空壳。`,
        fix: `让 ${hookName} 执行 node ${entry}`,
      });
    }
  }

  // 本地 hooksPath 必须指向仓库内的 .githooks（CI 上无意义，故跳过）
  if (env.CI !== "true" && env.CI !== "1") {
    const hooksPath = git(["config", "--get", "core.hooksPath"], { cwd: root, allowFailure: true });
    if (hooksPath.stdout.trim() !== ".githooks") {
      findings.push({
        code: "G2_HOOKS_PATH_NOT_SET",
        message: "core.hooksPath 未指向 .githooks：闸门 2 在本机未生效。",
        fix: "pnpm prepare（或 node scripts/gates/install-hooks.mjs）",
      });
    }
  }

  // 闸门 3：required status check 的 workflow
  const ciPath = join(root, ".github", "workflows", "ci.yml");
  const ciText = readTextOrNull(ciPath);
  if (ciText === null) {
    findings.push({
      code: "G3_CI_WORKFLOW_MISSING",
      message: ".github/workflows/ci.yml 不存在：闸门 3（required status check）没有载体。",
      fix: "恢复 CI workflow",
    });
  } else {
    if (!new RegExp(`^\\s{2}${REQUIRED_CHECK_NAME}:`, "m").test(ciText)) {
      findings.push({
        code: "G3_REQUIRED_JOB_MISSING",
        message: `ci.yml 里没有 job id 为 \`${REQUIRED_CHECK_NAME}\` 的任务：分支保护要求的那个检查点消失了。`,
        fix: `恢复名为 ${REQUIRED_CHECK_NAME} 的 job`,
      });
    }
    if (!ciText.includes("gate:ci")) {
      findings.push({
        code: "G3_CI_ENTRY_MISSING",
        message: "ci.yml 没有执行 pnpm gate:ci：CI 变成了空转的绿灯。",
        fix: "在 workflow 里执行 pnpm gate:ci",
      });
    }
    // 可信判定：闸门代码必须取自基线修订，否则被检查者可以给自己发合格证（ADR-0005）。
    if (!ciText.includes("gate:trusted")) {
      findings.push({
        code: "G3_TRUSTED_JUDGE_MISSING",
        message:
          "ci.yml 没有执行 pnpm gate:trusted：判定者变成了被检查的工作树自己（删掉闸门代码就能让它报绿）。",
        fix: "在 workflow 里加一步 pnpm gate:trusted（见 ADR-0005）",
      });
    }
    // 变更集的判定依赖完整历史：浅克隆会让 diff 为空、闸门静默空转。
    if (!/fetch-depth:\s*0/.test(ciText)) {
      findings.push({
        code: "G3_SHALLOW_CLONE",
        message: "ci.yml 没有 fetch-depth: 0：浅克隆下 diff 可能为空，闸门会静默空转。",
        fix: "在 actions/checkout 里设 fetch-depth: 0",
      });
    }
  }

  // 闸门 3 的 eval 阈值子闸门（S14）。
  //
  // 为什么它需要一条**自己的**检查：删掉这个子闸门不会让任何别的东西变红。
  // lint 照样绿、快照照样绿、测试照样绿——"绿灯"于是只剩"代码看起来还行"的意思，
  // 而"需求被满足了吗"重新变回无人回答。这正是 implement1.md §2.3 说的那件事，
  // 也是 Phase 3 存在的全部理由。
  const evalGateText = readTextOrNull(join(root, EVAL_GATE_ENTRY));
  const ciEntryText = readTextOrNull(join(root, CI_ENTRY));
  if (evalGateText === null) {
    findings.push({
      code: "G3_EVAL_GATE_MISSING",
      message: `${EVAL_GATE_ENTRY} 不存在：eval 阈值判定没有载体，绿灯只剩"代码看起来还行"。`,
      fix: "恢复该子闸门（判定在 evals/runner/gate.ts，见 Phase 3 / S14）",
    });
  } else if (ciEntryText === null || !ciEntryText.includes("evals.mjs")) {
    findings.push({
      code: "G3_EVAL_GATE_MISSING",
      message: `${CI_ENTRY} 不再执行 evals.mjs：子闸门还在，但没人调用它——这是最省事的绕过方式。`,
      fix: "把 evals.mjs 加回 ci.mjs 的子闸门清单",
    });
  }

  // 闸门 5：发布门
  const releasePath = join(root, ".github", "workflows", "release.yml");
  const releaseText = readTextOrNull(releasePath);
  if (releaseText === null) {
    findings.push({
      code: "G5_RELEASE_WORKFLOW_MISSING",
      message: ".github/workflows/release.yml 不存在：闸门 5（发布门）没有载体。",
      fix: "恢复 release workflow",
    });
  } else {
    if (!releaseText.includes("gate:release")) {
      findings.push({
        code: "G5_RELEASE_ENTRY_MISSING",
        message: "release.yml 没有执行 pnpm gate:release。",
        fix: "在 release workflow 里执行 pnpm gate:release",
      });
    }
    if (!/^\s*environment:/m.test(releaseText)) {
      findings.push({
        code: "G5_RELEASE_APPROVAL_MISSING",
        message: "release.yml 没有绑定 environment：发布门缺少人工审批环节。",
        fix: "加 environment: release，并在仓库设置里配 required reviewers",
      });
    }
  }

  // AGENTS.md：上限与出处（防"愿景文档化"）
  const agentsPath = join(root, "AGENTS.md");
  const agentsText = readTextOrNull(agentsPath);
  if (agentsText === null) {
    findings.push({
      code: "G0_AGENTS_MD_MISSING",
      message: "AGENTS.md 不存在：agent 的种子规则没有落地。",
      fix: "恢复 AGENTS.md",
    });
  } else {
    const rules = parseAgentRules(agentsText);
    if (rules.count === 0) {
      findings.push({
        code: "G0_AGENTS_MD_NO_RULES",
        message: "AGENTS.md 里没有解析到任何 `### R<n>` 规则块。",
        fix: "按 `### R1 · 标题` 的格式写规则",
      });
    }
    if (rules.count > AGENTS_MD_MAX_RULES) {
      findings.push({
        code: "G0_AGENTS_MD_TOO_MANY_RULES",
        message: `AGENTS.md 有 ${rules.count} 条规则，超过上限 ${AGENTS_MD_MAX_RULES}：它正在变成愿景文档（会增加成本、并且腐化）。`,
        fix: "删到 8 条以内；新规则只能由真实错误长出（棘轮）",
      });
    }
    if (rules.missingOrigin.length > 0) {
      findings.push({
        code: "G0_AGENTS_MD_RULE_NO_ORIGIN",
        message: `这些规则没有 \`出处\`：${rules.missingOrigin.join("; ")}`,
        fix: "每条规则都要能追溯到一个具体出过的问题",
      });
    }
  }

  return findings;
}

/**
 * @param {string} root
 * @returns {boolean}
 */
export function harnessFilesExist(root) {
  return (
    existsSync(join(root, ".githooks", "pre-commit")) &&
    existsSync(join(root, ".github", "workflows", "ci.yml"))
  );
}
