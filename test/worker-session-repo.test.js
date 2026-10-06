/**
 * A session works only for the repository it was made for.
 *
 * The worker follows a renamed repository by its id (worker-repo-identity,
 * worker-repo-move). One thing was left: a site that never corrects its
 * config after a rename keeps reaching GitHub by the old name, and when
 * another repository takes that name (with the same App installed), the
 * site's editors would commit into it. The cron was already guarded.
 *
 * So an editor session carries the id of the repository it was made for, and
 * every use checks that the name still answers as that repository. These
 * tests drive the real handlers through:
 *
 *   - the takeover: refused, nothing of the request reaches GitHub, nothing
 *     stored is shown;
 *   - the normal case: one more KV read, no GitHub call of its own, nothing
 *     refused;
 *   - a session from before ids were carried;
 *   - storage trouble: nobody is locked out.
 *
 * GitHub is played by the harness: a table of names → { id, full_name }.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { fakeKV, withFetch, jsonRes, b64, ORIGIN } from './worker-harness.js';

const GH = 'https://api.github.com';
const OLD = 'oldowner/club';        // the name in the site's config
const NEW = 'NewOrg/club';          // what GitHub calls the repository since it moved
const ID = 4242;                    // the repository
const SQUAT = 9001;                 // a different repository that later gets the old name
const ADA = { email: 'ada@example.com', name: 'Ada', role: 'editor', days: 30, paths: [''], features: ['comments', 'schedule'] };
const OWNER = { Authorization: 'Bearer gho_owner' };
const PAGE = '<!doctype html>\n<html><body>\n<h1 data-cms="t">Before</h1>\n</body></html>\n';
const SESSION = 'e'.repeat(64);
const AS = { 'X-Kiln-Session': SESSION };

/**
 * GitHub, as far as these tests need it. `names` maps a lowercased owner/name
 * to the repository GitHub answers with (a renamed repository answers to its
 * old name with its current one, as GitHub's redirect does). The App is
 * installed on every repository in the table, and every one has an index.html.
 * `names` is read on every call, so a test can change who has a name.
 */
function github(names) {
  return async (url, init) => {
    const u = new URL(url);
    if (u.origin !== GH) return undefined;
    const p = decodeURIComponent(u.pathname);
    let m;
    if ((m = p.match(/^\/repos\/([^/]+\/[^/]+)\/installation$/))) return names[m[1].toLowerCase()] ? jsonRes({ id: 77 }) : undefined;
    if (p === '/app/installations/77/access_tokens' && init.method === 'POST') return jsonRes({ token: 'ghs_installation' }, 201);
    if ((m = p.match(/^\/repos\/([^/]+\/[^/]+)$/)) && init.method === 'GET') {
      const hit = names[m[1].toLowerCase()];
      return hit ? jsonRes({ id: hit.id, full_name: hit.full_name, default_branch: 'main', permissions: { push: true } }) : undefined;
    }
    if (!(m = p.match(/^\/repos\/([^/]+\/[^/]+)\/(.+)$/)) || !names[m[1].toLowerCase()]) return undefined;
    if (m[2] === 'git/blobs/cur') return jsonRes({ content: b64(PAGE) });
    if (m[2].startsWith('git/trees/')) return jsonRes({ tree: [{ type: 'blob', path: 'index.html' }] });
    if (m[2].startsWith('contents/')) return init.method === 'PUT' ? jsonRes({ commit: { sha: 'c0ffee' } }, 201) : jsonRes({ sha: 'cur', content: b64(PAGE) });
    return undefined;
  };
}
const same = () => ({ [OLD.toLowerCase()]: { id: ID, full_name: OLD } });
const renamed = () => ({ [OLD.toLowerCase()]: { id: ID, full_name: NEW }, [NEW.toLowerCase()]: { id: ID, full_name: NEW } });
const taken = () => ({ [OLD.toLowerCase()]: { id: SQUAT, full_name: OLD }, [NEW.toLowerCase()]: { id: ID, full_name: NEW } });

/**
 * What the worker asks GitHub in order to know who a name is: its App's
 * installation, a token for it, and the repository itself. Everything else
 * is a request being carried out.
 */
const isAsk = (c) => /\/installation$|\/access_tokens$/.test(c.url) || (c.method === 'GET' && /^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/?]+$/.test(c.url));
const carriedOut = (calls) => calls.filter(c => !isAsk(c)).map(c => `${c.method} ${c.url.slice(GH.length)}`);
const asks = (calls) => calls.filter(c => c.method === 'GET' && isAsk(c) && !/\/installation$/.test(c.url)).map(c => c.url.slice(GH.length));

