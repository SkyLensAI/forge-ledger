# Forge

> **这是详细工程记录，不是落地页。** 落地页见 [`README.md`](README.md)（英文）/
> [`README.zh-CN.md`](README.zh-CN.md)——那里只有一句话、60 秒 demo 与架构；
> Phase 表、实测读数与已知缺口留在这里，并且会继续如实记账。

把痕迹编译成资产：把会话、文档、PR、会议里的**决策 / 状态 / 事件 / 规则**编译成
带类型、带出处、可维护的资产库，并能按任务注入回任意模型。

> 代号 **Forge**（铸造厂）。产品定位见 `positioning.md`，目录设计见 `directory.md`，
> 实现顺序见 `implement1.md` / `implement2.md`。

## 当前进度

**Phase 0 · 纪律地基**（第 1–3 天）——先有 harness，后有代码。

| 步骤 | 内容 | 状态 |
|---|---|---|
| S1 | 建仓 + 工具链（pnpm workspaces / turbo / tsconfig / eslint） | ✅ `pnpm test` 绿（37 条闸门测试） |
| S2 | 种子规则 `AGENTS.md`（≤ 8 条，机器校验） | ✅ 8 条 |
| S3 | 五道闸门 + 绕过方式清单 | ✅ 载体就位；服务端配置待 remote（见下） |

**退出条件**：一个故意写错的改动必须被拦住 → `pnpm gate:rehearse` 可复现验证。

**Phase 1 · 立宪**（第 3–7 天）——回填不了，所以最早。

| 步骤 | 内容 | 状态 |
|---|---|---|
| S4–S7 | 分类法 / ID / 出处 / 迁移通道的**决策** | ✅ `docs/adr/0006`–`0012`、`0019` |
| S4–S7 | 它们的**代码**（`schema/`、`packages/schema`、迁移通道、出处闸门） | ✅ 已落盘 |
| — | 出处的纯函数判定 | ✅ `packages/core/src/provenance.ts` + `#k:` 键锚点（ADR-0014） |
| — | v0→v1 迁移：把 `docs/adr/0001`–`0005` 纳入版本纪律 | ✅ 已迁移（出处重指到可解析的位置，ADR-0019） |

**Phase 2 · 确定性骨架**（第 2 周）——无 API key 跑通全链路。

| 步骤 | 内容 | 状态 |
|---|---|---|
| S8 | store 三层（`sources/` 只读 · `assets/` 可写 · `index/` 可重建） | ✅ `packages/store`（`node:sqlite`，零新依赖） |
| S9 | Normalizer + 官方导出连接器 → 事件 IR | ✅ `packages/core/src/normalize.ts` + `packages/ingest` |
| S10 | Emitter v1：资产 → `AGENTS.md` + `adr/`，逐字节确定 | ✅ `packages/core/src/emit.ts`（ADR-0017） |
| S11 | CLI：`forge compile / lint / emit` | ✅ `apps/cli` |

**退出条件**：给一份脱敏会话导出，两次运行产出**逐字节相同**的 `AGENTS.md`，全程不需要 API key。
→ 由 `apps/cli/test/e2e.test.ts` 断言：**两个全新 vault** 各跑一遍，字节完全相同。

**Phase 3 · 先有尺子**（第 2–3 周）——eval 早于任何 LLM。

| 步骤 | 内容 | 状态 |
|---|---|---|
| S12 | eval runner + **20 条人工确认的 golden 集** | ✅ `evals/golden/extraction/` + `evals/runner/` + `evals/extractors/` |
| S13 | **不变量测试**：出处完整率、state 替换盖日期、`INDEX.md` 更新、emit 确定性 | ✅ `evals/invariants/`，**每条都配了反例** |
| S14 | CI 接阈值：**红了不许合** | ✅ 已落盘并接进闸门 3（`evals.mjs` + `G3_EVAL_GATE_MISSING`） |

**退出条件**：把 Extractor 换成"永远返回空"的假实现，**CI 必须变红**。
→ 已实现为一条每次 CI 都跑的检查（`E4_EVAL_RULER_BLIND`），而不是一次性验证：
阈值可以被调松、runner 可以被改松，而"分数够不够"都会继续绿。
另外三条边界也钉住了：空实现及格、召回率恰好等于阈值、只差一点点。

**Phase 3 的真实状态**：golden 集（20 条）与阈值（0.700 / 0.700）**已人工确认**
（`reviewed_by` / `ratified_by` = `allentire`）。确认**绑在内容指纹上**——
之后再动 golden 集或阈值一个字节，闸门就会报 `E2` / `E6` 变红，直到重新确认。
这是 implement2.md 人机分工表里 P3 的"人必须做：**阈值与 golden 集**"，
闸门负责检查它有没有发生、以及它是不是还对着当前这一份。

**Phase 4 · 第一处模型接缝**（第 3–5 周）——模型只做抽取，代码负责不信任。

