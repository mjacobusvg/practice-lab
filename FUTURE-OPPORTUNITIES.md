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
3. **Adult ADHD Clinical Interview Guide** (in the Scribe) — semi-structured and dynamic,
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
  what the Scribe is supposed to be: a second clinical brain, not a hall monitor.
- **Prerequisite** — the two ADHD posts published; the existing assessment-suite send
  infrastructure (tokenized one-time links, `assessment-create.js`) extended to collateral
  informants. Draft the items from the construct level and clinical literature; do **not**
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
