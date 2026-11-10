# `evals/` —— 先有尺子，再接模型（Phase 3 建的尺子，Phase 4 接的模型，Phase 5 加了第二把）

> 目录一物两用：**它既是本项目的质量门，也恰好是你要卖给用户的那类资产**
> （`directory.md` 的"一个漂亮的递归"）。做不好自己的 eval，就做不好用户的 eval。

## 这里有两把尺子

| 尺子 | 量什么 | 用例 | 判定 |
|---|---|---|---|
| **extraction**（Phase 3） | 一件事被抽成了**对的类型、指回对的位置**吗 | `evals/golden/extraction/cases.json`（20 条） | 精确率 / 召回率 vs 阈值（`E1`）+ 尺子还睁着眼吗（`E4`） |
| **conflict**（Phase 5） | 合成的"新旧状态矛盾"**100% 进队列、证据正确、零条被自动应用**吗 | `evals/golden/conflict/cases.json`（9 条） | `E8`（队列完整 + 证据对得上）+ `E9`（无自动覆盖） |

## 这里还有五个**探针**（Phase 4–8）

尺子量"做得好不好"，探针量"边界还在不在"。两者的失败方式完全不同：
尺子的分数难看时，人会去调阈值；探针红的时候，人只能去修边界。

| 探针 | 量什么 | 判定 |
|---|---|---|
| `trust`（Phase 4） | 敌意模型的产出穿不穿得过 sanitize 与守卫 | `E7` |
| `conflict`（Phase 5） | 合成的矛盾 100% 进队列、证据对得上、资产侧零改动、判定模块零 IO | `E8` / `E9` |
| `retrieval`（Phase 6） | 注入块不超预算、绝不预加载 | `E10` / `E11` |
| `maintenance`（Phase 7） | **每一次写入都有见证人**；健康检查分得开健康与烂掉；1000 条之后信号不被淹 | `E12` / `E13` / `E14` |
| `phase8`（Phase 8） | ADR ≥ 30 且读得动；团队版没有付费信号时一项能力都不许开；listing / demo 可重生成、demo 来自自己的库 | `E15` / `E16` |

两把尺子共用**同一套确认机制**（`evals/runner/review.ts` 的 `ReviewRecord` 与指纹）：
"有人点过头"如果只是一面旗，它就能被盖在任何后续改动上。所以确认记的是**内容指纹**
（`E2` 会红），而两把尺子的确认含义**必须是同一个**——各写一套的结局是它悄悄分叉。

Phase 8 的探针（`evals/runner/phase8.ts`）不量分数，它量**顺序**：
自举的 30 条 ADR 底线、团队版在付费信号之前必须全关、上架包永远是 draft、
demo 只从自己的库生成。四条都是"能不能重算"的问题，所以 `E15` 在每次 CI 里
重新生成一遍 demo / listing 并逐字节比对；`E16` 只把"没信号却开了能力"判红——
`deferred` 与 `partial` 是状态，不是错误。

## 这把尺子量什么、不量什么

**量**：一个抽取实现在 20 条人工确认的用例上，把事件抽成了**对的类型、指回对的位置**的次数。

**不量**：措辞好不好、正文写得漂不漂亮、归并与冲突（那是 P5 的尺子）。

最重要的一句话写在前面：

> **阈值是地板，不是目标。** 它回答"这个实现是不是坏掉了"，**不**回答"这个实现够好了吗"。
> 实测的精确率 0.882 / 召回率 0.882 **不**等于"抽取质量已达 88%"——
> 它是"一个朴素的词法启发式在这 20 条上能做到 88%"。
> Phase 4 把模型接了进来，而这把尺子仍然是同一个（**模型可替换，尺子不是**）。
> 模型路径当前的状态是**未量过**——没有 API key。见下面「Phase 4 · 模型路径怎么量」。

绿灯只说明"你写的检查通过了"（implement1.md §2.3）。**这句话是本目录的立身之本。**

## 现在实测到的数字

