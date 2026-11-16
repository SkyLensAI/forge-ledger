# Reduce Chinese bigram collisions in retrieval

**Labels:** `enhancement`, `retrieval`, `i18n`
**Evidence:** `STATUS.md` → Phase 6（「中文走二元组切分，字符级碰撞会让『无关』看起来有关」）

## Why

Chinese text is tokenized into bigrams. That makes retrieval work without a
dictionary, but character-level collisions can make an unrelated query look
related. The probe found this with a natural-language control query ("的迁徙" hit
"的迁移"), which is why control queries must currently be ASCII garbage. That is a
workaround, not a fix.

## What to do

- Add a small Chinese query/asset fixture set with intentionally confusable terms.
- Measure false-positive injection on natural-language control queries.
- Candidate improvements: stop-word filtering for high-frequency bigrams, a
  controlled term list, or requiring a minimum number of distinct matched bigrams.
  Keep the scoring explainable.
- The change must not break the existing English/ASCII behavior or the injection
  budget.
- Document the new control-query policy: if natural-language controls become
  reliable, say so; otherwise keep the ASCII rule and explain why.

## Done when

- The false-positive rate on the Chinese fixture is measured before/after.
- A mutation test shows that "inject everything" still turns the budget/preload
  checks red.
