# Marketing Spine — AI Scribe / Think Beyond Practice

This is the **master narrative** for the AI Scribe and the Think Beyond Practice
membership. It is the approved, canonical pitch. Reuse it — do not reinvent the
pitch from scratch each time. Cut it down per channel (see "Channel cuts" below).

House style: **no em-dashes.** Lead with the audit differentiator. Open like you
built something worth considering, not like you're apologizing for mentioning it.
Do **not** claim "no other scribe audits notes" as an absolute unless it has been
competitively established — the description is strong enough on its own.

---

## Master narrative (full — for website, email, demo page, launch post)

I built Think Beyond Practice's AI Scribe specifically for psychiatric practice, and the biggest difference is that it doesn't stop at writing the note. It audits the finished note before you sign it.

It looks for the kinds of problems that actually matter in an audit: contradictions between the HPI, ROS, MSE, assessment, medication list, and plan; missing support for the level of service; documentation that doesn't line up with what was billed; and other inconsistencies you may not notice when you're moving quickly. Then the Chart Audit + Coder evaluates the visit, recommends the appropriate coding, and shows you the reasoning behind it rather than just spitting out a CPT code.

It also helps before and during the visit, not just afterward. You can bring in the prior note and it gives you a concise rundown of what happened last time, what needs follow-up, and continuity questions so you're not digging through the chart five minutes before the appointment. If you're doing psychotherapy, it can also generate a psychotherapy guide based on what is actually going on with that patient, which helps you structure and engage in the therapy work and appropriately document the add-on when it applies.

Screeners are built in as well.

And the $119/month isn't just for the scribe. It's part of the Think Beyond Practice membership, which also includes the Chart Audit + Coder, billing/coding training, letter generation, medication interaction tools, monthly CEs, case discussion/support, and the rest of the platform.

There's a free 2-week trial if you want to actually use it with your workflow and see whether it earns its place.

thinkbeyondpractice.com

---

## Landing-page version

**Headline:**

> Your scribe shouldn't just write the note. It should help you catch what could hurt you before you sign it.

**Sub-sequence (the workflow, in order):**

> Prepare for the visit. Support the therapy. Write the note. Audit the chart. Defend the code.

This sequence communicates that this is not just transcription — it is a clinical
workflow and documentation system built around psychiatric practice.

---

## Channel cuts

- **Facebook / forum comment:** use the compact version below.
- **Website, email campaign, demo page, launch post:** use the full master narrative.
- **Landing page:** use the headline + sub-sequence above.

### Compact version (Facebook / forum comment)

I built Think Beyond Practice's AI Scribe for psychiatric practice, and the biggest difference is it doesn't stop at writing the note. It audits the finished note before you sign it: contradictions between the HPI, ROS, MSE, assessment, med list, and plan; missing support for the level of service; documentation that doesn't match what was billed. Then it recommends the coding and shows you the reasoning, instead of just spitting out a CPT code. It also preps you off the prior note (a rundown, follow-ups, and continuity questions before you walk in) and can generate a psychotherapy guide for the session so you can engage in the therapy work and document the add-on when it applies. Screeners are built in. The $119/month isn't just the scribe — it's the whole membership (Chart Audit + Coder, billing/coding training, letter generation, medication interaction tools, monthly CEs, case discussion, and the rest of the platform). Free 2-week trial if you want to run it with your own workflow. thinkbeyondpractice.com

---

## Why this works (keep these principles when adapting)

- Opens with what you built and for whom, not an apology.
- Leads with the **audit layer** — the real wedge. Other scribes write the note and stop.
- Explains the scribe across the **whole workflow**: before the visit, during the visit, after the visit.
- Ties the psychotherapy guide to something clinicians care about: actually doing and
  documenting billable psychotherapy, not just generating prose.
- Frames $119 as **membership value**, not "another expensive scribe subscription."
- Avoids overclaiming ("no other scribe does this") — not needed.

## Grounding (what the product actually does — verified in-repo)

- **Chart Audit + Coder** (`chart-coder-demo.html`, `pm-chart-coder.html`): reads the finished
  note "the way an auditor would," catches internal contradictions (e.g. HPI vs ROS, med list
  vs narrative), flags MUST-FIX items before signing, evaluates MDM across three axes
  (Problems / Data / Risk), applies the CPT 2025 2-of-3 rule, recommends E/M + psychotherapy
  add-on codes (e.g. 90833) + modifiers (25, 95), runs a second self-verification pass, and
  produces a chart-ready attestation. It does **not** write the note — it tells you what the
  note supports.
- **AI Scribe** (`pm-ai-scribe.html`, `ai-scribe-workspace.html`): writes the psychiatric note;
  prep flow builds a rundown + continuity questions from the prior note; psychotherapy guide;
  screeners built in.
- **Membership** ($119/mo, `platform?plan=full_monthly_119`): scribe is **not** sold on its
  own — it is one part of the membership, which also includes the Chart Audit + Coder,
  billing/coding training, letter generation, medication interaction tools, monthly CEs, case
  discussion/support, and the rest of the platform. Free 2-week trial at `/start-scribe`.

---

## Ready-to-fire reply variants (for "which AI scribe?" group posts)

The highest-value, lowest-effort channel: someone in a PMHNP / private-practice group
asks "has anyone used an AI scribe, which do you recommend?" **Reply, don't post** — a
helpful answer to a real question reads as a peer, a "check out my scribe" post reads as
an ad (and often gets removed). **Be early** — the first substantive reply usually becomes
the top comment and draws the follow-ups. **Reply from your own account** so the "I built
it" disclosure lands as authentic. These posts recur constantly, so keep these on hand.
All audit-first, no em-dashes. Pick by group norm.

