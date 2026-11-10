/**
 * 投影清单 —— 让"这一目录里哪些文件是生成器写的"变成一份可读的合同。
 *
 * 为什么需要它：`forge listing` / `forge demo` 都是**投影**，每次生成的文件集合
 * 可能随库变化（比如少了一条 ADR，`references/` 就少一个文件）。如果生成器只覆盖
 * 新文件、不清理旧文件，目录里会积累一批**不再对应任何资产**的页面。
 *
 * 这类残留很隐蔽：所有"期望的文件都在"的检查都会绿，而目录里多出来的那些
 * 不再被任何东西引用——直到有人点开一个已经不存在的决策。
 *
 * 但生成器也**不能**直接删掉目录里所有不认识的文件：`CNAME`、`LICENSE` 之类
 * 是人的东西。所以这里写一份清单，下一次生成时只清理**上一份清单里列过、
 * 而这一份没有**的文件。删除范围因此是明确的、可审计的。
 */
import type { EmittedFile } from "./emit.ts";
import { stableJson } from "./json.ts";

/** 投影清单的文件名。它是每个生成目录里的固定成员。 */
export const PROJECTION_MANIFEST = ".forge-manifest.json";

/** 清单自身的版本。它跟着清单形状走，不跟资产 schema 走。 */
export const PROJECTION_MANIFEST_VERSION = 1;

/**
 * 给一组产物加上清单，并按路径排序。
 *
 * 清单把**它自己**也列进去：这样"上一轮生成了哪些文件"是一个完整的集合，
 * 清理时不需要对清单文件做特例。
 *
 * @param {string} generator
 * @param {EmittedFile[]} files
 * @returns {EmittedFile[]}
 */
export function withProjectionManifest(generator: string, files: EmittedFile[]): EmittedFile[] {
  const ordered = [...files].sort(comparePath);
  const paths = [...ordered.map((file) => file.path), PROJECTION_MANIFEST].sort();
  const manifest: EmittedFile = {
    path: PROJECTION_MANIFEST,
    content: stableJson({
      schema_version: PROJECTION_MANIFEST_VERSION,
      generator,
      files: paths,
    }),
  };
  return [...ordered, manifest].sort(comparePath);
}

/**
 * 从清单的解析结果里取文件路径。
 *
 * **任何可疑形状都返回 `null`**（而不是尽量恢复）：这份清单的唯一用途是
 * 决定"哪些旧文件可以删"。一个读错一半的清单会导致删掉不该删的文件，
 * 所以这里选择"读不懂就不删"。
 *
 * @param {unknown} manifest
 * @returns {string[] | null}
 */
export function generatedPathsOf(manifest: unknown): string[] | null {
  if (typeof manifest !== "object" || manifest === null) return null;
  const raw = (manifest as Record<string, unknown>)["files"];
  if (!Array.isArray(raw)) return null;
  const paths: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !isSafeRelativePath(item)) return null;
    paths.push(item);
  }
  return paths;
}

/**
 * 上一份清单里有、这一份没有的路径。
 *
 * @param {string[] | null} previous
 * @param {EmittedFile[]} files
 * @returns {string[]}
 */
export function stalePaths(previous: string[] | null, files: EmittedFile[]): string[] {
  if (previous === null) return [];
  const next = new Set(files.map((file) => file.path));
  return previous.filter((path) => !next.has(path)).sort();
}

/**
 * 只接受相对、无空段、无反斜杠的路径。
 *
 * @param {string} path
 * @returns {boolean}
 */
function isSafeRelativePath(path: string): boolean {
  if (path.length === 0 || path.startsWith("/") || path.includes("\\")) return false;
  return path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

/**
 * @param {EmittedFile} a
 * @param {EmittedFile} b
 * @returns {number}
 */
function comparePath(a: EmittedFile, b: EmittedFile): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}
