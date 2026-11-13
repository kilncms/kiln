/**
 * Bring my site in, the service side (worker/bring.js and its routes): a
 * person types the address of the site they have somewhere else, Kiln starts
 * a site it keeps the files of, empty, and starts a job on a GitHub Actions
 * runner that copies the old site into it. The job answers on a signed route.
 *
 * Nothing here touches the network: the real handlers run over a SQLite-backed
 * D1 stand-in and a stand-in GitHub, which answers only the calls the design
 * allows, wants the second app's token for all of them, and writes down
 * anything that would delete, rename or transfer a repository, and anything
 * else it is asked. The address a person types is never fetched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHmac } from 'node:crypto';
import worker from '../worker/index.js';
import { copyAnswered, bringOn, convertRepo, convertWorkflow, cleanAddress, bringSentence, copySentence, copyTrouble, cutReport, signAnswer, signedRight, sweepCopies, MOST_TRIES, COPY_MINUTES, withoutCommands } from '../worker/bring.js';
import { sweepBrings, accountAuthor } from '../worker/cloud.js';
import { keepSentence } from '../worker/keeps.js';
import { kilnConfigFile } from '../worker/prepare.js';
import { siteCopiedMail, copyFailedMail, siteStartedMail } from '../worker/mail.js';
import { fakeKV, withFetch, jsonRes } from './worker-harness.js';
import { cloudEnv, addSite, d1Skip } from './d1-fake.js';
import { fakeGitHub } from './github-fake.js';
import { fakeCloudflare } from './cloudflare-fake.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
const SECRET = 'a-long-random-text-shared-with-the-runner';
const ROSA = { sub: 'g-1001', email: 'rosa@example.com', name: 'Rosa Diaz' };
const OMAR = { sub: 'g-2002', email: 'omar@example.com', name: 'Omar Haddad' };
const JWT = /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/;
const SETTINGS = 'assets/kiln-config.js';
const JOBS = '/repos/kiln-sites/kiln-converter/actions/workflows/convert.yml/dispatches';

/** GitHub, as far as bringing a site in needs it. `hub.fail` breaks one step: 'job' or 'settings'. */
function fakeHub({ fail = null } = {}) {
  const hub = { repos: new Map(), made: [], jobs: [], unsafe: [], other: [], fail, n: 0 };
  hub.handler = async (url, init) => {
    const u = new URL(url);
    if (u.hostname !== 'api.github.com') { hub.other.push(url); return jsonRes({}, 500); }
    const p = u.pathname, m = init.method, auth = (init.headers && init.headers.Authorization) || '';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
    if (m === 'DELETE' || /\/transfer$/.test(p) || (m === 'PATCH' && /^\/repos\/[^/]+\/[^/]+$/.test(p))) { hub.unsafe.push(`${m} ${p}`); return jsonRes({}, 500); }
    if ((p === '/orgs/kiln-sites/installation' && m === 'GET') || (p === '/app/installations/77/access_tokens' && m === 'POST')) {
      if (!JWT.test(auth)) return jsonRes({ message: 'A JSON web token could not be decoded' }, 401);
      return m === 'GET' ? jsonRes({ id: 77 }) : jsonRes({ token: 'keep-token' }, 201);
    }
    if (auth !== 'Bearer keep-token') return jsonRes({ message: 'Bad credentials' }, 401);   // everything else is asked with the second app's token
    if (p === '/orgs/kiln-sites/repos' && m === 'POST') {
      const full = `kiln-sites/${body.name}`;
      hub.repos.set(full, { asked: body, files: new Map() });
      hub.made.push(full);
      return jsonRes({ full_name: full, name: body.name, private: body.private === true, default_branch: 'main' }, 201);
    }
    if (p === JOBS && m === 'POST') {
      if (hub.fail === 'job') return jsonRes({ message: 'Workflow does not have a workflow_dispatch trigger' }, 422);
      if (hub.fail === 'job401') { hub.refused = (hub.refused || 0) + 1; return jsonRes({ message: 'Bad credentials' }, 401); }
      hub.jobs.push(body);
      return new Response(null, { status: 204 });
    }
    const hit = p.match(/^\/repos\/(kiln-sites\/[^/]+)\/contents\/(.+)$/);
    const repo = hit && hub.repos.get(hit[1]);
    if (repo && m === 'GET') { const f = repo.files.get(hit[2]); return f ? jsonRes({ path: hit[2], sha: f.sha }) : jsonRes({ message: 'Not Found' }, 404); }
    if (repo && m === 'PUT') {
      if (hub.fail === 'settings') return jsonRes({ message: 'Server Error' }, 500);
      const had = repo.files.get(hit[2]);
      if (had && body.sha !== had.sha) return jsonRes({ message: '"sha" wasn\'t supplied.' }, 422);
      repo.files.set(hit[2], { sha: `sha-${++hub.n}`, text: Buffer.from(body.content, 'base64').toString(), message: body.message, branch: body.branch });
      return jsonRes({ content: { path: hit[2] } }, had ? 200 : 201);
    }
    hub.other.push(`${m} ${p}`);   // the starter site is never read, and nothing else is asked
    return jsonRes({ message: 'Not Found' }, 404);
  };
  return hub;
}

/** A person signed in to the dashboard with Google. */
function person(env, token, who, id) {
  env.kiln_cloud.exec('INSERT INTO accounts (id, github_login, email, name, google_sub, created_at) VALUES (?, NULL, ?, ?, ?, 1)', id, who.email, who.name, who.sub);
  env.KILN.map.set(`csess:${token}`, JSON.stringify({ account_id: id, login: null, uid: null, gh: null, google: who }));
}

/** A service that brings sites in, Rosa signed in with Google (token 'rosa'). `notes` is what the operator is told, `sent` what customers are mailed. */
function world({ fail = null, mail = false, env: extra = {} } = {}) {
  const hub = fakeHub({ fail });
  const notes = [], sent = [];
  const env = cloudEnv(fakeKV(), {
    CLOUD_DASHBOARD: 'https://app.example', KEEP_ORG: 'kiln-sites', KEEP_APP_ID: '4242', KEEP_APP_KEY: PEM,
    HOSTING_ACCOUNT_ID: 'cf-acct', HOSTING_API_TOKEN: 'cf-token', HOSTING_SUBDOMAIN: 'kiln-sites', CONVERT_SECRET: SECRET,
    NOTIFY: { send: async (m) => { if (m && m.subject) sent.push(m); else notes.push(String(m.raw)); return { messageId: `<${sent.length}@kilncms.com>` }; } }, NOTIFY_TO: 'ops@example.com',
    ...(mail ? { CUSTOMER_MAIL_FROM: 'hello@kilncms.com' } : {}), ...extra,
  });
  person(env, 'rosa', ROSA, 'acct-g');
  return { hub, env, notes, sent };
}
const send = async (env, method, pathname, body, token) => {
  const res = await worker.fetch(new Request(`https://worker.example${pathname}`, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
  }), env);
  return { status: res.status, json: await res.json().catch(() => null) };
};
const ask = (w, method, pathname, body, token = 'rosa') => withFetch(w.hub.handler, async (calls) => ({ ...(await send(w.env, method, pathname, body, token)), calls }));
const OAK = { address: 'www.oakbakery.com', name: 'Oak Bakery', mine: true };
const bring = (w, body = OAK, token = 'rosa') => ask(w, 'POST', '/cloud/sites/bring', body, token);
const again = (w, id, token = 'rosa') => ask(w, 'POST', '/cloud/sites/bring/again', { id }, token);
const asked = (calls) => calls.map(c => `${c.method} ${new URL(c.url).pathname}`);
const sites = (env) => env.kiln_cloud.db.prepare('SELECT * FROM sites ORDER BY created_at').all().map(r => ({ ...r }));
const copies = (env) => env.kiln_cloud.db.prepare('SELECT * FROM conversions ORDER BY tries, created_at').all().map(r => ({ ...r }));
const plain = (t) => {
  assert.equal(/[{}<>]|undefined|null\b|—|–/.test(t), false, `a plain sentence: ${t}`);
  assert.match(t, /\.$/, `a whole sentence: ${t}`);
};

