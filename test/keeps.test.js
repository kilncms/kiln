/**
 * Kiln keeps the files, part B: starting a site for someone with no GitHub
 * account (worker/keeps.js and its route, POST /cloud/sites/start). Kiln makes
 * a private repository in an organization of its own with a second GitHub
 * App's token, fills it with the starter site, writes the site's own settings
 * file, and registers it to the account that asked. Also here: who owns such a
 * site, what happens when it is removed, and what the dashboard is told.
 *
 * Nothing here touches the network: the real handlers run over a SQLite-backed
 * D1 stand-in and a stand-in GitHub, which answers only the calls the design
 * allows, wants the second app's token for all of them, and writes down
 * anything that would delete, rename or transfer a repository.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import worker from '../worker/index.js';
import { keepsOn, keepsReady, inKeepOrg, cleanName, siteSlug, keepKey, keepSentence, keptRemovedNote, STARTS_AN_HOUR } from '../worker/keeps.js';
import { siteName, siteAddress } from '../worker/hosting.js';
import { kilnConfigFile } from '../worker/prepare.js';
import { fakeKV, withFetch, jsonRes } from './worker-harness.js';
import { cloudEnv, addSite, d1Skip } from './d1-fake.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });       // "BEGIN PRIVATE KEY"
const OLD_PEM = privateKey.export({ type: 'pkcs1', format: 'pem' });   // "BEGIN RSA PRIVATE KEY", as GitHub hands a key out

const ROSA = { sub: 'g-1001', email: 'rosa@example.com', name: 'Rosa Diaz' };
const OMAR = { sub: 'g-2002', email: 'omar@example.com', name: 'Omar Haddad' };
const STARTER = {
  'index.html': Buffer.from('<!doctype html><title>Home</title><h1>Welcome</h1>'),
  'about.html': Buffer.from('<!doctype html><h1>About</h1>'),
  'assets/site.css': Buffer.from('h1 { color: teal }'),
  'assets/kiln.js': Buffer.from('/* the editor */'.repeat(20)),
  'assets/logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x00, 0xff, 0xfe]),
  'empty.txt': Buffer.from(''),
};
const JWT = /^Bearer ([\w-]+)\.([\w-]+)\.([\w-]+)$/;

