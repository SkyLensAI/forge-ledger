/**
 * 候选区（`_inbox/`）与录像（cassette）的存储层测试。
 *
 * 三条性质在这里被钉住，每一条都对应一个具体的失败：
 *
 * 1. **候选区的东西不是资产**：它不能出现在 `assets.scan()` 里。
 *    这条一旦破了，"模型写的东西"就会以资产的身份出现在检索与投影里。
 * 2. **同名 = 同内容**：候选 ID 是内容寻址的，所以重跑不产生第二份。
 * 3. **录像对不上就报错**：静默返回空响应会让"模型什么都没抽出来"
 *    与"录像里根本没有这一段"长得一模一样。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildExtractionRequest, type CandidateAssertion, type ExtractionInput } from "@forge/core";
import {
  CASSETTE_VERSION,
  CANDIDATE_PREFIX,
  candidateIdOf,
  openInboxLayer,
  openVault,
  readCassette,
  replayModel,
  requestDigest,
  vaultPaths,
  writeCassette,
  type CandidateRecord,
  type Cassette,
} from "../src/index.ts";

const SOURCE_ID = "src_01M6Q2FD00P3EVALGATE000000";

function temp(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "forge-inbox-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * @param {Partial<CandidateAssertion>} [overrides]
 * @returns {CandidateAssertion}
 */
function candidate(overrides: Partial<CandidateAssertion> = {}): CandidateAssertion {
  return {
    type: "decision",
    title: "一条候选",
    subject: null,
    body: "正文",
    sources: [`src://${SOURCE_ID}#k:conv_a/msg_01`],
    confidence: 0.3,
    origin: "model",
    ...overrides,
  };
}

/**
 * @param {CandidateAssertion} value
 * @returns {CandidateRecord}
 */
function record(value: CandidateAssertion): CandidateRecord {
  return {
    candidate_version: 1,
    candidate_id: candidateIdOf(value),
    type: value.type,
    title: value.title,
    subject: value.subject,
    body: value.body,
    sources: value.sources,
    confidence: value.confidence,
    origin: value.origin,
    harness: "extraction-v1",
    model: "cassette:某模型",
  };
}

test("候选 ID 是内容寻址的：同样的内容得到同样的 ID，出处顺序不影响", () => {
  const a = candidateIdOf(candidate());
  const b = candidateIdOf(candidate());
  assert.equal(a, b);
  assert.ok(a.startsWith(CANDIDATE_PREFIX));

  const twoSources = candidate({
    sources: [`src://${SOURCE_ID}#k:conv_a/msg_01`, `src://${SOURCE_ID}#k:conv_b/msg_02`],
  });
  const reversed = candidate({
    sources: [`src://${SOURCE_ID}#k:conv_b/msg_02`, `src://${SOURCE_ID}#k:conv_a/msg_01`],
  });
  assert.equal(candidateIdOf(twoSources), candidateIdOf(reversed));
});

test("候选 ID 不含时间：跑两次得到同一个文件（幂等）", () => {
  const run = temp();
  try {
    const paths = vaultPaths(run.root);
    const inbox = openInboxLayer(paths);
    const first = inbox.put(record(candidate()));
    const bytesAfterFirst = readFileSync(first.path, "utf8");
    const second = inbox.put(record(candidate()));

    assert.equal(second.created, false);
    assert.equal(second.path, first.path);
    assert.equal(readFileSync(second.path, "utf8"), bytesAfterFirst);
    assert.equal(readdirSync(paths.inbox).length, 1);
  } finally {
    run.cleanup();
  }
});

test("**候选区的东西不是资产**：assets.scan() 一条都看不见它", () => {
  const run = temp();
  try {
    const vault = openVault(run.root);
    vault.inbox.put(record(candidate()));
    // 候选是 JSON，不是带 front-matter 的 markdown —— 所以"约定即集合"也扫不到它。
    // 这条一旦破了，模型写的东西就会以资产的身份出现在检索与投影里。
    assert.deepEqual(vault.assets.scan().docs, []);
    assert.equal(vault.inbox.scan().records.length, 1);
  } finally {
    run.cleanup();
  }
});