/** The signature as a shell script would make it: HMAC-SHA256 of the body's bytes, in hex. Not the service's own code. */
const sig = (raw, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
/** The runner's answer. `signature: null` sends none; `raw` sends other bytes than were signed. */
const answer = (w, said, { signature, raw = JSON.stringify(said), handler = w.hub.handler } = {}) => withFetch(handler, async (calls) => {
  const res = await worker.fetch(new Request('https://worker.example/cloud/convert/done', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(signature === null ? {} : { 'X-Kiln-Signature': signature || sig(raw) }) }, body: raw,
  }), w.env);
  return { status: res.status, json: await res.json().catch(() => null), calls };
});
const REPORT = '# What was copied\n\n25 pages.\n\n## Check these\n\n- The contact form posted to the old site.\n\n## Next steps\n\ngit init && gh repo create\n';
/** Kiln's release branch, as far as putting a site up reads it. */
const RELEASE = 'https://raw.githubusercontent.com/kilncms/kiln/release';
const OUT = {
  'dist/VERSION': Buffer.from('r2\n'), 'dist/kiln.js': Buffer.from('(function(){"use strict";var t=window.KILN||{};window.KILN_VERSION="r2";})();\n'),
  'dist/kiln-editor.js': Buffer.from('/* editor r2 */\n'), 'dist/kiln-features.js': Buffer.from('/* features r2 */\n'), 'templates/_headers': Buffer.from('/*\n  X-Content-Type-Options: nosniff\n'),
};
const copiedPage = (title) => `<!doctype html>\n<html lang="en">\n<head>\n  <title>${title}</title>\n</head>\n<body>\n  <h1>${title}</h1>\n  <p>Words about ${title} that its owner will want to change one day.</p>\n</body>\n</html>\n`;
/**
 * The same world once the runner has pushed the copy: a GitHub that holds the
 * copied files of `repo` and a Cloudflare that takes them, so the site can go
 * up. Everything else is still asked of `w.hub`.
 */
function copied(w, repo) {
  const gh = fakeGitHub({ repo, files: { 'index.html': copiedPage('Home'), 'about.html': copiedPage('About'), 'assets/site.css': 'h1{}' } });
  const cf = fakeCloudflare({ account: 'cf-acct', token: 'cf-token' });
  w.env.KILN.map.set(`itok:${repo}`, 'inst-token');
  const handler = async (url, init) => {
    if (url.startsWith(`${RELEASE}/`)) { const f = OUT[url.slice(RELEASE.length + 1)]; return f ? new Response(f) : undefined; }
    return (await cf.handler(url, init)) || (await gh.handler(url, init)) || w.hub.handler(url, init);
  };
  return { gh, cf, handler };
}
const SHOWN_REPORT = '# What was copied\n\n25 pages.\n\n## Check these\n\n- The contact form posted to the old site.';

// ─── Settings, the address, the sentences ─────────────────────────────────────

test('the settings: bringing a site in is on when a site can be started and the shared secret is set, and the job lives in the organization unless told otherwise', () => {
  const env = { KEEP_ORG: 'kiln-sites', KEEP_APP_ID: '1', KEEP_APP_KEY: 'k', HOSTING_ACCOUNT_ID: 'a', HOSTING_API_TOKEN: 't', HOSTING_SUBDOMAIN: 'kiln-sites' };
  assert.equal(bringOn(env), false);
  assert.equal(bringOn({ ...env, CONVERT_SECRET: '  ' }), false);
  assert.equal(bringOn({ ...env, CONVERT_SECRET: 's3cret' }), true);
  assert.equal(bringOn({ CONVERT_SECRET: 's3cret' }), false, 'no site can be started here');
  assert.equal(bringOn({ ...env, CONVERT_SECRET: 's3cret', HOSTING_SUBDOMAIN: '' }), false);
  assert.equal(convertRepo(env), 'kiln-sites/kiln-converter');
  assert.equal(convertRepo({ ...env, CONVERT_REPO: 'acme/copier' }), 'acme/copier');
  assert.equal(convertRepo({ ...env, CONVERT_REPO: 'not a repository' }), 'kiln-sites/kiln-converter');
  assert.equal(convertWorkflow(env), 'convert.yml');
  assert.equal(convertWorkflow({ CONVERT_WORKFLOW: 'copy.yaml' }), 'copy.yaml');
  assert.equal(convertWorkflow({ CONVERT_WORKFLOW: '../other' }), 'convert.yml');
});

test('an address a person typed becomes a web address a copy can be made from, and everything else is refused with one sentence', () => {
  const ours = { own: ['worker.example', 'app.example'], hostingSubdomain: 'kiln-sites' };
  const good = [
    ['oakbakery.com', 'https://oakbakery.com', 'oakbakery.com'],
    ['  WWW.OakBakery.com/ ', 'https://www.oakbakery.com', 'oakbakery.com'],
    ['http://oakbakery.com', 'http://oakbakery.com', 'oakbakery.com'],
    ['https://www.oakbakery.com/shop/index.html?utm=1#top', 'https://www.oakbakery.com/shop/index.html', 'oakbakery.com'],
    ['https://oakbakery.com:443/', 'https://oakbakery.com', 'oakbakery.com'],
    ['oakbakery.com:80', 'http://oakbakery.com', 'oakbakery.com'],
    ['https://oakbakery.com.', 'https://oakbakery.com', 'oakbakery.com'],
    ['//oakbakery.com', 'https://oakbakery.com', 'oakbakery.com'],
    ['oak-bakery.squarespace.com', 'https://oak-bakery.squarespace.com', 'oak-bakery.squarespace.com'],
    ['https://oak-bakery.lovable.app/', 'https://oak-bakery.lovable.app', 'oak-bakery.lovable.app'],
    ['someone-else.workers.dev', 'https://someone-else.workers.dev', 'someone-else.workers.dev'],
  ];
  for (const [typed, address, source] of good) {
    const out = cleanAddress(typed, ours);
    assert.deepEqual([out.ok, out.address, out.source], [true, address, source], typed);
  }
  const refused = [
    [undefined, 'no_address'], ['', 'no_address'], ['   ', 'no_address'], [42, 'no_address'],
    ['ftp://oakbakery.com', 'not_web'], ['mailto:rosa@oakbakery.com', 'not_web'], ['javascript:alert(1)', 'not_web'], ['file:///etc/passwd', 'not_web'],
    ['http://127.0.0.1', 'not_public'], ['http://2130706433', 'not_public'], ['http://0x7f.0.0.1/', 'not_public'], ['https://[::1]/', 'not_public'],
    ['localhost', 'not_public'], ['localhost:8787', 'not_public'], ['https://intranet', 'not_public'],
    ['printer.local', 'not_public'], ['wiki.corp.internal', 'not_public'], ['site.test', 'not_public'], ['www.example', 'not_public'], ['a.invalid', 'not_public'],
    ['oakbakery.com:8080', 'bad_port'], ['https://oakbakery.com:8443/x', 'bad_port'],
    ['https://rosa:secret@oakbakery.com', 'has_login'], ['rosa@oakbakery.com', 'has_login'],
    ['https://worker.example/cloud/me', 'kiln_own'], ['app.example', 'kiln_own'], ['kilncms.com', 'kiln_own'], ['https://demo.kilncms.com/x', 'kiln_own'],
    ['oak-bakery-1a2b3c4d.kiln-sites.workers.dev', 'kiln_own'],
    ['oak bakery.com', 'bad_address'], ['https://', 'bad_address'], ['https://oak_bakery.com', 'bad_address'],
    ['oakbakery.com/$(id)', 'bad_address'], ["oakbakery.com/a';x", 'bad_address'], ['oakbakery.com\\x', 'bad_address'], [`oakbakery.com/${'a'.repeat(400)}`, 'bad_address'],
  ];
  for (const [typed, code] of refused) {
    const out = cleanAddress(typed, ours);
    assert.deepEqual([out.ok, out.code], [false, code], String(typed));
    assert.equal(out.error, bringSentence(code));
    plain(out.error);
  }
  assert.equal(cleanAddress('kilncms.com').code, 'kiln_own', 'with nothing told about this service');
});

