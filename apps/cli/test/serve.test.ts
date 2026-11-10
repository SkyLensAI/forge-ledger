/**
 * `forge serve` 的测试（S23）—— 五条性质，全是**安全**或**边界**性质：
 *
 * 1. **只绑回环**：从本机回环能连上，而且监听地址不是 `0.0.0.0`。
 * 2. **没有 token 一律 401**：回环不等于安全——任何一个网页都能发请求。
 * 3. **网页来的请求 403**，**即使 token 对**（纵深防御）。
 * 4. **取用与 CLI 逐字节相同**：判定只有一份，宿主有三个（CLI / MCP / 桥）。
 * 5. **采集是增量的**：同一批报两次，第二次一个新来源都不产生。
 *
 * 它跑的是真的 HTTP（真的 `fetch`、真的端口、真的进程内服务器），
 * 因为这一层的错法全在"接线"上：header 名字写错、CORS 头漏了、
 * 绑了 0.0.0.0——这些只有真的连一次才会错。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SCHEMA_VERSION,
  renderAssetDocument,
  type AssetFrontMatter,
} from "@forge/schema";
import { openVault } from "@forge/store";
import { startServer } from "../src/serve.ts";

const REPO = process.cwd();
const ANCHOR = "检索优先，绝不预加载整个大脑";
const SPAN = `file://docs/note.md#t:${ANCHOR}`;

function temp(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "forge-serve-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * @param {string} root
 * @returns {void}
 */
function seed(root: string): void {
  const vault = openVault(root);
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs", "note.md"), `# 说明\n\n${ANCHOR}。\n`, "utf8");

  const frontMatter: AssetFrontMatter = {
    schema_version: SCHEMA_VERSION,
    id: "state_01M6Q2FD00NVKBVBH80QD63VSX",
    type: "state",
    status: "active",
    created: "2026-01-01",
    last_confirmed: "2026-11-01",
    supersedes: null,
    origin_incident: null,
    subject: "索引层的存储后端",
    sources: [SPAN],
    sensitivity: "internal",
    confidence: 0.9,
  };
  const body = "# 存储后端用 SQLite\n\n## 当前状态\n\n索引层用 node:sqlite。\n";
  mkdirSync(join(root, "assets", "state"), { recursive: true });
  // 连测试也绕不过审计条目：`writeAuthored` 的第二个参数**必填**（S27）。
  // 这行代码本身就是那条纪律的演示——夹具也得说清"这条是谁、什么时候写进去的"。
  vault.assets.writeAuthored(
    {
      path: "assets/state/state_01M6Q2FD00NVKBVBH80QD63VSX.md",
      frontMatter,
      body,
      raw: renderAssetDocument(frontMatter, body),
    },
    {
      at: "2026-11-01T00:00:00.000Z",
      actor: "test-fixture",
      kind: "asset-promoted",
      subject: frontMatter.id,
      detail: { why: "取用测试的夹具资产" },
    },
  );
}

const QUERY = "索引层的存储后端怎么选";

/** 每次用一个不冲突的端口：`0` 会让系统分配，但我们要断言"绑的是哪个地址"。 */
let nextPort = 18787;
function takePort(): number {
  nextPort += 1;
  return nextPort;
}

