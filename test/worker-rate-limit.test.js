/**
 * How often the service may be asked (worker/index.js: rateLimited,
 * standingLimited, workLimited).
 *
 * Two testers on one site, from one network address, were refused again and
 * again: every request either of them made, signed in or not, was counted on
 * one count of 20 a minute for the address. A signed-in person's requests are
 * now counted for their own session, on a roomier count; the address count is
 * for the sign-in routes and for whoever comes with no session, or with a
 * session id nobody holds.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeKV, withFetch, call, jsonRes, REPO, ORIGIN } from './worker-harness.js';

const ADDRESS = '203.0.113.9';
const hex = (c) => c.repeat(64);
const OWNER = hex('1'), SAM = hex('2'), KIM = hex('3');

/** Cloudflare's rate-limit binding, for one minute: `limit` requests for each key. */
function limiter(limit) {
  const counts = new Map();
  return { counts, async limit({ key }) { const n = (counts.get(key) || 0) + 1; counts.set(key, n); return { success: n <= limit }; } };
}

function envWith({ rl = limiter(20), roomy = limiter(200), extra = {} } = {}) {
  const editor = (name) => ({ repo: REPO, name, role: 'editor', email: `${name.toLowerCase()}@example.com`, paths: [''], keys: [], features: null, mode: null });
  const env = {
    ALLOWED_ORIGINS: ORIGIN,
    KILN: fakeKV({
      [`osess:${OWNER}`]: { v: 1, token: 'gho_owner', token_exp: null, refresh_token: null, login: 'ada', uid: 1, repo: REPO, rid: 7, origin: ORIGIN, created: Date.now() },
      [`esess:${SAM}`]: editor('Sam'),
      [`esess:${KIM}`]: editor('Kim'),
      [`itok:${REPO}`]: 'installation-token',
      ...extra,
    }),
  };
  if (rl) env.RL = rl;
  if (roomy) env.RL_ROOMY = roomy;
  // How many times the store was read, to hold a made-up session to what it may cost.
  let reads = 0;
  const get = env.KILN.get;
  env.KILN.get = async (...a) => { reads++; return get(...a); };
  env.reads = () => reads;
  return env;
}

// GitHub says yes to everything: these tests are about who is counted, not about what a session may do.
const github = (url) => (url.startsWith('https://api.github.com/')
  ? jsonRes({ id: 7, full_name: REPO, default_branch: 'main', permissions: { push: true }, login: 'ada', sha: 'abc123', content: '', state: 'success', total_count: 0, tree: [] })
  : undefined);
const from = (session, headers = {}) => ({ session, headers: { 'CF-Connecting-IP': ADDRESS, ...headers } });
const page = (name) => `/gh/repos/${REPO}/contents/${name}?ref=main`;

/**
 * One person's busy minute, as the editor asks it (the counts are worked out
 * from src/editor/main.js): four pages opened, a publish and the watching
 * after it, sitting on a page, and the site menu saved on fourteen pages.
 * Returns every answer's status.
 */
async function busyMinute(env, session, { owner = false } = {}) {
  const got = [];
  const ask = async (method, path, opts = {}) => { got.push((await call(env, method, path, { ...from(session), ...opts })).status); };
  for (let i = 0; i < 4; i++) {                                   // opening a page
    await call(env, 'GET', `/standing?origin=${encodeURIComponent(ORIGIN)}`, from(null)).then(r => got.push(r.status));
    if (owner) await ask('GET', '/auth/session');
    await ask('GET', page(`p${i}.html`));
    await ask('GET', page(`p${i}/index.html`));
    await ask('GET', `/gh/repos/${REPO}/contents/p${i}.html?ref=kiln-drafts`);   // is there a saved draft?
    await ask('POST', '/presence', { body: { repo: REPO, path: `/p${i}`, name: 'x', build: 'test' } });
  }
  for (let i = 0; i < 2; i++) await ask('POST', '/presence', { body: { repo: REPO, path: '/p0', name: 'x', build: 'test' } });   // every 30 seconds
  await ask('GET', page('p0.html'));                               // a publish reads the page, then writes it
  await ask('GET', page('p0.html'));
  for (let i = 0; i < 5; i++) {                                   // watching it go live: every 12 seconds, two requests
    await ask('GET', `/gh/repos/${REPO}/deployments?sha=abc123&per_page=1`);
    await ask('GET', `/gh/repos/${REPO}/commits/abc123/status`);
  }
  await ask('GET', `/gh/repos/${REPO}/git/trees/main?recursive=1`);   // the site menu on 14 pages: N + 6
  for (let i = 0; i < 14; i++) await ask('GET', page(`m${i}.html`));
  await ask('GET', `/gh/repos/${REPO}/git/ref/heads%2Fmain`);
  await ask('GET', `/gh/repos/${REPO}/git/commits/abc123`);
  return got;
}

