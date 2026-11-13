/**
 * The members area of a site Kiln hosts itself.
 *
 * On Cloudflare Pages a site's own functions/ folder guards its members
 * pages. A hosted site runs no program of its own, so worker/hosting.js
 * uploads the same gate with the site's files (worker/members-gate-entry.js,
 * bundled into worker/members-gate.js). These tests run the real upload over
 * an in-memory GitHub and an in-memory Cloudflare, then visit the site the way
 * a browser would, with the uploaded program run where Cloudflare would run
 * it, talking to the real service code. Nothing here touches the network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import worker from '../worker/index.js';
import { withFetch, fakeKV } from './worker-harness.js';
import { fakeGitHub } from './github-fake.js';
import { fakeCloudflare } from './cloudflare-fake.js';
import { cloudEnv, addSite, d1Skip } from './d1-fake.js';
import { deploySite, GATE_PATHS, GATE_FILE, memberSecret, membersGateOn, hasMembersArea, serviceAddress } from '../worker/hosting.js';
import { MEMBERS_GATE_MODULE } from '../worker/members-gate.js';
import { checkSite } from '../worker/sitecheck.js';
import { gateModuleText, gateFile } from '../scripts/build-members-gate.mjs';
import { onRequest as pagesDoor } from '../templates/functions/_middleware.js';
import { onRequest as pagesGate } from '../templates/functions/members/_middleware.js';
import { onRequestPost as pagesRedeem } from '../templates/functions/api/member-redeem-google.js';
import { signToken } from '../templates/functions/_kiln.js';

const SERVICE = 'https://auth.example';
const KEY = 'the-hosting-member-key-of-this-service';
const REPO = 'ada/club';
const NAME = 'club-12345678';
const ADDRESS = `https://${NAME}.kiln-sites.workers.dev`;
const ADA = { email: 'ada@example.com', name: 'Ada', role: 'member', days: 30 };
const CODE = '1'.repeat(32);
const SID = 'c'.repeat(32);
const DAY = 24 * 3600 * 1000;

const plain = { 'index.html': '<h1>Home</h1>', 'about.html': '<h1>About</h1>', '404.html': 'Not here' };
const club = { ...plain, 'members-login.html': '<h1>Sign in</h1>', 'members/index.html': '<h1>MEMBERS ONLY</h1>', 'members/report.pdf': 'PDF FOR MEMBERS' };
const ON = { HOSTING_MEMBER_KEY: KEY, HOSTING_SERVICE_URL: SERVICE };

function world(files, settings = ON, cf = fakeCloudflare()) {
  const gh = fakeGitHub({ repo: REPO, files });
  const env = { HOSTING_ACCOUNT_ID: cf.account, HOSTING_API_TOKEN: cf.token, HOSTING_SUBDOMAIN: 'kiln-sites', ...settings };
  const handler = async (url, init) => (await cf.handler(url, init)) || gh.handler(url, init);
  const deploy = (extra = {}) => withFetch(handler, () => deploySite(env, { token: 'inst-token', repo: REPO, name: NAME, first: true, siteId: 'site-1', ...extra }));
  return { gh, cf, env, deploy, up: () => cf.scripts.get(NAME) };
}
const secretOf = (id) => createHmac('sha256', KEY).update(id).digest('hex');

/** The service as the gate reaches it: Ada is a member and has just come back from Google with a one-time code. */
function service({ people = [ADA], origin = ADDRESS } = {}) {
  const kv = fakeKV({ [`people:${REPO}`]: people, [`gcode:${CODE}`]: { name: 'Ada', days: 30, repo: REPO, origin, email: ADA.email } });
  return { KILN: kv, ALLOWED_ORIGINS: origin };
}
/** Send the gate's calls to the service's real code. `state.down` makes the service unreachable. */
async function withService(serviceEnv, fn) {
  const real = globalThis.fetch;
  const state = { down: false, calls: [] };
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.startsWith(`${SERVICE}/`)) throw new Error(`a call that is not to the service: ${url}`);
    state.calls.push(url.slice(SERVICE.length));
    if (state.down) throw new Error('connect failed');
    return worker.fetch(new Request(url, init), serviceEnv);
  };
  try { return await fn(state); } finally { globalThis.fetch = real; }
}
const cookiesFrom = (res) => Object.fromEntries(res.headers.getSetCookie().map(c => c.split(';')[0].split('=')));
const jar = (cookies) => ({ Cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ') });
const ask = (path, { cookies = null, method = 'GET', body = undefined, at = ADDRESS } = {}) =>
  new Request(at + path, { method, headers: cookies ? jar(cookies) : {}, body: body === undefined ? undefined : JSON.stringify(body) });

// ── What is uploaded ────────────────────────────────────────────────────────

test('members on hosting: a site with no members area is uploaded as plain files, exactly as before, even where the members area is switched on', async () => {
  const w = world(plain);
  const out = await w.deploy();
  assert.equal(out.state, 'live');
  assert.equal('members' in out, false, 'the answer says nothing about a members area the site does not have');
  const up = w.up();
  assert.deepEqual(Object.keys(up.meta), ['compatibility_date', 'assets', 'annotations']);
  assert.deepEqual(up.meta.assets.config, { html_handling: 'auto-trailing-slash', not_found_handling: '404-page' });
  assert.deepEqual(up.parts, ['metadata'], 'no program goes with the files');
  assert.equal(up.module, null);
  assert.equal(hasMembersArea([{ path: '/members.html' }, { path: '/blog/members/x.html' }]), false, 'only the folder members/ at the top is the members area');
});

test('members on hosting: a site with pages under members/ is uploaded with the gate, the three things the gate is given, and the addresses it runs first for', async () => {
  const w = world(club);
  const out = await w.deploy();
  assert.equal(out.state, 'live');
  assert.equal(out.members, 'on');
  const up = w.up();
  assert.deepEqual(up.meta, {
    compatibility_date: '2026-06-01',
    assets: { jwt: up.meta.assets.jwt, config: { html_handling: 'auto-trailing-slash', not_found_handling: '404-page', run_worker_first: ['/members/*', '/api/member-redeem-google', '/*%*'] } },
    annotations: up.meta.annotations,
    main_module: 'members-gate.js',
    bindings: [
      { type: 'assets', name: 'ASSETS' },
      { type: 'plain_text', name: 'KILN_WORKER', text: SERVICE },
      { type: 'secret_text', name: 'KILN_MEMBER_SECRET', text: secretOf('site-1') },
    ],
  });
  assert.deepEqual(up.parts, ['metadata', GATE_FILE]);
  assert.equal(up.module, MEMBERS_GATE_MODULE, 'the program that went up is the generated gate');
  assert.deepEqual(GATE_PATHS, JSON.parse(await readFile(new URL('../templates/_routes.json', import.meta.url), 'utf8')).include,
    'the gate runs for the same addresses on Kiln\'s hosting as on Cloudflare Pages');
});

test('members on hosting: a site\'s secret is the same at every upload, and no two sites share one', async () => {
  const w = world(club);
  await w.deploy();
  const first = w.up().bindings.find(b => b.name === 'KILN_MEMBER_SECRET').text;
  await w.deploy({ first: false });
  assert.equal(w.up().deploys, 2);
  assert.equal(w.up().bindings.find(b => b.name === 'KILN_MEMBER_SECRET').text, first, 'a member stays signed in across uploads');
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(first, secretOf('site-1'), 'HMAC-SHA256 of the site\'s id with the key, in hex');
  await w.deploy({ first: false, siteId: 'site-2' });
  const other = w.up().bindings.find(b => b.name === 'KILN_MEMBER_SECRET').text;
  assert.notEqual(other, first);
  assert.equal(other, await memberSecret(w.env, 'site-2'));
  assert.notEqual(await memberSecret({ HOSTING_MEMBER_KEY: 'another-key' }, 'site-1'), first, 'another key gives other secrets');
});

test('members on hosting: without the key, or without the service\'s address, a site with members pages goes up as plain files and the answer says so', async () => {
  for (const settings of [{}, { HOSTING_MEMBER_KEY: KEY }, { HOSTING_SERVICE_URL: SERVICE }, { HOSTING_MEMBER_KEY: KEY, HOSTING_SERVICE_URL: 'http://not-https.example' }]) {
    const w = world(club, settings);
    assert.equal(membersGateOn(w.env), false);
    const out = await w.deploy();
    assert.equal(out.state, 'live');
    assert.equal(out.members, 'not_switched_on');
    assert.deepEqual(Object.keys(w.up().meta), ['compatibility_date', 'assets', 'annotations']);
    assert.deepEqual(w.up().parts, ['metadata']);
    assert.equal('run_worker_first' in w.up().meta.assets.config, false);
  }
  assert.equal(membersGateOn(ON), true);
  assert.equal(serviceAddress({ HOSTING_SERVICE_URL: `${SERVICE}/` }), SERVICE, 'a slash at the end is dropped');
});

test('members on hosting: a site that takes its members pages away goes back to plain files at the next upload', async () => {
  const w = world(club);
  await w.deploy();
  assert.equal(w.up().module, MEMBERS_GATE_MODULE);
  const later = world(plain, ON, w.cf);
  const out = await later.deploy({ first: false });
  assert.equal('members' in out, false);
  assert.equal(later.up().module, null);
  assert.deepEqual(later.up().parts, ['metadata']);
});

// ── What a visitor gets ─────────────────────────────────────────────────────

test('members on hosting: a stranger is sent to the sign-in page, and every other page is served as a plain file without the gate running', async () => {
  const w = world(club);
  await w.deploy();
  await withService(service(), async (state) => {
    for (const [path, text] of [['/', '<h1>Home</h1>'], ['/about', '<h1>About</h1>'], ['/members-login.html', '<h1>Sign in</h1>']]) {
      const res = await w.cf.visit(NAME, ask(path));
      assert.equal(res.status, 200);
      assert.equal(await res.text(), text);
    }
    assert.equal(w.up().ran || 0, 0, 'the gate did not run for a page outside the members area');

    for (const path of ['/members/', '/members/index.html', '/members/report.pdf', '/members/not-there.html']) {
      const res = await w.cf.visit(NAME, ask(path));
      assert.equal(res.status, 302, path);
      assert.equal(res.headers.get('Location'), `${ADDRESS}/members-login.html?to=${encodeURIComponent(path)}`);
      assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
      assert.equal(await res.text(), '');
    }
    assert.deepEqual(state.calls, [], 'a visitor with no cookie costs the service nothing');
  });
});

test('members on hosting: a member signs in and gets the members pages, marked never to be kept by a cache', async () => {
  const w = world(club);
  await w.deploy();
  await withService(service(), async (state) => {
    const signIn = await w.cf.visit(NAME, ask('/api/member-redeem-google', { method: 'POST', body: { code: CODE } }));
    assert.equal(signIn.status, 200);
    assert.deepEqual(await signIn.json(), { ok: true, name: 'Ada', days: 30 });
    const cookies = cookiesFrom(signIn);
    assert.deepEqual(Object.keys(cookies).sort(), ['kiln_member', 'kiln_member_ok']);
    assert.deepEqual(state.calls, ['/google/claim']);

    for (const [path, text] of [['/members/', '<h1>MEMBERS ONLY</h1>'], ['/members/report.pdf', 'PDF FOR MEMBERS']]) {
      const res = await w.cf.visit(NAME, ask(path, { cookies }));
      assert.equal(res.status, 200, path);
      assert.equal(await res.text(), text);
      assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
      assert.match(res.headers.get('Vary'), /Cookie/);
    }
    assert.deepEqual(state.calls, ['/google/claim'], 'the service has just vouched for her, so it is not asked again for a few minutes');

    // The code is good once: a second person cannot sign in with it.
    const again = await w.cf.visit(NAME, ask('/api/member-redeem-google', { method: 'POST', body: { code: CODE } }));
    assert.equal(again.status, 403);
  });
});

test('members on hosting: a cookie that was changed, or that another site signed, is refused', async () => {
  const w = world(club);
  await w.deploy();
  await withService(service(), async () => {
    const signIn = await w.cf.visit(NAME, ask('/api/member-redeem-google', { method: 'POST', body: { code: CODE } }));
    const cookies = cookiesFrom(signIn);
    const [body, sig] = decodeURIComponent(cookies.kiln_member).split('.');
    const longer = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), exp: Date.now() + 3600 * DAY })).toString('base64url');
    const elsewhere = await signToken({ n: 'Ada', exp: Date.now() + DAY, t: 'ms', s: SID }, secretOf('site-2'));
    for (const forged of [`${longer}.${sig}`, `${body}.${sig.slice(0, -2)}AA`, elsewhere, 'not-a-token', '%E0%A4%A']) {
      const res = await w.cf.visit(NAME, ask('/members/', { cookies: { ...cookies, kiln_member: encodeURIComponent(forged).replace('%25E0%25A4%25A', '%E0%A4%A') } }));
      assert.equal(res.status, 302, forged.slice(0, 20));
      assert.match(res.headers.get('Location'), /\/members-login\.html\?to=/);
    }
  });
});