| 实现 | 精确率 | 召回率 | F1 | 是否及格（阈值 0.700） |
|---|---|---|---|---|
| `baseline-lexical`（词法基线） | 0.882 | 0.882 | 0.882 | ✅ |
| `null`（永远返回空） | 0.000 | 0.000 | 0.000 | ❌ ← 这就是 Phase 3 的退出条件 |
| `hostile-probe`（编造出处的探针） | 0.200 | 0.471 | 0.281 | ❌ ← 分数低是**对的**：它每一条都编造出处 |
| `model-replay`（真实模型 + 录像） | —— | —— | —— | ⛔ **没有数据**（需要一份录像，见下） |

后两行的分数**都不该被读成抽取质量**：一行是故意的敌意，一行还没有跑过。
它们出现在表里，是因为"探针也在同一张表上"这件事本身值得被看见。

复现：

```bash
node evals/runner/main.ts                    # 基线
node evals/runner/main.ts --extractor null   # 反例，必须不及格
node evals/runner/main.ts --list             # 列出可驱动的实现
node scripts/gates/evals.mjs                 # 闸门怎么判（落盘后才可用）
```

### 基线**漏在哪、错在哪**（如实记账，不挑好看的报）

| 用例 | 现象 | 为什么这是对的失败 |
|---|---|---|
| `ext-006` | 漏了一条 decision | "第一版就四种…别一上来就十五种" 里没有词法信号——改写过的说法是词法法的天然盲区 |
| `ext-007` | 漏了一条 decision，同时误报一条 state | "迁移通道也得**现在就**建起来"里的"现在"被当成了状态陈述 |
| `ext-019` | 误报一条 state | "这个索引层**现在用的是** SQLite 还是别的？"是一句**疑问**，词法法分不出疑问句和陈述句 |

这三条一起说明了一件重要的事：**精确率与召回率必须一起卡**。
只看召回率会奖励"什么都抽"，只看精确率会奖励"什么都不抽"。
`ext-018` ~ `ext-020` 三条反例存在的唯一目的，就是让空产出和滥产出都现形。

## 目录结构

```
evals/
├── golden/extraction/cases.json   20 条人工确认的用例（每条带一个能解析到仓库原文的 span）
├── golden/conflict/cases.json     9 条合成的『新旧状态矛盾』（判据：100% 进队列、证据正确、零自动应用）
├── fixtures/conflict-scenarios.md  那 9 条引用的原文（合成证据层：编的句子，但真实存在于仓库里）
├── extractors/
│   ├── candidate.ts               候选断言的构造（两个实现共用，出处拼法只有一份）
│   ├── baseline.ts                词法基线：确定性、零依赖、没有模型
│   ├── null.ts                    永远返回空：退出条件的反例，长期在场的探针
│   ├── hostile.ts                 编造出处的敌意**模型**：信任边界的探针（E7）
│   └── model.ts                   把一台 Model 包成 Extractor（model-replay 的入口）
├── runner/
│   ├── run.ts                     读用例 → 跑实现 → 判出处 → 打分
│   ├── main.ts                    CLI：node evals/runner/main.ts
│   ├── gate.ts                    **闸门的判定**（纯函数，所以它能被测试）
│   ├── gate.test.ts               闸门判定自己的尺子（含边界与"当前真实状态"）
│   ├── trust.ts                   信任边界探针的**判定**（纯函数，可注入依赖）
│   ├── trust.test.ts              探针的自证：含两条变异，探针必须报红
│   ├── conflict.ts                冲突探针（E8/E9）：跑合成集 + 内存队列 + 扫判定模块的 IO
│   ├── conflict.test.ts           冲突探针的自证：四条变异（否决、自动应用、漏写、IO）
│   ├── retrieval.ts               取用探针（E10/E11）：拿本仓库自己的资产量预算与预加载
│   ├── maintenance.ts             维护探针（E12–E14）：审计链 / 健康检查 / 1002 条规模
│   └── review.ts                  golden 集的确认记录与指纹（两把尺子共用）
├── invariants/invariants.test.ts  S13 的四条不变量，**每条都配了反例**
├── regressions/                   真实出过的事（R7），见那里的 README
│   └── regressions.test.ts        **回归集的执行体**：登记表 / 可执行检查 / 缺口记账
├── fixtures/desensitized-export.json  脱敏样例导出（Phase 2 留下的）
└── thresholds.json                阈值 + 它被谁批准过
```

