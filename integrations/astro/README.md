# @kilncms/astro

Provenance helpers for editing an [Astro](https://astro.build) site with
[Kiln](https://kilncms.com) in **source mode**: your pages are generated, so
Kiln edits the content files they're generated *from*. For that, each rendered
value has to say where it lives. These helpers stamp that — one line per field,
the same mental model as annotating a hand-written page with `data-cms`.

## Install

The package is not on npm yet. Until it is, the helper lives in your project as
one file with no dependencies, `src/lib/kiln-astro.mjs`: the setup wizard puts
it there, or copy [`index.mjs`](index.mjs) from this folder yourself. Import
from that path wherever the examples below say `'@kilncms/astro'`. Once
published:

```sh
npm install @kilncms/astro
```

Then annotate the fields your components render:

```astro
---
import { kilnSource, kilnBody } from '@kilncms/astro';
const { entry } = Astro.props;          // a content-collection entry
const { Content } = await render(entry);
---
<h3 {...kilnSource(entry, 'title')}>{entry.data.title}</h3>
<time {...kilnSource(entry, 'date', { type: 'date' })}>{entry.data.date}</time>
<span {...kilnSource(entry, ['venue', 'name'])}>{entry.data.venue.name}</span>
<Image {...kilnSource(entry, 'cover', { type: 'image', alt: 'coverAlt' })} src={entry.data.cover} alt={entry.data.coverAlt} />
<a {...kilnSource(entry, ['cta', 'label'], { href: ['cta', 'href'] })} href={entry.data.cta.href}>{entry.data.cta.label}</a>
<div {...kilnBody(entry)}><Content /></div>
```

Each helper returns a plain attrs object like
`{ 'data-kiln-source': 'src/content/events/service.md#/frontmatter/title?c=events' }`
that you spread onto the element showing that value. When a signed-in Kiln
editor opens the page, those elements become editable in place; saving commits
to the underlying content file and your host rebuilds the site.

What the editor can do with each kind of element today:

- **Words** (a title, a venue, a line of text): edited in place.
- **A date, a time, a number, a yes/no** (`opts.type`): edited as text, in the
  form the file stores. A date is typed `2026-09-20` even if your template
  writes it out as "September 20, 2026"; the editor says so when the field is
  opened, and the page shows it your way again once the site has rebuilt.
- **The body** (`kilnBody`): edited in place with the toolbar: bold, italic,
  links, lists, headings, quotes, line breaks. Kiln writes back Markdown in your
  file's own style, changing only the blocks that were edited. A table, a code
  block, raw HTML and an MDX component or expression stay as they render and are
  written back exactly. In `.mdx` the prose is editable and the code is not.
- **A field your template renders as Markdown**: stamp it
  `kilnSource(entry, 'summary', { type: 'markdown' })` and it is edited the same
  way as the body. A YAML block (`|`) stays a block.
- **A picture** (`{ type: 'image' }` on an `<img>` or Astro's `<Image />`):
  "Replace picture…" takes a picture from the device, makes it web-sized
  (WebP, or JPEG from a browser such as Safari that cannot write WebP), and
  puts it in the folder the field's picture is in now: beside the entry for a
  path such as `./images/hall.jpg` (what `image()` checks), under `public/` for
  an address such as `/img/hall.jpg`. The field is written in the same style.
  The picture is committed before the entry that names it, and the worker
  refuses a picture path that is not in the repository. `opts.alt` names the
  field that holds the picture's description; it is typed beside "Replace
  picture…". A field with no picture yet, a picture on another site, or a path
  that uses an alias (`~/assets/…`) stays as it is and says why.
- **A picture inside the body**: click it while the text is open, and it is
  replaced and described the same way; only its line of Markdown changes.
- **A link** (`opts.href` on an `<a>`): its words are edited in place and its
  address is typed in the toolbar beside them. `{ type: 'url' }` on an `<a>`
  makes the address the field: the toolbar takes the address and the words
  stay as your template wrote them.
- **An address shown as itself** (`{ type: 'url' }` on anything but an `<a>`):
  edited as text. It takes a web address (`https://…`), `mailto:`, `tel:` or a
  place on the site (`/about`, `#top`); words are turned away with a sentence.
- **What is written back**: only the edited line changes. A value keeps the
  quotes its line had, and on an unquoted line a time, or any text YAML could
  read as something else (`yes`, `007`, a date), is quoted.
- **Someone else changed the same field** since the page was built: the editor
  asks before anything of theirs is replaced, and shows both versions. This
  works where the page shows the stored value itself; a date your template
  writes out in words is saved without the question.

## Loading the editor

Astro builds the site from `src/` and copies `public/` into the result as it
is. Nothing else in the repository reaches the built site, so Kiln's own files
live under `public/`, and the template your pages are built from loads them.
The setup wizard (`npx github:kilncms/kiln#release`, run in the repository) does both:

- `public/assets/kiln.js`, `kiln-editor.js`, `kiln-features.js` and
  `kiln-config.js` (with `mode: 'source', adapter: 'astro'`), `public/kiln.html`
  (the sign-in page at `/kiln`) and `public/_headers`. If `astro.config` names
  another `publicDir`, that folder is used.
- These two lines before `</body>` in every `.astro` file that closes
  `<body>`, usually one layout. It lists the files and asks first.

```astro
<script is:inline src="/assets/kiln-config.js"></script>
<script is:inline src="/assets/kiln.js" defer></script>
```

`is:inline` matters: without it Astro tries to bundle the first script and the
build stops with "references an asset in the public/ directory". The built
page carries the plain tags, without `is:inline`.

## API

### `kilnSource(entry, field, opts?)`

Attrs for one frontmatter field.

- `entry` — a content-collection entry. The file path comes from
  `entry.filePath` (Astro 5 content layer) or falls back to
  `src/content/<collection>/<id>` (legacy collections).
- `field` — a frontmatter key (`'title'`), or an array for nested values
  (`['venue', 'name']`, `['tags', 0]`).
- `opts.type` — optional editor hint: `string` · `text` · `markdown` · `date` ·
  `time` · `enum` · `boolean` · `number` · `url` · `image`. Without it the
  field is edited as a string.
- `opts.alt` — on a picture: the field that holds its description (a key or an
  array, like `field`). Stamped as `data-kiln-source-alt`.
- `opts.href` — on a link: the field that holds its address. Stamped as
  `data-kiln-source-href`.

The reference carries the entry's collection (`?c=events`), so the editor can
find the field in the collection's schema.

### `kilnBody(entry)`

Attrs for the entry's whole markdown body. Put it on the element that wraps
`<Content />`. Both `.md` and `.mdx` bodies are edited with the toolbar; in
`.mdx` the code (imports, exports, components, expressions) stays as written.

### `kiln()` (default export)

```js
// astro.config.mjs
import kiln from './src/lib/kiln-astro.mjs';   // '@kilncms/astro' once it is on npm
export default defineConfig({ integrations: [kiln()] });
```

At the end of each build it publishes your collections' schemas with the site,
at `/kiln-schema.json`, as Astro itself describes them (JSON Schema, from
`.astro/collections/`). The editor reads it and refuses, with a sentence, a
value your next build would reject: a title longer than `.max(80)`, a page
address where the schema says `.url()`, an empty field the schema requires, a
word that is not in a `z.enum([...])`. Without the integration everything is
edited as before; nothing is guessed. The file holds field names and their
rules, no content.

## Stripping provenance from a build

`data-kiln-source` values reveal repo paths (harmless for open-source sites,
possibly unwanted elsewhere). Set `KILN_DISABLE=1` in a build's environment
and every helper returns `{}` — no provenance is emitted, no `/kiln-schema.json`
is written, and those fields simply aren't editable on that deployment.

## Behavior guarantees

- Helpers **never throw**. An entry they can't resolve returns `{}` and your
  build continues; that field just isn't editable.
- No dependencies, no Kiln internals, no network. Safe in any Astro version
  that can spread attrs (all of them).

## License

AGPL-3.0-only, like Kiln itself.
