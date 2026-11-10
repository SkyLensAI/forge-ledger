/**
 * MCP server 的测试（S22）—— 五条性质：
 *
 * 1. **协议层是普通的函数**：`handle()` 能直接调，测试不必解 stdio 的时序。
 * 2. **通知不许回**（`notifications/initialized` 回一条 null-id 响应会让客户端困惑）。
 * 3. **`forge_context` 与 CLI 给出同一段字节**：这是"判定只有一份"的执行体，
 *    两处各写一遍的结局是"命令行里看到的和 Cursor 里看到的不一样"。
 * 4. **`forge_search` 只列条目、不读正文**：列表不是注入，合并两者就是把预加载做成默认行为。
 * 5. **真的能作为子进程跑起来**（端到端）：`initialize → tools/list → tools/call` 一轮。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSION, renderAssetDocument, type AssetFrontMatter } from "@forge/schema";
import { openVault } from "@forge/store";
import { PROTOCOL_VERSIONS, createServer } from "../src/server.ts";

const REPO = process.cwd();
const MCP = join(REPO, "apps", "mcp", "src", "main.ts");

/**
 * 出处的解析根是**库根**（与 `forge lint --vault` 同一套）：所以 fixture 自己造一份
 * 能被解析的原文放进去。用仓库里的路径会得到 `PROV_SPAN_UNRESOLVED`——
 * 那不是 bug，是"出处只能在它自己的宿主里校验"（ADR-0009）。
 */
const ANCHOR_TEXT = "检索优先，绝不预加载整个大脑";
const SPAN = `file://docs/note.md#t:${ANCHOR_TEXT}`;

function temp(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "forge-mcp-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * 造一个 vault：一条规则、一条状态、一条与查询无关的决策。
 *
 * @param {string} root
 * @returns {void}
 */
function seed(root: string): void {
  const vault = openVault(root);
  // 出处的目标文件：库根下的一篇文档，里面确实写着被引用的那句话。
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs", "note.md"), `# 说明

${ANCHOR_TEXT}。
`, "utf8");
  const docs: Array<{ type: "rule" | "state" | "decision"; id: string; title: string; body: string; subject: string | null }> = [
    {
      type: "rule",
      id: "rule_01M6Q2FD00GRZFQ6K3F6KPGA03",
      title: "不许绕过闸门",
      body: "## 规则\n\n闸门红了要修问题。\n\n## 强制\n\n闸门 1 直接阻断。\n",
      subject: "闸门",
    },
    {
      type: "state",
      id: "state_01M6Q2FD00NVKBVBH80QD63VSX",
      title: "存储后端用 SQLite",
      body: "## 当前状态\n\n索引层用 node:sqlite。\n",
      subject: "索引层的存储后端",
    },
    {
      type: "decision",
      id: "dec_01M6Q2FD00CQS8ZBPRX44R5C3P",
      title: "配色定成深色",
      body: "## 问题\n\n亮还是暗。\n\n## 考虑过的选项\n\n1. 亮\n2. 暗\n\n## 选定\n\n**深色**。\n\n## 后果\n\n费眼。\n",
      subject: null,
    },
  ];
  for (const doc of docs) {
    const frontMatter: AssetFrontMatter = {
      schema_version: SCHEMA_VERSION,
      id: doc.id,
      type: doc.type,
      status: doc.type === "decision" ? "accepted" : "active",
      created: "2026-01-01",
      last_confirmed: doc.type === "state" ? "2026-11-01" : null,
      supersedes: null,
      origin_incident: doc.type === "rule" ? SPAN : null,
      subject: doc.subject,
      sources: [SPAN],
      sensitivity: "internal",
      confidence: 0.9,
    };
    const fullBody = `# ${doc.title}\n\n${doc.body}`;
    mkdirSync(join(root, "assets", doc.type === "decision" ? "dec" : doc.type), { recursive: true });
    vault.assets.writeAuthored(
      {
        path: `assets/${doc.type === "decision" ? "dec" : doc.type}/${doc.id}.md`,
        frontMatter,
        body: fullBody,
        raw: renderAssetDocument(frontMatter, fullBody),
      },
      {
        at: "2026-11-01T00:00:00.000Z",
        actor: "test-fixture",
        kind: "asset-promoted",
        subject: doc.id,
        detail: { why: "MCP 测试的夹具资产" },
      },
    );
  }
}

const QUERY = "索引层的存储后端怎么选";

/**
 * @param {ReturnType<typeof createServer>} server
 * @param {import("../src/server.ts").JsonRpcRequest} request
 * @returns {any}
 */
function call(server: ReturnType<typeof createServer>, request: Record<string, unknown>): any {
  const response = server.handle(request);
  assert.ok(response !== null, "这条消息必须有回复");
  return response;
}