/** GitHub, as far as starting a kept site needs it. `fail` breaks one step; `notReady` is how many looks find no first commit yet. */
function fakeHub({ fail = null, notReady = 0 } = {}) {
  const starter = new Map(Object.entries(STARTER).map(([path, bytes], i) => [`s${i}`, { path, bytes }]));
  const tree = [
    ...[...starter].map(([sha, f]) => ({ path: f.path, mode: '100644', type: 'blob', sha })),
    { path: 'assets', mode: '040000', type: 'tree', sha: 'dir-1' },
    { path: 'assets/kiln-config.js', mode: '100644', type: 'blob', sha: 's-config' },        // the demo's own settings, sandbox and all
    { path: '.github/workflows/deploy.yml', mode: '100644', type: 'blob', sha: 's-workflow' },
    { path: 'latest', mode: '120000', type: 'blob', sha: 's-link' },
  ];
  const hub = { repos: new Map(), made: [], read: [], unsafe: [], jwts: [], refAsks: 0 };
  hub.handler = async (url, init) => {
    const u = new URL(url);
    if (u.hostname !== 'api.github.com') return undefined;
    const p = u.pathname, m = init.method, auth = (init.headers && init.headers.Authorization) || '';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
    if (m === 'DELETE' || /\/transfer$/.test(p) || (m === 'PATCH' && /^\/repos\/[^/]+\/[^/]+$/.test(p))) { hub.unsafe.push(`${m} ${p}`); return jsonRes({}, 500); }
    if ((p === '/orgs/kiln-sites/installation' && m === 'GET') || (p === '/app/installations/77/access_tokens' && m === 'POST')) {
      if (!JWT.test(auth)) return jsonRes({ message: 'A JSON web token could not be decoded' }, 401);
      hub.jwts.push(auth.slice(7));
      return m === 'GET' ? jsonRes({ id: 77 }) : jsonRes({ token: 'keep-token' }, 201);
    }
    if (auth !== 'Bearer keep-token') return jsonRes({ message: 'Bad credentials' }, 401);   // everything else is asked with the second app's token
    if (p === '/orgs/kiln-sites/repos' && m === 'POST') {
      if (fail === 'create') return jsonRes({ message: 'Validation Failed' }, 422);
      const full = `kiln-sites/${body.name}`;
      hub.repos.set(full, { asked: body, blobs: new Map(), tree: null, commit: null, head: 'init-sha', n: 0 });
      hub.made.push(full);
      return jsonRes({ full_name: full, name: body.name, private: fail === 'public' ? false : body.private === true, default_branch: 'main' }, 201);
    }
    if (p === '/repos/kilncms/kiln-demo' && m === 'GET') return fail === 'starter' ? jsonRes({}, 404) : jsonRes({ default_branch: 'main' });
    if (p === '/repos/kilncms/kiln-demo/git/trees/main' && m === 'GET') return jsonRes({ truncated: false, tree });
    let hit = p.match(/^\/repos\/kilncms\/kiln-demo\/git\/blobs\/(.+)$/);
    if (hit && m === 'GET') {
      hub.read.push(hit[1]);
      const f = starter.get(hit[1]);
      return f ? jsonRes({ encoding: 'base64', content: f.bytes.toString('base64').replace(/(.{60})/g, '$1\n') }) : jsonRes({}, 404);
    }
    hit = p.match(/^\/repos\/(kiln-sites\/[^/]+)\/git\/(.+)$/);
    const repo = hit && hub.repos.get(hit[1]);
    if (!repo) return jsonRes({ message: 'Not Found' }, 404);
    if (hit[2] === 'ref/heads/main' && m === 'GET') return hub.refAsks++ < notReady ? jsonRes({ message: 'Git Repository is empty.' }, 409) : jsonRes({ object: { sha: repo.head } });
    if (hit[2] === 'blobs' && m === 'POST') {
      assert.equal(body.encoding, 'base64');
      const sha = `b${++repo.n}`;
      repo.blobs.set(sha, Buffer.from(body.content, 'base64'));
      return jsonRes({ sha }, 201);
    }
    if (hit[2] === 'trees' && m === 'POST') { repo.tree = body; return jsonRes({ sha: 'tree-1' }, 201); }
    if (hit[2] === 'commits' && m === 'POST') { if (fail === 'commit') return jsonRes({}, 500); repo.commit = body; return jsonRes({ sha: 'commit-1' }, 201); }
    if (hit[2] === 'refs/heads/main' && m === 'PATCH') { repo.head = body.sha; return jsonRes({ ref: 'refs/heads/main' }); }
    return jsonRes({ message: 'Not Found' }, 404);
  };
  /** The files of a repository as its last tree has them: path → bytes. */
  hub.files = (full) => { const r = hub.repos.get(full); return Object.fromEntries(r.tree.tree.map(e => [e.path, r.blobs.get(e.sha)])); };
  return hub;
}

/** A person signed in to the dashboard with Google, as part A leaves them. */
function person(env, token, who, id) {
  env.kiln_cloud.exec('INSERT INTO accounts (id, github_login, email, name, google_sub, created_at) VALUES (?, NULL, ?, ?, ?, 1)', id, who.email, who.name, who.sub);
  env.KILN.map.set(`csess:${token}`, JSON.stringify({ account_id: id, login: null, uid: null, gh: null, google: who }));
}

