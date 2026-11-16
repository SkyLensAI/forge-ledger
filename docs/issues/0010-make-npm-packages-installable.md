# Make the CLI/MCP packages installable with `npx`

**Labels:** `release`, `packaging`, `help wanted`
**Evidence:** `STATUS.md` → Phase 8 · S31；`apps/cli/package.json` / `apps/mcp/package.json`（`private: true`）

## Why

The lowest-friction way to try Forge is `npx @forge/cli ...`, not cloning the repo
and installing pnpm + Node 24. The release path already exists (ADR-0044:
`release-preflight.mjs`, `release.yml` with `pnpm -r publish --provenance`), but the
publishable packages are still `private: true` and the versions are `0.0.0`.

## What to do

- Decide the npm scope and version (a human decision; do not invent it).
- Make `@forge/cli` and `@forge/mcp` publishable, and ensure every `@forge/*`
  dependency they need is publishable too (the preflight checks this chain).
- Verify the published tarball actually runs on Node 24: the sources are `.ts` and
  rely on native type stripping (ADR-0011). Add an install-and-run smoke test from
  a clean temp directory.
- Keep `@forge/extension` private.
- Do not publish from a laptop; use the tag-triggered release workflow.

## Done when

- `pnpm gate:release` and `release-preflight.mjs` pass with real versions.
- A clean `npx` invocation is documented in the README quick start.
- The release notes state what was published and what remains private.
