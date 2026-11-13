/**
 * Which repositories can Kiln reach for the person who is signed in?
 *
 * On the plan where a site lives in the customer's own GitHub repository,
 * Kiln's GitHub App has to be installed on it. The dashboard could not tell
 * whether it was, or on which repositories, so the person typed `owner/name`
 * from memory. GET /cloud/github is the answer the dashboard was missing: is
 * the App on the person's account, and which repositories it can reach there.
 * GET /cloud/github?repo=owner/name answers for one repository, which is how a
 * repository of an organization is asked about.
 *
 * GitHub is played by test/github-fake.js (fakeInstallation). Nothing here
 * touches the network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import worker from '../worker/index.js';
import { installUrl, accountReach, repoReach } from '../worker/cloud.js';
import { fakeKV, withFetch, jsonRes } from './worker-harness.js';
import { fakeInstallation } from './github-fake.js';
import { cloudEnv, addSite, d1Skip } from './d1-fake.js';

const GH = 'https://api.github.com';
const PK8 = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
const STAGING = 'https://github.com/apps/kiln-cms-staging/installations/new';
const appCreds = (over = {}) => JSON.stringify({ app_id: 1, slug: 'kiln-cms-staging', client_id: 'cid', client_secret: 'sec', pk8: PK8, ...over });

/** A service with its App's keys, and 'ada' (GitHub number 7) signed in to the dashboard with token 'tok'. */
function env({ creds = {}, sess = {}, extra = {} } = {}) {
  const kv = fakeKV();
  kv.map.set('app:creds', appCreds(creds));
  const e = cloudEnv(kv, extra);
  kv.map.set('csess:tok', JSON.stringify({ account_id: 'acct-1', login: 'ada', uid: 7, gh: 'gho_x', ...sess }));
  return e;
}
const get = (e, path = '/cloud/github', token = 'tok') =>
  worker.fetch(new Request(`https://worker.example${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} }), e);
const answer = async (e, path) => { const res = await get(e, path); return { status: res.status, body: await res.json() }; };
/** Make a kept answer four seconds older (or `ms`), as if the person had waited. */
const wait = (e, key = 'cgh:acct-1', ms = 4000) => { const v = JSON.parse(e.KILN.map.get(key)); v.at -= ms; e.KILN.map.set(key, JSON.stringify(v)); };
const asked = (gh) => gh.calls.map(c => `${c.method} ${c.path}`);
const LOOKUP = 'GET /users/ada/installation';
const TOKEN = 'POST /app/installations/9001/access_tokens';
const LIST = 'GET /installation/repositories';

/** GitHub about single repositories: `reach` is what the App is told, `push` what the person's own sign-in is told. */
function oneRepo({ reach = {}, push = {} } = {}) {
  const calls = [];
  const said = (a, ok) => { if (a === 'throw') throw new TypeError('fetch failed'); return typeof a === 'number' ? jsonRes({ message: 'no' }, a) : a === undefined ? jsonRes({ message: 'Not Found' }, 404) : ok(a); };
  const handler = async (url, init = {}) => {
    const auth = (init.headers || {}).Authorization || '';
    let m;
    if ((m = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/installation$/.exec(url))) { calls.push({ what: 'app', repo: m[1], auth }); return said(reach[m[1]], () => jsonRes({ id: 4242 })); }
    if ((m = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)$/.exec(url))) { calls.push({ what: 'person', repo: m[1], auth }); return said(push[m[1]], (a) => jsonRes({ full_name: m[1], permissions: { push: a === true, admin: false } })); }
  };
  return { calls, handler };
}

// ─── The list for the person's own account ────────────────────────────────────

test('/cloud/github: nobody signed in is refused, and GitHub is not asked', { skip: d1Skip }, async () => {
  const e = env();
  await withFetch(fakeInstallation().handler, async (calls) => {
    assert.equal((await get(e, '/cloud/github', null)).status, 401);
    assert.equal((await get(e, '/cloud/github', 'not-a-session')).status, 401);
    assert.equal((await get(e, '/cloud/github?repo=ada/club', null)).status, 401);
    assert.equal(calls.length, 0);
  });
});

test('/cloud/github: a person signed in with Google is told a GitHub sign-in is needed, and GitHub is not asked', { skip: d1Skip }, async () => {
  const e = env({ sess: { login: null, uid: null, gh: null, google: { sub: 'g-1', email: 'rosa@example.com', name: 'Rosa Diaz' } } });
  await withFetch(fakeInstallation().handler, async (calls) => {
    for (const path of ['/cloud/github', '/cloud/github?repo=ada/club']) {
      const { status, body } = await answer(e, path);
      assert.equal(status, 200);
      assert.deepEqual(body, { ok: true, installed: false, code: 'needs_github', repos: [] });
    }
    assert.equal(calls.length, 0);
  });
});

test('/cloud/github: the App is not on the account yet, and is seen once the person has installed it', { skip: d1Skip }, async () => {
  const e = env();
  const gh = fakeInstallation({ installed: false, repos: [{ full_name: 'ada/club' }] });
  await withFetch(gh.handler, async () => {
    const first = await answer(e);
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, { ok: true, installed: false, selection: null, install_url: STAGING, manage_url: null, repos: [], more: false });
    assert.deepEqual(asked(gh), [LOOKUP], 'one question, as the App, and no token asked for');
    gh.state.installed = true;
    assert.equal((await answer(e)).body.installed, false, 'the same answer for three seconds');
    assert.equal(gh.calls.length, 1);
    wait(e);
    const later = (await answer(e)).body;
    assert.equal(later.installed, true);
    assert.deepEqual(later.repos.map(r => r.repo), ['ada/club']);
  });
});

test('/cloud/github: the App is installed with no repository chosen', { skip: d1Skip }, async () => {
  const e = env();
  await withFetch(fakeInstallation({ repos: [] }).handler, async () => {
    assert.deepEqual((await answer(e)).body, { ok: true, installed: true, selection: 'selected', install_url: STAGING, manage_url: STAGING, repos: [], more: false });
  });
});

test('/cloud/github: each repository says its name, whether it is private, its website and whether it is already a site here', { skip: d1Skip }, async () => {
  const e = env();
  addSite(e, { repo: 'Ada/Club' });   // GitHub's names ignore letter case
  addSite(e, { id: 'site-2', account_id: 'acct-2', repo: 'ada/notes', origin: 'https://notes.example' });   // somebody else's site
  const gh = fakeInstallation({ selection: 'all', repos: [
    { full_name: 'ada/club', private: true, homepage: 'https://club.example' },
    { full_name: 'ada/notes', private: false, homepage: 'http://notes.example' },
    { full_name: 'ada/long', private: false, homepage: `https://long.example/${'a'.repeat(200)}` },
    { full_name: 'ada/blank', private: false, homepage: '' },
    { full_name: 'ada/odd', private: false, homepage: 'javascript:alert(1)' },
  ] });
  await withFetch(gh.handler, async (calls) => {
    const res = await get(e);
    const text = await res.text();
    const body = JSON.parse(text);
    assert.deepEqual(body, { ok: true, installed: true, selection: 'all', install_url: STAGING, manage_url: STAGING, more: false, repos: [
      { repo: 'ada/club', private: true, homepage: 'https://club.example', added: true },
      { repo: 'ada/notes', private: false, homepage: null, added: false },
      { repo: 'ada/long', private: false, homepage: null, added: false },
      { repo: 'ada/blank', private: false, homepage: null, added: false },
      { repo: 'ada/odd', private: false, homepage: null, added: false },
    ] });
    // GitHub is asked three things, in this order.
    assert.deepEqual(asked(gh), [LOOKUP, TOKEN, LIST]);
    assert.match(gh.calls[0].auth, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/, 'the installation is asked for as the App');
    assert.deepEqual(gh.calls[1].body, { permissions: { metadata: 'read' } }, 'the token may read the list and nothing else');
    assert.equal(gh.calls[2].auth, 'Bearer ghs_list_1');
    assert.equal(calls[2].url, `${GH}/installation/repositories?per_page=100`);
    assert.equal(calls.some(c => c.headers.Authorization === 'Bearer gho_x'), false, "the person's own sign-in is not used for the list");
    // Neither the token nor the installation's number leaves the service.
    assert.doesNotMatch(text, /ghs_|9001|settings\/installations/);
  });
});

