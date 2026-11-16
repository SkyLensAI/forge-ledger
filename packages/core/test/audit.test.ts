/**
 * 审计的测试 —— 重点是那三种**必须被抓到**的破坏（S27）：
 * 删一条、改一条、换两条的顺序。
 *
 * 每一条都配了一个"干净的时候必须零问题"的对照：一个永远报红的检查
 * 比没有检查更糟——它会训练人无视红色，而审计的全部价值就是"红的时候有人信"。
 *
 * 这个文件里有两处是**真实踩过的坑**（`evals/regressions/0006`）：
 *
 * 1. 条目必须是**一行**（JSONL 的名字就是它的契约）。缩进版塞进去之后，
 *    写入看着正常，读的时候每一行都解析失败。
 * 2. 哈希**不能包含它自己**。把 `hash` 也算进被哈希的字节里，后果是
 *    每一条刚写下的记录立刻被判成"内容被改过"。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SCHEMA_VERSION, renderAssetDocument, type AssetDoc, type AssetFrontMatter } from "@forge/schema";
import {
  AUDIT_GAP_CODES,
  AUDIT_KINDS,
  GENESIS_HASH,
  appendAuditEntry,
  auditCompleteness,
  hashAuditEntry,
  parseAuditLine,
  serializeAuditEntry,
  stableJsonLine,
  startDateOf,
  verifyChain,
  type AuditDraft,
  type AuditEntry,
} from "../src/index.ts";

/**
 * @param {Partial<AuditDraft>} [overrides]
 * @returns {AuditDraft}
 */
function draft(overrides: Partial<AuditDraft> = {}): AuditDraft {
  return {
    at: "2026-11-06T10:00:00.000Z",
    actor: "allentire",
    kind: AUDIT_KINDS.ASSET_PROMOTED,
    subject: "state_01M6Q2FD00NVKBVBH80QD63VSX",
    detail: { candidate_id: "cand_abc", confidence: "0.8" },
    ...overrides,
  };
}

/**
 * 造一条长度为 n 的链。时间是递增的（链要求时间不倒流）。
 *
 * @param {number} n
 * @returns {AuditEntry[]}
 */
function chain(n: number): AuditEntry[] {
  const entries: AuditEntry[] = [];
  let tail: AuditEntry | null = null;
  for (let index = 1; index <= n; index += 1) {
    const pad = String(index).padStart(2, "0");
    tail = appendAuditEntry(tail, draft({ at: `2026-11-06T10:${pad}:00.000Z`, detail: { n: String(index) } }));
    entries.push(tail);
  }
  return entries;
}

/**
 * @param {AssetDoc[]} [docs]
 * @returns {AssetDoc}
 */
function assetDoc(): AssetDoc {
  const frontMatter: AssetFrontMatter = {
    schema_version: SCHEMA_VERSION,
    id: "state_01M6Q2FD00NVKBVBH80QD63VSX",
    type: "state",
    status: "active",
    created: "2026-11-06",
    last_confirmed: "2026-11-06",
    supersedes: null,
    origin_incident: null,
    subject: "索引层的存储后端",
    sources: ["file://docs/implement2.md#t:检索优先，绝不预加载整个大脑"],
    sensitivity: "internal",
    confidence: 0.9,
  };
  const body = "# 存储后端\n\n## 当前状态\n\n索引层用 node:sqlite。\n";
  return {
    path: `assets/state/${frontMatter.id}.md`,
    frontMatter,
    body,
    raw: renderAssetDocument(frontMatter, body),
  };
}

test("链的增长是确定的：同样的草稿得到同样的 seq / prev / hash", () => {
  const first = chain(1)[0];
  assert.ok(first !== undefined);
  const again = appendAuditEntry(null, first);
  assert.deepEqual(again, first);
  assert.equal(first.seq, 1);
  assert.equal(first.prev, GENESIS_HASH);
  // 哈希是 64 位十六进制，不是"随便一个字符串"。
  assert.match(first.hash, /^[0-9a-f]{64}$/);
});

test("条目是**一行**：JSONL 的名字就是它的契约（regressions/0006）", () => {
  const entry = chain(1)[0];
  assert.ok(entry !== undefined);
  const line = serializeAuditEntry(entry);
  assert.equal(line.includes("\n"), false, "一条记录必须占一行——多行 JSON 会让每一行的解析都失败");
  assert.equal(line, stableJsonLine(JSON.parse(line)));
  assert.deepEqual(parseAuditLine(line), { ok: true, entry });
});

test("哈希**不包含它自己**：刚写下的条目必须立刻验得过（regressions/0006）", () => {
  const entry = chain(1)[0];
  assert.ok(entry !== undefined);
  // 把 hash 算进去的实现会让这里变成"永远不相等"。
  assert.equal(hashAuditEntry(entry), entry.hash);
  const withOtherHash = { ...entry, hash: "f".repeat(64) };
  assert.equal(hashAuditEntry(withOtherHash), entry.hash, "hash 字段自己不能影响哈希");
});

test("干净的链：零问题（一个永远报红的检查比没有检查更糟）", () => {
  const verification = verifyChain(chain(5));
  assert.equal(verification.ok, true);
  assert.deepEqual(verification.problems, []);
  assert.equal(verification.entries, 5);
});

