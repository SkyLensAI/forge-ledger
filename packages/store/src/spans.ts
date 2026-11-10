/**
 * 出处解析 —— **IO 在边缘**（ADR-0009）。
 *
 * 判定（"这个 span 合不合法、命不命中"）是纯函数，住在 `@forge/core`；
 * 读文件、解 JSON、按 connector id 找回解析器，是这里的事。
 * 分开的理由不是洁癖：同一份判定要跑在 CI、CLI、MCP server、桌面端四个宿主里，
 * 而它们的"文件系统"各不相同。把 IO 留在边缘，判定才能被复用而不是被复制。
 *
 * 本模块的**结果必须诚实**：解析不了就报 `unresolved`，宿主没有这一层就报
 * `unavailable`。"没查"和"查过没问题"是两种输出（ADR-0009）——
 * 把它们混起来，闸门就会在某些宿主上静默变成绿灯。
 */
import { join } from "node:path";
import { matchAnchor, type Span, type SpanAnchor, type SpanFact, type SpanIndex } from "@forge/core";
import { connectorById } from "@forge/ingest";
import { readTextIfExists } from "./paths.ts";
import type { SourceLayer } from "./sources.ts";

/** excerpt 上限，与 core 的 MAX_EXCERPT_LENGTH 同量级：够人核对，不淹没输出。 */
const EXCERPT_LIMIT = 160;

export interface SpanIndexOptions {
  /** 来源层。`null` = 这个宿主没有 sources（例如 CI：`data/` 被 gitignore）。 */
  sources: SourceLayer | null;
  /** `file://` 的解析根，按顺序尝试。 */
  workspaces: string[];
}

/**
 * @param {SpanIndexOptions} options
 * @returns {SpanIndex}
 */
export function buildSpanIndex(options: SpanIndexOptions): SpanIndex {
  const fileCache = new Map<string, string | null>();
  const sourceCache = new Map<string, ReturnType<SourceLayer["read"]>>();
  const keyCache = new Map<string, KeyLookup>();

  /**
   * @param {string} path
   * @returns {string | null}
   */
  function readCached(path: string): string | null {
    if (!fileCache.has(path)) fileCache.set(path, readTextIfExists(path));
    return fileCache.get(path) ?? null;
  }

  /**
   * 来源里所有可被 `#k:` 指到的键。用**连接器自己**解析，而不是写第二份实现：
   * 两份实现对同一份文件的判断必然漂移，而漂移的方向永远是"校验那份更宽松"。
   *
   * 返回三种情况而不是 `Set | null`：**"没有这一层"和"没有这一份"是两件事**。
   * 前者是本宿主校验不了（unavailable），后者是目标不存在（unresolved）——
   * 合并它们会让"这个 vault 里根本没有这份来源"看起来像"这台机器不支持校验"。
   *
   * @param {string} sourceId
   * @returns {KeyLookup}
   */
  function keysOf(sourceId: string): KeyLookup {
    const cached = keyCache.get(sourceId);
    if (cached !== undefined) return cached;

    let result: KeyLookup;
    if (options.sources === null) {
      result = { kind: "no-source-layer" };
    } else {
      if (!sourceCache.has(sourceId)) sourceCache.set(sourceId, options.sources.read(sourceId));
      const record = sourceCache.get(sourceId);
      if (record === null || record === undefined) {
        result = { kind: "no-such-source" };
      } else {
        const connector = connectorById(record.meta.connector);
        result =
          connector === null
            ? { kind: "no-connector", connectorId: record.meta.connector }
            : { kind: "keys", keys: new Set(connector.parse(record.text).records.map((item) => item.key)) };
      }
    }
    keyCache.set(sourceId, result);
    return result;
  }

  return {
    lookup(canonical: string): SpanFact {
      const span = describe(canonical);
      if (span === null) {
        // 走到这里说明调用方没先做语法校验。宁可报红，也不要猜。
        return { kind: "unresolved", reason: `span 语法不合法，无法解析：${canonical}` };
      }

      if (span.scheme === "file") return resolveFile(span, readCached, options.workspaces);
      return resolveSource(span, keysOf);
    },
  };
}

/** `#k:` 解析的三种前置状态。**"没有这一层"和"没有这一份"必须分开。** */
type KeyLookup =
  | { kind: "keys"; keys: Set<string> }
  | { kind: "no-source-layer" }
  | { kind: "no-such-source" }
  | { kind: "no-connector"; connectorId: string };

/**
 * 从规范形式反解出 span。规范形式是我们自己 `formatSpan` 出来的，
 * 所以这里只是把它拆开——**不重新解析语法**（语法合法性已由纯函数判过）。
 *
 * @param {string} canonical
 * @returns {Span | null}
 */
function describe(canonical: string): Span | null {
  const schemeEnd = canonical.indexOf("://");
  if (schemeEnd <= 0) return null;
  const scheme = canonical.slice(0, schemeEnd);
  if (scheme !== "file" && scheme !== "src") return null;

  const rest = canonical.slice(schemeEnd + 3);
  const hashAt = rest.indexOf("#");
  const target = hashAt >= 0 ? rest.slice(0, hashAt) : rest;
  const anchorRaw = hashAt >= 0 ? rest.slice(hashAt + 1) : null;
  if (target.length === 0) return null;

  if (anchorRaw === null) return { scheme, target, anchor: null };
  const kind = anchorRaw.slice(0, 2);
  if (kind === "h:" || kind === "t:" || kind === "k:") {
    return { scheme, target, anchor: { kind: kind === "h:" ? "h" : kind === "t:" ? "t" : "k", payload: anchorRaw.slice(2) } };
  }
  return { scheme, target, anchor: { kind: "L", payload: anchorRaw } };
}

