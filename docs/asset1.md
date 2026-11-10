## 💻 工程师

## 先澄清一个经常被混淆的点

"资产"有两个轴，多数人只想到一个就以为想全了：

- **来源轴**：资产从哪儿来（对话只是入口之一）
- **产物轴**：沉淀成什么、**谁来消费**

决定价值和定价的是**产物轴**。而且我要先给一个反直觉的判断：**会话本身其实是低质量来源**——冗长、充满试探性错误和模型幻觉，直接提炼就会"垃圾复利" [1]。会话真正独家提供的东西只有一个：**决策的理由**（"为什么当时选了 B 而不是 A"），这个理由在任何其他文件里都不会被记下来。

---

## 一、来源轴：除了会话，还有哪些"原料"

| 来源 | 是否天然带"决策痕迹" | 素材形态 |
|---|---|---|
| 多模型对话（ChatGPT/Claude/Gemini） | 中（有但混杂） | 会话记录 |
| **代码 / PR 线程 + agent session transcript** | **高** | 提交、diff、评审讨论 |
| 会议 / 通话录音 | 高 | 转写稿、行动项 |
| 工单 / 支持对话 / 事故复盘 | 高 | 事件、根因、处置 |
| 邮件 / IM（Slack、飞书） | 中高 | 讨论串 |
| 文档（Notion/Confluence）、日历 | 低（是结论不是过程） | 已成型文档 |
| 运行日志 / agent traces | 中高 | 调用链 |
| 浏览器 / 阅读记录 | 低 | 半成品 |

**别一次全接。** 筛选标准就一条：**这条来源里有没有"做过选择和争论"**？有 → 优先；只是结论 → 它是你要写入的对象，不是来源。

---

## 二、产物轴：资产清单（这是你真正在问的）

我按"谁来消费"分三层，价值递增。

### 第 1 层：给人读的（笔记层）——最不值钱
摘要、知识卡、高亮+旁注、导出成"书" [2]。门槛极低、免费替代品极多 [3]、留存差。**这一层不是产品，是产品的一个视图。**

### 第 2 层：给流程用的（结构层）
- **决策记录（ADR）**：范式是"问题 / 考虑过的选项 / 选中项 / 后果"+ 编号 + 状态 [4]。规模感：有人在一个 repo 里**四个月攒了 141 条** ADR，靠一条规则让 Claude Code 在有值得记住的决策时主动提议新增 [4]。
- **规格（spec）**：面向**单次变更**的"它必须做什么、为什么" [5]。这个品类一年内就产业化：GitHub Spec Kit（2025/9）、AWS Kiro GA（2025/11）、OpenSpec、BMAD 各拿到数万 star [6]。但大多数 spec 工作流留下的是"一个功能一文件夹 Markdown，分支合并就搁置"，**living spec（活的规格）才是没被解决的那一半** [6]。
- **实体档案 / 状态页**：Karpathy 那套的目录结构很具体——**每个客户、项目、想法、人各一页，外加一份任务清单和一页仪表盘** [7]。
- **SOP / playbook / checklist / 术语表 / 时间线**

### 第 3 层：给机器直接消费的（运行时层）——最有价值、最少人做
- **规则文件：AGENTS.md / CLAUDE.md**。它们是 agent **每个会话开始时都会读**的常驻指令（构建/测试命令、猜不到的约定、从它自己犯的错里学到的规则）；AGENTS.md 是跨工具的公共名（Codex、Copilot、Cursor、Kiro 都读），Claude Code 在没有 CLAUDE.md 时也读 AGENTS.md [5]。
  ⚠️ 但研究结论很冷静：**这类文件并不稳定地提升成功率，还会增加成本，并且会不断增长、腐化**；真正有用的是"一份简短、手写的、只写 agent 否则一定会做错的东西"的文件 [5]。Addy Osmani 的标准值得当产品需求写进 PRD：**"AGENTS.md 里的每一行都应该能追溯到一个具体出过的问题。"** [5]
- **Skill / 技能包**：官方定义是"指令、脚本、资源的文件夹"，动态按需加载，Team/Enterprise 可由管理员为全员下发 [8]。
- **MCP connector / plugin**：Claude Marketplace 已有 2000+，可用已承诺的预算结算 [9]。
- **文档供给格式**：skill.md、llms.txt、MCP [10]。
- **Prompt / 指令模板库** [11]。
- **评估集 / 回归套件（golden set）**：把生产 trace 变成评估数据集是成体系的做法，已有官方与商用路径 [12][13][14]。

---

## 三、这个清单里哪几类真能收钱（我的排序）

