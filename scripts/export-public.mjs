// @ts-check
/**
 * 把私有仓库里的「账本格式规范」导出成一个可独立发布、可独立校验的公开仓库。
 *
 * 为什么是**白名单导出**而不是 .gitignore 减法：
 *   公开仓与本仓的关系不是「同一个仓库少几个文件」，而是「本仓是上游，公开仓是产物」。
 *   减法会漏（新增目录默认公开），白名单不会。
 *
 * 三条纪律：
 *   1. 只复制 manifest 里列出的路径；输出里的每个路径再按 forbidden_paths 判一遍。
 *   2. 文本一律按 LF + 末尾换行写出（R6：逐字节确定）。
 *   3. 导出后扫描 forbidden_text；命中即失败，不静默通过。
 *
 * 用法：
 *   node scripts/export-public.mjs                  # 导出到 dist/forge-spec
 *   node scripts/export-public.mjs --out ../spec    # 指定输出目录
 *   node scripts/export-public.mjs --check          # 只校验导出物是否与当前源一致
 *   node scripts/export-public.mjs --force          # 覆盖非空输出目录
 */
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const MANIFEST_PATH = join(REPO_ROOT, "public-export.json");
const TEXT_EXTENSIONS = new Set([".md", ".mjs", ".js", ".json", ".yaml", ".yml", ".txt"]);

/**
 * @typedef {{ from: string, to: string }} Entry
 * @typedef {{ find?: string, regex?: string, replace: string }} SanitizeItem
 * @typedef {{
 *   name: string,
 *   description?: string,
 *   default_out: string,
 *   entries: Entry[],
 *   sanitize?: SanitizeItem[],
 *   forbidden_paths?: string[],
 *   forbidden_text?: string[]
 * }} Manifest
 */

const usage = `用法：
  node scripts/export-public.mjs [--out <dir>] [--check] [--force]

  --out <dir>   输出目录（默认取 public-export.json 的 default_out）
  --check       不写盘，只验证现有导出物与当前源逐字节一致
  --force       允许覆盖非空输出目录`;

/**
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareStrings(a, b) {
  // 不用 localeCompare：它的结果依赖本机 locale，会破坏逐字节确定（R6）。
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  process.stderr.write(`✗ ${message}\n`);
  process.exit(1);
}

/**
 * @param {string} message
 */
function info(message) {
  process.stdout.write(`${message}\n`);
}

/**
 * @param {string} path
 * @returns {string}
 */
function toPosix(path) {
  return path.split("\\").join("/");
}

/**
 * @param {string} dir
 * @returns {string[]}
 */
function walk(dir) {
  /** @type {string[]} */
  const files = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) files.push(...walk(full));
    else if (stat.isFile()) files.push(full);
  }
  return files.sort(compareStrings);
}

/**
 * @param {string} path
 * @returns {string}
 */
function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * @param {string} text
 * @param {SanitizeItem} item
 * @returns {string}
 */
function applySanitize(text, item) {
  if (item.find !== undefined) {
    if (text === "") return text;
    return text.split(item.find).join(item.replace);
  }
  if (item.regex !== undefined) {
    return text.replace(new RegExp(item.regex, "g"), item.replace);
  }
  return fail("public-export.json 的 sanitize 条目必须带 find 或 regex");
}

/**
 * @param {string} dir
 * @returns {void}
 */
function removeDir(dir) {
  // Windows 上目录刚被另一个进程读过时，rm 可能短暂 EPERM；重试即可。
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

/**
 * @param {string} dir
 * @returns {void}
 */
function clearDir(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) removeDir(join(dir, name));
}

/**
 * @param {Manifest} manifest
 * @param {string} relativePath
 * @returns {string}
 */
function assertAllowedOutputPath(manifest, relativePath) {
  const normalized = toPosix(relativePath);
  if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
    return fail(`输出路径越界：${relativePath}`);
  }
  for (const forbidden of manifest.forbidden_paths ?? []) {
    const prefix = forbidden.endsWith("/") ? forbidden : `${forbidden}/`;
    if (normalized === forbidden || normalized.startsWith(prefix)) {
      return fail(`输出路径命中 forbidden_paths：${normalized}（规则：${forbidden}）`);
    }
  }
  return normalized;
}

/**
 * @param {Manifest} manifest
 * @param {string} from
 * @param {string} to
 * @returns {void}
 */
function copyFile(manifest, from, to) {
  mkdirSync(dirname(to), { recursive: true });
  const ext = extname(from).toLowerCase();
  if (!TEXT_EXTENSIONS.has(ext)) {
    writeFileSync(to, readFileSync(from));
    return;
  }

  let text = readFileSync(from, "utf8").replace(/\r\n?/g, "\n");
  for (const item of manifest.sanitize ?? []) text = applySanitize(text, item);

  const sourceLabel = toPosix(relative(REPO_ROOT, from));
  for (const pattern of manifest.forbidden_text ?? []) {
    if (text.includes(pattern)) {
      fail(`${sourceLabel} 仍然包含禁止出现的文本：${pattern}（先补一条 sanitize 规则）`);
    }
  }

  if (!text.endsWith("\n")) text += "\n";
  writeFileSync(to, text, "utf8");
}

/**
 * @param {Manifest} manifest
 * @param {Entry} entry
 * @param {string} targetRoot
 * @returns {void}
 */
