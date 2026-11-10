# 0001 · 可信判定只覆盖了 `ci.mjs` 的第 1、2 步，没覆盖第 3 步

> 发现于 Phase 3 写 `scripts/gates/evals.mjs` 的时候。
> 发现方式：要接一个新的子闸门，于是去读"子闸门是怎么被调起来的"——
> 读到的路径与 bypass-matrix 6.3/6.4 的描述对不上。

## 当初以为是什么

`docs/gates/bypass-matrix.md` 在 6.3 / 6.4 的"缓解"一栏写着：

> 修法（把判定也在基线修订里跑一遍）已经有了——`gate:trusted` 会把基线修订的
> 闸门代码 checkout 到临时 worktree 再判定，所以"改松判定"过不了服务端。

也就是说：**"判定逻辑住在不受保护的文件里"这个结构问题已经被 ADR-0005 解决了。**

## 实际是什么

只解决了一半。

`scripts/gates/trusted-ci.mjs` 确实把**基线修订**的 `scripts/gates/ci.mjs`
checkout 到临时 worktree 并执行它，cwd 指向当前工作树。而 `ci.mjs` 做四件事：

| 步骤 | 判定代码来自 | 被检查者改得到吗 |
|---|---|---|
| 1. 变更集判定（`lib/policy.mjs`） | **基线修订**（import 相对脚本自身解析） | 否 ✅ |
| 2. harness 完整性（`lib/harness.mjs`） | **基线修订** | 否 ✅ |
| 3. 子闸门（`consistency.mjs` / `assets.mjs` / `evals.mjs`） | **当前工作树** | **是** ❌ |

第 3 步的那行是：

```js
spawnSync("node", [`scripts/gates/${script}`], { cwd: root, ... })
```

`root` 是 `repoRoot()`，即**当前工作树**。而且子闸门自己又用
`pathToFileURL(join(root, "packages/core/src/index.ts"))` 去 import 判定模块——
`root` 同样是工作树。

**结论**：把 `packages/core/src/asset.ts` 的 `judgeAsset` 改成永远返回 `[]`，
或者把 `evals/runner/run.ts` 改成永远返回满分报告，**第 3 步会开开心心地报绿**。
`packages/*` 与 `evals/*` 都不在受保护路径里，所以这在规则上只需要一条 ADR，
在机器上则没有人拦。

（`packages/schema` 与 `schema/` 受 R2 约束，但 `packages/core` 与 `packages/store` 不受。
所以受保护的恰好不是"判定住在哪儿"，而是"分类法住在哪儿"。）

## 怎么复现

```bash
# 1. 在任一分支上把资产审核的判定改成永远放行
#    （改 packages/core/src/asset.ts 的 judgeLibrary，直接 return []）
# 2. 造一条没有出处的资产，确认本地 assets.mjs 不再报红
node scripts/gates/assets.mjs          # 期望：红
# 3. 跑可信判定
pnpm gate:trusted                      # 实际：第 3 步放行
```

第 1、2 步仍然会拦住它：改动 `packages/core` 本身不需要 ADR，所以真要"放水"，
得先有一条 ADR（`R2_PROTECTED_WITHOUT_ADR` 只在改动**受保护路径**时才触发——
而这里改的不是）。这条绕法因此是"需要一条 ADR 的放水"，与 3.3 同类。

## 留下了什么

1. **`docs/gates/bypass-matrix.md` 里的过度承诺被删掉了**，改写为「6.10 的准确描述」。
   一份把缓解写得比现实强的清单，比没有那份清单更危险——它会让人停止追问。
2. **本条记录**（R7 的那个"回归用例"位）。它现在**可自动执行**：
   `regressions.test.ts` 的 0001 断言子闸门代码仍取自基线、
   数据仍取自工作树；删掉 ADR-0043 的修复，这条会红。
3. **ADR-0043**：判定代码根与数据根分离，由 `trusted-ci.mjs` 传入
   `FORGE_JUDGE_ROOT` / `FORGE_JUDGE_DATA_ROOT`。

## 后来怎么修好的

真正的修法是"让第 3 步的判定也来自基线修订"，但**不重新安装依赖**：

- `trusted-ci.mjs` 建立基线 worktree 后，把工作树的 `node_modules` 用
  junction/symlink 接进去；
- 基线 `ci.mjs` 从 `FORGE_JUDGE_ROOT` 启动子闸门，并把
  `FORGE_JUDGE_DATA_ROOT`（当前工作树）传下去；
- 子闸门的 import 走 `codeRoot`，读资产 / schema / 黄金集 / 阈值走 `dataRoot`。

代价是基线判定代码与工作树依赖可能来自不同修订（ADR-0043 的残余风险），
而不是每个 PR 重装一遍依赖。修复已经由人落盘；落盘前的验证器
（`handoff/verify-gate610.mjs`）随 `handoff/` 一起删除，它的三步判据
现在由 `regressions.test.ts` 0001 长期执行。