/** A service that keeps sites and hosts them, Rosa signed in with Google (token 'rosa'), ada with GitHub (token 'tok'). */
function world({ fail = null, notReady = 0, env: extra = {} } = {}) {
  const hub = fakeHub({ fail, notReady });
  const notes = [];
  const env = cloudEnv(fakeKV(), {
    CLOUD_DASHBOARD: 'https://app.example', KEEP_ORG: 'kiln-sites', KEEP_APP_ID: '4242', KEEP_APP_KEY: PEM,
    HOSTING_ACCOUNT_ID: 'cf-acct', HOSTING_API_TOKEN: 'cf-token', HOSTING_SUBDOMAIN: 'kiln-sites',
    NOTIFY: { send: async (m) => { notes.push(m.raw); } }, NOTIFY_TO: 'ops@example.com', ...extra,
  });
  person(env, 'rosa', ROSA, 'acct-g');
  return { hub, env, notes };
}
const send = async (env, method, pathname, body, token) => {
  const res = await worker.fetch(new Request(`https://worker.example${pathname}`, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
  }), env);
  return { status: res.status, json: await res.json().catch(() => null) };
};
/** One request to the service, with the stand-in GitHub in place of the network. Answers { status, json, calls }. */
const ask = (w, method, pathname, body, token = 'rosa') => withFetch(w.hub.handler, async (calls) => ({ ...(await send(w.env, method, pathname, body, token)), calls }));
const start = (w, name = 'Oak Bakery', token = 'rosa') => ask(w, 'POST', '/cloud/sites/start', { name }, token);
const github = (calls) => calls.filter(c => c.url.startsWith('https://api.github.com/'));
const rows = (env) => env.kiln_cloud.db.prepare('SELECT * FROM sites ORDER BY created_at').all().map(r => ({ ...r }));
const plain = (t) => {
  assert.equal(/[{}<>]|undefined|null\b|—|–/.test(t), false, `a plain sentence: ${t}`);
  assert.match(t, /\.$/, `a whole sentence: ${t}`);
};

test('the settings: keeping sites is on when the organization, the app id and the key are all given, and a repository in that organization is known in any letter case', () => {
  assert.equal(keepsOn({}), false);
  assert.equal(keepsOn({ KEEP_ORG: 'kiln-sites', KEEP_APP_ID: '1' }), false);
  assert.equal(keepsOn({ KEEP_ORG: 'kiln-sites', KEEP_APP_KEY: PEM }), false);
  assert.equal(keepsOn({ KEEP_ORG: ' ', KEEP_APP_ID: '1', KEEP_APP_KEY: PEM }), false);
  assert.equal(keepsOn({ KEEP_ORG: 'kiln-sites', KEEP_APP_ID: '1', KEEP_APP_KEY: PEM }), true);
  assert.equal(keepsReady({ KEEP_ORG: 'kiln-sites', KEEP_APP_ID: '1', KEEP_APP_KEY: PEM }), false, 'a kept site has no address without Kiln\'s hosting');
  assert.equal(inKeepOrg({ KEEP_ORG: 'kiln-sites' }, 'Kiln-Sites/oak'), true);
  assert.equal(inKeepOrg({ KEEP_ORG: 'Kiln-Sites' }, 'kiln-sites/oak'), true);
  assert.equal(inKeepOrg({ KEEP_ORG: 'kiln-sites' }, 'kiln-sites-2/oak'), false);
  assert.equal(inKeepOrg({}, 'kiln-sites/oak'), false);
});

test('a name and its slug: 2 to 60 characters after tidying, and lowercase letters, digits and dashes for the repository', () => {
  assert.equal(cleanName('  Oak \n  Bakery '), 'Oak Bakery');
  assert.equal(cleanName('a'), null);
  assert.equal(cleanName('   '), null);
  assert.equal(cleanName(7), null);
  assert.equal(cleanName('x'.repeat(60)), 'x'.repeat(60));
  assert.equal(cleanName('x'.repeat(61)), null);
  assert.equal(siteSlug('Oak Bakery'), 'oak-bakery');
  assert.equal(siteSlug('Café Très Bon!'), 'cafe-tres-bon');
  assert.equal(siteSlug('!!!'), 'site');
  assert.equal(siteSlug('日本'), 'site');
  assert.match(siteSlug('A very long name for a site that goes on and on and on'), /^[a-z0-9]+(-[a-z0-9]+)*$/);
  assert.ok(siteSlug('x'.repeat(60)).length <= 40);
});

