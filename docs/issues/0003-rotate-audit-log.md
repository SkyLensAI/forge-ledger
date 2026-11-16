# Rotate the audit log without breaking the hash chain

**Labels:** `help wanted`, `maintenance`, `audit`
**Evidence:** `STATUS.md` → Phase 7 · 如实记账的部分（「审计没有轮转」）

## Why

The audit log is append-only and grows forever. Rotation is not just "move the
file": the chain's first entry after a rotation needs a defined relationship to the
last entry before it, or `forge audit --verify` cannot distinguish rotation from
tampering.

## What to do

- Define the rotation contract (for example: each segment starts with a header that
  records the previous segment's final hash, and the verifier walks segments in
  order).
- Implement `forge audit --rotate` (or an equivalent explicit command) that:
  - refuses to rotate a broken chain;
  - writes the new segment atomically;
  - records the rotation itself as an auditable event.
- Keep the default `forge audit --verify` behavior: a missing continuation must be
  a failure, not a silent reset.
- Add tests for: clean rotation, rotation with a deleted segment, and rotation after
  a manually edited line.

## Done when

- Rotation has a documented residual risk (what happens if a segment is lost).
- The verifier rejects a fabricated "new chain starts here" reset.
- `docs/handbook/maintenance.md` is updated with the operator procedure.
