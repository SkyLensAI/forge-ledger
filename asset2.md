## 💻 工程师

# 可复用资产全清单

下面这张清单按**"谁来消费"**分层——因为消费方决定了价值、腐烂速度和能不能收钱。最后一栏是我给每类的定价潜力判断。

先给一个前提：**原始会话不是资产，是原料**（冗长、含试探性错误和幻觉）。它独家的产出是"为什么这么选"的理由，这个理由别处不存。同理，一次性的问答、模型的幻觉内容都是噪声。

---

## A 层 · 运行时资产（机器每个会话都消费）——价值最高

| # | 资产 | 原料来源 | 消费方 | 腐烂速度 | 可否事后重建 |
|---|---|---|---|---|---|
| A1 | **规则文件 / 常驻指令**（AGENTS.md、CLAUDE.md、Cursor rules） | 踩坑记录、约定、构建/测试命令 | agent 每会话开头必读 | 快 | 可，但**内容必须是"它本来一定会做错的事"** |
| A2 | **技能包 Skill**（指令+脚本+资源的文件夹，动态加载） | 反复执行的完整工作流 | Claude 及兼容方 | 中 | 部分可 |
| A3 | **MCP connector / plugin** | 工具与数据源接入逻辑 | 所有 agent | 中 | 可 |
| A4 | **记忆条目 / 用户偏好档案** | 对话中的偏好、禁忌、背景 | 跨会话记忆层 | 快（会被推翻） | 否 |
| A5 | **反模式清单（"不要做 X"）** | **真实翻车事件** | agent | 慢 | **否（必须绑定当时）** |
| A6 | **系统提示 / 角色设定（persona）** | 角色、语气、边界定义 | 指定 agent | 慢 | 可 |
| A7 | **Prompt 模板 / 指令片段库** | 好用的问法 | 人 + agent | 慢 | 可 |
| A8 | **工具与权限配置**（工具白名单、沙箱、审批规则） | 治理决策 | 平台层 | 中 | 可 |
| A9 | **护栏 / 策略文件**（安全、合规、敏感度分级） | 合规要求、事故 | 平台层 | 中 | 可 |
| A10 | **文档供给文件**（skill.md、llms.txt） | 对外文档 | 第三方 agent | 中 | 可 |

**A1 的现实提醒**：研究表明这类文件**并不稳定地提升成功率，还会增加成本，而且会不断增长、腐化**；真正有用的是简短、手写、只写"agent 否则一定会做错的事"的那一份 [1]。Addy Osmani 那句判据可以直接当产品需求：**每一行都应能追溯到一个具体出过的问题** [1]。这就是 A5 为什么比 A1 更值钱——**A5 天然满足这条判据。**

---

## B 层 · 结构资产（人与流程消费）

| # | 资产 | 说明 | 腐烂速度 | 可否事后重建 |
|---|---|---|---|---|
| B1 | **决策记录 ADR** | 问题 / 考虑过的选项 / 选中项 / 后果 + 编号 + 状态 [2] | 慢（但会被推翻） | **否** |
| B2 | **活规格 living spec** | 面向一次变更的"做什么、为什么"，并能持续更新 [1][3] | 中 | 否 |
| B3 | **SOP / playbook / runbook** | 可重复执行的流程 | 慢 | 可（但会失真） |
| B4 | **Checklist** | 发布、复盘、交接检查项 | 慢 | 可 |
| B5 | **实体档案页** | 客户 / 项目 / 人 / 想法，**各一页** [4] | 快 | 否 |
| B6 | **状态快照页（state）** | "当前真相"，就地替换 + 日期 [4] | 快 | 否 |
| B7 | **时间线 / 变更史（event）** | 只追加 [4] | 不腐烂 | 否 |
| B8 | **任务清单 / 行动项 / 监控项** | 从对话自动检测出的 TODO/决策/问题 [5] | 快 | 否 |
| B9 | **仪表盘 / 概览页** | 一页看全局 [4] | 快 | 可 |
| B10 | **术语表 / 领域词典** | 内部黑话与定义 | 很慢 | 可 |
| B11 | **接口契约 / schema / 数据字典** | 边界与字段语义 | 中 | 可 |
| B12 | **指标定义（口径）** | 每个指标怎么算、由谁负责 | 慢 | 难 |
| B13 | **组织角色图** | 谁负责什么、找谁 | 中 | 可 |

