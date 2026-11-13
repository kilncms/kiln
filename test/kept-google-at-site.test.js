/**
 * "Continue with Google" on a site's own sign-in page, for the owner of a site
 * whose files Kiln keeps. That owner has no GitHub account, so once their
 * session has ended this button is their way back in at the site: they get
 * the same owner session "Open the editor" in the dashboard makes. Nobody
 * else gets one: not another Google person, not the owner of a different kept
 * site, and nobody at all at a site Kiln does not keep the files of. Google
 * and GitHub are stand-ins: nothing touches the network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { fakeKV, withFetch, jsonRes } from './worker-harness.js';
import { cloudEnv, addSite, d1Skip } from './d1-fake.js';

const { privateKey } = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const PK8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', privateKey)).toString('base64');

const REPO = 'kiln-sites/oak-bakery-1a2b3c4d';
const OTHER = 'kiln-sites/elm-cafe-5e6f7a8b';
const SITE = 'https://oak-bakery-1a2b3c4d.kiln-sites.workers.dev';
const OTHER_SITE = 'https://elm-cafe-5e6f7a8b.kiln-sites.workers.dev';
const ROSA = { sub: 'g-1001', email: 'rosa@example.com', name: 'Rosa Diaz' };
const OMAR = { sub: 'g-2002', email: 'omar@example.com', name: 'Omar Haddad' };
const STRANGER = { sub: 'g-9009', email: 'sam@example.com', name: 'Sam Lee' };
const DAY = 86400 * 1000;

/** Google says the person is `who`; GitHub answers only the app's installation token, and only about Rosa's repository. */
const outside = (who) => async (url, init) => {
  if (url === 'https://oauth2.googleapis.com/token') return jsonRes({ id_token: 'idt' });
  if (url.startsWith('https://oauth2.googleapis.com/tokeninfo')) return jsonRes({ aud: 'gid', sub: who.sub, email: who.email, name: who.name, email_verified: 'true' });
  const u = new URL(url);
  if (u.hostname !== 'api.github.com') return undefined;
  if (((init.headers && init.headers.Authorization) || '') !== 'Bearer inst-1') return jsonRes({ message: 'Bad credentials' }, 401);
  if (u.pathname === `/repos/${REPO}` && init.method === 'GET') return jsonRes({ id: 9001, full_name: REPO, private: true, permissions: { push: true } });
  return jsonRes({ message: 'Not Found' }, 404);
};

function person(env, token, who, id) {
  env.kiln_cloud.exec('INSERT INTO accounts (id, github_login, email, name, google_sub, created_at) VALUES (?, NULL, ?, ?, ?, 1)', id, who.email, who.name, who.sub);
  env.KILN.map.set(`csess:${token}`, JSON.stringify({ account_id: id, login: null, uid: null, gh: null, google: who }));
}

/** Rosa and Omar each signed in to the dashboard with Google and each have a site Kiln keeps. Rosa's is up on Kiln's hosting unless `hosted` is false. */
function world({ status = 'active', hosted = true } = {}) {
  const env = cloudEnv(fakeKV(), {
    CLOUD_DASHBOARD: 'https://app.example', KEEP_ORG: 'kiln-sites', GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsec',
    HOSTING_ACCOUNT_ID: 'cf-acct', HOSTING_API_TOKEN: 'cf-token', HOSTING_SUBDOMAIN: 'kiln-sites',
  });
  person(env, 'rosa', ROSA, 'acct-g');
  person(env, 'omar', OMAR, 'acct-o');
  addSite(env);   // ada/club at https://club.example, on acct-1
  addSite(env, { id: 'site-k', account_id: 'acct-g', repo: REPO, origin: SITE, plan: 'managed', status });
  addSite(env, { id: 'site-o', account_id: 'acct-o', repo: OTHER, origin: OTHER_SITE, plan: 'managed' });
  env.kiln_cloud.exec("UPDATE sites SET kept = 1 WHERE id IN ('site-k', 'site-o')");
  if (hosted) env.kiln_cloud.exec('INSERT INTO hosting (site_id, name, url, state, created_at, updated_at) VALUES (?,?,?,?,?,?)', 'site-k', 'oak-bakery-1a2b3c4d', SITE, 'live', 1, 1);
  env.KILN.map.set('app:creds', JSON.stringify({ app_id: 1, slug: 'kiln-cms', client_id: 'cid', client_secret: 'sec', pk8: PK8 }));
  env.KILN.map.set(`itok:${REPO}`, 'inst-1');
  return env;
}

