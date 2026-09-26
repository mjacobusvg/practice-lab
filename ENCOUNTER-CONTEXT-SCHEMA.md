# Encounter Context: the schema, and where every field comes from

**Step 1 SHIPPED 26 Sept 2026 in `ai-scribe-practice.html` (build ambient-148-sub).** The rest of
this document is the design work that preceded it; the "Step 1 as built" section at the bottom
records what actually landed and how it differs from the proposal. The rule set before this: build the structure from existing
application state, not by re-parsing prose. So every field below names the variable that
populates it, and the fields with no such variable are called out rather than quietly filled by
an extractor.

## The headline: the medication list has no source

> **Stale as written, kept for the record.** The original analysis called the medication list the
> single gap. Working through it turned up six more structured fields with no source, listed under
> "Fields with NO structured source" below and now declared in `ctx.unresolved`. The medication
> list is still the most consequential of them, and still the one an extraction layer would sneak
> back in through, but it is not the only one.

Most of the minimal schema already exists as real state somewhere. **Current medications, with
dose and formulation, exist only as free text the clinician typed.** There is no med-list widget
anywhere in the Scribe. Pretending otherwise is how an extraction layer sneaks back in.

## Fields that map cleanly to existing state

| Field | Source | Shape today |
|---|---|---|
| `visitType` | `visitType` global | `'new_eval'` / `'follow_up'`. Already clean. |
| `diagnoses` | **`pfState`** at the `clin_dx` preflight question | **Clinician-CONFIRMED selections.** ~~Lives for one function call and is flattened into a prose string.~~ **Step 2 (below): captured into `tbpEncounterState.preflight.diagnoses` at Generate.** |
| `psychotherapy` | `pfState` modality + `timeChoice` + `code` | Clinician-selected. Same flattening. |
| `clinicalDecisions` | `pfState` `clin_*` answers | Clinician-selected. Same flattening. |
| `note.sections` | `wnSections` | Already an object: `{note, checklist, guide, interview, transcript, coach, screeners}`. |
| `prep.checklist` | `prepChecklist` | Already an array of strings. |
| `prep.snapshot` | `prepSnapshot` | String, but a discrete artifact. |
| `sources` | `tbpSources` | Already objects: `{id, name, text, review, chars, pasted, truncated}`. |
| `framework` | `adhdFw` | Already parsed into `{EVIDENCE, ESTABLISHED, GAPS, COMPETING, QUESTIONS}`. |
| `priorNote` | `#context` | String, but explicitly the prior signed note. Discrete. |
| `drafted` | `#hpi-out`, `#assess-out`, `#therapy-out`, `#plan-out` | Four discrete outputs. |

**The recurring pattern: `pfState` is the richest structured clinical state in the app and it is
thrown away.** The clinician's confirmed diagnosis list, their modality choice, their
contributing-factor selections are all real selections that get turned into sentences and
forgotten. Preserving `pfState` into encounter context is most of item 0 by itself.

## Fields with NO structured source

| Field | Why it is missing |
|---|---|
| `medications.current` | Free text in the working note or the prior-note box. No widget, no list. |
| `medications.recentChanges` | Same. "PCP started fluoxetine two weeks ago" is a sentence. |
| `adverseEffects` | Same. "racing heart feeling in the afternoons" is a sentence. |
| `vitals`, `labs` | Same. |
| `screeners.completed` | `window.TBP_SCALES` is a structured catalogue; a scale *inserted into the note* becomes text, and a *scored* one is not captured at all. |

## How to fill the medication list without an extraction layer

The repo already solved this exact problem, and Michael already named the pattern in his own
words this month: *"it should be bringing it to them as a question in PREFLIGHT."*

That is the `clin_dx` card. When the system had no diagnosis list, it did not infer one and it
did not give up: **it detected the absence, asked the clinician, and the answer became
authoritative structured data.**

Apply the same three steps to medications:

