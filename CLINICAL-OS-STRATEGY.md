# Think Beyond Practice Clinical OS Strategy

**Working strategy and product-direction document**
August 2026

## Status of this document

This is a living strategy document, not a final specification, binding roadmap, or complete description of Think Beyond Practice.

Its purpose is to preserve the product thinking, competitive observations, architectural direction, and promising ideas that have emerged while we continue building the platform.

Some ideas in this document will change. Some may be deprioritized or abandoned. Better approaches may emerge. Pricing, implementation details, naming, workflows, and technical architecture may evolve.

**Before implementing anything described here:**

- Inspect the current repository and existing architecture.
- Verify what already exists rather than assuming.
- Determine whether the proposed feature actually improves the user's workflow.
- Consider clinical safety, privacy, cost, maintenance burden, and model usage.
- Surface assumptions and tradeoffs to Michael before making consequential product decisions.

Do not treat this document as permission to implement everything in it.

## 1. The larger product thesis

Think Beyond Practice is increasingly becoming something larger than a collection of tools.

The useful framing is:

> Think Beyond Practice is an operating system for psychiatric practice.

That does not mean an EHR replacement.

It means TBP increasingly connects the major kinds of work psychiatric prescribers actually perform:

- preparing for encounters
- conducting clinical interviews
- psychotherapy support
- documentation
- chart auditing
- coding
- medication decision support
- medication interactions
- medication monitoring
- evidence review
- patient education
- forms
- letters
- administrative work
- billing knowledge
- practice operations
- continuing education
- professional consultation/community

The important architectural idea is that these capabilities should not remain isolated tools that happen to live on the same website.

The encounter should create context once.
That context should be reusable by whatever TBP capability the clinician chooses to use next.

## 2. The AI Scribe should become the encounter context layer

The AI Scribe is currently one of the most important entry points into TBP.
Its long-term role should be larger than transcription.

The Scribe already knows an enormous amount about the encounter:

- current diagnoses
- current medications
- medications started
- medications stopped
- dose changes
- treatment response
- medication failures
- adverse effects
- functional impairment
- symptoms
- psychotherapy topics
- risk concerns
- treatment decisions
- monitoring discussed
- forms or letters discussed
- future follow-up needs

The provider should not have to manually re-enter those facts into another TBP tool five minutes later.

The design principle should be:

> Capture context once. Reuse it intentionally.

The current Scribe, Chart Audit + Coder, Interaction Interpreter, Monitoring Protocol, Letter Library, Assessment Suite, Fact Checker, and other tools already provide many of the component capabilities needed for this direction. The repo also already has model proxying, ingestion and related infrastructure that may support later orchestration work.

## 3. Orchestration is more important than accumulating features

A major competitive observation came from looking at products such as PMHScribe.

Many modern scribes now provide roughly the same commodity layer:

- ambient transcription
- psychiatric notes
- custom templates
- psychiatric evaluations
- medication-management notes
- psychotherapy documentation
- CPT suggestions
- diagnosis suggestions
- configurable note style

Calling something "psychiatry-specific" may still reduce setup burden, but it is not necessarily a durable technical moat. Modern general-purpose scribes can often produce competent psychiatric documentation when given good templates and instructions.

PMHScribe also advertises adjacent capabilities such as medication education, letters, prior-authorization support, and printable orders.

Those are useful workflow conveniences, but many are fundamentally:

> encounter context + appropriate prompt/template + document generation.

TBP should not respond by simply accumulating another pile of buttons.

The stronger direction is:

> The Scribe understands what happened and surfaces the appropriate next capability with the relevant context already loaded.

That is orchestration.

## 4. Cost discipline is essential

"Clinical operating system" must not mean that every available AI function runs after every appointment.
That would create needless model cost and latency.

Do not architect this as:

> Every encounter → generate note → call Interaction AI → call monitoring AI → call evidence AI → call augmentation AI → call letter AI → call PA AI → call everything else

Most of those outputs would never be used.

Instead, the Scribe's normal encounter-processing response should eventually be able to return inexpensive structured signals alongside the note.

Conceptually:

```json
{
  "medication_changed": true,
  "medications_started": ["aripiprazole"],
  "medications_stopped": [],
  "monitoring_relevant": true,
  "interaction_review_relevant": true,
  "partial_response_detected": true,
  "letter_discussed": false,
  "form_discussed": false,
  "psychotherapy_performed": true,
  "clinical_guidance_candidate": true
}
```

These do not automatically execute those other tools.
They allow the interface to show relevant actions.

For example:

> **Actions from this visit**
> Medication change detected
> Review interactions / Review monitoring / Create after-visit medication plan
> Partial response discussed
> Explore treatment/augmentation options

