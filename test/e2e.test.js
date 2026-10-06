/**
 * KLR-22 — scripts/e2e.mjs: the editing loop as invited editors drive it,
 * runnable as one command against staging, and leaving the repository as it
 * found it.
 *
 * The script cannot be run against staging from a test. Here it runs against
 * the REAL worker handlers and the REAL editor transport, with GitHub played
 * by an in-memory repository that keeps a true git history
 * (test/github-fake.js) and KV by the usual stand-in. So every publish and
 * every refusal in the script is exercised for real on every `npm test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../worker/index.js';
import { run, readConfig, Stop, STAGING_WORKER } from '../scripts/e2e.mjs';
import { fakeKV, withFetch } from './worker-harness.js';
import { fakeGitHub } from './github-fake.js';

const REPO = 'acme/kiln-e2e';
const PAGE = '<!doctype html>\n<html>\n<head><title>Test site</title></head>\n<body>\n  <h1 data-cms="hero_title">A test site</h1>\n  <p data-cms="hero_tagline">The original line, exactly as it was.</p>\n  <script src="/assets/kiln-config.js"></script>\n  <script src="/assets/kiln.js" defer></script>\n</body>\n</html>\n';
const FILES = { 'index.html': PAGE, 'assets/site.css': 'h1{color:teal}', '.kiln-e2e': '' };

/** A real RSA key, so the worker can sign its App token for a name it has no cached token for (a renamed repository). */
const { privateKey } = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const PK8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', privateKey)).toString('base64');

/**
 * GitHub for a repository that can be renamed. Every name it has had answers,
 * the earlier ones with its current name, as GitHub's redirect does; its id
 * stays what it was; the App is installed on it under every name.
 */
function renameable(gh, { id = 4711, admin = true } = {}) {
  let current = REPO;
  const known = new Set([REPO]);
  const renames = [];
  let refuse = () => false;
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
  return {
    renames,
    name: () => current,
    refuseRename: (fn) => { refuse = fn; },
    handler: async (url, init = {}) => {
      if (url === 'https://api.github.com/app/installations/77/access_tokens') return json({ token: 'installation-token' }, 201);
      const m = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/?]+)(.*)$/.exec(url);
      if (!m || !known.has(m[1])) return undefined;
      const [, asked, rest] = m;
      const method = (init.method || 'GET').toUpperCase();
      if (rest === '/installation') return json({ id: 77 });
      if (rest === '' && method === 'PATCH') {
        const to = `${current.split('/')[0]}/${JSON.parse(init.body).name}`;
        if (refuse(asked, to)) return json({ message: 'Server Error' }, 500);
        renames.push([asked, to]);
        current = to;
        known.add(to);
        return json({ id, full_name: current });
      }
      if (rest === '' && method === 'GET') return json({ id, full_name: current, default_branch: 'main', permissions: { push: true, admin } });
      return gh.handler(`https://api.github.com/repos/${REPO}${rest}`, init);
    },
  };
}

/** Staging, as the script would find it: a worker with its App, installed on a marked test repository. */
function staging({ files = FILES, token = 'owner-token', smoke = false, rename = null, env: envOver = {} } = {}) {
  const gh = fakeGitHub({ repo: REPO, files });
  const ren = rename ? renameable(gh, rename) : null;
  const kv = fakeKV({ 'app:creds': { slug: 'kiln-cms-staging', app_id: 1, client_id: 'cid', ...(rename ? { pk8: PK8 } : {}) }, [`itok:${REPO}`]: 'installation-token' });
  const env = { KILN: kv, ALLOWED_ORIGINS: '' };
  const lines = [];
  const kvCalls = [];
  let n = 0;
  let tick = 1_800_000_000_000;
  const intercept = { fn: null };
  const io = {
    fetch: async (url, init = {}) => {
      if (intercept.fn) { const r = await intercept.fn(url, init); if (r) return r; }
      return url.startsWith(STAGING_WORKER) ? worker.fetch(new Request(url, init), env) : globalThis.fetch(url, init);
    },
    kvPut: async (key, value, ttl) => { kvCalls.push(['put', key, ttl]); kv.map.set(key, value); },
    kvDelete: async (key) => { kvCalls.push(['delete', key]); kv.map.delete(key); },
    log: (l) => lines.push(l),
    sleep: async () => {},
    now: () => (tick += 1000),
    hex: (bytes) => (++n).toString(16).padStart(2, '0').repeat(bytes),
  };
  const cfg = readConfig({ KILN_E2E_REPO: REPO, GH_TOKEN: token, ...envOver }, smoke ? ['--smoke'] : rename ? ['--rename'] : []);
  const go = () => withFetch(ren ? ren.handler : gh.handler, () => run(cfg, io));
  return { gh, ren, kv, env, io, cfg, lines, kvCalls, intercept, go, out: () => lines.join('\n'), startHead: gh.head(), startRefs: [...gh.refs.keys()].sort() };
}
const names = (r, ok) => r.checks.filter(c => c.ok === ok).map(c => c.name);