/**
 * @param {Span} span
 * @param {(path: string) => string | null} readCached
 * @param {string[]} workspaces
 * @returns {SpanFact}
 */
function resolveFile(span: Span, readCached: (path: string) => string | null, workspaces: string[]): SpanFact {
  if (workspaces.length === 0) {
    return { kind: "unavailable", reason: "这个宿主没有配置 file:// 的解析根" };
  }

  for (const workspace of workspaces) {
    const text = readCached(join(workspace, span.target));
    if (text === null) continue;

    if (span.anchor === null) {
      return { kind: "resolved", excerpt: clamp(firstLine(text)) };
    }
    if (span.anchor.kind === "k") {
      const parsed = tryJson(text);
      if (parsed === null) {
        return { kind: "unresolved", reason: `${span.target} 不是合法 JSON，装不下键锚点` };
      }
      return keyLookup(parsed, span.anchor.payload, span.target);
    }
    return matchText(span.anchor, text, span.target);
  }

  return { kind: "unresolved", reason: `在解析根里找不到 ${span.target}` };
}

/**
 * @param {Span} span
 * @param {(sourceId: string) => KeyLookup} keysOf
 * @returns {SpanFact}
 */
function resolveSource(span: Span, keysOf: (sourceId: string) => KeyLookup): SpanFact {
  const lookup = keysOf(span.target);

  if (lookup.kind === "no-source-layer") {
    return {
      kind: "unavailable",
      reason: `这个宿主没有来源层，无法校验 src://${span.target}`,
    };
  }
  if (lookup.kind === "no-connector") {
    return {
      kind: "unavailable",
      reason: `没有 id 为「${lookup.connectorId}」的连接器，无法解析这份来源（连接器是插件，删掉它等于删掉解释权）`,
    };
  }
  if (lookup.kind === "no-such-source") {
    return { kind: "unresolved", reason: `来源 ${span.target} 不在库里` };
  }

  const keys = lookup.keys;
  if (span.anchor === null) {
    return { kind: "resolved", excerpt: clamp(`${keys.size} 条记录`) };
  }
  if (span.anchor.kind === "k") {
    if (!keys.has(span.anchor.payload)) {
      return {
        kind: "unresolved",
        reason: `来源 ${span.target} 里没有键「${span.anchor.payload}」——它可能被改写过了`,
      };
    }
    return { kind: "resolved", excerpt: clamp(`#k:${span.anchor.payload}`) };
  }
  return { kind: "unavailable", reason: `src:// 的 ${span.anchor.kind} 型锚点要读原始字节，v0 只支持 #k:` };
}

/**
 * @param {SpanAnchor} anchor
 * @param {string} text
 * @param {string} target
 * @returns {SpanFact}
 */
function matchText(anchor: SpanAnchor, text: string, target: string): SpanFact {
  // 复用 core 的纯匹配：**不要在这里重写一份**——重写的那份一定会更宽松，
  // 而更宽松的校验比没有校验更糟（它会把"看起来有出处"变成绿灯）。
  const result = matchAnchor(anchor, text);
  if (result.ok) return { kind: "resolved", excerpt: clamp(result.excerpt) };
  return { kind: "unresolved", reason: `${target} 里${result.reason}` };
}

/**
 * 键路径查找：`a/b/c` 逐段走对象/数组。
 * 数字段在数组上按**下标**解释（1 基还是 0 基？—— 0 基，和 JSON 一致）。
 *
 * @param {unknown} root
 * @param {string} keyPath
 * @param {string} label
 * @returns {SpanFact}
 */
function keyLookup(root: unknown, keyPath: string, label: string): SpanFact {
  let current: unknown = root;
  const walked: string[] = [];
  for (const segment of keyPath.split("/")) {
    walked.push(segment);
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return { kind: "unresolved", reason: `${label} 的 ${walked.join("/")} 不存在` };
      }
      current = current[index];
      continue;
    }
    if (typeof current !== "object" || current === null) {
      return { kind: "unresolved", reason: `${label} 的 ${walked.join("/")} 不存在` };
    }
    const record = current as Record<string, unknown>;
    if (!Object.hasOwn(record, segment)) {
      return { kind: "unresolved", reason: `${label} 的 ${walked.join("/")} 不存在` };
    }
    current = record[segment];
  }
  return { kind: "resolved", excerpt: clamp(JSON.stringify(current) ?? "") };
}

/**
 * @param {string} text
 * @returns {unknown}
 */
function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * @param {string} text
 * @returns {string}
 */
function firstLine(text: string): string {
  return text.split("\n", 1)[0] ?? "";
}

/**
 * @param {string} text
 * @returns {string}
 */
function clamp(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > EXCERPT_LIMIT ? `${flat.slice(0, EXCERPT_LIMIT)}…` : flat;
}