The expensive or complex operation occurs only when the clinician chooses it.

Whenever possible, deterministic/structured logic should happen before an AI call.

Example:

> "Two potentially relevant medication interactions were found."

may be calculated from the Interaction Interpreter's structured data.
Only if the provider selects "Explain these in this patient's context" does an additional model call occur.

The existing Interaction Interpreter already has substantial structured functionality including medication selection, patient context, risk categories, Beers-related logic, documentation output and an AI interpretation component.

This pattern should become a general TBP rule:

> Detect cheaply. Explain/generate deeply only when requested.

## 5. Current core differentiator: Chart Audit + Coder

TBP should continue leading its Scribe marketing with the feature that is genuinely different from simple note generation.

The Scribe does not merely generate documentation.
The Chart Audit + Coder evaluates the completed chart for things that matter after documentation has been created:

- internal contradictions
- HPI vs ROS inconsistencies
- medication-list vs narrative inconsistencies
- missing support
- documentation that does not support the billed service
- MDM support
- psychotherapy add-on support
- coding defensibility

The current marketing spine correctly summarizes the workflow as:

> Prepare for the visit. Support the therapy. Write the note. Audit the chart. Defend the code.

This remains an important public-facing wedge.

"Audit-ready notes" and auditing the finished chart are not the same thing.

## 6. After-Visit Medication Plan

PMHScribe's "medication education" feature led to a useful idea, but TBP should not simply generate another generic drug monograph.

Many EHRs already provide generic medication and diagnosis education.

The more useful TBP product is:

> After-Visit Medication Plan

It should be specific to what actually happened today.

Example:

> **Changes from today's visit**
> Escitalopram: increase from 15 mg to 20 mg daily.
> Aripiprazole: start 2 mg each morning.
> **What we discussed:** expected response, common adverse effects, akathisia/restlessness, metabolic monitoring, when to contact the office

The Scribe already knows which medication changed.
TBP can potentially combine that encounter context with existing structured medication, interaction and monitoring data.

The existing Monitoring Protocol already includes medication-driven monitoring information and a patient-specific pathway capable of creating a patient-facing monitoring handout and chart-ready documentation output.

The goal should not be:

> "Here is everything anyone could ever know about aripiprazole."

The goal should be:

> "Here is what changed today, what you and your prescriber discussed, and what you actually need to remember."

This could eventually become a downloadable, printable or portal-ready output.
It should be optional.
Do not automatically invoke additional AI after every medication-management appointment.

## 7. Letter integration

TBP already has a substantial Letter Library rather than a generic "ask AI to write something" feature.

The standards include explicit thinking around:

- minimum necessary disclosure
- clinician scope
- avoiding unsupported certifications
- legally/clinically useful language
- adversarial-reader risk
- appropriate clinical judgment
- template-specific failure modes

The standards are centrally stored and versioned rather than simply improvised by the model.

The Scribe should eventually be able to hand relevant encounter context into that system.

Example:

> During encounter: patient discusses needing workplace accommodations.
> After encounter:
> **Follow-up from this visit**
> Workplace accommodation discussed → [Prepare accommodation letter]

Nothing needs to be generated automatically.

If the patient actually requests the letter two days later, the clinician can return to the encounter, choose "Prepare accommodation letter," and TBP can pass the relevant encounter information into the existing Letter Library.

This prevents duplicate data entry while avoiding unnecessary generation costs.

## 8. Form / Documentation Appointment Mode

This may become one of TBP's stronger workflow differentiators.

Do not think of it merely as:

> "AI listens and fills a PDF."

The more useful idea is:

> TBP guides the clinician through the appointment so the information required for the documentation is actually obtained.

At the beginning of the visit:

> **What are we completing today?**
> FMLA / PFML, Workplace accommodation, Academic accommodation, Return to work, Disability documentation, ESA documentation, Other

The selected form/document type loads a known information schema.

For FMLA/PFML, for example, the workflow might require things such as:

- onset
- probable duration
- continuous vs episodic incapacity
- anticipated frequency of flare-ups
- typical duration of episodes
- treatment requirements
- relevant work/functional impact

The key word is **guide**.

If the clinician has not obtained something needed, the Scribe should notice.

Example:

> Still needed: Expected frequency of episodic incapacity.
> (later) Frequency established as approximately 1 to 2 times monthly. Still needed: Typical duration of each episode.
> (later) Work-related functional impact has not yet been addressed.

The existing TBP Letter Standards already independently recognized that FMLA/PFML should not be treated as an ordinary free-text letter and contemplated a dedicated certification-prep workflow around clinical facts that must be transferred into the official form.

That is the model to expand.

