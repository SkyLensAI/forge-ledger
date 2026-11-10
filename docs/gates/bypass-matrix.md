# 闸门绕过方式清单（Phase 0 · S3）

> 交付物要求：**逐条验证"它能不能被绕过"**。这份清单是判断"闸门是不是 checklist"的唯一标准——
> checklist 天生会被跳过；闸门必须知道自己的洞在哪，并且知道洞后面还有没有墙。

## 零、一句话结论

**闸门的权威只来自服务端（闸门 3 / 4 / 5）。本地闸门（1 / 2）全部可以被绕过，
它们的存在意义是"不要等到 CI 才知道错"，而不是"拦住"。**

这不是妥协，是设计（ADR-0001）。判断一道闸门是否真实有效的唯一问题不是"它能不能被绕过"，
而是：**绕过它之后，还有没有一道人说不上话的墙。**

| 闸门 | 层 | 能不能被绕过 | 绕过之后的墙 |
|---|---|---|---|
| 1 agent hook | 本地 | 能（改配置、不加载项目设置、宿主差异） | 闸门 2 → 闸门 3 |
| 2 pre-commit | 本地 | 能（`--no-verify`、不装钩子、改 hooksPath） | **闸门 3（权威）** |
| 3 required status check | 服务端 | 需管理员权限（`enforce_admins: true` 后连管理员也拦） | 闸门 4 |
| 4 branch rule | 服务端 | 需仓库 admin / org owner | 无（最后一堵墙） |
| 5 发布门 | 服务端 + 人工 | 需 admin 改 environment 或绕过 CI 本机发布 | 制品溯源（P2 接） |

---

## 一、逐条绕过方式与验证

### 演练发现的结构错误（已修）

第一版 CI 直接跑工作树里的 `ci.mjs`。演练场景 A/D 暴露了两层的同一个病：

| | 现象 | 结论 |
|---|---|---|
| 本地钩子（闸门 2） | 删掉 `policy.mjs` → 钩子 `ERR_MODULE_NOT_FOUND` 崩溃（恰好 fail-closed，提交被阻断）；但**改成永远放行 → 钩子开开心心放行**（实测 D1） | 本地层是**自证**的，天生没有权威；不试图加固，只把它当早期反馈 |
| CI（闸门 3，第一版） | 同样崩溃，**不是"判定为红"** | 结构错误：被检查者同时是检查者 |

修法是 ADR-0005：CI 的判定代码取自**基线修订**（`trusted-ci.mjs` 把 base checkout 到临时 worktree）。
演练 A3/A4/D2 是这条的回归用例——同一个"改松闸门"的改动，本地放行、可信 CI 拦住。

> 这正是 Phase 0 要"先有 harness"的原因：这个洞是靠**演练**发现的，不是靠读代码。

### 闸门 1 · agent hook（`.claude/settings.json` → `agent-guard.mjs`）