test('the app\'s key is read in the form the signer takes, and the older form GitHub hands out goes through the converter it is given', () => {
  const body = PEM.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s/g, '');
  assert.equal(keepKey({ KEEP_APP_KEY: PEM }), body);
  assert.equal(keepKey({ KEEP_APP_KEY: PEM.replace(/\n/g, '\\n') }), body, 'a key stored with its line ends written out');
  assert.equal(keepKey({ KEEP_APP_KEY: OLD_PEM }), null, 'the older form, with nothing to convert it');
  assert.equal(keepKey({ KEEP_APP_KEY: OLD_PEM }, { pkcs1: (pem) => (pem === OLD_PEM.trim() ? 'converted' : 'wrong') }), 'converted');
  assert.equal(keepKey({ KEEP_APP_KEY: 'not a key!' }), null);
  assert.equal(kilnConfigFile({ repo: 'a/b', branch: 'main', worker: 'https://w.example' }).includes('siteName'), false, 'a site that was given no name has the settings file it always had');
});

test('every sentence a person can read is a plain one that says what to do', () => {
  for (const code of ['not_set_up', 'bad_name', 'busy', 'one_unpaid', 'too_many', 'not_started', 'half_made', 'in_keep_org']) plain(keepSentence(code));
  assert.equal(keepSentence('something_new'), keepSentence('not_started'));
});