test("initialize：回一个双方都支持的协议版本，能力里只有 tools", () => {
  const vault = temp();
  try {
    const server = createServer({ vault: vault.root });
    const response = call(server, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    assert.equal(response.result.protocolVersion, "2024-11-05", "客户端给的版本支持就回它");
    assert.deepEqual(response.result.capabilities, { tools: { listChanged: false } });
    assert.equal(response.result.serverInfo.name, "forge");

    // 不认识的版本 → 回我们自己最新的那一个（规范的做法）。
    const unknown = call(server, { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } });
    assert.equal(unknown.result.protocolVersion, PROTOCOL_VERSIONS[0]);
  } finally {
    vault.cleanup();
  }
});

test("通知不许回：`notifications/initialized` 的回复必须是 null", () => {
  const vault = temp();
  try {
    const server = createServer({ vault: vault.root });
    assert.equal(server.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
    // 反例：一条**带 id** 的消息必须有回复，否则调用方会一直等。
    assert.ok(server.handle({ jsonrpc: "2.0", id: 7, method: "ping" }) !== null);
  } finally {
    vault.cleanup();
  }
});

test("tools/list：四个工具，顺序固定（输出会进快照）", () => {
  const vault = temp();
  try {
    const server = createServer({ vault: vault.root });
    const response = call(server, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    assert.deepEqual(
      response.result.tools.map((tool: { name: string }) => tool.name),
      ["forge_context", "forge_search", "forge_get", "forge_lint"],
    );
    for (const tool of response.result.tools) {
      assert.equal(tool.inputSchema.type, "object");
      assert.equal(tool.inputSchema.additionalProperties, false, "多余参数不许静默吞掉");
    }
    // 需要参数的那三个必须把 required 写出来：客户端据此才知道该问什么。
    for (const name of ["forge_context", "forge_search", "forge_get"]) {
      const tool = response.result.tools.find((item: { name: string }) => item.name === name);
      assert.ok(Array.isArray(tool.inputSchema.required) && tool.inputSchema.required.length > 0, name);
    }
  } finally {
    vault.cleanup();
  }
});

test("forge_context：回一段注入，**与 CLI 逐字节相同**（判定只有一份）", () => {
  const vault = temp();
  try {
    seed(vault.root);
    const server = createServer({ vault: vault.root, today: "2026-11-06" });
    const response = call(server, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "forge_context", arguments: { query: QUERY, budget: 700 } },
    });
    const text: string = response.result.content[0].text;
    assert.match(text, /这不是全库/);

    // 同一份输入的 CLI 输出（同一个 vault.context 入口）。
    const cli = spawnSync("node", [join(REPO, "apps", "cli", "src", "main.ts"), "context", QUERY, "--vault", vault.root, "--today", "2026-11-06", "--budget", "700"], {
      cwd: REPO,
      encoding: "utf8",
      env: { PATH: process.env["PATH"] ?? "" },
    });
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(text, cli.stdout, "MCP 与 CLI 的注入必须逐字节相同——判定只有一份");
  } finally {
    vault.cleanup();
  }
});

test("forge_search：**只列条目**，正文一个字都不回（列表不是注入）", () => {
  const vault = temp();
  try {
    seed(vault.root);
    const server = createServer({ vault: vault.root });
    const response = call(server, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "forge_search", arguments: { query: QUERY } },
    });
    const text: string = response.result.content[0].text;
    assert.match(text, /state_01M6Q2FD00NVKBVBH80QD63VSX/);
    assert.doesNotMatch(text, /索引层用 node:sqlite/, "把正文带回来就是把预加载做成默认行为");
    assert.match(text, /不要.*预加载|forge_get/);
    // 无关的那条一条都不该出现。
    assert.doesNotMatch(text, /dec_01M6Q2FD00CQS8ZBPRX44R5C3P/);
  } finally {
    vault.cleanup();
  }
});

test("forge_get：按 ID 读全文；ID 大小写不敏感；查不到时是**工具错误**（不是协议错误）", () => {
  const vault = temp();
  try {
    seed(vault.root);
    const server = createServer({ vault: vault.root });

    const hit = call(server, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "forge_get", arguments: { id: "STATE_01M6Q2FD00NVKBVBH80QD63VSX" } },
    });
    assert.match(hit.result.content[0].text, /索引层用 node:sqlite/);
    assert.equal(hit.error, undefined);

    const miss = call(server, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "forge_get", arguments: { id: "state_01M6Q2FD00AAAAAAAAAAAAAAAAAA" } },
    });
    assert.equal(miss.error, undefined, "「查不到」是工具层的结果，不是协议层的错误");
    assert.equal(miss.result.isError, true);
    assert.match(miss.result.content[0].text, /库里没有/);
  } finally {
    vault.cleanup();
  }
});

