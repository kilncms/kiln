// Who is online: a person who signed out stops counting at once, and a person
// counts once however many tabs they have. The editor's side (src/editor/online.js)
// and the service's side (presencePing in worker/index.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { peopleOnline, onlineLabel, leaveBody, tellLeft } from '../src/editor/online.js';
import { editorEnv, call, REPO, SESSION } from './worker-harness.js';

const ANA = 'b'.repeat(64);
const twoPeople = () => editorEnv({}, {
  [`esess:${ANA}`]: { repo: REPO, name: 'Ana', role: 'editor', email: 'ana@example.com', paths: [''], keys: [], features: null, mode: null },
});
const ping = (env, session, path = '/', more = {}) => call(env, 'POST', '/presence', { session, body: { repo: REPO, path, name: 'ignored', ...more } });

// ─── the editor ──────────────────────────────────────────────────────────────

test('a person is one row however many rows the service sent, and the person looking is not counted', () => {
  const rows = [
    { name: 'Sam', role: 'editor', page: '/' },
    { name: 'Sam', role: 'editor', page: '/about.html' },
    { name: 'Ana', role: 'editor', page: '/' },
    { name: 'Rosa', role: 'owner', page: '/' },
    { name: '', role: 'editor', page: '/' },
    null,
  ];
  const people = peopleOnline(rows, 'Ana');
  assert.deepEqual(people.map(p => p.name), ['Sam', 'Rosa']);
  assert.equal(people[0].page, '/', 'the first row the service sent for a person is the one kept');
  assert.equal(onlineLabel(people), '2 online');
  assert.deepEqual(peopleOnline(undefined, 'Ana'), []);
  assert.equal(onlineLabel([]), '0 online');
});

test('signing out sends the same ping with leave: true', () => {
  assert.deepEqual(leaveBody({ repo: 'acme/site', path: '/about.html', name: 'Sam' }), { repo: 'acme/site', path: '/about.html', name: 'Sam', leave: true });
  assert.equal(leaveBody({ repo: 'acme/site' }).path, '/');
});

test('telling the service never fails the sign-out and never holds it up for long', async () => {
  assert.equal(await tellLeft(async () => ({ ok: true })), true);
  assert.equal(await tellLeft(async () => ({ ok: false })), false, 'the service refused');
  assert.equal(await tellLeft(async () => { throw new Error('offline'); }), false);
  assert.equal(await tellLeft(() => { throw new Error('thrown at once'); }), false);
  const started = Date.now();
  assert.equal(await tellLeft(() => new Promise(() => {}), { wait: 40 }), false, 'a service that never answers');
  assert.ok(Date.now() - started < 1000);
});

test('the editor tells the service before it signs out, and stops pinging first', () => {
  const main = readFileSync(new URL('../src/editor/main.js', import.meta.url), 'utf8');
  const signOut = main.slice(main.indexOf('async function signOut()'), main.indexOf('function renderAdminBar()'));
  assert.match(signOut, /leaving = true;/);
  assert.match(signOut, /await tellLeft\(/);
  assert.match(signOut, /leaveBody\(\{ repo: cfg\.repo, path: location\.pathname, name: state\.user \}\)/);
  assert.ok(signOut.indexOf('leaving = true;') < signOut.indexOf('await tellLeft('), 'no ping can follow the leave');
  assert.ok(signOut.indexOf('await tellLeft(') < signOut.indexOf('window.Kiln.logout()'), 'the sign-in is still good when the service is told');
  assert.match(main, /if \(signInOver \|\| leaving\) return;   \/\/ nobody is signed in to be shown/);
  assert.match(main, /state\.online = peopleOnline\(data\.online, state\.user\);/);
});

// ─── the service ─────────────────────────────────────────────────────────────

test('a person who signed out stops counting at once', async () => {
  const env = twoPeople();
  await ping(env, SESSION);
  assert.deepEqual((await ping(env, ANA)).json.online.map(o => o.name), ['Sam']);
  const left = await ping(env, SESSION, '/', { leave: true });
  assert.equal(left.status, 200);
  assert.deepEqual(left.json, { ok: true, left: true });
  assert.equal(env.KILN.map.has(`pres:${REPO}:Sam`), false, 'the entry is gone, not left to run out');
  assert.deepEqual((await ping(env, ANA)).json.online, []);
  assert.deepEqual((await ping(env, ANA)).json.others, []);
});

test('a person is counted once however many tabs they have', async () => {
  const env = twoPeople();
  await ping(env, SESSION, '/');
  await ping(env, SESSION, '/about.html');
  await ping(env, SESSION, '/blog/');
  await ping(env, SESSION, '/');
  const seen = (await ping(env, ANA, '/')).json;
  assert.equal(seen.online.length, 1);
  assert.equal(seen.online[0].name, 'Sam');
  assert.equal([...env.KILN.map.keys()].filter(k => k.startsWith(`pres:${REPO}:`)).length, 2, 'one entry for Sam, one for Ana');
  const own = (await ping(env, SESSION, '/')).json;
  assert.deepEqual(own.online.map(o => o.name), ['Ana'], 'a person never counts their own other tabs');
});

test('leaving writes nothing, and a person who comes back counts again', async () => {
  const env = twoPeople();
  let writes = 0;
  const put = env.KILN.put.bind(env.KILN);
  env.KILN.put = async (k, v, o) => { if (k.startsWith('pres:')) writes++; return put(k, v, o); };
  assert.equal((await ping(env, SESSION, '/', { leave: true })).status, 200, 'leaving without ever having been listed is fine');
  assert.equal(writes, 0);
  await ping(env, SESSION);
  await ping(env, SESSION, '/', { leave: true });
  await ping(env, SESSION);
  assert.deepEqual((await ping(env, ANA)).json.online.map(o => o.name), ['Sam']);
});

test('nobody is taken off the list by someone who is not signed in', async () => {
  const env = twoPeople();
  await ping(env, SESSION);
  const res = await ping(env, null, '/', { leave: true });
  assert.equal(res.status, 403);
  assert.equal(env.KILN.map.has(`pres:${REPO}:Sam`), true);
  const other = await ping(env, ANA, '/', { leave: true, name: 'Sam' });
  assert.equal(other.status, 200);
  assert.equal(env.KILN.map.has(`pres:${REPO}:Sam`), true, 'an invited person leaves under their own name only');
});

test('a service that cannot remove the entry still answers, so the sign-out is not held up', async () => {
  const env = twoPeople();
  await ping(env, SESSION);
  env.KILN.delete = async () => { throw new Error('KV is not answering'); };
  const res = await ping(env, SESSION, '/', { leave: true });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { ok: true, left: false });
});
