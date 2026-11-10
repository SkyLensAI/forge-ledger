# Forge · 上架包（draft）

> **状态：draft。没有提交、没有发布、没有出现在任何市场里。** 本目录由 `forge listing --repo --out listing` 从**本仓库自己的资产**生成。

- 插件名：`forge`
- 版本：`0.0.0`（默认值，不是一次已发布的版本）
- 资产：44 条（decision 44）
- 入口：`plugins/forge/skills/forge/SKILL.md`

## 里面有什么

| 文件 | 消费者 | 作用 |
|---|---|---|
| `.claude-plugin/marketplace.json` | 市场 | 一份可被市场读取的条目 |
| `plugins/<name>/.claude-plugin/plugin.json` | Claude Code | 插件清单（Skill + MCP） |
| `plugins/<name>/.mcp.json` | MCP 宿主 | 启动 `forge-mcp` 并指向库目录 |
| `plugins/<name>/skills/<name>/SKILL.md` | Skill 加载器 | 规则与索引；决策全文在 `references/` 按需读 |
| `manifest.json` | 机器 | 状态、计数与未完成项 |
| `SUBMISSION.md` | 人 | 上架之前必须由人完成的清单 |

## 为什么是 draft

上架需要人：账号、仓库 URL、一个真正可安装的 `forge-mcp` 包、以及平台审核。代码能做的是把条目生成对，不能替人按提交按钮。所以这个目录**不会**自称 `published`——一份自称已上架的生成物，会让下一个人以为最花时间的那一步已经做完了。

## 重新生成

```bash
node apps/cli/src/main.ts listing --repo --out listing          # 写盘
node apps/cli/src/main.ts listing --repo --out listing --check  # 只比对，不写盘
```
