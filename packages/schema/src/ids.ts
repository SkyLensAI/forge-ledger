/**
 * ID 的铸造与解析（ADR-0007 的形状 + ADR-0013 的取值来源）。
 *
 * 形状永远是 `<前缀>_<26 位 Crockford base32>`。**取值分两种来源**，
 * 判据只有一条：这个东西能不能重算出来。
 *
 * - 能重算（来源、事件）→ **内容寻址**。同一份字节必须得到同一个 ID，
 *   否则 Phase 2 的退出条件（两次运行逐字节相同）在架构上就不成立。
 * - 不能重算（人写的决策、模型抽取的候选）→ **ULID**。它需要一个
 *   "何时被写下"的语义，而时间可排序是白拿的便利。
 *
 * 为什么时间不进派生 ID：时间戳进输出 = 输出每次都不一样 = 快照测试只能关掉（R6）。
 */
import { createHash } from "node:crypto";
import { ID_PREFIXES, SOURCE_PREFIX, isAssetType, type AssetType } from "./fields.ts";
import { ID_SUFFIX_LENGTH, encodeBase32, normalizeBase32 } from "./base32.ts";

/** 26 字符后缀的合法形状（大小写都收，因为手抄会变）。 */
const SUFFIX_PATTERN = /^[0-9A-Za-z]{26}$/;

/**
 * 内容寻址 ID：`SHA-256(seed)` 的前 128 位编码成 26 字符。
 *
 * seed 的选择是调用方的契约：来源用**原始字节**，事件用
 * `source_id` + `key` + `text` 三者拼接。拼接里加分隔符很重要——
 * 不加的话 `("ab","c")` 和 `("a","bc")` 会撞成同一个 ID。
 *
 * @param {string} prefix
 * @param {string} seed
 * @returns {string}
 */
export function contentAddressedId(prefix: string, seed: string): string {
  const digest = createHash("sha256").update(seed, "utf8").digest();
  return prefix + encodeBase32(digest, ID_SUFFIX_LENGTH);
}

/**
 * ULID：10 字符毫秒时间戳（48 位）+ 16 字符随机段（80 位）。
 *
 * `random` 由调用方注入而不是在这里 `Math.random`：这样测试是确定的，
 * 而"随机性从哪来"是一个显式的决定，不是一个隐藏的默认。
 *
 * @param {number} atMs
 * @param {Uint8Array} random 至少 10 字节
 * @returns {string} 26 字符
 */
export function mintUlid(atMs: number, random: Uint8Array): string {
  if (!Number.isSafeInteger(atMs) || atMs < 0) {
    throw new Error(`ULID 的时间戳必须是 0 以上的安全整数，收到 ${String(atMs)}`);
  }
  const time = new Uint8Array(6);
  let value = atMs;
  for (let i = 5; i >= 0; i -= 1) {
    time[i] = value & 0xff;
    value = Math.floor(value / 256);
  }
  return encodeBase32(time, 10) + encodeBase32(random, 16);
}

/**
 * @param {AssetType} type
 * @param {number} atMs
 * @param {Uint8Array} random
 * @returns {string}
 */
export function mintAssetId(type: AssetType, atMs: number, random: Uint8Array): string {
  return ID_PREFIXES[type] + mintUlid(atMs, random);
}

export interface ParsedAssetId {
  type: AssetType;
  prefix: string;
  suffix: string;
}

/**
 * 解析资产 ID。**先归一再比较**（ADR-0007）：`DEC_01abc…` 与 `dec_01ABC…`
 * 必须被认成同一个 ID，否则 `supersedes` 这类引用会静默断链。
 *
 * @param {string} id
 * @returns {ParsedAssetId | null}
 */
export function parseAssetId(id: string): ParsedAssetId | null {
  const lower = id.toLowerCase();
  for (const [type, prefix] of Object.entries(ID_PREFIXES)) {
    if (!lower.startsWith(prefix)) continue;
    if (!isAssetType(type)) continue;
    const suffix = id.slice(prefix.length);
    if (!SUFFIX_PATTERN.test(suffix)) return null;
    if (normalizeBase32(suffix) === null) return null;
    return { type, prefix, suffix };
  }
  return null;
}

/**
 * @param {string} id
 * @returns {AssetType | null}
 */
export function typeOfId(id: string): AssetType | null {
  return parseAssetId(id)?.type ?? null;
}

/**
 * @param {string} id
 * @returns {boolean}
 */
export function isAssetId(id: string): boolean {
  return parseAssetId(id) !== null;
}

/**
 * 来源 ID：形状与资产 ID 一样，但前缀是 `src_`，而且它**不属于任何资产类型**。
 *
 * @param {string} id
 * @returns {boolean}
 */
export function isSourceId(id: string): boolean {
  const lower = id.toLowerCase();
  if (!lower.startsWith(SOURCE_PREFIX)) return false;
  const suffix = id.slice(SOURCE_PREFIX.length);
  return SUFFIX_PATTERN.test(suffix) && normalizeBase32(suffix) !== null;
}

/**
 * 供跨引用比较用：把 ID 归一到可比较形式；不规范返回 null。
 *
 * @param {string} id
 * @returns {string | null}
 */
export function normalizeId(id: string): string | null {
  const parsed = parseAssetId(id);
  if (parsed !== null) {
    const suffix = normalizeBase32(parsed.suffix);
    return suffix === null ? null : parsed.prefix + suffix;
  }
  if (isSourceId(id)) {
    const suffix = normalizeBase32(id.slice(SOURCE_PREFIX.length));
    return suffix === null ? null : SOURCE_PREFIX + suffix;
  }
  return null;
}
