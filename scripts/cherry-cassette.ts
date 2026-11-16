#!/usr/bin/env node
/**
 * 为 Cherry Studio 会话生成一份**确定性录像**。
 *
 * 这个脚本不发明判定：它调用评测里已经在用的 `baseline-lexical` 抽取器，
 * 把它的产出包装成模型响应的 JSON 形状，再用 `requestDigest` 记下"这是对哪次请求的回答"。
 * 之后 `forge extract --cassette` 走的是**和真实模型完全相同**的一条路：
 * 解析 → sanitize → 入库守卫 → `_inbox/`。
 *
 * 也就是说：词法基线的产出在这里仍然只是**候选**，不会直接进 `assets/`。
 * 这不是绕开信任边界，而是让"没有 API key"也能把候选区填上。
 *
 * 用法：
 *   pnpm tsx scripts/cherry-cassette.ts --vault data --out data/imports/cherry.cassette.json
 *   pnpm tsx scripts/cherry-cassette.ts --vault data --source src_… --out …
 *
 * --source 可以重复，只给这些来源生成录像；不给则为库里的全部来源生成。
 * 给了却找不到来源必须报错——拼错的来源 ID 不能静默变成"0 条录像"。
 */
import { resolve } from "node:path";
import { EXTRACTION_HARNESS, buildExtractionRequest } from "../packages/core/src/index.ts";
import { CASSETTE_VERSION, openVault, requestDigest, writeCassette } from "../packages/store/src/index.ts";
import { baselineExtractor } from "../evals/extractors/baseline.ts";

function valueOf(argv: string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}

function valuesOf(argv: string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== flag) continue;
    const next = argv[index + 1];
    if (next === undefined) throw new Error(`选项 ${flag} 缺少值`);
    values.push(next);
  }
  return values;
}

const argv = process.argv.slice(2);
const vaultPath = valueOf(argv, "--vault") ?? "data";
const outPath = valueOf(argv, "--out");
const sourceFilter = new Set(valuesOf(argv, "--source"));
if (outPath === null) {
  process.stderr.write("✗ 必须给 --out <文件>：录像写哪儿是个决定，不该有默认值。\n");
  process.exit(2);
}

const vault = openVault(resolve(vaultPath));
const allInputs = vault.inputs();
if (allInputs.length === 0) {
  process.stderr.write("✗ 库里没有事件：先 forge compile --import <导出文件>。\n");
  process.exit(1);
}
if (sourceFilter.size > 0) {
  const known = new Set(allInputs.map((input) => input.sourceId));
  const missing = [...sourceFilter].filter((id) => !known.has(id)).sort();
  if (missing.length > 0) {
    process.stderr.write(`✗ 库里没有这些来源：${missing.join(", ")}\n`);
    process.exit(1);
  }
}
const inputs = allInputs.filter((input) => sourceFilter.size === 0 || sourceFilter.has(input.sourceId));

const records = inputs.map((input) => {
  const candidates = baselineExtractor.extract(input);
  const assertions = candidates.map((candidate) => ({
    type: candidate.type,
    title: candidate.title,
    subject: candidate.subject,
    body: candidate.body,
    sources: candidate.sources,
    confidence: candidate.confidence,
  }));
  return {
    request_digest: requestDigest(buildExtractionRequest(input)),
    response: JSON.stringify({ assertions }),
  };
});

const cassette = {
  cassette_version: CASSETTE_VERSION,
  // 没有时间戳：录像也是产出，两次生成必须得到同样的字节（R6）。
  about: "由 forge-cherry-cassette 生成的词法基线录像（确定性、零网络）",
  model: baselineExtractor.id,
  harness: EXTRACTION_HARNESS,
  records,
};

writeCassette(resolve(outPath), cassette);
process.stdout.write(
  `✓ 已生成 ${String(records.length)} 段回放响应 → ${resolve(outPath)}` +
    `（抽取器 ${baselineExtractor.id}，harness=${EXTRACTION_HARNESS}）\n`,
);
