// @ts-check
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { normalizePath } from "./policy.mjs";

/**
 * @typedef {import('./policy.mjs').Change} Change
 * @typedef {import('./policy.mjs').ChangeStatus} ChangeStatus
 */

/**
 * @param {string[]} args
 * @param {{ cwd?: string, allowFailure?: boolean }} [options]
 * @returns {{ ok: boolean, stdout: string, stderr: string, status: number | null }}
 */
export function git(args, options = {}) {
  const result = spawnSync("git", args, {
    cwd: options.cwd ?? process.cwd(),
    encoding: "utf8",
    windowsHide: true,
  });
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  const ok = result.status === 0;
  if (!ok && options.allowFailure !== true) {
    throw new Error(`git ${args.join(" ")} 失败（exit ${result.status}）: ${stderr.trim()}`);
  }
  return { ok, stdout, stderr, status: result.status };
}

/**
 * 解析 `git diff --name-status -z` 的输出。
 * -z 下的记录形如：`M\0path\0`，重命名则是 `R100\0old\0new\0`。
 * 不使用 `\n` 解析：文件名可以包含空格与换行。
 *
 * @param {string} raw
 * @returns {Change[]}
 */
export function parseNameStatusZ(raw) {
  const tokens = raw.split("\0").filter((token) => token.length > 0);
  /** @type {Change[]} */
  const changes = [];
  let i = 0;
  while (i < tokens.length) {
    const statusToken = tokens[i] ?? "";
    i += 1;
    const isRenameOrCopy = statusToken.startsWith("R") || statusToken.startsWith("C");
    if (isRenameOrCopy) {
      const from = tokens[i] ?? "";
      const to = tokens[i + 1] ?? "";
      i += 2;
      if (to.length === 0) break;
      // 重命名记为 deleted + added 两条：受保护路径的"移出"与"移入"都要被看见。
      changes.push({ path: normalizePath(from), status: "deleted" });
      changes.push({ path: normalizePath(to), status: "added" });
      continue;
    }
    const path = tokens[i] ?? "";
    i += 1;
    if (path.length === 0) break;
    changes.push({ path: normalizePath(path), status: toStatus(statusToken) });
  }
  return changes;
}

/**
 * @param {string} token
 * @returns {ChangeStatus}
 */
function toStatus(token) {
  if (token.startsWith("A")) return "added";
  if (token.startsWith("D")) return "deleted";
  if (token.startsWith("M")) return "modified";
  if (token.startsWith("T")) return "modified";
  return "unknown";
}

/**
 * 暂存区（即将写入提交的）变更集。
 * @param {{ cwd?: string }} [options]
 * @returns {Change[]}
 */
export function stagedChanges(options = {}) {
  const result = git(["diff", "--cached", "--name-status", "-z", "--no-renames"], options);
  return parseNameStatusZ(result.stdout);
}

/**
 * 两次修订之间的变更集。
 * @param {string} base
 * @param {string} head
 * @param {{ cwd?: string }} [options]
 * @returns {Change[]}
 */
export function changesBetween(base, head, options = {}) {
  const result = git(["diff", "--name-status", "-z", "--no-renames", base, head], options);
  return parseNameStatusZ(result.stdout);
}

/**
 * 找出可用的比较基线。CI 上是 PR 的 base 分支，本地退化为父提交。
 * @param {{ cwd?: string, env?: Record<string, string | undefined> }} [options]
 * @returns {string | null}
 */
export function resolveBaseRef(options = {}) {
  const env = options.env ?? process.env;

  // CI 显式给出基线时优先用它：push 事件下 main 的 merge-base 会等于 HEAD，
  // 那样 diff 为空、闸门会静默空转。
  const explicit = env.FORGE_BASE_SHA;
  if (typeof explicit === "string" && explicit.trim().length > 0) {
    const sha = explicit.trim();
    const verify = git(["rev-parse", "--verify", `${sha}^{commit}`], {
      ...options,
      allowFailure: true,
    });
    if (verify.ok) {
      const base = git(["merge-base", "HEAD", sha], { ...options, allowFailure: true });
      return base.ok && base.stdout.trim().length > 0 ? base.stdout.trim() : sha;
    }
  }

  const candidates = [];
  if (env.GITHUB_BASE_REF) candidates.push(`origin/${env.GITHUB_BASE_REF}`);
  candidates.push("origin/main", "main");

  for (const candidate of candidates) {
    const base = git(["merge-base", "HEAD", candidate], { ...options, allowFailure: true });
    if (base.ok && base.stdout.trim().length > 0) return base.stdout.trim();
  }
  const parent = git(["rev-parse", "--verify", "HEAD~1"], { ...options, allowFailure: true });
  if (parent.ok && parent.stdout.trim().length > 0) return parent.stdout.trim();
  return null;
}

/**
 * 从提交信息里抽取 `ADR:` 尾注（CI 侧放行受保护路径改动的第二种方式）。
 * @param {string} text
 * @returns {string[]}
 */
export function extractAdrTrailers(text) {
  /** @type {string[]} */
  const refs = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*ADR:\s*(\S+)\s*$/.exec(line);
    if (match?.[1] !== undefined) refs.push(match[1]);
  }
  return refs;
}

/**
 * 自 base 以来所有提交信息的尾注集合。
 * @param {string} base
 * @param {{ cwd?: string }} [options]
 * @returns {string[]}
 */
export function adrRefsSince(base, options = {}) {
  const result = git(["log", "--format=%B%x00", `${base}..HEAD`], options);
  return extractAdrTrailers(result.stdout);
}

/**
 * 若存在，返回 `.git/COMMIT_EDITMSG` 里的尾注（pre-commit 阶段信息已落盘）。
 * @param {{ cwd?: string }} [options]
 * @returns {string[]}
 */
export function adrRefsFromCommitMessageFile(options = {}) {
  const path = git(["rev-parse", "--git-path", "COMMIT_EDITMSG"], options).stdout.trim();
  try {
    return extractAdrTrailers(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
}

/**
 * @param {{ cwd?: string }} [options]
 * @returns {string}
 */
export function currentBranch(options = {}) {
  return git(["rev-parse", "--abbrev-ref", "HEAD"], options).stdout.trim();
}

/**
 * @param {{ cwd?: string }} [options]
 * @returns {boolean}
 */
export function isWorkingTreeClean(options = {}) {
  return git(["status", "--porcelain"], options).stdout.trim().length === 0;
}

/**
 * @param {{ cwd?: string }} [options]
 * @returns {string | null}
 */
export function repoRoot(options = {}) {
  const result = git(["rev-parse", "--show-toplevel"], { ...options, allowFailure: true });
  return result.ok ? result.stdout.trim() : null;
}