1. **Detect candidates deterministically.** We own a 190-drug name-and-brand dictionary already:
   `MEDICATIONS` in `pm-interaction-checker.html`, with `brand` on every entry. Matching note
   text against it is a lookup, not clinical NLP, and it is the same "detect cheaply" rule
   `CLINICAL-OS-STRATEGY` already sets.
2. **Ask the clinician to confirm.** Names, doses, formulation. Pre-filled from what was
   detected, editable, with an "add one it missed" row.
3. **The confirmed list is the fact.** Not an inference, not an AI summary. The clinician said
   it, the same way they say the diagnosis list.

This is better than extraction in a way that matters beyond accuracy: **Adderall IR and
Adderall XR stop being a parsing question and become a thing the clinician saw and confirmed.**

## Proposed shape

```js
{
  visitType: 'follow_up',
  medications: {
    current: [ { rawName, normalizedName, rxcui, dose, route, formulation,
                 confirmedBy: 'clinician', detectedFrom: 'working_note' } ],
    changes:  [ { medication, change: 'started'|'stopped'|'increased',
                  dose, timing, prescriber, confirmedBy } ]
  },
  diagnoses:   [ { text, code, confirmedBy: 'clinician', source: 'preflight' } ],
  adverseEffects: [ { symptom, relationship, sourceType: 'patient_report' } ],
  screeners:   [ { id, name, score, administered } ],
  psychotherapy: { modality, code, minutes },
  clinicalDecisions: [ { question, answer, confirmedBy: 'clinician' } ],
  note: { sections: {...}, drafted: {...} },
  prep: { snapshot, checklist },
  sources: [ { id, name, kind, review } ],
  framework: { ... },
  results: { }          // what capabilities established, written back. See below.
}
```

## Distinctions the schema must not collapse

Each one has already bitten us this month:

- `confirmedBy: 'clinician'` vs `'detected'` vs `'inferred'` — the whole fabrication problem
- `sourceType: 'patient_report'` vs `'observed'` — "racing heart feeling" became "afternoon tachycardia" in a drafted note on 26 Sept
- `current` vs `changes` vs historical trials — a five-day Concerta trial is not a current medication
- `formulation` as its own field — IR and XR resolve to different labels and different doses
- today's encounter vs carried-forward history — the entire carry-forward rule set

## The return leg

`results` is where a capability writes what it established, so it is available later without
retyping: the interaction check that was run and what it found, the monitoring implication of a
stimulant change, a scored screener. `CLINICAL-OS-STRATEGY`'s **remember** step. Nothing reads it
on day one; the field exists so the second consumer has somewhere to put its answer.

## Structure of the change

```js
getEncounterContext()        // canonical structured object, built from state
renderCaseContext(ctx)       // the existing prose, rendered FROM the object
tbpCaseContext()             // compatibility wrapper: renderCaseContext(getEncounterContext())
```

Existing callers keep working unchanged. New capabilities read the object. The prose is a view,
never a source.

## Order

1. `getEncounterContext()` over the fields that already have state. No medication list yet, and
   no new UI. Purely a refactor with a compatibility wrapper.
2. The medication confirmation card, modelled on `clin_dx`, filling `medications`.
3. Discern reads `ctx.medications.current` and calls the evidence service.
4. Interaction Interpreter reads the same array. Second consumer, and the proof the service is
   not Discern-shaped.
5. Both write into `results`.

Step 1 touches no clinical behaviour and is independently verifiable: the prose it renders should
be byte-identical to what `tbpCaseContext()` produces today.


---

# Step 1 as built (26 Sept 2026)

`ai-scribe-practice.html:4156`. Three functions where there was one:

```
getEncounterContext()   ->  the canonical object, read from application state
renderCaseContext(ctx)  ->  the prose view every clinical prompt already consumes
tbpCaseContext()        ->  renderCaseContext(getEncounterContext())   // unchanged signature
```

