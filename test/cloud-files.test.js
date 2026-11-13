/**
 * Leaving Kiln's hosting: the owner of a site whose files Kiln keeps takes the
 * files along without writing to anyone. GET /cloud/sites/files?site= answers
 * with GitHub's own short-lived link to one zip of the site's repository and a
 * name for the file. It is for a kept site of the account that asks, and only
 * once that site has been paid for, where a site can be paid for at all.
 *
 * Nothing here touches the network: the real handlers run over a SQLite-backed
 * D1 stand-in and a stand-in GitHub that answers only what carries the second
 * app's token.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import worker from '../worker/index.js';
import { keptFilesName } from '../worker/keeps.js';
import { fakeKV, withFetch, jsonRes } from './worker-harness.js';
import { cloudEnv, addSite, d1Skip } from './d1-fake.js';

const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const REPO = 'kiln-sites/oak-bakery-1a2b3c4d';
const SITE = 'https://oak-bakery-1a2b3c4d.kiln-sites.workers.dev';
const LINK = 'https://codeload.github.com/kiln-sites/oak-bakery-1a2b3c4d/legacy.zip/refs/heads/main?token=SECRET-LINK-TOKEN';
const ROSA = { sub: 'g-1001', email: 'rosa@example.com', name: 'Rosa Diaz' };
const DAY = 86400 * 1000;
const PAID_FIRST = "You can download this site's files once the site has been paid for. Subscribe on the site's row first.";

/** GitHub, as far as handing over a zip needs it. `dead` answers every call for the repository with a fault; `branch` is its default branch. */
function fakeHub() {
  const hub = { dead: false, branch: 'main', minted: 0, zips: [] };
  hub.handler = async (url, init) => {
    const u = new URL(url);
    if (u.hostname !== 'api.github.com') return undefined;
    const p = u.pathname, m = init.method, auth = (init.headers && init.headers.Authorization) || '';
    if (p === '/orgs/kiln-sites/installation' && m === 'GET') return jsonRes({ id: 77 });
    if (p === '/app/installations/77/access_tokens' && m === 'POST') { hub.minted++; return jsonRes({ token: 'keep-token' }, 201); }
    if (auth !== 'Bearer keep-token') return jsonRes({ message: 'Bad credentials' }, 401);   // everything else is asked with the second app's token
    if (hub.dead) return jsonRes({ message: 'Server Error' }, 500);
    if (p === `/repos/${REPO}` && m === 'GET') return jsonRes({ full_name: REPO, private: true, default_branch: hub.branch });
    if (p === `/repos/${REPO}/zipball/${hub.branch}` && m === 'GET') {
      hub.zips.push({ redirect: init.redirect });
      return new Response(null, { status: 302, headers: { Location: LINK } });
    }
    return jsonRes({ message: 'Not Found' }, 404);
  };
  return hub;
}

/** A service that keeps sites. Rosa (token 'rosa', signed in with Google) has the kept site 'kept1'; ada (token 'tok', GitHub) has 'site-1' in her own repository. */
function world({ env: extra = {}, site = {}, token = 'keep-token' } = {}) {
  const hub = fakeHub();
  const notes = [];
  const env = cloudEnv(fakeKV(), {
    CLOUD_DASHBOARD: 'https://app.example', KEEP_ORG: 'kiln-sites', KEEP_APP_ID: '4242', KEEP_APP_KEY: PEM,
    HOSTING_ACCOUNT_ID: 'cf-acct', HOSTING_API_TOKEN: 'cf-token', HOSTING_SUBDOMAIN: 'kiln-sites',
    NOTIFY: { send: async (m) => { notes.push(m.raw); } }, NOTIFY_TO: 'ops@example.com', ...extra,
  });
  env.kiln_cloud.exec('INSERT INTO accounts (id, github_login, email, name, google_sub, google_email, created_at) VALUES (?, NULL, ?, ?, ?, ?, 1)', 'acct-g', ROSA.email, ROSA.name, ROSA.sub, ROSA.email);
  env.KILN.map.set('csess:rosa', JSON.stringify({ account_id: 'acct-g', login: null, uid: null, gh: null, google: ROSA }));
  addSite(env, { id: 'kept1', account_id: 'acct-g', repo: REPO, origin: SITE, plan: 'managed', status: 'active', ls_subscription_id: 'sub-1', ...site });
  env.kiln_cloud.exec("UPDATE sites SET kept = 1, name = 'Oak Bakery' WHERE id = 'kept1'");
  addSite(env, { id: 'site-1', ls_subscription_id: 'sub-2' });   // ada/club, in ada's own repository
  if (token) env.KILN.map.set('keeptok:kiln-sites:4242', token);   // the token the service holds for the second app
  return { hub, env, notes };
}

