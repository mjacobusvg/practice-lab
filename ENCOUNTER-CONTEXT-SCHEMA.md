# Encounter Context: proposed minimal schema, and where every field comes from

**Proposal only. No code written.** The rule set before this: build the structure from existing
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
