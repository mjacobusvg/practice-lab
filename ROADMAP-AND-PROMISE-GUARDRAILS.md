# Roadmap and promise guardrails

Use this file before putting any future capability on the public site, in a broadcast,
or into a roadmap graphic. The question is not only "could this be cool?" It is whether
it is **architecturally plausible, realistically buildable and maintainable, clinically
safe enough for the proposed role, and honestly marketable from the data the workspace
actually has.**

This is an internal product/marketing gate. It is deliberately stricter than brainstorming.

---

## 1. How to describe how the product is built

Do **not** describe the clinical content or reasoning as "crowdsourced." That can sound as
though clinical answers are being voted into existence or pulled from an unvetted crowd.

The better idea is that the **roadmap is member-shaped / clinician-shaped**.

Preferred language:

> **Built with the people who use it.** Members help shape what gets built next by bringing
> real workflow problems, awkward edge cases, and ideas from actual practice.

> **A clinician-shaped roadmap.** Have an idea that would save time, reduce friction, or make
> the workspace more useful in a real visit? Send it. If the problem is real and the solution
> is safe, feasible, and fits the architecture, we will see whether we can build it.

> This is being built in public with practicing clinicians. The roadmap changes when members
> show us a better problem to solve.

Short forms:

- **Member-shaped roadmap**
- **Built with practicing clinicians**
- **Clinician-shaped development**
- **Built from real workflow problems**

"Crowdsourced roadmap" is acceptable only if the surrounding copy makes clear that ideas are
sourced from users but product decisions are still curated, tested, and safety-gated. Prefer
"member-shaped" in most copy.

---

## 2. The roadmap gate

A feature should not appear publicly as **Coming next** unless it passes the first six gates
below. If it is promising but fails one or more, it belongs under **Exploring** or stays
internal.

### A. Architecturally plausible

Can we explain, concretely, where the feature gets its data, what context it has, where state
lives, and how the output gets back into the clinician's workflow?

Do not promise infrastructure by implication.

Examples:

- The workspace can surface monitoring considerations from medications, diagnoses, and history
  that are actually present in the session. Plausible.
- "Automatic reminders when this patient is due for labs" is **not** plausible until there is
  a durable patient identity/task model, a place to store timing, and a defined delivery path.
- A late-arriving record can update a working note because the session already has the note and
  the new source. Plausible.
- "The system knows when the patient's last labs were" is not plausible unless those labs are
  actually in the available record or an EHR connection supplies them.

### B. Data sufficient

Does the workspace actually have enough information to do what the copy implies?

Never turn "could infer if the data were present" into "knows." Missing data must remain
missing. The product may identify what is unknown; it may not imply access it does not have.

### C. Buildable by this team

"Feasible" means more than whether AI coding assistance can produce a prototype.

The feature must be realistically buildable by a clinician-founder using AI development tools
**and** supportable afterward. Price in:

- engineering complexity and dependencies
- testing burden
- ongoing maintenance
- API/vendor cost and rate limits
- latency
- support burden
- required content updates
- failure recovery
- whether it creates a new 24/7 operational obligation

A feature that can be coded in a weekend but requires constant manual babysitting is not
meaningfully feasible.

### D. Reliable enough for the job

Ask what happens when it is wrong, incomplete, slow, or unavailable.

Low-consequence drafting can tolerate more uncertainty than medication safety, ordering,
patient communication, or an action that changes care. Design the failure mode before the
marketing line.

### E. Privacy / persistence fit

Can it work within the product's PHI and persistence model?

If the feature requires durable patient-specific memory, scheduled follow-up, external delivery,
or cross-session identity, explicitly design that first. Do not smuggle a patient registry into
a roadmap sentence.

### F. Risk appropriate

Classify the feature by what happens if the system is wrong.

**Lower risk:** summarize, organize, draft, retrieve, identify missing information.

**Moderate risk:** surface clinical considerations, monitoring issues, interaction education,
diagnostic alternatives, or documentation requirements. These need provenance, uncertainty,
and clinician review.

**Higher risk:** place orders, send patient messages, change medications, submit forms, trigger
external actions, or act on a patient-specific schedule. These require explicit clinician
confirmation, stronger validation, auditability, and often additional infrastructure.

