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

### 演练发现的唯一"结构错误"（已修）

第一版 CI 直接跑工作树里的 `ci.mjs`。演练场景 A 把 `scripts/gates/lib/policy.mjs` 删掉后：

- 不可信版（工作树自查）：`ERR_MODULE_NOT_FOUND` 崩溃——**不是"判定为红"，而是"检查者自己没了"**
- 更坏的改法：把 `evaluateChangeset` 改成永远返回 `ok: true` → 闸门会**报绿**

这类问题不是"绕过方式"，而是结构错误：**被检查者同时是检查者**。修法是 ADR-0005
（判定代码取自基线修订），演练 A3/A4 就是这条的回归用例。

> 这正是 Phase 0 要"先有 harness"的原因：这个洞是靠**演练**而不是靠**读代码**发现的。

### 闸门 1 · agent hook（`.claude/settings.json` → `agent-guard.mjs`）

| # | 绕过方式 | 成功？ | 为什么 | 缓解 | 残余风险 |
|---|---|---|---|---|---|
| 1.1 | agent 直接编辑 `.claude/settings.json` 摘掉 hook | **是** | hook 配置是普通文件，agent 有写权限 | `.claude/**` 是受保护路径：闸门 2/3 会因缺 ADR 拦下；且 CI 的 harness 完整性检查（`G1_AGENT_HOOK_UNWIRED`）会红 | 本会话内闸门 1 已失效（但改动不进 main） |
| 1.2 | 宿主不加载项目级 settings（`settingSources` 不含 project） | **是** | hook 由宿主决定是否加载，仓库管不到 | 判定逻辑仍在闸门 2/3 里跑 | 闸门 1 在部分宿主上可能根本不生效 |
| 1.3 | hook 进程读不到 stdin / JSON 非法 | **是**（fail-open） | 有意为之：基础设施故障不该卡死整个会话 | stderr 留痕；闸门 3 兜底 | 静默失效，只能靠日志发现 |
| 1.4 | `FORGE_GATE_OVERRIDE="理由"` | **是**（显式） | 人给的逃生舱，Phase 1 立宪时必需 | 只对人有效：agent 要设置它得先跑 shell，而 shell 本身受 B 类规则约束；CI 侧受保护路径仍需 ADR | 人滥用逃生舱 |
| 1.5 | 用 Bash 写文件（绕过 Edit/Write 判定） | **部分** | Bash 的 `command` 只匹配到 B1–B4 模式 | B4 覆盖了对受保护路径的 `rm`；但 `node -e "fs.writeFileSync(...)"` 未被拦 | **已知缺口**：任意 shell 写文件不受路径判定约束 |

> 1.5 是这道闸门最真实的缺口。**它不能靠继续加正则解决**——正则拦不住任意的 shell。
> 正确的补法在 Phase 7（审计日志 + hook 强制执行，S27），而不是在这里堆模式。

### 闸门 2 · pre-commit（`.githooks/pre-commit`）

| # | 绕过方式 | 成功？ | 为什么 | 缓解 | 残余风险 |
|---|---|---|---|---|---|
| 2.1 | `git commit --no-verify` | **是** | git 的设计 | **闸门 3 用同一套 policy 重判**（演练场景 A2/A3 实测） | 无（权威不在本地） |
| 2.2 | 没跑过 `pnpm install` → `core.hooksPath` 未设置 | **是（静默）** | 钩子安装依赖 prepare 生命周期 | `node scripts/gates/install-hooks.mjs` 可手动补；CI 侧由 harness 检查兜底 | 本机可能长期无闸门 2 而无感知 |
| 2.3 | `node_modules` 缺失时 lint 步骤降级为警告 | **是** | 有意为之：没装依赖不该阻断提交 | CI 一定装依赖并跑全量 lint | 本机可能提交未过 lint 的代码 |
| 2.4 | 直接调 git 库 / GUI 客户端提交 | **是** | 它们不跑钩子 | 闸门 3 | 无 |
| 2.5 | 把 pre-commit 改成 `exit 0` | **是** | 文件可写 | 受保护路径 → 需 ADR；harness 检查 `G2_GIT_HOOK_UNWIRED` | 同上 |

### 闸门 3 · required status check（`.github/workflows/ci.yml` → `pnpm gate:ci`）

**这是唯一有权威的闸门。** 它的判定与本地完全同源（`lib/policy.mjs`），所以"本地跳过了"没有意义。

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

## 二、Phase 0 尚未覆盖的检查（不假装存在）

这几条是后续阶段的闸门，**现在没有实现，所以不要以为它们在保护你**：

| 未覆盖 | 归属 | 接上的判据 |
|---|---|---|
| provenance 完整性（无出处不许入库） | P1 / S6 | 缺 span 的样例资产被 CI 明确拒绝 |
| `schema/`（人读）与 `packages/schema`（代码）一致性 | P1 / S7 | 一致性检查通过 |
| emit 逐字节确定性快照 | P2 / S10 | 两次运行产出相同 `AGENTS.md` |
| eval 阈值（抽取/归并/冲突） | P3 / S12–S14 | "永远返回空"的假 Extractor 会让 CI 变红 |
| 审计日志完整性 | P7 / S27 | 见 1.5 的缺口 |

---

## 三、安装状态（Phase 0 收尾时的真实状态）

| 闸门 | 载体 | 状态 |
|---|---|---|
| 1 agent hook | `.claude/settings.json` + `agent-guard.mjs` | 已配置；判定逻辑有测试覆盖（8 条）。**宿主是否加载项目级 settings 取决于宿主**（见 1.2） |
| 2 pre-commit | `.githooks/pre-commit`（`core.hooksPath`） | 已生效并实测拦截 |
| 3 required status check | `.github/workflows/ci.yml` | workflow 已就位（可信判定 + 本地判定 + 演练三步）；**服务端 branch protection 需建 remote 后执行脚本** |
| 4 branch rule | `setup-branch-protection.sh` | 脚本已就位；**未应用**（无 remote） |
| 5 发布门 | `.github/workflows/release.yml` | workflow 已就位；environment reviewer **未配置** |

**诚实结论**：Phase 0 结束时，真正在服务端生效的是 0 道；本地生效的是 2 道（1、2）；
其余 3 道的载体与配置脚本已就位，等待 remote。这是"没有 remote 的仓库"这一事实决定的，
不是设计缺陷——但必须写在纸上，否则会误以为五道闸门都在运行。

**本地可复现的验证**：`pnpm gate:rehearse` 在临时克隆里跑 8 个场景，全部与期望一致
（含 3 个反例、1 个正例、1 个结构缺陷实证）。它是 Phase 0 退出条件的可执行形式，也已进 CI。
