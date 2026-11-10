---
schema_version: 1
id: dec_01M6QGCKYWGDFKGD5J54CTNGZX
type: decision
status: accepted
created: "2026-11-06"
last_confirmed: "2026-11-06"
supersedes: null
origin_incident: null
sources:
  - "file://docs/implement2.md#t:只定 4 种资产"
  - "file://docs/implement2.md#t:别一上来 15 种"
  - "file://docs/directory.md#t:schema 是宪法"
sensitivity: internal
confidence: 0.9
---

# 分类法 v1 只定 4 种资产：decision / state / event / rule

## 问题

分类法是 schema 的核心，也是产品的元资产 E1。`directory.md` 的示例 taxonomy 列了 7 种
（decision / state / event / rule / spec / sop / eval_case）。第一版照抄它，还是只定最小的完备集？

## 考虑过的选项

1. **照抄 `directory.md` 的 7 种**：文档已经有了，看起来"一步到位"。
2. **只定 4 种：`decision` / `state` / `event` / `rule`**。
3. **只定 2 种（`state` / `event`）**，其余靠 front-matter 字段表达。

## 选定

**选 2。**

- 这 4 种是按**写规则的完备划分**切的，不是按业务域：`event` 只追加、`state` 就地替换（必须带日期）、
  `decision` 一旦 accepted 不可变、`rule` 就地替换且必须绑一个 `origin_incident`。
  每种类型对应一种**不同的写规则**；写规则相同的东西不该是两种类型。
- `spec` / `sop` / `eval_case` 的写规则分别是 `state` / `state` / `event` 的特例，
  第一版用 `requires_fields` / `requires_sections` 就能表达。它们确实值得独立成类型——
  但那是 v2 的迁移问题，不是第 1 天的设计问题。
- 选 3 不行：`decision` 的不可变性与 `rule` 的溯源要求是**结构性**的，
  用可选字段表达等于把它们降级成"记得填"的约定（反模式 2）。
- "加类型很便宜"是错的：类型是 grep、目录分区、emitter 分支、检索路由的公共键。
  多一种类型，所有下游都多一条分支；而"少一种、以后加"只需要一次迁移——
  迁移通道在 ADR-0008 里先建，正是为了让这个代价可支付。

## 后果

- **好**：4 种类型的写规则互不重叠，"这条该算 state 还是 event"有唯一答案。
- **好**：判定分支可穷举、可测试（`packages/core` 的类型相关分支一共 4 条）。
- **代价**：Phase 4 的抽取器遇到 spec / SOP 类内容时只能先归到 `state`，靠 `requires_fields` 区分。
- **代价**：加类型要走 v2 迁移（迁移脚本 + bump 版本 + 配 ADR），这是有意的摩擦。
- **残余风险**：4 种够不够，只有真实采集数据能回答。若 Phase 4 发现某类内容反复落错桶，
  那是一次迁移的正当理由（棘轮），而不是现在先把 15 种建好。
