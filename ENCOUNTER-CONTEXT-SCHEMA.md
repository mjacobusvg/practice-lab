# Encounter Context: the schema, and where every field comes from

**Step 1 SHIPPED 26 Sept 2026 in `ai-scribe-practice.html` (build ambient-148-sub).** The rest of
this document is the design work that preceded it; the "Step 1 as built" section at the bottom
records what actually landed and how it differs from the proposal. The rule set before this: build the structure from existing
application state, not by re-parsing prose. So every field below names the variable that
populates it, and the fields with no such variable are called out rather than quietly filled by
an extractor.

## The headline: one field has no source, and it is the medication list

Everything else in the minimal schema already exists as real state somewhere. **Current
medications, with dose and formulation, exist only as free text the clinician typed.** There is
no med-list widget anywhere in the Scribe. That is the single honest gap, and pretending
otherwise is how an extraction layer sneaks back in.

## Fields that map cleanly to existing state

| Field | Source | Shape today |
|---|---|---|
| `visitType` | `visitType` global | `'new_eval'` / `'follow_up'`. Already clean. |
| `diagnoses` | **`pfState`** at the `clin_dx` preflight question (`:6753`) | **Clinician-CONFIRMED selections.** Real structured data that currently lives for one function call and is flattened into a prose string. |
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
