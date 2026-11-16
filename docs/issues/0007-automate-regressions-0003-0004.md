# Make regression cases 0003/0004 executable

**Labels:** `testing`, `regressions`
**Evidence:** `STATUS.md` → Phase 7 · 如实记账的部分；`evals/regressions/README.md`

## Why

Regression cases 0003 and 0004 describe real mistakes, but their tested object was
a one-off `handoff/apply.mjs` that has been deleted. They are documented gaps, not
covered regressions. R7 says a bug must leave behind something that will catch it
next time; these two currently only leave prose.

## What to do

- Read 0003 and 0004 and identify the **durable invariant** behind each mistake
  (for example: a document that says "not yet done" must not outlive the work; a
  gate code must remain visible to the consistency check).
- Re-express each as an executable check against a fixture that still exists in the
  repository — not against the deleted handoff script.
- If a case genuinely cannot be automated, keep the `why` field and make it
  explicit in the regression test report; do not count it as covered.
- Update `evals/regressions/README.md` with the new coverage status.

## Done when

- `evals/regressions/regressions.test.ts` runs both cases or explicitly reports them
  as `why`-blocked.
- Removing the fix that motivated a case makes the suite red.
