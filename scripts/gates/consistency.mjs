#!/usr/bin/env node
// @ts-check
/**
 * 闸门 3 的补充判定 · schema 一致性（S7 / ADR-0010）
 *
 * `directory.md` 要求人读的 `schema/` 与代码侧的 `packages/schema` 一一对应，
 * 并且"在 CI 里比对一致性"。但"一致性"如果只由人评审，它就会像所有 checklist
 * 一样被跳过（反模式 4）。所以这里把它变成**可列举、可判红的漂移检查**。
 *
 * 检查的是**漂移**，不是正确性。漂移是这两份表述唯一会犯的错：
 * 代码加了码忘了写文档、文档写了前缀分类法里没有、模板漏了必填项。
 *
 * 已知不覆盖（明确记账，不假装它被保证了）：语义漂移——文档把某条规则解释反了。
 * 缓解是 R2：`schema/` 的改动必须配 ADR，而 ADR 是给人看的。
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { repoRoot } from "./lib/git.mjs";
import { degrade, fail, ok, warn } from "./lib/report.mjs";

/** 数据来自当前工作树，判定代码来自本脚本所在的修订（见 `assets.mjs` 的同名注释）。 */
const dataRoot = process.env.FORGE_JUDGE_DATA_ROOT
  ? resolve(process.env.FORGE_JUDGE_DATA_ROOT)
  : (repoRoot() ?? process.cwd());
const codeRoot = fileURLToPath(new URL("../..", import.meta.url));

/** 一致性检查自己的码，也必须出现在 docs/handbook/gates.md 里（ADR-0010）。 */
export const CONSISTENCY_CODES = {
  TAXONOMY_DRIFT: "C1_TAXONOMY_DRIFT",
  CODE_NOT_DOCUMENTED: "C2_CODE_NOT_DOCUMENTED",
  TEMPLATE_INCOMPLETE: "C3_TEMPLATE_INCOMPLETE",
  GATE_CODE_NOT_DOCUMENTED: "C4_GATE_CODE_NOT_DOCUMENTED",
};

/**
 * @param {string} relative
 * @returns {string | null}
 */
function read(relative) {
  try {
    return readFileSync(join(dataRoot, relative), "utf8");
  } catch {
    return null;
  }
}

if (!existsSync(join(codeRoot, "node_modules")) && !existsSync(join(dataRoot, "node_modules"))) {
  warn("[consistency] node_modules 未安装，跳过 schema 一致性检查（CI 会装依赖并跑全量）");
  degrade();
}

let schema;
try {
  schema = await import(pathToFileURL(join(codeRoot, "packages/schema/src/index.ts")).href);
} catch (error) {
  warn(
    `[consistency] 无法加载 packages/schema（${error instanceof Error ? error.message : String(error)}）——` +
      "跳过。这是**无法校验**，不是校验通过",
  );
  degrade();
}

/** @type {string[]} */
const problems = [];

// ── 1. taxonomy.yaml ↔ 代码常量 ─────────────────────────────────────────────
const taxonomyText = read("schema/taxonomy.yaml");
if (taxonomyText === null) {
  problems.push(`[${CONSISTENCY_CODES.TAXONOMY_DRIFT}] schema/taxonomy.yaml 不存在——人读的那一半没有落地`);
} else {
  const parsed = schema.parseTaxonomy(taxonomyText);
  if (!parsed.ok) {
    problems.push(
      `[${CONSISTENCY_CODES.TAXONOMY_DRIFT}] schema/taxonomy.yaml 解析失败：` +
        schema.summarizeIssues(parsed.issues),
    );
  } else {
    for (const drift of schema.checkTaxonomyAgainstCode(parsed.value)) {
      problems.push(`[${CONSISTENCY_CODES.TAXONOMY_DRIFT}] ${drift}`);
    }
  }
}

// ── 2. 每个违规码必须出现在 schema/provenance.md ─────────────────────────────
const provenanceText = read("schema/provenance.md");
if (provenanceText === null) {
  problems.push(`[${CONSISTENCY_CODES.CODE_NOT_DOCUMENTED}] schema/provenance.md 不存在`);
} else {
  // 码表来自代码，不是写死在这份脚本里——写死会在加码时忘掉同步。
  const core = await import(pathToFileURL(join(codeRoot, "packages/core/src/index.ts")).href).catch(() => null);
  const codes =
    core === null
      ? []
      : [
          ...Object.values(core.ASSET_CODES),
          // 候选断言的码也是"代码与人之间的契约"（S12 引入）：抽取器的产出
          // 会带着这些码回到人面前，所以它们同样必须被写进规范里。
          ...Object.values(core.CANDIDATE_CODES),
        ];
  for (const code of codes) {
    if (!provenanceText.includes(code)) {
      problems.push(
        `[${CONSISTENCY_CODES.CODE_NOT_DOCUMENTED}] 违规码 ${code} 没有出现在 schema/provenance.md：` +
          `码是代码与人之间的契约，契约不该能单方面改（ADR-0010）`,
      );
    }
  }
}

