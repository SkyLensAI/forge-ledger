# MCP 客户端清单

`clients.json` 是**唯一一份**客户端清单。`forge mcp-config` 读它、校验它、按形状渲染；
`docs/handbook/mcp.md` 只解释怎么用，不再抄一份路径表。

## 为什么是数据，不是十份文档

同一台 server，不同客户端只差三件事：**配置形状**、**文件位置**、**作用域**。
把这三件事写成数据之后：

- 加一个客户端 = 加一行；
- 形状写错 = `forge mcp-config --list` 直接报出是哪一条；
- 文档与配置片段不会彼此漂移，因为片段是从清单渲染出来的。

渲染逻辑在 `packages/core/src/integrations.ts`（纯函数、零 IO，R5）。

形状的含义：

| 形状 | 顶层结构 | 典型客户端 |
|---|---|---|
| `mcpServers-json` | `{ "mcpServers": { "forge": { command, args } } }` | Claude / Cursor / TRAE / Kimi Code |
| `mcpServers-typed-json` | 同上，但显式带 `"type": "stdio"` | CodeBuddy / Qoder |
| `servers-json` | `{ "servers": { "forge": { type, command, args } } }` | VS Code Local harness |
| `context_servers-json` | `{ "context_servers": { "forge": { command, args } } }` | Zed |
| `mcp_servers-toml` | `[mcp_servers.forge]` | Codex CLI |
| `mcpServers-yaml` | `mcpServers` 是**数组** | Continue |
| `cordis-yaml` | `- insert:` 插件配置 | DeepSeek Harness |
| `gui` | 字段表 | Cherry Studio / JetBrains |

## 字段

| 字段 | 含义 |
|---|---|
| `id` | kebab-case 稳定标识；`forge mcp-config --client <id>` 用它 |
| `name` | 人读的名字 |
| `tier` | `p0` 必须覆盖 / `p1` 正式支持 / `p2` 只给通用模板 |
| `shape` | `mcpServers-json` / `mcpServers-typed-json` / `servers-json` / `context_servers-json` / `mcp_servers-toml` / `mcpServers-yaml` / `cordis-yaml` / `gui` |
| `scope` | `user` / `project` / `workspace` / `both` / `varies` |
| `transport` | 只能是 `stdio`——个人版不做远程 MCP |
| `paths` | `windows` / `macos` / `linux` → 配置位置提示；GUI 客户端用空对象 |
| `notes` | 给 stderr 的一两句注意事项 |

## 加一个客户端

1. 在这里加一行；
2. `pnpm forge mcp-config --list` 确认它出现；
3. `pnpm forge mcp-config --client <id>` 确认片段能直接粘；
4. `pnpm check`。

如果引入了新的 `shape`，必须同时改 `renderClientConfig` 与
`packages/core/test/integrations.test.ts`——**新形状不是一行数据能覆盖的**，
它是一段新的渲染规则。

## 不承诺的事

`p2` 条目只给通用模板。长尾客户端（5ire / Witsy / ChatWise / Msty / Open WebUI / Trae /
Qoder / CodeBuddy / 通义灵码 等）没有回归测试，就不进“官方支持”。
