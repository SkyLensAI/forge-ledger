/**
 * 对外 demo（S32）—— **用你自己的库**，不是编造的样例。
 *
 * implement2.md 给 S32 写的是一句很短的话：
 *
 * > 对外 demo = **你自己的库**，不是编造的样例
 *
 * 这句话约束的不是页面好不好看，而是**演示的诚实性**：
 * 一份用手写样例拼出来的 demo 能展示任何你想要的效果，但它不证明这个产品
 * 在你的真实数据上跑得通。所以 `forge demo` 的输入只有 `assets/`
 * （或 `--repo` 时的仓库资产），输出里的每一条、每一处出处都来自那份输入。
 *
 * 三条纪律，与其它出口同源：
 *
 * 1. **逐字节确定**（R6 / ADR-0017）：没有时间戳、没有随机、排序键写死。
 * 2. **HTML 转义**：资产正文是人写的，也是模型写的；一个演示页不该成为
 *    "把库里的 `<script>` 原样执行"的宿主。
 * 3. **没有外部资源**：不引用 CDN、字体、脚本。单文件即可离线打开，
 *    于是"两年后还能打开"不需要依赖任何一个域名还在。
 */
import type { AssetDoc, AssetType, EventIR } from "@forge/schema";
import { ASSET_TYPES } from "@forge/schema";
import { sortAssets } from "./compile.ts";
import { slugify, titleOf } from "./emit.ts";
import { stableJson } from "./json.ts";
import { withProjectionManifest } from "./projection.ts";
import type { EmittedFile } from "./emit.ts";

/** 演示清单的版本。它跟着清单形状走，不跟资产的 `SCHEMA_VERSION` 走。 */
export const DEMO_VERSION = 1;

export interface DemoOptions {
  title?: string;
  /** 输入来自哪里。写进 demo，避免读者把仓库自举误读成用户库。 */
  source?: "repo" | "vault";
  /** 一句说明。默认值会写出"由自己的资产生成"。 */
  about?: string;
}

export interface DemoInput {
  assets: AssetDoc[];
  events: EventIR[];
}

/**
 * 生成一份静态演示站：
 *
 * - `index.html`：计数 + 按类型分组的索引
 * - `assets/<type>/<id>-<slug>.html`：每条资产一页（含出处）
 * - `library.json`：机器可读的同一份投影
 * - `README.md`：这页是怎么来的、怎么重新生成
 *
 * @param {DemoInput} input
 * @param {DemoOptions} [options]
 * @returns {EmittedFile[]}
 */
export function emitDemo(input: DemoInput, options: DemoOptions = {}): EmittedFile[] {
  const title = options.title ?? "资产库";
  const source = options.source ?? "vault";
  const docs = sortAssets(input.assets);
  const counts = countByType(docs);
  const about =
    options.about ??
    `由 forge demo 从${source === "repo" ? "本仓库自己的" : "资产库里的"} ${String(docs.length)} 条资产生成。` +
      "每一条都带可解析的出处；这里没有编造的样例数据。";

  const pages = new Map<string, string>();
  for (const doc of docs) pages.set(assetPagePath(doc), renderAssetPage(doc, title));

  const files: EmittedFile[] = [
    { path: "index.html", content: renderIndex({ title, about, source, docs, counts }) },
    { path: "library.json", content: renderLibraryJson({ about, source, docs, counts }) },
    { path: "README.md", content: renderReadme({ title, about, source, total: docs.length }) },
  ];
  for (const [path, content] of pages) files.push({ path, content });

  return withProjectionManifest("forge demo", files);
}

/**
 * 资产页的路径：**ID 在前、slug 在后**。
 *
 * slug 只负责可读，ID 负责唯一。只用 slug 时两条同名决策会互相覆盖——
 * 而覆盖是静默的：页面还在，只是少了一条。
 *
 * @param {AssetDoc} doc
 * @returns {string}
 */