| # | 绕过方式 | 成功？ | 为什么 | 缓解 | 残余风险 |
|---|---|---|---|---|---|
| 1.1 | agent 直接编辑 `.claude/settings.json` 摘掉 hook | **是** | hook 配置是普通文件，agent 有写权限 | `.claude/**` 是受保护路径：闸门 2/3 会因缺 ADR 拦下；且 CI 的 harness 完整性检查（`G1_AGENT_HOOK_UNWIRED`）会红 | 本会话内闸门 1 已失效（但改动不进 main） |
| 1.2 | 宿主不加载项目级 settings（`settingSources` 不含 project） | **是** | hook 由宿主决定是否加载，仓库管不到 | 判定逻辑仍在闸门 2/3 里跑 | 闸门 1 在部分宿主上可能根本不生效 |
| 1.3 | hook 进程读不到 stdin / JSON 非法 | **是**（fail-open） | 有意为之：基础设施故障不该卡死整个会话 | stderr 留痕；闸门 3 兜底 | 静默失效，只能靠日志发现 |
| 1.4 | `FORGE_GATE_OVERRIDE="理由"` | **是**（显式） | 人给的逃生舱，Phase 1 立宪时必需 | 只对人有效：agent 要设置它得先跑 shell，而 shell 本身受 B 类规则约束；CI 侧受保护路径仍需 ADR | 人滥用逃生舱 |
| 1.5 | 用 Bash 写文件（绕过 Edit/Write 判定） | **部分** | Bash 的 `command` 只匹配到 B1–B4 模式 | B4 覆盖了对受保护路径的 `rm`；但 `node -e "fs.writeFileSync(...)"` 未被拦 | **已知缺口**：任意 shell 写文件不受路径判定约束 |
| 1.6 | **反向的错**：B4 按**子串**匹配路径，于是误报 | 不适用（它拦错了东西） | `evaluateBashCommand` 用的是 `command.includes("schema")` 这类子串判定，而受保护清单里恰好有 `schema` | 换一种写法（glob、先 cd、用 Python 脚本） | **已知误报**：一条只是**提到**受保护路径的命令会被拦下，哪怕删除目标在别处（Phase 4 实测：删 `handoff/` 下一个文件名里含该子串的载荷，报 `B4_DELETE_PROTECTED`） |

> 1.5 是这道闸门最真实的缺口。**它不能靠继续加正则解决**——正则拦不住任意的 shell。
> 正确的补法在 Phase 7（审计日志 + hook 强制执行，S27），而不是在这里堆模式。
>
> 1.6 是同一个设计选择的另一面：子串匹配**宁可误报也不漏报**，
> 因为漏报的代价是"受保护路径被删掉而没人看见"。误报的代价是换一种写法。
> 这个取舍是**有意的**，但它必须被写下来——否则第一个撞上它的人会以为是 bug，
> 然后开始怀疑整套判定（Phase 4 撞上它时的经过记在 `handoff/README.md` 里）。

### 闸门 2 · pre-commit（`.githooks/pre-commit`）

| # | 绕过方式 | 成功？ | 为什么 | 缓解 | 残余风险 |
|---|---|---|---|---|---|
| 2.1 | `git commit --no-verify` | **是** | git 的设计 | **闸门 3 用同一套 policy 重判**（演练场景 A2/A3 实测） | 无（权威不在本地） |
| 2.2 | 没跑过 `pnpm install` → `core.hooksPath` 未设置 | **是（静默）** | 钩子安装依赖 prepare 生命周期 | `node scripts/gates/install-hooks.mjs` 可手动补；CI 侧由 harness 检查兜底 | 本机可能长期无闸门 2 而无感知 |
| 2.3 | `node_modules` 缺失时 lint 步骤降级为警告 | **是** | 有意为之：没装依赖不该阻断提交 | CI 一定装依赖并跑全量 lint | 本机可能提交未过 lint 的代码 |
| 2.4 | 直接调 git 库 / GUI 客户端提交 | **是** | 它们不跑钩子 | 闸门 3 | 无 |
| 2.5 | 把 pre-commit 改成 `exit 0` | **是** | 文件可写 | 受保护路径 → 需 ADR；harness 检查 `G2_GIT_HOOK_UNWIRED` | 同上 |
| 2.6 | **把判定代码改松**（如 `evaluateChangeset` 永远返回 ok） | **是（实测 D1）** | 本地钩子跑的是工作树里的判定代码——**本地闸门同样是自证的** | 权威在闸门 3：基线版判定会按 `R2_PROTECTED_WITHOUT_ADR` 拦住（实测 D2） | 本机早期反馈失效，但改动进不了 main |
| 2.7 | 删掉判定模块 | **是，但 fail-closed** | 钩子的 import 断裂 → `ERR_MODULE_NOT_FOUND` → 退出码非 0 → 提交被阻断（实测 A1） | 同上 | 无（结果是阻断） |

> 2.6 / 2.7 是这次演练最重要的收获：**本地层是自证的，所以它天然没有权威**。
> 这不是可以通过"再加固一点"解决的问题，而是分层设计的理由（ADR-0001 + ADR-0005）。
> 不要试图让本地钩子也读基线修订：那样连"修改规则"这个动作本身都无法提交。

