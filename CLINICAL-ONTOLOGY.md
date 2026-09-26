# Clinical ontology and invariants

**What this is.** The meaning of the clinical state the Scribe holds, and the rules that must
survive any implementation. Not an architecture doc (`ENCOUNTER-CONTEXT-SCHEMA.md` covers shape)
and not a strategy doc (`CLINICAL-OS-STRATEGY.md` covers direction). This is what the fields
*mean* and who is allowed to establish them.

**Why it exists.** These decisions were made several times over in conversation and then lived
only in chat history and code. Every session re-derived them, and re-derived some of them wrong.
An implementation that invents its own ontology as it goes will produce a system that is
internally consistent and clinically wrong, and the tests will pass.

**How to use it.** A session implementing a clinical capability reads this first and implements
*against* it. If the implementation turns out to need something this document forbids, that is a
signal the ontology is incomplete, not permission to route around it: raise it, decide it, update
this file, then build. Recording the fork is the point.

## How each claim below is known

Nothing here is binding because an AI wrote it down. Every claim carries its provenance:

| tag | meaning |
|---|---|
| **ENFORCED** | true in code now, with the citation. Changing it means changing code and tests. |
| **DECIDED** | explicitly decided by Michael in the work that produced this, not yet enforced anywhere. Binding. |
| **INFERRED** | recovered from existing behavior by reading the code. **A description, not an invariant.** Do not treat as a rule until it is confirmed and re-tagged. |
| **OPEN** | a real semantic fork. Not decided. Do not resolve it by picking whichever reading makes the code easier. |

## The four axes

Every clinical concept here is described on four axes, because most of the failures have not been
about what a thing *is*. They have been about **who is allowed to say it is true**.

- **Identity** — what thing is this, specifically enough to act on?
- **State** — what is its status right now?
- **Source** — where did the assertion come from?
- **Authority** — what is permitted to establish or change the canonical value?

---

# 1. The universal invariants

These bind across every concept. They are the ones capable of corrupting downstream clinical
reasoning if violated.

### I-1. A model output may PROPOSE a state change. It never BECOMES encounter state because a model produced it. **DECIDED**

Extraction, inference, summarization and reasoning all produce candidates. Canonical clinical
state changes only through an act of authority (see §5). This is the general form of the
medication rule and it will matter far beyond medications: a suggested diagnosis, an inferred
adverse effect, a proposed dose change, an extracted vital.

Corollary: a capability may write into `tbpEncounterState.results` freely, because a result is
explicitly a record of what a capability established, not an assertion about the patient (§4).
It may not write into `medications.current` or `preflight.diagnoses`.

### I-2. State flows one way: application state to canonical context to rendered prose. Never back. **ENFORCED**

`getEncounterContext()` assembles, `renderCaseContext()` renders, `tbpCaseContext()` wraps
(`ai-scribe-practice.html`). Prose is a view. The moment anything parses prose back into state, a
wording change becomes a silent clinical change.

> **Wrong model:** the case context *is* the prose string we already generate for the model.
> **Why wrong:** a paragraph is not a medication list. Nothing deterministic can consume it, so
> every capability re-derives the same facts, and each re-derivation is a fresh chance to get
> them wrong. It also makes prompt wording load-bearing for program behavior.
> **Correct model:** canonical structured state, from which each consumer derives the view it
> needs, prose being one such view.

### I-3. Unresolved means unresolved. An inferred value is worse than an empty field. **ENFORCED**

`ctx.unresolved` names each gap as a string rather than leaving the field absent, so the gap is
visible instead of being discovered by whoever expected a value. A field with no authoritative
source stays empty and says why.

> **Wrong model:** fill the gap with the best available inference so downstream code has
> something to work with.
> **Why wrong:** downstream cannot tell an inference from a fact, and an inference presented as
> a fact is exactly how a wrong number reaches a clinical decision. An empty field fails loudly.
> **Correct model:** declare the gap. A capability that needs the value asks for it (§5.3) or
> declines to answer.

### I-4. Fail closed. Where a distinction cannot be verified, take the safer reading. **ENFORCED**

Instances in code: a capability result whose inputs cannot be verified reads `unknown`, never
`current`. A medication cue that is ambiguous between past and present resolves to past, because
wrongly listing a stopped drug as current is the dangerous direction. A medication mention with
no clear status renders unselected rather than pre-set.

### I-5. Specificity that exists in the source is never destroyed. **ENFORCED**

If the clinician wrote "Adderall XR", the system holds "Adderall XR". A coarser representation
may be derived and carried *alongside*, never *instead*. Generalizing to make a lookup convenient
is how the wrong label gets used.

