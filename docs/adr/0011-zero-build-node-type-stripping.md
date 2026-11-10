---
schema_version: 1
id: dec_01M6QGCKZ15QPTV67AZ839ZQ40
type: decision
status: accepted
created: "2026-11-06"
last_confirmed: "2026-11-06"
supersedes: null
origin_incident: null
sources:
  - "file://docs/implement2.md#t:pnpm workspaces / turbo / tsconfig / eslint"
  - "file://docs/adr/0002-core-hookspath-over-husky.md#t:意味着钩子本身不会因为依赖树变动而失效"
  - "file://docs/directory.md#t:core 是纯函数，IO 全在边缘"
sensitivity: internal
confidence: 0.8
---

# 零 build：TS 由 Node 原生类型擦除直接执行，包只发布源码

## 问题

Phase 1 引入第一批 TS 包（`packages/schema`、`packages/core`）。两条路：
加构建步骤（tsc → `dist/`，turbo build，CI 先 build 再 test），
还是让 Node 直接执行 `.ts` 源码（Node 24 起原生类型擦除默认开启）？

## 考虑过的选项

1. **tsc 编译到 `dist/`**，包 `exports` 指向产物，CI 先 build。
2. **用 tsx / esbuild 之类运行器**，源码直接跑但多一个依赖。
3. **直接 `node file.ts`**：`exports` 指向 `src/index.ts`，`tsc --noEmit` 只做类型检查。

## 选定

**选 3。**

- 理由不是"少一层更酷"，而是**少一个产物层就少一类假绿**：
  `dist/` 过期、turbo 缓存命中错版本、CI 忘记 build、本地 build 过、CI 没 build——
  这些失败模式的共同点是"看起来跑过了"，而确定性（R6）是这个阶段的全部价值。
- 类型擦除要求只用**可擦除语法**：不得使用 `enum`、`namespace`、参数属性、装饰器。
  这条约束的执行体不是禁令，而是"CI 里 node 真的会跑它"——用了不可擦除语法就是红。
- **Node 版本下限因此从 22 提到 24**：22.18 起才默认开启类型擦除，
  且 `node --test` 对 `.ts` 的稳定支持到 24 才到位。`engines` 与两个 workflow 一起改。
- tsconfig 需要 `allowImportingTsExtensions`（导入路径必须带 `.ts` 后缀），
  且**永不 emit**——因为不 emit，这个开关不与任何产物路径冲突。
- 已知缺口，明确记账：**eslint 只覆盖 `.mjs`，`.ts` 的静态检查只有 tsc**。
  于是类型相关规则（floating promise、无谓断言）缺位。
  这是为了不引入 typed lint 那一整套配置而付的价；等它真的咬人再加（棘轮），
  而不是现在为了"配置看起来完整"先装一套。

## 后果

- **好**：`pnpm test` 直接跑源码，没有 build 步骤，也没有 `dist/` 漂移。
- **好**：闸门脚本可以用绝对路径调用包源码（判定脚本住在原仓库、cwd 指向别处），
  演练场景因此**不需要在临时克隆里装依赖**——这是 Phase 0 演练能保持快的原因。
- **代价**：`node_modules` 仍然必需（`zod`、`yaml`）。所以"零依赖跑闸门"只对
  `ci.mjs --guard-only` 成立；资产闸门在缺依赖时降级为警告，并记进 bypass-matrix。
- **代价**：这些包无法发布给外部消费者（没有产物）。Phase 2 真要发布时再补构建，
  那会是一次显式决策，而不是一个默认存在的 `dist/`。
- **代价**：首次加载多一次类型擦除（毫秒级），且调试时堆栈指向源码（这是好事）。
