# Changelog

All notable changes to Forge are recorded here. Versions follow the Forge Ledger
Format; the format itself is versioned separately in [`spec/`](spec/).

## v0.1.0 — 2026-11-16

The first public surface of Forge: a local-first ledger that CI keeps from rotting.

### What this release fixes

Forge does not try to "remember more". It makes a long-lived context library
maintainable after the first month:

- **Provenance is a hard constraint.** Every asset points to a resolvable span in a
  source file or immutable fragment. A broken citation fails the gate; it is not a
  metadata warning.
- **Model output cannot enter the asset layer.** Model candidates land in
  `_inbox/`; promotion is human-triggered. `origin === "model"` is a
  non-configurable boundary.
- **Rot is detectable and reviewable.** `forge health` reports orphan pages, index
  drift, expired assertions, and silently superseded states. It never fixes itself
  into looking healthy.
- **Output is deterministic.** Two fresh vaults emit byte-identical bytes; no
  clock, randomness, locale, or newline drift in the output.

### Added

- Four typed asset kinds: `decision`, `state`, `event`, `rule`.
- `forge compile / lint / emit / context / extract / inbox / link / conflicts`.
- Maintenance machine: `health`, `confirm`, `audit` (hash-chained write-ahead
  log), `weekly`.
- MCP server with four tools (`context`, `search`, `get`, `lint`), sharing the
  same judgment as the CLI.
- Browser extension for capture + retrieval, with all judgment kept in the local
  bridge.
- CI gates: provenance, taxonomy consistency, eval thresholds, hostile-model
  trust boundary, injection budget/preload, bootstrap, team-ordering, determinism.
- Static demo generated from this repository's own ADRs:
  <https://skylensai.github.io/forge-ledger/>.

### Known gaps (not hidden)

- The browser extension has no automated DOM test in a real browser.
- `model-http.ts` has not been exercised against a real endpoint without an API
  key; model extraction quality has no measured numbers.
- Audit writes have no file lock and no rotation.
- Merge proposals are not yet persisted as a reviewable queue.
- Retrieval is lexical and misses paraphrases; Chinese bigram collisions are
  recorded in the handbook.
- Regression cases 0003/0004 still cannot be executed automatically.
- Team edition is intentionally not started: `payment_signal` is `null`.

### Upgrade notes

- Requires Node.js **24+** and pnpm.
- Run `pnpm install && pnpm check`.
- The ledger format is **v1**; normative text is in [`spec/`](spec/).

---

## 中文

### 这一版修掉了哪种腐烂

v0.1.0 不承诺“记得更多”，它让一个长期存在的上下文库在第一个月之后仍然**可维护**：

- **出处是硬约束**：每条资产都指向来源里可解析的 span；坏引用会让闸门变红。
- **模型产出不能直接进资产层**：候选只能进 `_inbox/`，晋升由人触发。
- **腐烂能被看见**：`forge health` 报孤立页、索引漂移、过期断言、静默被取代；
  它不会“自动修好”自己。
- **输出确定**：两个全新 vault 产出逐字节相同；没有时钟、随机、时区或换行漂移。

### 已知缺口（如实记账）

- 浏览器扩展没有真实浏览器里的自动化 DOM 测试。
- `model-http.ts` 没有在真实端点上跑过；模型抽取质量没有实测数字。
- 审计没有文件锁、没有轮转。
- 归并提议还没有持久化成可复核的队列。
- 检索是词法的，会漏掉改写；中文二元组碰撞写在 handbook 里。
- 回归 0003/0004 仍不能自动执行。
- 团队版按设计未启动：`payment_signal` 是 `null`。

### 升级方式

- 需要 Node.js **24+** 与 pnpm。
- 跑 `pnpm install && pnpm check`。
- 账本格式是 **v1**；规范文本在 [`spec/`](spec/)。
