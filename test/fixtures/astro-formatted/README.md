# astro-formatted

A small Astro site whose entries hold formatted Markdown: nested lists, a link
in a heading, hard breaks of both kinds, a table, code, a picture, a reference
link, an HTML comment, TOML front matter, typeset quotes, and an MDX entry with
imports, an export, a component around Markdown, an inline component and an
expression.

`built/` is what Astro 7.3.6 (with @astrojs/mdx 8.0.3) made of `src/`, page by
page (`npx astro build`, then `dist/posts/<id>/index.html`). The tests read
those pages as the editor reads a page in the browser.
