/**
 * `sources/` 层 —— **只读、只追加**。
 *
 * 这是整个系统里唯一"不能重算"的东西，所以它受到的约束最硬：
 * 写一次就定终身，而且**没有修改 API**。不是"不要修改"的约定，
 * 是这里根本没有那个函数——R8 说的"信任边界写进代码"就是这种形态。
 *
 * 为什么 ID 是内容寻址的（ADR-0013）：
 *   1. 同一份导出重复导入不产生第二份来源（幂等），否则事件会翻倍；
 *   2. 两次运行给出同一个 `src_`，于是 `src://` 引用和由它派生的事件 ID 都稳定；
 *   3. 内容变了 ID 就变了——"来源被悄悄改过"从不可判定变成不可能。
 */
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { SourceConnector } from "@forge/ingest";
import { contentAddressedId } from "@forge/schema";
import type { VaultPaths } from "./paths.ts";
import { readTextIfExists, stableJson, writeOnce } from "./paths.ts";

export interface SourceMeta {
  id: string;
  connector: string;
  media_type: string;
  sha256: string;
  bytes: number;
  original_name: string;
}

export interface ImportedSource {
  meta: SourceMeta;
  /** false = 这份字节已经在库里了（幂等命中，不是失败）。 */
  created: boolean;
}

export interface SourceRecord {
  meta: SourceMeta;
  text: string;
}

export interface SourceLayer {
  import(text: string, options: { connector: SourceConnector; originalName: string }): ImportedSource;
  list(): SourceMeta[];
  read(id: string): SourceRecord | null;
}

const RAW_FILE = "raw";
const META_FILE = "meta.json";

/**
 * @param {VaultPaths} paths
 * @returns {SourceLayer}
 */
export function openSourceLayer(paths: VaultPaths): SourceLayer {
  return {
    import(text, options) {
      const digest = sha256(text);
      const id = contentAddressedId("src_", text);
      const dir = join(paths.sources, id);
      const meta: SourceMeta = {
        id,
        connector: options.connector.id,
        media_type: options.connector.mediaType,
        sha256: digest,
        bytes: Buffer.byteLength(text, "utf8"),
        original_name: options.originalName,
      };

      const existed = readTextIfExists(join(dir, META_FILE)) !== null;
      if (existed) {
        const existing = readMeta(dir);
        if (existing === null || existing.sha256 !== digest) {
          // 内容寻址下这不可达；真发生了说明目录被外部动过。
          // 宁可炸掉也不要"顺手覆盖"——覆盖来源层是本系统最不可逆的动作。
          throw new Error(
            `来源 ${id} 已存在但内容对不上（meta.sha256 与当前字节不一致）。` +
              `sources/ 是只读层：请把它当作事故处理，不要覆盖。`,
          );
        }
        return { meta: existing, created: false };
      }

      writeOnce(join(dir, RAW_FILE), text);
      writeOnce(join(dir, META_FILE), stableJson(meta));
      return { meta, created: true };
    },

    list() {
      const metas: SourceMeta[] = [];
      for (const entry of listDirs(paths.sources)) {
        const meta = readMeta(join(paths.sources, entry));
        if (meta !== null) metas.push(meta);
      }
      // 按 ID 排序而不是 readdir 顺序：ID 是内容寻址的，排序不依赖任何隐式状态。
      return metas.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    },

    read(id) {
      const dir = join(paths.sources, id);
      const meta = readMeta(dir);
      const text = readTextIfExists(join(dir, RAW_FILE));
      if (meta === null || text === null) return null;
      return { meta, text };
    },
  };
}

/**
 * @param {string} text
 * @returns {string}
 */
export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * @param {string} dir
 * @returns {SourceMeta | null}
 */
function readMeta(dir: string): SourceMeta | null {
  const raw = readTextIfExists(join(dir, META_FILE));
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record["id"] !== "string" || typeof record["sha256"] !== "string") return null;
    return {
      id: record["id"],
      connector: typeof record["connector"] === "string" ? record["connector"] : "",
      media_type: typeof record["media_type"] === "string" ? record["media_type"] : "",
      sha256: record["sha256"],
      bytes: typeof record["bytes"] === "number" ? record["bytes"] : 0,
      original_name: typeof record["original_name"] === "string" ? record["original_name"] : "",
    };
  } catch {
    return null;
  }
}

/**
 * @param {string} dir
 * @returns {string[]}
 */
function listDirs(dir: string): string[] {
  // 只列目录：`sources/` 下不允许有散落文件，有也不该被当成来源。
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}
