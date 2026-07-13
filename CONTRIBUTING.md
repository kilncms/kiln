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

`npm test` runs the engine and transport suites and is the fastest signal that a
change is sound. `npm run build` produces the shipped bundles.

`scripts/e2e.mjs` is **maintainer-only**: it exercises a real GitHub round-trip
against the live public demo repo, which external contributors' tokens can't
write to. CI plus `npm test` is the expected verification path for outside PRs.

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
scripts/             build, live e2e (maintainer-only), managed onboarding
```

## Pull request expectations

- Run `npm test` and make sure the engine tests pass before opening a PR.
- Keep diffs minimal and focused — one logical change per PR.
- Add or update tests when you change engine or transport behavior.
- Match the existing code style, wording, and formatting in files you touch.
- Describe what changed and why in the PR description.

## Releases (maintainers)

Kiln follows [Semantic Versioning](https://semver.org/). To cut a release: move the
`[Unreleased]` items in `CHANGELOG.md` under a new `## [x.y.z]` heading, bump `version`
in `package.json`, tag it (`git tag vX.Y.Z && git push --tags`), and create a GitHub
Release from that tag with the CHANGELOG section as the notes.

## Licensing of contributions

Kiln is **open source** under the GNU AGPL-3.0. By submitting a contribution you
agree it is licensed under the project's AGPL-3.0 license — inbound license
equals outbound license.
