/**
 * Kiln keeps the files, part C: the owner of a site whose files Kiln keeps has
 * no GitHub account, and edits the site all the same. POST /cloud/sites/editor
 * gives them an owner session with no GitHub token in it; every place that
 * checks an owner session takes it for its own repository and for no other;
 * the /gh proxy reads and writes with the app's installation token and puts
 * the person on each change as its author.
 *
 * Nothing here touches the network: the real handlers run over a SQLite-backed
 * D1 stand-in and a stand-in GitHub that answers only what carries the app's
 * installation token, so a call made "as a person" would fail the test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { fakeKV, withFetch, jsonRes, b64 } from './worker-harness.js';
import { cloudEnv, addSite, d1Skip } from './d1-fake.js';

/** A real RSA key, so the worker can sign its App token when it has to ask for a new installation token. */
const { privateKey } = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const PK8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', privateKey)).toString('base64');

const REPO = 'kiln-sites/oak-bakery-1a2b3c4d';
const OTHER = 'kiln-sites/elm-cafe-5e6f7a8b';
const SITE = 'https://oak-bakery-1a2b3c4d.kiln-sites.workers.dev';
const OTHER_SITE = 'https://elm-cafe-5e6f7a8b.kiln-sites.workers.dev';
const ROSA = { sub: 'g-1001', email: 'rosa@example.com', name: 'Rosa Diaz' };
const OMAR = { sub: 'g-2002', email: 'omar@example.com', name: 'Omar Haddad' };
const DAY = 86400 * 1000;
const PLAN_ENDED = "This site's Kiln plan has ended, so nothing can be published through Kiln until it is renewed.";

/** GitHub, as far as a kept owner's editing needs it. `stale` is how many file reads with the first token it turns down; `dead` turns down every call. */
function fakeHub() {
  const hub = { stale: 0, dead: false, minted: 0 };
  hub.handler = async (url, init) => {
    const u = new URL(url);
    if (u.hostname !== 'api.github.com') return undefined;
    const p = u.pathname, m = init.method;
    const auth = (init.headers && init.headers.Authorization) || '';
    if (p === `/repos/${REPO}/installation` && m === 'GET') return jsonRes({ id: 77 });
    if (p === '/app/installations/77/access_tokens' && m === 'POST') { hub.minted++; return jsonRes({ token: `inst-${hub.minted + 1}` }, 201); }
    const tok = /^Bearer (inst-\d+)$/.exec(auth);
    if (!tok || hub.dead) return jsonRes({ message: 'Bad credentials' }, 401);   // nothing is ever asked as a person
    if (!p.startsWith(`/repos/${REPO}`)) return jsonRes({ message: 'Not Found' }, 404);
    const rest = p.slice(`/repos/${REPO}`.length);
    if (hub.stale > 0 && tok[1] === 'inst-1' && rest.startsWith('/contents/')) { hub.stale--; return jsonRes({ message: 'Bad credentials' }, 401); }
    if (rest === '' && m === 'GET') return jsonRes({ id: 9001, full_name: REPO, private: true, permissions: { push: true } });
    if (rest.startsWith('/contents/') && m === 'GET') return jsonRes({ path: rest.slice(10), sha: 'file-1', content: b64('<h1>Oak Bakery</h1>'), encoding: 'base64' });
    if (rest.startsWith('/contents/') && (m === 'PUT' || m === 'DELETE')) return jsonRes({ content: { sha: 'file-2' }, commit: { sha: 'commit-2' } });
    if (rest === '/git/commits' && m === 'POST') return jsonRes({ sha: 'commit-3' }, 201);
    return jsonRes({ message: 'Not Found' }, 404);
  };
  return hub;
}

function person(env, token, who, id) {
  env.kiln_cloud.exec('INSERT INTO accounts (id, github_login, email, name, google_sub, created_at) VALUES (?, NULL, ?, ?, ?, 1)', id, who.email, who.name, who.sub);
  env.KILN.map.set(`csess:${token}`, JSON.stringify({ account_id: id, login: null, uid: null, gh: null, google: who }));
}

/**
 * Rosa (token 'rosa') and Omar (token 'omar') signed in with Google, each with
 * a site Kiln keeps; ada (token 'tok') signed in with GitHub, with a site in a
 * repository of her own. Rosa's site is up on Kiln's hosting unless `hosted` is false.
 */
