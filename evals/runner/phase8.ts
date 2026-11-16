/**
 * Phase 8 探针（S29–S32）—— 自举、团队版顺序、上架、demo。
 *
 * 为什么又是一个"探针"而不是几条一次性测试：
 * 前七个阶段的探针都遵守同一条纪律——**边界要在每次 CI 里被问一遍**。
 * Phase 8 的边界是下面这四条：
 *
 * 1. 自举不是一句"我们有 30 条 ADR"，而是**这 30 条能被同一套判定读进来**；
 * 2. 团队版没有付费信号时**一项能力都不许开**（S30 的顺序）；
 * 3. 上架包是**投影**，必须可重生成，而且**永远自称 draft**；
 * 4. demo 必须来自**自己的库**，不是编造的样例（S32）。
 *
 * 这个文件里的 IO 是允许的（`evals/` 是工具目录）：判定与渲染都在
 * `packages/core` 的纯函数里，这里只负责把仓库读进来、把结果量出来。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BOOTSTRAP_ADR_TARGET,
  assetPagePath,
  emitDemo,
  emitListing,
  judgeLibrary,
  teamStatusFromConfig,
  type EmittedFile,
} from "../../packages/core/src/index.ts";
import { buildSpanIndex, inspectProjection, readRepoAssets } from "../../packages/store/src/index.ts";

export interface Phase8ProbeResult {
  ok: boolean;
  adrCount: number;
  adrTarget: number;
  assets: number;
  demoFiles: number;
  listingFiles: number;
  demoDeterministic: boolean;
  listingDeterministic: boolean;
  demoFromOwnLibrary: boolean;
  listingFromOwnLibrary: boolean;
  listingDraft: boolean;
  team: {
    eligibility: string;
    paymentSignal: string | null;
    missing: string[];
    violations: string[];
  };
  /** 每一条都能直接进闸门的报错信息。 */
  violations: string[];
  detail: string[];
}

/**
 * 跑一次 Phase 8 探针。
 *
 * @param {string} repoRoot
 * @returns {Phase8ProbeResult}
 */
