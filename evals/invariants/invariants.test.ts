/**
 * 不变量 —— Phase 3 · S13。
 *
 * 这里测的**不是抽取质量**，而是系统里四条"必须永远成立、而且不靠模型判断"的性质
 * （implement1.md §3.4 列的正是这四条）。它们的共同点是：判据是纯确定性的，
 * 所以它们可以在没有模型、没有 API key 的情况下被断言。
 *
 * 写法上有一条刻意的选择：**每条不变量都配一个反例**。
 * 一条只会变绿的不变量等于没有不变量——它和"记得加出处"这种礼貌指令没有区别（R8）。
 * 所以每个 `test` 里都有一处"故意弄坏它"的断言，证明这把尺子真的会红。
 *
 * 位置的说明：它们住在 `evals/invariants/` 而不是某个包的 `test/` 里，
 * 因为它们横跨 schema / store / core 三层——放进任何一层，
 * 那一层就会开始假装自己是全系统的尺子。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SCHEMA_VERSION,
  assetDirOf,
  newFrontMatter,
  renderAssetDocument,
  type AssetDoc,
  type AssetFrontMatter,
  type AssetType,
} from "../../packages/schema/src/index.ts";
import { emitLibrary, judgeLibrary, type Violation } from "../../packages/core/src/index.ts";
import { openVault, readRepoAssets } from "../../packages/store/src/index.ts";

/** 仓库根：不变量要对着**本仓库真实的东西**跑，所以这里不能用 cwd 之外的假设。 */
const REPO_ROOT = process.cwd();

/** 一条在仓库里真实可解析的 `file://` 出处。用它而不是编一个，是因为出处必须真的能解析。 */
const REAL_SPAN = "file://docs/implement2.md#t:把闸门写成 checklist";

/**
 * @returns {{root: string, cleanup: () => void}}
 */
function tempVault(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "forge-inv-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const DIRS: Readonly<Record<AssetType, string>> = {
  decision: assetDirOf("decision"),
  state: assetDirOf("state"),
  event: assetDirOf("event"),
  rule: assetDirOf("rule"),
};

/**
 * 往 vault 里写一条资产。走 `renderAssetDocument` 而不是手拼 front-matter：
 * 手拼的那份迟早会和渲染器漂移，于是用例测的是手拼的格式，不是产品的格式。
 *
 * @param {string} root
 * @param {AssetType} type
 * @param {string} id
 * @param {string} body
 * @param {Partial<AssetFrontMatter>} [overrides]
 * @returns {AssetDoc}
 */
