# Tier 2 clinical reference: review sheet

**You do not edit code for this.** Read the table, reply with a verdict per row, I make the edits.

## What you are approving

`rx-clinical-reference.js` holds figures the FDA label does **not** contain, so Discern can answer
"how high can I actually go" without inventing a number. Eight rows exist. All are
`verified: false`, which the model is told means *commonly cited, not clinician-verified*.

## What I can and cannot give you

I **cannot** cite sources. This container has no route to any clinical reference, and quoting one
from memory would be the exact defect this table exists to prevent, one layer down. So the
"proposed figure" column is **my training, unverified**. The only column with a real citation is
the FDA one, and only for Adderall XR, because that is the only label we have actually retrieved.

Treat this as *"here is a proposed number and my reasoning, check it against whatever you trust."*

## My recommendation before you start: delete five of the eight

Writing this sheet, I realised most of what I seeded is probably **already in the label**, which
means Tier 1 should retrieve it and Tier 2 should not duplicate it. A Tier 2 row that restates a
labeled maximum is worse than no row: it is an unverified copy of a fact we can retrieve
authoritatively, and if the two ever disagree the unverified one is sitting right next to it.

**Tier 2 should hold only figures the label genuinely lacks.**

| # | product | proposed figure | what kind of claim | my read | recommend |
|---|---|---|---|---|---|
| 1 | **Adderall XR** | 60 mg/day | practical adult ceiling | The retrieved Takeda label has **no adult maximum** (confirmed: we read `dosage_and_administration`, 4,316 chars). This is the genuine Tier 2 case. | **KEEP**, pending your check |
| 2 | **Adderall IR** | 40 mg/day, divided | practical adult ceiling | Same situation as #1 in kind, but I have not retrieved the IR label to confirm it lacks a maximum. | **KEEP or DELETE** — your call |
| 3 | **Concerta** | 72 mg/day | I believe this is the **labeled** adult maximum | If labeled, Tier 1 retrieves it and this row is a duplicate. | **DELETE** |
| 4 | **Vyvanse** | 70 mg/day | I believe this is the **labeled** maximum | Same. | **DELETE** |
| 5 | **fluoxetine** | 80 mg/day | I believe this is **labeled**, and indication-dependent | Same, plus it varies by indication, which a flat row cannot express. | **DELETE** |
| 6 | **sertraline** | 200 mg/day | I believe this is the **labeled** maximum | Same. | **DELETE** |
| 7 | **escitalopram** | 20 mg/day | labeled recommended adult dose, not a practical ceiling | This one is arguably **wrong in kind**: clinicians do exceed 20 mg. Stating 20 as a ceiling could make Discern *more* conservative than you are. | **DELETE** |
| 8 | **bupropion XL** | 450 mg/day | I believe this is the **labeled** maximum | Same. | **DELETE** |

If you take the recommendation, you review **one or two rows**, not eight, and the ones you keep
are the ones where Tier 2 actually earns its place.

## How to reply

Anything I can act on, for example:

- *"keep 1 and 2, delete the rest"*
- *"keep 1 at 60, change 2 to 30 mg, delete the rest"*
- *"delete all eight, I don't want a curated table yet"* — also a legitimate answer. Discern then
  says the label states no adult maximum and gives no practical figure, which is honest but less
  useful.

For anything you keep, tell me the number you'd stand behind and I'll set `verified: true` with
your initials and today's date.

## The rule going forward

**Nothing enters this table without a clinician approving the row.** I do not add drugs to it on
my own initiative, and I do not set `verified: true` on my own work. If Discern needs a figure
that is not here, it says so rather than filling the gap.
