# Handbook · 闸门怎么用

## 首次上手

```bash
pnpm install          # prepare 生命周期会设置 core.hooksPath=.githooks
pnpm check            # lint + typecheck + test
pnpm gate:rehearse    # 演练：故意写错的改动必须被拦住
```

## 日常命令

| 命令 | 作用 |
|---|---|
| `pnpm test` | 全部测试：闸门自身 + `packages/*` 的纯逻辑 + CLI 端到端 |
| `pnpm lint` / `pnpm typecheck` | 与 CI 相同的静态检查 |
| `pnpm check` | 上面三件事一起跑（提交前的完整本地验证） |
| `pnpm gate:ci` | **闸门 3 的本地等价物**：变更集 + harness 完整性 + schema 一致性 + 资产出处 + 重活 |
| `pnpm gate:trusted` | **闸门 3 的权威形态**：闸门代码取自基线修订，判定当前工作树（ADR-0005） |
| `pnpm gate:rehearse` | 退出条件演练（临时克隆里跑场景，不碰工作区）；CI 也会跑 |
| `node evals/runner/main.ts` | **跑一次尺子**（默认词法基线）；`--extractor null` 是"尺子还睁着眼吗"的反例，`--extractor hostile-probe` 是信任边界的探针，`--list` 列出可驱动的实现 |
| `node evals/runner/main.ts --extractor model-replay` | 对着录像跑一次模型抽取（需要 `FORGE_CASSETTE=<文件>`）；**不走网络**，所以结果可复现 |
| `node scripts/gates/consistency.mjs` | 只跑 schema 一致性（`schema/` ↔ `packages/schema`） |
| `node scripts/gates/assets.mjs` | 只跑资产出处审核（本仓库里所有带 front-matter 的 markdown） |
| `node scripts/gates/evals.mjs` | 只跑 eval 判定（阈值 + 两把尺子的人工确认 + 信任边界 / 冲突 / 取用 / 维护四个探针） |

## 产品侧的十六条命令（`forge`）+ 两个宿主

```bash
node apps/cli/src/main.ts compile --import <导出文件>   # 来源 → 事件 IR → 重建索引
node apps/cli/src/main.ts lint --repo                    # 审核本仓库的资产
node apps/cli/src/main.ts emit --out <目录>              # 资产 → AGENTS.md / INDEX.md / adr/
node apps/cli/src/main.ts bootstrap                      # 自举：ADR / 规则 / eval / 两个对外产物（S29）
node apps/cli/src/main.ts listing --repo --out listing   # 上架包（S31，永远 draft）
node apps/cli/src/main.ts demo --repo --out demo         # 对外 demo（S32，自己的库）
node apps/cli/src/main.ts extract --cassette <文件>       # 事件 → 模型抽取 → 守卫 → 候选区
node apps/cli/src/main.ts inbox                          # 候选区：列出 / --promote 确认成草稿
node apps/cli/src/main.ts link                           # 归并 + 冲突判定 → 队列（不写 assets/）
node apps/cli/src/main.ts conflicts                      # 队列：列出 / --resolve 由人判决
node apps/cli/src/main.ts context "存储后端怎么选"        # 取用：检索 → 预算内的一段注入（S21）
node apps/cli/src/main.ts health --today 2026-11-06       # 健康检查（S25）：四类腐烂 + 审计
node apps/cli/src/main.ts health --today 2026-11-06 --due # 只问到期的（S26 的定时任务问这个）
node apps/cli/src/main.ts confirm <状态 ID> --date <日期> --note <为什么仍然成立>   # 人重新确认（S26）
node apps/cli/src/main.ts audit [--verify]                # 审计日志：列出 / 核对哈希链（S27）
node apps/cli/src/main.ts weekly --today 2026-11-06       # 周报（S28）：这周变成了什么样 + 谁动了它
node apps/cli/src/main.ts serve                           # 本机回环桥：浏览器扩展靠它取用 + 采集
node apps/mcp/src/main.ts --vault data                    # MCP server（stdio）：给 Claude / Cursor
```

`bootstrap` / `listing` / `demo` 是 Phase 8 加的三条，用法见
`docs/handbook/bootstrap.md`。`bootstrap` 会把 `listing/` 与 `demo/` 和库逐字节比对，
所以这三条命令的顺序是"先修库、再重新生成产物、最后跑 bootstrap"。