## 9. PDF form filling

Once the guided clinical information exists, TBP can eventually fill actual forms.

This is a separate technical problem from gathering the information.

There are two broad categories.

**A. Fillable AcroForm PDFs**

These have actual named PDF form fields. These are relatively straightforward. The application can enumerate fields, map TBP data to them, populate them, generate a completed PDF, have the clinician review, then deliver it through the existing paid/free document workflow.

For common forms, create durable mappings.

**B. Flat/scanned PDFs**

These lack form fields. These require either known coordinate templates, a one-time mapping interface, or more complex visual/form analysis.

Do not make "support literally any scanned form uploaded from anywhere" a launch requirement.
Start with commonly used forms that can be mapped reliably.

## 10. The Scribe should guide dedicated form visits

A major distinction from ordinary ambient scribes should be that TBP can help the clinician conduct the necessary encounter.

The Scribe already has a guided philosophy. Form mode should preserve that.

For a documentation appointment, the AI should know:

- what information the chosen document requires,
- what has already been obtained,
- what remains missing,
- what questions would reasonably obtain that information,
- what requires actual clinician judgment rather than AI inference.

The model should never fabricate a required answer because "it probably means X."
Missing information remains missing until the clinician obtains or supplies it.

## 11. Prior authorization: solve the actual workflow

Do not build a feature simply because a competitor calls something "Prior Authorization."

Most real psychiatric medication PAs occur through systems such as CoverMyMeds, payer portals, electronic questionnaires, or phone workflows.

The actual provider burden is usually answering questions such as:

- diagnosis
- previous medication trials
- dose
- duration
- response
- intolerance
- contraindication
- why the requested medication is needed

A generic medical-necessity letter may occasionally help, but it does not solve most PA workflows.

A better TBP feature is:

> PA Prep

The Scribe/prior documentation assembles:

> Requested medication, Diagnosis, Relevant symptoms/functional impairment, Previous trials (each with dose, duration, result, reason discontinued), Relevant contraindications/intolerances, Clinical rationale.

The provider or staff then has the answers ready while completing CoverMyMeds.

Longer term, actual electronic PA integration could be explored separately if an appropriate API/network becomes practical.

## 12. Clinical Guidance: the potential Doximity Ask answer

Doximity's stronger competitive feature is not merely its Scribe.
Its Ask product can provide evidence-oriented clinical guidance using a substantial evidence and medication-information infrastructure.

TBP can move into this territory, but should do so narrowly and deliberately.

TBP does not need to answer every question in medicine.
It can become unusually good at psychiatric prescribing.

Potential domains include:

- antidepressant optimization
- antidepressant switching
- depression augmentation
- OCD treatment and augmentation
- ADHD medication selection
- bipolar pharmacotherapy
- antipsychotic selection
- antipsychotic monitoring
- EPS management
- medication interactions
- adverse-effect troubleshooting
- pregnancy/lactation
- monitoring
- treatment-resistant conditions

The strategic opportunity is:

> Psychiatric clinical guidance using the context of the patient already in front of you.

## 13. Clinical Guidance must not be a naked LLM

This is the highest clinical-risk idea in this document.

It should not ship as:

> send patient information to model → model says what medication to use.

The system should maintain clear separation between:

**Structured clinical/drug information** — known facts and deterministic data.

**Retrieved evidence** — relevant guidelines, labels, systematic reviews, trials or other vetted material.

**AI synthesis** — the model's interpretation of those facts and sources.

These should remain distinguishable in both architecture and user experience.

A wrong note sentence is undesirable.
A fabricated treatment recommendation can cause clinical harm.

The quality standard for this system should therefore be at least as disciplined as the Chart Audit + Coder.

## 14. Building a TBP psychiatric evidence corpus

TBP can build and maintain its own focused evidence layer.

Supabase/Postgres can store:

- source metadata
- topic
- diagnosis
- medication
- evidence type
- publication date
- effective date
- source URL
- abstract
- legally permitted source text
- TBP structured clinical synthesis
- human review status
- last reviewed date
- superseded status
- embeddings for retrieval

Potential evidence categories:

- FDA labeling
- government/public medical data
- professional guidelines where use/licensing permits
- systematic reviews
- meta-analyses
- important RCTs
- open-access literature
- clinician-reviewed TBP summaries

TBP should not indiscriminately copy subscription or copyrighted resources into its database.

Potential legal/technical sources include public government drug-label APIs such as DailyMed/openFDA and appropriately licensed research sources such as open-access literature indexed through Europe PMC. Any corpus design must track licensing and source provenance rather than assuming that access equals redistribution rights.

This evidence corpus should be curated and version controlled.

Example:

> Topic: OCD antipsychotic augmentation
> Reviewed: August 2026
> Evidence sources: guideline, systematic review, meta-analysis, relevant RCTs, FDA labels
> TBP synthesis: when augmentation becomes reasonable, relative evidence by agent, anticipated response period, major safety considerations, monitoring requirements

## 15. Clinical Guidance workflow

Potential future workflow:

Scribe identifies:

> Diagnosis: OCD / Current medication: fluoxetine 80 mg / Adequate duration: yes / Response: partial / ERP: ongoing

The provider sees:

> Partial response identified → [Explore treatment options]

Only after clicking does TBP retrieve evidence and invoke the clinical-guidance reasoning workflow.

Potential output:

> **Clinical question:** Management options after partial response to an adequate SSRI trial in OCD
> **Evidence-supported options:** ...
> **Patient-specific considerations:** ...
> **Relevant monitoring:** ...
> **Evidence:** Source 1, Source 2, Source 3

The provider remains responsible for the treatment decision.
The system should support reasoning, not pretend to replace it.

## 16. Augmentation tool integration

The augmentation tool currently under development is especially relevant to this architecture.

It should eventually be callable from the encounter.

Instead of requiring: finish visit → remember there is an augmentation tool → open it → re-enter patient's entire story

the Scribe could detect meaningful but incomplete treatment response.

Then offer:

> Explore augmentation options

The augmentation system receives the relevant encounter context automatically.

Again, do not execute it automatically.

## 17. Monitoring integration

The existing Monitoring Protocol can become an action layer attached to medication decisions.

Example:

> Aripiprazole initiated → Monitoring considerations detected → [Review monitoring] [Create patient monitoring plan]

Or:

> Lithium continued → [Review monitoring schedule]

The current Monitoring Protocol already contains medication-driven monitoring schedules and clinically relevant thresholds, plus patient-specific output capability.

Longer term this can connect to actual lab ordering.

## 18. Medication Interaction integration

The Interaction Interpreter should remain independently available.

Inside the Scribe, however, it becomes an invocable capability.

Example:

> Scribe detects medication list and planned changes.
> **Medication safety:** 2 potentially relevant interaction issues identified. [Review]

If the provider never opens it, no extra interpretation call is needed.

If they do:

- pass the medication list,
- pass relevant patient factors,
- perform deterministic lookup,
- then optionally provide patient-specific AI interpretation.

Avoid paying for clinical explanations nobody requested.

## 19. Real electronic lab ordering

A potentially important longer-term capability is actual electronic lab ordering, not merely generating a printable PDF.

Health Gorilla currently offers a Lab Network that supports electronic ordering and results workflows across connected diagnostic vendors including Labcorp and Quest. It supports FHIR/API-based ordering and also an embedded ordering iFrame.

TBP could eventually use this to close the monitoring loop.

Example:

> Olanzapine initiated
> Baseline monitoring: weight/BMI, glucose/A1c, lipids
> Labs discussed: A1c, lipid panel, CMP → [Create lab order]

The provider chooses the action.
TBP already knows much of the context.
The ordering system supplies anything still required:

- ordering provider
- patient identity/demographics
- diagnostic lab
- test codes
- diagnosis/clinical rationale
- insurance/billing information
- lab-specific Ask-at-Order questions

Then the order can be submitted electronically.
Results could eventually return through the same integration.

## 20. Health Gorilla should be investigated, not assumed

Health Gorilla is currently an interesting candidate, not a selected vendor.

Important unknowns include:

- implementation cost
- monthly/platform minimums
- per-order transaction cost
- per-result transaction cost
- implementation/certification requirements
- required provider/lab accounts
- Quest/Labcorp-specific requirements
- billing mechanics
- sandbox limitations
- production onboarding
- support model
- SLAs
- contract commitments
- BAA/security terms
- vendor-risk considerations
- current litigation and privacy implications

Do not build architecture tightly coupled to Health Gorilla until those questions are answered.

Prefer an internal abstraction such as `LabOrderingService` rather than spreading Health-Gorilla-specific assumptions throughout the Scribe.

That preserves the ability to use another network or direct integration later.

## 21. Embedded lab UI may be a useful intermediate step

Health Gorilla currently offers an embedded Lab Network iFrame that allows order entry within another application without requiring the integrating company to build the complete custom order-entry UI. It still requires tenant provisioning, configured lab connections, OAuth credentials and onboarding. Results are handled separately.

This could potentially provide an intermediate pathway:

> TBP identifies/constructs the order context → launches the Health Gorilla ordering interface within TBP → provider confirms/submits → results eventually return through the API

That may dramatically reduce first-version development compared with rebuilding a complete multi-lab ordering UI.