| 步骤 | 内容 | 状态 |
|---|---|---|
| S15 | Extractor：LLM **只做抽取**；入库时强制低置信度起步、用真实抓取到的来源重建 `sources`、丢弃编造内容 | ✅ `packages/core/src/model.ts`（`Model` 接缝 + `sanitizeCandidates`）+ `apps/cli/src/model-http.ts` |
| S16 | **入库守卫**：不确定的一律进候选区 `_inbox/`，不直接进正式资产 | ✅ `packages/core/src/guard.ts` + `packages/store/src/inbox.ts` + `forge extract` / `forge inbox` |
| S17 | 跑 eval 定阈值；够不上就调 harness（分块、受控词表、提示），**不是换模型** | ⚠ 协议与可复现的管道已就位（cassette 录制/回放 + `model-replay`），**真实模型的分数没有数据**——没有 API key |

**退出条件**：extraction 精确率/召回率达标，且**连续 3 天稳定**。
→ **未达成**，而且这一行会一直这么写着。没有 API key 就量不出真实模型的分数，
而用一份手写的合成录像凑一组好看的分数，就是"让模型给自己发合格证"的另一种写法
（ADR-0024）。现在能做、也已经做了的是这些：

- **模型产出永远不进 `assets/`**：`origin === "model"` 是一条**不可配置**的判据，
  与置信度、与策略都无关。它由 `pnpm test` 里的变异用例钉住（把置信度拉满、
  把入库线放到 0，模型产出仍然只能进候选区）。
- **信任边界每次 CI 都问一遍**（`E7_EVAL_TRUST_BOUNDARY_OPEN`）：拿一台**敌意模型**
  走完整的真实路径（渲染请求 → 答 → 解析 → sanitize → 守卫），要求
  "零条编造出处的候选活下来、零条模型产出被判可直接入库、**且至少一条活到候选区**"。
  最后半句是关键：一个"什么都不放行"的实现能让前两条全绿。
- **没有 API key 也能跑完整的抽取链路**：`forge extract --cassette <录像>`。
  录像的键是**提示词的指纹**，所以 harness 一改、旧录像对不上时就报错，
  而不是悄悄拿一段回答别的问题的文字来充数。
- **管道的确定性**：同一份录像跑两次，候选区的字节完全相同（`apps/cli/test/extract.test.ts`）。

**已知未验证**（如实记账）：`model-http.ts`（真实端点调用）被**桩 fetch** 测过
（请求拼法、响应形状、非 2xx、端点拼斜杠，见 `apps/cli/test/model-http.test.ts`），
但**没有被真实端点测过**——鉴权是否被接受、超时怎么表现，都还没有数据；模型路径的抽取质量**没有数据**。两处都写在
`evals/README.md` 的「Phase 4 · 模型路径怎么量」里。

### 验证状态

`pnpm test`：**477 条测试，全部通过**；`pnpm lint` 干净；`tsc --noEmit` 干净。
`compile / lint / emit / context / extract --cassette / health / confirm / audit / weekly`
与 `serve` 全程不需要任何 API key。

> **上一版这里写着"236 条测试，其中 228 条通过"，而那句话是错的。** 它把"只差一个字段"
> 这个**推断**写成了结论，而落盘之后那 8 条并没有全绿——其中一个是真的判定 bug，
> 与那个字段无关（见 `evals/regressions/0005` 与 ADR-0032）。
> 此后这份文件凡是写"红了几条"，都同时写清红在**哪一层的哪一件事**上。

### 实测的尺子读数（`evals/README.md` 有完整表格）

| 实现 | 精确率 | 召回率 | 是否及格（阈值 0.700） |
|---|---|---|---|
| `baseline-lexical`（词法基线，无模型） | 0.882 | 0.882 | ✅ |
| `null`（永远返回空） | 0.000 | 0.000 | ❌ ← Phase 3 的退出条件 |
| `hostile-probe`（编造出处的敌意探针） | 0.200 | 0.471 | ❌ ← 分数低是**对的** |
| `model-replay`（真实模型 + 录像） | —— | —— | ⛔ 没有数据 |

**阈值是地板，不是目标。** 0.882 **不**等于"抽取质量已达 88%"——
它是"一个朴素的词法启发式在这 20 条上能做到 88%"。基线的漏报与误报逐条记在
`evals/README.md` 里，不挑好看的报。

### ⛔ 受保护路径挡住的部分（agent 不能自主写，见 `AGENTS.md` R2/R3）

Phase 4 要动 `schema/provenance.md`（候选断言的码从 5 条长到 9 条），
Phase 5 要动分类法本身（给 `state` 加必填的题面 `subject`，ADR-0025）——
两批都落在受保护路径上。闸门 1 实测拦下了 agent 的写入：

```
[A1_PROTECTED_PATH] scripts/gates/evals.mjs
    → 如果是正当变更：先写 docs/adr/NNNN-*.md 记录决策，再由人执行该改动
```

