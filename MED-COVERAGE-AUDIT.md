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

Open the console and run, in the DEFAULT `top` context (no frame switching needed):

```
await tbpCoverageA()     all 42: identity -> RxNorm -> SPL -> sections. No model calls.
await tbpCoverageB()     14 difficult cases through full Discern reasoning.
```

The Scribe runs inside the desk's iframe, so its own location carries `?slot=` rather than the
`?dev=1` typed on the desk. The desk now passes the flag through to the frame, and the Scribe
publishes both handles onto the top window, so the first attempt reported
`tbpCoverageA is not defined`.

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


---

# Pass A result, 27 Sept 2026: 3 pass, 13 fail, 26 ambiguous

**Not 39 problems. Three root causes, none of them architecture.** Nothing was fixed during the
run, as instructed.

## First, what worked

**Identity resolution is sound.** 38 of 42 resolved an RxNorm concept, and where a label was
found it was the RIGHT label every single time:

| written | resolved to |
|---|---|
| `Abilify Maintena 400 mg IM monthly` | ABILIFY MAINTENA (ARIPIPRAZOLE) KIT, Otsuka |
| `Invega Sustenna 156 mg IM monthly` | INVEGA SUSTENNA (PALIPERIDONE PALMITATE) |
| `divalproex ER 1000 mg nightly` | DIVALPROEX SODIUM ER, and it passed end to end |
| `cariprazine 3 mg daily` | VRAYLAR, resolved from the generic name |
| `Seroquel XR 300 mg nightly` | SEROQUEL XR, not plain Seroquel |
| `Adderall 10 mg bid` | ADDERALL, not Adderall XR |

All three round-1 findings are confirmed fixed at the identity stage. No LAI collapsed to its
oral parent. Adderall IR and Adderall XR resolved to different labels.

## Cause 1: the ambiguity rule is far too strict — 26 cases

Two sub-causes, both reproduced offline.

**A query with no release-form token demands a NON-extended-release label.** `Concerta` has no
`XR` in it, so `wantER` is false, so the real Concerta label (which is extended release by
definition) scores `RELEASE FORM MISMATCH` and the lookup refuses. Absence of a form token in the
query means *no preference*, not *must not be extended release*.

**A brand and its generic count as materially different products.** `lithium` against
`LITHIUM CARBONATE CAPSULE` and `LITHOBID (LITHIUM CARBONATE) TABLET` gives product names
`lithium` and `lithobid`, which differ, so it refuses. That is most of the 26: fluvoxamine,
mirtazapine, trazodone, clonazepam, doxepin, Vyvanse, aripiprazole, quetiapine, Suboxone all
report exactly **1** materially different label.

## Cause 2: no SPL found at all — 4 cases

`venlafaxine XR` (RXCUI 2610943), `clonidine ER` (885790), `carbamazepine XR` (852896),
`Symbyax` (405343). RxNorm resolves the form-suffixed string to a specific product concept that
DailyMed does not index, and the `drug_name` search fails because no title contains
"venlafaxine XR" as written. Needs an ingredient-name fallback: try `venlafaxine` when
`venlafaxine XR` finds nothing.

## Cause 3: the right label, and zero sections stored — 9 cases

fluoxetine, sertraline, escitalopram, Wellbutrin XL, Adderall IR, Seroquel XR, Vraylar,
Abilify Maintena, Invega Sustenna. Every one found the correct label with a Set ID and version,
and came back with nothing.

**The section insert response is never checked.** `await sb('tbp_drug_label_section', {POST})`
resolves on a 400 or a 413 exactly as it does on success, so a failed write is indistinguishable
from a successful ingest. That fits the shape: the three passes are comparatively small labels,
and the failures are large ones.

That is a hypothesis, not a diagnosis. It cannot be settled from a session container. The fix is
to make `sb()` check its response and carry the error into the trail, then re-run: the same
method that found the previous nine defects.

Also visible: **`clinical_studies` came back for none of the three passes**, only
`dosage_and_administration` and `use_in_specific_populations`. That is the section holding the
studied dose range, and it has never once been retrieved.

## The shape

| cause | cases | kind |
|---|---|---|
| ambiguity rule too strict | 26 | scoring logic, two small changes |
| no SPL for a form-suffixed name | 4 | needs an ingredient fallback |
| sections not stored | 9 | write failure, unverified; needs instrumentation |

Identity, granularity, the Tier 1/Tier 2 split, LAI product preservation and the staleness
contract all held. Nothing here reopens the ontology.


---

# Pass A rerun, `ambient-165-sub`: 34 pass, 1 fail, 7 ambiguous

Up from 3 pass. Causes 1 and 2 did what they were meant to. **But the headline hides one result
that matters more than the count: a wrong label PASSED.**

## RED, new: `lithium` resolved to a homeopathic product

```
lithium 900 mg nightly  ->  PASS
label: ENERGY CATALYST (ADENOSINUM CYCLOPHOSPHORICUM ...) [Set ID e15fd50b]
sections: dosage_and_administration(159)
```

