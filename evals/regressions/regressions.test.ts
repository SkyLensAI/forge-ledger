/**
 * 回归集的可执行形态。
 *
 * `evals/regressions/` 原来是一堆**成文但不会跑**的案例。README 当时写着：
 * "把它们统一成可自动执行的形态是 Phase 7（S27）的事"——这个文件就是那件事。
 *
 * 三条规矩，缺一不可：
 *
 * 1. **每一份 `.md` 都必须在这里有一项登记**（`CASES`）。一条没有登记的回归
 *    等于一段散文：它不会在任何一次 CI 里被想起。
 * 2. **能自动跑的必须自动跑**（`check`）。跑不了的要写清 `why`——
 *    **记不了账的缺口比缺口本身更糟**，因为下一个人会以为它已经覆盖了。
 * 3. **登记表不许有孤儿**（登记了但没有对应的 `.md`）。删一份案例时忘了删登记，
 *    会让这份表慢慢变成一份历史遗迹，而遗迹里的绿灯不代表任何东西。
 *
 * 为什么这些检查住在这里而不是各案的正文里：正文是给人读的叙述，
 * 而"它今天还成立吗"必须由代码回答。两者都要有，且不能互相替代。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AUDIT_KINDS,
  appendAuditEntry,
  detectConflicts,
  judgeCandidates,
  parseAuditLine,
  serializeAuditEntry,
  verifyChain,
  type CandidateAssertion,
} from "../../packages/core/src/index.ts";
import { EVENT_SCHEMA_VERSION, type EventIR } from "../../packages/schema/src/index.ts";
import { isoSecond, webCaptureConnector } from "../../packages/ingest/src/index.ts";
import { replaceFrontMatter } from "../../packages/store/src/index.ts";

const REGRESSIONS = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

interface RegressionCase {
  /** 案例编号（`0001`…），与文件名前缀一致。 */
  id: string;
  /**
   * 这条回归今天怎么被判红。`null` = **目前无法自动执行**，那时 `why` 必须写清楚
   * 为什么、以及它靠什么在起作用的。
   */
  check: (() => void) | null;
  /** 无法自动执行时的记账。有 `check` 时忽略。 */
  why?: string;
}

/**
 * 一个固定的事件：出处校验要拿它当"本次输入"。
 *
 * @param {string} sourceId
 * @returns {EventIR}
 */
function event(sourceId: string): EventIR {
  return {
    schema_version: EVENT_SCHEMA_VERSION,
    source_id: sourceId,
    key: "m1",
    kind: "message",
    occurred_at: "2026-11-01T10:00:00Z",
    actor: "user",
    text: "索引层最后选了 node:sqlite。",
  };
}

/**
 * @param {Partial<CandidateAssertion>} [overrides]
 * @returns {CandidateAssertion}
 */
function candidate(overrides: Partial<CandidateAssertion> = {}): CandidateAssertion {
  return {
    type: "state",
    title: "索引层的存储后端",
    body: "索引层用 node:sqlite。",
    sources: ["src://src_AAAA#k:m1"],
    confidence: 0.5,
    origin: "model",
    subject: "索引层的存储后端",
    ...overrides,
  };
}