/** A real RSA key, so the worker can sign its App token the way it does in production. */
const { privateKey } = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const PK8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', privateKey)).toString('base64');

/**
 * A worker's storage and environment. `ops` lists every KV operation made
 * through `env` as "get esess:…", in order; `fail` names key prefixes whose
 * reads throw, as KV does when it is in trouble.
 */
function world(seed = {}, extra = {}) {
  const kv = fakeKV({ 'app:creds': { app_id: 1, slug: 'kiln-test', client_id: 'c', client_secret: 's', pk8: PK8 }, ...seed });
  const ops = [];
  const fail = [];
  const KILN = { map: kv.map, expires: kv.expires };
  for (const op of ['get', 'put', 'delete', 'list']) {
    KILN[op] = async (...args) => {
      const key = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].prefix) || '';
      ops.push(`${op} ${key}`);
      if (op === 'get' && fail.some(prefix => key.startsWith(prefix))) throw new Error('KV GET failed: 500 Internal Server Error');
      return kv[op](...args);
    };
  }
  const env = { ALLOWED_ORIGINS: ORIGIN, KILN, ...extra };
  const json = (k) => (kv.map.has(k) ? JSON.parse(kv.map.get(k)) : null);
  const reads = () => ops.filter(o => o.startsWith('get ')).map(o => o.slice(4));
  const writes = () => ops.filter(o => /^(put|delete) /.test(o));
  return { env, kv, json, ops, reads, writes, fail };
}
async function ask(env, method, path, { body, headers = {} } = {}) {
  const init = { method, headers: { Origin: ORIGIN, ...headers } };
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
  const res = await worker.fetch(new Request(`https://worker.example${path}`, init), env);
  let json = null;
  try { json = await res.clone().json(); } catch { /* not JSON */ }
  return { status: res.status, json, res };
}
/** Run `fn` without the worker's own log lines. */
async function quietly(fn) {
  const real = { log: console.log, error: console.error };
  console.log = () => {}; console.error = () => {};
  try { return await fn(); } finally { console.log = real.log; console.error = real.error; }
}

// ── What a site stores ──
/** How the worker knows a repository it met under `name`. */
const met = (name, id = ID) => ({ [`rid:${id}`]: { id, name, at: 1 }, [`rname:${name.toLowerCase()}`]: { id, at: 1 } });
/** The same after everything moved from `was` to `name`. */
const moved = (name, was, id = ID) => ({ [`rid:${id}`]: { id, name, was, at: 2, moved: 3 }, [`rname:${name.toLowerCase()}`]: { id, at: 2 }, [`rname:${was.toLowerCase()}`]: { id, at: 1 } });
/** What GitHub last said about a name, as the worker remembers it for ten minutes. */
const heard = (name, id = ID, full = name) => ({ [`rsee:${name.toLowerCase()}`]: { id, name: full } });
const TOKEN = (name) => ({ [`itok:${name}`]: 'ghs_in_hand' });
/** An editor session as a sign-in makes it now: with the id of its repository. One from before has none. */
const editorSession = (repo, rid) => ({ repo, name: 'Ada', role: 'editor', email: ADA.email, paths: [''], keys: [], features: ['comments', 'schedule'], mode: null, created: 5, exp: null, ...(rid ? { rid } : {}) });
const THREAD = `cmt:${OLD}:index.html:0000000000a1`;
const thread = { id: '0000000000a1', page: 'index.html', status: 'open', anchor: null, created: 1, resolved: null, messages: [{ by: 'Ada', email: ADA.email, ts: 1, text: 'a private note about the club' }] };

const getPage = (env, repo = OLD, headers = AS) => ask(env, 'GET', `/gh/repos/${repo}/contents/index.html?ref=main`, { headers });
const putPage = (env, repo = OLD, headers = AS) => ask(env, 'PUT', `/gh/repos/${repo}/contents/index.html`, { headers, body: { message: 'edit', content: b64(PAGE.replace('Before', 'After')), sha: 'cur', branch: 'main' } });

