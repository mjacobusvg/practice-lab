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

## Pass B, both modes

`tbpCoverageB()` dismisses the card and records what was asked. `tbpCoverageB({mode:'confirm'})`
accepts the list and records the answer. 14 cases each.

The gate behaves. Two cases asked before answering and neither guessed: `Adderall 10 mg bid`
(formulation, and IR and XR have different labeled maximums) and `quetiapine 100 mg nightly`
(formulation). The other twelve answered directly, which is the point of the earlier carve-out:
a note that already states the product is not sent back for ratification.

### Finding 1: an identity substitution reached the clinician as a label claim

Symbyax answered: *"The labeled adult maximum for Symbyax is 12 mg olanzapine / 50 mg fluoxetine
once daily. That is the explicit figure in the current label."*

**Symbyax has no current label.** That is established, by this audit, two sections up. The
combination fallback had correctly read the generic olanzapine and fluoxetine labeling and
correctly recorded the substitution in the trail. The prompt never carried it:
`buildEvidenceBlock` announced the block as labeling "for the specific products confirmed for
this patient" and headed the item `EVIDENCE FOR: Symbyax`. So the model was told a generic
label was the Symbyax label, and wrote a true sentence about the wrong document.

This defect was introduced by the fix two sections up. Making retrieval succeed is not the same
as making the answer honest about what succeeded, and the trail carrying the truth does not help
a clinician reading the prose.

`buildEvidenceBlock` now states the substitution beside the label it applies to and instructs
that anything taken from it be attributed to that labeling by name. An ordinary retrieval
carries no such line, so the warning does not become noise the model learns to skip.

### Finding 2: the same dosing question answered 54 mg/day once and 72 mg/day twice

`Concerta 36 mg daily` / "How high can I go on this?"

- run 1: "The labeled maximum for methylphenidate extended-release (Concerta/OROS formulation)
  is **54 mg/day** for adults."
- run 2 and run 3: "**72 mg/day**."

72 mg/day is the adult figure. 54 mg/day is the pediatric one. This is the ORIGINAL DEFECT'S
EXACT SHAPE: the Adderall failure was also an adult question answered with a pediatric ceiling.

Retrieval was not the variable. The same case resolved the same label in every run. The
variation is in what the model did with the same evidence.

**What this means for the audit method.** A single pass cannot establish that a dosing answer is
correct; it establishes that it was correct once. Every clean result recorded above has the same
limit. Pass A's 41/42 is about retrieval and is stable, because retrieval is deterministic given
a label. Pass B's answers are not, and a per-case repeat count is needed before any of them can
be called reliable.

**OPEN, and not to be resolved by picking whichever reading is convenient:** whether
pediatric-vs-adult dose separation should be enforced structurally (the prompt is handed the
adult figure and the pediatric one as distinct, labeled facts) rather than left to the model to
keep apart while reading a full dosing section. The original Adderall defect, the run-1 Concerta
answer, and the lithium range noted below are all the same confusion.

### Smaller observations

- Lithium: "the therapeutic range the label cites is 0.8 to 1.2 mEq/L" states the MAINTENANCE
  range without the acute-mania range (1.0 to 1.5) or the distinction between them. Specificity
  present in the source was lost, which the ontology forbids.
- Adderall plus fluoxetine: "Both labels name this combination." Needs checking against the
  trail. The fluoxetine label names sympathomimetics; whether the Adderall label names
  fluoxetine is a different claim.
