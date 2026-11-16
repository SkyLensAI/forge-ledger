/**
 * Emitter 的尺子 —— Phase 2 的退出条件在这里被断言。
 *
 * 这一个文件守的是 R6（产出必须逐字节确定）。写法上有一个刻意的选择：
 * **不用"跑两遍比对"当作判据本身**（ADR-0017）——那只证明"这次跑的两遍一样"。
 * 这里断的是**结构性质**：输出里不含时钟、不含随机、顺序由显式键决定。
 * "跑两遍"的端到端版本在 `apps/cli/test/e2e.test.ts`，它守的是别的东西：
 * 整条链路里没有漏网的时钟。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SCHEMA_VERSION,
  renderAssetDocument,
  type AssetDoc,
  type AssetFrontMatter,
  type AssetType,
} from "@forge/schema";
import { deriveEvents } from "../src/compile.ts";
import { type RawRecord } from "../src/normalize.ts";
import { emitAgentsMd, emitAdrFiles, emitIndex, emitLibrary, sectionBody, slugify } from "../src/emit.ts";
import { createSpanIndex, judgeAsset } from "../src/asset.ts";

/**
 * @param {AssetType} type
 * @param {string} id
 * @param {string} title
 * @param {string} body
 * @param {Partial<AssetFrontMatter>} [overrides]
 * @returns {AssetDoc}
 */
function asset(
  type: AssetType,
  id: string,
  title: string,
  body: string,
  overrides: Partial<AssetFrontMatter> = {},
): AssetDoc {
  const frontMatter: AssetFrontMatter = {
    schema_version: SCHEMA_VERSION,
    id,
    type,
    status: type === "decision" ? "accepted" : type === "event" ? "recorded" : "active",
    created: "2026-11-06",
    last_confirmed: type === "state" ? "2026-11-06" : null,
    supersedes: null,
    origin_incident: type === "rule" ? "file://docs/implement2.md#t:把闸门写成 checklist" : null,
    // 题面：`state` 必填、`rule` 建议填（ADR-0025）。fixture 也给非 state 类型填一个，
    // 因为"题面只有 state 才有"这个印象会让 emit 的排序键在别的类型上测不到。
    subject: `${type}:${title}`,
    sources: ["file://docs/implement2.md#t:把闸门写成 checklist"],
    sensitivity: "internal",
    confidence: 0.9,
    ...overrides,
  };
  const fullBody = `# ${title}\n\n${body}`;
  return {
    path: `assets/${type}/${id}.md`,
    frontMatter,
    body: fullBody,
    raw: renderAssetDocument(frontMatter, fullBody),
  };
}

const DECISION = asset(
  "decision",
  "dec_01M6Q2FD002MW3PYGNRES1PGRW",
  "分类法只定 4 种资产",
  "## 问题\n\n少了还是多了。\n\n## 考虑过的选项\n\n1. 四种\n2. 七种\n\n## 选定\n\n**选四种**。\n\n## 后果\n\n- **代价**：要迁移。\n",
);

const RULE = asset(
  "rule",
  "rule_01M6Q2FD00GRZFQ6K3F6KPGA03",
  "不许绕过闸门",
  "## 规则\n\n闸门红了要修**问题**，不是修**闸门**。\n\n## 强制\n\n闸门 1 的 B1–B4 直接阻断。\n",
);

const STATE = asset(
  "state",
  "state_01M6Q2FD00NVKBVBH80QD63VSX",
  "存储后端选本地 SQLite",
  "## 当前状态\n\n用 Node 内置的 node:sqlite。\n",
);

const EVENT = asset("event", "event_01M6Q2FD00AX057HVVTGFVQC8M", "误提交事故", "撤回不难，难的是信任。\n");

test("emit：同样的输入产出同样的字节（库的输入顺序不影响输出）", () => {
  const forward = emitLibrary({ assets: [DECISION, RULE, STATE, EVENT], events: [] });
  const reversed = emitLibrary({ assets: [EVENT, STATE, RULE, DECISION], events: [] });
  assert.deepEqual(
    forward.map((file) => file.path),
    reversed.map((file) => file.path),
  );
  for (let i = 0; i < forward.length; i += 1) {
    assert.equal(forward[i]?.content, reversed[i]?.content, `${forward[i]?.path} 的字节随输入顺序变了`);
  }
});

