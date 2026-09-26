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

### I-1. Three layers, and authority is what moves information between them. **DECIDED**

The deeper distinction is not AI versus clinician. It is:

```
SOURCE MATERIAL                    what was said, written or recorded
  clinician note
  patient report
  outside record
  transcript
        |
        v   model may derive freely
DERIVED ARTIFACT                   an interpretation. storable, displayable, reasonable-over.
  record summary                   NOT a claim about the patient.
  prep snapshot
  ADHD framework
  draft assessment
  Discern reasoning
  capability result
        |
        v   requires authority (§6)
CANONICAL ENCOUNTER ASSERTION      what the encounter holds as true
  confirmed medication state
  confirmed diagnosis
  clinician decision
  confirmed or entered finding
```

**The rule:** a model output may become a stored **derived artifact** or capability result. It
may not establish a **canonical patient or encounter assertion** merely because the model
produced it.

So `prepSnapshot`, `adhdFw`, `d.review`, the drafted note and Discern's reasoning are all
legitimate. They are derived artifacts and they are allowed to exist, persist, be shown, and
feed further reasoning. What they may not do is silently become canonical.

A derived artifact may say *"the records support longstanding inattentive symptoms."* It may not
produce `diagnosis.ADHD = established`. That crossing requires the authority appropriate to that
assertion.

**ENFORCED:** `ctx.provenance` states each field's `layer` / `authoredBy` / `authority`, as data
rather than as prose, so a consumer can check instead of inferring from a field name. This
matters specifically because **`adhdFw.ESTABLISHED` is a heading inside a model synthesis** and
its name invites exactly the wrong reading. The UI may keep saying "Established" to the
clinician; nothing in code may treat the key as authoritative patient state.

**DECIDED, not yet done:** the framework's internal shape should carry its own
`artifactType: 'derived'` / `authoredBy: 'model'` / `authority: 'noncanonical'` rather than
relying on the context map alone. Deferred as a rename with real regression surface; the
provenance map closes the immediate hazard.

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

### External identity resolution is DERIVED, not clinician-confirmed. **DECIDED, ENFORCED**

The clinician confirms *"Adderall XR 20 mg, current"*. The system then maps that prescribing
identity to an RxCUI and an SPL Set ID. **Those are two different assertions with two different
authors**, and writing the mapping into the confirmed record would read as though the clinician
had confirmed an RxCUI. They did not.

```
CANONICAL ENCOUNTER ASSERTION      DERIVED EXTERNAL IDENTITY MAPPING
  Adderall XR 20 mg, current   ->    RxCUI 541878
  confirmedBy: clinician             SPL Set ID abc-123, version 41
                                     identitySource: RxNorm + DailyMed
                                     authority: noncanonical
                                     status: resolved | ambiguous | failed
```

**ENFORCED:** the mapping lives in `tbpEncounterState.derived.identity`, keyed by the prescribing
identity it was derived from. `medications.current[].rxcui` stays null.

There is a second reason beyond honesty: resolution is part of the medication fingerprint, so
writing an RxCUI into the canonical record after a lookup would mark every prior result stale
because a lookup ran. Nothing about the patient changed.

**ENFORCED:** if resolution is ambiguous it stays unresolved and **nothing is retrieved**. No
label is chosen, nothing is cached, and the gap is named in the prompt. Picking whichever
candidate lets the pipeline continue is how a pediatric maximum becomes an adult one.

**DECIDED:** a combination product is **one prescribing identity with multiple pharmacologic
components.** Suboxone 8/2 is one thing prescribed and one thing taken:

```js
{ rawName: 'Suboxone 8 mg/2 mg SL film', route: 'sublingual',
  components: [ { ingredient: 'buprenorphine', strength: '8 mg' },
                { ingredient: 'naloxone',      strength: '2 mg' } ] }
```

The Interaction Interpreter expands `components` when it needs pharmacologic logic; grounding
resolves the product. Same for compounded products: one product identity, components represented
individually **when known**. If the composition is uncertain it is `unresolved` (I-3). Do not
invent components.

