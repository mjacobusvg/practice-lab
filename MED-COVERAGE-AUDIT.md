# Psych medication grounding: coverage audit

**26 Sept 2026. Read-only. Nothing was fixed, nothing was refactored, the Interaction Interpreter
was not touched.**

## The question this answers

We proved the grounding architecture on one hard case (Adderall XR + fluoxetine). That is not the
same as proving it works across psychiatry. Do we have three isolated problems or thirty?

**Answer: three. And one of them is the original defect in a place nobody was looking.**

## What could and could not be tested here

| stage | testable offline? | status |
|---|---|---|
| 1. medication identity resolution (detection, vocabulary) | yes | **TESTED**, 42 cases |
| 2. formulation / product selection, status, granularity | yes | **TESTED**, 42 cases |
| 3. RxNorm concept resolution | no, needs network | **NOT TESTED** |
| 4. SPL selection | no | **NOT TESTED** |
| 5. label sections retrieved | no | **NOT TESTED** |
| 6. does the answer follow the evidence | no | **NOT TESTED** |

A Claude session container has no route to DailyMed or RxNav. Stages 3-6 need a browser run.
`tools/audit-med-coverage.js` is the offline half and re-runs in a second.

## Result: 40 of 42 detected cleanly

Every SSRI/SNRI, every antipsychotic, every mood stabiliser but one, every benzodiazepine and
hypnotic resolved with the right ingredient key, the right release form where one was written,
the right dose, and the right identity granularity. `Effexor XR`, `Wellbutrin XL`, `bupropion SR`,
`Seroquel XR`, `guanfacine ER`, `carbamazepine XR` all kept their formulation and resolved at
**product** granularity. Bare generics resolved at **ingredient** granularity. That is the
architecture working as designed, across the whole formulary, without a drug-specific line of code.

`doxepin 6 mg` correctly resolved to `doxepin_low_dose` rather than to the antidepressant.

## RED 1 — LAI products collapse to their oral namesake

**This is the Adderall XR defect again, and it is worse.**

| written | detected as | what that would retrieve |
|---|---|---|
| `Abilify Maintena 400 mg IM monthly` | **Abilify** | the ORAL aripiprazole label |
| `Invega Sustenna 156 mg IM monthly` | **Invega** | the ORAL paliperidone ER label |

"Maintena" and "Sustenna" are not release-form modifiers, so the detector drops them exactly the
way it would have dropped "XR" before release forms were handled. Note the dose also vanished
(`-`): "400 mg IM monthly" did not parse, because the dose regex expects the number to follow the
drug name and "Maintena" sat in between.

A dosing question about Abilify Maintena would be answered from the oral label, where 400 mg is
far outside the range. Worse than the original defect, because monthly IM and daily oral are not
even the same units.

Affects every LAI: Maintena, Asimtufii, Sustenna, Trinza, Hafyera, Aristada, Perseris, Uzedy,
Risperdal Consta, Zyprexa Relprevv. `pm-lai.html` already carries 18 of these products.

## RED 2 — `divalproex` is not in the vocabulary at all

The interaction checker's dictionary keys it as `valproate`, brand `Depakote`. Clinicians write
**divalproex**, which matches nothing, so `divalproex ER 1000 mg nightly` produced no candidate.

`Depakote` would match. `valproate` would match. The commonest written form does not. Same shape
as the earlier `amphetamine_mixed_salts` problem, which needed a curated alias.

## YELLOW — `Symbyax` is not in the vocabulary

The combination brand is absent; its components are present separately. Detected nothing. Lower
priority: it is uncommon, and both components resolve if written generically.

## Not a failure, but worth naming

`Suboxone 8 mg/2 mg` resolves to `buprenorphine` and the naloxone component is dropped. For
interaction purposes buprenorphine is the actor, so this is defensible, but the combination
`components[]` decision recorded in `CLINICAL-ONTOLOGY.md` §3.1 is still unbuilt.

## The shape of the finding

All three are the **same kind** of problem: a written product name that the vocabulary cannot
match, or matches too coarsely. None is an architecture failure. The evidence model, the
granularity rule, the Tier 1/Tier 2 split and the staleness contract all held across 42 drugs.

Bucketed as asked:

- **Green:** 40/42 on stages 1-2. Ordinary label-grounded questions are structurally fine.
- **Yellow:** vocabulary gaps. `divalproex`, `Symbyax`. A curated alias each, same mechanism
  already used for `amphetamine_mixed_salts`.
- **Red:** LAI products. Needs product-suffix recognition, not just release-form recognition.
  **Nothing about the ontology is wrong**, so it does not reopen architecture.

## What is NOT concluded

Stages 3-6 are untested for all 42. This audit says identity and detection hold up. It does not
say the right label comes back, or that the answer follows the evidence. That needs a browser run
against live DailyMed.

---

# Round 2, 27 Sept 2026: fixes applied, live harness built

## All three findings fixed. 42/42 on stages 1-2.

**LAI** was not solved as a Maintena/Sustenna suffix rule. Those are product identities and must
stay whole exactly as `Adderall XR` does. `tools/gen-rx-vocabulary.js` now reads them from
`pm-lai.html`, where they are already maintained and already reviewed against labeling, so there
is no second clinical list to drift. Six ingredients, thirteen products. A matched LAI product
gets `formulation: 'long-acting injectable'` with `formulationSource: 'product'`, the dose parses
again (the suffix no longer sits between name and number), and an injectable never merges with an
oral of the same ingredient.

**`divalproex`** added as an alias of `valproate`, with `valproic acid` and the salt forms.

**`Symbyax`** added as a combination with `components: ['olanzapine','fluoxetine']`. Suboxone and
Zubsolv too. Also fixed: a combination strength written with one unit at the end (`6/25 mg`)
dropped the dose entirely.

Regression tests for each exact failure, including every product in the LAI dataset.

## Still NOT validated

Stages 3-6 for all 42. This remains the honest statement: **42/42 passed offline
detection and identity. That is not "medication grounding validated."**

## The live harness, `/practice?dev=1`

```
await tbpCoverageA()     all 42: identity -> RxNorm -> SPL -> sections. No model calls.
await tbpCoverageB()     14 difficult cases through full Discern reasoning.
```

**Pass A** reports PASS / FAIL / AMBIGUOUS per drug with the resolved identity, label title,
Set ID, SPL version, sections with character counts, and the exact failure stage (`3 RxNorm`,
`4 SPL`, `5 sections`, `? service`). Results land in `window.TBP_COVERAGE_A`.

**Pass B** is deliberately smaller. Forty-two near-identical "what is the max dose" answers do not
teach forty-two different things. The fourteen are the cases where being right is hard:
formulation-sensitive stimulants (Adderall XR *and* bare Adderall, Concerta), an XR
antidepressant, two narrow-therapeutic-index mood stabilisers, an antipsychotic with an
indication-specific maximum, an LAI, a combination product, a boxed-warning question, and three
interaction pairs. Answers and their trails land in `window.TBP_COVERAGE_B_RESULTS`.

Run A first. Do not fix anything during it; the point is the completed map.
