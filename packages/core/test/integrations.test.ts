/**
 * MCP 客户端清单与渲染（personal2.md）。
 *
 * 这个测试只钉三件事：
 *
 * 1. **清单能过校验**：形状 / 平台 / 级别 / 唯一 id 都是契约，不是注释；
 * 2. **每种形状渲染成它该有的样子**：VS Code 是 `servers`，Zed 是 `context_servers`，
 *    Codex 是 TOML，Continue 的 `mcpServers` 是数组——这些差异写错的后果是
 *    "复制粘贴之后客户端静默不识别"，而静默是最难查的一种失败；
 * 3. **同一份输入渲染两次字节相同**（R6）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CLIENT_SHAPES,
  buildMcpLaunch,
  formatClientList,
  pathHintFor,
  renderClientConfig,
  validateClientManifest,
  type ClientEntry,
  type ClientManifest,
} from "../src/index.ts";

const MANIFEST_PATH = join(process.cwd(), "docs", "integrations", "clients.json");

function manifest(): ClientManifest {
  const verdict = validateClientManifest(JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as unknown);
  assert.equal(verdict.ok, true, verdict.ok ? "" : verdict.issues.join("\n"));
  if (!verdict.ok) throw new Error("unreachable");
  return verdict.manifest;
}

function client(id: string): ClientEntry {
  const found = manifest().clients.find((entry) => entry.id === id);
  assert.ok(found, `清单里应该有 ${id}`);
  return found;
}

test("清单：能过校验，P0 覆盖 IDE / 桌面 / 编码 agent，id 唯一", () => {
  const parsed = manifest();
  const ids = parsed.clients.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, "id 不许重复");

  for (const required of [
    "vscode",
    "vscode-copilot",
    "cherry-studio",
    "cline",
    "roo-code",
    "claude-desktop",
    "claude-code",
    "cursor",
  ]) {
    assert.ok(ids.includes(required), `P0 必须覆盖 ${required}`);
  }

  for (const entry of parsed.clients) {
    assert.equal(entry.transport, "stdio", `${entry.id}：个人版只做本地 stdio`);
    assert.ok((CLIENT_SHAPES as readonly string[]).includes(entry.shape), `${entry.id} 的形状必须是已知形状`);
  }
});

test("清单：坏数据要指出具体是哪一条、错在哪", () => {
  const base = {
    manifest_version: 1,
    clients: [
      {
        id: "ok",
        name: "OK",
        tier: "p0",
        shape: "mcpServers-json",
        scope: "user",
        transport: "stdio",
        paths: { windows: "x.json" },
      },
    ],
  };

  assert.equal(validateClientManifest(base).ok, true);

  const duplicate = {
    ...base,
    clients: [base.clients[0], { ...base.clients[0] }],
  };
  const dup = validateClientManifest(duplicate);
  assert.equal(dup.ok, false);
  assert.match(dup.ok ? "" : dup.issues.join("\n"), /id 重复/);

  const remote = { ...base, clients: [{ ...base.clients[0], transport: "http" }] };
  const badTransport = validateClientManifest(remote);
  assert.equal(badTransport.ok, false);
  assert.match(badTransport.ok ? "" : badTransport.issues.join("\n"), /只能是 stdio/);

  const badShape = { ...base, clients: [{ ...base.clients[0], shape: "mcpServers" }] };
  const shape = validateClientManifest(badShape);
  assert.equal(shape.ok, false);
  assert.match(shape.ok ? "" : shape.issues.join("\n"), /shape/);
});

test("新增客户端：TRAE / Kimi 是 mcpServers，CodeBuddy / Qoder 带 type，DSH 是 Cordis YAML", () => {
  const parsed = manifest();
  const ids = parsed.clients.map((entry) => entry.id);
  for (const required of ["trae", "codebuddy", "qoder", "deepseek-harness", "kimi-code"]) {
    assert.ok(ids.includes(required), `清单里应该有 ${required}`);
  }

  const launch = buildMcpLaunch("linux", "/repo", "/repo/data");

  for (const id of ["trae", "kimi-code"]) {
    const rendered = renderClientConfig(client(id), launch, { platform: "linux" });
    const json = JSON.parse(rendered.content) as Record<string, any>;
    assert.ok(json["mcpServers"]?.["forge"], `${id} 用 mcpServers`);
    assert.equal(json["mcpServers"]["forge"]["type"], undefined, `${id} 不要求 type`);
  }

  for (const id of ["codebuddy", "qoder"]) {
    const rendered = renderClientConfig(client(id), launch, { platform: "linux" });
    const json = JSON.parse(rendered.content) as Record<string, any>;
    assert.equal(json["mcpServers"]["forge"]["type"], "stdio", `${id} 显式写 type`);
  }

  const dsh = renderClientConfig(client("deepseek-harness"), launch, { platform: "linux" });
  assert.equal(dsh.format, "yaml");
  assert.match(dsh.content, /^- insert:\n/m);
  assert.match(dsh.content, /name: "@deepseek-ai\/dsh-mcp-client"/);
  assert.match(dsh.content, /serverName: "forge"/);
  assert.match(dsh.content, /transport: "stdio"/);
});

test("启动方式：Windows 走 forge-mcp.cmd，其他平台走仓库内 tsx；全部绝对路径", () => {
  const win = buildMcpLaunch("win32", "D:/repo", "D:/repo/data");
  assert.equal(win.command, "cmd");
  assert.deepEqual(win.args, ["/c", "D:\\repo\\forge-mcp.cmd", "--vault", "D:\\repo\\data"]);

  const linux = buildMcpLaunch("linux", "/repo", "/repo/data");
  assert.equal(linux.command, "node");
  assert.deepEqual(linux.args, [
    "/repo/node_modules/tsx/dist/cli.mjs",
    "/repo/apps/mcp/src/main.ts",
    "--vault",
    "/repo/data",
  ]);
  for (const arg of [linux.args[0], linux.args[1], linux.args[3]]) {
    assert.ok(arg !== undefined && arg.startsWith("/"), `必须是绝对路径：${String(arg)}`);
  }

  const mac = buildMcpLaunch("darwin", "/repo", "/repo/data");
  assert.equal(mac.command, "node");
  assert.match(mac.args[0] ?? "", /^\/repo\//);
});

test("渲染：mcpServers / servers / context_servers 三个顶层键不许串台", () => {
  const launch = buildMcpLaunch("linux", "/repo", "/repo/data");

  const claude = JSON.parse(renderClientConfig(client("claude-desktop"), launch, { platform: "linux" }).content) as any;
  assert.ok(claude["mcpServers"]["forge"]);
  assert.equal(claude["servers"], undefined);

  const vscode = JSON.parse(renderClientConfig(client("vscode"), launch, { platform: "linux" }).content) as any;
  assert.ok(vscode["servers"]["forge"]);
  assert.equal(vscode["servers"]["forge"]["type"], "stdio");
  assert.equal(vscode["mcpServers"], undefined, "VS Code Local harness 的顶层键是 servers");

  const zed = JSON.parse(renderClientConfig(client("zed"), launch, { platform: "linux" }).content) as any;
  assert.ok(zed["context_servers"]["forge"]);
  assert.equal(zed["mcpServers"], undefined, "Zed 的顶层键是 context_servers");

  const copilot = JSON.parse(renderClientConfig(client("vscode-copilot"), launch, { platform: "linux" }).content) as any;
  assert.ok(copilot["mcpServers"]["forge"], "新 Copilot harness 用 mcpServers");
});

test("渲染：Codex 是 TOML，Continue 的 mcpServers 是数组，GUI 是字段表", () => {
  const launch = buildMcpLaunch("linux", "/repo", "/repo/data");

  const toml = renderClientConfig(client("codex"), launch, { platform: "linux" });
  assert.equal(toml.format, "toml");
  assert.match(toml.content, /^\[mcp_servers\.forge\]\n/);
  assert.match(toml.content, /command = "node"/);
  assert.match(toml.content, /args = \[\n/);

  const continueConfig = renderClientConfig(client("continue"), launch, { platform: "linux" });
  assert.equal(continueConfig.format, "yaml");
  assert.match(continueConfig.content, /^mcpServers:\n  - name: "forge"\n/m);
  assert.doesNotMatch(continueConfig.content, /mcpServers:\n  forge:/, "Continue 是数组，不是对象");

  const gui = renderClientConfig(client("cherry-studio"), launch, { platform: "linux" });
  assert.equal(gui.format, "text");
  assert.match(gui.content, /^Transport: stdio\n/m);
  assert.match(gui.content, /^Command: node\n/m);
});

test("渲染：逐字节确定；路径提示按平台取，不认识的平台键在校验期就红", () => {
  const launch = buildMcpLaunch("win32", "D:/repo", "D:/repo/data");
  const a = renderClientConfig(client("cursor"), launch, { platform: "win32" });
  const b = renderClientConfig(client("cursor"), launch, { platform: "win32" });
  assert.equal(a.content, b.content);

  assert.equal(pathHintFor(client("cursor"), "win32"), "%USERPROFILE%\\.cursor\\mcp.json");
  assert.equal(pathHintFor(client("cursor"), "linux"), "~/.cursor/mcp.json");
  assert.equal(pathHintFor(client("cherry-studio"), "linux"), null);

  const list = formatClientList(manifest(), "linux");
  assert.match(list, /^id\ttier\tshape\t配置位置\n/);
  assert.match(list, /vscode\tp0\tservers-json/);
  assert.match(list, /zed\tp1\tcontext_servers-json/);
});