**Status:** decided, not built. `components` has no writer; combination doses currently parse as
a single dose string. Build it when the Interaction Interpreter forces it.

## 3.2 State

**ENFORCED today:** `current` | `historical`, plus a candidate-only `unclear` that cannot be
confirmed as itself.

### Medication history is DIMENSIONS, not more buckets. **DECIDED**

`historical` is too coarse. The fix is **not** a richer set of mutually exclusive states.

> **Wrong model:** add `failed` as a medication state.
> **Why wrong:** "failed" is a clinical **conclusion**, and usually the very conclusion being
> evaluated. Five days of Concerta stopped for headaches is not a failed trial; it is not even an
> adequate trial. Writing `state: failed` launders somebody else's interpretation into canonical
> state, and then every capability downstream inherits the word as truth. This is the same error
> as collapsing Adderall XR into Adderall, one layer up: a premature interpretation destroying
> the distinction that the reasoning was supposed to make.
> **Correct model:** preserve the dimensions a prescriber actually reasons from, and let the
> capability draw the conclusion.

```
lifecycle:       current | historical | proposed | prescribed_not_started | unknown
exposure:        never_started | started | unknown
response:        beneficial | partial | no_benefit_reported | worsened | unknown
discontinuation: adverse_effect | inefficacy | patient_preference | pregnancy |
                 cost_access | other | unknown
duration:        actual duration when known
sourceLanguage:  the clinician's original wording, preserved
```

So "Previously stopped Concerta after five days due to headaches" becomes:

```js
{ lifecycle: 'historical', exposure: 'started', duration: '5 days',
  response: 'unknown', discontinuation: 'adverse_effect',
  adverseEffects: ['headaches'],
  sourceLanguage: 'previously stopped Concerta after five days due to headaches' }
```

Discern can then conclude *"that does not establish an adequate efficacy trial"* instead of
inheriting the word **failed**. Note `response: 'unknown'` is doing real work: stopping for a
side effect at day five says nothing about whether the drug would have worked.

**Status:** decided, not built. The detector currently emits `current` / `historical` /
`unclear` only. This does not block Discern grounding, which needs confirmed CURRENT medications.
It blocks anything that reasons over medication **history**.

### Patient-reported vs clinician-confirmed is SOURCE and AUTHORITY, not another state. **DECIDED**

The patient says *"I take Adderall XR 20 mg every morning."* The clinician confirms that this is
the medication list for the encounter. Neither of those objectively verifies adherence, and the
four axes keep them straight without inventing states:

```
Identity:   Adderall XR 20 mg
State:      current
Source:     patient report
Authority:  clinician confirmation (for the canonical encounter list)
```

> **Wrong model:** `patient_reported_current`, `clinician_confirmed_current`,
> `objectively_verified_current` as distinct states.
> **Why wrong:** it mixes axes. Source and state are independent, and crossing them multiplies
> the state space every time a new source appears.

### `medications.changes` holds EVENTS, not a second state system. **DECIDED**

The three readings are genuinely different and must not be collapsed:

```js
{ medication: '...',
  event:  'start' | 'stop' | 'increase' | 'decrease' | 'switch',
  status: 'reported_external' | 'clinician_decided' | 'proposed',
  actor:  'PCP' | 'patient' | 'clinician',
  timing: '...', source: '...', confirmedBy: 'clinician' | null }
```

- *"PCP started fluoxetine 40 mg two weeks ago"* is `reported_external`.
- *"Increase Adderall XR to 25 mg"*, once the clinician decides it, is `clinician_decided`.
- *"Could consider increasing Adderall XR"* from Discern is `proposed`, and **I-1 stops it
  becoming a medication change because a model suggested it.**

**Status:** decided, not built. No writer yet.

## 3.3 Source

**ENFORCED.** Candidates carry the segment they came from (today's note, drafted HPI, drafted
plan, last visit) and the sentence that justified the proposed status.