function world({ status = 'active', hosted = true } = {}) {
  const env = cloudEnv(fakeKV(), {
    CLOUD_DASHBOARD: 'https://app.example', KEEP_ORG: 'kiln-sites',
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
  return { env, hub: fakeHub() };
}

const answer = async (res, calls) => ({ status: res.status, json: await res.json().catch(() => null), calls });
/** The dashboard asks the service, signed in as `token`. */
const dash = (w, pathname, body, token = 'rosa') => withFetch(w.hub.handler, async (calls) => answer(await worker.fetch(new Request(`https://worker.example${pathname}`, {
  method: 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}), w.env), calls));
/** The editor at a site's address asks the service, with an owner session. */
const site = (w, method, pathname, { session, body, origin = SITE } = {}) => withFetch(w.hub.handler, async (calls) => {
  const init = { method, headers: { Origin: origin, ...(session ? { 'X-Kiln-Session': session } : {}) } };
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
  return answer(await worker.fetch(new Request(`https://worker.example${pathname}`, init), w.env), calls);
});
const github = (calls) => calls.filter(c => c.url.startsWith('https://api.github.com/'));
/**
 * What was asked of GitHub beyond the one look the service takes, with the
 * installation token, at which repository answers to the session's name (it
 * does so for every owner session, and remembers the answer).
 */
const beyondIdentity = (calls) => github(calls).filter(c => !(c.method === 'GET' && c.url === `https://api.github.com/repos/${REPO}` && /^Bearer inst-\d+$/.test(c.headers.Authorization)));
const sessions = (env) => [...env.KILN.map.keys()].filter(k => k.startsWith('osess:'));
const record = (env, id) => env.KILN.get(`osess:${id}`, 'json');
const plain = (t) => {
  assert.equal(typeof t, 'string');
  assert.equal(/[{}<>]|undefined|null\b|—|–/.test(t), false, `a plain sentence: ${t}`);
  assert.match(t, /\.$/, `a whole sentence: ${t}`);
};

/** Press "Open the editor" as Rosa: the answer, and what the small file every visitor loads would read from the address. */
async function open(w, token = 'rosa', id = 'site-k') {
  const r = await dash(w, '/cloud/sites/editor', { id }, token);
  if (r.status !== 200) return r;
  const m = /^#kiln-owner=([a-f0-9]{64})&kiln-login=([^&]*)&kiln-exp=(\d+)$/.exec(new URL(r.json.url).hash);
  assert.ok(m, `the address carries the session the way the loader reads it: ${r.json.url}`);
  return { ...r, session: m[1], login: decodeURIComponent(m[2]), exp: Number(m[3]), record: await record(w.env, m[1]) };
}

test('the owner of a site Kiln keeps opens its editor: the answer is the site\'s address with an owner session that holds no GitHub token and lasts 30 days', { skip: d1Skip }, async () => {
  const w = world();
  const before = Date.now();
  const r = await open(w);
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.json).sort(), ['ok', 'url']);
  assert.equal(r.json.ok, true);
  assert.ok(r.json.url.startsWith(`${SITE}/kiln#kiln-owner=`), r.json.url);
  assert.match(r.json.url, /&kiln-login=Rosa%20Diaz&kiln-exp=\d+$/, 'a space in the name is %20: the loader reads it with decodeURIComponent');
  assert.equal(r.login, 'Rosa Diaz');

  const s = r.record;
  assert.deepEqual(Object.keys(s).sort(), ['account_id', 'created', 'email', 'kept', 'login', 'origin', 'repo', 'rid', 'v']);
  assert.deepEqual({ ...s, created: 0 }, { v: 1, kept: true, account_id: 'acct-g', login: 'Rosa Diaz', email: 'rosa@example.com', repo: REPO, rid: 9001, origin: SITE, created: 0 });
  assert.ok(s.created >= before && s.created <= Date.now());
  assert.equal(r.exp, s.created + 30 * DAY, 'thirty days from the moment it was made');

  // GitHub was asked for the repository's id, with the app's installation token and nothing else.
  const asked = github(r.calls);
  assert.ok(asked.some(c => c.method === 'GET' && c.url === `https://api.github.com/repos/${REPO}`));
  for (const c of asked) assert.equal(c.headers.Authorization, 'Bearer inst-1', `${c.method} ${c.url}`);

  // An account with no name on it goes by the part of its email before the @.
  const w2 = world();
  w2.env.kiln_cloud.exec('UPDATE accounts SET name = NULL WHERE id = ?', 'acct-g');
  w2.env.KILN.map.set('csess:rosa', JSON.stringify({ account_id: 'acct-g', login: null, uid: null, gh: null, google: { sub: ROSA.sub, email: ROSA.email } }));
  assert.equal((await open(w2)).record.login, 'rosa');
});