## 为什么大约定这么几件事

**1. 用例的判据必须指得回原文。** 每条用例带一个 `span`，runner 会去解析它——
解析不到就报 `E5_EVAL_GOLDEN_INVALID`，并且**分数不可采信**。
理由与产品里的出处规则同源（ADR-0009）：一条指不回原文的标准答案，
就是一条凭空发明的标准答案。这条检查第一次运行就抓到了两处真实的错
（一条 `#t:` 锚点只有 7 字符、一条 `#k:` 指错了 JSON 路径）——
尺子先审自己，是有产出的。

**2. golden 集与阈值都必须被**人工确认**，而且由闸门检查（`E2` / `E6`）。**
这不是形式主义：golden 集由 agent 自己写、自己判，就是让模型给自己发合格证，
"先有尺子"的意义会整个消失。implement2.md 的人机分工表把 P3 的"人必须做"
明确写成"**阈值与 golden 集**"。

**3. 确认绑的是内容，不是文件名。**
`review.cases_sha256` 记的是被确认那一份用例的指纹，`thresholds_sha256` 同理。
闸门比对的是**当前**这一份的指纹。所以：加一条、删一条、改一个期望值、
甚至只是调低阈值——**任何一个字节的改动都会让确认失效**（`E2` / `E6` 变红），
直到有人重新确认。

为什么必须这样：一句"有人点过头"如果只是一面旗，它就能被盖在任何后续改动上，
包括"agent 事后往 golden 集里塞一条恰好让当前实现变准的用例"。
指纹用**规范化 JSON**（键递归排序）算，所以纯排版改动不会误伤——
一次因为挪了个字段顺序就失效的确认，只会训练人闭着眼睛重签。

**当前状态：已确认**（`reviewed_by` = `ratified_by` = `allentire`，2026-11-06）。

重新确认的方法（一次大约十分钟）：

1. 打开 `evals/golden/extraction/cases.json`，逐条读 `why`。
2. 点开它对应的 `span`（`file://` + `#h:` / `#t:` / `#k:`），确认那处原文里**确实记着**这件事。
3. 认为对，就重算指纹并更新 `review` 块：

```bash
node -e '
const {createHash}=require("node:crypto"),{readFileSync,writeFileSync}=require("node:fs");
const stable=(v)=>Array.isArray(v)?v.map(stable):(v&&typeof v==="object"?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v);
const dig=(v)=>createHash("sha256").update(JSON.stringify(stable(v),null,2)+"\n","utf8").digest("hex");
const p="evals/golden/extraction/cases.json", c=JSON.parse(readFileSync(p,"utf8"));
c.review.status="confirmed"; c.review.reviewed_by="<你的 login>"; c.review.reviewed_at="YYYY-MM-DD";
c.review.cases_sha256=dig(c.cases);
writeFileSync(p, JSON.stringify(c,null,2)+"\n");'
```

4. 改阈值同理：更新数字，重算 `{precision, recall}` 的指纹写进 `thresholds_sha256`，
   并填 `ratified_by` / `ratified_at`。

**没做这一步时 `pnpm gate:ci` 是红的——这是对的。** 红的原因是
"确认过期了"，而修法是重新确认，不是把闸门调松。

**4. 闸门里有一条与分数无关的检查（`E4`）。**
"把实现换成永远返回空的那个，它还会及格吗"——阈值可以被慢慢调松、
runner 可以被改得永远算满分，而这两种改动都会让"分数够不够"继续绿。
`E4` 直接问尺子还分不分得开活的和死的。**退出条件不该只被验证一次。**

## 怎么加东西

**加一条用例**：在 `cases.json` 的 `cases` 数组里加一项，必须带 `span`（能解析到仓库里的原文）
与 `why`（一句话说清为什么是这个类型）。加完 `E2` 会自动变红——因为确认记的是**内容指纹**，
**新判据需要重新确认**。这是有意的摩擦。