This should be investigated during vendor diligence.

## 22. Standalone tools should remain

Orchestration does not mean removing standalone tools.

A clinician may want to use the Interaction Interpreter without having completed a Scribe encounter.
They may want the Letter Library independently.
They may want the Monitoring Protocol as a reference.

Those tools should remain.

The change is:

> Inside the Scribe, those standalone products become context-aware capabilities.

That is the distinction.

## 23. Context should follow the provider

Long term, TBP should minimize repeated data entry.

A possible model:

```
Encounter Context
    |
    +-- AI Scribe
    +-- Psychotherapy Guide
    +-- Screeners
    +-- Chart Audit + Coder
    +-- Interaction Interpreter
    +-- Monitoring Protocol
    +-- After-Visit Medication Plan
    +-- Augmentation
    +-- Clinical Guidance
    +-- Letter Library
    +-- Form / Documentation Prep
    +-- PA Prep
    +-- Lab Ordering
```

The clinician should not repeatedly paste the same patient story into every branch.

## 24. A possible Operating System structure

Conceptually:

```
                 THINK BEYOND PRACTICE
                  CLINICAL OPERATING SYSTEM
                            |
                        AI Scribe
                            |
                    Encounter Context
                            |
        +-------------------+-------------------+
        |                   |                   |
  DOCUMENTATION        CLINICAL CARE      ADMINISTRATION
        |                   |                   |
  Note generation      Interactions        Letters
  Psychotherapy        Monitoring          Forms
  Screeners            Augmentation        FMLA/PFML
  Chart Audit          Evidence            Disability
  Coding               Med guidance        PA Prep
                       Lab ordering
```

This is a conceptual model, not a required UI layout.

## 25. The competitive position

Do not try to win with:

> "Our AI writes psychiatric notes."

That is becoming commodity functionality.

Do not try to win with:

> "We have more buttons than PMHScribe."

That is an arms race with little defensibility.

Do not claim competitors lack features unless specifically verified.

The stronger TBP position is:

- **Before the encounter:** TBP helps the clinician understand what happened last time and what needs follow-up.
- **During the encounter:** TBP guides the clinician when useful, including psychotherapy and specialized documentation workflows.
- **After the encounter:** TBP creates the documentation.
- **Before signing:** TBP audits the chart.
- **When another task emerges:** TBP already understands the encounter and can route that context into the appropriate tool.

That is much closer to an operating system than an ambient scribe.

## 26. Important UX principle: do not create a Christmas tree

Do not show twenty actions after every visit.

The orchestration layer should prioritize only what actually became relevant.

- Normal stable follow-up: Note ready / Chart audit available.
- Medication change: Medication changed → [Review interactions] [Review monitoring] [Create medication plan].
- FMLA visit: FMLA/PFML documentation, 2 required items still missing → [Continue guided questions].
- Partial response: Incomplete response identified → [Explore treatment options].

The interface should feel intelligent because it removes irrelevant options, not because it exposes every capability TBP has.

## 27. Safety principle: suggestions are not actions

The AI may identify "Monitoring may be relevant." It should not silently order labs.

It may identify "Possible augmentation question." It should not silently recommend or prescribe medication.

It may identify "Workplace accommodation discussed." It should not generate/send a letter without clinician review.

The operating system should help clinicians act deliberately.

## 28. Model-use principle

Before adding a new AI call, ask:

> Could this be accomplished deterministically from information we already have?

If yes, use structured logic first.

Use AI when the task actually needs:

- synthesis
- interpretation
- summarization
- contextual reasoning
- natural-language generation
- identifying whether required information was expressed in free conversation

Do not pay an LLM to perform database lookup.

## 29. Build sequence, not commitment

A reasonable current sequence is:

**Phase 1: Orchestration foundation.** Create the encounter-action architecture. Allow Scribe output to identify relevant follow-up capabilities without executing them. Build a standardized context object that can be passed safely into other TBP tools.

**Phase 2: Existing-tool handoffs.** Start with things TBP already owns: Interaction Interpreter, Monitoring Protocol, Letter Library, Chart Audit + Coder, existing screening/assessment capabilities.

**Phase 3: After-Visit Medication Plan.** Use medication change context plus existing medication/monitoring infrastructure.

**Phase 4: Form / Documentation Appointment.** Start with guided workflows. Do not begin with arbitrary PDF filling.

**Phase 5: Common mapped PDF forms.** Support selected reliable forms. Reuse the existing document delivery/payment architecture where appropriate.

**Phase 6: PA Prep.** Assemble the actual information providers need for electronic PA workflows.