决策已经写下（`docs/adr/0021`–`0024` 与 `0025`–`0028`），产物在 `handoff/`——
**两批合成一份清单 v3**（Phase 4 那一条当时没有落盘，本次一并带上，见 `handoff/README.md`）。
**v3 已经落盘。** Phase 6 又落了一批 **v4**：`scripts/gates/consistency.mjs` 的
抽码正则只认一位数，于是 `E10`/`E11` 这类两位数码**根本不会被 `C4` 看到**——
改完它，handbook 里那两行才从"人写的"变成"机器要求的"（ADR-0033，
演练里配了一条**反例**：删掉那两行必须报红）。
Phase 8 的 **v5 也已经落盘**：ADR-0043 把子闸门的判定代码也搬到基线修订
（关闭 bypass-matrix 6.10），ADR-0044 接上发布前检查与真实的 `pnpm -r publish`。
落盘前 `node handoff/apply.mjs --verify` 已在临时仓库里验过两批载荷；
落盘后 `pnpm check` / `gate:ci` / `gate:trusted` 已重跑。
**"由人执行"就是一条命令**：

```bash
node handoff/apply.mjs            # 先看计划（dry-run）
node handoff/apply.mjs --verify   # 在临时目录里演练，核对结果与预期是否一致
node handoff/apply.mjs --yes      # 确认后落盘
pnpm check && pnpm gate:ci        # 全量测试 + 闸门 3 的完整判定
```

v3 / v4 / v5 都已经按这条流程落盘；`handoff/` 用完即删，现在不在仓库里。

**v3 一共八个文件**：Phase 4 的 `schema/provenance.md`，加上 Phase 5 的
`schema/taxonomy.yaml`、四份资产模板、`packages/schema` 的 `fields.ts` 与 `assets.ts`。
**v4 一个文件**（Phase 6）：`scripts/gates/consistency.mjs` 的抽码正则。
**v5 八个文件**（Phase 8）：五个 `scripts/gates/` 的文件（`ci.mjs` / `trusted-ci.mjs` /
`assets.mjs` / `consistency.mjs` / `evals.mjs`）、`release.mjs`、新增的
`release-preflight.mjs`、`.github/workflows/release.yml`。
其余产物都落在不受保护的路径上：判定在 `packages/core`（`model.ts` / `guard.ts` /
`link.ts` / `conflict.ts`），存储在 `packages/store`（`inbox.ts` / `conflicts.ts`），
闸门判定在 `evals/runner/gate.ts`（`E7`–`E9`）。
这是 ADR-0020 那条分工的延续：**判定住在能被测试的那一侧，受保护的那一侧只留薄壳。**

agent 没有、也不会用 `FORGE_GATE_OVERRIDE` 给自己放行（bypass-matrix 1.4 明确说
"agent 自己设置它属于违宪"），也不会走 1.5 那个已知的 Bash 缺口。
细节见 `evals/regressions/0001` 与 ADR-0043——那里还记着一次撞到的**闸门误报**
（`B4_DELETE_PROTECTED` 按子串匹配，一条只是**提到**受保护路径的命令会被拦下）。

> **上一批（Phase 3）已经在工作区里落盘了**，而 `README.md` 当时还写着"待人工落盘"。
> 这次一并改回事实，经过记在 `evals/regressions/0003`：
> 一份说"还没做"的文档比一份说错了的文档更危险——说错了会被纠正，说"还没做"的
> 只会让人不去看真实状态。

## Phase 5 · 归并与冲突（第 5–7 周）——模型提议，代码不自动应用

| 步骤 | 内容 | 状态 |
|---|---|---|
| S18 | Linker：规则优先，LLM 只判"这两条是不是同一件事"；不确定就新建 | ✅ `packages/core/src/link.ts`（规则路径**不需要模型**就能跑） |
| S19 | Conflict Judge：**只出候选 + 证据，不落库** | ✅ `packages/core/src/conflict.ts` + `evals/runner/conflict.ts` 的探针 |
| S20 | 人工冲突确认队列（**这是你未来的收费点**） | ✅ `packages/store/src/conflicts.ts` + `forge link` / `forge conflicts` |

**退出条件**：构造一组"新旧状态矛盾"的合成事件，**100% 进队列且证据正确，
无一条被自动覆盖**。
→ 已实现为一条**每次 CI 都跑的检查**（`E8` + `E9`），而不是一次性验证：
拿 9 条合成用例跑完整条真实路径（判定 → 落队列，落在内存里），要求
**该进队列的 6 条一条不少**、**每条候选两侧的证据都解析得到原文、而且原文里
写着它声称的那句话**、**资产侧零改动 + 判定模块零 IO**。
两个探测点各自配了变异用例（把判定改成"模型能一票否决"、把落盘改成"顺手应用"），
探针必须报红——只会变绿的检查不是检查。

**三条纪律都落在代码里，而不是提示词里**：