### I-6. Two distinct kinds of test, and they are not substitutes. **DECIDED**

- **Regression tests** answer: did we change existing behavior? (`tests/encounter-context.test.js`
  proves a refactor is byte-identical against the pre-refactor commit.)
- **Semantic/invariant tests** answer: does the behavior preserve the clinical distinctions we
  intend? (`tests/result-contract.test.js`, `tests/rx-detect.test.js`.)

A green regression suite says the refactor did not alter behavior. It says nothing about whether
the preserved behavior was the right representation. Do not report the first as evidence of the
second.

---

# 2. Encounter state

**Identity.** One patient encounter, in one Desk tab. Keyed per tab (`tbp_draft_<slot>`).

**State.** Two stores with different owners:

| | holds | authored by |
|---|---|---|
| existing app state | working note, drafted outputs, prior note, prep, outside records, framework | see §6 |
| `tbpEncounterState` | confirmed preflight, medications, screeners, capability results | confirmation acts and capabilities |

**ENFORCED:** `tbpEncounterState` holds **only what has no other authoritative home.** The
working note lives in `#raw` / `wnSections`; the framework lives in `adhdFw`. Copying those in
would create two sources of truth for one fact, which is worse than having none.

**Authority.** `getEncounterContext()` is a reader and never assigns into the store (asserted by
test). Snapshots it returns are deep copies, so a consumer cannot write back through a value it
believes is a read-only view.

**ENFORCED:** structured clinical state participates in crash recovery. Structured state that
vanishes on refresh while the prose note survives is a persistence bug, not a design choice.

### The authoritative working note

**ENFORCED.** Precedence: the focus overlay's plain note when it is open, visible and non-empty;
otherwise the section panels; otherwise `#raw`. `ctx.note.from` reports which branch won.

> **Wrong model:** `focus-note || raw`.
> **Why wrong:** in sections mode `#focus-note` is hidden but not cleared, so this reads a stale
> copy of a note the clinician can no longer see, and reasons about a version that no longer
> exists on screen.

---

# 3. Medication

The concept that has cost the most, and the one that produced a hallucinated maximum dose.

## 3.1 Identity

**ENFORCED.** Prescribing identity is preserved verbatim from what the clinician wrote, including
the release-form modifier. Pharmacologic identity exists alongside it as a separate mapping.

> **Wrong model:** normalize a medication to its ingredient or common family upstream, and use
> that as the clinical identity.
> **Why wrong:** formulation and release mechanism change dosing limits, interaction
> interpretation, and prescribing decisions. "Adderall XR" resolved to generic "Adderall"
> retrieves the wrong label, and the wrong label has a different maximum. This is not
> hypothetical: it is the defect that started this work.
> **Correct model:** prescribing identity (brand, formulation, route, strength, RxCUI) is
> preserved and is what grounding resolves against. Pharmacologic/interaction identity
> (`interactionKey`) is a separate field carried alongside, for the deterministic checker, which
> correctly operates at the ingredient level because CYP and serotonergic relationships do.

**ENFORCED.** `MEDICATIONS` in `pm-interaction-checker.html` is a **candidate-detection vocabulary
and interaction-key map. It is not an identity source.** It stores `brand: "Ritalin/Concerta"` in
one string and `brand: "Adderall"` with no IR/XR distinction, correctly for its own purpose.
`rx-vocabulary.js` splits sibling brands into distinct terms sharing one key.

**ENFORCED.** `rxcui` is null and `identityStatus` reads `unresolved` until the RxNorm/DailyMed
layer resolves it. A guessed RxCUI picks a label, and a wrong label is the whole bug.

**OPEN.** Compounded, combination and dose-form-ambiguous products. "Suboxone 8 mg/2 mg" parses
as a combination dose today, but nothing decides whether a combination product is one medication
or two for interaction purposes. Not forced yet; will be forced by the Interaction Interpreter.

## 3.2 State

**ENFORCED today:** `current` | `historical`, plus a candidate-only `unclear` that cannot be
confirmed as itself.

**OPEN.** `historical` is currently one bucket and clinically it is several. "Previously failed
Concerta after five days" and "stopped lithium when she became pregnant" and "never started the
sertraline the PCP sent in" are different facts with different implications for what to try next.
The detector collapses all past-tense language into one state. **This needs a decision before any
capability reasons over medication history**, because "failed" is the one a prescriber acts on.

**OPEN.** `medications.changes` has a home in the store and no writer and no definition. It could
mean: a change proposed today, a change made today, or a change since the last visit. These are
three different things and at least two of them are clinically useful. Undefined, so unused.