test('every sentence a person can read is a plain one that says what to do', () => {
  for (const code of ['not_set_up', 'not_mine', 'no_address', 'bad_address', 'not_web', 'has_login', 'not_public', 'bad_port', 'kiln_own', 'bad_name', 'not_now', 'no_job',
    'no_such_site', 'no_copy', 'copied', 'still_copying', 'no_more_tries', 'busy']) plain(bringSentence(code));
  for (const reason of ['unreachable', 'blank', 'nothing', 'tool', 'no_answer', 'no_job']) {
    plain(copySentence(reason));
    assert.match(copySentence(reason), /Try again/);
    plain(copySentence(reason, { again: false }));
    assert.match(copySentence(reason, { again: false }), /Write to info@kilncms\.com/);
    assert.equal(/Try again/.test(copySentence(reason, { again: false })), false, 'no button is named that is not there');
  }
  assert.equal(copySentence('something new'), copySentence('tool'));
  assert.equal(bringSentence('not_mine'), "Tick the box that says this is your site, or that you have its owner's permission to copy it.");
  assert.equal(/other|another|someone|already|before/i.test(bringSentence('not_now')), false, 'nothing about anybody else');
});

// ─── POST /cloud/sites/bring ──────────────────────────────────────────────────

test('a person brings a site in: an empty private repository, the site\'s row, the copy written down, the mark, and the job started with the right inputs', { skip: d1Skip }, async () => {
  const w = world({ mail: true });
  const { status, json, calls } = await bring(w, { address: ' WWW.OakBakery.com/?ref=old#top ', name: '  Oak   Bakery ', mine: true });
  assert.equal(status, 200, JSON.stringify(json));
  assert.equal(json.ok, true);
  const site = json.site;

  // GitHub, in order: the second app's token, the repository, the job. The starter is not read and nothing is written.
  const repo = w.hub.made[0];
  assert.match(repo, /^kiln-sites\/oak-bakery-[0-9a-f]{8}$/);
  assert.deepEqual(asked(calls), ['GET /orgs/kiln-sites/installation', 'POST /app/installations/77/access_tokens', 'POST /orgs/kiln-sites/repos', `POST ${JOBS}`]);
  assert.equal(calls.every(c => c.url.startsWith('https://api.github.com/')), true, 'the address itself is never read by the service');
  assert.deepEqual([w.hub.other, w.hub.unsafe], [[], []]);
  assert.deepEqual(w.hub.repos.get(repo).asked, { name: repo.split('/')[1], private: true, auto_init: true, has_issues: false, has_projects: false, has_wiki: false, description: 'Oak Bakery: a site whose files Kiln keeps' });
  assert.equal(w.hub.repos.get(repo).files.size, 0);

  // the rows
  const [row] = sites(w.env);
  assert.deepEqual([sites(w.env).length, row.id, row.account_id, row.repo, row.kept, row.name, row.plan, row.status], [1, site.id, 'acct-g', repo, 1, 'Oak Bakery', 'managed', 'trialing']);
  const [copy] = copies(w.env);
  assert.match(copy.id, /^[0-9a-f]{32}$/);
  assert.deepEqual({ ...copy, id: 0, asked_at: 0, created_at: 0, updated_at: 0 },
    { id: 0, site_id: site.id, account_id: 'acct-g', address: 'https://www.oakbakery.com', branch: 'main', state: 'copying', reason: null, pages: null, rendered: null, report: null, tries: 1, asked_at: 0, done_at: null, created_at: 0, updated_at: 0 });

  // the job
  assert.deepEqual(w.hub.jobs, [{ ref: 'main', inputs: { job: copy.id, address: 'https://www.oakbakery.com', repo, back: 'https://worker.example/cloud/convert/done', pages: '200' } }]);

  // one free copy of that site for 30 days, counted without "www."
  assert.equal(w.env.KILN.map.has('brought:oakbakery.com'), true);
  assert.equal(Math.round((w.env.KILN.expires.get('brought:oakbakery.com') - Date.now() / 1000) / 86400), 30);

  // the answer: the site as /cloud/me lists it
  assert.deepEqual([site.kept, site.name, site.repo], [true, 'Oak Bakery', repo]);
  assert.match(site.origin, /\.kiln-sites\.workers\.dev$/);
  assert.deepEqual(site.bring, { state: 'copying', address: 'https://www.oakbakery.com', asked_at: copy.asked_at, done_at: null, pages: null, rendered: false, error: null, again: false });
  const me = await ask(w, 'GET', '/cloud/me');
  assert.deepEqual(me.json.sites, [site]);
  assert.equal(w.notes.length, 1, 'the operator is told a site was started');
  assert.equal(w.sent.length, 0, 'the owner is written to when the copy is done, not before');
});

test('a site brought in with no name is called by its address, without www', { skip: d1Skip }, async () => {
  const w = world();
  const { status, json } = await bring(w, { address: 'https://www.oakbakery.com/', mine: true });
  assert.equal(status, 200, JSON.stringify(json));
  assert.equal(json.site.name, 'oakbakery.com');
  assert.match(w.hub.made[0], /^kiln-sites\/oakbakery-com-[0-9a-f]{8}$/);
  assert.equal((await bring(world(), { address: 'oakbakery.com', name: '   ', mine: true })).json.site.name, 'oakbakery.com', 'a name of spaces is no name');
});

test('each refusal is a sentence, and nothing is made: nobody signed in, a service that brings nothing in, no tick, an address or a name that will not do', { skip: d1Skip }, async () => {
  const w = world();
  assert.equal((await bring(w, OAK, null)).status, 401);
  for (const mine of [undefined, false, 'true', 1]) {
    const no = await bring(w, { ...OAK, mine });
    assert.deepEqual([no.status, no.json], [400, { error: "Tick the box that says this is your site, or that you have its owner's permission to copy it.", code: 'not_mine' }]);
  }
  for (const [address, code] of [['', 'no_address'], ['http://127.0.0.1/admin', 'not_public'], ['https://worker.example', 'kiln_own'], ['https://app.example', 'kiln_own'],
    ['bakery-1a2b3c4d.kiln-sites.workers.dev', 'kiln_own'], ['oakbakery.com:8080', 'bad_port'], ['ftp://oakbakery.com', 'not_web']]) {
    const no = await bring(w, { ...OAK, address });
    assert.deepEqual([no.status, no.json], [400, { error: bringSentence(code), code }], address);
  }
  const name = await bring(w, { ...OAK, name: 'x' });
  assert.deepEqual([name.status, name.json.code, name.json.error], [400, 'bad_name', bringSentence('bad_name')]);
  assert.deepEqual([w.hub.made, w.hub.jobs, sites(w.env), copies(w.env), w.notes], [[], [], [], [], []]);
  assert.equal(w.env.KILN.map.has('brought:oakbakery.com'), false);

  const off = world({ env: { CONVERT_SECRET: '' } });
  const no = await bring(off);
  assert.deepEqual([no.status, no.json, no.calls.length], [409, { error: bringSentence('not_set_up'), code: 'not_set_up' }, 0]);

  // A database migration 0009 has not reached: nothing is made, and the dashboard still lists.
  const old = world({ env: { d1: { upTo: 8 } } });
  const early = await bring(old);
  assert.deepEqual([early.status, early.json.code, old.hub.made.length, sites(old.env).length], [409, 'not_set_up', 0, 0]);
  assert.equal((await ask(old, 'GET', '/cloud/me')).status, 200);
});