let n = 0;
/**
 * `who` pressed "Continue with Google" on the sign-in page of the site at
 * `origin` (set up for `repo`), chose their account at Google and came back:
 * { status, to (where they are sent), page (what they read), calls }.
 */
async function comeBack(env, who, { origin = SITE, repo = REPO, returnTo = '/kiln' } = {}) {
  const nonce = `nonce-${++n}`;
  env.KILN.map.set(`gstate:${nonce}`, JSON.stringify({ origin, returnTo, repo }));
  return withFetch(outside(who), async (calls) => {
    const res = await worker.fetch(new Request(`https://worker.example/google/callback?code=c&state=${nonce}`, { redirect: 'manual' }), env);
    return { status: res.status, to: res.headers.get('Location') || '', page: res.status === 302 ? '' : await res.text(), calls };
  });
}
const sessions = (env, kind = 'osess:') => [...env.KILN.map.keys()].filter(k => k.startsWith(kind));
const owner = (to) => /^#kiln-owner=([a-f0-9]{64})&kiln-login=([^&]*)&kiln-exp=(\d+)$/.exec(new URL(to).hash);
const NOT_ON_THE_LIST = /You're not on the list \(yet\)/;

test('the owner of a site Kiln keeps presses Continue with Google at the site and gets the owner session the dashboard makes, back on the page they came from', { skip: d1Skip }, async () => {
  const env = world();
  const r = await comeBack(env, ROSA, { returnTo: '/menu.html' });
  assert.equal(r.status, 302);
  assert.ok(r.to.startsWith(`${SITE}/menu.html#kiln-owner=`), r.to);
  const m = owner(r.to);
  assert.ok(m, `the address carries the session the way the loader reads it: ${r.to}`);
  assert.equal(decodeURIComponent(m[2]), 'Rosa Diaz');
  const made = await env.KILN.get(`osess:${m[1]}`, 'json');
  assert.deepEqual({ ...made, created: 0 }, { v: 1, kept: true, account_id: 'acct-g', login: 'Rosa Diaz', email: 'rosa@example.com', repo: REPO, rid: 9001, origin: SITE, created: 0 });
  assert.equal(Number(m[3]), made.created + 30 * DAY, 'thirty days, as from the dashboard');
  assert.equal('token' in made, false, 'no GitHub token in it');
  assert.deepEqual(sessions(env, 'esess:'), [], 'no editor session beside it');

  // It is the session "Open the editor" in the dashboard makes: the same record, made by the same code.
  const dash = await withFetch(outside(ROSA), async () => (await worker.fetch(new Request('https://worker.example/cloud/sites/editor', {
    method: 'POST', headers: { Authorization: 'Bearer rosa', 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'site-k' }),
  }), env)).json());
  const fromDash = await env.KILN.get(`osess:${owner(dash.url)[1]}`, 'json');
  assert.deepEqual({ ...fromDash, created: 0 }, { ...made, created: 0 });
  assert.ok(dash.url.startsWith(`${SITE}/kiln#kiln-owner=`), 'the dashboard still lands on the sign-in page');

  // The site's editor is let in with it, as the owner.
  const asked = await withFetch(outside(ROSA), async () => {
    const res = await worker.fetch(new Request('https://worker.example/auth/session', { headers: { Origin: SITE, 'X-Kiln-Session': m[1] } }), env);
    return { status: res.status, json: await res.json() };
  });
  assert.equal(asked.status, 200);
  assert.equal(asked.json.kept, true);

  // GitHub was asked only with the app's installation token, never as a person.
  for (const c of r.calls.filter(c => c.url.startsWith('https://api.github.com/'))) assert.equal(c.headers.Authorization, 'Bearer inst-1', `${c.method} ${c.url}`);
});

