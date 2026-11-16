#!/usr/bin/env node
/**
 * 30 秒演示的可复现脚本。
 *
 * 它从 `spec/examples/` 搭一个**临时库**（合成来源 + 4 条示例资产），然后依次演示：
 *
 *   1. `forge lint`     —— 出处解析通过；
 *   2. `forge context`  —— 只注入预算内的一条，并说明它不是全库；
 *   3. `forge health`   —— 只读的健康报告；
 *   4. 改掉被引用的原文 —— `forge lint` 立刻报 PROV_SPAN_UNRESOLVED（退出码 1）。
 *
 * 不依赖 `data/`、不依赖 API key、不依赖网络。录制方式：
 *
 *   pnpm demo:30s
 *
 * 需要保留临时库排查时加 `--keep`。
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(process.cwd());
const TODAY = "2026-11-16";
const KEEP = process.argv.includes("--keep");

const vault = mkdtempSync(join(tmpdir(), "forge-demo-"));
const cli = join(ROOT, "apps", "cli", "src", "main.ts");

/**
 * @param {string} title
 */
function section(title) {
  console.log(`\n\x1b[1m── ${title} ──\x1b[0m`);
}

/**
 * @param {string[]} args
 * @param {import("node:child_process").SpawnSyncOptions} [options]
 */
function forge(args, options = {}) {
  console.log(`\x1b[2m$ forge ${args.join(" ")}\x1b[0m`);
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
    ...options,
  });
}

try {
  // 临时库的三层：assets 是要展示的资产；examples/sources 是出处解析根。
  for (const type of ["dec", "event", "rule", "state"]) {
    mkdirSync(join(vault, "assets", type), { recursive: true });
    cpSync(join(ROOT, "spec", "examples", "ledger", type), join(vault, "assets", type), { recursive: true });
  }
  mkdirSync(join(vault, "examples", "sources"), { recursive: true });
  cpSync(
    join(ROOT, "spec", "examples", "sources", "conversation.md"),
    join(vault, "examples", "sources", "conversation.md"),
  );

  section("compile");
  forge(["compile", "--vault", vault]);

  section("lint — provenance resolves");
  const clean = forge(["lint", "--vault", vault, "--today", TODAY]);
  if (clean.status !== 0) throw new Error("干净的示例库应当通过 lint");

  section("context — budgeted, never the whole library");
  forge(["context", "SQLite", "--vault", vault, "--today", TODAY]);

  section("health — read-only rot report");
  forge(["health", "--vault", vault, "--today", TODAY]);

  section("break the source — lint must go red");
  const source = join(vault, "examples", "sources", "conversation.md");
  writeFileSync(source, readFileSync(source, "utf8").replace("索引层用本地 SQLite", "索引层用 Postgres"));
  const broken = forge(["lint", "--vault", vault, "--today", TODAY]);
  if (broken.status !== 1) throw new Error("改掉被引用的原文之后 lint 必须失败");

  console.log("\n✓ 演示完成：出处不是元数据，是闸门。");
} finally {
  if (KEEP) console.log(`\n临时库保留在：${vault}`);
  else rmSync(vault, { recursive: true, force: true });
}