**ENFORCED.** Outside records are **not** scanned for medications. A drug named anywhere in a
40-page neuropsych report is the weakest possible signal for a current-medication list.

**ENFORCED.** A drug appearing only in the prior note is downgraded to `unclear` whatever that
note's tense was. Last visit's present tense is not today's present tense.

**ENFORCED.** Status cues are sentence-scoped. An earlier version leaked across the boundary and
filed an active prescription as historical because the *next* sentence said "previously stopped".

### Query-scoped use is not confirmation. **DECIDED 26 Sept 2026, ENFORCED**

Exposed by implementation, which is the only reason it is here.

> **Wrong model:** a question that needs medication facts needs a clinician-confirmed canonical
> medication list first.
> **Why wrong:** it conflates two different things, and it puts a reconciliation form in front of
> a clinician whose note already says, in plain words, *"Currently taking Adderall XR 20 mg every
> morning"* and *"PCP started fluoxetine 40 mg two weeks ago"*. Nothing about that is ambiguous.
> Making them ratify it before the question can be answered exposes an internal state-management
> requirement as though it were a clinical information requirement. It is not one.
> **Correct model:** reading is not confirming. A medication stated clearly enough in today's
> material is a **query-scoped input**: good enough to retrieve a label and answer, and it does
> NOT enter `medications.current`. Canonical confirmation is for state the app will persist,
> reuse, modify or act on later.

**The gate is per CLAIM, and asks only for a distinction that changes the evidence:**

| situation | ask? |
|---|---|
| "max dose" of a drug that comes in IR and XR, no release form stated | **yes**, the label differs |
| the same drug, but the question is "is A + B contraindicated" | no, same section either way |
| a drug described as both current and stopped | **yes**, no amount of reading settles it |
| a drug mentioned only as stopped | no, it is simply not an input |
| a drug with no release-form ambiguity | no |

**ENFORCED:** `resolveQueryScope()` in `rx-grounding.js`; the result records
`meta.medicationSource` as `note` or `confirmed`, and declares `notedMedications` rather than
`medications` as its input so a note-grounded answer still goes stale if the note changes.

### Grounding prevents invention. It does not prevent synthesis. **DECIDED 26 Sept 2026**

The first failure was a fabricated maximum dose. The fix produced the opposite failure, and it
took a live run to see it: an answer that opened with *"the label does not specify an explicit
labeled maximum for adults"*. Technically grounded. Clinically useless.

> **Wrong model (A):** the model answers medication questions from memory.
> **Why wrong:** it invented a pediatric maximum and presented it as an adult one.
> **Wrong model (B):** the model may only report what one retrieved document literally contains.
> **Why wrong:** it turns a clinical decision-support tool into a document reader. "What is the
> maximum I can go to" is a clinical question; "does this label contain a field called adult
> maximum" is not the same question, and answering the second is a non-answer to the first. A
> non-answer is worse than useless mid-visit, because it costs the time it took to read.
> **Correct model:** answer the clinical question. Lead with the most useful accurate answer and
> qualify second. The retrieved label is authoritative for what a label establishes and may not
> be contradicted or have figures attributed to it that it does not contain. Established clinical
> practice may supply what the label does not, **said plainly as practice rather than labeling**.

Every number carries its category: FDA recommended dose, explicit labeled maximum *where one
exists*, highest dose studied, practical ceiling in common use, pediatric versus adult,
formulation-specific. Presenting one as another is the original defect in a new costume.

Where good sources disagree on a ceiling, give the values and say which is which. Disagreement
between sound sources is information, not an inability to answer.

**A failed retrieval bars claiming the label, not answering the question.** It may not state,
quote or imply what an unread document says. It should still answer from practice, say briefly
what could not be verified, and not make that the headline.

### Tier 2 exists, and is NOT yet verified. **DECIDED 26 Sept 2026**

The most useful sentence in a real answer, *"many references cite 40-60 mg/day as a practical
adult ceiling"*, was model memory: the trail showed only DailyMed. Deleting the sentence would
have been the wrong fix, because it is what the clinician asked for.