B1 的规模感值得一提：有人在一个 repo 里四个月攒了 **141 条 ADR**，靠一条规则让 coding agent 在遇到值得记住的决策时主动提议新增 [2]。

---

## C 层 · 交付资产（对外，能卖最贵的价）

| # | 资产 | 原料来源 | 备注 |
|---|---|---|---|
| C1 | **帮助中心文章 / 对外文档** | **支持工单会话** | Zendesk、Zoho Desk 的 Zia 都已内置"从工单会话生成文章" [6][7][8] |
| C2 | **FAQ / 标准问答对** | 重复被问的问题 | 复用率最高 |
| C3 | **销售话术与异议处理** | 通话、赢单/输单复盘 | |
| C4 | **品牌与语气规范（Brand Kit for AI）** | 已有文案、审稿意见 | 已有专门的"给 AI 的品牌套件"概念与公开规范数据集 [9][10] |
| C5 | **模板族** | 邮件、方案、周报、复盘模板 | 一次成型，不腐烂 |
| C6 | **成品交付物** | 报告、方案、提案 | 单次价值最高、复用性最低 |
| C7 | **培训与入职材料** | 老员工隐性知识 | |
| C8 | **可上架的技能 / 插件** | 自用技能产品化 | 有现成分发渠道，可用客户已承诺预算结算 [11] |

---

## D 层 · 数据资产（资产中的资产，可训练、可评估）

| # | 资产 | 说明 |
|---|---|---|
| D1 | **评估集 / golden set / 回归套件** | 把生产 trace 变成评估数据集，已有官方与商用路径 [12][13] |
| D2 | **失败案例库** | 从 trace 里挖失败，是 A5 反模式清单的原料库 |
| D3 | **优质问答对 / 偏好对** | 用于 SFT / DPO |
| D4 | **RAG 语料 / 编译后的知识层** | Karpathy 模式的核心：编译一次，之后维护，而不是每次重新检索 [4] |
| D5 | **红队样本 / 攻击与越狱用例** | 安全资产的原料 |
| D6 | **标注数据** | 人工判断沉淀 |

一条战略性事实：**对话类数据被普遍视为最被低估的 AI 资产**，而"专有数据 > 模型接入权"是 AI 产品建立护城河的主流论点 [14][15][16]。

---

## E 层 · 元资产（管理上面所有资产的东西）——最容易被忽略、也最难被抄

| # | 资产 | 说明 |
|---|---|---|
| E1 | **资产 schema / 分类法** | 核心规则：什么算 state（就地替换+日期）、什么算 event（只追加）[4] |
| E2 | **出处与新鲜度元数据** | 每条事实：来自哪段记录、谁写的、**最后确认时间** |
| E3 | **索引 / 目录** | Karpathy 的每个操作都以更新 INDEX.md 收尾 [4] |
| E4 | **审计日志** | 谁、何时、改了什么（hook + 审计强制执行，不靠"礼貌的指令"）[4] |
| E5 | **冲突 / 待确认队列** | 新旧矛盾时的待裁决项 |
| E6 | **健康检查规则与报告（lint）** | 治孤儿页、索引漂移、过期断言 [17] |
| E7 | **敏感度分级与权限模型** | 单人系统走向团队的分叉点 [17] |

---

## 汇总：怎么给它们排序

按三条判据打分——**谁消费 / 会不会腐烂 / 能否事后重建**：

| 资产 | 消费方广度 | 需要维护（=可订阅） | 不可事后重建 | 结论 |
|---|---|---|---|---|
| **A5 反模式清单** | agent（每次） | 是 | **是** | ⭐ 最该做 |
| **B1 决策记录 ADR** | 人+agent | 是 | **是** | ⭐ 最该做 |
| **B2 活规格** | 人+agent | 是 | **是** | ⭐ 最该做 |
| **D1 评估集** | 机器 | 是 | 是（需 trace） | ⭐ 最该做（单价最高） |
| A1 规则文件 | agent | 是 | 部分是 | 好，但卖的是"维护"，不是"生成" |
| A2/A3 Skill、MCP | agent | 中 | 否 | 好，但要靠平台渠道 [11] |
| B5/B6/B8 实体页、状态、TODO | 本人为主 | 是 | 否 | 留存靠它，定价靠别的 |
| C1/C2 KB 文章与 FAQ | 客户 | 中 | 否 | 有现成产品（Zendesk/Zoho）[6][7] |
| C4 品牌规范 | 团队 | 慢 | 否 | 不腐烂 = 一次性买卖 |
| **第 1 层笔记/摘要/知识卡** | 本人 | — | 否 | 门槛零、免费替代多，**只当入口** [18] |