function writeAsset(
  root: string,
  type: AssetType,
  id: string,
  body: string,
  overrides: Partial<AssetFrontMatter> = {},
): AssetDoc {
  const frontMatter: AssetFrontMatter = {
    // 默认就带一条**真能解析**的出处：不变量 1 要测的是"能不能解析"，
    // 所以基线必须是绿的，否则后面每条"反例"都只是在一个本来就红的库上再加一条红。
    ...newFrontMatter(type, id, "2026-11-06"),
    sources: [REAL_SPAN],
    origin_incident: type === "rule" ? REAL_SPAN : null,
    ...overrides,
  };
  const fullBody = `# ${id} 的正文\n\n${body}`;
  const raw = renderAssetDocument(frontMatter, fullBody);
  const dir = join(root, "assets", DIRS[type]);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.md`), raw, "utf8");
  return { path: `assets/${DIRS[type]}/${id}.md`, frontMatter, body: fullBody, raw };
}

const DECISION_BODY = "## 问题\n\n要不要。\n\n## 考虑过的选项\n\n1. 要\n2. 不要\n\n## 选定\n\n要。\n\n## 后果\n\n有代价。\n";
const STATE_BODY = "## 当前状态\n\n现在是这样。\n";
const RULE_BODY = "## 规则\n\n不许乱来。\n\n## 强制\n\n靠闸门。\n";

/** 三条出处完整的资产 + 一条 state（state 的 last_confirmed 与题面也齐）。 */
function seedVault(root: string): AssetDoc[] {
  return [
    writeAsset(root, "decision", "dec_01M6Q2FD002MW3PYGNRES1PGRW", DECISION_BODY, { created: "2026-01-01" }),
    writeAsset(root, "rule", "rule_01M6Q2FD00GRZFQ6K3F6KPGA03", RULE_BODY, { created: "2026-01-02" }),
    writeAsset(root, "state", "state_01M6Q2FD00NVKBVBH80QD63VSX", STATE_BODY, {
      created: "2026-01-03",
      last_confirmed: "2026-01-04",
      // 题面：`state` 的必填字段（ADR-0025）。基线库必须是**全绿**的，
      // 否则下面每条"反例"都只是在一个本来就红的库上再加一条红。
      subject: "索引层的存储后端",
    }),
  ];
}

/**
 * @param {string} root
 * @returns {Violation[]}
 */
function judgeVault(root: string): Violation[] {
  const vault = openVault(root);
  const scan = vault.assets.scan();
  assert.deepEqual(scan.invalid, [], `vault 里读不动的资产：${JSON.stringify(scan.invalid)}`);
  return judgeLibrary(scan.docs, vault.spanIndex([REPO_ROOT]));
}

// ─────────────────────────────────────────────────────────────────────────────
// 不变量 1 · 出处完整率
// ─────────────────────────────────────────────────────────────────────────────

test("不变量：出处完整率是 100%——0 条资产允许没有可解析的出处", () => {
  const vault = tempVault();
  try {
    seedVault(vault.root);
    const violations = judgeVault(vault.root);
    assert.deepEqual(violations, [], `不该有任何出处问题：\n${violations.map((v) => v.message).join("\n")}`);

    const docs = openVault(vault.root).assets.scan().docs;
    const provenanceCodes = new Set(["PROV_NO_SOURCES", "PROV_SPAN_UNRESOLVED", "PROV_SCHEME_UNAVAILABLE"]);
    const complete = docs.filter(
      (doc) => judgeVault(vault.root).filter((v) => v.path === doc.path && provenanceCodes.has(v.code)).length === 0,
    );
    assert.equal(complete.length / docs.length, 1, "出处完整率必须正好是 1");
  } finally {
    vault.cleanup();
  }
});

test("不变量 1 的反例：抽掉出处，完整率必须掉下来（否则这条不变量是装饰）", () => {
  const vault = tempVault();
  try {
    seedVault(vault.root);
    // 同一个决策，只是没有出处——这正是"没有出处的一行不许进 assets/"要拦的东西。
    writeAsset(vault.root, "decision", "dec_01M6Q2FD00CQS8ZBPRX44R5C3P", DECISION_BODY, { sources: [] });

    const violations = judgeVault(vault.root);
    assert.ok(
      violations.some((violation) => violation.code === "PROV_NO_SOURCES"),
      `没有出处的资产必须被抓到，实际：${violations.map((v) => v.code).join(",")}`,
    );
  } finally {
    vault.cleanup();
  }
});

test("不变量 1 的反例：span 语法对但解析不到，也必须是红（腐烂的出处比没有更糟）", () => {
  const vault = tempVault();
  try {
    // 指向一个真实存在、但里面没有这句话的文件——ADR-0009 说的正是这种情形。
    writeAsset(vault.root, "decision", "dec_01M6Q2FD002MW3PYGNRES1PGRW", DECISION_BODY, {
      sources: ["file://docs/implement2.md#t:这句话在文档里根本不存在"],
    });
    const violations = judgeVault(vault.root);
    assert.ok(
      violations.some((violation) => violation.code === "PROV_SPAN_UNRESOLVED"),
      `解析不到的 span 必须报 PROV_SPAN_UNRESOLVED，实际：${violations.map((v) => v.code).join(",")}`,
    );
  } finally {
    vault.cleanup();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 不变量 2 · state 替换要盖日期
// ─────────────────────────────────────────────────────────────────────────────

/**
 * state 的日期规矩，两条：
 *   `last_confirmed` 必须不早于 `created`（不能"确认"一件还没发生的事）；
 *   如果它声明 `supersedes`，被取代的那条必须存在，且新的 `created` 不早于旧的 `last_confirmed`
 *   （否则时间线上会出现"新状态从过去就开始生效"）。
 *
 * 为什么这条是**纯确定性**的：它只比较字符串日期，不需要任何判断。
 * 这正是"S13 的不变量不靠模型"的意思。
 *
 * @param {AssetDoc[]} docs
 * @returns {string[]}
 */
function stateDateProblems(docs: AssetDoc[]): string[] {
  const byId = new Map(docs.map((doc) => [doc.frontMatter.id, doc]));
  const problems: string[] = [];

  for (const doc of docs) {
    if (doc.frontMatter.type !== "state") continue;
    const created = doc.frontMatter.created;
    const confirmed = doc.frontMatter.last_confirmed;

    if (confirmed === null) {
      problems.push(`${doc.frontMatter.id}：state 没有 last_confirmed——没有日期就没有新鲜度，过期就无从发现`);
      continue;
    }
    if (confirmed < created) {
      problems.push(`${doc.frontMatter.id}：last_confirmed(${confirmed}) 早于 created(${created})`);
    }

    const supersedes = doc.frontMatter.supersedes;
    if (supersedes === null) continue;
    const old = byId.get(supersedes);
    if (old === undefined) {
      problems.push(`${doc.frontMatter.id}：supersedes 指向 ${supersedes}，但库里没有这条资产`);
      continue;
    }
    if (old.frontMatter.last_confirmed !== null && created < old.frontMatter.last_confirmed) {
      problems.push(
        `${doc.frontMatter.id}：新状态 created(${created}) 早于被取代的 ${supersedes} 的 ` +
          `last_confirmed(${old.frontMatter.last_confirmed})——时间线上会出现"新状态从过去就开始生效"`,
      );
    }
  }
  return problems;
}

test("不变量：state 替换会盖日期，且新状态不早于被取代的那条", () => {
  const vault = tempVault();
  try {
    seedVault(vault.root);
    writeAsset(vault.root, "state", "state_01M6Q2FD00Z52A681X6FHS62G7", STATE_BODY, {
      created: "2026-02-01",
      last_confirmed: "2026-02-01",
      supersedes: "state_01M6Q2FD00NVKBVBH80QD63VSX",
      status: "active",
    });
    const docs = openVault(vault.root).assets.scan().docs;
    assert.deepEqual(stateDateProblems(docs), []);
  } finally {
    vault.cleanup();
  }
});

test("不变量 2 的反例：新状态不盖日期，必须被抓到", () => {
  const vault = tempVault();
  try {
    // 就地替换却没有日期：这是 state 最典型的腐烂方式——内容换了，日期还是旧的。
    writeAsset(vault.root, "state", "state_01M6Q2FD00NVKBVBH80QD63VSX", STATE_BODY, {
      created: "2026-11-06",
      last_confirmed: "2026-01-01",
    });
    const docs = openVault(vault.root).assets.scan().docs;
    const problems = stateDateProblems(docs);
    assert.equal(problems.length, 1, `必须恰好抓到这一处，实际：${JSON.stringify(problems)}`);
    assert.match(problems[0] ?? "", /last_confirmed.*早于 created/);
  } finally {
    vault.cleanup();
  }
});

test("不变量 2 的反例：supersedes 断链必须被抓到", () => {
  const vault = tempVault();
  try {
    writeAsset(vault.root, "state", "state_01M6Q2FD00Z52A681X6FHS62G7", STATE_BODY, {
      created: "2026-02-01",
      last_confirmed: "2026-02-01",
      supersedes: "state_01M6Q2FD00NVKBVBH80QD63VSX",
    });
    const problems = stateDateProblems(openVault(vault.root).assets.scan().docs);
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? "", /库里没有这条资产/);
  } finally {
    vault.cleanup();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 不变量 3 · INDEX.md 每次都更新
// ─────────────────────────────────────────────────────────────────────────────

test("不变量：compile 之后 INDEX.md 反映当前库（directory.md §八.3）", () => {
  const vault = tempVault();
  try {
    const store = openVault(vault.root);
    store.importText(readFileSync(join(REPO_ROOT, "evals/fixtures/desensitized-export.json"), "utf8"), {
      originalName: "export.json",
    });
    store.compile();

    const indexPath = join(vault.root, "index", "INDEX.md");
    const text = readFileSync(indexPath, "utf8");
    assert.match(text, /派生数据：删掉能重建/);
    assert.match(text, /\| 事件（索引层，非资产） \| \d+ \|/);

    const counts = store.index.counts();
    assert.ok(counts !== null && counts.events > 0, `索引层应有事件，实际 ${JSON.stringify(counts)}`);
  } finally {
    vault.cleanup();
  }
});

test("不变量 3 的反例：库里多了资产而 INDEX.md 没跟着变，必须能看出来", () => {
  const vault = tempVault();
  try {
    const store = openVault(vault.root);
    store.compile();
    const before = readFileSync(join(vault.root, "index", "INDEX.md"), "utf8");
    assert.match(before, /\*\*资产合计\*\* \| \*\*0\*\* \|/, "空库的合计是 0");

    writeAsset(vault.root, "decision", "dec_01M6Q2FD002MW3PYGNRES1PGRW", DECISION_BODY);
    // 还没重新编译——索引停在旧状态，这与磁盘上的库不再一致。
    const scan = openVault(vault.root).assets.scan();
    assert.equal(scan.docs.length, 1);
    assert.match(before, /\*\*资产合计\*\* \| \*\*0\*\* \|/, "旧投影还没变（这正是「漂移」的样子）");

    openVault(vault.root).compile();
    const after = readFileSync(join(vault.root, "index", "INDEX.md"), "utf8");
    assert.match(after, /\*\*资产合计\*\* \| \*\*1\*\* \|/, "重新编译后索引必须追上库");
    assert.match(after, /dec_01M6Q2FD002MW3PYGNRES1PGRW/);
    assert.notEqual(after, before);
  } finally {
    vault.cleanup();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 不变量 4 · emit 逐字节确定
// ─────────────────────────────────────────────────────────────────────────────

test("不变量：同样的库 emit 两次，逐字节相同（R6 / ADR-0017）", () => {
  const vault = tempVault();
  try {
    seedVault(vault.root);
    const store = openVault(vault.root);
    const scan = store.assets.scan();
    const { events } = store.derive();

    const first = emitLibrary({ assets: scan.docs, events });
    // 故意把输入顺序倒过来：输出的顺序必须由显式排序键决定，不由输入顺序决定。
    const second = emitLibrary({ assets: [...scan.docs].reverse(), events: [...events].reverse() });

    assert.deepEqual(
      first.map((file) => file.path),
      second.map((file) => file.path),
    );
    for (let i = 0; i < first.length; i += 1) {
      assert.equal(first[i]?.content, second[i]?.content, `${first[i]?.path} 的字节随输入顺序变了`);
    }
  } finally {
    vault.cleanup();
  }
});

test("不变量 4 的反例：输出里混进时钟，必须能被抓到", () => {
  const vault = tempVault();
  try {
    seedVault(vault.root);
    const store = openVault(vault.root);
    const scan = store.assets.scan();
    const { events } = store.derive();
    const text = emitLibrary({ assets: scan.docs, events })
      .map((file) => file.content)
      .join("\n");

    // 这是"生成时间"最典型的两种写法。断言它们**不在**输出里——
    // 而不是断言"跑两遍一样"，因为跑两遍一样只说明这两遍一样（ADR-0017）。
    assert.doesNotMatch(text, /生成于|generated at|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/i);
    assert.doesNotMatch(text, /\r/);

    // 反例本身：把时钟放进去，上面那条断言就会红。
    const polluted = `${text}\n> 生成于 2026-11-06T12:00:00Z\n`;
    assert.match(polluted, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, "这根探针必须真的能认出时钟");
  } finally {
    vault.cleanup();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 自举：本仓库自己的资产也要满足不变量 1 与 2
// ─────────────────────────────────────────────────────────────────────────────

test("自举：本仓库的资产满足不变量 1/2（出处完整 + state 日期规矩）", () => {
  const { docs, invalid } = readRepoAssets(REPO_ROOT);
  assert.deepEqual(invalid, []);
  assert.deepEqual(stateDateProblems(docs), []);
  assert.equal(docs.filter((doc) => doc.frontMatter.schema_version !== SCHEMA_VERSION).length, 0);
});