function copyEntry(manifest, entry, targetRoot) {
  const from = resolve(REPO_ROOT, entry.from);
  if (!existsSync(from)) fail(`manifest 里的源路径不存在：${entry.from}`);

  assertAllowedOutputPath(manifest, entry.to);
  const to = resolve(targetRoot, entry.to);
  const stat = statSync(from);

  if (stat.isDirectory()) {
    const files = walk(from);
    if (files.length === 0) fail(`manifest 里的目录是空的：${entry.from}`);
    for (const file of files) {
      const relativeFile = relative(from, file);
      const outputRelative = toPosix(join(entry.to, relativeFile));
      assertAllowedOutputPath(manifest, outputRelative);
      copyFile(manifest, file, join(targetRoot, outputRelative));
    }
    return;
  }

  copyFile(manifest, from, to);
}

/**
 * @param {string} root
 * @returns {Map<string, string>}
 */
function hashMap(root) {
  /** @type {Map<string, string>} */
  const result = new Map();
  if (!existsSync(root)) return result;
  for (const file of walk(root)) {
    result.set(toPosix(relative(root, file)), sha256(file));
  }
  return result;
}

/**
 * @param {string} expectedRoot
 * @param {string} actualRoot
 * @returns {boolean}
 */
function compareTrees(expectedRoot, actualRoot) {
  const expected = hashMap(expectedRoot);
  const actual = hashMap(actualRoot);
  const paths = [...new Set([...expected.keys(), ...actual.keys()])].sort(compareStrings);
  let ok = true;

  for (const path of paths) {
    const a = expected.get(path);
    const b = actual.get(path);
    if (a === undefined) {
      info(`  + 导出物多出：${path}`);
      ok = false;
    } else if (b === undefined) {
      info(`  - 导出物缺少：${path}`);
      ok = false;
    } else if (a !== b) {
      info(`  ~ 内容不同：${path}`);
      ok = false;
    }
  }
  return ok;
}

/**
 * @param {string} targetRoot
 * @returns {void}
 */
function writeChecksumManifest(targetRoot) {
  const files = walk(targetRoot)
    .map((file) => toPosix(relative(targetRoot, file)))
    .filter((path) => path !== "MANIFEST.sha256")
    .sort(compareStrings);
  const lines = files.map((path) => `${sha256(join(targetRoot, path))}  ${path}`);
  writeFileSync(join(targetRoot, "MANIFEST.sha256"), `${lines.join("\n")}\n`, "utf8");
}

/**
 * @param {string[]} args
 * @returns {{ out: string | null, check: boolean, force: boolean }}
 */
function parseFlags(args) {
  /** @type {{ out: string | null, check: boolean, force: boolean }} */
  const flags = { out: null, check: false, force: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === "--help" || arg === "-h") {
      info(usage);
      process.exit(0);
    } else if (arg === "--check") {
      flags.check = true;
    } else if (arg === "--force") {
      flags.force = true;
    } else if (arg === "--out") {
      const value = args[index + 1];
      if (value === undefined) fail("--out 后面需要一个目录");
      flags.out = value;
      index += 1;
    } else if (arg.startsWith("--out=")) {
      flags.out = arg.slice("--out=".length);
    } else {
      fail(`不认识的参数：${arg}\n\n${usage}`);
    }
  }
  return flags;
}

const flags = parseFlags(process.argv.slice(2));
const manifest = /** @type {Manifest} */ (JSON.parse(readFileSync(MANIFEST_PATH, "utf8")));
const outDir = resolve(REPO_ROOT, flags.out ?? manifest.default_out);
const tempDir = `${outDir}.tmp`;

removeDir(tempDir);
mkdirSync(tempDir, { recursive: true });

for (const entry of manifest.entries) copyEntry(manifest, entry, tempDir);
writeChecksumManifest(tempDir);

if (flags.check) {
  if (!existsSync(outDir)) fail(`--check 找不到导出目录：${toPosix(relative(REPO_ROOT, outDir))}`);
  const ok = compareTrees(outDir, tempDir);
  removeDir(tempDir);
  if (!ok) fail("导出物与当前源不一致；先运行不带 --check 的导出");
  info(`✓ 导出物逐字节一致：${toPosix(relative(REPO_ROOT, outDir))}`);
  process.exit(0);
}

if (existsSync(outDir)) {
  const entries = readdirSync(outDir);
  if (entries.length > 0 && !flags.force) {
    fail(`输出目录非空：${toPosix(relative(REPO_ROOT, outDir))}（确认可覆盖后加 --force）`);
  }
  clearDir(outDir);
} else {
  mkdirSync(outDir, { recursive: true });
}

// 不删除 outDir 本身：Windows 上它可能正好是另一个进程的 CWD，rmdir 会 EPERM。
// 清空内容再复制，结果相同，而且不会因为"目录被占用"失败。
cpSync(tempDir, outDir, { recursive: true });
removeDir(tempDir);

const files = hashMap(outDir);
info(`✓ 已导出 ${manifest.name} → ${toPosix(relative(REPO_ROOT, outDir))}`);
info(`  文件数：${String(files.size)}（含 MANIFEST.sha256）`);
info("  下一步（由人执行）：");
info("    git init <out> && git add -A && git commit -m \"spec: v1 public release\"");
info("    gh repo create <org>/forge-spec --public --source=<out> --remote=origin --push");