The direction is enforced one way: **application state -> context -> prose.** Never prose ->
reconstructed context. The prose is a view. The moment anything parses it back, a wording change
becomes a silent clinical change.

## What it returns

| Field | Populated | Notes |
|---|---|---|
| `visitType` | yes | `'new_eval'` / `'follow_up'` / `null` |
| `note.text` | yes | the authoritative working note |
| `note.from` | yes | `'focus'` / `'sections'` / `'raw'` / `'none'` — which branch won |
| `drafted.{hpi,assessment,therapy,plan}` | yes | four addressable outputs, not one blob |
| `priorNote` | yes | `#context` |
| `prep.snapshot` | yes | string |
| `prep.checklist` | yes | array, **copied** so a consumer cannot mutate app state |
| `sources[]` | yes | FULL text, unfiltered and uncapped |
| `framework` | yes | `adhdFw` |
| `unresolved.*` | declared | seven named gaps, see below |
| `results` | empty | the return channel; nothing writes to it yet |

Two decisions worth keeping straight:

**`note.from` is part of the contract.** In sections mode the plain `#focus-note` is hidden but
not cleared, so `focus-note || raw` reads a stale copy of a note the clinician can no longer see.
The selection rule is preserved exactly as it was, and now it reports which branch it took,
because a consumer reading a med list off the visible panels needs to know which panels those are.

**`sources[]` holds full text; the renderer applies the review-preferred rule and the 14,000
character cap.** Those are rendering decisions (don't resend a 35-page neuropsych report to a
model on every question). A deterministic consumer may well want the whole document, so the
filtering does not happen in the context.

## What it deliberately does NOT do

`unresolved` names seven gaps as strings rather than leaving them absent, so the next person finds
a declared gap instead of discovering an empty field: `medications`, `medicationChanges`,
`adverseEffects`, `vitals`, `labs`, `screenersCompleted`, `diagnoses`.

**`pfState` is still discarded, and that is the biggest remaining gap.** The table above calls it
the richest structured clinical state in the app: the clinician's CONFIRMED diagnosis list,
modality and contributing-factor selections, which live for one function call and are flattened
into a sentence. Capturing it means changing the preflight handler, which is a behavior change,
not a refactor. Step 1 was scoped to prove the shape is safe. `pfState` is the obvious next step.

No extraction layer was added. Nothing parses the note for a med name. That is the whole point:
the medication list has no structured source, and inventing one by regexing prose is the failure
mode this work exists to avoid.

## Why the test is the deliverable

`tests/encounter-context.test.js` extracts the **actual pre-refactor `tbpCaseContext()`** from
commit `9b6e832` with `git show`, runs it and the new pair against the same stubbed DOM, and
asserts `{text, have}` is byte-identical: 52 hand-built branch cases (every working-note branch,
every drafted subset, prep with and without a checklist, sources at 13,999 / 14,000 / 14,001
characters, review-preferred, numbering that skips unused records) plus 4,000 randomized states.
4,052/4,052.

That string is the case context for Discern, prep, the ADHD framework builder and the mid-visit
delta. A one-character change to it is a change to clinical output that no visible test catches.
The regression is not a formality; it is the reason this refactor is safe to ship.

Re-run it with `node tests/encounter-context.test.js`. It is pinned to the pre-refactor commit,
not `HEAD`, so it keeps working after this lands.


---

# Step 2 as built (26 Sept 2026): the backing store

Step 1 left a defect rather than a gap. `getEncounterContext()` builds a fresh object every call,
so the `results: {}` it returned could not be the "remember" channel it was documented as: a
capability writing an interaction result into a snapshot would lose it on the next call, silently
and with no error. Shipping the medication card on top of that would have built the next feature
on a channel that drops writes.

## The split

```
existing app state (#raw, wnSections, tbpSources, prepSnapshot, adhdFw, ...)
         +
tbpEncounterState            <- the mutable store: things with no other home
         |
         v
getEncounterContext()        <- a READER. assembles, never stores.
         |
         v
canonical snapshot (deep copy)
```