**Phase 7: Narrow Clinical Guidance.** Build evidence infrastructure before ambitious AI recommendations.

**Phase 8: Augmentation + evidence integration.** Connect the treatment reasoning tools to patient context.

**Phase 9: Electronic lab ordering.** Only after vendor pricing, contractual, security and integration diligence.

This order can change.

## 30. Questions to ask before every new Scribe integration

Before adding a new capability, answer:

- Does the clinician actually need this during or after the encounter?
- Does the Scribe already have information that saves them from entering it again?
- Can the feature be surfaced without automatically paying for another AI call?
- Can deterministic logic do part of the work?
- Does this improve the actual workflow or merely improve our feature list?
- What happens if the AI is wrong?
- Does the clinician review before anything consequential occurs?
- Does the feature belong in the Scribe, or should the Scribe simply hand context to a separate tool?

## 31. What not to lose

The important strategic insight is:

> TBP does not need to build every possible clinical feature inside one enormous AI.
> It needs a shared encounter context and a set of trustworthy capabilities.

- The Scribe becomes the router.
- The tools remain specialized.
- The provider remains in control.
- AI runs when AI adds value.
- Structured systems handle what structured systems can handle.
- Clinical evidence remains sourced and reviewable.

And the clinician should increasingly feel:

> "TBP already knows what I'm doing, so I don't have to start over every time I need the next thing."

That is the operating-system vision.

## 32. Previsit intelligence: the missing front half

Everything §2 lists as "what the Scribe already knows" is downstream of the microphone. For a
follow-up that is fine, because last visit's note carries the context in. For a **new
evaluation the Scribe currently starts blind**, and that is the largest remaining gap in the
encounter-context thesis.

### The asymmetry, as it actually exists in the code

There are two prep paths in `pm-ai-scribe.html`, and they are not symmetric:

| | input | output |
|---|---|---|
| `prepSystem()` (follow-up) | last visit's note | SNAPSHOT / STARTING_NOTE / CHECKLIST / FOCI |
| `newEvalScaffoldSystem()` (new eval) | **nothing** (`'Produce the blank intake scaffold now.'`) | an empty sectioned form |

The new-eval scaffold is blind *by design*: its prompt says "Invent NO clinical content: no
symptoms, no findings, no history, no denials. Empty sections only," and the result is cached
in the Vault because it is the same blank form every time. That was correct when there was
nothing to feed it.

So the work is not "build a previsit feature." It is: **give the new-eval prep call a source,
and it becomes `prepSystem` for new patients.** The follow-up path already proves the output
shape — a glance snapshot plus a checklist of what to ask today is exactly what a previsit
evaluation guide needs to produce.

### Two routes into previsit context

Do not force clinicians to duplicate an intake system their EHR already runs.

1. **Bring existing intake in.** Paste or upload the intake packet, referral, or prior
   records. Cheapest to build, works for clinicians whose EHR already gathers good history,
   and it is close to free: the working note already accepts pasted text and uploads. What is
   missing is making that content visible to the *prep* call, which currently runs before it
   and reads only a prior note.
2. **Send a TBP previsit packet.** For clinicians whose EHR does not gather what they need.
   Reuses the Assessment Suite send infrastructure (tokenized one-time links,
   `assessment-create.js`), extended to collateral informants.

Route 1 first. It is smaller, it serves more clinicians, and it de-risks route 2.

### What route 1 actually is: sources, not a paste box

Route 1 above reads like "add a big paste box." That is the weak version. The durable one is
**give the Scribe sources** — a document already sitting on the clinician's own machine, pasted
text, a prior Scribe note, a referral — and let any of them feed the prep call. The bottleneck
today is not that clinicians lack the information. It is that the information lives in a
27-page neuropsych report, a discharge summary, school testing or an old psychiatric record,
and they have to hand-extract it before the Scribe can reason over any of it.

Two of this section's assumptions were checked against the code in Sep 2026 and one was wrong:

- **The Scribe's file input is transcript-only.** `#transcript-file` accepts
  `.txt,.md,.vtt,.srt,.text` — recorder transcripts, nothing else. There is no PDF or DOCX
  path in the Scribe. So "the working note already accepts pasted text and uploads" above is
  true only for plain text; reading an outside record is a real build, not a wiring change.
- **The extraction primitive already exists in this repo and is running in production.**
  `template-upload.html` loads pdf.js and mammoth from cdnjs and has an 18-line client-side
  `extractText(file)` covering `.docx / .pdf / .txt / .rtf`. Reuse it. Two changes are needed:
  it caps PDFs at `Math.min(pdf.numPages, 5)`, which has to go, and it returns `''` on a
  scanned/image PDF, which must surface as a visible "no text found, this looks scanned"
  state rather than a silent empty summary.

