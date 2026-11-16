/**
 * `audit/` 层 —— 只追加的审计日志（S27）。
 *
 * 三个决定写在这里，它们都不是实现细节：
 *
 * 1. **写前日志（write-ahead）**。条目先落盘，资产后落盘。反过来做的话，
 *    崩在这两步之间会留下一条没有记录的写入——而那是审计唯一不能出的错。
 *    反过来崩，留下的是一条"记了但没写成"的条目：多记一条看得见，漏记一条看不见。
 *    哪个方向是安全的一目了然。
 * 2. **同一个文件，一行一条**（JSONL）。不用 SQLite：审计要能被 `git diff`、
 *    被 `grep`、被任何编辑器打开——索引层可以重建，审计不行，
 *    而不可重建的东西不该锁在一个二进制文件里。
 * 3. **链尾在内存里，写的时候现读一次**。不缓存整份日志：
 *    日志会长到几十万行，而每次写入都要重新验一遍前驱——
 *    那既慢，又让"两条条目同时写"这个竞争条件有了第二个失败面。
 *    代价是**单写者假设**（见下方注释里的已知缺口）。
 *
 * 已知缺口（记账，不假装堵住了）：
 * - **同时写**。两个进程同时对同一个库跑 `forge promote`，两边都会读到同一个链尾，
 *   于是产生两条 `seq` 相同或 `prev` 相同的条目。链的验证会把它报出来
 *   （`verifyChain` 的缺号/断链），但**不会**阻止它发生。单人本地工具里这可以接受，
 *   团队版（Phase 8）要在这里加文件锁。
 * - **有人直接往 `assets/` 放文件**。文件系统不会问"你记了吗"。
 *   所以审计不可能强制每一次写入；它做的是让沉默的写入在
 *   `AUDIT_UNATTRIBUTED_ASSET` 里被看见（`auditCompleteness`）。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  appendAuditEntry,
  auditCompleteness,
  parseAuditLine,
  serializeAuditEntry,
  verifyChain,
  type AuditDraft,
  type AuditEntry,
  type AuditGap,
  type ChainVerification,
} from "@forge/core";
import type { AssetDoc } from "@forge/schema";
import type { VaultPaths } from "./paths.ts";
import { readTextIfExists } from "./paths.ts";

const LOG_FILE = "audit.jsonl";

export interface AuditLayer {
  /** 接在链尾写一条。**写盘失败就抛**：调用方（写资产那条路）不许在它失败之后继续。 */
  append(draft: AuditDraft): AuditEntry;
  /**
   * 日志文件在不在。
   *
   * 它必须能被单独问：**"没有日志"与"日志里没有这一条"是两件事**。
   * 把前者渲染成后者，就是用一份缺失的账本替"什么都没发生"背书——
   * 周报里那句话（"这一周确实没有过写入"）只有在日志确实存在时才敢说。
   */
  exists(): boolean;
  /** 全部条目，按文件顺序。读不动的地方进 `problems`，**不静默跳过**。 */
  read(): { entries: AuditEntry[]; problems: string[] };
  /** 验链：缺号 / 断链 / 被改 / 时间倒流。 */
  verify(): ChainVerification;
  /** 与资产库对账：日志指向的空气，以及绕过 forge 的写入。 */
  completeness(assets: AssetDoc[]): AuditGap[];
  /** 日志文件的绝对路径（报告里要能指出来）。 */
  path(): string;
}

/**
 * @param {VaultPaths} paths
 * @returns {AuditLayer}
 */
export function openAuditLayer(paths: VaultPaths): AuditLayer {
  const file = join(paths.audit, LOG_FILE);

  const read = (): { entries: AuditEntry[]; problems: string[] } => {
    const text = readTextIfExists(file);
    if (text === null) return { entries: [], problems: [] };

    const entries: AuditEntry[] = [];
    const problems: string[] = [];
    // 空行是允许的（手工编辑留下的），但**有内容而读不动**的行必须报出来：
    // 静默跳过会让"日志被截断"与"日志本来就这么短"看起来一样。
    const lines = text.split("\n");
    for (const [index, line] of lines.entries()) {
      if (line.trim().length === 0) continue;
      const parsed = parseAuditLine(line);
      if (parsed.ok) entries.push(parsed.entry);
      else problems.push(`${LOG_FILE} 第 ${String(index + 1)} 行读不动：${parsed.reason}`);
    }
    return { entries, problems };
  };

  return {
    append(draft) {
      // 每次写入都现读链尾：内存里缓存一份"最后一条"看着更快，
      // 但那份缓存与被审计的东西住在同一个进程里——改了日志的人只要重启一次进程，
      // 缓存就替他把链接回去了。**审计的判据不能住在被审计的进程里。**
      const { entries } = read();
      const tail = entries.length === 0 ? null : (entries[entries.length - 1] ?? null);
      const entry = appendAuditEntry(tail, draft);
      mkdirSync(paths.audit, { recursive: true });
      appendFileSync(file, `${serializeAuditEntry(entry)}\n`, "utf8");
      return entry;
    },

    read,

    exists() {
      return readTextIfExists(file) !== null;
    },

    verify() {
      const { entries, problems } = read();
      const chain = verifyChain(entries);
      return { ...chain, ok: chain.ok && problems.length === 0, problems: [...chain.problems, ...problems].sort() };
    },

    completeness(assets) {
      return auditCompleteness(read().entries, assets);
    },

    path() {
      return file;
    },
  };
}
