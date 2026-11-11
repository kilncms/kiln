/**
 * Owner sessions: a site owner's GitHub sign-in stays on the worker.
 *
 * The old way handed the browser a GitHub token (#kiln-token=…), and any
 * script on the owner's site could read it and use it on every repository
 * the person can change. With keep=server the worker keeps the token in
 * osess:<id> and the site holds only the id, sent as X-Kiln-Session; every
 * call goes through the worker, for one repository, from one address.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { fakeKV, withFetch, jsonRes, call, ORIGIN, REPO } from './worker-harness.js';

const GH = 'https://api.github.com';
const ID = 'b'.repeat(64);
const RID = 42;
const HOUR = 3600 * 1000;

function env(seed = {}) {
  return {
    ALLOWED_ORIGINS: `${ORIGIN},https://npu-i-site.pages.dev,https://other.example`,
    KILN: fakeKV({
      'app:creds': { app_id: 1, slug: 'kiln-cms', client_id: 'cid', client_secret: 'sec' },
      [`rsee:${REPO}`]: { id: RID, name: REPO },
      [`itok:${REPO}`]: 'installation-token',
      ...seed,
    }),
  };
}
const ownerRec = (over = {}) => ({
  v: 1, token: 'ghu_live', token_exp: Date.now() + 8 * HOUR, refresh_token: 'ghr_live',
  login: 'rosa', uid: 7, repo: REPO, rid: RID, origin: ORIGIN, created: Date.now(), ...over,
});
const withOwner = (over, seed) => env({ [`osess:${ID}`]: ownerRec(over), ...seed });

/** GitHub as the owner's token sees it. */
function github({ push = true, user = true, tokenOk = 'ghu_live', refresh = null } = {}) {
  return async (url, init) => {
    const auth = (init.headers && (init.headers.Authorization || init.headers.authorization)) || '';
    if (url === 'https://github.com/login/oauth/access_token') {
      const body = JSON.parse(init.body);
      if (body.grant_type === 'refresh_token') return refresh ? refresh(body) : jsonRes({ error: 'bad_refresh_token' });
      return jsonRes({ access_token: 'ghu_new', expires_in: 28800, refresh_token: 'ghr_new' });
    }
    if (tokenOk && auth.startsWith('Bearer ghu_') && auth !== `Bearer ${tokenOk}`) return jsonRes({ message: 'Bad credentials' }, 401);
    if (url === `${GH}/user`) return user ? jsonRes({ login: 'rosa', id: 7 }) : jsonRes({ message: 'Bad credentials' }, 401);
    if (url === `${GH}/repos/${REPO}`) return jsonRes({ id: RID, full_name: REPO, permissions: { push } });
    if (url.startsWith(`${GH}/repos/${REPO}/`)) return jsonRes({ path: url, method: init.method }, 200, { ETag: '"abc"', Link: '<x>; rel="next"', 'X-RateLimit-Remaining': '4999' });
    if (url.startsWith(`${GH}/repos/`)) return jsonRes({ id: 99, full_name: 'other/repo', permissions: { push: true } });
  };
}

async function login(e, query) {
  const res = await worker.fetch(new Request(`https://worker.example/auth/login?${query}`, { redirect: 'manual' }), e);
  return res;
}
async function signIn(e, query, gh = github({ tokenOk: 'ghu_new' })) {
  const res = await login(e, query);
  assert.equal(res.status, 302, 'login redirects to GitHub');
  const state = new URL(res.headers.get('Location')).searchParams.get('state');
  return withFetch(gh, async (calls) => ({ res: await worker.fetch(new Request(`https://worker.example/auth/callback?code=c1&state=${state}`), e), calls }));
}
const fragment = (res) => new URLSearchParams(new URL(res.headers.get('Location')).hash.slice(1));
const sessionsIn = (e) => [...e.KILN.map.keys()].filter(k => k.startsWith('osess:'));
const owned = (e, path, opts = {}) => call(e, opts.method || 'GET', path, { session: ID, ...opts });

// ─── Signing in ─────────────────────────────────────────────────────────────

