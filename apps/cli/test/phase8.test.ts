/**
 * Phase 8 的端到端测试：自举、上架包、对外 demo。
 *
 * 它们跑真的子进程，因为退出码、`--check`、参数错误都是产品的一部分。
 * 与 `e2e.test.ts` 同一条理由：函数调用测不到"这条命令在 shell 里能不能用"。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = process.cwd();
const CLI = join(REPO, "apps", "cli", "src", "main.ts");

/**
 * @param {string[]} args
 * @param {{ cwd?: string }} [options]
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function forge(args: string[], options: { cwd?: string } = {}): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync("node", [CLI, ...args], {
    cwd: options.cwd ?? REPO,
    encoding: "utf8",
    env: { PATH: process.env["PATH"] ?? "" },
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function temp(prefix: string): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("自举：本仓库的 ADR / 规则 / eval / 产物全绿", () => {
  const result = forge(["bootstrap"]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /自举：\d+ 条 ADR（目标 ≥ 30）/);
  assert.match(result.stdout, /团队版：deferred/);
  assert.match(result.stdout, /产物 listing：\d+ 个文件逐字节一致/);
  assert.match(result.stdout, /产物 demo：\d+ 个文件逐字节一致/);
});

test("上架包：写盘 → --check 绿 → 改一个字节 → --check 红", () => {
  const run = temp("forge-listing-");
  try {
    const out = join(run.root, "listing");

    const written = forge(["listing", "--repo", "--out", out]);
    assert.equal(written.status, 0, written.stderr);
    assert.match(written.stdout, /上架包完成/);

    const checked = forge(["listing", "--repo", "--out", out, "--check"]);
    assert.equal(checked.status, 0, checked.stderr);
    assert.match(checked.stdout, /逐字节相同/);

    const manifestPath = join(out, "manifest.json");
    writeFileSync(manifestPath, `${readFileSync(manifestPath, "utf8")}\n`, "utf8");
    const drifted = forge(["listing", "--repo", "--out", out, "--check"]);
    assert.equal(drifted.status, 1);
    assert.match(drifted.stderr, /manifest\.json/);
  } finally {
    run.cleanup();
  }
});

test("上架包：清单计数来自本仓库自己的库，而且永远是 draft", () => {
  const run = temp("forge-listing-manifest-");
  try {
    const out = join(run.root, "listing");
    assert.equal(forge(["listing", "--repo", "--out", out]).status, 0);
    const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) as {
      status?: string;
      published?: boolean;
      assets?: { total?: number; decision?: number };
    };
    assert.equal(manifest.status, "draft");
    assert.equal(manifest.published, false);
    assert.ok((manifest.assets?.decision ?? 0) >= 30, "上架包必须包含自举的 ADR");
    assert.equal(manifest.assets?.total, manifest.assets?.decision);
  } finally {
    run.cleanup();
  }
});

test("demo：写盘 → --check 绿 → 改一个字节 → --check 红", () => {
  const run = temp("forge-demo-");
  try {
    const out = join(run.root, "demo");

    const written = forge(["demo", "--repo", "--out", out]);
    assert.equal(written.status, 0, written.stderr);
    assert.match(written.stdout, /演示站完成/);

    const checked = forge(["demo", "--repo", "--out", out, "--check"]);
    assert.equal(checked.status, 0, checked.stderr);

    const indexPath = join(out, "index.html");
    writeFileSync(indexPath, `${readFileSync(indexPath, "utf8")}\n`, "utf8");
    const drifted = forge(["demo", "--repo", "--out", out, "--check"]);
    assert.equal(drifted.status, 1);
    assert.match(drifted.stderr, /index\.html/);
  } finally {
    run.cleanup();
  }
});

test("demo：数据源标记为 repo，不是编造的样例", () => {
  const run = temp("forge-demo-source-");
  try {
    const out = join(run.root, "demo");
    assert.equal(forge(["demo", "--repo", "--out", out]).status, 0);
    const library = JSON.parse(readFileSync(join(out, "library.json"), "utf8")) as {
      source?: string;
      counts?: { total?: number };
    };
    assert.equal(library.source, "repo");
    assert.ok((library.counts?.total ?? 0) >= 30);
  } finally {
    run.cleanup();
  }
});

test("listing：上一轮清单里多出来的文件会被清掉（只清生成器写过的）", () => {
  const run = temp("forge-listing-stale-");
  try {
    const out = join(run.root, "listing");
    // 模拟上一轮生成器写过 9999-stale.md，这一轮不再生成它。
    const stale = "plugins/forge/skills/forge/references/9999-stale.md";
    mkdirSync(join(out, "plugins/forge/skills/forge/references"), { recursive: true });
    writeFileSync(join(out, stale), "旧产物\n", "utf8");
    writeFileSync(
      join(out, ".forge-manifest.json"),
      `${JSON.stringify({ schema_version: 1, generator: "forge listing", files: [stale, ".forge-manifest.json"] }, null, 2)}\n`,
      "utf8",
    );

    const written = forge(["listing", "--repo", "--out", out]);
    assert.equal(written.status, 0, written.stderr);
    assert.equal(existsSync(join(out, stale)), false, "上一轮产物没有被清掉");
  } finally {
    run.cleanup();
  }
});

test("listing / demo 都必须给 --out（写哪儿是个决定）", () => {
  assert.equal(forge(["listing", "--repo"]).status, 2);
  assert.equal(forge(["demo", "--repo"]).status, 2);
});