That is not lithium. It is a homeopathic combination whose ingredient list happens to contain a
lithium salt, and it was handed back as the authoritative label with a 159-character dosage
section.

Reproduced offline. Its product name is `energy catalyst liquid`, but scoring tests whether the
query words appear anywhere in the **title**, and "lithium" appears in the ingredient
parenthetical. Full-title match, 100 points, recent date, and the ingredient-granularity
loosening from this round removed the tie check that would have caught it.

**A wrong label that passes is worse than a failure**, because nothing downstream can tell. This
is the same class as the original defect and it was introduced by my own fix for cause 1.

The guard needed: the query has to match the **product name**, not merely appear somewhere in the
title. `energy catalyst liquid` does not contain "lithium" and should never have scored.

## CONFIRMED: cause 3 was the section writes

The `wrote` column settles it. On nearly every label:

```
boxed_warning indications_and_usage dosage_and_administration contraindications
drug_interactions use_in_specific_populations warnings_and_precautions! clinical_studies!
```

`!` marks a failed write. **`warnings_and_precautions` and `clinical_studies` fail to store on
almost every drug**, and they are consistently the two largest sections. Everything else stores.

That is why `clinical_studies` has never once been retrieved, on any label, in any run: it has
been failing to write the whole time and the old code could not tell.

Outstanding: the actual HTTP status and body. `TBP_COVERAGE_A[0].writes` carries it.

## The 7 remaining ambiguities: form tokens left in product names

Reproduced offline:

| title | product name |
|---|---|
| `EFFEXOR XR (VENLAFAXINE) CAPSULE, EXTENDED-RELEASE` | `effexor xr extended` |
| `EFFEXOR XR- venlafaxine hydrochloride capsule, extended release` | `effexor xr` |
| `BUPROPION HYDROCHLORIDE SR TABLET, ... EXTENDED RELEASE` | `bupropion sr` |
| `BUPROPION HYDROCHLORIDE TABLET, EXTENDED RELEASE` | `bupropion` |

Two causes: the dose-form pattern matches `extended release` with a space but not
`extended-release` with a hyphen, and a bare `SR` in a title survives as part of the product name.
So two labels for the same product compare as different products and the lookup refuses.

The fix is not to strip form tokens from the product name outright: `adderall xr` must stay
distinct from `adderall`. The comparison should use a form-stripped **core** while `isER`
continues to carry the release distinction separately.

`Adderall 10 mg bid` ambiguous is **correct** and should stay: both an IR and an XR label exist
and the note said neither, which is exactly what the confirmation card is for.

## YELLOW: a query stating no preference landing on a modified-release or specialty label

| written | resolved to |
|---|---|
| `fluvoxamine` | FLUVOXAMINE MALEATE CAPSULE, **EXTENDED RELEASE** |
| `oxcarbazepine` | **OXTELLAR XR** |
| `clozapine` | **VERSACLOZ** oral suspension |

Not wrong labels for that ingredient, but the dosing differs from what a clinician writing the
bare name almost certainly means. With no preference stated, a plain immediate-release label
should be **preferred** as a tiebreak, not required: Concerta must still resolve when the only
label on file is extended release.

## Remaining FAIL: Symbyax

`no SPL found by drug name or by RXCUI 405343`. The ingredient fallback did not fire because
`Symbyax` contains no form token to strip, so the fallback name equalled the original. It may
simply have no current SPL on DailyMed, which would be a true negative rather than a defect.

## Pass A run 3 -> run 4: the three fixes

Run 3 was 35 pass / 1 fail / 6 ambiguous. The instrumentation added before it answered the
question it was added for, and two of the three remaining problems turned out not to be
retrieval problems at all.

**1. Section writes were failing on a column that does not exist.** The trail returned:

```
{section: 'drug_interactions', chars: 3938, stored: false,
 error: "supabase section insert -> HTTP 400: {\"code\":\"PGRST204\", ... of
         'tbp_drug_label_section' in the schema cache\"}"}
```

PGRST204 is PostgREST saying a column in the payload is not in the table. Not a size limit:
3938 characters. The column was `by`, which `extractSections` attaches to a section it found
by its heading rather than by its LOINC code. It is useful provenance and it is not a column,
so PostgREST rejected the whole row, and because the response was never checked the section
simply vanished. That is why `clinical_studies` and `warnings_and_precautions` failed on
nearly every label: those are exactly the sections the title fallback finds.

The row is now built from a whitelist (`SECTION_COLUMNS`), never by spreading the section
object, so no future field can silently kill a write. `by` survives in memory for the trail.

**2. Two of the run-3 failures were cached, not wrong.** `lithium` still resolved to
`ENERGY CATALYST` and `oxcarbazepine` still to `OXTELLAR XR` after the scoring fixes that
reject both. Neither was re-fetched: a stored label is served for thirty days, and re-ingest
only fires when the section list is empty. A resolver fix cannot be validated at all under
that rule. `tbpCoverageA({ fresh: true })` now passes `refresh` through to the function and
bypasses the cache.

