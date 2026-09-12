# ROADMAP — Think Beyond Practice

**The executive statefile. Start here.** This file answers three questions:

1. **What are we proving now?**
2. **What are we building now?**
3. **What are we intentionally NOT building yet?**

It is short and living on purpose. It sits above the deeper docs and links down to them
instead of repeating them. Update the "Where we are now" and "Current focus" sections
whenever something meaningful ships.

> **For any Claude/AI session:** read this file before proposing or starting substantial
> new product functionality **on your own initiative**. A self-generated idea has to fit the
> Current Focus and clear the NOT NOW gate; an idea being good is not enough, see NOT NOW.
> This does NOT apply to work Michael asks for — see Owner authority immediately below.

## Owner authority

**This file is a guide for prioritization and continuity, not an authorization system.**

Explicit instructions from Michael supersede roadmap status, parking-lot placement, lane
assignment, and any prior NOT NOW decision. When he says build it, build it. Do not refuse,
stall, hedge, or ask for a "gate override" first, and do not answer a direct instruction by
citing this file back at him. If the instruction conflicts with what is written here, the
document is stale, not the instruction: say so in a sentence, update the affected sections to
match the new priority, and get on with the work.

The gate exists to restrain a session that has thought up something shiny on its own. It has
never applied to the owner.

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

**In the practice copy, not live (Sep 2026).** `ai-scribe-practice.html` +
`ai-scribe-practice-workspace.html` + `note-engine-practice.js`, reachable at `/practice`, carry
work that has NOT been ported to the live Scribe. Porting is a deliberate step and not a file
copy: the live files carry the build-tag lockstep rules the practice copy deliberately opts out
of. What is there:

- **Outside records.** Upload a PDF/DOCX/TXT/RTF, get a clinical review of it (not a summary —
  see `CLINICAL-OS-STRATEGY.md` §32 on why that distinction is the whole feature), optionally let
  it inform new-eval prep, optionally insert a chart-ready record summary onto the existing
  `Historical Note:` carry-forward rail. Raw file and extracted text stay in memory only.
- **Reason through this case.** One streamed call over what the session already holds, available
  before, during and after the visit. No retrieval, no Archive, no background job.
- **Provenance in the shared prompts.** Outside-record claims stay attributed in `draftSystem`
  and `verifySystem`, not only in the document feature.
- **Landing chooser.** The Scribe's jobs are visible on the working-note screen and collapse to a
  compact strip rather than disappearing.

Before any member beta: run the case battery against it (inadequate trial, duration vs failure,
tolerability, missing information, diagnostic anchoring, contradictory outside record, and a
direct attempt to make it assert a dose or interaction), then port.

**Next: Discern** (`CLINICAL-OS-STRATEGY.md` §34) — the reasoning workspace the practice-copy
feature grows into, including the exploratory / adopted / documented boundary, ambient one-tap
starters, and the cost and latency architecture. Then the ADHD Evaluation **Framework** (renamed
from Guide; a framework structures reasoning, a guide implies it knows the path), which needed the
record and longitudinal-context layer underneath it first. A faster Scribe-side Ask the Archive
sits alongside, not above, those.

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
4. Scribe -> embedded visit outputs / Letter engine
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

#### Lane 4 — Scribe -> embedded visit outputs / Letter engine

Do not make the clinician leave the encounter merely to re-enter information the Scribe
already has. The standalone Letter Generator stays available for work that starts outside an
encounter, but inside the Scribe the same engine becomes an **embedded capability**: one letter/
delivery engine, two entrances.

At or near visit completion, offer **Create from this visit** when relevant. Initial output
classes:

- **Patient Visit Summary** — patient-facing language: what was discussed, finalized medication
  instructions/changes, agreed monitoring or follow-up, and other clinician-confirmed next steps.
  This is not a copy of the chart note and must not expose internal differential/reasoning that was
  not intended for the patient.
- **Treatment Plan** — a structured clinical plan generated from the clinician-confirmed
  assessment/Plan, available for review and use as appropriate rather than treated as an automatic
  patient handout.
- **Care-Coordination Summary / Letter** — a purpose-limited subset for a therapist, PCP, or other
  authorized recipient. Do not dump the whole note; include only the information needed for the
  coordination purpose.