---

## 三条使用说明

1. **别追求全清单。** 这份清单里能撑起独立产品的，是 A5 + B1 + B2 + D1 这四类（**全部满足"不可事后重建"**）。其余要么是它们的原料，要么是它们的视图。
2. **区别对待生命周期。** 严格按 E1 的 schema 打标：state 类就地替换并盖日期；event 类只追加。这一步不做，你的库在 500–1000 条事实量级就会开始漂移 [17][19]。
3. **一个反直觉的取舍**：C 层（对外交付物）**单价最高但复用最低**，A/D 层（机器消费）**单价低但复用极高**。做"笔记卡 + 对外文档"的团队会发现自己进了红海；做"决策 + 反模式 + 评估集"的团队会发现自己站在别人还没做的位置——因为那三类都要求**绑定决策发生的那一刻**，无法靠事后读一遍代码或聊天记录伪造出来 [20]。
[1] [AGENTS.md vs CLAUDE.md vs spec.md: What Goes Where](https://specroot.io/notes/agents-md-vs-claude-md/)

[2] [Architecture decision records as an AI agent's memory](https://www.andrewconnell.com/articles/architecture-decision-records-ai-agents/)

[3] [Spec-Driven Development Needs a Living Spec | SpecsGraph](https://www.specsgraph.io/blog/spec-driven-development-living-specification)

[4] [My LLM wiki started to rot, so I gave it one rule · Artur Tyloch](https://tyloch.biz/posts/llm-wiki-second-brain-rot/)

[5] [ChatGPT、Claude、Gemini 文件夹 — 保存与整理 AI 聊天 | Foldif](https://foldif.com/zh)

[6] [Creating help center content using ticket data and generative AI – Zendesk help](https://support.zendesk.com/hc/en-us/articles/9409324793498-Creating-help-center-content-using-ticket-data-and-generative-AI)

[7] [Generate Article from Ticket Conversation with Zia- Online Help | Zoho Desk](https://help.zoho.com/portal/en/kb/desk/zia/generative-ai/articles/intelligent-document-processing-generate-articles-from-ticket-conversation)

[8] [Turn Support Tickets Into Knowledge-Base Articles — Munin](https://www.getmunin.com/en/journal/knowledge-base-from-support-tickets/)

[9] [Brand Kit for AI: What to Give Your Assistants (2026)](https://www.circlify.ai/blog/brand-kit-for-ai)

[10] [thehonestape/brand-voice-spec · Datasets at Hugging Face](https://huggingface.co/datasets/thehonestape/brand-voice-spec)

[11] [Claude Marketplace: plugins and connectors, products and agents, and service partners | Claude by Anthropic](https://claude.com/resources/articles/claude-marketplace)

[12] [Convert agent traces into evaluation datasets - Microsoft Foundry | Microsoft Learn](https://learn.microsoft.com/en-us/azure/foundry/observability/how-to/traces-to-dataset)

[13] [LLM evaluation dataset from production traces - Runtype](https://www.runtype.com/guides/build-eval-set-from-production)

[14] [Conversational Data: Your Untapped AI Advantage | Verint](https://www.verint.com/blog/conversational-data-most-valuable-ai-asset/)

[15] [Proprietary Data Beats Model Access](https://lyriq.ai/blog/proprietary-data-beats-model-access)

[16] [How to Build a Data Moat: Proprietary Data Strategy for AI Apps - Kanopy Labs](https://kanopylabs.com/blog/how-to-build-a-data-moat-for-ai)

[17] [Knowledge bases for AI agents: 14 ways they rot](https://omiid.me/notebook/66/knowledge-bases-for-ai-agents-14-ways-they-rot)

[18] [AI知识管家 - 让每一次 AI 对话都有价值](https://aichatkeeper.com/zh/)

[19] [Context drift: why home-built brains go stale after a few hundred facts, and how to catch it | Tandem](https://usetandem.ai/blog/context-drift-home-built-brains)

[20] [Automatically generate architecture decision records for AI agents](https://backthread.dev/use-cases/decision-log-for-ai-coded-codebases)