- Sertraline in pregnancy leaned on practice knowledge ("one of the better-characterized
  antidepressants in pregnancy"). Defensible as synthesis rather than invention, but it should
  be attributed as practice rather than sitting beside labeled statements unmarked.

## Pass B, 5x repeat: two fixes did not work

`tbpCoverageB({mode:'confirm', repeat:5})`, 70 runs. Reported 13 of 14 cases as varied, which
**overstates it**: the metric compared whole figure sets, so a run writing "60 mg" and another
writing "60 mg/day" counted as disagreement. That is now per-figure run counts, which separates
punctuation noise from a number that actually moved.

Two findings, and both are fixes from the previous round failing rather than new defects.

### The population split did not stop the Concerta error

Across five runs the figures were `36 mg | 72 mg/day`, `36 mg | 54 mg | 54 mg/day`, and
`36 mg | 54 mg | 54 mg/day | 72 mg/day`. **One run gave 54 mg/day with no 72 anywhere.** 54 is
the 6-to-12 ceiling, the patient is an adult, and this is the fourth appearance of the same
confusion.

The split fails closed by design: no numbered subsections means the section goes to the model
whole and the separation does nothing. Whether that is what happened to the Concerta label is
not yet established. `tbpSplitCheck('Concerta')` answers it directly, reporting whether the
split fired, the reason it declined, and the head of the section text.

Do not assume the answer. If the split declined, the fix is in the segmentation. If it fired and
the model still said 54, the fix is not segmentation at all and the structural approach needs
rethinking rather than tuning.

### The identity substitution survived exactly one request

Symbyax again answered "the explicit figure in the current label", after the fix that was
supposed to prevent exactly that sentence.

`identity_note` was read only from the fresh ingest: `(ingested && ingested.identity_note)`.
`ingested` is null on a cache hit. Symbyax had been cached by the verification probe, so the
note was null from the next request onward and the prompt went back to presenting a generic
label as the Symbyax label. The note was already being stored as the prefix of `chosen_reason`
so that it would outlive the fetch; the evidence block simply never read it from there.
`identityNoteOf` now recovers it, with tests.

This is the second time a fix in this area was validated against a fresh fetch and then quietly
stopped working on the cached path. The lesson is specific: **anything that must appear in an
answer has to be proven on the CACHED path, because that is the path almost every real request
takes.**

### What the repeat run does establish

Case 12 (lamotrigine plus divalproex) was stable across all five runs. Every other case moved at
least one figure, though most of that movement is incidental numbers appearing in some runs and
not others rather than a contested ceiling. The per-figure counts now make the difference
readable at a glance.

## Pass B after the figure index: two fixed, one new

### Fixed

**Symbyax.** Now reads "That figure comes from the generic combination labeling (Par Health
USA), which is being used here because there is no current Symbyax label." Correct attribution,
the substitution named, and it held on the cached path.

**Concerta no longer leads with 54.** 72 mg/day in 4 of 5 runs, and 54 has dropped to an
incidental mention rather than the answer. The per-figure population index did what the heading
split could not.

### New: the model reached for an unsourced number instead

One run in five: *"some clinical practice pushes to 108 mg/day in adults off-label."* 108 mg/day
is in no retrieved label and no Tier 2 row.

This is not the model disobeying. Rule 2 says established clinical practice "you may supply from
your own knowledge, clearly marked as such," and it supplied a practice figure and marked it.
Blocked from borrowing the pediatric 54, it reached for a remembered number instead. The
carve-out was written to stop grounded uselessness and it worked exactly as written.

**The line now drawn:** describing practice in words is synthesis and stays. Naming its figure is
invention and does not. A number that appears in neither the label nor the clinical reference
block may not be stated, and "off-label" or "in common practice" does not license it, because a
reader cannot tell a remembered figure from a sourced one. The model is told what to say instead:
that clinicians do exceed the labeled ceiling and there is no sourced figure for how far.

The carve-out itself is intact and has its own test, so a later change cannot quietly walk the
answers back to refusing to synthesize.

### The check that should have caught it

108 mg/day was found by reading prose. That does not scale past fourteen cases, and every defect
in this audit was invisible in the answer and visible in the data.

Pass B now compares every dose figure in an answer against the retrieved evidence AND the
clinician's note, and reports any figure found in neither. A figure that is in neither came from
the model's memory, which is the entire defect class stated as one test. The evidence text is
captured on a dev-only side channel rather than on the persisted log entry, since it runs to tens
of thousands of characters and has no business in saved encounter state.

### Note on the variance metric

"14 of 14 varied" is not the alarming number it looks like. Flagging any figure absent from any
run will fire on almost any prose. The useful column is now the unsourced one: variance says the
wording moved, unsourced says a number had no origin.

## The unsourced check found what the whole audit missed

3 of 14 cases stated a dose figure present in neither the retrieved evidence nor the note. Two
were arithmetic. The third inverts a conclusion this document reached twice.

### Concerta has been answered from memory the entire time

Flagged on case 3: `54 mg/day 4/5`, `72 mg/day 2/5`, `108 mg/day 1/5`.

