# ROADMAP — Think Beyond Practice

**The executive statefile. Start here.** This file answers three questions:

1. **What are we proving now?**
2. **What are we building now?**
3. **What are we intentionally NOT building yet?**

It is short and living on purpose. It sits above the deeper docs and links down to them
instead of repeating them. Update the "Where we are now" and "Current focus" sections
whenever something meaningful ships.

> **For any Claude/AI session:** read this file before proposing or starting substantial
> new product functionality. New work has to fit the Current Focus and clear the NOT NOW
> gate. An idea being good is not enough; see NOT NOW.

**Document hierarchy**

- `ROADMAP.md` (this file) — what matters now, what we're proving, what we're deliberately not doing.
- `FUTURE-OPPORTUNITIES.md` — every meaningful idea we've discussed, preserved and organized, none of it approved for build.
- `CLINICAL-OS-STRATEGY.md` — where the product can ultimately go and how the architecture gets there.
- `MARKETING-SPINE.md` — how we explain and sell it.
- `CLINICAL-NOTE-GENERATOR-ARCHITECTURE.md` — how the core clinical workflow actually works.
- `CLAUDE.md` — rules for working on the codebase.

---

## North Star

**Increase the number of psychiatric prescribers for whom Think Beyond Practice is part of
an ordinary clinical day.**

Underneath that:

> TBP becomes the psychiatric clinical operating layer: **prepare -> guide -> document -> audit -> act.**

Audit is our strongest current differentiator and stays central to the *positioning*. But
it is not the North Star. The goal is habitual use of the whole workflow, not optimizing
the company around one feature.

---

## Where we are now (Aug 2026, build ambient-56)

**Live and working:** AI Scribe (`pm-ai-scribe.html` inside the `ai-scribe-workspace.html`
Patient Desk), Chart Audit + Coder, Interaction Interpreter, Monitoring Protocol, Letter
Library, screeners/assessments, psychotherapy guide (Therapy Coach). Membership at $119/mo
with a free 2-week trial. Members + contacts in Supabase; email broadcasts via
`broadcast-send.js`.

**The strategic shift that produced this file:** development is no longer the main problem.
We have enough features. The problem is adoption, integration, proof of habitual use, and
marketing what already exists. Stop expanding breadth.

**Shipped recently:**
- **Note-as-memory bridge** — follow-up drafts carry durable *dated* context forward (med
  trajectory, labs/monitoring with dates, dated risk history, quantified progress), and
  "No change"/"not assessed today"/blank no longer deletes a carried section.
- **Reliability** — fixed working-note section truncation, fixed HPI getting cut off
  mid-note, added a "back to working note" path after drafting.
- **Onboarding/stickiness** — continuous two-pass walkthrough, empty-note setup nudge,
  instant intake-template load, version-check refresh nudge for stale tabs.
- **Growth plumbing** — broadcasts can target active Scribe users; fixed a paying member
  who was being silently excluded from sends.

---

## Current focus

The actual state of the company. In priority order:

1. **Make the existing core workflow excellent.** Improve what is already built rather than
   adding new standalone tools. Reliability, note quality, usability, onboarding, speed, and
   removing friction come first.
2. **Make TBP feel like one product.** Connect existing capabilities through encounter
   context. The clinician should move naturally from preparation -> visit -> note ->
   audit/coding -> relevant next action without re-entering the same information.
3. **Prove habitual clinical use.** The question is no longer whether TBP has enough
   features (it does). It is whether clinicians actually make TBP part of their normal
   workweek.