- **归并是分组，不是覆盖。** 链接只说"这条候选讲的是那个实体"，不改写任何字节。
  数据被改写只发生在两处：`forge inbox --promote` 与 `forge conflicts --resolve`，
  两处都由人触发。
- **拿不准就新建。** 归并的假阴性只是库里多一条；假阳性是两条事实被压成一条，
  而且看不出来。模型的归并提议**不会自动成立**，`proposedMergesApplied()` 自证它没被
  自动应用；当前它只在 `forge link` 的报告里可见——把归并提议也持久化成队列
  （`_conflicts/` 只收冲突候选）仍是尚未完成的一项。
- **冲突永不自动覆盖。** `ConflictCandidate` 的形状里没有"应用"这一档；
  改写只能由 `resolve --decision replace` 触发，而它必填日期与理由。
  落盘方式是**新一代状态 + `supersedes` 链**（旧的那代只改 `status`），
  于是用户的库里永远留着两代——`data/` 未必在 git 里（ADR-0028）。

**题面（`subject`）是这一期唯一动到 schema 的地方**（ADR-0025）：归并与冲突都要判
"这两条是不是同一件事"，而 `assets/state/*.md` 原本没有任何字段能表达它说的是哪件事。
`state` 现在必填 `subject`，缺了就报 `REQUIRED_FIELD_MISSING`——
因为**题面缺失 = 这条状态不参与冲突判定**，而那是这个产品最不能出的静默故障。

**实测的读数**（复现：`node evals/runner/main.ts`）：合成集 9 条，期望 6 条进队列、
实际 6 条；6 条候选两侧证据逐条核对通过；资产侧改动 0；判定模块里的 IO 0。
如实记账的部分（同义题面会漏并、措辞敏感带来的噪音、写一半的替换怎么修）写在
`docs/handbook/conflicts.md` 的「已知缺口」一节，不假装它们被解决了。

## Phase 6 · 取用与分发（第 7–9 周）——被"调用"，而不是被"打开"

| 步骤 | 内容 | 状态 |
|---|---|---|
| S21 | Retriever + 注入预算控制；**绝不预加载全库** | ✅ `packages/core/src/retrieve.ts` + `forge context`（ADR-0029） |
| S22 | MCP server，让 Claude / Cursor 直接调用你的资产 | ✅ `apps/mcp`（零依赖 stdio，四个工具）+ `forge mcp-config`（多客户端形状/路径） |
| S23 | 浏览器扩展：只做"取用 + 增量采集"，选择器配置可远端热更新 | ✅ `apps/extension` + `apps/cli/src/serve.ts`（ADR-0030） |
| S24 | Emitter v2：Skill 导出、Eval 导出 | ✅ `packages/core/src/emit-skill.ts` + `forge emit --skill / --evals`（ADR-0031） |

**退出条件**：**连续 3 天在真实工作里被"调用"，而不是被"打开"**。
→ **未达成，而且这一行会一直这么写着**——它是一条关于**使用行为**的判据，
不是一条能由代码证明的判据。把它写成"✅"就是这条 README 里最常见的谎
（`evals/regressions/0003` / `0005` 记了两次）。
现在能做、也已经做了的是：**让"被调用"这件事在结构上随时可以发生**——
一条命令取用、一个 MCP 工具、一个浏览器按钮，三者走的是同一份判定。

**P6 的 CI 强制项是"注入预算"，它是两条检查**（`E10` / `E11`）：

- `E10_EVAL_INJECTION_BUDGET`：拿**本仓库自己的 29 条资产**当语料、
  用它们的标题当查询，量**渲染出来的整块**（含"这不是全库"那几行）不许超预算；
  同时探针自己不许瞎——"一条都不给"的实现能让所有预算检查全绿。
- `E11_EVAL_PRELOAD`：对照查询（ASCII 乱码）必须一条都不注入；
  任一查询的注入条数不得超过语料的一半。
  **它必须单独判**：预加载不会让预算检查变红（预算够大就全绿）。

**实测的读数**（复现：`node evals/runner/main.ts`）：语料 29 条，
5 条查询 + 1 条对照 → 注入 12 条、判出无关 21 条、单块最大 1190/1200 token；
把预算压到下限 600 时注入 1 条、整块 533 token。
**变异验证过**：把"放不下就停"改成"全都塞进去"，`E10` 与 `E11` 同时报红。

**四条纪律落在代码里，而不是提示词里**：

- **打分可解释、产出确定。** `词法命中 × 字段权重 × 类型权重`，每条都带
  `why`（`闸门（题面 ×1 · 正文 ×2）`）。没有时钟、没有随机、可以快照、可以 diff——
  这是"为什么这条进来了"能被回答的前提。
- **绝不预加载。** 注入的每一条分数必须 > 0；无关的、被取代的、过期的
  **根本不进候选**，而且全部写在注入块**自己里面**（它会被人原样贴到别处去）。
