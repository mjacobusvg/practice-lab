# FORUM-POSTS.md — writing, scheduling and rendering platform posts

State file for everything about member-facing forum posts: how a body is written, where it is
stored, when it publishes, and how it renders. Read this before drafting, scheduling, or editing
any post, and before touching post typography in `platform.html`.

The community is on the TBP platform (`platform.html` + `netlify/functions/`), **not Circle**.
The Circle-named files and MCP connector are legacy. See the Circle note in `CLAUDE.md`.

## 1. Post body markdown: what actually renders

Bodies are written in a **deliberately limited** Markdown, rendered by
`netlify/functions/_lib/richtext.js` (`toRichHtml`). Every line is HTML-escaped first, then a
fixed allowlist of constructs is re-introduced. Nothing else survives.

**Heading levels are offset by one, because the post title is the page's `h1`:**

| you write | you get |
|---|---|
| `# Section`   | `<h2>` — **this is the normal section heading in a post** |
| `## Sub`      | `<h3>` |
| `### Sub-sub` | `<h4>` |
| `**Section**` on its own line | `<p><strong>Section</strong></p>` — **a bold paragraph, NOT a heading** |

**This last row has bitten us and cost a long debugging detour.** A line wrapped in `**` looks
like a heading in a draft and in most Markdown previews, but the platform renders it as ordinary
bold body text. It gets no heading font, no rule, no spacing, and no place in the document
outline. If a post needs sections, they must be `#` lines. Monday 14 Sep's post shipped with five
such bold pseudo-headings and had to be converted in the database after publication.

Also supported: `**bold**`, `*italic*`, `` `code` ``, `> quote`, `- ` and `1. ` lists,
`---` rules, GFM tables (a pipe row followed by a separator row), `[text](url)` for http(s) and
mailto only, and `![alt](url)` for images **only** from our own `post-images` bucket. Anything
else renders as literal text. A blank line separates paragraphs; single newlines inside a
paragraph become `<br>`.

## 2. Where posts live

**`public.scheduled_posts`** — the queue.
`id, space, title, body, publish_at, email_blast, pin, status, published_post_id, error,
created_by, created_at, forced_post_id, free_visible, ce_candidate, members_teaser, members_extra`

`body` is raw Markdown. `space` is a slug and is NOT NULL. Defaults: `email_blast` true,
`pin` false, `status` 'scheduled', `free_visible` false, `ce_candidate` false.

**`public.forum_posts`** — published posts.
`id, space_id, author_id, title, excerpt, body_html, body_plain, is_pinned, is_locked,
comment_count, reaction_count, circle_post_id, created_at, updated_at, canonical_synthesis,
post_type, ce_candidate, denial_meta, image_urls, poll, attachments, free_visible, edited_at,
members_teaser, free_readonly`

`netlify/functions/publish-scheduled.js` moves one to the other and sets
`body_html: toRichHtml(s.body)`.

**Consequence: a published post stores the source and the HTML separately.** Editing one without
the other desynchronises them. Always update `body_plain` AND regenerate `body_html` with the
same renderer, then checksum both against a local render before and after.

## 3. Cadence and conventions

- **Monday and Thursday, `publish_at` 15:00 UTC = 8:00 AM Pacific.** Unbroken since August 2026.
  Write UTC in the database; convert before reporting a local time.
- Spaces in use: `clinical-insights` (the substantive conceptual/teaching pieces),
  `shared-clinical` (discussion prompts meant to be argued with), `workflow`, `practice-growth`.
- `ce_candidate` true for substantive teaching posts, false for discussion prompts and tool
  announcements.
- `email_blast` has been false for the recent run. The only true rows are members-gated posts.
  A free post surfaces on the platform without an email push.
- `members_teaser` / `members_extra` gate a members-only section. Leave both null when the value
  of the post is the conversation, since a gate splits the thread.
- Member **broadcasts are email**, via `netlify/functions/broadcast-send.js` (AWS SES to
  `public.contacts`), scheduled by `send-scheduled-broadcasts.js`. Never route a post or member
  action through Circle.

## 4. Verification discipline (do not skip)

Stored post text carries **no trailing newline**; a local `.md` file does. Compare with
`printf '%s' "$(cat file.md)" | md5sum` against `md5(body)` in SQL, never a raw `md5sum file.md`.

Every write to a post body is verified by checksum against the local source before it is called
done. When editing published HTML, render both the old and new body locally first and diff them,
so the change is known to be confined to the intended lines.

## 5. How a post renders (reader mode)

Since commit `56c27cf` the post detail view is a **reading surface, not a dashboard panel**:

- `viewPost()` wraps the whole post (title, byline, body, members section, comments) in
  `.reader-col`: a 740px panel with the prose inset to 600px, which is ~72 characters and does
  **not** widen with the browser.
- The card chrome is removed; the article sits on the page.
- Body text is **Source Serif 4 at 18px / 1.72** in `--prose-ink`. All navigation and interface
  text stays DM Sans.
- Sidebar and topic rail drop to 30% and desaturate while a post is open, via
  `.layout:has(.reader-col)`, so there is no class to set or clear when navigating.
- Section headings (`h2`) are 1.55rem `var(--font-heading)` with a rule above and real spacing.
- Under 900px the column goes full width with 18px gutters and the rails stop dimming.

`--font-heading` is defined in the `:root, [data-theme="dark"]` block as DM Serif Display. It was
used in eight rules and declared in none for a long time, so every in-post heading silently fell
back to DM Sans. Do not remove the declaration.

**Never judge a post's typography in a bespoke preview renderer.** Drafts were previewed for
weeks in a serif, 66-character layout that did not match the platform's sans-serif, uncapped one,
which hid both the heading bug and the line-length problem. A preview must use the real
`<style>` blocks extracted from `platform.html`, or it will lie. Rendering the real file in
headless Chromium and reading computed styles is the reliable check.

## 6. Editing a post that is already published

1. Read the live `origin/main` copy of anything you will edit (`CLAUDE.md` rule 1).
2. Pull `body_plain`, transform it locally, and confirm by checksum that the transform produces
   exactly the intended change and nothing else.
3. Update `body_plain` and `body_html` in the same statement.
4. Re-check `md5(body_html)` against a local `toRichHtml` render of the new source.
5. Say plainly that a live post was edited, and what changed.
