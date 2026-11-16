/**
 * 上架（S31）—— 把资产库投影成一份**可提交、但明确未提交**的市场条目。
 *
 * implement2.md 给 S31 写的是"Skill / MCP 提交，借平台分发与已承诺预算结算"。
 * 其中**只有一半是代码能做的**：
 *
 * | 能做 | 不能做 |
 * |---|---|
 * | 生成 marketplace / plugin 清单、Skill、MCP 配置 | 注册账号、发布 npm 包、通过平台审核 |
 * | 保证条目逐字节确定、可重生成 | 声称"已经上架" |
 * | 把未完成项列成一份人可执行的清单 | 编造 repository / homepage / author |
 *
 * 所以这个出口的产物里**永远**有 `status: "draft"` 与 `published: false`。
 * 一份自称已上架的生成物，比没有生成物更危险：它会让下一个人以为按钮已经按过了。
 *
 * 三种消费者共用同一批资产：
 * - Claude 的 Skill 加载器（`SKILL.md` + `references/`）
 * - MCP（`.mcp.json` / plugin 清单里的 `mcpServers`）
 * - 市场条目（`.claude-plugin/marketplace.json`）
 *
 * 输出仍然**逐字节确定**（R6 / ADR-0017）：没有时间戳、没有随机、
 * 所有路径与排序键显式写死，JSON 走 `stableJson`。
 */
import type { AssetDoc, AssetType, EventIR } from "@forge/schema";
import { ASSET_TYPES } from "@forge/schema";
import { sortAssets } from "./compile.ts";
import { emitSkill } from "./emit-skill.ts";
import type { EmittedFile } from "./emit.ts";
import { stableJson } from "./json.ts";
import { withProjectionManifest } from "./projection.ts";

/** 上架包清单的版本。它跟着清单形状走，不跟资产的 `SCHEMA_VERSION` 走。 */
export const LISTING_VERSION = 1;

export interface ListingOptions {
  /** 插件 / 市场名。默认 `forge`。 */
  name?: string;
  /** Skill / 投影的标题。 */
  title?: string;
  /** 版本号。**必填或默认 `0.0.0`**：不编造一个看起来像正式发布的版本。 */
  version?: string;
  /** 市场 owner 的显示名。默认 `forge`。 */
  owner?: string;
  /** MCP server 的可执行名。默认 `forge-mcp`。 */
  mcpCommand?: string;
  /** MCP server 的默认库目录（相对项目根）。默认 `data`。 */
  vault?: string;
}

export interface ListingInput {
  assets: AssetDoc[];
  events: EventIR[];
}

/**
 * 生成一份上架包。
 *
 * @param {ListingInput} input
 * @param {ListingOptions} [options]
 * @returns {EmittedFile[]}
 */
export function emitListing(input: ListingInput, options: ListingOptions = {}): EmittedFile[] {
  const name = pluginName(options.name ?? "forge");
  const title = options.title ?? "资产库";
  const version = options.version ?? "0.0.0";
  const owner = options.owner ?? name;
  const mcpCommand = options.mcpCommand ?? "forge-mcp";
  const vault = options.vault ?? "data";

  const docs = sortAssets(input.assets);
  const counts = countByType(docs);
  const summary = describeCounts(counts);
  const description = listingDescription(title, counts);
  const mcpServers = buildMcpServers(name, mcpCommand, vault);

  const files: EmittedFile[] = [];

  // ── 市场条目 ────────────────────────────────────────────────────────────
  files.push({
    path: ".claude-plugin/marketplace.json",
    content: stableJson({
      name,
      owner: { name: owner },
      metadata: { description, version },
      plugins: [
        {
          name,
          source: `./plugins/${name}`,
          description,
          version,
          category: "productivity",
          keywords: ["knowledge-base", "adr", "provenance", "agents", "context"],
        },
      ],
    }),
  });

  // ── 插件清单 ────────────────────────────────────────────────────────────
  files.push({
    path: `plugins/${name}/.claude-plugin/plugin.json`,
    content: stableJson({
      name,
      version,
      description,
      skills: [`./skills/${name}`],
      mcpServers,
    }),
  });

  // ── MCP 配置 ────────────────────────────────────────────────────────────
  //
  // 同时放在插件根的 `.mcp.json` 与 plugin 清单里，是因为两个宿主读的位置不同。
  // 它们由**同一份对象**生成，所以不会漂移——手工维护两份才会。
  files.push({
    path: `plugins/${name}/.mcp.json`,
    content: stableJson({ mcpServers }),
  });

  // ── Skill ───────────────────────────────────────────────────────────────
  //
  // 直接复用 `emitSkill`：Skill 出口只有一个真相。上架包只是给它换了个前缀，
  // 而不是在分发路径上再写一份渲染器。
  for (const file of emitSkill(input, { name, title })) {
    files.push({ path: `plugins/${name}/skills/${name}/${file.path}`, content: file.content });
  }

  // ── 清单 ────────────────────────────────────────────────────────────────
  files.push({
    path: "manifest.json",
    content: stableJson({
      schema_version: LISTING_VERSION,
      kind: "marketplace-entry",
      name,
      version,
      status: "draft",
      published: false,
      assets: { total: docs.length, ...counts },
      skill: `plugins/${name}/skills/${name}/SKILL.md`,
      mcp: { command: mcpCommand, vault },
      generated_by: "forge listing",
      note:
        "draft 是生成器的输出，不是待办事项的省略。只有人能把它变成 published：注册账号、发布包、通过平台审核。",
    }),
  });

  files.push({ path: "README.md", content: renderReadme({ name, version, summary, counts, total: docs.length }) });
  files.push({ path: "SUBMISSION.md", content: renderSubmission({ name, version, mcpCommand }) });

  // 路径排序：输出顺序不是契约，但**可复现的输出顺序**是（R6）。
  return withProjectionManifest("forge listing", files);
}