- **一次判定，三个宿主。** CLI / MCP / 浏览器桥都走 `vault.context()`，
  测试里**逐字节**断言三者输出相同。"命令行看到的和 Cursor 里看到的不一样"
  这个问题在结构上不会出现。
- **扩展里没有判定。** 浏览器执行不了本仓库的 TypeScript，所以判定全在本机桥
  （`forge serve`）这一侧，扩展只剩 DOM 胶水。唯一成文的重复（"最长前缀赢"的
  站点匹配）被逐条比对测试钉住。

**如实记账的部分**（不假装被解决了）：

- **扩展没有被真的装进浏览器测过。** CI 里没有浏览器，`content.js` 那几十行
  DOM 胶水**没有任何自动化验证**——能测的只有它的**结构**（清单指向的文件存在、
  语法合法、没有 import 工作区、随包配置能被 core 解析）。与 `model-http.ts`
  同一类记账，写在 `apps/extension/README.md` 的「没做什么」里。
- **检索是词法的，会漏掉改写过的说法。** 这是刻意的取舍（可解释 vs. 质量），
  代价记在 ADR-0029 的残余风险里。
- **中文走二元组切分，字符级碰撞会让"无关"看起来有关。** 探针第一版的对照查询
  命中了 2 条 ADR（「的迁徙」撞上「的迁移」）——这不是缺陷，但它说明
  **对照查询不能用自然语言**。
- ~~**`C4_GATE_CODE_NOT_DOCUMENTED` 看不见两位数闸门码。**~~ **已在 Phase 6 修掉**
  （ADR-0033，`handoff/` v4 落盘）：抽码正则放宽成 `[A-G]\d{1,2}_`。
  从 `E10` 起，handbook 里那些行是**机器要求**的——删掉任意一行 CI 立刻红；
  Phase 7 的 `E12`–`E14` 就享受到了这条修好之后的待遇。

## Phase 7 · 维护机器（第 9–11 周）——护城河与订阅

| 步骤 | 内容 | 状态 |
|---|---|---|
| S25 | Linter：孤儿页、索引漂移、过期断言、静默被取代 | ✅ `packages/core/src/health.ts` + `forge health`（ADR-0034） |
| S26 | 新鲜度任务：state 超期主动确认 | ✅ `forge health --due` + `forge confirm`（ADR-0036） |
| S27 | 审计日志 + hook 强制执行，**不靠礼貌指令** | ✅ `packages/core|store/src/audit.ts` + `forge audit`（ADR-0035） |
| S28 | 健康报告 → 周报 | ✅ `packages/core/src/report.ts` + `forge weekly`（ADR-0037） |

**退出条件**：库里涨到 **500–1000 条事实仍然可用**。
→ **未达成，而且这一行会一直这么写着**——它是一条关于**人**的判据
（检索到的是不是真的答了问题、过期的有没有被及时看见），代码证明不了。
把它写成"✅"就是这份 README 里最常出现的那种谎（`evals/regressions/0003` / `0005`）。

现在能做、也已经做了的是：把"还能用"这句话的**地基**变成三条每 CI 都跑的读数（`E14`）——
1002 条语料下**两次产出字节相同**、埋在里面那处腐烂**仍然被找到**、
干净语料上**仍然零噪音**。这三条不成立时，"还能用"连地基都没有；但它们成立**不等于**库好用。

**四条纪律落在代码里，而不是提示词里**：

- **审计的强制点是写门的签名，不是一句"记得记审计"。**
  `writeAuthored(doc, draft)` 的第二个参数是必填的审计条目，运行时还会再问一遍
  （类型不是边界：`any`、从 JS 调过来都能绕过去）。顺手删掉了 `writeDerived`——
  它的调用点是零，而一个没人用的写门摆在无见证人的那一侧，就是在等有人用它绕开审计。
- **审计是写前日志，而且是一条哈希链。** 先记账后落盘：崩在两步之间留下的是**多记**
  （看得见，`AUDIT_DANGLING_SUBJECT` 会报），反过来是**漏记**（那条资产从此没有主人）。
  链能抓住三种破坏：删一行、改一行、换两行——删/改/换后的日志必须验不过。
- **新鲜度任务只能问，不能自己答。** `forge` 里**没有** `--auto-confirm`，
  这不是"还没做"：自动刷新 `last_confirmed` 会让库永远看起来新鲜，
  而"过期"是这个维护机器唯一有价值的信号（ADR-0036）。
  `confirm` 只动 `last_confirmed` 一个字段，由自证函数保证；理由进审计、不进资产。
- **健康检查只读，而且不打分。** 一个会自己修东西的健康检查会让库永远看起来健康；
  一个 0–100 的分数会把"哪件事该处理"变成"怎么把分数弄回去"（ADR-0034）。

**实测读数**（复现：`node evals/runner/main.ts`）：

