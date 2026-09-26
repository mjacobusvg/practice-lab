# Clinical OS integration: what is actually built

**26 Sept 2026.** `ROADMAP.md` §A lists a nine-item build order for turning the tools into one
workflow. This checks each item against the code rather than against the doc's own claims. The
short version: **one item is done, three are partly done, five are untouched, and the one that
everything else depends on is half-built in the wrong shape.**

**UPDATE 26 Sept 2026, later the same day:** item 0 is no longer in the wrong shape. Step 1
shipped to practice (ambient-148-sub): `getEncounterContext()` returns the canonical object,
`renderCaseContext()` produces the prose, `tbpCaseContext()` is a wrapper, and 4,052 regression
checks prove the prose is byte-identical to the pre-refactor version. The remaining gap in item 0
is that `pfState` is still discarded and no capability writes to `ctx.results` yet. Row 0 below is
updated; every other row still stands.

**UPDATE 2, same day (ambient-149-sub):** that remaining gap is closed. `ctx.results` was not
actually a "remember" channel, because `getEncounterContext()` builds a fresh object every call and
a write into a snapshot vanished on the next one. `tbpEncounterState` is now the durable backing
store, `getEncounterContext()` reads from it and returns a deep copy, `pfState` is captured into it
at preflight Generate, and it participates in crash recovery. Item 0 is **done**. What remains is
writers (the medication card) and readers (the capability handoffs in rows 1-4), not foundation.

| # | Item | State | Evidence |
|---|---|---|---|
| **0** | **Encounter-context foundation** | **DONE** | `getEncounterContext()` (`ai-scribe-practice.html:4156`) returns a structured object; `renderCaseContext()` renders the prose view; `tbpCaseContext()` wraps the two and is byte-identical (`tests/encounter-context.test.js`, 4,052 checks). `tbpEncounterState` is the durable store for state with no other home, `pfState` is captured at preflight Generate, and the whole thing survives reload (`tests/encounter-state.test.js`, 20 checks against the real save/restore path). Remaining work is writers and readers, not foundation: no med-list widget exists, and no capability writes to `results` yet. |
| 1 | Scribe -> Chart Audit + Coder | **0%** | A `<option>` in the Clinical tools dropdown. `window.open(url,'_blank')`. No context passes. |
| 2 | Scribe -> Monitoring Protocol | **0%** | Same dropdown, same new tab, retype everything. |
| 3 | Scribe -> Interaction Interpreter | **0%** | Same. The 190-drug engine is one click and a full re-entry away. |
| 4 | Scribe -> visit outputs / Letter engine | **0%** | Same. |
| 5 | Screeners <-> Encounter Context | **~60%** | Real: `scales-data.js` is loaded by both Scribes, and `scale-select-focus` inserts a scale into the working note. Data is genuinely shared. Missing the return leg: a scored scale does not flow back as encounter state. |
| 6 | Therapy Coach -> Psychotherapy note | **DONE** | `initTherapyCoach` -> `wnSections.coach` -> `runTherapy()` -> the psychotherapy add-on in the signed note. An end-to-end capability handoff that already works. |
| 7 | Pre-visit -> live-visit continuity | **~70%** | `prepSnapshot` carries the rundown from prep into the visit, survives reload, and is pinned above the note. The ADHD Framework extends it. |
| 8 | Contextual "Relevant next steps" | **0%** | Zero references. |

## The surface already exists and nobody noticed

`CLINICAL-OS-STRATEGY.md` specifies the first integrated surface as one row:
`Check: Interactions · Monitoring · Safety · Scale · EPS · Discern`.

**The CASE TOOLS row is that row.** It was built for the ADHD Framework without being recognised
as the Clinical OS surface:

```
CASE TOOLS   ⚙ Add to this visit  📄 Review outside records  🧠 Discern  🧠 ADHD Framework
```

Two of the six capabilities are in it. The other four exist as finished engines behind a
dropdown that opens a new tab. The mid-visit card (`tbpAdhdDelta`) is also already the
"capability answers without taking over the screen" pattern the strategy asks for.

## What this means

The roadmap's own line holds up: **"The work is plumbing, not construction."** Item 6 proves a
capability handoff works end to end. Items 1-4 are four instances of the same missing pipe.

And item 0 is the reason they are all stuck. `tbpCaseContext()` gathers the right material and
hands it to a model as prose. Everything downstream that is deterministic needs it structured:

```
meds:        [{name:'Adderall XR', dose:'20 mg', route:'PO'}, {name:'fluoxetine', dose:'40 mg'}]
changes:     [{drug:'fluoxetine', event:'started', by:'PCP', when:'2 weeks ago'}]
symptoms:    ['afternoon palpitations on prior stimulant']
dx:          ['ADHD','depression']
```

Give the Interaction Interpreter that and it runs. Give it a paragraph and it cannot.

## Where the medication work fits

It is not a Discern feature. **It is the first shared Clinical OS service**, and it has two
consumers on day one: Discern (reasoning) and the Interaction Interpreter (deterministic). The
Monitoring Protocol and LAI follow. That is what `FUTURE-OPPORTUNITIES.md` means by "build one
dataset, not seven tools", and it only works if item 0 produces structure.

## Proposed order

1. **Structured encounter context.** Extend `tbpCaseContext()` to emit a structured object
   alongside the prose it already produces. Nothing breaks: the prose consumers keep working.
2. **Medication service consumes it.** Drug identities come from the structured med list rather
   than from re-parsing prose in each tool. This is also the answer to "browser or Lambda":
   extraction is a property of encounter context, not of Discern.
3. **Discern grounded**, as the bug we found demands.
4. **Interaction Interpreter as the second consumer** — roadmap item 3, and the cheapest proof
   that the service is shared rather than Discern-shaped.
5. Then items 1, 2 and 4, which are the same pipe again.

Do not migrate four tools onto a shared file before step 3 works. The shape is better designed
after it has survived a real question than before.