export function assetPagePath(doc: AssetDoc): string {
  return `assets/${doc.frontMatter.type}/${doc.frontMatter.id}-${slugify(titleOf(doc))}.html`;
}

interface IndexInput {
  title: string;
  about: string;
  source: "repo" | "vault";
  docs: AssetDoc[];
  counts: Record<AssetType, number>;
}

/**
 * @param {IndexInput} input
 * @returns {string}
 */
function renderIndex(input: IndexInput): string {
  const lines: string[] = [];
  lines.push(`<header class="hero">`);
  lines.push(`<p class="eyebrow">forge · demo</p>`);
  lines.push(`<h1>${escapeHtml(input.title)}</h1>`);
  lines.push(`<p class="lead">${escapeHtml(input.about)}</p>`);
  lines.push(
    `<p class="notice">${input.source === "repo" ? "数据源：本仓库自己的 ADR / 资产" : "数据源：一个真实的资产库"}` +
      ` · 共 ${String(input.docs.length)} 条 · 无外部脚本、无外部样式</p>`,
  );
  lines.push(`</header>`);
  lines.push(`<main>`);

  lines.push(`<section class="counts">`);
  for (const type of ASSET_TYPES) {
    lines.push(`<div class="count"><span>${escapeHtml(type)}</span><strong>${String(input.counts[type])}</strong></div>`);
  }
  lines.push(`</section>`);

  for (const type of ASSET_TYPES) {
    const docs = input.docs.filter((doc) => doc.frontMatter.type === type);
    lines.push(`<section>`);
    lines.push(`<h2>${escapeHtml(type)} <span class="muted">${String(docs.length)}</span></h2>`);
    if (docs.length === 0) {
      lines.push(`<p class="muted">（暂无）</p>`);
    } else {
      lines.push(`<ul class="assets">`);
      for (const doc of docs) {
        lines.push(
          `<li>` +
            `<a href="${escapeAttr(assetPagePath(doc))}">${titleHtml(titleOf(doc))}</a>` +
            `<span class="meta">${escapeHtml(doc.frontMatter.status)} · ${escapeHtml(doc.frontMatter.created)}` +
            ` · ${String(doc.frontMatter.sources.length)} 处出处</span>` +
            `</li>`,
        );
      }
      lines.push(`</ul>`);
    }
    lines.push(`</section>`);
  }

  lines.push(`</main>`);
  lines.push(`<footer>由 <code>forge demo</code> 生成。重新生成会逐字节覆盖本页。</footer>`);
  return page(input.title, lines.join("\n"));
}

/**
 * 一条资产的页面。
 *
 * @param {AssetDoc} doc
 * @param {string} libraryTitle
 * @returns {string}
 */
function renderAssetPage(doc: AssetDoc, libraryTitle: string): string {
  const fm = doc.frontMatter;
  const lines: string[] = [];
  lines.push(`<nav><a href="../../index.html">← ${escapeHtml(libraryTitle)}</a></nav>`);
  lines.push(`<header class="hero">`);
  lines.push(`<p class="eyebrow">${escapeHtml(fm.type)} · ${escapeHtml(fm.id)}</p>`);
  lines.push(`<h1>${titleHtml(titleOf(doc))}</h1>`);
  lines.push(`</header>`);
  lines.push(`<main>`);
  lines.push(`<dl class="facts">`);
  lines.push(`<div><dt>状态</dt><dd>${escapeHtml(fm.status)}</dd></div>`);
  lines.push(`<div><dt>创建</dt><dd>${escapeHtml(fm.created)}</dd></div>`);
  lines.push(`<div><dt>最后确认</dt><dd>${escapeHtml(fm.last_confirmed ?? "未确认")}</dd></div>`);
  lines.push(`<div><dt>敏感度</dt><dd>${escapeHtml(fm.sensitivity)}</dd></div>`);
  lines.push(`<div><dt>置信度</dt><dd>${String(fm.confidence)}</dd></div>`);
  lines.push(`<div><dt>来源文件</dt><dd><code>${escapeHtml(doc.path)}</code></dd></div>`);
  lines.push(`</dl>`);

  lines.push(`<section>`);
  lines.push(`<h2>出处</h2>`);
  if (fm.sources.length === 0) {
    lines.push(`<p class="muted">（没有出处。资产审核会把它报成 PROV_NO_SOURCES。）</p>`);
  } else {
    lines.push(`<ul class="sources">`);
    for (const source of fm.sources) lines.push(`<li><code>${escapeHtml(source)}</code></li>`);
    lines.push(`</ul>`);
  }
  lines.push(`</section>`);

  lines.push(`<article class="prose">`);
  lines.push(renderMarkdown(doc.body));
  lines.push(`</article>`);
  lines.push(`</main>`);
  lines.push(`<footer>由 <code>forge demo</code> 生成 · 正文来自资产文件，不是样例</footer>`);
  return page(titleOf(doc), lines.join("\n"));
}