test('/cloud/github: more than a hundred repositories gives the first hundred and says there are more', { skip: d1Skip }, async () => {
  const many = (n) => Array.from({ length: n }, (_, i) => ({ full_name: `ada/site-${i}` }));
  for (const [n, shown, more] of [[150, 100, true], [100, 100, false], [1, 1, false]]) {
    const e = env();
    await withFetch(fakeInstallation({ repos: many(n) }).handler, async () => {
      const { body } = await answer(e);
      assert.equal(body.repos.length, shown);
      assert.equal(body.more, more);
      assert.equal(body.repos[0].repo, 'ada/site-0');
    });
  }
});

test('/cloud/github: when GitHub does not answer, installed is null and nothing is kept', { skip: d1Skip }, async () => {
  const silent = [
    ['a fault at the first question', (m, p) => p === '/users/ada/installation' && 500],
    ['no answer at all', (m, p) => p === '/users/ada/installation' && 'throw'],
    ['a limit GitHub asks everyone to wait out', (m, p) => p === '/users/ada/installation' && jsonRes({ message: 'slow down' }, 403, { 'retry-after': '30' })],
    ['a fault when the token is asked for', (m, p) => m === 'POST' && 502],
    ['a fault when the list is asked for', (m, p) => p === '/installation/repositories' && 503],
  ];
  for (const [what, fail] of silent) {
    const e = env();
    const gh = fakeInstallation({ repos: [{ full_name: 'ada/club' }] });
    gh.failOn(fail);
    await withFetch(gh.handler, async () => {
      const { status, body } = await answer(e);
      assert.equal(status, 200, what);
      assert.deepEqual(body, { ok: true, installed: null, selection: null, install_url: STAGING, manage_url: null, repos: [], more: false }, what);
      assert.equal(e.KILN.map.has('cgh:acct-1'), false, `${what}: not kept`);
      // GitHub is back: the very next ask is answered, with no three seconds to wait out.
      gh.failOn(null);
      assert.equal((await answer(e)).body.installed, true, what);
    });
  }
});