test('keep=server: the site gets an owner session, its login and when it ends, and never the GitHub token', async () => {
  const e = env();
  const { res } = await signIn(e, `origin=${encodeURIComponent(ORIGIN)}&return_to=/about&repo=${REPO}&keep=server`);
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('Location').startsWith(`${ORIGIN}/about#`));
  const f = fragment(res);
  assert.match(f.get('kiln-owner'), /^[a-f0-9]{64}$/);
  assert.equal(f.get('kiln-login'), 'rosa');
  assert.ok(Number(f.get('kiln-exp')) > Date.now() + 179 * 24 * HOUR);
  assert.equal(f.get('kiln-token'), null);
  assert.equal(f.get('kiln-sid'), null);
  assert.ok(!res.headers.get('Location').includes('ghu_new'), 'the token is nowhere in the address');
  const rec = JSON.parse(e.KILN.map.get(`osess:${f.get('kiln-owner')}`));
  assert.equal(rec.v, 1);
  assert.equal(rec.token, 'ghu_new');
  assert.equal(rec.refresh_token, 'ghr_new');
  assert.equal(rec.login, 'rosa');
  assert.equal(rec.uid, 7);
  assert.equal(rec.repo, REPO);
  assert.equal(rec.rid, RID);
  assert.equal(rec.origin, ORIGIN);
  assert.ok(rec.token_exp > Date.now() + 7 * HOUR);
  assert.equal(e.KILN.expires.get(`osess:${f.get('kiln-owner')}`) - Math.floor(Date.now() / 1000) > 179 * 86400, true);
  assert.equal([...e.KILN.map.keys()].filter(k => k.startsWith('sid:')).length, 0, 'no old-style refresh record');
});

test('without keep=server the sign-in answers the old way, exactly as before', async () => {
  const e = env();
  const { res } = await signIn(e, `origin=${encodeURIComponent(ORIGIN)}&return_to=/`);
  const f = fragment(res);
  assert.equal(f.get('kiln-token'), 'ghu_new');
  assert.match(f.get('kiln-sid'), /^[0-9a-f-]{36}$/);
  assert.ok(Number(f.get('kiln-exp')) > Date.now());
  assert.equal(f.get('kiln-owner'), null);
  assert.equal(sessionsIn(e).length, 0);
  assert.deepEqual(JSON.parse(e.KILN.map.get(`sid:${f.get('kiln-sid')}`)), { refresh_token: 'ghr_new' });
});

test('keep=server is refused for a repository the person cannot change, an address that belongs to another repository, and a repository name that is not one', async () => {
  const e = env();
  const cant = await signIn(e, `origin=${encodeURIComponent(ORIGIN)}&return_to=/&repo=${REPO}&keep=server`, github({ push: false, tokenOk: 'ghu_new' }));
  assert.equal(cant.res.status, 403);
  assert.match(await cant.res.text(), /not yours to sign in to/);
  // npu-i-site.pages.dev belongs to NPU-I/npu-i on this worker's map.
  const bound = await signIn(e, `origin=${encodeURIComponent('https://npu-i-site.pages.dev')}&return_to=/&repo=${REPO}&keep=server`);
  assert.equal(bound.res.status, 403);
  assert.equal(bound.calls.filter(c => c.url.startsWith(`${GH}/repos/`)).length, 0, 'GitHub is not even asked');
  for (const bad of ['nope', 'a/b/c', '../x', '']) {
    const res = await login(e, `origin=${encodeURIComponent(ORIGIN)}&return_to=/&repo=${encodeURIComponent(bad)}&keep=server`);
    assert.equal(res.status, 400, bad);
    assert.match(await res.text(), /which repository/);
  }
  // A state stored by hand with a bad repository is refused at the callback too.
  e.KILN.map.set('state:n1', JSON.stringify({ origin: ORIGIN, returnTo: '/', keep: 'server', repo: 'x/../y/z' }));
  await withFetch(github(), async () => {
    const res = await worker.fetch(new Request('https://worker.example/auth/callback?code=c&state=n1'), e);
    assert.equal(res.status, 400);
  });
  assert.equal(sessionsIn(e).length, 0, 'no session was made by any refusal');
});

// ─── The owner's branch of /gh/* ─────────────────────────────────────────────

