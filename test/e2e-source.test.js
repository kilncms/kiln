/**
 * scripts/e2e-source.mjs — source mode end to end: a site a generator builds,
 * edited as an invited editor through the worker's /source/commit and
 * /source/revert, and put back afterwards.
 *
 * As with test/e2e.test.js, the script runs here against the REAL worker
 * handlers, with GitHub played by an in-memory repository that keeps a true
 * git history, shaped like the Astro test site (content collections, a page
 * template, the editor's config in public/).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../worker/index.js';
import { run } from '../scripts/e2e-source.mjs';
import { run as runHtml, readConfig, patient, kvFailure, STAGING_WORKER } from '../scripts/e2e.mjs';
import { fakeKV, withFetch } from './worker-harness.js';
import { fakeGitHub } from './github-fake.js';

const REPO = 'acme/kiln-e2e-astro';
const fixture = (f) => readFileSync(new URL(`./fixtures/astro-min/${f}`, import.meta.url), 'utf8');
const ONE = 'src/content/events/one.md';
const TEMPLATE = 'src/pages/index.astro';
const FILES = {
  '.kiln-e2e': '',
  'package.json': '{"private":true,"dependencies":{"astro":"^7.0.0"}}\n',
  'astro.config.mjs': "import { defineConfig } from 'astro/config';\nexport default defineConfig({});\n",
  [TEMPLATE]: fixture(TEMPLATE),
  [ONE]: fixture(ONE),
  'src/content/events/two.md': fixture('src/content/events/two.md'),
  'src/content/site/home.md': '---\nheading: Week of Remembrance\n---\n',
  'public/assets/kiln-config.js': `window.KILN = {\n  repo:   '${REPO}',\n  branch: 'main',\n  worker: '${STAGING_WORKER}',\n  mode:   'source',\n  adapter: 'astro',\n};\n`,
};
const EDITOR = 'kiln-editor@users.noreply.github.com';

function staging({ files = FILES, smoke = false, env: envOver = {} } = {}) {
  const gh = fakeGitHub({ repo: REPO, files });
  const kv = fakeKV({ 'app:creds': { slug: 'kiln-cms-staging', app_id: 1, client_id: 'cid' }, [`itok:${REPO}`]: 'installation-token' });
  const env = { KILN: kv, ALLOWED_ORIGINS: '' };
  const lines = []; const kvCalls = []; const sleeps = [];
  let n = 0; let tick = 1_800_000_000_000;
  const intercept = { fn: null };
  const io = {
    fetch: async (url, init = {}) => {
      if (intercept.fn) { const r = await intercept.fn(url, init); if (r) return r; }
      return url.startsWith(STAGING_WORKER) ? worker.fetch(new Request(url, init), env) : globalThis.fetch(url, init);
    },
    kvPut: async (key, value, ttl) => { kvCalls.push(['put', key, ttl]); kv.map.set(key, value); },
    kvDelete: async (key) => { kvCalls.push(['delete', key]); kv.map.delete(key); },
    log: (l) => lines.push(l),
    sleep: async (ms) => { sleeps.push(ms); },
    now: () => (tick += 1000),
    hex: (bytes) => (++n).toString(16).padStart(2, '0').repeat(bytes),
  };
  const cfg = readConfig(smoke ? { ...envOver } : { KILN_E2E_REPO: REPO, GH_TOKEN: 'owner-token', ...envOver }, smoke ? ['--smoke'] : []);
  const go = (script = run) => withFetch(gh.handler, () => script(cfg, io, envOver));
  return { gh, kv, io, cfg, lines, kvCalls, sleeps, intercept, go, out: () => lines.join('\n'), startHead: gh.head() };
}
const names = (r, ok) => r.checks.filter(c => c.ok === ok).map(c => c.name);

test('source e2e, a full run: two fields of one content file are published as an editor, verified on GitHub, undone, and every refusal is tried for real', async () => {
  const s = staging();
  const r = await s.go();
  assert.deepEqual(names(r, false), [], s.out());
  assert.equal(r.ok, true);
  assert.equal(r.checks.length, 32, s.out());
  const passed = names(r, true);
  for (const name of [
    'worker answers /healthz and can edit Astro sources',
    'the site is set up for source mode (its kiln-config.js says so)',
    'editor publishes two fields of one content file',
    'on GitHub: one commit, by the editor, touching only that file',
    'on GitHub: exactly the two edited lines changed; every other line is what it was',
    'someone else changes the title (a second editor, saying what the title was)',
    'the first editor publishes the old title and the venue: the title is left out with what the file says now, the venue is saved',
    'on GitHub: their title is still there, and only the venue line changed',
    'the first editor chooses their own title: the same edit, saying what the file holds now, is written',
    'refused: text that lives in the page template, as a source edit (source mode edits content files only)',
    'refused: the page template written directly through the proxy',
    'refused: a content file outside the editor\'s folders', 'refused: the site\'s configuration',
    'refused: deleting the content file (a tree entry with no content)', 'refused: the content file written around the source endpoint',
    'refused: script markup in a value', 'refused: a time that is not a time', 'refused: a suggest-only editor publishing a source edit',
    'none of the refused requests changed the branch',
    'editor undoes the change (what the editor offers after a failed build)',
    'on GitHub: the content file is byte for byte what it was, in one more commit by the editor',
    'cleanup: the repository is as it was found',
  ]) assert.ok(passed.includes(name), `missing: ${name}`);
  // What the repository saw: the publish, the second editor's title, the venue (the title left out),
  // the title once it said what the file held, and the undo. Each touched only the content file.
  const byEditor = [...s.gh.commits.entries()].filter(([, c]) => c.author.email === EDITOR);
  assert.deepEqual(byEditor.map(([, c]) => c.author.name), ['Kiln E2E events (via Kiln)', 'Kiln E2E site (via Kiln)', 'Kiln E2E events (via Kiln)', 'Kiln E2E events (via Kiln)', 'Kiln E2E events (via Kiln)']);
  const text = (i) => s.gh.blobs.get(s.gh.trees.get(byEditor[i][1].tree).get(ONE).sha).toString('utf8');
  const first = fixture(ONE).replace('title: Interfaith Worship Service', 'title: E2E title 01010101').replace('venue: "Big Bethel AME"', 'venue: "E2E venue 01010101"');
  assert.equal(text(1), first.replace('E2E title 01010101', 'E2E theirs 01010101'), 'the second editor changed the title');
  assert.equal(text(2), first.replace('E2E title 01010101', 'E2E theirs 01010101').replace('E2E venue 01010101', 'E2E venue two 01010101'), 'their title was not written over; the venue was saved');
  assert.equal(text(3), first.replace('E2E title 01010101', 'E2E mine 01010101').replace('E2E venue 01010101', 'E2E venue two 01010101'), 'the title, once the edit said what the file held');
  assert.equal(text(4), fixture(ONE), 'the undo');
  for (const [, c] of byEditor) {
    const parent = s.gh.trees.get(s.gh.commits.get(c.parents[0]).tree); const tree = s.gh.trees.get(c.tree);
    assert.deepEqual([...tree.keys()].filter(p => tree.get(p).sha !== parent.get(p)?.sha), [ONE]);
  }
  const [publish] = byEditor;
  const before = s.gh.trees.get(s.gh.commits.get(s.startHead).tree); const after = s.gh.trees.get(publish[1].tree);
  assert.deepEqual([...after.keys()].filter(p => after.get(p).sha !== before.get(p)?.sha), [ONE]);
  assert.equal(publish[1].message, 'E2E 01010101: edit title and venue (via Kiln)');
  // The published text: title and venue replaced where they stood, each keeping its own quoting, nothing else touched.
  const published = s.gh.blobs.get(after.get(ONE).sha).toString('utf8');
  assert.equal(published, fixture(ONE).replace('title: Interfaith Worship Service', 'title: E2E title 01010101').replace('venue: "Big Bethel AME"', 'venue: "E2E venue 01010101"'));
  // The maintainer's token only read, and reset the branch at the end.
  assert.deepEqual(s.gh.calls.filter(c => c.method !== 'GET' && c.auth === 'Bearer owner-token').map(c => `${c.method} ${c.path}`), ['PATCH /git/refs/heads/main']);
  assert.match(s.out(), /32\/32 checks passed/);
  assert.match(s.out(), /Not covered here, check by hand on the built site:/);
});

test('source e2e leaves the repository as it found it, and no session behind', async () => {
  const s = staging();
  await s.go();
  assert.equal(s.gh.head(), s.startHead);
  for (const f of Object.keys(FILES)) assert.equal(s.gh.read(f), FILES[f], f);
  assert.deepEqual([...s.gh.refs.keys()], ['heads/main']);
  assert.equal([...s.kv.map.keys()].some(k => k.startsWith('esess:')), false);
  assert.deepEqual(s.kvCalls.map(c => c[0]), ['put', 'put', 'put', 'delete', 'delete', 'delete']);
  // The editor that publishes may only touch the content folder.
  assert.deepEqual(s.kvCalls.filter(c => c[0] === 'put').map(c => c[2]), [900, 900, 900]);
});

test('source e2e has teeth: a worker that edits the page template, lets an editor out of its folders, or changes a line it was not asked to, fails the run', async () => {
  const accept = (match) => async (url, init) => (url.startsWith(STAGING_WORKER) && match(url, init) ? new Response('{"ok":true,"commit":{"sha":"x"}}', { status: 200 }) : null);
  const body = (init) => { try { return JSON.parse(init.body || '{}'); } catch { return {}; } };
  for (const [what, match, expected] of [
    ['the template as a source edit', (url, init) => url.endsWith('/source/commit') && body(init).file === TEMPLATE, /refused: text that lives in the page template, as a source edit .* — expected 400 file type not editable, got 200/],
    ['the template through the proxy', (url, init) => init.method === 'PUT' && url.endsWith(`/contents/${TEMPLATE}`), /refused: the page template written directly through the proxy — expected 415 file_type, got 200/],
    ['a file outside the folder', (url, init) => url.endsWith('/source/commit') && body(init).file === 'src/content/site/home.md', /refused: a content file outside the editor's folders — expected 403 outside your editing scope, got 200/],
    ['a delete', (url, init) => url.endsWith('/git/trees'), /refused: deleting the content file .* — expected 403 no_delete, got 200/],
    ['script markup', (url, init) => url.endsWith('/source/commit') && /script/.test(body(init).edits?.[0]?.value || ''), /refused: script markup in a value — expected 422 no edits could be applied, got 200/],
  ]) {
    const s = staging();
    s.intercept.fn = accept(match);
    const r = await s.go();
    assert.equal(r.ok, false, what);
    assert.match(s.out(), expected, what);
    assert.equal(s.gh.head(), s.startHead, `${what}: still put back`);
  }
  // A publish that also rewrites a line nobody edited (here: re-quoting the start time).
  const s = staging();
  s.intercept.fn = async (url, init) => {
    if (!(url.endsWith('/source/commit') && body(init).edits?.length === 2)) return null;
    const text = fixture(ONE).replace('Interfaith Worship Service', 'E2E title 01010101').replace('Big Bethel AME', 'E2E venue 01010101').replace("start: '18:00'", 'start: "18:00"');
    const sha = s.gh.commit({ [ONE]: text }, { by: { name: 'Kiln E2E events (via Kiln)', email: EDITOR }, message: 'E2E' });
    return new Response(JSON.stringify({ ok: true, file: ONE, commit: { sha }, applied: ['a', 'b'], skipped: [] }), { status: 200 });
  };
  const r = await s.go();
  assert.equal(r.ok, false);
  assert.deepEqual(names(r, false), ['on GitHub: exactly the two edited lines changed; every other line is what it was']);
  assert.match(s.out(), /lines 2, 4, 5 changed; expected lines 2, 5/);
  assert.equal(s.gh.head(), s.startHead);
});

test('source e2e has teeth: a worker that writes over a field someone else changed fails the run', async () => {
  // A worker from before the check: it never looks at what an edit read.
  const s = staging();
  const env = { KILN: s.kv, ALLOWED_ORIGINS: '' };
  s.intercept.fn = async (url, init) => {
    if (!url.endsWith('/source/commit') || !init.body) return null;
    const body = JSON.parse(init.body);
    if (!(body.edits || []).some(e => 'was' in e)) return null;
    for (const e of body.edits) delete e.was;
    return worker.fetch(new Request(url, { ...init, body: JSON.stringify(body) }), env);
  };
  const r = await s.go();
  assert.equal(r.ok, false);
  assert.deepEqual(names(r, false), ['the first editor publishes the old title and the venue: the title is left out with what the file says now, the venue is saved']);
  assert.match(s.out(), /the title is left out with what the file says now, the venue is saved — applied \[[^\]]*\], skipped \[\]/);
  assert.equal(s.gh.head(), s.startHead, 'still put back');
  assert.equal(s.gh.read(ONE), FILES[ONE]);
});

test('source e2e stops before writing when the repository is not marked, is not a source-mode site, or lacks the fields', async () => {
  const { '.kiln-e2e': _m, ...unmarked } = FILES;
  const cases = [
    [unmarked, 'the repository is marked as a test repository (.kiln-e2e)'],
    [{ ...FILES, 'public/assets/kiln-config.js': "window.KILN = { repo: 'a/b', worker: 'x' };\n" }, 'the site is set up for source mode (its kiln-config.js says so)'],
    [{ ...FILES, [ONE]: '---\ntitle: Only a title\n---\nBody\n' }, 'starting state recorded'],
  ];
  for (const [files, failing] of cases) {
    const s = staging({ files });
    const r = await s.go();
    assert.deepEqual(names(r, false), [failing]);
    assert.equal(s.gh.calls.filter(c => c.method !== 'GET').length, 0, `${failing}: nothing was written`);
    assert.deepEqual(s.kvCalls, [], `${failing}: no session was made`);
  }
});

test('source e2e: a failure midway still puts everything back; --smoke writes nothing', async () => {
  const s = staging();
  let puts = 0;
  s.gh.failOn((method, path) => method === 'PUT' && path === `/contents/${ONE}` && ++puts === 5);   // GitHub breaks at the undo
  const r = await s.go();
  assert.equal(r.ok, false);
  assert.deepEqual(names(r, false), ['editor undoes the change (what the editor offers after a failed build)']);
  assert.ok(names(r, true).includes('cleanup: the repository is as it was found'));
  assert.equal(s.gh.head(), s.startHead);
  assert.equal(s.gh.read(ONE), FILES[ONE]);
  const smoke = staging({ smoke: true });
  const q = await smoke.go();
  assert.equal(q.ok, true, smoke.out());
  assert.equal(q.checks.length, 4);
  assert.deepEqual(smoke.kvCalls, []);
  assert.equal(smoke.gh.calls.length, 0);
});

// ─── shared with e2e.mjs ─────────────────────────────────────────────────────

test('both scripts: a 429 from the worker is waited out, not counted as a failed check', async () => {
  for (const script of [run, runHtml]) {
    const s = script === run ? staging() : staging({ files: { '.kiln-e2e': '', 'index.html': '<!doctype html>\n<html><body>\n<p data-cms="line">A line.</p>\n</body></html>\n' } });
    // The limiter trips on the 5th, 6th and 12th request to the worker; once it says how long to wait.
    let count = 0;
    s.intercept.fn = async (url) => {
      if (!url.startsWith(STAGING_WORKER)) return null;
      count++;
      if (count === 5) return new Response('{"error":"rate limited, slow down"}', { status: 429 });
      if (count === 6) return new Response('{"error":"rate limited, slow down"}', { status: 429, headers: { 'Retry-After': '7' } });
      if (count === 12) return new Response('{"error":"rate limited, slow down"}', { status: 429 });
      return null;
    };
    const r = await s.go(script);
    assert.equal(r.ok, true, s.out());
    assert.deepEqual(s.sleeps.filter(ms => ms === 15000 || ms === 7000), [15000, 7000, 15000]);
    assert.match(s.out(), /the worker asked to slow down \(429\): waiting 15 seconds/);
    assert.match(s.out(), /waiting 7 seconds/);
  }
});

test('both scripts: a worker that keeps answering 429 does fail the check, after six waits; other hosts and other statuses are not retried', async () => {
  const sleeps = [];
  let calls = 0;
  const io = patient({ fetch: async () => { calls++; return new Response('{}', { status: 429 }); }, sleep: async (ms) => sleeps.push(ms), log: () => {} }, { worker: STAGING_WORKER });
  assert.equal((await io.fetch(`${STAGING_WORKER}/gh/x`, {})).status, 429);
  assert.equal(calls, 7);
  assert.deepEqual(sleeps, [15000, 15000, 15000, 15000, 15000, 15000]);
  calls = 0;
  assert.equal((await io.fetch('https://api.github.com/rate_limit', {})).status, 429);
  assert.equal(calls, 1, 'GitHub is not the worker');
  const other = patient({ fetch: async () => new Response('{}', { status: 503 }), sleep: async () => { throw new Error('should not wait'); }, log: () => {} }, { worker: STAGING_WORKER });
  assert.equal((await other.fetch(`${STAGING_WORKER}/healthz`, {})).status, 503);
});

test('both scripts: when wrangler may not write to the KV, the message says what to do', () => {
  const refused = kvFailure(['kv', 'key', 'put', 'esess:abc', '{}'], '\n✘ [ERROR] A request to the Cloudflare API (/accounts/x/storage/kv/namespaces/y/values/z) failed.\n\n  Authentication error [code: 10000]\n');
  assert.match(refused, /^wrangler kv key put was refused by Cloudflare \(.*\)\. Wrangler's browser sign-in can be allowed to read this KV namespace and not to write it\./);
  assert.match(refused, /CLOUDFLARE_API_TOKEN .*CLOUDFLARE_ACCOUNT_ID.*or CLOUDFLARE_API_KEY, CLOUDFLARE_EMAIL and CLOUDFLARE_ACCOUNT_ID/);
  assert.match(refused, /Nothing was written to the repository$/);
  assert.doesNotMatch(refused, /esess:abc/, 'the session id is not echoed');
  assert.equal(kvFailure(['kv', 'key', 'delete', 'k'], 'fetch failed: ENOTFOUND api.cloudflare.com'), 'wrangler kv key delete failed: fetch failed: ENOTFOUND api.cloudflare.com');
});
