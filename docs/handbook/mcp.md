# 把 forge 接进桌面客户端（MCP · stdio）

这是 docs/personal.md 迭代 1 与 docs/personal2.md 的落地页：**一条命令、一份片段，不动代码**。

先说边界，避免接错东西：

- 只暴露**四个只读工具**：`forge_context` / `forge_search` / `forge_get` / `forge_lint`；
- **没有写入工具**（`promote` / `confirm` / `conflicts --resolve` 仍然只能在 CLI 里由人执行）；
- **只有 stdio**，没有 HTTP / SSE，不监听端口；
- **不需要 API key**，不访问网络；
- 第一次调用之前请确认 `--vault` 指向的是你的库（默认是当前目录下的 `data/`）。

> 判定不在客户端、也不在 MCP server 里：所有宿主（CLI / MCP / 浏览器桥）调的是同一个
> `vault.context()`。所以 **MCP 返回的注入与 `forge context` 逐字节相同**，这条性质由
> `apps/mcp/test/server.test.ts` 与 `apps/cli/test/context.test.ts` 各断言一次。

---

## 0. 最快路径：让 forge 生成配置

客户端的差异只有**配置形状**（`mcpServers` / `servers` / `context_servers` / TOML / YAML / GUI），
MCP server 本身不变。所以清单只有一份：

```
docs/integrations/clients.json
```

看当前支持哪些客户端：

```bash
pnpm forge mcp-config --list
```

给某个客户端生成片段：

```bash
# Windows（路径与启动命令都按 win32 生成）
pnpm forge mcp-config --client cursor --vault D:/projects/my-vault --platform win32

# macOS / Linux
pnpm forge mcp-config --client claude-desktop --vault ~/my-vault --platform darwin
```

约定：

- **stdout 只有片段本身**（JSON / TOML / YAML / GUI 字段表），可以直接重定向：
  `pnpm forge mcp-config --client cursor > mcp.json`；
- 配置位置、注意事项、资产库路径全部走 **stderr**；
- 启动命令一律**绝对路径**，不依赖客户端的 cwd 或 PATH；
- Windows 上生成 `cmd /c "<仓库>\forge-mcp.cmd" --vault <库>`；
  macOS / Linux 上生成 `node <仓库>/node_modules/tsx/dist/cli.mjs <仓库>/apps/mcp/src/main.ts --vault <库>`。

> `--platform` 改的是**路径分隔符与启动方式**，仓库根与库路径仍然来自当前 checkout。
> 给另一台机器生成配置时，在**那台机器**上跑 `forge mcp-config`，不要在一台机器上
> 替另一台猜绝对路径。

**为什么 Windows 用 tsx：** Node 24 的原生类型擦除拒绝执行 `node_modules` 下的 `.ts`；
没有符号链接权限时，pnpm 用 junction 链接 workspace 包，`@forge/*` 的解析结果仍然落在
`node_modules` 里，直接跑会得到 `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`。
tsx 只是启动垫片，不产生构建产物，也不改变 ADR-0011 的零 build。

---

## 1. P0：个人版必须覆盖

| 客户端 | 形状 | 配置位置 | 生成命令 |
|---|---|---|---|
| **VS Code + Copilot（Local harness）** | 顶层 `servers` | `.vscode/mcp.json` | `--client vscode` |
| **VS Code + Copilot（Copilot harness）** | 顶层 `mcpServers` | `.mcp.json` 或 `%COPILOT_HOME%\mcp-config.json` | `--client vscode-copilot` |
| **Cherry Studio** | GUI 字段 | 设置 → MCP → MCP 服务器 → 添加 | `--client cherry-studio` |
| **Cline** | `mcpServers` | MCP Servers 面板 → Configure | `--client cline` |
| **Roo Code** | `mcpServers` | MCP Servers 面板 → Configure | `--client roo-code` |
| **Claude Desktop** | `mcpServers` | `%APPDATA%\Claude\claude_desktop_config.json` | `--client claude-desktop` |
| **Claude Code** | `mcpServers` | 项目根 `.mcp.json` | `--client claude-code` |
| **Cursor** | `mcpServers` | `~/.cursor/mcp.json` 或项目 `.cursor/mcp.json` | `--client cursor` |

### VS Code：两个 harness，键名不同

- **旧 Local harness**（`.vscode/mcp.json`）用顶层 **`servers`**，条目里带 `"type": "stdio"`。
  这是 `--client vscode` 生成的形状。
