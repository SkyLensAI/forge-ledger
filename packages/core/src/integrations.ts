/**
 * MCP 客户端集成：**数据 + 纯函数**，零 IO（R5）。
 *
 * 这个模块只回答一个问题：**同一个 forge MCP server，在不同客户端里应该长什么样。**
 * 它不改 server，也不启动 server——server 始终是 stdio 的四个只读工具。
 * 差异全部在**配置形状**：
 *
 * | shape | 顶层键 | 客户端 |
 * |---|---|---|
 * | `mcpServers-json` | `mcpServers` | Claude Desktop / Claude Code / Cursor / Cline / Gemini / Windsurf / LM Studio / TRAE / Kimi Code |
 * | `mcpServers-typed-json` | `mcpServers` + `type` | CodeBuddy / Qoder |
 * | `servers-json` | `servers` | VS Code Local harness |
 * | `context_servers-json` | `context_servers` | Zed |
 * | `mcp_servers-toml` | `[mcp_servers.*]` | Codex CLI |
 * | `mcpServers-yaml` | `mcpServers`（数组） | Continue |
 * | `cordis-yaml` | `- insert:` | DeepSeek Harness（DSH） |
 * | `gui` | 无文件 | Cherry Studio / JetBrains |
 *
 * 清单住在 `docs/integrations/clients.json`，宿主（CLI）负责读它；
 * 这里只负责**校验 + 渲染**。所以"加一个客户端"是一次数据改动，
 * 而渲染出来的字节由同一段纯函数决定（R6）。
 */
import { stableJson } from "./json.ts";

/** 清单版本。形状不兼容地变化时才加一。 */
export const CLIENT_MANIFEST_VERSION = 1;

/** 支持的配置形状。新增形状必须同时改 `renderClientConfig` 与测试。 */
export const CLIENT_SHAPES = [
  "mcpServers-json",
  "mcpServers-typed-json",
  "servers-json",
  "context_servers-json",
  "mcp_servers-toml",
  "mcpServers-yaml",
  "cordis-yaml",
  "gui",
] as const;

export type ClientShape = (typeof CLIENT_SHAPES)[number];

/** 支持级别：p0 必须覆盖，p1 正式支持，p2 只给通用模板。 */
export const CLIENT_TIERS = ["p0", "p1", "p2"] as const;
export type ClientTier = (typeof CLIENT_TIERS)[number];

/** 配置作用域。`both` = 用户级与项目级都支持。 */
export const CLIENT_SCOPES = ["user", "project", "workspace", "both", "varies"] as const;
export type ClientScope = (typeof CLIENT_SCOPES)[number];

/** 只生成这三类平台的路径与启动方式；其他平台不属于个人版。 */
export const CLIENT_PLATFORMS = ["win32", "darwin", "linux"] as const;
export type ClientPlatform = (typeof CLIENT_PLATFORMS)[number];

/**
 * 清单里的路径键。故意用人读的名字（windows / macos），
 * 而不是 Node 的 `process.platform` 值——清单是给人改的，
 * 平台映射只在 `pathHintFor` 一处发生。
 */
export const CLIENT_PATH_KEYS = ["windows", "macos", "linux"] as const;

export interface ClientEntry {
  /** 稳定的 kebab-case id；`forge mcp-config --client <id>` 用它。 */
  id: string;
  name: string;
  tier: ClientTier;
  shape: ClientShape;
  scope: ClientScope;
  /** 只支持本地 stdio；远程 MCP 属于托管版，个人版明确不做。 */
  transport: "stdio";
  /** 平台 → 配置文件路径的人读提示。GUI 客户端可以为空。 */
  paths: Record<string, string>;
  notes?: string;
}

export interface ClientManifest {
  manifest_version: number;
  clients: ClientEntry[];
}

/** 从清单渲染出来的启动方式。命令与参数都是**绝对路径**，不依赖 cwd / PATH。 */
export interface McpLaunchSpec {
  command: string;
  args: string[];
}

export type RenderFormat = "json" | "toml" | "yaml" | "text";

export interface RenderClientOptions {
  platform: ClientPlatform;
  /** MCP server 在配置里的名字。默认 `forge`。 */
  serverName?: string;
}

