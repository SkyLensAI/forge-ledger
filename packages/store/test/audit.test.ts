/**
 * 审计层与维护动作的测试（S26 / S27）。
 *
 * 这里跑的是**真的写入路径**：`importText` → `promote` → `confirm` → `resolve`，
 * 每一条都经过 `writeAuthored`，而它要一条审计条目才肯写。
 *
 * 三件事是重点：
 *
 * 1. **审计覆盖每一次写入**（不是"记得写就有"）：一个动作都不做时是空的，
 *    做过之后每一条资产都能在日志里找到主人。
 * 2. **链是真的**：删一行、改一行，`verify()` 必须报出来。
 * 3. **`confirm` 只动一个字段**：正文、出处、题面一个字节都不许变——
 *    它是第二个能写已有资产的地方（ADR-0028 说的是"改写状态只有一条通路"），
 *    所以它必须被限制到只改 `last_confirmed`（ADR-0036）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AUDIT_GAP_CODES, AUDIT_KINDS } from "@forge/core";
import { newFrontMatter, parseAssetDocument, renderAssetDocument } from "@forge/schema";
import { openVault, replaceFrontMatter } from "../src/index.ts";

const FIXTURE = join(process.cwd(), "evals", "fixtures", "desensitized-export.json");

function temp(prefix: string): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * 造一个库：导一份来源、塞一条候选、把它确认成一条 state 资产。
 *
 * 走的是**真的路径**（`inbox.put` → `promote`），而不是直接往 `assets/` 写文件——
 * 直接写文件正是审计看不见的那条路，用它做测试就等于绕开了被测的东西。
 *
 * @param {string} root
 * @returns {{vault: import("../src/index.ts").Vault; path: string; id: string}}
 */
function seededVault(root: string): { vault: ReturnType<typeof openVault>; path: string; id: string } {
  // 时钟冻住：审计条目里的时刻是**输入**，所以这份测试是可复现的（R6）。
  let tick = Date.parse("2026-11-01T09:00:00Z");
  const vault = openVault(root, { now: () => (tick += 1000) });

  vault.importText(readFileSync(FIXTURE, "utf8"), { originalName: "export.json", actor: "allentire" });

  const candidate = {
    candidate_version: 1,
    candidate_id: "cand_01M6Q2FD00NVKBVBH80QD63VSX",
    type: "state" as const,
    title: "索引层的存储后端",
    subject: "索引层的存储后端",
    body: "# 索引层的存储后端\n\n## 当前状态\n\n索引层用 node:sqlite。\n",
    sources: ["file://docs/implement2.md#t:检索优先，绝不预加载整个大脑"],
    confidence: 0.5,
    origin: "model" as const,
    harness: "test",
    model: "fixture",
  };
  // 候选 ID 是**内容寻址**的（ADR-0013）：写进去的时候会被重算，
  // 所以这里必须用落盘之后返回的那个，而不是自己编一个。
  const stored = vault.inbox.put(candidate);
  const candidateId = stored.path.split(/[\\/]/).pop()?.replace(".json", "") ?? "";
  const promoted = vault.promote(candidateId, {
    date: "2026-11-01",
    confidence: 0.8,
    actor: "allentire",
    atMs: Date.parse("2026-11-01T10:00:00Z"),
    random: new Uint8Array(16),
  });
  assert.equal(promoted.ok, true);
  if (!promoted.ok) throw new Error("夹具没建立起来");

  const id = promoted.asset.path.split("/").pop()?.replace(".md", "") ?? "";
  return { vault, path: promoted.asset.path, id };
}

test("审计：每一次写入都有条目，而且链是完整的", () => {
  const run = temp("forge-audit-");
  try {
    const { vault, id, path } = seededVault(run.root);
    const { entries, problems } = vault.audit.read();
    assert.deepEqual(problems, []);
    assert.deepEqual(
      entries.map((entry) => entry.kind),
      [AUDIT_KINDS.SOURCE_IMPORTED, AUDIT_KINDS.ASSET_PROMOTED],
    );
    assert.equal(entries[1]?.subject, id);
    assert.equal(entries[1]?.actor, "allentire");
    assert.equal(vault.audit.verify().ok, true);

    // 与库对账：日志记的那条资产在库里 → 没有 DANGLING，也没有 UNATTRIBUTED。
    const gaps = vault.audit.completeness(vault.assets.scan().docs);
    assert.deepEqual(gaps, []);
    assert.equal(path.length > 0, true);
  } finally {
    run.cleanup();
  }
});

