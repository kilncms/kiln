# Publishing the npm packages

Three packages in this repository are meant for npm. None is published yet.
Each is one command from publishable; this page is those commands, in order.
The repository's root package (`kiln`) is **not** for npm: it is marked
`private`, and the name `kiln` on npm belongs to someone else, which is why
no message or guide may ever say `npx kiln …`.

| Package | Folder | What it is |
|---|---|---|
| `@kilncms/astro` | `integrations/astro/` | provenance helpers for Astro sites in source mode |
| `kiln-mcp` | `mcp/` | the MCP server (scoped edits for AI agents) |
| `create-kiln` | `cli/` | the setup tool: `npx create-kiln` |

## Once, before the first publish

```bash
npm login                      # as the account that will own the packages
npm whoami
npm org ls kilncms             # the @kilncms scope must exist and be yours;
                               # if it does not: https://www.npmjs.com/org/create
npm view @kilncms/astro name; npm view kiln-mcp name; npm view create-kiln name
                               # each should answer 404: the names are still free
```

## Every time

Publish from a clean checkout of a released commit (`git status` empty, on a
`prod-…` tag), so what is on npm matches what production runs.

```bash
npm ci && npm test             # at the repository root

# 1. @kilncms/astro — no dependencies; a scoped package is public only when told to be
cd integrations/astro
npm pack --dry-run             # 4 files: LICENSE, README.md, index.mjs, package.json
npm publish                    # publishConfig.access is "public"
cd ../..

# 2. kiln-mcp
cd mcp
npm ci && npm test             # 13 tests
npm pack --dry-run             # 5 files: LICENSE, README.md, index.mjs, lib.mjs, package.json
npm publish
cd ..

# 3. create-kiln — packs the built editor, the worker source and the templates with it
cd cli
npm pack --dry-run             # 29 files; prepack copies dist/, worker/, src/, templates/ and LICENSE in, postpack removes them
npm publish
cd ..

npm view @kilncms/astro version; npm view kiln-mcp version; npm view create-kiln version
```

To publish a new version later: raise `version` in that package's
`package.json`, commit, release, then the same commands.

## After the first publish of `create-kiln`

These were left as they are on purpose, because they would be wrong until the
package exists:

- The guides and the CLI's own messages say `npx github:kilncms/kiln#release`. Once
  `create-kiln` is on npm, `npx create-kiln` is the shorter command for the
  same thing; change the guides, then the messages in `cli/index.mjs`.
- `cli/README.md` is the package's page on npm and already says
  `npx create-kiln`.
- The self-hosted route of the wizard copies `parse5` and `yaml` from
  `node_modules` next to the tool when it cannot reach npm. An installed
  package has its dependencies one level up instead, so that fallback does
  nothing there and the wizard falls back to `npm install` in the worker
  folder. It needs the network either way.

## What `npm pack` runs

`prepack` copies files into the package folder and `postpack` takes them out
again, so nothing generated is left behind and nothing generated is committed:

- `cli/prepack.mjs`: `dist/`, `worker/`, `src/`, `templates/`, `LICENSE`
  (`node prepack.mjs --clean` removes them).
- `scripts/pack-license.mjs`: the `LICENSE`, for `mcp/` and
  `integrations/astro/`.

If a pack is interrupted, run `node prepack.mjs --clean` in `cli/`: a leftover
`cli/dist` makes the tool in this checkout use that copy instead of the
repository's.
