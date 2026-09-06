# FUTURE OPPORTUNITIES — Think Beyond Practice

> **Nothing in this file is abandoned. Nothing in this file is promised.**
> These are strategic options preserved so good ideas are not lost. An item moves into
> `ROADMAP.md` only when it supports the current company focus and has earned development
> attention (see the NOT NOW gate in `ROADMAP.md`: it must strengthen acquisition, habitual
> use, retention, or expansion of the current product).

This is an idea bank and strategic expansion map, **not** a TODO list. It exists so that
"we're not building this now" never means "we forgot this." Capture every idea here; build
from `ROADMAP.md`.

Where useful, an idea carries a short annotation:
- **Why it matters**
- **Prerequisite** (what should be true before building it)
- **Business model**
- **Status** (always: strategic option, not active roadmap)

---

## 1. Clinical OS expansion

The deeper architecture and phased reasoning for most of this lives in
`CLINICAL-OS-STRATEGY.md`.

- Full longitudinal patient context (beyond the lightweight per-encounter context object)
- EHR integrations
- FHIR
- Read-only chart history
- EHR note write-back
- Medication reconciliation
- Lab integration
- Electronic lab ordering (vendor diligence not started; Health Gorilla is a candidate, not a
  choice — see `CLINICAL-OS-STRATEGY.md` §19-21)
- PA Prep (assemble the answers CoverMyMeds / payer portals actually ask for, rather than a
  generic medical-necessity letter)
- Form completion / documentation-appointment mode (guided visits that ensure the info a form
  needs is actually obtained)
- Mapped fillable PDFs (start with common, reliably mappable forms)
- After-Visit Medication Plan (specific to what changed today, not a generic monograph)
- Patient education
- Deeper evidence-backed clinical guidance
- Augmentation guidance
- Treatment algorithms
- Monitoring intelligence
- Longitudinal outcome trends

**Note on clinical guidance / evidence:** highest clinical-risk area in the whole strategy. It
must never ship as a naked LLM. Keep structured clinical/drug data, retrieved evidence, and AI
synthesis architecturally and visually separate; quality bar at least as disciplined as the
Chart Audit + Coder. Prerequisite: build the sourced, versioned evidence corpus before
ambitious AI recommendations (`CLINICAL-OS-STRATEGY.md` §12-15).

---

### TBP Adult ADHD Evaluation Framework (three original instruments + AI synthesis)

A first-principles alternative to licensing somebody else's questionnaire. Three
TBP-original tools feeding one evidence map:

1. **Adult ADHD Patient History Questionnaire** (pre-visit) — gathers current examples,
   childhood recollections, impairment, compensatory systems, education/work history,
   substance and sleep chronology. Deliberately no positive/negative cutoff.
