# astro-entries

A small Astro site with a collection of posts: a list page that shows the
posts that are not drafts in their `order`, and a page per post. One post is
a draft (`draft: true`) and is on neither. Each list item and each post's
article is stamped with `kilnEntry`, so the editor puts the entry's own
controls there. The schema has a title limit, a date, a description, a
social picture, a draft mark and an order.

`built/` is what Astro 7.3.6 made of `src/` (`npx astro build`):
`built/posts.html` is `dist/posts/index.html`, `built/spring-fair.html` is
`dist/posts/spring-fair/index.html`, and `built/kiln-schema.json` is what the
Kiln integration published beside them.