test('nobody else gets a session for it: another Google account, a GitHub account and a visitor who is not signed in are all refused, and nothing is made', { skip: d1Skip }, async () => {
  const w = world();
  const omar = await open(w, 'omar');
  assert.equal(omar.status, 403);
  assert.equal(omar.json.code, 'needs_github');
  const ada = await open(w, 'tok');
  assert.equal(ada.status, 404);
  assert.equal(ada.json.code, 'no_such_site');
  assert.equal((await open(w, null)).status, 401);
  assert.equal((await open(w, 'rosa', 'site-o')).status, 403, 'and Rosa gets none for Omar\'s site');
  assert.deepEqual(sessions(w.env), []);
});

test('a site whose files are in its owner\'s own GitHub repository is not opened this way, and the sentence says where its editor is', { skip: d1Skip }, async () => {
  const w = world();
  const r = await open(w, 'tok', 'site-1');
  assert.equal(r.status, 403);
  assert.equal(r.json.code, 'not_kept');
  plain(r.json.error);
  assert.match(r.json.error, /sign in with GitHub there\.$/);
  assert.deepEqual(sessions(w.env), []);
  assert.equal(github(r.calls).length, 0);
});

test('a site that is not up on Kiln\'s hosting yet, and a site whose plan has ended, are refused in a sentence that says what to do', { skip: d1Skip }, async () => {
  const notUp = world({ hosted: false });
  const a = await open(notUp);
  assert.equal(a.status, 409);
  assert.equal(a.json.code, 'not_up');
  assert.equal(a.json.error, "Your site is not up yet. Press Put it on Kiln's hosting on the site's row first, then open the editor.");
  assert.deepEqual(sessions(notUp.env), []);

  const ended = world({ status: 'canceled' });
  const b = await open(ended);
  assert.equal(b.status, 403);
  assert.equal(b.json.code, 'plan_ended');
  plain(b.json.error);
  assert.match(b.json.error, /^Editing is switched off for this site/);
  assert.deepEqual(sessions(ended.env), []);
  assert.equal(github(b.calls).length, 0);
});

test('/auth/session answers as for an owner and says the session is a kept one; it is good at its own address only, and after 30 days it is over', { skip: d1Skip }, async () => {
  const w = world();
  const r = await open(w);
  const a = await site(w, 'GET', '/auth/session', { session: r.session });
  assert.equal(a.status, 200);
  assert.deepEqual(a.json, { ok: true, role: 'owner', login: 'Rosa Diaz', repo: REPO, exp: r.exp, kept: true });
  assert.equal(github(a.calls).length, 0, 'GitHub is not asked who a kept owner is');

  const elsewhere = await site(w, 'GET', '/auth/session', { session: r.session, origin: 'https://club.example' });
  assert.equal(elsewhere.status, 403);
  assert.equal(elsewhere.json.code, 'owner_origin');
  plain(elsewhere.json.error);

  await w.env.KILN.put(`osess:${r.session}`, JSON.stringify({ ...r.record, created: Date.now() - 30 * DAY - 1000 }));
  const late = await site(w, 'GET', '/auth/session', { session: r.session });
  assert.equal(late.status, 401);
  assert.equal(late.json.code, 'signin_ended');
  assert.equal(late.json.error, 'Your sign-in has ended. Open the editor again from your Kiln dashboard to keep editing.');
  assert.equal(await record(w.env, r.session), null);
});

