## 💻 工程师

# 项目工程目录设计（含说明）

先约定：下文用 **Forge** 作为项目代号（"把痕迹编译成资产"的铸造厂）。你可以替换。

整个目录是**六条设计原则的投影**，所以先讲原则，再上树——否则你只会看到一堆文件夹名，不知道为什么这么切。

---

## 一、七条设计原则（目录为什么长这样）

1. **代码与数据分离，用户数据不进 repo。** 资产库的生命周期比代码长得多——你的 app 会重写三遍，用户的决策记录不能丢。所以数据不进 git，且 schema 的版本纪律要比代码更严。
2. **源头不可变，编译层可重建。** 严格三层：`sources`（只读原料）/ `assets`（编译产物，只有 agent 写）/ `schema`（编译规则）。这是整套系统的骨架 [1]。任何"能重新算出来"的东西都不该被当成资产。
3. **schema 是宪法。** 分类法（什么算 state、什么算 event）不是配置项，是产品的核心资产 E1 [1]。它必须有独立目录、独立版本号、独立迁移脚本。
4. **core 是纯函数，IO 全在边缘。** 编译与维护逻辑不碰文件系统、不碰网络。这样同一份引擎能跑在桌面、浏览器扩展、CLI、MCP server 和云端 worker 里。
5. **出处是硬约束，不是元数据奢侈品。** "每一行都能追溯到一个具体出过的问题" [2] 必须在 CI 里被强制校验，否则它只是一句口号。
6. **维护是一等公民。** lint、冲突队列、审计、新鲜度与编译同级——因为腐烂才是这个品类的真正敌人（POC 后约 60% 的失败来自数据新鲜度 [3]）。
7. **出口要多，所以导出必须独立成包。** 同一份资产要能变成 AGENTS.md、Skill 目录、MCP 工具、Obsidian 页面、评估集 [2][4][5][6]。

---

## 二、完整目录树

```
forge/
├── apps/                              # 可交付的端
│   ├── desktop/                       # 主客户端（Tauri）：本地优先，主界面
│   ├── extension/                     # 浏览器扩展（MV3）：会话采集 + 侧栏取用
│   ├── web/                           # 云端控制台：团队、权限、审计、协作
│   ├── cli/                           # forge 命令行：本地编译/lint/导出，可进 CI
│   └── mcp-server/                    # MCP server：把资产暴露给 Claude/Cursor
│
├── packages/
│   ├── schema/                        # ★ 事件 IR + 资产 IR + zod 校验 + 迁移
│   ├── core/                          # ★ 编译与维护引擎（纯函数、零 IO）
│   ├── llm/                           # 模型网关：多 provider、自带 key、本地模型、缓存与成本
│   ├── ingest/                        # 采集层
│   │   ├── contracts/                 # 连接器接口定义
│   │   └── connectors/                # chat-export/chat-ext/git-pr/meeting/ticket/email
│   ├── store/                         # 存储实现：本地(SQLite+文件) / 云同步适配
│   ├── provenance/                    # 出处图：ID 方案、span 对齐、可追溯性校验
│   ├── lint/                          # 健康检查：孤儿页、索引漂移、过期断言
│   ├── policy/                        # 敏感度分级、权限模型、审计日志
│   ├── emit/                          # 导出器：AGENTS.md / Skill / Obsidian / Eval / Notion
│   └── ui/                            # 共享组件与设计 token
│
├── services/                          # 需要服务端才能活的部分（v0 可全空）
│   ├── sync/                          # 端到端加密同步
│   ├── jobs/                          # 后台编译队列、定时健康检查
│   ├── auth/                          # 账号、组织、计费
│   └── telemetry/                     # 匿名质量与使用指标
│
├── schema/                            # ★ 数据侧的"宪法"（不是代码，是人的约定）
│   ├── taxonomy.yaml                  # 资产分类法：state/event/decision/spec/rule/eval...
│   ├── asset-types/                   # 每种资产的模板与必填字段
│   ├── provenance.md                  # 出处与新鲜度规则（人可读）
│   └── sensitivity.md                 # 敏感度分级与处理规则
│
├── evals/                             # 既是产品质量门，也是产品输出形态
│   ├── golden/                        # 人工确认的黄金集
│   ├── regressions/                   # 从真实 trace 回归出的用例
│   ├── extraction/                    # 抽取准确率
│   ├── conflict/                      # 冲突检测准确率
│   └── fixtures/                      # 脱敏样例会话
│
├── data/                              # 运行时用户数据（.gitignore 整个目录）
│   ├── sources/                       # 只读原始层：不可变
│   ├── assets/                        # 编译层：只有 agent 写
│   ├── index/                         # 索引/向量/派生缓存（随时可重建）
│   └── audit/                         # 审计日志与冲突队列
│
├── infra/
│   ├── terraform/                     # 云资源
│   ├── docker/                        # 本地依赖（DB、队列）
│   └── github-actions/
│
├── docs/
│   ├── adr/                           # 吃自己的狗粮：本项目自己的决策记录
│   ├── rfcs/                          # 大改动先写 RFC
│   └── handbook/                      # 上手、发布、值班
│
├── scripts/                           # 一次性脚本：迁移、回填、导入
├── .github/workflows/                 # CI：schema/provenance/lint/eval/emit 快照
├── pnpm-workspace.yaml
├── turbo.json
└── README.md
```

