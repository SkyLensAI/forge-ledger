/**
 * 上架包（S31）的尺子。
 *
 * 三条要钉住的性质：
 * 1. **可重生成**：同一份库两次生成逐字节相同；
 * 2. **同一批资产**：Skill 的 references 数量等于决策数量，清单里的总数等于库的总数；
 * 3. **诚实**：产物永远自称 draft / published=false，不编造作者、仓库与版本。
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
import { emitListing } from "../src/distribution.ts";

/**
 * @param {AssetType} type
 * @param {number} index
 * @param {Partial<AssetFrontMatter>} [overrides]
 * @returns {AssetDoc}
 */
function asset(type: AssetType, index: number, overrides: Partial<AssetFrontMatter> = {}): AssetDoc {
  const frontMatter: AssetFrontMatter = {
    schema_version: SCHEMA_VERSION,
    id: `${type === "decision" ? "dec" : type === "rule" ? "rule" : type === "state" ? "state" : "event"}_${String(index).padStart(26, "0")}`,
    type,
    status: type === "decision" ? "accepted" : type === "event" ? "recorded" : "active",
    created: `2026-11-0${String((index % 6) + 1)}`,
    last_confirmed: type === "state" ? "2026-11-06" : null,
    supersedes: null,
    origin_incident: type === "rule" ? "file://docs/implement2.md#t:把闸门写成 checklist" : null,
    subject: `${type}:${String(index)}`,
    sources: ["file://docs/implement2.md#t:把闸门写成 checklist"],
    sensitivity: "internal",
    confidence: 0.8,
    ...overrides,
  };
  const body = `# ${type} ${String(index)}\n\n## 问题\n\n测试。\n`;
  return {
    path: `assets/${type}/${String(index)}.md`,
    frontMatter,
    body,
    raw: renderAssetDocument(frontMatter, body),
  };
}

const ASSETS: AssetDoc[] = [
  asset("decision", 1),
  asset("decision", 2),
  asset("rule", 3),
  asset("state", 4),
];

test("上架包两次生成逐字节相同（产物是投影，不是第二份真相）", () => {
  const first = emitListing({ assets: ASSETS, events: [] });
  const second = emitListing({ assets: [...ASSETS].reverse(), events: [] });
  assert.deepEqual(first, second);
});

test("必需文件都在，JSON 都能解析", () => {
  const files = emitListing({ assets: ASSETS, events: [] });
  const paths = new Set(files.map((file) => file.path));
  for (const path of [
    ".claude-plugin/marketplace.json",
    "plugins/forge/.claude-plugin/plugin.json",
    "plugins/forge/.mcp.json",
    "plugins/forge/skills/forge/SKILL.md",
    "manifest.json",
    "README.md",
    "SUBMISSION.md",
  ]) {
    assert.equal(paths.has(path), true, `缺 ${path}`);
  }

  for (const path of [
    ".claude-plugin/marketplace.json",
    "plugins/forge/.claude-plugin/plugin.json",
    "plugins/forge/.mcp.json",
    "manifest.json",
  ]) {
    const file = files.find((item) => item.path === path);
    assert.ok(file !== undefined);
    assert.doesNotThrow(() => JSON.parse(file.content), `${path} 不是合法 JSON`);
  }
});

test("Skill 的 references 数量等于决策数量（同一批资产，不是另一份清单）", () => {
  const files = emitListing({ assets: ASSETS, events: [] });
  const references = files.filter((file) => file.path.startsWith("plugins/forge/skills/forge/references/"));
  assert.equal(references.length, ASSETS.filter((item) => item.frontMatter.type === "decision").length);
});

test("清单计数来自库本身", () => {
  const files = emitListing({ assets: ASSETS, events: [] });
  const manifest = JSON.parse(files.find((file) => file.path === "manifest.json")?.content ?? "{}") as {
    assets?: { total?: number; decision?: number; rule?: number; state?: number };
  };
  assert.equal(manifest.assets?.total, 4);
  assert.equal(manifest.assets?.decision, 2);
  assert.equal(manifest.assets?.rule, 1);
  assert.equal(manifest.assets?.state, 1);
});

test("上架包永远自称 draft —— 代码不替人按提交按钮", () => {
  const files = emitListing({ assets: ASSETS, events: [] });
  const manifest = JSON.parse(files.find((file) => file.path === "manifest.json")?.content ?? "{}") as {
    status?: string;
    published?: boolean;
  };
  assert.equal(manifest.status, "draft");
  assert.equal(manifest.published, false);

  const submission = files.find((file) => file.path === "SUBMISSION.md")?.content ?? "";
  assert.match(submission, /必须由人完成/);
  assert.match(submission, /published/);
});

test("输出里没有时间戳、没有 CRLF", () => {
  const files = emitListing({ assets: ASSETS, events: [] });
  for (const file of files) {
    assert.doesNotMatch(file.content, /\r/, `${file.path} 含 CRLF`);
    assert.doesNotMatch(file.content, /\d{2}:\d{2}:\d{2}/, `${file.path} 里出现了时间戳`);
  }
});

test("空库也能生成一份诚实的空上架包", () => {
  const files = emitListing({ assets: [], events: [] });
  const manifest = JSON.parse(files.find((file) => file.path === "manifest.json")?.content ?? "{}") as {
    assets?: { total?: number };
  };
  assert.equal(manifest.assets?.total, 0);
  assert.equal(files.some((file) => file.path.endsWith("references/0001-x.md")), false);
});