`rx-clinical-reference.js` is the home for it. Every entry carries its figure, its basis, its
granularity and `verified: false` until a clinician reviews it. **Being written down is the only
thing separating this from recall** — it is inspectable, versioned and correctable, and the model
is told to give the figure while saying it is commonly cited rather than labeled.

The precedent is `pm-lai.html`, which already carries curated dosing with a per-fact marker
distinguishing label-derived from TBP synthesis.

| tier | source | establishes |
|---|---|---|
| 1 | FDA / DailyMed SPL | labeled dose, explicit labeled maximum **where one exists**, contraindications, interactions, warnings, populations |
| 2 | `rx-clinical-reference.js` | practical adult ranges, commonly cited ceilings |
| 3 | guidelines, primary literature | not built |

**Open:** nothing is verified. An unverified entry beats recall; a wrong entry is worse than none.
Verification is a clinician's job, not a model's.

### Identity granularity follows the claim. **DECIDED 26 Sept 2026, ENFORCED**

> **Wrong model:** every medication claim needs the exact manufacturer's SPL, or it fails.
> **Why wrong:** "I found 52 generic fluoxetine labels and cannot tell which manufacturer's
> bottle she has, therefore I cannot retrieve fluoxetine evidence." Whether fluoxetine inhibits
> CYP2D6 is identical in every equivalent label. Refusing there is the mirror image of collapsing
> Adderall XR into Adderall: one demands too little specificity, the other too much.
> **Correct model:** `claim -> required identity granularity -> appropriate evidence`.

| claim | granularity | why |
|---|---|---|
| Adderall XR maximum | **product** | IR and XR are different labels with different numbers |
| fluoxetine inhibits CYP2D6 | **ingredient** | the same fact in every equivalent label |
| is A + B contraindicated | pair, at each drug's own level | |

**ENFORCED:** `granularityFor()` decides per drug from the identity the clinician wrote (a brand
or a release form means product level, a bare ingredient name means ingredient level), and
`chooseSpl` relaxes its tie rule accordingly: at ingredient level a different manufacturer or
dose form is not a reason to refuse, a different *product* still is.

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

**Was the most consequential open item in this document; resolved by I-1.** Several model-authored
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

**RESOLVED by I-1.** These are derived artifacts and are allowed to exist, persist and feed
further reasoning. They may not become canonical assertions. `ctx.provenance` now states each
field's layer as data, so nothing has to infer authority from a field name.

### A summary may stand in for a source, but never invisibly. **DECIDED**

> **Wrong model (A):** always resend the whole document, so the model always has the source.
> **Why wrong:** a 35-page neuropsych report on every question destroys the architecture for a
> different reason. The summary exists because the token cost is real.
> **Wrong model (B):** send the summary and let the consumer believe it received the record.
> **Why wrong:** absence from a summary reads as absence from the record, and a factual claim
> gets made from a document nobody looked at.
> **Correct model:** a derived summary may be used as a **retrieval and orientation** artifact,
> and the consumer must know it is reasoning from a derived summary rather than the source. When
> a specific factual claim materially depends on the source, retrieve the relevant **source
> passage** rather than treating absence from the summary as absence from the record.

This is the same shape as the DailyMed work, and that parallel is the point:

```
summary for navigation  ->  source for the claim
```

The renderer already applies exactly this principle to truncated raw text, saying in the prompt
that absence in the excerpt is not absence in the record. `d.review` gets the same protection.

**ENFORCED:** `ctx.sources[].reviewLayer` / `reviewAuthoredBy` mark a review as model-derived.

**DECIDED, not yet done:** the rendered block must label itself, roughly:

```
OUTSIDE RECORD REVIEW
artifactType: derived_summary
sourceDocument: <name>
coverage: summary, not the full document
```

Not shipped in this pass because it changes what every clinical prompt sees, which is a
deliberate behaviour change deserving its own commit. **It will require a new baseline for
`tests/encounter-context.test.js`**, whose whole value is that it is pinned to the pre-refactor
prose. That is correct and expected: the test proves nothing changed accidentally, and this
change is on purpose.

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