test('/cloud/github: an answer is kept for three seconds and the token for the list for one minute', { skip: d1Skip }, async () => {
  const e = env();
  const gh = fakeInstallation({ repos: [{ full_name: 'ada/club' }] });
  await withFetch(gh.handler, async () => {
    assert.equal((await answer(e)).body.repos[0].added, false);
    assert.equal(gh.calls.length, 3);
    // A second tab, a moment later: GitHub is not asked, and a site added meanwhile still shows as added.
    addSite(e, { repo: 'ada/club' });
    assert.equal((await answer(e)).body.repos[0].added, true);
    assert.equal(gh.calls.length, 3);
    const now = Math.floor(Date.now() / 1000);
    assert.ok(e.KILN.expires.get('cgh:acct-1') - now <= 60, 'the kept answer leaves KV within a minute');
    assert.ok(Math.abs(e.KILN.expires.get('itok-acct:9001') - now - 60) <= 2, 'the token is kept for one minute');
    assert.equal(e.KILN.map.get('itok-acct:9001'), 'ghs_list_1');
    // After three seconds GitHub is asked again, with the token it already has.
    wait(e);
    gh.state.repos.push({ full_name: 'ada/notes' });
    assert.deepEqual((await answer(e)).body.repos.map(r => r.repo), ['ada/club', 'ada/notes'], 'a repository the person just let Kiln reach is in the list');
    assert.deepEqual(asked(gh).slice(3), [LOOKUP, LIST]);
    // GitHub has ended the kept token: a new one is asked for, once.
    wait(e);
    gh.tokens.clear();
    assert.equal((await answer(e)).body.installed, true);
    assert.deepEqual(asked(gh).slice(5), [LOOKUP, LIST, TOKEN, LIST]);
    assert.equal(e.KILN.map.get('itok-acct:9001'), 'ghs_list_2');
  });
});

test('/cloud/github: a login that now belongs to somebody else shows none of their repositories', { skip: d1Skip }, async () => {
  const e = env();   // ada signed in as GitHub number 7
  const gh = fakeInstallation({ uid: 99, repos: [{ full_name: 'ada/secret', private: true }] });
  await withFetch(gh.handler, async () => {
    const { body } = await answer(e);
    assert.equal(body.installed, false);
    assert.deepEqual(body.repos, []);
    assert.deepEqual(asked(gh), [LOOKUP], 'the list was never asked for');
  });
});

test('/cloud/github: the install address is for the App this service holds the keys of', { skip: d1Skip }, async () => {
  const e = env({ creds: { slug: undefined } });
  await withFetch(fakeInstallation({ installed: false }).handler, async () => {
    assert.equal((await answer(e)).body.install_url, 'https://github.com/apps/kiln-cms/installations/new');
  });
  assert.equal(installUrl({ slug: 'kiln-cms-staging' }), STAGING);
  assert.equal(installUrl(null), 'https://github.com/apps/kiln-cms/installations/new');
  assert.equal(installUrl({ slug: 'x/../y?z' }), 'https://github.com/apps/kiln-cms/installations/new');
});