### 闸门 3 · required status check（`.github/workflows/ci.yml` → `pnpm gate:trusted` + `pnpm gate:ci`）

**这是唯一有权威的闸门。** 它跑两份判定：`gate:trusted`（基线修订的闸门，权威）
与 `gate:ci`（工作树的闸门，与本地 pre-commit 同源）。两者都绿才算绿。

| # | 绕过方式 | 成功？ | 为什么 | 缓解 | 残余风险 |
|---|---|---|---|---|---|
| 3.1 | 改 job 名（让 required check 永远等不到） | 否 | harness 检查 `G3_REQUIRED_JOB_MISSING`；且分支保护要求的 context 会一直处于 expected 状态，PR 无法合并 | — | 无 |
| 3.2 | 删掉 workflow / 改成 `echo skipped` | 否 | harness 检查 `G3_CI_WORKFLOW_MISSING` / `G3_CI_ENTRY_MISSING`；且这些都**由基线版本的 harness 执行** | — | 无 |
| 3.3 | 放宽 policy 让检查通过 | **是**（需 ADR） | policy 本身是代码 | `scripts/gates/**` 是受保护路径：同一变更集必须有 ADR，即"放水"必须留下书面理由 | 有 ADR 的放水仍是放水，只能靠人审 |
| 3.4 | 改 `eslint.config.mjs` / `tsconfig.json` 放宽 lint | **是** | 工具链配置不在受保护路径内（有意：保护清单太长会训练人绕过流程） | 评审；Phase 3 起 eval 阈值不依赖本地 lint 配置 | **已知缺口**：lint 强度可被静默调低 |
| 3.5 | 浅克隆导致 diff 为空、闸门空转 | 否 | workflow 固定 `fetch-depth: 0`，且 harness 检查 `G3_SHALLOW_CLONE`；无基线时 `ci.mjs` 会**显式报警**而不是静默跳过 | — | 无 |
| 3.6 | fork PR | 否 | `pull_request` 事件下 secrets 不注入，但 `pnpm gate:ci` 不需要 secrets | — | 无 |
| 3.7 | **删掉/改松闸门代码**（如把 `evaluateChangeset` 改成永远 ok） | 否 | 判定由**基线修订**里的闸门执行（`trusted-ci.mjs` 把 base checkout 到临时 worktree）：被检查者改不到检查者。演练 A3/A4 实测：不可信版直接崩溃，可信版报 `R2_PROTECTED_WITHOUT_ADR` | — | PR 可重写 workflow 文件本身不被调用 → 缓解见 3.2（由基线版 harness 检查） |

### 闸门 4 · branch rule（`setup-branch-protection.sh`）

| # | 绕过方式 | 成功？ | 为什么 | 缓解 | 残余风险 |
|---|---|---|---|---|---|
| 4.1 | 管理员直接推 main | 否（配置后） | `enforce_admins: true` | — | 无 |
| 4.2 | 关掉分支保护再推 | **是** | 需要 admin 权限 | 这是"人"的权限问题，不是闸门问题；组织级 ruleset 可进一步收紧 | 仓库 admin 始终是最终权威 |
| 4.3 | force push / 删分支 | 否 | `allow_force_pushes: false`、`allow_deletions: false` | 本机还有闸门 4 镜像（`pre-push`） | 无 |
| 4.4 | 本机 `pre-push` 镜像 | **是**（可绕） | `FORGE_ALLOW_MAIN_PUSH=1` 或 `--no-verify` | 服务端 branch rule | 无（它只是早期反馈） |
| 4.5 | **尚未配置**（仓库还没有 remote） | **是（当前状态）** | `gh repo view` 失败 → 脚本拒绝执行并报错退出 | 建 remote 后跑一次脚本 | **当前 Phase 0 的真实状态：闸门 3/4 的服务端配置尚未生效** |