### Read it vs use it — two different actions, never one button

Uploading a record and reading it are not the same as bringing it into the clinical context.
Often 80% of a packet is irrelevant, and the clinician should be able to understand a document
without contaminating today's reasoning with it.

- **Read** — temporary analysis. Summarize it, and later ask it questions. No effect on prep,
  on the note, or on synthesis.
- **Use** — this source becomes transient model context for prep and reasoning this session.

### Persistence: read the clinician's file, do not become a second copy of it

The uploaded PDF is not new PHI the Scribe is creating. It is already a file on the clinician's
own device — they had to have it to upload it. So the reason not to retain it is not secrecy.
It is that **the Scribe needs temporary access to reason over the source, and has no need to
create another retained copy of it.** TBP is not becoming a document repository; the EHR owns
the chart.

The persistence that actually matters is information *generated or captured inside the Scribe*
that the clinician may not otherwise possess: ambient transcription, working-note content,
AI-generated summaries, prep output. Note that the Scribe is not persistence-free today —
`ai-scribe-workspace.html` autosaves each tab's draft to `localStorage` under
`tbp_draft_<slot>` for crash recovery. That is correct and stays.

So the rule, precisely:

> No durable server-side storage of PHI. Uploaded source documents and their extracted text
> are transient session input and must not be written to `localStorage` either — not because
> the clinician lacks that PHI, but because the Scribe has no need to hold a second copy.
> Existing browser-local draft recovery continues to apply to working-note content. If the
> clinician deliberately incorporates a document-derived summary into the note, that summary
> becomes ordinary note content and follows the same local recovery and carry-forward
> behavior as the rest of the note.

Three distinct objects, and they must not be conflated:

| | what it is | lifetime |
|---|---|---|
| **Raw source** | the file and its extracted text | in-memory only; gone on Remove or session end |
| **Temporary analysis** | a Read summary, an answer to a question, prep reasoning | session only; AI-generated is not the same as durable |
| **Clinician-approved historical summary** | what they deliberately put in the note | durable; rides the existing note rail |

Removing a source must actually drop it from the active context, not just hide its card.

### The carry-forward mechanism already exists — reuse it, do not rebuild it

An outside record is the sharpest case of a problem the Scribe already solves. `draftSystem()`
carries this rule today, verbatim:

> `PRESERVE DURABLE DATED CONTEXT (write today's note so it is a usable record for next
> visit's you): this clinician has no chart integration, so THIS NOTE is the only memory the
> next visit will have.`

and this one:

> `HISTORICAL BACKGROUND: content marked 'Historical Note:' ... carries forward VERBATIM as
> background.`

**Verbatim** is the whole point. Alongside `PROMOTE DURABLE BACKGROUND TO HISTORICAL`, the
null-update tokens that refuse to delete a carried section, and the dated med/lab/risk
trajectory rules, the Scribe already reasons about being its own future memory and already has
a rail that does not get re-paraphrased each visit.

So a chart-bound record summary is a **`Historical Note:` variant, not a new subsystem.** Do
not build a parallel "Prior Outside Records" persistence layer beside machinery that works.
Iterative re-summarization is exactly what that rail already prevents: 30 pages becomes a good
250-word summary, then 180 words, then 120, then "history of ADHD testing," and the evidence is
gone.

### Two summary intents, two different prompts

A summary has to know where it is going. These are not the same job:

- **Read summary** — efficient, for the clinician on screen, right now. "ADHD and GAD
  diagnosed; stimulant recommended, methylphenidate previously helpful." Nothing needs to
  survive it.
- **Carry-forward summary** — the durable representation of a source the Scribe will almost
  certainly never see again, because next session it receives only what was pasted from the
  last note. It must preserve what the document was, who wrote it, when, what it concluded,
  **the evidence those conclusions rested on**, developmental and longitudinal facts,
  collateral, treatment history and response, meaningful recommendations, and stated
  limitations. It is longer than the Read summary on purpose.

The instruction that carries this: *you are creating the future Scribe's memory of this source;
preserve what will matter longitudinally, do not optimize for brevity.*

There is a general principle underneath, and it is not limited to documents. Today's transcript
is **recoverable** — the whole thing is present while drafting, so synthesize freely. An outside
record is **non-recoverable**. For non-recoverable sources the threshold for discarding
information is higher.

### Provenance is a Phase 1 requirement, not a polish item

