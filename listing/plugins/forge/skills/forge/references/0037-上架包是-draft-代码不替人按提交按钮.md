# 上架包是 draft，代码不替人按提交按钮

> 决策 `dec_06GV1Q7H3K5NDZ1RE0EXTCHB9H` · accepted · 2026-11-06 · 最后确认 2026-11-06
>
> 出处：
> - `file://docs/implement2.md#t:上架路径：Skill/MCP 提交，借平台分发与已承诺预算结算`
> - `file://packages/core/src/distribution.ts#t:status: "draft"`
> - `file://packages/core/src/distribution.ts#t:published: false`
> - `file://packages/core/src/distribution.ts#t:直接复用 `emitSkill`：Skill 出口只有一个真相`
> - `file://packages/core/src/distribution.ts#t:上架需要人：账号、仓库 URL、一个真正可安装的`

# 上架包是 draft，代码不替人按提交按钮

## 问题

implement2.md 给 S31 写的是"上架路径"，交付物是"市场条目"。这半句话里
藏着一个容易做错的区分：

- **生成一份条目**是代码能做的；
- **提交、审核、上架**是代码不能做的：需要账号、仓库 URL、一个真正可安装的
  包、平台审核，以及有人对隐私与支持渠道负责。

如果把两者混成"跑一条命令就上架了"，产物会自称 `published`，
而下一个人会以为最花时间的那一步已经完成。这正是本仓库反复记账的那类失败
（`evals/regressions/0003` / `0005`）：一份说"已经完成"的文档，比一份说"还没做"的
文档更危险。

## 考虑过的选项

1. **完成平台提交，把"上架成功"写进 README。** 否决。这需要本仓库之外的
   账号与审核，agent 做不了；写出来就是编造。
2. **手写一份 `plugin.json` / `marketplace.json` 提交进仓库。** 否决。手写清单
   会和资产库漂移，而对外清单是最不该有第二份真相的地方。
3. **用同一批资产生成一份可提交的 draft 包，并把未完成项列成人的清单。** 采纳。

## 选定

- `forge listing --out <目录>` 生成：
  - `.claude-plugin/marketplace.json`（市场条目）
  - `plugins/<name>/.claude-plugin/plugin.json`（插件清单）
  - `plugins/<name>/.mcp.json`（MCP 配置）
  - `plugins/<name>/skills/<name>/SKILL.md` + `references/`
  - `manifest.json`（`status: "draft"`、`published: false`、计数与未完成项）
  - `README.md` / `SUBMISSION.md`（人怎么把它变成已上架）
- Skill 出口**直接复用 `emitSkill`**：上架包只是换了一个路径前缀，
  不在分发路径上再写一份渲染器。渲染器有两份，`SKILL.md` 与 `references/`
  就会在某个边界用例上悄悄分叉。
- MCP 配置在 `.mcp.json` 与 plugin 清单里各出现一次，但由**同一个对象**生成，
  所以它们不会漂移；手工维护两份才会。
- 产物逐字节确定：没有时间戳、没有随机、JSON 走 `stableJson`、路径排序显式。
- **不编造** repository / homepage / author。生成器没有这些输入，就先留空；
  `SUBMISSION.md` 把它们列为必须由人完成的项。
- 版本默认 `0.0.0`。它不是一次已发布的版本号，只是"尚未发布"的诚实写法。

## 后果

- **好**：S31 的交付物从一句"我们会提交"变成一份可提交、可 diff、可重生成的
  草稿；`forge bootstrap` 与 `E15` 会检查它与库是否逐字节一致。
- **好**：`published: false` 是结构性的，不是一句提醒。想把它改成 `true`，
  必须有人改 `manifest.json` 并留下上架证据；代码不会替人改。
- **代价**：生成器不能替人完成真正花时间的那部分：把 `@forge/mcp` 发布成
  可安装的包、填仓库元数据、过平台审核。`SUBMISSION.md` 把它们写得很清楚。
- **残余风险**：平台条目格式会变。`marketplace.json` 与 `plugin.json` 的形状
  绑定当前约定；格式变化时，`forge listing` 需要跟着改，而 `E15` 只能保证
  "本仓库内部的产物与库一致"，保证不了"平台仍然接受这个形状"。