test('KLR-22 a full run: every publish goes through the worker as an editor, every refusal is tried for real, all checks pass', async () => {
  const s = staging();
  const r = await s.go();
  assert.deepEqual(names(r, false), [], s.out());
  assert.equal(r.ok, true);
  assert.equal(r.checks.length, 39, s.out());
  const passed = names(r, true);
  for (const name of [
    'editor publishes a text edit', 'editor puts the page back, byte for byte',
    'editor publishes two pictures in one commit (the staged-upload path: blobs, tree, commit, branch move)',
    'editor saves a draft (a new kiln-drafts branch, then a write to it)', 'editor names a version (a tag on an earlier commit)',
    'refused: an SVG upload', 'refused: a script added to a page', 'refused: a workflow file',
    'refused: deleting a file (a tree entry with no content)', 'refused: moving the branch back to an earlier commit', 'refused: a forced branch update',
    'refused: a new branch at a commit the repository does not have', 'refused: a stylesheet, without the Theme tool', 'refused: a new page, without the New page tool',
    'none of the refused requests changed the branch', 'granted editor publishes a new page and a picture in one commit', 'granted editor writes a stylesheet',
    'refused: a suggest-only editor publishing straight to the site', 'suggest-only editor writes its preview to its own scratch branch',
    'cleanup: the repository is as it was found',
  ]) assert.ok(passed.includes(name), `missing: ${name}`);
  // The publishes were real commits by the editors, made through the proxy with the installation token.
  const byEditors = [...s.gh.commits.values()].filter(c => c.author.email === 'kiln-editor@users.noreply.github.com');
  assert.equal(byEditors.length, 7, 'edit, restore, uploads, draft, new page, stylesheet, suggestion preview');
  assert.deepEqual([...new Set(byEditors.map(c => c.author.name))].sort(), ['Kiln E2E default (via Kiln)', 'Kiln E2E granted (via Kiln)', 'Kiln E2E suggest (via Kiln)']);
  const editorWrites = s.gh.calls.filter(c => c.method !== 'GET' && c.auth === 'Bearer installation-token');
  assert.ok(editorWrites.length >= 15);
  // The maintainer's token was used to read, and to put things back: nothing else.
  const ownerWrites = s.gh.calls.filter(c => c.method !== 'GET' && c.auth === 'Bearer owner-token').map(c => `${c.method} ${c.path.replace(/\d{10}-e2e-\w+|e2e-\w+/, 'X')}`);
  assert.deepEqual(ownerWrites, ['DELETE /git/refs/heads/kiln-drafts', 'DELETE /git/refs/tags/kiln/X', 'DELETE /git/refs/heads/kiln/suggest-X', 'PATCH /git/refs/heads/main']);
  assert.match(s.out(), /39\/39 checks passed/);
  assert.match(s.out(), /Not covered here, check by hand on staging:/);
});

test('KLR-22 it leaves the repository as it found it: same head, same page, no branch or tag left, no session left', async () => {
  const s = staging();
  await s.go();
  assert.equal(s.gh.head(), s.startHead);
  assert.equal(s.gh.read('index.html'), PAGE);
  assert.deepEqual([...s.gh.refs.keys()].sort(), s.startRefs, 'only main, as before');
  assert.deepEqual(s.gh.paths(), ['.kiln-e2e', 'assets/site.css', 'index.html'], 'no upload, page or stylesheet left behind');
  assert.equal([...s.kv.map.keys()].some(k => k.startsWith('esess:')), false);
  assert.deepEqual(s.kvCalls.map(c => c[0]), ['put', 'put', 'put', 'delete', 'delete', 'delete']);
  assert.deepEqual(s.kvCalls.filter(c => c[0] === 'put').map(c => c[2]), [900, 900, 900], 'sessions expire by themselves in 15 minutes even if cleanup never ran');
});