interface LibraryJsonInput {
  about: string;
  source: "repo" | "vault";
  docs: AssetDoc[];
  counts: Record<AssetType, number>;
}

/**
 * @param {LibraryJsonInput} input
 * @returns {string}
 */
function renderLibraryJson(input: LibraryJsonInput): string {
  return stableJson({
    schema_version: DEMO_VERSION,
    kind: "forge-demo",
    about: input.about,
    source: input.source,
    counts: { total: input.docs.length, ...input.counts },
    assets: input.docs.map((doc) => ({
      id: doc.frontMatter.id,
      type: doc.frontMatter.type,
      title: titleOf(doc),
      status: doc.frontMatter.status,
      created: doc.frontMatter.created,
      last_confirmed: doc.frontMatter.last_confirmed,
      sensitivity: doc.frontMatter.sensitivity,
      confidence: doc.frontMatter.confidence,
      path: doc.path,
      page: assetPagePath(doc),
      sources: doc.frontMatter.sources,
    })),
  });
}

interface ReadmeInput {
  title: string;
  about: string;
  source: "repo" | "vault";
  total: number;
}

/**
 * @param {ReadmeInput} input
 * @returns {string}
 */
function renderReadme(input: ReadmeInput): string {
  return [
    `# ${input.title} · demo`,
    "",
    "> 本目录由 `forge demo` 从资产库生成，**不是手写样例**。",
    "",
    `- 数据源：${input.source === "repo" ? "本仓库自己的资产（自举）" : "一个真实的资产库"}`,
    `- 条数：${String(input.total)}`,
    `- 说明：${input.about}`,
    "",
    "## 重新生成",
    "",
    "```bash",
    "node apps/cli/src/main.ts demo --repo --out demo          # 写盘",
    "node apps/cli/src/main.ts demo --repo --out demo --check  # 只比对，不写盘",
    "```",
    "",
    "页面没有外部依赖：直接打开 `index.html` 即可，不需要服务器、CDN 或网络。",
    "",
  ].join("\n");
}

/**
 * 页面外壳。CSS 内联，因为演示页的第一条要求是"两年后还能打开"。
 *
 * @param {string} title
 * @param {string} body
 * @returns {string}
 */