export interface RenderedClientConfig {
  id: string;
  name: string;
  shape: ClientShape;
  format: RenderFormat;
  /** 可直接写进文件或粘进 UI 的片段；JSON/TOML/YAML 均以一个换行结尾。 */
  content: string;
  /** 当前平台的配置位置提示（原始清单值，未展开 `~` / `%VAR%`）。 */
  pathHint: string | null;
  /** 给 stderr 用的短提示；stdout 只放 `content`。 */
  instructions: string[];
}

export type ManifestVerdict =
  | { ok: true; manifest: ClientManifest }
  | { ok: false; issues: string[] };

/**
 * 校验清单。判据写成"能指出是哪一条、错在哪"，因为清单是给人改的。
 *
 * @param value JSON.parse 的结果
 * @returns 通过时返回规范化后的清单；失败时返回问题列表
 */
export function validateClientManifest(value: unknown): ManifestVerdict {
  const issues: string[] = [];
  if (!isRecord(value)) return { ok: false, issues: ["清单必须是一个 JSON 对象"] };

  if (value["manifest_version"] !== CLIENT_MANIFEST_VERSION) {
    issues.push(`manifest_version 必须是 ${String(CLIENT_MANIFEST_VERSION)}`);
  }
  const rawClients = value["clients"];
  if (!Array.isArray(rawClients) || rawClients.length === 0) {
    return { ok: false, issues: [...issues, "clients 必须是非空数组"] };
  }

  const clients: ClientEntry[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of rawClients.entries()) {
    const at = `clients[${String(index)}]`;
    if (!isRecord(raw)) {
      issues.push(`${at} 必须是对象`);
      continue;
    }
    const id = typeof raw["id"] === "string" ? raw["id"] : "";
    const label = id.length > 0 ? `clients[${String(index)}]（${id}）` : at;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      issues.push(`${label} 的 id 必须是 kebab-case（a-z、0-9、-）`);
    } else if (seen.has(id)) {
      issues.push(`${label} 的 id 重复`);
    } else {
      seen.add(id);
    }

    const name = typeof raw["name"] === "string" ? raw["name"] : "";
    if (name.trim().length === 0) issues.push(`${label} 缺少 name`);

    if (!isOneOf(raw["tier"], CLIENT_TIERS)) issues.push(`${label} 的 tier 必须是 ${CLIENT_TIERS.join(" / ")}`);
    if (!isOneOf(raw["shape"], CLIENT_SHAPES)) {
      issues.push(`${label} 的 shape 必须是 ${CLIENT_SHAPES.join(" / ")}`);
    }
    if (!isOneOf(raw["scope"], CLIENT_SCOPES)) {
      issues.push(`${label} 的 scope 必须是 ${CLIENT_SCOPES.join(" / ")}`);
    }
    if (raw["transport"] !== "stdio") {
      issues.push(`${label} 的 transport 只能是 stdio（个人版不做远程 MCP）`);
    }

    const paths = raw["paths"];
    if (!isRecord(paths)) {
      issues.push(`${label} 的 paths 必须是对象（GUI 客户端用空对象）`);
    } else {
      for (const [key, path] of Object.entries(paths)) {
        if (!(CLIENT_PATH_KEYS as readonly string[]).includes(key)) {
          issues.push(`${label} 的 paths 有未知平台键 ${key}（只认 ${CLIENT_PATH_KEYS.join(" / ")}）`);
        }
        if (typeof path !== "string" || path.trim().length === 0) {
          issues.push(`${label} 的 paths.${key} 必须是非空字符串`);
        }
      }
    }

    if (raw["notes"] !== undefined && typeof raw["notes"] !== "string") {
      issues.push(`${label} 的 notes 必须是字符串`);
    }

    if (
      id.length > 0 &&
      isOneOf(raw["tier"], CLIENT_TIERS) &&
      isOneOf(raw["shape"], CLIENT_SHAPES) &&
      isOneOf(raw["scope"], CLIENT_SCOPES) &&
      raw["transport"] === "stdio" &&
      isRecord(paths) &&
      name.trim().length > 0
    ) {
      clients.push({
        id,
        name,
        tier: raw["tier"],
        shape: raw["shape"],
        scope: raw["scope"],
        transport: "stdio",
        paths: Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, String(path)])),
        ...(typeof raw["notes"] === "string" ? { notes: raw["notes"] } : {}),
      });
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, manifest: { manifest_version: CLIENT_MANIFEST_VERSION, clients } };
}

