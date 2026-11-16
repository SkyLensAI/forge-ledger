# 0006 · 审计日志写下去的那一刻，它已经"被改过"了

> 发现于 Phase 7 的第一次冒烟（S27）。发现方式：用 CLI 跑一遍 `compile`，
> 然后 `forge audit --verify`。

## 当初以为是什么

审计的哈希链是"写一条、验一条"的两行代码：把条目的字段排好序、算 sha256、
存进 `hash`。测试里也是这么构造的，所以它看起来**在结构上不可能错**。

## 实际是什么

这里连着踩了两个坑，而且第二个只有在第一个修好之后才露出来。

**坑一：日志不是 JSONL。** 条目用 `stableJson`（两空格缩进）序列化，
只去掉了末尾换行。于是每条记录占**十几行**，而读取端按行解析——
`audit.jsonl 第 1 行读不动：不是合法 JSON` 出现了十几次。
写入端看起来完全正常：文件写好了、字节也在，只是**格式的名字说了谎**。

**坑二：哈希包含了自己。** 修好换行之后，每一条刚写下的记录立刻被判成
`内容被改过`。原因是把 `hash` 也算进了被哈希的字节——而写下去的时候
`hash` 是空串，读回来的时候它是真的哈希。**一个哈希不能包含它自己**，
这是定义，不是约定。

两个坑都在"健康检查"里被发现了，但发现的方式很值得记：
第一版的健康检查把一条正常的日志报成了 14 处 `HEALTH_AUDIT_CHAIN_BROKEN`。
如果当时图省事把健康检查改松（"读不动的行跳过就行了"），
第二个坑就永远不会露出来——**一个报得太吵的检查，最容易被修成"不报"**。

## 怎么复现

```bash
rm -rf /tmp/v && node apps/cli/src/main.ts compile --vault /tmp/v \
  --import evals/fixtures/desensitized-export.json
node apps/cli/src/main.ts audit --vault /tmp/v --verify
```

坑一：`audit/audit.jsonl` 里的一条记录占多行，`audit` 列出时会报"第 N 行读不动"。
坑二：`--verify` 报 `seq 1 的内容与它自己的 hash 对不上`。

## 留下了什么

1. `stableJsonLine`（`packages/core/src/json.ts`）：单行、键排序、无尾换行。
   它与缩进版**同时存在**，因为两者的用途不同——一份给人读，一份给机器按行读。
2. `hashAuditEntry` 覆盖"除 `hash` 以外的全部字段"，这件事写成了一个函数
   （`auditBodyJson`），而不是散在注释里。
3. 两条测试（`packages/core/test/audit.test.ts`）：
   - "条目是**一行**：JSONL 的名字就是它的契约"
   - "哈希**不包含它自己**：刚写下的条目必须立刻验得过"
4. 探针（`evals/runner/maintenance.ts`）每次 CI 都走一遍真的写入路径，
   然后断言"行数 = 条目数"——坑一不可能再回来。
5. **一条纪律**：`forge audit --verify` 在**刚写完之后**必须返回 0。
   它是审计的"干净对照"，写进了 `apps/cli/test/maintenance.test.ts`。
