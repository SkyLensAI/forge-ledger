# Phase 2 只建三个包：编译与投影逻辑落 `packages/core`，不为 emit 单开包

> 决策 `dec_01M6Q2FD00Z52A681X6FHS62G7` · accepted · 2026-11-06 · 最后确认 2026-11-06
>
> 出处：
> - `file://AGENTS.md#t:编译与维护逻辑必须落在`
> - `file://docs/implement1.md#t:编排用确定性 DAG / 状态机`
> - `file://docs/directory.md#t:第二天你就得把同一段逻辑复制到 CLI 和 MCP server`
> - `file://docs/adr/0006-taxonomy-v1-four-asset-types.md#t:判定分支可穷举、可测试`

# Phase 2 只建三个包：编译与投影逻辑落 `packages/core`，不为 emit 单开包

## 问题

`directory.md` 的 v0 最小版列了 6 个包（`schema` / `core` / `llm` / `ingest` / `store` / `emit`），
完整目录树里还有更多。Phase 2 要写 store、normalizer、emitter、CLI——
按那张清单，`emit` 该是一个独立包，`provenance` 也该是。

但 R5 说的是"编译与维护逻辑必须落在 `packages/core`（零 IO、纯函数）"，
而"为每个出口一个文件"（`directory.md` §三）说的是**文件**，不是包。
两者不冲突，但把"文件"读成"包"很容易。

## 考虑过的选项

1. **照 v0 清单建包**：`packages/emit`、`packages/provenance`、`packages/lint` … 各建一个。
2. **只建三个**：`schema`（IR + 校验 + 迁移）、`core`（全部纯逻辑，含 emit 投影）、
   `store`（IO）、`ingest`（连接器）——即四个，其中 `schema` 是 Phase 1 的。
3. **按"消费者"拆**：给 CLI 一个包，给将来的 MCP server 一个包。

## 选定

**选 2。**

- `directory.md` §六自己给了拆包信号："需要第二个消费者（比如 MCP server）→
  把逻辑从 app 下沉到 `packages/core`"。**在第二个消费者出现之前拆包，只是在制造
  需要维护的空壳**，而空壳的害处不是浪费，是让人以为那里有边界。
- `emit` 不独立成包的实质理由：emitter 的实现是**模板 + 排序键 + 换行规则**，
  三者都必须与 `sortAssets`、`Occurred_at` 归一、`\n` 约定共用同一份约定。
  拆成两个包就得把这些约定导出成公共 API，而它们本来是内部细节。
  出口多起来（Skill / Eval / Obsidian，S24）之后如果 `emit.ts` 真的长到难以阅读，
  那时按出口拆——**那时**它能拆得干净，因为边界由真实的模板共性和差异决定。
- `provenance` 同理：它是 300 行的纯函数 + 一份判定，塞进一个包只会让
  `@forge/core` 的 `exports` 多一行。它的**逻辑**独立（这是 ADR-0009 的重点），
  包不必独立。
- 编排是**写死的 DAG**（sources → 事件 → 资产 → 投影），不是 orchestrator agent。
  它住在 `store/vault.ts`（因为每一步都碰 IO）而**不是** `core`——
  R5 说的是"业务逻辑不写在 apps"，不是"所有代码都写进 core"。
  判定在 core，IO 在 store，参数在 apps。三层各管一段，没有一层跨过别人的活。

## 后果

- **好**：`grep` 一处就能回答"这条规则谁在判"——它在 `packages/core`。
  CI 闸门、CLI、将来的 MCP server 都调同一份，不存在两份会漂移的实现。
- **好**：包数量少意味着 `pnpm install` 快、依赖图浅、`tsconfig` 一处配置。
- **代价**：`packages/core/src/emit.ts` 会随出口数量增长。已知会咬人的点，
  处理方式写在"选定"里（按出口拆），不是现在预拆。
- **代价**：`directory.md` 的目录树与仓库实际布局不一致了。
  这不是漂移而是**有意的分歧**（分歧理由记在这里），但必须在文档里说清，
  否则下一个人会以为仓库建漏了——这条已记进 README 的「目录」一节。
- **残余风险**：`apps/cli/src/main.ts` 目前自己做了"读文件 → 调 core → 打印"的编排。
  这**是** app 层该干的事（宿主适配），但它也意味着 CLI 与将来的 MCP server
  会有两段相似而不共享的编排代码。第二个消费者出现时，把这段下沉到 `store`——
  信号很明确：出现第二份，就下沉。
