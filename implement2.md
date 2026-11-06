## 💻 工程师

# 用 agent 实现本项目的完整顺序

顺序不是偏好问题。下面每一步的位置都由**依赖**和**不可逆性**决定，我会明确标出"为什么必须在这之前"。

---

## 排序的四条原则

1. **回填不了的东西先做。** schema、ID、出处、迁移通道——这四样一旦缺位，采集开始后的数据就永久贬值。ADR 类资产**事后重建会被模型编造理由**，记录必须来自决策发生的那一刻 [1]。
2. **先有尺子，再接模型。** 否则你无法区分"模型在变好"和"模型在制造垃圾"——而垃圾会复利，错误条目会变成先验 [2]。
3. **先确定性骨架，后 LLM。** 无 API key 就能跑通全链路的版本被验证为可用的架构纪律 [3]。
4. **单一来源端到端跑通，再扩来源。** 同时调试两个未知，你只会得到两个未知。

---

## 依赖图（谁堵谁）

```
P0 纪律地基 ──▶ P1 立宪(schema/ID/出处) ──▶ P2 确定性骨架(无模型可跑)
                                                  │
                                                  ▼
                              P3 尺子(eval+不变量+CI阈值)
                                                  │
                                                  ▼
                              P4 第一处模型接缝(Extractor) ──▶ P5 归并+冲突
                                                                     │
                          P6 取用与分发 ◀────────────────────────────┘
                              │
                              ▼
                          P7 维护机器(护城河/订阅)
                              │
                              ▼
                          P8 自举 + 团队版 + 上架
```

**关键路径**：S4 → S5 → S6 → S8 → S9 → S10 → S12 → S15 → S19 → S21 → S25。这 11 步串行，其余可并行。

---

## Phase 0 · 纪律地基（第 1–3 天）

> 目标：**先有 harness，后有代码。** agent = 模型 + harness，大致 10% 模型 / 90% harness [4]。

| 步骤 | 动作 | 交付物 |
|---|---|---|
| **S1** | 建仓 + 工具链（pnpm workspaces / turbo / tsconfig / eslint） | 一个 `pnpm test` 能跑过的空仓 |
| **S2** | 写**种子规则**（`AGENTS.md`，5–8 条）——只写"agent 否则一定会做错的事" [5] | 8 条以内的规则文件 |
| **S3** | 装 **5 道闸门**：agent hook → pre-commit → required status check → branch rule → 发布门，并**逐条验证"它能不能被绕过"** [6] | 一份"绕过方式"清单 |

**退出条件**：一个故意写错的 PR（比如删掉一处 schema 校验）**必须被拦住**。

**常见失败**：把 `AGENTS.md` 写成愿景文档（研究结论很直白：这类文件不保证提升成功率、会增加成本、还会腐化 [5]）；把闸门写成 checklist——checklist 天生会被跳过 [6]。

**注意 S2 的正确姿势**：种子规则很少，规则主要靠**棘轮**长出来——**每一个错误变成一条规则** [7]。所以不要在第 1 天试图写全。

---

## Phase 1 · 立宪（第 3–7 天）——回填不了，所以最早

| 步骤 | 动作 | 交付物 |
|---|---|---|
| **S4** | `schema/taxonomy.yaml` v1，**只定 4 种资产**：`decision` / `state` / `event` / `rule`。别一上来 15 种 | 分类法 + 每种模板 |
| **S5** | ID 方案（`dec_`/`state_`/`event_`/`rule_` + ULID）+ front-matter 规范（含 `sources` / `last_confirmed` / `origin_incident`） | 规范文件 + zod schema |
| **S6** | provenance 校验器 + CI 集成：**没有 span 断言的资产不许入库** | CI 检查 |
| **S7** | 迁移通道（哪怕只有 v1 的空迁移，通道必须先建） | `migrate.ts` + 通道测试 |

**退出条件**：一个缺出处的样例资产被 CI 明确拒绝；`schema/`（人读）与 `packages/schema`（代码）一致性检查通过。

**为什么必须现在**：一旦开始采集却没有强制出处，那段历史**永久贬值**；而 `rule` 类的 `origin_incident` 字段就是把"A5 每条规则可追溯到一个具体出过的问题"写进结构而不是写进文档——**原则只有在被 schema 强制时才算数** [5]。

---

## Phase 2 · 确定性骨架（第 2 周）——无 API key 跑通全链路

| 步骤 | 动作 | 交付物 |
|---|---|---|
| **S8** | store 三层：`sources/` 只读、`assets/` 可写、`index/` 可重建 [8] | SQLite + 文件实现 |
| **S9** | Normalizer + **第一个来源选"官方数据导出导入"**，不选浏览器插件 | 事件 IR |
| **S10** | Emitter v1：资产 → `AGENTS.md` + `ADR/`，**输出必须逐字节确定**（快照测试） | 确定性导出 |
| **S11** | CLI：`forge compile / lint / emit` | 可在 CI 里跑的命令 |