test('proxy: forwards to the session repository and /user with the stored token, and passes status, body and headers through', async () => {
  const e = withOwner();
  await withFetch(github(), async (calls) => {
    const r = await owned(e, `/gh/repos/${REPO}/contents/index.html?ref=main`);
    assert.equal(r.status, 200);
    assert.equal(r.json.path, `${GH}/repos/${REPO}/contents/index.html?ref=main`);
    assert.equal(r.res.headers.get('etag'), '"abc"');
    assert.equal(r.res.headers.get('link'), '<x>; rel="next"');
    assert.equal(r.res.headers.get('x-ratelimit-remaining'), '4999');
    assert.equal(calls.at(-1).headers.Authorization, 'Bearer ghu_live');
    const put = await owned(e, `/gh/repos/${REPO.toUpperCase()}/contents/admin/secret.js`, { method: 'PUT', body: { content: 'PHNjcmlwdD4=', message: 'x' } });
    assert.equal(put.status, 200, 'no content guard, no path limits, the name compared without case');
    assert.equal(calls.at(-1).url, `${GH}/repos/${REPO}/contents/admin/secret.js`);
    assert.deepEqual(calls.at(-1).body, { content: 'PHNjcmlwdD4=', message: 'x' }, 'the body goes as it came, with no author stamp');
    const me = await owned(e, '/gh/user');
    assert.equal(me.status, 200);
    assert.equal(me.json.login, 'rosa');
    assert.ok(!calls.some(c => (c.headers.Authorization || '') === 'Bearer installation-token' && c.method !== 'GET'), 'the installation token is never used for the owner');
  });
  // GitHub's own refusal comes back as it is.
  await withFetch(async () => jsonRes({ message: 'sha mismatch' }, 409), async () => {
    const r = await owned(e, `/gh/repos/${REPO}/contents/index.html`, { method: 'PUT', body: { content: 'eA==' } });
    assert.equal(r.status, 409);
    assert.equal(r.json.message, 'sha mismatch');
  });
});

test('proxy: another repository, a path that climbs out, any /user write, and a different address are refused before GitHub is asked', async () => {
  const e = withOwner();
  await withFetch(github(), async (calls) => {
    for (const path of ['/repos/other/repo/contents/x', '/repos/acme/site-two/contents/x', '/orgs/acme/repos', '/user/repos', '/repos/acme', '/']) {
      const r = await owned(e, `/gh${path}`);
      assert.equal(r.status, 403, path);
      assert.equal(r.json.code, 'owner_scope', path);
    }
    for (const path of [`/repos/${REPO}/../../other/repo/contents/x`, `/repos/${REPO}/%2e%2e/%2e%2e/other/repo/contents/x`, `/repos/${REPO}/%2E%2E%2F%2E%2E%2Fother/repo`, `/repos/${REPO}/contents%2F..%2F..%2F..%2Fother/repo`]) {
      const r = await owned(e, `/gh${path}`);
      assert.ok([400, 403].includes(r.status), `${path}: ${r.status}`);
    }
    assert.equal((await owned(e, '/gh/user', { method: 'PATCH', body: { name: 'x' } })).status, 403);
    const away = await owned(e, `/gh/repos/${REPO}/contents/x`, { headers: { Origin: 'https://other.example' } });
    assert.equal(away.status, 403);
    assert.equal(away.json.code, 'owner_origin');
    const none = await owned(e, `/gh/repos/${REPO}/contents/x`, { headers: { Origin: '' } });
    assert.equal(none.status, 403);
    assert.equal(calls.length, 0, 'GitHub was never asked');
  });
});

test('proxy: a renamed repository is followed by its id, as editor sessions follow one; a name that is now another repository is refused', async () => {
  const e = withOwner({}, { 'rname:acme/old': { id: RID }, [`rname:${REPO}`]: { id: RID } });
  await withFetch(github(), async (calls) => {
    const r = await owned(e, '/gh/repos/acme/old/contents/index.html');
    assert.equal(r.status, 200);
    assert.equal(calls.at(-1).url, `${GH}/repos/${REPO}/contents/index.html`);
  });
  // The session's name now answers as another repository.
  const taken = withOwner({}, { [`rsee:${REPO}`]: { id: 777, name: REPO } });
  await withFetch(github(), async (calls) => {
    const r = await owned(taken, `/gh/repos/${REPO}/contents/index.html`);
    assert.equal(r.status, 401);
    assert.equal(r.json.code, 'repo_changed');
    assert.equal(calls.length, 0);
  });
});

test('proxy: an unknown or deleted session is 401, and nothing reaches GitHub', async () => {
  const e = env();
  await withFetch(github(), async (calls) => {
    assert.equal((await owned(e, `/gh/repos/${REPO}/contents/x`)).status, 401);
    assert.equal((await call(e, 'GET', `/gh/repos/${REPO}/contents/x`, { session: 'nothex' })).status, 401);
    assert.equal(calls.length, 0);
  });
});

// ─── Renewing the token ──────────────────────────────────────────────────────