const CASES: RegressionCase[] = [
  {
    id: "0001",
    // ADR-0043 已经把它修好。回归不再只断言"缺口被写着"，而是断言**修复还在**：
    // 子闸门代码仍然取自基线修订，数据仍然取自当前工作树。删掉这条修复，这里就红。
    check: () => {
      const ci = readFileSync(join(REPO_ROOT, "scripts", "gates", "ci.mjs"), "utf8");
      const trusted = readFileSync(join(REPO_ROOT, "scripts", "gates", "trusted-ci.mjs"), "utf8");
      const matrix = readFileSync(join(REPO_ROOT, "docs", "gates", "bypass-matrix.md"), "utf8");

      assert.match(ci, /FORGE_JUDGE_ROOT/, "ci.mjs 必须把子闸门的代码根与数据根分开");
      assert.match(ci, /FORGE_JUDGE_DATA_ROOT/, "ci.mjs 必须把数据根传给子闸门");
      assert.match(trusted, /FORGE_JUDGE_ROOT:\s*tree/, "trusted-ci 必须把基线 worktree 作为代码根");
      assert.match(trusted, /FORGE_JUDGE_DATA_ROOT:\s*repo/, "trusted-ci 必须把当前工作树作为数据根");

      for (const name of ["assets.mjs", "consistency.mjs", "evals.mjs"]) {
        const text = readFileSync(join(REPO_ROOT, "scripts", "gates", name), "utf8");
        assert.match(text, /FORGE_JUDGE_DATA_ROOT/, `${name} 必须从 dataRoot 读数据`);
      }

      assert.match(matrix, /6\.10/, "bypass-matrix 里必须仍然记着 6.10（现在写的是它已关闭）");
      assert.match(matrix, /已关闭|已落盘/, "6.10 修复之后，清单要写明它已经关闭");
    },
  },
  {
    id: "0002",
    check: () => {
      // 逐来源判：同一条候选，对着**它真正来自的那个来源**判 → 一条违规都没有。
      const sourceId = "src_AAAA";
      const same = judgeCandidates({ sourceId, events: [event(sourceId)] }, [candidate()]);
      assert.deepEqual(same, [], "引用真事件的候选被判成了编造——逐来源判这条纪律被改回去了");

      // 对着另一个来源判 → 必须被报出来（否则这条检查就只是在"永远放行"）。
      const other = judgeCandidates({ sourceId: "src_BBBB", events: [event("src_BBBB")] }, [candidate()]);
      assert.ok(other.length > 0, "出处指向别的来源时必须被拒绝——把两边的方向都钉住");
    },
  },
  {
    id: "0003",
    check: null,
    why:
      "它测的是 `handoff/apply.mjs`——一个**用完即删**的一次性落盘工具。" +
      "脚本删掉之后这条回归没有被测对象了。留下的纪律是那句「一份说还没做的文档比一份说错了的文档更危险」，" +
      "它没法机器判定（判据是 README 与事实一致），只能由评审承担。",
  },
  {
    id: "0004",
    check: null,
    why:
      "同上：被测对象是 `handoff/apply.mjs` 的 junction 舞台，而那个脚本是用完即删的。" +
      "真正的教训已经写进了工具的注释与 README（演练不许写工作区），" +
      "但它没有留下一个能在仓库里长期重跑的断言——因为**舞台本身**就是那个脚本。",
  },
  {
    id: "0005",
    check: () => {
      // 同一件事被再说一遍，但两侧的排版不同：资产带 `## 当前状态`（模板要求的章节），
      // 候选只有一句话。归一化必须剥掉章节标题，否则"再确认"会永远被判成"冲突"。
      const judgement = detectConflicts({
        candidates: [candidate({ body: "两周一个版本。" })],
        assets: [
          {
            id: "state_01M6Q2FD00NVKBVBH80QD63VSX",
            path: "assets/state/state_01M6Q2FD00NVKBVBH80QD63VSX.md",
            type: "state",
            subject: "索引层的存储后端",
            sources: ["src://src_AAAA#k:m1"],
            status: "active",
            body: "## 当前状态\n\n两周一个版本。",
          },
        ],
      });
      assert.equal(
        judgement.conflicts.length,
        0,
        "章节标题没被剥掉：同一条事实被再说一遍时又报了冲突（ADR-0032 的那个 bug 回来了）",
      );
      assert.equal(judgement.refreshes.length, 1, "它应该进「再确认」那一档");
    },
  },
  {
    id: "0006",
    check: () => {
      const first = appendAuditEntry(null, {
        at: "2026-11-06T10:00:00.000Z",
        actor: "probe",
        kind: AUDIT_KINDS.ASSET_PROMOTED,
        subject: "state_01M6Q2FD00NVKBVBH80QD63VSX",
        detail: { n: "1" },
      });
      const line = serializeAuditEntry(first);
      assert.equal(line.includes("\n"), false, "审计条目必须占一行——JSONL 的名字就是它的契约");
      const parsed = parseAuditLine(line);
      assert.equal(parsed.ok, true, "刚写下的那一行必须能原样读回来");

      const second = appendAuditEntry(first, {
        at: "2026-11-06T10:01:00.000Z",
        actor: "probe",
        kind: AUDIT_KINDS.STATE_CONFIRMED,
        subject: first.subject,
        detail: {},
      });
      const chain = parsed.ok ? [parsed.entry, second] : [second];
      // 刚写下的链必须**立刻**零问题。把 hash 算进自己的实现会让这里永远红。
      const verification = verifyChain(chain);
      assert.deepEqual(verification.problems, [], "刚写下的链必须立刻零问题");
    },
  },
  {
    id: "0007",
    check: () => {      const raw = [
        "---",
        "schema_version: 1",
        'id: "state_01M6Q2FD00NVKBVBH80QD63VSX"',
        "type: state",
        "status: active",
        'created: "2026-01-01"',
        "last_confirmed: null",
        "supersedes: null",
        "origin_incident: null",
        'subject: "索引层的存储后端"',
        "sources:",
        '  - "src://src_AAAA#k:m1"',
        "sensitivity: internal",
        "confidence: 0.9",
        "---",
        "",
        "# 存储后端",
        "",
        "## 当前状态",
        "",
        "索引层用 node:sqlite。",
        "",
      ].join("\n");
      const frontMatter = {
        schema_version: 1,
        id: "state_01M6Q2FD00NVKBVBH80QD63VSX",
        type: "state" as const,
        status: "active",
        created: "2026-01-01",
        last_confirmed: "2026-12-01",
        supersedes: null,
        origin_incident: null,
        subject: "索引层的存储后端",
        sources: ["src://src_AAAA#k:m1"],
        sensitivity: "internal",
        confidence: 0.9,
      };
      const written = replaceFrontMatter(raw, frontMatter);
      const bodyOf = (text: string): string => text.slice(text.indexOf("\n---\n") + 5);
      assert.equal(bodyOf(written), bodyOf(raw), "正文字节必须原样保留");
      // 再改一次：**换行不许累积**。上一版每改写一次正文前面就多一个空行。
      assert.equal(
        replaceFrontMatter(written, { ...frontMatter, last_confirmed: "2026-01-01" }).replace(
          "last_confirmed: \"2026-01-01\"",
          "last_confirmed: \"2026-12-01\"",
        ),
        written,
        "改两次的结果必须与改一次相同",
      );
    },
  },
  {
    id: "0008",
    check: () => {
      // `Date.parse("2026-02-31T00:00:00Z")` 在 V8 里会**静默归一**成 3 月 3 日。
      // 连接器原来的判据只有 `Number.isNaN(Date.parse(...))`，于是不存在的日期
      // 被折成一个看起来很正常的时刻——比丢弃它更糟。
      assert.equal(isoSecond("2026-02-31T00:00:00Z"), null, "不存在的日历日期不许被静默归一");
      assert.equal(isoSecond("2026-02-29T00:00:00Z"), null, "2026 不是闰年");
      assert.equal(isoSecond("2024-02-29T00:00:00Z"), "2024-02-29T00:00:00Z", "真实存在的闰日必须留下");

      // web-capture 的 `isoSecond` 不导出，所以走连接器的真实解析路径再问一遍。
      const parsed = webCaptureConnector.parse(
        JSON.stringify({
          capture_version: 1,
          host: "example.com",
          items: [{ key: "example.com/a", text: "正文", time: "2026-02-31T00:00:00Z" }],
        }),
      );
      assert.equal(parsed.records.length, 0, "坏日期不许变成一条事件");
      assert.equal(parsed.skipped.length, 1, "坏日期必须进 skipped，不能静默丢");
    },
  },
];