**加一个实现**：在 `evals/extractors/` 写一个满足 `Extractor` 的对象，
然后在 `runner/run.ts` 的 `EXTRACTORS` 表里加一行。Phase 4 的模型实现就是从这条缝进来的
（`model-replay`）——**不改 runner，不改尺子**。这是 Phase 3 存在的全部意义：
模型是可替换的，尺子不是。

**改阈值**：改 `thresholds.json` 的数字，`E6` 会自动变红，重算指纹并重新填
`ratified_by` / `ratified_at`。一个没人重新批准的阈值，比一个旧的阈值更危险——
它看起来像有人还在盯着。

## Phase 4 · 模型路径怎么量（S17 的基准报告）

### 当前状态：**未量过**（如实记账，不是"效果不错"）

本仓库**没有 API key**，所以模型路径**没有在真实模型上跑过**。这里给的是
"要量什么、怎么量、什么算达标"，加上现在就能测的那部分证据。
**没有任何一句关于"模型抽得准不准"的结论**——那需要一个真实运行。

为什么不用一份手写的合成录像去凑一组分数：手写的回答可以逐条贴合 20 条 golden 用例，
那测出来的是"出题人也会答题"。而那个数字一旦写进这里，它就会变成后续所有讨论的前提，
且没有人能从它看出它来自一份手写的录像。**那是"让模型给自己发合格证"的另一种写法**
（ADR-0024）。

### 现在就能测的部分（已经测了）

| 性质 | 在哪 | 状态 |
|---|---|---|
| 管道是确定的：同一份录像跑两次，候选区字节相同 | `apps/cli/test/extract.test.ts` | ✅ |
| 编造的出处被丢掉、真的留下 | 同上 + `packages/core/test/model.test.ts` | ✅ |
| 模型产出进不了 `assets/`（含守卫被改松时的变异用例） | `packages/core/test/guard.test.ts` | ✅ |
| 信任边界在**敌意模型**上连着（`E7`，每次 CI） | `evals/runner/trust.test.ts` | ✅ |
| 词法基线在同一把尺子上的分数 | 上表（0.882，不需要 key） | ✅ |
| **模型在真实来源上的精确率/召回率** | —— | ⛔ **没有数据** |

### 一条命令拿到第一份真实报告

```bash
# 1. 录一段真实模型的回答（需要 key；这一步之后再也不需要它）
FORGE_API_KEY=... node apps/cli/src/main.ts extract \
    --vault <库> --record evals/fixtures/cassette-<模型>-<日期>.json \
    --model <模型名> --endpoint <OpenAI 兼容端点>

# 2. 对着录像量（不需要 key，结果可复现）
FORGE_CASSETTE=evals/fixtures/cassette-<模型>-<日期>.json \
    node evals/runner/main.ts --extractor model-replay
```

同一个 harness 版本下换模型、或者同一个模型下换 harness，两次分数**可比**——
因为录像的键是提示词的指纹，输入没变则问的是同一批问题（ADR-0021）。

### 什么算达标

**与 Phase 3 同一套，不另立标准**：`evals/thresholds.json` 的阈值 + `E2`/`E6` 的人工确认。
当前阈值 0.700 / 0.700 是**地板**——它回答"这个实现是不是坏掉了"。
拿到第一份真实报告之后要做的第一件事，是判断那个地板还合不合适，
而不是"超过了就行了"。

### 一条纪律（implement2.md S17）

**够不上阈值就调 harness，不是换模型。** 分块、受控词表、提示词——
`EXTRACTION_HARNESS`（`packages/core/src/model.ts`）就是为此存在的：
改提示词、改词表、改分块都要动那个字符串，于是"这个分数是哪个 harness 抽出来的"
永远有答案。换模型便宜到不构成诱惑（`Model` 只有两个成员），
所以调 harness 才是唯一划算的动作——**这是设计出来的，不是靠自觉**。

## Phase 5 · 冲突这把尺子怎么量（S18–S20）

### 它量什么