test('members on hosting: a members address written with %-codes is sent to its plain form, where the gate stands, and never served', async () => {
  const w = world(club);
  await w.deploy();
  await withService(service(), async () => {
    for (const [tricky, plainPath] of [['/%6Dembers/', '/members/'], ['/%6dembers/index.html', '/members/index.html'], ['/members%2Freport.pdf', '/members/report.pdf'], ['/%4Dembers/report.pdf', '/members/report.pdf']]) {
      const res = await w.cf.visit(NAME, ask(tricky));
      assert.equal(res.status, 308, tricky);
      assert.equal(res.headers.get('Location'), ADDRESS + plainPath);
      assert.equal(await res.text(), '');
      assert.equal((await w.cf.visit(NAME, ask(plainPath))).status, 302, 'and there the gate asks for a sign-in');
    }
    assert.equal((await w.cf.visit(NAME, ask('/%E0%A4%A'))).status, 400, 'an address that does not decode is refused');
    assert.equal((await w.cf.visit(NAME, ask('/ab%6Fut'))).status, 200, 'any other address with a %-code is served as before');
  });
});

test('members on hosting: when the service cannot be reached, the last yes holds for up to an hour, and then the gate closes', async () => {
  const w = world(club);
  await w.deploy();
  const secret = secretOf('site-1');
  const now = Date.now();
  const member = encodeURIComponent(await signToken({ n: 'Ada', exp: now + 30 * DAY, t: 'ms', s: SID }, secret));
  const ok = async (fields) => encodeURIComponent(await signToken({ s: SID, t: 'mc', ...fields }, secret));
  const dueWithinTheHour = { kiln_member: member, kiln_member_ok: await ok({ c: now - 1000, exp: now + 30 * 60 * 1000 }) };
  const hourPassed = { kiln_member: member, kiln_member_ok: await ok({ c: now - 61 * 60 * 1000, exp: now - 1000 }) };

  await withService(service(), async (state) => {
    state.down = true;
    const held = await w.cf.visit(NAME, ask('/members/', { cookies: dueWithinTheHour }));
    assert.equal(held.status, 200);
    assert.equal(await held.text(), '<h1>MEMBERS ONLY</h1>');
    assert.deepEqual(state.calls, ['/members/check'], 'the service was asked, and did not answer');

    for (const cookies of [hourPassed, { kiln_member: member }]) {
      const closed = await w.cf.visit(NAME, ask('/members/', { cookies }));
      assert.equal(closed.status, 503);
      assert.equal(closed.headers.get('Retry-After'), '60');
      assert.match(await closed.text(), /cannot check your access right now\. Try again in a minute\./);
    }

    // The service is back and has no such sign-in: she is signed out.
    state.down = false;
    const gone = await w.cf.visit(NAME, ask('/members/', { cookies: dueWithinTheHour }));
    assert.equal(gone.status, 302);
    assert.deepEqual(gone.headers.getSetCookie().map(c => c.split(';')[0]), ['kiln_member=', 'kiln_member_ok=']);
  });
});

