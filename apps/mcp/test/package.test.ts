/**
 * 发布元数据的结构测试（S31 的准备，不是发布）。
 *
 * `private: true` 仍然保留：真正发布需要 scope 所有权、registry 凭据，
 * 而且 `@forge/mcp` 的 workspace 依赖也得先发出去。这里钉住的是**机器能准备的那部分**：
 * 命令名、Node 下限、随包文件、发布访问级别。
 *
 * 上架包（`listing/`）里的 `.mcp.json` 指向 `forge-mcp`；如果 `bin` 改名而这里没红，
 * 用户装到的会是一个不存在的命令——那是发布之后最难查的一类错。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

function readJson(relative: string): Record<string, any> {
  return JSON.parse(readFileSync(join(PKG_DIR, relative), "utf8")) as Record<string, any>;
}

test("@forge/mcp：bin 与 listing 指向的命令一致，文件随包发布", () => {
  const pkg = readJson("package.json");
  assert.equal(pkg["bin"]?.["forge-mcp"], "./src/main.ts");
  assert.ok(existsSync(join(PKG_DIR, "src", "main.ts")), "bin 指向的入口必须存在");
  assert.deepEqual(pkg["files"], ["src"], "发布包只带 src：别把测试与临时文件发出去");
});

test("@forge/mcp：Node 下限与 ADR-0011 一致，发布级别显式", () => {
  const pkg = readJson("package.json");
  assert.equal(pkg["engines"]?.["node"], ">=24", "零构建依赖 Node 原生类型擦除（ADR-0011）");
  assert.equal(pkg["publishConfig"]?.["access"], "public");
});

test("listing/.mcp.json：启动命令与 @forge/mcp 的 bin 同名", () => {
  const listing = readJson("../../listing/plugins/forge/.mcp.json");
  const pkg = readJson("package.json");
  const servers = listing["mcpServers"] ?? listing;
  const forge = servers["forge"] ?? Object.values(servers)[0];
  assert.equal((forge as Record<string, unknown>)["command"], Object.keys(pkg["bin"] ?? {})[0]);
});