一组合成的"新旧状态矛盾"（`evals/golden/conflict/cases.json`，9 条），
判定跑完整条真实路径（`judgeConflicts` → `writeConflicts`，落进一个**内存队列**），然后问三件事：

| 判据 | 它防的是 | 码 |
|---|---|---|
| **该进队列的 100% 进队列** | 判据被改窄、某个 early return 吃掉了整批 | `E8` |
| **每条的证据都指向它声称的那句话** | 引错位置、两侧证据写反了——**看起来完全正常**的那种错 | `E8` |
| **零条被自动应用**（判定模块没有 IO，资产侧没变） | "低风险的那一档就自动刷新吧"那个口子 | `E9` |

第三条分两半量：**判定模块有没有 IO 的能力**（扫源码文本——"这次没写盘"不等于
"没有写盘的能力"），以及**走完"判定 → 落队列"之后资产侧变没变**。
这是 implement2.md 给 P5 写的那条 CI 强制项（四个字：**无自动覆盖**）。

### 现在实测到的数字

| 实现 | 期望进队列 | 实际进队列 | 证据逐条核对 | 资产侧改动 | 判定模块 IO |
|---|---|---|---|---|---|
| 真实判定（`judgeConflicts`） | 6 | 6 | 6 条候选两侧全核 | 0 | 0 |
| 变异：模型能一票否决 | 6 | 0 | —— | —— | —— |
| 变异：落盘时顺手应用 | 6 | 6 | —— | **被改动**（`E9` 报红） | —— |

后两行是 `evals/runner/conflict.test.ts` 里的**变异用例**：把某条性质故意弄坏，
探针必须报红。只会变绿的检查不是检查（R8）。

### 它**不**量什么（如实记账）

- **抽取质量**（那是 extraction 那把尺子的事）；
- **"语义上矛盾但字面上不同"的对子**（"存储层是 SQLite" vs "我们不再用嵌入式数据库了"）：
  规则查不到，只能靠模型提议碰上。已知缺口，写在 `docs/handbook/conflicts.md`；
- **同义题面**（「索引层的存储后端」vs「存储后端选型」）：是两个实体，
  它们之间的矛盾不会被报出来。这条同样是 ADR-0026 里写明的残余风险。

### 怎么加一条用例

在 `cases.json` 的 `cases` 数组里加一项，两侧的 `sources` 必须是**能解析到
`evals/fixtures/conflict-scenarios.md` 里那句话**的 span——探针会去核对
"锚点是不是就指向它声称的那句话"。加完 `E2` 会自动变红：确认记的是**内容指纹**。

判据只有一条但很硬：**锚点必须指向这一侧声称的那句话**。只"解析得到"不够——
引错位置与编造出处，在报告里长得一模一样。

### 怎么跑

```bash
node evals/runner/main.ts                      # 抽取那把尺子（顺带跑一次冲突探针，报告里能看到）
node scripts/gates/evals.mjs                   # 闸门怎么判（E1–E9）
node --test evals/runner/conflict.test.ts      # 探针的自证（四条变异）
```

## Phase 7 · 维护机器怎么量（S25–S28）

implement2.md 给 P7 写的 CI 强制项是 **审计完整性**。它和另外两条一起，
由 `evals/runner/maintenance.ts` 每次 CI 都量一遍（`E12`–`E14`）。

### 实测读数（复现：`node evals/runner/main.ts`）

| 探针 | 读数 |
|---|---|
| 审计：真的写入路径 | 来源导入 1 次 + 候选确认 1 次 + 重新确认 1 次 → **3 条**（`source-imported` / `asset-promoted` / `state-confirmed`），行数 = 条目数 |
| 审计：三种破坏 | **3/3 被抓住**（删一行 → 缺号；改内容 → 哈希对不上；换顺序 → 断链） |
| 审计：写门的强制 | 不给见证人直接写资产 → **被拒绝**（运行时，不只看类型）；有人直接往 `assets/` 放文件 → **被看见**（`AUDIT_UNATTRIBUTED_ASSET`） |
| 健康检查：语料 | **11 组**：干净的那组 **0 条发现**；该报没报 0 处；不该报却报了 0 处 |
| 健康检查：只读与可重印 | 拿本仓库自己的 **38 条资产**跑一遍：仓库字节不变 · 两次报告逐字节相同 |
| 规模 | **1002 条**语料 · 两次字节相同 · 埋在里面的 1 处腐烂**被找到** · 孤儿 0 条（`event` 不参与孤儿判定） |