test('a Google account starts a site: a private repository in Kiln\'s organization, every starter file, this site\'s settings, and a row Kiln keeps', { skip: d1Skip }, async () => {
  const w = world({ notReady: 1 });   // the first commit is not there at the first look
  assert.equal(keepsReady(w.env), true);
  const { status, json, calls } = await start(w, '  Oak   Bakery ');
  assert.equal(status, 200, JSON.stringify(json));
  assert.equal(json.ok, true);
  const site = json.site;

  // the repository
  assert.equal(w.hub.made.length, 1);
  const repo = w.hub.made[0];
  assert.match(repo, /^kiln-sites\/oak-bakery-[0-9a-f]{8}$/);
  assert.equal(repo.split('-').pop(), site.id.slice(0, 8), 'its name ends with the start of the site\'s id');
  const made = w.hub.repos.get(repo);
  assert.deepEqual(made.asked, { name: repo.split('/')[1], private: true, auto_init: true, has_issues: false, has_projects: false, has_wiki: false, description: 'Oak Bakery: a site whose files Kiln keeps' });

  // its files: the starter's, and the settings written for this site
  const files = w.hub.files(repo);
  const config = "window.KILN = {\n  repo:   '" + repo + "',\n  branch: 'main',\n  worker: 'https://worker.example',\n  siteName: 'Oak Bakery',\n  styles: [],\n};\n";
  assert.deepEqual(Object.keys(files).sort(), [...Object.keys(STARTER), 'assets/kiln-config.js'].sort());
  for (const [path, bytes] of Object.entries(STARTER)) assert.equal(files[path].equals(bytes), true, path);
  assert.equal(files['assets/kiln-config.js'].toString(), config);
  assert.equal(/sandbox/.test(config), false);
  assert.deepEqual(w.hub.read.slice().sort(), ['s0', 's1', 's2', 's3', 's4', 's5'], 'the demo\'s own settings, its workflow and its link were not read');
  assert.equal(made.tree.base_tree, undefined, 'the starter and nothing else');
  assert.deepEqual(made.commit, { message: "Kiln's starter site", tree: 'tree-1', parents: ['init-sha'] });
  assert.equal(made.head, 'commit-1', 'the branch was moved to it');

  // GitHub was asked in this order, and for nothing that removes or moves a repository
  const asked = github(calls).map(c => `${c.method} ${new URL(c.url).pathname}`);
  assert.deepEqual(asked.slice(0, 5), ['GET /orgs/kiln-sites/installation', 'POST /app/installations/77/access_tokens', 'GET /repos/kilncms/kiln-demo', 'GET /repos/kilncms/kiln-demo/git/trees/main', 'POST /orgs/kiln-sites/repos']);
  assert.deepEqual(asked.slice(5, 7), [`GET /repos/${repo}/git/ref/heads/main`, `GET /repos/${repo}/git/ref/heads/main`], 'it looked again for the first commit');
  assert.deepEqual(asked.slice(-3), [`POST /repos/${repo}/git/trees`, `POST /repos/${repo}/git/commits`, `PATCH /repos/${repo}/git/refs/heads/main`]);
  assert.deepEqual(w.hub.unsafe, []);
  // the second app signed for itself
  const [head, payload, sig] = w.hub.jwts[0].split('.');
  assert.equal(JSON.parse(Buffer.from(payload, 'base64url')).iss, '4242');
  assert.equal(verify('RSA-SHA256', Buffer.from(`${head}.${payload}`), publicKey, Buffer.from(sig, 'base64url')), true);
  assert.equal(w.env.KILN.map.get('keeptok:kiln-sites:4242'), 'keep-token');
  const life = w.env.KILN.expires.get('keeptok:kiln-sites:4242') - Math.floor(Date.now() / 1000);
  assert.ok(life > 49 * 60 && life <= 50 * 60, 'the token is kept for 50 minutes');

  // the row
  const all = rows(w.env);
  assert.equal(all.length, 1);
  const address = siteAddress(w.env, siteName(w.env, { repo, id: site.id }));
  assert.match(address, /^https:\/\/oak-bakery-[0-9a-f]{8}-[0-9a-f]{8}\.kiln-sites\.workers\.dev$/);
  assert.deepEqual({ id: all[0].id, account_id: all[0].account_id, repo: all[0].repo, origin: all[0].origin, plan: all[0].plan, status: all[0].status, kept: all[0].kept },
    { id: site.id, account_id: 'acct-g', repo, origin: address, plan: 'managed', status: 'trialing', kept: 1 });

  // the answer is the site as /cloud/me lists it
  const me = await ask(w, 'GET', '/cloud/me');
  assert.equal(me.json.keeps, true);
  assert.deepEqual(site, me.json.sites[0]);
  assert.equal(site.kept, true);
  assert.equal(site.editable, true);
  assert.equal(site.subscribed, false);
  assert.equal(typeof site.trial_ends, 'number');
  assert.equal(w.env.KILN.map.has('keeplock:acct-g'), false, 'the lock is given back');
  const note = w.notes.find(n => n.includes(`Subject: Kiln started a site and keeps its files: ${repo}`));
  assert.ok(note && note.includes('Started by: rosa@example.com') && note.includes(address));

  // a second press of the same kind uses the token that was kept
  w.env.kiln_cloud.exec("UPDATE sites SET status = 'active'");
  const again = await start(w, 'Elm Cafe');
  assert.equal(again.status, 200);
  assert.equal(github(again.calls).some(c => /installation/.test(c.url)), false);
  assert.equal(rows(w.env).length, 2);
});

test('the key works in the form GitHub hands it out', { skip: d1Skip }, async () => {
  const w = world({ env: { KEEP_APP_KEY: OLD_PEM } });
  const { status, json } = await start(w);
  assert.equal(status, 200, JSON.stringify(json));
  const [head, payload, sig] = w.hub.jwts[0].split('.');
  assert.equal(verify('RSA-SHA256', Buffer.from(`${head}.${payload}`), publicKey, Buffer.from(sig, 'base64url')), true);
});

