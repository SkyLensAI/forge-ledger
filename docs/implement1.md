## 💻 工程师

# 用 agent 实现本项目

## 0. 先把问题拆成两个，而且必须一起答

- **A. 用 coding agent 把这个项目写出来**（开发侧）
- **B. 这个产品本身就是一个 agent 系统**（运行侧）

必须一起答的原因很实在：**这个产品的内容——规则、决策、评估——恰好就是 harness 的组成部分。** 你用 A 的过程本身就在生产 B 需要的资产。这不是"顺便做个 dogfooding 营销"，而是这个项目唯一可行的冷启动路径（否则你的库第 1 天是空的）。

---

## 1. 心法：`agent = model + harness`

框架值得先立住：**一个 agent 是"模型 + harness"**，而 harness 包括规则文件、工具与 MCP、沙箱、编排逻辑（何时派生 sub-agent、如何在模型间路由）、在固定点跑确定性代码的 hooks、以及告诉你它开始跑偏的可观测性；大致比例是 **10% 模型、90% harness** [1]。

一组公开数字让它具体化：**在 Terminal Bench 2.0 上，只改 harness、模型不变，一个编码 agent 从 30 名之外进到了前 5** [1]。

**推论：本项目的工程量 90% 在 harness，不在提示词。** 换更强的模型不是解法——把预算花在规则、闸门、评估、编排上。

还有一个原则你会在下面看到两次：**"棘轮"——每一个错误都变成一条规则** [2]。这既是你的开发方法，也正是你要卖给用户的资产 A5（反模式清单）。**你的开发流程和你卖的东西是同一个东西。**

---

## 2. 开发侧：怎么用 agent 把这个项目建起来

### 2.1 仓库即 harness：放什么、坚决不放什么

- `AGENTS.md` / `CLAUDE.md` 只写**"agent 否则一定会做错的事"**，且**每一行都能追溯到一个具体出过的问题** [3]。
- 但别迷信它：研究结论是这类文件**并不稳定提升成功率、会增加成本、还会增长腐化** [3]。所以它必须挂到上一轮设计的元数据上——每条规则带 `origin_incident`，由 CI 校验（没出处不许合）。
- 规格分两层用：`spec.md` 管**单次变更**（做什么、为什么）[3]；**living spec** 管长期正确性——后者是 spec-driven 这个已经产业化的品类（Spec Kit / Kiro / OpenSpec / BMAD）里**没被解决的那一半** [4]。

### 2.2 第一个要定的事：谁能拍板

| 任务类型 | 交给 agent | 人（走 RFC） | CI 强制 |
|---|---|---|---|
| 连接器、emit 模板、单测、重构、文档 | ✅ 全自动 | | |
| **schema / taxonomy 变更、迁移脚本** | | ✅ | ✅ |
| 权限模型、敏感度分级、删除类操作 | | ✅ | ✅ |
| 不变量：provenance 完整、schema 一致性、eval 阈值、emit 确定性 | | | ✅ 逃不掉 |

**schema 和迁移不能交给 agent 自主决定。** 理由回到上一轮：资产比代码活得久，你会亲手毁掉用户两年的记录。

### 2.3 把"清单"变成"闸门"——这是最容易做错的一步

**定义完成的清单（checklist）会被 agent 跳过。** 必须把每一项变成闸门：agent hook（会话内）、pre-commit hook（提交时）、required status check（CI）、branch rule（拦合并）——而且要知道**每一种都有不同的绕过方式**（改 hook 配置、`--no-verify`、管理员豁免）[5]。

同时记住那句话：**绿灯只说明你写的检查通过了，不说明需求被满足了** [5]。所以除了 lint 通过，你还必须有 **eval 阈值**，否则你只是在验证自己的错觉。

### 2.4 并行与评审

- `git worktree` + sub-agent 并行开工，但**每个 agent 的产出必须过同一组闸门**——否则并行只是在并行制造垃圾。
- 人的角色从"写代码"转向"判断代码" [1]。这意味着你的时间要花在写 eval、定 schema、审冲突队列上。
- **agent 之间的交接物必须是结构化文件（spec / ADR / eval），不是聊天记录。** 因为下一个消费者（人或 agent）只读文件。

### 2.5 自举：用本项目自己的产物管理本项目

这一步是整套方案的关键，也是最好的 demo：

