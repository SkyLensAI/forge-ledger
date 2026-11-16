---
schema_version: 1
id: dec_06GV1Q7H3K5NDZ1RE0EXTCHB8G
type: decision
status: accepted
created: "2026-11-06"
last_confirmed: "2026-11-06"
supersedes: null
origin_incident: "file://docs/implement2.md#t:团队版**只在出现付费信号后**做"
sources:
  - "file://docs/implement2.md#t:团队版**只在出现付费信号后**做"
  - "file://docs/implement2.md#t:单人模式的三个缺失项：没权限、没并发、没敏感度切分"
  - "file://packages/core/src/team.ts#t:TEAM_CAPABILITIES = [\"permissions\", \"concurrency\", \"sensitivity\"]"
  - "file://docs/team/status.json#t:payment_signal"
  - "file://evals/runner/gate.ts#t:TEAM_UNGUARDED: \"E16_EVAL_TEAM_UNGUARDED\""
sensitivity: internal
confidence: 0.9
---

# 团队版由付费信号闸门，不由路线图解锁

## 问题

implement2.md 给 S30 写的第一句话是一个**顺序**：

> 团队版**只在出现付费信号后**做：权限、敏感度分级、同步
> （单人模式的三个缺失项：没权限、没并发、没敏感度切分）。

这句话在路线图上看起来像"第 11 周以后做"，但它真正的意思是
**没有证据就不要做**。两者的差别在于：路线图到点自动解锁，
而付费信号是一个必须由**人**提供的外部事实。

问题在于，代码没有办法知道"有没有人付钱"。所以这个决定不能写成
"代码会检查付费信号"——那是在假装代码能读银行流水。它能做的是两件事：

1. 把"没有信号"这个状态**写下来**，而不是留在某个人脑子里；
2. **拒绝把任何提前长出来的团队能力报告成已启用**。

## 考虑过的选项

1. **只在 README 里保留这句话。** 否决。这正是本仓库反复付代价的那类失败：
   一句礼貌的约束，下一次"反正迟早要做"就会被顺手绕过去。
2. **现在就把权限、并发、敏感度切分实现掉，等信号来了再打开。** 否决。
   S30 的前提不是"功能有没有写完"，而是"值不值得写"。先写团队版会带来
   权限模型、并发锁、同步协议三份长期维护成本，而它们都没有付费客户来校准。
3. **记录信号与三项能力，用纯函数判定顺序是否被违反。** 采纳。

## 选定

- `docs/team/status.json` 记录两个输入：
  - `payment_signal`：字符串或 `null`。**只能由人填写**。空白字符串按 `null` 处理——
    一个空格不能解锁团队版。
  - `capabilities`：`permissions` / `concurrency` / `sensitivity` 三个布尔值。
- `packages/core/src/team.ts` 的 `evaluateTeamEdition`：
  - 没有信号 → `deferred`；如果任何能力为 `true`，产出
    `TEAM_CAPABILITY_WITHOUT_SIGNAL` **违规**（不是"提前完成"）；
  - 有信号但能力没齐 → `partial`，缺项逐条列出；
  - 有信号且三项都齐 → `ready`。
- `forge bootstrap` 把违规报红；`evals/runner/gate.ts` 的 `E16_EVAL_TEAM_UNGUARDED`
  每次 CI 再问一遍。
- 解析也住在 `team.ts`（`teamStatusFromConfig`）：CLI 与探针对同一份文件
  必须给出同一个答案。形状不对一律按"没有信号 + 能力全关"处理——
  保守方向是**不会**把坏配置读成已启用。

## 后果

- **好**："只在出现付费信号后做"变成一条能被违反、也能被发现的规则。
  有人先打开权限开关而没写信号，`forge bootstrap` 与 CI 会同时报红。
- **好**：`deferred` 与 `partial` **不报错**。"还没做"和"做错了顺序"是两件事；
  把前者判红会让这条检查从第一天起就永远红着，而永远红着的检查等于没有检查。
- **代价**：代码证明不了付费信号是真的。一个能改 `docs/team/status.json` 的人
  可以填一个假字符串。这是**有意留下的边界**：信号的权威性来自评审与商业事实，
  不来自代码；代码只负责让"先做了"不能悄悄变成"已就绪"。
- **代价**：`sensitivity` 字段在单人版已经存在（资产 front-matter），
  但它只是**标注**，不是**隔离**。团队版的 `sensitivity` 能力指的是按敏感度
  做访问控制与分发切分；在付费信号出现之前，它保持 `false`。
- **未做（写下来，不假装做了）**：权限模型、并发锁、同步协议一行代码都没有。
  它们正是 S30 的三项能力，也正是这条闸门要保护的"还没到做的时候"。
