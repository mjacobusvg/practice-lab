# Roadmap and promise guardrails

Use this file before putting any future capability on the public site, in a broadcast,
or into a roadmap graphic.

The first question is **can we actually build it?** Not "can Michael personally code it?"
Michael is not the implementation bottleneck in the old sense. The working development model is
Michael defining the clinical problem and product behavior, with Claude / ChatGPT doing substantial
architecture, coding, debugging, testing, and iteration. That model is how the current product was
built and it materially changes what counts as feasible.

So do not reject an idea because it sounds like "too much for one founder" before checking whether
AI-assisted development plus available APIs, libraries, infrastructure, or third-party services can
actually make it work.

**Buildability is gate #1.** If we can genuinely build it, it is a potential roadmap item. The
remaining gates decide whether it is safe enough, honest enough, useful enough, and sustainable
enough to pursue or market.

This is an internal product/marketing gate. It is deliberately stricter than brainstorming, but it
should not be artificially conservative about engineering capacity.

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
> is buildable, we will see whether we can make it work safely and reliably.

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

A useful public line:

> **Have an idea? Send it. If we can build it and it makes the work better, I want to see what we
> can do with it.**

---

## 2. The roadmap gate

A feature should not appear publicly as **Coming next** unless it has passed the relevant gates
below. If it is promising but one or more are unsettled, it belongs under **On the roadmap** or
**Exploring**.

### A. Buildable with the actual development model

This is gate #1.

Ask first: **Can Claude / ChatGPT and the existing product stack actually build this, or is there a
real technical dependency that makes it impossible or impractical right now?**

Do not use "solo founder" as shorthand for "small engineering capacity." The actual development
model has already shown that substantial features can be designed, coded, tested, and iterated very
quickly with AI assistance.

A feature is potentially buildable when one or more of these are true:

- it can be implemented in the existing codebase with AI-assisted development
- the required capability exists through a usable API, library, database, or service
- the missing infrastructure can itself reasonably be built
- a working practice build can be created to test the concept before committing to the full version

A feature is **not** buildable merely because we can describe it. There still has to be a credible
technical path.

Bias toward **prototype and test** when the path is credible rather than talking ourselves out of an
idea because it sounds ambitious.

### B. Architecturally plausible

Once something appears buildable, ask how it fits the product.

Can we explain, concretely, where the feature gets its data, what context it has, where state lives,
and how the output gets back into the clinician's workflow?

Do not promise infrastructure by implication.

Examples:

- The workspace can surface monitoring considerations from medications, diagnoses, and history
  that are actually present in the session. Plausible.
- "Automatic reminders when this patient is due for labs" requires durable patient identity/task
  state, a place to store timing, and a defined delivery path. That may still be buildable, but those
  pieces have to be designed rather than assumed.
- A late-arriving record can update a working note because the session already has the note and
  the new source. Plausible.
- "The system knows when the patient's last labs were" is only plausible when those labs are
  actually in the available record or an EHR connection supplies them.

### C. Data sufficient

Does the workspace actually have enough information to do what the copy implies?

Never turn "could infer if the data were present" into "knows." Missing data must remain
missing. The product may identify what is unknown; it may not imply access it does not have.

If a feature would work once a new data source or connector is added, that does not disqualify the
feature. It means the connector or data path is part of the build.

### D. Reliable enough for the job

Ask what happens when it is wrong, incomplete, slow, or unavailable.

Low-consequence drafting can tolerate more uncertainty than medication safety, ordering,
patient communication, or an action that changes care. Design the failure mode before the
marketing line.

### E. Privacy / persistence fit

Can it work within the product's PHI and persistence model, or can the persistence model be extended
safely enough to support it?

If the feature requires durable patient-specific memory, scheduled follow-up, external delivery,
or cross-session identity, explicitly design that. Do not accidentally imply a patient registry in
marketing copy before one exists.

Needing new infrastructure is not automatically a reason to reject a feature. It is a build
requirement that has to be understood.

### F. Risk appropriate

Classify the feature by what happens if the system is wrong.

**Lower risk:** summarize, organize, draft, retrieve, identify missing information.

**Moderate risk:** surface clinical considerations, monitoring issues, interaction education,
diagnostic alternatives, or documentation requirements. These need provenance, uncertainty,
and clinician review.

**Higher risk:** place orders, send patient messages, change medications, submit forms, trigger
external actions, or act on a patient-specific schedule. These require explicit clinician
confirmation, stronger validation, auditability, and often additional infrastructure.

