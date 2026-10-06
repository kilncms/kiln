# Contributing to Kiln

Thanks for your interest in improving Kiln. This guide covers how to contribute,
the development workflow, repo layout, and what we expect in a pull request.

## How to contribute

1. **Fork** the repo and clone your fork.
2. Create a branch: `git checkout -b fix/short-description`.
3. Make your change, adding or updating tests where it matters (see Development below).
4. Commit using [Conventional Commits](https://www.conventionalcommits.org/) prefixes —
   `fix:`, `feat:`, `docs:`, `refactor:`, `test:`, `chore:`.
5. Push to your fork and open a **pull request** against `main`. CI runs the full test
   suite on every PR; please make sure it's green.

Small fixes and docs improvements are welcome as direct PRs. For larger changes or a new
feature, open an issue first so we can agree on the approach before you build it.

## Development

```bash
npm install
npm test               # splice engine + transport suite (node --test)
npm run build          # dist/kiln.js + dist/kiln-editor.js + dist/kiln-features.js
```

`npm test` runs every suite (the editing engine, the worker's request handlers
against stand-ins for GitHub, KV and D1, the CLI, the release and backup
scripts) and is the fastest signal that a change is sound. It needs Node 20 or
newer; the database tests need Node 22 and are skipped on 20. `npm run build`
produces the shipped bundles.

**What CI checks** (`.github/workflows/ci.yml`, on every push and pull request):

- `npm test` on Node 20 and 22
- `dist/` is what the sources build: it rebuilds with the committed stamp and
  fails on any difference. If you change anything under `src/`, run
  `npm run build` and commit `dist/` in a commit of its own
- the worker bundles in all three configurations (`wrangler deploy --dry-run`;
  nothing is uploaded)
- every script parses, the `mcp/` tests pass, the CLI package packs
- `npm audit --audit-level=high` in the root, `cli/` and `mcp/`
- every link in the markdown files points at a file or heading that exists
  (`node scripts/check-links.mjs`)

A weekly workflow also requests every web link and lists advisories of any
severity.

`scripts/e2e.mjs` is **maintainer-only**: it drives the staging worker and a
marked test repository as three invited editors would, publishes, tries every
write that must be refused, and puts the repository back as it found it. It
needs wrangler access to the staging worker, so it is not part of CI. Its
whole flow runs in `npm test` against the real worker handlers and an
in-memory GitHub (`test/e2e.test.js`), which is the verification path for
outside PRs.

## Repo layout

```
src/engine.js        the splice engine (parse5 offsets, batch edits, attr edits)
src/github.js        transports (direct / proxied), conflict-retry edits, atomic commits
src/autotag.js       the heuristic first-pass auto-tagger behind `kiln tag`
src/kiln.js          boot shim
src/features.js      visitor runtime (gallery lightbox, tag filters, event calendar)
src/editor/main.js   editor UI bundle source
cli/index.mjs        the setup wizard + doctor + tag + update commands
worker/              kiln-auth Cloudflare Worker (sign-in + commit pipeline)
templates/           members-area scaffolding the wizard copies into a new site
test/                engine + transport + autotag tests
scripts/             build, release, propagate, backup and restore, e2e (maintainer-only), link check
```

## Pull request expectations

- Run `npm test` and make sure it passes before opening a PR.
- Keep diffs minimal and focused — one logical change per PR.
- Add or update tests when you change engine or transport behavior.
- Match the existing code style, wording, and formatting in files you touch.
- Describe what changed and why in the PR description.

## Releases (maintainers)

What runs in production is marked by a git tag, `prod-YYYY-MM-DD`, which
`npm run deploy:prod` (`scripts/release.mjs`) creates and pushes when it deploys
the worker; it refuses unless the commit is on `main`, pushed, green in CI and
already on staging. `ENVIRONMENTS.md` has the whole procedure, including
hotfixes and how sites get a new editor.

Version numbers follow [Semantic Versioning](https://semver.org/). To name a
version: move the `[Unreleased]` items in `CHANGELOG.md` under a new
`## [x.y.z]` heading, bump `version` in `package.json` and `WORKER_VERSION` in
`worker/index.js`, commit, release, and tag that commit `vX.Y.Z`. So far
`v0.4.0` is the only such tag, and no GitHub Release has been published.

## Licensing of contributions

Kiln is **open source** under the GNU AGPL-3.0. By submitting a contribution you
agree it is licensed under the project's AGPL-3.0 license — inbound license
equals outbound license.