test('fair use: one site that is not paid for at a time for an account, and 30 new sites an hour for the whole service', { skip: d1Skip }, async () => {
  const w = world();
  assert.equal((await start(w)).status, 200);
  let r = await start(w, 'Elm Cafe');
  assert.equal(r.status, 409);
  assert.deepEqual(r.json, { error: 'You already have a site here that is not paid for. Subscribe for that site or remove it, then start a new one.', code: 'one_unpaid' });
  assert.equal(github(r.calls).length, 0, 'GitHub was not asked for anything');
  assert.equal(w.hub.made.length, 1);
  for (const status of ['past_due', 'canceled', 'expired']) {
    w.env.kiln_cloud.exec('UPDATE sites SET status = ?', status);
    assert.equal((await start(w, 'Elm Cafe')).json.code, 'one_unpaid', status);
  }
  // somebody else is not held back by Rosa's site
  person(w.env, 'omar', OMAR, 'acct-o');
  assert.equal((await start(w, 'Fig Tree', 'omar')).status, 200);

  // the hourly count: this hour's is full
  assert.equal(STARTS_AN_HOUR, 30);
  const hour = Math.floor(Date.now() / 3600000);
  assert.equal(w.env.KILN.map.get(`keepstarts:${hour}`) ?? w.env.KILN.map.get(`keepstarts:${hour - 1}`), '2', 'each repository made is counted');
  for (const h of [hour, hour + 1]) w.env.KILN.map.set(`keepstarts:${h}`, '30');
  w.env.kiln_cloud.exec("UPDATE sites SET status = 'active'");
  r = await start(w, 'Elm Cafe');
  assert.equal(r.status, 429);
  assert.deepEqual(r.json, { error: 'Kiln has started a lot of new sites in the last hour. Please try again in an hour.', code: 'too_many' });
  assert.equal(github(r.calls).length, 0);
  assert.equal(w.hub.made.length, 2);
  for (const h of [hour, hour + 1]) w.env.KILN.map.set(`keepstarts:${h}`, '29');
  assert.equal((await start(w, 'Elm Cafe')).status, 200, 'one under the count goes through');
});

test('two presses at once make one repository and one site', { skip: d1Skip }, async () => {
  const w = world();
  const both = await withFetch(w.hub.handler, () => Promise.all([
    send(w.env, 'POST', '/cloud/sites/start', { name: 'Oak Bakery' }, 'rosa'),
    send(w.env, 'POST', '/cloud/sites/start', { name: 'Oak Bakery' }, 'rosa'),
  ]));
  assert.deepEqual(both.map(r => r.status).sort(), [200, 409]);
  assert.deepEqual(both.find(r => r.status === 409).json, { error: 'Kiln is already starting a site for you. Wait a minute, then reload this page to see it.', code: 'busy' });
  assert.equal(w.hub.made.length, 1);
  assert.equal(rows(w.env).length, 1);
  // a press while another start holds the lock
  w.env.kiln_cloud.exec("UPDATE sites SET status = 'active'");
  w.env.KILN.map.set('keeplock:acct-g', 'somebody');
  const r = await start(w, 'Elm Cafe');
  assert.equal(r.json.code, 'busy');
  assert.equal(w.env.KILN.map.get('keeplock:acct-g'), 'somebody', 'the other start\'s lock is left alone');
});

test('a failure after the repository was made: one sentence, no row, the repository left where it is, and the operator told its name', { skip: d1Skip }, async () => {
  for (const fail of ['commit', 'public']) {
    const w = world({ fail });
    const { status, json } = await start(w);
    assert.equal(status, 502, fail);
    assert.deepEqual(json, { error: 'Kiln could not finish starting your site, so it is not in your list. Please try again in a few minutes, and write to info@kilncms.com if it happens again.', code: 'half_made' });
    assert.equal(rows(w.env).length, 0, 'no row is left behind');
    assert.equal(w.hub.made.length, 1);
    assert.equal(w.hub.repos.has(w.hub.made[0]), true);
    assert.deepEqual(w.hub.unsafe, [], 'nothing tried to remove it');
    const note = w.notes.find(n => n.includes(`Subject: Kiln made ${w.hub.made[0]} and could not finish starting the site`));
    assert.ok(note && note.includes(`The repository ${w.hub.made[0]} was left where it is.`), fail);
    assert.equal(w.env.KILN.map.has('keeplock:acct-g'), false);
    assert.equal((await ask(w, 'GET', '/cloud/me')).json.sites.length, 0);
  }
  // a failure before anything was made says so differently, and makes nothing
  for (const fail of ['starter', 'create']) {
    const w = world({ fail });
    const { status, json } = await start(w);
    assert.equal(status, 502, fail);
    assert.deepEqual(json, { error: 'Kiln could not start your site just now. Please try again in a few minutes.', code: 'not_started' });
    assert.equal(w.hub.made.length, 0);
    assert.equal(rows(w.env).length, 0);
    assert.equal(w.notes.length, 0);
  }
});

