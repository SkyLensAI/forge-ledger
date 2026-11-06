# Handbook · 闸门怎么用

## 首次上手

```bash
pnpm install          # prepare 生命周期会设置 core.hooksPath=.githooks
pnpm gate:rehearse    # 演练：故意写错的改动必须被拦住
```

## 日常命令

| 命令 | 作用 |
|---|---|
| `pnpm test` | 闸门自身的测试（37 条：policy / harness 完整性 / agent hook / pre-push / 发布门） |
| `pnpm lint` / `pnpm typecheck` | 与 CI 相同的静态检查 |
| `pnpm check` | 上面三件事一起跑（提交前的完整本地验证） |
| `pnpm gate:ci` | **闸门 3 的本地等价物**：变更集判定 + harness 完整性 + lint/typecheck/test |
| `pnpm gate:trusted` | **闸门 3 的权威形态**：闸门代码取自基线修订，判定当前工作树（ADR-0005） |
| `pnpm gate:rehearse` | 退出条件演练（临时克隆里跑 10 个场景，不碰工作区）；CI 也会跑 |

## 闸门红了怎么办

**修问题，不要修闸门。** 具体判断：

| 报错码 | 含义 | 正确动作 |
|---|---|---|
| `R2_PROTECTED_WITHOUT_ADR` | 改到了受保护路径且没有 ADR | 在 `docs/adr/` 新增一条 ADR 一起提交；或在提交信息加 `ADR: <id>` 尾注 |
| `R1_USER_DATA_IN_REPO` | 用户数据进了 git | `git restore --staged <path>`，确认 `.gitignore` |
| `R3_SECRET_IN_REPO` | `.env*` 等进了 git | 移出暂存区；样板用 `.env.example` |
| `G0_AGENTS_MD_TOO_MANY_RULES` | AGENTS.md 超过 8 条 | 删到 8 条以内：新规则只能由真实错误长出 |
| `G1_*` / `G2_*` / `G3_*` / `G5_*` | 闸门本身被拆了 | 恢复闸门载体；这类改动必须走 ADR |
| `G3_TRUSTED_JUDGE_MISSING` | CI 不再用基线修订的闸门判定 | 恢复 `pnpm gate:trusted` 这一步（ADR-0005） |
| `G3_SHALLOW_CLONE` | 浅克隆会让 diff 为空、闸门静默空转 | `actions/checkout` 里设 `fetch-depth: 0` |
| `B1`–`B4` | agent 试图用 shell 绕过闸门 | 不要绕过：先修被拦下的问题 |

## 新增一条纪律的顺序

1. 先有**真实错误**（一个 bug、一次踩坑、一次事故）。
2. 在 `scripts/gates/lib/policy.mjs` 加判定（纯函数），**并在 `scripts/gates/tests/` 加一条会红的用例**。
3. 若它值得 agent 记住，再进 `AGENTS.md`——但先删一条旧的（上限 8）。
4. 若它改动了受保护路径，配一条 ADR。

这就是棘轮：**每一个错误变成一条规则，规则再变成闸门。**

## 受保护路径（改动需 ADR）

`.claude/`、`.githooks/`、`.github/workflows/`、`scripts/gates/`、`schema/`、`packages/schema/`、`**/migrations/`。

判据是：**改它等于放宽约束。** 工具链配置（`package.json`、`eslint.config.mjs`、`tsconfig*.json`）
不在其中——它们改坏了 CI 会直接红，加 ADR 只会训练人绕过流程。这个缺口记在 `bypass-matrix.md` 3.4。

## 绕过清单

**任何"闸门能不能被绕过"的问题，答案在 `docs/gates/bypass-matrix.md`。**
新增或修改闸门后，必须同步更新那份清单——否则你会以为自己在被保护。
