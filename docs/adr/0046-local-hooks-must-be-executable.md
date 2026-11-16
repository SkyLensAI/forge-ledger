---
schema_version: 1
id: dec_01JQ0Z7MN1V2W3X4Y5Z6ABCDEG
type: decision
status: accepted
created: "2026-11-16"
last_confirmed: "2026-11-16"
supersedes: null
origin_incident: "file://scripts/gates/rehearse.mjs#t:A1 本地 pre-commit 阻断"
sources:
  - "file://scripts/gates/rehearse.mjs#t:A1 本地 pre-commit 阻断"
  - "file://.githooks/pre-commit#t:闸门 2 · pre-commit"
  - "file://.github/workflows/ci.yml#t:pnpm gate:rehearse"
  - "file://docs/adr/0001-gate-authority-lives-in-ci.md#t:本地做早期反馈，服务端做权威判定"
sensitivity: internal
confidence: 0.9
---

# 本地钩子必须以可执行模式提交

## 问题

CI 的 rehearsal 步骤要证明一件事：**一个故意写错的改动会在本地被拦住**。
它克隆当前仓库、把 `core.hooksPath` 指向 `.githooks`，然后执行一次错误的
`git commit`，期望 pre-commit 以非零退出。

在一次真实的 Linux CI 运行里，这个演练只过了 7/10：A1（本地 pre-commit 阻断）
和 B1（本地拦住用户数据）都失败了，A2 也随之失败。原因不是判定写错，而是
`.githooks/pre-commit` 与 `.githooks/pre-push` 在 git 索引里是 **100644**——
没有可执行位。Linux 上的 git 会直接忽略不可执行的 hook，并打印一条容易被
日志淹没的提示：

```text
hint: The '.githooks/pre-commit' hook was ignored because it's not set as executable.
```

于是本地闸门变成“静默不存在”。这比它报错更糟：演练以外的人只会看到提交
成功，不会知道钩子根本没跑。

## 考虑过的选项

1. **在 `scripts/gates/install-hooks.mjs` 里 `chmod +x`。** 否决作为唯一修法。
   它只能修当前工作区；`git clone` 出来的副本仍然按索引模式决定可执行位，
   而 rehearsal 和 CI 用的正是新克隆。
2. **让 rehearsal 显式用 `sh .githooks/pre-commit` 调用。** 否决。那会让演练
   测到一个现实中不存在的调用方式，等于把“钩子没生效”这件事藏起来。
3. **在索引里把两个钩子标成 100755 并提交。** 采纳。这是 git 记录文件模式
   的唯一位置；新克隆（包括 Linux CI）会得到可执行位。
4. **用 `--no-verify` 跳过本地闸门，只靠 CI。** 否决。R3 明确禁止；而且
   这会把“本地早期反馈”整个删掉，只留下更慢的反馈。

## 选定

- 用 `git update-index --chmod=+x .githooks/pre-commit .githooks/pre-push`
  把两个钩子的索引模式改为 **100755**，随本次变更提交。
- 不改 rehearsal 的判定：它应该继续模拟一次普通的 `git commit`，这样
  “钩子不可执行”会继续被当成失败。
- 提交信息带 `ADR: 0001` 尾注，因为这条修复恢复的是 ADR-0001 描述的分层：
  本地负责尽快失败，服务端负责权威判定。两者都需要钩子真的存在。

## 后果

- **好**：新克隆在 Linux 上会真正执行 pre-commit；rehearsal 的 A1/B1/A2
  重新有意义，退出条件回到 10/10。
- **好**：这是一次索引模式修复，不改判定逻辑，也不放宽任何规则。
- **代价**：Windows 工作区不保证文件系统层面的可执行位；但 Git for Windows
  通过自己的 sh 执行钩子，而 CI 是 Linux，索引模式在那边生效。
- **残余风险**：以后新增钩子仍然可能忘记设置 100755；本 ADR 只修当前两个
  钩子，没有加一条“所有 `.githooks/*` 必须是 100755”的自动检查。