72 mg/day is not a stray mention. It is THE ANSWER, given as "the labeled maximum for
methylphenidate in adults". The check matches the bare digits anywhere in the evidence or the
note, so it is lenient by construction, and a miss means the characters "54" and "72" appear
**nowhere in the retrieved Concerta evidence.**

So every Concerta answer in this audit came from the model's memory. Including the one this
document recorded as evidence that the population index worked: 72 mg/day in 4 of 5 runs looked
like a fix and was a coincidence of recall.

**Pass A called Concerta PASS.** It checked that a label resolved and that sections stored. It
never checked whether the stored section contained the facts the question needs. Those are
different claims, and only one of them was ever measured.

This is the same failure shape as every other defect here, one level up: the trail said
`dosage_and_administration(4141)` and looked like success. A section being retrieved is not the
same as the facts being retrieved.

**Not yet diagnosed, and not to be guessed at.** The Concerta dosing section is 4141 characters
and the ceilings are not in it. The figures live in a dosing TABLE, and whether that table
survives `stripTags`, or sits in a subsection the extractor never reaches, is an open question
with different fixes. `tbpSplitCheck('Concerta')` already showed the section text; what is needed
is which figures the retrieved evidence actually contains.

Pass B now records `evidenceFigures` per case: every dose figure present in the evidence that was
sent. A case whose answer figures do not appear in its evidence figures is answering from memory
regardless of how confident the trail looks.

### The two false positives, now separated

`120 mg/day` (ziprasidone) is "60 mg bid" doubled. `4,500 mg/day` (divalproex) is 60 mg/kg times
an assumed weight. Both are arithmetic on figures that WERE present, not recall. Figures that are
small integer multiples of a number in the note are now reported as `computed` rather than
`unsourced`, because flagging them buries the ones that really did come from nowhere.

## CORRECTION: the Concerta evidence does contain the figures

`tbpEvidenceFigures('Concerta')` on the real retrieval:

```
dosage_and_administration   4141 | 10 mg, 15 mg, 18 mg, 2 mg/kg/day, 20 mg, 27 mg, 36 mg,
                                   5 mg, 54 mg, 54 mg/day, 60 mg/day, 72 mg, 72 mg/day
use_in_specific_populations 7768 | ... 54 mg/day, 60 mg/kg/day, 72 mg/day
clinical_studies            4907 | ... 36 mg/day, 45 mg, 54 mg, 72 mg, 72 mg/day, 108 mg/day
```

**The section above this one is wrong and stays here so it is not repeated.** 54 mg/day and
72 mg/day are both in the retrieved dosing section. 108 mg/day is in clinical_studies. So
"every Concerta answer came from memory" was wrong, and "108 mg/day was invented" was wrong.

The mistake was trusting a new check over a direct look at the data, which is precisely the
failure this audit keeps finding in the product. The check is lenient by construction, so a flag
looked conclusive. It was not.

### What actually remains, and it is two separate things

**1. The check flagged figures that were present, and only in SOME runs.** 54 mg/day was flagged
in 4 of 5 runs and 72 mg/day in 2 of 5. If the check were simply broken it would flag every run
equally. A per-run split points at the evidence sometimes not reaching the prompt at all, which
would be an intermittent retrieval failure and a genuine defect. It could also be a bug in how
the evidence is captured. **Not diagnosed. Do not pick the more convenient one.**

Pass B now records `evidenceFigures` per run, so a rerun separates these: a run with figures
recorded and a flag anyway means the check is wrong, and a run with no figures recorded means
the evidence never arrived.

**2. 108 mg/day was mis-categorised, not invented.** It is in `clinical_studies`, which makes it
a STUDIED dose. The answer called it "some clinical practice extends to 108 mg/day off-label",
which turns a studied dose into a practice claim. The existing rules already forbid the same
move in the other direction ("do NOT present the highest studied dose as though it were" a
maximum). This is that error wearing different clothes, and it is a category confusion rather
than a fabrication.

The rule added in the previous round (a dose figure must appear in the label or the clinical
reference block) is still sound and stays. It simply did not fire on what was assumed.

## The Concerta answer is now wrong in the dangerous direction

Leading answer, `mode: 'confirm'`, run at ambient-177:

> "The labeled maximum for Concerta (methylphenidate extended-release) in adults is **54 mg/day**
> for ADHD. Some clinicians prescribe above that, off-label doses up to **72 mg/day** are not
> uncommon in practice, but 54 mg is where the label stops."

**54 mg/day is the ceiling for children 6 to 12. 72 mg/day is the adult labeled maximum.** The
answer has them inverted and additionally calls the real adult figure off-label. Both numbers are
in the retrieved dosing section. This is the original Adderall defect, on a different drug, after
two structural fixes aimed squarely at it, and stated with more confidence than before.

An earlier entry in this file recorded "Concerta no longer leads with 54" as evidence the
population index worked. That was one sampling of a non-deterministic answer, and the index had
not fixed anything.

### The audit instrument was broken while reporting on it

`evidenceFigures: 0` on all five runs, with `gaps: null`, while the model was plainly receiving
the evidence: the same run's Symbyax answer names the Par Health labeling and the absence of a
Symbyax label, which is information only the evidence block carries.

So the unsourced check has been comparing answers against the clinician's NOTE ALONE. Every
finding it produced is void, including the "1 of 14" that looked like an improvement.

The capture assigned `window.TBP_LAST_EVIDENCE` in the Scribe and read it in the harness. Rather
than reason about which window a function published to the top frame sees, it is now a module
variable in the same scope as both, which removes the question instead of answering it.

**The masking was worse than the bug.** Figures that are small integer multiples of a note figure
were reported as `computed` and hidden. Concerta's 72 is 36 x 2. Symbyax's 12 and 50 are 6 and 25
doubled. So the two most important cases were silenced by a heuristic added to reduce noise, and
the report looked cleaner each round while measuring less. Computed figures are now shown, not
suppressed.

### What has to be established next, and not assumed

The evidence block reaches the model. Whether the POPULATION INDEX is inside it is a different
question, and the two need different fixes:

- index present and it tagged 54 as pediatric -> the index is not being used, and prompting is
  the wrong instrument for this
- index present and it tagged 54 as adult -> the nearest-population heuristic is wrong on this
  label's table
- index absent -> it is not being generated for this section at all

`tbpLastPopulationIndex()` returns exactly what the model was handed. Do not guess which of the
three it is.

## ROOT CAUSE: the question was never classified as a medication question

```
classifyQuestion('How high can I go on this?')  ->  needsMedicationFacts: false, classes: []
```

`evidenceChars: 1`, which is the single newline between an empty evidence block and an empty
reference block. **No retrieval ran. No labeling was ever requested.** Every Concerta answer in
this entire audit was the model answering a dose ceiling from memory.

The pattern required `how much|how high` followed within 40 characters by
`dose|dosing|mg|on (the|her|his|their)`. The clinician wrote "on **this**". That one word is the
whole defect.

"What is the maximum dose?" matched and retrieved correctly, which is why Pass A and the other
thirteen Pass B cases looked fine, and why this took nine rounds to find: the case that failed
was the one phrased the way a clinician actually speaks.

### Why it stayed invisible

**The classifier fails OPEN.** On a miss, `grounded` is false, so no evidence is fetched AND no
gap is recorded. The trail showed `gaps: null`, which reads as "nothing was missing" and actually
meant "nothing was asked for". A wrong number arrived looking exactly like a checked one.

Every instrument pointed elsewhere. Pass A said Concerta resolved, because it did, when asked.
`tbpEvidenceFigures` showed the section holds 54 and 72, because it does. Both were true and
neither was reached by the question being asked.

### Both halves fixed

1. The dosing patterns now cover how the question is actually asked: "how high can I go on
   this", "can I go up", "room to increase", "how far can I push", "bump it up". Tests pin the
   other direction too, since widening a phrase list until everything is a medication question
   is its own failure.

2. **A miss can no longer pass silently.** After an answer comes back with no evidence block, any
   dose figure in it that is not in the clinician's own note is reported as a gap:
   *"this answer states dose figures that were NOT checked against product labeling."* A phrase
   list will always miss some phrasing. What it must not do is fail open. The check is after the
   fact on purpose: adding a disclaimer to every question in an encounter that has medications
   would be noise on the ones that never mention a dose.

### What this invalidates

Every conclusion in this document about Concerta answers. The population split, the figure
index, and the practice-figure rule were all evaluated against a case that was never grounded
in the first place. They may work. This audit has not shown it.
