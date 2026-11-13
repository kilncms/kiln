/**
 * Signing in with GitHub: an account is known by GitHub's number for the
 * person, not by their login.
 *
 * A login is not permanent. A person can rename their GitHub account, and
 * somebody else can then take the old name. Until migration 0012 the dashboard
 * found an account by its login, so the person who renamed found an empty
 * dashboard, and whoever took the old name signed in as the old account: its
 * sites, its billing page, and the editor of any site whose files Kiln keeps.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { fakeKV, withFetch, jsonRes } from './worker-harness.js';
import { cloudEnv, addSite, d1Skip } from './d1-fake.js';

const DASH = 'https://app.example';

function env(extra = {}) {
  const kv = fakeKV();
  kv.map.set('app:creds', JSON.stringify({ app_id: 1, slug: 'kiln-cms', client_id: 'cid', client_secret: 'sec' }));
  return cloudEnv(kv, { CLOUD_DASHBOARD: DASH, ...extra });
}

/** GitHub answers "who is this?" with `person`, and knows nothing else. */
const github = (person) => async (url) => {
  if (url === 'https://github.com/login/oauth/access_token') return jsonRes({ access_token: 'ghu_new' });
  if (url === 'https://api.github.com/user') return jsonRes({ email: null, ...person });
  return jsonRes({ message: 'Not Found' }, 404);
};