test('fair use: the limits of starting a site, and one free copy of a site in 30 days, which an account that pays is not held to', { skip: d1Skip }, async () => {
  const w = world();
  assert.equal((await bring(w)).status, 200);
  // Rosa has a site that is not paid for
  const second = await bring(w, { address: 'rosas-other-site.com', mine: true });
  assert.deepEqual([second.status, second.json], [409, { error: keepSentence('one_unpaid'), code: 'one_unpaid' }]);
  // Omar asks for the same site, typed another way
  person(w.env, 'omar', OMAR, 'acct-o');
  const omar = await bring(w, { address: 'http://oakbakery.com/about', mine: true }, 'omar');
  assert.deepEqual([omar.status, omar.json], [429, { error: 'Kiln cannot copy that site during the free days just now. Write to info@kilncms.com and we will help you bring it in.', code: 'not_now' }]);
  assert.deepEqual([w.hub.made.length, w.hub.jobs.length, sites(w.env).length, omar.calls.length], [1, 1, 1, 0], 'refused before anything was made or asked');
  // Omar pays for a site: the mark does not hold him, and his copy leaves the mark as it was
  w.env.kiln_cloud.exec("INSERT INTO sites (id, account_id, repo, origin, plan, status, ls_subscription_id, created_at, kept, name) VALUES ('paid-1', 'acct-o', 'kiln-sites/paid-1', 'https://paid.example', 'managed', 'active', 'sub-1', 1, 1, 'Paid')");
  const mark = w.env.KILN.map.get('brought:oakbakery.com');
  const paid = await bring(w, { address: 'http://oakbakery.com/about', mine: true }, 'omar');
  assert.equal(paid.status, 200, JSON.stringify(paid.json));
  assert.deepEqual([w.hub.made.length, w.hub.jobs.length, w.env.KILN.map.get('brought:oakbakery.com')], [2, 2, mark]);
  assert.equal(w.hub.jobs[1].inputs.address, 'http://oakbakery.com/about');
  // 30 new sites an hour for the whole service, counted with the sites that start from the starter
  person(w.env, 'lena', { sub: 'g-3003', email: 'lena@example.com', name: 'Lena' }, 'acct-l');
  w.env.KILN.map.set(`keepstarts:${Math.floor(Date.now() / 3600000)}`, '30');
  const late = await bring(w, { address: 'lenas-site.com', mine: true }, 'lena');
  assert.deepEqual([late.status, late.json], [429, { error: keepSentence('too_many'), code: 'too_many' }]);
  assert.equal(w.env.KILN.map.has('brought:lenas-site.com'), false);
  assert.deepEqual(w.hub.unsafe, []);
});

test('a job that cannot be started: one sentence, the copy failed with its reason, the site and its repository left for another try, and the operator told', { skip: d1Skip }, async () => {
  const w = world({ fail: 'job', mail: true });
  const { status, json } = await bring(w);
  assert.equal(status, 502);
  assert.deepEqual([json.code, json.error], ['no_job', "Kiln could not start copying the site just now. Wait a few minutes, then press Try again on the site's row."]);
  assert.deepEqual([w.hub.made.length, sites(w.env).length, w.hub.unsafe.length], [1, 1, 0]);
  const [copy] = copies(w.env);
  assert.deepEqual([copy.state, copy.reason, copy.tries, typeof copy.done_at], ['failed', 'no_job', 1, 'number']);
  assert.deepEqual([json.site.id, json.site.bring.state, json.site.bring.error, json.site.bring.again], [sites(w.env)[0].id, 'failed', copySentence('no_job'), true]);
  assert.equal(w.notes.length, 2, 'that the site was started, and that its job was not');
  assert.equal(w.sent.length, 0, 'the person is told on the page they are looking at');
  // GitHub is well again: Try again starts it
  w.hub.fail = null;
  const next = await again(w, json.site.id);
  assert.deepEqual([next.status, next.json.bring.state, w.hub.jobs.length, w.hub.made.length], [200, 'copying', 1, 1]);
});

test('a remembered token GitHub no longer takes is forgotten, and the job is started once more with a new one', { skip: d1Skip }, async () => {
  const w = world({ fail: 'job' });
  const first = await bring(w);
  assert.equal(first.status, 502);
  const KEY = 'keeptok:kiln-sites:4242';
  assert.equal(await w.env.KILN.get(KEY), 'keep-token', 'the token is remembered');
  // the remembered token dies before its 50 minutes are over
  await w.env.KILN.put(KEY, 'dead-token');
  w.hub.fail = null;
  const next = await again(w, first.json.site.id);
  assert.deepEqual([next.status, next.json.bring.state, w.hub.jobs.length], [200, 'copying', 1]);
  assert.deepEqual(asked(next.calls).filter(c => !c.includes('/contents/')), [`POST ${JOBS}`, 'GET /orgs/kiln-sites/installation', 'POST /app/installations/77/access_tokens', `POST ${JOBS}`]);
  assert.deepEqual(next.calls.filter(c => new URL(c.url).pathname === JOBS).map(c => c.headers.Authorization), ['Bearer dead-token', 'Bearer keep-token']);
  assert.equal(await w.env.KILN.get(KEY), 'keep-token', 'the new token is the one remembered now');
  assert.deepEqual(w.hub.unsafe, []);
});

test('a job start GitHub answers 401 to twice is tried twice and no more, and the copy fails as any job that cannot be started', { skip: d1Skip }, async () => {
  const w = world({ fail: 'job401' });
  const { status, json } = await bring(w);
  assert.deepEqual([status, json.code], [502, 'no_job']);
  assert.equal(w.hub.refused, 2, 'the first try and one more');
  const [copy] = copies(w.env);
  assert.deepEqual([copy.state, copy.reason], ['failed', 'no_job']);
  assert.match(w.notes.at(-1), /answered 401/);
  assert.deepEqual([w.hub.made.length, sites(w.env).length, w.hub.unsafe.length], [1, 1, 0]);
});

// ─── POST /cloud/convert/done ─────────────────────────────────────────────────

test('the job\'s answer is taken only with the right signature of the very bytes that arrived', { skip: d1Skip }, async () => {
  const w = world({ mail: true });
  await bring(w);
  const job = copies(w.env)[0].id;
  const said = { job, ok: true, pages: 25, rendered: false, report: REPORT };
  const raw = JSON.stringify(said);
  assert.equal(await signAnswer(SECRET, raw), sig(raw), 'the service signs as a shell script would');
  assert.deepEqual([await signedRight(SECRET, raw, sig(raw)), await signedRight(SECRET, raw, sig(raw, 'another secret')), await signedRight('', raw, sig(raw, '')), await signedRight(SECRET, raw, undefined)], [true, false, false, false]);
  const refused = [
    await answer(w, said, { signature: null }),                                   // none
    await answer(w, said, { signature: sig(raw, 'another secret') }),             // made with another secret
    await answer(w, said, { signature: sig(raw).slice(7) }),                      // without "sha256="
    await answer(w, said, { signature: 'sha256=abc' }),
    await answer(w, said, { signature: sig(raw), raw: raw.replace('25', '26') }), // the body changed after it was signed
    await answer(w, said, { signature: sig(raw), raw: `${raw}\n` }),
  ];
  for (const r of refused) assert.deepEqual([r.status, r.json, r.calls.length], [401, { error: 'bad signature' }, 0]);
  assert.deepEqual([copies(w.env)[0].state, w.sent.length], ['copying', 0], 'nothing changed');
  // too long an answer is refused, signed or not
  const long = await answer(w, { ...said, report: 'x'.repeat(300001) });
  assert.deepEqual([long.status, copies(w.env)[0].state], [413, 'copying']);
  // signed, and not JSON
  assert.equal((await answer(w, null, { raw: 'ok=true' })).status, 400);
  // a service with no secret takes no answer at all
  const off = world({ env: { CONVERT_SECRET: '' } });
  assert.equal((await answer(off, said, { signature: sig(raw, '') })).status, 401);
  // the right one
  const good = await answer(w, said);
  assert.deepEqual([good.status, good.json], [200, { ok: true, state: 'done' }]);
});