1. 每个值得记住的技术决策 → 生成一条 ADR。规模感：有人在一个 repo 里 **四个月攒了 141 条** [6]。
2. 每个线上踩的坑 → 生成一条 rule（挂在 `origin_incident` 上）——这就是棘轮原则 [2]。
3. 每个真实失败案例 → 进 `evals/regressions/`。
4. 用本项目的 lint 检查本项目自己的 harness 有没有腐化。

**你不需要编 demo 数据，你的开发历史就是数据。**

---

## 3. 运行侧：产品本身的 agent 架构

### 3.1 总原则：模型抽取，代码不信任

有一条实践值得直接抄。ModelMap 那个项目的做法是：**一个 TypeScript 引擎和一个 Python 参考实现跑同一套确定性规则；LLM 只做两件事**——把自由文本解析进受控词表、解释规则**已经产出**的结论；它唯一的读物是一个带版本的事实包 [7]。而且入库时：**把每个判断字段强制置为低置信度、用真正抓取到的 URL 重建来源列表、丢弃模型编造的内容** [7]。他的原话是：**"模型负责抽取，代码负责不信任。"** 他还说，最难的不是规则，而是**把信任边界实现在代码里，而不是写在提示词里** [7]。

**映射到本项目：LLM 只做四件事——**

1. 从事件里抽取候选断言
2. 判断两条断言是否在说同一件事（归并）
3. 判断新事件与现有 state 是否冲突
4. 生成给人读的措辞

**其余全部确定性**：生命周期（state 替换 / event 追加）、去重、索引、出处解析、权限、敏感度、导出。因为本产品的失败模式是"自信地错"——**过期的事实比没有事实更糟**。

### 3.2 Agent 清单：七个窄 agent，没有"总管 agent"

| # | Agent | 类型 | 输入 → 输出 | 强制校验 | 失败处理 |
|---|---|---|---|---|---|
| 1 | Normalizer | 确定性 | 原始来源 → 规范化事件 IR | schema | 丢弃 + 记录 |
| 2 | Extractor | LLM | 事件 → 候选断言（带 source span，**置信度从低起步**） | zod + span 可解析 | 重试 → 降级入库为候选 |
| 3 | Linker | 规则优先 + LLM 判定 | 候选断言 → 归并 / 新建实体 | 冲突率阈值 | 不确定就新建，别乱并 |
| 4 | Conflict Judge | LLM，**只出候选 + 证据，不落库** | 新事件 × 现有 state → 冲突候选 | 必须带证据 span | 一律进人工队列 |
| 5 | Linter | 确定性 | 全库 → 健康报告 | 规则集版本化 | 阻断 emit |
| 6 | Retriever & Injector | 确定性 + 排序模型 | 查询 → 预算内的上下文 | token 预算 | 宁少勿多 |
| 7 | Emitter | 确定性模板 | 资产 → AGENTS.md / Skill / Eval / KB 文章 | **逐字节确定性快照** | 不通过就阻断 |

**关键设计：编排用确定性 DAG / 状态机，不要一个自由发挥的 orchestrator。** 因为本产品的核心卖点就是可复现、可审计、有出处——而"让一个大 agent 自己决定怎么干"与这三条直接冲突。

### 3.3 四条不能让步的运行时决策

1. **检索优先，绝不预加载整个大脑。** 预加载会 context rot，需要"检索 + 新鲜度/出处"两层 [8]。
2. **没有 source span 的断言不许进 `assets/`。** 出处是硬约束（呼应 Osmani 那条判据 [3]）。
3. **冲突永远不自动覆盖。** 一律进人工队列——这是"维护型产品"的信任基石，也是你唯一能收订阅费的动作。
4. **成本：增量编译 + 内容哈希缓存；抽取用便宜模型，冲突裁决才用贵模型。** 并且保留"无 key 也能跑"的确定性路径 [7] + 本地模型/自带 key（本地优先是用户最认可的点 [9]）。

### 3.4 用 eval 管住 agent，而不是靠"感觉不错"

- 三类黄金集分开：`extraction`、`linkage`、`conflict` [10]，并且从真实 trace 反向造用例 [11]。
- 每个 agent 输出 schema 化 + 置信度阈值 + 重试策略。
- 必测的**不变量**（这些是纯确定性断言，不靠模型判断）：provenance 完整率、state 替换是否盖日期、`INDEX.md` 是否更新 [12]、emit 是否逐字节确定。

