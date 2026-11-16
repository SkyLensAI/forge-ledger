---
schema_version: 1
id: dec_01M6QE3MZDZ9JE8EFMW27VAVKT
type: decision
status: accepted
created: 2026-11-06
last_confirmed: 2026-11-06
supersedes: null
origin_incident: null
sources:
  - "file://docs/implement2.md#t:把闸门写成 checklist"
  - "file://docs/directory.md#h:六、v0 最小版（照抄这个开始，别一上来就建 20 个包）"
  - "file://docs/directory.md#t:每个来源一个包 / 建一个万能"
sensitivity: internal
confidence: 0.8
---

# Phase 0 不预建 `packages/` 与 `apps/`：脚手架跟着需求长

## 问题

`directory.md` 给出了完整的目录树（6 个包 + 5 个端）。Phase 0 只要求"一个 `pnpm test` 能跑过的空仓"。要不要把目录树先建出来？

## 考虑过的选项

1. **先建全部目录（含空 `services/`、`apps/web` 等）**。看起来"架构清楚"。
2. **只建 Phase 0 真正需要的东西**：根工具链 + 闸门脚本 + 文档。`packages/`、`apps/` 在 Phase 1/2 有真实内容时再建。

## 选定

**选 2。**

- "先建目录"违反本项目自己的反模式 4（**建一个万能 `utils/` 或包地狱**）。空目录不会提供任何约束，只会制造"结构已存在"的错觉。
- 更硬的理由：**空目录里的 schema 检查是假的**。Phase 0 的价值在于"闸门真的会红"，而一个没有内容的 `packages/schema/` 只会让 `packages/schema/` 变成受保护路径却毫无内容可保护——保护一个空壳是自欺。
- 唯一例外：`scripts/gates/` 在 Phase 0 就有真实内容（判定逻辑 + 测试），且**自己是受保护路径**——闸门从第一天起就在管自己。

## 后果

- **好**：每个目录出现时都有明确职责，没有"待填"的悬空结构。
- **好**：`pnpm test` 在 Phase 0 就跑的是真东西（闸门自身的测试 34 条），不是空转。
- **代价**：Phase 1/2 需要把 `pnpm-workspace.yaml` 的 `packages/*`、`apps/*` 真正用起来，并确认 `turbo` 在有包之后能正常编排任务。
- **注**：`turbo.json` 已按 `directory.md` 的 6 包 + 3 端形态配好任务图，无需等到那时再改。