test('a copy that worked: this site\'s settings are written over the copy\'s own, the copy is done with its pages and its report, and its owner is written to once. A site that could not be put up leaves the copy done, and its owner and the operator are told', { skip: d1Skip }, async () => {
  const w = world({ mail: true });
  const { json } = await bring(w);
  const repo = w.hub.made[0], job = copies(w.env)[0].id;
  // the runner pushed the copy, which came with a settings file of its own
  w.hub.repos.get(repo).files.set(SETTINGS, { sha: 'from-the-copy', text: 'window.KILN = { repo: "someone/else" };' });
  const said = { job, ok: true, pages: 25, rendered: true, report: REPORT };
  const first = await answer(w, said);
  assert.deepEqual([first.status, first.json], [200, { ok: true, state: 'done' }]);
  assert.deepEqual(asked(first.calls), [`GET /repos/${repo}/contents/${SETTINGS}`, `PUT /repos/${repo}/contents/${SETTINGS}`], 'with the token it already has');
  const file = w.hub.repos.get(repo).files.get(SETTINGS);
  assert.equal(file.text, kilnConfigFile({ repo, branch: 'main', worker: 'https://worker.example', siteName: 'Oak Bakery' }));
  assert.deepEqual([file.branch, first.calls[1].body.sha], ['main', 'from-the-copy']);
  const [copy] = copies(w.env);
  assert.deepEqual([copy.state, copy.reason, copy.pages, copy.rendered, copy.report, typeof copy.done_at], ['done', null, 25, 1, SHOWN_REPORT, 'number']);
  // the mail
  assert.equal(w.sent.length, 1);
  const expected = siteCopiedMail({ name: 'Oak Bakery', address: json.site.origin, up: false, from: 'https://www.oakbakery.com', pages: 25, endsAt: sites(w.env)[0].created_at + 7 * 86400e3, dashboard: 'https://app.example' });
  assert.deepEqual({ to: w.sent[0].to, subject: w.sent[0].subject, text: w.sent[0].text }, { to: 'rosa@example.com', subject: 'Your site is copied', text: expected.text });
  // this GitHub and this Cloudflare cannot put a site up: the copy is done all the same, and the mail says which button puts it up
  assert.ok(w.sent[0].text.includes(`The copy is not up yet. Open your dashboard and press Put it on Kiln's hosting on the site's row. The site is then up at its temporary address, ${json.site.origin}, about a minute later.`));
  assert.equal(w.env.kiln_cloud.row('SELECT COUNT(*) n FROM hosting WHERE site_id = ?', json.site.id).n, 0);
  assert.match(w.notes.at(-1), /What went wrong: \w+: /);
  assert.match(w.notes.at(-1), /The copy is done and stays done\. Its owner was told that Put it on Kiln's hosting on the site's row puts the site up\./);

  // the same answer again, another answer for the same job, and an answer for a job nobody knows
  for (const more of [said, { job, ok: false, reason: 'unreachable' }, { job: 'f'.repeat(32), ok: true, pages: 3 }, { job: 'not a job', ok: true, pages: 3 }, { ok: true }]) {
    const r = await answer(w, more);
    assert.deepEqual([r.status, r.json, r.calls.length], [200, { ok: true, already: true }, 0]);
  }
  assert.deepEqual([copies(w.env)[0].state, copies(w.env)[0].pages, w.sent.length, w.hub.unsafe.length, w.hub.other.length], ['done', 25, 1, 0, 0]);

  // the report: cut where the steps for a person at a terminal begin, then at 20,000 characters
  assert.equal(cutReport(REPORT), SHOWN_REPORT);
  assert.equal(cutReport('a'.repeat(25000)).length, 20000);
  assert.equal(cutReport('Pages\nSee ## Next steps below\n'), 'Pages\nSee ## Next steps below', 'only a line that starts with it');
  assert.equal(cutReport(undefined), '');
});

test('a copy that worked goes up on Kiln\'s hosting by itself: Kiln is added in the account\'s own name, the operator reads who did it, and the mail says the site is up and where', { skip: d1Skip }, async () => {
  const w = world({ mail: true });
  const { json } = await bring(w);
  const repo = w.hub.made[0], job = copies(w.env)[0].id, before = w.notes.length;
  const up = copied(w, repo);
  const done = await answer(w, { job, ok: true, pages: 2, report: REPORT }, { handler: up.handler });
  assert.deepEqual([done.status, done.json], [200, { ok: true, state: 'done' }]);
  assert.equal(copies(w.env)[0].state, 'done');
  // the site is up, made from files Kiln was added to and marked for editing
  const hosting = w.env.kiln_cloud.row('SELECT * FROM hosting WHERE site_id = ?', json.site.id);
  assert.equal(hosting.state, 'live');
  const home = up.gh.read('index.html');
  assert.match(home, /<h1 [^>]*data-cms/);
  assert.equal(up.cf.serve(hosting.name, '/index.html')?.bytes.toString(), home);
  assert.ok(up.gh.read('assets/kiln-config.js').includes(repo), 'the settings are this site\'s own');
  // nobody is signed in: the changes carry the account's own name and address
  const by = [...up.gh.commits.values()].filter(c => c.author.name !== 'Site Owner').map(c => `${c.author.name} <${c.author.email}>`);
  assert.ok(by.length >= 2, `${by.length} changes`);
  assert.deepEqual([...new Set(by)], ['Rosa Diaz (via Kiln) <rosa@example.com>']);
  const told = w.notes.slice(before);
  assert.equal(told.length, 1);
  assert.match(told[0], /By: Kiln, after a copy/);
  assert.ok(told[0].includes(`Address: ${json.site.origin}`));
  // the mail
  assert.equal(w.sent.length, 1);
  const expected = siteCopiedMail({ name: 'Oak Bakery', address: json.site.origin, up: true, from: 'https://www.oakbakery.com', pages: 2, endsAt: sites(w.env)[0].created_at + 7 * 86400e3, dashboard: 'https://app.example' });
  assert.deepEqual({ to: w.sent[0].to, subject: w.sent[0].subject, text: w.sent[0].text }, { to: 'rosa@example.com', subject: 'Your site is copied', text: expected.text });
  assert.ok(w.sent[0].text.includes(`The copy is up at its temporary address, ${json.site.origin}. Open that address to see your site.`));
  // its owner can still publish it again from the dashboard, as before
  const again = await withFetch(up.handler, () => send(w.env, 'POST', '/cloud/sites/hosting', { id: json.site.id }, 'rosa'));
  assert.deepEqual([again.status, again.json.ok, again.json.hosting.state], [200, true, 'live']);
  assert.deepEqual([w.sent.length, w.hub.unsafe.length], [1, 0]);
});

test('the job waits for its answer while the site is put up, so nothing is handed on to run after the answer and the mail tells the truth', { skip: d1Skip }, async () => {
  const w = world({ mail: true });
  await bring(w);
  const repo = w.hub.made[0], job = copies(w.env)[0].id;
  const up = copied(w, repo), waits = [], raw = JSON.stringify({ job, ok: true, pages: 2 });
  await withFetch(up.handler, async () => {
    const res = await worker.fetch(new Request('https://worker.example/cloud/convert/done', { method: 'POST', headers: { 'X-Kiln-Signature': sig(raw) }, body: raw }), w.env, { waitUntil: (work) => waits.push(work) });
    assert.deepEqual([res.status, await res.json()], [200, { ok: true, state: 'done' }]);
    // Work handed on to run after the answer is cut off by Cloudflare about 30 seconds in, which could stop the publishing half way.
    assert.deepEqual([copies(w.env)[0].state, w.sent.length, waits.length], ['done', 1, 0], 'done, up and written to before the answer; nothing goes on afterwards');
  });
  assert.equal(w.env.kiln_cloud.row('SELECT state FROM hosting WHERE site_id = ?', sites(w.env)[0].id).state, 'live');
  assert.equal(w.sent.length, 1);
  assert.ok(w.sent[0].text.includes('The copy is up at its temporary address, '));
});