### One-liner (brevity-first groups)

I built one, Think Beyond Practice's AI Scribe, for psychiatric practice. The big difference: it does not just write the note, it audits it before you sign (contradictions across the HPI, ROS, MSE, assessment, med list, and plan; whether the level of service is supported; then coding with the reasoning, not just a CPT code). It also preps you off the last note before the visit, and has a psychotherapy guide and screeners built in. It is part of the $119/mo membership (coder, billing/coding training, letter generator, interaction tools, monthly CEs, case discussion), not a standalone scribe fee, and there is a free 2-week trial. thinkbeyondpractice.com

### Medium

Use the **Compact version** above (the Facebook / forum cut).

### Full (warm, best when they ask "and things to consider")

Welcome to private practice! Full disclosure, I built one, so I am biased. But here is the one thing I would look at closely when you compare them: what happens after the note is written.

Most scribes write the note and stop. The one I built, Think Beyond Practice's AI Scribe, is made specifically for psychiatric practice, and its biggest difference is that it audits the finished note before you sign it. It looks for the things that actually matter in an audit: contradictions between the HPI, ROS, MSE, assessment, med list, and plan; missing support for the level of service; documentation that does not match what was billed. Then it recommends the coding and shows you the reasoning behind it instead of just spitting out a CPT code.

It also helps before and during the visit, not just after. It preps you off the prior note (a quick rundown, what needs follow-up, and continuity questions before you walk in), and if you do psychotherapy it can generate a guide for the session so you can actually do the therapy work and document the add-on when it applies. Screeners are built in.

One thing worth knowing going in: the $119/month is not just the scribe. It is the whole Think Beyond Practice membership, which also includes the Chart Audit + Coder, billing and coding training, letter generation, medication interaction tools, monthly CEs, and case discussion with other solo PMHNPs, which honestly helps a lot when you are newer to all of this.

There is a free 2-week trial, and a walkthrough on the site you can click through without signing up, so you can run it against your own workflow and see if it earns its place. Happy to answer any questions. thinkbeyondpractice.com

---

## Experience-led pitch (day-in-the-life) — sell the two "holy shit" moments

Use this for landing sections, ads, emails, and posts where you have room to show the
EXPERIENCE rather than list features. It leads with the moment of relief (it already knows
what to follow up on) and lands the audit/coding as the second payoff. **Grounding rule:**
the pre-visit rundown works off the **prior note the clinician brings in**, NOT a live EHR
or automatic lab trends (that is the future EHR-integration vision — do not imply it exists
yet). Keep the input honest ("bring in your last note, and…").

Bring in your last note, and before you walk in, Think Beyond Practice gives you a focused rundown so you are not opening the chart trying to remember where you left off:

**Since you last saw this patient**
Carries diagnoses of OCD and ADHD. Vyvanse 30 mg was started at the last visit. Last documented labs (Jan 25): A1c 5.7%, up from 5.4%. Last visit the patient reported improvement in intrusive thoughts but continued avoidance around contamination exposures. You planned to reassess medication response, appetite, ERP progress, side effects, and functional improvement.

**Ask today**
- How has Vyvanse affected attention and functioning?
- Any appetite suppression, insomnia, or activation?
- How often are the contamination compulsions happening now?
- Which ERP exposures is she working on, and has the avoidance kept decreasing?
- Is updated metabolic monitoring due?

Think Beyond Practice does that.

And that is only the start. After the visit it drafts the note in your own documentation style. Then, before you sign, the Chart Audit reads what you actually documented, the way an auditor would. It flags contradictions between the HPI, assessment, med list, ROS, MSE, and plan; clinical claims that are not well supported; and whether your MDM actually holds up the level you are about to bill.

And it does not just hand you a code. It shows you WHY. So when you are staring at a tough follow-up wondering "is this really a 99215, or still a 99214?", it walks the reasoning with you, and if the documentation does not support the higher level, it shows you what is missing. Not to inflate the code, but so you document the work you actually did and get sharper at coding over time. That is one of the things clinicians use it for most.

**Prepare for the visit. Document the care. Audit the chart. Understand the code.**
That is Think Beyond Practice.

---

## Talking about reasoning features (Discern, case reasoning, record review)

Two hard rules, both about accuracy rather than modesty.

**Never claim nobody else is doing this.** As of Sep 2026 Freed ships a persistent AI chat panel
with patient context and uploaded-document handling, and Berries has an in-session assistant that
answers contextual questions and suggests interventions and case conceptualisation. "The only
scribe that reasons" is false and checkable. The honest and stronger claim is about the whole
workflow sharing one psychiatric model of the encounter, not about owning a feature.

**Never describe it as making clinical decisions.** Avoid: AI diagnoses with you, AI treatment
recommendations, AI second opinion, your AI psychiatrist, clinical decision maker, copilot, guide,
advisor. Use: reasoning partner, think through the case, what am I missing, explore competing
explanations, challenge the formulation, surface considerations before a decision. The clinician
owns the formulation; the tool helps interrogate the reasoning that gets there. See
`CLINICAL-OS-STRATEGY.md` §34.

Address the boundary directly rather than avoiding it — members will think of it themselves, and
naming it first reads as having thought about it rather than as defensiveness.

One differentiator is true and worth using: members watch this get built from real cases and
influence it. "I ran it on an actual neuropsych evaluation, it gave me everything and told me
nothing, then I noticed the patient was tested on a stimulant and realised the tool had to
understand what changes interpretation" is a better story than any feature list.