`emit` 的输出**逐字节确定**（R6 / ADR-0017）：同样的库跑两次得到同样的字节。
`emit --check` 只比对不写盘，适合进 CI。`compile / lint / emit` 全程不需要任何 API key。

`extract` 是唯一会碰到模型的一条，而它**只有两种来法**：

| 方式 | 要 key 吗 | 结果可复现吗 | 什么时候用 |
|---|---|---|---|
| `--cassette <文件>` | 不要 | 是 | 评测、CI、复现别人报的问题 |
| `--record <文件>` | 要 | 录完就对着一份录像跑 | 第一次接一个新 harness / 新模型 |

`link` / `conflicts` 是 Phase 5 加的那一对，用法见 `docs/handbook/conflicts.md`：

```bash
node apps/cli/src/main.ts link          # 候选区 × 现有资产 → 归并（S18）+ 冲突判定（S19）
node apps/cli/src/main.ts conflicts     # 看队列：每条都带两侧的证据 span
node apps/cli/src/main.ts conflicts --resolve <ID> --decision replace     --date 2026-11-06 --confidence 0.8 --rationale "确认过线上就是这样"
```

`link` **一个字节都不写 `assets/`**：判定只出候选与证据，改写只能由
`conflicts --resolve` 触发——那个命令是**全项目唯一**能改动已有状态的地方（ADR-0028）。
这条边界由 `E9` 每次 CI 问一遍。

`context` / `serve` / `mcp` 是 Phase 6 加的三个取用入口，**它们走的是同一份判定**
（`vault.context()`），所以三处给出的是**同一段字节**——两处都写了逐字节断言的测试：

```bash
node apps/cli/src/main.ts context "索引层的存储后端" --budget 1200 --today 2026-11-06
node apps/cli/src/main.ts serve --port 8787 --selectors https://example.com/selectors.json
node apps/mcp/src/main.ts --vault data
```

- `context` 把注入块打到 **stdout**，计数与提示打到 **stderr**——于是 stdout 可以被
  原样重定向进任何模型的上下文。
- `serve` 只绑 `127.0.0.1`，**要 token**（不给就生成一个打在 stderr 上），
  网页来源一律 403。回环不等于安全：任何一个网页都能向 `http://127.0.0.1:8787` 发请求。
- MCP 的四个工具是 `forge_context` / `forge_search` / `forge_get` / `forge_lint`。
  **`search` 只列条目、`get` 才读全文**——把它们合成一个"返回全文的搜索"，
  就是把预加载做成默认行为。

`health` / `confirm` / `audit` / `weekly` 是 Phase 7 加的维护机器，用法见
`docs/handbook/maintenance.md`。三条规矩值得在这里重复一遍，因为它们全在**退出码**上体现：

| 命令 | 退出码 | 谁在用 |
|---|---|---|
| `health --due` | 有到期的 → 非零 | **定时任务**：cron 只在需要你动手时才来敲门 |
| `audit --verify` | 链断了 → 非零 | CI / 定时任务：它是"审计完整性"的读路径 |
| `health`（不带 `--due`） | 有需要处理的 → 非零 | 人：孤儿（仅供参考）**不进**退出码 |

**模型产出永远不进 `assets/`**（S16 / ADR-0022）：它们一律落进候选区 `_inbox/`，
由 `forge inbox --promote` 由人确认成一份**草稿**。确认时 `--date` 与 `--confidence`
都是必填——那两个是人的判断，给默认值会让"确认"退化成一次点击。

## 闸门红了怎么办

**修问题，不要修闸门。** 具体判断：

