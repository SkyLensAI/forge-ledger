/**
 * 出处 span 的语法与匹配 —— 纯函数，零 IO，零依赖。
 *
 * 规范文本（人读）在 `schema/provenance.md`；这里是它的执行体（ADR-0009）。
 * 分工：本模块只回答"这个 span 合法吗""这段文字里锚点命不命中"；
 * **读文件、构建索引是边缘的事**（闸门脚本、CLI、MCP server、桌面端）。
 * 这样同一份判定可以在四个宿主里复用，并且可以用固定字符串做测试。
 *
 * 语法 v1：
 *   span   := scheme "://" target [ "#" anchor ]
 *   scheme := "file" | "src"
 *   anchor := "h:" 标题 | "t:" 原文片段 | "k:" 键路径 | "L<起>-L<止>"
 *
 * 为什么 anchor 只有这几种可机械判定的形式：出处必须能被判红。
 * 自由文本形式的出处（"来自那天的会话"）看起来像证据，但它无法校验——
 * 而**腐坏的出处比没有出处更糟**（ADR-0009）。
 *
 * `k:` 是 v1 里唯一的**结构化**锚点（ADR-0014）：它指向来源文件里的一个键路径，
 * 而不是一段文字。理由是 `t:` 在 JSON 上会脆断——导出把引号、反斜杠、换行
 * 转义成 `\"` `\\` `\n`，同一句话在原文与原始字节里是两个不同的字符串。
 * 判据随之分成两半：**语法**由这里的纯函数判（键路径长什么样），
 * **命中**由来源层（`packages/store`）判（那个键在解析后的 JSON 里存不存在）。
 */

/** v1 支持的 scheme。`file` 指工作区内文件；`src` 指 data/sources/ 里的不可变片段。 */
export const SPAN_SCHEMES = ["file", "src"] as const;
export type SpanScheme = (typeof SPAN_SCHEMES)[number];

/** anchor 的四种形式：标题 / 原文片段 / 键路径 / 行区间。 */
export const ANCHOR_KINDS = ["h", "t", "k", "L"] as const;
export type AnchorKind = (typeof ANCHOR_KINDS)[number];

/** 能对着"一段文字"判定的锚点。`k` 不在其中——它要对着一份**解析后的结构**判定。 */
export type TextAnchorKind = Extract<AnchorKind, "h" | "t" | "L">;


/**
 * `#t:` 片段的最小长度（归一化后）。
 * 太短的片段会在文档里到处命中，等于没有定位能力——它会让闸门"通过"，但那不是证据。
 */
export const MIN_TEXT_ANCHOR_LENGTH = 8;

/** excerpt 的回显上限：够人核对，又不至于把整个文件塞进闸门输出。 */
export const MAX_EXCERPT_LENGTH = 160;

export interface SpanAnchor {
  kind: AnchorKind;
  /** `h` / `t` 时是文字；`k` 时是键路径；`L` 时是原样的 `L12-L20`（解析见 parseLineRange）。 */
  payload: string;
}

/**
 * 这个锚点能不能对着一"段文字"判定。
 * `h` / `t` / `L` 能；`k` 不能（它要对着一份解析后的结构判定，见 matchAnchor）。
 *
 * @param {SpanAnchor} anchor
 * @returns {boolean}
 */
export function isTextAnchor(anchor: SpanAnchor): boolean {
  return anchor.kind !== "k";
}

export interface Span {
  scheme: SpanScheme;
  target: string;
  anchor: SpanAnchor | null;
}

export type ParseSpanResult = { ok: true; span: Span } | { ok: false; reason: string };
export type MatchResult = { ok: true; excerpt: string } | { ok: false; reason: string };

/**
 * 空白折叠 + 行尾归一。
 *
 * 为什么每个比较前都要走一遍：文档里被引用的句子经常跨行（Markdown 里换行不等于语义边界），
 * 若按字节比较，改一次排版就会让所有引用失效——那不是"出处是硬约束"，
 * 那是"出处是脆弱的字符串比对"。折叠空白让 span 对齐**语义**而不是排版。
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\s+/)
    .filter((piece) => piece.length > 0)
    .join(" ");
}

/**
 * @param {string} raw
 * @returns {ParseSpanResult}
 */