function page(title: string, body: string): string {
  return [
    "<!doctype html>",
    '<html lang="zh-CN">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="generator" content="forge demo">',
    `<title>${escapeHtml(title)} · forge</title>`,
    "<style>",
    ":root{color-scheme:light dark;--fg:#1d1d1f;--muted:#6b6b70;--bg:#fbfbfd;--card:#fff;--line:#e3e3e8;--accent:#0b5fff}",
    "@media (prefers-color-scheme:dark){:root{--fg:#f2f2f7;--muted:#9a9aa2;--bg:#111114;--card:#18181c;--line:#2c2c33;--accent:#78a4ff}}",
    "*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.7 ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif}",
    "a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}",
    ".hero,main,footer,nav{max-width:860px;margin:0 auto;padding:0 22px}",
    ".hero{padding-top:56px}.eyebrow{margin:0;color:var(--muted);font-size:12px;letter-spacing:.12em;text-transform:uppercase}",
    "h1{font-size:34px;line-height:1.2;margin:8px 0 12px}h2{font-size:20px;margin:34px 0 12px}",
    ".lead{font-size:17px;color:var(--muted);margin:0 0 8px}.notice{color:var(--muted);font-size:13px;margin:0 0 28px}",
    ".counts{display:flex;gap:10px;flex-wrap:wrap;margin:8px 0 26px}.count{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px;min-width:92px}",
    ".count span{display:block;color:var(--muted);font-size:12px}.count strong{font-size:22px}",
    ".assets{list-style:none;padding:0;margin:0;border-top:1px solid var(--line)}",
    ".assets li{display:flex;justify-content:space-between;gap:16px;padding:12px 2px;border-bottom:1px solid var(--line)}",
    ".meta,.muted{color:var(--muted);font-size:13px}",
    ".facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin:22px 0;padding:16px;background:var(--card);border:1px solid var(--line);border-radius:12px}",
    ".facts dt{color:var(--muted);font-size:12px}.facts dd{margin:2px 0 0}",
    ".sources{padding-left:20px}.sources code{font-size:12px;word-break:break-all}",
    ".prose h1,.prose h2,.prose h3{margin-top:30px}.prose p{margin:0 0 14px}.prose blockquote{margin:0 0 14px;padding:2px 16px;border-left:3px solid var(--line);color:var(--muted)}",
    ".prose pre{overflow:auto;padding:14px;background:var(--card);border:1px solid var(--line);border-radius:10px;font-size:13px}",
    ".prose code{background:var(--card);border:1px solid var(--line);border-radius:5px;padding:1px 5px;font-size:.9em}",
    ".prose pre code{border:0;padding:0;background:none}.prose .table{white-space:pre}",
    "footer{color:var(--muted);font-size:12px;padding-top:44px;padding-bottom:44px}",
    "</style>",
    "</head>",
    "<body>",
    body,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/**
 * 一个刻意很小的 Markdown 渲染器。
 *
 * 为什么不用现成的库：输出字节会随库版本变化（R6），而这个渲染器只服务于演示页，
 * 需要覆盖的语法就是 ADR 里实际出现的那几种。**渲染不了的语法会原样显示**，
 * 这比"悄悄丢掉一段"好——演示页上的缺失应该看得见。
 *
 * @param {string} markdown
 * @returns {string}
 */
export function renderMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const html: string[] = [];
  let paragraph: string[] = [];
  let quote: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let inFence = false;
  let fenceLang = "";
  let fence: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    html.push(`<p>${inline(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const flushQuote = (): void => {
    if (quote.length === 0) return;
    html.push(`<blockquote>${quote.map((line) => `<p>${inline(line)}</p>`).join("")}</blockquote>`);
    quote = [];
  };
  const flushList = (): void => {
    if (list === null) return;
    const tag = list.ordered ? "ol" : "ul";
    html.push(`<${tag}>${list.items.map((item) => `<li>${inline(item)}</li>`).join("")}</${tag}>`);
    list = null;
  };
  const flushAll = (): void => {
    flushParagraph();
    flushQuote();
    flushList();
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";

    if (line.startsWith("```")) {
      if (!inFence) {
        flushAll();
        inFence = true;
        fenceLang = line.slice(3).trim();
        fence = [];
      } else {
        const cls = fenceLang.length === 0 ? "" : ` class="language-${escapeAttr(fenceLang)}"`;
        html.push(`<pre><code${cls}>${escapeHtml(fence.join("\n"))}</code></pre>`);
        inFence = false;
        fenceLang = "";
        fence = [];
      }
      index += 1;
      continue;
    }
    if (inFence) {
      fence.push(line);
      index += 1;
      continue;
    }

    if (line.trim().length === 0) {
      flushAll();
      index += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading !== null) {
      flushAll();
      const level = heading[1]?.length ?? 1;
      html.push(`<h${String(level)}>${inline(heading[2] ?? "")}</h${String(level)}>`);
      index += 1;
      continue;
    }

    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      flushAll();
      html.push("<hr>");
      index += 1;
      continue;
    }

    if (/^\s*\|/.test(line)) {
      flushAll();
      const rows: string[] = [];
      while (index < lines.length && /^\s*\|/.test(lines[index] ?? "")) {
        rows.push(lines[index] ?? "");
        index += 1;
      }
      // 表格不做语法解析：它的单元格里可能有 `|` 与中文全角字符，
      // 一个半吊子解析器会把表格渲染得比原样更难看。原样保留，至少信息不丢。
      html.push(`<pre class="table">${escapeHtml(rows.join("\n"))}</pre>`);
      continue;
    }

    const quoteMatch = /^\s{0,3}>\s?(.*)$/.exec(line);
    if (quoteMatch !== null) {
      flushParagraph();
      flushList();
      quote.push(quoteMatch[1] ?? "");
      index += 1;
      continue;
    }

    const unordered = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ordered = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (unordered !== null || ordered !== null) {
      flushParagraph();
      flushQuote();
      const isOrdered = ordered !== null;
      const item = (unordered ?? ordered)?.[1] ?? "";
      if (list === null || list.ordered !== isOrdered) {
        flushList();
        list = { ordered: isOrdered, items: [] };
      }
      list.items.push(item);
      index += 1;
      continue;
    }

    if (list !== null && /^\s+/.test(line)) {
      const last = list.items.length - 1;
      list.items[last] = `${list.items[last] ?? ""} ${line.trim()}`;
      index += 1;
      continue;
    }

    flushList();
    flushQuote();
    paragraph.push(line.trim());
    index += 1;
  }

  if (inFence) {
    html.push(`<pre><code>${escapeHtml(fence.join("\n"))}</code></pre>`);
  }
  flushAll();

  return html.join("\n");
}

