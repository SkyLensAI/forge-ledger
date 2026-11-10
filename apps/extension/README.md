# `apps/extension` —— 浏览器扩展（MV3 · S23）

**只做两件事：取用 + 增量采集。** 这是 implement2.md 给这一期的原话，也是它存在的全部理由。

```
forge serve                    ← 本机桥（127.0.0.1，要 token）
      ▲
      │ HTTP：/selectors · /context · /capture
      │
扩展（这一个目录）  ← 只有 DOM 胶水
      │
      ▼
你正在读的页面
```

## 为什么判定一行都不在扩展里

本仓库是**零构建**的（ADR-0011 靠 Node 的原生类型擦除），而**浏览器执行不了 TypeScript**。
于是扩展没法 import `@forge/core`。面对这个约束只有两条路：

1. 把判定在 JS 里抄一份 → 从此有两份实现，而漂移的方向永远是**浏览器那份更宽松**；
2. **把判定挪到桥这一侧** → 扩展只做"读 DOM、发请求"。

选 2。所以：

| 事 | 住在哪 | 怎么被验证 |
|---|---|---|
| 选择器配置能不能用、该用哪一份 | `packages/core/src/selectors.ts` | `packages/core/test/selectors.test.ts` |
| 这个 URL 归哪个站点管 | 同上（扩展里有一份成文的重复，见下） | 拿一张 URL 表逐条比对两份输出 |
| 一条记录的键是什么、哪些是增量 | 同上 + `packages/store/src/vault.ts` 的 `capture()` | `packages/store/test/capture.test.ts` |
| 采集怎么落成 sources | `packages/store/src/vault.ts` | 同上 |
| **读 DOM、把相对时间折成 ISO** | `src/content.js`（本目录） | ⛔ **没有自动化验证** |

## 那条成文的重复：`src/match.js`

扩展里**唯一**与判定同形的一小段是"最长前缀赢"的站点匹配（`src/match.js`）。
它必须存在（页面侧要知道当前 tab 归谁管），所以处置办法不是假装没有，而是：

- 判据写成最小的那几行；
- `apps/extension/test/extension.test.ts` 拿一张 URL 表，把它的输出与
  `@forge/core` 的 `hostForUrl` **逐条比对**。两份实现漂移的那一刻，测试就红。

## 选择器配置怎么热更新

这个品类的第一大差评是"平台一改版工具就坏"（占全部评价 16%）。插件是所有来源里
最脆弱的一环，所以脆弱性被**前移到一个能当天修好的地方**：

```bash
forge serve --selectors https://example.com/forge/selectors.json
```

- 桥去拉远端那一份，按 `revision` 与扩展手里那份比：**大的赢，相同则远端赢**。
- 扩展拿到就存进 `chrome.storage.local`：桥没开、网断、配置服务器挂了，
  用的仍然是**上一次拿到的那份**（不是随包的那份——一次改版之后它已经不管用了）。
- 远端配置**只能表达选择器，表达不了代码**：`SelectorConfig` 里没有任何可执行的东西，
  解析器也不 `eval`。所以"远端配置被投毒"的最坏后果是**采不到东西**——
  没有这条性质，"远端可热更新"就等于"远端可以改你的浏览器"。

改一次 DOM 结构 = 改 `selectors.default.json`（或远端那一份）并推上去，**不用重新发版**。

## 安全边界

- 桥**只绑 `127.0.0.1`**，而且**要 token**（回环不等于安全：任何一个网页都能向
  `http://127.0.0.1:8787` 发请求）。
- 网页来的请求一律 **403**，即使它拿到了 token（CORS 只放行 `chrome-extension://` /
  `moz-extension://`）。
- 扩展的权限只有 `storage` + `activeTab` + 到 `127.0.0.1` 的 host 权限。
  它**不读**别的站点的后台数据，只在你在那一页点了"采集"时读那一页。

## 怎么装（手动加载，未上架）

1. `forge serve` —— 记下它打在 stderr 上的 token。
2. Chrome → `chrome://extensions` → 打开"开发者模式" → "加载已解压的扩展程序" → 选这个目录。
3. 扩展详情 → 选项 → 填桥地址与 token。
4. 打开一个配了选择器的页面（`selectors.default.json` 里那三类），点扩展图标：
   - **取用**：写一句查询，拿回一段预算内的上下文（可以直接贴进任何模型）；
   - **采集这一页**：把这一页的新记录送进 `sources/`，然后跑 `forge compile`。

## ⛔ 没做什么（如实记账）

1. **它没有被真的装进浏览器测过。** CI 里没有浏览器，所以 `src/content.js` 里那几十行
   DOM 胶水**没有任何自动化验证**。这与 `apps/cli/src/model-http.ts` 的处境一样
   （那个文件也没被真实端点测过）：写在 `evals/README.md` 的同一节里，不留给读者自己发现。
2. **没有构建步骤。** 扩展是纯 JS，`manifest.json` 直接指向源码——
   如果哪天它需要打包（比如引入依赖），那一步要单独记账，因为它会打破"零构建"。
3. **`selectors.default.json` 里的三条选择器是示例，不是维护过的配置。**
   它们是按各站点的公开 DOM 结构写的，没有跟着站点改版维护过。
   真正维护它的是远端那一份（`--selectors`）——这也正是它可热更新的理由。
4. **没有 Firefox 版本。** `manifest.json` 里写了 `moz-extension://` 的来源放行，
   但 `background.service_worker` 在 Firefox 上要换成 `background.scripts`。