export function runPhase8Probe(repoRoot: string): Phase8ProbeResult {
  const { docs, invalid } = readRepoAssets(repoRoot);
  const index = buildSpanIndex({ sources: null, workspaces: [repoRoot] });
  const assetViolations = judgeLibrary(docs, index);
  const adrDocs = docs.filter((doc) => doc.path.startsWith("docs/adr/") && doc.frontMatter.type === "decision");
  const decisions = docs.filter((doc) => doc.frontMatter.type === "decision");

  const input = { assets: docs, events: [] };
  const demoA = emitDemo(input, { source: "repo" });
  const demoB = emitDemo(input, { source: "repo" });
  const listingA = emitListing(input);
  const listingB = emitListing(input);

  const demoDeterministic = sameFiles(demoA, demoB);
  const listingDeterministic = sameFiles(listingA, listingB);

  const demoPaths = new Set(demoA.map((file) => file.path));
  const demoDisk = inspectProjection(join(repoRoot, "demo"), demoA);
  const demoFromOwnLibrary =
    decisions.every((doc) => demoPaths.has(assetPagePath(doc))) &&
    readLibraryTotal(demoA) === docs.length &&
    readLibrarySource(demoA) === "repo" &&
    !demoDisk.missing &&
    demoDisk.drifted.length === 0;

  const listingPaths = new Set(listingA.map((file) => file.path));
  const listingManifest = readManifest(listingA);
  const listingDisk = inspectProjection(join(repoRoot, "listing"), listingA);
  const listingDraft =
    listingManifest !== null &&
    listingManifest["status"] === "draft" &&
    listingManifest["published"] === false;
  const listingAssets =
    listingManifest !== null && typeof listingManifest["assets"] === "object" && listingManifest["assets"] !== null
      ? (listingManifest["assets"] as Record<string, unknown>)
      : null;
  const listingFromOwnLibrary =
    listingAssets !== null &&
    listingAssets["total"] === docs.length &&
    listingPaths.has("plugins/forge/skills/forge/SKILL.md") &&
    countReferences(listingA) === decisions.length &&
    !listingDisk.missing &&
    listingDisk.drifted.length === 0;

  const team = teamStatusFromConfig(readJsonOrNull(join(repoRoot, "docs", "team", "status.json")));
  const teamViolations = team.violations.map((violation) => `${violation.code}: ${violation.message}`);

  const violations: string[] = [];
  if (invalid.length > 0) {
    violations.push(`${String(invalid.length)} 个文件读不成资产（${invalid[0]?.path ?? "?"}）`);
  }
  if (assetViolations.length > 0) {
    violations.push(
      `${String(assetViolations.length)} 条资产审核不通过（第一条 ${assetViolations[0]?.path ?? "?"}：` +
        `${assetViolations[0]?.message ?? ""}）`,
    );
  }
  if (adrDocs.length < BOOTSTRAP_ADR_TARGET) {
    violations.push(`ADR 只有 ${String(adrDocs.length)} 条，低于目标 ${String(BOOTSTRAP_ADR_TARGET)} 条`);
  }
  if (!demoDeterministic) violations.push("demo 两次生成不是逐字节相同");
  if (!listingDeterministic) violations.push("listing 两次生成不是逐字节相同");
  if (!demoFromOwnLibrary) {
    violations.push(
      demoDisk.missing
        ? "demo 目录不存在（先跑 `forge demo --repo --out demo`）"
        : demoDisk.drifted.length > 0
          ? `demo 与磁盘上的产物不一致（${String(demoDisk.drifted.length)} 处：${demoDisk.drifted.slice(0, 3).join("、")}）`
          : "demo 不是从本仓库自己的资产完整生成的",
    );
  }
  if (!listingFromOwnLibrary) {
    violations.push(
      listingDisk.missing
        ? "listing 目录不存在（先跑 `forge listing --repo --out listing`）"
        : listingDisk.drifted.length > 0
          ? `listing 与磁盘上的产物不一致（${String(listingDisk.drifted.length)} 处：${listingDisk.drifted.slice(0, 3).join("、")}）`
          : "listing 不是从本仓库自己的资产完整生成的",
    );
  }
  if (!listingDraft) violations.push("listing 没有自称 draft / published=false");

  return {
    ok: violations.length === 0,
    adrCount: adrDocs.length,
    adrTarget: BOOTSTRAP_ADR_TARGET,
    assets: docs.length,
    demoFiles: demoA.length,
    listingFiles: listingA.length,
    demoDeterministic,
    listingDeterministic,
    demoFromOwnLibrary,
    listingFromOwnLibrary,
    listingDraft,
    team: {
      eligibility: team.eligibility,
      paymentSignal: team.paymentSignal,
      missing: [...team.missing],
      violations: teamViolations,
    },
    violations,
    detail: [
      `ADR ${String(adrDocs.length)}/${String(BOOTSTRAP_ADR_TARGET)} · 资产 ${String(docs.length)} 条`,
      `demo ${String(demoA.length)} 个文件 · listing ${String(listingA.length)} 个文件`,
      `团队版 ${team.eligibility}（付费信号：${team.paymentSignal ?? "无"}；缺失：${team.missing.join(" / ") || "无"}）`,
    ],
  };
}

/**
 * 两份产物是否逐字节相同。
 *
 * @param {EmittedFile[]} a
 * @param {EmittedFile[]} b
 * @returns {boolean}
 */
function sameFiles(a: EmittedFile[], b: EmittedFile[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index];
    const right = b[index];
    if (left === undefined || right === undefined) return false;
    if (left.path !== right.path || left.content !== right.content) return false;
  }
  return true;
}

/**
 * @param {EmittedFile[]} files
 * @returns {number | null}
 */
function readLibraryTotal(files: EmittedFile[]): number | null {
  const library = parseFile(files, "library.json");
  if (library === null) return null;
  const counts = library["counts"];
  if (typeof counts !== "object" || counts === null) return null;
  const total = (counts as Record<string, unknown>)["total"];
  return typeof total === "number" ? total : null;
}

/**
 * @param {EmittedFile[]} files
 * @returns {string | null}
 */
function readLibrarySource(files: EmittedFile[]): string | null {
  const library = parseFile(files, "library.json");
  if (library === null) return null;
  const source = library["source"];
  return typeof source === "string" ? source : null;
}

/**
 * @param {EmittedFile[]} files
 * @returns {Record<string, unknown> | null}
 */
function readManifest(files: EmittedFile[]): Record<string, unknown> | null {
  return parseFile(files, "manifest.json");
}

/**
 * @param {EmittedFile[]} files
 * @param {string} path
 * @returns {Record<string, unknown> | null}
 */
function parseFile(files: EmittedFile[], path: string): Record<string, unknown> | null {
  const file = files.find((item) => item.path === path);
  if (file === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(file.content);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * @param {EmittedFile[]} files
 * @returns {number}
 */
function countReferences(files: EmittedFile[]): number {
  return files.filter((file) => file.path.startsWith("plugins/forge/skills/forge/references/")).length;
}

/**
 * @param {string} path
 * @returns {unknown}
 */
function readJsonOrNull(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}