**DECIDED: a confirmation does not expire because time passed. It becomes stale because relevant
state changed.**

> **Wrong model:** re-confirm every N minutes, or on reload.
> **Why wrong:** it is pointless re-confirmation, which is the reconciliation chore wearing a
> timer. Nothing about the patient changed while the clinician was typing.
> **Correct model:** a confirmation stays valid for the encounter until a relevant fact changes,
> a conflicting source appears, or the clinician edits or revokes it.

- A reload does **not** invalidate it. **ENFORCED** (it survives crash recovery).
- A newly detected medication may. **ENFORCED** (`new-since-confirmed`).
- Adderall XR 20 to 30 mg does. **ENFORCED** (the change reopens the card and marks dependent
  results stale).
- A conflicting current-med statement should. **DECIDED, not built** (nothing detects conflict).

This is the same event-driven invalidation as §4, deliberately: one mechanism, not two.

**Still open:** explicit revocation. There is no way to un-confirm without editing the list.

---

# 7. What is deliberately not modeled yet

Declared so nobody mistakes absence for oversight. Each stays `unresolved` until it has a real
source and a real writer, per I-3.

| concept | status |
|---|---|
| adverse effects | free text. Patient-reported is not an observed finding, and that distinction is unmodeled. |
| vitals, labs | free text. No structured source. |
| scored screeners | `TBP_SCALES` is a catalogue of instruments. A scored result is not captured. |
| medication changes | defined as EVENTS (§3.2). No writer yet. |
| psychotherapy modality | captured at preflight; not yet consumed by anything but the note |

---

# 8. Decisions log, and what is still open

All seven forks raised in the first draft were decided on 26 Sept 2026. Recorded here so the
resolution is findable without reading the whole document, and so nobody re-opens a settled one.

| # | fork | decision | built? |
|---|---|---|---|
| 1 | working artifact vs. assertion | three layers: source material -> derived artifact -> canonical assertion. A model may derive freely; crossing into canonical needs authority (I-1) | provenance map **yes**; per-artifact metadata no |
| 2 | medication history granularity | **dimensions, not buckets.** No canonical `failed` state | no |
| 3 | patient-reported vs. confirmed | a source/authority distinction, not a state (§3.2) | n/a, it is a modelling rule |
| 4 | `medications.changes` | **events**, with `status` separating reported / decided / proposed | no |
| 5 | summary substituting for source | allowed for orientation, never invisibly; source passage for a specific claim (§5.1) | context labels **yes**; prompt label no |
| 6 | confirmation lifetime | no time expiry; event-driven invalidation only (§6) | **yes**, mostly |
| 7 | combination products | one prescribing identity, `components[]` alongside | no |

**The load-bearing one is #2.** Do not solve medication-history granularity by adding a canonical
`failed` state. "Failed" is usually the conclusion being evaluated. Preserve exposure, duration,
response, adverse effects and stop reason separately, so a capability can decide whether the
history supports calling it a failed trial. Getting this wrong would put an unexamined
interpretation into canonical state, which is the whole class of error this document exists to
prevent, and it would do it in the place where Think Beyond AI is supposed to add the most value.

## Still open

1. **Explicit revocation of a confirmation (§6).** No way to un-confirm short of editing the list.
2. **Conflict detection (§6).** A conflicting current-medication statement *should* invalidate a
   confirmation. Nothing detects conflict.
3. **Adverse effects (§7).** Patient-reported is not an observed finding and the distinction is
   unmodeled. Likely resolves the same way as #3 above, on the source axis, but not decided.

---

## Maintaining this

Add to it when implementation pressure forces a decision, not before. An ontology written ahead
of the code is speculation; this one is worth having because each entry was paid for. When a
capability needs a distinction this file does not make, that is the signal: decide it, record it
with its wrong model, then build.

Re-tag **INFERRED** entries as they are confirmed or corrected. An inference left sitting long
enough starts to read like a rule, which is the failure this document exists to prevent.
