/**
 * `index/` 层 —— **派生数据，删掉能重建**。
 *
 * 判据是"删掉它会不会丢东西"。这里存的全部是能从 sources + assets 重新算出来的：
 * 事件 IR 的条数、资产清单、来源指纹。所以 `forge compile` 对 index 层的动作是
 * **重建**，不是"迁移"或"修复"——后两个词意味着它里面有不可再生的东西。
 *
 * 为什么用 SQLite（`node:sqlite`，Node 24 内置）：
 *   - 零依赖。ADR-0011 已经为 zod / yaml 背了两个依赖，索引层不该再背第三个；
 *   - 它是**文件**，不是服务。本地优先要求没有后台进程也要能跑；
 *   - 删掉一个文件就回到"未索引"状态，重建是重新导入而不是恢复备份。
 *
 * 已知缺口（不假装没有）：这个索引用不上向量检索。检索与注入是 Phase 6（S21），
 * 到那时索引层会多出一张表或一个旁路文件——那是一次显式决策，不是现在预埋的空表。
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eventId, type AssetDoc, type EventIR } from "@forge/schema";
import type { VaultPaths } from "./paths.ts";
import { readTextIfExists, stableJson } from "./paths.ts";
import type { SourceMeta } from "./sources.ts";

const DB_FILE = "forge.sqlite";
const INDEX_MD = "INDEX.md";

/** 索引 schema 的版本。表结构变了就 +1，读取时对不上就整层重建（派生数据没有迁移的必要）。 */
export const INDEX_FORMAT_VERSION = 1;

export interface IndexLayer {
  /** 删除并重建。**这是唯一的写入方式**——没有"更新某一行"的 API。 */
  rebuild(input: { sources: SourceMeta[]; events: EventIR[]; assets: AssetDoc[] }): void;
  counts(): { sources: number; events: number; assets: number } | null;
  /** 索引里记着的资产 ID（排序过）。健康检查拿它和 `assets/` 对账。 */
  assetIds(): string[];
  /** 按来源列出事件键。 */
  eventKeysOf(sourceId: string): string[];
}

/**
 * @param {VaultPaths} paths
 * @returns {IndexLayer}
 */
export function openIndexLayer(paths: VaultPaths): IndexLayer {
  return {
    rebuild(input) {
      mkdirSync(paths.index, { recursive: true });
      const dbPath = join(paths.index, DB_FILE);
      rmSync(dbPath, { force: true });
      // -journal 是 SQLite 的中间产物；留着会让"删掉就重建"多一个隐式状态。
      rmSync(`${dbPath}-journal`, { force: true });

      const db = new DatabaseSync(dbPath);
      try {
        db.exec(`
          CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE sources (id TEXT PRIMARY KEY, connector TEXT NOT NULL, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL);
          CREATE TABLE events (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, key TEXT NOT NULL);
          CREATE TABLE assets (id TEXT PRIMARY KEY, type TEXT NOT NULL, path TEXT NOT NULL);
        `);
        db.prepare("INSERT INTO meta VALUES (?, ?)").run("format_version", String(INDEX_FORMAT_VERSION));

        const insertSource = db.prepare("INSERT INTO sources VALUES (?, ?, ?, ?)");
        for (const meta of input.sources) {
          insertSource.run(meta.id, meta.connector, meta.sha256, meta.bytes);
        }
        const insertEvent = db.prepare("INSERT INTO events VALUES (?, ?, ?)");
        for (const event of input.events) {
          // 主键用内容寻址 ID（ADR-0013）而不是 `source#key` 字符串拼接：
          // 将来检索层要跨来源引用"这一条事件"，需要一个不依赖拼接规则的稳定标识。
          insertEvent.run(eventId(event), event.source_id, event.key);
        }
        const insertAsset = db.prepare("INSERT INTO assets VALUES (?, ?, ?)");
        for (const asset of input.assets) {
          insertAsset.run(asset.frontMatter.id, asset.frontMatter.type, asset.path);
        }
      } finally {
        db.close();
      }
    },

    counts() {
      const db = openIfCurrent(paths);
      if (db === null) return null;
      try {
        return {
          sources: count(db, "sources"),
          events: count(db, "events"),
          assets: count(db, "assets"),
        };
      } finally {
        db.close();
      }
    },

    assetIds() {
      const db = openIfCurrent(paths);
      if (db === null) return [];
      try {
        const rows = db.prepare("SELECT id FROM assets ORDER BY id").all();
        return rows.map((row) => String((row as { id: unknown }).id));
      } finally {
        db.close();
      }
    },

    eventKeysOf(sourceId) {
      const db = openIfCurrent(paths);
      if (db === null) return [];
      try {
        const rows = db.prepare("SELECT key FROM events WHERE source_id = ? ORDER BY key").all(sourceId);
        return rows.map((row) => String((row as { key: unknown }).key));
      } finally {
        db.close();
      }
    },
  };
}

/**
 * `INDEX.md` 的**落盘位置在 index 层**（directory.md §八.3 要求每次操作以更新 INDEX.md 收尾）。
 * 它由 emit 生成内容，但住在派生层——放错层会让"删掉 index 能重建"这句话不成立。
 *
 * 覆盖写而不是只写一次：它是**投影**，投影的正确内容就是"当前库的样子"。
 *
 * @param {VaultPaths} paths
 * @param {string} content
 * @returns {void}
 */
export function writeIndexMarkdown(paths: VaultPaths, content: string): void {
  mkdirSync(paths.index, { recursive: true });
  writeFileSync(join(paths.index, INDEX_MD), content, "utf8");
}

/**
 * 读回 `INDEX.md`。不存在时返回 null——**"文件不在"与"内容为空"是两件事**：
 * 健康检查对前者的修法是"跑一次 compile"，对后者是"有人在它上面动过手"。
 *
 * @param {VaultPaths} paths
 * @returns {string | null}
 */
export function readIndexMarkdown(paths: VaultPaths): string | null {
  return readTextIfExists(join(paths.index, INDEX_MD));
}

/**
 * @param {VaultPaths} paths
 * @param {string} name
 * @returns {string}
 */
export function snapshotPath(paths: VaultPaths, name: string): string {
  return join(paths.index, `${name}.json`);
}

/**
 * @param {VaultPaths} paths
 * @param {string} name
 * @param {unknown} value
 * @returns {void}
 */
export function writeSnapshot(paths: VaultPaths, name: string, value: unknown): void {
  mkdirSync(paths.index, { recursive: true });
  writeFileSync(snapshotPath(paths, name), stableJson(value), "utf8");
}

/**
 * @param {VaultPaths} paths
 * @returns {DatabaseSync | null} 不存在或版本对不上时返回 null（调用方负责重建）
 */
function openIfCurrent(paths: VaultPaths): DatabaseSync | null {
  const dbPath = join(paths.index, DB_FILE);
  if (!existsSync(dbPath)) return null;
  const db = new DatabaseSync(dbPath);
  const row = db.prepare("SELECT value FROM meta WHERE key = 'format_version'").get() as
    | { value?: unknown }
    | undefined;
  if (row === undefined || String(row.value) !== String(INDEX_FORMAT_VERSION)) {
    db.close();
    return null;
  }
  return db;
}

/**
 * @param {DatabaseSync} db
 * @param {string} table
 * @returns {number}
 */
function count(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n?: unknown } | undefined;
  return Number(row?.n ?? 0);
}

export type { DatabaseSync };