test("emit：输出里没有时钟、没有随机", () => {
  const text = emitLibrary({ assets: [DECISION, RULE, STATE, EVENT], events: [] })
    .map((file) => file.content)
    .join("\n");
  // 生成时间、生成日期、UUID、随机十六进制都是"每次都不一样"的常见来源。
  assert.doesNotMatch(text, /生成于|generated at|last updated|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/i);
  assert.doesNotMatch(text, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i);
  // 换行只有 LF：CRLF 会让字节在两个平台上不同。
  assert.doesNotMatch(text, /\r/);
});

test("emit：文件以单个换行结尾", () => {
  for (const file of emitLibrary({ assets: [DECISION], events: [] })) {
    assert.equal(file.content.endsWith("\n"), true, `${file.path} 没有以换行结尾`);
    assert.equal(file.content.endsWith("\n\n"), false, `${file.path} 结尾多了空行`);
  }
});

test("AGENTS.md：规则的强制手段被提上来，出处逐条列出", () => {
  const text = emitAgentsMd({ assets: [RULE], events: [] });
  assert.match(text, /### rule_01M6Q2FD00GRZFQ6K3F6KPGA03 · 不许绕过闸门/);
  assert.match(text, /- \*\*强制\*\*：闸门 1 的 B1–B4 直接阻断。/);
  assert.match(text, /- \*\*出处\*\*：/);
  assert.match(text, /file:\/\/docs\/implement2\.md#t:把闸门写成 checklist/);
});

test("AGENTS.md：规则没有强制手段时明说，而不是留一个空条目", () => {
  const hollow = asset("rule", "rule_01M6Q2FD00Z52A681X6FHS62G7", "注意事项", "## 规则\n\n要注意。\n\n## 强制\n\n");
  assert.match(emitAgentsMd({ assets: [hollow], events: [] }), /没写强制手段/);
});

test("AGENTS.md：空库也是确定输出，不是空文件", () => {
  const text = emitAgentsMd({ assets: [], events: [] });
  assert.match(text, /# 资产库/);
  assert.match(text, /空库/);
  assert.match(text, /（暂无 rule 型资产。规则要从真实踩过的坑长出来——棘轮。）/);
});

test("事件不进 AGENTS.md 的常驻区之外：时间线只放最近 N 条，且**说出来**被截断了", () => {
  const events = Array.from({ length: 25 }, (_, index) => ({
    schema_version: SCHEMA_VERSION,
    source_id: "src_01M6Q2FD002MW3PYGNRES1PGRW",
    key: `conv/msg_${String(index).padStart(3, "0")}`,
    kind: "message" as const,
    occurred_at: `2026-01-${String((index % 28) + 1).padStart(2, "0")}T00:00:00Z`,
    actor: "user" as const,
    text: `第 ${index} 条`,
  }));

  const text = emitAgentsMd({ assets: [], events });
  assert.match(text, /以上为最近 20 条；库中共 25 条事件。/);
  // 静默截断会让"最近 20 条"读成"一共 20 条"——那是在输出里撒谎，比不确定更糟。
});

test("INDEX.md：分开资产与事件，事件标明「非资产」", () => {
  const text = emitIndex({
    assets: [DECISION, RULE],
    events: [
      {
        schema_version: SCHEMA_VERSION,
        source_id: "src_01M6Q2FD002MW3PYGNRES1PGRW",
        key: "conv/msg_001",
        kind: "message",
        occurred_at: "2026-01-01T00:00:00Z",
        actor: "user",
        text: "一条",
      },
    ],
  });
  assert.match(text, /\| decision \| 1 \|/);
  assert.match(text, /\| rule \| 1 \|/);
  assert.match(text, /事件（索引层，非资产） \| 1 \|/);
});

test("adr/：编号是排序后的位次，且路径可复现", () => {
  const earlier = asset("decision", "dec_01M6Q2FD002MW3PYGNRES1PGRW", "早的决策", "## 问题\n\nx\n\n## 考虑过的选项\n\n1\n\n## 选定\n\nx\n\n## 后果\n\nx\n", {
    created: "2026-01-01",
  });
  const later = asset("decision", "dec_01M6Q2FD00CQS8ZBPRX44R5C3P", "晚的决策", "## 问题\n\nx\n\n## 考虑过的选项\n\n1\n\n## 选定\n\nx\n\n## 后果\n\nx\n", {
    created: "2026-02-01",
  });

  const files = emitAdrFiles([later, earlier]);
  assert.deepEqual(
    files.map((file) => file.path),
    ["adr/0001-早的决策.md", "adr/0002-晚的决策.md"],
  );
  // ADR 是**资产**，所以它带 front-matter（ADR-0012）——投影才不带。
  assert.match(files[0]?.content ?? "", /^---\nschema_version: 1\n/);
});

test("slugify：只依赖输入（不依赖 locale），且总有结果", () => {
  assert.equal(slugify("Hello World"), "hello-world");
  assert.equal(slugify("分类法 v1：只定 4 种"), "分类法-v1-只定-4-种");
  assert.equal(slugify("///"), "untitled");
  // 土耳其语环境下 toLowerCase 会把 I 变成 ı——所以这里做的是 ASCII 小写。
  assert.equal(slugify("ID 方案"), "id-方案");
});

test("sectionBody：取二级标题下的正文并压平成一行", () => {
  const body = "# 标题\n\n## 规则\n\n第一行\n第二行\n\n## 强制\n\n靠闸门\n";
  assert.equal(sectionBody(body, "规则"), "第一行 第二行");
  assert.equal(sectionBody(body, "强制"), "靠闸门");
  assert.equal(sectionBody(body, "不存在"), "");
});

test("deriveEvents：连接器抛错记成一条丢弃，而不是让整次编译少一截来源", () => {
  const records: RawRecord[] = [
    { key: "c/1", occurred_at: "2026-01-01T00:00:00Z", actor: "user", text: "好的一条" },
  ];
  const result = deriveEvents([
    { id: "src_01M6Q2FD002MW3PYGNRES1PGRW", text: "x", parse: () => ({ records }) },
    {
      id: "src_01M6Q2FD00CQS8ZBPRX44R5C3P",
      text: "y",
      parse: () => {
        throw new Error("格式坏了");
      },
    },
  ]);
  assert.equal(result.events.length, 1);
  assert.equal(result.discarded.length, 1);
  assert.match(result.discarded[0]?.reason ?? "", /连接器抛错：格式坏了/);
});

test("deriveEvents：排序键是显式的 (source_id, key)，与处理顺序无关", () => {
  const a: RawRecord[] = [
    { key: "c/2", occurred_at: "2026-01-01T00:00:00Z", actor: "user", text: "b" },
    { key: "c/1", occurred_at: "2026-01-01T00:00:00Z", actor: "user", text: "a" },
  ];
  const result = deriveEvents([{ id: "src_01M6Q2FD002MW3PYGNRES1PGRW", text: "x", parse: () => ({ records: a }) }]);
  assert.deepEqual(
    result.events.map((event) => event.key),
    ["c/1", "c/2"],
  );
});

test("judgeAsset：没有出处报 PROV_NO_SOURCES，span 解析不到报 PROV_SPAN_UNRESOLVED", () => {
  const index = createSpanIndex(
    new Map([
      ["file://docs/implement2.md#t:把闸门写成 checklist", { kind: "resolved", excerpt: "把闸门写成清单" }],
    ]),
    { kind: "unresolved", reason: "没有这份文件" },
  );

  const noSources = asset("decision", "dec_01M6Q2FD002MW3PYGNRES1PGRW", "无出处", "## 问题\n\nx\n\n## 考虑过的选项\n\n1\n\n## 选定\n\nx\n\n## 后果\n\nx\n", {
    sources: [],
  });
  assert.deepEqual(
    judgeAsset(noSources, index).map((violation) => violation.code),
    ["PROV_NO_SOURCES"],
  );

  const badSpan = asset("decision", "dec_01M6Q2FD00CQS8ZBPRX44R5C3P", "坏出处", "## 问题\n\nx\n\n## 考虑过的选项\n\n1\n\n## 选定\n\nx\n\n## 后果\n\nx\n", {
    sources: ["docs/implement2.md#t:没有 scheme"],
  });
  const codes = judgeAsset(badSpan, index).map((violation) => violation.code);
  assert.ok(codes.includes("PROV_SPAN_UNRESOLVED"));
});

test("judgeAsset：rule 没有 origin_incident 是红——原则被 schema 强制，不是被文档要求", () => {
  const index = createSpanIndex(
    new Map([["file://docs/implement2.md#t:把闸门写成 checklist", { kind: "resolved", excerpt: "x" }]]),
    { kind: "unresolved", reason: "没有这份文件" },
  );
  const orphan = asset("rule", "rule_01M6Q2FD00GRZFQ6K3F6KPGA03", "没来源的规则", "## 规则\n\nx\n\n## 强制\n\nx\n", {
    origin_incident: null,
  });
  const codes = judgeAsset(orphan, index).map((violation) => violation.code);
  assert.ok(codes.includes("REQUIRED_FIELD_MISSING"), `实际：${codes.join(",")}`);
});
