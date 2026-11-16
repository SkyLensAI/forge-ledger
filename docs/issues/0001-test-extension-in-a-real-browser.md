# Test the browser extension in a real browser

**Labels:** `good first issue`, `testing`, `extension`
**Evidence:** `apps/extension/README.md` → 「没做什么」；`STATUS.md` → Phase 6 · 如实记账的部分

## Why

CI has no browser. The existing tests cover the extension's *structure* (manifest
targets exist, syntax parses, no workspace imports, packaged config is parseable by
core) but **never execute `content.js` in a real DOM**. That leaves the most
user-facing glue — DOM insertion, selector matching, message passing with
`forge serve` — without automated verification.

## What to do

1. Add a minimal browser-level test. Playwright is acceptable, but keep the
   dependency out of the runtime packages; it belongs under `apps/extension/test/`
   or a separate test package.
2. Cover at least:
   - the content script injects the "capture" and "context" affordances on a page
     matching a selector;
   - a capture round-trip reaches `forge serve` and lands in the inbox path;
   - the extension does not perform retrieval judgment of its own (it calls the
     local bridge).
3. Document the command in `apps/extension/README.md` and CI (or explicitly record
   that it needs a browser and why it is not in the default gate).

## Done when

- The DOM glue fails when intentionally broken (a mutation test, not only a green path).
- The structural tests stay in the default `pnpm test`; the browser test is opt-in
  if it cannot run headless in CI.
