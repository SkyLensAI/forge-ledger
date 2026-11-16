# Reduce paraphrase misses in lexical retrieval

**Labels:** `enhancement`, `retrieval`, `design`
**Evidence:** `STATUS.md` → Phase 6 · 如实记账的部分；ADR-0029 的残余风险

## Why

Retrieval is deliberately lexical: `term hits × field weights × type weights`, with
a human-readable `why` for every injected item. This is explainable and
deterministic, but it misses paraphrases ("how do we persist state?" vs "存储后端").
The trade-off is recorded; the question is whether a *small*, still-explainable
improvement can narrow it without turning retrieval into a model call.

## What to do

- Build a small query set with paraphrases and measure the current miss rate before
  changing anything. Keep the ASCII control query: it must still inject zero items.
- Candidate directions: a controlled synonym table, light stemming for English,
  or query expansion from asset titles. Avoid embeddings unless the measurement
  justifies the loss of explainability.
- Preserve the non-negotiable properties: deterministic output, no clock/randomness,
  no preloading, and the budget check (`E10`) must still pass.
- Add a mutation case: an implementation that injects everything must fail `E11`.

## Done when

- The before/after numbers are in `evals/README.md`.
- Every injected item still has a `why`, and the CLI/MCP/browser outputs remain
  byte-identical for the same query.