- **新 Copilot harness** 用顶层 **`mcpServers`**，位置是工作区根的 `.mcp.json`
  或 `%COPILOT_HOME%\mcp-config.json`（未设置时 `~/.copilot/mcp-config.json`）。
  这是 `--client vscode-copilot` 生成的形状。

Copilot harness 正在取代 Local harness；**新配置优先用 `vscode-copilot`**。
两个都留在清单里，是因为装了哪个 harness 不是 forge 能替用户决定的。

### Cherry Studio / Cline / Roo Code

这三个客户端用 GUI 或“打开配置文件”的按钮管理 MCP，没有稳定的单一文件路径。
`forge mcp-config` 给的是**字段表**或一段 `mcpServers` JSON：

- Cherry Studio：传输方式选 **stdio**，Command / Args 照字段表填；
- Cline / Roo Code：在 MCP Servers 面板点 Configure，把 `mcpServers` 片段合并进去。

---

## 2. P1：值得正式支持

| 客户端 | 形状 | 配置位置 | 生成命令 |
|---|---|---|---|
| **Codex CLI** | `[mcp_servers.forge]` TOML | `~/.codex/config.toml` | `--client codex` |
| **Gemini CLI** | `mcpServers` | `~/.gemini/settings.json` | `--client gemini-cli` |
| **Windsurf** | `mcpServers` | `~/.codeium/windsurf/mcp_config.json` | `--client windsurf` |
| **JetBrains AI Assistant / Junie** | GUI / `.junie/mcp.json` | Settings → Tools → AI Assistant → MCP | `--client jetbrains` |
| **Continue** | `mcpServers` **数组**（YAML） | `.continue/mcpServers/forge.yaml` | `--client continue` |
| **Zed** | 顶层 `context_servers` | `~/.config/zed/settings.json` | `--client zed` |
| **LM Studio** | `mcpServers` | `~/.lmstudio/mcp.json` | `--client lm-studio` |
| **TRAE** | `mcpServers` | 项目根 `.trae/mcp.json` | `--client trae` |
| **CodeBuddy** | `mcpServers` + `type` | `~/.codebuddy/.mcp.json` / 项目 `.mcp.json` | `--client codebuddy` |
| **Qoder** | `mcpServers` + `type` | `~/.qoder/settings.json` / `.qoder/settings.json` | `--client qoder` |
| **DeepSeek Harness（DSH）** | `cordis.patch.yml` 的 `insert` | `~/.dsh/cordis.patch.yml` / `.dsh/cordis.patch.yml` | `--client deepseek-harness` |
| **Kimi Code** | `mcpServers` | `~/.kimi-code/mcp.json` / `.kimi-code/mcp.json` | `--client kimi-code` |

几个容易写错的点，生成器已经替你处理：

- **Codex 是 TOML，键名是 snake_case 的 `mcp_servers`**，不是 JSON 的 `mcpServers`；
- **Continue 的 `mcpServers` 是数组**，不是对象；
- **Zed 的顶层键是 `context_servers`**，不是 `mcpServers`；
- **CodeBuddy / Qoder 显式写 `"type": "stdio"`**；它们的 `type` 可以省略、默认 stdio，但写出来最不容易被版本差异咬到；
- **DeepSeek Harness 没有 `mcp.json`**：一个 server 就是 `cordis.patch.yml` 里的一条 `insert`，
  而且要先装 `@deepseek-ai/dsh-mcp-client`（版本对齐你的 `dsh`），详见下面。

### TRAE

项目级配置放在项目根 `.trae/mcp.json`，用 `mcpServers` 声明。
首次使用要在 **设置 → MCP** 打开「启用项目级 MCP」并在弹窗里确认；
全局 MCP 仍然在 **设置 → MCP** 里手动添加。stdio 的 `command` 必须是 PATH 里的命令或完整路径。

### CodeBuddy

- 用户级推荐 `~/.codebuddy/.mcp.json`（旧路径 `~/.codebuddy/mcp.json` 已弃用）；
- 项目级推荐项目根 `.mcp.json`（旧路径 `mcp.json` 已弃用）；
- 支持 **JSONC**（注释与尾逗号），生成的纯 JSON 是它的子集；
- 项目级 server 首次连接需要人工批准。

### Qoder

用户级 `~/.qoder/settings.json`，项目级 `.qoder/settings.json`，顶层 `mcpServers`。
`type` 省略时默认 stdio；生成器显式写出。也可以用
`qoder mcp add forge -- <command> <args>`。

### DeepSeek Harness（DSH）

DSH 没有独立的 `mcp.json`，一个 MCP server 就是 profile patch 里的一行。
先安装 plugin（版本要和 `dsh --version` 对齐，不要用默认的旧 dist-tag）：