---

## 三、逐个目录说明

### `apps/` —— 端，不是核心

关键判断：**核心逻辑一行都不许写在 apps 里。** 每个 app 只做"把 core 接到某个宿主环境"。

| 目录 | 职责 | 备注 |
|---|---|---|
| `desktop` | 主界面、本地数据管理、首次导入向导 | Tauri，因为它要写本地文件且要跑本地模型 |
| `extension` | 采集（会话增量）+ 侧栏取用（一键注入上下文） | ⚠️ 全品类第一大差评就是"平台改版就坏"（16% 评价）[7]，所以采集逻辑必须做成可远端更新的配置，而不是硬编码选择器 |
| `web` | 团队版一切需要服务端的东西 | v0 可以是空目录 |
| `cli` | 本地编译、lint、导出；**能进用户的 CI** | 这是你被工程团队接纳的入口，别把它当附属品 |
| `mcp-server` | 把资产作为工具暴露给 Claude/Cursor | 分发靠生态，而非自建入口 [8][6] |

### `packages/` —— 能力，可被任何 app 复用

- **`schema/`（最重要）**：定义两套 IR——**事件 IR**（规范化后的来源片段）与**资产 IR**（带类型的产物）。附带 zod 校验、版本号、迁移函数。**这个包的数据模型变更要走 RFC + 迁移脚本，不能随手改。**
- **`core/`（第二重要）**：编译（事件→资产）、维护（state/event 生命周期、冲突消解、新鲜度）、检索与注入排序。**零 IO**，输入输出都是纯数据，因此可测试、可复用。
- **`llm/`**：唯一允许直接调模型的地方。必须支持"用户自带 key / 本地模型"，因为本地优先是这个品类被验证的用户偏好（300 条评价明确赞赏本地处理）[7]。
- **`ingest/`**：连接器**不要每个来源一个包**——它们是插件，放在 `connectors/` 下，统一实现 `contracts/` 里的接口。来源清单见上一轮那张表（会话、PR、会议、工单、邮件…）。
- **`store/`**：本地用 SQLite + 文件；云端只是适配器。**派生数据（向量、索引、缓存）一律可重建**，放在 `data/index/`。
- **`provenance/`**：ID 方案与 span 对齐。这是你区别于"又一个笔记工具"的工程实现。
- **`lint/`**：健康检查规则引擎。孤儿页、索引漂移、过期断言、状态被静默取代 [9]。
- **`policy/`**：敏感度分级 + 权限 + 审计。**单人产品走向团队的分叉点就在这里**——没有它，团队版根本不敢上线 [9]。
- **`emit/`**：每个出口一个文件，输出必须**确定性**（同一输入产出逐字节相同的 AGENTS.md），这样才能做快照测试。