`getEncounterContext()` stays an assembler. A test asserts it never assigns into the store.

## What lives in the store, and what deliberately does not

```js
tbpEncounterState = {
  preflight:   { confirmedAt, diagnoses: [], clinicalDecisions: [], psychotherapy: {} },
  medications: { current: [], changes: [] },     // home exists, no writer yet
  screeners:   [],                               // home exists, no writer yet
  results:     { interactions: [], monitoring: [], discern: [] }
}
```

**Only things with nowhere else to live.** The working note stays in `#raw` / `wnSections`, the
framework stays in `adhdFw`, prep stays in `prepSnapshot` / `prepChecklist`. Copying those in
would create two sources of truth for one fact, which is worse than having none.

## `pfState` is captured, and it is the first user of the pattern

`tbpRecordPreflight()` runs from the preflight **Generate** handler, which is the moment the
clinician confirms, and runs **before** `generateNote()` so a failed generation does not discard a
confirmation that really happened. It writes the confirmed diagnosis list, each `clin_*` decision
with its selections, and modality/code/time.

The prompt-facing `clinicalDecisions` array that drives the note is **untouched**. The capture is a
parallel read of the same clicks, not a rewrite of how the note is generated, which is why the
prose regression still passes byte-for-byte.

## Reload recovery

The store is part of the crash-recovery draft: `collect()` writes `enc`, `hasContent()` counts it
(so confirming preflight before typing keeps a draft on its own, as a framework already did),
`tbpRestoreDraft()` rebuilds it, and `clearVisit()` plus "Delete recovered draft" reset it.

`tbpEncounterRestore()` shape-checks instead of trusting: a restore feeds whatever is in
localStorage directly into clinical state, and a truncated or hand-edited key must not leave a
consumer calling `.length` on a string. Unknown keys under `results` are preserved, so a
capability added after a draft was saved does not silently lose its output on reload.

## Tests

`tests/encounter-state.test.js`, 20 checks. The save/reload tests run the **real crash-recovery
IIFE extracted from the page**, not a reimplementation: `window.tbpSaveDraft()` into a stub
localStorage, then a fresh environment seeded with it running `window.tbpRestoreDraft()`, which is
what a refresh does. A reimplementation would pass while the shipped path stayed broken.

They cover the four properties that matter: a confirmation survives the function that made it; a
**fresh** snapshot still carries it; it survives save and reload; and mutating a snapshot cannot
write back into the store (pushing, overwriting and splicing at every level, including nested
`clinicalDecisions[0].selections`). Plus corrupt-blob restores, a pre-feature draft with no `enc`
key, and source-level assertions that the page actually wires all of this up.

`tests/encounter-context.test.js` still passes 4,052/4,052: no clinical prose changed.

## Next, in order

See "Step 3" below for the result contract, then the build order at the end of this document.


---

# Step 3 as built (26 Sept 2026): the result contract

Established **before** any capability writes, because it is far easier to bake into the contract
than to retrofit once five capabilities depend on it.

## The bug it prevents

```
1. meds are Adderall XR 20 mg + fluoxetine 40 mg
2. the Interaction Interpreter runs and writes its findings
3. fluoxetine is stopped
4. the old findings are still sitting in encounter state
5. Assessment/Plan reads them as describing the current regimen
```

Nothing errors. The note is wrong. `results` therefore means **"this capability was run against
these inputs at this point in the encounter"**, never "this is true about the patient".

## Shape

```js
tbpRecordResult('interactions', {
  inputs: { medications: [...] },        // what it was computed FROM; drives staleness
  data:   [ ...findings... ],            // what it established
  meta:   { evidenceVersion: 'spl-2026-03' }   // provenance; does NOT affect staleness
});
// stored as: { id, capability, inputs, inputCanon, fingerprint, data, meta,
//              createdAt, reviewed, reviewedAt }
```