**退出条件**：给一份脱敏会话导出，两次运行产出**逐字节相同**的 `AGENTS.md`；全过程不需要任何 API key [3]。

**为什么来源选导出而不是插件**：这个品类第一大差评就是"平台一改版工具就坏"，占全部评价 16% [9]。插件是最脆弱的一环，放到 Phase 6。

---

## Phase 3 · 先有尺子（第 2–3 周）——eval 早于任何 LLM

| 步骤 | 动作 | 交付物 |
|---|---|---|
| **S12** | eval runner + **20 条人工确认的 golden 集** [10] | `evals/golden/` |
| **S13** | **不变量测试**：出完整率、state 替换是否盖日期、`INDEX.md` 是否更新 [8]、emit 确定性 | `evals/invariants/` |
| **S14** | CI 接阈值：**红了不许合** [6] | 强制门 |

**退出条件**：把 Extractor 换成一个"永远返回空"的假实现，**CI 必须变红**。这一步过了，你才有资格接模型。

**为什么必须在这之前**：没有尺子就接模型，犯错会复利——错误条目变成先验、摘要丢掉出处、只写不读 [2]。

---

## Phase 4 · 第一处模型接缝（第 3–5 周）

| 步骤 | 动作 | 交付物 |
|---|---|---|
| **S15** | Extractor：LLM **只做抽取**；入库时强制低置信度起步、用真实抓取到的来源重建 `sources`、丢弃编造内容 [3] | 抽取 agent |
| **S16** | **入库守卫**：不确定的一律进候选区 `_inbox/`，不直接进正式资产 | 候选区 |
| **S17** | 跑 eval 定阈值；够不上就调 harness（分块、受控词表、提示），**不是换模型** [4] | 一份基准报告 |

**退出条件**：extraction 精确率/召回率达标，且**连续 3 天稳定**。

**纪律**：把信任边界实现在代码里，不要写在提示词里——"模型负责抽取，代码负责不信任" [3]。

---

## Phase 5 · 归并与冲突（第 5–7 周）

| 步骤 | 动作 | 交付物 |
|---|---|---|
| **S18** | Linker：规则优先，LLM 只判"这两条是不是同一件事"；不确定就新建，别乱并 | 归并逻辑 |
| **S19** | Conflict Judge：**只出候选 + 证据，不落库** [3] | 冲突检测 |
| **S20** | 人工冲突确认队列（**这是你未来的收费点**） | 队列 UI |

**退出条件**：构造一组"新旧状态矛盾"的合成事件，**100% 进队列且证据正确**，无一条被自动覆盖。

---

## Phase 6 · 取用与分发（第 7–9 周）

| 步骤 | 动作 | 交付物 |
|---|---|---|
| **S21** | Retriever + 注入预算控制；**绝不预加载全库**（会 context rot）[11] | 检索与注入 |
| **S22** | MCP server，让 Claude/Cursor 直接调用你的资产 [12] | MCP 包 |
| **S23** | 浏览器扩展：只做"取用 + 增量采集"，且**选择器配置可远端热更新** [9] | MV3 扩展 |
| **S24** | Emitter v2：Skill 导出 [13]、Eval 导出 [10] | 多出口 |

**退出条件**：**连续 3 天在真实工作里被"调用"，而不是被"打开"**。这是唯一重要的北极星。

---

## Phase 7 · 维护机器（第 9–11 周）——护城河与订阅

| 步骤 | 动作 | 交付物 |
|---|---|---|
| **S25** | Linter：孤儿页、索引漂移、过期断言、静默被取代 [2] | 健康检查 |
| **S26** | 新鲜度任务：state 超期主动确认（POC 后约 60% 的失败来自新鲜度，不是检索质量 [14]） | 定时 job |
| **S27** | 审计日志 + hook 强制执行，**不靠礼貌指令** [8] | 审计层 |
| **S28** | 健康报告 → 周报（让你"想订阅"的理由） | 周报 |

**退出条件**：库里涨到 **500–1000 条事实仍然可用**——这是公认的家酿大脑漂移阈值 [14]。

---

## Phase 8 · 自举、团队与上架（第 11 周+）

| 步骤 | 动作 | 交付物 |
|---|---|---|
| **S29** | **自举**：用本项目的 CLI 管本项目的 ADR / 规则 / eval，目标自己产出 30+ ADR（规模感参考：有人四个月 141 条 [15]） | `docs/adr/` |
| **S30** | 团队版**只在出现付费信号后**做：权限、敏感度分级、同步（单人模式的三个缺失项：没权限、没并发、没敏感度切分 [2]） | 团队功能 |
| **S31** | 上架路径：Skill/MCP 提交，借平台分发与已承诺预算结算 [12] | 市场条目 |
| **S32** | 对外 demo = **你自己的库**，不是编造的样例 | 演示 |

