---
id: dec_01M6QE3MZBQ94WCYD1ZATQN3KP
type: decision
status: accepted
created: 2026-11-06
last_confirmed: 2026-11-06
supersedes: null
origin_incident: null
sources:
  - "implement2.md#Phase 0 · S1"
  - "directory.md#八、命名与迁移纪律"
sensitivity: internal
confidence: 0.75
---

# 本地钩子用 core.hooksPath + 裸脚本，不引入 husky / lint-staged

## 问题

闸门 2（pre-commit）需要一个本地钩子载体。主流做法是 husky + lint-staged。

## 考虑过的选项

1. **husky + lint-staged**：生态默认，写起来最省事。
2. **core.hooksPath 指向仓库内的 `.githooks/` + 一个 node 脚本**：零依赖。
3. **simple-git-hooks / lefthook**：更轻的第三方，但仍是一个依赖。

## 选定

**选 2。**

理由不是"反依赖"，而是三条具体后果：

- **判定必须在 CI 里以完全相同的形态跑一遍**。裸脚本 `node scripts/gates/pre-commit.mjs` 与 CI 里 `pnpm gate:ci` 调的是同一套 policy；husky 的配置层会多出一层"本地与 CI 行为可能不一致"的地方。
- **husky 的安装依赖 `prepare` 生命周期 + `husky install`**，在 Windows / CI / 无 git 环境里有多种失败模式，而失败时它是**静默**的（钩子没装 = 闸门消失）。
- **零依赖**意味着钩子本身不会因为依赖树变动而失效。

## 后果

- **好**：本地钩子与 CI 判定同源；`git config core.hooksPath` 一行即可检查是否生效。
- **代价**：clone 后必须跑一次 `pnpm install`（或 `node scripts/gates/install-hooks.mjs`）。
- **代价**：钩子是 fail-closed 的——机器上找不到 `node` 时直接拒绝提交。这是有意的：宁可提交不了，也不要静默地没有闸门。
- **残余风险**：忘记装钩子 → 本地无闸门（CI 仍有效）。已记录在 bypass-matrix，并由 `scripts/gates/ci.mjs` 的 harness 完整性检查在 CI 侧兜底。