test('refresh: a token about to run out is renewed on the worker and the new pair stored; the session keeps the day it ends', async () => {
  const created = Date.now() - 10 * 24 * HOUR;
  const e = withOwner({ token: 'ghu_old', token_exp: Date.now() + 60 * 1000, refresh_token: 'ghr_old', created });
  let asked = null;
  const gh = github({ tokenOk: 'ghu_fresh', refresh: (b) => { asked = b; return jsonRes({ access_token: 'ghu_fresh', expires_in: 28800, refresh_token: 'ghr_fresh' }); } });
  await withFetch(gh, async (calls) => {
    const r = await owned(e, `/gh/repos/${REPO}/contents/x`);
    assert.equal(r.status, 200);
    assert.equal(asked.refresh_token, 'ghr_old');
    assert.equal(calls.at(-1).headers.Authorization, 'Bearer ghu_fresh');
  });
  const rec = JSON.parse(e.KILN.map.get(`osess:${ID}`));
  assert.equal(rec.token, 'ghu_fresh');
  assert.equal(rec.refresh_token, 'ghr_fresh');
  assert.ok(rec.token_exp > Date.now() + 7 * HOUR);
  assert.equal(rec.created, created);
  assert.equal(e.KILN.expires.get(`osess:${ID}`), Math.floor((created + 180 * 24 * HOUR) / 1000));
});

test('refresh: when GitHub refuses the refresh, or answers 401 to the stored token, the session is ended with signin_ended', async () => {
  const e = withOwner({ token_exp: Date.now() - 1000 });
  await withFetch(github(), async (calls) => {
    const r = await owned(e, `/gh/repos/${REPO}/contents/x`);
    assert.equal(r.status, 401);
    assert.equal(r.json.code, 'signin_ended');
    assert.match(r.json.error, /Sign in again/);
    assert.equal(calls.filter(c => c.url.startsWith(GH)).length, 0);
  });
  assert.equal(e.KILN.map.has(`osess:${ID}`), false);

  const gone = withOwner({ token: 'ghu_revoked' });
  await withFetch(github(), async () => {
    const r = await owned(gone, `/gh/repos/${REPO}/contents/x`);
    assert.equal(r.status, 401);
    assert.equal(r.json.code, 'signin_ended');
  });
  assert.equal(gone.KILN.map.has(`osess:${ID}`), false);

  // The same on a worker route that proves ownership.
  const people = withOwner({ token: 'ghu_revoked' });
  await withFetch(github(), async () => {
    const r = await owned(people, `/admin/people?repo=${REPO}`);
    assert.equal(r.status, 401);
    assert.equal(r.json.code, 'signin_ended');
  });
  assert.equal(people.KILN.map.has(`osess:${ID}`), false);

  // An expired token with no refresh token has ended too.
  const noRefresh = withOwner({ token_exp: Date.now() - 1000, refresh_token: null });
  await withFetch(github(), async () => assert.equal((await owned(noRefresh, '/auth/session')).status, 401));
  assert.equal(noRefresh.KILN.map.has(`osess:${ID}`), false);
});

test('refresh: GitHub out of reach ends nothing; the next request tries again', async () => {
  const e = withOwner({ token_exp: Date.now() - 1000 });
  await withFetch(async () => new Response('down', { status: 502 }), async () => {
    const r = await owned(e, `/gh/repos/${REPO}/contents/x`);
    assert.equal(r.status, 503);
    assert.equal(r.json.code, 'github_unreachable');
  });
  assert.equal(e.KILN.map.has(`osess:${ID}`), true);
});

// ─── Routes that prove ownership ─────────────────────────────────────────────

test('ownership routes take an owner session and still take the old GitHub token', async () => {
  const routes = [
    ['GET', `/admin/people?repo=${REPO}`],
    ['GET', `/admin/api-tokens?repo=${REPO}`],
    ['GET', `/schedules?repo=${REPO}`],
    ['GET', `/comments/counts?repo=${REPO}`],
    ['GET', `/suggestions?repo=${REPO}`],
    ['POST', '/presence', { repo: REPO, path: '/', name: 'Rosa' }],
  ];
  for (const [method, path, body] of routes) {
    const e = withOwner();
    await withFetch(github(), async (calls) => {
      const r = await owned(e, path, { method, body });
      assert.equal(r.status, 200, `owner session: ${method} ${path} ${JSON.stringify(r.json)}`);
      assert.ok(calls.some(c => c.url === `${GH}/repos/${REPO}` && c.headers.Authorization === 'Bearer ghu_live'), `${path}: push checked with the session's token`);
    });
    const old = env();
    await withFetch(github(), async () => {
      const r = await call(old, method, path, { session: null, body, headers: { Authorization: 'Bearer ghu_live' } });
      assert.equal(r.status, 200, `old token: ${method} ${path}`);
    });
  }
  const presence = withOwner();
  await withFetch(github(), async () => {
    const r = await owned(presence, '/presence', { method: 'POST', body: { repo: REPO, path: '/', name: 'Rosa' } });
    assert.equal(r.json.scope, null, 'an owner, not an editor');
  });
});