test("破坏一：删掉中间一条 —— 必须报缺号与断链", () => {
  const entries = chain(5);
  const tampered = entries.filter((entry) => entry.seq !== 3);
  const problems = verifyChain(tampered).problems;
  assert.equal(problems.length > 0, true);
  assert.equal(problems.some((problem) => problem.includes("缺了条目")), true);
  assert.equal(problems.some((problem) => problem.includes("插入、删除或调换")), true);
});

test("破坏二：改一条的内容 —— 必须报哈希对不上", () => {
  const entries = chain(5);
  const target = entries[2];
  assert.ok(target !== undefined);
  // 改的是**理由**，不是形状：这一条最容易被人当成"顺手修个 typo"。
  const tampered = entries.map((entry) =>
    entry.seq === target.seq ? { ...entry, detail: { ...entry.detail, n: "改了" } } : entry,
  );
  const problems = verifyChain(tampered).problems;
  assert.equal(problems.some((problem) => problem.includes("内容被改过")), true);
});

test("破坏三：换两条的顺序 —— 必须报断链", () => {
  const entries = chain(4);
  const [a, b, c, d] = entries;
  assert.ok(a !== undefined && b !== undefined && c !== undefined && d !== undefined);
  const problems = verifyChain([a, c, b, d]).problems;
  assert.equal(problems.some((problem) => problem.includes("插入、删除或调换")), true);
});

test("破坏四：时间倒流 —— 必须报出来（顺序未必是被「改」了，也可能是时钟不可信）", () => {
  const entries = chain(3);
  const [a, b, c] = entries;
  assert.ok(a !== undefined && b !== undefined && c !== undefined);
  const problems = verifyChain([a, c, b]).problems;
  assert.equal(problems.some((problem) => problem.includes("时间在倒流")), true);
});

test("读不动的行各自有原因，而且**不静默跳过**", () => {
  const broken = parseAuditLine("{不是 JSON");
  assert.equal(broken.ok, false);
  if (!broken.ok) assert.equal(broken.reason.includes("不是合法 JSON"), true);

  const unknownKind = parseAuditLine(JSON.stringify({ ...chain(1)[0], kind: "made-up" }));
  assert.equal(unknownKind.ok, false);
  if (!unknownKind.ok) assert.equal(unknownKind.reason.includes("不认识的 kind"), true);

  const noActor = parseAuditLine(JSON.stringify({ ...chain(1)[0], actor: "" }));
  assert.equal(noActor.ok, false);
  if (!noActor.ok) assert.equal(noActor.reason.includes("actor 不能是空串"), true);

  const badDetail = parseAuditLine(JSON.stringify({ ...chain(1)[0], detail: { n: 1 } }));
  assert.equal(badDetail.ok, false);
  if (!badDetail.ok) assert.equal(badDetail.reason.includes("detail.n 必须是字符串"), true);
});

test("对账：日志指向的资产不在库里 → DANGLING", () => {
  const gaps = auditCompleteness(chain(1), []);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0]?.code, AUDIT_GAP_CODES.DANGLING);
  assert.equal(gaps[0]?.subject, "state_01M6Q2FD00NVKBVBH80QD63VSX");
});

test("对账：审计开始之后出现的资产，日志里查不到 → UNATTRIBUTED", () => {
  const entries = chain(1); // 这份链记的是 state_01M6Q…（见 `draft`）
  const recorded = assetDoc(); // 就是日志里记的那一条
  // 同日出现的另一条资产：日志里没有它，而且它比审计起点晚不了几天——
  // 它只能是"被人直接放进 assets/ 的"，而那正是审计看不见的那种写入。
  const intruder: AssetDoc = {
    ...recorded,
    path: "assets/state/state_01M6Q2FD00NVKBVBH80QD63VSY.md",
    frontMatter: { ...recorded.frontMatter, id: "state_01M6Q2FD00NVKBVBH80QD63VSY" },
  };

  const gaps = auditCompleteness(entries, [recorded, intruder]);
  assert.deepEqual(
    gaps.map((gap) => [gap.code, gap.subject]),
    [[AUDIT_GAP_CODES.UNATTRIBUTED, "state_01M6Q2FD00NVKBVBH80QD63VSY"]],
    "记过的那条不许被报，没记过的那条必须被报——两边的方向都要对",
  );
});

test("对账：审计开启**之前**就存在的资产不追认（否则报告里会长期挂着几十条历史）", () => {
  const entries = chain(1); // 第一天是 2026-11-06
  const recorded = assetDoc(); // 日志里记的那一条（同日，边界当天）
  const older: AssetDoc = {
    ...recorded,
    path: "assets/state/state_01M6Q2FD00NVKBVBH80QD63VSY.md",
    frontMatter: { ...recorded.frontMatter, id: "state_01M6Q2FD00NVKBVBH80QD63VSY", created: "2026-01-01" },
  };
  const unattributed = auditCompleteness(entries, [recorded, older]).filter(
    (gap) => gap.code === AUDIT_GAP_CODES.UNATTRIBUTED,
  );
  assert.deepEqual(unattributed, [], "审计开启之前就存在的资产不该被追认——那会把整段历史都报成问题");
  // 没有日志 = 没有审计起点，不该把整个库都判成未归属。
  assert.equal(auditCompleteness([], [older]).length, 0);
});

test("空日志的起点是 null：`auditCompleteness` 不该拿它当「第一天」", () => {
  assert.equal(startDateOf([]), null);
  assert.equal(startDateOf(chain(2)), "2026-11-06");
});