4. **Market what already exists.** Show the experience, not a feature list. ("Imagine
   opening the visit and TBP already reminds you what to follow up on...")

---

## Goals

Separated into current baseline, near-term proof, and long-range scenarios. The scenario
ranges are explicitly scenarios, not forecasts or promises.

### Current baseline (Aug 2026)

- 39 active paid subscriptions
- ~$2.8K subscription MRR
- 18 Full / 21 Forum
- Full-product use is not yet habitual across the paid base
- **4 of 18 active Full subscribers used the tracked AI Scribe in the prior 30 days**

That last number stays in this file on purpose. When the instinct is "add another feature,"
the real question is usually: **why aren't the other 14 using the thing we already built?**

### Next proof point (the milestone that matters)

Not "ship phase X." Establish a **cohort of at least 50-100 psychiatric prescribers who use
TBP repeatedly during ordinary clinical work, with measurable 30/60/90-day retention.**
The exact number is not a committed KPI yet; repeated real use with retention is the point.

### Scale thesis (scenario ranges, not forecasts)

- At roughly **500-1,500 paying clinicians**, TBP can become a meaningful **$1M+ recurring**
  software business.
- At roughly **3,000-6,000 clinicians**, a **$4M-$10M ARR** vertical-SaaS outcome becomes
  credible.
- Expansion into practices/teams, psychiatrists, therapists, other specialties, enterprise
  education, simulation licensing, and integrations creates paths beyond the individual-PMHNP
  membership ceiling (see `FUTURE-OPPORTUNITIES.md`).

---

## What we measure now

**Primary question: Are clinicians making TBP part of an ordinary clinical day?**

Watch:
- trial -> first successful clinical use
- first note / first audit
- return on a second clinical day
- weekly active clinical users
- visits/workflows completed per active clinician
- percent of Full members using the core workflow monthly
- 30/60/90-day retention by activation cohort
- Scribe -> Audit completion rate
- use of context-aware handoffs
- trial -> paid conversion
- cancellation reason
- signup reason / acquisition source

This turns the roadmap from "things Michael wants to build" into a company learning what
actually drives adoption.

---

## Short-term roadmap — what to actually work on

Two lanes run in parallel: **(A) make the tools feel like one product** and **(B) make what
already exists better.** Plus a non-negotiable **(C) infrastructure/safety** lane.

The immediate product goal: **turn the existing collection of excellent tools into a
connected psychiatric workflow.** Concretely, in build order:

### A. Integration — the Clinical OS, using what already exists

**Build order (open the repo and start at the top):**

0. Encounter-context foundation
1. Scribe -> Chart Audit + Coder
2. Scribe -> Monitoring Protocol
3. Scribe -> Interaction Interpreter
4. Scribe -> Letter Library
5. Screeners <-> Encounter Context
6. Therapy Coach -> Psychotherapy note
7. Pre-visit -> live-visit continuity
8. Contextual "Relevant next steps" area

Detail for each:

#### Lane 0 — Encounter-context foundation (do this first)

Make the Scribe produce a **lightweight Encounter Context** alongside the note. Not another
giant AI output; a small structured internal object that becomes the common language between
tools. Do **not** attempt a full longitudinal patient model yet. Just establish: the Scribe
knows what happened, and other TBP tools can receive that context.

Conceptually:

```
Diagnoses: OCD, ADHD
Current meds: fluoxetine 60 mg, Vyvanse 30 mg
Medication changes today: Vyvanse increased 30 -> 40 mg
Reported response: attention improved, intrusive thoughts improved, afternoon function still impaired
Adverse effects: appetite suppression
Monitoring: stimulant monitoring relevant; last BP/HR unknown; metabolic monitoring not relevant
Psychotherapy: ERP discussed; contamination avoidance remains
Documentation needs: accommodation letter discussed
Follow-up: reassess appetite; reassess duration of Vyvanse benefit; continue ERP exposure work
```

Design principle (from `CLINICAL-OS-STRATEGY.md`): **detect cheaply, explain/generate deeply
only when requested.** The context object surfaces relevant actions; it does not auto-run any
downstream AI.

#### Lane 1 — Scribe -> Chart Audit + Coder (first full orchestration loop)

Strongest differentiator, most obvious first win. Today: finish note -> find Chart Audit ->
paste note -> run. Future: finish note -> **Audit this note.** The user pastes nothing.

- **Passes:** completed HPI, assessment, plan, psychotherapy section, ROS/MSE if present,
  diagnoses, medication list, selected code if the clinician has one.
- **Returns, inside the Patient Desk:** "Chart Audit - 2 items to review before signing,"
  expandable, e.g.:
  - *Potential inconsistency:* HPI reports appetite suppression after Vyvanse, but Plan
    states "denies medication adverse effects."
  - *Coding support:* current documentation supports 99214 (moderate MDM). What would
    distinguish 99215 - not "add this to bill higher," but "99215 generally requires
    high-level MDM or qualifying total time; based on this documentation, high-risk
    management / extensive data / severe exacerbation is not demonstrated."
  - *Psychotherapy add-on:* documentation supports / does not yet clearly support 90833
    because...

#### Lane 2 — Medication change -> Monitoring Protocol

Scribe detects "started quetiapine" / "increased lithium" / "continuing stimulant." After
the note: **Monitoring may be relevant -> Review monitoring.** The Monitoring Protocol opens
already knowing drug, dose, patient age if available, diagnoses, known labs/vitals from
today's context, what changed, and the date of change. No retyping "quetiapine 50 mg
nightly." If it returns recommended labs, the clinician can **Add monitoring plan to note.**
Information flows Scribe -> Monitoring -> back into Plan.

#### Lane 3 — Medication regimen -> Interaction Interpreter

Same pattern. Scribe already knows current meds, additions, discontinuations, doses. On a
meaningful change: **Check interactions.** The Interaction tool receives the med list
automatically, does deterministic lookup first, and only produces AI interpretation if
opened. Then: **Add relevant counseling to Plan.**

#### Lane 4 — Scribe -> Letter Library

During the visit the patient requests a work-accommodation letter; Scribe detects
`letter_discussed`. At the end: **Documentation request discussed -> Create a letter using
today's visit context.** The Letter Library already knows patient name if available, relevant
diagnoses, functional impairment documented today, the requested accommodation, treatment
status, the clinician's letter style, and TBP letter standards. Clinician picks the letter
type; generation uses only the appropriate subset of the encounter. One of the "oh, it
actually knows what I was just doing" moments.

#### Lane 5 — Screeners <-> Encounter Context

Make existing screeners part of the same flow, both directions. Before/during the encounter
TBP surfaces the relevant instrument (Y-BOCS for OCD follow-up, PHQ-9 for depression). A
completed score becomes context ("PHQ-9 13 today, previously 18") that the Scribe, the
Assessment, and the Audit all see. No copying the score into three places.

#### Lane 6 — Therapy Coach -> Psychotherapy note

Partially wired conceptually already. Clinician opens Therapy Coach mid-visit (e.g. ERP /
motivational barrier), uses a suggested intervention, then **Add to psychotherapy note.** TBP
stores the intervention performed, the patient response, and the therapeutic target, so the
final psychotherapy documentation has real substance instead of "supportive psychotherapy
provided." Existing-tool integration, not a new product.

#### Lane 7 — Pre-visit -> live-visit continuity (foundational)

Already started via "Set me up." Make the output structured (Since you last saw this patient:
last treatment changes, response at last visit, outstanding follow-up, monitoring) and then
turn the "Ask today" items into **answerable live fields** in the workspace:

```
Appetite since starting Vyvanse: ____
Duration of benefit:            ____
ERP progress:                   ____
```

Clinician answers; the answers feed the HPI. That makes the chain real: prior note -> prep
-> interview -> note. This is what makes the marketing claim ("prepared before the patient
appears") literally true.

#### Lane 8 — One intelligent "Relevant next steps" area

Where the separate tools start feeling like one program. During/after the encounter, surface
only what actually became relevant:

```
Relevant to this visit
  Audit your note       (ready when the draft is complete)
  Monitoring            (quetiapine was started today)
  Interactions          (two serotonergic medications are active)
  Letter                (work accommodation was discussed)
```

NOT a 26-tool menu. This is exactly the Christmas-tree avoidance from the OS strategy: the
interface feels intelligent because it removes irrelevant options.

### B. Make what already exists better (runs alongside A)

**AI Scribe:** note quality; carried-forward history without bloat; clearer separation of
historical fact vs "reported today"; better follow-up prep; fewer clicks; faster recovery on
failure; stronger autosave/reliability; custom clinician style without weakening clinical
reasoning; better onboarding/tutorial.

**Chart Audit:** clearer explanations; prioritize significant problems over nitpicks; show
exactly where a contradiction/support issue occurs; educational coding explanations; strong
99214 vs 99215 reasoning; psychotherapy-code defensibility; never encourage documentation
inflation.

**Patient Desk / workspace:** fewer isolated tool launches; persistent encounter state;
obvious current patient / current visit; contextual actions; easier return to the working note.

**Marketing:** workflow stories over feature inventories ("Imagine opening the visit and TBP
already reminds you..."; "Not sure whether this is really a 99215?"; "Before you sign, let
TBP audit the chart."). See `MARKETING-SPINE.md`.

**Near-term Scribe refinement already queued:** bloat control for carried notes (likely lever:
collapse old med-trajectory lines into a summary after N entries so a long med history does
not accrue forever). Hold until we've seen real follow-ups on ambient-56, then tune from what
actually reads as bloated.

### C. Infrastructure / safety debt (non-negotiable, not the exciting part)

- Resolve the known marketplace RLS exposure (Supabase audit found marketplace tables with
  RLS disabled) **before any real marketplace transactions begin.**
- Review flagged SECURITY DEFINER views/functions and privileges.
- Gradually add staging/testing/deployment guardrails as usage grows.
- Do **not** undertake a major rewrite merely for architectural elegance.

---

## NOT NOW — strategic options, not development commitments

These remain potentially valuable future extensions. They should **not** distract from
proving the current psychiatric product. The full, organized idea tree lives in
`FUTURE-OPPORTUNITIES.md`; the headline items:

- therapist version
- primary-care / additional-specialty versions
- EHR integrations
- enterprise / team workflows
- advanced clinical guidance / evidence layer
- electronic lab ordering
- expanded forms / PA automation
- mentorship and supervision marketplace expansion
- therapeutic simulation platform
- enterprise CE licensing
- white-label / licensed simulation technology
- broader marketplace
- additional standalone clinical utilities

**The gate (this is a strategic control mechanism, not a formality):** an idea moves onto the
active roadmap only with evidence that it strengthens **acquisition, habitual use, retention,
or expansion** of the current product. Absent that evidence, it stays in
`FUTURE-OPPORTUNITIES.md`.

The point is not to stop having ideas. Michael's ability to see adjacent possibilities is one
of the reasons TBP exists. The rule is: separate ideation from execution. Capture every idea;
build the ones that serve the current focus.