| 报错码 | 含义 | 正确动作 |
|---|---|---|
| `A1_PROTECTED_PATH` | agent 试图写受保护路径 | 先写 ADR，再由人执行；临时放行需人显式设置 `FORGE_GATE_OVERRIDE` |
| `B1_SKIP_HOOKS` | `--no-verify` / `git commit -n` | 去掉它，先修好被拦下的问题 |
| `B2_FORCE_PUSH` | 强推会重写历史，而审计依赖历史不可变 | 改用普通 push；需要覆盖时开新分支 |
| `B3_UNWIRE_HOOKS` | 改 `core.hooksPath` 等于摘下闸门 2 | 闸门配置的改动要走 ADR，由人执行 |
| `B4_DELETE_PROTECTED` | 命令试图删除受保护路径 | 删除受保护路径需要 ADR + 人工执行 |
| `R1_USER_DATA_IN_REPO` | 用户数据进了 git | `git restore --staged <path>`，确认 `.gitignore` |
| `R2_PROTECTED_WITHOUT_ADR` | 改到了受保护路径且没有 ADR | 在 `docs/adr/` 新增一条 ADR 一起提交；或提交信息加 `ADR: <id>` 尾注 |
| `R3_SECRET_IN_REPO` | `.env*` 等进了 git | 移出暂存区；样板用 `.env.example` |
| `G0_AGENTS_MD_MISSING` | `AGENTS.md` 不存在 | 恢复它 |
| `G0_AGENTS_MD_NO_RULES` | 解析不到 `### R<n>` 规则块 | 按 `### R1 · 标题` 的格式写 |
| `G0_AGENTS_MD_TOO_MANY_RULES` | 规则超过 8 条 | 删到 8 条以内：新规则只能由真实错误长出 |
| `G0_AGENTS_MD_RULE_NO_ORIGIN` | 规则没有 `出处` | 每条规则都要能追溯到一个具体出过的问题 |
| `G1_AGENT_HOOK_MISSING` | `.claude/settings.json` 不存在：闸门 1 没装 | 恢复配置 |
| `G1_AGENT_HOOK_UNPARSEABLE` | 配置不是合法 JSON：闸门 1 静默失效 | 修好 JSON |
| `G1_AGENT_HOOK_UNWIRED` | PreToolUse 里没有 hook 调用 `agent-guard.mjs` | 把它挂回去 |
| `G2_GIT_HOOK_MISSING` | `.githooks/` 下缺钩子 | 恢复钩子脚本 |
| `G2_GIT_HOOK_UNWIRED` | 钩子被改成了空壳 | 让它执行对应的 `*.mjs` |
| `G2_HOOKS_PATH_NOT_SET` | 本机 `core.hooksPath` 没指向 `.githooks` | `pnpm prepare` |
| `G3_CI_WORKFLOW_MISSING` | `ci.yml` 不存在：闸门 3 没有载体 | 恢复 workflow |
| `G3_REQUIRED_JOB_MISSING` | 没有 job id 为 `gates` 的任务 | 恢复它（分支保护的 context 就是这个名字） |
| `G3_CI_ENTRY_MISSING` | CI 没执行 `pnpm gate:ci`：空转的绿灯 | 加回这一步 |
| `G3_TRUSTED_JUDGE_MISSING` | CI 不再用基线修订的闸门判定 | 恢复 `pnpm gate:trusted`（ADR-0005） |
| `G3_SHALLOW_CLONE` | 浅克隆会让 diff 为空、闸门静默空转 | `actions/checkout` 里设 `fetch-depth: 0` |
| `G3_EVAL_GATE_MISSING` | eval 阈值子闸门被删掉，或 `ci.mjs` 不再调用它 | 恢复 `scripts/gates/evals.mjs` 并把 `"evals.mjs"` 加回 `ci.mjs` 的子闸门清单 |
| `G5_RELEASE_WORKFLOW_MISSING` | `release.yml` 不存在 | 恢复它 |
| `G5_RELEASE_ENTRY_MISSING` | 发布 workflow 没执行 `gate:release` | 加回这一步 |
| `G5_RELEASE_APPROVAL_MISSING` | 发布门没有人工审批环节 | 加 `environment: release` 并配 required reviewers |
| `C1_TAXONOMY_DRIFT` | `schema/taxonomy.yaml` 与代码常量不一致（前缀 / lifecycle / 必填项 / 新鲜度） | 两边一起改；**改分类法要走 ADR**（R2） |
| `C2_CODE_NOT_DOCUMENTED` | 违规码或 ID 前缀没有出现在 `schema/provenance.md` / `schema/ids.md` | 码与文档是契约，契约不该能单方面改（ADR-0010） |
| `C3_TEMPLATE_INCOMPLETE` | 资产模板漏了必填字段或必填章节 | 照着 `schema/taxonomy.yaml` 补模板 |
| `C4_GATE_CODE_NOT_DOCUMENTED` | 闸门码没有出现在本文件里 | 在表里加一行——**检查者无人审查**是下一个"看起来在保护你"的东西 |
| `ASSET_FRONTMATTER_INVALID` | front-matter 不合法 | 补全字段，见 `schema/taxonomy.yaml` |
| `SCHEMA_VERSION_MISMATCH` | 版本号与分类法不一致（**缺版本号 = v0**） | 跑迁移通道；不要在闸门里顺手兼容（ADR-0008） |
| `ID_PREFIX_MISMATCH` | ID 前缀与 `type` 字段不一致 | 改成同一个类型，前缀表见 `schema/ids.md` |
| `PROV_NO_SOURCES` | 没有 `sources` | 补出处——没有出处的一行不许进 `assets/`（R4） |
| `PROV_SPAN_UNRESOLVED` | span 语法不合法，或目标/锚点解析不到 | 去修 span，或指向仍然存在的那一处 |
| `PROV_SCHEME_UNAVAILABLE` | 本宿主校验不了这个 scheme（如 CI 里没有 `sources/`） | **这是「无法校验」，不是「通过」**；到能校验它的宿主里跑 |
| `REQUIRED_FIELD_MISSING` | 类型要求的字段缺失（`rule.origin_incident` / `state.last_confirmed` / `state.subject`） | 补上；要求写在分类法里，不在文档里。`state` 缺 `subject` 的后果是**它不参与冲突判定**（ADR-0025） |
| `REQUIRED_SECTION_MISSING` | 类型要求的正文章节缺失 | 按 `schema/asset-types/<类型>.md` 补 |
| `FRESHNESS_EXPIRED` | `state` 超过窗口未确认（**只由 `forge lint --today` 报，不进闸门**） | 确认是否仍成立；仍成立就更新 `last_confirmed` |
| `CAND_NO_TITLE` / `CAND_NO_SOURCES` | 候选断言没有标题 / 没有 `sources` | 见 `schema/provenance.md` 的「候选断言的码」一节 |
| `CAND_SPAN_MALFORMED` | 候选断言的出处不是合法 span | 按 `schema/provenance.md` 的语法改 |
| `CAND_SPAN_NOT_SOURCE` | 候选断言用了 `file://` 之类的非 `src://` scheme | 抽取阶段的证据就是事件本身，只能用 `src://` |
| `CAND_SPAN_NOT_IN_INPUT` | 出处指向**本次输入里不存在的事件**——编造的出处 | 只引用输入里存在的事件键；引不出来说明这条候选没有依据 |
| `CAND_EXTRACTOR_THREW` | 抽取器自己抛了异常（模型端 500、录像对不上…） | 先修抽取器的异常；**别把它吞成"这次什么都没抽出来"** |
| `CAND_TYPE_UNKNOWN` | 模型给的类型不在受控词表里（不是四种资产类型之一） | 受控词表是四选一。整条丢掉，不是"顺手归到最近的类型" |
| `CAND_RESPONSE_UNPARSEABLE` | 模型的响应读不成约定的形状（JSON 坏了、没有 `assertions`） | 去调 harness（提示词 / 输出契约 / 分块），**不是换模型** |
| `CAND_CONFIDENCE_FORCED` | 置信度被代码压到入库上界（模型自称 0.99 也只按 0.3 算） | **不需要动手**：这是"低置信度起步"的执行体。它是痕迹，不是待办 |
| `E1_EVAL_BELOW_THRESHOLD` | 抽取实现没够上阈值 | 修实现或修尺子。**不要调低阈值**——那只会让下一次的问题更晚被发现 |
| `E2_EVAL_GOLDEN_UNREVIEWED` | golden 集还没被人工确认（**两把尺子各一份**：`evals/golden/extraction/` 与 `evals/golden/conflict/`） | 逐条核对那份 `cases.json` 的 `why`，再把 `review` 块填上。冲突合成集的判据是"人工读一遍：这些矛盾确实该进队列、那些不该进的确实不该进" |
| `E3_EVAL_CANDIDATE_PROVENANCE` | 候选断言的出处是编的/缺失的（信任边界被越过） | 按 `CAND_*` 的修法改抽取实现——**代码不信任模型** |
| `E4_EVAL_RULER_BLIND` | 把实现换成"永远返回空"的那个，它**依然及格** | 先修尺子（runner / 阈值 / 比对方式），再接模型。这是 Phase 3 的退出条件 |
| `E5_EVAL_GOLDEN_INVALID` | 用例自己坏了：判据指不回原文、事件不合 schema、期望对不上输入 | 修用例。**此时分数不可采信**——不要把它读成"抽取器不及格" |
| `E6_EVAL_THRESHOLD_UNRATIFIED` | 阈值还没被人工批准 | 读过 `evals/README.md` 的实测数字之后，填 `evals/thresholds.json` 的 `ratified_by` |
| `E7_EVAL_TRUST_BOUNDARY_OPEN` | 信任边界被越过：**敌意模型**的产出穿过了 sanitize 或守卫（编造出处的候选活了下来，或模型产出被判成可直接入库） | 修边界（`sanitizeCandidates` / `guardCandidates`），不要改探针。这是 Phase 4 的退出条件 |
| `E8_EVAL_CONFLICT_QUEUE_INCOMPLETE` | 合成的"新旧状态矛盾"没有 100% 进队列，或者进队列的证据对不上原文（锚点没指向它声称的那句话） | 修**判定**或修**用例**：`evals/golden/conflict/cases.json` 与 `packages/core/src/conflict.ts`。**不要**放宽判据——漏报一次"状态被推翻"比多报十条难查得多。Phase 5 退出条件的前半句 |
| `E9_EVAL_CONFLICT_AUTO_APPLIED` | 有冲突被**自动应用**了：判定模块里出现了 IO/时钟，或走完"判定 → 落队列"之后资产侧被改动 | implement2.md 给 P5 写的那条 CI 强制项就是四个字：**无自动覆盖**。冲突必须等人 `resolve`——队列是唯一能改写已有状态的通路（ADR-0027/0028） |
| `E10_EVAL_INJECTION_BUDGET` | 注入块撑破了预算（量的是**渲染出来的整块**，含元信息），或者取用探针自己瞎了（所有查询一条都没注入 / 每个查询都把整个库判成「有关」） | implement2.md 给 P6 写的那条 CI 强制项就是四个字：**注入预算**。要更多内容就给更大的 `--budget`，**不要**让注入块自己长大。探针的语料是**本仓库自己的 29 条资产**，判定在 `packages/core/src/retrieve.ts`（ADR-0029） |
| `E11_EVAL_PRELOAD` | 检索退化成了预加载：注入里出现分数为 0 的条目、注入条数超过语料的一半、或者对照查询（明明无关）也注入了东西 | 修**相关性判据**，不要动预算——预加载**不会**让 `E10` 变红（预算够大就全绿），所以它必须单独判。这是"绝不预加载全库"的执行体（ADR-0029） |
| `E12_EVAL_AUDIT_GAP` | 审计不完整：链断了、三种破坏（删一行 / 改一行 / 换两行）有没被抓住的、或者**不给见证人也能写资产** | implement2.md 给 P7 写的那条 CI 强制项就是四个字：**审计完整性**。修**写路径**（`writeAuthored` 的第二个参数不许变成可选），不要放宽探针（ADR-0035） |
| `E13_EVAL_HEALTH_BLIND` | 健康检查分不开「健康」和「烂掉」：干净语料上报了东西（噪音）、某组腐烂没被认出来（瞎了）、它改了库（不是只读）、或者报告不能重印 | 两个方向都要保住：干净时零发现，烂的时候**只报那一种**。改 `packages/core/src/health.ts` 的判据，或者改语料（但语料改了要能说清为什么） |
| `E14_EVAL_SCALE_DEGRADED` | 规模上去之后退化：1000 条语料两次产出字节不同，或者埋在里面的那处腐烂被淹掉了 | 这是 P7 退出条件（"涨到 500–1000 条仍然可用"）的**结构性替身**。它证明机器不崩、信号不淹，**不证明**库还好用（ADR-0038） |
| `E15_EVAL_BOOTSTRAP_DEGRADED` | 自举 / 分发退化：ADR 跌破 30 条、资产读不动或审核不过、demo / listing 不可重生成、demo 不是从自己的库完整生成、或上架包不再自称 draft | P8 的交付物是**自举 + 上架 + demo**，三条都必须能重算。补真实 ADR、修资产、重新生成产物；**不要**关掉探针（ADR-0039 / 0041 / 0042） |
| `E16_EVAL_TEAM_UNGUARDED` | 没有付费信号，却已经打开权限 / 并发 / 敏感度切分中的任何一项 | implement2.md S30 的第一句话就是"团队版**只在出现付费信号后**做"。`deferred` / `partial` 不是错误；只有"没信号却开了能力"才是。信号由人写进 `docs/team/status.json`（ADR-0040） |
| `HEALTH_ORPHAN` | 一条资产没有任何邻居（没人取代它、它没取代谁、没人与它共享同一处来源、同一题面下只有它） | **仅供参考，不进退出码**。看一眼值不值得留：值得就把它接起来，不值得就删掉（ADR-0034） |
| `HEALTH_INDEX_DRIFT` | `index/` 与 sources + assets 算出来的对不上（或索引根本不在） | 跑一次 `forge compile` 重建。**不要手工改 `INDEX.md`**：它是投影，改它等于制造第二份真相（ADR-0015） |
| `HEALTH_SILENT_SUPERSESSION` | `supersedes` 链断了：指向不存在的一代，或者旧那一代还标着 `active`，或者标了 `superseded` 却没有接班人 | 把旧那一代的 `status` 改成 `superseded`（正文与出处一个字节都别动），或者把 `supersedes` 指对（ADR-0034） |
| `HEALTH_DUPLICATE_ACTIVE` | 同一个题面上有多条 `active` 状态，而且它们之间**没有取代关系** | 留一条 active，其余走一次状态替换（`forge conflicts --resolve --decision replace`）。**冲突判定看不见它**：S19 只在新候选到来时看这个题面（ADR-0034） |
| `HEALTH_AUDIT_CHAIN_BROKEN` | 审计链断了：缺号 / `prev` 对不上 / 内容被改 / 时间倒流 / 有行读不动 | 从备份恢复日志，或者把「这一段不可追溯」写下来。**不要**手工调 `seq` 或重算 `hash`——那是改历史，不是修审计（ADR-0035） |
| `AUDIT_DANGLING_SUBJECT` | 审计记过的资产现在不在库里了 | 先弄清它去哪了：审计记过的写入被删掉，是必须先弄清的事 |
| `AUDIT_UNATTRIBUTED_ASSET` | 库里有一条资产，审计里没有任何一条提到它（它是怎么来的？） | 手工放进去的 → 把来源写进它的 `sources` 就够了；forge 写的 → 说明有条写路径绕过了审计，去修那条路径（ADR-0035） |