---

## 三个不可逆点（这个顺序专门保护的）

| 不可逆点 | 一旦做错的后果 | 被哪一步保护 |
|---|---|---|
| 开始采集却不记录出处 | 那段历史永久贬值，且无法事后重建 [1] | S5 + S6 |
| schema 定型后才想改分类法 | 迁移成本随数据量线性增长 | S7（通道先建） |
| 让 LLM 直接写正式资产、不做入库守卫 | 垃圾污染库并变成先验 [2] | S16 |

---

## 三条可并行的支线（不占关键路径）

- **并行线 1（P2 期间）**：第二个来源的连接器调研（PR/会议），只写接口不实现。
- **并行线 2（P4 期间）**：设计 token + UI 骨架，做冲突队列的静态页面。
- **并行线 3（P6 期间）**：写 `docs/rfcs/` 模板与第一个真实 RFC（团队版权限模型）。

---

## 人 / agent 分工速查

| 阶段 | agent 全自动 | 人必须做 | CI 强制 |
|---|---|---|---|
| P0 | 脚手架、闸门脚本 | 种子规则取舍 | 闸门本身 |
| P1 | zod、迁移骨架 | **分类法、ID 方案** | 出处完整性 |
| P2 | store/normalizer/emitter/CLI | 确定性验收标准 | emit 快照 |
| P3 | runner、测试 | **阈值与 golden 集** | 阈值 |
| P4 | 抽取、提示迭代 | **入库守卫边界** | eval 阈值 |
| P5 | 归并、冲突检测 | **冲突判定原则** | 无自动覆盖 |
| P6 | MCP、扩展、导出器 | 北极星定义 | 注入预算 |
| P7 | linter、定时任务 | **什么算过期** | 审计完整性 |
| P8 | 全部实现 | **定价、权限模型** | 权限测试 |

---

## 一句话

**顺序的灵魂只有一条：把回填不了的东西放在最前，把尺子放在模型之前，把 LLM 放到最后。**

按这个顺序，第 11 周你会得到两样东西——一个能用的产品，和一套已经长满了 ADR、反模式规则与真实回归用例的库。**后者就是你最好的销售材料，也是别人抄不走的部分**，因为它绑定的是"你的决策发生在那一刻"的记录 [1]。
[1] [Automatically generate architecture decision records for AI agents](https://backthread.dev/use-cases/decision-log-for-ai-coded-codebases)

[2] [Knowledge bases for AI agents: 14 ways they rot](https://omiid.me/notebook/66/knowledge-bases-for-ai-agents-14-ways-they-rot)

[3] [Build an LLM Triage Layer That Can't Freelance | AIXplore](https://ai.rundatarun.io/ai-systems-architecture/grounded-llm-triage-layer)

[4] [The New Software Lifecycle | AddyOsmani.com](https://addyosmani.com/blog/new-sdlc-vibe-coding/)

[5] [AGENTS.md vs CLAUDE.md vs spec.md: What Goes Where](https://specroot.io/notes/agents-md-vs-claude-md/)

[6] [Quality gates for AI code, not a checklist agents skip - Kousigan A](https://www.kousigan.com/blog/definition-of-done-quality-gates-ai-code/)

[7] [Addy Osmani on Agent Harness Engineering: Model + Harness — thekb.eu](https://www.thekb.eu/en/fiches/osmani-agent-harness-engineering-2026-04-19/)

[8] [My LLM wiki started to rot, so I gave it one rule · Artur Tyloch](https://tyloch.biz/posts/llm-wiki-second-brain-rot/)

[9] [We Read 4,241 Reviews of AI Chat Export Tools. | Chat2Doc](https://chat2doc.net/en/blog/we-read-4241-reviews-of-ai-chat-export-tools)

[10] [Convert agent traces into evaluation datasets - Microsoft Foundry | Microsoft Learn](https://learn.microsoft.com/en-us/azure/foundry/observability/how-to/traces-to-dataset)

[11] [Why Isn't Your AI Second Brain Working? | Hjarni](https://hjarni.com/blog/ai-second-brain-not-working)

[12] [Claude Marketplace: plugins and connectors, products and agents, and service partners | Claude by Anthropic](https://claude.com/resources/articles/claude-marketplace)

[13] [What are skills? | Claude Help Center](https://support.claude.com/en/articles/12512176-what-are-skills)

[14] [Context drift: why home-built brains go stale after a few hundred facts, and how to catch it | Tandem](https://usetandem.ai/blog/context-drift-home-built-brains)

[15] [Architecture decision records as an AI agent's memory](https://www.andrewconnell.com/articles/architecture-decision-records-ai-agents/)