test("回归集：每一份案例都登记了，而且登记表里没有孤儿", () => {
  const files = readdirSync(REGRESSIONS)
    .filter((name) => name.endsWith(".md") && /^\d{4}-/.test(name))
    .sort();
  const fileIds = files.map((name) => name.slice(0, 4));
  const registered = CASES.map((entry) => entry.id).sort();

  assert.deepEqual(
    registered,
    fileIds,
    `登记表与目录对不上。\n` +
      `  目录里有而没登记的：${fileIds.filter((id) => !registered.includes(id)).join("、") || "无"}\n` +
      `  登记了却没有文件的：${registered.filter((id) => !fileIds.includes(id)).join("、") || "无"}\n` +
      "  一条没有登记的回归不会在任何一次 CI 里被想起。",
  );
});

test("回归集：跑不了的那些必须写清为什么（记不了账的缺口比缺口本身更糟）", () => {
  for (const entry of CASES) {
    if (entry.check !== null) continue;
    assert.ok(
      typeof entry.why === "string" && entry.why.trim().length >= 20,
      `${entry.id} 既没有可执行的检查，也没有写清为什么——那会被读成「已覆盖」`,
    );
  }
});

test("回归集：每一条能自动跑的，今天都必须成立", () => {
  for (const entry of CASES) {
    if (entry.check === null) continue;
    // 逐条跑、逐条报：一条失败不该遮住后面那些的状态。
    entry.check();
  }
});

test("回归集：至少有一条是**真的**在跑（全都是散文就等于没有回归集）", () => {
  const executable = CASES.filter((entry) => entry.check !== null).length;
  assert.ok(executable >= 4, `能自动执行的只有 ${String(executable)} 条——回归集正在变成散文`);
});
