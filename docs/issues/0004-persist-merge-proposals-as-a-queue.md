# Persist merge proposals as a reviewable queue

**Labels:** `enhancement`, `core`, `store`
**Evidence:** `STATUS.md` → Phase 5（「把归并提议也持久化成队列仍是尚未完成的一项」）；`docs/handbook/conflicts.md`

## Why

Conflict candidates already land in `_conflicts/` and require a human decision.
Merge proposals (`forge link`) are only visible in the command's report; they
disappear when the process exits. The discipline is "propose, never auto-apply",
but a proposal nobody can revisit is not a queue.

## What to do

- Add a durable queue for merge proposals, separate from `_conflicts/` (merging is
  grouping, not overwriting; keep the two decisions distinct).
- Store enough evidence to review a proposal offline: candidate ids, the matched
  subject, the rule or model signal that produced it, and both sides' provenance.
- `forge link` writes proposals; a new/existing command lists and resolves them.
- Resolution must be explicit and human-triggered. Do not add an "auto-accept"
  path; `proposedMergesApplied()` should keep proving that proposals are not
  silently applied.
- Add tests that a proposal survives process exit, and that resolving it is the
  only path that changes asset bytes.

## Done when

- The queue is a projection that can be rebuilt, not a hidden second truth.
- `docs/handbook/conflicts.md` documents the review loop.