test('KLR-22 a repository that is not marked as a test repository is never written to', async () => {
  const s = staging({ files: { 'index.html': PAGE } });   // no .kiln-e2e
  const r = await s.go();
  assert.equal(r.ok, false);
  assert.deepEqual(names(r, false), ['the repository is marked as a test repository (.kiln-e2e)']);
  assert.match(s.out(), /there is no \.kiln-e2e file at its root, so this script will not write to it/);
  assert.equal(s.gh.calls.filter(c => c.method !== 'GET').length, 0, 'not one write reached GitHub');
  assert.deepEqual(s.kvCalls, [], 'no session was made');
  assert.equal(s.gh.head(), s.startHead);
});

test('KLR-22 when a step fails midway, the run stops there, says which, and still puts everything back', async () => {
  const s = staging();
  s.gh.failOn((method, path) => method === 'POST' && path === '/git/trees');   // GitHub breaks at the upload commit
  const r = await s.go();
  assert.equal(r.ok, false);
  assert.deepEqual(names(r, false), ['editor publishes two pictures in one commit (the staged-upload path: blobs, tree, commit, branch move)']);
  assert.equal(names(r, true).includes('cleanup: the repository is as it was found'), true);
  assert.equal(names(r, true).some(n => n.startsWith('refused:')), false, 'later steps did not run');
  assert.equal(s.gh.head(), s.startHead);
  assert.equal(s.gh.read('index.html'), PAGE);
  assert.equal([...s.kv.map.keys()].some(k => k.startsWith('esess:')), false);
});

test('KLR-22 it has teeth: a worker that lets a refused write through fails the run', async () => {
  for (const [what, match, expected] of [
    ['an SVG upload', (url, init) => init.method === 'PUT' && /\.svg$/.test(url), /refused: an SVG upload — expected 403 file_active, got 201/],
    ['a delete', (url, init) => init.method === 'POST' && url.endsWith('/git/trees') && /"sha":null/.test(init.body || ''), /refused: deleting a file .* — expected 403 no_delete, got 201/],
    ['a rollback', (url, init) => init.method === 'PATCH' && /git\/refs\/heads\/main$/.test(url) && !/force/.test(init.body || ''), /refused: moving the branch back to an earlier commit — expected 403 ref_not_direct, got 201/],
  ]) {
    const s = staging();
    s.intercept.fn = async (url, init) => (url.startsWith(STAGING_WORKER) && match(url, init) ? new Response('{"sha":"x"}', { status: 201 }) : null);
    const r = await s.go();
    assert.equal(r.ok, false, what);
    assert.match(s.out(), expected, what);
    assert.equal(s.gh.head(), s.startHead, `${what}: still cleaned up`);
  }
  // A refusal for the wrong reason is not a pass either.
  const s = staging();
  s.intercept.fn = async (url, init) => (url.startsWith(STAGING_WORKER) && init.method === 'PUT' && /\.css$/.test(url) ? new Response('{"error":"session expired"}', { status: 401 }) : null);
  assert.equal((await s.go()).ok, false);
  assert.match(s.out(), /refused: a stylesheet, without the Theme tool — expected 403 grant_required, got 401/);
});

test('KLR-22 if someone else commits to the branch during the run, nothing is reset and the run says so', async () => {
  const s = staging();
  let done = false;
  s.gh.onWrite((gh) => { if (!done && gh.calls.some(c => c.path === '/git/refs' && /tags/.test(c.body.ref || ''))) { done = true; gh.commit({ 'notes.html': '<p>the owner, meanwhile</p>' }, { message: 'owner work' }); } });
  const r = await s.go();
  assert.equal(r.ok, false);
  const cleanup = r.checks.find(c => c.name === 'cleanup: the repository is as it was found');
  assert.equal(cleanup.ok, false);
  assert.match(cleanup.detail, /someone else committed meanwhile, so nothing was reset/);
  assert.notEqual(s.gh.head(), s.startHead);
  assert.equal(s.gh.read('notes.html'), '<p>the owner, meanwhile</p>', 'their commit is still there');
  assert.equal(s.gh.calls.some(c => c.method === 'PATCH' && c.body.force && c.auth === 'Bearer owner-token'), false, 'no forced reset');
});

