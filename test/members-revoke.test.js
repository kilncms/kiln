/**
 * S4 — removing a member ends a sign-in they already hold.
 *
 * Two halves, tested together with nothing stubbed between them: the site's
 * gate and redeem function (templates/functions) call the REAL worker handlers
 * through a fetch stand-in, over an in-memory KV.
 *
 * The bound: a removed member is turned away at the gate's next check, which
 * is at most RECHECK_MS (5 minutes) after the last one; if the worker cannot
 * be reached, the last "yes" stands for OUTAGE_MS (60 minutes) at most.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { onRequest, RECHECK_MS, OUTAGE_MS } from '../templates/functions/members/_middleware.js';
import { onRequestPost as redeem } from '../templates/functions/api/member-redeem-google.js';
import { signToken, verifyToken } from '../templates/functions/_kiln.js';
import { fakeKV } from './worker-harness.js';

const SITE = 'https://club.example';
const WORKER = 'https://worker.example';
const REPO = 'acme/club';
const SECRET = 'a-per-site-secret-of-reasonable-length';
const siteEnv = { KILN_MEMBER_SECRET: SECRET, KILN_WORKER: WORKER };
const ADA = { email: 'ada@example.com', name: 'Ada', role: 'member', days: 30 };

/** Worker state: Ada is a member, and has just come back from Google with a one-time code. */
function setup({ people = [ADA], days = 30 } = {}) {
  const kv = fakeKV({
    [`people:${REPO}`]: people,
    [`gcode:${'1'.repeat(32)}`]: { name: 'Ada', days, repo: REPO, origin: SITE, email: ADA.email },
  });
  return { env: { KILN: kv, ALLOWED_ORIGINS: SITE }, kv };
}

/** Route the site's calls to the worker; `down` makes the worker unreachable. Counts /members/check calls. */
async function withWorker(wenv, fn) {
  const real = globalThis.fetch;
  const state = { down: false, checks: 0, status: null };
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.startsWith(WORKER)) throw new Error(`unexpected fetch ${url}`);
    if (url.endsWith('/members/check')) state.checks++;
    if (state.down) throw new Error('connect failed');
    if (state.status) return new Response('{}', { status: state.status });
    return worker.fetch(new Request(url, init), wenv);
  };
  try { return await fn(state); } finally { globalThis.fetch = real; }
}

