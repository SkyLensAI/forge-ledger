# Exercise `model-http.ts` against a real endpoint

**Labels:** `testing`, `model`, `needs-api-key`
**Evidence:** `STATUS.md` → Phase 4（「已知未验证」）；`evals/README.md` → Phase 4 · 模型路径怎么量

## Why

`apps/cli/src/model-http.ts` is tested only with a stubbed `fetch`: request shape,
response shape, non-2xx handling, and endpoint slash handling are covered. Nobody
has verified that a real provider accepts the authentication, what a timeout looks
like, or whether the extraction quality holds. This is an honest gap, not a claim
that the path is unmaintained.

## What to do

- Add an opt-in integration test that runs only when an explicit environment
  variable (for example `FORGE_MODEL_ENDPOINT` and `FORGE_MODEL_API_KEY`) is set.
- Never record or commit the key. The default suite must stay offline and green.
- Test at least: successful extraction, 401/403, 429, timeout, and a truncated
  response body.
- If a cassette can be recorded from the real call, add it under the existing
  cassette mechanism so the replay path has a genuine model trace (with secrets
  removed).
- Record the measured precision/recall in `evals/README.md`; if the numbers are
  bad, report them — do not tune the ruler to make the model look good.

## Done when

- The opt-in test is documented with exact setup steps.
- The default `pnpm test` still runs without a key.
- `STATUS.md` can replace "没有被真实端点测过" with a measured statement.
