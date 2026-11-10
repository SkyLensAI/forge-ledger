/**
 * 维护机器的 CLI 端到端（S25–S28）。
 *
 * 跑的是**真的子进程**：退出码、参数校验、报告落到 stdout 还是文件——
 * 这三样只有在真跑起来的时候才会出错。而维护这套东西的价值**恰好全在退出码上**：
 * 定时任务靠它决定要不要来敲门，`0` 与 `1` 写反了，整个新鲜度任务就变成
 * 一封每周都没人看的邮件。
 *
 * 覆盖四件事：
 *   `health`   需要 `--today`（否则拒绝），`--due` 只问到期的，有需要动手的事时退出码为 1
 *   `confirm`  `--note` / `--date` 必填，改完之后审计里多一条
 *   `audit`    `--verify` 在链断掉时非零
 *   `weekly`   窗口是输入，没有日志时措辞不一样
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = process.cwd();
const CLI = join(REPO, "apps", "cli", "src", "main.ts");
const FIXTURE = join(REPO, "evals", "fixtures", "desensitized-export.json");

/**
 * @param {string[]} args
 * @returns {{status: number, stdout: string, stderr: string}}
 */
function forge(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("node", [CLI, ...args], {
    cwd: REPO,
    encoding: "utf8",
    // 环境里不带任何 API key：整个维护链路都不该碰到模型。
    env: { PATH: process.env["PATH"] ?? "" },
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function temp(prefix: string): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * 造一个带一条资产、一条候选的库：compile → 手工塞一条候选 → inbox --promote。
 *
 * 用 CLI 走完整条路（而不是直接调 store）：这一步同时验证了
 * `inbox --promote` 会把审计条目带上——**写入的见证人是这条命令产出的**。
 *
 * @param {string} vaultRoot
 * @returns {string} 资产的 ID
 */
function seed(vaultRoot: string): string {
  assert.equal(forge(["compile", "--vault", vaultRoot, "--import", FIXTURE]).status, 0);

  const candidate = {
    candidate_version: 1,
    candidate_id: "cand_01M6Q2FD00NVKBVBH80QD63VSX",
    type: "state",
    title: "索引层的存储后端",
    subject: "索引层的存储后端",
    body: "# 索引层的存储后端\n\n## 当前状态\n\n索引层用 node:sqlite。\n",
    sources: ["file://docs/implement2.md#t:检索优先，绝不预加载整个大脑"],
    confidence: 0.5,
    origin: "model",
    harness: "cli-test",
    model: "fixture",
  };
  const inbox = join(vaultRoot, "_inbox");
  writeFileSync(join(inbox, `${candidate.candidate_id}.json`), JSON.stringify(candidate), "utf8");

  const promoted = forge([
    "inbox",
    "--vault",
    vaultRoot,
    "--promote",
    candidate.candidate_id,
    "--date",
    "2026-11-01",
    "--confidence",
    "0.8",
    "--actor",
    "allentire",
  ]);
  assert.equal(promoted.status, 0, promoted.stderr);
  const id = /(state_[0-9A-Za-z]{26})/.exec(promoted.stdout)?.[1];
  assert.ok(id !== undefined, `promote 的输出里应该有资产 ID：${promoted.stdout}`);
  return id;
}

test("health：不给 --today 就拒绝（基准日必须是输入，不是「跑的那一刻」）", () => {
  const run = temp("forge-cli-health-");
  try {
    const vaultRoot = join(run.root, "vault");
    const missing = forge(["health", "--vault", vaultRoot]);
    assert.equal(missing.status, 2);
    assert.equal(missing.stderr.includes("必须给 --today"), true);
  } finally {
    run.cleanup();
  }
});

test("health：空的库是健康的；到期之后 `--due` 会把它列出来（退出码给 cron 用）", () => {
  const run = temp("forge-cli-health-due-");
  try {
    const vaultRoot = join(run.root, "vault");
    assert.equal(forge(["compile", "--vault", vaultRoot, "--import", FIXTURE]).status, 0);

    const clean = forge(["health", "--vault", vaultRoot, "--today", "2026-11-06"]);
    assert.equal(clean.status, 0, clean.stderr);
    assert.equal(clean.stdout.includes("## 结论"), true);
    assert.equal(clean.stdout.includes("需要你处理的：0 处"), true);

    const id = seed(vaultRoot);
    // 先确认一次（草稿的 last_confirmed 是 null），再往前推到过期。
    assert.equal(
      forge([
        "confirm",
        id,
        "--vault",
        vaultRoot,
        "--date",
        "2026-11-01",
        "--note",
        "看过一遍，仍然是 sqlite",
      ]).status,
      0,
    );

    const early = forge(["health", "--vault", vaultRoot, "--today", "2026-11-20", "--due"]);
    assert.equal(early.status, 0, "还没到期：cron 不该被叫醒");
    assert.equal(early.stdout.includes("没有到期的 state"), true);

    const late = forge(["health", "--vault", vaultRoot, "--today", "2027-01-15", "--due"]);
    assert.equal(late.status, 1, "到期了：退出码必须非零，否则定时任务不会来敲门");
    assert.equal(late.stdout.includes("已 75 天没确认"), true);
    assert.equal(late.stdout.includes("只能问，不能自己答"), true);

    // 到期**不会**被健康检查自己修掉：再跑一次，它还在。
    const again = forge(["health", "--vault", vaultRoot, "--today", "2027-01-15", "--due"]);
    assert.equal(again.status, 1);
  } finally {
    run.cleanup();
  }
});

test("confirm：--note / --date 必填，改了之后审计里多一条（理由进审计、不进资产）", () => {
  const run = temp("forge-cli-confirm-");
  try {
    const vaultRoot = join(run.root, "vault");
    const id = seed(vaultRoot);

    const noNote = forge(["confirm", id, "--vault", vaultRoot, "--date", "2026-11-20"]);
    assert.equal(noNote.status, 2);
    assert.equal(noNote.stderr.includes("没有理由的确认等于一次点击"), true);

    const noDate = forge(["confirm", id, "--vault", vaultRoot, "--note", "仍然成立"]);
    assert.equal(noDate.status, 2);

    const ok = forge([
      "confirm",
      id,
      "--vault",
      vaultRoot,
      "--date",
      "2026-11-20",
      "--note",
      "又问了一遍，索引层仍然是 node:sqlite",
      "--actor",
      "allentire",
    ]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout.includes("只动了这一个字段"), true);

    const asset = readFileSync(join(vaultRoot, "assets", "state", `${id}.md`), "utf8");
    assert.equal(asset.includes("又问了一遍"), false, "理由不许进资产");
    assert.equal(asset.includes("last_confirmed: \"2026-11-20\""), true);

    const audit = forge(["audit", "--vault", vaultRoot]);
    assert.equal(audit.status, 0, audit.stderr);
    assert.equal(audit.stdout.includes("state-confirmed"), true);
    assert.equal(audit.stdout.includes("又问了一遍"), true);
  } finally {
    run.cleanup();
  }
});

test("audit --verify：链完整时退出码 0，被改过之后非零", () => {
  const run = temp("forge-cli-audit-");
  try {
    const vaultRoot = join(run.root, "vault");
    seed(vaultRoot);

    const clean = forge(["audit", "--vault", vaultRoot, "--verify"]);
    assert.equal(clean.status, 0, clean.stderr);
    assert.equal(clean.stdout.includes("审计链完整"), true);

    // 把第一个人换掉：这是"改历史"最便宜的形状。
    const file = join(vaultRoot, "audit", "audit.jsonl");
    writeFileSync(file, readFileSync(file, "utf8").replace('"actor":"allentire"', '"actor":"someone-else"'), "utf8");

    const broken = forge(["audit", "--vault", vaultRoot, "--verify"]);
    assert.equal(broken.status, 1);
    assert.equal(broken.stderr.includes("内容被改过"), true);
    assert.equal(
      broken.stderr.includes("恢复备份") && broken.stderr.includes("手工调 seq"),
      true,
      "修法必须是「恢复备份或写下来」，不是「把 seq 改回去」——后者是改历史，不是修审计",
    );
  } finally {
    run.cleanup();
  }
});

test("audit：过滤是读路径；「筛选后为空」不等于「日志为空」", () => {
  const run = temp("forge-cli-audit-filter-");
  try {
    const vaultRoot = join(run.root, "vault");
    seed(vaultRoot);

    const entries = readFileSync(join(vaultRoot, "audit", "audit.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { at: string; actor: string; kind: string });
    const promoted = entries.find((entry) => entry.kind === "asset-promoted");
    if (promoted === undefined) assert.fail("seed 之后应该有一条 asset-promoted");
    const day = promoted.at.slice(0, 10);

    const byActor = forge(["audit", "--vault", vaultRoot, "--actor", "allentire"]);
    assert.equal(byActor.status, 0, byActor.stderr);
    assert.equal(byActor.stdout.includes("筛选后 1 条：actor=allentire"), true);
    assert.equal(byActor.stdout.includes("asset-promoted"), true);

    const byKind = forge(["audit", "--vault", vaultRoot, "--kind", "asset-promoted"]);
    assert.equal(byKind.status, 0, byKind.stderr);
    assert.equal(byKind.stdout.includes("asset-promoted"), true);
    assert.equal(byKind.stdout.includes("source-imported"), false, "过滤后的列表里不该出现别的种类");

    const byDay = forge(["audit", "--vault", vaultRoot, "--since", day, "--until", day]);
    assert.equal(byDay.status, 0, byDay.stderr);
    assert.equal(byDay.stdout.includes(`since=${day}`), true);
    assert.equal(byDay.stdout.includes("asset-promoted"), true);

    const empty = forge(["audit", "--vault", vaultRoot, "--actor", "nobody"]);
    assert.equal(empty.status, 0, empty.stderr);
    assert.equal(empty.stdout.includes("筛选后 0 条"), true);
    assert.equal(empty.stdout.includes("这不等于日志是空的"), true);

    const future = forge(["audit", "--vault", vaultRoot, "--since", "2099-01-01"]);
    assert.equal(future.status, 0, future.stderr);
    assert.equal(future.stdout.includes("筛选后 0 条"), true);

    const badKind = forge(["audit", "--vault", vaultRoot, "--kind", "made-up"]);
    assert.equal(badKind.status, 2);
    assert.equal(badKind.stderr.includes("不认识的审计种类"), true);

    const badDate = forge(["audit", "--vault", vaultRoot, "--since", "2026-13-99"]);
    assert.equal(badDate.status, 2);
    assert.equal(badDate.stderr.includes("YYYY-MM-DD"), true);

    const inverted = forge(["audit", "--vault", vaultRoot, "--since", "2026-12-01", "--until", "2026-01-01"]);
    assert.equal(inverted.status, 2);
    assert.equal(inverted.stderr.includes("不能晚于"), true);

    const verify = forge(["audit", "--vault", vaultRoot, "--verify", "--actor", "allentire"]);
    assert.equal(verify.status, 0, verify.stderr);
    assert.equal(verify.stderr.includes("过滤选项对 --verify 无效"), true);
  } finally {
    run.cleanup();
  }
});

test("weekly：窗口是输入；没有审计日志时**不许**说「这一周很安静」", () => {
  const run = temp("forge-cli-weekly-");
  try {
    const vaultRoot = join(run.root, "vault");
    seed(vaultRoot);

    // 审计时刻由 CLI 边界上的 `Date.now()` 写入，测试改不了它；所以窗口必须从
    // **实际写下的那条记录**推出来。写死一个历史日期会让这条测试在日期过去之后
    // 必然变红（2026-11-07 实测），而它测的只是「今天几号」，不是周报的窗口逻辑。
    const promoted = readFileSync(join(vaultRoot, "audit", "audit.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { at: string; kind: string })
      .find((entry) => entry.kind === "asset-promoted");
    if (promoted === undefined) assert.fail("seed 之后审计里应该有一条 asset-promoted");
    const day = promoted.at.slice(0, 10);

    const week = forge(["weekly", "--vault", vaultRoot, "--today", day, "--days", "1"]);
    assert.equal(week.status, 0, week.stderr);
    assert.equal(week.stdout.includes(`周报（${day} → ${day}）`), true);
    assert.equal(week.stdout.includes("asset-promoted：1 条"), true);

    const noToday = forge(["weekly", "--vault", vaultRoot]);
    assert.equal(noToday.status, 2);

    // 另一个库：一次都没写过审计。
    const empty = join(run.root, "empty");
    const bare = forge(["weekly", "--vault", empty, "--today", "2026-11-06"]);
    assert.equal(bare.status, 0, bare.stderr);
    assert.equal(bare.stdout.includes("这不等于这一周什么都没发生"), true);
  } finally {
    run.cleanup();
  }
});

test("health --out：报告写进文件，字节与 stdout 那份相同（周报可以重印）", () => {
  const run = temp("forge-cli-health-out-");
  try {
    const vaultRoot = join(run.root, "vault");
    const out = join(run.root, "health.md");
    assert.equal(forge(["compile", "--vault", vaultRoot, "--import", FIXTURE]).status, 0);
    assert.equal(forge(["health", "--vault", vaultRoot, "--today", "2026-11-06", "--out", out]).status, 0);

    const file = readFileSync(out, "utf8");
    const printed = forge(["health", "--vault", vaultRoot, "--today", "2026-11-06"]).stdout;
    assert.equal(file, printed, "落盘的报告与打印出来的必须是同一段字节");
  } finally {
    run.cleanup();
  }
});
