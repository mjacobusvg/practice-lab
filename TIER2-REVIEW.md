# Tier 2 clinical reference: reviewed and closed

**Reviewed by Michael, 26 Sept 2026. Seven rows deleted, one kept unverified.**

## The decision

| product | proposed | verdict | why |
|---|---|---|---|
| Concerta 72 mg/day | duplicate | **deleted** | labeling supports it; Tier 1 retrieves it |
| Vyvanse 70 mg/day | duplicate | **deleted** | same |
| fluoxetine 80 mg/day | duplicate | **deleted** | same |
| sertraline 200 mg/day | duplicate | **deleted** | same |
| escitalopram 20 mg/day | duplicate, and wrong in kind | **deleted** | that is the labeled recommended dose, not a practical ceiling |
| bupropion XL 450 mg/day | duplicate | **deleted** | same |
| Adderall IR 40 mg/day | duplicate | **deleted** | the IR labeling itself says only in rare cases is it necessary to exceed 40 mg/day, so Tier 1 already carries the clinically useful number |
| **Adderall XR 60 mg/day** | the real gap | **KEPT, `verified: false`** | the current labeling gives an adult recommended dose of 20 mg/day, states **no** explicit adult maximum, and its adult trial tested 20, 40 and 60 mg/day. "How high can I go" has no answer in that document. |

## Why the Adderall XR row stays unverified

Michael declined to certify the figure on the strength of model memory, which is correct: that is
the original defect one layer down. He noted a lead (an adult ADHD review drawing on CADDRA
guidance listing mixed amphetamine salts XR at 60 mg/day), recorded on the row and marked as not
yet read or verified.

**Standing instruction:** to have Discern state 60 mg/day as the practical clinical ceiling,
ground it in an actual current clinical or licensed reference and bring the source-backed wording
for approval. Until then the row reaches the model flagged *commonly cited, not
clinician-verified*, and the answer says so.

## What this simplified

**Tier 1 answers almost everything it can answer. Tier 2 exists only for a real gap in Tier 1.**
Not as a shadow medication database that has to be maintained and personally certified. The
result is one unresolved curated fact, not eight.

## The rules that came out of it

- A Tier 2 row that restates a labeled figure is an unverified copy sitting next to a
  retrievable fact, free to disagree with it. Delete it.
- A Tier 2 `basis` says why THIS TABLE holds a figure. It never reports what a label contains:
  that gets repeated as a label fact, which already happened once.
- Nothing enters this table without a clinician approving the row. No entry is set
  `verified: true` by its author.

## Deleting the IR row created a bug, caught by its own test

With the immediate-release row gone there was one amphetamine entry left, and a bare "Adderall"
fell through the single-hit shortcut and collected the **XR** ceiling. That is the original defect
exactly: a formulation the clinician never wrote, inheriting a number that does not apply to it.
A product-level row now only answers for its own product, and a bare "Adderall" gets nothing.