export function parseSpan(raw: string): ParseSpanResult {
  const text = raw.trim();
  if (text.length === 0) return { ok: false, reason: "空 span" };

  const schemeEnd = text.indexOf("://");
  if (schemeEnd <= 0) {
    return { ok: false, reason: `缺少 scheme://（实际：${preview(raw)}）` };
  }

  const schemeRaw = text.slice(0, schemeEnd);
  if (!isSpanScheme(schemeRaw)) {
    return {
      ok: false,
      reason: `未知 scheme「${schemeRaw}」：v1 只有 ${SPAN_SCHEMES.join(" / ")}（外部证据要先落进 sources/ 再引用）`,
    };
  }

  const rest = text.slice(schemeEnd + "://".length);
  const hashAt = rest.indexOf("#");
  const target = hashAt >= 0 ? rest.slice(0, hashAt) : rest;
  const anchorRaw = hashAt >= 0 ? rest.slice(hashAt + 1) : null;

  const targetProblem = checkTarget(target);
  if (targetProblem !== null) return { ok: false, reason: targetProblem };

  if (anchorRaw === null) return { ok: true, span: { scheme: schemeRaw, target, anchor: null } };

  const anchor = parseAnchor(anchorRaw);
  if (typeof anchor === "string") return { ok: false, reason: anchor };

  return { ok: true, span: { scheme: schemeRaw, target, anchor } };
}

/**
 * span 的规范形式，也是它在 `SpanIndex` 里的键。
 *
 * 用途：`file://a.md#t:  多  空格` 与 `file://a.md#t:多 空格` 必须命中同一个事实，
 * 否则同一处证据会因为排版差异被当成两处（一处 resolved、一处 unresolved）。
 *
 * @param {Span} span
 * @returns {string}
 */
export function formatSpan(span: Span): string {
  const anchor =
    span.anchor === null
      ? ""
      : `#${span.anchor.kind === "L" ? span.anchor.payload : `${span.anchor.kind}:${normalizeText(span.anchor.payload)}`}`;
  return `${span.scheme}://${span.target}${anchor}`;
}

/**
 * 把 `L12-L20` 解析成 1 基、闭区间的行号。
 * @param {string} payload
 * @returns {{ start: number, end: number } | null}
 */
export function parseLineRange(payload: string): { start: number; end: number } | null {
  const match = /^L(\d+)-L(\d+)$/.exec(payload);
  if (match === null) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
  if (start < 1 || end < start) return null;
  return { start, end };
}

/**
 * 锚点是否命中这段文字 —— **纯函数**：输入是"目标文件的全部内容"，输出是命中与否 + 供人核对的回显。
 *
 * @param {SpanAnchor} anchor
 * @param {string} text
 * @returns {MatchResult}
 */
export function matchAnchor(anchor: SpanAnchor, text: string): MatchResult {
  const all = text.replace(/\r\n?/g, "\n").split("\n");

  if (anchor.kind === "k") {
    // 键锚点不能对着自由文本判定——它要对着一份**解析后的结构**判定。
    // 这里明确报"判不了"，而不是猜一个 false：把"无法判定"和"判定为假"混成一种输出，
    // 正是 ADR-0009 要避免的那类错误。调用方（asset 审核）遇到 k 走 SpanIndex。
    return {
      ok: false,
      reason: `键锚点 #k:${anchor.payload} 需要来源层解析（对自由文本判定没有意义）`,
    };
  }

  if (anchor.kind === "h") {
    const wanted = normalizeText(anchor.payload);
    for (const line of all) {
      const heading = headingOf(line);
      if (heading !== null && normalizeText(heading) === wanted) {
        return { ok: true, excerpt: excerptOf(line) };
      }
    }
    return { ok: false, reason: `没有标题匹配「${anchor.payload}」` };
  }

  if (anchor.kind === "t") {
    const wanted = normalizeText(anchor.payload);
    if (!normalizeText(text).includes(wanted)) {
      return { ok: false, reason: `目标里找不到片段「${anchor.payload}」` };
    }
    // 命中了，但要给出**人可核对**的回显：从片段首词所在的行开始取。
    const firstWord = wanted.split(" ")[0] ?? wanted;
    for (const line of all) {
      if (normalizeText(line).includes(firstWord)) return { ok: true, excerpt: excerptOf(line) };
    }
    // 理论上不可达（整体命中必有一行含首词），但不留静默分支。
    return { ok: true, excerpt: preview(wanted) };
  }

  const range = parseLineRange(anchor.payload);
  if (range === null) {
    return { ok: false, reason: `行区间不合法：「${anchor.payload}」（形如 #L12-L20，1 基且 start ≤ end）` };
  }
  if (all.length < range.end) {
    return {
      ok: false,
      reason: `目标只有 ${all.length} 行，引用的是 ${anchor.payload}`,
    };
  }
  return { ok: true, excerpt: excerptOf(all.slice(range.start - 1, range.end).join(" ")) };
}

/**
 * @param {string} value
 * @returns {value is SpanScheme}
 */