test('a site that is slow to go up after the answer: its owner is written to in time, told which button puts it up, and the operator is told', { skip: d1Skip }, async () => {
  const w = world({ mail: true });
  await bring(w);
  const job = copies(w.env)[0].id, raw = JSON.stringify({ job, ok: true, pages: 2 }), waits = [], notes = [];
  const out = await withFetch(w.hub.handler, async () => {
    const r = await copyAnswered(w.env, { body: raw, signature: sig(raw), worker: 'https://worker.example', dashboard: 'https://app.example', note: async (subject, lines) => { notes.push([subject, ...lines].join('\n')); },
      host: () => new Promise(() => {}), later: (work) => waits.push(work), hostWait: 5 });
    await Promise.all(waits);
    return r;
  });
  assert.deepEqual([out.status, out.body, copies(w.env)[0].state], [200, { ok: true, state: 'done' }, 'done']);
  assert.equal(w.sent.length, 1);
  assert.ok(w.sent[0].text.includes("The copy is not up yet. Open your dashboard and press Put it on Kiln's hosting on the site's row."));
  assert.equal(notes.length, 1);
  assert.match(notes[0], /^Kiln could not put kiln-sites\/oak-bakery-[0-9a-f]{8} on its hosting after its copy\n/);
  assert.match(notes[0], /What went wrong: slow: the site was not up after 0 seconds, and it may still go up/);
  // a host that throws is the same to its owner
  const w2 = world({ mail: true });
  await bring(w2);
  const raw2 = JSON.stringify({ job: copies(w2.env)[0].id, ok: true, pages: 1 });
  const out2 = await withFetch(w2.hub.handler, () => copyAnswered(w2.env, { body: raw2, signature: sig(raw2), worker: 'https://worker.example', dashboard: 'https://app.example', host: async () => { throw new Error('Cloudflare is away'); } }));
  assert.deepEqual([out2.body, copies(w2.env)[0].state, w2.sent.length], [{ ok: true, state: 'done' }, 'done', 1]);
  assert.ok(w2.sent[0].text.includes('The copy is not up yet.'));
});

test('whose name a change carries when nobody is signed in: the account\'s own, as a signed-in person\'s would be', { skip: d1Skip }, async () => {
  const w = world();
  assert.deepEqual(await accountAuthor(w.env, 'acct-g'), { name: 'Rosa Diaz (via Kiln)', email: 'rosa@example.com' });
  w.env.kiln_cloud.exec('INSERT INTO accounts (id, github_login, email, name, google_sub, created_at) VALUES (?, ?, ?, NULL, NULL, 1)', 'acct-h', 'grace', 'grace@example.com');
  assert.deepEqual(await accountAuthor(w.env, 'acct-h'), { name: 'grace', email: 'grace@users.noreply.github.com' });
  w.env.kiln_cloud.exec('INSERT INTO accounts (id, github_login, email, name, google_sub, created_at) VALUES (?, NULL, ?, NULL, ?, 1)', 'acct-n', 'lena@example.com', 'g-3003');
  assert.deepEqual(await accountAuthor(w.env, 'acct-n'), { name: 'lena (via Kiln)', email: 'lena@example.com' });
});

test('settings that cannot be written leave the copy as it was, so the job can answer again', { skip: d1Skip }, async () => {
  const w = world({ fail: 'settings', mail: true });
  await bring(w);
  const said = { job: copies(w.env)[0].id, ok: true, pages: 4, rendered: false, report: '' };
  const first = await answer(w, said);
  assert.deepEqual([first.status, copies(w.env)[0].state, w.sent.length, w.notes.length], [502, 'copying', 0, 2]);
  w.hub.fail = null;
  const second = await answer(w, said);
  assert.deepEqual([second.status, second.json, copies(w.env)[0].state, w.sent.length], [200, { ok: true, state: 'done' }, 'done', 1]);
});

test('a copy that did not work: failed with its reason, nothing written to the repository, and its owner told why and what to try', { skip: d1Skip }, async () => {
  for (const [said, reason] of [[{ ok: false, reason: 'unreachable' }, 'unreachable'], [{ ok: false, reason: 'blank', pages: 0, rendered: true }, 'blank'], [{ ok: false, reason: 'nothing' }, 'nothing'],
    [{ ok: false, reason: 'npm ERR! code 1' }, 'tool'], [{ ok: false }, 'tool'], [{ ok: true, pages: 0 }, 'nothing'], [{ ok: 'yes', pages: 9 }, 'tool']]) {
    const w = world({ mail: true });
    const { json } = await bring(w);
    const r = await answer(w, { job: copies(w.env)[0].id, ...said });
    assert.deepEqual([r.status, r.json, r.calls.length], [200, { ok: true, state: 'failed' }, 0], reason);
    assert.deepEqual([copies(w.env)[0].state, copies(w.env)[0].reason], ['failed', reason]);
    assert.equal(w.sent.length, 1);
    const trouble = copyTrouble(reason);
    const expected = copyFailedMail({ address: 'https://www.oakbakery.com', ...trouble, again: true, dashboard: 'https://app.example' });
    assert.deepEqual({ to: w.sent[0].to, subject: w.sent[0].subject, text: w.sent[0].text }, { to: 'rosa@example.com', subject: 'The copy of www.oakbakery.com did not work', text: expected.text });
    const me = await ask(w, 'GET', '/cloud/me');
    assert.deepEqual([me.json.sites[0].id, me.json.sites[0].bring.state, me.json.sites[0].bring.error, me.json.sites[0].bring.again], [json.site.id, 'failed', `${trouble.why} ${trouble.next}`, true]);
    assert.equal(w.notes.length, reason === 'tool' ? 2 : 1, 'the operator hears of a copy that stopped for a reason nobody named');
    assert.equal(sites(w.env).length, 1, 'the site stays, for another try');
  }
});

test('a site removed while it was being copied: the answer fails the copy and nobody is written to', { skip: d1Skip }, async () => {
  const w = world({ mail: true });
  await bring(w);
  w.env.kiln_cloud.exec('DELETE FROM sites');
  const r = await answer(w, { job: copies(w.env)[0].id, ok: true, pages: 25 });
  assert.deepEqual([r.status, r.json, r.calls.length, copies(w.env)[0].reason, w.sent.length], [200, { ok: true, state: 'failed' }, 0, 'removed', 0]);
});

// ─── POST /cloud/sites/bring/again ────────────────────────────────────────────

