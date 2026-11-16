# Handbook · 自举、团队版与上架（Phase 8）

Phase 8 加了三样东西，它们都遵守同一条规矩：**产物必须能从库重算**。

| 命令 | 交付物 | 什么时候跑 |
|---|---|---|
| `forge bootstrap` | 一份自举报告（ADR / 规则 / 尺子 / 产物 / 团队版） | 每次改完资产或对外产物 |
| `forge listing --repo --out listing` | 上架包（marketplace / plugin / Skill / MCP） | 资产变了之后重新生成 |
| `forge demo --repo --out demo` | 静态演示站（自己的库） | 同上 |

正确顺序是：**先修库，再重新生成产物，最后跑 bootstrap**。
`bootstrap` 会把 `listing/` 与 `demo/` 和库逐字节比对；产物落后于库就会红。

每个产物目录里有一份 `.forge-manifest.json`，记录"这一轮生成器写了哪些文件"。
重新生成时只清理**上一份清单里列过、这一轮没有**的文件——目录里人放的东西
（`CNAME`、`LICENSE`）不在清单里，所以永远不会被删。清单读不懂时同样不删：
宁可留下残留，也不误删。`E15` 会把清单之外的残留文件也算作漂移。

```bash
pnpm bootstrap                  # 或 node apps/cli/src/main.ts bootstrap
pnpm listing                    # 重新生成上架包
pnpm demo                       # 重新生成演示站
node apps/cli/src/main.ts listing --repo --out listing --check   # 只比对
node apps/cli/src/main.ts demo --repo --out demo --check         # 只比对
```

## 1. 自举（S29）

`forge bootstrap` 判六件事：

1. `docs/adr/` 下的 `decision` 资产 ≥ **30** 条（implement2.md S29 的量级）；
2. 仓库里所有带 front-matter 的资产都能被 `judgeLibrary` 审过（出处可解析、必填字段齐全）；
3. `AGENTS.md` 的种子规则 ≤ 8 条，而且每条都有 `出处`；
4. 两把尺子（extraction / conflict）的 `review.status` 都是 `confirmed`，阈值有 `ratified_by`；
5. `listing/` 与 `demo/` 与库逐字节一致；
6. 团队版没有在没信号的时候先长出来（见下一节）。

退出码：`0` 全绿，`1` 有具体问题，`2` 用法错误。
**红了修问题**：补真实 ADR、补出处、重新生成产物；不要调松判据——
判据同时被 `E15` / `E16` 在每次 CI 里使用。

> 数量是**决策日志被用起来**的痕迹，不是目标本身。
> 30 条是底线，不是奖励；一条格式正确但内容空洞的 ADR，这条命令拦不住。

## 2. 团队版（S30）—— 现在不该存在

implement2.md 的原话是"团队版**只在出现付费信号后**做"。所以今天：

- 没有任何团队功能代码；
- `docs/team/status.json` 记录 `payment_signal: null` 与三项能力全 `false`；
- `forge bootstrap` 报告 `团队版：deferred`；
- 如果有人在没有信号时把任何一项能力改成 `true`，`forge bootstrap` 与 `E16` 会红。

三项能力对应单人模式的三个缺失项：

| 能力 | 含义 | 今天 |
|---|---|---|
| `permissions` | 谁能读 / 写哪条资产 | 没做 |
| `concurrency` | 多进程 / 多人同时写同一库 | 没做（审计只报冲突，不加锁） |
| `sensitivity` | 按 `public` / `internal` / `private` 做分发与访问控制 | 字段有，隔离没做 |

**由人**提供付费信号时，修改 `docs/team/status.json`：

```json
{
  "schema_version": 1,
  "payment_signal": "PO-2026-001",
  "capabilities": {
    "permissions": false,
    "concurrency": false,
    "sensitivity": false
  }
}
```

然后 `forge bootstrap` 会从 `deferred` 变成 `partial`（缺三项能力）。
三项都实现并打开之后才是 `ready`。代码证明不了这个信号是真的；
它只负责让"先做了"不能悄悄变成"已就绪"。

## 3. 上架（S31）—— 产物永远是 draft

`forge listing` 从**同一批资产**生成：

```
listing/
├── .claude-plugin/marketplace.json
├── plugins/forge/
│   ├── .claude-plugin/plugin.json
│   ├── .mcp.json
│   └── skills/forge/
│       ├── SKILL.md
│       └── references/...
├── manifest.json          # status: draft, published: false
├── README.md
└── SUBMISSION.md          # 人必须完成的清单
```

`manifest.json` **永远**是 `status: "draft"` / `published: false`。
代码不替人按提交按钮：注册账号、发布 `@forge/mcp`、填写 repository/homepage/author、
通过平台审核，都是 `SUBMISSION.md` 里列给人做的事。

`forge listing` 不编造元数据。没有输入就先留空，而不是写一个看起来像真的 URL。

## 4. 对外 demo（S32）—— 只用自己的库

`forge demo` 的输入只有资产（`--repo` 时是仓库自己的 ADR / 资产）：

```
demo/
├── index.html
├── assets/<type>/<id>-<slug>.html
├── library.json
└── README.md
```

- 没有样例数据入口；
- 没有外部脚本 / 样式 / 字体，直接打开 `index.html` 即可；
- 所有文本都做 HTML 转义；
- 没有时间戳、没有随机，两次生成逐字节相同；
- `library.json` 的 `source` 写出 `repo` / `vault`，读者不用猜。

页面比手写 demo 朴素，这是刻意的取舍：S32 要的是**真实**，不是好看。
复杂 Markdown（比如表格）会原样显示为 `pre`，而不是悄悄丢掉。

## 已知边界（写下来，不假装做了）

- 自举命令证明不了 ADR 的**内容质量**，只能证明数量、可读性与出处。
- 团队版的三项能力一行代码都没有；`E16` 只防"没信号却先开"。
- 上架包没有真的提交过。`marketplace.json` / `plugin.json` 的形状绑定当前平台约定，
  平台格式变化时需要跟着改。
- 扩展仍然没有被真的装进浏览器（见 `apps/extension/README.md`）；
  MCP 包仍然是 `private: true`。