test('reading and saving go to GitHub with the app\'s installation token, and a save carries the person as its author', { skip: d1Skip }, async () => {
  const w = world();
  const { session } = await open(w);

  const read = await site(w, 'GET', `/gh/repos/${REPO}/contents/index.html?ref=main`, { session });
  assert.equal(read.status, 200);
  assert.equal(read.json.sha, 'file-1');
  assert.deepEqual(beyondIdentity(read.calls).map(c => `${c.method} ${c.url} ${c.headers.Authorization}`), [`GET https://api.github.com/repos/${REPO}/contents/index.html?ref=main Bearer inst-1`]);

  const somebody = { name: 'Somebody Else', email: 'else@example.com' };
  const save = await site(w, 'PUT', `/gh/repos/${REPO}/contents/index.html`, { session, body: { message: 'Update the home page', content: b64('<h1>Hello</h1>'), sha: 'file-1', branch: 'main', author: somebody, committer: somebody } });
  assert.equal(save.status, 200);
  const put = github(save.calls).find(c => c.method === 'PUT');
  assert.equal(put.headers.Authorization, 'Bearer inst-1');
  assert.deepEqual(put.body.author, { name: 'Rosa Diaz (via Kiln)', email: 'rosa@example.com' });
  assert.equal('committer' in put.body, false, 'the committer stays the Kiln bot');
  assert.equal(put.body.message, 'Update the home page');
  assert.equal(put.body.sha, 'file-1');

  const commit = await site(w, 'POST', `/gh/repos/${REPO}/git/commits`, { session, body: { message: 'Three pages at once', tree: 'tree-1', parents: ['commit-2'] } });
  assert.equal(commit.status, 201);
  assert.deepEqual(github(commit.calls).find(c => c.method === 'POST').body.author, { name: 'Rosa Diaz (via Kiln)', email: 'rosa@example.com' });

  const remove = await site(w, 'DELETE', `/gh/repos/${REPO}/contents/old.html`, { session, body: { message: 'Remove a page', sha: 'file-1', branch: 'main' } });
  assert.equal(remove.status, 200);
  assert.equal(github(remove.calls).find(c => c.method === 'DELETE').body.author.name, 'Rosa Diaz (via Kiln)');
  for (const c of [...github(save.calls), ...github(commit.calls), ...github(remove.calls)]) assert.equal(c.headers.Authorization, 'Bearer inst-1');
});

test('GET /user is answered by the service itself, with the person\'s name and no GitHub id', { skip: d1Skip }, async () => {
  const w = world();
  const { session } = await open(w);
  const r = await site(w, 'GET', '/gh/user', { session });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { login: 'Rosa Diaz', name: 'Rosa Diaz', id: null, kept: true });
  assert.equal(github(r.calls).length, 0);
});

test('a kept session reaches its own repository\'s files and nothing else: another repository, the repository itself, its settings and its workflows are refused before GitHub is asked', { skip: d1Skip }, async () => {
  const w = world();
  const { session } = await open(w);
  const refused = [
    ['GET', `/gh/repos/${OTHER}/contents/index.html`],
    ['GET', '/gh/repos/ada/club/contents/index.html'],
    ['PUT', `/gh/repos/${OTHER}/contents/index.html`, { message: 'm', content: b64('x') }],
    ['GET', '/gh/user/repos'],
    ['POST', '/gh/user'],
    ['DELETE', `/gh/repos/${REPO}`],
    ['PATCH', `/gh/repos/${REPO}`, { name: 'mine-now', private: false }],
    ['POST', `/gh/repos/${REPO}/transfer`, { new_owner: 'somebody' }],
    ['POST', `/gh/repos/${REPO}/hooks`, { config: { url: 'https://elsewhere.example' } }],
    ['PUT', `/gh/repos/${REPO}/collaborators/somebody`, {}],
    ['DELETE', `/gh/repos/${REPO}/git/refs/heads/main`],
    ['PUT', `/gh/repos/${REPO}/contents/.github/workflows/build.yml`, { message: 'm', content: b64('on: push') }],
    ['POST', `/gh/repos/${REPO}/git/trees`, { tree: [{ path: '.github/workflows/build.yml', mode: '100644', type: 'blob', sha: 'b1' }] }],
  ];
  for (const [method, pathname, body] of refused) {
    const r = await site(w, method, pathname, { session, body });
    assert.equal(r.status, 403, `${method} ${pathname}`);
    assert.equal(r.json.code, 'owner_scope', `${method} ${pathname}`);
    assert.equal(beyondIdentity(r.calls).length, 0, `${method} ${pathname} never reached GitHub`);
  }
  assert.ok(await record(w.env, session), 'and the session is still there');
});

test('a 401 from GitHub is about the service\'s own token: it is dropped, a new one is asked for, the call is made once more, and the person stays signed in', { skip: d1Skip }, async () => {
  const w = world();
  const { session } = await open(w);
  w.hub.stale = 1;
  const r = await site(w, 'GET', `/gh/repos/${REPO}/contents/index.html`, { session });
  assert.equal(r.status, 200);
  const reads = github(r.calls).filter(c => c.url.endsWith('/contents/index.html')).map(c => c.headers.Authorization);
  assert.deepEqual(reads, ['Bearer inst-1', 'Bearer inst-2']);
  assert.equal(await w.env.KILN.get(`itok:${REPO}`), 'inst-2');
  assert.ok(await record(w.env, session));
  assert.equal((await site(w, 'GET', '/auth/session', { session })).status, 200);

  // GitHub turning down every token still ends nothing: the person is asked to try again.
  w.hub.dead = true;
  const down = await site(w, 'GET', `/gh/repos/${REPO}/contents/index.html`, { session });
  assert.equal(down.status, 502);
  assert.equal(down.json.code, 'github_unreachable');
  plain(down.json.error);
  assert.equal(github(down.calls).filter(c => c.url.endsWith('/contents/index.html')).length, 2, 'tried once more, and no more than that');
  assert.ok(await record(w.env, session));
});