### 闸门 5 · 发布门（`release.yml` → `pnpm gate:release`）

| # | 绕过方式 | 成功？ | 为什么 | 缓解 | 残余风险 |
|---|---|---|---|---|---|
| 5.1 | 本机 `npm publish` | **是** | 闸门 5 只管 CI 里的发布路径 | 包未配 `publishConfig`、无 registry 凭据之前无害；Phase 2 用 provenance/OIDC 收紧 | **已知缺口**：本机发布不受闸门 5 约束 |
| 5.2 | 不走 CI 直接打 tag 推上去 | 否 | `release.yml` 在 tag 上跑，`gate:release` 会先判定 | — | 无 |
| 5.3 | tag 与 package.json 版本不一致 | 否 | `gate:release` 检查 | — | 无 |
| 5.4 | 跳过人工审批 | 否（配置后） | `environment: release` + required reviewers | 未配 reviewer 时脚本会明确告警 | 未配置时退化为"仅 CI 判定" |
| 5.5 | 发布环境缺 reviewer | **是（当前状态）** | 需要仓库设置里配置 | `setup-branch-protection.sh --environment-reviewer <login>` | 同上 |

---

## 二、Phase 1–8 接上的检查（以及它们各自的洞）

| 检查 | 归属 | 接在哪儿 | 状态 |
|---|---|---|---|
| provenance 完整性（无出处不许入库） | P1 / S6 | `scripts/gates/assets.mjs` → `gate:ci` | ✅ 已接（ADR-0012 的"约定即集合"） |
| `schema/`（人读）与 `packages/schema`（代码）一致性 | P1 / S7 | `scripts/gates/consistency.mjs` → `gate:ci` | ✅ 已接（ADR-0010） |
| emit 逐字节确定性快照 | P2 / S10 | `apps/cli/test/e2e.test.ts`（两个全新 vault → 同样的字节） | ✅ 已接（ADR-0017） |
| eval 阈值（**抽取**） | P3 / S12–S14 | `scripts/gates/evals.mjs` → `gate:ci` | ✅ 已接（ADR-0020） |
| 不变量（出处完整率 / state 日期 / `INDEX.md` / emit 确定性） | P3 / S13 | `evals/invariants/invariants.test.ts` → `pnpm test` | ✅ 已接；**每条都配了反例**，否则它只是一条会变绿的断言 |
| eval 阈值（归并 / 冲突） | P5 / S18–S19 | `evals/runner/conflict.ts` → `E8`/`E9`（`scripts/gates/evals.mjs` 的宿主） | ✅ 已接；判定住在 `evals/runner/gate.ts`，探针每次 CI 都跑 |
| 审计日志完整性 | P7 / S27 | `evals/runner/maintenance.ts` → `E12`（同一宿主） | ✅ 已接；写入路径 / 链破坏 / 无见证人写入三项一起判 |
| 维护与规模探针 | P7 / S25–S28 | `evals/runner/maintenance.ts` → `E13`/`E14` | ✅ 已接；健康检查分得开干净与腐烂，1000 条下仍确定 |
| 取用预算与预加载 | P6 / S21 | `evals/runner/retrieval.ts` → `E10`/`E11` | ✅ 已接；预算与"绝不预加载"分开判 |
| 自举与团队版闸门 | P8 / S29–S32 | `evals/runner/phase8.ts` → `E15`/`E16` | ✅ 已接；`deferred` 不报红，"没信号却开了能力"才红 |

### 新接的三项各自的绕过方式