let turn = 0;
/** One whole sign-in to the dashboard as `person`. Gives the answer, and the session when one was made. */
async function signIn(e, person) {
  const state = `s${++turn}`;
  e.KILN.map.set(`cstate:${state}`, '1');
  let res;
  await withFetch(github(person), async () => {
    res = await worker.fetch(new Request(`https://worker.example/cloud/callback?code=c1&state=${state}`, { redirect: 'manual', headers: { Cookie: `__Host-kiln_signin=${state}` } }), e);
  });
  const sid = (/#kc_token=([0-9a-f-]{36})$/.exec(res.headers.get('Location') || '') || [])[1] || null;
  return { res, sid, sess: sid ? JSON.parse(e.KILN.map.get(`csess:${sid}`)) : null };
}
/** What the dashboard shows the person who holds this session. */
async function dashboard(e, sid) {
  let body;
  await withFetch(github({}), async () => {
    const res = await worker.fetch(new Request('https://worker.example/cloud/me', { headers: { Authorization: `Bearer ${sid}`, Origin: DASH } }), e);
    assert.equal(res.status, 200);
    body = await res.json();
  });
  return body;
}
const account = (e, id) => ({ ...e.kiln_cloud.row('SELECT id, github_login, github_id FROM accounts WHERE id = ?', id) });
const accounts = (e) => e.kiln_cloud.row('SELECT COUNT(*) n FROM accounts').n;

test('a first sign-in makes an account with the login and GitHub\'s number, and the next one finds it', { skip: d1Skip }, async () => {
  const e = env();
  const first = await signIn(e, { login: 'rosa', id: 7 });
  assert.equal(first.res.status, 302);
  assert.deepEqual(account(e, first.sess.account_id), { id: first.sess.account_id, github_login: 'rosa', github_id: 7 });
  const again = await signIn(e, { login: 'rosa', id: 7 });
  assert.equal(again.sess.account_id, first.sess.account_id);
  assert.equal(accounts(e), 2, 'the account the harness starts with, and this one');
});

test('a person who renamed their GitHub account finds the same account, and the new login is written down', { skip: d1Skip }, async () => {
  const e = env();
  const before = await signIn(e, { login: 'rosa', id: 7 });
  addSite(e, { id: 'site-rosa', account_id: before.sess.account_id, repo: 'rosa/bakery', origin: 'https://bakery.example' });
  const after = await signIn(e, { login: 'rosa-diaz', id: 7 });
  assert.equal(after.sess.account_id, before.sess.account_id);
  assert.equal(after.sess.login, 'rosa-diaz', 'the session carries the login GitHub gave at this sign-in');
  assert.equal(after.sess.uid, 7);
  assert.deepEqual(account(e, before.sess.account_id), { id: before.sess.account_id, github_login: 'rosa-diaz', github_id: 7 });
  const seen = await dashboard(e, after.sid);
  assert.equal(seen.account.github_login, 'rosa-diaz');
  assert.deepEqual(seen.sites.map(s => s.id), ['site-rosa'], 'their site is still theirs');
  assert.equal(accounts(e), 2, 'no second account was made');
});

test('somebody else who now holds the old login gets a new, empty account and cannot see the old one\'s sites', { skip: d1Skip }, async () => {
  const e = env();
  const rosa = await signIn(e, { login: 'rosa', id: 7 });
  addSite(e, { id: 'site-rosa', account_id: rosa.sess.account_id, repo: 'rosa/bakery', origin: 'https://bakery.example' });
  await signIn(e, { login: 'rosa-diaz', id: 7 });   // Rosa renamed, and Kiln has seen it
  const other = await signIn(e, { login: 'rosa', id: 9 });
  assert.equal(other.res.status, 302);
  assert.notEqual(other.sess.account_id, rosa.sess.account_id);
  assert.deepEqual(account(e, other.sess.account_id), { id: other.sess.account_id, github_login: 'rosa', github_id: 9 });
  const seen = await dashboard(e, other.sid);
  assert.deepEqual(seen.sites, [], 'an empty dashboard');
  assert.equal(seen.account.id, other.sess.account_id);
  assert.deepEqual(account(e, rosa.sess.account_id), { id: rosa.sess.account_id, github_login: 'rosa-diaz', github_id: 7 }, 'the old account is as it was');
});

test('the old login is taken before Kiln has seen the rename: the newcomer still gets a new account, and the owner still finds theirs', { skip: d1Skip }, async () => {
  const e = env();
  const rosa = await signIn(e, { login: 'rosa', id: 7 });
  addSite(e, { id: 'site-rosa', account_id: rosa.sess.account_id, repo: 'rosa/bakery', origin: 'https://bakery.example' });
  // Rosa renames on GitHub and does not come back to Kiln. Somebody else takes "rosa" and signs in.
  const other = await signIn(e, { login: 'rosa', id: 9 });
  assert.equal(other.res.status, 302, 'the table allows one account for a login, and the sign-in still finishes');
  assert.notEqual(other.sess.account_id, rosa.sess.account_id);
  assert.deepEqual((await dashboard(e, other.sid)).sites, []);
  assert.deepEqual(account(e, rosa.sess.account_id), { id: rosa.sess.account_id, github_login: null, github_id: 7 }, 'the old account gave up the login and kept its number');
  // Rosa comes back under her new name and is found by her number.
  const back = await signIn(e, { login: 'rosa-diaz', id: 7 });
  assert.equal(back.sess.account_id, rosa.sess.account_id);
  assert.deepEqual(account(e, rosa.sess.account_id), { id: rosa.sess.account_id, github_login: 'rosa-diaz', github_id: 7 });
  assert.deepEqual((await dashboard(e, back.sid)).sites.map(s => s.id), ['site-rosa']);
});

test('a person renames to a login another account still carries: that account gives the login up and keeps its number', { skip: d1Skip }, async () => {
  const e = env();
  const rosa = await signIn(e, { login: 'rosa', id: 7 });
  const zed = await signIn(e, { login: 'bakery', id: 9 });
  // Number 9 gave "bakery" up on GitHub, and Rosa took it.
  const renamed = await signIn(e, { login: 'bakery', id: 7 });
  assert.equal(renamed.res.status, 302);
  assert.equal(renamed.sess.account_id, rosa.sess.account_id);
  assert.deepEqual(account(e, rosa.sess.account_id), { id: rosa.sess.account_id, github_login: 'bakery', github_id: 7 });
  assert.deepEqual(account(e, zed.sess.account_id), { id: zed.sess.account_id, github_login: null, github_id: 9 });
  const back = await signIn(e, { login: 'zed', id: 9 });
  assert.equal(back.sess.account_id, zed.sess.account_id);
  assert.deepEqual(account(e, zed.sess.account_id), { id: zed.sess.account_id, github_login: 'zed', github_id: 9 });
});

test('an account from before the change is found by its login once and gets the number, and after that the old login does not reach it', { skip: d1Skip }, async () => {
  const e = env();
  addSite(e);   // 'acct-1', login 'ada', no number: the account the harness starts with
  assert.deepEqual(account(e, 'acct-1'), { id: 'acct-1', github_login: 'ada', github_id: null });
  const ada = await signIn(e, { login: 'ada', id: 41 });
  assert.equal(ada.sess.account_id, 'acct-1');
  assert.deepEqual(account(e, 'acct-1'), { id: 'acct-1', github_login: 'ada', github_id: 41 });
  // Ada renames. Somebody else takes "ada" and signs in, before Ada has come back.
  const other = await signIn(e, { login: 'ada', id: 99 });
  assert.notEqual(other.sess.account_id, 'acct-1');
  assert.deepEqual((await dashboard(e, other.sid)).sites, []);
  assert.deepEqual(account(e, 'acct-1'), { id: 'acct-1', github_login: null, github_id: 41 });
  const back = await signIn(e, { login: 'ada-l', id: 41 });
  assert.equal(back.sess.account_id, 'acct-1');
  assert.deepEqual((await dashboard(e, back.sid)).sites.map(s => s.id), ['site-1']);
  assert.equal(accounts(e), 2);
});

test('a person with an account renames to the login of an account that never got a number: that account can be reached by nobody', { skip: d1Skip }, async () => {
  const e = env();
  const rosa = await signIn(e, { login: 'rosa', id: 7 });
  const renamed = await signIn(e, { login: 'ada', id: 7 });   // 'acct-1' carries "ada" and has no number
  assert.equal(renamed.sess.account_id, rosa.sess.account_id, 'Rosa has her own account and is not given the other one');
  assert.deepEqual(account(e, 'acct-1'), { id: 'acct-1', github_login: null, github_id: null });
  // Rosa moves on, and a third person takes "ada": they do not reach the old account either.
  await signIn(e, { login: 'rosa', id: 7 });
  const third = await signIn(e, { login: 'ada', id: 99 });
  assert.notEqual(third.sess.account_id, 'acct-1');
  assert.notEqual(third.sess.account_id, rosa.sess.account_id);
});

test('GitHub gives no number: an account without a number is found by its login as before, and an account with a number is never reached', { skip: d1Skip }, async () => {
  const e = env();
  const ada = await signIn(e, { login: 'ada' });
  assert.equal(ada.sess.account_id, 'acct-1');
  assert.deepEqual(account(e, 'acct-1'), { id: 'acct-1', github_login: 'ada', github_id: null });
  const rosa = await signIn(e, { login: 'rosa', id: 7 });
  const before = accounts(e);
  const unnumbered = await signIn(e, { login: 'rosa' });
  assert.equal(unnumbered.sid, null, 'no session');
  assert.equal(unnumbered.res.headers.get('Location'), 'https://app.example/?signin=again', 'the person is sent back to the dashboard to try again');
  assert.equal(accounts(e), before);
  assert.deepEqual(account(e, rosa.sess.account_id), { id: rosa.sess.account_id, github_login: 'rosa', github_id: 7 });
});

test('a database migration 0012 has not reached: an account is found by its login, as before', { skip: d1Skip }, async () => {
  const e = env({ d1: { upTo: 11 } });
  assert.equal(e.kiln_cloud.db.prepare('PRAGMA table_info(accounts)').all().some(c => c.name === 'github_id'), false, 'no column for the number');
  const first = await signIn(e, { login: 'rosa', id: 7 });
  assert.equal(first.res.status, 302);
  assert.equal(first.sess.login, 'rosa');
  const again = await signIn(e, { login: 'rosa', id: 7 });
  assert.equal(again.sess.account_id, first.sess.account_id);
  assert.equal((await signIn(e, { login: 'ada', id: 41 })).sess.account_id, 'acct-1');
  assert.equal((await signIn(e, { login: 'rosa', id: 9 })).sess.account_id, first.sess.account_id, 'by login alone, as it was');
  assert.equal(accounts(e), 2);
});