### 这些数字**不**说明什么

- "3/3 破坏被抓住"不等于"审计不可绕过"。**直接改文件系统**永远绕得过它——
  审计做的是让那种写入在下一次健康检查里被看见，不是阻止它。
- "1002 条仍然确定"不等于"库仍然可用"。P7 的退出条件是关于**人**的判据，
  README 里那一行会一直写着"未达成"。探针证明的是它的地基（ADR-0038）。
- "干净语料 0 条发现"只说明**这一组**干净语料不产生噪音。
  真实库的形状（同一题面几十条、来源上千份）不在覆盖里。

### 变异验证（探针自己也得能被判红）

每条探针都配了变异用例（`evals/runner/gate.test.ts`）：把探针结果里对应的字段
翻成红的，`evaluateEvalGate` 必须报出那个码。只会变绿的检查不是检查。

```bash
node evals/runner/main.ts                    # 三把尺子 + 三个探针的读数（顺带 3 个维护探针）
node --test evals/runner/gate.test.ts        # 闸门判定 + 每条探针的变异用例
node --test evals/regressions/regressions.test.ts   # 回归集今天还成立吗
```

## 与闸门的关系

| 层 | 在哪 | 判什么 |
|---|---|---|
| 打分 | `packages/core/src/evaluation.ts`（纯函数） | 精确率 / 召回率 / F1 |
| 信任边界（判定） | `packages/core/src/extract.ts` 的 `judgeCandidates` | 候选引用的每一处必须是它这次真的看见过的 |
| 信任边界（执行） | `packages/core/src/model.ts` 的 `sanitizeCandidates`、`guard.ts` 的 `guardCandidates` | 重建出处、压置信度、丢弃编造内容；模型产出永不进 `assets/` |
| 信任边界（探针） | `evals/extractors/hostile.ts` + `evals/runner/trust.ts` | 拿一台敌意模型走完整路径，四条性质一起看 |
| 归并（判定） | `packages/core/src/link.ts` 的 `linkCandidates` | 同证据 / 同题面 → 链接；模型只能提议（`proposedMergesApplied` 自证） |
| 冲突（判定） | `packages/core/src/conflict.ts` 的 `detectConflicts` / `judgeConflicts` | 同题面 + 内容不同 → 冲突候选；归一化相等 → 再确认；证据两侧齐全可解析 |
| 冲突（落盘） | `packages/store/src/conflicts.ts` + `vault.resolveConflict` | 队列的读写；**唯一**能改写已有状态的地方（只由人触发） |
| 冲突（探针） | `evals/runner/conflict.ts` | 合成集 100% 进队列、证据逐条核对、判定模块零 IO、资产侧零改动 |
| 取用（判定） | `packages/core/src/retrieve.ts` 的 `retrieve` / `retrievalViolations` | 词法打分 × 类型权重；预算硬上限；分数为 0 的一条都不注入；过期的不当现状 |
| 取用（探针） | `evals/runner/retrieval.ts` | 拿**本仓库自己的 29 条资产**当语料：预算不超、没有预加载、尺子没瞎 |
| 闸门判定 | `evals/runner/gate.ts`（纯函数） | 十四条：`E1`–`E14` |
| 宿主 | `scripts/gates/evals.mjs`（受保护路径，薄壳） | 读依赖、跑 runner、打印、设退出码 |

判定住在 `evals/` 而不是闸门脚本里的理由，写在 ADR-0020 里：**"闸门第一次运行"
不该发生在它生效的那一刻**——判定住在不受保护的地方，才能在落盘之前被测试。
`E7` 是这条理由的第二次兑现：它连同**两条变异用例**（把 sanitize 换成什么都不裁的、
把守卫换成什么都放行的，探针必须报红）一起住在 `evals/runner/trust.test.ts`。