**3. The six ambiguities were one normalisation artifact.** Every one showed a doubled core:
`effexor effexor`, `venlafaxine venlafaxine`, `bupropion bupropion`, `vyvanse vyvanse`,
`carbamazepine carbamazepine`, `suboxone soluble`. Some SPL titles restate the product name,
so the normalised core came out doubled and read as a different product from the same drug's
other label. A repeated word adds nothing to an identity, so `splProductCore` now drops
repeats. `soluble`, `sublingual`, `buccal`, `transdermal` and `system` were also missing from
the dosage-form list, which is the `suboxone soluble` case.

**Still open going into run 4:** `Symbyax` found no SPL by name or by RXCUI 405343, and the
ingredient fallback did not fire because there is no form token to strip. It may genuinely
have no current label; run 4 with `fresh: true` will say.

## Pass A run 4: 40 pass, 1 fail, 1 ambiguous, of 42

Run with `tbpCoverageA({ fresh: true })`, so every label was re-fetched from DailyMed rather
than served from the thirty-day cache. All three run-3 fixes are confirmed against live data.

**lithium resolves to `LITHIUM SOLUTION [ADVAGEN PHARMA LTD]`.** In run 3 it resolved to
`ENERGY CATALYST`, a homeopathic combination product, and the trail presented it as
authoritative lithium labeling. That was the single most dangerous result in the audit, and it
is fixed by the identity-scoring rule rather than by excluding one product.

**oxcarbazepine resolves to `OXCARBAZEPINE TABLET, FILM COATED`**, not OXTELLAR XR: a bare
generic query gets the ordinary product, not a specialty extended-release one.

**Sections are stored.** `clinical_studies` appears on nearly every row with a real character
count. It was being extracted and then silently dropped on write for as long as the title
fallback has existed.

Five of the six run-3 ambiguities were the doubled-core artifact and are gone.

### The two remaining rows

**Row 31, `carbamazepine XR` -> AMBIGUOUS, "2 materially different: carbatrol; tegretol".**
This is the system working. Carbatrol is carbamazepine ER capsules, Tegretol-XR is carbamazepine
ER tablets, and a bare "carbamazepine XR" does not say which. They are genuinely different
products, so refusing to pick one and saying why is the correct outcome under fail-closed. It
is recorded as a TRUE POSITIVE, not a defect to fix.

**Row 39, `Symbyax` -> FAIL, "no SPL found by drug name or by RXCUI 405343".** RESOLVED, see
below. The probe confirmed a generic olanzapine and fluoxetine label exists (rxcui 611247), so
this was a retrieval gap rather than a product without labeling.

### Zero failed section writes

`TBP_COVERAGE_A.flatMap(r => (r.writes||[]).filter(w => !w.stored))` returned `[]` across all
42 rows. Section persistence is confirmed working, not inferred from the section counts.

### The combination fallback

Symbyax has no current SPL of its own. Both DailyMed lookups came back empty, and the
bare-strip fallback could not fire because it only removes a release-form token and Symbyax has
none. So a product whose generic labeling was in DailyMed the whole time failed as "no SPL
found".

`ingestDrug` now asks RxNorm what the concept contains, and when it contains two or more
ingredients it searches DailyMed for labeling of that ingredient SET (both orders, since RxNorm
does not promise DailyMed's ordering). `chooseSpl` is then scored against the generic
combination name, because that is what the label is called.

**The guard is the point.** `comboQueries` returns nothing for fewer than two ingredients, so a
single ingredient can never stand in for a combination brand. Answering a Symbyax question from
olanzapine monotherapy labeling would be the Adderall defect in different clothes: the dosing in
that label is not this product's dosing. A combination may only be answered from labeling for
the same set of ingredients.

The substitution is recorded on the stored `chosen_reason`, not only on the fresh response, so
it survives the cache and the trail never implies a brand label was found where there is none.

### Symbyax verified, and Pass A closed

```
title:    OLANZAPINE AND FLUOXETINE (OLANZAPINE AND FUOXETINE) CAPSULE [PAR HEALTH USA, LLC]
note:     no current Symbyax label; using the generic combination labeling for
          fluoxetine and olanzapine
why:      ... preferred for a bare query (score 125 of 3 candidates)
sections: 3
```

Both ingredients are in the title, the match is a full identity match, and the trail states
what was read and why. The label's own parenthetical carries a typo ("FUOXETINE"), which did
not affect identity because the product name governs.

It matched on `fluoxetine and olanzapine`, the REVERSE of the order in the label's title:
RxNorm returns the ingredients alphabetically, DailyMed titles the product the other way. The
both-orders retry is load-bearing, not defensive padding. Without it this drug still fails.

**Pass A final: 41 of 42 resolve correctly.** The one remaining row, `carbamazepine XR`, is a
recorded true positive: Carbatrol and Tegretol-XR are different products, the query does not
say which, and naming both instead of picking one is the designed behavior.