/**
 * Skill 的入口文件名是固定的 `SKILL.md`，而插件名必须小写、无空格。
 * 这里只做 ASCII 小写与连字符化——与 `slugify` 同一条纪律：不依赖 locale。
 *
 * @param {string} value
 * @returns {string}
 */
function pluginName(value: string): string {
  const lowered = value.replace(/[A-Z]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 32));
  const folded = lowered.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return folded.length > 0 ? folded : "forge";
}

/**
 * @param {string} name
 * @param {string} command
 * @param {string} vault
 * @returns {Record<string, { command: string, args: string[] }>}
 */
function buildMcpServers(
  name: string,
  command: string,
  vault: string,
): Record<string, { command: string; args: string[] }> {
  return {
    [name]: {
      command,
      // `${CLAUDE_PROJECT_DIR}` 是宿主的占位符，不是这里要展开的变量。
      // 写成绝对路径会把生成者的家目录带进产物里——那既不可移植，也不是确定性输出。
      args: ["--vault", `\${CLAUDE_PROJECT_DIR}/${vault}`],
    },
  };
}

/**
 * @param {string} title
 * @param {Record<AssetType, number>} counts
 * @returns {string}
 */
function listingDescription(title: string, counts: Record<AssetType, number>): string {
  const total = ASSET_TYPES.reduce((sum, type) => sum + counts[type], 0);
  const parts = [
    counts.decision > 0 ? `决策 ${String(counts.decision)} 条` : "",
    counts.rule > 0 ? `规则 ${String(counts.rule)} 条` : "",
    counts.state > 0 ? `状态 ${String(counts.state)} 条` : "",
  ].filter((part) => part.length > 0);
  const detail = parts.length === 0 ? "空库" : parts.join("、");
  return (
    `${title}（共 ${String(total)} 条：${detail}）：把决策、规则与状态编译成带可解析出处的资产库。` +
    `Skill 让模型按需读全文，MCP 让 Claude / Cursor 直接取用。`
  );
}

/**
 * @returns {Record<AssetType, number>}
 */
function emptyCounts(): Record<AssetType, number> {
  return { decision: 0, state: 0, event: 0, rule: 0 };
}

/**
 * @param {AssetDoc[]} docs
 * @returns {Record<AssetType, number>}
 */
function countByType(docs: AssetDoc[]): Record<AssetType, number> {
  const counts = emptyCounts();
  for (const doc of docs) counts[doc.frontMatter.type] += 1;
  return counts;
}

/**
 * @param {Record<AssetType, number>} counts
 * @returns {string}
 */
function describeCounts(counts: Record<AssetType, number>): string {
  const total = ASSET_TYPES.reduce((sum, type) => sum + counts[type], 0);
  const parts = ASSET_TYPES.filter((type) => counts[type] > 0).map((type) => `${type} ${String(counts[type])}`);
  return parts.length === 0 ? "空库" : `${String(total)} 条（${parts.join(" · ")}）`;
}

interface ReadmeInput {
  name: string;
  version: string;
  summary: string;
  counts: Record<AssetType, number>;
  total: number;
}