// ── One gate, two hosts ─────────────────────────────────────────────────────

test('members on hosting: the generated gate is up to date with templates/functions/ (run `npm run build` when this fails)', async () => {
  const onDisk = await readFile(new URL('../worker/members-gate.js', import.meta.url), 'utf8');
  assert.equal(onDisk, gateFile(await gateModuleText()), 'worker/members-gate.js is older than the files it is made from: run `npm run build`');
});

test('members on hosting: the gate answers every request as the Cloudflare Pages functions do', async () => {
  const program = (await import(`data:text/javascript;base64,${Buffer.from(MEMBERS_GATE_MODULE).toString('base64')}`)).default;
  const file = (request) => new Response(`FILE ${new URL(request.url).pathname}`, { headers: { 'Cache-Control': 'public, max-age=60' } });
  // Cloudflare Pages: _routes.json says where functions run at all; then the
  // front door, then the file whose folder matches the address.
  const onPages = (request, env) => pagesDoor({
    request, env,
    next: () => {
      const path = new URL(request.url).pathname;
      if (path === '/members' || path.startsWith('/members/')) return pagesGate({ request, env, next: () => file(request) });
      if (path === '/api/member-redeem-google' && request.method === 'POST') return pagesRedeem({ request, env });
      return file(request);
    },
  });
  const onHosting = (request, env) => program.fetch(request, { ...env, ASSETS: { fetch: file } });
  const routed = (path) => path.startsWith('/members/') || path === '/api/member-redeem-google' || path.includes('%');
  const through = (host) => async (request, env) => (routed(new URL(request.url).pathname) ? host(request, env) : file(request));

  async function story(send) {
    const env = { KILN_MEMBER_SECRET: secretOf('site-1'), KILN_WORKER: SERVICE };
    const seen = [];
    const note = async (what, res) => {
      seen.push({ what, status: res.status, location: res.headers.get('Location'), cache: res.headers.get('Cache-Control'), vary: res.headers.get('Vary'), retry: res.headers.get('Retry-After'),
        cookies: res.headers.getSetCookie().map(c => c.replace(/=[^;]*/, '=…')), body: await res.text() });
      return res;
    };
    await withService(service(), async (state) => {
      await note('stranger', await send(ask('/members/'), env));
      await note('stranger, a file', await send(ask('/members/report.pdf'), env));
      await note('not a token', await send(ask('/members/', { cookies: { kiln_member: 'x.y' } }), env));
      await note('%-coded', await send(ask('/%6Dembers/a%20b.html'), env));
      await note('does not decode', await send(ask('/%E0%A4%A'), env));
      await note('another %-coded page', await send(ask('/caf%C3%A9.html'), env));
      await note('a public page', await send(ask('/about'), env));
      await note('redeem, no code', await send(ask('/api/member-redeem-google', { method: 'POST', body: {} }), env));
      await note('redeem, a wrong code', await send(ask('/api/member-redeem-google', { method: 'POST', body: { code: '2'.repeat(32) } }), env));
      await note('redeem, by GET', await send(ask('/api/member-redeem-google'), env));
      await note('gate with no secret', await send(ask('/members/'), { KILN_WORKER: SERVICE }));
      await note('redeem with no secret', await send(ask('/api/member-redeem-google', { method: 'POST', body: { code: CODE } }), { KILN_WORKER: SERVICE }));
      const signIn = await send(ask('/api/member-redeem-google', { method: 'POST', body: { code: CODE } }), env);
      const cookies = cookiesFrom(signIn);
      await note('redeem', signIn);
      await note('member', await send(ask('/members/report.pdf', { cookies }), env));
      await note('member, %-coded', await send(ask('/%6Dembers/report.pdf', { cookies }), env));
      await note('member, check is due', await send(ask('/members/', { cookies: { kiln_member: cookies.kiln_member } }), env));
      const old = encodeURIComponent(await signToken({ n: 'Ada', exp: Date.now() + DAY, t: 'ms' }, env.KILN_MEMBER_SECRET));
      await note('a sign-in from before sessions', await send(ask('/members/', { cookies: { kiln_member: old } }), env));
      state.down = true;
      await note('service down, no last yes', await send(ask('/members/', { cookies: { kiln_member: cookies.kiln_member } }), env));
      await note('service down, last yes', await send(ask('/members/', { cookies }), env));
      seen.push({ what: 'calls to the service', calls: state.calls });
    });
    return seen;
  }
  const pages = await story(through(onPages));
  const hosting = await story(through(onHosting));
  assert.deepEqual(hosting, pages);
  assert.deepEqual(pages.map(s => s.status).filter(Boolean), [302, 302, 302, 308, 400, 200, 200, 400, 403, 200, 503, 503, 200, 200, 308, 200, 302, 503, 200], 'and the story is the one meant');
});