test('try again: a new job for the same address and repository, three tries for a site at most, and an earlier try\'s late answer changes nothing', { skip: d1Skip }, async () => {
  const w = world({ mail: true });
  const { json } = await bring(w);
  const id = json.site.id, repo = w.hub.made[0];
  const refusedWith = async (code, status, token = 'rosa', site = id) => {
    const r = await again(w, site, token);
    assert.deepEqual([r.status, r.json.code, r.json.error], [status, code, bringSentence(code)]);
  };
  assert.equal((await again(w, id, null)).status, 401);
  await refusedWith('still_copying', 409);
  const first = copies(w.env)[0].id;
  await answer(w, { job: first, ok: false, reason: 'unreachable' });

  const two = await again(w, id);
  assert.deepEqual([two.status, two.json.ok, two.json.site, two.json.bring.state, two.json.bring.error], [200, true, id, 'copying', null]);
  assert.deepEqual(copies(w.env).map(c => [c.state, c.tries, c.address, c.site_id]), [['failed', 1, 'https://www.oakbakery.com', id], ['copying', 2, 'https://www.oakbakery.com', id]]);
  const second = copies(w.env)[1].id;
  assert.notEqual(second, first);
  assert.deepEqual(w.hub.jobs[1], { ref: 'main', inputs: { job: second, address: 'https://www.oakbakery.com', repo, back: 'https://worker.example/cloud/convert/done', pages: '200' } });
  assert.equal(w.hub.made.length, 1, 'the same repository');
  // the first job answers after all
  const late = await answer(w, { job: first, ok: true, pages: 25 });
  assert.deepEqual([late.json, copies(w.env).map(c => c.state)], [{ ok: true, already: true }, ['failed', 'copying']]);

  // somebody else, a site that was not brought in, and a site that is not there
  person(w.env, 'omar', OMAR, 'acct-o');
  await refusedWith('no_such_site', 404, 'omar');
  await refusedWith('no_such_site', 404, 'rosa', 'no-such-site');
  w.env.kiln_cloud.exec("INSERT INTO sites (id, account_id, repo, origin, plan, status, created_at, kept, name) VALUES ('started-1', 'acct-g', 'kiln-sites/started-1', 'https://started.example', 'managed', 'trialing', 1, 1, 'Started')");
  await refusedWith('no_copy', 404, 'rosa', 'started-1');

  // the second try says nothing for more than half an hour: it can be tried again before the five-minute job has seen it
  w.env.kiln_cloud.exec('UPDATE conversions SET asked_at = ? WHERE id = ?', Date.now() - (COPY_MINUTES + 1) * 60000, second);
  assert.equal((await ask(w, 'GET', '/cloud/me')).json.sites.find(s => s.id === id).bring.again, true);
  const three = await again(w, id);
  assert.equal(three.status, 200, JSON.stringify(three.json));
  assert.deepEqual(copies(w.env).map(c => [c.state, c.reason, c.tries]), [['failed', 'unreachable', 1], ['failed', 'no_answer', 2], ['copying', MOST_TRIES, MOST_TRIES]].map(([s, r, t]) => [s, s === 'copying' ? null : r, t]));
  assert.equal(w.hub.jobs.length, 3);

  // the third fails: no fourth, and the row says to write instead of naming a button
  const third = copies(w.env)[2].id;
  await answer(w, { job: third, ok: false, reason: 'blank' });
  await refusedWith('no_more_tries', 409);
  const shown = (await ask(w, 'GET', '/cloud/me')).json.sites.find(s => s.id === id).bring;
  assert.deepEqual([shown.state, shown.again, shown.error], ['failed', false, copySentence('blank', { again: false })]);
  assert.equal(w.sent.at(-1).text.includes('Try again'), false);
  assert.deepEqual([w.hub.jobs.length, w.hub.made.length, w.hub.unsafe.length], [3, 1, 0]);

  // a copy that is done is not made again
  const done = world();
  const made = await bring(done);
  await answer(done, { job: copies(done.env)[0].id, ok: true, pages: 2 });
  const r = await again(done, made.json.site.id);
  assert.deepEqual([r.status, r.json.code, done.hub.jobs.length], [409, 'copied', 1]);
});

// ─── What the dashboard is told ───────────────────────────────────────────────

test('what the dashboard is told: brings on /cloud/me and /healthz, bring on a site that was brought in, and the report for its owner alone', { skip: d1Skip }, async () => {
  const w = world();
  assert.equal((await ask(w, 'GET', '/healthz', null, null)).json.brings, true, 'known before anybody is signed in');
  const off = world({ env: { CONVERT_SECRET: '' } });
  assert.deepEqual([(await ask(off, 'GET', '/healthz', null, null)).json.brings, (await ask(off, 'GET', '/cloud/me')).json.brings], [false, false]);
  let me = await ask(w, 'GET', '/cloud/me');
  assert.deepEqual([me.json.brings, me.json.sites], [true, []]);

  const { json } = await bring(w);
  const id = json.site.id, [copy] = copies(w.env);
  const copying = { state: 'copying', address: 'https://www.oakbakery.com', asked_at: copy.asked_at, done_at: null, pages: null, rendered: false, error: null, again: false };
  assert.deepEqual((await ask(w, 'GET', '/cloud/me')).json.sites[0].bring, copying);
  assert.deepEqual((await ask(w, 'GET', `/cloud/sites/bring?site=${id}`)).json, { ok: true, bring: { ...copying, report: '', tries: 1 } });

  await answer(w, { job: copy.id, ok: true, pages: 25, rendered: true, report: REPORT });
  const done = { ...copying, state: 'done', done_at: copies(w.env)[0].done_at, pages: 25, rendered: true };
  me = await ask(w, 'GET', '/cloud/me');
  assert.deepEqual(me.json.sites[0].bring, done, 'no report in the list of sites');
  const one = await ask(w, 'GET', `/cloud/sites/bring?site=${id}`);
  assert.deepEqual([one.status, one.json], [200, { ok: true, bring: { ...done, report: SHOWN_REPORT, tries: 1 } }]);

  // nobody else is told
  person(w.env, 'omar', OMAR, 'acct-o');
  const other = await ask(w, 'GET', `/cloud/sites/bring?site=${id}`, null, 'omar');
  assert.deepEqual([other.status, other.json], [404, { error: bringSentence('no_such_site'), code: 'no_such_site' }]);
  assert.equal((await ask(w, 'GET', `/cloud/sites/bring?site=${id}`, null, null)).status, 401);
  // a site that was not brought in says nothing about it
  addSite(w.env);
  me = await ask(w, 'GET', '/cloud/me', null, 'tok');
  assert.deepEqual([me.json.brings, me.json.sites.length, 'bring' in me.json.sites[0]], [true, 1, false]);
});

// ─── The five-minute job ──────────────────────────────────────────────────────

test('the five-minute job gives up on a copy that has said nothing for 30 minutes, tells its owner and the operator once, takes ten at a time, and never throws', { skip: d1Skip }, async () => {
  const w = world({ mail: true });
  const { json } = await bring(w);
  const [copy] = copies(w.env);
  const at = (minutes) => copy.asked_at + minutes * 60000;
  await withFetch(w.hub.handler, async (calls) => {
    assert.deepEqual(await sweepBrings(w.env), { failed: 0 });
    assert.deepEqual(await sweepBrings(w.env, { now: at(29) }), { failed: 0 });
    assert.deepEqual([copies(w.env)[0].state, w.sent.length, w.notes.length], ['copying', 0, 1]);
    assert.deepEqual(await sweepBrings(w.env, { now: at(31) }), { failed: 1 });
    assert.deepEqual([copies(w.env)[0].state, copies(w.env)[0].reason, copies(w.env)[0].done_at], ['failed', 'no_answer', at(31)]);
    assert.equal(w.sent.length, 1);
    const expected = copyFailedMail({ address: 'https://www.oakbakery.com', ...copyTrouble('no_answer'), again: true, dashboard: 'https://app.example' });
    assert.deepEqual({ to: w.sent[0].to, subject: w.sent[0].subject, text: w.sent[0].text }, { to: 'rosa@example.com', subject: 'The copy of www.oakbakery.com did not work', text: expected.text });
    assert.ok(w.sent[0].text.includes('The copy did not finish in 30 minutes.'));
    assert.equal(w.notes.length, 2, 'the operator is told');
    assert.deepEqual(await sweepBrings(w.env, { now: at(40) }), { failed: 0 });
    assert.deepEqual([w.sent.length, w.notes.length, calls.length], [1, 2, 0], 'once, and GitHub is not asked');
  });
  // the job answers after all: too late, and Try again is there
  assert.deepEqual((await answer(w, { job: copy.id, ok: true, pages: 25 })).json, { ok: true, already: true });
  assert.equal((await ask(w, 'GET', '/cloud/me')).json.sites[0].bring.again, true);
  assert.equal((await again(w, json.site.id)).status, 200);

  // ten at most in one run
  const many = world();
  for (let i = 0; i < 12; i++) {
    many.env.kiln_cloud.exec("INSERT INTO conversions (id, site_id, account_id, address, branch, state, tries, asked_at, created_at, updated_at) VALUES (?, ?, 'acct-g', 'https://old.example.org', 'main', 'copying', 1, ?, 1, 1)",
      String(i).padStart(32, '0'), `gone-${i}`, 1000 + i);
  }
  assert.deepEqual(await sweepBrings(many.env), { failed: 10 });
  assert.deepEqual(await sweepBrings(many.env), { failed: 2 });
  assert.equal(copies(many.env).every(c => c.state === 'failed' && c.reason === 'no_answer'), true);

  // never throws
  assert.deepEqual(await sweepCopies(undefined), { failed: 0 });
  assert.deepEqual(await sweepCopies({ CONVERT_SECRET: 's' }), { failed: 0 });
  assert.deepEqual(await sweepCopies({ CONVERT_SECRET: 's', kiln_cloud: { prepare() { throw new Error('the database is away'); } } }), { failed: 0 });
  assert.deepEqual(await sweepCopies(world({ env: { d1: { upTo: 8 } } }).env), { failed: 0 });
  assert.deepEqual(await sweepCopies(many.env, { note: async () => { throw new Error('no mail today'); } }), { failed: 0 });
});

