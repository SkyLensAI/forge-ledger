# Handle synonym subjects in the linker

**Labels:** `enhancement`, `core`, `linking`
**Evidence:** `STATUS.md` → Phase 5 · 如实记账的部分；`docs/handbook/conflicts.md` → 「已知缺口」

## Why

`state` assets carry a required `subject`, and the linker groups candidates by that
subject. Two phrasings of the same thing ("存储后端" vs "持久化层") currently miss
each other. The design intentionally prefers a false negative (an extra asset) over
a false positive (two facts collapsed into one), but the miss rate is not measured.

## What to do

- First, **measure the gap**: extend the conflict/link probe with a small,
  human-reviewed set of synonym pairs and report the miss rate. Do not change the
  linker before there is a number.
- If a fix is proposed, it must stay explainable: a rule table or a controlled
  vocabulary is preferred over an embedding. If a model signal is used, it may only
  *propose*, never auto-apply (see ADR-0026 / ADR-0029).
- Keep "when unsure, create a new asset" as the default.
- Add the measurement as an invariant or eval probe so a future change cannot make
  it quietly worse.

## Done when

- The miss rate is recorded in `evals/README.md` and `docs/handbook/conflicts.md`.
- Any new matching path has a mutation test proving it cannot auto-merge.
