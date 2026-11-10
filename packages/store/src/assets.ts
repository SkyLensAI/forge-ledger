/**
 * `assets/` 层 —— **可写**，但写入必须有见证人。
 *
 * 这里只有一个写入口：`writeAuthored(doc, draft)`。两个参数缺一不可，
 * 而第二个是**审计条目**——谁写的、什么时候、凭什么。这不是"别忘了记审计"的约定，
 * 是**签名**：给不出条目，这个函数没有第三种写法可调（R8 / S27）。
 *
 * 为什么把审计做成参数而不是"写完之后顺手调一下 audit.append"：
 * 后者是一个可以被忘记的步骤，而**能被忘记的强制等于没有强制**。
 * 一个已经落盘的资产不会因为你后来补了一条日志就变得可追溯——
 * 崩在两步之间的时候，库里那条就是无主的。
 *
 * 为什么不再提供 `writeDerived`（**Phase 7 删掉了它**）：
 * 它写的是"派生数据"，于是听起来不需要审计——但 `assets/` 里没有派生数据
 * （事件住在索引层，ADR-0015/0016），于是它实际上是一个**没有见证人的写门**。
 * 一个没人用的 API 摆在受保护的那一侧，就是在等某一天有人用它绕开审计。
 * 删掉它的判据很直接：**这个函数的调用点是零**，而它的存在本身是一个洞。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { normalizeSubjectKey, type AssetRef } from "@forge/core";
import type { AuditDraft, AuditEntry } from "@forge/core";
import { parseAssetDocument, renderAssetDocument, type AssetDoc, type AssetFrontMatter } from "@forge/schema";
import type { AuditLayer } from "./audit.ts";
import type { VaultPaths } from "./paths.ts";
import { listMarkdown, readTextIfExists } from "./paths.ts";

/**
 * 把已落盘的资产折成归并与冲突判定需要的形状（`AssetRef`）。
 *
 * **这是资产侧题面的唯一读取点**：`frontMatter.subject` 只在这里被读一次，
 * 归一化也在这一处做。判定侧拿到的已经是规范形式，于是"哪个键"只有一个答案。
 *
 * 为什么它住在 store 而不是 core：`AssetDoc` 是**宿主**扫出来的东西（IO 的产物），
 * 而 core 的判定只认纯数据（`AssetRef`）。这条分界线让冲突判定能在没有文件系统
 * 的情况下被测（`evals/golden/conflict/` 就是这么跑的）。
 *
 * @param {AssetDoc[]} docs
 * @returns {AssetRef[]}
 */
export function assetRefsOf(docs: AssetDoc[]): AssetRef[] {
  return docs.map((doc) => ({
    id: doc.frontMatter.id,
    path: doc.path,
    type: doc.frontMatter.type,
    subject: normalizeSubjectKey(doc.frontMatter.subject),
    sources: [...doc.frontMatter.sources],
    status: doc.frontMatter.status,
    body: doc.body,
  }));
}

/**
 * 改写一条资产的 front-matter，**正文一个字节都不动**。
 *
 * 只有两处会用到它：冲突的 resolve 把被取代的那一代标成 `superseded`
 * （ADR-0028），以及 `forge confirm` 刷新 `last_confirmed`（ADR-0036）。
 * 刻意不提供"改正文"的入口——一次状态替换是**新建一代**，
 * 不是把新内容塞进旧文件。把它做成一个通用编辑器，就等于给"就地覆盖"
 * 留了一扇门，而那扇门后面没有见证人（现在它有了：`draft`）。
 *
 * 重新渲染会把 front-matter 的键序归一化（R6）：这是这次写入唯一会碰到的
 * "非语义"改动，而它发生在人显式触发的那条路径上。
 *
 * @param {AssetLayer} layer
 * @param {AssetDoc} doc
 * @param {(front: AssetFrontMatter) => AssetFrontMatter} change
 * @param {AuditDraft} draft 这次改写的见证人
 * @returns {WriteOutcome}
 */
export function rewriteFrontMatter(
  layer: AssetLayer,
  doc: AssetDoc,
  change: (front: AssetFrontMatter) => AssetFrontMatter,
  draft: AuditDraft,
): WriteOutcome {
  // 只算一次：算两次的话，"改什么"这件事就有了两个可能不一致的答案。
  const frontMatter = change(doc.frontMatter);
  return layer.writeAuthored(
    {
      path: doc.path,
      frontMatter,
      body: doc.body,
      // **正文逐字节原样保留**（`replaceFrontMatter`），而不是"用 `doc.body` 重新渲染一遍"。
      raw: replaceFrontMatter(doc.raw, frontMatter),
    },
    draft,
  );
}

/**
 * 只换 front-matter，**正文一个字节都不动**。
 *
 * 为什么不能写成 `renderAssetDocument(frontMatter, doc.body)`：那是**重新渲染**，
 * 而重新渲染的排版规则与"人写下来的字节"不是同一件事——
 * 解析出来的 body 带着一个前导空行（front-matter 与正文之间的那个空行），
 * 再渲染一次就会变成两个。于是每次改写状态，正文就多一个空行：
 * 不报错、不影响阅读、**静默累积**，而它让"正文一个字节都没动"这句话变成假的
 * （`evals/regressions/0007`）。文件里已经有一份真相（`doc.raw`），
 * 改写就应该在它上面做手术，而不是另写一份。
 *
 * @param {string} raw 原样的全文
 * @param {AssetFrontMatter} frontMatter 新的 front-matter
 * @returns {string}
 */
