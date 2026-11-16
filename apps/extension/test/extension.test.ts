/**
 * 扩展的**结构测试**（S23）。
 *
 * 这里测不了"它在浏览器里工作"——CI 里没有浏览器，而那几十行 DOM 胶水
 * 也就没有任何自动化验证。这件事写在 `apps/extension/README.md` 的「没做什么」里，
 * 不假装它被覆盖了。
 *
 * 但**能测的那部分必须测满**，它们恰好是最容易悄悄坏掉的部分：
 *
 * 1. `manifest.json` 指向的每一个文件都真的存在（改名之后忘了改清单 =
 *    扩展装不上，而报错信息在另一个界面里）；
 * 2. 每个 JS 文件语法合法（`node --check`）；
 * 3. 扩展里**没有** import 工作区的包（R5 的执行体：判定不在 apps 里，
 *    而且浏览器根本执行不了那些 TypeScript）；
 * 4. 随包的那份选择器配置**真的能过 core 的解析器**——一份装不进去的兜底配置，
 *    等于没有兜底；
 * 5. `src/match.js` 里那段成文的重复与 `@forge/core` 的 `hostForUrl` **逐条一致**。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSelectorConfig, hostForUrl, type SelectorConfig } from "@forge/core";

const EXT = join(process.cwd(), "apps", "extension");

const manifest = JSON.parse(readFileSync(join(EXT, "manifest.json"), "utf8")) as Record<string, any>;

test("manifest：MV3、有名字与版本、权限窄", () => {
  assert.equal(manifest["manifest_version"], 3);
  assert.equal(typeof manifest["name"], "string");
  assert.equal(typeof manifest["version"], "string");
  assert.deepEqual(manifest["permissions"], ["storage", "activeTab"], "权限窄是这一层的安全边界，不是偏好");
  assert.deepEqual(manifest["host_permissions"], ["http://127.0.0.1/*"], "只跟本机桥说话");
});

test("manifest 指到的每个文件都真的存在", () => {
  const referenced = [
    manifest["background"]?.["service_worker"],
    manifest["action"]?.["default_popup"],
    manifest["options_ui"]?.["page"],
    ...(manifest["content_scripts"] ?? []).flatMap((script: Record<string, unknown>) => script["js"] ?? []),
  ].filter((value: unknown): value is string => typeof value === "string");

  assert.ok(referenced.length >= 4, `清单里指到的文件太少：${JSON.stringify(referenced)}`);
  for (const relative of referenced) {
    assert.ok(existsSync(join(EXT, relative)), `清单指向了不存在的文件：${relative}`);
  }
});

test("每个 JS 文件语法合法（装的进去的前提）", () => {
  for (const relative of ["src/background.js", "src/content.js", "src/match.js", "src/popup.js", "src/options.js"]) {
    const result = spawnSync("node", ["--check", join(EXT, relative)], { encoding: "utf8" });
    assert.equal(result.status, 0, `${relative} 语法不合法：${result.stderr}`);
  }
});

test("R5 的执行体：扩展里不许 import 工作区的任何包（判定不在 apps 里）", () => {
  for (const relative of ["src/background.js", "src/content.js", "src/match.js", "src/popup.js", "src/options.js"]) {
    const text = readFileSync(join(EXT, relative), "utf8");
    assert.doesNotMatch(text, /from\s+["']@forge\//, `${relative} 引用了工作区的包——浏览器执行不了它们`);
    // 反向的检查：它也不许自己造一个"判定"出来（这条只能靠人看，但至少钉住危险的形状）。
    assert.doesNotMatch(text, /eval\s*\(|new Function\s*\(/, `${relative} 里有动态执行——远端配置的安全边界就不成立了`);
  }
});

test("随包的选择器配置真的能过 core 的解析器（装不进去的兜底 = 没有兜底）", () => {
  const raw = JSON.parse(readFileSync(join(EXT, "selectors.default.json"), "utf8")) as unknown;
  const parsed = parseSelectorConfig(raw);
  assert.ok(parsed.ok, `兜底配置不合法：${parsed.ok ? "" : parsed.issues.join("；")}`);
  assert.ok(parsed.value.hosts.length > 0);
});

test("成文的重复要对得上：`match.js` 与 core 的 `hostForUrl` 逐条一致", async () => {
  const module = (await import(new URL("../src/match.js", import.meta.url).href)) as {
    hostFor: (config: unknown, url: string) => { match?: string } | null;
  };

  const config: SelectorConfig = {
    config_version: 1,
    revision: 1,
    updated_at: "2026-11-06",
    hosts: [
      { match: "https://example.com/", label: "根", item: ".m", fields: { text: ".t" } },
      { match: "https://example.com/a/b", label: "深处", item: ".m", fields: { text: ".t" } },
      { match: "https://example.com/a", label: "中层", item: ".m", fields: { text: ".t" } },
      { match: "http://127.0.0.1:8787/", label: "本机", item: ".m", fields: { text: ".t" } },
    ],
  };

  const urls = [
    "https://example.com/",
    "https://example.com/x",
    "https://example.com/a",
    "https://example.com/a/b",
    "https://example.com/a/b/c?q=1",
    "https://other.example/",
    "http://127.0.0.1:8787/health",
    "",
  ];

  for (const url of urls) {
    const core = hostForUrl(config, url);
    const extension = module.hostFor(config, url);
    assert.equal(
      extension?.match ?? null,
      core?.match ?? null,
      `${url}：扩展挑的是 ${String(extension?.match)}，core 挑的是 ${String(core?.match)}——两份实现漂移了`,
    );
  }
});