### `services/` —— v0 全部留空

判断标准：**任何能跑在用户机器上的，都不要放进 services。** 只有"跨设备/跨人"才需要服务端。

### `schema/` vs `packages/schema/` —— 这组区分很关键

- `schema/`（根目录）：**人的约定**——分类法 YAML、每种资产的模板、出处规则文档。产品经理和运营也读它。
- `packages/schema/`：**代码里的实现**——zod schema、类型、迁移函数。

两者必须一一对应，且在 CI 里比对一致性。**这是防止"sources 层是地狱"的唯一办法。**

### `evals/` —— 一个漂亮的递归

这个目录一份两用：**它既是本项目的质量门，也恰好是你要卖给用户的那类资产 D1** [5][10]。你做不好自己的 eval，就做不好用户的 eval。

### `data/` —— 运行时数据，整体 gitignore

```
data/
├── sources/       # 原始层：append-only，永不修改，永不删除
│   └── src_<hash>/…
├── assets/        # 编译层：只有 agent 写，人只读+审核
├── index/         # 派生层：删掉能重建，成本只是重算时间
└── audit/         # 变更日志 + 冲突待确认队列
```

在代码库里它通常是空的（只有 `.gitkeep`），因为真实数据在用户机器的 `~/.forge/` 下。

---

## 四、三个关键文件（照这个写就能跑起来）

**1）`schema/taxonomy.yaml` —— 分类法，全系统的宪法**

```yaml
version: 3
asset_types:
  decision:      { lifecycle: event,  immutable_after: accepted, requires: [options, chosen, rationale] }
  state:         { lifecycle: state,  rule: replace_in_place, requires: [last_confirmed] }
  event:         { lifecycle: event,  rule: append_only }
  rule:          { lifecycle: state,  rule: replace_in_place, requires: [origin_incident] }  # A5 反模式
  spec:          { lifecycle: state,  rule: replace_in_place, requires: [change_ref] }
  sop:           { lifecycle: state,  rule: replace_in_place, requires: [owner] }
  eval_case:     { lifecycle: event,  rule: append_only,  requires: [input, expected] }
freshness:
  state: { confirm_within: 30d, on_expiry: ask }
  event: { confirm_within: null }
```

注意 `rule` 的 `requires: [origin_incident]`——把"A5 每条规则必须能追溯到一个具体出过的问题" [2] **写进 schema**，而不是写进文档。原则只有被 schema 强制时才算数。

**2）资产文件的 front-matter —— state/event 与出处的落地点**

```markdown
---
id: dec_01HQ8Z...
type: decision
status: accepted            # proposed | accepted | superseded
created: 2026-10-14
last_confirmed: 2026-11-02
supersedes: dec_01HQ2X...
origin_incident: inc_01HQ...
sources:
  - "chatgpt://conv_abc123@2026-10-14#turn-7"
  - "github://acme/api/pull/482#review-thread-3"
sensitivity: internal
confidence: 0.82
---
## 问题
## 考虑过的选项
## 选定
## 后果
```

出处锚点指向 `data/sources/` 里的**不可变片段**。规则很简单：**没有出处的一行，不允许进入 `assets/`。**

**3）`.github/workflows/health.yml` —— 维护的强制执行**

```
1. schema 校验（data/ 与 schema/ 一致）
2. provenance 完整性（每条断言都能解析到 source span）
3. lint / 健康检查（孤儿页、索引漂移、过期 state）
4. evals 阈值（抽取准确率、冲突检测召回率）
5. emit 快照（同一输入产出确定性文件）
```

第 5 条很关键：**用 CI 强制维护，不要靠"礼貌的指令"** [1]。

---

## 五、数据的两个"家"— 别搞混

| | 产品的库 | 用户的工作区 |
|---|---|---|
| 位置 | `~/.forge/`（本地）| 用户自己的 repo / Obsidian / Notion |
| 内容 | sources + assets + index + audit | 导出的 `AGENTS.md`、`ADR/`、`skills/`、KB 文章 |
| 谁写 | 只有 Forge 写 | 双向，冲突靠 `emit` 的确定性 + 人工确认 |

