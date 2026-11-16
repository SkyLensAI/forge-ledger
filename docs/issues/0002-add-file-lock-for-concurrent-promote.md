# Add a file lock for concurrent `promote`

**Labels:** `help wanted`, `concurrency`, `store`
**Evidence:** `STATUS.md` → Phase 7 · 如实记账的部分（「同时写没有锁」）

## Why

Two processes promoting into the same vault at the same time can read the same
audit-chain tail. Verification later reports the broken chain, but it does not
prevent the corruption. This is a known, written-down gap — not a hypothetical.

## What to do

- Add an OS-level lock around the audit-tail read + append + asset write section
  (the same critical section used by `forge inbox --promote` and
  `forge conflicts --resolve`).
- The lock must work on Windows, macOS, and Linux without a new runtime dependency
  if possible; document the chosen primitive and its failure mode.
- If a lock cannot be acquired, fail with a clear code and message; do **not**
  silently skip the audit entry.
- Add a regression case that starts two writers against a temp vault and asserts:
  one succeeds, the other either waits or fails explicitly, and the chain verifies.

## Done when

- The concurrent-writer regression is in `evals/regressions/` and runs in CI.
- `docs/handbook/maintenance.md` no longer lists "no lock" as an open gap.