| 探针 | 读数 |
|---|---|
| 审计 | 真的写入路径产出 3 条条目、行数 = 条目数；删/改/换序 **3/3 被抓住**；不给见证人 → 拒绝写入；手写文件 → 被看见 |
| 健康检查 | 11 组语料，干净那组 **0 条发现**；该报没报 0、不该报却报 0；本仓库 38 条资产跑一遍是**只读**且报告可重印 |
| 规模 | 1002 条语料：两次字节相同 · 埋的 1 处腐烂被找到 · 孤儿 0 条 |

**如实记账的部分**（不假装被解决了；完整清单在 `docs/handbook/maintenance.md`）：

- **审计挡不住直接改文件系统。** 任何人都可以往 `assets/` 里放 markdown，
  文件系统不会问"你记了吗"。审计能做的是让这种沉默的写入在健康检查里被看见
  （`AUDIT_UNATTRIBUTED_ASSET`），不是阻止它。
- **同时写没有锁。** 两个进程同时对同一个库 `promote` 会读到同一个链尾；
  链的验证会把它报出来，但不会阻止它。团队版（Phase 8）要加文件锁。
- **审计没有轮转。** 日志会持续增长；轮转要解决"轮转点之前的链怎么办"，那是另一个问题。
- **孤儿判定按来源目标算邻接，忽略锚点。** 早期库里来源少，孤儿会偏少。
- **回归集 10 条里有 2 条仍不能自动执行**（0003/0004，被测对象是已用完的一次性
  `handoff/apply.mjs`）。这是**写下来的缺口**，不是"已经覆盖了"。

## Phase 8 · 自举、团队与上架（第 11 周+）

| 步骤 | 内容 | 状态 |
|---|---|---|
| S29 | **自举**：用本项目的 CLI 管本项目的 ADR / 规则 / eval，目标自己产出 30+ ADR | ✅ `forge bootstrap`；**45 条 ADR** |
| S30 | 团队版**只在出现付费信号后**做：权限、敏感度分级、同步 | ⛔ **按设计未启动**（没有付费信号）；`docs/team/status.json` 的 `payment_signal` 是 `null` |
| S31 | 上架路径：Skill/MCP 提交 | ⚠ `forge listing` 生成可提交的 **draft** 包；MCP 的发布元数据已准备，但仍是 `private`；**没有提交、没有上架** |
| S32 | 对外 demo = **你自己的库**，不是编造的样例 | ✅ `forge demo`；`demo/` 从本仓库自己的 45 条 ADR 生成 |

**S29 不是数到 30 就完事。** `forge bootstrap` 一起判六件事：
ADR ≥ 30、所有资产能过 `judgeLibrary`、`AGENTS.md` 的 8 条种子规则都有出处、
两把尺子都被人工确认、`listing/` 与 `demo/` 与库逐字节一致、团队版没有提前开闸。
这六件事同时被 `E15` / `E16` 在每次 CI 里问一遍。报告的实测输出：

```
✓ 自举：45 条 ADR（目标 ≥ 30）
  资产：45 条（decision 45）
  种子规则：8 条（上限 8；每条都有出处）
  尺子：extraction confirmed（allentire）· conflict confirmed（allentire）· 阈值批准 allentire
  团队版：deferred（付费信号：无；缺失能力：权限 / 并发 / 敏感度切分）
  产物 listing：53 个文件逐字节一致
  产物 demo：49 个文件逐字节一致
```

**S30 的状态是"还没到时候"，不是"还没做完"。** implement2.md 的原话是
"团队版**只在出现付费信号后**做"。所以权限、并发、敏感度切分一行代码都没有；
`docs/team/status.json` 把 `payment_signal` 记为 `null`、三项能力全 `false`。
如果有人在没有信号时把任何一项改成 `true`，`forge bootstrap` 与 `E16` 会红。
代码证明不了有人付钱；它只负责让"先做了"不能悄悄变成"已就绪"（ADR-0040）。

**S31 的产物永远是 `draft`。** `forge listing` 生成
`marketplace.json` / `plugin.json` / `.mcp.json` / `SKILL.md` + `references/`，
但 `manifest.json` 里固定是 `status: "draft"`、`published: false`。
提交需要人：账号、仓库 URL、一个真正可安装的 `@forge/mcp`（当前仍是 `private: true`）、
平台审核。`listing/SUBMISSION.md` 把未完成项列成清单，生成器**不编造**这些元数据。
**发布路径已经不再是一个占位**：ADR-0044 的 `release-preflight.mjs` 会在 `publish`
之前检查版本、`private`、依赖链、`files`/`engines`/`publishConfig`；`release.yml`
用 `pnpm -r publish --provenance` 发布。真正按下发布键仍然需要人（凭据、scope、版本）。

**S32 的 demo 没有样例数据入口。** `demo/` 的每一页、每一处出处都来自本仓库自己的
45 条 ADR；`library.json` 的 `source` 写着 `repo`。所有文本都做 HTML 转义，
页面没有外部脚本 / 样式 / 字体，直接打开 `index.html` 即可，两年后也不需要某个 CDN 还在。
小型 Markdown 渲染器不覆盖全部 CommonMark（复杂表格原样显示为 `pre`）——
这是刻意的取舍：不丢内容、不乱执行，比排版与 GitHub 一致更重要（ADR-0042）。

