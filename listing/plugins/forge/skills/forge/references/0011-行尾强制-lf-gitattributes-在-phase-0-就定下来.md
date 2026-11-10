# 行尾强制 LF（.gitattributes），在 Phase 0 就定下来

> 决策 `dec_01M6QE3MZCXNVVEHFZ5Q2F198J` · accepted · 2026-11-06 · 最后确认 2026-11-06
>
> 出处：
> - `file://docs/directory.md#t:每个出口一个文件，输出必须`
> - `file://docs/implement2.md#t:输出必须逐字节确定`

# 行尾强制 LF（.gitattributes），在 Phase 0 就定下来

## 问题

Phase 2 的退出条件是"两次运行产出**逐字节相同**的 `AGENTS.md`"（emit 快照测试）。而开发机是 Windows、CI 是 Linux。如果行尾随平台漂移，快照测试会在 CI 上以最难读的方式失败——而且失败原因看起来和"编译逻辑"毫无关系。

## 考虑过的选项

1. **等 Phase 2 遇到问题再修**。届时已经有若干快照基线，重写基线的同时还要判断"哪次差异是真实的行为变化"，成本高且容易掩盖真问题。
2. **现在就把 `.gitattributes` 定死为 `* text=auto eol=lf`**，并关掉本机的 `core.autocrlf`。

## 选定

**选 2。**

这与 Phase 0 的排序原则一致：**回填不了的东西先做**。行尾不是"配置细节"，它是"确定性输出"这条产品承诺的地基——而地基类决定事后重建的代价最高。

## 后果

- **好**：`emit` 的字节级快照从第一次提交起就是跨平台稳定的。
- **好**：二进制文件显式标记为 binary，避免 git 试图做文本转换。
- **代价**：Windows 上的编辑器若强行写 CRLF，diff 会出现噪音；依赖编辑器遵守 `.gitattributes`（主流编辑器都遵守）。
- **注意**：本机 `core.autocrlf` 已设为 `false`，与 `eol=lf` 配合。
