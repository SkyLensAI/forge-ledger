# 资产集合的判据是「带 front-matter 的 markdown」；仓库里的第一批资产是 ADR

> 决策 `dec_01M6QGCKZ2Q8K348RJ1T59CZV4` · accepted · 2026-11-06 · 最后确认 2026-11-06
>
> 出处：
> - `file://docs/implement1.md#t:你不需要编 demo 数据，你的开发历史就是数据`
> - `file://docs/implement1.md#t:用本项目的 lint 检查本项目自己的 harness 有没有腐化`
> - `file://docs/directory.md#t:在代码库里它通常是空的`

# 资产集合的判据是「带 front-matter 的 markdown」；仓库里的第一批资产是 ADR

## 问题

出处闸门要检查"所有入库资产"。但 `data/` 被 gitignore（R1），CI 里看不到任何用户资产。
那么 CI 到底检查什么？资产集合怎么定义，才能既不漏、又不依赖"记得登记"？

## 考虑过的选项

1. **只校验一个专门的样例目录**（如 `evals/fixtures/`）。
2. **维护一份资产清单文件**，每个资产都要登记。
3. **约定即集合**：仓库里任何带 YAML front-matter 的 markdown 都是资产，必须过闸门；
   `schema/` 除外（那是宪法，不是资产）。

## 选定

**选 3。**

- 选 2 的问题不是麻烦，而是**它会漏**：漏登记的资产不受任何检查，
  而且没有任何信号提示它漏了。"忘记登记"是一种静默失败，静默失败不是闸门。
- 选 1 会把闸门降级成"样例测试"：真实资产反而没人检查，而它们正是最该被检查的。
- 因此第一批被检查的资产天然是 `docs/adr/*.md`。这不是顺手，而是这个项目唯一可行的冷启动路径：
  **开发历史本身就是第一批数据**——本仓库的 ADR 既是开发副产物，也是产品要卖的那类资产。
- 检索范围排除：`schema/`（宪法）、`data/`（用户数据）、`node_modules/`、`dist/`、`.git/`、`.turbo/`。
  除此之外，**加了 front-matter 就等于自愿被闸门管**。

## 后果

- **好**：自举闭环成立——本项目的每条 ADR 都被同一套出处规则约束，
  写错 span 会被自己的闸门拦下（ADR-0009 的 origin_incident 就是这么发现的）。
- **好**：Phase 2 的 emitter 产出（`AGENTS.md`）不带 front-matter，因此不会被误判为资产。
  "带 front-matter"这个判据同时区分了**资产**与**投影**——投影可以被重新生成，资产不行。
- **代价**：给任何 markdown 加 front-matter 都会立刻引入完整形状要求
  （id / type / status / created / sources …）。想只加个 `tags:` 的人会被闸门拦下。
  这是有意的：半吊子的 front-matter 比没有更难查。
- **代价**：CI 看不到用户数据 → 用户库的校验只能靠 CLI（Phase 2）。
  两处必须是**同一份纯函数**（`packages/core`），否则会出现"本地过、CI 挂"的漂移。
- **残余风险**：`docs/` 里的设计文档（`implement1.md` 等）没有 front-matter，因此不受出处约束。
  它们在这个体系里的角色是**证据（source）**而不是资产——这个区分是本 ADR 成立的前提，
  一旦有人给设计文档加上 front-matter，前提就变了（闸门会立刻要求它自带出处）。
