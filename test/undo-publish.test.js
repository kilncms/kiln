import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { makeGh, encodeContent, decodeContent } from '../src/github.js';
import { revertPublish, undoMessage, publishRecord, restage } from '../src/editor/undo-publish.js';

const REPO = 'acme/site', PATH = 'index.html';
const BEFORE = '<h1 data-cms="hero">Fresh bread</h1>';
const AFTER = '<h1 data-cms="hero">Fresh bread every morning</h1>';
const OTHERS = '<h1 data-cms="hero">Fresh bread every morning</h1><p data-cms="note">Closed Monday</p>';

/** GitHub, played by a list of file states: each GET serves the next one (the last repeats). */
function fakeGitHub(states, { putStatus = () => 200 } = {}) {
  const calls = [];
  let gets = 0, puts = 0;
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    calls.push({ method: init.method, path: u.pathname, body: init.body ? JSON.parse(init.body) : null });
    if (init.method === 'GET') {
      const s = states[Math.min(gets++, states.length - 1)];
      return new Response(JSON.stringify({ content: encodeContent(s.text), sha: s.sha }), { status: 200 });
    }
    if (init.method === 'PUT') {
      const status = putStatus(puts++);
      if (status !== 200) return new Response(JSON.stringify({ message: 'is at abc but expected def (sha mismatch)' }), { status });
      return new Response(JSON.stringify({ commit: { sha: 'undo1' }, content: { sha: 'blob2' } }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };
  return { gh: makeGh({ mode: 'direct', token: () => 't', fetchImpl }), calls };
}
const args = (gh) => ({ gh, repo: REPO, branch: 'main', path: PATH, before: BEFORE, after: AFTER, message: 'Edit index.html: hero (via Kiln)' });

test('undo publish: puts the file back to exactly what it was, as one ordinary commit', async () => {
  const { gh, calls } = fakeGitHub([{ text: AFTER, sha: 'blob1' }]);
  const r = await revertPublish(args(gh));
  assert.equal(r.ok, true);
  assert.equal(r.commit.sha, 'undo1');
  const puts = calls.filter(c => c.method === 'PUT');
  assert.equal(puts.length, 1);
  assert.equal(puts[0].path, `/repos/${REPO}/contents/${PATH}`);
  assert.equal(decodeContent(puts[0].body.content), BEFORE, 'the exact earlier text');
  assert.equal(puts[0].body.sha, 'blob1', 'written against the file as it stands');
  assert.equal(puts[0].body.branch, 'main');
  assert.equal(puts[0].body.message, 'Undo "Edit index.html: hero" (via Kiln)');
  assert.equal(puts[0].body.force, undefined);
});

test('undo publish: never a force push, never a ref, tree or commit object write', async () => {
  const { gh, calls } = fakeGitHub([{ text: AFTER, sha: 'blob1' }]);
  await revertPublish(args(gh));
  for (const c of calls) {
    assert.ok(!c.path.includes('/git/'), `no git data call: ${c.method} ${c.path}`);
    assert.ok(['GET', 'PUT'].includes(c.method));
    assert.ok(!JSON.stringify(c.body || {}).includes('force'));
  }
});

test('undo publish: someone else published to the same file in between, so nothing is written', async () => {
  const { gh, calls } = fakeGitHub([{ text: OTHERS, sha: 'blob9' }]);
  const r = await revertPublish(args(gh));
  assert.deepEqual(r, { ok: false, reason: 'changed' });
  assert.equal(calls.filter(c => c.method !== 'GET').length, 0, 'no write of any kind');
});

test('undo publish: someone else publishes during the undo, and their work is not overwritten', async () => {
  // first look: still ours. The write is refused (the file moved). The next look shows their text.
  const { gh, calls } = fakeGitHub([{ text: AFTER, sha: 'blob1' }, { text: AFTER, sha: 'blob1' }, { text: OTHERS, sha: 'blob9' }],
    { putStatus: () => 409 });
  const r = await revertPublish(args(gh));
  assert.deepEqual(r, { ok: false, reason: 'changed' });
  assert.equal(calls.filter(c => c.method === 'PUT').length, 1, 'one refused attempt, no second try over their work');
});

test('undo publish: a refusal for another reason is passed on, not hidden', async () => {
  const { gh } = fakeGitHub([{ text: AFTER, sha: 'blob1' }], { putStatus: () => 403 });
  await assert.rejects(() => revertPublish(args(gh)), /GitHub 403/);
});

test('undo publish: the commit message names what was undone and reads as an undo in History', () => {
  assert.equal(undoMessage('Edit index.html: hero (via Kiln)'), 'Undo "Edit index.html: hero" (via Kiln)');
  assert.equal(undoMessage('New autumn menu (via Kiln)\n\nbody'), 'Undo "New autumn menu" (via Kiln)');
  assert.equal(undoMessage('He said "hi" (via Kiln)'), 'Undo "He said \'hi\'" (via Kiln)');
  assert.equal(undoMessage(''), 'Undo "a change" (via Kiln)');
  assert.ok(undoMessage('x'.repeat(300)).length < 100);
  // History's reader shows these as "Went back to an earlier version"
  const main = readFileSync(new URL('../src/editor/main.js', import.meta.url), 'utf8');
  assert.ok(main.includes(String.raw`/^(Undo|Restore) .*\(via Kiln\)$/`));
  assert.match(undoMessage('Edit index.html: hero (via Kiln)'), /^(Undo|Restore) .*\(via Kiln\)$/);
});

test('undo publish: the edits come back as unpublished, so nothing typed is lost', () => {
  const rec = publishRecord({ path: PATH });
  rec.entries.set('hero', JSON.stringify({ html: 'Fresh bread every morning' }));
  rec.entries.set('photo', JSON.stringify({ attrs: { src: '/assets/uploads/new.webp', alt: 'A loaf' } }));
  rec.prevBase.set('hero', 'Fresh bread');
  rec.prevBaseAttrs.set('photo', { src: '/img/old.jpg', alt: '' });
  const op = { op: 'appendMain', html: '<section></section>', key: 'gallery_1' };
  rec.structural.push(op);
  const stage = {
    pending: new Map(),
    undoBase: new Map([['hero', 'Fresh bread every morning']]),            // what publishing left behind
    undoBaseAttrs: new Map([['photo', { src: '/assets/uploads/new.webp', alt: 'A loaf' }]]),
    structural: [],
  };
  const back = restage(rec, stage);
  assert.deepEqual(back, ['hero', 'photo']);
  assert.deepEqual(stage.pending.get('hero'), { html: 'Fresh bread every morning' });
  assert.deepEqual(stage.pending.get('photo'), { attrs: { src: '/assets/uploads/new.webp', alt: 'A loaf' } });
  assert.equal(stage.undoBase.get('hero'), 'Fresh bread', 'the baseline is the site as it is again');
  assert.deepEqual(stage.undoBaseAttrs.get('photo'), { src: '/img/old.jpg', alt: '' });
  assert.deepEqual(stage.structural, [op]);
});

test('undo publish: a field edited again after publishing keeps the newer edit', () => {
  const rec = publishRecord({});
  rec.entries.set('hero', JSON.stringify({ html: 'Published text' }));
  rec.prevBase.set('hero', 'Original text');
  const stage = { pending: new Map([['hero', { html: 'Typed after publishing' }]]), undoBase: new Map([['hero', 'Published text']]), undoBaseAttrs: new Map(), structural: [] };
  restage(rec, stage);
  assert.deepEqual(stage.pending.get('hero'), { html: 'Typed after publishing' });
  assert.equal(stage.undoBase.get('hero'), 'Original text');
});
