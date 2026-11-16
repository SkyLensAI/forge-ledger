---
schema_version: 1
id: dec_06GV1Q7H3K5NDZ1RE0EXTCHB7F
type: decision
status: accepted
created: "2026-11-06"
last_confirmed: "2026-11-06"
supersedes: null
origin_incident: "file://docs/implement2.md#t:**自举**：用本项目的 CLI 管本项目的 ADR / 规则 / eval"
sources:
  - "file://docs/implement2.md#t:**自举**：用本项目的 CLI 管本项目的 ADR / 规则 / eval"
  - "file://docs/implement2.md#t:目标自己产出 30+ ADR"
  - "file://packages/core/src/bootstrap.ts#t:BOOTSTRAP_ADR_TARGET = 30"
  - "file://apps/cli/src/main.ts#t:forge bootstrap"
  - "file://packages/core/src/bootstrap.ts#t:数量是「决策日志被用起来」的痕迹"
sensitivity: internal
confidence: 0.85
---

# 自举是一条命令，不是一张进度表

## 问题

implement2.md 给 S29 写的目标有两半：

> **自举**：用本项目的 CLI 管本项目的 ADR / 规则 / eval，目标自己产出 30+ ADR。

第二半（30+ ADR）容易被数出来，第一半（**用本项目的 CLI 管**）却容易变成一句
"我们平时也用 `forge lint --repo`"。这两件事的差别很大：

- 只数 ADR，一个把模板抄 30 遍的仓库也能过；
- 只在嘴上说"用 CLI 管"，`docs/adr/`、`AGENTS.md`、`evals/`、两个对外产物
  就会各自漂移，而漂移不会自己发出声音。

自举要证明的不是"我们写了 38 条决策"，而是**同一套判定能把这个仓库自己读进来、
审一遍、并发现它有没有退步**。

## 考虑过的选项

1. **只数 ADR，报告一个数字。** 否决。数字是 vanity metric：
   它不区分"真的做过 30 个决策"和"把同一个模板改了 30 次标题"。
2. **人工写一份自举报告，放进 README。** 否决。这份仓库已经付过两次代价
   （`evals/regressions/0003` / `0005`）：一份说"已经完成"的文档，
   下一次改动就会让它变成谎话。报告必须能重算。
3. **用一条命令把四件事一起判：资产、种子规则、尺子、对外产物。** 采纳。

## 选定

- `forge bootstrap`：
  - 用 `readRepoAssets` 读仓库自己的资产，用与 `forge lint --repo` **同一份**
    `judgeLibrary` 审出处；
  - 数 `docs/adr/` 下的 `decision` 资产，**30 条是底线**，不是目标本身；
  - 读 `AGENTS.md` 的种子规则时**直接复用闸门 1 的解析器**
    （`scripts/gates/lib/harness.mjs`），避免报告说绿、闸门说红；
  - 读两把尺子的 `review` 与阈值批准状态：自举只自举文档、不自举质量门，不算成立；
  - 用**同一批资产**重算 `listing/` 与 `demo/`，逐字节比对；
  - 团队版按 S30 的顺序判定（见 ADR-0040）。
- 判定住在 `packages/core/src/bootstrap.ts`（零 IO），宿主只负责读文件与打印。
- 退出码：`0` = 自举成立；`1` = 有具体问题；`2` = 用法错误。
- `listing/` 与 `demo/` 是投影，加入 `DEFAULT_REPO_EXCLUDES`：
  否则 `listing/` 里的 `SKILL.md`（以 `---` 开头的 Skill front-matter）
  会被 `readRepoAssets` 当成坏资产，自举还没开始就先红了。
- 两个产物目录各写一份 `.forge-manifest.json`，记录这一轮生成器写了哪些文件。
  下一次生成只清理**上一份清单里列过、这一轮没有**的文件——目录里人放的东西
  （`CNAME`、`LICENSE`）不在清单里，所以永远不会被删；清单读不懂时也什么都不删。
  `bootstrap` 与 `E15` 把清单之外的残留同样算作漂移：所有"期望的文件都在"的检查
  都看不见残留文件，而残留文件不再对应任何资产。

## 后果

- **好**："自举完成"从一句愿望变成一组可重算的读数。ADR 数量、规则出处、
  尺子确认、产物一致、团队版顺序，任何一项退步都会让命令变红。
- **好**：自举报告与 `E15` 探针共用同一批判据；`forge bootstrap` 是给人看的入口，
  `E15` 是每次 CI 都会跑的那一份。两处不会给出两个答案。
- **代价**：`forge bootstrap` 每次都重算 demo / listing（38 条资产、约 80 个文件），
  比一条 `lint` 慢；但它仍然在几十毫秒级，而"对外产物漂移"是它最值钱的那条检查。
- **代价**：30 条是 implement2.md 给的量级，不是本仓库证明出来的最佳值。
  它的作用是**防止自举退化成 3 条 ADR 的演示仓库**，不是奖励凑数。
- **残余风险**：ADR 的**质量**仍由人判断。命令只能保证它们能被读、能过出处、
  数量够；一条内容空洞但格式正确的 ADR 它拦不住。
