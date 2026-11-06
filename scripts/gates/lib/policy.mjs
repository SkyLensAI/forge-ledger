// @ts-check
/**
 * 闸门策略：纯数据 + 纯函数，零 IO。
 *
 * 这是"清单 → 闸门"的落地点：每一条纪律都是一个**可机器判定**的规则，
 * 而不是 AGENTS.md 里的一句礼貌请求。
 *
 * 权威性说明（ADR-0001）：本文件只做判定；判定结果由 pre-commit（闸门 2）
 * 与 CI（闸门 3）消费。本地钩子只是省时间的早期反馈，**唯一有权威的是 CI**。
 */

/**
 * @typedef {'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'unknown'} ChangeStatus
 * @typedef {{ path: string, status: ChangeStatus }} Change
 * @typedef {{ code: string, path: string, message: string, fix: string }} Violation
 * @typedef {{ ok: boolean, violations: Violation[] }} Verdict
 */

/**
 * 受保护路径：改动这些路径 = 改"宪法"或改"闸门本身"，
 * 必须同时提交一份 ADR（docs/adr/NNNN-*.md）或在提交信息里带 `ADR:` 尾注。
 *
 * 为什么只保护这些、不保护 package.json / eslint.config.mjs：
 * 受保护的判据是"改动它等于放宽约束"。工具链配置改动会在 CI 里直接暴露
 * （lint/typecheck 跑不过），加 ADR 只会训练人绕过流程。
 * @type {ReadonlyArray<{ prefix?: string, contains?: string, why: string }>}
 */
export const PROTECTED = [
  { prefix: ".claude/", why: "agent hook 配置（闸门 1 本体）" },
  { prefix: ".githooks/", why: "pre-commit / pre-push（闸门 2 本体）" },
  { prefix: ".github/workflows/", why: "CI 强制门与发布门（闸门 3/5 本体）" },
  { prefix: "scripts/gates/", why: "闸门实现本体" },
  { prefix: "schema/", why: "分类法：产品宪法（人可读）" },
  { prefix: "packages/schema/", why: "分类法实现：zod + 迁移（代码）" },
  { contains: "/migrations/", why: "迁移通道" },
];

/** 用户数据目录：永不进 repo（反模式 #1，一次误提交就是一次信任崩塌）。 */
export const USER_DATA_PREFIX = "data/";

/** data/ 下允许入库的例外（占位文件）。 */
export const USER_DATA_ALLOWLIST = new Set(["data/.gitkeep"]);

/** ADR 文件名规范，与 directory.md §八 的 ID 纪律一致。 */
export const ADR_PATTERN = /^docs\/adr\/\d{4}-[a-z0-9][a-z0-9-]*\.md$/;

/** 密钥类文件：即使 repo 是私有的，也不允许进历史。 */
export const SECRET_PATTERN = /(^|\/)\.env(\.|$)/;

/** 允许入库的密钥样板。 */
export const SECRET_ALLOWLIST = new Set([".env.example"]);

/** AGENTS.md 规则上限。超过就说明它在变成愿景文档 [5]。 */
export const AGENTS_MD_MAX_RULES = 8;

/**
 * @param {string} path
 * @returns {string | null} 命中受保护路径时返回原因，否则 null
 */
export function protectedReason(path) {
  const normalized = normalizePath(path);
  for (const entry of PROTECTED) {
    if (entry.prefix !== undefined && normalized.startsWith(entry.prefix)) return entry.why;
    if (entry.contains !== undefined && normalized.includes(entry.contains)) return entry.why;
  }
  return null;
}

/**
 * @param {string} path
 * @returns {boolean}
 */
export function isUserData(path) {
  const normalized = normalizePath(path);
  return normalized.startsWith(USER_DATA_PREFIX) && !USER_DATA_ALLOWLIST.has(normalized);
}

/**
 * @param {string} path
 * @returns {boolean}
 */
export function isSecret(path) {
  const normalized = normalizePath(path);
  const base = normalized.split("/").pop() ?? "";
  return SECRET_PATTERN.test(normalized) && !SECRET_ALLOWLIST.has(base);
}

/**
 * @param {string} path
 * @returns {boolean}
 */
export function isAdr(path) {
  return ADR_PATTERN.test(normalizePath(path));
}

/**
 * 判定一个变更集（提交、PR、或两次 tag 之间的差异）是否合规。
 *
 * @param {Change[]} changes
 * @param {{ adrRefs?: string[] }} [options] 提交信息 `ADR:` 尾注里声明的 ADR
 * @returns {Verdict}
 */