/**
 * @param {ReadmeInput} input
 * @returns {string}
 */
function renderReadme(input: ReadmeInput): string {
  const lines: string[] = [];
  lines.push("# Forge · 上架包（draft）");
  lines.push("");
  lines.push(
    "> **状态：draft。没有提交、没有发布、没有出现在任何市场里。** " +
      "本目录由 `forge listing --repo --out listing` 从**本仓库自己的资产**生成。",
  );
  lines.push("");
  lines.push(`- 插件名：\`${input.name}\``);
  lines.push(`- 版本：\`${input.version}\`（默认值，不是一次已发布的版本）`);
  lines.push(`- 资产：${input.summary}`);
  lines.push(`- 入口：\`plugins/${input.name}/skills/${input.name}/SKILL.md\``);
  lines.push("");
  lines.push("## 里面有什么");
  lines.push("");
  lines.push("| 文件 | 消费者 | 作用 |");
  lines.push("|---|---|---|");
  lines.push("| `.claude-plugin/marketplace.json` | 市场 | 一份可被市场读取的条目 |");
  lines.push("| `plugins/<name>/.claude-plugin/plugin.json` | Claude Code | 插件清单（Skill + MCP） |");
  lines.push("| `plugins/<name>/.mcp.json` | MCP 宿主 | 启动 `forge-mcp` 并指向库目录 |");
  lines.push("| `plugins/<name>/skills/<name>/SKILL.md` | Skill 加载器 | 规则与索引；决策全文在 `references/` 按需读 |");
  lines.push("| `manifest.json` | 机器 | 状态、计数与未完成项 |");
  lines.push("| `SUBMISSION.md` | 人 | 上架之前必须由人完成的清单 |");
  lines.push("");
  lines.push("## 为什么是 draft");
  lines.push("");
  lines.push(
    "上架需要人：账号、仓库 URL、一个真正可安装的 `forge-mcp` 包、以及平台审核。" +
      "代码能做的是把条目生成对，不能替人按提交按钮。" +
      "所以这个目录**不会**自称 `published`——一份自称已上架的生成物，" +
      "会让下一个人以为最花时间的那一步已经做完了。",
  );
  lines.push("");
  lines.push("## 重新生成");
  lines.push("");
  lines.push("```bash");
  lines.push("node apps/cli/src/main.ts listing --repo --out listing          # 写盘");
  lines.push("node apps/cli/src/main.ts listing --repo --out listing --check  # 只比对，不写盘");
  lines.push("```");
  lines.push("");
  return lines.join("\n");
}

/**
 * @param {{ name: string, version: string, mcpCommand: string }} input
 * @returns {string}
 */
function renderSubmission(input: { name: string; version: string; mcpCommand: string }): string {
  const lines: string[] = [];
  lines.push("# 上架清单（人来做）");
  lines.push("");
  lines.push(
    "机器已经做完的：生成 marketplace / plugin 清单、Skill、MCP 配置，并保证它们可以逐字节重生成。",
  );
  lines.push("");
  lines.push("## 机器已完成");
  lines.push("");
  lines.push("- [x] `.claude-plugin/marketplace.json`");
  lines.push(`- [x] 插件清单（\`${input.name}\` ${input.version}）`);
  lines.push("- [x] Skill（`SKILL.md` + `references/`）");
  lines.push("- [x] MCP 配置（`.mcp.json` 与 plugin 清单同源）");
  lines.push("- [x] 未完成项与 draft 状态写进 `manifest.json`");
  lines.push("");
  lines.push("## 必须由人完成");
  lines.push("");
  lines.push(
    `- [ ] 让 \`${input.mcpCommand}\` 成为一个真正可安装的命令（当前 workspace 包是 \`private: true\`）。`,
  );
  lines.push("- [ ] 填写真实的 repository / homepage / author：生成器**不编造**这些字段。");
  lines.push("- [ ] 在平台上提交条目，并按平台要求提供隐私说明与支持渠道。");
  lines.push("- [ ] 审核通过之后，**由人**把 `manifest.json` 的 `published` 改成 true，并记录在哪一天上的架。");
  lines.push("");
  lines.push("## 判据");
  lines.push("");
  lines.push(
    "`published: true` 不是一句宣告，是一条需要证据的状态：" +
      "市场条目 URL、审核通过的通知、以及一个装得上的包。三者缺一，它就该一直是 `false`。",
  );
  lines.push("");
  return lines.join("\n");
}