test('the session stands only while the site does: once the site\'s row is gone the session is removed and the person is told they are signed out', { skip: d1Skip }, async () => {
  const w = world();
  const { session } = await open(w);
  assert.equal((await site(w, 'GET', '/auth/session', { session })).status, 200);
  w.env.kiln_cloud.exec('DELETE FROM sites WHERE id = ?', 'site-k');
  // The yes is remembered for a minute, so that editing is not a database read
  // on every call. Inside that minute the address is already no site of
  // Kiln's, so nothing is reached; after it the session itself is removed.
  const remembered = [...w.env.KILN.map.keys()].filter(k => k.startsWith('keptup:'));
  assert.deepEqual(remembered, [`keptup:acct-g:${REPO}`]);
  const inside = await site(w, 'GET', `/gh/repos/${REPO}/contents/index.html`, { session });
  assert.equal(inside.status, 403);
  assert.equal(inside.json.code, 'origin_refused');
  assert.equal(github(inside.calls).length, 0);
  await w.env.KILN.delete(remembered[0]);   // the minute is over
  const r = await site(w, 'GET', `/gh/repos/${REPO}/contents/index.html`, { session });
  assert.equal(r.status, 401);
  assert.equal(r.json.code, 'signin_ended');
  plain(r.json.error);
  assert.equal(github(r.calls).length, 0);
  assert.equal(await record(w.env, session), null);

  // The same when the site is no longer a kept one of that account.
  const w2 = world();
  const two = await open(w2);
  w2.env.kiln_cloud.exec("UPDATE sites SET account_id = 'acct-o' WHERE id = ?", 'site-k');
  for (const k of [...w2.env.KILN.map.keys()].filter(k => k.startsWith('keptup:'))) await w2.env.KILN.delete(k);
  assert.equal((await site(w2, 'GET', '/auth/session', { session: two.session })).status, 401);
  assert.equal(await record(w2.env, two.session), null);
});

test('when the plan has ended, a kept owner can still read the site and nothing they send is written', { skip: d1Skip }, async () => {
  const w = world();
  const { session } = await open(w);
  w.env.kiln_cloud.exec("UPDATE sites SET status = 'canceled' WHERE id = ?", 'site-k');

  const save = await site(w, 'PUT', `/gh/repos/${REPO}/contents/index.html`, { session, body: { message: 'm', content: b64('x'), sha: 'file-1' } });
  assert.equal(save.status, 403);
  assert.deepEqual(save.json, { error: PLAN_ENDED, code: 'plan_ended' });
  assert.equal(beyondIdentity(save.calls).length, 0);

  const read = await site(w, 'GET', `/gh/repos/${REPO}/contents/index.html`, { session });
  assert.equal(read.status, 200);
  assert.equal(read.json.sha, 'file-1');
  assert.equal((await site(w, 'GET', '/auth/session', { session })).status, 200);

  const people = await site(w, 'GET', `/admin/people?repo=${REPO}`, { session });
  assert.equal(people.status, 403);
  assert.deepEqual(people.json, { error: PLAN_ENDED, code: 'plan_ended' });
});

test('the People list answers a kept owner for their own repository without asking GitHub, and for no other repository', { skip: d1Skip }, async () => {
  const w = world();
  const { session } = await open(w);
  const mine = await site(w, 'GET', `/admin/people?repo=${REPO}`, { session });
  assert.equal(mine.status, 200);
  assert.equal(beyondIdentity(mine.calls).length, 0, 'GitHub is not asked whether a kept owner may change the repository');
  for (const repo of [OTHER, 'ada/club']) {
    const r = await site(w, 'GET', `/admin/people?repo=${repo}`, { session });
    assert.equal(r.status, 403, repo);
    assert.equal(beyondIdentity(r.calls).length, 0, repo);
  }
});