| # | 绕过方式 | 成功？ | 为什么 | 缓解 | 残余风险 |
|---|---|---|---|---|---|
| 6.1 | 删掉 `node_modules` 再跑 `gate:ci --guard-only` | **是**（降级） | 三个子闸门都要 `yaml`/`zod` 才能跑（ADR-0011） | 完整模式的 `gate:ci` 与 CI 都会先 `pnpm install`；子闸门会打印「本次没查」而不是安静返回绿 | 本机可能长期看不到资产/一致性/阈值判定而无感知 |
| 6.2 | 资产闸门在 CI 里对 `src://` 报 `PROV_SCHEME_UNAVAILABLE` | **不适用** | CI 看不到 `data/`（R1），所以用户资产的出处**只能在用户机器上校验** | `forge lint` 用同一份纯函数；`unavailable` 与 `resolved` 是两种输出 | 用户不跑 `forge lint` 就等于没校验 |
| 6.3 | 给 `readRepoAssets` 加一条排除目录，把资产藏起来 | **是**（需 ADR） | 排除表是代码 | `packages/store` 不在受保护路径里——**这是本清单里最该注意的一条** | 藏起来的资产不受任何检查，也不发信号 |
| 6.4 | 让 `checkTaxonomyAgainstCode` 只检查一部分 | **是**（需 ADR） | 检查表是代码 | 同上；且 `schema/` 的改动本身受 R2 约束 | 同 6.3 |
| 6.5 | 把 fixture 改成 `.md` 并让资产闸门报红，然后放宽闸门 | **是** | 修闸门比修数据便宜 | 评审；`C3_TEMPLATE_INCOMPLETE` 之类的码会指向具体的文档 | 见 3.3「有 ADR 的放水仍是放水」 |
| 6.6 | 把阈值调到刚好让当前实现过 | **是**（需填 `ratified_by`） | `evals/thresholds.json` 是普通文件 | `E2`/`E6` 盯"有没有人确认过"；`E4` 与阈值无关——阈值降到 0 时空实现也会及格，`E4` 立刻变红 | 阈值被调到"高于空实现、但低于真实水平"时不会响 |
| 6.7 | 改 golden 集的期望值（让实现显得更准） | **是** | 用例是数据 | 每条用例必须带一个能解析到仓库原文的 `span`（`E5`）——改期望就得同时改得动它所引用的那份文档；且确认状态会退回 `proposed`，要人重签 | 有人"顺手重签"，见 ADR-0020 的残余风险 |
| 6.8 | 删掉 `scripts/gates/evals.mjs`，或留着文件但从 `ci.mjs` 的清单里摘掉它 | 否 | — | `G3_EVAL_GATE_MISSING`（harness 完整性检查）**由基线修订执行** | 无 |
| 6.9 | 把 `evals/extractors/null.ts` 改成会返回正确答案的实现 | **是** | 它是普通文件 | 那等于承认退出条件可以被伪造——但它要留下 diff | **已知缺口**：没有机器判定"空实现真的是空的"；靠评审看 diff |
| 6.10 | 把 `evals/runner/run.ts` / `gate.ts` 改成永远返回满分 | **落盘前是** | runner 与判定都在 `evals/`（不受保护），而子闸门是**从工作树**跑起来的 | **ADR-0043**：判定代码与数据根分离；载荷在 `handoff/`，`apply.mjs --verify` 已通过 | **落盘前仍是缺口**；落盘后子闸门代码取自基线修订 |

### 6.10 的准确描述（修正一处过度承诺）

`gate:trusted`（ADR-0005）把**基线修订**的 `ci.mjs` 拿来判定当前工作树，所以
**变更集判定**（`lib/policy.mjs`）与 **harness 完整性检查**（`lib/harness.mjs`）
确实来自基线——被检查者改不到。

但 `ci.mjs` 的第 3 步是 `spawnSync("node", ["scripts/gates/<子闸门>"], { cwd: root })`，
`root` 是**当前工作树**。所以：

- `consistency.mjs` / `assets.mjs` / `evals.mjs` 这三个子闸门来自**工作树**；
- 它们 import 的 `packages/core`、`packages/store`、`packages/schema`、`evals/runner/*`
  也全部来自**工作树**。

于是"改松判定"这条绕法在**第 1、2 步过不了**，在**第 3 步过得去**。
本清单早先的 6.3 / 6.4 把缓解写成了"判定也在基线修订里跑一遍"——那句话对第 1、2 步成立，
对第 3 步**不成立**。这条修正在这里，因为在被发现之前，它一直是一条过度承诺。

