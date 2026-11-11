# Source mode: editing a site that a generator builds

Back to the [README](../README.md). Setting it up on a self-hosted worker is in [self-hosting.md](self-hosting.md#a-site-a-generator-builds-source-mode); the full design is [SOURCE-MODE-SPEC.md](SOURCE-MODE-SPEC.md).

On a plain HTML site, the HTML in your repo *is* the page. On an Astro site it
isn't: the repo holds content files and the pages are generated from them at build
time, so editing the output would just be erased on the next build. **Source mode**
points Kiln at the sources instead. You still click the text on the live page and
type; Kiln saves the change to the underlying content file, commits it, and your
host rebuilds the site.

Source mode exists for **Astro**. It does not exist yet for Eleventy, Hugo or
Jekyll: on those sites the wizard and `kiln doctor` say Kiln can't edit their
content files, Kiln edits only HTML files committed in the repository, and a
page that is their build output is refused with a sentence instead of being
edited and then erased by the next build.

The generated page says where each value lives, with one attribute:

```html
<h3 data-kiln-source="src/content/events/service.md#/frontmatter/title">
  Interfaith Worship Service
</h3>
```

The format is `<repo-relative path>#<RFC 6901 JSON pointer>`, plus an optional
`?type=date`-style hint. On Astro you don't write these by hand — spread the
[`@kilncms/astro`](../integrations/astro/) helper onto each rendered field, one line
per field:

```astro
<h3 {...kilnSource(entry, 'title')}>{entry.data.title}</h3>
<div {...kilnBody(entry)}><Content /></div>
```

(The package is not on npm yet. Until it is, the wizard copies the helper into your
project as `src/lib/kiln-astro.mjs`, and you import from that path.)

The wizard does the rest: run `npx github:kilncms/kiln#release` in a generator-built repo
and it detects the generator, shows what it found ("Found astro.config.mjs and 63
content files"), asks how the site is built in plain language, writes
`mode: 'source', adapter: 'astro'` into the config, and deploys a worker that can
commit to content files. On an Astro site it puts the editor, the config, the
sign-in page and the `_headers` file under `public/`, the folder Astro copies into
the built site as it is, and offers to add the two script tags to the template
that closes `<body>`. An existing install needs `npx github:kilncms/kiln#release update`
(which also offers a newer copy of the helper file) plus a redeploy of its worker. `kiln doctor` warns when a repo looks generator-built
but the site is still in HTML mode — the silent-data-loss trap this mode exists to
close.

Honest scope, today:

- **In:** markdown content files: `.md` and `.mdx` frontmatter (YAML between
  `---` or TOML between `+++`) and body. Frontmatter is spliced surgically:
  comments, quoting, and key order survive byte-identical.
- **In:** formatted text, with the same toolbar as on a plain HTML site: bold,
  italic, links, bullet and numbered lists (nested too), headings, quotes, line
  breaks. The editor reads the entry's Markdown, matches each block on the page
  to its block in the file, and writes back only what changed, in the file's own
  style (its bullet, its emphasis marks, its kind of line break): an untouched
  block keeps every byte, and a changed word rewrites that word. Pictures in the
  text go back as the file wrote them. A table, a code block, raw HTML and, in
  MDX, a component or an expression stay on the page as they render, take no
  typing, say why when clicked, and are written back exactly. In MDX the worker
  takes an edit only when every import, export, component and expression is as
  it was, in the same order, with none added. A field the page renders as
  Markdown is the same, stamped `kilnSource(entry, 'summary', { type: 'markdown' })`.
  (This needs a worker that says `sourceMarkdown` in its `/healthz`; with an
  older one a formatted text stays read-only, as before.)
- **In:** pictures and link addresses. A picture stamped
  `kilnSource(entry, 'cover', { type: 'image', alt: 'coverAlt' })` gets
  "Replace picture…" and its description in the toolbar. The new picture is
  made web-sized (WebP, or JPEG from a browser such as Safari that cannot write
  WebP), checked against the upload limits, put in the folder the field's
  picture is in now (beside the entry for `./images/hall.jpg`, which `image()`
  checks; under `public/` for `/img/hall.jpg`), committed before the entry that
  names it, and named in the field in the same style. A picture inside an
  entry's text is replaced the same way, and only its line changes. A link
  stamped `kilnSource(entry, ['cta', 'label'], { href: ['cta', 'href'] })` has
  its words edited in place and its address typed beside them. The worker
  writes a picture path only when that picture is in the repository. (This
  needs a worker that says `sourceMedia` in its `/healthz`; with an older one
  pictures and link addresses stay read-only, as before.)
- **In:** the site's own schema. With `kiln()` in `astro.config.mjs`, each
  build publishes the collections' schemas at `/kiln-schema.json`, and the
  editor refuses, with a sentence, a value the next build would reject: a title
  longer than `.max(80)`, a page address where `.url()` wants a full one, an
  empty required field, a word outside a `z.enum`. A picture field whose schema
  wants a full web address says so instead of offering an upload.
- **In:** typed values (`date`, `time`, `url`, `boolean`, `number`). A value of
  the wrong kind is said in a sentence when the field is left ("This needs to be
  a date written like 2026-09-20."), and the worker checks again. A `url` is a
  web address, `mailto:`, `tel:` or a place on the site, never words. A value
  is written in the quoting its line had, and text a YAML reader could take for
  something else (a time, yes/no, a number with a leading zero) is quoted. One commit per
  content file; real publish states — **Saved. The site is rebuilding… →
  Published ✓ / Build failed** — with a one-click undo when a bad edit breaks
  the build, which puts the edit back on the page as unpublished. A reload while
  the site rebuilds shows what was saved, not the page from before.
- **In:** nothing is written over unasked. If someone else changed the same
  field since the page was built, the editor asks **Someone else changed this**
  and shows theirs and yours; the other fields of the same publish are saved.
  (Each edit says what its field showed; the worker checks it against the
  file. An older editor or an older worker saves without the question, as
  both did before.)
- **In:** Search & jump lists the site's real pages: the adapter's routes, the
  links on the pages and the sitemap, each checked against the built site.
- **In:** the guard: an HTML-mode site with build tooling and committed build
  output is blocked from editing `dist/` with an explanation, instead of edits
  silently vanishing.
- **Read-only on the page for now**, each with a sentence that says why when it
  is clicked: a table inside a text; a picture field that has no picture yet,
  names a picture on another site, or uses a path alias (`~/assets/…`), since
  there is no folder to follow. Choosing a picture that is already in the
  repository, instead of uploading one, is not offered for content pictures yet.
- **In:** entries. An element stamped `kilnEntry(entry)` (a card in a list,
  the article on the entry's page) gets an **Entry** button: make it a draft or
  put it on the site, put a draft on the site later (the worker's scheduler),
  move it up or down where the collection has an order field, copy it, see its
  History, remove it. **New post or page** adds an entry to a collection on the
  page: the editor's own box asks for the title and every field the
  collection's schema requires, names the file from the title, and never
  writes over a file that is there. **Entries & drafts** lists a collection's
  files with its drafts first, so a draft the site does not show can be
  reached. Drafts follow the site's own mark: `draft: true`, unless the Kiln
  config names another field (`draftField`, with `draftValue: false` for a
  field like `published`); a site whose schema has no such field is not
  offered drafts. Adding, copying and removing are commits the moment they are
  confirmed (and need the "New posts & pages" grant); a removed entry comes
  back from History. A draft mark and a new order are staged and published
  like any edit. **Schedule for later…** schedules staged content-file edits.
- **In:** History and Page settings on a generated page. History lists the
  versions of the page's own entry file (and of the other files it shows),
  with a preview of each and **Go back to this**; it also lists entries
  removed from the page's collections, each with **Bring it back**. Page
  settings changes the entry's title, its description (`description`,
  `summary` or `excerpt`) and its social picture (`image`, `ogImage`,
  `socialImage`, `cover` or `heroImage`), whichever the entry or its schema has.
  (These need a worker that says `sourceEntries` in its `/healthz`; with an
  older one both say they can't, as before.)
- **Not yet:** date-picker-style controls (typed values are edited as text, in
  the form they are stored: a date is typed `2026-09-20` even where the page
  writes it out), Eleventy / Hugo / Jekyll adapters (Astro first; none of the
  three is built yet), suggestions for content files, and comments on a
  generated page. A suggest-only editor finds these fields read-only, and
  Comments is not in the menu on such a page: nothing is offered there that
  would then be refused.

The full design is [SOURCE-MODE-SPEC.md](SOURCE-MODE-SPEC.md).