test("审计：日志是 JSONL —— 一行一条，每一行都能读回来", () => {
  const run = temp("forge-audit-line-");
  try {
    const { vault } = seededVault(run.root);
    const text = readFileSync(vault.audit.path(), "utf8");
    const lines = text.split("\n").filter((line) => line.length > 0);
    assert.equal(lines.length, vault.audit.read().entries.length);
    for (const line of lines) {
      assert.equal(line.startsWith("{") && line.endsWith("}"), true, `这一行不是一条记录：${line.slice(0, 40)}`);
    }
  } finally {
    run.cleanup();
  }
});

test("审计：删掉一行 —— verify 必须报出来（不是静默地少一条）", () => {
  const run = temp("forge-audit-tamper-");
  try {
    const { vault } = seededVault(run.root);
    const file = vault.audit.path();
    const lines = readFileSync(file, "utf8").split("\n").filter((line) => line.length > 0);
    assert.equal(lines.length, 2);
    writeFileSync(file, `${lines[1] ?? ""}\n`, "utf8");

    const verification = vault.audit.verify();
    assert.equal(verification.ok, false);
    assert.equal(verification.problems.some((problem) => problem.includes("缺了条目")), true);
  } finally {
    run.cleanup();
  }
});

test("审计：改一行 —— verify 必须报「内容被改过」", () => {
  const run = temp("forge-audit-edit-");
  try {
    const { vault } = seededVault(run.root);
    const file = vault.audit.path();
    const text = readFileSync(file, "utf8");
    // 把 actor 换一个人：这是"改历史"最便宜的形状。
    writeFileSync(file, text.replace('"actor":"allentire"', '"actor":"someone-else"'), "utf8");
    const verification = vault.audit.verify();
    assert.equal(verification.ok, false);
    assert.equal(verification.problems.some((problem) => problem.includes("内容被改过")), true);
  } finally {
    run.cleanup();
  }
});

test("对账：有人直接往 assets/ 放文件 —— 审计看不见，但健康检查必须看得见", () => {
  const run = temp("forge-audit-intruder-");
  try {
    const { vault } = seededVault(run.root);
    // 绕过 forge 的写入：文件系统不会问"你记了吗"。
    const frontMatter = newFrontMatter("rule", "rule_01M6Q2FD00NVKBVBH80QD63VSX", "2026-11-02");
    frontMatter.sources = ["file://docs/implement2.md#t:检索优先，绝不预加载整个大脑"];
    frontMatter.origin_incident = "file://docs/implement2.md#t:检索优先，绝不预加载整个大脑";
    const body = "# 手写的一条规则\n\n## 规则\n\n不许手写。\n\n## 强制\n\n靠审计看得见它。\n";
    const intruderPath = join(run.root, "assets", "rule", "rule_01M6Q2FD00NVKBVBH80QD63VSX.md");
    mkdirSync(dirname(intruderPath), { recursive: true });
    writeFileSync(intruderPath, renderAssetDocument(frontMatter, body), "utf8");

    const gaps = vault.audit.completeness(vault.assets.scan().docs);
    assert.deepEqual(
      gaps.map((gap) => gap.code),
      [AUDIT_GAP_CODES.UNATTRIBUTED],
    );
    // 而且是**真的从盘上**读出来的：那一条能被解析成资产。
    assert.equal(vault.assets.scan().docs.length, 2);
  } finally {
    run.cleanup();
  }
});

test("审计：没有日志文件 ≠ 日志里没有这一条", () => {
  const run = temp("forge-audit-absent-");
  try {
    const vault = openVault(run.root);
    assert.equal(vault.audit.exists(), false, "一次都没写过时，日志文件**不存在**");
    assert.deepEqual(vault.audit.read().entries, []);
    assert.equal(vault.audit.verify().ok, true, "空日志是完整的，不是「断了」");
  } finally {
    run.cleanup();
  }
});