**这一期的 CI 强制项是两条**：

- `E15_EVAL_BOOTSTRAP_DEGRADED`：ADR 跌破 30 条、资产读不动、产物不可重生成、
  或 demo 不是自己的库 → 红；
- `E16_EVAL_TEAM_UNGUARDED`：没有付费信号却开了团队能力 → 红。
  `deferred` / `partial` **不报错**——"还没做"和"做错了顺序"是两件事。

## 快速开始

```bash
pnpm install        # 同时安装本地闸门（core.hooksPath=.githooks）
pnpm check          # lint + typecheck + test
pnpm eval           # 跑一次尺子（默认词法基线，不需要 API key）
pnpm forge extract --cassette <录像>   # 模型抽取 → 候选区（不需要 key）
pnpm forge link                        # 归并 + 冲突判定 → 队列（不写 assets/）
pnpm forge conflicts                   # 冲突队列：列出 / --resolve 由人判决
pnpm forge inbox                       # 看候选区
pnpm forge context "存储后端怎么选"      # 取用：预算内的一段注入（**不是全库**）
pnpm forge emit --out out --skill --evals   # 多出口：投影 + Skill + 候选用例集
pnpm mcp --vault data                  # MCP：让 Claude / Cursor 直接调你的库
pnpm forge mcp-config --list           # 支持的 MCP 客户端（VS Code / Zed / Codex / Continue …）
pnpm forge mcp-config --client cursor --vault data   # 生成可直接粘贴的配置片段
pnpm mcp:smoke --vault data            # 通用 MCP stdio 冒烟：四个工具 + stdout 纯净
pnpm forge serve                       # 本机桥：浏览器扩展靠它取用 + 采集
pnpm forge health --today 2026-11-06   # 健康检查：四类腐烂 + 审计（只读）
pnpm forge health --today 2026-11-06 --due   # 定时任务问的那一句（有到期 → 非零）
pnpm forge confirm <状态 ID> --date 2026-11-20 --note "为什么仍然成立"
pnpm forge audit --verify              # 核对审计哈希链（断了 → 非零）
pnpm forge weekly --today 2026-11-06   # 周报：这周变成了什么样 + 谁动了它
pnpm forge automate --list             # 自动化政策：可无人值守 / 准备给人 / 禁止
pnpm forge automate --out .forge-automation   # 生成 cron / Task Scheduler / 流水线配方
pnpm forge bootstrap                   # 自举：ADR / 规则 / eval / 产物（S29）
pnpm forge listing --repo --out listing  # 上架包：永远是 draft（S31）
pnpm forge demo --repo --out demo        # 对外 demo：自己的库（S32）
pnpm gate:rehearse  # 退出条件演练（临时克隆，不碰工作区）
```

**Windows**：`pnpm forge` / `pnpm mcp` 已经走 tsx（没有符号链接权限时，pnpm 的 junction
会把 workspace 包解析进 `node_modules`，Node 的原生类型擦除拒绝那里的 `.ts`）。
也可以直接用仓库根的包装：`.\forge.ps1`、`forge.cmd`、`forge-mcp.cmd`。
语法是 PowerShell / cmd，不是 bash。

桌面客户端怎么接（Claude Desktop / Claude Code / Cursor 的复制即用配置）见
[`docs/handbook/mcp.md`](docs/handbook/mcp.md)。

## 五道闸门

| # | 闸门 | 载体 | 权威性 |
|---|---|---|---|
| 1 | agent hook | `.claude/settings.json` → `scripts/gates/agent-guard.mjs` | 早期反馈 |
| 2 | pre-commit | `.githooks/pre-commit` | 早期反馈 |
| 3 | required status check | `.github/workflows/ci.yml` → `pnpm gate:trusted` + `pnpm gate:ci` | **权威** |
| 4 | branch rule | `scripts/gates/setup-branch-protection.sh` | **权威** |
| 5 | 发布门 | `.github/workflows/release.yml` | **权威** + 人工审批 |

判定逻辑只有一份：`scripts/gates/lib/policy.mjs`（纯函数、零 IO）。
**本地闸门全部可被绕过，权威只在服务端**；且**变更集判定与 harness 完整性检查**
由**基线修订**里的闸门执行（`trusted-ci.mjs`），所以"删掉或改松这两样"不能给自己发合格证。

⚠ 这句话有边界，别读多了：`ci.mjs` 的第 3 步（`consistency/assets/evals` 三个子闸门）
跑的是**工作树**里的文件。所以"改松子闸门的判定"在第 1、2 步过不去，在第 3 步过得去。
这是**已知且成文**的缺口（`docs/gates/bypass-matrix.md` 6.10 + `evals/regressions/0001`），
不是已经解决的事——完整清单见 `docs/gates/bypass-matrix.md`。