test("forge_lint：库健康时通过；坏资产时报错并指出**修法**", () => {
  const vault = temp();
  try {
    seed(vault.root);
    const server = createServer({ vault: vault.root });
    const ok = call(server, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "forge_lint", arguments: {} } });
    assert.match(ok.result.content[0].text, /审核通过/);

    // 抽掉一条资产的出处 = 它不再是证据。
    writeFileSync(
      join(vault.root, "assets", "state", "state_01M6Q2FD00NVKBVBH80QD63VSX.md"),
      readAssetWithNoSources("state_01M6Q2FD00NVKBVBH80QD63VSX"),
      "utf8",
    );
    const bad = call(server, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "forge_lint", arguments: {} } });
    assert.equal(bad.result.isError, true);
    assert.match(bad.result.content[0].text, /PROV_NO_SOURCES/);
    assert.match(bad.result.content[0].text, /补上 span/, "码后面必须跟修法——码是契约，修法是行动指令");
  } finally {
    vault.cleanup();
  }
});

test("参数错走协议错误，而且消息说得清**怎么修**", () => {
  const vault = temp();
  try {
    const server = createServer({ vault: vault.root });
    const missing = call(server, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "forge_context", arguments: {} },
    });
    assert.equal(missing.error.code, -32602);
    assert.match(missing.error.message, /需要 query/);

    const badType = call(server, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "forge_context", arguments: { query: "x", budget: "1200" } },
    });
    assert.equal(badType.error.code, -32602);
    assert.match(badType.error.message, /budget 必须是整数/);
  } finally {
    vault.cleanup();
  }
});

test("不认识的方法 / 工具：各回各的码，不假装成功", () => {
  const vault = temp();
  try {
    const server = createServer({ vault: vault.root });
    assert.equal(call(server, { jsonrpc: "2.0", id: 1, method: "没有这个方法" }).error.code, -32601);
    assert.equal(
      call(server, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "没有这个工具" } }).error.code,
      -32601,
    );
    assert.equal(call(server, { jsonrpc: "1.0", id: 3, method: "ping" }).error.code, -32600);
  } finally {
    vault.cleanup();
  }
});

test("端到端：真的作为子进程跑起来，一轮 initialize → tools/list → tools/call", () => {
  const vault = temp();
  try {
    seed(vault.root);
    const input = [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "forge_context", arguments: { query: QUERY, budget: 700 } },
      }),
      "{ 这不是 JSON",
      "",
    ].join("\n");

    const result = spawnSync("node", [MCP, "--vault", vault.root], {
      cwd: REPO,
      encoding: "utf8",
      input,
      env: { PATH: process.env["PATH"] ?? "" },
    });
    assert.equal(result.status, 0, result.stderr);

    const lines = result.stdout.split("\n").filter((line) => line.trim().length > 0);
    // 四条有回复的消息：initialize / tools/list / tools/call / parse error。
    // **通知那条没有回复**——它在 stdout 里的缺席就是这条性质的证据。
    assert.equal(lines.length, 4, `实际回了 ${String(lines.length)} 条：\n${result.stdout}`);

    const parsed = lines.map((line) => JSON.parse(line) as { id: number | null; result?: any; error?: any });
    assert.equal(parsed[0]?.result?.protocolVersion, "2025-06-18");
    assert.equal(parsed[1]?.result?.tools.length, 4);
    assert.match(parsed[2]?.result?.content?.[0]?.text ?? "", /这不是全库/);
    assert.equal(parsed[3]?.error?.code, -32700, "一条坏消息只该毁掉它自己，不该毁掉整条连接");

    // stdout 里全是协议消息：一行日志混进去就会让客户端解析失败。
    assert.doesNotMatch(result.stdout, /就绪/);
    assert.match(result.stderr, /就绪/, "诊断信息走 stderr");
  } finally {
    vault.cleanup();
  }
});

/**
 * 一条把 sources 抽空的 state 资产：用它验证 lint 会把 `PROV_NO_SOURCES` 报出来。
 *
 * @param {string} id
 * @returns {string}
 */
function readAssetWithNoSources(id: string): string {
  const frontMatter: AssetFrontMatter = {
    schema_version: SCHEMA_VERSION,
    id,
    type: "state",
    status: "active",
    created: "2026-01-01",
    last_confirmed: "2026-11-01",
    supersedes: null,
    origin_incident: null,
    subject: "索引层的存储后端",
    sources: [],
    sensitivity: "internal",
    confidence: 0.9,
  };
  return renderAssetDocument(frontMatter, "# 存储后端用 SQLite\n\n## 当前状态\n\n索引层用 node:sqlite。\n");
}
