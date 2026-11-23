/**
 * Sign-in by email to the Kiln dashboard (worker/index.js "Email sign-in"
 * with for=dashboard, cloud.js emailDashboardSignIn), and at a site for the
 * owner of a site whose files Kiln keeps (cloud.js keptOwnerAtSite). These
 * drive the real handlers with the real SQL (node:sqlite), KV and mail in
 * memory, and check that:
 *
 *   - an account is found only by an address Kiln confirmed: the one an email
 *     sign-in made it with, or the one Google confirmed; never by the address
 *     GitHub reported
 *   - an address no account has makes a new account with no GitHub login
 *   - a Google sign-in after an email one, for the same address, is the same account
 *   - two accounts with the same confirmed address sign nobody in
 *   - the link and the code work once, for 15 minutes, the code only in its window
 *   - links asked for one address are limited, as at a site
 *   - the session is the one a Google owner gets, with `byEmail` for `google`
 *   - an owner who signed in by email is recognised at their kept site
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { googleDashboardSignIn, commitAuthor } from '../worker/cloud.js';
import { fakeKV, withFetch, jsonRes } from './worker-harness.js';
import { cloudEnv, addSite, d1Skip } from './d1-fake.js';

const DASH = 'https://app.example';
const EVE = 'eve@example.com';
const FOR = { for: 'dashboard' };

function world(extra = {}) {
  const sent = [];
  const env = cloudEnv(fakeKV(), { CLOUD_DASHBOARD: DASH, CUSTOMER_MAIL_FROM: 'hello@kilncms.com', NOTIFY: { send: async (m) => { sent.push(m); return { messageId: `m${sent.length}` }; } }, ...extra });
  return { env, sent, d1: env.kiln_cloud };
}

async function hit(w, method, path, form, fetcher = async () => undefined) {
  const init = { method, redirect: 'manual' };
  if (form) init.body = new URLSearchParams(form);
  return withFetch(fetcher, async () => {
    const res = await worker.fetch(new Request(`https://worker.example${path}`, init), w.env);
    return { status: res.status, to: res.headers.get('Location') || '', page: res.status === 302 ? '' : await res.text() };
  });
}

/** Asks for a link from the dashboard's page (or a site's, with `place`): the page, the window's id, and the link and code that were sent. */
async function ask(w, email, place = FOR, fetcher) {
  const before = w.sent.length;
  const r = await hit(w, 'POST', '/email/login', { ...place, email }, fetcher);
  const req = (r.page.match(/name="req" value="([a-f0-9]{64})"/) || [])[1] || null;
  const mail = w.sent.length > before ? w.sent[w.sent.length - 1] : null;
  const token = mail ? (mail.text.match(/https:\/\/worker\.example\/email\/open\?t=([a-f0-9]{64})/) || [])[1] : null;
  const code = mail ? (mail.text.match(/asked for the link: (\d{6})/) || [])[1] : null;
  return { ...r, req, mail, token, code };
}
const session = (w, to) => { const sid = (/#kc_token=([\w-]+)$/.exec(to) || [])[1]; return sid ? JSON.parse(w.env.KILN.map.get(`csess:${sid}`)) : null; };
const accounts = (w) => w.d1.db.prepare('SELECT id, github_login, email, google_sub, google_email, signin_email FROM accounts ORDER BY created_at, id').all();

test('the dashboard\'s email sign-in: the page asks for any address, sends the link and the code with the dashboard\'s words, and a new address makes an account with no GitHub login', { skip: d1Skip }, async () => {
  const w = world();
  const page = await hit(w, 'GET', '/email/login?for=dashboard');
  assert.equal(page.status, 200);
  assert.match(page.page, /Type your email address\. We will send it a link to sign in to your Kiln dashboard, and a code you can type here instead\. There is no password\. If you are new to Kiln, signing in this way makes your account\./);
  assert.match(page.page, /<input type="hidden" name="for" value="dashboard">/);
  assert.match(page.page, new RegExp(`href="${DASH}/?">Back to the Kiln dashboard`));

  const a = await ask(w, ' Eve@Example.com ');
  assert.equal(a.status, 200);
  assert.match(a.page, /A link to sign in to your Kiln dashboard is on its way to Eve@Example\.com\. The link works once, for 15 minutes\./);
  assert.match(a.page, /check that you typed the address the way you meant to\./);
  assert.equal(a.mail.to, EVE);
  assert.equal(a.mail.subject, 'Your sign-in link for Kiln');
  assert.match(a.mail.text, /To sign in to your Kiln dashboard, open this link and press Sign in:/);
  assert.match(a.mail.text, /&for=dashboard/);
  assert.match(a.mail.text, /someone asked for a sign-in link for the Kiln dashboard with this email address\./);
  assert.ok(a.token && a.code && a.req);
  assert.equal(accounts(w).length, 1, 'asking makes nothing yet');

  // Opening the link (a GET, as a mail scanner does) uses nothing up.
  const open = await hit(w, 'GET', `/email/open?t=${a.token}&for=dashboard`);
  assert.match(open.page, /<h1>Sign in to your Kiln dashboard<\/h1>/);
  assert.match(open.page, /This link signs in eve@example\.com\. Press Sign in to go on\./);
  const done = await hit(w, 'POST', '/email/open', { t: a.token, for: 'dashboard' });
  assert.equal(done.status, 302);
  assert.match(done.to, /^https:\/\/app\.example\/?#kc_token=/);
  const made = accounts(w).find(r => r.signin_email === EVE);
  assert.deepEqual({ ...made, id: 'x' }, { id: 'x', github_login: null, email: EVE, google_sub: null, google_email: null, signin_email: EVE });
  const sess = session(w, done.to);
  assert.deepEqual(sess, { account_id: made.id, login: null, uid: null, gh: null, byEmail: { email: EVE, name: null } });
  assert.equal('google' in sess, false);

  // The same kind of session a Google owner gets: /cloud/me, the address Kiln writes to, the author of a change.
  const sid = /#kc_token=([\w-]+)$/.exec(done.to)[1];
  const me = await (await worker.fetch(new Request('https://worker.example/cloud/me', { headers: { Authorization: `Bearer ${sid}` } }), w.env)).json();
  assert.deepEqual(me.account, { id: made.id, github_login: null, email: EVE, name: null, google: false, by_email: true });
  assert.deepEqual(await commitAuthor(w.env, sess), { name: 'eve (via Kiln)', email: EVE });
  const typed = await worker.fetch(new Request('https://worker.example/cloud/account', { method: 'POST', headers: { Authorization: `Bearer ${sid}` }, body: JSON.stringify({ email: 'other@example.com' }) }), w.env);
  assert.equal(typed.status, 403, 'an address nobody confirmed is never written on the account');
  assert.equal((await typed.json()).error, 'Kiln writes to the address you signed in with. To use another address, sign in with a link sent to that address.');
  const add = await worker.fetch(new Request('https://worker.example/cloud/sites', { method: 'POST', headers: { Authorization: `Bearer ${sid}` }, body: JSON.stringify({ repo: 'eve/site', origin: 'https://eve.example' }) }), w.env);
  assert.equal((await add.json()).code, 'needs_github', 'no GitHub account, so no repository of its own');

  // Used once: the link and the code from the same email are both gone.
  const again = await hit(w, 'POST', '/email/open', { t: a.token, for: 'dashboard' });
  assert.equal(again.status, 410);
  assert.match(again.page, /To get a new one, go back to the Kiln dashboard and press Get a sign-in link by email\./);
  const code = await hit(w, 'POST', '/email/code', { ...FOR, req: a.req, code: a.code });
  assert.equal(code.status, 410);

  // A second sign-in with the same address finds the same account.
  const b = await ask(w, EVE);
  const second = await hit(w, 'POST', '/email/code', { ...FOR, req: b.req, code: b.code });
  assert.equal(session(w, second.to).account_id, made.id);
  assert.equal(accounts(w).length, 2);
});

test('the dashboard\'s email sign-in never finds an account by the address GitHub reported, only by one Google or an email sign-in confirmed', { skip: d1Skip }, async () => {
  const w = world();
  // acct-1 signed in with GitHub, which reported ada@example.com. A Google account confirmed rosa@example.com.
  w.d1.exec("INSERT INTO accounts (id, github_login, email, name, google_sub, google_email, created_at) VALUES ('acct-g', NULL, 'typed@example.com', 'Rosa Diaz', 'g-1001', 'rosa@example.com', 2)");
  const ada = await ask(w, 'ada@example.com');
  const inAda = await hit(w, 'POST', '/email/open', { t: ada.token });
  const sAda = session(w, inAda.to);
  assert.notEqual(sAda.account_id, 'acct-1', 'the GitHub account is never reached by its address');
  assert.equal(accounts(w).find(r => r.id === sAda.account_id).signin_email, 'ada@example.com', 'a new account is made instead');
  assert.equal(w.d1.row("SELECT email FROM accounts WHERE id = 'acct-1'").email, 'ada@example.com', 'and the GitHub account is not changed');

  // The address typed on the Google account is no proof either.
  const typed = await ask(w, 'typed@example.com');
  const inTyped = await hit(w, 'POST', '/email/open', { t: typed.token });
  assert.notEqual(session(w, inTyped.to).account_id, 'acct-g');

  // The address Google confirmed is: the email sign-in reaches the Google account, and leaves it a Google account.
  const rosa = await ask(w, 'ROSA@example.com');
  const inRosa = await hit(w, 'POST', '/email/code', { ...FOR, req: rosa.req, code: rosa.code });
  const sRosa = session(w, inRosa.to);
  assert.equal(sRosa.account_id, 'acct-g');
  assert.deepEqual(sRosa.byEmail, { email: 'rosa@example.com', name: 'Rosa Diaz' });
  assert.equal(w.d1.row("SELECT signin_email FROM accounts WHERE id = 'acct-g'").signin_email, null);
  assert.equal(accounts(w).length, 4);
});

test('a Google sign-in for the address an email sign-in made an account with is the same account; two accounts with one confirmed address sign nobody in', { skip: d1Skip }, async () => {
  const w = world();
  const a = await ask(w, EVE);
  const first = session(w, (await hit(w, 'POST', '/email/open', { t: a.token })).to);
  const google = (sub) => googleDashboardSignIn(w.env, { for: 'dashboard', dash: DASH }, { identity: async () => ({ info: { sub, email: EVE, email_verified: 'true', name: 'Eve Park' } }) });
  const g = await google('g-7');
  const viaGoogle = session(w, g.headers.get('Location'));
  assert.equal(viaGoogle.account_id, first.account_id, 'one account for the person');
  assert.deepEqual({ ...w.d1.row("SELECT google_sub, google_email, signin_email, name FROM accounts WHERE id = ?", first.account_id) }, { google_sub: 'g-7', google_email: EVE, signin_email: EVE, name: 'Eve Park' });

  // Another Google person whose address is also Eve's (Google moved the address to them) gets their own account,
  // and from then on an email sign-in for the address cannot tell whose it is: nobody is signed in.
  const other = session(w, (await google('g-8')).headers.get('Location'));
  assert.notEqual(other.account_id, first.account_id);
  const b = await ask(w, EVE);
  const refused = await hit(w, 'POST', '/email/open', { t: b.token });
  assert.equal(refused.status, 409);
  assert.match(refused.page, /More than one Kiln account has this address/);
  assert.match(refused.page, /Back to the Kiln dashboard/);
  assert.equal([...w.env.KILN.map.keys()].filter(k => k.startsWith('csess:')).length, 4, 'no new session: tok, and the three above');
});

test('the dashboard\'s link and code run out after 15 minutes, the code works only in the window that asked, and five wrong codes void both', { skip: d1Skip }, async () => {
  const w = world();
  const a = await ask(w, EVE);
  const linkKey = [...w.env.KILN.map.keys()].find(k => k.startsWith('elink:'));
  const rec = JSON.parse(w.env.KILN.map.get(linkKey));
  w.env.KILN.map.set(linkKey, JSON.stringify({ ...rec, exp: Date.now() - 1 }));
  assert.equal((await hit(w, 'GET', `/email/open?t=${a.token}&for=dashboard`)).status, 410);
  assert.equal((await hit(w, 'POST', '/email/open', { t: a.token, for: 'dashboard' })).status, 410);

  const b = await ask(w, EVE);
  const codeKey = [...w.env.KILN.map.keys()].find(k => k.startsWith('ecode:') && JSON.parse(w.env.KILN.map.get(k)).link);
  w.env.KILN.map.set(codeKey, JSON.stringify({ ...JSON.parse(w.env.KILN.map.get(codeKey)), exp: Date.now() - 1 }));
  assert.equal((await hit(w, 'POST', '/email/code', { ...FOR, req: b.req, code: b.code })).status, 410);

  // The right code from another window (another window id) does nothing, and neither does a site's page.
  const c = await ask(w, EVE);
  const d = await ask(w, 'dan@example.com');
  assert.equal((await hit(w, 'POST', '/email/code', { ...FOR, req: d.req, code: c.code })).status, 400);
  assert.equal((await hit(w, 'POST', '/email/code', { origin: 'https://app.example', return_to: '/', repo: 'ada/club', req: c.req, code: c.code })).status !== 302, true);
  const ok = await hit(w, 'POST', '/email/code', { ...FOR, req: c.req, code: c.code });
  assert.equal(ok.status, 302);
  assert.equal(accounts(w).filter(r => r.signin_email).length, 1, 'only Eve signed in, so only her account was made');

  const e = await ask(w, 'fay@example.com');
  for (let i = 0; i < 4; i++) assert.equal((await hit(w, 'POST', '/email/code', { ...FOR, req: e.req, code: e.code === '000000' ? '111111' : '000000' })).status, 400);
  const fifth = await hit(w, 'POST', '/email/code', { ...FOR, req: e.req, code: e.code === '000000' ? '111111' : '000000' });
  assert.equal(fifth.status, 403);
  assert.equal((await hit(w, 'POST', '/email/open', { t: e.token })).status, 410, 'the link in the same email is void too');
});

test('the dashboard\'s email sign-in: three links for one address in 15 minutes, whatever its case and spaces; a worker with no mail says so and sends nothing', { skip: d1Skip }, async () => {
  const w = world();
  for (const typed of [EVE, ' EVE@example.com', 'Eve@Example.Com ']) assert.equal((await ask(w, typed)).status, 200);
  const fourth = await ask(w, 'eve@EXAMPLE.com');
  assert.equal(fourth.status, 429);
  assert.match(fourth.page, /Sign-in links for this address were asked for 3 times in the last 15 minutes/);
  assert.match(fourth.page, /Back to the Kiln dashboard/);
  assert.equal(w.sent.length, 3);

  const quiet = world({ NOTIFY: undefined });
  const off = await hit(quiet, 'GET', '/email/login?for=dashboard');
  assert.equal(off.status, 503);
  assert.match(off.page, /Go back to the Kiln dashboard and use Continue with Google or Continue with GitHub\./);
  assert.equal((await ask(quiet, EVE)).status, 503);
  assert.equal(quiet.sent.length, 0);
  const health = await (await worker.fetch(new Request('https://worker.example/healthz'), w.env)).json();
  assert.equal(health.emailSignIn, true);
  assert.equal((await (await worker.fetch(new Request('https://worker.example/healthz'), quiet.env)).json()).emailSignIn, false);
});

// ─── At the site: the owner of a site whose files Kiln keeps ─────────────────

const { privateKey } = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const PK8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', privateKey)).toString('base64');
const REPO = 'kiln-sites/oak-bakery-1a2b3c4d';
const SITE = 'https://oak-bakery-1a2b3c4d.kiln-sites.workers.dev';
const AT_SITE = { origin: SITE, return_to: '/kiln', repo: REPO };
const github = async (url, init) => {
  const u = new URL(url);
  if (u.hostname !== 'api.github.com') return undefined;
  if (((init.headers && init.headers.Authorization) || '') !== 'Bearer inst-1') return jsonRes({ message: 'Bad credentials' }, 401);
  if (u.pathname === `/repos/${REPO}` && init.method === 'GET') return jsonRes({ id: 9001, full_name: REPO, private: true, permissions: { push: true } });
  return jsonRes({ message: 'Not Found' }, 404);
};

/** Eve started on Kiln by email and owns the kept site; Kiln writes to and hosts it. `owner` sets how her account knows her address. */
function keptWorld(owner = { signin_email: EVE }) {
  const w = world({ KEEP_ORG: 'kiln-sites', HOSTING_ACCOUNT_ID: 'cf-acct', HOSTING_API_TOKEN: 'cf-token', HOSTING_SUBDOMAIN: 'kiln-sites' });
  w.d1.exec('INSERT INTO accounts (id, github_login, email, google_sub, google_email, signin_email, created_at) VALUES (?, NULL, ?, ?, ?, ?, 2)',
    'acct-e', EVE, owner.google_sub || null, owner.google_email || null, owner.signin_email || null);
  addSite(w.env, { id: 'site-k', account_id: 'acct-e', repo: REPO, origin: SITE, plan: 'managed' });
  w.d1.exec("UPDATE sites SET kept = 1 WHERE id = 'site-k'");
  w.d1.exec('INSERT INTO hosting (site_id, name, url, state, created_at, updated_at) VALUES (?,?,?,?,?,?)', 'site-k', 'oak-bakery-1a2b3c4d', SITE, 'live', 1, 1);
  w.env.KILN.map.set('app:creds', JSON.stringify({ app_id: 1, slug: 'kiln-cms', client_id: 'cid', client_secret: 'sec', pk8: PK8 }));
  w.env.KILN.map.set(`itok:${REPO}`, 'inst-1');
  return w;
}

test('at the site: the owner of a site Kiln keeps who signed up by email gets a link, and opening it gives the owner session the dashboard makes', { skip: d1Skip }, async () => {
  for (const owner of [{ signin_email: EVE }, { google_sub: 'g-5', google_email: EVE }]) {
    const w = keptWorld(owner);
    const a = await ask(w, EVE, AT_SITE, github);
    assert.equal(a.status, 200);
    assert.ok(a.token, `a link is sent to the owner, who is not on the site's list (${JSON.stringify(owner)})`);
    const done = await hit(w, 'POST', '/email/open', { t: a.token }, github);
    assert.equal(done.status, 302, done.page);
    assert.ok(done.to.startsWith(`${SITE}/kiln#kiln-owner=`), done.to);
    const sid = /#kiln-owner=([a-f0-9]{64})/.exec(done.to)[1];
    const made = JSON.parse(w.env.KILN.map.get(`osess:${sid}`));
    assert.equal(made.account_id, 'acct-e');
    assert.equal(made.email, EVE);
    assert.equal(made.kept, true);
  }
});

test('at the site: nobody else gets an owner session by email, not an address GitHub reported, not the owner of another site, and not an address two accounts share', { skip: d1Skip }, async () => {
  // The owner's account knows the address only as GitHub's or typed: no proof, so no link and no session.
  const typed = keptWorld({});
  const a = await ask(typed, EVE, AT_SITE, github);
  assert.equal(a.status, 200);
  assert.equal(a.mail, null, 'the same page, and nothing sent');
  assert.match(a.page, /If eve@example\.com can sign in to oak-bakery-1a2b3c4d\.kiln-sites\.workers\.dev, a link is on its way to it\./);

  // Another address: the same page, nothing sent.
  const w = keptWorld();
  assert.equal((await ask(w, 'sam@example.com', AT_SITE, github)).mail, null);

  // Two accounts with the confirmed address: nobody is the owner.
  w.d1.exec("INSERT INTO accounts (id, github_login, email, google_sub, google_email, created_at) VALUES ('acct-x', NULL, NULL, 'g-9', ?, 3)", EVE);
  const b = await ask(w, EVE, AT_SITE, github);
  assert.equal(b.mail, null);
  assert.equal([...w.env.KILN.map.keys()].filter(k => k.startsWith('osess:')).length, 0);
});
