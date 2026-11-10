/**
 * Phase 4 的**退出条件**，写成可执行的形式。
 *
 *   模型只做抽取：它的产出进候选区，**进不了** `assets/`；
 *   出处是编的那些被丢掉，而且全过程**不需要 API key**。
 *
 * 为什么要跑真的子进程：`--cassette` / `--record` 的互斥、退出码、
 * 候选区的实际落盘形状，这些只有真跑起来才会出错。
 *
 * 为什么每条用例都要断言"assets/ 里一条都没有"：这是 S16 的全部内容。
 * 一个只在报告里说"我进了候选区"、实际却写了 assets 的实现，在日志上完全看不出区别。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXTRACTION_HARNESS,
  buildExtractionRequest,
  type ExtractionInput,
  type ModelRequest,
} from "@forge/core";
import { CASSETTE_VERSION, openVault, requestDigest, writeCassette, type Cassette } from "@forge/store";

const REPO = process.cwd();
const CLI = join(REPO, "apps", "cli", "src", "main.ts");
const FIXTURE = join(REPO, "evals", "fixtures", "desensitized-export.json");

/**
 * @param {string[]} args
 * @param {{cwd?: string, env?: Record<string, string>}} [options]
 * @returns {{status: number, stdout: string, stderr: string}}
 */