test('KLR-22 a kiln-drafts branch that was already there is used and left in place', async () => {
  const s = staging();
  s.gh.refs.set('heads/kiln-drafts', s.gh.head());
  const r = await s.go();
  assert.equal(r.ok, true, s.out());
  assert.ok(s.gh.refs.has('heads/kiln-drafts'));
  assert.match(s.out(), /the branch was already there; left in place/);
});

test('KLR-22 with KILN_E2E_SITE it waits for the edit to show on the site', async () => {
  const s = staging({ env: { KILN_E2E_SITE: 'https://e2e.example/' } });
  s.intercept.fn = async (url) => (url.startsWith('https://e2e.example/') ? new Response(s.gh.read('index.html')) : null);
  const r = await s.go();
  assert.equal(r.ok, true, s.out());
  assert.ok(names(r, true).includes('the edit appears on https://e2e.example'));
});

test('KLR-22 --smoke writes nothing anywhere: no session, no call to GitHub, no token needed', async () => {
  const s = staging({ smoke: true, token: '', env: { KILN_E2E_REPO: '' } });
  const r = await s.go();
  assert.equal(r.ok, true, s.out());
  assert.equal(r.checks.length, 12);
  assert.deepEqual(s.kvCalls, []);
  assert.equal(s.gh.calls.length, 0);
  assert.match(s.out(), /12\/12 checks passed \(smoke: nothing was written\)/);
});