const cookiesFrom = (res) => Object.fromEntries(res.headers.getSetCookie().map(c => c.split(';')[0].split('=')).map(([k, v]) => [k, v]));
const jar = (cookies) => ({ Cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ') });

async function signIn(code = '1'.repeat(32)) {
  const res = await redeem({ request: new Request(`${SITE}/api/member-redeem-google`, { method: 'POST', body: JSON.stringify({ code }) }), env: siteEnv });
  return { res, cookies: cookiesFrom(res) };
}
async function visit(cookies, path = '/members/report.pdf') {
  let served = 0;
  const res = await onRequest({ request: new Request(SITE + path, { headers: jar(cookies) }), env: siteEnv, next: async () => { served++; return new Response('MEMBERS ONLY'); } });
  return { res, served, set: cookiesFrom(res) };
}
/** The same sign-in, `ms` later: the "checked just now" cookie is re-signed as if issued then. */
async function age(cookies, ms) {
  const ok = await verifyToken(decodeURIComponent(cookies.kiln_member_ok), SECRET);
  const older = await signToken({ ...ok, c: ok.c - ms, exp: ok.exp - ms }, SECRET);
  return { ...cookies, kiln_member_ok: encodeURIComponent(older) };
}
const remove = (wenv) => wenv.KILN.put(`people:${REPO}`, JSON.stringify([]));

test('S4 sign-in: the member cookie carries a session id the worker knows, and nothing is asked for the first minutes', async () => {
  const { env, kv } = setup();
  await withWorker(env, async (state) => {
    const { res, cookies } = await signIn();
    assert.equal(res.status, 200);
    const payload = await verifyToken(decodeURIComponent(cookies.kiln_member), SECRET);
    assert.match(payload.s, /^[a-f0-9]{32}$/);
    assert.deepEqual(JSON.parse(kv.map.get(`msess:${payload.s}`)), { repo: REPO, email: ADA.email, origin: SITE });
    assert.ok(cookies.kiln_member_ok, 'the first check is not due yet');
    const v = await visit(cookies);
    assert.equal(v.served, 1);
    assert.equal(state.checks, 0, 'no call to the worker inside the re-check window');
  });
});

test('S4 the bound: a member who is removed is let in until the next check, and turned away at it', async () => {
  const { env } = setup();
  await withWorker(env, async (state) => {
    const { cookies } = await signIn();
    await remove(env);
    // Inside the window the last answer still stands.
    const inside = await visit(await age(cookies, RECHECK_MS - 1000));
    assert.equal(inside.served, 1);
    assert.equal(state.checks, 0);
    // One second past it the worker is asked, says no, and the member is signed out.
    const after = await visit(await age(cookies, RECHECK_MS + 1000));
    assert.equal(after.res.status, 302);
    assert.equal(after.served, 0, 'the file is not served');
    assert.equal(state.checks, 1);
    assert.match(after.res.headers.get('Location'), /\/members-login\.html\?to=/);
    assert.deepEqual(after.set, { kiln_member: '', kiln_member_ok: '' }, 'both cookies are cleared');
    assert.equal(after.res.headers.get('Cache-Control'), 'private, no-store');
  });
});

test('S4 removal through the worker: POST /admin/people/remove ends the sign-in record, and adding the person back does not revive it', async () => {
  const { env, kv } = setup();
  await withWorker(env, async () => {
    const { cookies } = await signIn();
    const sid = (await verifyToken(decodeURIComponent(cookies.kiln_member), SECRET)).s;
    // The owner's request, with GitHub saying "push access".
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.startsWith('https://api.github.com/')) return new Response(JSON.stringify({ permissions: { push: true } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return realFetch(input, init);
    };
    const owner = (path, body) => worker.fetch(new Request(`${WORKER}${path}`, { method: 'POST', headers: { Authorization: 'Bearer gho_owner', Origin: SITE, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env);
    const removed = await owner('/admin/people/remove', { repo: REPO, email: ADA.email });
    assert.equal(removed.status, 200);
    assert.equal(kv.map.has(`msess:${sid}`), false, 'the record is gone');
    const back = await owner('/admin/people', { repo: REPO, ...ADA });
    assert.equal(back.status, 200);
    globalThis.fetch = realFetch;
    const v = await visit(await age(cookies, RECHECK_MS + 1000));
    assert.equal(v.res.status, 302, 'the old cookie stays dead; they sign in again');
    assert.equal(v.served, 0);
  });
});

test('S4 still a member: the check renews quietly and the page is served', async () => {
  const { env } = setup();
  await withWorker(env, async (state) => {
    const { cookies } = await signIn();
    const v = await visit(await age(cookies, RECHECK_MS + 1000));
    assert.equal(v.served, 1);
    assert.equal(state.checks, 1);
    const renewed = await verifyToken(decodeURIComponent(v.set.kiln_member_ok), SECRET);
    assert.ok(renewed.c > Date.now() + RECHECK_MS - 5000, 'good for another window');
    assert.equal(v.set.kiln_member, undefined, 'the sign-in cookie itself is left alone');
    // A member whose role changed to editor is no longer a member of the gated area.
    await env.KILN.put(`people:${REPO}`, JSON.stringify([{ ...ADA, role: 'editor' }]));
    assert.equal((await visit(await age(cookies, RECHECK_MS + 1000))).res.status, 302);
  });
});

test('S4 worker unreachable: the last yes stands for an hour at most, then the gate closes; it never opens for an unchecked cookie', async () => {
  const { env } = setup();
  await withWorker(env, async (state) => {
    const { cookies } = await signIn();
    for (const how of ['down', 500, 404]) {
      state.down = how === 'down'; state.status = how === 'down' ? null : how;
      const stale = await visit(await age(cookies, RECHECK_MS + 1000));
      assert.equal(stale.served, 1, `served on the last answer (${how})`);
      assert.equal(stale.set.kiln_member_ok, undefined, 'and the answer is not renewed');
      const tooOld = await visit(await age(cookies, OUTAGE_MS + 1000));
      assert.equal(tooOld.res.status, 503, `closed after the outage allowance (${how})`);
      assert.equal(tooOld.served, 0);
      assert.equal(tooOld.res.headers.get('Cache-Control'), 'private, no-store');
      // No "checked" cookie at all (cleared, or a copied sign-in cookie).
      const bare = await visit({ kiln_member: cookies.kiln_member });
      assert.equal(bare.res.status, 503);
      assert.equal(bare.served, 0);
    }
  });
});

test('S4 a sign-in from before this check (no session id) must sign in again; a checked cookie for another session does not vouch for it', async () => {
  const { env } = setup();
  await withWorker(env, async (state) => {
    const old = encodeURIComponent(await signToken({ n: 'Ada', exp: Date.now() + 3600e3, t: 'ms' }, SECRET));
    const v = await visit({ kiln_member: old });
    assert.equal(v.res.status, 302);
    assert.equal(v.served, 0);
    assert.equal(state.checks, 0);
    // Removed member borrows a current member's "checked" cookie.
    const { cookies } = await signIn();
    const other = encodeURIComponent(await signToken({ n: 'Eve', exp: Date.now() + 3600e3, t: 'ms', s: 'e'.repeat(32) }, SECRET));
    const mixed = await visit({ kiln_member: other, kiln_member_ok: cookies.kiln_member_ok });
    assert.equal(mixed.res.status, 302, 'asked about its own session, which the worker does not know');
    assert.equal(mixed.served, 0);
  });
});

test('S4 worker: /members/check answers only for the site the sign-in belongs to, and a malformed id is a 400', async () => {
  const { env } = setup();
  await withWorker(env, async () => {
    const { cookies } = await signIn();
    const sid = (await verifyToken(decodeURIComponent(cookies.kiln_member), SECRET)).s;
    const check = async (body) => { const r = await worker.fetch(new Request(`${WORKER}/members/check`, { method: 'POST', body: JSON.stringify(body) }), env); return { status: r.status, json: await r.json() }; };
    assert.deepEqual(await check({ sid, origin: SITE }), { status: 200, json: { ok: true } });
    assert.deepEqual(await check({ sid, origin: 'https://other.example' }), { status: 200, json: { ok: false } });
    assert.deepEqual(await check({ sid }), { status: 200, json: { ok: false } });
    assert.deepEqual(await check({ sid: 'f'.repeat(32), origin: SITE }), { status: 200, json: { ok: false } });
    assert.equal((await check({ sid: '../people', origin: SITE })).status, 400);
    assert.equal((await check({})).status, 400);
  });
});

test('S4 old and new together: an old site template gets no session record; an old worker makes the new redeem say what to do', async () => {
  // Old template: asks for no session, so the worker stores nothing and answers as before.
  const a = setup();
  const res = await worker.fetch(new Request(`${WORKER}/google/claim`, { method: 'POST', body: JSON.stringify({ code: '1'.repeat(32), origin: SITE }) }), a.env);
  assert.deepEqual(await res.json(), { ok: true, name: 'Ada', days: 30 });
  assert.equal([...a.kv.map.keys()].filter(k => k.startsWith('msess:')).length, 0);
  // New template against a worker that predates the session id.
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, name: 'Ada', days: 30 }), { status: 200 });
  try {
    const { res: r } = await signIn();
    assert.equal(r.status, 503);
    assert.match((await r.json()).error, /older than its members gate/);
    assert.equal(r.headers.getSetCookie().length, 0, 'no cookie that the gate would refuse');
  } finally { globalThis.fetch = real; }
});

test('S4 a "never expires" member gets a record without an expiry, and /healthz says the worker can end member sign-ins', async () => {
  const { env, kv } = setup({ days: 0 });
  await withWorker(env, async () => {
    const { cookies } = await signIn();
    const payload = await verifyToken(decodeURIComponent(cookies.kiln_member), SECRET);
    assert.equal(payload.exp, null);
    assert.ok(kv.map.has(`msess:${payload.s}`));
  });
  const health = await (await worker.fetch(new Request(`${WORKER}/healthz`), env)).json();
  assert.equal(health.ok, true);
  assert.equal(health.memberSessions, true);
});