export function evaluateChangeset(changes, options = {}) {
  const adrRefs = options.adrRefs ?? [];
  /** @type {Violation[]} */
  const violations = [];

  const touchesProtected = changes.filter((c) => protectedReason(c.path) !== null);
  const adrInChangeset = changes.some((c) => isAdr(c.path) && c.status !== "deleted");
  const hasAdr = adrInChangeset || adrRefs.length > 0;

  for (const change of changes) {
    if (isUserData(change.path)) {
      violations.push({
        code: "R1_USER_DATA_IN_REPO",
        path: change.path,
        message: `用户数据被加入版本控制（${change.status}）。资产库比代码活得久，但它的家是 ~/.forge/，不是 git。`,
        fix: `git restore --staged "${change.path}"，并确认它在 .gitignore 里`,
      });
    }

    if (isSecret(change.path)) {
      violations.push({
        code: "R3_SECRET_IN_REPO",
        path: change.path,
        message: "密钥/环境文件被加入版本控制。",
        fix: `git restore --staged "${change.path}"；样板请用 .env.example`,
      });
    }
  }

  if (touchesProtected.length > 0 && !hasAdr) {
    for (const change of touchesProtected) {
      const why = protectedReason(change.path) ?? "受保护路径";
      violations.push({
        code: "R2_PROTECTED_WITHOUT_ADR",
        path: change.path,
        message: `改动了受保护路径（${why}），但本次变更里没有 ADR。闸门不能被随手改，宪法也不能被顺手改。`,
        fix:
          "在 docs/adr/ 新增 NNNN-*.md 记录这次改动（问题/选项/选定/后果），" +
          "或在提交信息里加 `ADR: <id>` 尾注",
      });
    }
  }

  return { ok: violations.length === 0, violations };
}

/**
 * @param {string} path
 * @returns {string}
 */
export function normalizePath(path) {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Bash 侧的闸门。Edit/Write 由路径判定拦住了，但 shell 是同一个洞的后门：
 * `git commit --no-verify`、`git push --force`、`git config core.hooksPath`、
 * `rm -rf .githooks` 都能让前一道闸门形同虚设。
 *
 * 这是 agent hook（闸门 1）专用：CI 不需要它，因为 CI 不跑 agent 的 shell。
 *
 * @param {string} command
 * @returns {Violation[]}
 */
export function evaluateBashCommand(command) {
  /** @type {Violation[]} */
  const violations = [];

  /** @type {Array<{ pattern: RegExp, code: string, message: string, fix: string }>} */
  const forbidden = [
    {
      pattern: /--no-verify\b/,
      code: "B1_SKIP_HOOKS",
      message: "--no-verify 跳过本地钩子。闸门红了就修问题，不改闸门、也不跳过闸门。",
      fix: "去掉 --no-verify，先修好被拦下的问题",
    },
    {
      pattern: /\bgit\s+commit\b[^\n]*\s-n(\s|$)/,
      code: "B1_SKIP_HOOKS",
      message: "`git commit -n` 等价于 --no-verify。",
      fix: "去掉 -n",
    },
    {
      pattern: /\bgit\s+push\b[^\n]*(--force\b|--force-with-lease\b|\s-f(\s|$))/,
      code: "B2_FORCE_PUSH",
      message: "强推会重写历史，而审计与出处依赖历史不可变。",
      fix: "改用普通 push；需要覆盖时开新分支",
    },
    {
      pattern: /\bgit\s+config\b[^\n]*core\.hooksPath/,
      code: "B3_UNWIRE_HOOKS",
      message: "改 core.hooksPath 等于摘下闸门 2。",
      fix: "闸门配置的改动要走 ADR，由人执行",
    },
  ];

  for (const entry of forbidden) {
    if (entry.pattern.test(command)) {
      violations.push({
        code: entry.code,
        path: "(bash)",
        message: entry.message,
        fix: entry.fix,
      });
    }
  }

  if (/\b(rm|rmdir|del|rimraf)\b/.test(command)) {
    for (const entry of PROTECTED) {
      // 命令里通常不写结尾斜杠（`rm -rf .githooks`），所以两边都规范化掉尾斜杠。
      const raw = entry.prefix ?? entry.contains ?? "";
      const target = raw.replace(/\/+$/, "");
      if (target.length > 0 && command.includes(target)) {
        violations.push({
          code: "B4_DELETE_PROTECTED",
          path: target,
          message: `命令试图删除受保护路径 ${target}（${entry.why}）：这正是"绕过闸门"的经典手法。`,
          fix: "删除受保护路径需要 ADR + 人工执行",
        });
      }
    }
  }

  return violations;
}
