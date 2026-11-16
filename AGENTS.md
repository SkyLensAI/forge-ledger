# AGENTS.md — Forge 种子规则

只写 **agent 否则一定会做错的事**。规则很少是故意的：**新规则只能由一个真实错误长出来（棘轮），加之前先删一条。**

- 格式由 `pnpm gate:ci` 机器校验：规则数 ≤ 8、每条必须有 `出处`（见 `scripts/gates/lib/harness.mjs`）。
- 本文件的有效性不靠自觉：格式不合规 → CI 红。
- 分工会话：`docs/handbook/` 讲怎么干活，本文件只讲"不许做错什么"。

---

### R1 · 用户数据永不进 git

- **强制**：`.gitignore` 忽略 `data/`；闸门 2/3 判定 `R1_USER_DATA_IN_REPO`。
- **出处**：`directory.md` 反模式 1 —— 一次误提交就是一次信任崩塌。

### R2 · schema / taxonomy / 迁移不许 agent 自主改

- **强制**：闸门 1 `A1_PROTECTED_PATH` 直接阻断写入；确需改动时，同一变更集里必须有新增的 `docs/adr/NNNN-*.md`（闸门 3 `R2_PROTECTED_WITHOUT_ADR`）。
- **出处**：`implement2.md` 不可逆点 2（迁移成本随数据量线性增长）；`implement1.md` §2.2。

### R3 · 不许绕过闸门

- **禁止**：`git commit --no-verify`、`git commit -n`、`git push --force`、改 `core.hooksPath`、删受保护路径。
- **同样无效**：改松闸门代码。判定由**基线修订**里的闸门执行，被检查者改不到检查者（ADR-0005）。
- **强制**：闸门 1 `B1/B2/B3/B4`（Bash 侧）。闸门红了要修**问题**，不是修**闸门**。
- **出处**：`implement1.md` §2.3 —— 每一种闸门都有不同的绕过方式。

### R4 · 没有出处的断言不许进 `assets/`

- **强制**：闸门 3 的 `scripts/gates/assets.mjs` 校验本仓库每条资产都能解析到 `data/sources/`（或仓库内可读路径）里的 span；CI 看不到 `data/` 时，用户资产由同一份纯函数的 `forge lint` 校验。
- **出处**：`implement1.md` §3.3 —— 出处是硬约束，不是元数据奢侈品。

### R5 · 业务逻辑不写在 `apps/`

- **强制**：编译与维护逻辑必须落在 `packages/core`（零 IO、纯函数），`packages/core/test/purity.test.ts` 扫全部源文件：禁止 IO 模块、时钟、随机、定时器与 `process`/`console`。
- **出处**：`directory.md` 反模式 3 —— 否则第二天就得把同一段逻辑抄到 CLI 和 MCP server。

### R6 · 产出必须逐字节确定

- **禁止**：在输出里放时间戳、随机数、依赖 `Object.keys` 的隐式顺序、依赖本机时区/换行符。
- **强制**：`apps/cli/test/e2e.test.ts` 用两个全新 vault 断言逐字节相同；`packages/core/test/emit.test.ts` 与 `emit-skill` 的测试钉住投影；`.gitattributes` 已强制 LF。
- **出处**：`directory.md` §三 —— 确定性是快照测试、审计、回滚的前提。

### R7 · 每个错误变成一条规则或一个回归用例

- **要求**：修完一个 bug，必须同时留下"下次它还犯就一定能被拦住"的东西（本文件一条规则，或 `evals/regressions/` 一个用例）。
- **强制**：`evals/regressions/regressions.test.ts` 是回归集的执行体，随 `pnpm test` 进 CI；跑不了的条目必须写明 `why`，不许静默算作"已覆盖"。
- **出处**：`implement2.md` S2 —— 规则主要靠棘轮长出来，所以第 1 天不要写全。

### R8 · 不许把"模型会做对"当假设

- **禁止**：用自然语言提示代替代码强制（"记得加出处"）；让 LLM 直接写正式资产。
- **强制**：评审 + R4；信任边界必须写在代码里。
- **出处**：`implement1.md` §3.1 —— "模型负责抽取，代码负责不信任"；最难的不是规则，是把信任边界实现在代码里。