- **Other Clinical Letter** — accommodation, return-to-work, school, medication/travel, or another
  existing Letter Library standard using today's encounter context.

The workflow is **Generate -> Review/Edit -> choose recipient -> confirm disclosure authority ->
Send**. Nothing leaves TBP automatically. The clinician must see the exact final output and
explicitly authorize delivery. For patient-directed material, confirm the destination. For
third-party care coordination, require an explicit clinician attestation that the disclosure is
permitted/authorized for that recipient and purpose; do not infer an ROI from the encounter.

**Reuse, do not rebuild.** Embedded Scribe outputs should call the existing Letter Generator
infrastructure for applicable standards/templates, PDF generation, S3 storage/retention options,
sent-log behavior, and AWS SES delivery under the AWS BAA. Do not create a second email, storage,
or retention implementation inside the Scribe. Encounter Context supplies the source facts; the
Letter engine handles document/delivery mechanics.

The important product moment is not merely "open Letter Generator." It is: the clinician just
finished the visit, TBP already knows the verified plan and relevant context, and a useful output
can be created and sent without retyping the encounter. This is a direct realization of
**prepare -> guide -> document -> audit -> act**.

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

**Where prep gets its source (added Sep 2026).** For a follow-up, prep reads last visit's note
and the chain already works. For a **new evaluation it reads nothing** — `newEvalScaffoldSystem()`
is called with the literal string `'Produce the blank intake scaffold now.'` — so "prepared
before the patient appears" is not yet true for new patients, which is where preparation matters
most. The fix is to let the clinician hand the Scribe **sources**: a record already on their own
machine (PDF/DOCX), pasted intake or referral text, a prior note. The extraction code for this
already exists in `template-upload.html` and is reused rather than rewritten.

