# CONTENT-PIPELINE.md — what we are writing and why

Working map of the member-facing post series. **This is meant to be edited**, not frozen. Its job
is to make the current shape legible so nobody (Michael, Claude, ChatGPT) has to reconstruct it
from memory or re-argue a decision that was already made. When an idea changes, change it here.

Mechanics of posting (Markdown that actually renders, schema, cadence, checksum discipline) live
in `FORUM-POSTS.md`. This file is only about **content**.

Last updated: 26 Sept 2026.

---

## 1. The current arc

**Subject:** what maintains anxiety-spectrum problems, and where treatment can intervene.

**The thesis under the whole thing:** diagnosis tells you what to call it; formulation tells you
what to do next. Find what the person is avoiding and you have often found the treatment target.

**Working series titles (not chosen yet):**
- *What Keeps Anxiety Going?* — narrow, accurate, plain
- *Beyond the Diagnosis: Finding the Mechanism* — broader, fits the TBP name, could host later arcs
- Recommendation: the second as the series banner, the first as this arc's subtitle.

### The progression

Each post sets up the next. This is the logic, in one line:

> notice the pattern → name what is being avoided → see how the disorder preserves it → target the
> maintaining behavior.

| # | Post | The one thing it argues |
|---|---|---|
| 1 | **You Can't Change What You Don't Notice** | Awareness is upstream of every therapy. Before someone can respond differently, they have to notice they are responding at all. |
| 2 | **Find the Avoidance, Find a Treatment Target** | Avoidance is defined by function, not appearance. Naming it gives clinician and patient something concrete to work on. |
| 3 | **OCD Is More Adaptable Than We Give It Credit For** | The form changes while the reinforcement loop survives. "Better" may mean quieter, not freer. |
| 4 | **Why ERP Works** | It targets the relief-seeking process rather than chasing each new ritual. Which is why you can "do exposure" and still be stuck. |
| 5+ | **Applications by presentation** | Social anxiety, panic, GAD, PTSD, health anxiety. Same lens, one presentation at a time: what is avoided, what the avoidance looks like, what the target is. |

**Why this order.** Michael's own instinct, and it is the right one: start broad. Posts 1 and 2 give
the reader a lens. OCD then lands as the most interesting *case* of that lens rather than as the
whole framework, because in OCD the compulsion is usually the avoidance, which only reads as
surprising once "avoidance is functional, not visual" is already established.

**The one real tension, named so it does not get lost:** the OCD material is the strongest raw
writing Michael has produced for this arc, and the sequence puts it third. Two defensible answers.
Either run 1 and 2 next week and OCD/ERP the week after (keeps the best material close, keeps the
logic intact), or hold OCD until the per-disorder posts have landed. **Decided: OCD and ERP run
immediately after 1 and 2.** The per-disorder applications follow and can run indefinitely.

### Next slots
- **Mon 28 Sept** — Post 1, *You Can't Change What You Don't Notice*
- **Thu 1 Oct** — Post 2, *Find the Avoidance, Find a Treatment Target*
- Nothing is in `scheduled_posts` past 24 Sept. Both slots are empty.

---

## 2. Michael's own lines — use these, do not paraphrase them

These are his, written in the moment. They are the spine of the series and they are better than any
polish of them. Where a draft needs a load-bearing sentence, start here.

**On OCD (the opening of post 3):**
> I am both enthralled and frustrated by OCD. While I enjoy treating it, it is one disorder you have
> to be mindful of its adaptability, ingenuity, etc.

**On exposure:**
> I get it, it's hard doing exposure, it requires sitting with the uncomfortableness of it.

**The thesis of post 2:**
> In anxiety disorders, if you can find what is being avoided, you find a target for treatment.

**The claim that generated the arc:**
> All anxieties are avoidance disorders. Social anxiety causes us not to be social; in OCD the
> avoidance is in the compulsion.

*Note on that last one:* it is the engine of the series, and it overstates as written. Not everything
called anxiety sits in the DSM anxiety chapter, and avoidance is not the whole disorder. Keep the
force, lose the absolute: "avoidance sits at the center of most anxiety presentations." Same house
rule as `MARKETING-SPINE.md` on not claiming an absolute we would have to defend.

**On why naming avoidance is itself the intervention:**
> Educating patients to these things starts fostering mindfulness/awareness, as well as a target for
> both of you.

**The forms of avoidance that do not look like avoidance** — this list is the substance of post 2:
escape, reassurance, checking, compulsions, overpreparing, suppression, safety behaviors, worry,
mental review, substance use, attempts to eliminate uncertainty, researching, body scanning,
rescue medication, staying excessively busy.

**The two formulation questions:**
> What is this person trying not to feel, experience, risk, remember, or not know?
> And what are they doing to make sure they don't have to experience it?

---

## 3. House rules for these posts

Learned the hard way on the 14 Sept post; they apply to every post in this series.

- **The target of change is the reader, not Michael.** He has thought this way the whole time. Never
  write "here is what this changed for me," and never split theory from practice as though the
  argument were separate from the clinical work.
- **Every section must argue something the rest of the post does not.** Section count is not a target.
- **Lists must be one category.** Do not mix an intervention, a state, a behaviour and a circumstance
  in the same list.
- **No absolutes we would have to defend.** No em-dashes (house style).
- **Sections are `# Heading`.** A line wrapped in `**` is a bold paragraph, not a heading. See
  `FORUM-POSTS.md` §1.
- **Do not judge typography in a bespoke preview.** See `FORUM-POSTS.md` §5.

---

## 4. Parked, not dropped

Real ideas that are not in the current arc. Add here rather than losing them mid-conversation.

- **Mindfulness across modalities** — the common denominator across CBT, ERP, ACT, DBT, MI. Currently
  folded into post 1; could be its own piece if post 1 gets crowded.
- **"The medication stopped working" is really OCD reorganizing** — SSRI lowers intensity, ERP never
  progresses, rituals get subtler, distress returns, medication gets blamed. Strong, and a direct
  sequel to the 14/17 Sept medication-response pair. Probably belongs after post 4.
- **Poll for a broadcast, not a post slot:** which form of OCD is easiest to miss clinically —
  reassurance seeking, mental rituals, avoidance disguised as preference, checking disguised as being
  careful, medication/safety behaviours.
- **Health anxiety**, where avoidance runs in both directions at once: compulsive checking and
  Googling, or refusing to see a doctor at all.

---

## 5. Related, tracked elsewhere

- **ADHD release** — `RELEASE-GATE-ADHD-PORT.md`. Deliberately not another ADHD content series. The
  ADHD work reaches members as a product update in a broadcast, not as posts.
- **ANCC** — virtual visit completed, awaiting the accreditation decision. A short progress note in a
  broadcast, not a post and not a headline.
- **Broadcasts** are email via `netlify/functions/broadcast-send.js`. See the Circle note in
  `CLAUDE.md`. Weekly cadence, built Friday/Saturday for Sunday or Monday.
