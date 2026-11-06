# Forge

把痕迹编译成资产：把会话、文档、PR、会议里的**决策 / 状态 / 事件 / 规则**编译成
带类型、带出处、可维护的资产库，并能按任务注入回任意模型。

> 代号 **Forge**（铸造厂）。产品定位见 `positioning.md`，目录设计见 `directory.md`，
> 实现顺序见 `implement1.md` / `implement2.md`。

## 当前进度

**Phase 0 · 纪律地基**（第 1–3 天）——先有 harness，后有代码。

| 步骤 | 内容 | 状态 |
|---|---|---|
| S1 | 建仓 + 工具链（pnpm workspaces / turbo / tsconfig / eslint） | ✅ `pnpm test` 绿（35 条） |
| S2 | 种子规则 `AGENTS.md`（≤ 8 条，机器校验） | ✅ 8 条 |
| S3 | 五道闸门 + 绕过方式清单 | ✅ 载体就位；服务端配置待 remote（见下） |

**退出条件**：一个故意写错的改动必须被拦住 → `pnpm gate:rehearse` 可复现验证。

## 快速开始

```bash
pnpm install        # 同时安装本地闸门（core.hooksPath=.githooks）
pnpm check          # lint + typecheck + test
pnpm gate:rehearse  # 退出条件演练（临时克隆，不碰工作区）
```

## 五道闸门

| # | 闸门 | 载体 | 权威性 |
|---|---|---|---|
| 1 | agent hook | `.claude/settings.json` → `scripts/gates/agent-guard.mjs` | 早期反馈 |
| 2 | pre-commit | `.githooks/pre-commit` | 早期反馈 |
| 3 | required status check | `.github/workflows/ci.yml` → `pnpm gate:ci` | **权威** |
| 4 | branch rule | `scripts/gates/setup-branch-protection.sh` | **权威** |
| 5 | 发布门 | `.github/workflows/release.yml` | **权威** + 人工审批 |

判定逻辑只有一份：`scripts/gates/lib/policy.mjs`（纯函数、零 IO）。
**本地闸门全部可被绕过，权威只在服务端** —— 完整清单见 `docs/gates/bypass-matrix.md`。

## 建 remote 之后要做的两件事

```bash
scripts/gates/setup-branch-protection.sh --approvals 0    # 闸门 3/4：required check + branch rule
scripts/gates/setup-branch-protection.sh --environment-reviewer <login>   # 闸门 5：发布人工审批
```

（`--approvals 0` 是单人模式的取舍：CI 绿即可自合。取舍理由记在 bypass-matrix 3.x。）

## 目录

```
scripts/gates/      五道闸门的实现（自身也是受保护路径）
docs/adr/           本项目自己的决策记录（吃自己的狗粮）
docs/gates/         绕过方式清单
docs/handbook/      上手与操作手册
AGENTS.md           agent 的种子规则（≤ 8 条，CI 校验）
packages/ apps/     Phase 1/2 有真实内容时再建（见 ADR-0004）
data/               用户数据，gitignored
```