/**
 * 生成启动方式。
 *
 * Windows 指向仓库根的 `forge-mcp.cmd`（稳定入口；不要求客户端理解 tsx），
 * 其他平台指向仓库内的 tsx + MCP 入口。**全部绝对路径**：
 * 客户端的 cwd 与 PATH 不可控，让用户去猜就是让配置在别人机器上失败。
 *
 * @param platform 目标平台
 * @param repoRoot 仓库绝对路径
 * @param vault 资产库绝对路径
 * @returns 命令与参数
 */
export function buildMcpLaunch(platform: ClientPlatform, repoRoot: string, vault: string): McpLaunchSpec {
  const root = nativePath(platform, repoRoot);
  const target = nativePath(platform, vault);
  if (platform === "win32") {
    return {
      command: "cmd",
      args: ["/c", joinNative(platform, root, "forge-mcp.cmd"), "--vault", target],
    };
  }
  return {
    command: "node",
    args: [
      joinNative(platform, root, "node_modules/tsx/dist/cli.mjs"),
      joinNative(platform, root, "apps/mcp/src/main.ts"),
      "--vault",
      target,
    ],
  };
}

/**
 * 把一个客户端渲染成可直接粘贴的片段。
 *
 * @param client 清单里的一条
 * @param launch `buildMcpLaunch` 的结果
 * @param options 平台与 server 名
 * @returns 片段、格式与路径提示
 */
export function renderClientConfig(
  client: ClientEntry,
  launch: McpLaunchSpec,
  options: RenderClientOptions,
): RenderedClientConfig {
  const name = options.serverName ?? "forge";
  const pathHint = pathHintFor(client, options.platform);
  const instructions = pathHint === null ? [] : [`配置位置：${pathHint}`];
  if (client.notes !== undefined) instructions.push(client.notes);

  switch (client.shape) {
    case "mcpServers-json":
      return rendered(client, pathHint, instructions, "json", stableJson({ mcpServers: { [name]: launch } }));
    case "mcpServers-typed-json":
      return rendered(
        client,
        pathHint,
        instructions,
        "json",
        stableJson({ mcpServers: { [name]: { type: "stdio", ...launch } } }),
      );
    case "servers-json":
      return rendered(
        client,
        pathHint,
        instructions,
        "json",
        stableJson({ servers: { [name]: { type: "stdio", ...launch } } }),
      );
    case "context_servers-json":
      return rendered(client, pathHint, instructions, "json", stableJson({ context_servers: { [name]: launch } }));
    case "mcp_servers-toml":
      return rendered(client, pathHint, instructions, "toml", renderToml(name, launch));
    case "mcpServers-yaml":
      return rendered(client, pathHint, instructions, "yaml", renderYaml(name, launch));
    case "cordis-yaml":
      return rendered(client, pathHint, instructions, "yaml", renderCordisYaml(name, launch));
    case "gui":
      return rendered(client, pathHint, instructions, "text", renderGuiFields(name, launch));
  }
}

/**
 * 列出清单。顺序就是清单顺序（显式、可审），不按 id 重排。
 *
 * @param manifest 已校验的清单
 * @param platform 当前平台（决定路径提示）
 * @returns 制表符分隔的文本
 */