2. **ADHD Collateral History Questionnaire** — for a parent, partner, sibling or friend,
   branching on whether the informant knew the patient in childhood, adulthood, or both.
   Asks what they observed ("did someone have to remind them about assignments,
   belongings, appointments"), not whether a criterion is met.
3. **Adult ADHD Clinical Interview Framework** (in the Scribe; "guide" was the
   earlier name and implies the tool knows the path, see `CLINICAL-OS-STRATEGY.md` §34 on
   naming and agency) — semi-structured and dynamic,
   organized around the symptom constructs plus onset, settings, impairment, chronology,
   differential, and diagnostic uncertainty.

**The paradigm, which is the actual point:** questionnaires gather evidence, the interview
establishes meaning, collateral tests the history, the clinician makes the diagnosis. The
output is an evidence map (what is established, by which source, what argues against, what
is still uncertain), never a global score. Inventing a "TBP ADHD Score ≥ 42 = positive"
would imply psychometric validation we do not have.

**AI behavior spec — synthesis first, gap detection second.** The guide is *not* a
completeness checker. Its primary job is to independently synthesize the history and say
how strongly the evidence supports an ADHD formulation, why, what argues against it, and
what remains uncertain — in ordinary clinical language ("I would keep ADHD high on the
differential"), never a probability. It must be able to disagree with the clinician gently
in both directions. Missing information is framed as *things worth clarifying*, never as
MISSING REQUIRED ELEMENTS.

Three distinct states, never treated alike:
- **Soft gap** — more information would increase confidence.
- **Meaningful uncertainty** — competing explanations remain unresolved.
- **Contradictory evidence** — something in the history actively argues against the
  diagnosis (e.g. no attentional difficulty until a TBI at 31; concentration problems only
  during discrete manic episodes).

And the governing rule: **"not documented" ≠ "not present" ≠ "not assessed."** A history
describing lost homework, parental reminders and midnight project completion supports
childhood onset even if nobody wrote "before age 12." The question is whether the total
history reasonably establishes the construct, not whether every checklist item was asked.

- **Why it matters** — Part 1 and Part 2 of the ADHD posts argue that measurement is not
  diagnosis. This is that thesis built as a product, and it is a strong demonstration of
  what the Scribe is supposed to be: a second clinical brain, not a hall monitor. Note there
  are **four** posts, not two: Part 3's material on functional targets and what counts as the
  medication actually working bears directly on a longitudinal module and should be read as
  part of the clinical spec.
- **Prerequisite** — the ADHD posts published (Part 1 publishes first; the remaining parts are
  scheduled with post IDs already assigned); the existing assessment-suite send infrastructure
  (tokenized one-time links, `assessment-create.js`) extended to collateral informants. Also
  document ingestion into prep (`CLINICAL-OS-STRATEGY.md` §32) — without it the guide asks
  questions whose answers are sitting in an uploaded PDF. Draft the items from the construct level and clinical literature; do **not**
  build by paraphrasing ASRS/DIVA/DSM items side by side, and do not brand it as an
  "ASRS-like" or "DIVA alternative" tool. Label it plainly as a structured clinical-history
  and interview aid, not a validated psychometric test.
- **Note on licensing** — this is *not* driven by licensing pressure. ASRS v1.1 (WHO, free
  with attribution) and WFIRS-S (UBC 2011, public domain, unmodified with notice retained)
  are both already shipped legitimately in `assessment-instruments.js`. The licensing
  argument only bites for a structured diagnostic interview like DIVA. The real case for
  building this is clinical: the existing paradigm collects endorsements when what the
  diagnosis needs is context, chronology and meaning.
- **Business model** — member-facing differentiator inside the Scribe; a candidate for
  eventual validation study (inter-rater agreement, concordance with expert diagnosis).
- **Status** — strategic option, not active roadmap.
- **Where the rest of the design lives** — this entry holds the *instruments* and the *AI
  behavior spec*. The delivery architecture is `CLINICAL-OS-STRATEGY.md` §32, "Previsit
  intelligence: the missing front half," which records the `prepSystem()` / `newEvalScaffoldSystem()`
  asymmetry in `pm-ai-scribe.html`, the two routes into previsit context, why the work has to sit
  on discrete reasoning checkpoints rather than a live stream (ambient transcription runs after
  Stop, not during), and the discipline that the previsit packet must not become a fourteen-page
  form. Read both before starting: neither half is buildable on its own.

---

### Fast Ask the Archive inside the Scribe

The standalone Archive is a research experience: it shows what it found, which posts it came from,
related templates. In a visit the job is different — answer first, sources on request.

**Why the existing pipeline cannot simply be embedded** (measured Sep 2026, `inngest-serve.mjs`):
it makes three sequential model calls — Haiku query expansion, a Sonnet synthesis capped at 4000
tokens, and a third Haiku call whose only job is writing descriptions for the source list. The
synthesis does not stream, and the whole thing runs as a background Inngest job the browser polls,
so the answer can only ever arrive all at once. That is the 60-120 seconds.

The Scribe version should be: one retrieval of a small number of relevant chunks, one synthesis
call streamed through the Scribe's existing `callAPI` path, sources carried free from the
retrieval rows (title, url, author and space are already columns) behind a "show sources" action.
No third call.

- **Prerequisite** — note the archive corpus lives in Supabase with OpenAI embeddings, both
  deliberately off the PHI path (`BAA-AND-PHI-ROUTING.md`). The synthesis can see the patient on
  the BAA-covered clinical path; the *search query* cannot carry PHI. In practice that is not a
  scrubbing exercise — the archive is searched by clinical topic, which contains no PHI by nature
  — but the boundary must be real, not assumed from the query "sounding clinical".
- **Where it sits** — subordinate to Discern (§34), not a peer. Reasoning answers from the case;
  the Archive is invoked when the question actually needs retrieved knowledge.
- **Status** — strategic option, not active roadmap.

---

### Medication Intelligence / point-of-care reference layer

A structured psychiatric medication data layer that supports multiple TBP workflows, rather
than another collection of standalone reference tools.

Potential capabilities: medication reference pages, side-by-side comparison, switching and
tapering guidance, equivalency tools, metabolism / CYP information, adverse-effect
considerations, monitoring, pregnancy and lactation, available formulations, and links to
relevant TBP clinical content and CE.

**The design principle, which is the point of the entry.** This must support clinical
reasoning, not encourage medication selection by simplistic rankings such as "lowest weight
gain" or "least EPS." Adverse-effect profiles are one part of an individualized risk-benefit
analysis and frequently trade against efficacy, potency, prior response, indication, and
patient preference. Olanzapine to aripiprazole is the standing example: more metabolic risk,
but also more potency, and the lower-risk option is not automatically the better one for a
given patient. Where TBP provides comparisons it must make those tradeoffs visible rather
than imply that lower theoretical risk equals a better medication.

**Build one dataset, not seven tools.** The architectural case is stronger than the product
case. Today the same clinical facts would end up maintained separately in the Interaction
Interpreter, the Monitoring Protocol, clinical guidance, the After-Visit Medication Plan, and
any future augmentation or switching work. One structured medication service that all of them
call is the version worth building. Possible eventual UI: Medication Reference -> Compare ->
Switch / Taper -> patient-specific considerations. Directly relevant to `ROADMAP.md` Lane 2
(Monitoring Protocol) and Lane 3 (Interaction Interpreter), which are current work and would
be the first two consumers.

**Where the actual differentiation is.** Not in the reference content. There is already
abundant psychiatric reference material available, and reproducing it is a large ongoing
content-maintenance obligation for something clinicians can get elsewhere. The differentiator
is patient context: a static reference answers "tell me about aripiprazole," whereas the
Scribe already knows the current regimen, prior trials and failures, BMI, diagnoses, and what
changed today. "Given this patient's history, what are the tradeoffs" is a different class of
product from a drug card, and it is the only version worth diverting development for.

**On equivalency calculators specifically.** Benzodiazepine equivalencies, stimulant
conversions, and antipsychotic dose equivalents are approximate and source-dependent. If TBP
builds these, they should show an estimated equivalent range, the source and method, and the
limitations, explicitly not a milligram-for-milligram conversion. False precision in a
calculator is worse than no calculator.

- **Why it matters** — it is infrastructure for work already on the roadmap, not breadth. It
  also thickens the Plus tier: reference plus compare plus switch/taper alongside the
  Interaction Interpreter, Monitoring Protocol, Chart Audit and Coder, letters and CE.
- **Prerequisite** — Lanes 2 and 3 far enough along to know what shape of structured drug
  data they actually need, so the schema is derived from real consumers rather than guessed.
  Build from FDA labels, open government data, primary literature, and appropriately licensed
  guidelines only. Start with the drugs psychiatric prescribers use constantly; do not chase
  a headline count of medications or diagnoses.
- **Business model** — member-facing depth inside the existing tiers; no separate product.
- **Status** — parking lot / later. Preserved because it could become foundational
  infrastructure, not because there is an urgent gap. Worth being honest that the reference
  half of this is a "meh" on its own merits.

**Market note (Aug 2026).** Prompted by Sigmund Psych, a psychiatric point-of-care reference
app built by two PMHNPs (Sigmund Psych LLC, Florida, formed 3 Feb 2026). Advertises 92
diagnoses, 189 medications across 21 classes, treatment pathways, comparison and equivalency
calculators, coping-skill guidance, supplements, and CE, at $19.99/month or $199/year, with a
CE tier at $289/year. Useful mainly as evidence that clinicians will pay for the reference
slice alone, and their terms explicitly disclaim patient-specific recommendations and tell
users not to enter PHI, which is exactly the ceiling TBP's encounter context is positioned
above. Do not create a trial account to copy their drug cards, pathway wording, database, or
UI: their terms claim ownership of that content. The product concepts are not theirs;
independently sourced data with TBP's own provenance standards is the better path regardless.

---

## 2. Practice / organization product

Path beyond the individual-PMHNP membership ceiling.

- Group practices
- Organization templates
- Organization documentation standards
- Coding / compliance policies
- Team analytics
- Supervision workflows
- Quality improvement
- Enterprise contracts

**Why it matters:** per-seat expansion revenue and higher retention than individual
memberships. **Prerequisite:** the single-clinician workflow is habitual and retained first.

---

## 3. New clinician verticals

- Psychiatrists
- Therapists (likely a lower-cost therapist membership)
- Psychologists (if appropriate)
- Primary care
- Other specialties
- Specialty-specific Clinical OS versions

**Why it matters:** the encounter-context architecture is largely specialty-agnostic; each new
vertical is a new market with the same engine. **Prerequisite:** don't fragment attention
until the psychiatric product is proven; a rheumatology anything is a distraction until then.

---

## 4. Education

- CE expansion
- Enterprise CE licensing
- Health-system licensing
- University / NP-program licensing
- Curriculum packages
- White-label CE
- CE content licensing

**Why it matters:** licensing and institutional deals are a different revenue shape than
memberships. **Business model:** membership benefit, standalone CE, enterprise/institutional
licensing.

---

## 5. Simulation

- Therapeutic simulator (practice with an AI patient, technique-specific feedback)
- MI simulator
- CBT simulator
- ERP skill practice
- Suicide-risk conversations
- Brief interventions
- Difficult-patient conversations
- Medication counseling
- Diagnostic interviews
- Tiered difficulty
- Performance feedback
- Scoring / rubrics
- Competency assessment
- Administrator reporting
- Scenario authoring
- Licensing the simulation engine to other CE creators
- White-label simulation platform

**Flagship example, fully annotated (template for how to capture a big idea):**

> **Therapeutic simulation platform**
> - *Idea:* let clinicians practice MI / CBT / ERP / brief interventions with an AI patient
>   and receive technique-specific feedback.
> - *Potential users:* individual clinicians, health systems, universities, CE companies.
> - *Business models:* TBP membership benefit, standalone CE, enterprise licensing,
>   white-label licensing, platform/engine licensing.
> - *Prerequisite:* prove that TBP's own simulations produce repeated learner engagement
>   before building third-party authoring infrastructure.
> - *Status:* strategic option; not active roadmap.

---

## 6. Professional network / marketplace

- Mentorship
- Supervision
- Expert consultation
- Provider matching
- Specialty experts
- Office hours
- Workshops
- Courses
- Templates / resources
- Seller ecosystem
- Marketplace-driven membership acquisition

**Why it matters:** community and marketplace can become an acquisition channel, not just a
benefit. **Prerequisite / caution:** the marketplace RLS exposure in the infrastructure/safety
debt lane (`ROADMAP.md` §C) must be resolved before any real marketplace transactions. See
also `MARKETPLACE.md`.

---

## 7. Practice infrastructure

- Credentialing
- Credentialing Autopilot
- Payer intelligence
- Compliance
- Billing / coding
- Templates
- Letters / forms
- Referral networking
- Possibly other practice-management services over time

**Why it matters:** these are the administrative burdens that make solo practice hard;
solving them deepens the "operating layer" position.

---

## How to add to this file

Drop the idea under the right category. If it's a big one, add the four-line annotation
(why it matters / prerequisite / business model / status). Don't prune this file to look
tidy — losing an idea is worse than a long list. Promotion to real work happens in
`ROADMAP.md`, never here.
