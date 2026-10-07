# astro-media

A small Astro site whose entry has pictures and links: a picture Astro's
`image()` checks (a path from the entry, `./images/green.png`), a picture
under `public/` (`/img/hall.png`), each with a description field; a link
whose words and address are two fields; a link whose address is a field; and
pictures and links inside the Markdown text. The collection's schema limits
the title's length and asks for full web addresses.

`built/` is what Astro 7.3.6 made of `src/` (`npx astro build`):
`built/spring-fair.html` is `dist/posts/spring-fair/index.html`, and
`built/kiln-schema.json` is what the Kiln integration published beside it.
