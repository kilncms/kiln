# @kilncms/astro

Provenance helpers for editing an [Astro](https://astro.build) site with
[Kiln](https://kilncms.com) in **source mode**: your pages are generated, so
Kiln edits the content files they're generated *from*. For that, each rendered
value has to say where it lives. These helpers stamp that — one line per field,
the same mental model as annotating a hand-written page with `data-cms`.

## Install

The package is not on npm yet. Until it is, copy
[`index.mjs`](index.mjs) from this folder into your project (it is one file
with no dependencies), for example as `src/lib/kiln-astro.mjs`, and import from
that path wherever the examples below say `'@kilncms/astro'`. Once published:

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
<div {...kilnBody(entry)}><Content /></div>
```

Each helper returns a plain attrs object like
`{ 'data-kiln-source': 'src/content/events/service.md#/frontmatter/title' }`
that you spread onto the element showing that value. When a signed-in Kiln
editor opens the page, those elements become editable in place; saving commits
to the underlying content file and your host rebuilds the site.

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

### `kilnBody(entry)`

Attrs for the entry's whole markdown body. Put it on the element that wraps
`<Content />`. (`.md` bodies are editable; `.mdx` bodies are code, and Kiln
never edits code.)

### `kiln()` (default export — optional in v1)

```js
// astro.config.mjs
import kiln from '@kilncms/astro';
export default defineConfig({ integrations: [kiln()] });
```

Honesty first: in v1 this integration **does nothing** except log a reminder
that provenance comes from the explicit helpers. Automatic stamping of
collection fields and a build-time `.kiln/schema.json` export (typed editor
controls from your zod schemas) will land under this same entry point later —
adding it today just means nothing to rewire then.

## Stripping provenance from a build

`data-kiln-source` values reveal repo paths (harmless for open-source sites,
possibly unwanted elsewhere). Set `KILN_DISABLE=1` in a build's environment
and every helper returns `{}` — no provenance is emitted, and those fields
simply aren't editable on that deployment.

## Behavior guarantees

- Helpers **never throw**. An entry they can't resolve returns `{}` and your
  build continues; that field just isn't editable.
- No dependencies, no Kiln internals, no network. Safe in any Astro version
  that can spread attrs (all of them).

## License

AGPL-3.0-only, like Kiln itself.