test('ownership routes: an owner session is for its own repository only, even where its token could change another', async () => {
  const e = withOwner();
  await withFetch(github(), async (calls) => {
    for (const path of ['/admin/people?repo=other/repo', '/comments/counts?repo=other/repo', '/schedules?repo=other/repo']) {
      const r = await owned(e, path);
      assert.ok([401, 403].includes(r.status), `${path}: ${r.status}`);
    }
    const p = await owned(e, '/presence', { method: 'POST', body: { repo: 'other/repo', path: '/', name: 'x' } });
    assert.equal(p.status, 403);
    assert.equal(calls.filter(c => c.url.includes('other/repo')).length, 0);
  });
  // Nor from another address.
  await withFetch(github(), async () => {
    const r = await owned(e, `/admin/people?repo=${REPO}`, { headers: { Origin: 'https://other.example' } });
    assert.equal(r.status, 403);
    assert.equal(r.json.code, 'owner_origin');
  });
});

// ─── Who am I, signing out, the handshake ────────────────────────────────────

test('/auth/session answers who the owner is; /auth/logout ends the session and says ok either way; /healthz says ownerSessions', async () => {
  const created = Date.now() - HOUR;
  const e = withOwner({ created });
  const s = await owned(e, '/auth/session');
  assert.equal(s.status, 200);
  assert.deepEqual(s.json, { ok: true, role: 'owner', login: 'rosa', repo: REPO, exp: created + 180 * 24 * HOUR });
  assert.ok(!JSON.stringify(s.json).includes('ghu_'), 'no token in the answer');
  assert.equal((await owned(e, '/auth/session', { headers: { Origin: 'https://other.example' } })).status, 403);
  const out = await owned(e, '/auth/logout', { method: 'POST' });
  assert.deepEqual(out.json, { ok: true });
  assert.equal(e.KILN.map.has(`osess:${ID}`), false);
  assert.deepEqual((await owned(e, '/auth/logout', { method: 'POST' })).json, { ok: true });
  const after = await owned(e, '/auth/session');
  assert.equal(after.status, 401);
  assert.equal(after.json.code, 'signin_ended');
  const h = await call(env(), 'GET', '/healthz', { session: null });
  assert.equal(h.json.ownerSessions, true);
});

test('the old /auth/logout {sid} still removes the old refresh record', async () => {
  const e = env({ 'sid:old-1': { refresh_token: 'r' } });
  const r = await call(e, 'POST', '/auth/logout', { session: null, body: { sid: 'old-1' } });
  assert.deepEqual(r.json, { ok: true });
  assert.equal(e.KILN.map.has('sid:old-1'), false);
});

// ─── Moving owners who are signed in the old way ─────────────────────────────

test('adopt: a working token becomes an owner session, its refresh token moves over and the old record is gone', async () => {
  const e = env({ 'sid:old-1': { refresh_token: 'ghr_kept' } });
  await withFetch(github(), async () => {
    const r = await call(e, 'POST', '/auth/adopt', { session: null, body: { token: 'ghu_live', sid: 'old-1', repo: REPO } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.ok, true);
    assert.match(r.json.session, /^[a-f0-9]{64}$/);
    assert.equal(r.json.login, 'rosa');
    assert.ok(r.json.exp > Date.now() + 179 * 24 * HOUR);
    const rec = JSON.parse(e.KILN.map.get(`osess:${r.json.session}`));
    assert.equal(rec.token, 'ghu_live');
    assert.equal(rec.refresh_token, 'ghr_kept');
    assert.equal(rec.repo, REPO);
    assert.equal(rec.rid, RID);
    assert.equal(rec.origin, ORIGIN);
    assert.equal(e.KILN.map.has('sid:old-1'), false);
  });
  // Without a sid it still works, and keeps the token until GitHub stops taking it.
  const bare = env();
  await withFetch(github(), async () => {
    const r = await call(bare, 'POST', '/auth/adopt', { session: null, body: { token: 'ghu_live', repo: REPO } });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(bare.KILN.map.get(`osess:${r.json.session}`)).token_exp, null);
  });
});

