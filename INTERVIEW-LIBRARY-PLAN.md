# Named reusable interviews: what exists, what is missing

**Analysis and proposal. Nothing built. Stop for approval.**

The product position this serves: *"here is a strong starting interview; if you already have one
you like, use yours."* Not *"here is the Think Beyond ADHD evaluation you should use."*

---

## The distinction the architecture already makes

**Evaluation / HPI template** = how the finished note is organised.
**Interview / question set** = what is in front of the clinician to ask during the visit.

These are separate objects in the code today, not one object used two ways. That was the hard
part and it is done.

## What is ALREADY built

| capability | where | state |
|---|---|---|
| Interview stored separately from the note template | `vaultInterviews` / `houseInterviews` | built |
| Storage keyed for multiple kinds | `interview_<kind>` (comment at :1387 says "keyed so adding a second kind is a kind, not a redesign") | **shape built, one kind used** |
| Interview carries a NAME end to end | `wnSections.interviewName` through the serializer (:7500), the panel title (:7630), the parser (:7559) and draft persistence (:11530) | **built, fully plumbed** |
| Clinician can edit the interview | `#interview-edit`, `#interview-editor`, `#vl-interview-edit` | built |
| Save edited interview to the Vault | `vault_profile.interview_adhd` | built |
| House default, overridden by the clinician's version | `houseInterviews` vs `vaultInterviews` | built |
| **Parse arbitrary plain text into headings and questions** | `tbpInterviewSplit` (:7583) | **built** |
| Safety contract: scaffolding is not evidence | Draft strips it (B.9), unanswered establishes nothing (C.1, C.4 both PASS) | built and gate-tested |

**The parser is the import path.** `tbpInterviewSplit` already turns plain text into the
heading/question structure. Pasting an existing evaluation is largely solved; it simply has no
door.

## What is MISSING

1. **`INTERVIEW_KIND` is a hardcoded constant** (`:9132`, `var INTERVIEW_KIND = 'interview_adhd'`).
   The storage shape supports many; exactly one is ever addressed.
2. **No library.** `vault_profile` holds one interview blob. There is no list, so there is no
   second interview to choose between.
3. **No picker** at visit setup. The interview row shows or hides; it does not offer a choice.
4. **No import door.** Zero matches for any import, upload or paste path into an interview.
5. **No name-on-save.** `interviewName` is recovered from the serialized header label, not set
   by the clinician when saving.

## Smallest release-ready implementation

In rough order of value per unit of work.

**1. Turn the constant into a selection.** `INTERVIEW_KIND` becomes a variable set from the
clinician's choice. The `interview_<kind>` storage pattern needs no change. This is the whole
architectural step and it is small.

**2. A named list in the Vault.** `vault_profile.interviews` as `{ key: {name, text} }`,
with the existing `interview_adhd` migrated in as one entry so nothing is lost. The house
interview stays the fallback when the list is empty.

**3. A picker in visit setup.** "Interview: [Think Beyond ADHD | My ADHD evaluation | Initial
psych eval | none]". Feeds the selection from step 1.

**4. Import by paste.** A textarea, run through `tbpInterviewSplit`, shown in the EXISTING
editor for review and correction, given a name, saved to the list. No new parser, no new editor.

**5. Create from scratch.** Falls out of 4 for free: an empty paste box is a new interview.

### Deliberately NOT in the smallest version

- **File upload (.docx/.pdf).** Needs extraction. Paste covers the common case, since a
  clinician with an existing evaluation can select and copy it. Add later if paste proves
  insufficient, which is a real question rather than an assumed one.
- **Sharing interviews between members.** Different feature, different permission model.
- **Any ADHD-specific logic.** The point is that nothing here is ADHD-specific. The kind is
  a key.

## The safety line, and why it is inherited rather than rebuilt

**An imported question set is scaffolding, not patient evidence.** It must go to the Vault, NOT
through the outside-records ingestion path, and must never become an encounter source.

The existing contract gives this for free *provided import writes to the vault path*: the Draft
strips the interview entirely (B.9), unanswered questions establish nothing (C.1, C.4), and the
Framework reports nothing from them (C.3). Those are the same guarantees the house interview
already has, because an imported interview is the same object in the same slot.

**The failure mode to guard against:** routing an uploaded evaluation through "Review outside
records" would make a question the patient was never asked look like documentation. That is the
exact confusion Block C exists to prevent, and it is why import needs its own door rather than
reusing the records door.

## Where this sits relative to the release

**This is not built and the ADHD interview release does not require it.** The interview is
already clinician-editable and savable; what is missing is having MORE THAN ONE and bringing an
existing one in.

Two defensible calls:

- **Ship the interview release without it.** The clinician can already edit the house interview
  into their own and save it. They just cannot keep two.
- **Hold the release for it**, on the argument that shipping "use our ADHD evaluation" first and
  "or bring your own" second sets the wrong expectation about whose interview it is.

The second is a product judgement, not an engineering one. Steps 1 to 3 are small; step 4 is the
one with real surface area, and it is the one that makes the position true.