test("取用：桥给出的注入与 CLI **逐字节相同**（判定只有一份，宿主有三个）", async () => {
  const vault = temp();
  const port = takePort();
  const server = await startServer({ vault: vault.root, port, today: "2026-11-06", token: "t".repeat(24), log: () => {} });
  try {
    seed(vault.root);
    const response = await fetch(`http://127.0.0.1:${String(port)}/context?q=${encodeURIComponent(QUERY)}&budget=700`, {
      headers: { "x-forge-token": "t".repeat(24) },
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /这不是全库/);

    const cli = spawnSync(
      "node",
      [join(REPO, "apps", "cli", "src", "main.ts"), "context", QUERY, "--vault", vault.root, "--today", "2026-11-06", "--budget", "700"],
      { cwd: REPO, encoding: "utf8", env: { PATH: process.env["PATH"] ?? "" } },
    );
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(text, cli.stdout, "三个宿主必须给出同一段字节");
  } finally {
    await server.close();
    vault.cleanup();
  }
});

test("安全：没有 token 401；token 不对也 401", async () => {
  const vault = temp();
  const port = takePort();
  const server = await startServer({ vault: vault.root, port, token: "s".repeat(24), log: () => {} });
  try {
    const missing = await fetch(`http://127.0.0.1:${String(port)}/health`);
    assert.equal(missing.status, 401);

    const wrong = await fetch(`http://127.0.0.1:${String(port)}/health`, { // 头部只能放 ASCII：用一个同样"不对"但形状合法的值。
        headers: { "x-forge-token": "wrong-token-wrong-token" } });
    assert.equal(wrong.status, 401);

    const right = await fetch(`http://127.0.0.1:${String(port)}/health`, { headers: { "x-forge-token": "s".repeat(24) } });
    assert.equal(right.status, 200);
  } finally {
    await server.close();
    vault.cleanup();
  }
});

test("安全：网页来的请求 403 —— **即使 token 是对的**", async () => {
  const vault = temp();
  const port = takePort();
  const token = "w".repeat(24);
  const server = await startServer({ vault: vault.root, port, token, log: () => {} });
  try {
    const fromPage = await fetch(`http://127.0.0.1:${String(port)}/health`, {
      headers: { "x-forge-token": token, origin: "https://evil.example" },
    });
    assert.equal(fromPage.status, 403, "token 可能被截屏、被贴进聊天记录——网页一律拒");

    // 反例：扩展来源要放行，否则这条纵深防御会把正经用途一起挡掉。
    const fromExtension = await fetch(`http://127.0.0.1:${String(port)}/health`, {
      headers: { "x-forge-token": token, origin: "chrome-extension://abcdefghijklmnop" },
    });
    assert.equal(fromExtension.status, 200);
    assert.equal(
      fromExtension.headers.get("access-control-allow-origin"),
      "chrome-extension://abcdefghijklmnop",
      "回显来源，而不是 `*`——`*` 会让「哪些来源被放行」从代码里消失",
    );
  } finally {
    await server.close();
    vault.cleanup();
  }
});

test("采集：增量落到 sources，**再报一次一个新来源都不产生**", async () => {
  const vault = temp();
  const port = takePort();
  const token = "c".repeat(24);
  const server = await startServer({ vault: vault.root, port, token, log: () => {} });
  try {
    const report = {
      host: "https://chat.example.com/",
      label: "示例对话",
      page: "https://chat.example.com/c/1",
      items: [
        { text: "索引层最后选了 node:sqlite", author: "user", time: "2026-11-06T10:00:00Z" },
        { text: "发布节奏是两周一个版本", author: "user", time: "2026-11-06T10:01:00Z" },
      ],
      skipped: ["第 3 条记录的正文为空"],
    };
    const post = (body: unknown) =>
      fetch(`http://127.0.0.1:${String(port)}/capture`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forge-token": token },
        body: JSON.stringify(body),
      });

    const first = await post(report);
    assert.equal(first.status, 200);
    const outcome = (await first.json()) as Record<string, any>;
    assert.equal(outcome["fresh"], 2);
    assert.equal(outcome["sourceId"] !== null, true);
    assert.equal(outcome["skipped"].length, 1, "扩展报上来的 skipped 原样回来");

    const again = (await (await post(report)).json()) as Record<string, any>;
    assert.equal(again["fresh"], 0);
    assert.equal(again["duplicates"], 2);
    assert.equal(again["sourceId"], null, "没有新东西 → 一个字节都不写");

    assert.equal(readdirSync(join(vault.root, "sources")).length, 1);
    assert.equal(openVault(vault.root).derive().events.length, 2, "采到的东西要真的能推出事件");
  } finally {
    await server.close();
    vault.cleanup();
  }
});

test("恶意/坏请求：坏 JSON 400、超限 413、形状不对 400，服务器都活着", async () => {
  const vault = temp();
  const port = takePort();
  const token = "b".repeat(24);
  const server = await startServer({ vault: vault.root, port, token, log: () => {} });
  try {
    const post = (body: string) =>
      fetch(`http://127.0.0.1:${String(port)}/capture`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forge-token": token },
        body,
      });

    assert.equal((await post("{ 这不是 JSON")).status, 400);
    assert.equal((await post(JSON.stringify({ host: "", page: "p", items: [] }))).status, 400);
    assert.equal((await post("x".repeat(2 * 1024 * 1024))).status, 413);

    // 服务器还活着：一条坏请求只该毁掉它自己。
    const health = await fetch(`http://127.0.0.1:${String(port)}/health`, { headers: { "x-forge-token": token } });
    assert.equal(health.status, 200);
  } finally {
    await server.close();
    vault.cleanup();
  }
});