// ── The service's side: one hosted site, two addresses ──────────────────────

test('members on hosting: the service takes a member check from both addresses of a hosted site, and from no other site', { skip: d1Skip }, async () => {
  const OWN = 'https://club.org';
  const env = cloudEnv(fakeKV({ [`msess:${SID}`]: { repo: REPO, email: ADA.email, origin: ADDRESS }, [`people:${REPO}`]: [ADA] }));
  addSite(env, { origin: OWN, status: 'active' });   // its own domain is live, so that is the address on record
  env.kiln_cloud.exec('INSERT INTO hosting (site_id, name, url, state, created_at, updated_at) VALUES (?,?,?,?,?,?)', 'site-1', NAME, ADDRESS, 'live', Date.now(), Date.now());
  addSite(env, { id: 'site-2', repo: 'bob/shop', origin: 'https://shop.example', status: 'active' });
  const check = (origin, sid = SID) => worker.fetch(new Request(`${SERVICE}/members/check`, { method: 'POST', body: JSON.stringify({ sid, origin }) }), env).then(r => r.json());

  await withFetch(async (url) => { throw new Error(`no network in this test: ${url}`); }, async () => {
    assert.deepEqual(await check(ADDRESS), { ok: true }, 'the address she signed in at');
    assert.deepEqual(await check(OWN), { ok: true }, 'the same site at its own domain');
    assert.deepEqual(await check('https://shop.example'), { ok: false }, 'another site of this service');
    assert.deepEqual(await check('https://stranger.example'), { ok: false }, 'an address the service does not know');
    assert.deepEqual(await check(''), { ok: false });

    // A sign-in made at the own domain is good at the temporary address too.
    await env.KILN.put(`msess:${'d'.repeat(32)}`, JSON.stringify({ repo: REPO, email: ADA.email, origin: OWN }));
    assert.deepEqual(await check(ADDRESS, 'd'.repeat(32)), { ok: true });
    assert.deepEqual(await check('https://shop.example', 'd'.repeat(32)), { ok: false });

    // Once she is off the list, neither address lets her in.
    await env.KILN.put(`people:${REPO}`, JSON.stringify([]));
    assert.deepEqual(await check(ADDRESS), { ok: false });
    assert.deepEqual(await check(OWN), { ok: false });
  });
});

