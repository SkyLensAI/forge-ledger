/**
 * 投影目录的磁盘状态 —— IO 那一侧。
 *
 * 判定"哪些文件是生成器写的、哪些是上一轮的残留"的逻辑在
 * `@forge/core/src/projection.ts`（纯函数）；这里只负责把它落到磁盘上。
 *
 * 为什么值得单独一个模块：`forge bootstrap`、`forge listing --check`、
 * `forge demo --check` 与 `evals/runner/phase8.ts` 都要回答同一个问题——
 * **磁盘上的产物与库算出来的是不是同一份**。四处各写一遍 `readFileSync` +
 * 路径拼接，结局是某一天其中一处忘了检查残留文件，而另外三处还在绿。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PROJECTION_MANIFEST,
  generatedPathsOf,
  stalePaths,
  type EmittedFile,
} from "@forge/core";

export interface ProjectionDiskState {
  /** 目录根本不存在。 */
  missing: boolean;
  /** 内容不一致、缺失、或是上一轮残留的文件路径。 */
  drifted: string[];
}

/**
 * 读一个投影目录里的清单。
 *
 * 读不懂（没有清单、JSON 坏、形状可疑）返回 `null`——
 * 调用方因此**不会**删除任何文件。这是安全方向：宁可留下残留，也不误删。
 *
 * @param {string} dir
 * @returns {string[] | null}
 */
export function readProjectionManifest(dir: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, PROJECTION_MANIFEST), "utf8"));
    return generatedPathsOf(parsed);
  } catch {
    return null;
  }
}

/**
 * 比较一份生成结果与磁盘上的目录。
 *
 * @param {string} dir
 * @param {EmittedFile[]} files
 * @returns {ProjectionDiskState}
 */
export function inspectProjection(dir: string, files: EmittedFile[]): ProjectionDiskState {
  if (!existsSync(dir)) return { missing: true, drifted: [] };

  const drifted: string[] = [];
  for (const file of files) {
    const target = join(dir, file.path);
    if (!existsSync(target)) {
      drifted.push(file.path);
      continue;
    }
    try {
      if (readFileSync(target, "utf8") !== file.content) drifted.push(file.path);
    } catch {
      drifted.push(file.path);
    }
  }
  for (const path of stalePaths(readProjectionManifest(dir), files)) {
    drifted.push(`${path}（上一轮产物）`);
  }
  return { missing: false, drifted };
}