function forge(
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("node", [CLI, ...args], {
    cwd: options.cwd ?? REPO,
    encoding: "utf8",
    // 环境里**不带任何 API key**：抽取的确定性路径根本不该读它。
    env: {
      PATH: process.env["PATH"] ?? "",
      ...(process.env["NODE_OPTIONS"] ? { NODE_OPTIONS: process.env["NODE_OPTIONS"] } : {}),
      ...options.env,
    },
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function temp(prefix: string): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * 造一份录像：第一条候选引用**真事件**，第二条引用**编造的键**。
 *
 * 两条是刻意凑在一起的：只有"真的留下、假的丢掉"同时发生，
 * 才说明 sanitize 是在逐条判，而不是整批放行或整批丢弃。
 *
 * @param {string} vaultRoot
 * @returns {{path: string, input: ExtractionInput}}
 */
function writeSyntheticCassette(vaultRoot: string): { path: string; input: ExtractionInput } {
  const vault = openVault(vaultRoot);
  const { events } = vault.derive();
  const sourceId = events[0]?.source_id ?? "";
  const input: ExtractionInput = { sourceId, events: events.filter((e) => e.source_id === sourceId) };
  const realKey = input.events[0]?.key ?? "";

  const response = JSON.stringify({
    assertions: [
      {
        type: "decision",
        title: "一条真的决策",
        body: "出处指向一条真实存在的事件。",
        sources: [`src://${sourceId}#k:${realKey}`],
        confidence: 1,
      },
      {
        type: "rule",
        title: "一条编造出处的规则",
        body: "这条的键在本来源里不存在。",
        sources: [`src://${sourceId}#k:${realKey}不存在`],
        confidence: 1,
      },
    ],
  });

  const request: ModelRequest = buildExtractionRequest(input);
  const cassette: Cassette = {
    cassette_version: CASSETTE_VERSION,
    about: "apps/cli/test/extract.test.ts 里造的合成录像（不是真实模型的回答）",
    model: "synthetic-fixture",
    harness: EXTRACTION_HARNESS,
    records: [{ request_digest: requestDigest(request), response }],
  };
  const path = join(vaultRoot, "cassette.json");
  writeCassette(path, cassette);
  return { path, input };
}

/** 把库里所有 markdown 资产文件读出来（`assets/` 下）。 */
function assetFiles(vaultRoot: string): string[] {
  const assets = join(vaultRoot, "assets");
  if (!existsSync(assets)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(assets);
  return out.sort();
}

test("退出条件：抽取只写候选区，assets/ 一条都不进，全程不需要 API key", () => {
  const run = temp("forge-extract-");
  try {
    const vaultRoot = join(run.root, "vault");
    assert.equal(forge(["compile", "--vault", vaultRoot, "--import", FIXTURE]).status, 0);

    const { path } = writeSyntheticCassette(vaultRoot);
    const result = forge(["extract", "--vault", vaultRoot, "--cassette", path]);

    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes("模型产出**不进 assets/**"), result.stdout);

    // 真的那条活下来、编造的那条被丢掉。
    const inbox = readdirSync(join(vaultRoot, "_inbox")).filter((name) => name.endsWith(".json"));
    assert.equal(inbox.length, 1);
    const record = JSON.parse(readFileSync(join(vaultRoot, "_inbox", inbox[0] ?? ""), "utf8")) as {
      origin: string;
      confidence: number;
      candidate_id: string;
    };
    assert.equal(record.origin, "model");
    // 模型说 1，入库按 0.3 起算。
    assert.equal(record.confidence, 0.3);
    assert.ok(record.candidate_id.startsWith("cand_"));
    assert.ok(result.stdout.includes("CAND_SPAN_NOT_IN_INPUT"), "编造的出处必须被看见");

    // **最关键的一条**：assets/ 里一个文件都没有。
    assert.deepEqual(assetFiles(vaultRoot), []);
  } finally {
    run.cleanup();
  }
});

test("幂等：同一份录像跑两次，候选区的字节完全相同（R6）", () => {
  const run = temp("forge-extract-twice-");
  try {
    const vaultRoot = join(run.root, "vault");
    assert.equal(forge(["compile", "--vault", vaultRoot, "--import", FIXTURE]).status, 0);
    const { path } = writeSyntheticCassette(vaultRoot);

    assert.equal(forge(["extract", "--vault", vaultRoot, "--cassette", path]).status, 0);
    const first = readdirSync(join(vaultRoot, "_inbox")).map((name) =>
      readFileSync(join(vaultRoot, "_inbox", name), "utf8"),
    );

    assert.equal(forge(["extract", "--vault", vaultRoot, "--cassette", path]).status, 0);
    const second = readdirSync(join(vaultRoot, "_inbox")).map((name) =>
      readFileSync(join(vaultRoot, "_inbox", name), "utf8"),
    );

    assert.deepEqual(first, second);
    assert.equal(second.length, 1, "跑两次不产生第二份候选");
  } finally {
    run.cleanup();
  }
});

test("录像对不上就报错，不静默返回空候选", () => {
  const run = temp("forge-extract-miss-");
  try {
    const vaultRoot = join(run.root, "vault");
    assert.equal(forge(["compile", "--vault", vaultRoot, "--import", FIXTURE]).status, 0);
    const { path } = writeSyntheticCassette(vaultRoot);

    // 把来源换掉：请求指纹因此变了，录像里当然没有这一段。
    const cassette = JSON.parse(readFileSync(path, "utf8")) as Cassette;
    cassette.records = cassette.records.map((record) => ({ ...record, request_digest: "0".repeat(64) }));
    writeCassette(path, cassette);

    const result = forge(["extract", "--vault", vaultRoot, "--cassette", path]);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes("没有这次请求的响应"), result.stderr);
    assert.equal(existsSync(join(vaultRoot, "_inbox")) && readdirSync(join(vaultRoot, "_inbox")).length, 0,
      "抽取失败时**一个候选都不许落盘**");
  } finally {
    run.cleanup();
  }
});

test("参数缺失时明确报错：不给默认模型、不给默认录像", () => {
  const run = temp("forge-extract-args-");
  try {
    const vaultRoot = join(run.root, "vault");
    assert.equal(forge(["compile", "--vault", vaultRoot, "--import", FIXTURE]).status, 0);

    const missing = forge(["extract", "--vault", vaultRoot]);
    assert.equal(missing.status, 2);
    assert.ok(missing.stderr.includes("--cassette"));

    const both = forge(["extract", "--vault", vaultRoot, "--cassette", "a.json", "--record", "b.json"]);
    assert.equal(both.status, 2);
    assert.ok(both.stderr.includes("只能给一个"));
  } finally {
    run.cleanup();
  }
});

test("库里没有事件时说清楚要先 compile", () => {
  const run = temp("forge-extract-empty-");
  try {
    const vaultRoot = join(run.root, "vault");
    const result = forge(["extract", "--vault", vaultRoot, "--cassette", join(run.root, "none.json")]);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes("库里没有事件"), result.stderr);
  } finally {
    run.cleanup();
  }
});

test("forge inbox：确认一条候选 = 写出一份**草稿**，并把它移出候选区", () => {
  const run = temp("forge-inbox-");
  try {
    const vaultRoot = join(run.root, "vault");
    assert.equal(forge(["compile", "--vault", vaultRoot, "--import", FIXTURE]).status, 0);
    const { path } = writeSyntheticCassette(vaultRoot);
    assert.equal(forge(["extract", "--vault", vaultRoot, "--cassette", path]).status, 0);

    const listed = forge(["inbox", "--vault", vaultRoot]);
    assert.equal(listed.status, 0, listed.stderr);
    assert.ok(listed.stdout.includes("一条真的决策"), listed.stdout);

    const candidateId = /(cand_[0-9A-Za-z]{26})/.exec(listed.stdout)?.[1] ?? "";
    assert.ok(candidateId.length > 0, listed.stdout);

    // 置信度是必填项。
    const noConfidence = forge(["inbox", "--vault", vaultRoot, "--promote", candidateId, "--date", "2026-11-06"]);
    assert.equal(noConfidence.status, 2);
    assert.ok(noConfidence.stderr.includes("--confidence"));

    const promoted = forge([
      "inbox", "--vault", vaultRoot,
      "--promote", candidateId,
      "--date", "2026-11-06",
      "--confidence", "0.8",
    ]);
    assert.equal(promoted.status, 0, promoted.stderr);
    assert.ok(promoted.stdout.includes("草稿"), promoted.stdout);

    // 资产真的落到了 assets/，而且出处原样搬了过来。
    const files = assetFiles(vaultRoot);
    assert.equal(files.length, 1);
    const text = readFileSync(files[0] ?? "", "utf8");
    assert.ok(text.includes("src://"), text);
    assert.ok(text.includes("confidence: 0.8"));

    // 候选区里没有它了；再确认一次会被拒（同一处出处不能有两份记录）。
    const after = forge(["inbox", "--vault", vaultRoot]);
    assert.ok(after.stdout.includes("候选区是空的"), after.stdout);
    const again = forge([
      "inbox", "--vault", vaultRoot,
      "--promote", candidateId,
      "--date", "2026-11-06",
      "--confidence", "0.8",
    ]);
    assert.equal(again.status, 1);
    assert.ok(again.stderr.includes("候选区里没有"), again.stderr);
  } finally {
    run.cleanup();
  }
});
