# Forge

**Compile conversations, docs, and PRs into a typed, provenance-backed asset
library — and let CI stop it from rotting.**

Local-first. No account, no cloud, no API key for the core loop.
Byte-for-byte reproducible.

[Live demo](https://skylensai.github.io/forge-ledger/) · [Format spec](spec/specification.md) · [Quick start](#quick-start) · [中文](README.zh-CN.md)

Most AI memory tools solve **extraction**. Extraction has no moat.
The real failure mode is silent rot: stale facts, drifted indexes, orphaned
pages, superseded decisions nobody notices.
Forge treats provenance as a hard constraint and maintenance as the product.

---

## The problem

Your decisions are scattered across chat sessions, documents, PRs, and meeting
notes. A notes app stores the text. A RAG pipeline retrieves chunks. Neither
tells you whether a claim is still true, where it came from, or that it was
superseded six weeks ago.

So the knowledge base silently rots:

- **stale facts** keep getting injected with full confidence;
- **drifted indexes** no longer match the sources;
- **orphaned pages** lose every path back to their evidence;
- **superseded decisions** are still cited as current.

Forge makes each of those a machine-checkable failure instead of a feeling.

## What Forge does

- **Compiles traces into four typed asset kinds** — `decision`, `state`,
  `event`, `rule` — with required fields and required sections.
- **Requires provenance.** Every asset resolves to a span in a source
  (`file://…` or a content-addressed `src://…`). No resolvable span, no asset.
- **Keeps model output out of the library.** A model may propose candidates,
  but `origin === "model"` can never be admitted directly; proposals wait in
  `_inbox/` for a human.
- **Treats maintenance as the product.** `forge health` reports four kinds of
  rot, `forge confirm` asks a human whether a state still holds, and
  `forge audit` verifies an append-only hash chain of writes.
- **Makes output reproducible.** Same input, same bytes — for the CLI, the
  deterministic emitters, and the static demo.

## Quick start

Requires **Node ≥ 24** and **pnpm ≥ 12**.

```bash
git clone https://github.com/SkyLensAI/forge-ledger.git
cd forge-ledger
pnpm install
pnpm forge lint --repo      # 46 typed assets, each checked against its source
pnpm demo:open              # regenerate demo/ from this repo's own library, then open it
```

No API key is involved. The repository is its own test corpus: the 46 ADRs in
`docs/adr/` are the assets, and `demo/` is a byte-identical projection of them.

> **Reproducibility invariant.** 同一条命令、两个全新 vault：各跑一遍，字节完全相同。
> Two fresh vaults, one command: the output is byte-identical.

Prefer the raw commands? `pnpm forge <command>` is the CLI. On Windows the
repo also ships `forge.cmd`, `forge.ps1`, `forge-mcp.cmd`, and `forge-mcp.ps1`.

## Architecture

```text
 chat exports / docs / PRs / meetings
                 │
                 ▼
             compile ──────────► sources/  (read-only, content-addressed)
                 │                 assets/   (typed, provenance required)
                 │                 index/    (rebuildable, local SQLite)
                 ▼
      extract (optional model) ─► _inbox/   (proposals only, never assets/)

 assets ──► lint / gates ──► emit ──► AGENTS.md · INDEX.md · adr/ · Skill · demo
 assets ──► context ───────► CLI · MCP server · browser extension (one judgement)
 assets ──► health ────────► rot report · due confirmations · audit chain · weekly
```

The same retrieval judgement powers the CLI, the MCP server, and the browser
bridge — tests assert their output is byte-identical.

## Use it from your tools

```bash
pnpm forge context "why is the index on SQLite?"   # budgeted injection, never the whole library
pnpm forge mcp-config --client cursor --vault data # copy-paste client config
pnpm mcp --vault data                              # MCP server (stdio, four tools)
pnpm forge health --today 2026-11-16               # read-only rot report
pnpm forge audit --verify                          # verify the write hash chain
```

Claude Desktop / Claude Code / Cursor configuration lives in
[`docs/handbook/mcp.md`](docs/handbook/mcp.md).

## Why not just a notes app?

| | Notes / PKM | RAG memory | Forge |
|---|---|---|---|
| Unit of knowledge | a page | a chunk | a typed claim with required fields |
| Provenance | optional link | chunk ID | **hard constraint**, resolved to source spans |
| Freshness | manual | none | `last_confirmed` + due queue + `forge confirm` |
| Supersession | manual | none | explicit `supersedes` chain, never silent overwrite |
| Failure mode | quiet rot | quiet rot | **CI red** |
| Output | app-shaped | embeddings | deterministic files you can diff |

Forge is not trying to replace your editor. It is the ledger underneath it:
the place where a claim, its evidence, and its expiry date are all one object.

## What is actually true today

Honest accounting is part of the design. The short version:

- **46 ADRs**, **477 tests**, and **10 real regression cases** (8 of them run in
  CI; the other 2 are documented as not automatable).
- **The demo is generated from this repository's own library**, not from
  invented sample data.
- **Model extraction works from recorded cassettes** (no key needed), but
  real-endpoint extraction quality has **no measurement** — there is no API key
  in CI. The repository does not pretend a synthetic recording is a model score.
- **The browser extension has not been tested in a real browser.** CI checks
  its structure, not its DOM glue.
- **The team edition is deferred by design** — no payment signal, so no
  permissions / concurrency / sensitivity features exist yet.
- **There is no published npm package yet.** Clone + `pnpm install` is the
  current install path; the release gate and preflight are in place, but
  publishing needs an npm scope, credentials, and a human decision.

The full engineering record — phase tables, measured readings, known gaps, and
the gates that enforce them — is in [`STATUS.md`](STATUS.md).

## Five gates, one policy

| # | Gate | Carrier |
|---|---|---|
| 1 | agent hook | `.claude/settings.json` → `scripts/gates/agent-guard.mjs` |
| 2 | pre-commit | `.githooks/pre-commit` |
| 3 | required CI check | `pnpm gate:trusted` + `pnpm gate:ci` |
| 4 | branch rule | `scripts/gates/setup-branch-protection.sh` |
| 5 | release gate | `.github/workflows/release.yml` + human approval |

Local gates are early feedback; **authority lives on the server**. Gate logic
is a single pure function in `scripts/gates/lib/policy.mjs`, and CI runs the
judge from the base revision so a change cannot loosen its own check.

## License

- **Reference implementation** (`apps/`, `packages/`, `scripts/`, `evals/`,
  `schema/`): **AGPL-3.0-only** — see [`LICENSE`](LICENSE).
- **Specification** (`spec/`, taxonomy, examples): **CC0-1.0** — zero friction
  is the first requirement of a standard.
- **Documentation**: **CC-BY-4.0**.

See [`LICENSES/README.md`](LICENSES/README.md) for the full layering. The
specification is designed to ship as an independent repository; the export
lives in `dist/forge-spec`.

## Contributing

Start with [`STATUS.md`](STATUS.md) — it lists what is measured, what is
deliberately not built, and what is known to be missing. A backlog that admits
its gaps is more useful than a roadmap that does not.
