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
2. **本条记录**（R7 的那个"回归用例"位）。它现在还不是可自动执行的用例，见本目录 README。

## 还没做什么（明确记账）

真正的修法是"让第 3 步的判定也来自基线修订"。代价很直接：
子闸门要 `yaml` / `zod` 才能跑，所以临时 worktree 里得装一遍依赖——
CI 时长与复杂度都上一个台阶，而 Phase 3 的退出条件不需要它。

**这是一个值得单独决策的改动，不该混在 Phase 3 里顺手做掉**（ADR-0004 的同一条理由：
在需求出现之前先把东西建出来，制造的是需要维护的空壳）。
它现在的状态是：**已知、成文、可复现、未修**。