test('another Google person, and the owner of a different kept site, get no owner session at this site: they are looked up in the list of people as before', { skip: d1Skip }, async () => {
  for (const who of [STRANGER, OMAR]) {
    const env = world();
    const r = await comeBack(env, who);
    assert.equal(r.status, 403, who.name);
    assert.match(r.page, NOT_ON_THE_LIST);
    assert.ok(r.page.includes(who.email));
    assert.deepEqual(sessions(env), [], `${who.name}: no owner session was made`);
    assert.deepEqual(sessions(env, 'esess:'), []);
  }
  // Rosa owns a kept site, but not this one: at Omar's site she is one more Google person.
  const env = world();
  env.kiln_cloud.exec('INSERT INTO hosting (site_id, name, url, state, created_at, updated_at) VALUES (?,?,?,?,?,?)', 'site-o', 'elm-cafe-5e6f7a8b', OTHER_SITE, 'live', 1, 1);
  const r = await comeBack(env, ROSA, { origin: OTHER_SITE, repo: OTHER });
  assert.equal(r.status, 403);
  assert.match(r.page, NOT_ON_THE_LIST);
  assert.deepEqual(sessions(env), []);
});

test('an owner who is also on the list of people gets the owner session, not an invited editor\'s', { skip: d1Skip }, async () => {
  const env = world();
  env.KILN.map.set(`people:${REPO}`, JSON.stringify([{ email: ROSA.email, name: 'Rosa', role: 'editor', days: 30, paths: ['blog/'] }]));
  const r = await comeBack(env, ROSA);
  assert.equal(r.status, 302);
  assert.ok(owner(r.to), r.to);
  assert.equal(sessions(env).length, 1);
  assert.deepEqual(sessions(env, 'esess:'), []);
});

test('a site Kiln does not keep the files of is as before: the Google person who owns its account gets no owner session, on the list or off it', { skip: d1Skip }, async () => {
  const env = world();
  env.kiln_cloud.exec("UPDATE sites SET kept = 0 WHERE id = 'site-k'");
  const off = await comeBack(env, ROSA);
  assert.equal(off.status, 403);
  assert.match(off.page, NOT_ON_THE_LIST);
  assert.deepEqual(sessions(env), []);

  env.KILN.map.set(`people:${REPO}`, JSON.stringify([{ email: ROSA.email, name: 'Rosa', role: 'editor', days: 30, paths: [''] }]));
  const on = await comeBack(env, ROSA);
  assert.equal(on.to.includes('kiln-owner'), false, on.to);
  assert.deepEqual(sessions(env), [], 'no owner session for a site that is not kept');
});

test('the owner is refused as the dashboard refuses, with a plain page that says what to do: editing switched off, the site not up, and an address that is not the site', { skip: d1Skip }, async () => {
  const plainPage = (r, status, title) => {
    assert.equal(r.status, status);
    assert.ok(r.page.includes(`<h1>${title}</h1>`), r.page);
    assert.ok(r.page.includes('You signed in as <strong>rosa@example.com</strong>.'));
    assert.ok(r.page.includes('href="https://app.example"'), 'the way to the dashboard');
    assert.equal(/—|–|undefined|GitHub|repository/.test(r.page), false);
  };
  let env = world({ status: 'canceled' });
  let r = await comeBack(env, ROSA);
  plainPage(r, 403, 'Editing is switched off for this site');
  assert.ok(r.page.includes("This is your site, but editing is switched off for it, so its editor cannot be opened. Open your Kiln dashboard and press Subscribe on the site's row, then sign in here again."), r.page);
  assert.deepEqual(sessions(env), []);

  env = world({ hosted: false });
  r = await comeBack(env, ROSA);
  plainPage(r, 409, 'Your site is not up at this address yet');
  assert.ok(r.page.includes("This is your site, but it is not up at this address yet. Open your Kiln dashboard, press Put it on Kiln's hosting on the site's row, then press Open the editor there."), r.page);
  assert.deepEqual(sessions(env), []);

  // A sign-in link somebody wrote by hand, naming Rosa's repository and an address that is not her site: no session goes there.
  env = world();
  r = await comeBack(env, ROSA, { origin: 'https://elsewhere.example' });
  assert.notEqual(r.status, 302);
  assert.equal(r.to, '');
  assert.deepEqual(sessions(env), []);
});
