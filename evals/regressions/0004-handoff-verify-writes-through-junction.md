# 0004 · `--verify` 会把载荷**写进工作区**——通过 junction

> 发现于 Phase 5 准备 `handoff/` 第二批的时候。
> 发现方式：这批载荷跨 `schema/` 与 `packages/` 两个顶层目录，
> 而上一批只有一个（`schema/provenance.md`）——写多目录的舞台时踩到的。

## 当初以为是什么

`node handoff/apply.mjs --verify` 是"在临时目录里把载荷跑一遍（**不碰工作区**）"。
`handoff/README.md` 和脚本头部的注释都这么写着，而上一批跑过一次、看起来没问题。

## 实际是什么

**它会写工作区，而且写的是受保护路径。**

舞台里有两种东西：真副本（载荷覆盖的那几个文件）与 junction（其余一律接回工作区）。
上一批只有 `schema/` 一个顶层目录，所以脚本把"载荷所在的顶层目录"整个复制成真副本，
其余目录 junction 回去——能跑。

这批多了一个 `packages/`。第一版的处理是"载荷涉及的顶层目录**不** junction"，
听起来对，实际漏了：`packages/` 只是在**外层循环**里被跳过，
可脚本随后要往 `stage/packages/schema/src/` 写载荷，而那个目录**不存在**——
于是它先 `copyTree` 一份，再写。看起来也没问题。

真正的问题是**顺序**。`link()` 用的是 `symlinkSync(..., "junction")`，而 junction 是
**双向**的：如果 `packages` 先被接成 junction（在"哪些顶端目录是载荷的"这个判断
出错时就会发生——把两个载荷目录写成两个不同的顶层目录不总会走到同一个分支），
那么 `stage/packages/schema/src/fields.ts` 指向的就是
`<工作区>/packages/schema/src/fields.ts`——**载荷会直接落到工作区里**。
一次本意"不碰工作区"的演练，会变成一次**静默的、针对受保护路径的落盘**，
而且它是"成功"退出的。

第二条同样致命、同时也是最先撞上的：`copyTree` 跳过 `node_modules`，
而 pnpm 把每个包**自己的**依赖放在 `packages/<包>/node_modules/` 下。
整棵复制 `packages/` 之后，载荷版的 `assets.ts` 一加载就报"找不到 zod"——
看起来像闸门坏了，实际是舞台搭错了。

## 怎么复现

```bash
# 分母是"载荷跨了几个顶层目录"——单目录时看不出问题，多目录时才会撞上
node -e '…造一份 targets 跨 schema/ 与 packages/ 的清单…'
node handoff/apply.mjs --verify
git diff --stat schema/ packages/schema/    # 修复前：这里会有改动
```

## 留下了什么

1. **搭法改成"只复制通往载荷的那条路"**（`handoff/apply.mjs` 的 `overlay`）：
   载荷文件所在的每一层目录是真副本，**兄弟目录与 `node_modules` 一律 junction**。
   判据只有一条：**载荷文件所在的目录必须是真副本，其余必须是同一份。**
   于是"我测的到底是哪一份"在舞台里仍然只有一个答案，而 junction 不再有机会被写。
2. **载荷覆盖的顶层目录改成集合**（`payloadTopDirs`），并且**逐个目录判定**：
   不再依赖"第一个条目在哪个顶层目录"。
3. **演练加了一条判据**：三条场景之外，脚本自己的注释里写明了这条陷阱
   （`overlay` 的 doc comment），因为下一个人会先读那段注释，而不是先读这份记录。
4. **本记录**（R7 的那个"回归用例"位）。

## 还没做什么（明确记账）

**这条性质没有进 CI。** `handoff/` 不属于仓库（untracked，用完即删），
所以它的 bug 无法被 `pnpm test` 拦住——CI 上根本看不到这个目录。
这类"一次性工具"的纪律只能靠两件事：**它每次都被演练**（`--verify` 是标准动作，
`handoff/README.md` 的六步里排第二），以及**它的危险动作只有一条**
（默认 dry-run，只有 `--yes` 才写）。这与 `evals/regressions/0003` 结尾那段是同一个判断：
真正的修法是让这类产物根本不需要人记着删，而那要等它出现第三次。