The roadmap may describe support for clinician decisions. Do not imply autonomous clinical
care.

### G. Maintenance burden

Ask whether the capability depends on changing clinical guidance, payer rules, forms, drug data,
state law, EHR APIs, or third-party services. A feature can be valuable and still be a bad fit if
keeping it correct becomes a second full-time job.

### H. Reversible rollout

Prefer capabilities that can be tested in practice, feature-flagged, observed, and rolled back
without damaging existing workflows. New infrastructure and high-risk actions need a narrower
pilot than a new synthesis view.

### I. Meaningful user value

Does it solve a recurring problem clinicians actually have, or is it impressive in a demo?
Prioritize repeated friction, repeated re-entry, missed context, and work that currently happens
outside the visit workflow.

---

## 3. Public roadmap labels

Use these labels consistently.

### LIVE

The capability is in the member product now. Copy can be specific about what it does.

### NEXT / COMING NEXT

The capability has a reasonably defined workflow, passes the roadmap gate, and is the intended
next build. Do not attach a date unless there is a real commitment.

### ON THE ROADMAP

The direction is architecturally plausible and strategically useful, but sequencing may change.
Describe the job it should solve, not implementation details that have not been designed.

### EXPLORING

Interesting problem or direction, but architecture, safety, dependencies, or maintenance are not
settled. Do not market it as inevitable.

---

## 4. Current roadmap examples and safe wording

### Structured Interviews — NEXT

> **Structured Interviews** — ADHD first. Starts with what is already known and helps the
> clinician systematically work through what still needs assessment instead of repeating a
> static checklist.

Architecturally plausible because Prep, source ingestion, the working note, and Framework context
already exist. The interview is another structured surface over context the session already has.

### Medication intelligence — ROADMAP / likely next-wave

> **Medication intelligence** — recognize the medications already in the case, surface clinically
> meaningful interactions, explain why they matter, identify what raises or lowers concern, and
> support monitoring and documentation without making you re-enter the medication list.

This extends an existing medication-interaction capability. Keep clinician review explicit.
Do not market autonomous medication changes or prescribing.

### Monitoring support — ROADMAP

> **Monitoring support** — use medications, diagnoses, and history already available in the visit
> to surface labs, vitals, ECGs, or other monitoring worth considering, show what information is
> missing, and carry the monitoring plan the clinician chooses into the note.

Do **not** say the workspace will automatically know when monitoring is due unless the relevant
history/date is actually available. Do **not** promise patient-specific reminders until durable
patient identity, task persistence, timing, and delivery have been designed.

### Context-aware letters and forms — ROADMAP

> **Context-aware letters and forms** — for FMLA/PFML, accommodations, disability, return-to-work,
> medical necessity, and similar documentation, identify what the document still requires while
> the patient is in front of you, then carry the clinical information established in the visit
> into the finished document.

The differentiator is not merely "AI writes a letter after the visit." Others already do that.
The stronger workflow is helping the clinician notice missing document requirements while the
patient is still available, then reusing the established encounter context instead of asking for
it again.

### More diagnostic frameworks — ROADMAP

> **More diagnostic frameworks** — extend the evidence-aware reasoning model beyond ADHD to
> diagnostic questions where longitudinal history, conflicting evidence, and competing
> explanations matter.

Avoid turning this into a menu of tunnel-vision "focus modes." Frameworks are optional reasoning
layers, not replacements for a broad evaluation.

---

## 5. The rule for public promises

Before publishing a roadmap line, be able to answer these questions in plain English:

1. What exact clinician problem does this solve?
2. What information does the workspace actually have when it tries to solve it?
3. Where does any needed state persist?
4. What happens if the information is missing or contradictory?
5. What could go wrong if the output is wrong?
6. What clinician confirmation is required?
7. Can this team build **and maintain** it without creating an unsustainable operational burden?
8. Can we describe it without implying functionality that has not been designed?

If those answers are fuzzy, the public language should be fuzzy only about **timing**, not about
capability. Better yet, label it **Exploring** until the workflow is real.

The standard is not "can we imagine it?" The standard is:

> **Can we explain how it would work, why it is safe enough for its role, and how we would keep it
> working after launch?**