test("改写 front-matter：正文**逐字节**不动，而且改两次的结果一样（regressions/0007）", () => {
  const run = temp("forge-rewrite-");
  try {
    const { vault, path } = seededVault(run.root);
    const doc = vault.assets.read(path);
    assert.ok(doc !== null);

    // 用仓库里真实的资产文件（带 front-matter 的 markdown）做一遍：
    // 解析 → 只换 front-matter → 解析，正文必须一个字节都不差。
    const first = replaceFrontMatter(doc.raw, { ...doc.frontMatter, last_confirmed: "2026-12-01" });
    const reparsed = parseAssetDocument(path, first);
    assert.ok(reparsed.ok);
    assert.equal(reparsed.doc.body, doc.body, "正文必须原样：解析出来的 body 与写进去的字节是同一个");

    // 再改一次：**必须与第一次逐字节相同**。上一版的实现每次改写都往正文前面
    // 多加一个空行——不报错、不影响阅读、静默累积，而且它让"正文一个字节都没动"变成假话。
    const second = replaceFrontMatter(first, { ...doc.frontMatter, last_confirmed: "2026-01-01" });
    assert.equal(
      second.slice(second.indexOf("#")),
      first.slice(first.indexOf("#")),
      "改两次的结果必须一样：正文里的换行不许累积",
    );
  } finally {
    run.cleanup();
  }
});

test("`confirm`：只动 last_confirmed —— 正文、出处、题面一个字节都不变（ADR-0036）", () => {
  const run = temp("forge-confirm-");
  try {
    const { vault, id, path } = seededVault(run.root);
    const before = readFileSync(join(run.root, path), "utf8");
    const beforeDoc = vault.assets.read(path);
    assert.ok(beforeDoc !== null);

    const result = vault.confirm(id, {
      date: "2026-12-01",
      note: "又问了一遍，索引层仍然是 node:sqlite",
      actor: "allentire",
      atMs: Date.parse("2026-12-01T09:00:00Z"),
    });
    assert.equal(result.ok, true);

    const after = readFileSync(join(run.root, path), "utf8");
    const afterDoc = parseAssetDocument(path, after);
    assert.ok(afterDoc.ok);
    assert.equal(afterDoc.doc.frontMatter.last_confirmed, "2026-12-01");
    assert.equal(afterDoc.doc.body, beforeDoc.body, "正文一个字节都不许动");
    assert.deepEqual(afterDoc.doc.frontMatter.sources, beforeDoc.frontMatter.sources);
    assert.equal(afterDoc.doc.frontMatter.subject, beforeDoc.frontMatter.subject);
    assert.notEqual(before, after, "last_confirmed 变了，所以文件确实变了");

    // 理由进审计、**不进资产**：资产里躺着一段"为什么我认为它成立"，
    // 会让下一个读它的人分不清哪句是事实、哪句是当时的辩解。
    assert.equal(after.includes("又问了一遍"), false);
    const tail = vault.audit.read().entries.at(-1);
    assert.equal(tail?.kind, AUDIT_KINDS.STATE_CONFIRMED);
    assert.equal(tail?.detail["note"], "又问了一遍，索引层仍然是 node:sqlite");
    assert.equal(vault.audit.verify().ok, true);
  } finally {
    run.cleanup();
  }
});

test("`confirm`：往回填日期、空理由、非 state —— 三种都不许过", () => {
  const run = temp("forge-confirm-guard-");
  try {
    const { vault, id } = seededVault(run.root);
    const base = { note: "仍然成立", atMs: Date.parse("2026-12-01T09:00:00Z") };

    // 先确认一次（刚 promote 出来的草稿 `last_confirmed` 是 null，往回填对它没有意义）。
    assert.equal(vault.confirm(id, { ...base, date: "2026-11-15" }).ok, true);

    assert.equal(vault.confirm(id, { ...base, date: "2026-11-01" }).ok, false, "确认只能把「最后一次看过它」往后推");
    assert.equal(
      vault.confirm(id, { ...base, date: "2026-12-01", note: "   " }).ok,
      false,
      "没有理由的确认等于一次点击",
    );
    assert.equal(vault.confirm("state_01M6Q2FD00NVKBVBH80QD63VSY", { ...base, date: "2026-12-01" }).ok, false);
  } finally {
    run.cleanup();
  }
});