```bash
dsh plugin --profile web add @deepseek-ai/dsh-mcp-client@<你的 dsh 版本>
```

然后把生成片段并入 `~/.dsh/cordis.patch.yml`（项目级 `.dsh/cordis.patch.yml`），再重启 `dsh web`。
`serverName` 必须全局唯一；要接两个 forge 库时，把片段里的 `serverName` 与 `id` 一起改名。

### Kimi Code

用户级 `~/.kimi-code/mcp.json`（可用 `KIMI_CODE_HOME` 迁移目录），项目级 `.kimi-code/mcp.json`。
同名时项目级覆盖用户级。**项目级 stdio server 会在会话启动时执行命令**，
只应在可信仓库里启用。也可以用 `kimi mcp add`。

---

## 3. P2：只给通用模板，不承诺

```bash
pnpm forge mcp-config --client generic-mcp-servers
```

适用于 5ire / Witsy / ChatWise / Msty 等长尾 `mcpServers` 客户端。
**Open WebUI 通常需要 `mcpo` 之类的代理**才能接 stdio；其他客户端需逐个验证，
不进“官方支持”。TRAE / CodeBuddy / Qoder / DeepSeek Harness / Kimi Code 已经验证过，
放在上面的 P1 表里。

---

## 4. 冒烟测试（任何客户端通用）

配好之后，先跑同一个测试，不要一上来就怀疑模型：

```bash
pnpm mcp:smoke --vault <库>
```

它自己造一个临时库（一条带可解析出处的 rule），然后检查五件事：

1. `initialize` 回一个双方都支持的协议版本；
2. `tools/list` 回**四个**工具，名字与顺序都对；
3. `forge_context` 回一段预算内、且每条都带可解析出处的注入；
4. `forge_lint` 正常；
5. **stdout 里只有 JSON-RPC**（一行日志就会让客户端解析失败）。

也可以完全接管启动方式，验证客户端实际会执行的那条命令：

```bash
node scripts/mcp-smoke.mjs --command cmd -- /c "D:\forge\forge1.1\forge-mcp.cmd" --vault "D:\forge\forge1.1\data"
```

> 手工跑服务时：**stdout 只放协议消息**，诊断都走 stderr。粘贴下面三行即可：
>
> ```json
> {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}
> {"jsonrpc":"2.0","method":"notifications/initialized"}
> {"jsonrpc":"2.0","id":2,"method":"tools/list"}
> ```

---

## 5. 接通之后怎么验证“是同一段字节”

在仓库根跑（**不要加 `--today` / `--budget`**，否则参数不同、字节本来就不该相同）：

```bash
pnpm forge context "索引层的存储后端怎么选" --vault <库>
```

再在客户端里让模型调用 `forge_context`，参数只用同一句查询。两边文本必须**逐字节相同**。
相同性只对**同一组输入**成立；`--vault` 指到不同的库，或一边传了 `today`/`budget`
而另一边没传，结果不同是正常的，不是判定漂移。

---

## 6. 加一个新客户端

1. 在 `docs/integrations/clients.json` 加一行（id、name、tier、shape、scope、paths、notes）；
2. `pnpm forge mcp-config --list` 确认它出现了；
3. `pnpm forge mcp-config --client <id>` 确认片段形状正确；
4. 如果引入了新形状，改 `packages/core/src/integrations.ts` 的 `renderClientConfig`
   与 `packages/core/test/integrations.test.ts`；
5. 跑 `pnpm check`。

**支持一个客户端 = 加一行数据**，而不是写一套新的集成代码。

---

## ⛔ 没做什么（如实记账）

1. **没有自动改客户端配置。** 三家客户端的配置位置、权限模型与 UI 各不相同，
   脚本替人写它等于把一个可回滚的手工步骤变成一次不可见的系统改动。复制粘贴是刻意的。
2. **没有 HTTP / SSE 传输。** 公网或远程 MCP 需要鉴权、限流、审计与敏感度隔离；
   个人版明确不做（docs/personal.md 第二节）。
3. **没有写入工具。** 确认、判决与改写仍然是 CLI 里带 `--date` / `--note` / `--rationale`
   的人工动作（ADR-0028）。
4. **没有把 `@forge/mcp` 发布成可全局安装的包。** 当前仍是 `private: true`，
   所以配置里启动的是**仓库内源码**。发布路径见 README 的 S31 一节。
5. **P1 的路径是“当前版本的常见位置”，不是永久契约。** 客户端会搬家；
   清单里的 `paths` 是提示，不是保证。接不上时以客户端自己的文档为准。
