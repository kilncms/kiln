/**
 * An account without GitHub, and signing in to the dashboard with Google
 * (part A of "Kiln keeps the files"). A person with no GitHub account presses
 * "Sign in with Google" on the dashboard: /cloud/login/google sends them to
 * Google, Google sends them back to the one address it already has for this
 * service (/google/callback, which a site's editors and members use too), and
 * the state kept for the sign-in says it is for the dashboard. They get an
 * account of their own, found again by Google's id for them and never joined
 * to anybody else's, and a dashboard session with no GitHub person behind it.
 * Until Kiln can keep a site's files for them (part B), such an account can
 * add and reach no repository at all. Nothing here touches the network: the
 * real handlers run over a SQLite-backed D1 stand-in and a stand-in Google.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import worker from '../worker/index.js';
import { isCloudAdmin, commitAuthor, accountAuthor, signedInAs } from '../worker/cloud.js';
import { accountAddress, addressSql } from '../worker/mail.js';
import { googleTrouble, forDashboard, troubleBody, STALE_SIGN_IN, UNCONFIRMED_GOOGLE, DASHBOARD_SIGN_IN_STOPPED, ACCOUNT_NOT_READY, NO_GOOGLE_SIGN_IN } from '../worker/signin-trouble.js';
import { fakeKV, withFetch, jsonRes, ORIGIN, REPO } from './worker-harness.js';
import { cloudEnv, addSite, fakeD1, schemaFiles, d1Skip } from './d1-fake.js';

const DASH = 'https://app.example';
const BACK = '<a href="https://app.example/">Back to the Kiln dashboard</a>';
const ROSA = { sub: 'g-1001', email: 'rosa@example.com', name: 'Rosa Diaz' };
const cloud = (extra = {}) => cloudEnv(fakeKV(), { CLOUD_DASHBOARD: DASH, GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsecret', ...extra });
/** Google: the code is good, and the person is `who` (with `over` laid on what Google says about them). */
const google = (who = ROSA, over = {}) => async (url) => {
  if (url === 'https://oauth2.googleapis.com/token') return jsonRes({ id_token: 'idt' });
  if (url.startsWith('https://oauth2.googleapis.com/tokeninfo')) return jsonRes({ aud: 'gid', sub: who.sub, email: who.email, name: who.name, email_verified: 'true', ...over });
};
/** The cookie the browser that started a dashboard sign-in holds for it (worker/signin-trouble.js). */
const cookieFor = (state) => `__Host-kiln_signin=${state}`;
const get = (env, p, token, cookie) => worker.fetch(new Request(`https://worker.example${p}`, { redirect: 'manual', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(cookie ? { Cookie: cookie } : {}) } }), env);
const post = (env, p, body, token) => worker.fetch(new Request(`https://worker.example${p}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env);
const sessions = (env) => [...env.KILN.map.keys()].filter(k => k.startsWith('csess:') && k !== 'csess:tok');
const page = async (res) => ({ status: res.status, body: (await res.text()).replace(/<style[\s\S]*?<\/style>/g, '') });
const plain = (t, label) => {
  assert.equal(/[{}]|OAuth|JSON|<pre|undefined|null\b/.test(t), false, `${label}: nothing a developer wrote: ${t}`);
  assert.equal(/—/.test(t), false, `${label}: no em dash`);
};
/** Presses "Sign in with Google" and comes back from Google as `who`. Answers the callback's response and the state that was kept. */
async function signIn(env, who = ROSA, over = {}) {
  const start = await get(env, '/cloud/login/google');
  assert.equal(start.status, 302);
  const state = new URL(start.headers.get('Location')).searchParams.get('state');
  const res = await withFetch(google(who, over), () => get(env, `/google/callback?code=c&state=${state}`, null, cookieFor(state)));
  return { res, state, start };
}
const tokenOf = (res) => (res.headers.get('Location').match(/#kc_token=([0-9a-f-]{36})$/) || [])[1];

test('migration 0008: every account and site is kept as it was, a login may now be empty, and a login or a Google id still belongs to one account', { skip: d1Skip }, () => {
  const d1 = fakeD1({ upTo: 7 });
  d1.exec("INSERT INTO accounts (id, github_login, email, ls_customer_id, created_at) VALUES ('a1', 'ada', 'ada@example.com', 'cus_9', 11)");
  d1.exec("INSERT INTO accounts (id, github_login, email, ls_customer_id, created_at) VALUES ('a2', 'Grace-H', NULL, NULL, 22)");
  d1.exec("INSERT INTO sites (id, account_id, repo, origin, plan, status, created_at) VALUES ('s1', 'a1', 'ada/club', 'https://club.example', 'managed', 'active', 33)");
  assert.throws(() => d1.exec("INSERT INTO accounts (id, github_login, created_at) VALUES ('a3', NULL, 1)"), /NOT NULL/, 'before: a login is required');
  const siteBefore = { ...d1.row("SELECT * FROM sites WHERE id = 's1'") };
  const file = schemaFiles().find(f => path.basename(f) === '0008_accounts_without_github.sql');
  d1.db.exec(readFileSync(file, 'utf8'));

  assert.deepEqual(d1.db.prepare('SELECT * FROM accounts ORDER BY id').all().map(r => ({ ...r })), [
    { id: 'a1', github_login: 'ada', email: 'ada@example.com', ls_customer_id: 'cus_9', created_at: 11, google_sub: null, name: null },
    { id: 'a2', github_login: 'Grace-H', email: null, ls_customer_id: null, created_at: 22, google_sub: null, name: null },
  ]);
  assert.deepEqual({ ...d1.row("SELECT * FROM sites WHERE id = 's1'") }, { ...siteBefore, kept: null, name: null }, 'the site is untouched, and is not one Kiln keeps');
  assert.equal(d1.row("SELECT COUNT(*) n FROM sqlite_master WHERE name = 'accounts_new'").n, 0, 'nothing is left over');
  // two accounts with no login, each with its own Google id
  d1.exec("INSERT INTO accounts (id, github_login, email, name, google_sub, created_at) VALUES ('g1', NULL, 'rosa@example.com', 'Rosa', 'g-1', 1)");
  d1.exec("INSERT INTO accounts (id, github_login, email, name, google_sub, created_at) VALUES ('g2', NULL, 'rosa@example.com', 'Rosa', 'g-2', 1)");
  assert.throws(() => d1.exec("INSERT INTO accounts (id, github_login, created_at) VALUES ('a4', 'ada', 1)"), /UNIQUE/, 'a login is still one account');
  assert.throws(() => d1.exec("INSERT INTO accounts (id, google_sub, created_at) VALUES ('g3', 'g-1', 1)"), /UNIQUE/, 'a Google id is one account');
  assert.throws(() => d1.exec("INSERT INTO accounts (id, github_login) VALUES ('a5', 'eve')"), /NOT NULL/, 'the other columns keep their rules');
});

test('Google sign-in to the dashboard: the first one makes an account and a session and returns to the dashboard as a GitHub sign-in does', { skip: d1Skip }, async () => {
  const env = cloud();
  const start = await get(env, '/cloud/login/google');
  assert.equal(start.status, 302);
  const to = new URL(start.headers.get('Location'));
  assert.equal(to.origin + to.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(to.searchParams.get('client_id'), 'gid');
  assert.equal(to.searchParams.get('redirect_uri'), 'https://worker.example/google/callback', 'the address Google already has: no new one');
  assert.equal(to.searchParams.get('scope'), 'openid email profile');
  const state = to.searchParams.get('state');
  assert.deepEqual(JSON.parse(env.KILN.map.get(`gstate:${state}`)), { for: 'dashboard', dash: DASH });
  assert.ok(env.KILN.expires.get(`gstate:${state}`) - Date.now() / 1000 <= 600, 'the state is good for ten minutes');

  await withFetch(google(), async (calls) => {
    const res = await get(env, `/google/callback?code=c&state=${state}`, null, cookieFor(state));
    assert.equal(res.status, 302);
    assert.match(res.headers.get('Location'), /^https:\/\/app\.example\/?#kc_token=[0-9a-f-]{36}$/);
    const sid = tokenOf(res);
    const account = { ...env.kiln_cloud.row("SELECT * FROM accounts WHERE google_sub = 'g-1001'") };
    assert.match(account.id, /^[0-9a-f-]{36}$/);
    assert.deepEqual({ ...account, id: 'x', created_at: 0 }, { id: 'x', github_login: null, email: 'rosa@example.com', ls_customer_id: null, created_at: 0, google_sub: 'g-1001', name: 'Rosa Diaz', google_email: 'rosa@example.com' });
    assert.deepEqual(JSON.parse(env.KILN.map.get(`csess:${sid}`)), { account_id: account.id, login: null, uid: null, gh: null, google: { sub: 'g-1001', email: 'rosa@example.com', name: 'Rosa Diaz' } });
    const life = env.KILN.expires.get(`csess:${sid}`) - Date.now() / 1000;
    assert.ok(life > 30 * 86400 - 60 && life <= 30 * 86400, 'the session lasts 30 days');
    assert.equal(env.KILN.map.has(`gstate:${state}`), false, 'the state works once');
    const exchange = calls.find(c => c.url === 'https://oauth2.googleapis.com/token');
    assert.equal(new URLSearchParams(String(exchange.body)).get('redirect_uri'), 'https://worker.example/google/callback');
    assert.equal(calls.every(c => c.url.startsWith('https://oauth2.googleapis.com/')), true, 'only Google was asked');

    // the same state a second time: nobody is signed in
    const again = await page(await get(env, `/google/callback?code=c&state=${state}`, null, cookieFor(state)));
    assert.equal(again.status, 400);
    assert.match(again.body, /<h1>That sign-in is no longer good<\/h1>/);
    assert.equal(sessions(env).length, 1);
  });
});

test('Google sign-in to the dashboard: a second one finds the same account, whatever Google now says the address is', { skip: d1Skip }, async () => {
  const env = cloud();
  const first = await signIn(env);
  const second = await signIn(env, { ...ROSA, email: 'rosa.diaz@example.org', name: 'Rosa D.' });
  const a = JSON.parse(env.KILN.map.get(`csess:${tokenOf(first.res)}`)), b = JSON.parse(env.KILN.map.get(`csess:${tokenOf(second.res)}`));
  assert.notEqual(tokenOf(first.res), tokenOf(second.res));
  assert.equal(a.account_id, b.account_id);
  assert.equal(env.kiln_cloud.row('SELECT COUNT(*) n FROM accounts').n, 2, 'the harness account and this one');
  assert.equal(env.kiln_cloud.row("SELECT email FROM accounts WHERE google_sub = 'g-1001'").email, 'rosa@example.com', 'the address on the account is the owner\'s to change, not Google\'s');
});

test('Google sign-in to the dashboard: an account that signed in with GitHub is never found or changed, even with the same address', { skip: d1Skip }, async () => {
  const env = cloud();
  const before = { ...env.kiln_cloud.row("SELECT * FROM accounts WHERE id = 'acct-1'") };
  const { res } = await signIn(env, { sub: 'g-2002', email: 'ada@example.com', name: 'ada' });
  const sess = JSON.parse(env.KILN.map.get(`csess:${tokenOf(res)}`));
  assert.notEqual(sess.account_id, 'acct-1');
  assert.deepEqual({ ...env.kiln_cloud.row("SELECT * FROM accounts WHERE id = 'acct-1'") }, before);
  assert.equal(env.kiln_cloud.row("SELECT COUNT(*) n FROM accounts WHERE email = 'ada@example.com'").n, 2, 'two accounts, not one joined by its address');
});

test('Google sign-in to the dashboard: an address Google has not confirmed is refused, with a plain page and the way back to the dashboard', { skip: d1Skip }, async () => {
  for (const over of [{ email_verified: 'false' }, { email_verified: undefined }, { aud: 'somebody-else' }, { sub: '' }, { email: 'not an address' }]) {
    const env = cloud();
    const { res } = await signIn(env, ROSA, over);
    const out = await page(res);
    assert.equal(out.status, 403, JSON.stringify(over));
    assert.match(out.body, /<h1>Google could not confirm your account<\/h1>/);
    assert.match(out.body, /Then go back to the Kiln dashboard and sign in again\.<\/p>/);
    assert.ok(out.body.includes(BACK));
    plain(out.body, 'unconfirmed');
    assert.equal(sessions(env).length, 0, 'nobody was signed in');
    assert.equal(env.kiln_cloud.row('SELECT COUNT(*) n FROM accounts').n, 1, 'no account was made');
  }
});

test('Google sign-in to the dashboard: every other way it can stop is a plain page with the way back to the dashboard', { skip: d1Skip }, async () => {
  // Google refuses the code
  let env = cloud();
  let state = new URL((await get(env, '/cloud/login/google')).headers.get('Location')).searchParams.get('state');
  let out = await withFetch(async (url) => (url === 'https://oauth2.googleapis.com/token' ? jsonRes({ error: 'invalid_grant', error_description: 'Bad Request' }, 400) : undefined),
    async () => page(await get(env, `/google/callback?code=c&state=${state}`, null, cookieFor(state))));
  assert.equal(out.status, 400);
  assert.match(out.body, /<h1>That sign-in was already used, or it took too long<\/h1>/);
  assert.match(out.body, /Go back to the Kiln dashboard and sign in again\.<\/p>/);
  assert.ok(out.body.includes(BACK));
  assert.equal(sessions(env).length, 0);

  // the person pressed Cancel at Google: they come back with the state and no code
  env = cloud();
  state = new URL((await get(env, '/cloud/login/google')).headers.get('Location')).searchParams.get('state');
  out = await page(await get(env, `/google/callback?error=access_denied&state=${state}`, null, cookieFor(state)));
  assert.equal(out.status, 400);
  assert.match(out.body, /<h1>The sign-in did not finish<\/h1><p>Google sent you back without signing you in\. Nothing is wrong with your account\. Go back to the Kiln dashboard and sign in again\.<\/p>/);
  assert.ok(out.body.includes(BACK));
  assert.equal(env.KILN.map.has(`gstate:${state}`), false);

  // this service has no Google sign-in
  env = cloud({ GOOGLE_CLIENT_SECRET: '' });
  out = await page(await get(env, '/cloud/login/google'));
  assert.equal(out.status, 503);
  assert.match(out.body, /<h1>Google sign-in is not set up here yet<\/h1>/);
  assert.match(out.body, /Go back to the Kiln dashboard and sign in with GitHub, or write to info@kilncms\.com\.<\/p>/);
  assert.ok(out.body.includes(BACK));
  assert.equal([...env.KILN.map.keys()].some(k => k.startsWith('gstate:')), false, 'nothing was kept');

  // the database has not had migration 0008: the person is told, and nothing is half made
  env = cloud({ d1: { upTo: 7 } });
  out = await page((await signIn(env)).res);
  assert.equal(out.status, 503);
  assert.match(out.body, /<h1>Kiln could not open your account just now<\/h1>/);
  assert.ok(out.body.includes(BACK));
  assert.equal(sessions(env).length, 0);

  // every page a person signing in to the dashboard can be shown: plain, and never "the site"
  const all = [googleTrouble({ status: 429 }), googleTrouble({ status: 400, tok: { error: 'invalid_grant' } }), googleTrouble({ status: 401, tok: { error: 'invalid_client' } }), googleTrouble({ status: 503 }),
    googleTrouble({ status: 400, tok: { error: 'something_new' } }), STALE_SIGN_IN, UNCONFIRMED_GOOGLE, DASHBOARD_SIGN_IN_STOPPED, ACCOUNT_NOT_READY, NO_GOOGLE_SIGN_IN].map(forDashboard);
  for (const t of all) {
    plain(t.heading + t.words, t.code);
    assert.equal(/\b(the|this) site\b/.test(t.words), false, `${t.code}: ${t.words}`);
    assert.match(t.words, /\.$/);
    assert.ok(troubleBody(t, { dashboard: DASH }).endsWith(`<p>${BACK}</p>`));
  }
  assert.equal(troubleBody(STALE_SIGN_IN, { dashboard: 'javascript:alert(1)' }), troubleBody(STALE_SIGN_IN), 'only a real web address is linked');
});

test('Google sign-in to a site: a state kept for a site\'s editor still goes the editor\'s way, and makes no dashboard account', { skip: d1Skip }, async () => {
  const env = cloud();
  env.KILN.map.set('gstate:n1', JSON.stringify({ origin: ORIGIN, returnTo: '/', repo: REPO }));
  const out = await withFetch(google(ROSA, { email_verified: 'false' }), async () => page(await get(env, '/google/callback?code=c&state=n1')));
  assert.equal(out.status, 403);
  assert.match(out.body, /<h1>Google could not confirm your account<\/h1>/);
  assert.match(out.body, /Then go back to the site and sign in again\.<\/p>/);
  assert.ok(out.body.includes(`<a href="${ORIGIN}/kiln">Back to the sign-in page</a>`));
  // and a confirmed person who is on no list is told so by the site's own page, with no dashboard session or account
  env.KILN.map.set('gstate:n2', JSON.stringify({ origin: ORIGIN, returnTo: '/', repo: REPO, for: undefined }));
  const res = await withFetch(google(), async () => get(env, '/google/callback?code=c&state=n2'));
  assert.notEqual(res.status, 302);
  assert.equal(String(res.headers.get('Location') || '').includes('kc_token'), false);
  assert.equal(sessions(env).length, 0);
  assert.equal(env.kiln_cloud.row('SELECT COUNT(*) n FROM accounts').n, 1);
  // a callback with nothing at all is still the same page as before
  assert.match((await page(await get(env, '/google/callback?state=x'))).body, /<h1>This is not a whole sign-in<\/h1>/);
});

test('/cloud/me: a Google account says who it is and that it has no GitHub login, and a GitHub account reads as before with the two new answers', { skip: d1Skip }, async () => {
  const env = cloud();
  const sid = tokenOf((await signIn(env)).res);
  const mine = await (await get(env, '/cloud/me', sid)).json();
  const id = JSON.parse(env.KILN.map.get(`csess:${sid}`)).account_id;
  assert.deepEqual(mine.account, { id, github_login: null, email: 'rosa@example.com', ls_customer_id: null, name: 'Rosa Diaz', google: true });
  assert.deepEqual(mine.sites, []);
  assert.equal(JSON.stringify(mine).includes('g-1001'), false, 'Google\'s id for the person stays in the service');

  addSite(env);
  const ada = await (await get(env, '/cloud/me', 'tok')).json();
  assert.deepEqual(ada.account, { id: 'acct-1', github_login: 'ada', email: 'ada@example.com', ls_customer_id: null, name: null, google: false });
  assert.equal(ada.sites.length, 1);

  // a database migration 0008 has not reached: a GitHub account still reads
  const old = cloud({ d1: { upTo: 7 } });
  const before = await (await get(old, '/cloud/me', 'tok')).json();
  assert.deepEqual(before.account, { id: 'acct-1', github_login: 'ada', email: 'ada@example.com', ls_customer_id: null, name: null, google: false });
});

test('a Google account cannot add a repository, reach one, or be the operator', { skip: d1Skip }, async () => {
  const env = cloud({ CLOUD_ADMIN: 'rosa@example.com', CLOUD_ADMIN_ID: '' });
  const sid = tokenOf((await signIn(env)).res);
  const sess = JSON.parse(env.KILN.map.get(`csess:${sid}`));
  addSite(env);                                                                         // somebody else's
  addSite(env, { id: 'site-2', account_id: sess.account_id, repo: 'rosa/shop', origin: 'https://shop.example' });   // a row on this very account, however it got there
  await withFetch(async () => jsonRes({ permissions: { push: true } }), async (calls) => {
    let res = await post(env, '/cloud/sites', { repo: 'rosa/shop', origin: 'https://rosa.example' }, sid);
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: 'Adding a repository of your own needs a GitHub sign-in. Sign out, then sign in with GitHub.', code: 'needs_github' });
    assert.equal(env.kiln_cloud.row('SELECT COUNT(*) n FROM sites').n, 2, 'no site was added');

    for (const site of ['site-1', 'site-2', 'no-such-site']) {
      for (const ask of [() => get(env, `/cloud/sites/prepare?site=${site}`, sid), () => post(env, '/cloud/sites/prepare', { id: site }, sid), () => get(env, `/cloud/sites/firstpass?site=${site}`, sid)]) {
        res = await ask();
        assert.equal(res.status, 403, site);
        assert.deepEqual(await res.json(), { error: 'This site is in a GitHub repository, and you are signed in with Google. Sign out, then sign in with GitHub.', code: 'needs_github' });
      }
    }
    assert.equal((await get(env, '/admin/cloud/overview', sid)).status, 403, 'the operator\'s pages stay shut');
    assert.equal(calls.length, 0, 'GitHub was never asked about anything');
  });
  assert.equal(isCloudAdmin(sess, env), false);
  assert.equal(isCloudAdmin(sess, { CLOUD_ADMIN: 'rosa@example.com' }), false);
  assert.equal(isCloudAdmin({ ...sess, uid: 4242 }, { CLOUD_ADMIN_ID: '4242' }), false, 'whatever else the session says');
});

test('whose name a change from the dashboard carries: a GitHub person exactly as before, a Google person by name "(via Kiln)" with the address Google confirmed', { skip: d1Skip }, async () => {
  const env = cloud();
  assert.deepEqual(await commitAuthor(env, { account_id: 'acct-1', login: 'ada', uid: 7, gh: 'gho_x' }), { name: 'ada', email: '7+ada@users.noreply.github.com' });
  assert.deepEqual(await commitAuthor(env, { account_id: 'acct-1', login: 'ada', gh: 'gho_x' }), { name: 'ada', email: 'ada@users.noreply.github.com' });
  assert.equal(signedInAs({ account_id: 'acct-1', login: 'ada' }), 'ada');

  const sid = tokenOf((await signIn(env)).res);
  const sess = JSON.parse(env.KILN.map.get(`csess:${sid}`));
  assert.deepEqual(await commitAuthor(env, sess), { name: 'Rosa Diaz (via Kiln)', email: 'rosa@example.com' });
  assert.equal(signedInAs(sess), 'rosa@example.com', 'a note to the operator names the address');
  // the owner types another address for notices: nobody confirmed it, so it is not taken, and they read what to do
  const typed = await post(env, '/cloud/account', { email: 'shop@example.org' }, sid);
  assert.deepEqual([typed.status, await typed.json()], [403, { error: 'Kiln writes to the address you signed in with. To use another address, sign in with that Google account.', code: 'google_address' }]);
  assert.equal((await post(env, '/cloud/account', { email: '' }, sid)).status, 403);
  assert.equal(env.kiln_cloud.row("SELECT email FROM accounts WHERE google_sub = 'g-1001'").email, 'rosa@example.com', 'nothing was stored');
  assert.deepEqual(await commitAuthor(env, sess), { name: 'Rosa Diaz (via Kiln)', email: 'rosa@example.com' });
  // Google gave no name: the part of the address before the @
  assert.deepEqual(await commitAuthor(env, { ...sess, google: { ...sess.google, name: null } }), { name: 'rosa (via Kiln)', email: 'rosa@example.com' });
});

test('a GitHub sign-in to the dashboard is exactly as before: the same session, the same account row', { skip: d1Skip }, async () => {
  const env = cloud();
  env.KILN.map.set('app:creds', JSON.stringify({ app_id: 1, slug: 'kiln-cms', client_id: 'cid', client_secret: 'sec' }));
  env.KILN.map.set('cstate:s1', '1');
  await withFetch(async (url) => {
    if (url === 'https://github.com/login/oauth/access_token') return jsonRes({ access_token: 'ghu_new' });
    if (url === 'https://api.github.com/user') return jsonRes({ login: 'rosa', id: 7, email: 'rosa@example.com' });
  }, async () => {
    const res = await get(env, '/cloud/callback?code=c1&state=s1', null, cookieFor('s1'));
    assert.equal(res.status, 302);
    const sid = tokenOf(res);
    const row = { ...env.kiln_cloud.row("SELECT * FROM accounts WHERE github_login = 'rosa'") };
    assert.deepEqual(JSON.parse(env.KILN.map.get(`csess:${sid}`)), { account_id: row.id, login: 'rosa', uid: 7, gh: 'ghu_new' });
    assert.deepEqual({ ...row, id: 'x', created_at: 0 }, { id: 'x', github_login: 'rosa', email: 'rosa@example.com', ls_customer_id: null, created_at: 0, google_sub: null, name: null, google_email: null });
    // the same person then signs in with Google at the same address: a second account, and the first is as it was
    const g = tokenOf((await signIn(env)).res);
    assert.notEqual(JSON.parse(env.KILN.map.get(`csess:${g}`)).account_id, row.id);
    assert.deepEqual({ ...env.kiln_cloud.row("SELECT * FROM accounts WHERE github_login = 'rosa'") }, row);
  });
});

// ─── The address Kiln writes to (security review 0.6.7, L5) ──────────────────

test('an account that signed in with Google is written to at the address Google confirmed at its last sign-in, and at no other', { skip: d1Skip }, async () => {
  const env = cloud();
  const sid = tokenOf((await signIn(env)).res);
  const id = env.kiln_cloud.row("SELECT id FROM accounts WHERE google_sub = 'g-1001'").id;
  assert.equal(await accountAddress(env, id), 'rosa@example.com');
  // an address that was typed for the account before, which nobody confirmed, is used for nothing
  env.kiln_cloud.exec("UPDATE accounts SET email = 'stranger@example.org' WHERE id = ?", id);
  assert.equal(await accountAddress(env, id), 'rosa@example.com');
  const sess = JSON.parse(env.KILN.map.get(`csess:${sid}`));
  assert.deepEqual(await commitAuthor(env, sess), { name: 'Rosa Diaz (via Kiln)', email: 'rosa@example.com' });
  assert.deepEqual(await accountAuthor(env, id), { name: 'Rosa Diaz (via Kiln)', email: 'rosa@example.com' });
  const me = await (await withFetch(google(), () => get(env, '/cloud/me', sid))).json();
  assert.equal(me.account.email, 'rosa@example.com', 'the dashboard shows the address Kiln writes to');
  // a query that joins accounts for a mail reads the same address, and a GitHub account's own
  addSite(env, { id: 'site-a' });
  addSite(env, { id: 'site-g', account_id: id, repo: 'kiln-sites/oak', origin: 'https://oak.example' });
  const joined = await env.kiln_cloud.prepare(`SELECT s.id, ${await addressSql(env)} FROM sites s JOIN accounts a ON a.id = s.account_id ORDER BY s.id`).all();
  assert.deepEqual(joined.results.map(r => ({ ...r })), [{ id: 'site-a', email: 'ada@example.com' }, { id: 'site-g', email: 'rosa@example.com' }]);
  // Rosa's address at Google changes and she signs in again: the new one is written down, and what was typed stays unused
  assert.match(tokenOf((await signIn(env, ROSA, { email: 'Rosa.Diaz@Example.net' })).res), /^[0-9a-f-]{36}$/);
  assert.deepEqual({ ...env.kiln_cloud.row('SELECT email, google_email FROM accounts WHERE id = ?', id) }, { email: 'stranger@example.org', google_email: 'rosa.diaz@example.net' });
  assert.equal(await accountAddress(env, id), 'rosa.diaz@example.net');
  // a Google account with no confirmed address written down has no address at all
  env.kiln_cloud.exec('UPDATE accounts SET google_email = NULL WHERE id = ?', id);
  assert.equal(await accountAddress(env, id), null);
  assert.deepEqual(await accountAuthor(env, id), { name: 'Rosa Diaz (via Kiln)', email: null });
  // an account that signed in with GitHub is as before: the address it gives is stored and used
  assert.equal(await accountAddress(env, 'acct-1'), 'ada@example.com');
  const res = await post(env, '/cloud/account', { email: 'ada@club.example' }, 'tok');
  assert.deepEqual([res.status, await res.json()], [200, { ok: true, email: 'ada@club.example' }]);
  assert.equal(await accountAddress(env, 'acct-1'), 'ada@club.example');
});

test('a database the confirmed address has not reached: a Google account has no address Kiln may use, a GitHub account is as before, and signing in still works', { skip: d1Skip }, async () => {
  const eight = cloud({ d1: { upTo: 8 } });
  eight.kiln_cloud.exec("INSERT INTO accounts (id, github_login, email, name, google_sub, created_at) VALUES ('g1', NULL, 'typed@example.org', 'Rosa Diaz', 'g-1001', 1)");
  assert.equal(await addressSql(eight), 'CASE WHEN a.google_sub IS NOT NULL THEN NULL ELSE a.email END AS email');
  assert.equal(await accountAddress(eight, 'g1'), null);
  assert.equal(await accountAddress(eight, 'acct-1'), 'ada@example.com');
  const sid = tokenOf((await signIn(eight)).res);
  assert.equal(JSON.parse(eight.KILN.map.get(`csess:${sid}`)).account_id, 'g1');
  // on what they publish, the address Google confirmed for this session
  assert.deepEqual(await commitAuthor(eight, JSON.parse(eight.KILN.map.get(`csess:${sid}`))), { name: 'Rosa Diaz (via Kiln)', email: 'rosa@example.com' });
  const seven = cloud({ d1: { upTo: 7 } });
  assert.equal(await addressSql(seven), 'a.email AS email');
  assert.equal(await accountAddress(seven, 'acct-1'), 'ada@example.com');
});

// ─── A dashboard sign-in belongs to the browser that started it ──────────────

const ELSEWHERE = 'Kiln could not tell that this sign-in was started in this browser, so nobody was signed in. Nothing is wrong with your account. Go back to the Kiln dashboard and sign in again. If it keeps happening, check that this browser accepts cookies from Kiln.';
const withGitHub = () => { const env = cloud(); env.KILN.map.set('app:creds', JSON.stringify({ app_id: 1, slug: 'kiln-cms', client_id: 'cid', client_secret: 'sec' })); return env; };
const gitHub = async (url) => {
  if (url === 'https://github.com/login/oauth/access_token') return jsonRes({ access_token: 'ghu_new' });
  if (url === 'https://api.github.com/user') return jsonRes({ login: 'rosa', id: 7, email: 'rosa@example.com' });
};
const stateOf = (start) => new URL(start.headers.get('Location')).searchParams.get('state');

test('pressing Sign in, with GitHub or with Google, leaves a cookie that holds the sign-in\'s state for ten minutes; in local development over plain http it is not marked Secure', { skip: d1Skip }, async () => {
  const env = withGitHub();
  for (const p of ['/cloud/login/google', '/cloud/login']) {
    const start = await get(env, p);
    assert.equal(start.status, 302, p);
    assert.equal(start.headers.get('Set-Cookie'), `__Host-kiln_signin=${stateOf(start)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`, p);
  }
  for (const host of ['localhost:8787', '127.0.0.1:8787']) {
    for (const p of ['/cloud/login/google', '/cloud/login']) {
      const start = await worker.fetch(new Request(`http://${host}${p}`, { redirect: 'manual' }), env);
      assert.equal(start.headers.get('Set-Cookie'), `kiln_signin=${stateOf(start)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`, `${host}${p}`);
    }
  }
});