## 建 remote 之后要做的两件事

```bash
scripts/gates/setup-branch-protection.sh --approvals 0    # 闸门 3/4：required check + branch rule
scripts/gates/setup-branch-protection.sh --environment-reviewer <login>   # 闸门 5：发布人工审批
```

（`--approvals 0` 是单人模式的取舍：CI 绿即可自合。取舍理由记在 bypass-matrix 3.x。）

## 目录

```
scripts/gates/      五道闸门的实现（自身也是受保护路径）
packages/schema/    两套 IR + 校验 + ID + 迁移通道（受保护路径）
packages/core/      编译与维护引擎：零 IO 纯函数（R5）
                     · extract.ts 接缝与信任边界 · model.ts 模型接缝 + sanitize
                     · guard.ts 入库守卫（S16）
                     · link.ts 归并（S18）· conflict.ts 冲突判定（S19，只出候选）
                     · retrieve.ts 检索与注入预算（S21）· emit-skill.ts 多出口（S24）
                     · selectors.ts 选择器与增量采集（S23，纯逻辑、无 DOM）
                     · health.ts 四类腐烂（S25）· audit.ts 哈希链与对账（S27）
                     · report.ts 健康报告与周报（S28）
                     · team.ts 团队版闸门（S30）· bootstrap.ts 自举判定（S29）
                     · distribution.ts 上架包（S31）· demo.ts 对外演示（S32）
                     · automation.ts 三档自动化政策 + 配方生成（`forge automate`）
packages/store/     sources / assets / index 三层 + _inbox 候选区 + _conflicts 冲突队列
                     + audit 只追加日志 + cassette 录像
                     · vault.context() / vault.capture()：三个宿主共用的取用与采集入口
                     · vault.health() / vault.weekly() / vault.confirm()：维护机器
packages/ingest/    连接器契约 + 两个连接器（官方导出 / 浏览器采集，纯解析）
apps/cli/           forge compile / lint / emit / extract / inbox / link / conflicts
                     / context / health / confirm / audit / weekly / serve
                     / bootstrap / listing / demo（Phase 8）
                     · model-http.ts 与 serve.ts 是**仅有的两处碰网络的地方**
apps/mcp/           MCP server：四个工具（context / search / get / lint），零依赖 stdio
docs/integrations/  MCP 客户端清单（clients.json）：形状 / 路径 / 作用域，`forge mcp-config` 的唯一数据源
apps/extension/     MV3 扩展：只做**取用 + 增量采集**；判定在 core，DOM 胶水在这里
evals/              先有尺子：两把尺子（extraction / conflict）/ 四个抽取实现
                     （含两台探针）/ runner / 三个探针（信任 / 冲突 / 取用）
                     + 维护探针（审计 / 健康 / 规模，E12–E14）· 不变量 · 回归集
evals/regressions/  真实踩过的坑；`regressions.test.ts` 是它们的**执行体**（Phase 7 兑现）
evals/fixtures/     脱敏样例导出 + 冲突合成集的证据层（真实导出进不了 git——R1）
docs/adr/           本项目自己的决策记录（吃自己的狗粮）
docs/gates/         绕过方式清单
docs/automation.md  三档自动化政策：可无人值守 / 准备给人 / 设计上禁止；配方由 `forge automate` 生成
docs/handbook/      上手与操作手册 · conflicts.md 是队列怎么用 · maintenance.md 是维护机器
                     · bootstrap.md 是自举 / 团队版 / 上架
docs/team/          团队版的闸门状态：payment_signal 与三项能力（S30）
listing/            上架包（draft）——由 `forge listing --repo` 生成，bootstrap 校验
demo/               对外 demo——由 `forge demo --repo` 生成，bootstrap 校验
AGENTS.md           agent 的种子规则（≤ 8 条，CI 校验）
forge.cmd / forge.ps1        Windows 启动垫片（tsx）：CLI 与 MCP 各一对
docs/handbook/mcp.md         Claude Desktop / Claude Code / Cursor 的复制即用配置
data/               用户数据，gitignored
```

**`evals/` 的读法**（ADR-0020）：打分在 `packages/core`（纯函数），信任边界在
`packages/core/src/extract.ts` 的 `judgeCandidates`，**闸门的判定**在 `evals/runner/gate.ts`，
而 `scripts/gates/evals.mjs` 只是薄壳。判定之所以住在不受保护的 `evals/` 里，
是为了让它在落盘之前就能被测试——**"闸门第一次运行"不该发生在它生效的那一刻**。

**包划分的说明**（ADR-0018）：`directory.md` 的完整目录树里还有 `packages/emit`、
`packages/provenance`、`packages/lint`——**现在不建**。判据是"出现第二个消费者再下沉"：
在第二个消费者出现之前拆包，只是在制造需要维护的空壳，而空壳的害处是让人以为那里有边界。
