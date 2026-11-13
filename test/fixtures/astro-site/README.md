# kiln-e2e-astro

A throwaway Astro site for testing Kiln's source mode (sites a generator builds)
against the STAGING worker. Nothing here is a real site.

The empty file `.kiln-e2e` is what allows the end-to-end test to write here and
to put everything back afterwards. Do not remove it, and do not keep anything
here you would mind losing: the test resets `main` to where it found it.

- `src/content/events/*.md`, `src/content/site/home.md`: the content. Source
  mode edits these files.
- `src/pages/index.astro`: renders them. Each value is stamped with where it
  came from by `src/lib/kiln-astro.mjs` (a copy of `integrations/astro/index.mjs`
  from the Kiln repository, used from here until `@kilncms/astro` is on npm).
- `public/assets/`: the editor files and `kiln-config.js` (`mode: 'source'`,
  `adapter: 'astro'`, the staging worker). `public/kiln.html` is the sign-in page.

```bash
npm install
npm run build      # → dist/
```

Run the test from the Kiln repository:

```bash
KILN_E2E_REPO=erikkwilder/kiln-e2e-astro GH_TOKEN=$(gh auth token) node scripts/e2e-source.mjs
```