This is Lane 7 work, not a new initiative, and it is broader than the ADHD work: "someone sent
me records and I have to read them before this appointment" is most weeks for most psychiatric
prescribers, which is the habitual-use test this file measures on. Two rules govern it and are
not optional — the Scribe takes temporary access to the clinician's own file rather than keeping
a second copy of it, and an outside record's claims stay attributed to the record instead of
becoming present-tense patient history (the Lane B item "clearer separation of historical fact
vs 'reported today'"). Full design in `CLINICAL-OS-STRATEGY.md` §32.

#### Lane 8 — One intelligent "Relevant next steps" area

Where the separate tools start feeling like one program. During/after the encounter, surface
only what actually became relevant:

```
Relevant to this visit
  Audit your note       (ready when the draft is complete)
  Monitoring            (quetiapine was started today)
  Interactions          (two serotonergic medications are active)
  Visit output          (patient summary / coordination letter may be useful)
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
- medication intelligence layer (one structured drug dataset under Lanes 2 and 3, rather than
  separate reference / compare / switch / taper tools)
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

---

## Idea bank — Think Beyond AI (Sept 2026)

Captured from a working session, per the rule directly above: capture every idea,
build the ones that serve the current focus. Nothing here is committed. Run each
through `ROADMAP-AND-PROMISE-GUARDRAILS.md` before it goes near a public page,
and remember that buildability is gate #1: if there is a credible technical path,
it is a legitimate candidate, and architecture, risk, usefulness and maintenance
decide the form rather than whether to consider it at all.

**The frame this sits under** is the maturation arc in
`PRODUCT-ARCHITECTURE-AND-NAMING.md` §3: Scribe -> Clinical Assistant -> Clinical
Workspace -> a lightweight clinical operating layer, reached by taking over the
cognitive and workflow glue the EHR is bad at rather than by becoming a system of
record. Read an idea below against that, not only against "is it useful": the ones
that matter are the ones that close the gap between knowing something and having to
act on it somewhere else.

**Public, on the site now:** Structured Interviews (NEXT); Medication Intelligence,
Monitoring Support, Context-Aware Letters & Forms, Longitudinal Case View,
Connected Clinical Tools (ON THE ROADMAP); EHR-connected context (EXPLORING).
Everything below is internal until deliberately promoted.

### The three that could be signature features

Not more tools. These change what the product *is*.

**Tool auto-routing.** The workspace recognises what the visit needs and offers the
next tool with the context already carried: this is an interaction question, this
needs a safety plan, this patient is asking for FMLA. Turns a toolbox into one
thing. Publicly this is Connected Clinical Tools; internally it is the
architectural idea the rest depend on.

**Context-aware actions.** Not autonomous action. The workspace knows the job
coming next and helps gather what that job requires *before the patient leaves*.
The philosophy in one line: don't make me discover afterward that I forgot to ask
something I needed.

**Clinician-configurable intelligence.** Custom frameworks, custom structured
interviews, practice policies, documentation preferences. The system stops being
one clinician's workflow imposed on everyone and becomes each clinician's own
workflow made executable, within safe bounds.

### A word about what these are

Nothing in this bank should become a seventh, eighth or ninth "module". They are
**capabilities**, and several of the best ones should not be a named destination at
all -- they should be intelligence that appears in the workflow when it is useful.
Medication intelligence, monitoring, tool-routing and longitudinal context are the
clearest examples. See `PRODUCT-ARCHITECTURE-AND-NAMING.md`: the product is one
clinical workspace with capabilities that surface at different points in the work,
not a box containing tools.

### The north star behind all of it

**Think Beyond AI should know what job you are trying to accomplish.** Not "here is
today's transcript" but: you are doing a new evaluation; clarifying ADHD; following
up after a hospitalisation; changing a medication; doing PFML paperwork; answering
a portal message; refilling a controlled substance. Once it knows the job, it
assembles the right combination of prep, records, reasoning, interview, medication
intelligence, documentation, letters, monitoring and audit.

That is a stronger north star than "build a better scribe".

### The bank

Feasibility and risk are first-pass judgements from the session, not gate results.

| Idea | What it would do | Feasibility / risk |
|---|---|---|
| Structured Interviews | ADHD first, then others. Starts from what records establish, asks only what remains useful. | Very high / moderate |
| Medication Intelligence | Recognise the med list, run the existing interaction engine, explain meaningful interactions, risk modifiers, monitoring, documentation. | Very high / moderate |
| Medication Timeline | Clean timeline of every trial, dose, response, side effect, reason stopped, retrial, out of messy records. | Very high / low-moderate |
| Medication Reconciliation | Compare intake, prior notes, current note, outside records and patient report. Surface mismatches rather than silently picking one. | Very high / moderate |
| Monitoring Support | Surface labs, vitals, ECGs, metabolic and pregnancy considerations from meds and conditions. Distinguish known from missing. | High / moderate |
| Monitoring Timeline | When labs are supplied, pull dates and results into a timeline and show the trend. A1c 5.4 to 5.7 to 6.1 beats another blob of text. | High / moderate |
| Patient-specific tasks and reminders | "Recheck A1c in 3 months." The workspace remembers and resurfaces it. | Buildable, needs durable patient identity, task persistence, timing and delivery. Design those before marketing it. |
| Context-aware Letters & Forms | Knows what the document requires, says what is missing during the visit, then builds it. | High / moderate |
| Prior Authorization Builder | Build PA rationale from meds, prior trials, diagnosis, contraindications, response and payer criteria; name what is missing. | High; payer-criteria maintenance is the real cost |
| Referral / Consultation Builder | Concise referral with relevant history, failed interventions, meds, testing, and the actual question being asked. | Very high / low |
| Care Coordination Message | Short update or request for a therapist, PCP, specialist or school from visit context. | Very high / low. Sending it raises the risk considerably. |
| Visit-purpose Mode | Diagnostic clarification, side-effect visit, post-hospital follow-up, paperwork visit. The workspace reshapes around the job. | Very high / low |
| What Changed? | Compare today against last visit; show only clinically meaningful change. | Very high / low |
| Longitudinal Case Timeline | Diagnoses, hospitalisations, med changes, symptom shifts, labs, life events, treatment response. | High. Probably an eventual killer feature. |
| Ask This Patient's Chart | "When did she first report panic attacks?" "Why did we stop lamotrigine?" | High, scales with available chart context |
| Contradiction Tracker | Persist unresolved conflicts across sources and bring them back until the clinician resolves them. | High / moderate; cross-session needs persistence |
| Diagnostic Evidence Map | For a diagnosis: evidence for, against, unclear, competing explanations, with sources. | Very high / moderate |
| Custom Framework Builder | Clinicians define their own reasoning pathway. | High / moderate |
| Custom Structured Interview Builder | Clinician turns their own interview into an adaptive one that skips what is already known. | High / moderate |
| Practice-policy-aware Assistant | Load your own controlled-substance, interval, refill, benzodiazepine and telehealth policies; flag when the plan conflicts with them. | High / moderate. Strongly differentiated for private practice. |
| Informed Consent Support | Surface the specific risks, benefits and alternatives worth discussing, then document what was actually discussed. | High / moderate |
| Patient Instructions / AVS | Today's plan as patient-friendly instructions: changes, titration, what to watch, when to call. | Very high / moderate |
| Side-effect Detective | Patient reports bruxism or restless legs; check current meds, timing, dose changes, interactions and medical alternatives for plausible contributors. | High / moderate-high |
| Symptom-to-Medication Timeline | Overlay symptoms against medication changes without declaring causation. | High / moderate |
| Records Needed Next | Suggest records that would materially help, based on what is genuinely unresolved. | Very high / low |
| Smart Record Request | Generate the ROI text for exactly those records, and why. | Very high / low |
| Portal Message Assistant | Paste a patient message; draft a response with note and med context, flag what needs a visit, produce the documentation. | High / moderate |
| Refill Review | Current dose, last documented response, side effects, monitoring, last visit, planned follow-up, unresolved issues. | High, scales with available data |
| Post-hospital / ER Follow-up Prep | Read discharge documents, reconcile meds, identify diagnostic changes, pending tests, safety issues and questions. | Very high / moderate |
| Clinical Handoff / Case Conference Summary | A tight specialist handoff instead of a chart dump. | Very high / low |
| Decision Rationale Capture | When a diagnosis or medication changes, capture just enough rationale now that the chart explains it in six months. | Very high / low |
| Patient Education Builder | Education based on what was actually discussed, not a generic monograph. | High / moderate |
| Safety Plan Integration | Move into the existing safety-plan tool with current context populated. | Very high / moderate |
| Tool Auto-routing | Recognise which tool the visit needs and offer it with context carried over. | Very high / low-moderate |
| Morning / Session Prep Queue | Who has records to review, unresolved tasks, monitoring due, paperwork pending. | Buildable, needs schedule plus patient persistence |
| Read-only EHR Context | Pull meds, diagnoses, labs, appointments and prior notes instead of pasting. | High where API or FHIR access exists |
| Write-back | Approved note goes into the EHR. | Buildable, integration-dependent, higher operational risk |
| Specialty Packs | Same workspace, different templates, frameworks, monitoring and interview capabilities per specialty. | High once the architecture is modular |

### Deliberately held back from the public page

Custom framework and interview builders, symptom-to-medication causality, portal
message workflows, refill review, morning queues, automated patient-specific
reminders. Not because they are weak. Because a public roadmap should sell a
direction, not expose every thought anyone has had, and because several of them
need persistence architecture that does not exist yet.

The public items tell one coherent evolution and should stay that way:
**interview, medications, monitoring, documents, longitudinal context, connected
tools**, with EHR-connected context labelled Exploring rather than promised. That
is how "clinical assistant" becomes literal over time.

**More Diagnostic Frameworks stays internal until we can name the frameworks.**
Decided Sept 2026, after it was briefly considered for the public roadmap.

"More frameworks" as a roadmap line is vague, and it makes the roadmap read as
disproportionately diagnostic. Frameworks already appears in the Live tier, and
the very next item is a structured ADHD interview, so a third diagnostic entry
adds nothing the reader cannot already see. The slot it would have taken is
better spent on Longitudinal Case View and Connected Clinical Tools, which are
the two items that show where the *whole workspace* is going:

- **Longitudinal Case View** signals the transition from helping with this visit
  to making sense of the patient's course across the information you provide.
  That is a much larger conceptual expansion than another framework.
- **Connected Clinical Tools** is arguably the most strategically important item
  on the page, because it explains why the separate Think Beyond Practice tools
  exist. The interaction checker, safety plan, letters and forms, Audit + Coder
  stop behaving like separate destinations and become capabilities the workspace
  invokes with the context already in front of it. That is the path to a genuine
  clinical assistant.

It becomes interesting marketing the moment it is concrete: *"Diagnostic
Frameworks: bipolar spectrum and autism next"*, or whatever we actually build.
Promote it then, not before.
