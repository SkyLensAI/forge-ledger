/**
 * `forge mcp-config` 的 CLI 侧（personal2.md）。
 *
 * 这里测的是**片段能不能直接用**，不是客户端本身：
 *
 * 1. `--list` 能看见清单里有哪些客户端；
 * 2. 每种形状输出正确的顶层键（VS Code `servers` / Zed `context_servers` / Codex TOML）；
 * 3. **stdout 只有片段**——路径提示与注意事项走 stderr，这样重定向到文件才安全；
 * 4. 错参数（未知客户端、`--list` 与 `--client` 同给）退出码为 2，并列出可用的 id。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const REPO = process.cwd();
const CLI = join(REPO, "apps", "cli", "src", "main.ts");

function forge(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("node", [CLI, "mcp-config", ...args], {
    cwd: REPO,
    encoding: "utf8",
    env: { PATH: process.env["PATH"] ?? "" },
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

test("--list：列出 id、级别、形状与当前平台的路径", () => {
  const result = forge(["--list", "--platform", "linux"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^id\ttier\tshape\t配置位置\n/);
  for (const id of ["claude-desktop", "vscode", "cherry-studio", "codex", "zed", "continue", "trae", "codebuddy", "qoder", "deepseek-harness", "kimi-code"]) {
    assert.match(result.stdout, new RegExp(`^${id}\\t`, "m"), `--list 里应该有 ${id}`);
  }
  assert.match(result.stdout, /vscode\tp0\tservers-json/);
  assert.match(result.stdout, /zed\tp1\tcontext_servers-json/);
  assert.match(result.stdout, /codex\tp1\tmcp_servers-toml/);
  assert.match(result.stdout, /deepseek-harness\tp1\tcordis-yaml/);
  assert.match(result.stdout, /qoder\tp1\tmcpServers-typed-json/);
});

test("VS Code：顶层键是 servers（不是 mcpServers），且 stdout 只有 JSON", () => {
  const result = forge(["--client", "vscode", "--vault", "data", "--platform", "win32"]);
  assert.equal(result.status, 0, result.stderr);

  // stdout 只允许片段：重定向进文件后必须能直接解析。
  assert.doesNotMatch(result.stdout, /^·/m, "提示不许混进 stdout");
  const parsed = JSON.parse(result.stdout) as Record<string, any>;
  assert.ok(parsed["servers"]?.["forge"], "VS Code Local harness 用 servers");
  assert.equal(parsed["mcpServers"], undefined);
  assert.equal(parsed["servers"]["forge"]["type"], "stdio");
  assert.equal(parsed["servers"]["forge"]["command"], "cmd");
  assert.match(parsed["servers"]["forge"]["args"].join(" "), /forge-mcp\.cmd/);
  assert.match(result.stderr, /VS Code/);
  assert.match(result.stderr, /配置位置/);
});

test("Cursor：mcpServers；Linux 用 node + 仓库内 tsx 的绝对路径", () => {
  const result = forge(["--client", "cursor", "--vault", "/tmp/forge-vault", "--platform", "linux"]);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout) as Record<string, any>;
  assert.ok(parsed["mcpServers"]?.["forge"]);
  assert.equal(parsed["mcpServers"]["forge"]["command"], "node");
  assert.match(parsed["mcpServers"]["forge"]["args"][0], /node_modules\/tsx\/dist\/cli\.mjs$/);
  assert.ok(parsed["mcpServers"]["forge"]["args"].some((arg: string) => arg.endsWith("forge-vault")));
});

test("Zed / Codex / Continue：各自的形状不串台", () => {
  const zed = forge(["--client", "zed", "--platform", "linux"]);
  assert.equal(zed.status, 0, zed.stderr);
  const zedJson = JSON.parse(zed.stdout) as Record<string, any>;
  assert.ok(zedJson["context_servers"]?.["forge"]);
  assert.equal(zedJson["mcpServers"], undefined);

  const codex = forge(["--client", "codex", "--platform", "linux"]);
  assert.equal(codex.status, 0, codex.stderr);
  assert.match(codex.stdout, /^\[mcp_servers\.forge\]\n/);
  assert.match(codex.stdout, /command = "node"/);

  const cont = forge(["--client", "continue", "--platform", "linux"]);
  assert.equal(cont.status, 0, cont.stderr);
  assert.match(cont.stdout, /^mcpServers:\n  - name: "forge"\n/m);
});

test("TRAE / CodeBuddy / Qoder / Kimi：mcpServers 形状；CodeBuddy / Qoder 显式带 type", () => {
  for (const id of ["trae", "kimi-code"]) {
    const result = forge(["--client", id, "--platform", "linux"]);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout) as Record<string, any>;
    assert.ok(parsed["mcpServers"]?.["forge"], `${id} 用 mcpServers`);
    assert.equal(parsed["mcpServers"]["forge"]["type"], undefined, `${id} 不要求 type`);
  }

  for (const id of ["codebuddy", "qoder"]) {
    const result = forge(["--client", id, "--platform", "linux"]);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout) as Record<string, any>;
    assert.equal(parsed["mcpServers"]["forge"]["type"], "stdio", `${id} 显式写 type`);
  }
});

test("DeepSeek Harness：生成 cordis.patch.yml 的 insert 片段，不是 mcp.json", () => {
  const result = forge(["--client", "deepseek-harness", "--platform", "linux"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^- insert:\n/m);
  assert.match(result.stdout, /name: "@deepseek-ai\/dsh-mcp-client"/);
  assert.match(result.stdout, /serverName: "forge"/);
  assert.match(result.stdout, /transport: "stdio"/);
  assert.match(result.stderr, /cordis\.patch\.yml/);
  assert.doesNotMatch(result.stdout, /mcpServers/, "DSH 没有 mcp.json 这一层");
});

test("GUI 客户端：给字段表，不需要用户理解 JSON", () => {
  const result = forge(["--client", "cherry-studio", "--platform", "linux"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Name: forge\n/);
  assert.match(result.stdout, /^Transport: stdio\n/m);
  assert.match(result.stdout, /^Command: node\n/m);
  assert.match(result.stderr, /设置 → MCP/);
});

test("错参数：未知客户端 / 缺 --client / --list 与 --client 同给 → 退出码 2，并列出 id", () => {
  const unknown = forge(["--client", "no-such-client"]);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /未知客户端/);
  assert.match(unknown.stderr, /claude-desktop/);

  const missing = forge([]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /--client <id> 或 --list/);

  const both = forge(["--list", "--client", "cursor"]);
  assert.equal(both.status, 2);
  assert.match(both.stderr, /只能给一个/);
});