test('limit: three people at one address through a busy minute are never refused, and none of it is counted for the address', async () => {
  const env = envWith();
  await withFetch(github, async () => {
    const all = [
      ...(await busyMinute(env, OWNER, { owner: true })),
      ...(await busyMinute(env, SAM)),
      ...(await busyMinute(env, KIM)),
    ];
    assert.ok(all.length > 150, `the three made ${all.length} requests in the minute`);
    assert.equal(all.filter(s => s === 429).length, 0, 'nobody was told they asked too often');
    // The same minute on the old single count of 20 for the address would have refused most of it.
    assert.ok(all.length > 20 * 5);
  });
  // Each session was counted on its own, on the roomier count, and well inside it.
  const sessions = [...env.RL_ROOMY.counts].filter(([k]) => k.startsWith('session:'));
  assert.equal(sessions.length, 3);
  for (const [, n] of sessions) assert.ok(n > 20 && n < 100, `one person asked ${n} times`);
  assert.equal(env.RL_ROOMY.counts.get(`standing:${ADDRESS}`), 12);
  assert.equal(env.RL.counts.get(ADDRESS) || 0, 0, 'the address count is untouched, so signing in still has all of its share');
});

test('limit: a flood with no session is still stopped at 20 for its address, and is told when to ask again', async () => {
  const env = envWith();
  await withFetch(github, async (calls) => {
    const got = [];
    for (let i = 0; i < 26; i++) got.push(await call(env, 'GET', page('index.html'), from(null)));
    assert.deepEqual(got.slice(0, 20).map(r => r.status), Array(20).fill(401));
    const refused = got.slice(20);
    assert.deepEqual(refused.map(r => r.status), Array(6).fill(429));
    assert.equal(refused[0].res.headers.get('Retry-After'), '60');
    assert.equal(refused[0].res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
    assert.deepEqual(refused[0].json, { error: 'Too much was asked of the Kiln service from here in the last minute. Please wait a minute, then try again.', code: 'too_often', retry_after: 60 });
    assert.doesNotMatch(refused[0].json.error, /—|rate.?limit/i);
    assert.equal(calls.length, 0, 'nothing was asked of GitHub');
    // The sign-in routes are on the same count for the address, so they are shut too…
    assert.equal((await call(env, 'GET', '/auth/session', from(null))).status, 429);
    assert.equal((await call(env, 'POST', '/google/claim', { ...from(null), body: {} })).status, 429);
    // …and a real session does not open them: signing in is always counted for the address.
    assert.equal((await call(env, 'POST', '/google/claim', { ...from(SAM), body: {} })).status, 429);
    assert.equal((await call(env, 'POST', '/auth/adopt', { ...from(OWNER), body: {} })).status, 429);
    // The people at that address who are signed in carry on working.
    assert.equal((await call(env, 'GET', page('index.html'), from(SAM))).status, 200);
    assert.equal((await call(env, 'GET', '/auth/session', from(OWNER))).status, 200);
  });
});

test('limit: a made-up session is no way round the address count, and costs two reads of the store and nothing at GitHub', async () => {
  const env = envWith();
  await withFetch(github, async (calls) => {
    // A different made-up id each time, then one made-up id over and over.
    for (const made of [(i) => i.toString(16).padStart(2, '0').repeat(32), () => hex('f')]) {
      env.RL.counts.clear();
      const got = [], cost = [];
      for (let i = 0; i < 30; i++) {
        const before = env.reads();
        got.push((await call(env, 'GET', page('index.html'), from(made(i + 160)))).status);
        cost.push(env.reads() - before);
      }
      assert.equal(got.filter(s => s === 429).length, 10, 'stopped at 20, as with no session at all');
      assert.deepEqual(got.slice(20), Array(10).fill(429));
      assert.ok(!got.includes(200));
      // A refused one costs the two lookups that find it is nobody's session, and no more
      // (one of them is the read every request with a session id already cost).
      assert.deepEqual(cost.slice(20), Array(10).fill(2));
    }
    assert.equal(calls.length, 0, 'nothing was asked of GitHub');
    assert.equal([...env.RL_ROOMY.counts.keys()].filter(k => k.startsWith('session:')).length, 0, 'none was counted as a session');
  });
});

test('limit: a session that has ended is counted for the address again', async () => {
  const gone = hex('4');
  const env = envWith({ extra: { [`esess:${gone}`]: { repo: REPO, name: 'Old', role: 'editor', email: 'old@example.com', paths: [''], exp: Date.now() - 1000 } } });
  await withFetch(github, async () => {
    const got = [];
    for (let i = 0; i < 22; i++) got.push((await call(env, 'GET', page('index.html'), from(gone))).status);
    assert.deepEqual(got.slice(20), [429, 429]);
    assert.equal(env.RL.counts.get(ADDRESS), 22);
  });
});

test('limit: one session has its own roomy count, which another session at the same address does not share', async () => {
  const env = envWith();
  await withFetch(github, async () => {
    const got = [];
    for (let i = 0; i < 205; i++) got.push((await call(env, 'GET', page('index.html'), from(SAM))).status);
    assert.equal(got.slice(0, 200).filter(s => s !== 200).length, 0);
    assert.deepEqual(got.slice(200), Array(5).fill(429));
    // A real session is looked up once (two reads of the store at most), then
    // remembered: a person at work costs the limiter nothing more.
    const r0 = env.reads();
    assert.equal((await call(env, 'GET', page('index.html'), from(KIM))).status, 200);
    const first = env.reads() - r0;
    const r1 = env.reads();
    assert.equal((await call(env, 'GET', page('index.html'), from(KIM))).status, 200);
    assert.equal(first - (env.reads() - r1), 1, 'the second time, the limiter did not ask the store who this is');
  });
});

test('limit: the public /standing read is counted for the address on the roomier count, apart from the sign-in routes', async () => {
  const env = envWith({ roomy: limiter(5) });
  const ask = () => call(env, 'GET', `/standing?origin=${encodeURIComponent(ORIGIN)}`, from(null));
  for (let i = 0; i < 5; i++) assert.equal((await ask()).status, 200);
  const refused = await ask();
  assert.equal(refused.status, 429);
  assert.equal(refused.res.headers.get('Access-Control-Allow-Origin'), '*', 'readable from any page, as its answer is');
  assert.equal(refused.res.headers.get('Retry-After'), '60');
  assert.equal(env.RL.counts.size, 0);
});

test('limit: with only the first limiter bound, each session and each address still has a count of its own', async () => {
  const env = envWith({ roomy: null });
  await withFetch(github, async () => {
    for (const who of [SAM, KIM]) {
      const got = [];
      for (let i = 0; i < 21; i++) got.push((await call(env, 'GET', page('index.html'), from(who))).status);
      assert.deepEqual([got.slice(0, 20).filter(s => s !== 200).length, got[20]], [0, 429]);
    }
    assert.equal((await call(env, 'GET', page('index.html'), from(null))).status, 401, 'the address has its own 20 left');
    assert.equal((await call(env, 'GET', `/standing?origin=${encodeURIComponent(ORIGIN)}`, from(null))).status, 200);
  });
});

test('limit: with no limiter bound, nothing is refused for asking too often', async () => {
  const env = envWith({ rl: null, roomy: null });
  await withFetch(github, async () => {
    const got = [];
    for (let i = 0; i < 60; i++) got.push((await call(env, 'GET', page('index.html'), from(i % 2 ? SAM : null))).status);
    assert.ok(!got.includes(429));
    assert.equal(env.reads() < 60 * 6, true);
  });
});

test('limit: all three environments bind both limiters, and the guide to the settings names them', () => {
  const toml = readFileSync(new URL('../worker/wrangler.toml', import.meta.url), 'utf8');
  for (const name of ['RL', 'RL_ROOMY']) {
    assert.equal(toml.split(`name = "${name}"`).length - 1, 3, `${name} at the top level, in staging and in production`);
  }
  for (const head of ['[[unsafe.bindings]]', '[[env.staging.unsafe.bindings]]', '[[env.production.unsafe.bindings]]']) {
    assert.equal(toml.split(head).length - 1, 2, head);
  }
  const guide = readFileSync(new URL('../ENVIRONMENTS.md', import.meta.url), 'utf8');
  assert.match(guide, /^\| `RL` \|/m);
  assert.match(guide, /^\| `RL_ROOMY` \|/m);
});
