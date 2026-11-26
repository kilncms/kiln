/**
 * Connecting GitHub to a Kiln account that began without it.
 *
 * A person who signed in to the dashboard with Google, or with a link sent to
 * their email address, can connect their GitHub account to that same Kiln
 * account. One account then holds the sites Kiln keeps the files of and the
 * sites in the person's own repositories.
 *
 * This is sign-in code, so most of what is tested here is what must NOT
 * happen: a code or a key that works twice, a GitHub person fixed onto
 * somebody else's Kiln account, two accounts made into one, an account that
 * began with GitHub being reached by an address, or a sign-in without GitHub
 * being taken for one with it.
 *
 * The four steps (worker/cloud.js, above connectGitHub):
 *   1. POST /cloud/link/start      the dashboard is given a code
 *   2. GET  /cloud/login?link=     on to GitHub, the code stays behind
 *   3. GET  /cloud/callback        GitHub's answer is put aside under a key
 *   4. POST /cloud/link/finish     session + code + key: the account is changed
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import worker from '../worker/index.js';
import { emailDashboardSignIn, connectGitHub, isCloudAdmin } from '../worker/cloud.js';
import { accountAddress } from '../worker/mail.js';
import { fakeKV, withFetch, jsonRes } from './worker-harness.js';
import { cloudEnv, addSite, schemaFiles, d1Skip } from './d1-fake.js';

const DASH = 'https://app.example';
const EVE = 'eve@example.com';
const ROSA = { sub: 'g-1001', email: 'rosa@example.com', name: 'Rosa Diaz' };
const EVE_AT_GITHUB = { login: 'eve-gh', id: 501 };

// Every sentence a person can be shown by these routes, word for word.
const NOT_READY = 'This Kiln service cannot connect a GitHub account yet. That is for whoever runs the service to put right. Nothing was changed.';
const ALREADY = 'You are signed in with GitHub already, so there is nothing to connect.';
const TOO_MANY = 'You have started connecting GitHub many times in a short while. Wait an hour, then try again.';
const EXPIRED = 'Connecting GitHub works once and for ten minutes, in the browser it was started in. This time it was used already, or the time ran out. Nothing was changed. Start again from the dashboard.';
const TAKEN = 'That GitHub account already has a Kiln account of its own, so it cannot be connected to this one. Nothing was changed. Connect a different GitHub account, or sign out and sign in with GitHub to use that one.';
const OTHER = 'This Kiln account is connected to the GitHub account eve-gh, and you came back from GitHub as mallory. Nothing was changed. Sign in to GitHub as eve-gh, then connect again.';
const LINKED_ADDRESS = 'Kiln writes to the address this account was started with, the one Google or a sign-in link confirmed. Nobody confirms an address typed here, so it cannot take that one\'s place.';
const NEEDS_GITHUB_TO_ADD = 'Adding a repository of your own needs a GitHub sign-in. Sign out, then sign in with GitHub.';
const NEEDS_GITHUB_FOR_SITE = 'This site is in a GitHub repository, and you are signed in with Google. Sign out, then sign in with GitHub.';
const ELSEWHERE = 'Kiln could not tell that this sign-in was started in this browser, so nobody was signed in.';

function env(extra = {}) {
  const kv = fakeKV();
  kv.map.set('app:creds', JSON.stringify({ app_id: 1, slug: 'kiln-cms', client_id: 'cid', client_secret: 'sec' }));
  return cloudEnv(kv, { CLOUD_DASHBOARD: DASH, GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsecret', ...extra });
}

/** Nobody outside answers anything. */
const nobody = async () => jsonRes({ message: 'Not Found' }, 404);
/** GitHub answers "who is this?" with `person`, hands out `token`, and knows nothing else. */
const github = (person, token = 'ghu_new') => async (url) => {
  if (url === 'https://github.com/login/oauth/access_token') return jsonRes({ access_token: token });
  if (url === 'https://api.github.com/user') return jsonRes({ email: null, ...person });
  return jsonRes({ message: 'Not Found' }, 404);
};
/** Google: the code is good, and the person is `who`. */
const google = (who) => async (url) => {
  if (url === 'https://oauth2.googleapis.com/token') return jsonRes({ id_token: 'idt' });
  if (url.startsWith('https://oauth2.googleapis.com/tokeninfo')) return jsonRes({ aud: 'gid', sub: who.sub, email: who.email, name: who.name, email_verified: 'true' });
  return jsonRes({ message: 'Not Found' }, 404);
};
/** Any request to somewhere else fails the test: this step must ask nobody. */
const mustNotAsk = async (url) => { throw new Error(`asked ${url}`); };

const cookieFor = (state) => `__Host-kiln_signin=${state}`;
const get = (e, p, { token = null, cookie = null, outside = nobody } = {}) => withFetch(outside, () => worker.fetch(new Request(`https://worker.example${p}`, {
  redirect: 'manual', headers: { Origin: DASH, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(cookie ? { Cookie: cookie } : {}) },
}), e));
const post = (e, p, body, token = null, outside = nobody) => withFetch(outside, () => worker.fetch(new Request(`https://worker.example${p}`, {
  method: 'POST', headers: { Origin: DASH, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body || {}),
}), e));
const answer = async (res) => ({ status: res.status, body: await res.json() });