test('KLR-22 where it will run: staging by default, a local worker, and nowhere else unless --smoke; no default repository', () => {
  const ok = { KILN_E2E_REPO: REPO, GH_TOKEN: 't' };
  assert.equal(readConfig(ok).worker, 'https://kiln-auth-staging.erikkwilder.workers.dev');
  assert.equal(readConfig({ ...ok, KILN_E2E_WORKER: 'http://localhost:8778/' }).local, true);
  for (const w of ['https://auth.kilncms.com', 'https://kiln-auth.erikkwilder.workers.dev', 'https://kiln-auth-staging.erikkwilder.workers.dev.evil.example', 'https://someone.workers.dev']) {
    assert.throws(() => readConfig({ ...ok, KILN_E2E_WORKER: w }), /is neither the staging worker nor a local one/, w);
    assert.equal(readConfig({ KILN_E2E_WORKER: w }, ['--smoke']).smoke, true);
  }
  assert.throws(() => readConfig({ GH_TOKEN: 't' }), /Set KILN_E2E_REPO .* There is no default/);
  assert.throws(() => readConfig({ KILN_E2E_REPO: REPO }), /Set GH_TOKEN/);
  assert.throws(() => readConfig(ok, ['--production']), Stop);
  const src = readFileSync(new URL('../scripts/e2e.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /auth\.kilncms\.com|kilncms\/kiln-demo|kiln-demo\.pages\.dev/, 'the script names neither production nor the public demo');
  assert.match(src, /'--env', 'staging', '--remote'/, 'sessions are written to the staging KV, never another');
  assert.doesNotMatch(src, /--env', 'production'/);
});

// ─── --rename: what the worker stores follows the repository, on request only ──

const stored = (s) => [...s.kv.map.keys()].filter(k => /^(cmt|sug|sched|atok|esess):/.test(k));

test('--rename is off unless asked for, and is not a smoke check', () => {
  const ok = { KILN_E2E_REPO: REPO, GH_TOKEN: 't' };
  assert.equal(readConfig(ok).rename, false);
  assert.equal(readConfig(ok, ['--rename']).rename, true);
  assert.throws(() => readConfig(ok, ['--smoke', '--rename']), /--rename renames the test repository and back; --smoke writes nothing/);
  assert.throws(() => readConfig(ok, ['--renamed']), /Unknown option --renamed\. Use: node scripts\/e2e\.mjs \[--smoke\] \[--rename\]/);
});

test('--rename: after the full run the repository is renamed, everything stored for it is found under the new name and the old one, and it is renamed back', async () => {
  const s = staging({ rename: {} });
  const r = await s.go();
  assert.deepEqual(names(r, false), [], s.out());
  const passed = names(r, true);
  for (const name of [
    'rename: the token may rename the test repository, and it has the name the run was given',
    'rename: a comment, a suggestion, a scheduled post and an API token are stored under the name it has now',
    'rename: the repository is renamed on GitHub',
    'rename: asked under the new name, the worker shows the comment, the suggestion, the scheduled post and the token',
    'rename: a page that still has the old name is shown the same four',
    'rename: the API token made before the rename still reads the page',
    'rename: the editor sessions from before the rename are ended (editors sign in once more)',
    'rename: the repository has its own name back',
    'rename: what this step stored in the worker is removed again',
    'cleanup: the repository is as it was found',
  ]) assert.ok(passed.includes(name), `missing: ${name}`);
  // Renamed once and renamed back once; GitHub calls it what it was called.
  assert.equal(s.ren.renames.length, 2);
  assert.match(s.ren.renames[0][1], /^acme\/kiln-e2e-renamed-\w+$/);
  assert.deepEqual(s.ren.renames[1], [s.ren.renames[0][1], REPO]);
  assert.equal(s.ren.name(), REPO);
  // The repository and the worker are as they were found.
  assert.equal(s.gh.head(), s.startHead);
  assert.equal(s.gh.read('index.html'), PAGE);
  assert.deepEqual(stored(s), [], 'no comment, suggestion, schedule, token or session is left');
  assert.equal(JSON.parse(s.kv.map.get('rid:4711')).name, REPO, 'and the worker files the repository under its own name again');
});

test('--rename: when a check fails while the repository has the other name, it still gets its name back and what was stored is removed', async () => {
  const s = staging({ rename: {} });
  // The worker shows no comments under the new name.
  s.intercept.fn = async (url) => (/\/comments\?repo=acme\/kiln-e2e-renamed-/.test(url) ? new Response('{"threads":[]}', { status: 200, headers: { 'Content-Type': 'application/json' } }) : null);
  const r = await s.go();
  assert.equal(r.ok, false);
  assert.deepEqual(names(r, false), ['rename: asked under the new name, the worker shows the comment, the suggestion, the scheduled post and the token']);
  assert.match(s.out(), /the worker does not show the comment \(200\)/);
  assert.equal(s.ren.renames.length, 2, 'renamed back all the same');
  assert.equal(s.ren.name(), REPO);
  assert.ok(names(r, true).includes('rename: the repository has its own name back'));
  assert.deepEqual(stored(s), []);
  assert.equal(s.gh.head(), s.startHead);
});

test('--rename: if GitHub will not rename it back, the run fails and prints the command that does', async () => {
  const s = staging({ rename: {} });
  s.ren.refuseRename((asked, to) => to === REPO);
  const r = await s.go();
  assert.equal(r.ok, false);
  const back = r.checks.find(c => c.name === 'rename: the repository has its own name back');
  assert.equal(back.ok, false);
  assert.match(back.detail, /rename it back by hand: gh api -X PATCH repos\/acme\/kiln-e2e-renamed-\w+ -f name=kiln-e2e$/);
  assert.notEqual(s.ren.name(), REPO);
  assert.deepEqual(stored(s), [], 'what was stored is removed even so');
});

test('--rename: a token that may not rename the repository stops the step before anything is stored or renamed', async () => {
  const s = staging({ rename: { admin: false } });
  const r = await s.go();
  assert.equal(r.ok, false);
  assert.deepEqual(names(r, false), ['rename: the token may rename the test repository, and it has the name the run was given']);
  assert.match(s.out(), /GH_TOKEN has no admin access to it, which renaming takes/);
  assert.deepEqual(s.ren.renames, []);
  assert.equal([...s.kv.map.keys()].some(k => /^(cmt|sug|sched|atok):/.test(k)), false);
  assert.equal(s.gh.head(), s.startHead, 'and the rest of the run is still put back');
});
