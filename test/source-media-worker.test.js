// Pictures and link addresses through the real worker, over an in-memory
// GitHub: a picture field takes only a picture that is in the repository, in
// the place the field's style says; a Markdown text may not point a new
// picture at a file that is not there; a link's address field is an address.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editorEnv, withFetch, call, REPO } from './worker-harness.js';
import { fakeGitHub } from './github-fake.js';
import { picturesToCheck } from '../worker/source.js';

const MD = 'src/content/posts/fair.md';
const FAIR = `---
title: Fair
cover: ./images/green.png   # the picture at the top
coverAlt: The green
banner: /img/hall.png
cta:
  label: Book a stall
  href: https://example.com/book
---

The fair is on the green.

![The hall](/img/hall.png)
`;
const FILES = {
  [MD]: FAIR,
  'src/content/posts/images/green.png': 'png',
  'src/content/posts/images/new-k2.webp': 'webp',
  'public/img/hall.png': 'png',
  'public/img/new-k2.webp': 'webp',
};

async function run(files, body) {
  const gh = fakeGitHub({ repo: REPO, files });
  const r = await withFetch(gh.handler, () => call(editorEnv(), 'POST', '/source/commit', { body: { repo: REPO, adapter: 'astro', file: MD, ...body } }));
  return { ...r, gh };
}

test('/healthz says the worker takes pictures and link addresses from content files', async () => {
  const r = await call(editorEnv(), 'GET', '/healthz');
  assert.equal(r.json.sourceMedia, true);
});

test('a picture field takes a picture that is in the repository, and its comment stays', async () => {
  const ok = await run(FILES, { edits: [{ pointer: '/frontmatter/cover', key: 'c', type: 'image', value: './images/new-k2.webp' }] });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.gh.read(MD), FAIR.replace('cover: ./images/green.png', 'cover: ./images/new-k2.webp'));
  const pub = await run(FILES, { edits: [{ pointer: '/frontmatter/banner', key: 'b', type: 'image', value: '/img/new-k2.webp' }] });
  assert.equal(pub.status, 200, JSON.stringify(pub.json));
  assert.match(pub.gh.read(MD), /^banner: \/img\/new-k2\.webp$/m);
});

test('a picture that is not in the repository is not written: the build would fail on it', async () => {
  const gone = await run(FILES, { edits: [{ pointer: '/frontmatter/cover', key: 'c', type: 'image', value: './images/missing.webp' }] });
  assert.equal(gone.status, 422);
  assert.deepEqual(gone.json.skipped, [{ key: 'c', reason: 'picture not found: src/content/posts/images/missing.webp' }]);
  assert.equal(gone.gh.read(MD), FAIR);
  // the other edits of the file still go through
  const mixed = await run(FILES, { edits: [
    { pointer: '/frontmatter/cover', key: 'c', type: 'image', value: './images/missing.webp' },
    { pointer: '/frontmatter/coverAlt', key: 'a', value: 'The green at noon' },
  ] });
  assert.equal(mixed.status, 200);
  assert.deepEqual(mixed.json.applied, ['a']);
  assert.match(mixed.gh.read(MD), /^coverAlt: The green at noon$/m);
  assert.match(mixed.gh.read(MD), /^cover: \.\/images\/green\.png/m);
});

test('a picture field takes nothing but a picture in the site\'s files', async () => {
  for (const value of ['https://evil.example/a.png', '~/assets/a.png', '../../../../x.png', './notes.pdf', 'javascript:alert(1)']) {
    const r = await run(FILES, { edits: [{ pointer: '/frontmatter/cover', key: 'c', type: 'image', value }] });
    assert.equal(r.status, 422, value);
    assert.equal(r.json.skipped[0].reason, 'needs to be a picture on this site', value);
    assert.equal(r.gh.read(MD), FAIR);
  }
});

test('a link\'s address field takes an address, and nothing that runs', async () => {
  const ok = await run(FILES, { edits: [{ pointer: '/frontmatter/cta/href', key: 'h', type: 'url', value: 'https://example.com/stalls' }] });
  assert.equal(ok.status, 200);
  assert.match(ok.gh.read(MD), /^ {2}href: https:\/\/example\.com\/stalls$/m);
  const bad = await run(FILES, { edits: [{ pointer: '/frontmatter/cta/href', key: 'h', type: 'url', value: 'javascript:alert(1)' }] });
  assert.equal(bad.status, 422);
  assert.equal(bad.gh.read(MD), FAIR);
});

test('a Markdown text may not point a new picture at a file that is not there', async () => {
  const body = FAIR.slice(FAIR.indexOf('\n---\n') + 5);
  const swap = (to) => body.replace('/img/hall.png', to);
  const ok = await run(FILES, { edits: [{ pointer: '/body', key: 'b', value: swap('/img/new-k2.webp'), was: body }] });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.match(ok.gh.read(MD), /!\[The hall\]\(\/img\/new-k2\.webp\)/);
  const gone = await run(FILES, { edits: [{ pointer: '/body', key: 'b', value: swap('/img/missing.webp'), was: body }] });
  assert.equal(gone.status, 422);
  assert.deepEqual(gone.json.skipped, [{ key: 'b', reason: 'picture not found: public/img/missing.webp' }]);
  // A picture on another site is the site's own business; one already in the text is not looked up again.
  const remote = await run(FILES, { edits: [{ pointer: '/body', key: 'b', value: swap('https://cdn.example.com/a.png'), was: body }] });
  assert.equal(remote.status, 200);
});

test('picturesToCheck: what is looked up, and what is refused without looking', () => {
  const r = picturesToCheck([
    { key: 'c', pointer: '/frontmatter/cover', type: 'image', value: './images/a.webp' },
    { key: 'p', pointer: '/frontmatter/banner', type: 'image', value: '/img/b.webp' },
    { key: 'x', pointer: '/frontmatter/cover', type: 'image', value: 'https://a.example/x.png' },
    { key: 't', pointer: '/frontmatter/title', value: 'Hi' },
    { key: 'b', pointer: '/body', value: 'See ![a](./images/a.webp) and ![b](./images/old.png).' },
  ], MD, { currentOf: (e) => (e.key === 'b' ? 'See ![b](./images/old.png).' : undefined) });
  assert.deepEqual(r.check, [
    { key: 'c', path: 'src/content/posts/images/a.webp' },
    { key: 'p', path: 'public/img/b.webp' },
    { key: 'b', path: 'src/content/posts/images/a.webp' },
  ]);
  assert.deepEqual(r.skips, [{ key: 'x', reason: 'needs to be a picture on this site' }]);
});
