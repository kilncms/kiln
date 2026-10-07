// Formatted text through the real worker: what /source/read hands the editor,
// and what /source/commit takes back for a Markdown body, an MDX body, a
// Markdown field and a file with TOML front matter, over an in-memory GitHub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editorEnv, withFetch, call, REPO } from './worker-harness.js';
import { fakeGitHub } from './github-fake.js';

const MD = 'src/content/posts/fair.md';
const FAIR = `---
title: Fair # the heading
summary: |
  A day of **stalls**.
---

Watch the film:

<iframe src="https://www.youtube.com/embed/abc"></iframe>

The fair is on the green.
`;
const MDX = 'src/content/posts/parts.mdx';
const PARTS = `---
title: Parts
---
import Box from '../../components/Box.astro';

Open in {2026}.

<Box>

Inside.

</Box>

Plain words.
`;
const TOML = 'src/content/posts/walk.md';
const WALK = `+++
# TOML front matter
title = "Walk" # the heading
+++

Meet at *nine*.
`;

async function run(files, method, path, body) {
  const gh = fakeGitHub({ repo: REPO, files });
  const r = await withFetch(gh.handler, () => call(editorEnv(), method, path, { body: { repo: REPO, adapter: 'astro', ...body } }));
  return { ...r, gh };
}

test('/source/read: an entry\'s Markdown body and a Markdown field, as the file has them', async () => {
  const body = await run({ [MD]: FAIR }, 'POST', '/source/read', { file: MD, pointer: '/body' });
  assert.equal(body.status, 200);
  assert.equal(body.json.value, FAIR.slice(FAIR.indexOf('\n---\n') + 5));
  assert.match(body.json.sha, /^[0-9a-f]{40}$/);
  const field = await run({ [MD]: FAIR }, 'POST', '/source/read', { file: MD, pointer: '/frontmatter/summary' });
  assert.equal(field.json.value, 'A day of **stalls**.\n');
  const toml = await run({ [TOML]: WALK }, 'POST', '/source/read', { file: TOML, pointer: '/frontmatter/title' });
  assert.equal(toml.json.value, 'Walk');
  // The same door as a commit: no file it would refuse to write, no field that is not there.
  assert.equal((await run({ [MD]: FAIR }, 'POST', '/source/read', { file: 'astro.config.mjs', pointer: '/body' })).status, 403);
  assert.equal((await run({ [MD]: FAIR }, 'POST', '/source/read', { file: MD, pointer: '/frontmatter/nope' })).status, 404);
  assert.equal((await run({}, 'POST', '/source/read', { file: MD, pointer: '/body' })).status, 404);
});

test('/source/commit: a formatted body keeps the owner\'s embed, and may add nothing that runs', async () => {
  const body = FAIR.slice(FAIR.indexOf('\n---\n') + 5);
  const ok = await run({ [MD]: FAIR }, 'POST', '/source/commit', { file: MD, edits: [{ pointer: '/body', key: 'b', value: body.replace('on the green', 'on the **green**'), was: body }] });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.gh.read(MD), FAIR.replace('on the green', 'on the **green**'));
  for (const added of ['<script>x()</script>', '[go](javascript:alert(1))', '<iframe src="https://evil.example"></iframe>']) {
    const bad = await run({ [MD]: FAIR }, 'POST', '/source/commit', { file: MD, edits: [{ pointer: '/body', key: 'b', value: `${body}\n${added}\n` }] });
    assert.equal(bad.status, 422, added);
    assert.deepEqual(bad.json.skipped, [{ key: 'b', reason: 'value may not contain script markup' }]);
    assert.equal(bad.gh.read(MD), FAIR);
  }
});

test('/source/commit: a Markdown field is written into its block, a TOML title keeps its comment', async () => {
  const field = await run({ [MD]: FAIR }, 'POST', '/source/commit', { file: MD, edits: [{ pointer: '/frontmatter/summary', key: 's', type: 'markdown', value: 'A day of **stalls** and _music_.' }] });
  assert.equal(field.status, 200, JSON.stringify(field.json));
  assert.ok(field.gh.read(MD).startsWith('---\ntitle: Fair # the heading\nsummary: |\n  A day of **stalls** and _music_.\n---\n'), field.gh.read(MD));
  const toml = await run({ [TOML]: WALK }, 'POST', '/source/commit', { file: TOML, edits: [{ pointer: '/frontmatter/title', key: 't', value: 'Long walk' }] });
  assert.equal(toml.status, 200, JSON.stringify(toml.json));
  assert.equal(toml.gh.read(TOML), WALK.replace('"Walk"', '"Long walk"'));
});

test('/source/commit: MDX prose is written; a changed, added or removed piece of code is not', async () => {
  const body = PARTS.slice(PARTS.indexOf('\n---\n') + 5);
  const ok = await run({ [MDX]: PARTS }, 'POST', '/source/commit', { file: MDX, edits: [{ pointer: '/body', key: 'b', value: body.replace('Plain words.', 'Plain **words**.') }] });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.gh.read(MDX), PARTS.replace('Plain words.', 'Plain **words**.'));
  for (const value of [body.replace('{2026}', '{process.env.SECRET}'), body.replace('<Box>', '<Box tone="x">'), body.replace("import Box from '../../components/Box.astro';\n\n", ''), `${body}\n{fetch('https://evil.example')}\n`]) {
    const bad = await run({ [MDX]: PARTS }, 'POST', '/source/commit', { file: MDX, edits: [{ pointer: '/body', key: 'b', value }] });
    assert.equal(bad.status, 422);
    assert.match(bad.json.skipped[0].reason, /MDX code may not change/);
    assert.equal(bad.gh.read(MDX), PARTS);
  }
});

test('/healthz says the worker takes Markdown back, so an editor knows it may offer formatted text', async () => {
  const gh = fakeGitHub({ repo: REPO, files: {} });
  const r = await withFetch(gh.handler, () => call(editorEnv(), 'GET', '/healthz'));
  assert.equal(r.json.sourceMarkdown, true);
});