test("读不动的候选文件被报出来，不静默跳过", () => {
  const run = temp();
  try {
    const paths = vaultPaths(run.root);
    const inbox = openInboxLayer(paths);
    inbox.put(record(candidate()));
    writeFileSync(join(paths.inbox, "坏掉的.json"), "{ 这不是 JSON", "utf8");
    writeFileSync(join(paths.inbox, "字段不对.json"), JSON.stringify({ type: "insight" }), "utf8");

    const scan = inbox.scan();
    assert.equal(scan.records.length, 1);
    assert.equal(scan.invalid.length, 2);
    for (const item of scan.invalid) assert.ok(item.reason.length > 0);
  } finally {
    run.cleanup();
  }
});

test("remove 之后读不到，再 remove 返回 false（不假装删掉了）", () => {
  const run = temp();
  try {
    const inbox = openInboxLayer(vaultPaths(run.root));
    const id = candidateIdOf(candidate());
    inbox.put(record(candidate()));
    assert.equal(inbox.remove(id), true);
    assert.equal(inbox.read(id), null);
    assert.equal(inbox.remove(id), false);
  } finally {
    run.cleanup();
  }
});

test("录像的键把三个字段都算进去（换系统提示词会让键变）", () => {
  const base = { system: "s", user: "u", max_tokens: 10 };
  const digest = requestDigest(base);
  assert.equal(requestDigest({ ...base }), digest);
  assert.notEqual(requestDigest({ ...base, system: "s2" }), digest);
  assert.notEqual(requestDigest({ ...base, user: "u2" }), digest);
  assert.notEqual(requestDigest({ ...base, max_tokens: 11 }), digest);

  // 拼接歧义：("ab","c") 与 ("a","bc") 必须是两个不同的键（ADR-0013 的那个坑）。
  assert.notEqual(
    requestDigest({ system: "ab", user: "c", max_tokens: 1 }),
    requestDigest({ system: "a", user: "bc", max_tokens: 1 }),
  );
});

test("回放：没有这一段就抛错；版本不对也抛错", () => {
  const run = temp();
  try {
    const path = join(run.root, "cassette.json");
    const input: ExtractionInput = {
      sourceId: SOURCE_ID,
      events: [
        {
          schema_version: 1,
          source_id: SOURCE_ID,
          key: "conv_a/msg_01",
          kind: "message",
          occurred_at: "2026-01-01T00:00:00Z",
          actor: "user",
          text: "一段足够长的正文。",
        },
      ],
    };
    const cassette: Cassette = {
      cassette_version: CASSETTE_VERSION,
      about: "测试用",
      model: "测试模型",
      harness: "extraction-v1",
      records: [{ request_digest: requestDigest(buildExtractionRequest(input)), response: "{}" }],
    };
    writeCassette(path, cassette);

    const model = replayModel(readCassette(path));
    assert.equal(model.id, "测试模型");
    assert.equal(model.complete(buildExtractionRequest(input)).text, "{}");
    assert.throws(() => model.complete({ system: "别的", user: "别的问题", max_tokens: 1 }), /没有这次请求的响应/);

    writeFileSync(path, JSON.stringify({ ...cassette, cassette_version: 99 }), "utf8");
    assert.throws(() => readCassette(path), /cassette 版本/);

    assert.throws(() => readCassette(join(run.root, "不存在.json")), /没有 cassette/);
  } finally {
    run.cleanup();
  }
});

test("写录像：键排序 + 两次写同样内容得到同样的字节（R6）", () => {
  const run = temp();
  try {
    const path = join(run.root, "cassette.json");
    const cassette: Cassette = {
      cassette_version: CASSETTE_VERSION,
      about: "测试用",
      model: "m",
      harness: "h",
      records: [{ request_digest: "b", response: "1" }, { request_digest: "a", response: "2" }],
    };
    writeCassette(path, cassette);
    const first = readFileSync(path, "utf8");
    writeCassette(path, cassette);
    assert.equal(readFileSync(path, "utf8"), first);
    // records 是数组，顺序**保留**（它是对应关系的一部分）；排序的是对象的键。
    assert.equal((JSON.parse(first) as Cassette).records[0]?.request_digest, "b");
    assert.ok(first.indexOf('"about"') < first.indexOf('"cassette_version"'));
  } finally {
    run.cleanup();
  }
});