test('a Google sign-in to the dashboard that comes back in another browser signs nobody in: Google is not asked, no session is made, and the page says what to do', { skip: d1Skip }, async () => {
  const others = [() => undefined, () => cookieFor('another-sign-in'), (state) => `kiln_signin=${state}`, (state) => `other=1; __Host-kiln_signin=${state}x`];
  for (const cookie of others) {
    const env = cloud();
    const state = stateOf(await get(env, '/cloud/login/google'));
    const out = await withFetch(google(), async (calls) => ({ ...(await page(await get(env, `/google/callback?code=c&state=${state}`, null, cookie(state)))), asked: calls.length }));
    assert.equal(out.status, 400);
    assert.match(out.body, /<h1>The sign-in did not finish<\/h1>/);
    assert.ok(out.body.includes(ELSEWHERE), out.body);
    assert.ok(out.body.includes('https://app.example'), 'the way back to the dashboard');
    plain(out.body.replace(/<[^>]+>/g, ' '), 'started elsewhere');
    assert.equal(out.asked, 0, 'Google was not asked who the person is');
    assert.deepEqual(sessions(env), [], 'nobody is signed in');
    assert.equal(env.KILN.map.has(`gstate:${state}`), false, 'the state works once');
  }
});

test('a GitHub sign-in to the dashboard that comes back in another browser signs nobody in, and in the browser that started it it finishes and the cookie is taken away', { skip: d1Skip }, async () => {
  const env = withGitHub();
  let state = stateOf(await get(env, '/cloud/login'));
  const out = await withFetch(gitHub, async (calls) => ({ ...(await page(await get(env, `/cloud/callback?code=c1&state=${state}`))), asked: calls.length }));
  assert.equal(out.status, 400);
  assert.match(out.body, /<h1>The sign-in did not finish<\/h1>/);
  assert.ok(out.body.includes(ELSEWHERE), out.body);
  assert.ok(out.body.includes('https://app.example'), 'the way back to the dashboard');
  assert.equal(out.asked, 0, 'GitHub was not asked who the person is');
  assert.deepEqual(sessions(env), [], 'nobody is signed in');
  assert.equal(env.KILN.map.has(`cstate:${state}`), false, 'the state works once');

  const start = await get(env, '/cloud/login');
  state = stateOf(start);
  const res = await withFetch(gitHub, () => get(env, `/cloud/callback?code=c1&state=${state}`, null, start.headers.get('Set-Cookie').split(';')[0]));
  assert.equal(res.status, 302);
  assert.ok(tokenOf(res), 'signed in');
  assert.equal(res.headers.get('Set-Cookie'), '__Host-kiln_signin=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');
  assert.equal(sessions(env).length, 1);
});

test('the browser that started a Google sign-in finishes it with the cookie it was given, in local development over plain http too, and the cookie is then taken away', { skip: d1Skip }, async () => {
  for (const base of ['https://worker.example', 'http://localhost:8787', 'http://127.0.0.1:8787']) {
    const env = cloud();
    const at = (p, cookie) => worker.fetch(new Request(`${base}${p}`, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} }), env);
    const start = await at('/cloud/login/google');
    const res = await withFetch(google(), () => at(`/google/callback?code=c&state=${stateOf(start)}`, start.headers.get('Set-Cookie').split(';')[0]));
    assert.equal(res.status, 302, base);
    assert.ok(tokenOf(res), base);
    assert.equal(res.headers.get('Set-Cookie'), base.startsWith('https:') ? '__Host-kiln_signin=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0' : 'kiln_signin=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0', base);
    assert.equal(sessions(env).length, 1, base);
  }
});