test('adopt: a token GitHub refuses, a repository without push, an address not allowed or bound elsewhere, and a malformed request are refused, and nothing is made', async () => {
  const cases = [
    [{ body: { token: 'ghu_bad', sid: 'old-1', repo: REPO } }, 401],
    [{ body: { token: 'ghu_live', sid: 'old-1', repo: REPO }, gh: github({ push: false }) }, 403],
    [{ body: { token: 'ghu_live', sid: 'old-1', repo: REPO }, headers: { Origin: 'https://evil.example' } }, 403],
    [{ body: { token: 'ghu_live', sid: 'old-1', repo: REPO }, headers: { Origin: 'https://npu-i-site.pages.dev' } }, 403],
    [{ body: { token: 'ghu_live', sid: 'old-1', repo: '../x' } }, 400],
    [{ body: { sid: 'old-1', repo: REPO } }, 400],
    [{ body: 'not json' }, 400],
  ];
  for (const [c, status] of cases) {
    const e = env({ 'sid:old-1': { refresh_token: 'ghr_kept' } });
    await withFetch(c.gh || github(), async () => {
      const r = await call(e, 'POST', '/auth/adopt', { session: null, body: c.body, headers: c.headers || {} });
      assert.equal(r.status, status, JSON.stringify(c));
    });
    assert.equal(sessionsIn(e).length, 0, JSON.stringify(c));
    assert.equal(e.KILN.map.has('sid:old-1'), true, 'the old record is left as it was');
  }
});

test('an adopted session with a refresh token renews its token on first use', async () => {
  const e = env({ 'sid:old-1': { refresh_token: 'ghr_kept' } });
  let session;
  await withFetch(github(), async () => {
    session = (await call(e, 'POST', '/auth/adopt', { session: null, body: { token: 'ghu_live', sid: 'old-1', repo: REPO } })).json.session;
  });
  await withFetch(github({ tokenOk: 'ghu_next', refresh: () => jsonRes({ access_token: 'ghu_next', expires_in: 28800, refresh_token: 'ghr_next' }) }), async (calls) => {
    const r = await call(e, 'GET', `/gh/repos/${REPO}/contents/x`, { session });
    assert.equal(r.status, 200);
    assert.equal(calls.at(-1).headers.Authorization, 'Bearer ghu_next');
  });
});

// ─── Owner and editor sessions stay apart ────────────────────────────────────

test('an invited editor session never reaches the owner branch, and an owner session id is no editor session', async () => {
  const EDITOR = 'c'.repeat(64);
  const e = env({
    [`esess:${EDITOR}`]: { repo: REPO, name: 'Sam', role: 'editor', email: 'sam@example.com', paths: ['blog'], keys: [], features: null, mode: null },
    [`osess:${ID}`]: ownerRec(),
  });
  await withFetch(github(), async (calls) => {
    // The editor's session: still the editor proxy, still scoped to its paths.
    const out = await call(e, 'PUT', `/gh/repos/${REPO}/contents/index.html`, { session: EDITOR, body: { content: 'eA==', message: 'x' } });
    assert.equal(out.status, 403);
    assert.match(out.json.error, /outside your editing scope/);
    assert.equal((await call(e, 'GET', '/gh/user', { session: EDITOR })).status, 403, '/user is not on the editor allowlist');
    assert.equal((await call(e, 'GET', '/auth/session', { session: EDITOR })).status, 401);
    assert.ok(!calls.some(c => c.headers.Authorization === 'Bearer ghu_live'));
  });
  // The owner id is looked up as an owner session only: with the owner record
  // gone, it is nobody's session, even on routes editors use.
  e.KILN.map.delete(`osess:${ID}`);
  await withFetch(github(), async (calls) => {
    assert.equal((await owned(e, `/gh/repos/${REPO}/contents/x`)).status, 401);
    assert.equal((await owned(e, `/comments/counts?repo=${REPO}`)).status, 401);
    assert.equal((await owned(e, '/presence', { method: 'POST', body: { repo: REPO, path: '/', name: 'x' } })).status, 403);
    assert.equal(calls.length, 0);
  });
});