test('a name that will not do, a service that keeps no sites, and nobody signed in', { skip: d1Skip }, async () => {
  const w = world();
  for (const name of ['', 'a', 'x'.repeat(61), null, 12]) {
    const r = await start(w, name);
    assert.equal(r.status, 400);
    assert.deepEqual(r.json, { error: 'Give your site a name of 2 to 60 characters, such as Oak Bakery, then press Start again.', code: 'bad_name' });
    assert.equal(github(r.calls).length, 0);
  }
  assert.equal((await ask(w, 'POST', '/cloud/sites/start', { name: 'Oak Bakery' }, 'nobody')).status, 401);
  for (const off of [{ KEEP_APP_KEY: '' }, { KEEP_ORG: '' }, { KEEP_APP_ID: '' }, { HOSTING_API_TOKEN: '' }]) {
    const o = world({ env: off });
    const r = await start(o);
    assert.equal(r.status, 409);
    assert.deepEqual(r.json, { error: 'Starting a site is not switched on for this service yet. Write to info@kilncms.com and we will tell you when it is.', code: 'not_set_up' });
    assert.equal(github(r.calls).length, 0);
    assert.equal(rows(o.env).length, 0);
    assert.equal((await ask(o, 'GET', '/cloud/me')).json.keeps, false);
    assert.equal((await ask(o, 'GET', '/healthz', null, null)).json.keeps, false);
  }
});

test('who owns a kept site: the account on its row and nobody else, with GitHub never asked, and every other site as before', { skip: d1Skip }, async () => {
  const w = world();
  person(w.env, 'omar', OMAR, 'acct-o');
  const { json } = await start(w);
  const { id, repo } = json.site;
  const reach = (site, token) => ask(w, 'GET', `/cloud/sites/prepare?site=${site}`, null, token);
  // Its own account passes. (The main app has no token for the repository in
  // this test, which is what the route says next, after it has asked who owns it.)
  let r = await reach(id, 'rosa');
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'no_access');
  assert.equal(github(r.calls).length, 0, 'GitHub was not asked who owns it');
  // another Google account, and a GitHub account
  r = await reach(id, 'omar');
  assert.deepEqual([r.status, r.json.code], [403, 'needs_github']);
  r = await reach(id, 'tok');
  assert.deepEqual([r.status, r.json.code], [404, 'no_such_site']);
  // a GitHub account's ordinary sites: its own by its login, and one GitHub says it cannot change
  addSite(w.env);
  addSite(w.env, { id: 'site-2', repo: 'other/thing', origin: 'https://thing.example' });
  r = await reach('site-1', 'tok');
  assert.deepEqual([r.status, r.json.code], [409, 'no_access']);
  r = await reach('site-2', 'tok');
  assert.deepEqual([r.status, r.json.code], [403, 'not_yours']);
  assert.deepEqual(github(r.calls).map(c => c.url), ['https://api.github.com/repos/other/thing'], 'GitHub was asked, as before');
  // a kept site on an account that signs in with GitHub is that account's, with no GitHub check
  addSite(w.env, { id: 'site-k', repo: 'kiln-sites/elm-cafe-12345678', origin: 'https://elm.example' });
  w.env.kiln_cloud.exec("UPDATE sites SET kept = 1 WHERE id = 'site-k'");
  r = await reach('site-k', 'tok');
  assert.deepEqual([r.status, r.json.code], [409, 'no_access']);
  assert.equal(github(r.calls).length, 0);
  // an ordinary row on a Google account is still out of reach
  addSite(w.env, { id: 'site-g', account_id: 'acct-g', repo: 'rosa/shop', origin: 'https://shop.example' });
  r = await reach('site-g', 'rosa');
  assert.deepEqual([r.status, r.json.code], [403, 'needs_github']);
  assert.equal(repo.startsWith('kiln-sites/'), true);
});

