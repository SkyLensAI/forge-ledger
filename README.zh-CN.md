# Forge

**把会话、文档、PR 编译成带类型、带出处的资产库——并让 CI 阻止它悄悄腐烂。**

本地优先 · 无账号 · 无云端 · 核心链路不需要 API key · 逐字节可复现。

[在线 demo](https://skylensai.github.io/forge-ledger/) · [格式规范](spec/specification.md) · [60 秒开始](#60-秒开始) · [English](README.md)

大多数 AI 记忆工具解决的是**抽取**。抽取没有护城河。
真正的失败模式是静默腐烂：过期的事实、漂移的索引、失去出处的孤儿页、
没人注意已经被取代的决策。
Forge 把「出处」当作硬约束，把「维护」当作产品本身。

---

## 问题

你的决策散在会话、文档、PR 和会议记录里。笔记应用存下文本，RAG 检索片段，
但两者都不会告诉你：这句话现在还成立吗？它从哪来？六周前是不是已经被取代了？

于是知识库会悄悄腐烂：

- **过期事实**仍然带着十足的置信度被注入；
- **索引漂移**，与来源对不上；
- **孤儿页**失去了回到证据的所有路径；
- **被取代的决策**仍被当作当前结论引用。

Forge 把每一条都变成机器可判定的失败，而不是一种感觉。

## Forge 做什么

- **把痕迹编译成四种带类型的资产**：`decision` / `state` / `event` / `rule`，
  各有必填字段与必填章节。
- **出处是硬约束**：每条资产都必须解析到来源里的一个 span（`file://…` 或
  内容寻址的 `src://…`）。解析不到，就不是资产。
- **模型产出永远进不了正式库**：模型可以提议候选，但 `origin === "model"`
  不可配置地不能直接入库；候选停在 `_inbox/`，等人确认。
- **维护是产品本身**：`forge health` 报四类腐烂，`forge confirm` 由人回答
  「这条状态还成立吗」，`forge audit` 校验只追加的哈希链。
- **产出可复现**：同一份输入、同一份字节——CLI、确定性投影和静态 demo 都一样。

## 60 秒开始

需要 **Node ≥ 24**、**pnpm ≥ 12**。

```bash
git clone https://github.com/SkyLensAI/forge-ledger.git
cd forge-ledger
pnpm install
pnpm forge lint --repo      # 审核 46 条带类型的资产，每条都对着来源
pnpm demo:open              # 从本仓库自己的库重新生成 demo/ 并打开
```

全程不需要 API key。这个仓库就是自己的语料：`docs/adr/` 里的 46 条 ADR 是资产，
`demo/` 是它们逐字节相同的投影。

直接用原生命令也可以：`pnpm forge <命令>`。Windows 上另有
`forge.cmd`、`forge.ps1`、`forge-mcp.cmd`、`forge-mcp.ps1`。

## 架构

```text
 会话导出 / 文档 / PR / 会议
             │
             ▼
         compile ──────────► sources/  只读、内容寻址
             │                 assets/   带类型、出处必填
             │                 index/    可重建、本地 SQLite
             ▼
  extract（可选模型）────────► _inbox/   只放候选，永不直接进 assets/

 assets ──► lint / 闸门 ──► emit ──► AGENTS.md · INDEX.md · adr/ · Skill · demo
 assets ──► context ──────► CLI · MCP server · 浏览器扩展（同一份判定）
 assets ──► health ───────► 腐烂报告 · 到期确认 · 审计链 · 周报
```

CLI、MCP server 和浏览器桥共用同一份取用判定；测试逐字节断言三者输出相同。

## 接到你的工具里

```bash
pnpm forge context "存储后端怎么选"                 # 预算内注入，绝不预加载全库
pnpm forge mcp-config --client cursor --vault data # 可直接粘贴的客户端配置
pnpm mcp --vault data                              # MCP server（stdio，四个工具）
pnpm forge health --today 2026-11-16               # 只读的健康检查
pnpm forge audit --verify                          # 校验写入的哈希链
```

Claude Desktop / Claude Code / Cursor 的复制即用配置见
[`docs/handbook/mcp.md`](docs/handbook/mcp.md)。

## 为什么不只是一个笔记应用？

| | 笔记 / PKM | RAG 记忆 | Forge |
|---|---|---|---|
| 知识单位 | 一页 | 一个片段 | 一条带必填字段的类型化断言 |
| 出处 | 可选链接 | chunk ID | **硬约束**，必须解析到来源 span |
| 新鲜度 | 手工 | 无 | `last_confirmed` + 到期队列 + `forge confirm` |
| 取代关系 | 手工 | 无 | 显式 `supersedes` 链，永不静默覆盖 |
| 失败模式 | 悄悄腐烂 | 悄悄腐烂 | **CI 报红** |
| 产出 | 应用内数据 | 向量 | 可 diff 的确定性文件 |

Forge 不试图替代你的编辑器。它是编辑器下面的账本：
断言、证据、过期时间在这里是同一个对象。

## 今天到底什么是真的

如实记账是设计的一部分。短版本：

- **46 条 ADR**、**477 条测试**、**10 条真实回归**（8 条进 CI，另 2 条明确记为
  无法自动执行）。
- **demo 从本仓库自己的库生成**，不是编造的样例数据。
- **模型抽取可以从录像回放**（不需要 key），但**真实端点的抽取质量没有数据**——
  CI 里没有 API key。仓库不会把一段合成录像冒充成模型分数。
- **浏览器扩展没有被真的装进浏览器测过**。CI 检查的是结构，不是 DOM 胶水。
- **团队版按设计未启动**——没有付费信号，所以权限 / 并发 / 敏感度能力都还不存在。
- **还没有发布 npm 包**。当前安装方式是 clone + `pnpm install`；发布门与
  preflight 已就位，但发布仍需要 npm scope、凭据和人的决定。

完整工程记录——Phase 表、实测读数、已知缺口以及强制它们的闸门——在
[`STATUS.md`](STATUS.md)。

## 五道闸门，一份策略

| # | 闸门 | 载体 |
|---|---|---|
| 1 | agent hook | `.claude/settings.json` → `scripts/gates/agent-guard.mjs` |
| 2 | pre-commit | `.githooks/pre-commit` |
| 3 | required CI check | `pnpm gate:trusted` + `pnpm gate:ci` |
| 4 | branch rule | `scripts/gates/setup-branch-protection.sh` |
| 5 | 发布门 | `.github/workflows/release.yml` + 人工审批 |

本地闸门只是早期反馈；**权威在服务端**。判定逻辑只有一份纯函数
（`scripts/gates/lib/policy.mjs`），而且 CI 用基线修订里的闸门来判当前变更——
改松闸门不能给自己发合格证。

## 许可

- **参考实现**（`apps/`、`packages/`、`scripts/`、`evals/`、`schema/`）：
  **AGPL-3.0-only**，见 [`LICENSE`](LICENSE)。
- **规范**（`spec/`、分类法、示例）：**CC0-1.0**——标准的第一要求是零摩擦。
- **文档**：**CC-BY-4.0**。

完整分层见 [`LICENSES/README.md`](LICENSES/README.md)。规范设计为独立仓库发布，
导出产物在 `dist/forge-spec`。

## 参与

先读 [`STATUS.md`](STATUS.md)：它列出哪些被测量过、哪些是刻意没做、哪些已知缺失。
一份承认缺口的 backlog，比一份不承认的 roadmap 更有用。