/** One request for a site's files, with everything the service logged meanwhile. Answers { status, json, calls, logged }. */
async function files(w, site = 'kept1', token = 'rosa') {
  const logged = [];
  const real = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(real)) console[k] = (...a) => { logged.push(a.map(String).join(' ')); };
  try {
    return await withFetch(w.hub.handler, async (calls) => {
      const res = await worker.fetch(new Request(`https://worker.example/cloud/sites/files?site=${site}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} }), w.env);
      return { status: res.status, json: await res.json().catch(() => null), calls, logged };
    });
  } finally { Object.assign(console, real); }
}

test('files: the owner of a kept site that was paid for gets GitHub\'s link to one zip and a name for it, and the operator hears of it', { skip: d1Skip }, async () => {
  const w = world();
  const out = await files(w);
  assert.equal(out.status, 200);
  assert.deepEqual(out.json, { ok: true, url: LINK, name: 'Oak Bakery.zip' });
  // The zip is asked for at the repository's default branch, with the second app's token, and GitHub's answer is not followed.
  assert.deepEqual(out.calls.map(c => `${c.method} ${new URL(c.url).pathname}`), [`GET /repos/${REPO}`, `GET /repos/${REPO}/zipball/main`]);
  assert.deepEqual(w.hub.zips, [{ redirect: 'manual' }]);
  assert.ok(out.calls.every(c => c.headers.Authorization === 'Bearer keep-token'));
  // One line to the operator, which says whose files, and never the link.
  assert.equal(w.notes.length, 1);
  assert.match(w.notes[0], /oak-bakery-1a2b3c4d/);
  assert.match(w.notes[0], /rosa@example\.com/);
  for (const text of [...w.notes, ...out.logged]) assert.doesNotMatch(text, /SECRET-LINK-TOKEN|codeload/);
  // A second press within the hour gets a link again, and the operator is not written to a second time.
  const again = await files(w);
  assert.equal(again.status, 200);
  assert.equal(w.notes.length, 1);
});

test('files: a site with another default branch is asked for at that branch, and a site with no name is named after its repository', { skip: d1Skip }, async () => {
  const w = world();
  w.hub.branch = 'trunk';
  w.env.kiln_cloud.exec("UPDATE sites SET name = NULL WHERE id = 'kept1'");
  const out = await files(w);
  assert.deepEqual(out.json, { ok: true, url: LINK, name: 'oak-bakery-1a2b3c4d.zip' });
  assert.equal(new URL(out.calls.at(-1).url).pathname, `/repos/${REPO}/zipball/trunk`);
});

test('files: with editing switched off the files can still be taken', { skip: d1Skip }, async () => {
  const w = world({ site: { status: 'canceled' } });
  w.env.kiln_cloud.exec("UPDATE sites SET access_until = ? WHERE id = 'kept1'", Date.now() - 3 * DAY);
  const out = await files(w);
  assert.equal(out.status, 200);
  assert.equal(out.json.url, LINK);
});

test('files: a site that has not been paid for is told to subscribe first, and GitHub is not asked', { skip: d1Skip }, async () => {
  const w = world({ site: { status: 'trialing', ls_subscription_id: null } });
  const out = await files(w);
  assert.equal(out.status, 403);
  assert.deepEqual(out.json, { error: PAID_FIRST, code: 'paid_first' });
  assert.equal(out.calls.length, 0);
  assert.equal(w.notes.length, 0);
});

test('files: where billing is not set up on the service, nobody could ever pay, so the download is open', { skip: d1Skip }, async () => {
  const w = world({ env: { LS_API_KEY: '' }, site: { status: 'trialing', ls_subscription_id: null } });
  const out = await files(w);
  assert.equal(out.status, 200);
  assert.deepEqual(out.json, { ok: true, url: LINK, name: 'Oak Bakery.zip' });
});

test('files: a site in its owner\'s own repository is refused in words that say where the files are', { skip: d1Skip }, async () => {
  const w = world();
  const out = await files(w, 'site-1', 'tok');
  assert.equal(out.status, 403);
  assert.equal(out.json.code, 'not_kept');
  assert.match(out.json.error, /^This site's files are in a GitHub repository of your own, so there is nothing to download here\. /);
  assert.doesNotMatch(out.json.error, /\brepo\b|—/);
  assert.equal(out.calls.length, 0);
  assert.equal(w.notes.length, 0);
});

test('files: another account\'s kept site is not found, and nobody who is not signed in is answered', { skip: d1Skip }, async () => {
  const w = world();
  const ada = await files(w, 'kept1', 'tok');
  assert.equal(ada.status, 404);
  assert.equal(ada.json.code, 'no_such_site');
  const nobody = await files(w, 'kept1', null);
  assert.equal(nobody.status, 401);
  const unknown = await files(w, 'no-such-site');
  assert.equal(unknown.status, 403);   // signed in with Google: only a kept site of their own is reached
  assert.equal(unknown.json.code, 'needs_github');
  assert.equal(ada.calls.length + nobody.calls.length + unknown.calls.length, 0);
  assert.equal(w.notes.length, 0);
});

test('files: when GitHub does not answer the owner is told to try again, and the operator is not told of a download', { skip: d1Skip }, async () => {
  const w = world();
  w.hub.dead = true;
  const out = await files(w);
  assert.equal(out.status, 502);
  assert.deepEqual(out.json, { error: 'GitHub did not answer just now, so Kiln could not get your files ready. Nothing was changed. Try again in a few minutes.', code: 'github' });
  assert.equal(w.notes.length, 0);
  assert.ok(out.logged.some(l => /kept_files_failed/.test(l)), 'the fault leaves a line for the operator');
});

test('files: a token that stopped working early is forgotten and a new one is asked for, once', { skip: d1Skip }, async () => {
  const w = world({ token: 'old-token' });
  const out = await files(w);
  assert.equal(out.status, 200);
  assert.equal(out.json.url, LINK);
  assert.equal(w.hub.minted, 1);
  assert.equal(w.env.KILN.map.get('keeptok:kiln-sites:4242'), 'keep-token');
});

test('files: the name of the file is what the owner called the site, without anything a computer refuses in a file name', () => {
  assert.equal(keptFilesName({ name: 'Oak Bakery', repo: REPO }), 'Oak Bakery.zip');
  assert.equal(keptFilesName({ name: 'Oak/Bakery: "Best" <2026>?', repo: REPO }), 'Oak Bakery Best 2026.zip');
  assert.equal(keptFilesName({ name: ' .. ', repo: REPO }), 'oak-bakery-1a2b3c4d.zip');
  assert.equal(keptFilesName({ name: '', repo: REPO }), 'oak-bakery-1a2b3c4d.zip');
  assert.equal(keptFilesName({}), 'site.zip');
  assert.equal(keptFilesName({ name: 'x'.repeat(200), repo: REPO }).length, 84);
});