---

## 4. 落地节奏（按 harness 优先排，不按功能排）

| 阶段 | 交付 | 人 / agent 分工 |
|---|---|---|
| **第 1 周** | **先造 harness，不造产品**：`AGENTS.md` + 5 道闸门 + 一个 20 条的 eval 集 + `schema/taxonomy.yaml` | 人写规则与阈值，agent 搭脚手架 |
| **第 1–3 周（v0）** | 纯确定性骨架：schema + store + 1 个 ingest 来源 + Emitter 生成 `AGENTS.md`。**验收标准：没有 API key 也能跑通全链路** | agent 全自动，人只审 schema |
| **第 4–8 周** | 接 Extractor + Linker，建 extraction eval 并设阈值 | 人定阈值与边界，agent 写连接器与测试 |
| **第 9 周+** | Conflict Judge + 人工冲突队列 + Linter | 人管队列与规则，agent 做规则实现 |

**v0 必须能在没有 API key 的情况下跑通**——这一条是被验证过的架构纪律 [7]，也是你区分"工具"和"玩具"的分水岭。

---

## 5. 反模式清单（这就是你要吃的自己的狗粮）

1. **让 agent 自主改 schema / taxonomy / 迁移脚本而不走 RFC。**
2. **用自然语言提示代替代码强制**（"记得加出处" → 必须变成 CI 校验）。这是原文明说的最难之处 [7]。
3. **没有 eval 就说"效果不错"。**
4. **把闸门写成 checklist**——它会被跳过 [5]。
5. **用一个大 orchestrator agent 一把梭** → 不可复现、不可审计，和产品价值直接冲突。
6. **让运行时的 agent 自动覆盖用户已有的状态** → 信任一次崩掉就回不来。
7. **把"换个更贵的模型"当解法**——那只是 10% 的部分 [1]。
8. **以为绿灯 = 需求满足** [5]。

---

## 6. 一句话总结

**这个项目的正确实现方式，就是把你自己变成第一个用户：**开发侧用 harness 纪律（规则来自踩坑、闸门不可绕过、eval 定成败），运行侧用"模型抽取、代码不信任"的七个窄 agent + 确定性编排。等到第 8 周你回头看，`docs/adr/` 里那几十条决策、`data/assets/rule/` 里那几条反模式、`evals/regressions/` 里那批真实失败案例——**它们既是你的开发副产物，也是你要卖的产品本身。**
[1] [The New Software Lifecycle | AddyOsmani.com](https://addyosmani.com/blog/new-sdlc-vibe-coding/)

[2] [Addy Osmani on Agent Harness Engineering: Model + Harness — thekb.eu](https://www.thekb.eu/en/fiches/osmani-agent-harness-engineering-2026-04-19/)

[3] [AGENTS.md vs CLAUDE.md vs spec.md: What Goes Where](https://specroot.io/notes/agents-md-vs-claude-md/)

[4] [Spec-Driven Development Needs a Living Spec | SpecsGraph](https://www.specsgraph.io/blog/spec-driven-development-living-specification)

[5] [Quality gates for AI code, not a checklist agents skip - Kousigan A](https://www.kousigan.com/blog/definition-of-done-quality-gates-ai-code/)

[6] [Architecture decision records as an AI agent's memory](https://www.andrewconnell.com/articles/architecture-decision-records-ai-agents/)

[7] [Build an LLM Triage Layer That Can't Freelance | AIXplore](https://ai.rundatarun.io/ai-systems-architecture/grounded-llm-triage-layer)

[8] [Why Isn't Your AI Second Brain Working? | Hjarni](https://hjarni.com/blog/ai-second-brain-not-working)

[9] [We Read 4,241 Reviews of AI Chat Export Tools. | Chat2Doc](https://chat2doc.net/en/blog/we-read-4241-reviews-of-ai-chat-export-tools)

[10] [Convert agent traces into evaluation datasets - Microsoft Foundry | Microsoft Learn](https://learn.microsoft.com/en-us/azure/foundry/observability/how-to/traces-to-dataset)

[11] [LLM evaluation dataset from production traces - Runtype](https://www.runtype.com/guides/build-eval-set-from-production)

[12] [My LLM wiki started to rot, so I gave it one rule · Artur Tyloch](https://tyloch.biz/posts/llm-wiki-second-brain-rot/)