/** Sign Ada in with Google through a site whose config says `repo`. Returns the session id and its record. */
async function signIn(w, repo, names) {
  w.kv.map.set('gstate:n1', JSON.stringify({ origin: ORIGIN, returnTo: '/', repo }));
  const gh = github(names);
  return withFetch(async (url, init) => {
    if (url === 'https://oauth2.googleapis.com/token') return jsonRes({ id_token: 'idt' });
    if (url.startsWith('https://oauth2.googleapis.com/tokeninfo')) return jsonRes({ aud: 'gid', email_verified: 'true', email: ADA.email, name: 'Ada' });
    return gh(url, init);
  }, async () => {
    const res = await worker.fetch(new Request('https://worker.example/google/callback?code=c&state=n1'), w.env);
    const frag = new URLSearchParams(new URL(res.headers.get('Location') || 'https://x.example/').hash.slice(1));
    const sid = frag.get('kiln-esession');
    return { res, sid, record: sid ? w.json(`esess:${sid}`) : null, told: frag.get('kiln-repo') };
  });
}
const GOOGLE = { GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsecret' };

// ─── Editor sessions ─────────────────────────────────────────────────────────

test('editor session: from the moment a sign-in makes it, it carries the id of the repository whose list the person is on', async () => {
  // A site under the name its repository has.
  const plain = world({ ...met(OLD), [`people:${OLD}`]: [ADA] }, GOOGLE);
  const a = await signIn(plain, OLD, same());
  assert.equal(a.res.status, 302);
  assert.deepEqual({ repo: a.record.repo, rid: a.record.rid }, { repo: OLD, rid: ID });
  // A site whose config still has the old name, after everything moved: the
  // session is filed where the repository's things are, and is for that repository.
  const after = world({ ...moved(NEW, OLD), [`people:${NEW}`]: [ADA] }, GOOGLE);
  const b = await signIn(after, OLD, renamed());
  assert.deepEqual({ repo: b.record.repo, rid: b.record.rid, told: b.told }, { repo: NEW, rid: ID, told: OLD });
  // A name the worker has never met is looked up, which puts it on record.
  const fresh = world({ [`people:${OLD}`]: [ADA] }, GOOGLE);
  const c = await signIn(fresh, OLD, same());
  assert.equal(c.record.rid, ID);
  assert.equal(fresh.json(`rname:${OLD}`).id, ID);
  // The id is the one on record for the name, not whoever answers to it
  // today: Ada is on the first repository's list, so that is what she is
  // signed in to, and the name's new holder gets no session out of it.
  const held = world({ ...met(OLD), [`people:${OLD}`]: [ADA] }, GOOGLE);
  const d = await quietly(() => signIn(held, OLD, taken()));
  assert.equal(d.record.rid, ID);
  await quietly(() => withFetch(github(taken()), async (calls) => {
    assert.equal((await getPage(held.env, OLD, { 'X-Kiln-Session': d.sid })).status, 401);
    assert.deepEqual(carriedOut(calls), []);
  }));
});

test('editor session, takeover: when the name answers as another repository the session is refused as an ended one, nothing of the request reaches GitHub and nothing stored is shown', async () => {
  // The repository was renamed and its site never corrected. The App's token for the old name is still in hand.
  const w = world({ ...met(OLD), ...heard(OLD, ID, NEW), ...TOKEN(OLD), [`people:${OLD}`]: [ADA], [THREAD]: thread, [`esess:${SESSION}`]: editorSession(OLD, ID) });
  const names = renamed();
  await quietly(() => withFetch(github(names), async (calls) => {
    // A rename is not a takeover: the old name still answers as the same repository.
    assert.equal((await getPage(w.env)).status, 200);
    assert.equal((await putPage(w.env)).status, 201);
    assert.equal((await ask(w.env, 'GET', `/comments?repo=${OLD}&path=index.html`, { headers: AS })).json.threads.length, 1);

    // Somebody else gets the old name, and installs the App on what is now a different repository.
    Object.assign(names, taken());
    // For as long as the worker remembers GitHub's last answer (ten minutes at most), it does not know.
    assert.equal((await getPage(w.env)).status, 200);
    w.kv.map.delete(`rsee:${OLD}`);
    calls.length = 0;
    const before = new Map(w.kv.map);

    for (const r of [await getPage(w.env), await putPage(w.env)]) {
      assert.equal(r.status, 401, JSON.stringify(r.json));
      assert.equal(r.json.error, 'session expired', 'the answer an editor already gets for a session that has ended');
      assert.equal(r.json.code, 'repo_changed');
      assert.match(r.json.message, /different repository/);
    }
    // The worker's own routes, each asked as the site asks them.
    const refused = [
      await ask(w.env, 'GET', `/comments?repo=${OLD}&path=index.html`, { headers: AS }),
      await ask(w.env, 'GET', `/comments/counts?repo=${OLD}`, { headers: AS }),
      await ask(w.env, 'POST', '/comments', { headers: AS, body: { repo: OLD, path: 'index.html', text: 'hello' } }),
      await ask(w.env, 'POST', '/comments', { headers: AS, body: { repo: OLD, path: 'index.html', thread: thread.id, text: 'a reply' } }),
      await ask(w.env, 'POST', '/presence', { headers: AS, body: { repo: OLD, path: '/', name: 'Ada' } }),
      await ask(w.env, 'POST', '/schedule', { headers: AS, body: { repo: OLD, path: 'index.html', edits: [{ key: 't', html: 'Later' }], at: new Date(Date.now() + 3600e3).toISOString() } }),
      await ask(w.env, 'GET', `/schedules?repo=${OLD}`, { headers: AS }),
      await ask(w.env, 'GET', `/suggestions?repo=${OLD}`, { headers: AS }),
      await ask(w.env, 'POST', '/suggestions', { headers: AS, body: { repo: OLD, path: 'index.html', edits: [{ key: 't', html: 'After' }] } }),
      await ask(w.env, 'POST', '/source/commit', { headers: AS, body: { repo: OLD, adapter: 'astro', file: 'src/content/a.md', edits: [{ key: 'title', value: 'x' }] } }),
      await ask(w.env, 'POST', '/ai/assist', { headers: AS, body: { repo: OLD, kind: 'improve', text: 'x' } }),
    ];
    for (const r of refused) {
      assert.ok(r.status === 401 || r.status === 403, `${r.status} ${JSON.stringify(r.json)}`);
      assert.doesNotMatch(JSON.stringify(r.json), /private note|threads|counts|schedules|suggestions|online/);
    }
    assert.deepEqual(carriedOut(calls), [], 'no file is read or written, no commit made, in the repository that has the name now');
    assert.deepEqual(asks(calls), [`/repos/${OLD}`], 'GitHub was asked once who the name is, and the answer is remembered');
    assert.deepEqual([...w.kv.map].filter(([k]) => /^(cmt|sug|sched|esess|people):/.test(k)), [...before].filter(([k]) => /^(cmt|sug|sched|esess|people):/.test(k)),
      'nothing stored is changed; the session is not removed either: it waits for its site to say where the repository went');

    // With the answer remembered, nothing at all is sent to GitHub.
    calls.length = 0;
    assert.equal((await putPage(w.env)).status, 401);
    assert.deepEqual(calls, []);
  }));
});

test('editor session, normal: the check is one more KV read; GitHub is asked once in ten minutes, not per request; nothing is refused', async () => {
  const w = world({ ...met(OLD), ...heard(OLD), ...TOKEN(OLD), [`esess:${SESSION}`]: editorSession(OLD, ID) });
  await withFetch(github(same()), async (calls) => {
    // A publish of a page: the commit proxy's usual request.
    const put = await putPage(w.env);
    assert.equal(put.status, 201, JSON.stringify(put.json));
    assert.deepEqual(w.reads(), [`esess:${SESSION}`, `rsee:${OLD}`, `itok:${OLD}`, `itok:${OLD}`], 'three reads before sessions carried an id; the remembered answer is the fourth');
    assert.deepEqual(w.writes(), []);
    assert.deepEqual(carriedOut(calls), [`GET /repos/${OLD}/git/blobs/cur`, `PUT /repos/${OLD}/contents/index.html`]);
    assert.deepEqual(asks(calls), [], 'GitHub is not asked who the name is');

    // A read, and the worker's own routes: one read more each.
    w.ops.length = 0; calls.length = 0;
    assert.equal((await getPage(w.env)).status, 200);
    assert.deepEqual(w.reads(), [`esess:${SESSION}`, `rsee:${OLD}`, `itok:${OLD}`]);
    w.ops.length = 0;
    assert.equal((await ask(w.env, 'GET', `/comments/counts?repo=${OLD}`, { headers: AS })).status, 200);
    assert.deepEqual(w.reads().slice(0, 2), [`esess:${SESSION}`, `rsee:${OLD}`]);
    assert.equal((await ask(w.env, 'POST', '/presence', { headers: AS, body: { repo: OLD, path: '/', name: 'Ada' } })).status, 200);
    assert.deepEqual(asks(calls), []);

    // Ten minutes on, the remembered answer has run out: one request asks GitHub, once, and it is remembered again.
    w.kv.map.delete(`rsee:${OLD}`);
    calls.length = 0;
    assert.equal((await getPage(w.env)).status, 200);
    assert.deepEqual(asks(calls), [`/repos/${OLD}`]);
    assert.deepEqual(w.json(`rsee:${OLD}`), { id: ID, name: OLD });
    calls.length = 0;
    assert.equal((await getPage(w.env)).status, 200);
    assert.equal((await putPage(w.env)).status, 201);
    assert.deepEqual(asks(calls), []);
  });
});

test('editor session from before ids were carried: it is held to the id on record for its name, never rewritten, never ended', async () => {
  const w = world({ ...met(OLD), ...heard(OLD), ...TOKEN(OLD), [THREAD]: thread, [`esess:${SESSION}`]: editorSession(OLD) });
  const asStored = w.kv.map.get(`esess:${SESSION}`);
  const names = same();
  await quietly(() => withFetch(github(names), async (calls) => {
    // Same name, same repository: it works as it did, at the cost of one read more than a session with an id.
    assert.equal((await getPage(w.env)).status, 200);
    assert.deepEqual(w.reads(), [`esess:${SESSION}`, `rname:${OLD}`, `rsee:${OLD}`, `itok:${OLD}`]);
    assert.equal((await putPage(w.env)).status, 201);
    assert.equal((await ask(w.env, 'GET', `/comments?repo=${OLD}&path=index.html`, { headers: AS })).json.threads.length, 1);
    assert.deepEqual(w.writes(), [], 'nothing is written');
    assert.equal(w.kv.map.get(`esess:${SESSION}`), asStored, 'the session is as it was: a rewrite could bring back one that is being ended');

    // The name is on record as one repository and now answers as another: not this session's to use.
    Object.assign(names, taken());
    w.kv.map.delete(`rsee:${OLD}`);
    calls.length = 0;
    assert.equal((await putPage(w.env)).status, 401);
    assert.equal((await ask(w.env, 'GET', `/comments?repo=${OLD}&path=index.html`, { headers: AS })).status, 401);
    assert.deepEqual(carriedOut(calls), []);
    assert.equal(w.kv.map.get(`esess:${SESSION}`), asStored, 'and still not removed');
  }));

  // A name the worker has no id on record for is used as it always was, and GitHub is not asked about it.
  const unmet = world({ ...TOKEN(OLD), [`esess:${SESSION}`]: editorSession(OLD) });
  await withFetch(github(same()), async (calls) => {
    assert.equal((await getPage(unmet.env)).status, 200);
    assert.deepEqual(unmet.reads(), [`esess:${SESSION}`, `rname:${OLD}`, `itok:${OLD}`]);
    assert.deepEqual(asks(calls), []);
  });
});

test('editor session, storage trouble: when the worker cannot read its records the request is carried out as before, and nobody is signed out', async () => {
  // The remembered answer cannot be read.
  const w = world({ ...met(OLD), ...heard(OLD), ...TOKEN(OLD), [THREAD]: thread, [`esess:${SESSION}`]: editorSession(OLD, ID) });
  w.fail.push('rsee:');
  await withFetch(github(same()), async () => {
    assert.equal((await getPage(w.env)).status, 200);
    assert.equal((await putPage(w.env)).status, 201);
    assert.equal((await ask(w.env, 'GET', `/comments?repo=${OLD}&path=index.html`, { headers: AS })).status, 200);
    assert.equal((await ask(w.env, 'POST', '/presence', { headers: AS, body: { repo: OLD, path: '/', name: 'Ada' } })).status, 200);
  });
  assert.ok(w.reads().includes(`rsee:${OLD}`), 'it was tried');
  assert.ok(w.kv.map.has(`esess:${SESSION}`));

  // The record of the name cannot be read (a session from before, which goes by it).
  const older = world({ ...met(OLD), ...heard(OLD), ...TOKEN(OLD), [`esess:${SESSION}`]: editorSession(OLD) });
  older.fail.push('rname:');
  await withFetch(github(same()), async () => {
    assert.equal((await getPage(older.env)).status, 200);
    assert.equal((await putPage(older.env)).status, 201);
  });
  assert.ok(older.reads().includes(`rname:${OLD}`), 'it was tried');

  // GitHub cannot be asked who the name is (and nothing is remembered).
  const deaf = world({ ...met(OLD), ...TOKEN(OLD), [`esess:${SESSION}`]: editorSession(OLD, ID) });
  const gh = github(same());
  await withFetch(async (url, init) => (url === `${GH}/repos/${OLD}` ? jsonRes({ message: 'Server Error' }, 500) : gh(url, init)), async (calls) => {
    assert.equal((await getPage(deaf.env)).status, 200);
    assert.deepEqual(asks(calls), [`/repos/${OLD}`], 'it was tried');
  });
});