test('members on hosting: a sign-in begun at one address of a hosted site can be finished at its other address, and at no other site', { skip: d1Skip }, async () => {
  const OWN = 'https://club.org';
  const fresh = () => {
    const env = cloudEnv(fakeKV({ [`gcode:${CODE}`]: { name: 'Ada', days: 30, repo: REPO, origin: ADDRESS, email: ADA.email }, [`people:${REPO}`]: [ADA] }));
    addSite(env, { origin: OWN, status: 'active' });
    env.kiln_cloud.exec('INSERT INTO hosting (site_id, name, url, state, created_at, updated_at) VALUES (?,?,?,?,?,?)', 'site-1', NAME, ADDRESS, 'live', Date.now(), Date.now());
    addSite(env, { id: 'site-2', repo: 'bob/shop', origin: 'https://shop.example', status: 'active' });
    return env;
  };
  const claim = (env, origin) => worker.fetch(new Request(`${SERVICE}/google/claim`, { method: 'POST', body: JSON.stringify({ code: CODE, origin, session: true }) }), env);

  await withFetch(async (url) => { throw new Error(`no network in this test: ${url}`); }, async () => {
    const same = await claim(fresh(), ADDRESS);
    assert.equal(same.status, 200);
    const other = await claim(fresh(), OWN);
    assert.equal(other.status, 200);
    assert.match((await other.json()).sid, /^[a-f0-9]{32}$/);
    for (const origin of ['https://shop.example', 'https://stranger.example']) {
      const res = await claim(fresh(), origin);
      assert.equal(res.status, 403, origin);
      assert.deepEqual(await res.json(), { error: 'sign-in not valid for this site' });
    }
  });
});