## Staleness is evaluated on READ, not by the consumer

`getEncounterContext()` stamps `status` on every result it hands out:

| status | meaning |
|---|---|
| `current` | the declared inputs are unchanged since the capability ran |
| `stale` | they changed; rerun it, or do not rely on it |
| `unknown` | it cannot be verified, so it must **not** be treated as current |

This is deliberate. If checking were the consumer's job, the failure mode is a consumer that
forgets, and that failure is silent and clinical. **Forgetting must not be possible.**

`unknown` is the fail-closed default: no declared inputs, an empty inputs object, an input name
this build cannot resolve, or a missing canon all read `unknown` rather than `current`.

## Design decisions worth keeping straight

**A medication set is a set.** Canonicalization sorts arrays and object keys and normalizes case
and whitespace, so reordering the same two drugs, or `ADDERALL  XR` vs `Adderall XR`, is not a
regimen change and does not force a spurious rerun.

**Ambiguity errs toward stale.** `20mg` and `20 mg` compare as different. Rerunning is cheap; a
wrong `current` is not.

**Comparison is on the canonical string, never the hash.** `fingerprint` is an 8-hex display tag
for provenance. A hash collision deciding staleness would show a stale result as current, so a
test asserts `tbpResultStatus()` does not reference the fingerprint at all.

**The canon is stored, not recomputed.** If the canonicalizer changes in a later deploy, an old
record reads `stale`, not silently `current`.

**Only declared inputs invalidate.** A result declaring `{medications}` is unaffected by a
diagnosis change; one declaring `{medications, diagnoses}` is invalidated by either.

**Superseding keeps history.** Rerunning appends. The old record stays, visibly stale, so
"what did I check, against what, and when" is answerable.

**Reviewing does not launder staleness.** A clinician signing off on a finding does not make it
true of a regimen that changed afterwards. `reviewed: true` and `status: 'stale'` coexist.

**Snapshots cannot write back**, including the status stamp itself: a consumer cannot overwrite
its own staleness verdict.

`tests/result-contract.test.js`, 23 checks, including the exact five-step scenario above.

---

# Build order from here

1. **Medication confirmation** -> `tbpEncounterState.medications`. Lightweight: detect candidate
   meds from the authoritative encounter material, show a compact confirm/edit list, and make the
   confirmed list authoritative. **Not** a full reconciliation chore on every encounter. Force
   clarification only where it matters: formulation unclear, dose missing *and* the question
   depends on dose, current vs historical ambiguous, two sources conflict, or the clinician is
   about to run a medication-specific capability.
2. **Ground Discern.** Reads `getEncounterContext().medications`, pulls the relevant DailyMed/
   RxNorm sections through the evidence service in `netlify/functions/_lib/rx-evidence.js`,
   receives them as a separately labeled block, and applies the anti-collapse rules. **This closes
   the original defect** and is the reason for the whole detour, so it comes before any further
   integration.
3. **Interaction Interpreter as the second consumer.** Reads the same structured medication state
   instead of asking for re-entry, and writes back through `tbpRecordResult()` with the medication
   set as its declared input. Second consumer is what proves this is shared architecture rather
   than a medication pipeline built specially for Discern.

**Not yet:** Monitoring, Letters, Chart Audit, Coder. Prove it with two consumers first.

## Acceptance test for step 2

Ask Discern: *"What is the maximum Adderall dose I can go to, and is that combination
contraindicated?"* against Adderall XR 20 mg + fluoxetine 40 mg. Inspectable:

- **Medication state** — Adderall XR 20 mg + fluoxetine 40 mg
- **Evidence retrieved** — the exact SPL sections
- **Source and version** — visible in provenance
- **The answer** — keeps adult recommended dose, pediatric maximum and adult studied doses
  distinct, and distinguishes an interaction from a contraindication

Getting it right *because we can see exactly what facts it reasoned from* is the bar. Getting it
right by luck is not a fix.