test('adding a repository the App is not on yet sends the person to the App this service runs on', { skip: d1Skip }, async () => {
  const e = env();
  await withFetch(async () => undefined, async () => {   // GitHub: the App is on nothing
    const res = await worker.fetch(new Request('https://worker.example/cloud/sites', { method: 'POST',
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' }, body: JSON.stringify({ repo: 'ada/club', origin: 'https://club.example' }) }), e);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).install_url, STAGING);
  });
});

// ─── One repository: /cloud/github?repo=owner/name ────────────────────────────

test('/cloud/github?repo=: a repository of the person\'s own that the App can reach', { skip: d1Skip }, async () => {
  const e = env();
  const gh = oneRepo({ reach: { 'Ada/Club': true } });
  await withFetch(gh.handler, async () => {
    const { status, body } = await answer(e, '/cloud/github?repo=Ada/Club');
    assert.equal(status, 200);
    assert.deepEqual(body, { ok: true, repo: 'Ada/Club', installed: true, yours: true });
    assert.deepEqual(gh.calls.map(c => c.what), ['app'], 'a repository under the person\'s own login is theirs without asking');
    assert.match(gh.calls[0].auth, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    await answer(e, '/cloud/github?repo=Ada/Club');
    assert.equal(gh.calls.length, 1, 'kept for three seconds');
    wait(e, 'cgh:acct-1:ada/club');
    await answer(e, '/cloud/github?repo=Ada/Club');
    assert.equal(gh.calls.length, 2);
  });
});

test('/cloud/github?repo=: the App cannot reach the repository', { skip: d1Skip }, async () => {
  const e = env();
  await withFetch(oneRepo().handler, async () => {
    assert.deepEqual((await answer(e, '/cloud/github?repo=ada/club')).body, { ok: true, repo: 'ada/club', installed: false, yours: true });
  });
});

test('/cloud/github?repo=: a repository of an organization, the person\'s to change or not', { skip: d1Skip }, async () => {
  const cases = [
    ['may change it', { reach: { 'acme/site': true }, push: { 'acme/site': true } }, { installed: true, yours: true }],
    // Not the person's: whether the App is on it is nobody else's to know, so the App is not asked at all.
    ['may read it only', { reach: { 'acme/site': true }, push: { 'acme/site': false } }, { installed: null, yours: false }],
    ['cannot see it', { reach: { 'acme/site': true } }, { installed: null, yours: false }],
    ['theirs, and the App is not on it', { push: { 'acme/site': true } }, { installed: false, yours: true }],
  ];
  for (const [what, github, expected] of cases) {
    const e = env();
    const gh = oneRepo(github);
    await withFetch(gh.handler, async () => {
      assert.deepEqual((await answer(e, '/cloud/github?repo=acme/site')).body, { ok: true, repo: 'acme/site', ...expected }, what);
      assert.deepEqual(gh.calls.map(c => c.what), expected.yours ? ['person', 'app'] : ['person'], `${what}: the person's own sign-in is asked first, and the App only for a repository that is theirs`);
      assert.equal(gh.calls[0].auth, 'Bearer gho_x', 'asked with the person\'s own sign-in');
    });
  }
});

test('/cloud/github?repo=: when GitHub does not answer, the answer is null and nothing is kept', { skip: d1Skip }, async () => {
  const cases = [
    // GitHub is silent about whether it is the person's: the App is not asked, so each look is one request.
    [{ reach: { 'acme/site': true }, push: { 'acme/site': 503 } }, { installed: null, yours: null }, 2],
    [{ reach: { 'acme/site': true }, push: { 'acme/site': 'throw' } }, { installed: null, yours: null }, 2],
    [{ reach: { 'acme/site': 500 }, push: { 'acme/site': true } }, { installed: null, yours: true }, 4],
    [{ reach: { 'acme/site': 'throw' }, push: { 'acme/site': true } }, { installed: null, yours: true }, 4],
  ];
  for (const [github, expected, requests] of cases) {
    const e = env();
    const gh = oneRepo(github);
    await withFetch(gh.handler, async () => {
      assert.deepEqual((await answer(e, '/cloud/github?repo=acme/site')).body, { ok: true, repo: 'acme/site', ...expected });
      assert.equal([...e.KILN.map.keys()].some(k => k.startsWith('cgh:')), false, 'not kept');
      await answer(e, '/cloud/github?repo=acme/site');
      assert.equal(gh.calls.length, requests, 'asked again at once');
    });
  }
});

test('/cloud/github?repo=: nobody learns whether a stranger\'s private repository exists or has Kiln on it', { skip: d1Skip }, async () => {
  // The same answer for a repository with Kiln on it, one without, and a name nobody has.
  for (const reach of [{ 'stranger/secret': true }, { 'stranger/secret': 404 }, {}]) {
    const e = env();
    const gh = oneRepo({ reach });
    await withFetch(gh.handler, async () => {
      assert.deepEqual((await answer(e, '/cloud/github?repo=stranger/secret')).body, { ok: true, repo: 'stranger/secret', installed: null, yours: false });
      assert.deepEqual(gh.calls.map(c => c.what), ['person'], 'GitHub is never asked as Kiln\'s App about it');
    });
  }
});

test('/cloud/github?repo=: a "no" is kept for a minute, so looking every four seconds asks GitHub once a minute', { skip: d1Skip }, async () => {
  const cases = [
    ['the App is not on it yet', 'ada/club', {}, { installed: false, yours: true }, 1],
    ['not the person\'s', 'acme/site', { reach: { 'acme/site': true }, push: { 'acme/site': false } }, { installed: null, yours: false }, 1],
  ];
  for (const [what, repo, github, expected, each] of cases) {
    const e = env();
    const gh = oneRepo(github);
    await withFetch(gh.handler, async () => {
      // Fourteen looks, four seconds apart: 56 seconds, one ask.
      for (let i = 0; i < 14; i++) {
        assert.deepEqual((await answer(e, `/cloud/github?repo=${repo}`)).body, { ok: true, repo, ...expected }, what);
        wait(e, `cgh:acct-1:${repo}`);
      }
      assert.equal(gh.calls.length, each, `${what}: asked once in the minute`);
      wait(e, `cgh:acct-1:${repo}`, 5000);
      await answer(e, `/cloud/github?repo=${repo}`);
      assert.equal(gh.calls.length, 2 * each, `${what}: asked again after the minute`);
    });
  }
});

test('/cloud/github?repo=: one account may ask about thirty different repositories in an hour', { skip: d1Skip }, async () => {
  const e = env();
  e.KILN.map.set('csess:tok2', JSON.stringify({ account_id: 'acct-2', login: 'bea', uid: 8, gh: 'gho_y' }));
  const gh = oneRepo({ reach: { 'ada/site-1': true } });
  await withFetch(gh.handler, async () => {
    for (let i = 1; i <= 30; i++) assert.equal((await answer(e, `/cloud/github?repo=ada/site-${i}`)).status, 200, `name ${i}`);
    assert.equal(gh.calls.length, 30);
    const hour = Math.floor(Date.now() / 3600000);
    const counted = [...e.KILN.map.keys()].filter(k => k.startsWith('cghn:'));
    assert.equal(counted.length, 1);
    assert.match(counted[0], /^cghn:acct-1:\d+$/);
    assert.ok(Math.abs(Number(counted[0].split(':')[2]) - hour) <= 1, 'the count is for this hour');
    assert.equal(JSON.parse(e.KILN.map.get(counted[0])).length, 30);
    const left = e.KILN.expires.get(counted[0]) - Math.floor(Date.now() / 1000);
    assert.ok(left > 7190 && left <= 7200, 'the count is gone after two hours');

    // The thirty-first name is refused, under the person's own login or anybody else's, and GitHub is not asked.
    for (const name of ['ada/site-31', 'acme/site']) {
      const over = await answer(e, `/cloud/github?repo=${name}`);
      assert.equal(over.status, 429, name);
      assert.deepEqual(over.body, { error: 'You have asked about many repositories in a short time. Wait a few minutes, then try again.', code: 'too_many' });
    }
    assert.equal(gh.calls.length, 30, 'a refused name costs nothing at GitHub');
    assert.equal(e.KILN.map.has('cgh:acct-1:ada/site-31'), false, 'the refusal is not kept as an answer');

    // A name already asked about this hour is still answered: from the kept answer, and afresh once that is old.
    assert.deepEqual((await answer(e, '/cloud/github?repo=ada/site-1')).body, { ok: true, repo: 'ada/site-1', installed: true, yours: true });
    assert.equal(gh.calls.length, 30, 'from the kept answer');
    wait(e, 'cgh:acct-1:ada/site-1');
    assert.equal((await answer(e, '/cloud/github?repo=Ada/Site-1')).status, 200);
    assert.equal(gh.calls.length, 31, 'asked afresh, and not counted a second time');
    assert.equal(JSON.parse(e.KILN.map.get(counted[0])).length, 30);

    // Somebody else's account has its own thirty.
    assert.equal((await answer(e, '/cloud/github?repo=bea/blog')).status, 429, 'sanity: the first account is still over');
    const other = await worker.fetch(new Request('https://worker.example/cloud/github?repo=bea/blog', { headers: { Authorization: 'Bearer tok2' } }), e);
    assert.equal(other.status, 200);

    // In the next hour the first account may ask again.
    e.KILN.map.set(`cghn:acct-1:${Number(counted[0].split(':')[2]) - 1}`, e.KILN.map.get(counted[0]));
    e.KILN.map.delete(counted[0]);
    assert.equal((await answer(e, '/cloud/github?repo=ada/site-31')).status, 200);
  });
});

test('/cloud/github?repo=: a name that is not owner/name is refused, and so is a repository Kiln keeps for a site', { skip: d1Skip }, async () => {
  const e = env({ extra: { KEEP_ORG: 'kiln-keeps' } });
  const gh = oneRepo({ reach: { 'kiln-keeps/somebody': true } });
  await withFetch(gh.handler, async () => {
    for (const name of ['', 'club', 'a/b/c', 'a%20b/c', 'https://github.com/ada/club']) {
      const { status, body } = await answer(e, `/cloud/github?repo=${name}`);
      assert.equal(status, 400, name);
      assert.equal(body.error, 'The repository should look like owner/name, for example acme/website.');
    }
    const kept = await answer(e, '/cloud/github?repo=Kiln-Keeps/somebody');
    assert.equal(kept.status, 403);
    assert.equal(kept.body.code, 'in_keep_org');
    assert.equal(gh.calls.length, 0, 'GitHub is not asked about any of them');
  });
});

// ─── The two questions by themselves (no database, so these run on Node 20 too) ─

test('accountReach: installed, not installed, and GitHub silent', async () => {
  const kv = () => ({ KILN: fakeKV({ 'app:creds': appCreds() }) });
  const gh = fakeInstallation({ repos: [{ full_name: 'ada/club', private: true, homepage: 'https://club.example' }] });
  await withFetch(gh.handler, async () => {
    assert.deepEqual(await accountReach(kv(), { login: 'ada', uid: 7 }), { installed: true, selection: 'selected', repos: [{ repo: 'ada/club', private: true, homepage: 'https://club.example' }], more: false });
    assert.deepEqual(await accountReach(kv(), { login: 'ada' }), { installed: true, selection: 'selected', repos: [{ repo: 'ada/club', private: true, homepage: 'https://club.example' }], more: false }, 'a session from before the number was kept');
    assert.equal((await accountReach(kv(), { login: 'ada', uid: 8 })).installed, false);
    gh.state.installed = false;
    assert.deepEqual(await accountReach(kv(), { login: 'ada', uid: 7 }), { installed: false, selection: null, repos: [], more: false });
    gh.failOn(() => 500);
    assert.equal((await accountReach(kv(), { login: 'ada', uid: 7 })).installed, null);
  });
  // A service that has no App yet cannot ask at all.
  await withFetch(gh.handler, async (calls) => {
    assert.equal((await accountReach({ KILN: fakeKV() }, { login: 'ada', uid: 7 })).installed, null);
    assert.equal(calls.length, 0);
  });
});

test('repoReach: yes, no, and GitHub silent', async () => {
  const e = { KILN: fakeKV({ 'app:creds': appCreds() }) };
  const gh = oneRepo({ reach: { 'ada/club': true, 'ada/busy': 502, 'ada/gone': 'throw' } });
  await withFetch(gh.handler, async () => {
    assert.equal(await repoReach(e, 'ada/club'), true);
    assert.equal(await repoReach(e, 'ada/other'), false);
    assert.equal(await repoReach(e, 'ada/busy'), null);
    assert.equal(await repoReach(e, 'ada/gone'), null);
  });
});