**写入用户工作区一律要经过审核队列**，不能静默覆盖——这既是产品体验问题，也是"组织知识捕获"场景的信任底线 [4]。

---

## 六、v0 最小版（照抄这个开始，别一上来就建 20 个包）

```
forge/
├── apps/desktop/
├── apps/cli/
├── packages/{schema,core,llm,ingest,store,emit}/
├── schema/{taxonomy.yaml,asset-types/}
├── evals/{golden,fixtures}/
├── data/            # gitignored
├── docs/adr/
└── .github/workflows/health.yml
```

只有 6 个包、3 个端。**当出现以下信号时才拆包**：
- 某个连接器需要独立的发布节奏 → 从 `ingest/connectors/` 提出来
- 需要第二个消费者（比如 MCP server）→ 把逻辑从 app 下沉到 `packages/core`
- 团队版出现真实付费客户 → 才建 `services/` 和 `web`

---

## 七、反模式清单（这些是真会踩的坑）

1. **把用户数据放进 repo** —— 一次误提交就是一次信任崩塌。
2. **让编译器直接改用户工作区** —— 必须有审核队列。
3. **在 `apps/` 里写业务逻辑** —— 第二天你就得把同一段逻辑复制到 CLI 和 MCP server。
4. **每个来源一个包 / 建一个万能 `utils/`** —— 前者是包地狱，后者是垃圾桶。
5. **把派生数据当资产保存** —— 索引、向量、摘要缓存都该在 `data/index/`，删了能重建。
6. **schema 随手改、不写迁移** —— 资产比代码活得久，你会亲手毁掉用户两年的记录。
7. **把 lint 当成"以后再说"的功能** —— 那你做的还是笔记工具，不是基础设施。

---

## 八、命名与迁移纪律（三条硬规矩）

1. **ID 带类型前缀 + ULID**：`dec_`、`state_`、`event_`、`rule_`、`spec_`、`eval_`、`src_`。前缀让 grep 和路由都变简单，ULID 保证时序可排序。
2. **数据目录按 ID 前缀分区**：`data/assets/dec/`、`state/`、`rule/`……按类型分，而不是按项目/客户分（那会让跨领域检索变成噩梦）[9]。
3. **每次操作都以更新 `INDEX.md` 收尾** [1]，并且产出确定性输出——这是你能做快照测试、能审计、能回滚的前提。
[1] [My LLM wiki started to rot, so I gave it one rule · Artur Tyloch](https://tyloch.biz/posts/llm-wiki-second-brain-rot/)

[2] [AGENTS.md vs CLAUDE.md vs spec.md: What Goes Where](https://specroot.io/notes/agents-md-vs-claude-md/)

[3] [Context drift: why home-built brains go stale after a few hundred facts, and how to catch it | Tandem](https://usetandem.ai/blog/context-drift-home-built-brains)

[4] [What are skills? | Claude Help Center](https://support.claude.com/en/articles/12512176-what-are-skills)

[5] [Convert agent traces into evaluation datasets - Microsoft Foundry | Microsoft Learn](https://learn.microsoft.com/en-us/azure/foundry/observability/how-to/traces-to-dataset)

[6] [AGENTS.md vs CLAUDE.md: how coding agents find docs](https://www.mintlify.com/library/agents-md-vs-claude-md)

[7] [We Read 4,241 Reviews of AI Chat Export Tools. | Chat2Doc](https://chat2doc.net/en/blog/we-read-4241-reviews-of-ai-chat-export-tools)

[8] [Claude Marketplace: plugins and connectors, products and agents, and service partners | Claude by Anthropic](https://claude.com/resources/articles/claude-marketplace)

[9] [Knowledge bases for AI agents: 14 ways they rot](https://omiid.me/notebook/66/knowledge-bases-for-ai-agents-14-ways-they-rot)

[10] [LLM evaluation dataset from production traces - Runtype](https://www.runtype.com/guides/build-eval-set-from-production)