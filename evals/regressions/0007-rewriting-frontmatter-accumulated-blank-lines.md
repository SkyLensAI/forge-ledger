# 0007 · "只改 last_confirmed"的实现，每改一次正文就多一个空行

> 发现于 Phase 7 写 `forge confirm` 的时候。发现方式：一条测试断言
> "改写之后正文与改写之前逐字节相同"，它红了。

## 当初以为是什么

改写 front-matter 是把整份文件**重新渲染**一遍：`renderAssetDocument(newFront, doc.body)`。
`doc.body` 是从原文件解析出来的正文，它"就是"正文，所以渲染回去应该一样。

而"只动 `last_confirmed`"这句话，当时被理解成"`frontMatter` 里只有那一个字段变了"。

## 实际是什么

**解析出来的 `body` 带着一个前导空行**——front-matter 与正文之间那个空行在
`splitFrontMatter` 里被算进了 body。而 `renderAssetDocument` 在正文之前又补了一个空行。
于是：

```
parse(render(x)) 的 body  = "\n# 标题…"
render(那个 body)         = "---\n…\n---\n\n\n# 标题…"
```

每改写一次，正文前面就多一个换行。它不报错、不影响阅读、**静默累积**——
而它让"正文一个字节都没动"这句话变成假的。

更要命的是，这条路径**不是 Phase 7 才有的**：`conflicts --resolve` 的
"把旧那一代标成 superseded" 一直走的是 `rewriteFrontMatter`。
也就是说，这个 bug 从 Phase 5 起就在每一个被替换过的状态上发生，只是没人断言过它。

## 为什么测试没抓到

因为原来的测试断言的是**语义**（"status 变成 superseded 了"、"正文里那句话还在"），
而不是**字节**。"正文没变"这件事被当成了"内容没变"的同义词，
而两者在多一个空行的时候是不同的。

## 怎么复现

```bash
# 起一个库、确认一条 state、再 confirm 一次、再 confirm 一次
forge confirm <id> --date 2026-11-20 --note x
forge confirm <id> --date 2026-12-01 --note y
# 然后数正文之前的空行：每次改写多一个
```

## 留下了什么

1. `replaceFrontMatter(raw, frontMatter)`（`packages/store/src/assets.ts`）：
   改写**在原文上做手术**——把正文前后的字节原样保留，只换 front-matter 那一段。
   "重新渲染一遍"与"只换那一段"的区别，正好是"内容没变"与"字节没变"的区别。
2. `unchangedExceptLastConfirmed`（`packages/core/src/asset.ts`）：
   "只动一个字段"从一句注释变成一个能被重新问一遍的函数；写别的东西就拒绝落盘。
3. 一条测试，断言的正是**字节**：
   - 解析 → 只换 front-matter → 再解析，`body` 必须逐字节相同；
   - 改两次的结果必须与改一次相同（**换行不许累积**）。
4. `forge confirm` 的测试同时断言正文、出处、题面三样都没变。