**Phase 7 加的三个探针（`E12`–`E14`，判定在 `evals/runner/maintenance.ts`）继承同一个缺口**：
把 `maintenance.ts` 改成永远全绿、或者把 `gate.ts` 里那三段判定删掉，
`pnpm gate:ci` 的第 3 步不会红。它们防的是"改动引入的退化"，不是"有人蓄意改探针"——
后者要靠人 review 这个 PR，以及下面那条更根本的记账：

**Phase 8 的两个探针（`E15`–`E16`，探针在 `evals/runner/phase8.ts`）同样继承这个缺口。**
`forge bootstrap` 跑的是工作树里的同一批判定，所以它也不是权威——
权威仍然是 CI 的第 3 步，而第 3 步的判定模块同样来自工作树。两个入口给出同一个答案，
但**都不防蓄意改判定**。这条缺口没有因为多了一条命令而变小。

**统一修法已经写成 ADR-0043**：`trusted-ci.mjs` 建立基线 worktree 后，把
`FORGE_JUDGE_ROOT`（判定代码根）与 `FORGE_JUDGE_DATA_ROOT`（当前工作树）传给基线
`ci.mjs`；三个子闸门的 import 走 `codeRoot`，读资产 / schema / 黄金集 / 阈值走
`dataRoot`。依赖用 junction 接进基线 worktree，不重新安装。

- **当前状态**：ADR-0043 与载荷已落 `handoff/`，`node handoff/apply.mjs --verify`
  三步验证通过；**在人工落盘之前，6.10 仍然是缺口**。落盘后它关闭。
- **代价**：基线判定代码与工作树依赖可能来自不同修订；新规则仍然在合并之后才生效；
  `ci.mjs` 第 4 步（lint/typecheck/test）仍跑工作树里的 `package.json` 脚本（3.4）。
- **验证**：`handoff/verify-gate610.mjs` 证明三件事——坏出处资产被可信判定看见、
  改松工作树的 `judgeLibrary` 后不可信入口会绿（缺口真实存在）、同一份工作树走
  `trusted-ci` 仍然红（修复生效）。
- **审计**：`evals/regressions/0001` 仍然钉住"6.10 被写着"。落盘后那条回归的措辞
  需要跟着改成"已关闭"，否则它会变成一条过期的缺口记录。

---

## 三、安装状态（Phase 0 收尾时的真实状态）

| 闸门 | 载体 | 状态 |
|---|---|---|
| 1 agent hook | `.claude/settings.json` + `agent-guard.mjs` | 已配置；判定逻辑有测试覆盖（8 条）。**宿主是否加载项目级 settings 取决于宿主**（见 1.2） |
| 2 pre-commit | `.githooks/pre-commit`（`core.hooksPath`） | 已生效并实测拦截 |
| 3 required status check | `.github/workflows/ci.yml` | workflow 已就位（可信判定 + 本地判定 + 演练三步），完整模式还会跑 schema 一致性与资产出处；**服务端 branch protection 需建 remote 后执行脚本** |
| 4 branch rule | `setup-branch-protection.sh` | 脚本已就位；**未应用**（无 remote） |
| 5 发布门 | `.github/workflows/release.yml` | workflow 已就位；environment reviewer **未配置** |

**诚实结论**：Phase 0 结束时，真正在服务端生效的是 0 道；本地生效的是 2 道（1、2）；
其余 3 道的载体与配置脚本已就位，等待 remote。这是"没有 remote 的仓库"这一事实决定的，
不是设计缺陷——但必须写在纸上，否则会误以为五道闸门都在运行。

**本地可复现的验证**：`pnpm gate:rehearse` 在临时克隆里跑 10 个场景，全部与期望一致
（4 个反例、2 个正例、2 个结构缺陷实证、1 个"本地被改松但 CI 拦住"的对照）。
它是 Phase 0 退出条件的可执行形式，也已进 CI。
