# Issue drafts from the known-gaps list

These are **drafts**, not filed issues. They come from the honest-gaps sections of
[`STATUS.md`](../STATUS.md) and `docs/handbook/`. Publishing requires an account and a
remote, so the final step is human:

```bash
gh issue create --title "<title from the file>" \
  --body-file docs/issues/0001-test-extension-in-a-real-browser.md \
  --label "good first issue,testing,extension"
```

| Draft | Title | Suggested labels |
|---|---|---|
| [0001](0001-test-extension-in-a-real-browser.md) | Test the browser extension in a real browser | `good first issue`, `testing`, `extension` |
| [0002](0002-add-file-lock-for-concurrent-promote.md) | Add a file lock for concurrent `promote` | `help wanted`, `concurrency`, `store` |
| [0003](0003-rotate-audit-log.md) | Rotate the audit log without breaking the hash chain | `help wanted`, `maintenance`, `audit` |
| [0004](0004-persist-merge-proposals-as-a-queue.md) | Persist merge proposals as a reviewable queue | `enhancement`, `core`, `store` |
| [0005](0005-test-model-http-against-a-real-endpoint.md) | Exercise `model-http.ts` against a real endpoint | `testing`, `model`, `needs-api-key` |
| [0006](0006-handle-synonym-subjects-in-linker.md) | Handle synonym subjects in the linker | `enhancement`, `core`, `linking` |
| [0007](0007-automate-regressions-0003-0004.md) | Make regression cases 0003/0004 executable | `testing`, `regressions` |
| [0008](0008-lexical-retrieval-misses-paraphrases.md) | Reduce paraphrase misses in lexical retrieval | `enhancement`, `retrieval`, `design` |
| [0009](0009-reduce-chinese-bigram-collisions.md) | Reduce Chinese bigram collisions in retrieval | `enhancement`, `retrieval`, `i18n` |
| [0010](0010-make-npm-packages-installable.md) | Make the CLI/MCP packages installable with `npx` | `release`, `packaging`, `help wanted` |

Rules for these drafts:

- **Do not describe a gap as solved.** The point of this list is that it is honest.
- Link to the file/line where the gap is recorded, not just to this index.
- If a fix lands, add a regression case (`evals/regressions/`) in the same change
  (AGENTS.md R7), then close the issue with a link to that case.