test('a change a kept owner schedules is filed under their own name and account, and signing out removes the session', { skip: d1Skip }, async () => {
  const w = world();
  const { session } = await open(w);
  const r = await site(w, 'POST', '/schedule', { session, body: { repo: REPO, path: 'index.html', branch: 'main', content: b64('<h1>Soon</h1>'), at: new Date(Date.now() + 3600 * 1000).toISOString(), desc: 'Home' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(beyondIdentity(r.calls).length, 0);
  const filed = [...w.env.KILN.map.keys()].filter(k => k.startsWith('sched:'));
  assert.equal(filed.length, 1);
  const v = await w.env.KILN.get(filed[0], 'json');
  assert.deepEqual({ by: v.by, byEmail: v.byEmail, admin: v.admin, kept: v.kept, repo: v.repo }, { by: 'Rosa Diaz', byEmail: 'rosa@example.com', admin: true, kept: 'acct-g', repo: REPO });

  const out = await site(w, 'POST', '/auth/logout', { session });
  assert.equal(out.status, 200);
  assert.equal(await record(w.env, session), null);
  assert.equal((await site(w, 'GET', '/auth/session', { session })).status, 401);
});

test('an owner who signed in with GitHub is asked about and forwarded exactly as before: their own token, 180 days, and no word about kept', { skip: d1Skip }, async () => {
  const w = world();
  const id = 'c'.repeat(64);
  const created = Date.now();
  await w.env.KILN.put(`osess:${id}`, JSON.stringify({ v: 1, token: 'gho_ada', token_exp: null, refresh_token: null, login: 'ada', uid: 5, repo: 'ada/club', rid: 31, origin: 'https://club.example', created }));
  const who = await site(w, 'GET', '/auth/session', { session: id, origin: 'https://club.example' });
  assert.deepEqual(who.json, { ok: true, role: 'owner', login: 'ada', repo: 'ada/club', exp: created + 180 * DAY });
  const seen = [];
  const hub = { handler: async (url, init) => {
    if (url !== 'https://api.github.com/user') return jsonRes({ message: 'Not Found' }, 404);
    seen.push(`${init.method} ${url} ${init.headers.Authorization}`);
    return jsonRes({ login: 'ada', id: 5 });
  } };
  const user = await site({ env: w.env, hub }, 'GET', '/gh/user', { session: id, origin: 'https://club.example' });
  assert.equal(user.status, 200);
  assert.deepEqual(user.json, { login: 'ada', id: 5 });
  assert.deepEqual(seen, ['GET https://api.github.com/user Bearer gho_ada']);
});

test('what a kept owner scheduled goes out with the installation token and in their name while the site stands, and never once its row is gone', { skip: d1Skip }, async () => {
  const w = world();
  const { session } = await open(w);
  const make = async () => {
    await site(w, 'POST', '/schedule', { session, body: { repo: REPO, path: 'index.html', branch: 'main', content: b64('<h1>Soon</h1>'), at: new Date(Date.now() + 3600 * 1000).toISOString(), desc: 'Home' } });
    const key = [...w.env.KILN.map.keys()].find(k => k.startsWith('sched:'));
    await w.env.KILN.put(key, JSON.stringify({ ...(await w.env.KILN.get(key, 'json')), at: Date.now() - 1000 }));   // its time has come
    return key;
  };
  const tick = () => withFetch(w.hub.handler, async (calls) => { await worker.scheduled({}, w.env, { waitUntil() {} }); return calls; });

  const first = await make();
  const puts = github(await tick()).filter(c => c.method === 'PUT');
  assert.equal(puts.length, 1);
  assert.equal(puts[0].url, `https://api.github.com/repos/${REPO}/contents/index.html`);
  assert.match(puts[0].headers.Authorization, /^(Bearer|token) inst-1$/);
  assert.deepEqual(puts[0].body.author, { name: 'Rosa Diaz (via Kiln, scheduled)', email: 'rosa@example.com' });
  assert.equal(await w.env.KILN.get(first), null, 'published, so it waits no longer');

  const second = await make();
  w.env.kiln_cloud.exec('DELETE FROM sites WHERE id = ?', 'site-k');
  for (const k of [...w.env.KILN.map.keys()].filter(k => k.startsWith('keptup:'))) await w.env.KILN.delete(k);
  const after = github(await tick());
  assert.equal(after.filter(c => c.method !== 'GET').length, 0, 'nothing is written for a site that is gone');
  assert.equal(await w.env.KILN.get(second), null, 'and the change is not left waiting');
});