// ─── The two mails ────────────────────────────────────────────────────────────

test('the mail for a copy that worked: how many pages, that the site is up and where or which button puts it up, what did not come across, how the editor opens, and the free days as the welcome mail says them', () => {
  const endsAt = Date.UTC(2026, 10, 20, 12);
  const mail = siteCopiedMail({ name: 'Oak Bakery', address: 'https://oak-bakery-1a2b3c4d.kiln-sites.workers.dev/', up: true, from: 'https://www.oakbakery.com/', pages: 25, endsAt, dashboard: 'https://app.example' });
  const welcome = siteStartedMail({ name: 'Oak Bakery', address: 'https://x.example', endsAt, dashboard: 'https://app.example' }).text.split('\n\n');
  const free = welcome.filter(p => p.startsWith('The site is free until') || p.startsWith('If you do not subscribe by'));
  assert.equal(free.length, 2);
  assert.equal(mail.subject, 'Your site is copied');
  assert.deepEqual(mail.text.split('\n\n'), [
    'Hello,',
    'Kiln copied 25 pages from www.oakbakery.com into a new site called Oak Bakery. Kiln keeps its files for you, so there is nothing to install and nothing to store. Your old site was only read, and nothing on it was changed.',
    'The copy is up at its temporary address, https://oak-bakery-1a2b3c4d.kiln-sites.workers.dev. Open that address to see your site.',
    "Some things did not come across: shops and carts, forms that posted to the old site, logins and members' areas. The report on the site's row in your dashboard lists what to check.",
    "To edit the site, open your dashboard and press Open the editor on the site's row. There is no password. Click any outlined words or picture, change them, and press Publish.",
    ...free,
    'Your dashboard:',
    'https://app.example',
    'Kiln\nYou are getting this because a copy of www.oakbakery.com was asked for on Kiln Cloud with this email address. Reply to this email to reach a person.\n',
  ]);
  assert.match(siteCopiedMail({ name: 'Oak Bakery', address: 'https://a.example', from: 'https://b.example.org', pages: 1, endsAt, dashboard: 'https://app.example' }).text, /Kiln copied 1 page from b\.example\.org /);
  assert.equal(/GitHub|repositor|—|–|undefined/.test(mail.text + mail.html), false);
  assert.ok(mail.html.includes('<a href="https://app.example"'));
  // the site could not be put up: the same mail, except for the one paragraph that says which button does it
  const notUp = siteCopiedMail({ name: 'Oak Bakery', address: 'https://oak-bakery-1a2b3c4d.kiln-sites.workers.dev/', from: 'https://www.oakbakery.com/', pages: 25, endsAt, dashboard: 'https://app.example' });
  const [was, is] = [mail.text.split('\n\n'), notUp.text.split('\n\n')];
  assert.equal(notUp.subject, 'Your site is copied');
  assert.equal(is[2], "The copy is not up yet. Open your dashboard and press Put it on Kiln's hosting on the site's row. The site is then up at its temporary address, https://oak-bakery-1a2b3c4d.kiln-sites.workers.dev, about a minute later.");
  assert.deepEqual(is.filter((_, i) => i !== 2), was.filter((_, i) => i !== 2));
  assert.equal(/GitHub|repositor|—|–|undefined/.test(notUp.text + notUp.html), false);
});

test('the mail for a copy that did not work: the reason, what to try, that nothing was charged, and where Try again is', () => {
  const mail = copyFailedMail({ address: 'https://www.oakbakery.com', ...copyTrouble('unreachable'), again: true, dashboard: 'https://app.example' });
  assert.equal(mail.subject, 'The copy of www.oakbakery.com did not work');
  assert.deepEqual(mail.text.split('\n\n'), [
    'Hello,',
    'Kiln tried to copy www.oakbakery.com and it did not work. The site at that address did not answer, or it refused to be read.',
    'Check that the address is right and that the site opens in a browser, then press Try again.',
    "The Try again button is on the site's row in your dashboard. Nothing was charged for this, and your old site was not changed.",
    'Your dashboard:',
    'https://app.example',
    'Kiln\nYou are getting this because a copy of www.oakbakery.com was asked for on Kiln Cloud with this email address. Reply to this email to reach a person.\n',
  ]);
  const last = copyFailedMail({ address: 'https://www.oakbakery.com/shop', ...copyTrouble('blank', { again: false }), again: false, dashboard: 'https://app.example' });
  assert.equal(last.subject, 'The copy of www.oakbakery.com/shop did not work');
  assert.deepEqual(last.text.split('\n\n').slice(1, 4), [
    'Kiln tried to copy www.oakbakery.com/shop and it did not work. The pages came out blank, even when Kiln opened them in a browser.',
    'Kiln has tried 3 times. Write to info@kilncms.com and we will look at it with you.',
    'Nothing was charged for this, and your old site was not changed.',
  ]);
  for (const m of [mail, last]) assert.equal(/GitHub|repositor|—|–|undefined/.test(m.text + m.html), false);
});

test('the report a customer reads leaves out what only a person at a terminal could do', () => {
  const report = [
    '# What was copied from https://oakbakery.example',
    '',
    '- Pages copied: 12. 30 more addresses were found and not tried, because the run was set to stop after 200 pages (--max-pages). To copy them too, run again with a bigger --max-pages.',
    '- Marked so you can edit them: 240 pieces of text, 31 pictures, 4 lists of blocks, 12 menus',
    '',
    '## What to check',
    '',
    '- Phone menu: the button does not open the menu on a phone. Run again with --menu-shim to add a small script that opens it.',
    'To copy the pages as they look once they are drawn, run the rescue again with `--render`, from the same folder you ran it in:',
    '',
    '```',
    'npx github:kilncms/kiln#release rescue https://oakbakery.example --render --out=site',
    '```',
    '',
    '- Forms that posted into the old site: 1, on /contact. It no longer sends anything.',
    '',
    '## Next steps',
    '',
    '1. Create a GitHub repo and push (`gh repo create my-site --private --source . --push`).',
  ].join('\n');
  const said = cutReport(report);
  assert.equal(said, [
    '# What was copied from https://oakbakery.example',
    '',
    '- Pages copied: 12. 30 more addresses were found and not tried, because the run was set to stop after 200 pages.',
    '- Marked so you can edit them: 240 pieces of text, 31 pictures, 4 lists of blocks, 12 menus',
    '',
    '## What to check',
    '',
    '- Phone menu: the button does not open the menu on a phone.',
    '',
    '- Forms that posted into the old site: 1, on /contact. It no longer sends anything.',
  ].join('\n'));
  assert.equal(/--|npx|```|Next steps/.test(said), false);
  // a report with nothing of the kind is as it was
  assert.equal(withoutCommands('- Pages copied: 3.\n- Scripts taken out: 2.'), '- Pages copied: 3.\n- Scripts taken out: 2.');
});