/**
 * 行内语法：代码 span、链接、粗体。
 *
 * 链接只放行 `http` / `https` / `mailto`。`javascript:`、`data:` 与相对路径
 * 一律按原文显示——演示页不需要成为一个跳转攻击的入口。
 *
 * @param {string} text
 * @returns {string}
 */
function inline(text: string): string {
  return text
    .split(/(`[^`]*`)/g)
    .map((part) => {
      if (part.length >= 2 && part.startsWith("`") && part.endsWith("`")) {
        return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      }
      return part
        .split(/(\[[^\]]+\]\([^)]+\))/g)
        .map((segment) => {
          const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(segment);
          if (link !== null) {
            const label = link[1] ?? "";
            const href = link[2] ?? "";
            if (!isSafeHref(href)) return escapeHtml(segment);
            return `<a href="${escapeAttr(href)}" rel="noreferrer">${escapeHtml(label)}</a>`;
          }
          return escapeHtml(segment).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
        })
        .join("");
    })
    .join("");
}

/**
 * @param {string} href
 * @returns {boolean}
 */
function isSafeHref(href: string): boolean {
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:";
  } catch {
    return false;
  }
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 标题里的 `**粗体**`：先转义，再只放行粗体。
 *
 * 标题来自正文的一级标题，而 ADR 的标题经常带强调。不处理它会让演示页上
 * 出现字面的 `**`；把它交给完整的行内渲染器又会让标题里出现链接与代码框。
 * 这里只做一件事：转义 + 粗体。
 *
 * @param {string} value
 * @returns {string}
 */
function titleHtml(value: string): string {
  return escapeHtml(value).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeAttr(value: string): string {
  return escapeHtml(value);
}

/**
 * @param {AssetDoc[]} docs
 * @returns {Record<AssetType, number>}
 */
function countByType(docs: AssetDoc[]): Record<AssetType, number> {
  const counts = { decision: 0, state: 0, event: 0, rule: 0 } as Record<AssetType, number>;
  for (const doc of docs) counts[doc.frontMatter.type] += 1;
  return counts;
}
