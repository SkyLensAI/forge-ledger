# License texts

This repository is layered by material. The root `LICENSE` is the license GitHub
(and most visitors) will see, so it covers the reference implementation.

| File | Applies to |
|---|---|
| `../LICENSE` (= `AGPL-3.0-only.txt`) | reference implementation: `apps/`, `packages/`, `scripts/`, `evals/`, `schema/` |
| `CC0-1.0.txt` | specification text, `spec/`, `schema/taxonomy.yaml`, `schema.json`, examples |
| `CC-BY-4.0.txt` | documentation, governance, and contribution documents |

The specification uses CC0-1.0: the first requirement of a standard is zero friction.
The reference implementation uses AGPL-3.0-only: it needs to prevent "fork it and
offer a closed-source hosted service".

The specification is designed to be published as an independent repository
(`public-export.json` exports it to `dist/forge-spec`, including a
`MANIFEST.sha256`). Until that repository exists, the normative text lives in
`spec/`; the reference implementation lives here.

The license texts come from their official publication pages:

- <https://creativecommons.org/publicdomain/zero/1.0/>
- <https://creativecommons.org/licenses/by/4.0/>
- <https://www.gnu.org/licenses/agpl-3.0.html>