const tokenOf = (res) => (/#kc_token=([0-9a-f-]{36})$/.exec(res.headers.get('Location') || '') || [])[1] || null;
const sessionOf = (e, sid) => { const raw = e.KILN.map.get(`csess:${sid}`); return raw ? JSON.parse(raw) : null; };
const signedIn = (e, res) => { const sid = tokenOf(res); return { res, sid, sess: sid ? sessionOf(e, sid) : null }; };
const keys = (e, prefix) => [...e.KILN.map.keys()].filter(k => k.startsWith(prefix));
const sessions = (e) => keys(e, 'csess:').filter(k => k !== 'csess:tok');
const rowOf = (e, id) => ({ ...e.kiln_cloud.row('SELECT id, github_login, github_id, linked_at, email, signin_email, google_sub, google_email, name FROM accounts WHERE id = ?', id) });
const accounts = (e) => e.kiln_cloud.row('SELECT COUNT(*) n FROM accounts').n;
// Every account as it stands, but for when each person was last seen (migration 0020): any new session moves that.
const everything = (e) => JSON.stringify(e.kiln_cloud.db.prepare('SELECT * FROM accounts ORDER BY id').all().map(({ last_seen: _seen, ...row }) => row));

/** A sign-in with a link sent to `email`. */
async function byEmail(e, email = EVE) { return signedIn(e, await emailDashboardSignIn(e, { email })); }
/** A sign-in with Google as `who`, through the service's own two addresses. */
async function byGoogle(e, who = ROSA) {
  const start = await get(e, '/cloud/login/google');
  const state = new URL(start.headers.get('Location')).searchParams.get('state');
  return signedIn(e, await get(e, `/google/callback?code=c&state=${state}`, { cookie: cookieFor(state), outside: google(who) }));
}
/** A plain sign-in with GitHub as `person`. */
async function byGitHub(e, person, token = 'ghu_plain') {
  const start = await get(e, '/cloud/login');
  const state = new URL(start.headers.get('Location')).searchParams.get('state');
  return { start, state, ...signedIn(e, await get(e, `/cloud/callback?code=c1&state=${state}`, { cookie: cookieFor(state), outside: github(person, token) })) };
}

/** Step 1: the dashboard asks to connect. */
const start = async (e, sid) => answer(await post(e, '/cloud/link/start', {}, sid));
/** Steps 2 and 3: the browser goes to GitHub with the code and comes back as `person`. Answers where it is sent, and the key it is given. */
async function throughGitHub(e, code, person, { cookie = true, token = 'ghu_new', outside = null, query = 'code=c1' } = {}) {
  const go = await get(e, `/cloud/login?link=${code}`, { outside: mustNotAsk });
  const to = new URL(go.headers.get('Location'));
  if (to.origin !== 'https://github.com') return { go, to, key: null };
  const state = to.searchParams.get('state');
  const res = await get(e, `/cloud/callback?${query}&state=${state}`, { cookie: cookie ? cookieFor(state) : null, outside: outside || github(person, token) });
  const back = res.headers.get('Location') ? new URL(res.headers.get('Location')) : null;
  return { go, to, state, res, back, key: back ? (/^#kc_link=([0-9a-f]{64})$/.exec(back.hash) || [])[1] || null : null };
}
/** Step 4: the dashboard finishes with the key it was sent back with and the code it kept. */
const finish = async (e, sid, key, code) => answer(await post(e, '/cloud/link/finish', { key, code }, sid, mustNotAsk));
/** All four steps for the person who holds `sid`, coming back from GitHub as `person`. */
async function connect(e, sid, person, token = 'ghu_new') {
  const asked = await start(e, sid);
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  const round = await throughGitHub(e, asked.body.code, person, { token });
  assert.ok(round.key, 'the browser came back with a key');
  return { asked, round, ...(await finish(e, sid, round.key, asked.body.code)) };
}
const me = async (e, sid) => answer(await get(e, '/cloud/me', { token: sid }));

test('the sentences these routes can show are plain: nothing a developer wrote, and no em dash', () => {
  for (const s of [NOT_READY, ALREADY, TOO_MANY, EXPIRED, TAKEN, OTHER, LINKED_ADDRESS]) {
    assert.equal(/[{}<>]|OAuth|JSON|token|session|undefined|null\b/i.test(s), false, s);
    assert.equal(/—/.test(s), false, s);
  }
});

test('nobody who is signed out can start or finish connecting', { skip: d1Skip }, async () => {
  const e = env();
  for (const p of ['/cloud/link/start', '/cloud/link/finish']) {
    assert.deepEqual(await answer(await post(e, p, { key: 'a'.repeat(64), code: 'b'.repeat(64) })), { status: 401, body: { error: 'not signed in' } });
    assert.equal((await post(e, p, {}, 'no-such-session')).status, 401);
  }
  assert.deepEqual(keys(e, 'link'), [], 'no code was made');
});

test('a person who signed in by email connects GitHub: the account gets the login and the number, and a new session holds both sign-ins', { skip: d1Skip }, async () => {
  const e = env();
  const eve = await byEmail(e);
  const before = rowOf(e, eve.sess.account_id);
  const people = accounts(e);
  assert.deepEqual((await me(e, eve.sid)).body.account, { id: before.id, github_login: null, email: EVE, name: null, google: false, by_email: true, github_session: false, linked: false });

  // Step 1. The code goes to the dashboard that asked, and KV keeps neither the session id nor anything it could be read from.
  const asked = await start(e, eve.sid);
  assert.equal(asked.status, 200);
  assert.match(asked.body.code, /^[0-9a-f]{64}$/);
  assert.deepEqual(asked.body, { ok: true, url: `https://worker.example/cloud/login?link=${asked.body.code}`, code: asked.body.code, reconnect: false });
  const kept = e.KILN.map.get(`link:${asked.body.code}`);
  assert.equal(JSON.parse(kept).account_id, before.id);
  assert.equal(kept.includes(eve.sid), false, 'the session id is not written into the code\'s record');
  assert.ok(e.KILN.expires.get(`link:${asked.body.code}`) - Date.now() / 1000 <= 600, 'ten minutes');

  // Steps 2 and 3. GitHub is handed the usual state and never the code, and coming back changes nothing yet.
  const round = await throughGitHub(e, asked.body.code, EVE_AT_GITHUB);
  assert.equal(round.go.status, 302);
  assert.equal(round.to.href.includes(asked.body.code), false, 'the code does not travel to GitHub');
  assert.equal(round.to.searchParams.get('redirect_uri'), 'https://worker.example/cloud/callback');
  assert.match(round.go.headers.get('Set-Cookie'), new RegExp(`^__Host-kiln_signin=${round.state}; HttpOnly; Secure; SameSite=Lax`));
  assert.equal(round.res.status, 302);
  assert.equal(`${round.back.origin}${round.back.pathname}${round.back.search}`, 'https://app.example/?link=confirm');
  assert.match(round.back.hash, /^#kc_link=[0-9a-f]{64}$/);
  assert.equal(e.KILN.map.has(`link:${asked.body.code}`), false, 'the code is gone once it was used');
  assert.deepEqual(rowOf(e, before.id), before, 'the account is as it was');
  assert.equal(accounts(e), people, 'no account was made for the GitHub person');
  assert.deepEqual(sessions(e), [`csess:${eve.sid}`], 'and nobody was signed in');
  const aside = e.KILN.map.get(`linkback:${round.key}`);
  assert.equal(aside.includes(eve.sid) || aside.includes(asked.body.code), false, 'what is put aside names neither the session nor the code');

  // Step 4.
  const done = await finish(e, eve.sid, round.key, asked.body.code);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.match(done.body.token, /^[0-9a-f-]{36}$/);
  assert.deepEqual(done.body, { ok: true, token: done.body.token, login: 'eve-gh', connected: true });
  const after = rowOf(e, before.id);
  assert.ok(Number.isInteger(after.linked_at) && after.linked_at > 0);
  assert.deepEqual(after, { ...before, github_login: 'eve-gh', github_id: 501, linked_at: after.linked_at }, 'the addresses, the Google id and the name are untouched');
  assert.equal(accounts(e), people);
  assert.deepEqual(sessionOf(e, done.body.token), { account_id: before.id, login: 'eve-gh', uid: 501, gh: 'ghu_new', byEmail: eve.sess.byEmail });
  assert.deepEqual(sessions(e), [`csess:${done.body.token}`], 'the session that asked is gone');
  assert.equal((await me(e, eve.sid)).status, 401);
  assert.deepEqual((await me(e, done.body.token)).body.account, { id: before.id, github_login: 'eve-gh', email: EVE, name: null, google: false, by_email: true, github_session: true, linked: true });
  assert.equal(await accountAddress(e, before.id), EVE, 'Kiln keeps writing to the address it confirmed');
  assert.deepEqual(keys(e, 'link:').concat(keys(e, 'linkback:')), [], 'nothing of the connecting is left in KV');
});

test('a person who signed in with Google connects GitHub, and the new session still says Google', { skip: d1Skip }, async () => {
  const e = env();
  const rosa = await byGoogle(e);
  const before = rowOf(e, rosa.sess.account_id);
  const done = await connect(e, rosa.sid, { login: 'rosa-gh', id: 77 });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  const after = rowOf(e, before.id);
  assert.deepEqual(after, { ...before, github_login: 'rosa-gh', github_id: 77, linked_at: after.linked_at });
  assert.deepEqual(sessionOf(e, done.body.token), { account_id: before.id, login: 'rosa-gh', uid: 77, gh: 'ghu_new', google: rosa.sess.google });
  assert.deepEqual((await me(e, done.body.token)).body.account, { id: before.id, github_login: 'rosa-gh', email: ROSA.email, name: ROSA.name, google: true, by_email: false, github_session: true, linked: true });
  assert.equal(await accountAddress(e, before.id), ROSA.email);
});

test('the code works once, and so does the key', { skip: d1Skip }, async () => {
  const e = env();
  const eve = await byEmail(e);
  const asked = await start(e, eve.sid);
  const round = await throughGitHub(e, asked.body.code, EVE_AT_GITHUB);
  // The address with the code, opened a second time, goes nowhere near GitHub.
  const again = await throughGitHub(e, asked.body.code, { login: 'mallory', id: 999 });
  assert.equal(again.to.href, 'https://app.example/?link=expired');
  assert.equal(again.go.headers.get('Set-Cookie'), null);
  assert.deepEqual(keys(e, 'cstate:'), []);
  const done = await finish(e, eve.sid, round.key, asked.body.code);
  assert.equal(done.status, 200);
  const settled = everything(e);
  // The key a second time, even from the new session.
  for (const sid of [eve.sid, done.body.token]) {
    const twice = await finish(e, sid, round.key, asked.body.code);
    if (sid === eve.sid) assert.equal(twice.status, 401, 'the session that asked is gone');
    else assert.deepEqual(twice, { status: 410, body: { error: EXPIRED, code: 'expired' } });
  }
  assert.equal(everything(e), settled);
  assert.deepEqual(sessions(e), [`csess:${done.body.token}`]);
});

test('a code that is unknown, misspelled or past its time changes nothing, and GitHub is never asked', { skip: d1Skip }, async () => {
  const e = env();
  const eve = await byEmail(e);
  const settled = everything(e);
  for (const code of ['0'.repeat(64), 'short', 'Z'.repeat(64), '']) {
    const go = await get(e, `/cloud/login?link=${code}`, { outside: mustNotAsk });
    assert.equal(go.status, 302);
    assert.equal(go.headers.get('Location'), 'https://app.example/?link=expired', code);
    assert.equal(go.headers.get('Set-Cookie'), null, 'no sign-in was started');
  }
  assert.deepEqual(keys(e, 'cstate:'), []);
  // The code's ten minutes ran out while the person was at GitHub.
  const asked = await start(e, eve.sid);
  const go = await get(e, `/cloud/login?link=${asked.body.code}`);
  const state = new URL(go.headers.get('Location')).searchParams.get('state');
  e.KILN.map.delete(`link:${asked.body.code}`);
  const res = await get(e, `/cloud/callback?code=c1&state=${state}`, { cookie: cookieFor(state), outside: mustNotAsk });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('Location'), 'https://app.example/?link=expired');
  assert.match(res.headers.get('Set-Cookie'), /^__Host-kiln_signin=; .*Max-Age=0$/, 'the cookie of the sign-in is taken away');
  assert.deepEqual(keys(e, 'linkback:'), []);
  // A key nobody was given.
  assert.deepEqual(await finish(e, eve.sid, 'f'.repeat(64), asked.body.code), { status: 410, body: { error: EXPIRED, code: 'expired' } });
  assert.deepEqual(await finish(e, eve.sid, 'not a key', asked.body.code), { status: 410, body: { error: EXPIRED, code: 'expired' } });
  assert.equal(everything(e), settled);
  assert.deepEqual(sessions(e), [`csess:${eve.sid}`], 'the person is still signed in as before');
});

test('GitHub sending the person back without a sign-in, or without its number for them, connects nothing', { skip: d1Skip }, async () => {
  const e = env();
  const eve = await byEmail(e);
  const settled = everything(e);
  // The person pressed Cancel at GitHub.
  let asked = await start(e, eve.sid);
  let round = await throughGitHub(e, asked.body.code, null, { query: 'error=access_denied', outside: mustNotAsk });
  assert.equal(round.res.headers.get('Location'), 'https://app.example/?link=failed');
  // GitHub refused the code.
  asked = await start(e, eve.sid);
  round = await throughGitHub(e, asked.body.code, null, { outside: async () => jsonRes({ error: 'bad_verification_code' }) });
  assert.equal(round.res.headers.get('Location'), 'https://app.example/?link=failed');
  // GitHub named a login and gave no number: a login alone can change hands.
  asked = await start(e, eve.sid);
  round = await throughGitHub(e, asked.body.code, { login: 'eve-gh' });
  assert.equal(round.res.headers.get('Location'), 'https://app.example/?link=failed');
  assert.deepEqual(keys(e, 'link:').concat(keys(e, 'linkback:')), [], 'each code was used up, and nothing was put aside');
  assert.equal(everything(e), settled);
  assert.deepEqual(sessions(e), [`csess:${eve.sid}`]);
});

test('an address with a code that is passed to somebody else fixes nobody\'s GitHub account onto the account that made it', { skip: d1Skip }, async () => {
  const e = env();
  const mallory = await byEmail(e, 'mallory@example.com');
  const victim = await byEmail(e, 'victim@example.com');
  const settled = everything(e);
  const VICTIM_AT_GITHUB = { login: 'victim', id: 777 };

  // Mallory starts on her own account and gets the victim to open the address. The victim is signed in to GitHub.
  let asked = await start(e, mallory.sid);
  let round = await throughGitHub(e, asked.body.code, VICTIM_AT_GITHUB);
  assert.ok(round.key, 'the key is in the victim\'s browser, and nowhere else');
  assert.equal(everything(e), settled, 'coming back from GitHub changed no account');
  // Mallory holds her session and the code, and not the key.
  assert.equal((await finish(e, mallory.sid, 'e'.repeat(64), asked.body.code)).status, 410);
  assert.equal((await finish(e, mallory.sid, asked.body.code, asked.body.code)).status, 410, 'the code is not the key');
  // The victim's dashboard holds the key and the victim's own session, and neither Mallory's session nor the code.
  assert.deepEqual(await finish(e, victim.sid, round.key, 'c'.repeat(64)), { status: 410, body: { error: EXPIRED, code: 'expired' } });
  // A key that was tried once is gone, so nothing Mallory learns afterwards helps her.
  assert.equal((await finish(e, mallory.sid, round.key, asked.body.code)).status, 410);
  assert.equal(everything(e), settled);

  // The same with no session at all in the victim's dashboard.
  asked = await start(e, mallory.sid);
  round = await throughGitHub(e, asked.body.code, VICTIM_AT_GITHUB);
  assert.equal((await post(e, '/cloud/link/finish', { key: round.key, code: asked.body.code })).status, 401);

  // Mallory's own session id put into the victim's dashboard is still not enough: that dashboard was never given the code.
  asked = await start(e, mallory.sid);
  round = await throughGitHub(e, asked.body.code, VICTIM_AT_GITHUB);
  assert.equal((await finish(e, mallory.sid, round.key, 'd'.repeat(64))).status, 410);
  assert.equal((await finish(e, mallory.sid, round.key, asked.body.code)).status, 410, 'and the key was used up by the try');

  // Mallory's code and the victim's session and key: the code was made for another session.
  asked = await start(e, mallory.sid);
  round = await throughGitHub(e, asked.body.code, VICTIM_AT_GITHUB);
  assert.equal((await finish(e, victim.sid, round.key, asked.body.code)).status, 410);

  assert.equal(everything(e), settled, 'no account has anybody\'s GitHub login or number');
  assert.equal(e.kiln_cloud.row('SELECT COUNT(*) n FROM accounts WHERE github_id = 777').n, 0);
  assert.deepEqual(sessions(e).sort(), [`csess:${mallory.sid}`, `csess:${victim.sid}`].sort(), 'and nobody got a session with the victim\'s GitHub part');
});

test('coming back from GitHub in another browser than the one that left stops there', { skip: d1Skip }, async () => {
  const e = env();
  const eve = await byEmail(e);
  const settled = everything(e);
  const asked = await start(e, eve.sid);
  const round = await throughGitHub(e, asked.body.code, EVE_AT_GITHUB, { cookie: false, outside: mustNotAsk });
  assert.equal(round.res.status, 400);
  assert.ok((await round.res.text()).includes(ELSEWHERE));
  assert.deepEqual(keys(e, 'linkback:'), [], 'nothing was put aside');
  assert.equal(everything(e), settled);
});

test('a GitHub account that already has a Kiln account of its own is not connected to another one', { skip: d1Skip }, async () => {
  const e = env();
  const rosa = await byGitHub(e, { login: 'rosa', id: 7 });   // began with GitHub
  const eve = await byEmail(e);
  const settled = everything(e);
  const refused = await connect(e, eve.sid, { login: 'rosa', id: 7 });
  assert.deepEqual({ status: refused.status, body: refused.body }, { status: 409, body: { error: TAKEN, code: 'taken', login: 'rosa' } });
  // GitHub was asked to show its account picker, so the person could have chosen another GitHub account.
  assert.equal(refused.round.to.searchParams.get('prompt'), 'select_account');
  // The same when GitHub's person renamed since: the number is what counts.
  assert.equal((await connect(e, eve.sid, { login: 'rosa-diaz', id: 7 })).body.code, 'taken');
  // And for an account from before numbers were kept, which is known by its login alone ('ada', the harness's account).
  assert.equal(e.kiln_cloud.row("SELECT github_id FROM accounts WHERE id = 'acct-1'").github_id, null);
  assert.equal((await connect(e, eve.sid, { login: 'ada', id: 4242 })).body.code, 'taken');
  assert.equal((await connect(e, eve.sid, { login: 'Ada', id: 4242 })).body.code, 'taken');
  assert.equal(everything(e), settled, 'neither account changed');
  assert.deepEqual(sessions(e).sort(), [`csess:${rosa.sid}`, `csess:${eve.sid}`].sort(), 'the person is still signed in as before, and no session was made');
  assert.equal((await me(e, eve.sid)).body.account.github_session, false);
});

test('two accounts connecting the same GitHub person at the same moment: one is connected and the other is told it is taken', { skip: d1Skip }, async () => {
  const e = env();
  const eve = await byEmail(e);
  const rosa = await byGoogle(e);
  // Both went to GitHub and came back as the same person before either finished.
  const one = await start(e, eve.sid), two = await start(e, rosa.sid);
  const first = await throughGitHub(e, one.body.code, EVE_AT_GITHUB), second = await throughGitHub(e, two.body.code, EVE_AT_GITHUB);
  const [a, b] = await Promise.all([finish(e, eve.sid, first.key, one.body.code), finish(e, rosa.sid, second.key, two.body.code)]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal((a.status === 409 ? a : b).body.code, 'taken');
  assert.equal(e.kiln_cloud.row('SELECT COUNT(*) n FROM accounts WHERE github_id = 501').n, 1);
  assert.equal(e.kiln_cloud.row("SELECT COUNT(*) n FROM accounts WHERE github_login = 'eve-gh'").n, 1);

  // The step that writes, asked directly, so that both pass every check before either writes.
  const f = env();
  const [p, q] = [(await byEmail(f, 'p@example.com')).sess.account_id, (await byEmail(f, 'q@example.com')).sess.account_id];
  const both = await Promise.all([connectGitHub(f, p, { login: 'pat', uid: 9 }), connectGitHub(f, q, { login: 'pat', uid: 9 })]);
  assert.deepEqual(both.map(o => o.ok ? 'connected' : o.code).sort(), ['connected', 'taken']);
  assert.equal(f.kiln_cloud.row('SELECT COUNT(*) n FROM accounts WHERE github_id = 9').n, 1);
  // One account, two different GitHub people at once: one is written, and the other is told who the account is connected to.
  const r = (await byEmail(f, 'r@example.com')).sess.account_id;
  const pair = await Promise.all([connectGitHub(f, r, { login: 'ruth', uid: 21 }), connectGitHub(f, r, { login: 'ruby', uid: 22 })]);
  assert.equal(pair.filter(o => o.ok).length, 1);
  const won = f.kiln_cloud.row('SELECT github_login, github_id FROM accounts WHERE id = ?', r);
  assert.deepEqual(pair.find(o => !o.ok), { code: 'other', login: won.github_login });
  // One account, the same GitHub person twice at once: written once, and both are fine.
  const s = (await byEmail(f, 's@example.com')).sess.account_id;
  const same = await Promise.all([connectGitHub(f, s, { login: 'sam', uid: 31 }), connectGitHub(f, s, { login: 'sam', uid: 31 })]);
  assert.deepEqual(same.map(o => o.connected).sort(), [false, true]);
  // Without GitHub's number nothing is written.
  assert.deepEqual(await connectGitHub(f, (await byEmail(f, 't@example.com')).sess.account_id, { login: 'tess', uid: null }), { code: 'expired' });
});

test('a login that a renamed GitHub account left behind on its row does not stop the person who holds it now', { skip: d1Skip }, async () => {
  const e = env();
  // Rosa (number 7) renamed away from 'rosa' and has not signed in since, so her row still carries the old login.
  const rosa = await byGitHub(e, { login: 'rosa', id: 7 });
  const eve = await byEmail(e);
  const done = await connect(e, eve.sid, { login: 'rosa', id: 8 });   // whoever holds the name today
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual({ ...e.kiln_cloud.row('SELECT github_login, github_id FROM accounts WHERE id = ?', eve.sess.account_id) }, { github_login: 'rosa', github_id: 8 });
  assert.deepEqual({ ...e.kiln_cloud.row('SELECT github_login, github_id FROM accounts WHERE id = ?', rosa.sess.account_id) }, { github_login: null, github_id: 7 }, 'her row keeps its number, by which she is found');
  const back = await byGitHub(e, { login: 'rosa-diaz', id: 7 });
  assert.equal(back.sess.account_id, rosa.sess.account_id);
});

test('an account that connected GitHub is reached again by email, by GitHub and with Google, and no second account is made', { skip: d1Skip }, async () => {
  const e = env();
  const eve = await byEmail(e);
  const id = eve.sess.account_id;
  await connect(e, eve.sid, EVE_AT_GITHUB);
  const people = accounts(e);
  const linked = rowOf(e, id);

  // By email: the same account, and a session with no GitHub part.
  const mailed = await byEmail(e);
  assert.equal(mailed.sess.account_id, id);
  assert.deepEqual(mailed.sess, { account_id: id, login: null, uid: null, gh: null, byEmail: { email: EVE, name: null } });
  assert.deepEqual((await me(e, mailed.sid)).body.account, { id, github_login: 'eve-gh', email: EVE, name: null, google: false, by_email: true, github_session: false, linked: true });

  // By GitHub: the same account, found by GitHub's number, and nothing on its row is written over.
  const hubbed = await byGitHub(e, { login: 'eve-gh', id: 501, email: 'eve-at-github@example.com' });
  assert.deepEqual(hubbed.sess, { account_id: id, login: 'eve-gh', uid: 501, gh: 'ghu_plain' });
  assert.deepEqual(rowOf(e, id), linked);
  assert.equal(await accountAddress(e, id), EVE, 'the address GitHub shows for the person is not where Kiln writes');
  assert.deepEqual((await me(e, hubbed.sid)).body.account, { id, github_login: 'eve-gh', email: EVE, name: null, google: false, by_email: true, github_session: true, linked: true });

  // With Google, confirming the very address the account was started with: Google's id is written on the same account.
  const googled = await byGoogle(e, { sub: 'g-eve', email: EVE, name: 'Eve Adams' });
  assert.equal(googled.sess.account_id, id);
  assert.equal(googled.sess.gh, null);
  assert.deepEqual(rowOf(e, id), { ...linked, google_sub: 'g-eve', google_email: EVE, name: 'Eve Adams' });
  // And every way in still ends at that one account.
  assert.equal((await byGoogle(e, { sub: 'g-eve', email: EVE, name: 'Eve Adams' })).sess.account_id, id);
  assert.equal((await byEmail(e)).sess.account_id, id);
  assert.equal((await byGitHub(e, EVE_AT_GITHUB)).sess.account_id, id);
  assert.equal(accounts(e), people, 'no second account');

  // An account that began with Google and connected GitHub is found by Google's id as before.
  const rosa = await byGoogle(e);
  await connect(e, rosa.sid, { login: 'rosa-gh', id: 77 });
  const count = accounts(e);
  assert.equal((await byGoogle(e)).sess.account_id, rosa.sess.account_id);
  assert.equal((await byEmail(e, ROSA.email)).sess.account_id, rosa.sess.account_id, 'and by a link sent to the address Google confirmed');
  assert.equal((await byGitHub(e, { login: 'rosa-gh', id: 77 })).sess.account_id, rosa.sess.account_id);
  assert.equal(accounts(e), count);
});

test('connecting again gives a sign-in by email its GitHub part, for the account\'s own GitHub person and no other', { skip: d1Skip }, async () => {
  const e = env();
  const first = await byEmail(e);
  const id = first.sess.account_id;
  await connect(e, first.sid, EVE_AT_GITHUB);
  const mallory = await byGitHub(e, { login: 'mallory', id: 999 });   // has a Kiln account of her own
  const linked = everything(e);

  const eve = await byEmail(e);
  const signedInBefore = sessions(e).sort();
  const asked = await start(e, eve.sid);
  assert.equal(asked.body.reconnect, true);
  // Another GitHub person: nothing changes, and the answer says which GitHub account this Kiln account is connected to.
  let round = await throughGitHub(e, asked.body.code, { login: 'mallory', id: 999 });
  assert.deepEqual(await finish(e, eve.sid, round.key, asked.body.code), { status: 409, body: { error: OTHER, code: 'other', login: 'eve-gh' } });
  // The same from a GitHub person with no Kiln account.
  const wrong = await connect(e, eve.sid, { login: 'mallory', id: 31337 });
  assert.deepEqual({ status: wrong.status, body: wrong.body }, { status: 409, body: { error: OTHER, code: 'other', login: 'eve-gh' } });
  assert.equal(everything(e), linked);
  assert.ok(signedInBefore.includes(`csess:${eve.sid}`) && signedInBefore.includes(`csess:${mallory.sid}`));
  assert.deepEqual(sessions(e).sort(), signedInBefore, 'no session was made, and the one that asked is still there');
  assert.equal(sessionOf(e, eve.sid).gh, null, 'with no GitHub part');

  // The account's own GitHub person.
  const right = await connect(e, eve.sid, EVE_AT_GITHUB, 'ghu_again');
  assert.deepEqual({ status: right.status, body: right.body }, { status: 200, body: { ok: true, token: right.body.token, login: 'eve-gh', connected: false } });
  assert.deepEqual(sessionOf(e, right.body.token), { account_id: id, login: 'eve-gh', uid: 501, gh: 'ghu_again', byEmail: eve.sess.byEmail });
  assert.equal(sessionOf(e, eve.sid), null);
  assert.equal(everything(e), linked, 'nothing was written on any account, the day it was first connected included');
});

test('a session that already has its GitHub part is told there is nothing to connect, and starting is counted', { skip: d1Skip }, async () => {
  const e = env();
  assert.deepEqual(await start(e, 'tok'), { status: 409, body: { error: ALREADY, code: 'already_connected' } });   // the harness's GitHub sign-in
  const eve = await byEmail(e);
  const done = await connect(e, eve.sid, EVE_AT_GITHUB);
  assert.deepEqual(await start(e, done.body.token), { status: 409, body: { error: ALREADY, code: 'already_connected' } });
  assert.deepEqual(keys(e, 'link:'), []);
  // Ten starts in an hour for one account, and the eleventh is refused.
  const pat = await byEmail(e, 'pat@example.com');
  for (let i = 0; i < 10; i++) assert.equal((await start(e, pat.sid)).status, 200, `start ${i + 1}`);
  assert.deepEqual(await start(e, pat.sid), { status: 429, body: { error: TOO_MANY, code: 'too_many' } });
  assert.equal(keys(e, 'link:').length, 10);
  assert.equal((await start(e, (await byEmail(e, 'quinn@example.com')).sid)).status, 200, 'another account is not held up by it');
});

test('an account that began with GitHub is still never reached by an address or by Google, whatever its email says', { skip: d1Skip }, async () => {
  const e = env();
  const rosa = await byGitHub(e, { login: 'rosa', id: 7, email: ROSA.email });
  const born = rowOf(e, rosa.sess.account_id);
  assert.deepEqual([born.email, born.linked_at, born.signin_email, born.google_sub], [ROSA.email, null, null, null]);
  const mailed = await byEmail(e, ROSA.email);
  assert.notEqual(mailed.sess.account_id, born.id, 'a link sent to the address makes an account of its own');
  const googled = await byGoogle(e, { sub: 'g-other', email: ROSA.email, name: 'Somebody' });
  assert.notEqual(googled.sess.account_id, born.id);
  assert.deepEqual(rowOf(e, born.id), born, 'and nothing on the GitHub account changed');
  // Neither is the harness's account from before numbers were kept.
  assert.notEqual((await byEmail(e, 'ada@example.com')).sess.account_id, 'acct-1');
  assert.equal((await byGitHub(e, { login: 'rosa', id: 7 })).sess.account_id, born.id);
});

test('a plain sign-in with GitHub, with no code, goes as it always did', { skip: d1Skip }, async () => {
  const e = env();
  const people = accounts(e);
  const rosa = await byGitHub(e, { login: 'rosa', id: 7 });
  assert.equal(new URL(rosa.start.headers.get('Location')).search.includes('link'), false);
  assert.equal(new URL(rosa.start.headers.get('Location')).searchParams.get('prompt'), null, 'a plain sign-in shows no account picker');
  assert.equal(rosa.res.status, 302);
  assert.equal(rosa.res.headers.get('Location'), `${DASH}/#kc_token=${rosa.sid}`);
  assert.deepEqual(rosa.sess, { account_id: rosa.sess.account_id, login: 'rosa', uid: 7, gh: 'ghu_plain' });
  assert.equal(accounts(e), people + 1);
  const row = rowOf(e, rosa.sess.account_id);
  assert.deepEqual([row.github_login, row.github_id, row.linked_at], ['rosa', 7, null]);
  assert.deepEqual((await me(e, rosa.sid)).body.account, { id: row.id, github_login: 'rosa', email: null, name: null, google: false, by_email: false, github_session: true, linked: false });
  assert.deepEqual(keys(e, 'link'), []);
  // A callback nobody started is still sent back to sign in again.
  const stray = await get(e, '/cloud/callback?code=c1&state=nobody-kept-this', { outside: mustNotAsk });
  assert.equal(stray.headers.get('Location'), 'https://app.example/?signin=again');
});

test('what needs a GitHub sign-in is decided by the session, and what needs a confirmed address by the account', { skip: d1Skip }, async () => {
  const e = env({ CLOUD_ADMIN_ID: '501' });   // the operator is GitHub's person 501
  const first = await byEmail(e);
  const id = first.sess.account_id;
  const done = await connect(e, first.sid, EVE_AT_GITHUB);
  const withGitHub = done.body.token;
  const without = (await byEmail(e)).sid;
  addSite(e, { id: 'site-own', account_id: id, repo: 'eve-gh/shop', origin: 'https://shop.example' });
  addSite(e, { id: 'site-kept', account_id: id, repo: 'kiln-sites/oak-1a2b3c4d', origin: 'https://oak.example' });
  e.kiln_cloud.exec("UPDATE sites SET kept = 1 WHERE id = 'site-kept'");

  // Signed in by email today: no GitHub part, so what takes one is refused in the words every such sign-in reads.
  assert.deepEqual(await answer(await post(e, '/cloud/sites', { repo: 'eve-gh/shop2', origin: 'https://shop2.example' }, without, mustNotAsk)), { status: 403, body: { error: NEEDS_GITHUB_TO_ADD, code: 'needs_github' } });
  assert.deepEqual(await answer(await get(e, '/cloud/github', { token: without, outside: mustNotAsk })), { status: 200, body: { ok: true, installed: false, code: 'needs_github', repos: [] } });
  assert.deepEqual(await answer(await get(e, '/cloud/sites/files?site=site-own', { token: without, outside: mustNotAsk })), { status: 403, body: { error: NEEDS_GITHUB_FOR_SITE, code: 'needs_github' } });
  // The site Kiln keeps the files of is reached either way (what stops here is that nobody has paid, which is past every GitHub question).
  for (const sid of [without, withGitHub]) assert.equal((await answer(await get(e, '/cloud/sites/files?site=site-kept', { token: sid }))).body.code, 'paid_first');
  // With the GitHub part, the site in the person's own repository is theirs (the answer is the one for a site that is not kept).
  assert.equal((await answer(await get(e, '/cloud/sites/files?site=site-own', { token: withGitHub }))).body.code, 'not_kept');
  // Both sessions list both sites.
  for (const sid of [without, withGitHub]) assert.deepEqual((await me(e, sid)).body.sites.map(s => s.id).sort(), ['site-kept', 'site-own']);

  // The operator is a GitHub sign-in: the same account signed in by email is not the operator.
  assert.equal(isCloudAdmin(sessionOf(e, without), e), false);
  assert.equal(isCloudAdmin(sessionOf(e, withGitHub), e), true);

  // The address Kiln writes to stays the confirmed one, however the person signed in today.
  assert.deepEqual(await answer(await post(e, '/cloud/account', { email: 'typed@example.com' }, withGitHub)), { status: 403, body: { error: LINKED_ADDRESS, code: 'google_address' } });
  assert.equal((await answer(await post(e, '/cloud/account', { email: 'typed@example.com' }, without))).body.code, 'google_address');
  assert.equal(await accountAddress(e, id), EVE);
  assert.equal(rowOf(e, id).email, EVE);
  // An account that began with GitHub still gives its own address, as before.
  assert.deepEqual(await answer(await post(e, '/cloud/account', { email: 'ada@new.example' }, 'tok')), { status: 200, body: { ok: true, email: 'ada@new.example' } });
  assert.equal(await accountAddress(e, 'acct-1'), 'ada@new.example');
});

test('on a database migration 0019 has not reached, connecting is not offered and everything else works as before', { skip: d1Skip }, async () => {
  const files = schemaFiles();
  const before0019 = files.findIndex(f => path.basename(f) === '0019_linked.sql');
  assert.ok(before0019 > 0, 'this test stands for a database that migration 0019 has not reached');
  const e = env({ d1: { upTo: before0019 } });
  assert.throws(() => e.kiln_cloud.row('SELECT linked_at FROM accounts LIMIT 1'), /no such column/);
  const eve = await byEmail(e);
  assert.deepEqual(await start(e, eve.sid), { status: 503, body: { error: NOT_READY, code: 'not_ready' } });
  assert.deepEqual(await start(e, 'tok'), { status: 503, body: { error: NOT_READY, code: 'not_ready' } });
  assert.deepEqual(keys(e, 'link'), []);
  assert.deepEqual((await me(e, eve.sid)).body.account, { id: eve.sess.account_id, github_login: null, email: EVE, name: null, google: false, by_email: true, github_session: false, linked: false });
  assert.equal((await me(e, 'tok')).body.account.github_session, true);
  // Every sign-in finds its account, and finds it again.
  assert.equal((await byEmail(e)).sess.account_id, eve.sess.account_id);
  const rosa = await byGoogle(e);
  assert.equal((await byGoogle(e)).sess.account_id, rosa.sess.account_id);
  assert.equal((await byEmail(e, ROSA.email)).sess.account_id, rosa.sess.account_id);
  const pat = await byGitHub(e, { login: 'pat', id: 9, email: 'pat@example.com' });
  assert.equal((await byGitHub(e, { login: 'pat', id: 9 })).sess.account_id, pat.sess.account_id);
  assert.notEqual((await byEmail(e, 'pat@example.com')).sess.account_id, pat.sess.account_id, 'an account that began with GitHub is not found by an address');
  // A key that was put aside by a service on the newer database changes nothing here.
  const code = 'a'.repeat(64), key = 'b'.repeat(64);
  const hex = async (s) => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))).toString('hex');
  e.KILN.map.set(`linkback:${key}`, JSON.stringify({ account_id: eve.sess.account_id, by: await hex(eve.sid), code: await hex(code), login: 'eve-gh', uid: 501, gh: 'ghu_new' }));
  assert.deepEqual(await finish(e, eve.sid, key, code), { status: 503, body: { error: NOT_READY, code: 'not_ready' } });
  assert.deepEqual({ ...e.kiln_cloud.row('SELECT github_login, github_id FROM accounts WHERE id = ?', eve.sess.account_id) }, { github_login: null, github_id: null });
});