test('the ordinary way to add a site refuses a repository in the organization where Kiln keeps files', { skip: d1Skip }, async () => {
  const w = world();
  for (const repo of ['kiln-sites/oak-bakery-12345678', 'Kiln-Sites/anything']) {
    const r = await ask(w, 'POST', '/cloud/sites', { repo, origin: 'https://oak.example' }, 'tok');
    assert.equal(r.status, 403);
    assert.deepEqual(r.json, { error: 'That repository is one Kiln keeps for a site, so it cannot be added here. Enter a repository of your own.', code: 'in_keep_org' });
    assert.equal(github(r.calls).length, 0);
  }
  assert.equal(rows(w.env).length, 0);
});

test('removing a kept site takes the row away, leaves the repository alone, and tells the operator it may be removed by hand after 30 days', { skip: d1Skip }, async () => {
  const w = world();
  const { json } = await start(w);
  const { id, repo } = json.site;
  addSite(w.env);   // ada's ordinary site
  w.notes.length = 0;
  let r = await ask(w, 'POST', '/cloud/sites/remove', { id }, 'omar-nobody');
  assert.equal(r.status, 401);
  r = await ask(w, 'POST', '/cloud/sites/remove', { id }, 'tok');
  assert.equal(rows(w.env).length, 2, 'another account removes nothing');
  r = await ask(w, 'POST', '/cloud/sites/remove', { id });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.ok, true);
  assert.deepEqual(rows(w.env).map(s => s.id), ['site-1']);
  assert.equal(w.hub.repos.has(repo), true);
  assert.deepEqual(w.hub.unsafe, []);
  assert.equal(github(r.calls).length, 0, 'GitHub was not asked for anything');
  assert.equal(w.notes.length, 1);
  assert.ok(w.notes[0].includes(`Subject: Kiln no longer uses ${repo}`));
  assert.ok(w.notes[0].includes(`No site uses the repository ${repo} now. Kiln did not touch it.`));
  assert.ok(w.notes[0].includes('It may be removed by hand after 30 days'));
  assert.ok(keptRemovedNote({ repo: 'kiln-sites/x', now: Date.UTC(2026, 0, 1) }).lines[2].endsWith('from 2026-01-31.'));
  // an ordinary site is removed with no such note
  w.notes.length = 0;
  r = await ask(w, 'POST', '/cloud/sites/remove', { id: 'site-1' }, 'tok');
  assert.equal(r.status, 200);
  assert.equal(w.notes.some(n => n.includes('no longer uses')), false);
  // and its owner can start another
  assert.equal((await start(w, 'Elm Cafe')).status, 200);
});

test('what the dashboard is told: keeps on /cloud/me and /healthz, and kept on each kept site alone', { skip: d1Skip }, async () => {
  const w = world();
  assert.equal((await ask(w, 'GET', '/healthz', null, null)).json.keeps, true, 'known before anybody is signed in');
  let me = await ask(w, 'GET', '/cloud/me');
  assert.equal(me.json.keeps, true);
  assert.deepEqual(me.json.sites, []);
  await start(w);
  me = await ask(w, 'GET', '/cloud/me');
  assert.deepEqual(me.json.sites.map(s => s.kept), [true]);
  addSite(w.env);
  me = await ask(w, 'GET', '/cloud/me', null, 'tok');
  assert.equal(me.json.keeps, true);
  assert.equal(me.json.sites.length, 1);
  assert.equal('kept' in me.json.sites[0], false, 'an ordinary site says nothing about it');
});
