# What editors can do

Back to the [README](../README.md). The guide to send to someone you invite is [for-editors.md](for-editors.md), and every tool is described on [kilncms.com/docs](https://kilncms.com/docs).

## The editor

Click any outlined text and type. (Editable parts show their outline for a moment when
the page opens, and keep a faint one on touch screens.) The toolbar has **bold / italic /
underline / lists / links / clear** and a **Style** menu listing the site's own CSS classes
(`window.KILN.styles`), so typography stays designed and editors pick from the palette.
Everything stages on the page and publishes together as one commit: a **Publish** button
showing the number of edits appears beside the pencil as soon as there is something to
publish. It opens a sheet that shows each edit as before and after (changed words marked,
pictures side by side, added and removed blocks named), where one edit can be dropped and a
one-line note becomes the commit message. For ten seconds after publishing, **Undo** takes
that publish back as one more ordinary commit and returns the edits to the page.
**⌘Z / Ctrl+Z** undoes any staged change, blocks and image swaps included.

- **Images** — click to replace: upload one (auto-compressed), or pick **From this
  site** from the pictures the repository already holds (no new file is committed).
  Write alt text, and drag the corner handle to resize the moment the image is added. Kiln keeps the full-resolution
  original and publishes a web-optimized copy at the chosen size, so enlarging later
  never degrades.
- **Documents** — insert a PDF or file into text as a link, a chip, or a card, and
  choose whether it opens in a new tab or downloads. Files land in `/assets/files/`
  (or the gated `/members/files/` on a members page). Invited editors can add
  pictures, PDFs, Office documents, fonts, audio and video, up to 15 MB each;
  [the owner's guide](for-site-owners.md#what-editors-can-upload) has the list.
- **Blocks & tables** — anything in a `data-cms-repeat` gets duplicate / reorder /
  remove / tag controls, table rows included. Tag blocks and visitors get automatic
  filter buttons.
- **Galleries & events** — add a photo gallery (multi-upload, captions, per-gallery
  thumbnail size; visitors get a full-screen viewer) or an events list (structured
  form; visitors get list + month/week/day calendar views) anywhere on a page — you
  click where the new section goes.
- **Drafts, scheduling, history** — save privately, publish at a chosen time, and
  browse every published version in plain language. Undoing always **previews on the
  page first** (keep or cancel), per section or for the whole page, and undoing a
  publish that *added* a section removes it again.
- **Site-wide** — **Site menu** edits navigation across every page in one commit;
  **Find & replace** changes a phrase everywhere at once; **Page settings** edits the
  title, description, and social image; **+ New** creates posts and pages from your
  `_templates/`.
- **Together** — editors see who else is online and on which page; conflicting edits
  to the same field get an explicit warning with both versions kept. **💬 Comments**
  pin review threads to any element on the live page (resolve, reopen, badges), and a
  **Reviewer** seat comments without being able to change anything.
- **Suggest & approve** — suggest-only editors propose; owners see per-field
  before/after in a **Suggestions** queue and approve (a conflict-safe merge that
  keeps the suggester's name on the commit) or decline. With one `preview` config
  line, drafts and suggestions get real branch-preview URLs from your host.
- **Versions with names** — name any publish ("summer menu"), and every restore
  shows a side-by-side "now vs. then" preview before it stages.
- **⌘K** — jump to any page, field, or tool, or search the site's text with
  in-context results.
- **Sections & theme** — "+ Add section" composes pages from the repo's `_blocks/`
  library (dev- or AI-authored, so everything stays on-brand), and the **Theme**
  panel turns the site's `:root` CSS variables into color pickers and font menus —
  applied as byte-exact stylesheet commits.
- **AI assist** (optional, bring your own key) — improve/shorten/retone/translate any
  field with a before/after preview, generate image alt text, or draft a new post
  from a one-line brief. Same sanitizer, same commit pipeline, grant-gated.
- **On a phone** — the whole editor reshapes into bottom sheets with thumb-sized
  targets and a keyboard-aware toolbar. Update your hours from the parking lot.

## Blog posts with no build step

Put two files in your repo, `_templates/post.html` (a full page using
`data-cms="post_title|post_date|post_body"`) and `_templates/post-card.html` (the list
card with `{{title}}/{{href}}/{{date}}` placeholders), and give your blog index a
`data-cms-list="post_list"` container. The **+ New post** button clones the template and
splices a card into the index as ONE atomic commit (Git Data API), so the site never
deploys half-written. The new post page is itself click-editable.

## The API, and safe AI write access

The page is the schema: `GET /api/v1/fields?path=/` returns a page's editable
fields as JSON, `PATCH /api/v1/edits` writes them back as a sanitized, attributed
git commit. Owners mint tokens scoped by path, section keys, read-only, and expiry
— a token is a headless, scoped editor session, and it inherits every guard the
proxy applies to humans. On top of it, [`mcp/`](../mcp/README.md) ships **kiln-mcp**:
point Claude (or any MCP client) at your site and every AI edit is field-scoped,
script-proof, and one `git revert` from gone. "Every Monday, update the specials
from the sheet" is now a cron job, not a chore. Details in
[API-VISION.md](API-VISION.md).