// ── 3. 每个 ID 前缀必须出现在 schema/ids.md ─────────────────────────────────
const idsText = read("schema/ids.md");
if (idsText === null) {
  problems.push(`[${CONSISTENCY_CODES.CODE_NOT_DOCUMENTED}] schema/ids.md 不存在`);
} else {
  const prefixes = [...Object.values(schema.ID_PREFIXES), schema.SOURCE_PREFIX];
  for (const prefix of prefixes) {
    if (!idsText.includes(prefix)) {
      problems.push(`[${CONSISTENCY_CODES.CODE_NOT_DOCUMENTED}] ID 前缀 ${prefix} 没有出现在 schema/ids.md`);
    }
  }
}

// ── 4. 模板必须真的包含它的必填字段与必填章节 ───────────────────────────────
for (const type of schema.ASSET_TYPES) {
  const template = read(`schema/asset-types/${type}.md`);
  if (template === null) {
    problems.push(`[${CONSISTENCY_CODES.TEMPLATE_INCOMPLETE}] schema/asset-types/${type}.md 不存在`);
    continue;
  }
  for (const field of [...schema.REQUIRED_FIELDS[type], ...schema.ASSET_FIELDS]) {
    if (!template.includes(field)) {
      problems.push(
        `[${CONSISTENCY_CODES.TEMPLATE_INCOMPLETE}] ${type} 的模板没有提到字段 ${field}——` +
          `照着模板写的人会漏掉它，而闸门会在他们提交时才报错`,
      );
    }
  }
  for (const section of schema.REQUIRED_SECTIONS[type]) {
    if (!template.includes(section)) {
      problems.push(
        `[${CONSISTENCY_CODES.TEMPLATE_INCOMPLETE}] ${type} 的模板没有出现必填章节「${section}」`,
      );
    }
  }
}

// ── 5. 闸门自己的码必须出现在 docs/handbook/gates.md ────────────────────────
const handbook = read("docs/handbook/gates.md");
if (handbook === null) {
  problems.push(`[${CONSISTENCY_CODES.GATE_CODE_NOT_DOCUMENTED}] docs/handbook/gates.md 不存在`);
} else {
  // 码从**源码文本**里抽，而不是让每个闸门模块导出一张码表：
  // 导出表会和实际抛出的码漂移（加了抛出忘了加表），而源码里的字面量不会。
  //
  // 位数**一到两位**（ADR-0033）：`\d` 只认一位，于是 E10/E11 这类码根本不会被看到——
  // 而"看不到"的后果是静默的：它不报错，只是少查几个码，于是"文档是齐的"这句话
  // 又变回了一句人话。不写成 `\d+` 是因为**位数本身是一条约定**：
  // 码是 `[A-G]<数字>_…`，两位是给 E10–E99 留的位置，而 `\d+` 会在某天
  // 把一段无关的字符串（`E12345678_x`）也认成码。
  const sources = [
    "scripts/gates/lib/policy.mjs",
    "scripts/gates/lib/harness.mjs",
    "scripts/gates/agent-guard.mjs",
    // eval 阈值闸门的码住在 `evals/runner/gate.ts`（判定与宿主分离，理由见那里）。
    // 这里扫的是**判定实际所在的那份文件**，不是薄壳——薄壳里没有码可扫。
    "evals/runner/gate.ts",
  ];
  const found = new Set(Object.values(CONSISTENCY_CODES));
  for (const file of sources) {
    const text = read(file);
    if (text === null) {
      problems.push(`[${CONSISTENCY_CODES.GATE_CODE_NOT_DOCUMENTED}] 找不到 ${file}`);
      continue;
    }
    for (const match of text.matchAll(/["']([A-G]\d{1,2}_[A-Z0-9_]+)["']/g)) {
      const code = match[1];
      if (code !== undefined) found.add(code);
    }
  }
  for (const code of [...found].sort()) {
    if (!handbook.includes(code)) {
      problems.push(
        `[${CONSISTENCY_CODES.GATE_CODE_NOT_DOCUMENTED}] 闸门码 ${code} 没有出现在 docs/handbook/gates.md——` +
          `检查者无人审查，就会变成下一个"看起来在保护你"的东西`,
      );
    }
  }
}

if (problems.length === 0) {
  ok("✓ [consistency] schema/ 与 packages/schema 一致（分类法、码表、前缀、模板）");
  process.exit(0);
}

fail(`\n✗ [consistency] ${problems.length} 处漂移：\n`);
for (const problem of problems) fail(`  ${problem}`);
fail("\n  两边都要改：只改代码或只改文档都会让下一次检查更吵。\n");
process.exit(1);
