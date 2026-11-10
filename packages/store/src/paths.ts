/**
 * vault 的布局与**确定性写盘**。
 *
 * 三层不是三个文件夹，是三条**权限规则**（directory.md 原则 2）：
 *
 * | 层 | 规则 | 违反它的后果 |
 * |---|---|---|
 * | `sources/` | 只读、只追加，永不修改、永不删除 | 证据被改写，所有引用它的资产静默变成错的 |
 * | `assets/` | 可写（只有编译层写；人只读 + 审核） | —— |
 * | `index/` | 派生的，**删掉能重建** | 一旦有人往里存不可重建的东西，它就变成了第二份真相 |
 *
 * 这三条规则写在路径定义旁边，而不是写在文档里：**能重建的判据是"删掉它不会丢东西"**，
 * 所以代码必须真的把 index 层当作可丢弃的——`forge compile` 重建它，而不是"修"它。
 */
import { mkdirSync, readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { assetDirOf, type AssetType } from "@forge/schema";

export interface VaultPaths {
  root: string;
  sources: string;
  assets: string;
  index: string;
  audit: string;
  /**
   * 候选区（S16）。**与 `assets/` 平级而不是它的子目录**——
   * 理由写在 `inbox.ts` 的文件头：ADR-0012 的"约定即集合"会把 `assets/` 下的
   * 每个 markdown 都当成资产，候选区住在里面就必然要么变成假资产、要么让闸门长期报红。
   */
  inbox: string;
  /**
   * 冲突队列（S20）。与候选区同一条理由：它不是资产，所以不能住在 `assets/` 里。
   *
   * 它是**唯一**能改写已有状态的通路（ADR-0028），所以它住在一个显眼的、
   * 与候选区平级的位置上，而不是藏在某个包的数据目录里。
   */
  conflicts: string;
}

/**
 * @param {string} root
 * @returns {VaultPaths}
 */
export function vaultPaths(root: string): VaultPaths {
  return {
    root,
    sources: join(root, "sources"),
    assets: join(root, "assets"),
    index: join(root, "index"),
    audit: join(root, "audit"),
    inbox: join(root, "_inbox"),
    conflicts: join(root, "_conflicts"),
  };
}

/**
 * 创建四层目录 + 候选区 + 冲突队列。`audit/` 现在只有目录——审计日志是 Phase 7（S27）的东西，
 * 先建空目录是承认"它要有地方放"，而不是假装审计已经做了。
 *
 * @param {VaultPaths} paths
 * @returns {void}
 */
export function ensureVault(paths: VaultPaths): void {
  for (const dir of [paths.root, paths.sources, paths.assets, paths.index, paths.audit, paths.inbox, paths.conflicts]) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * 确定性 JSON：键排序、两空格缩进、LF、末尾一个换行。
 *
 * **实现已经下沉到 `@forge/core`**（Phase 6 出现了第二个消费者：
 * `forge emit --evals` 导出用例集也要确定性 JSON）。这里原地转出去，
 * 于是老调用点（队列记录、录像）一行都不用改，而"两处各写一份"
 * 这件会漂移的事没有发生。
 */
export { stableJson } from "@forge/core";

/**
 * 只在**目标不存在**时写。这是 sources 层"永不修改"的执行体。
 *
 * @param {string} path
 * @param {string} text
 * @returns {boolean} 真的写了返回 true，已存在返回 false
 */
export function writeOnce(path: string, text: string): boolean {
  if (existsSync(path)) return false;
  mkdirSync(dirname(path), { recursive: true });
  // `wx` 而不是 `w`：并发导入同一份文件时，第二个写者必须失败而不是覆盖。
  writeFileSync(path, text, { encoding: "utf8", flag: "wx" });
  return true;
}

/**
 * @param {string} path
 * @returns {string | null}
 */
export function readTextIfExists(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * 递归列出目录下所有 `.md`，返回**相对 root 的 `/` 分隔路径**，已排序。
 *
 * 排序在这里做而不是靠调用方：`readdirSync` 的顺序依赖文件系统实现，
 * 是可观测差异的一个经典来源（R6）。而且必须用 `/` 拼路径——
 * 反斜杠会进到 span 里，而 span 的 target 明确拒绝反斜杠（ADR-0009）。
 *
 * @param {string} root
 * @param {string} dir
 * @returns {string[]}
 */
export function listMarkdown(root: string, dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listMarkdown(root, full));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(relative(root, full).split(sep).join("/"));
    }
  }
  return out.sort();
}

/**
 * 资产在 `assets/` 下的相对路径：按 ID 前缀分区（directory.md §八.2）。
 * 按类型分而不是按项目/客户分——后者会让跨领域检索变成噩梦。
 *
 * @param {string} id
 * @param {AssetType} type
 * @returns {string}
 */
export function assetRelativePath(id: string, type: AssetType): string {
  return `assets/${assetDirOf(type)}/${id}.md`;
}
