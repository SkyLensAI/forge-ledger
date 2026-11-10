# 上架清单（人来做）

机器已经做完的：生成 marketplace / plugin 清单、Skill、MCP 配置，并保证它们可以逐字节重生成。

## 机器已完成

- [x] `.claude-plugin/marketplace.json`
- [x] 插件清单（`forge` 0.0.0）
- [x] Skill（`SKILL.md` + `references/`）
- [x] MCP 配置（`.mcp.json` 与 plugin 清单同源）
- [x] 未完成项与 draft 状态写进 `manifest.json`

## 必须由人完成

- [ ] 让 `forge-mcp` 成为一个真正可安装的命令（当前 workspace 包是 `private: true`）。
- [ ] 填写真实的 repository / homepage / author：生成器**不编造**这些字段。
- [ ] 在平台上提交条目，并按平台要求提供隐私说明与支持渠道。
- [ ] 审核通过之后，**由人**把 `manifest.json` 的 `published` 改成 true，并记录在哪一天上的架。

## 判据

`published: true` 不是一句宣告，是一条需要证据的状态：市场条目 URL、审核通过的通知、以及一个装得上的包。三者缺一，它就该一直是 `false`。
