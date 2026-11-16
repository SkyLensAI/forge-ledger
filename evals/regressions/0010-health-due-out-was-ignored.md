# 0010 · `health --due --out` 根本没写文件

> 发现于实现 docs/automation.md 的生成流水线时。发现方式：把生成的 `pipeline.sh`
> 对着一个临时库真跑一遍，命令都成功了，`reports/due.md` 却不存在。

## 当初以为是什么

文档里写的定时任务是：

```bash
forge health --today "$(date +%F)" --due --out reports/due.md
```

`--out` 在 `health` 的用法里一直写着“把报告写到文件”。`--due` 是同一个命令的开关，
所以“`--due --out` 写出当天的到期清单”被当成了既有行为——生成器直接把它写进了流水线。

## 实际是什么

`runHealthCommand` 的 `--due` 分支在解析完参数后**直接 return**，根本没有看 `args.out`：

```ts
if (args.due) {
  out("…");
  return 1;
}
```

于是 `--out` 被静默忽略。退出码仍然是对的（有到期项 → 1），所以只看退出码的
定时任务不会发现异常；但“通知 + 一键确认”这条链路里的**通知内容**从来没落地。
这个失败比崩溃安静：流水线退出 0、cron 不报错、报告目录里少一个文件。

## 怎么复现

```bash
forge health --vault /tmp/empty-vault --today 2026-11-12 --due --out /tmp/due.md
test -f /tmp/due.md && echo written || echo missing   # 修复前：missing
```

## 留下了什么

1. `--due` 与 `--out` 同给时，把同一份正文写进文件；`stdout` 只留空。
2. **没有到期项也要写**：留着一份昨天的 `due.md` 比没有文件更容易骗人。
   文件里明确写“没有到期的 state（基准日 …）”。
3. `evals/regressions/regressions.test.ts` 的 0010 每次 CI 都跑一遍真实子进程，
   断言文件真的出现、正文对、`stdout` 为空。
4. `apps/cli/test/maintenance.test.ts` 另有一条带到期项的用例，钉住“过期状态会进文件”
   以及“没有到期项时覆盖旧文件”。
5. 生成流水线 `forge automate --out` 现在真的会产出 `reports/due.md`；
   `pipeline.sh` / `pipeline.ps1` 的 `health --due` 一行不再是一句空承诺。

**教训**：文档里的示例命令必须跑一遍再写进生成器。
“参数存在”不等于“参数被读”；只对退出码的检查不会发现这种沉默的缺失。