The roadmap may describe support for clinician decisions. Do not imply autonomous clinical care.

Risk is a filter on **how** something is built and released, not an automatic reason to avoid
building useful clinical support.

### G. Maintenance and operating burden

Keep this separate from initial buildability.

A feature can be easy to build and still create an unreasonable ongoing obligation. Ask whether it
depends on changing clinical guidance, payer rules, forms, drug data, state law, EHR APIs, vendor
contracts, or third-party services.

Price in:

- ongoing content/data updates
- vendor/API cost and rate limits
- support burden
- latency and outages
- failure recovery
- external dependencies
- whether it creates a new 24/7 operational obligation

Do **not** inflate this into generic "a small team could never maintain that" pessimism. Identify
the actual maintenance burden. If automation, a stable data provider, or AI-assisted upkeep solves
it, count that too.

### H. Reversible rollout

Prefer capabilities that can be tested in practice, feature-flagged, observed, and rolled back
without damaging existing workflows. New infrastructure and higher-risk actions need a narrower
pilot than a new synthesis view.

The default development posture should often be:

> build the smallest real version in `/practice`, test it on ugly real workflows, then decide
> whether it earns expansion.

### I. Meaningful user value

Does it solve a recurring problem clinicians actually have, or is it impressive in a demo?
Prioritize repeated friction, repeated re-entry, missed context, and work that currently happens
outside the visit workflow.

A member bringing a real annoyance or edge case is strong evidence of value, especially when the
same problem is likely to recur for other clinicians.

---

## 3. What "feasible" means here

For this project, **feasible does not mean Michael could personally engineer and maintain it by
hand.** That is the wrong model.

Feasible means:

1. There is a credible technical path.
2. Claude / ChatGPT can realistically implement a meaningful portion of that path in the existing
   development workflow.
3. Any required outside capability exists or can plausibly be built or integrated.
4. The resulting feature can be tested well enough for its risk level.
5. The ongoing cost / dependency / maintenance burden is acceptable or automatable.
6. The feature does not require us to market knowledge, persistence, connectivity, or autonomy the
   product does not actually have.

The bias is **if we can build it, let's seriously consider building it.** The other gates decide the
form, sequencing, safeguards, and public promise.

---

## 4. Public roadmap labels

Use these labels consistently.

### LIVE

The capability is in the member product now. Copy can be specific about what it does.

### NEXT / COMING NEXT

The capability has a reasonably defined workflow, has passed the relevant roadmap gates, and is the
intended next build. Do not attach a date unless there is a real commitment.

### ON THE ROADMAP

There is a credible build path and the direction is strategically useful, but architecture,
sequencing, or implementation details may still change. Describe the clinician problem and intended
capability, not implementation details that are not settled.

### EXPLORING

Interesting problem or direction, but the build path, architecture, safety, dependencies, or value
are not yet settled. Do not market it as inevitable.

---

## 5. Current roadmap examples and safe wording

### Structured Interviews — NEXT

> **Structured Interviews** — ADHD first. Starts with what is already known and helps the
> clinician systematically work through what still needs assessment instead of repeating a
> static checklist.

Buildable because Prep, source ingestion, the working note, and Framework context already exist.
The interview is another structured surface over context the session already has.

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
history/date is actually available.

Patient-specific reminders may themselves be a valid future roadmap item if we build the required
patient identity, task persistence, timing, and delivery mechanism. Do not dismiss the idea simply
because those pieces do not exist yet; treat them as the architecture that would have to be built.

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

## 6. The rule for public promises

Before publishing a roadmap line, be able to answer these questions in plain English:

1. **Can we actually build it with the development model and tools available to us?**
2. What exact clinician problem does this solve?
3. What information does the workspace have, or what new source would have to be added?
4. Where does any needed state persist?
5. What happens if information is missing or contradictory?
6. What could go wrong if the output is wrong?
7. What clinician confirmation is required?
8. What real ongoing dependency or maintenance burden does it create?
9. Can we test and roll it out at a level appropriate to the risk?
10. Can we describe it without implying functionality that has not been designed or built?

Do not make the public language vague about **what** the feature is supposed to do merely because
implementation details may evolve. Be specific about the clinician problem and intended capability;
be appropriately noncommittal about timing and implementation until those are settled.

The standard is not "could Michael code this himself?" and it is not "can we imagine it?"

The standard is:

> **Can we build a real version of it, fit it honestly into the product's architecture, make the
> risk acceptable for its role, and support what we publicly promise?**
