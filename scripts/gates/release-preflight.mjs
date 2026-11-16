#!/usr/bin/env node
// @ts-check
/**
 * 发布前检查（闸门 5 的补充，ADR-0044）。
 *
 * 它**不发布**，只回答一个问题：现在这批 package.json 能不能被 `pnpm -r publish`
 * 正确发出去？如果答案是否，就在打 tag 之后、真正 publish 之前红掉——
 * 而不是发出一个装不上的包。
 *
 * 判据都是发布前必须为真的结构事实：
 *   1. 版本不是 `0.0.0`（那是"尚未发布"的占位，不是版本号）；
 *   2. `@forge/mcp` 不再是 `private`（上架包依赖一个可安装的 `forge-mcp`）；
 *   3. 每个要发布的包，它的 `@forge/*` 依赖也必须可发布——否则 npm 上装的时候
 *      会找不到依赖；
 *   4. 每个要发布的包都有 Node 下限、`files` 与 `publishConfig.access`；
 *   5. 扩展仍然是 `private`（浏览器扩展不通过 npm 分发）。
 *
 * 用法：
 *   node scripts/gates/release-preflight.mjs                 # CI 里跑（要求 NPM_TOKEN）
 *   node scripts/gates/release-preflight.mjs --allow-missing-token  # 本地演练
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const allowMissingToken = process.argv.includes("--allow-missing-token");

/**
 * @param {string} relative
 * @returns {Record<string, any>}
 */
function readJson(relative) {
  return JSON.parse(readFileSync(join(ROOT, relative), "utf8"));
}

/**
 * @param {string} group
 * @returns {Array<{dir: string, pkg: Record<string, any>}>}
 */
function workspacePackages(group) {
  const base = join(ROOT, group);
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(base, entry.name, "package.json")))
    .map((entry) => ({
      dir: `${group}/${entry.name}`,
      pkg: readJson(`${group}/${entry.name}/package.json`),
    }))
    .sort((a, b) => (a.dir < b.dir ? -1 : 1));
}

const packages = [...workspacePackages("packages"), ...workspacePackages("apps")];
const publishable = packages.filter((item) => item.pkg["private"] !== true);
const byName = new Map(packages.map((item) => [item.pkg["name"], item]));

/** @type {string[]} */
const problems = [];

const rootPkg = readJson("package.json");
if (rootPkg["version"] === "0.0.0") {
  problems.push("根 package.json 的版本还是 0.0.0：先决定这一版叫什么（tag 必须与它一致）。");
}

if (publishable.length === 0) {
  problems.push("没有任何可发布的包：所有 workspace 包都还是 private。");
}

const mcp = byName.get("@forge/mcp");
if (mcp === undefined) {
  problems.push("找不到 @forge/mcp：上架包没有可安装的 MCP server。");
} else if (mcp.pkg["private"] === true) {
  problems.push(
    "@forge/mcp 仍然是 private: true。上架包（listing/.mcp.json）指向 forge-mcp，它必须真的能被安装。" +
      "先确认 scope 所有权与 registry 凭据，再移除 private。",
  );
}

for (const item of publishable) {
  const name = item.pkg["name"];
  if (item.pkg["version"] === "0.0.0") {
    problems.push(`${name} 的版本还是 0.0.0。`);
  }
  if (item.pkg["engines"]?.["node"] !== ">=24") {
    problems.push(`${name} 缺少 engines.node = ">=24"（零构建依赖 Node 原生类型擦除，ADR-0011）。`);
  }
  if (!Array.isArray(item.pkg["files"]) || item.pkg["files"].length === 0) {
    problems.push(`${name} 没有 files：发布包会把测试与临时文件一起带出去。`);
  }
  if (item.pkg["publishConfig"]?.["access"] !== "public") {
    problems.push(`${name} 没有 publishConfig.access = "public"。`);
  }
  for (const dependency of Object.keys(item.pkg["dependencies"] ?? {})) {
    if (!dependency.startsWith("@forge/")) continue;
    const dep = byName.get(dependency);
    if (dep === undefined) {
      problems.push(`${name} 依赖 ${dependency}，但 workspace 里找不到它。`);
      continue;
    }
    if (dep.pkg["private"] === true) {
      problems.push(
        `${name} 依赖 ${dependency}，但 ${dependency} 仍然是 private——发布之后 npm 上装不到这个依赖。`,
      );
    }
  }
}

const extension = byName.get("@forge/extension");
if (extension !== undefined && extension.pkg["private"] !== true) {
  problems.push("@forge/extension 不是 private：浏览器扩展不通过 npm 分发，别把它发出去。");
}

if (!allowMissingToken && (process.env.FORGE_NPM_TOKEN ?? process.env.NPM_TOKEN ?? "").length === 0) {
  problems.push(
    "没有 NPM_TOKEN（或 FORGE_NPM_TOKEN）：发布需要 registry 凭据。本地演练加 --allow-missing-token。",
  );
}

console.log(`发布前检查：workspace ${String(packages.length)} 个包，可发布 ${String(publishable.length)} 个。`);
for (const item of publishable) {
  console.log(`  · ${item.pkg["name"]}@${String(item.pkg["version"])}（${item.dir}）`);
}

if (problems.length > 0) {
  console.error(`\n✗ ${String(problems.length)} 处问题：\n`);
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error("\n  修**发布准备**，不是跳过这道检查。");
  process.exit(1);
}

console.log("\n✓ 发布前检查通过：可以执行 pnpm -r publish。");
