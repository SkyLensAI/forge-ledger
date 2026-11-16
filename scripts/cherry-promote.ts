#!/usr/bin/env node
/**
 * 把一批**人工挑过**的 Cherry Studio 候选提升成资产。
 *
 * 这不是自动 promote：`promote` 的定义是"人确认了这条"，而这里的选择、
 * 类型、正文与必填章节都写在 `--spec` 指向的文件里——脚本只负责三件事：
 *   - 铸 ID、写 front-matter；
 *   - 走**唯一**的写入口 `writeAuthored`（带审计见证人）；
 *   - 把已经提升的候选从 `_inbox/` 移走，避免下次抽取重复。
 *
 * 它与 `forge inbox --promote` 的区别只有一个：promote 原样搬候选正文，
 * 会留下一份缺必填章节的草稿；这里允许把正文补成能过 `forge lint` 的形状。
 * **判定没有变**：出处原样搬、类型由人给定、置信度由人给定、没有默认值。
 *
 * 用法：
 *   pnpm tsx scripts/cherry-promote.ts --vault data --spec data/imports/curated-assets.json
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assetDirOf,
  mintAssetId,
  newFrontMatter,
  renderAssetDocument,
  type AssetDoc,
  type AssetFrontMatter,
  type AssetType,
} from "../packages/schema/src/index.ts";
import { openVault } from "../packages/store/src/index.ts";
import { AUDIT_KINDS } from "../packages/core/src/audit.ts";

interface SpecAsset {
  /** 可选：只有当这条资产确实来自一个模型候选时才填；人工从对话直接梳理的条目不编造候选 ID。 */
  candidate_id?: string | null;
  type: AssetType;
  title: string;
  subject: string | null;
  status: string;
  confidence: number;
  sources: string[];
  origin_incident?: string | null;
  last_confirmed?: string | null;
  body: string;
}

interface Spec {
  actor: string;
  date: string;
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
  process.stderr.write("✗ 必须给 --spec <文件>：提升哪几条是人的决定，不该由脚本猜。\n");
  process.exit(2);
}

const specFile = resolve(specPath);
const spec = specFile.endsWith(".json")
  ? (JSON.parse(readFileSync(specFile, "utf8")) as Spec)
  : ((await import(pathToFileURL(specFile).href)) as { default: Spec }).default;
const vault = openVault(resolve(vaultPath));

const existing = vault.assets.scan().docs;
const written: string[] = [];
const skipped: string[] = [];

for (const item of spec.assets) {
  const clash = existing.find(
    (doc) =>
      doc.frontMatter.type === item.type &&
      JSON.stringify([...doc.frontMatter.sources].sort()) === JSON.stringify([...item.sources].sort()),
  );
  if (clash !== undefined) {
    skipped.push(`${item.candidate_id ?? item.title}：已经有资产指向同一处出处（${clash.path}）`);
    continue;
  }

  const candidateId =
    typeof item.candidate_id === "string" && item.candidate_id.length > 0 ? item.candidate_id : null;

  const id = mintAssetId(item.type, Date.now(), new Uint8Array(randomBytes(16)));
  const frontMatter: AssetFrontMatter = {
    ...newFrontMatter(item.type, id, spec.date),
    status: item.status,
    confidence: item.confidence,
    sources: [...item.sources],
    subject: item.subject,
    origin_incident: item.origin_incident ?? null,
    last_confirmed: item.last_confirmed ?? null,
  };
  const body = item.body.startsWith("#") ? item.body : `# ${item.title}\n\n${item.body}`;
  const doc: AssetDoc = {
    path: `assets/${assetDirOf(item.type)}/${id}.md`,
    frontMatter,
    body,
    raw: renderAssetDocument(frontMatter, body),
  };

  const outcome = vault.assets.writeAuthored(doc, {
    at: new Date().toISOString(),
    actor: spec.actor,
    kind: AUDIT_KINDS.ASSET_PROMOTED,
    subject: id,
    detail: {
      ...(candidateId === null ? {} : { candidate_id: candidateId }),
      type: item.type,
      origin: candidateId === null ? "cherry-studio-transcript-curated" : "cherry-studio-transcript",
      confidence: String(item.confidence),
      date: spec.date,
    },
  });
  if (candidateId !== null) vault.inbox.remove(candidateId);
  written.push(`${id} ← ${candidateId ?? item.title}（${outcome.path}）`);
}

process.stdout.write(`✓ 写入 ${String(written.length)} 条，跳过 ${String(skipped.length)} 条\n`);
for (const line of written) process.stdout.write(`  ${line}\n`);
for (const line of skipped) process.stdout.write(`  · 跳过 ${line}\n`);
