#!/usr/bin/env node
// @ts-check
/**
 * 闸门 3 的补充判定 · 资产出处（S6 / ADR-0012）
 *
 * 它做一件本地闸门做不了的事：**校验本仓库里每一条资产的出处**。
 * `data/` 被 gitignore（R1），所以 CI 看不到用户资产——那用户库靠 `forge lint`。
 * 两处必须是**同一份纯函数**（`packages/core`），否则会出现"本地过、CI 挂"的漂移，
 * 而这类漂移的结局是所有人开始认为"闸门就是会偶尔抽风"。
 *
 * 为什么这个文件里几乎没有判定逻辑：判定在 `packages/core/src/asset.ts`。
 * 闸门只是它的一个宿主。宿主里写第二份实现，等于制造第二个真相。
 *
 * 依赖缺失时**降级为警告**而不是硬失败（ADR-0011）：`ci.mjs --guard-only`
 * 要在没有 node_modules 的临时克隆里跑得动（Phase 0 的演练靠这一点）。
 * 这个缺口记在 bypass-matrix 里——**记账，不假装没有**。
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { repoRoot } from "./lib/git.mjs";
import { degrade, warn } from "./lib/report.mjs";

/**
 * 判定对象（数据）来自**当前工作树**；判定代码来自**这份脚本所在的修订**。
 *
 * `trusted-ci.mjs` 把基线修订 checkout 到临时 worktree，然后从那里运行本文件，
 * 并通过 `FORGE_JUDGE_DATA_ROOT` 指向当前工作树。于是"改松判定"改不到判定者
 * （ADR-0005 / bypass-matrix 6.10），而资产仍然是这一份 PR 的资产。
 */
const dataRoot = process.env.FORGE_JUDGE_DATA_ROOT
  ? resolve(process.env.FORGE_JUDGE_DATA_ROOT)
  : (repoRoot() ?? process.cwd());
const codeRoot = fileURLToPath(new URL("../..", import.meta.url));

/**
 * @param {string} relative
 * @returns {Promise<any>}
 */
async function load(relative) {
  return import(pathToFileURL(join(codeRoot, relative)).href);
}

if (!existsSync(join(codeRoot, "node_modules")) && !existsSync(join(dataRoot, "node_modules"))) {
  warn("[assets] node_modules 未安装，跳过资产审核（CI 会装依赖并跑全量）");
  degrade();
}

let core;
let store;
try {
  core = await load("packages/core/src/index.ts");
  store = await load("packages/store/src/index.ts");
} catch (error) {
  warn(
    `[assets] 无法加载判定模块（${error instanceof Error ? error.message : String(error)}）——` +
      "跳过。这是**无法校验**，不是校验通过（见 docs/gates/bypass-matrix.md）",
  );
  degrade();
}

const { docs, invalid } = store.readRepoAssets(dataRoot);
// CI 里没有 sources 层，所以 src:// 一律报「无法校验」而不是放过（ADR-0009）。
const index = store.buildSpanIndex({ sources: null, workspaces: [dataRoot] });

/** @type {import("../../packages/core/src/violation.ts").Violation[]} */
const violations = [
  ...invalid.map((/** @type {{path: string, reason: string}} */ item) => ({
    code: "ASSET_FRONTMATTER_INVALID",
    path: item.path,
    message: `front-matter 读不动：${item.reason}`,
    fix: `补全 front-matter（字段表见 schema/taxonomy.yaml）；半吊子的 front-matter 比没有更难查`,
  })),
  ...core.judgeLibrary(docs, index),
];

const sorted = core.sortViolations(violations);

if (sorted.length === 0) {
  console.log(`✓ [assets] ${docs.length} 条资产出处完整（含 ${docs.length} 份 front-matter 资产）`);
  process.exit(0);
}

console.error(`✗ [assets] ${sorted.length} 处问题（审了 ${docs.length} 条资产）：\n`);
for (const violation of sorted) console.error(core.formatViolation(violation));
console.error("\n  出处是硬约束（R4）。修**资产**，不要放宽闸门。\n");
process.exit(1);