test("健康检查：只读 —— 跑一遍之后，库一个字节都没变", () => {
  const run = temp("forge-health-readonly-");
  try {
    const { vault, path, id } = seededVault(run.root);
    // 先确认一次：promote 出来的草稿 `last_confirmed` 是 null（那是"还没确认过"，
    // 归审核报 REQUIRED_FIELD_MISSING），而这里要测的是"到期"。
    assert.equal(
      vault.confirm(id, { date: "2026-11-01", note: "第一次确认", atMs: Date.parse("2026-11-01T11:00:00Z") }).ok,
      true,
    );
    const beforeAsset = readFileSync(join(run.root, path), "utf8");
    const beforeAudit = readFileSync(vault.audit.path(), "utf8");

    const first = vault.health({ today: "2026-12-31" });
    const second = vault.health({ today: "2026-12-31" });

    assert.equal(first.rendered, second.rendered, "同一份库、同一个基准日：报告逐字节相同（R6）");
    assert.equal(readFileSync(join(run.root, path), "utf8"), beforeAsset, "健康检查改了资产 —— 它只许读");
    assert.equal(readFileSync(vault.audit.path(), "utf8"), beforeAudit, "健康检查往审计里写了东西 —— 它只许读");
    // 到期的那条必须被报出来（30 天窗口，11-01 → 12-31 是 60 天）。
    assert.equal(first.report.due.length, 1);
    assert.equal(first.report.due[0]?.ageDays, 60);
  } finally {
    run.cleanup();
  }
});

test("健康检查：索引漂移能被真的抓到（拆掉索引层）", () => {
  const run = temp("forge-health-index-");
  try {
    const { vault } = seededVault(run.root);
    vault.compile();
    const clean = vault.health({ today: "2026-11-06" });
    assert.equal(
      clean.report.findings.some((finding) => finding.code === "HEALTH_INDEX_DRIFT"),
      false,
      "编译过之后索引层与库一致",
    );

    // 删掉索引层的文件：下一次健康检查必须报出来（它不是"索引一致"）。
    rmSync(join(run.root, "index", "INDEX.md"), { force: true });
    rmSync(join(run.root, "index", "forge.sqlite"), { force: true });
    const drifted = vault.health({ today: "2026-11-06" });
    assert.equal(
      drifted.report.findings.some((finding) => finding.code === "HEALTH_INDEX_DRIFT"),
      true,
    );
  } finally {
    run.cleanup();
  }
});

test("周报：窗口按天过滤，而且**没有日志时要如实说**", () => {
  const run = temp("forge-weekly-");
  try {
    const { vault } = seededVault(run.root);
    const week = vault.weekly({ today: "2026-11-06" });
    assert.deepEqual(week.window, { start: "2026-10-31", end: "2026-11-06" });
    // 夹具的两条都发生在 11-01，落在窗口里。
    assert.equal(week.audit?.length, 2);
    assert.equal(week.rendered.includes("asset-promoted：1 条"), true);

    // 窗口往前挪：条目落在窗口**之前**，于是"这一周确实没有过写入"。
    const quiet = vault.weekly({ today: "2026-10-20" });
    assert.deepEqual(quiet.audit, []);
    assert.equal(quiet.rendered.includes("这一周确实没有过写入"), true);

    // 从没写过审计的库：`audit` 是 null，措辞必须不一样。
    const empty = openVault(join(run.root, "empty"));
    assert.equal(empty.weekly({ today: "2026-11-06" }).audit, null);
    assert.equal(empty.weekly({ today: "2026-11-06" }).rendered.includes("这不等于这一周什么都没发生"), true);
  } finally {
    run.cleanup();
  }
});