export function formatClientList(manifest: ClientManifest, platform: ClientPlatform): string {
  const lines = ["id\ttier\tshape\t配置位置"];
  for (const client of manifest.clients) {
    const hint = pathHintFor(client, platform) ?? "（在客户端 UI 里填）";
    lines.push(`${client.id}\t${client.tier}\t${client.shape}\t${hint}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * 当前平台的配置路径提示。
 *
 * @param client 清单条目
 * @param platform 平台
 * @returns 路径或 null
 */
export function pathHintFor(client: ClientEntry, platform: ClientPlatform): string | null {
  const key = platform === "win32" ? "windows" : platform === "darwin" ? "macos" : "linux";
  const value = client.paths[key];
  return value === undefined ? null : value;
}

/**
 * @param client
 * @param pathHint
 * @param instructions
 * @param format
 * @param content
 * @returns
 */
function rendered(
  client: ClientEntry,
  pathHint: string | null,
  instructions: string[],
  format: RenderFormat,
  content: string,
): RenderedClientConfig {
  return { id: client.id, name: client.name, shape: client.shape, format, content, pathHint, instructions };
}

/**
 * TOML 的基本字符串与 JSON 字符串在转义上兼容（`\\`、`\"`、`\n` 等），
 * 所以直接借 `JSON.stringify`，不手写一套会漏掉边角的转义。
 *
 * @param value
 * @returns
 */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * @param name
 * @param launch
 * @returns
 */
function renderToml(name: string, launch: McpLaunchSpec): string {
  const lines = [`[mcp_servers.${name}]`, `command = ${tomlString(launch.command)}`, "args = ["];
  for (const arg of launch.args) lines.push(`  ${tomlString(arg)},`);
  lines.push("]");
  return `${lines.join("\n")}\n`;
}

/**
 * Continue 的 `mcpServers` 是**数组**，不是对象——这是它和别家最容易混淆的一处。
 *
 * @param name
 * @param launch
 * @returns
 */
function renderYaml(name: string, launch: McpLaunchSpec): string {
  const lines = [
    `name: ${yamlString(name)}`,
    "version: 0.0.1",
    "schema: v1",
    "mcpServers:",
    `  - name: ${yamlString(name)}`,
    `    command: ${yamlString(launch.command)}`,
    "    args:",
  ];
  for (const arg of launch.args) lines.push(`      - ${yamlString(arg)}`);
  return `${lines.join("\n")}\n`;
}

/**
 * DeepSeek Harness（DSH）没有 `mcp.json`：一个 MCP server 就是
 * `cordis.patch.yml` 里的一条 `insert` 插件配置（`@deepseek-ai/dsh-mcp-client`）。
 *
 * 生成的是**可直接粘进 patch 文件**的最小片段；`id` 用 `mcp-<name>`，
 * 与 DSH 讨论区里的示例一致。同名 serverName 会直接报错，所以不要把两份
 * 不同 forge 库渲染成同一个 `serverName`——需要两个库时把 `--client` 结果里的
 * `serverName` 与 `id` 一起改名。
 *
 * @param name
 * @param launch
 * @returns
 */
function renderCordisYaml(name: string, launch: McpLaunchSpec): string {
  const lines = [
    "- insert:",
    `    - id: ${yamlString(`mcp-${name}`)}`,
    `      name: ${yamlString("@deepseek-ai/dsh-mcp-client")}`,
    "      config:",
    `        serverName: ${yamlString(name)}`,
    `        transport: ${yamlString("stdio")}`,
    `        command: ${yamlString(launch.command)}`,
    "        args:",
  ];
  for (const arg of launch.args) lines.push(`          - ${yamlString(arg)}`);
  return `${lines.join("\n")}\n`;
}

/**
 * YAML 双引号标量可以接受 JSON 的转义序列。用引号而不是裸标量，
 * 是因为 Windows 路径里的 `\` 在裸标量里会变成转义歧义。
 *
 * @param value
 * @returns
 */
function yamlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * GUI 客户端没有文件可写，给字段表：用户照着填，不需要理解 JSON。
 *
 * @param name
 * @param launch
 * @returns
 */
function renderGuiFields(name: string, launch: McpLaunchSpec): string {
  const lines = [`Name: ${name}`, "Transport: stdio", `Command: ${launch.command}`, "Args:"];
  for (const arg of launch.args) lines.push(`  - ${arg}`);
  return `${lines.join("\n")}\n`;
}

/**
 * Windows 上用 `\`，其他平台用 `/`。只做分隔符方向转换，
 * 不折叠前缀斜杠（UNC 路径 `\\server\share` 不能被压成 `\server\share`）。
 *
 * @param platform
 * @param value
 * @returns
 */
function nativePath(platform: ClientPlatform, value: string): string {
  return platform === "win32" ? value.replace(/\//g, "\\") : value.replace(/\\/g, "/");
}

/**
 * @param platform
 * @param base
 * @param relative
 * @returns
 */
function joinNative(platform: ClientPlatform, base: string, relative: string): string {
  const sep = platform === "win32" ? "\\" : "/";
  const trimmedBase = nativePath(platform, base).replace(new RegExp(`\\${sep}+$`), "");
  const trimmedRelative = nativePath(platform, relative).replace(new RegExp(`^\\${sep}+`), "");
  return `${trimmedBase}${sep}${trimmedRelative}`;
}

/**
 * @param value
 * @returns
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param value
 * @param options
 * @returns
 */
function isOneOf<T extends string>(value: unknown, options: readonly T[]): value is T {
  return typeof value === "string" && (options as readonly string[]).includes(value);
}