### 两位数码现在在 `C4` 的射程里了（Phase 6 修掉）

`scripts/gates/consistency.mjs` 那条"每个闸门码都必须出现在**本文件**里"的检查
（`C4_GATE_CODE_NOT_DOCUMENTED`）从源码文本里抽码。它的正则原本只认**一位数**
（`[A-G]\d_`），于是 `E10_…` / `E11_…` 这类码**根本不会被它看到**——
那两行当时是**人写的**，不是机器逼出来的。

Phase 6 把它放宽成 `[A-G]\d{1,2}_`（ADR-0033），所以从 `E10` 起，
**上面每一行都是机器要求的**：从本文件里删掉任意一行，`pnpm gate:ci` 立刻红。
`E12`–`E14` 是这条修好之后加的第一批码，它们没有享受过"人记得写"的待遇。

## 新增一条纪律的顺序

1. 先有**真实错误**（一个 bug、一次踩坑、一次事故）。
2. 在 `scripts/gates/lib/policy.mjs` 加判定（纯函数），**并在 `scripts/gates/tests/` 加一条会红的用例**。
3. 若它值得 agent 记住，再进 `AGENTS.md`——但先删一条旧的（上限 8）。
4. 若它改动了受保护路径，配一条 ADR，并把新码加进**本文件的表**（否则 `C4_GATE_CODE_NOT_DOCUMENTED` 会红）。

这就是棘轮：**每一个错误变成一条规则，规则再变成闸门。**

## 受保护路径（改动需 ADR，且由人执行）

`.claude/`、`.githooks/`、`.github/workflows/`、`scripts/gates/`、`schema/`、
`packages/schema/`、`**/migrations/`。

判据是：**改它等于放宽约束。** 工具链配置（`package.json`、`eslint.config.mjs`、`tsconfig*.json`）
不在其中——它们改坏了 CI 会直接红，加 ADR 只会训练人绕过流程。这个缺口记在 `bypass-matrix.md` 3.4。

闸门 1 只拦 agent 的 Edit/Write。正当变更的流程是"先写 ADR，再由人执行"；
内容可以先放在普通目录里交给人工落盘（`handoff/` 就是这么来的）。

## 绕过清单

**任何"闸门能不能被绕过"的问题，答案在 `docs/gates/bypass-matrix.md`。**
新增或修改闸门后，必须同步更新那份清单——否则你会以为自己在被保护。