test("取用：查询为空 400，预算低于下限 400（不为它编一个默认）", async () => {
  const vault = temp();
  const port = takePort();
  const token = "q".repeat(24);
  const server = await startServer({ vault: vault.root, port, token, log: () => {} });
  try {
    const headers = { "x-forge-token": token };
    assert.equal((await fetch(`http://127.0.0.1:${String(port)}/context`, { headers })).status, 400);
    assert.equal((await fetch(`http://127.0.0.1:${String(port)}/context?q=甲&budget=10`, { headers })).status, 400);
    assert.equal((await fetch(`http://127.0.0.1:${String(port)}/nope`, { headers })).status, 404);
  } finally {
    await server.close();
    vault.cleanup();
  }
});

test("热更新：桥去拿远端配置，按 revision 决定用谁；远端挂了就退回本地那份", async () => {
  const vault = temp();
  const port = takePort();
  const token = "s".repeat(24);
  const remote = {
    config_version: 1,
    revision: 7,
    updated_at: "2026-11-06",
    hosts: [{ match: "https://new.example/", label: "新版", item: ".m", fields: { text: ".t" } }],
  };
  let fetched = 0;
  const server = await startServer({
    vault: vault.root,
    port,
    token,
    selectorUrl: "https://config.example/selectors.json",
    fetchText: async () => {
      fetched += 1;
      return JSON.stringify(remote);
    },
    log: () => {},
  });
  try {
    const headers = { "x-forge-token": token };
    const newer = (await (await fetch(`http://127.0.0.1:${String(port)}/selectors?have=1`, { headers })).json()) as Record<string, any>;
    assert.equal(newer["use"], "remote");
    assert.equal(newer["config"].revision, 7);
    assert.equal(fetched, 1);

    const older = (await (await fetch(`http://127.0.0.1:${String(port)}/selectors?have=9`, { headers })).json()) as Record<string, any>;
    assert.equal(older["use"], "local", "手里那份更新 → 用它，免得一次扩展更新把热修倒退回去");
  } finally {
    await server.close();
    vault.cleanup();
  }
});

test("热更新：远端拿不到（null）→ 结论是「用你手里那份」，不是错误", async () => {
  const vault = temp();
  const port = takePort();
  const token = "n".repeat(24);
  const server = await startServer({
    vault: vault.root,
    port,
    token,
    selectorUrl: "https://config.example/selectors.json",
    fetchText: async () => null,
    log: () => {},
  });
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/selectors?have=3`, {
      headers: { "x-forge-token": token },
    });
    assert.equal(response.status, 200);
    const decision = (await response.json()) as Record<string, any>;
    assert.equal(decision["use"], "local");
    assert.match(String(decision["why"]), /远端没有配置/);
  } finally {
    await server.close();
    vault.cleanup();
  }
});

test("日志留痕：取用/采集/热更新的每一次决定都写一行（stderr，不是 stdout）", async () => {
  const vault = temp();
  const port = takePort();
  const token = "l".repeat(24);
  const lines: string[] = [];
  const server = await startServer({ vault: vault.root, port, token, log: (line) => lines.push(line) });
  try {
    await fetch(`http://127.0.0.1:${String(port)}/selectors?have=1`, { headers: { "x-forge-token": token } });
    assert.ok(
      lines.some((line) => line.includes("/selectors")),
      `热更新的「生效了吗」要能被回答，实际日志：${lines.join(" | ")}`,
    );
  } finally {
    await server.close();
    vault.cleanup();
  }
});

test("绑的是回环地址，不是 0.0.0.0（这条边界由代码写死，不靠调用方记得）", async () => {
  const vault = temp();
  const port = takePort();
  const server = await startServer({ vault: vault.root, port, token: "x".repeat(24), log: () => {} });
  try {
    // 回环连得上。
    const ok = await fetch(`http://127.0.0.1:${String(port)}/health`, { headers: { "x-forge-token": "x".repeat(24) } });
    assert.equal(ok.status, 200);

    // 而"监听的地址"这条性质本身写在 `serve.ts` 的 `listen(port, "127.0.0.1")` 里。
    // 这里断言那句代码还在——它的每一次改动都该是一次显式的决定。
    const source = readFileSync(join(REPO, "apps", "cli", "src", "serve.ts"), "utf8");
    assert.match(source, /listen\(port, "127\.0\.0\.1"/, "绑回环是这一层的安全边界");
    assert.doesNotMatch(source, /listen\(port, "0\.0\.0\.0"/);
  } finally {
    await server.close();
    vault.cleanup();
  }
});