The output must never silently convert an outside-record claim into a present-tense patient
fact. "Outside neuropsychological evaluation dated 2022 documented ADHD" is a different
statement from "patient has ADHD diagnosed in childhood," and "records reviewed did not
document prior suicide attempts" is a different statement from "patient denies prior suicide
attempts." This is not only medicolegal hygiene; the attribution is what makes the clinical
reasoning correct. `ROADMAP.md` Lane B already lists "clearer separation of historical fact vs
'reported today'" as Scribe work, so this belongs in `draftSystem` and `verifySystem`, not in a
document-feature corner.

### Budget: chunk, do not throw 80 pages at one call

`clinical-proxy-stream` is pinned at Netlify's 26s maximum (see `netlify.toml`). A 27-page
report is roughly 15-20k tokens; 80 pages is 60k+. Do not solve 80 pages before the interaction
is proven — ship a graceful boundary for a large document, find out empirically what the
synchronous path handles, and if a normal-length evaluation blows the limit, move document
processing to the background-function pattern already used by `azure-transcribe-fast-background`
and the Chart Coder (`timeout = 900`). Longer term the right shape is chunk, extract the
clinically important material per chunk, then synthesize across chunks — not one enormous call,
which also loses early-page material under later pages.

### Reasoning checkpoints, not a continuously thinking AI

The model does not sit and think between calls. Continuous background re-analysis would add
cost, latency and UI churn, and would risk telling the clinician to establish childhood onset
while they are mid-sentence asking about childhood. Reject it.

Instead, discrete calls at moments the clinician controls:

1. **Prep** — one call before the visit over whatever previsit context exists. Produces the
   snapshot and the high-yield areas for today.
2. **The visit** — captured normally. No AI in the loop.
3. **Optional checkpoint** — a button ("Clinical read so far"), pressed when the clinician
   wants a second opinion, run against everything captured to that point. Returns the current
   formulation, strongest evidence, real contradictions, unresolved uncertainty, and two to
   four highest-value next questions.
4. **Final synthesis** — end of visit, over the complete record.

This is not novel architecture. The Scribe already has ~15 distinct reasoning call sites
(`draftSystem`, `verifySystem`, `refineSystem`, `elicitSystem`, `wizardSystem`,
`snapshotSystem`, …). The checkpoint is one more.

> **Constraint that decides build order: the checkpoint does not work in ambient mode.**
> Transcription happens *after* Stop (see the "Ambient fast path" comment in
> `pm-ai-scribe.html`), so mid-visit there is no transcript in the browser to reason over. The
> checkpoint is real for a clinician typing into the working note, and collapses into the
> final synthesis for an ambient visit. Prep and final synthesis work in every mode. Build
> those first, and do not lead marketing with the mid-visit moment.

### Naming

"Assessment Suite" is becoming the wrong container. Standardized instruments (PHQ-9, GAD-7,
ASRS, WFIRS), clinical history forms, evaluation modules, and collateral questionnaires are
four different kinds of thing. A surface like **Intake & Assessments**, with the Assessment
Suite living inside it, describes the actual shape better.

### ADHD as the first module

The ADHD evaluation posts are the clinical spec for the first evaluation module, and the
instrument design and AI behavior spec are recorded in `FUTURE-OPPORTUNITIES.md` (synthesis
first, gap detection second; soft gap vs meaningful uncertainty vs contradictory evidence;
"not documented" ≠ "not present" ≠ "not assessed").

There are **four** of those posts, not two. Part 1 and Part 2 argue that measurement is not
diagnosis; Parts 3 and 4 exist as well, and Part 3's material on functional targets and what
counts as the medication actually working is directly relevant to a longitudinal module — an
earlier draft of this section said "the two ADHD evaluation posts" and was wrong.

One discipline carried over from those posts: the previsit packet must not become a
fourteen-page form. Posts arguing that questionnaires are not diagnosis cannot be answered
with a 127-item questionnaire. Gather what is cheap for the patient to give and expensive for
the clinician to obtain manually — concrete examples, chronology, what systems they rely on,
when it was better or absent — and let the model summarize it so the clinician does not read
fourteen pages either.

### Marketing constraint

Any copy promising the Scribe works from "history, questionnaires and collateral already
gathered" is describing route 1 or route 2. Until one of them ships, that claim is not true
yet, and the honest version is prep plus final synthesis.

## 33. This document is intentionally incomplete

This is a starting point.

It does not define:

- final architecture
- final UX
- every clinical safety requirement
- final evidence-governance process
- final model choices
- lab vendor choice
- final pricing
- legal terms
- every form to support
- exact development timing
- every future tool

New discoveries should update this document.

When actual implementation reveals that an idea is cumbersome, expensive, unsafe, unnecessary or inferior to another design, change the strategy rather than forcing the implementation to match an old paragraph.

The goal is not to preserve this document. The goal is to preserve the reasoning while allowing the product to improve.