**INFERRED, not binding.** Patient-reported use, prescribed-but-unverified, and confirmed-current
are currently one state (`current`). The distinction is recognized elsewhere in the system (the
MSE prompt separates observed from reported; `unresolved.adverseEffects` notes that
patient-reported is not an observed finding) but is not modeled here. Flagging as a probable gap,
not asserting a rule.

## 3.3 Source

**ENFORCED.** Candidates carry the segment they came from (today's note, drafted HPI, drafted
plan, last visit) and the sentence that justified the proposed status.

**ENFORCED.** Outside records are **not** scanned for medications. A drug named anywhere in a
40-page neuropsych report is the weakest possible signal for a current-medication list.

**ENFORCED.** A drug appearing only in the prior note is downgraded to `unclear` whatever that
note's tense was. Last visit's present tense is not today's present tense.

**ENFORCED.** Status cues are sentence-scoped. An earlier version leaked across the boundary and
filed an active prescription as historical because the *next* sentence said "previously stopped".

## 3.4 Authority

> **Wrong model:** medication-looking text can populate `medications.current`.
> **Why wrong:** "stopped fluoxetine six months ago" and "previously failed Concerta" are
> medication-looking text. A system that treats extraction as establishment invents a regimen,
> and every capability downstream reasons confidently from it.
> **Correct model:** extraction generates **candidates with evidence**. Clinician confirmation
> establishes clinical state. These are different operations with different outputs.

**ENFORCED.** `tbpMedApplyConfirmation()` is the only path into `medications.current`. Every
record carries `confirmedBy` and `confirmedAt`. A row with no status is dropped, never defaulted.

**ENFORCED.** Confirmation is not reconciliation. The card opens only when a medication task asks
(`tbpMedConfirmationNeeded(purpose)`), goes quiet after one confirmation, and reopens only for a
new drug or for an ambiguity that matters *for the question being asked*: a missing dose only
when the question turns on dose, a missing release form only for a drug that has distinct ones.

> **Wrong model:** confirm the full medication list at the start of every encounter.
> **Why wrong:** it is a reconciliation chore, and the product thesis is that AI *reduces* the
> attention the clinician spends retrieving and checking. A form that appears whether or not it
> is needed spends attention rather than giving it back.

---

# 4. Capability results

**Identity.** A record of what one capability established, at one point, from particular inputs.

> **Wrong model:** `results` holds standing facts about the patient.
> **Why wrong:** meds are A + B, the interaction check runs and writes findings, B is stopped,
> and Assessment reads the old findings as describing the current regimen. Nothing errors. The
> note is wrong.
> **Correct model:** a result is scoped to the inputs it was computed from. Applicability is
> evaluated, not assumed.

**ENFORCED.** Each record stores the inputs it used, a canonical form of them, and a display
fingerprint. `getEncounterContext()` stamps `current` / `stale` / `unknown` on every result it
hands out.

**ENFORCED, and load-bearing:** staleness is evaluated **on read, by the context**, not by the
consumer. If checking were the consumer's job, the failure mode is a consumer that forgets, and
that failure is silent and clinical. Forgetting must not be possible.

**ENFORCED.** Only the inputs a result *declared* can invalidate it. A result declaring
`{medications}` is untouched by a diagnosis change; one declaring `{medications, diagnoses}` is
invalidated by either.

**ENFORCED.** Bookkeeping is excluded from the fingerprint via a projection applied to both
sides. Fingerprinting whole medication records made re-confirming an *unchanged* list mark every
result stale, which would have trained the clinician to ignore the staleness flag and destroyed
the only thing it is for. A quote or a timestamp is not a regimen change. A dose is.

**ENFORCED.** Reviewing does not launder staleness. `reviewed: true` and `status: 'stale'`
coexist: a clinician signing off on a finding does not make it true of a regimen that changed
afterwards.

**ENFORCED.** Superseding appends. The old record stays, visibly stale, so "what did I check,
against what, and when" remains answerable.

---

# 5. Source and authority

The axis most of the remaining risk lives on.

## 5.1 Who authored what

**INFERRED from code, offered as a map rather than a rule.** Everything in encounter context has
an author, and the system currently tracks this unevenly:

| artifact | authored by | confirmation gate |
|---|---|---|
| working note, prior note | clinician | n/a, it is their writing |
| ambient transcript | machine ASR (Azure) | none; appended to `wnSections.transcript` |
| drafted HPI / assessment / therapy / plan | model | none; clinician edits in place |
| pre-visit snapshot (`prepSnapshot`) | model | none |
| ADHD framework (`adhdFw`) | model | none |
| outside-record review (`d.review`) | model | none |
| which records feed reasoning (`useForPrep`) | clinician | the toggle is the act |
| confirmed diagnoses (`preflight.diagnoses`) | clinician | preflight Generate |
| confirmed medications | clinician | the medication card |
| capability results | capability | `reviewed` flag, optional |