function isSpanScheme(value: string): value is SpanScheme {
  return (SPAN_SCHEMES as readonly string[]).includes(value);
}

/**
 * target 的形状约束。这里只做**与宿主无关**的判定（路径健壮性）；
 * "文件是否存在"是解析器的职责。
 *
 * @param {string} target
 * @returns {string | null} 有问题时返回原因
 */
function checkTarget(target: string): string | null {
  if (target.length === 0) return "target 为空";
  if (/\s/.test(target)) return `target 含空白：「${preview(target)}」（路径请用无空格的相对路径）`;
  if (target.includes("\\")) return `target 用了反斜杠：「${preview(target)}」`;
  if (target.startsWith("/")) return `target 是绝对路径：「${preview(target)}」，span 必须相对仓库/工作区`;
  if (/^[A-Za-z]:/.test(target)) return `target 是绝对路径：「${preview(target)}」`;
  if (target.endsWith("/")) return `target 以 / 结尾（应指向一个文件/片段）：「${preview(target)}」`;
  const segments = target.split("/");
  for (const segment of segments) {
    if (segment === "." || segment === "..") return `target 含相对段落「${segment}」：「${preview(target)}」`;
    if (segment.length === 0) return `target 含空路径段：「${preview(target)}」`;
  }
  return null;
}

/**
 * @param {string} raw
 * @returns {SpanAnchor | string} 合法时返回 anchor，不合法时返回原因
 */
function parseAnchor(raw: string): SpanAnchor | string {
  if (raw.length === 0) {
    return "`#` 后面是空的：anchor 要么省略，要么写 h: / t: / k: / L<起>-L<止>";
  }

  const kind = raw.slice(0, 2);
  if (kind === "h:" || kind === "t:") {
    const payload = raw.slice(2);
    if (payload.trim().length === 0) return `\`#${kind}\` 的锚点内容为空`;
    if (kind === "t:" && normalizeText(payload).length < MIN_TEXT_ANCHOR_LENGTH) {
      return `#t: 片段太短（归一化后 ${normalizeText(payload).length} < ${MIN_TEXT_ANCHOR_LENGTH} 字符）：太短的片段哪都能命中，等于没有定位能力`;
    }
    return { kind: kind === "h:" ? "h" : "t", payload };
  }

  if (kind === "k:") {
    const payload = raw.slice(2);
    const problem = checkKeyPath(payload);
    if (problem !== null) return problem;
    return { kind: "k", payload };
  }

  if (raw.startsWith("L")) {
    if (parseLineRange(raw) === null) {
      return `行区间不合法：「${raw}」（形如 #L12-L20，1 基且 start ≤ end）`;
    }
    return { kind: "L", payload: raw };
  }

  return `未知 anchor 形式「${preview(raw)}」：v1 只有 #h:<标题> / #t:<片段> / #k:<键路径> / #L<起>-L<止>`;
}

/**
 * 键路径的形状约束：`a/b/c` 形式的非空段序列。
 *
 * 为什么不接受空段：`#k:conv//turn` 与 `#k:conv/turn` 在 JSON 里指向同一处，
 * 但它们是两个不同的字符串——允许这种写法等于允许"同一处证据有两个键"，
 * 与 formatSpan 的规范化目的相冲突。
 *
 * @param {string} payload
 * @returns {string | null} 有问题时返回原因
 */
export function checkKeyPath(payload: string): string | null {
  if (payload.length === 0) return "`#k:` 后面是空的（键路径形如 conv_01/turn_03）";
  if (/\s/.test(payload)) return `键路径含空白：「${preview(payload)}」`;
  if (payload.startsWith("/") || payload.endsWith("/")) {
    return `键路径不能以 / 开头或结尾：「${preview(payload)}」`;
  }
  if (payload.includes("//")) return `键路径含有空段：「${preview(payload)}」`;
  if (payload.includes("\\")) return `键路径用了反斜杠：「${preview(payload)}」（分隔符是 /）`;
  return null;
}

/**
 * ATX 标题的文字部分；不是标题返回 null。
 * @param {string} line
 * @returns {string | null}
 */
function headingOf(line: string): string | null {
  const match = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
  const body = match?.[1];
  if (body === undefined) return null;
  return body.replace(/\s+#+\s*$/, "").trim();
}

/**
 * @param {string} text
 * @returns {string}
 */
function excerptOf(text: string): string {
  return preview(normalizeText(text));
}

/**
 * @param {string} text
 * @returns {string}
 */
function preview(text: string): string {
  const flat = normalizeText(text);
  return flat.length > MAX_EXCERPT_LENGTH ? `${flat.slice(0, MAX_EXCERPT_LENGTH)}…` : flat;
}