**1）决策记录 + 规格 —— 最实。**
买主明确（工程团队）、触发点强制（变更/合并）、素材独有（session transcript + PR 线程）。而且这里有一条非常锋利的论点：**事后让模型读代码生成 ADR 是不行的，它会编造理由；记录必须来自决策发生的那一刻** [15]。这就是护城河的本质：**时间点绑定 + 出处不可事后重建**。注意，backthread 这类产品已经直接在做"transcript + PR 线程 → 决策日志，并且把每条决策挂到合并之后才记账" [15]——**这就是你在这个方向上的直接对手，也说明方向被验证了。**

**2）规则文件（AGENTS.md/CLAUDE.md —— 的维护）。**
每个会话必读、直接改变 agent 行为、价值即时可感。但既然研究表明它"不保证提升成功率、加成本、会腐化" [5]，那你卖的不该是"生成一份"，而是**"自动让它保持短、准、一行一溯源"的维护服务**。这恰好是我上一轮说的：产品在维护层。

**3）评估集 / 回归套件。**
把真实对话里翻过的车变成可复跑的测试。对做 AI 产品的团队是硬需求，单价最高 [12][13]。代价是你要往 devtools 走，不是往"整理工具"走。

**4）Skill / MCP 资产。**
有现成分发与结算渠道 [9]，但会被平台内化 [8]。定位应该是**上游编译器**：从你的痕迹库里产出可上架的技能，而不是自己开一个商店。

**5）笔记/摘要/知识卡。**
最不值钱的一层，被免费产品覆盖最狠 [3]。可以做，但要明白它是入口，不是产品。

---

## 四、一个判据，帮你给任何候选资产排序

对每种资产问三个问题：

1. **谁消费它？** 只有本人 → 便宜；agent 每次会话都要读 → 贵；同事/客户要读 → 最贵。
2. **它会不会腐烂？** 带日期/状态/出处的会腐烂（→ 需要持续维护 → 可以收订阅）；一次成型的（模板、术语表）不会（→ 一次性买卖）。
3. **它能不能被事后重建？** 不能（必须绑定决策那一刻的记录）→ 你有独家数据，这是护城河 [15]。

**三条全中的资产——决策记录、规格、评估集——才是这个项目该做的。** 只中第一条的（笔记卡），就是别人已经在免费送的东西。

---

## 五、结论

会话不是唯一的来源，**甚至不是最好的来源**。最好的来源是"**人在其中做过选择的痕迹**"——PR 线程、会议、工单、事故复盘。最好的产物也不是"更好读的记录"，而是**能被下一个 agent 直接加载并改变行为的东西**：规则文件、技能、决策记录、活规格、评估集 [5][8][12]。

所以我把 B 的项目定义再收紧一版：

> **把决策痕迹编译成机器可消费的资产，并持续维护它不腐烂。**

这么定义，它就不是"又一个会话整理工具"，而是**人和 agent 共用的上下文基础设施**——这才是能同时撑起订阅价和团队单的那一层。
[1] [Knowledge bases for AI agents: 14 ways they rot](https://omiid.me/notebook/66/knowledge-bases-for-ai-agents-14-ways-they-rot)

[2] [ChatGPT、Claude、Gemini 文件夹 — 保存与整理 AI 聊天 | Foldif](https://foldif.com/zh)

[3] [AI知识管家 - 让每一次 AI 对话都有价值](https://aichatkeeper.com/zh/)

[4] [Architecture decision records as an AI agent's memory](https://www.andrewconnell.com/articles/architecture-decision-records-ai-agents/)

[5] [AGENTS.md vs CLAUDE.md vs spec.md: What Goes Where](https://specroot.io/notes/agents-md-vs-claude-md/)

[6] [Spec-Driven Development Needs a Living Spec | SpecsGraph](https://www.specsgraph.io/blog/spec-driven-development-living-specification)

[7] [My LLM wiki started to rot, so I gave it one rule · Artur Tyloch](https://tyloch.biz/posts/llm-wiki-second-brain-rot/)

[8] [What are skills? | Claude Help Center](https://support.claude.com/en/articles/12512176-what-are-skills)

[9] [Claude Marketplace: plugins and connectors, products and agents, and service partners | Claude by Anthropic](https://claude.com/resources/articles/claude-marketplace)

[10] [AGENTS.md vs CLAUDE.md: how coding agents find docs](https://www.mintlify.com/library/agents-md-vs-claude-md)

[11] [Ophel — AI 对话大纲 · 会话管理 · Prompt 词库](https://ophel.app/zh/)

[12] [Convert agent traces into evaluation datasets - Microsoft Foundry | Microsoft Learn](https://learn.microsoft.com/en-us/azure/foundry/observability/how-to/traces-to-dataset)

[13] [LLM evaluation dataset from production traces - Runtype](https://www.runtype.com/guides/build-eval-set-from-production)

[14] [Golden Dataset: How to Build an Evaluation Dataset from Production Traces](https://langwatch.ai/blog/build-an-evaluation-dataset-from-production-traces)

[15] [Automatically generate architecture decision records for AI agents](https://backthread.dev/use-cases/decision-log-for-ai-coded-codebases)