**OPEN, and the most consequential open item in this document.** Several model-authored
artifacts re-enter the model's context as input, with no marker that they are model-authored
beyond a prose label. Specifically:

1. **`adhdFw.ESTABLISHED`** is a model synthesis in a field literally named ESTABLISHED. Nothing
   stops a future capability reading it as established fact.
2. **`d.review` is preferred over `d.text`** when rendering an outside record, so a model summary
   substitutes for the source document in what the next model sees. The tradeoff (not resending a
   35-page report on every question) is real and was made deliberately. The semantic consequence
   (reasoning over a summary of a document while appearing to reason over the document) has not
   been.
3. **`drafted.*` cannot distinguish model output from clinician-edited text.** The renderer is
   honest about this, saying the clinician "may have edited it since drafting", which is an
   admission that the system does not know.

The question to decide: is there a general distinction between **working artifacts** (a rundown,
a framework, a draft, a summary: model-authored aids the clinician reads and uses) and
**assertions about the patient** (diagnoses, medications, findings), with I-1 biting only on the
second? That reading is coherent and probably right, but it has never been stated, and if it is
correct then several field names actively invite the wrong reading.

## 5.2 What may be hardcoded

Already decided and documented. See `CLINICAL-NOTE-GENERATOR-ARCHITECTURE.md` §0.3 and §0.3.1:
universal integrity and safety rules may be baked into a prompt; clinician preferences must come
from the Vault; the Assessment's reasoning standard is hardcoded and may not be weakened by a
saved preference, while length and voice may be. Not restated here.

## 5.3 Asking

**DECIDED.** A capability that needs a value it does not have asks for it through the
confirmation mechanism for that concept, or declines to answer. It does not infer it, and it does
not answer around it without saying so.

---

# 6. Confirmation

**Identity.** A discrete act by which a clinician makes something canonical.

**ENFORCED.** Two exist: the preflight **Generate** click (diagnoses, contributing factors,
modality) and the medication card's **Confirm** (medications). Both stamp who and when.

**ENFORCED.** Confirmation is capture, not re-entry. The clinician confirms or edits what the
system found. Requiring them to retype what is already on screen is a failure of the feature.

**ENFORCED.** Confirmation runs before the work that consumes it, so a downstream failure does
not discard a confirmation that really happened.

**OPEN.** There is no revocation and no expiry. A confirmation is good for the encounter. Whether
a long encounter, an interrupted one, or a resumed-after-reload one should ever re-ask has not
been decided.

---

# 7. What is deliberately not modeled yet

Declared so nobody mistakes absence for oversight. Each stays `unresolved` until it has a real
source and a real writer, per I-3.

| concept | status |
|---|---|
| adverse effects | free text. Patient-reported is not an observed finding, and that distinction is unmodeled. |
| vitals, labs | free text. No structured source. |
| scored screeners | `TBP_SCALES` is a catalogue of instruments. A scored result is not captured. |
| medication changes | home exists, no writer, no definition (§3.2) |
| psychotherapy modality | captured at preflight; not yet consumed by anything but the note |

---

# 8. Open forks, collected

The decisions this document could not recover, gathered for one pass. Ordered by how much damage
getting them wrong would do.

1. **Working artifact vs. assertion (§5.1).** Does I-1 bite on model-authored aids, or only on
   assertions about the patient? Field names currently invite the wrong reading.
2. **Medication history states (§3.2).** Is `historical` one state or several? "Failed" is the
   one a prescriber acts on, and it is currently indistinguishable from "stopped for an unrelated
   reason".
3. **Patient-reported vs. confirmed-current (§3.2).** One state today.
4. **`medications.changes` (§3.2).** Proposed today, made today, or since last visit?
5. **Summary substituting for source (§5.1.2).** Should a consumer be able to tell it is reasoning
   over a review rather than the document, and should some questions refuse the substitution?
6. **Confirmation lifetime (§6).** Does a confirmation ever expire within an encounter?
7. **Combination and compounded products (§3.1).** One medication or two?

---

## Maintaining this

Add to it when implementation pressure forces a decision, not before. An ontology written ahead
of the code is speculation; this one is worth having because each entry was paid for. When a
capability needs a distinction this file does not make, that is the signal: decide it, record it
with its wrong model, then build.

Re-tag **INFERRED** entries as they are confirmed or corrected. An inference left sitting long
enough starts to read like a rule, which is the failure this document exists to prevent.