// ── What the owner is told ──────────────────────────────────────────────────

test('members on hosting: "Check this site" says of a hosted site with members pages whether only members can open them', async () => {
  const look = (files, opts = {}) => {
    const gh = fakeGitHub({ repo: REPO, files });
    const handler = async (url, init) => (url.startsWith('https://api.github.com/') ? gh.handler(url, init)
      : new Response('<!doctype html><title>Home</title>', { status: 200, headers: { 'Content-Type': 'text/html' } }));
    return withFetch(handler, async (calls) => {
      const checks = await checkSite({ token: 'inst-token', repo: REPO, origin: ADDRESS, worker: SERVICE, hosted: true, ...opts });
      return { line: checks.find(c => c.id === 'members') || null, ids: checks.map(c => c.id), listings: calls.filter(c => /\/git\/trees\//.test(c.url)).length };
    });
  };
  const on = await look(club, { membersOn: true });
  assert.equal(on.line.ok, true);
  assert.equal(on.line.title, 'The members area is switched on');
  assert.equal(on.line.detail, 'This site has pages under members/. Only the people on the site\'s list of members can open them, after they sign in with Google. Kiln\'s hosting takes care of that, so there is nothing for you to set up.');
  assert.equal(on.ids.at(-1), 'members', 'it is the last line');

  const off = await look(club, { membersOn: false });
  assert.equal(off.line.ok, false);
  assert.equal(off.line.detail, 'This site has pages under members/, but the members area is not switched on for Kiln\'s hosting yet, so anyone with the address can open those pages. Write to info@kilncms.com and we will switch it on.');

  assert.equal((await look(plain, { membersOn: true })).line, null, 'a site with no members pages gets no such line');
  const onPages = await look(club, { hosted: false, membersOn: true });
  assert.equal(onPages.line, null, 'a site on another host guards its members pages itself');
  assert.equal((await look(club, { membersOn: true, down: 'Kiln took this site down.' })).line, null, 'a site that is not online serves no pages at all');
  assert.equal(on.listings, onPages.listings, 'the line costs no further request to GitHub');
});