export function replaceFrontMatter(raw: string, frontMatter: AssetFrontMatter): string {
  const bodyOffset = bodyOffsetOf(raw);
  if (bodyOffset === 0) {
    // 找不到 front-matter 的边界时**拒绝**，而不是"从第 0 个字节开始当正文"——
    // 后者会把整份文件再拼一遍，产出两份 front-matter：一个不报错、但已经坏掉的文件。
    throw new Error(
      "replaceFrontMatter：这份文本的 front-matter 边界找不到（必须以 `---\\n` 开头，并有单独一行的 `---` 结束）。" +
        "改写只能发生在**已经是一份合法资产**的文件上；不在解析层猜。",
    );
  }
  // 头只到闭合的 `---` 那一行为止（含行尾换行）。**空行归正文**——
  // 解析器把 front-matter 与正文之间那个空行算进 `body` 里，所以
  // 这里再补一个空行就等于替作者改了排版：一个空行变成两个，而且每次改写都多一个。
  const head = `${renderAssetDocument(frontMatter, "").replace(/\n+$/, "")}\n`;
  return head + raw.slice(bodyOffset);
}

/**
 * 正文在 `raw` 里的起始偏移。
 *
 * **必须与解析器用同一条规则**：以 `---\n` 开头，第一个 `\n---\n` 是结束。
 * 复制这三行是刻意的取舍——另一个做法是把 `splitFrontMatter` 从
 * `packages/schema`（受保护路径）里导出来，而为了一个偏移量去动分类法那一侧
 * 不划算。两者一旦漂移，`packages/store/test/audit.test.ts` 里那条
 * "改写之后正文逐字节不变"的断言会立刻红。
 *
 * @param {string} raw
 * @returns {number}
 */
function bodyOffsetOf(raw: string): number {
  const OPEN = "---\n";
  if (!raw.startsWith(OPEN)) return 0;
  const rest = raw.slice(OPEN.length);
  const close = /\n---[ \t]*(\n|$)/.exec(rest);
  if (close === null) return 0;
  return OPEN.length + close.index + close[0].length;
}

export interface InvalidAsset {
  path: string;
  reason: string;
}

export interface AssetScan {
  docs: AssetDoc[];
  /** 读不动 / front-matter 不合法的文件。**不静默跳过**：它们是"看起来进了库但没进"的资产。 */
  invalid: InvalidAsset[];
}

export interface WriteOutcome {
  path: string;
  created: boolean;
  /** 落盘之后链上那一条。**报告里要能指出来**：这次写入的见证人在哪一行。 */
  audit: AuditEntry;
}

export interface AssetLayer {
  scan(): AssetScan;
  read(relativePath: string): AssetDoc | null;
  /**
   * 写一条资产。**必须有审计条目**，顺序是"先记账，后落盘"。
   *
   * @param {AssetDoc} doc
   * @param {AuditDraft} draft
   * @returns {WriteOutcome}
   */
  writeAuthored(doc: AssetDoc, draft: AuditDraft): WriteOutcome;
}

/**
 * @param {VaultPaths} paths
 * @param {AuditLayer} audit 审计层。**不是可选的**——见文件头。
 * @returns {AssetLayer}
 */
export function openAssetLayer(paths: VaultPaths, audit: AuditLayer): AssetLayer {
  return {
    scan() {
      const docs: AssetDoc[] = [];
      const invalid: InvalidAsset[] = [];
      for (const relativePath of listMarkdown(paths.root, paths.assets)) {
        const text = readTextIfExists(join(paths.root, relativePath));
        if (text === null) continue;
        const parsed = parseAssetDocument(relativePath, text);
        if (parsed.ok) docs.push(parsed.doc);
        else invalid.push({ path: relativePath, reason: parsed.reason });
      }
      return { docs, invalid };
    },

    read(relativePath) {
      const text = readTextIfExists(join(paths.root, relativePath));
      if (text === null) return null;
      const parsed = parseAssetDocument(relativePath, text);
      return parsed.ok ? parsed.doc : null;
    },

    writeAuthored(doc, draft) {
      // ── 见证人必须真的在场 ──────────────────────────────────────────────
      // 类型系统已经把它标成必填，但**类型不是边界**：`any`、从 JS 调过来、
      // 或者某天有人把它改成可选，都能绕过去。所以这里再问一遍——
      // 一个只在编译期成立的约束，在运行时就是一句礼貌建议（R8）。
      if (draft === undefined || draft === null || typeof draft !== "object") {
        throw new Error(
          "写资产必须带审计条目（S27）：谁写的、什么时候、凭什么。\n" +
            "  没有见证人的写入不许落盘——`@forge/store` 不提供第二条写路径。",
        );
      }

      // ── 写前日志 ────────────────────────────────────────────────────────
      // 顺序不能换。崩在这两行之间会留下一条"记了但没写成"的条目——
      // 那是**多记**，看得见；反过来是**漏记**，而漏记的那条资产从此没有主人。
      const entry = audit.append(draft);

      const full = join(paths.root, doc.path);
      const existed = readTextIfExists(full) !== null;
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, doc.raw, { encoding: "utf8" });
      return { path: doc.path, created: !existed, audit: entry };
    },
  };
}
