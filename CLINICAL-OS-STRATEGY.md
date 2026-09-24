# Think Beyond Practice Clinical OS Strategy

**Working strategy and product-direction document**
August 2026

## The product thesis

> **AI reduces the amount of attention the clinician has to spend retrieving, checking,
> remembering, organizing, and documenting information while they are trying to think with
> another human being.**

That is the healthcare use case. Not "AI writes the note for you," and not "AI replaces clinical
judgement."

The clinician still does the hard part: hearing the patient, interpreting ambiguity, deciding what
matters, weighing risk, making the treatment decision. The product carries the cognitive overhead
around that work. It remembers the records. It notices the interaction. It knows which lab is
overdue. It brings up the right screener. It remembers the question that went unanswered. It keeps
the case file available without making anyone reread it. It captures what was decided. Afterwards it
turns all of that into documentation.

And critically, **it knows when not to interrupt.**

Most "AI in healthcare" framing starts from "how do we automate this clinician task?" This starts
from "how do we give the clinician more of their attention back?" — which is a different question
and a better one.

### The test

Every feature is judged against one question:

> **Does this give attention back, or does it steal more of it?**

A feature that answers correctly but costs forty seconds mid-visit fails the test. A feature that is
technically impressive but requires the clinician to go and find it fails the test. §35 turns this
into a workable rule by adding the dimension of WHEN — the same help has a different attention cost
before, during and after the encounter.

### What follows from it

The Scribe should behave like a subtle clinical assistant in the background, not a collection of
tools the clinician has to go and hunt down. It reads the encounter context, notices when something
clinically relevant comes up, and surfaces only the smallest useful piece of help at that moment. It
also answers quick clinician-triggered actions — check interactions, check monitoring, bring up a
safety screener, what am I missing, what should I ask next.

Mid-visit help is fast, compact, collapsible and non-disruptive. Deeper material stays available in
the case file but never competes with the patient for attention.

Anything the clinician does with those assists stays part of the encounter state, so the Scribe can
use it later when drafting the note. **The clinician should never have to remember to document work
the assistant just helped them do.**

### Validated in the field (Sept 2026): a target user described the thesis back to us

A new PMHNP evaluating the platform (Vicki H.) articulated this thesis on her own, unprompted, in
clearer language than most of our copy. It is worth treating her feedback as design principles, not
testimonials (verbatim quotes and the competitive read are in `WHY-MEMBERS-CHOSE-US.md`). The
principles she surfaced, which sharpen the direction above:

- **The Scribe preserves the clinician's reasoning; it does not do the reasoning.** The refinement
  she implicitly asks for: do the clerical work silently, and interrupt ONLY when there is something
  clinically worth thinking about, rather than a fixed preflight questionnaire before every note. The
  right form is a single, targeted, reasoning-eliciting prompt ("last visit you were weighing
  activation vs emerging hypomania; today adds reduced sleep and goal-directed behavior, has your
  formulation changed?"), not six mandatory questions. This is the attention test applied to the
  preflight: depth only when it earns its interruption.
- **Continuity surfaces unfinished clinical threads,** not just prior-note context (the "patient
  came with three new concerns and I never asked whether they tried last visit's med change" moment).
- **Therapy Coach teaches the clinician to recognize and intentionally use what they already do,**
  and to translate it into documentation, rather than fabricating psychotherapy after the fact.
- **The Coder explains WHY documentation does or does not support a code:** a learning tool, not a
  calculator.
- **One integrated psychiatric workspace / copilot,** experienced across prepare -> see -> reason ->
  document -> code -> learn -> discuss, not twelve separate utilities. The value is the whole.
- **Meta-principle:** the tools are scaffolding for becoming a better psychiatric clinician, not just
  software that makes you faster. "The workflow itself teaches" may differentiate TBP more than any
  single feature. Her own summary: "I don't just want something that makes me faster. I want
  something that helps me become better while still making my life easier."

---

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

The current marketing spine summarizes the workflow as:

> Understand the record. Prepare the visit. Reason through the case. Document the care. Audit before you sign.

(Updated Sept 2026. It previously read "Prepare for the visit. Support the therapy.
Write the note. Audit the chart. Defend the code." The audit step remains an important
public-facing wedge; what changed is that it is no longer the whole frame.)

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


## 17A. Integrative psychiatry reference: medical contributors, labs, and evidence-backed adjuncts

A useful member-facing reference can sit beside Monitoring and Discern without becoming a
"functional medicine lab panel" generator. The design principle is **question first, test second**:
start from the clinical problem, then surface only labs or adjuncts that are plausibly relevant to
that problem and distinguish routine, conditional, emerging and low-evidence options.

Working concept name: **Medical Contributors & Adjuncts** or **Integrative Psychiatry Reference**.
Do not over-brand it as "functional psychiatry" if that implies indiscriminate testing or weakly
supported claims.

### Fast reference mode

A clinician should be able to search a condition or symptom and get a compact, evidence-graded
reference.

Examples:

> **Depression**
> - medical contributors / labs to consider when indicated
> - evidence-backed supplements / adjuncts
> - major medication interactions
> - when the evidence is too weak to recommend routine use

> **OCD**
> - adjunctive supplement options with the quality of evidence made explicit
> - studied dose/formulation where evidence exists
> - interaction / contraindication check against the patient's medication list

The reference should be useful even when no patient chart is open.

### Organize labs by the clinical question, not by a universal panel

Instead of a giant "psychiatric labs" checklist, let the clinician enter or choose the thing they
are trying to explain:

- fatigue / low energy;
- cognitive complaints;
- anxiety / palpitations;
- sleep disturbance;
- depressive symptoms with atypical or unexplained features;
- possible thyroid contribution;
- restrictive diet, malabsorption or nutritional risk;
- heavy menstrual bleeding / possible iron deficiency;
- antipsychotic or other medication-driven metabolic monitoring;
- eating-disorder or nutritional concern;
- heavy alcohol use / substance-related nutritional risk;
- pregnancy / perinatal context;
- other symptom clusters where a medical contributor could materially change the psychiatric
  formulation.

For each lab or study, show:

- **Why consider it**
- **When it is actually relevant**
- **What an abnormal result may mean**
- **What it does NOT establish**
- **Evidence / guideline basis**
- **Routine vs conditional vs emerging / low-evidence**
- **Who should act on the result / when medical follow-up is appropriate**

This should explicitly resist the common failure mode of ordering every plausible lab because it
appears on a functional-medicine checklist.

### Evidence-backed supplements / nonprescription adjuncts

Build a parallel reference for supplements and nutraceuticals used in psychiatric care. The product
must make evidence quality visible rather than flattening everything into "may help."

Each entry should contain:

- indication / population actually studied;
- adjunctive vs monotherapy evidence;
- quality and consistency of evidence;
- formulation-specific issues where they matter;
- studied dose range rather than an invented "recommended dose";
- expected time horizon if supported;
- common adverse effects;
- medication / supplement interactions;
- contraindications and special-population cautions;
- renal / hepatic / pregnancy considerations where relevant;
- monitoring, if any;
- source links and evidence date;
- an explicit label such as **better-supported adjunct / mixed evidence / emerging / insufficient
  evidence / avoid or use with caution**.

The usefulness is not "a supplement stack." It is fast access to **what has enough evidence to be
worth considering, for whom, and what could make it unsafe or irrelevant.**

### Interaction checking should be one click

If the clinician is in a patient workspace, the supplement reference should be able to use the
medication list already in encounter context.

Example:

> OCD -> NAC selected -> **Check against current medications**

The interaction layer should reuse the existing Interaction Interpreter architecture rather than
inventing a separate supplement checker. The output should distinguish:
- known clinically meaningful interaction;
- theoretical / low-certainty concern;
- duplicate pharmacologic effect or bleeding / sedation / serotonergic burden;
- no important interaction identified in the available evidence;
- uncertainty because evidence is sparse.

Do not imply that "no interaction found" means proven safety.

### Discern integration

Discern should be able to surface medical contributors and adjunctive options when they are relevant
to the reasoning task, but it should not reflexively turn every psychiatric presentation into a lab
or supplement workup.

Examples:

> Patient has depression, fatigue, a vegan diet, heavy menses and restless legs.
> Discern: "Before attributing all of the fatigue and concentration difficulty to depression, it may
> be worth clarifying whether anemia / iron deficiency, B12 deficiency and thyroid disease have been
> evaluated."

> Patient asks about "natural" options for OCD while taking multiple serotonergic medications.
> Discern: "There are adjunctive supplements with varying levels of evidence. I can show the OCD
> adjunct reference and check the current medication list for interaction concerns."

This is another instance of the general rule: **the reasoning layer notices when a capability may
matter, then offers it. It does not silently run every capability.**

### Relationship to Monitoring and lab ordering

Keep these jobs distinct:

- **Monitoring Protocol** = what should be monitored because of a medication / treatment.
- **Medical Contributors & Adjuncts** = what may be worth evaluating because of the clinical
  presentation or because the clinician is considering a nonprescription adjunct.
- **Lab Ordering** = the later transactional layer that actually places an order.

The reference should be useful long before electronic ordering exists. If lab ordering is eventually
connected, a clinician can move from:
**clinical question -> evidence-backed consideration -> clinician choice -> order**
without TBP ever silently ordering tests.

### Evidence architecture and safety bar

This should inherit the evidence rules in §§12-15. Do not ship the supplement layer as a naked LLM.

The durable source model should separate:
1. structured entries (condition, intervention, population, dose/formulation studied, safety flags);
2. retrieved evidence (guidelines, systematic reviews/meta-analyses, relevant RCTs, FDA / NIH / other
   authoritative safety material where applicable);
3. AI synthesis for patient-specific context.

Every clinical claim needs provenance and a last-reviewed date. The evidence corpus should make it
easy to update a supplement entry when the literature changes rather than burying claims in prompts.


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

## 34. Discern: reasoning alongside the encounter

**Status: named, designed, NOT built.** A first version of case reasoning exists in the practice
copy (`ai-scribe-practice.html`) as a modal with starter questions and free text. Discern is the
larger thing that grows out of it. Nothing here is live.

### What it is, and the line it does not cross

Discern is a reasoning workspace beside the Scribe. Not an AI that diagnoses the patient or says
what to prescribe. Something to ask "what am I missing?", "what else could explain this?", "what
would I need to establish before calling this hypomania?", "give me four questions that would
clarify the OCD picture".

> **The clinician owns the formulation and the decision. Discern's job is to help interrogate the
> reasoning that gets there.**

That distinction is the product, not a disclaimer. It is what separates a deliberation aid from an
autonomous clinical actor, and it should be visible in the behaviour rather than asserted in
small print.

### Naming discipline

Words imply agency. Avoid **guide, copilot, advisor, consultant, recommendation engine, second
opinion** — each subtly puts the system in the directive seat. Prefer **reasoning support,
think through the case, explore competing explanations, identify what may be missing, generate
questions to clarify, challenge the formulation, surface considerations before a decision**.

"Discern" works precisely because the verb is about distinguishing carefully, not instructing.

This applies to the ADHD work too: **"ADHD Evaluation Guide" should become "ADHD Evaluation
Framework."** A framework offers a structure for reasoning; a guide implies it knows the path.

### The three layers, and the boundary that matters

The earlier rule — "Discern never touches the note" — was too blunt. If a clinician asks what
differentials to consider and adopts the answer, that reasoning belongs in the Assessment. What
must never happen is a brainstormed possibility becoming chart content because it was mentioned.

| layer | what it is | persistence |
|---|---|---|
| **Exploratory chat** | anything can be considered here: "could this be borderline?" | temporary; never documentation |
| **Adopted reasoning** | the clinician explicitly endorses a takeaway | held as case-reasoning state for this encounter |
| **The note** | Draft uses the adopted reasoning | durable, ordinary note content |

> **Discern can influence the note, but it must never silently convert exploration into
> documentation.**

The mechanism is a light, explicit move: a candidate takeaway under a useful answer with
**Keep for assessment** / **Keep as a question** / **Don't carry forward**. One click, not a save
dialog. The conversation itself stays temporary — that is a feature, not a limitation. A clinician
needs somewhere to test a hypothesis without every exploratory thought becoming permanent PHI.

Not every answer is the same kind of thing, and Discern should not treat them alike:

- **Action-only** (interview questions, a therapy technique, a patient explanation, a quick
  reminder of a criterion) — used in the moment, normally persists nowhere.
- **Clinical reasoning** (differential formulation, competing explanations, interpretation of
  conflicting evidence, rationale for diagnosing or deferring, risk formulation, why a finding is
  weighted cautiously) — a candidate for adoption.
- **Documentation output** (assessment language, plan language, patient instructions, referral
  language) — the clinician asked for chart text; offer to place it.

Some prompts signal documentation intent on their face ("summarise my reasoning so far", "what
should go in my assessment", "help me explain why I am deferring the ADHD diagnosis") and can
offer **Use in assessment** directly. "What else could this be?" cannot.

### Ambient changes the interaction, not just the interface

An ambient clinician is with the patient, not at the keyboard. Typing a question mid-visit is not
the interaction. **Ambient needs one-tap starters** — what am I missing, challenge my formulation,
what should I clarify next — rather than a chat box.

And §32's constraint still binds: ambient transcription runs **after** Stop, so mid-visit there is
no transcript in the browser to reason over. Mid-visit Discern in ambient mode reasons over prep,
outside-record reviews and anything typed — not over what was just said. Say that plainly in the
UI rather than letting a clinician assume it heard the conversation. Discern is at full strength
before the visit and after the draft; in the middle of an ambient visit it is partially blind.

Which points at a general rule worth holding across the product: **show what the reasoning layer
can currently see.** A line reading "using: prep, working note, 1 outside record review — not
available: the live recording" answers the question every clinician will otherwise ask.

### Cost and latency architecture

The rule: **on demand, one call, smallest useful context.** Never an ambient loop re-analysing the
encounter, which would be both expensive and much riskier.

Four things keep it cheap, three already implemented in the practice copy:

1. **One reasoning call per question**, streamed, invoked only when the clinician asks.
2. **Reuse work already done.** The record review — not the 35-page report — is what goes into the
   reasoning context. Prep has already distilled the prior note; use prep, not the note again.
3. **The reasoning method rides a cached system prompt.** `clinical-proxy-stream` caches system
   prompts over ~4096 characters for an hour at 0.1x on reads, so the expensive part is paid about
   once an hour rather than once a question.
4. **Retrieval only when the question needs it.** "What am I missing for OCD?" is one call.
   "What is the evidence for memantine augmentation in OCD?" is the one that earns retrieval.

Do not guess at the bill. Every AI surface already logs `est_cost_usd` with account email, tier
and model to `public.tool_usage` — run it on real use for a week and price it from data before
deciding whether a heavier "deep review" needs an allowance.

**Latency target:** first useful text within a few seconds; an ordinary answer complete in roughly
20-30 seconds. Freed publishes "typically under 30 seconds" for its chat, so that is the bar the
category has set. Anything approaching the Archive's current 60-120 seconds is unusable with a
patient present — see §32 on why that pipeline is slow and why the Scribe path must stream.

### The competitive picture, stated honestly

**Do not claim nobody else is doing this.** As of Sep 2026, Freed 2.0 ships a persistent AI chat
panel with patient context, uploaded-document handling and cited clinical evidence; Berries has a
Session Assistant that stays open during the visit and answers contextual questions, suggests
interventions, follow-up questions and case conceptualisation. The category is moving here. Any
marketing claim of novelty for "a chat beside the note" is false and would be caught.

That validates the direction rather than undermining it. The differentiation is not a feature
checkbox — a competitor adds a chat button in a week. It is what happens when every capability
shares one psychiatric model of the encounter: outside-record synthesis that understands what
changes interpretation, prep that establishes what is known, reasoning that separates evidence
from inference, provenance that survives into the note, and longitudinal memory that carries the
meaning forward. That is a clinical operating model, and it is considerably harder to copy.

Worth borrowing from what already exists: the persistent side panel (two products landed on it
independently, which is evidence); a visible indicator of what the assistant can currently see;
conversing about an uploaded document after it has been reviewed rather than re-reading it; one
chat serving many jobs through suggested starters instead of accumulating a tool per job; and
PMHScribe's prior-auth principle generalised — **use the clinical context to produce the artifact
this recipient actually needs**, rather than dumping the chart (referral summary, patient
instructions, accommodation letter, handoff, consultation summary).

Worth **not** borrowing: Freed's chat can update the note when it reads a message as an editing
instruction. That is precisely the boundary above, and we should be on the other side of it.


### Discern deep review and context-specific reasoning frameworks

The category comparison surfaced a useful distinction that should become part of the product:
**Discern should not only be a chat beside a note. It should also be able to become the entire
workspace for a dedicated case-analysis session.** A clinician should be able to open a case, add
the available records, medication list, labs, collateral and working formulation, and spend the
session doing nothing except thinking through the case.

This does not require a separate intelligence layer. It is the same Discern reasoning engine with
a different task contract, context pack and output structure.

Call the product concept **Deep Review** for now (working name, not marketing-approved):

> **Deep Review = use Discern as a structured case conference with the record in front of it.**

A Deep Review should be able to organise the case across:
- psychiatric differential and competing formulations;
- medical and neurologic contributors;
- medication effects, interactions, adverse-effect burden and monitoring;
- substance use, intoxication and withdrawal;
- patient-specific modifiers (age, pregnancy, organ function, cognition, trauma, adherence,
  social context, prior treatment response);
- risk and level-of-care considerations;
- conflicting evidence and what is still unknown;
- the next questions, tests, collateral or observations most likely to change the formulation;
- explicit "what would make me change my mind?" reasoning;
- a concise synthesis the clinician can adopt, reject or carry into the assessment.

The important product rule is the same as §34: the output is **structured considerations, not a
diagnosis or prescription handed down by the system.** The clinician weighs the evidence and owns
the decision.

This also gives us a clean way to compete with products that advertise "complex case support."
Do not answer that claim by pretending Discern has a mysterious smarter model. Make Discern better
at complex cases by giving the model **reliable context-specific scaffolding** so it consistently
checks the domains that matter in that setting.

#### Clinical Context frameworks

Discern should eventually expose an optional **Clinical Context** selector. The context does not
change the underlying model. It changes what the reasoning layer is required to attend to, the
questions it prioritises, and the structure of its answer.

Initial contexts worth building:

| Context | What the framework must reliably attend to |
|---|---|
| **General outpatient** | longitudinal course, treatment response, adherence, competing psychiatric explanations, function, psychotherapy, medication burden, monitoring, unresolved threads |
| **Medical / hospital (C-L)** | consult question, delirium/encephalopathy, medical and neurologic mimics, medication/toxic contributors, organ function, QTc/electrolytes, withdrawal/intoxication, capacity when relevant, safety, what the primary team needs from psychiatry |
| **Emergency / crisis** | immediate safety, intoxication/withdrawal, delirium/medical instability, agitation drivers, suicide/violence risk, capacity, disposition, what must be established before discharge vs admission |
| **Perinatal** | pregnancy/lactation status, gestational timing, prior perinatal episodes, maternal/fetal risk tradeoffs, medication exposure, sleep disruption, postpartum risk, feeding plans, obstetric coordination |
| **Geriatric** | baseline cognition/function, delirium vs dementia vs psychiatric illness, anticholinergic/sedative burden, falls, renal/hepatic clearance, polypharmacy, sensory impairment, caregiver/collateral, capacity |
| **Addiction / dual diagnosis** | intoxication/withdrawal, substance-induced symptoms, MOUD, cross-substance interactions, overdose risk, readiness/change, co-occurring psychiatric symptoms, what persists outside substance effects |
| **Neuropsychiatry** | TBI, seizure, stroke, movement disorder, neurocognitive disease, medication neurologic effects, temporal relationship between neurologic disease and psychiatric symptoms |
| **Child / adolescent** | development, family/system context, school function, collateral, age-appropriate differential, medication developmental considerations, safety, guardianship/consent |
| **Forensic / capacity** | exact referral question, decision-specific capacity, understanding/appreciation/reasoning/choice, coercion, reliability of information, collateral, legal vs clinical question boundaries |
| **Eating disorders** | medical stability, weight/vital trends, electrolyte/cardiac risk, compensatory behaviours, level-of-care thresholds, medication limitations, comorbidity without losing the medical risk picture |

These are **frameworks, not specialty-branded AIs.** Avoid marketing language implying the model
turns into a consultation-liaison psychiatrist, addiction psychiatrist, forensic psychiatrist, etc.
The value is that the framework reduces omission risk and gives a strong general reasoning model a
disciplined way to think in that clinical context.

#### Medical / hospital (C-L) framework in more detail

C-L means **consultation-liaison psychiatry**: psychiatric reasoning inside a medical setting where
the presentation may be psychiatric, medical, neurologic, toxic, medication-related, or several at
once. This is exactly the kind of situation where generic "psychiatric differential" prompting is
not enough because the framework must deliberately resist premature psychiatric attribution.

A C-L Deep Review should start with the **consult question**, then dynamically expand only the
relevant branches:

1. **Why is psychiatry being asked to see this patient?**
   Agitation, confusion, "psychosis", depression, refusal of care, suicidality, medication advice,
   capacity, disposition, behaviour interfering with treatment, etc.

2. **Immediate medical / neurologic explanation check.**
   Delirium/encephalopathy, infection, hypoxia, metabolic or endocrine disturbance, seizure,
   stroke/TBI, pain, sleep deprivation, medication effects, withdrawal/intoxication and other
   reversible contributors before assuming a primary psychiatric syndrome.

3. **Delirium and baseline cognition.**
   Acute vs chronic, fluctuation, attention, arousal, baseline cognitive status, surgery/ICU
   context, recent medication changes and physiologic stressors.

4. **Medication + physiology.**
   Current MAR, recent additions/stops, renal/hepatic function, QTc, electrolytes, anticholinergic
   burden, sedatives/opioids, dopamine blockade, serotonergic burden, CYP interactions, steroid
   effects, withdrawal risk and monitoring implications.

5. **Substance contribution.**
   Intoxication, withdrawal and substance-induced syndromes, including the possibility that the
   treatment choice changes materially depending on the cause of agitation/confusion.

6. **Safety and capacity when relevant.**
   Suicide/violence/elopement risk and decision-specific capacity. Never produce a generic
   "has/does not have capacity" conclusion without identifying the actual decision at issue.

7. **Psychiatric differential after the above.**
   Mood, psychosis, catatonia, anxiety, trauma-related, adjustment, substance-induced and other
   psychiatric explanations, weighted in context rather than treated as the starting assumption.

8. **What the medical team actually needs.**
   A short, operational output: working formulation, what to clarify/check, medication or
   non-medication considerations requiring clinician review, monitoring, what to stop/avoid if
   supported, when psychiatry should reassess, and disposition considerations.

The UI should not dump this eight-part checklist every time. The framework is an internal
attention map. The output should be adaptive:
- postoperative hallucinations + fluctuating attention -> delirium branch becomes dominant;
- lupus patient refusing dialysis -> capacity + medical contributors dominate;
- agitation with QTc 525 on methadone/haloperidol -> medication physiology and monitoring dominate.

That is the broader architecture rule: **context frameworks should increase reliability without
turning Discern into a questionnaire.**

#### Build sequence

This is relatively cheap compared with a new standalone product because the hard infrastructure is
already Discern + record context. Build in this order:

1. **Deep Review session mode** using the existing Discern engine and uploaded/reviewed records.
2. **General structured review** (psychiatric / medical-neurologic / medication / substance /
   patient-specific / risk / unknowns / what changes the formulation).
3. **Medical / hospital (C-L)** as the first context-specific framework because it most clearly
   proves that context changes the reasoning task.
4. Add **Emergency, Perinatal, Geriatric, Addiction and Neuropsychiatry** based on actual use.
5. Only add more context frameworks when they produce a genuinely different attention map, not to
   inflate a "30+ specialties" marketing count.

A future Deep Review can also produce a clinician-approved **consultation summary** or **assessment
reasoning block**, but only through the existing Adopted Reasoning boundary. The exploratory case
conference itself stays temporary.


### What would make this good rather than impressive

The riskiest failure is not philosophical objection. It is Discern stating a verifiable
prescribing fact confidently and wrongly — a maximum dose, an interaction, an indication — and a
clinician acting on it. §12-15's rule holds: clinical guidance never ships as a naked LLM. Reason
at the level of strategy and drug class; name the specifics that need verification rather than
asserting them; and build the evidence layer before going further.

---

## 35. Encounter phase is the organizing rule

The interface should change based on WHEN in the visit the clinician is using it, not on which
internal module owns the information.

A clinician should never have to think "do I need Prep, Framework, Discern, Review Records, or the
note?" They think "I am about to see the patient," "I am with the patient," or "the visit is over."

> **Pre-visit: help me understand.**
> **Mid-visit: help me act.**
> **Post-visit: help me finish.**
>
> **The closer the clinician is to live patient interaction, the less attention the product is
> allowed to demand.**

- **Pre-visit.** Depth is fine. The case file, unresolved issues, records, the Framework, likely
  questions. There is time to read.
- **Mid-visit.** Ruthlessly short. One important change, the next question, current dose, a safety
  flag, an interaction. Anything taking more than a few seconds to understand is too much, because
  it is competing with the patient for the clinician's attention.
- **Post-visit.** Depth returns. Draft, reconcile what was established, update the Framework,
  audit and code, unresolved follow-ups.

This extends §26 rather than repeating it. §26 filters on ONE axis — what became clinically
relevant. This adds the second: **when**. The same information, at the same relevance, has a
radically different permitted size depending on whether the patient is in the room.

### 35.1 Proven once already

The ADHD Framework split is the first working instance, not a proposal:

| Phase | Surface | Size |
|---|---|---|
| Pre-visit | The Framework panel, collapsing to a "Pt detail / info" folder tab | Dense, read before walking in |
| Mid-visit | A small card: what changed / ask next / why it matters | ~430 characters, two seconds |
| Post-visit | The full check inside the panel | Everything, including lower-priority questions |

One body of reasoning, three amounts of the clinician's attention. That is the template every other
capability should be judged against.

### 35.2 We built the tools as destinations instead of assistance

The things clinicians actually do mid-visit ALREADY EXIST in the Scribe. They are packaged wrong.

`openClinicalTool()` calls `window.open(u, '_blank')` — the Interaction Interpreter, EPS Quick
Reference, ADHD Stimulant Quick Reference, LAI Start & Switch and Crisis & Safety Plan all open in a
NEW TAB. Every one of those is a mid-visit task (an interaction check happens while you are
deciding, not afterwards), and a new tab is the most mid-visit-hostile delivery available. For a
telehealth visit it is worse than hostile: it navigates away from the window with the patient's face
in it.

The pattern should be:

> Keep the deep tool available. Surface the smallest useful answer inside the encounter first.

- "Any relevant interaction here?" → *No major interaction. Watch BP/HR because X.* → **Open full
  tool** only if depth is needed.
- "Could this be akathisia?" → *Timing and restlessness fit. Ask about inner restlessness versus
  anxiety.*

Note which surfaces are already RIGHT for mid-visit: Safety (SI/HI insert) and Smart phrases.
Instant, deterministic, no model call, no navigation. §28 asks whether something could be done
deterministically from what we already have; that question matters most in the mid-visit phase,
because latency is the enemy there in a way it is not before or after. **A two-second answer beats a
better answer that takes forty.**

### 35.3 Encounter cards and the tray

The general interaction model, generalised from the Framework's folder tab: small cards appear in
the working screen when useful, are read in seconds, and collapse into a persistent tray rather than
disappearing.

    📁 Pt detail / info   📁 Interaction check   📁 Safety assessment   📁 Monitoring

Two ways a card appears:

1. **It notices something.** The patient mentions starting fluoxetine while the workspace already
   knows about an interacting medication. A small card: *Possible medication interaction → Review.*
2. **The clinician asks.** One-click actions — Interactions, Monitoring, Safety, Scale, Next
   question — that open inside the encounter, already populated from what the Scribe knows.

**The result must flow into the note.** This is the part that makes it an assistant rather than a
widget. If an interaction check returns "fluoxetine may increase atomoxetine exposure via CYP2D6
inhibition" and the clinician decides to reduce the dose, the draft should later carry: *Drug
interaction reviewed; elected to reduce atomoxetine and monitor tolerability.* The clinician should
not have to remember to document work the assistant just helped them do. Same for a safety
assessment completed in a card, or a monitoring check.

**Be conservative about the automatic half.** Popping something up every time a medication name is
spoken becomes Clippy immediately. The threshold is: *something important enough that a competent
assistant would quietly put a sticky note beside you.* Below that, a subtle indicator
(`Clinical assist · 2`) that can be opened at a natural pause. §27 still binds: suggestions are not
actions.

### 35.4 Discern should be phase-sensitive

Discern does not need to become a separate "Companion" feature. It is the reasoning layer whose
DEPTH changes with phase:

- **Before:** "Help me think through this case."
- **During:** "What matters right now?" · "Anything I'm missing?" · "What should I ask next?" · "Could
  that be a side effect?" · "Check these meds."
- **After:** "Where does the diagnosis stand?" · "What did I leave unresolved?" · "Anything I need to
  document?"

Today it produces the same depth at every point in the encounter, which makes it near-useless in the
middle. Note also (§34) that during an Ambient recording Discern is blind to the encounter entirely,
because the recorder holds one blob until Stop.

### 35.5 Detecting the phase, and what the data can and cannot tell us

`tbpDiscernPhase()` already computes before / during / after from the recorder state and whether a
transcript has landed. Generalising that into one phase signal every surface reads is what would
make this rule enforceable rather than aspirational.

**It only works cleanly for Ambient users.** A recording is an unambiguous "I am with the patient"
signal. A clinician typing has none: typing could be mid-visit or could be catching up at 9pm.
Guessing wrong is asymmetric — showing a two-second card to someone with twenty minutes is merely
unhelpful, but hiding depth from someone who wanted it is actively bad.

Two limits on what the telemetry can establish, stated so they do not harden into assumptions:

1. **Ambient capture mode** (`capture_inperson` / `capture_telehealth_tab` /
   `capture_telehealth_speaker`) tells us the telehealth versus in-person split **among Ambient
   users**, not among all users. A telehealth clinician who types or pastes never touches the
   recorder.
2. **Session timing patterns may help infer likely during-visit versus after-visit typing, but this
   is probabilistic rather than definitive.** Someone can leave a tab open for 45 minutes and type
   afterwards; someone else can type intermittently through a 20-minute visit.

And one thing telemetry will never see: **prescribing happens in the clinician's EHR, which is
invisible to us.** Whether a clinician sends medications mid-visit, immediately after, or batched at
day's end cannot be measured from inside TBP. That is one of the few questions where asking a few
members beats instrumentation.

On medications specifically: TBP does not prescribe, and adding it is not a small step — it means
Surescripts, and EPCS with DEA-compliant identity proofing for controlled substances. The workable
split is that the **decision** is mid-visit (capture "Concerta 27 → 36" in two seconds) and the
**artifact** is post-visit (the After-Visit Medication Plan in §6). That needs no integration.

### 35.6 Why this is worth codifying now

This is no longer an ADHD Framework observation. It changes how every future feature is judged: not
"is this useful?" but "useful in which phase, and is it small enough for that phase?"

---

## 36. The mid-visit engine: listen continuously, reason occasionally

The cost objection to a live companion is real but it is aimed at the wrong thing. There are two
separate costs and only one of them is continuous.

**Hearing the visit** is the unavoidable continuous cost, and it is not the frightening part.

**Verified:** batch transcription costs **$0.18 per audio hour**, from Michael's own Azure bill
(S1 Speech to Text Batch; 41.43 hours billed $7.458 over Aug 16 to Sep 14). This is the only
transcription price in this document taken from a primary source.

**Not verified, and to be treated as indicative only:** figures circulating for streaming
alternatives — roughly $0.15/hour for a cheap streaming model, about $0.12/hour more for real-time
diarization, so ~$0.27/hour all-in; Azure real-time at $1.00/hour plus a $0.30/hour diarization
add-on. **None of these has been confirmed against a vendor's own pricing page from inside this
environment, because the egress proxy blocks azure.microsoft.com, learn.microsoft.com and
assemblyai.com.** They reached this document through conversation, not through a fetch. Confirm
every one against the vendor's page and the specific configuration TBP would actually use before
any of them enters a business model or a pricing decision.

If a live transcript REPLACES the final batch transcript rather than being added on top, the delta
is plausibly single-digit cents per visit. That conclusion depends entirely on the unverified
numbers above. See §35.5 and the Ambient dependency in §34.

**Thinking about what it hears** is where an architecture gets expensive or stays cheap. The
expensive design is: every 15 seconds, send the whole transcript plus all records plus the framework
plus the medication list, and ask "anything interesting?" That is slow, costly and irritating, and it
is exactly the mistake the Framework's own reassess made before it was rewritten as a delta.

The engine should be a hierarchy:

> **Listen continuously. Detect cheaply. Use deterministic tools wherever possible. Call reasoning
> only when ambiguity actually requires reasoning.**

### 36.1 The deterministic tier ALREADY EXISTS and is already paid for

This is the finding that changes the economics, and it was verified in-repo rather than assumed:

| Capability | File | Model calls |
|---|---|---|
| Medication interactions | `pm-interaction-checker.html`, ~490 KB | **none** |
| Screening scales | `scales-data.js`, ~20 KB | **none** |
| Monitoring requirements | `pm-monitoring-protocol.html` | rules local; ONE call, for the patient handout only |

The interaction file is not a thin wrapper around a model. It is a local rules engine carrying on
the order of 311 pharmacokinetic relationships (inhibits / induces / substrate across CYP1A2, 2C8,
2C9, 2C19, 2D6, 3A4) plus 16 named risk mechanisms — serotonergic overlap, QTc stacking, respiratory
depression, anticholinergic burden, seizure threshold, bleeding risk, lithium level risk, metabolic
risk stacking. It runs entirely in the browser.

So "check this interaction mid-visit for essentially zero marginal cost" is not a thing to build. It
is a thing TBP already owns and currently hides behind `window.open(u, '_blank')` (§35.2). **The
work is plumbing, not construction:** surface the existing engine inside the encounter instead of in
a new tab. Same for scoring a PHQ-9, GAD-7 or ASRS, and for pulling lithium or antipsychotic
monitoring expectations.

That also means the cheapest, highest-value mid-visit features are the ones that need no AI at all,
which is §28's question answered in the affirmative for most of this list.

### 36.2 Three tiers, never exposed as tiers

- **Always available, effectively free.** Scales, safety instruments, calculators, references,
  deterministic interaction and monitoring lookups. No model call.
- **On demand.** Discern, "what am I missing?", "what did that answer establish?", "what would
  distinguish these?", the Framework's mid-visit delta. Nothing happens until the clinician asks,
  which is why clinician-triggered buttons are cheaper than anticipation.
- **Live companion.** Continuous transcription lets the workspace notice something itself and
  quietly surface it.

The clinician should never see these as tiers. They should see help that is there when needed.

### 36.3 Listening is not the same as reasoning

**The workspace can listen continuously without reasoning continuously.** This is the distinction
that makes a live companion financially plausible.

A text stream can be watched cheaply for medication names, treatment decisions, safety language,
symptom changes, contradictions, labs and diagnoses. Only when one of those produces a meaningful
event does anything wake up — and what wakes first should be a deterministic tool, not a reasoning
call. Reasoning is for genuine ambiguity: does what she just said materially change the picture,
could this be activation rather than hypomania, what one question would separate these.

Two honest limits on the cheap-detection step:

1. It needs a trigger vocabulary. The interaction dataset supplies the drug terms; safety language
   and symptom patterns would need their own lists, and simple text matching on a live transcript
   will produce false positives. The threshold matters more than the detector.
2. Automatic noticing requires live transcription, which TBP does not have (§34). Everything in the
   on-demand and free tiers works today without it.

### 36.4 A cheaper hybrid worth keeping in the discussion

Recording locally costs nothing (the WAV path already holds PCM in browser memory — see §34). So the
browser could keep a rolling buffer of the last 60 to 120 seconds WITHOUT transcribing it, and
transcribe only that snippet when the clinician presses something like **"check what we just
discussed."**

That cannot support automatic alerts, because the system cannot understand audio it never
transcribed. But it gives an on-demand companion at a fraction of continuous-streaming cost, and it
is a genuinely smaller first step than streaming the whole appointment.

### 36.5 The pipeline

> **Listen -> detect -> route -> answer -> remember**

- **Listen.** Continuous transcription, when it exists. Not required for anything below except the
  automatic trigger.
- **Detect.** Cheap text matching for medication names, treatment decisions, safety language,
  symptom changes, contradictions, labs, diagnoses.
- **Route.** *This is the step that decides the cost.* A deterministic tool if one exists; model
  reasoning ONLY when interpretation is actually required.
- **Answer.** The smallest useful thing, in a card, in the encounter.
- **Remember.** The result becomes part of the encounter state.

**Remember is not optional.** If the clinician opened an interaction check, completed a safety
assessment, scored a scale or reviewed monitoring, that work must reach the note without being
retyped. Otherwise the clinician does it twice, and a tool that makes you document your own use of
it has taken attention rather than given it back — the thesis inverted, in the one place it is
easiest to invert by accident.

### 36.6 The version that is buildable now, before live transcription

Nothing in this needs streaming. A compact row in the working screen:

    Check:  Interactions · Monitoring · Safety · Scale · EPS · Discern

- **Interactions** -> the existing local engine, in a card, not a new tab.
- **Monitoring** -> the relevant requirements for a medication being considered, from the local
  rules. Not "her TSH is overdue" — that needs the chart (§35.5).
- **Safety** -> the assessment opens in the workspace and is walked through with the patient.
- **Scale** -> pick, use and score it in place, from `scales-data.js`.
- **EPS** -> the applicable local guidance.
- **Discern** -> the only one of the six that invokes reasoning.

Five of the six are deterministic. Every card follows the §35 rule: show the answer needed now,
expand to the full tool only on request, collapse into the tray when read. The automatic trigger
layer arrives later and changes nothing about this surface except who initiates it.

This is the first Companion version, and it is mostly plumbing over capability that already exists.
**It should come before another large clinical feature.** TBP already owns more of the intelligence
than it looks like; what it lacks is behaving like an assistant rather than a toolbox.

### 36.7 Why this fits the thesis

Computation is spent only when spending it might save the clinician attention — not because another
thirty seconds of audio happened. An always-on system that reasons continuously would burn money to
produce interruptions, which is the thesis inverted.

### 36.8 The surface now exists, and it is not an ADHD feature

**Decided Sept 2026, from the first real mid-visit use.** The ADHD Framework's mid-visit check
produced a small floating card — WHAT CHANGED / ASK NEXT / WHY IT MATTERS — sitting over the working
note, with the full framework collapsed behind a folder tab. That card is the encounter-assist
surface described in 36.6. It was built for the ADHD Framework and it is not an ADHD feature; the
Framework is simply the first thing that had something to say into it.

Stop calling it the Framework delta popup. It is the surface; the Framework is a producer.

Every capability in the 36.6 row targets the same physical card, with the same contract:

| Producer | The card says | Expands to |
|---|---|---|
| Interaction check | Fluoxetine may meaningfully increase exposure to X | `pm-interaction-checker.html` |
| Monitoring rules | Lithium level appears overdue | the monitoring view |
| Safety detection | Suicidal thoughts mentioned | the safety assessment |
| Scales | PHQ-9 fits what is being described | `scales-data.js` |
| Discern | One unresolved issue may change the differential | Discern |
| ADHD Framework | Prior 'strong student' account retracted | the Framework panel |

Three rules the first build established, which any new producer inherits:

1. **One thing owns the clinician's attention.** The card arriving collapses whatever long document
   produced it. Holding the working note, a full reference panel and a new card at once is the
   attention split the card exists to end — and it is what the first version accidentally did.
2. **Telegraphic, not merely short.** "One sentence" is not a length limit; a forty-word sentence
   satisfies it and is still a paragraph to someone mid-interview. Sixteen words per line, the fact
   rather than the narration of it, no parenthetical explaining the reasoning. The reader was in the
   room. Depth lives one click away, never on the card.
3. **Dismissal is not deletion.** A read card collapses into the encounter's tray and stays part of
   encounter state, so the Scribe can use it when the note is drafted.

Not yet built: the shared tray, the non-ADHD producers, and any automatic trigger. What exists is
one producer and the card. That is the right order — the surface is proven against a real visit
before anything else is pointed at it.

---

## 37. Interview, Framework, Check: three jobs, not one feature

**Settled Sept 2026.** Write this down because the question keeps reopening: *wasn't this supposed
to be the ADHD interview?*

The ADHD Framework started as an intended DIVA-style interview guide and became something else.
That is a **discovery, not a drift**. Anyone can ship a forty-question ADHD instrument — DIVA is
free and a PDF does the job. What nobody ships is the thing that reads four prior notes and says
*the screener this diagnosis rests on is absent from the record, and the ASD differential was
opened by the same clinician and then abandoned.* That is not a question list. It is a reasoning
layer, and it is the harder and more distinctive problem.

So stop asking the Framework to be both. Three named pieces:

| | What it is | Whose job |
|---|---|---|
| **ADHD Interview** | The clinician's questioning structure. Customizable, with a Think Beyond default for anyone who has not made one. | The clinician's |
| **ADHD Framework** | The evidence-state engine. Reads records plus encounter material; tracks what is established, what was merely assumed, where the record is weak, what would move the evaluation. | The AI's |
| **Framework Check** | The lightweight mid- or post-visit delta from that engine: given what was just learned, what matters now. | The bridge |

They interact without being the same thing. A clinician can be halfway through their own interview,
hit Check, and get back:

> You have established current impairment and childhood classroom difficulty. Still unclear:
> impairment outside school before age 12. Ask about home or extracurricular settings.

Then they go on interviewing the way they always have. The Framework never takes over the
questioning; it watches what the questioning establishes.

**What this rules out:** turning the Framework into a forty-question instrument, and shipping a
second rigid interview form as a new module. The Interview is a template kind (see ROADMAP lane
7b), reusing the Vault pattern that already exists.

**What this rules in:** the Framework getting steadily better at the evidence problem, which is
where its actual advantage is.

---

## 38. The interview as an evidence-aware question bank (designed Sept 2026, NOT built)

**Built so far (`ambient-108-sub` / `109-sub`, practice):** the interview is a Vault-stored
`interview_<kind>` with a house default served live from Michael's Vault, loaded by an explicit
prep-screen action into its own collapsible work area, with per-heading folding. It is a static
question list. Everything below is designed and deliberately not built.

**The idea.** Record review should change what the interview *shows you*. If the clinician uploaded
prior records, the product should not make them look at 35 questions whose answers are already in
those records. Each section carries an evidence state:

| State | Meaning | Default |
|---|---|---|
| **Established** | Enough credible information is already in the record | Collapsed |
| **Partial** | Some information exists, an important piece is missing | Open, showing only the gap |
| **Open** | Little or nothing useful established | Open |

```
DEVELOPMENTAL HISTORY            Mostly established
5 questions covered by records · 2 worth asking
  ASK
  • Before age 12, did these problems also happen at home or outside school?
  • Did you need unusual supervision or reminders to keep up?
  Show record evidence · Show 5 covered questions
```

**The rule that makes this safe, and it is not optional.** Record-derived information populates a
separate **Known from records** layer WITH PROVENANCE. It must never autofill as though the patient
said it today:

```
Known from records
  Mother reportedly described frequent homework loss and classroom redirection in elementary school.
  Source: prior psychiatric evaluation, 5/22/26
Ask today
  Were those difficulties also present at home or in activities outside school?
```

This preserves attribution, lets contradictions surface rather than being silently reconciled, and
keeps historical documentation from becoming present-tense patient report — the same rule
`ROADMAP.md` lane 7 already states for outside records, and the same failure the draft prompt's
interview rule guards against today.

**Never delete a bypassed question — recede it.** A clinician will sometimes read the record-derived
evidence and decide they do not trust it. `Show covered questions` must always be there.

**Division of labour.** The Interview does not judge sufficiency. The Framework does, and the
Interview renders the consequence:

> Current inattention: well supported. Childhood school impairment: supported.
> Childhood cross-setting symptoms: unresolved. Learning disorder: unresolved.

The loop: upload records -> Framework interprets evidence -> Interview compresses around what is
still missing -> clinician conducts the visit -> Framework Check updates the gaps -> Interview
adapts again.

**The completion counter is a placeholder.** The folded heading currently reads `3 of 8 answered`,
which is a form's framing: it implies eight questions were meant to be answered. They were not —
some are irrelevant to this patient, some are already established, some were deliberately skipped.
Once evidence state exists the counter becomes the honest version, `3 answered · 4 covered by
records · 1 still open`, and completion stops being the measure.

**Why this is the leap.** It lets the default interview be comprehensive WITHOUT FEELING
comprehensive. Forty or fifty questions can sit underneath it because the clinician should rarely
see forty or fifty; they are the question bank, and the encounter view is the subset this patient
still needs. That is the difference between this and a PDF.

**Prerequisites, in order.** (1) The static interview has to be used on real visits first — it is
untested. (2) The Framework must already produce per-domain evidence states; today it produces
prose sections, not a structured state per interview heading. (3) Provenance has to survive the
record-extraction path. None of these is blocked; none should be skipped.

---

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
