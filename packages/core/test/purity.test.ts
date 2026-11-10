/**
 * R5 的执行体：`packages/core` 是**零 IO、纯函数**。
 *
 * 这条规则以前只有评审与局部探针（`evals/runner/conflict.ts` 只扫了
 * `conflict.ts` / `link.ts` 两个文件）。局部探针的缺口是安静的：新文件里
 * 加一个 `Date.now()` 或 `readFileSync`，那条探针不会看它。
 *
 * 这里扫的是 `packages/core/src` 的**每一个** `.ts` 文件。判据故意宽：
 *   1. 不许 import 任何做 IO / 环境读取的 Node 模块；
 *   2. 不许读时钟、造随机数、定时器；
 *   3. 不许 `console` / `process` / `fetch` / `require`。
 *
 * 允许 `node:crypto` 的 `createHash`（审计链要它），但**不许**要随机数：
 * 随机是输入，由调用方在边界上注入（见 `mintAssetId` / `promote` 的注释）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "packages", "core", "src");

function sourceFiles(): string[] {
  return readdirSync(SRC)
    .filter((name) => name.endsWith(".ts"))
    .sort();
}

/**
 * 注释里可以**讨论** `Date.now()`（`health.ts` 就写着"core 里没有它"）。
 * 判据只看代码，不看注释——否则一条解释会被当成一次违规。
 *
 * 这段剥离不追求完整词法分析：块注释 + 行注释足够覆盖本仓库的写法，
 * 而字符串里的 `//` 由 `[^:]` 这个前缀排除掉 `https://`。
 */
function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const FORBIDDEN_IMPORTS = [
  "fs",
  "fs/promises",
  "http",
  "https",
  "net",
  "dgram",
  "child_process",
  "worker_threads",
  "os",
  "path",
  "process",
  "readline",
  "stream",
  "timers",
  "timers/promises",
  "perf_hooks",
  "inspector",
  "v8",
  "vm",
];

const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /\bDate\.now\s*\(/, why: "时钟必须是输入（`today` / `atMs`），core 里不能读它" },
  { pattern: /\bnew\s+Date\s*\(/, why: "时钟必须是输入（`today` / `atMs`），core 里不能读它" },
  { pattern: /\bMath\.random\s*\(/, why: "随机必须是输入（`random` / ULID 后缀），core 里不能造它" },
  { pattern: /\bperformance\.now\s*\(/, why: "时钟必须是输入，core 里不能读它" },
  { pattern: /\b(?:setTimeout|setInterval|setImmediate)\s*\(/, why: "定时器是副作用，不属于纯函数" },
  { pattern: /\bconsole\./, why: "打印是 IO；宿主负责输出" },
  { pattern: /\bprocess\./, why: "读环境/退出码是宿主的职责" },
  { pattern: /\bfetch\s*\(/, why: "网络是 IO，必须住在边缘" },
  { pattern: /\brequire\s*\(/, why: "core 是 ESM；`require` 是另一套加载路径" },
  { pattern: /\brandomBytes\s*\(|\brandomUUID\s*\(|\bgetRandomValues\s*\(/, why: "随机必须由调用方注入" },
];

test("R5：packages/core 的每个源文件都不做 IO、不读时钟、不造随机", () => {
  const files = sourceFiles();
  assert.ok(files.length > 0, "packages/core/src 里应该有源文件");

  const problems: string[] = [];
  for (const file of files) {
    const text = codeOnly(readFileSync(join(SRC, file), "utf8"));

    for (const name of FORBIDDEN_IMPORTS) {
      const pattern = new RegExp(`\\bfrom\\s+["'](?:node:)?${name.replace("/", "\\/")}["']`);
      if (pattern.test(text)) {
        problems.push(`${file}：不能 import ${name}（零 IO，R5）`);
      }
    }

    for (const { pattern, why } of FORBIDDEN_PATTERNS) {
      const match = pattern.exec(text);
      if (match !== null) {
        problems.push(`${file}：出现 \`${match[0]}\` —— ${why}`);
      }
    }
  }

  assert.deepEqual(problems, [], problems.join("\n"));
});

test("R5：core 的哈希是纯的——只允许 node:crypto 的 createHash，不允许随机", () => {
  const audit = readFileSync(join(SRC, "audit.ts"), "utf8");
  assert.match(audit, /import\s+\{\s*createHash\s*\}\s+from\s+"node:crypto"/);
  assert.doesNotMatch(audit, /randomBytes|randomUUID|getRandomValues/);
});
