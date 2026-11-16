#!/usr/bin/env node
/**
 * 给已经落盘的资产补上 H1 标题（只补正文，front-matter 一个字节不动）。
 *
 * 为什么单独一步：`promote` 只搬候选正文，而候选正文可能从 `## 问题` 开始。
 * 没有 H1 时，`forge emit` 会把资产 ID 当成标题——标题是投影里最该像人话的那一行。
 *
 * 写入仍然走 `writeAuthored`（带审计见证人），不是直接改文件。
 *
 * 用法：
 *   pnpm tsx scripts/cherry-complete-assets.ts --vault data --spec data/imports/curated-assets.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { renderAssetDocument, type AssetDoc } from "../packages/schema/src/index.ts";
import { openVault } from "../packages/store/src/index.ts";
import { AUDIT_KINDS } from "../packages/core/src/audit.ts";

interface SpecAsset {
  /** 可选：按资产 ID 精确匹配。同一类型有多条资产引用同一处出处时必须给。 */
  id?: string;
  type: string;
  title: string;
  sources: string[];
  body: string;
}

interface Spec {
  actor: string;
  assets: SpecAsset[];
}

function valueOf(argv: string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}

const argv = process.argv.slice(2);
const vaultPath = valueOf(argv, "--vault") ?? "data";
const specPath = valueOf(argv, "--spec");
if (specPath === null) {
  process.stderr.write("✗ 必须给 --spec <文件>：标题来自人工选稿，不该由脚本猜。\n");
  process.exit(2);
}

const specFile = resolve(specPath);
const spec = specFile.endsWith(".json")
  ? (JSON.parse(readFileSync(specFile, "utf8")) as Spec)
  : ((await import(pathToFileURL(specFile).href)) as { default: Spec }).default;

const vault = openVault(resolve(vaultPath));
const docs = vault.assets.scan().docs;
let updated = 0;

for (const item of spec.assets) {
  const doc = item.id
    ? docs.find((candidate) => candidate.frontMatter.id === item.id)
    : docs.find(
        (candidate) =>
          candidate.frontMatter.type === item.type &&
          JSON.stringify([...candidate.frontMatter.sources].sort()) === JSON.stringify([...item.sources].sort()),
      );
  if (doc === undefined) {
    process.stderr.write(`· 跳过：库里没有对应 ${item.type}（${item.title}）\n`);
    continue;
  }
  if (/^#\s/m.test(doc.body.split("\n", 1)[0] ?? "")) continue;

  const body = `# ${item.title}\n\n${doc.body.replace(/^\n+/, "")}`;
  const next: AssetDoc = {
    path: doc.path,
    frontMatter: doc.frontMatter,
    body,
    raw: renderAssetDocument(doc.frontMatter, body),
  };
  vault.assets.writeAuthored(next, {
    at: new Date().toISOString(),
    actor: spec.actor,
    kind: AUDIT_KINDS.ASSET_PROMOTED,
    subject: doc.frontMatter.id,
    detail: { action: "complete-draft-title", path: doc.path },
  });
  updated += 1;
}

process.stdout.write(`✓ 补标题 ${String(updated)} 条\n`);
