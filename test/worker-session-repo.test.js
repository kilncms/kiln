/**
 * A session or a token works only for the repository it was made for.
 *
 * The worker follows a renamed repository by its id (worker-repo-identity,
 * worker-repo-move). One thing was left: a site that never corrects its
 * config after a rename keeps reaching GitHub by the old name, and when
 * another repository takes that name (with the same App installed), the
 * site's editors and scripts would commit into it. The cron was already
 * guarded.
 *
 * So an editor session, a member's sign-in and an API token carry the id of
 * the repository they were made for, and every use checks that the name
 * still answers as that repository. For each of the three kinds, these tests
 * drive the real handlers through:
 *
 *   - the takeover: refused, nothing of the request reaches GitHub, nothing
 *     stored is shown;
 *   - the normal case: one more KV read, no GitHub call of its own, nothing
 *     refused;
 *   - one from before ids were carried;
 *   - storage trouble: nobody is locked out.
 *
 * GitHub is played by the harness: a table of names → { id, full_name }.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
 * through `env` as "get esess:…", in order; `fail` names operations that
 * throw, as "get rsee:" (every read of a key that starts so), the way KV
 * does when it is in trouble.
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
      if (fail.some(f => `${op} ${key}`.startsWith(f))) throw new Error(`KV ${op.toUpperCase()} failed: 500 Internal Server Error`);
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

/**
 * Sign someone in with Google through a site whose config says `repo` (Ada,
 * an editor, unless another address is given). Returns the worker's answer,
 * and for an editor the session id and its record.
 */
async function signIn(w, repo, names, email = ADA.email) {
  w.kv.map.set('gstate:n1', JSON.stringify({ origin: ORIGIN, returnTo: '/', repo }));
  const gh = github(names);
  return withFetch(async (url, init) => {
    if (url === 'https://oauth2.googleapis.com/token') return jsonRes({ id_token: 'idt' });
    if (url.startsWith('https://oauth2.googleapis.com/tokeninfo')) return jsonRes({ aud: 'gid', email_verified: 'true', email, name: 'Someone' });
    return gh(url, init);
  }, async (calls) => {
    const res = await worker.fetch(new Request('https://worker.example/google/callback?code=c&state=n1'), w.env);
    const to = res.headers.get('Location') || '';
    const frag = new URLSearchParams(to ? new URL(to).hash.slice(1) : '');
    const sid = frag.get('kiln-esession');
    return { res, to, sid, record: sid ? w.json(`esess:${sid}`) : null, told: frag.get('kiln-repo'), page: to ? '' : await res.text(), github: calls.filter(c => c.url.startsWith(GH)) };
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
  w.fail.push('get rsee:');
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
  older.fail.push('get rname:');
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

// ─── Member sign-ins ─────────────────────────────────────────────────────────

const BEA = { email: 'bea@example.com', name: 'Bea', role: 'member', days: 30 };
const MEMBER = 'b'.repeat(32);
const FAR = Math.floor(Date.now() / 1000) + 40 * 24 * 3600;   // an expiry, as KV reports one
/** A member's sign-in as the worker stores it now: with the id of its repository. One from before has none. */
const memberSignIn = (repo, rid) => ({ repo, email: BEA.email, origin: ORIGIN, ...(rid ? { rid } : {}) });
/** What a site's members gate asks every few minutes. `{ ok: false }` is what makes it sign the member out. */
const check = async (env, sid = MEMBER) => { const r = await ask(env, 'POST', '/members/check', { body: { sid, origin: ORIGIN } }); return { status: r.status, json: r.json }; };
const YES = { status: 200, json: { ok: true } };
const NO = { status: 200, json: { ok: false } };
/** One cron run, without its log lines. */
const cron = (env) => quietly(() => worker.scheduled({}, env));
/** The site's config is corrected to the repository's current name, and the move that follows runs to its end. */
async function corrected(w) {
  assert.equal((await ask(w.env, 'GET', `/comments?repo=${NEW}&path=index.html`, { headers: OWNER })).status, 200);
  for (let run = 0; run < 10 && [...w.kv.map.keys()].some(k => k.startsWith('rmove:')); run++) await cron(w.env);
  assert.equal(w.json(`rid:${ID}`).name, NEW);
}

test('member sign-in: from the moment it is made, it carries the id of the repository whose list the member is on', async () => {
  const code = 'c'.repeat(32);
  const claim = (w) => ask(w.env, 'POST', '/google/claim', { body: { code, origin: ORIGIN, session: true } });
  const plain = world({ ...met(OLD), [`people:${OLD}`]: [BEA], [`gcode:${code}`]: { name: 'Bea', days: 30, repo: OLD, origin: ORIGIN, email: BEA.email } });
  await withFetch(github(same()), async () => {
    const r = await claim(plain);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(plain.json(`msess:${r.json.sid}`), memberSignIn(OLD, ID));
  });
  // Through a site whose config still has the old name, after everything moved.
  const after = world({ ...moved(NEW, OLD), [`people:${NEW}`]: [BEA], [`gcode:${code}`]: { name: 'Bea', days: 30, repo: OLD, origin: ORIGIN, email: BEA.email } });
  await withFetch(github(renamed()), async () => {
    const r = await claim(after);
    assert.deepEqual(after.json(`msess:${r.json.sid}`), memberSignIn(NEW, ID));
    assert.deepEqual(await check(after.env, r.json.sid), YES);
  });
});

test('member sign-in, takeover: when the name answers as another repository the gate is told no, the list is not read, and the sign-in is good again once the site says where the repository went', async () => {
  const w = world({ ...met(OLD), ...heard(OLD, ID, NEW), [`people:${OLD}`]: [BEA], [`msess:${MEMBER}`]: memberSignIn(OLD, ID) });
  const names = renamed();
  await quietly(() => withFetch(github(names), async (calls) => {
    assert.deepEqual(await check(w.env), YES, 'a rename is not a takeover');
    Object.assign(names, taken());
    w.kv.map.delete(`rsee:${OLD}`);
    calls.length = 0;
    assert.deepEqual(await check(w.env), NO);
    assert.deepEqual(carriedOut(calls), []);
    assert.deepEqual(asks(calls), [`/repos/${OLD}`]);
    assert.deepEqual(w.json(`msess:${MEMBER}`), memberSignIn(OLD, ID), 'refused, not removed');
    calls.length = 0; w.ops.length = 0;
    assert.deepEqual(await check(w.env), NO);
    assert.deepEqual(calls, [], 'with the answer remembered, GitHub is not asked again');
    assert.deepEqual(w.reads(), [`msess:${MEMBER}`, `rsee:${OLD}`], 'and the list stored for the first repository is not read');

    // The owner corrects the config: the sign-in follows the repository to its name, and is good.
    await corrected(w);
    assert.deepEqual(w.json(`msess:${MEMBER}`), memberSignIn(NEW, ID));
    assert.deepEqual(await check(w.env), YES);
  }));
});

test('member sign-in, normal: the check is one more KV read, GitHub is not asked, nobody is turned away', async () => {
  const w = world({ ...met(OLD), ...heard(OLD), [`people:${OLD}`]: [BEA], [`msess:${MEMBER}`]: memberSignIn(OLD, ID) });
  await withFetch(github(same()), async (calls) => {
    assert.deepEqual(await check(w.env), YES);
    assert.deepEqual(w.reads(), [`msess:${MEMBER}`, `rsee:${OLD}`, `people:${OLD}`], 'two reads before sign-ins carried an id; the remembered answer is the third');
    assert.deepEqual(w.writes(), []);
    assert.deepEqual(calls, []);
    // Someone who is no longer on the list is still turned away by the list, as before.
    w.kv.map.set(`people:${OLD}`, '[]');
    assert.deepEqual(await check(w.env), NO);
  });
});

test('member sign-in from before ids were carried: it takes the id on record for its name the first time it is used, with the expiry it had', async () => {
  const w = world({ ...met(OLD), ...heard(OLD), [`people:${OLD}`]: [BEA], [`msess:${'c'.repeat(32)}`]: memberSignIn(OLD), [`msess:${'d'.repeat(32)}`]: memberSignIn('someone/else') });
  await w.kv.put(`msess:${MEMBER}`, JSON.stringify(memberSignIn(OLD)), { expiration: FAR });
  const soon = Math.floor(Date.now() / 1000) + 30;
  await w.kv.put(`msess:${'a'.repeat(32)}`, JSON.stringify(memberSignIn(OLD)), { expiration: soon });
  await withFetch(github(same()), async (calls) => {
    assert.deepEqual(await check(w.env), YES, 'same name, same repository: nobody is signed out');
    assert.deepEqual(w.json(`msess:${MEMBER}`), memberSignIn(OLD, ID));
    assert.equal(w.kv.expires.get(`msess:${MEMBER}`), FAR, 'it still expires when it was going to');
    // From then on it is a sign-in like any other: one read more than before, nothing written.
    w.ops.length = 0;
    assert.deepEqual(await check(w.env), YES);
    assert.deepEqual(w.reads(), [`msess:${MEMBER}`, `rsee:${OLD}`, `people:${OLD}`]);
    assert.deepEqual(w.writes(), []);
    // One that never expires still never does.
    assert.deepEqual(await check(w.env, 'c'.repeat(32)), YES);
    assert.deepEqual(w.json(`msess:${'c'.repeat(32)}`), memberSignIn(OLD, ID));
    assert.equal(w.kv.expires.has(`msess:${'c'.repeat(32)}`), false);
    // One with seconds left is left to expire (KV refuses so short a life), and is still good until it does.
    assert.deepEqual(await check(w.env, 'a'.repeat(32)), YES);
    assert.deepEqual(w.json(`msess:${'a'.repeat(32)}`), memberSignIn(OLD));
    assert.equal(w.kv.expires.get(`msess:${'a'.repeat(32)}`), soon);
    assert.deepEqual(w.json(`msess:${'d'.repeat(32)}`), memberSignIn('someone/else'), 'another site\'s sign-in is not touched');
    assert.deepEqual(calls, []);
  });

  // A name the worker has no id on record for: used as it always was, and left as it is.
  const unmet = world({ [`people:${OLD}`]: [BEA], [`msess:${MEMBER}`]: memberSignIn(OLD) });
  await withFetch(github(same()), async (calls) => {
    assert.deepEqual(await check(unmet.env), YES);
    assert.deepEqual(unmet.json(`msess:${MEMBER}`), memberSignIn(OLD));
    assert.deepEqual(calls, []);
  });

  // The name is on record as one repository and answers as another: the sign-in is the first one's, and is not used.
  const held = world({ ...met(OLD), [`people:${OLD}`]: [BEA], [`msess:${MEMBER}`]: memberSignIn(OLD) });
  await quietly(() => withFetch(github(taken()), async (calls) => {
    assert.deepEqual(await check(held.env), NO);
    assert.deepEqual(held.json(`msess:${MEMBER}`), memberSignIn(OLD, ID), 'it has taken the id of the repository the name is on record as');
    assert.deepEqual(carriedOut(calls), []);
    await corrected(held);
    assert.deepEqual(await check(held.env), YES, 'and is good again under the name that repository has now');
  }));
});

test('member sign-in, storage trouble: when the worker cannot read its records the gate is answered as before, never with a no that would sign the member out', async () => {
  // The remembered answer cannot be read.
  const w = world({ ...met(OLD), ...heard(OLD), [`people:${OLD}`]: [BEA], [`msess:${MEMBER}`]: memberSignIn(OLD, ID) });
  w.fail.push('get rsee:');
  await withFetch(github(same()), async () => { assert.deepEqual(await check(w.env), YES); });
  assert.ok(w.reads().includes(`rsee:${OLD}`), 'it was tried');

  // The record of the name cannot be read: a sign-in from before stays as it is, and is answered by the list.
  const older = world({ ...met(OLD), ...heard(OLD), [`people:${OLD}`]: [BEA], [`msess:${MEMBER}`]: memberSignIn(OLD) });
  older.fail.push('get rname:');
  await withFetch(github(same()), async () => { assert.deepEqual(await check(older.env), YES); });
  assert.deepEqual(older.json(`msess:${MEMBER}`), memberSignIn(OLD));

  // The id cannot be written (a free account out of writes for the day): the answer is still yes, and it is taken next time.
  const full = world({ ...met(OLD), ...heard(OLD), [`people:${OLD}`]: [BEA], [`msess:${MEMBER}`]: memberSignIn(OLD) });
  full.fail.push('put msess:');
  await withFetch(github(same()), async () => {
    assert.deepEqual(await check(full.env), YES);
    assert.deepEqual(full.json(`msess:${MEMBER}`), memberSignIn(OLD));
    full.fail.length = 0;
    assert.deepEqual(await check(full.env), YES);
    assert.deepEqual(full.json(`msess:${MEMBER}`), memberSignIn(OLD, ID));
  });

  // GitHub cannot be asked who the name is.
  const deaf = world({ ...met(OLD), [`people:${OLD}`]: [BEA], [`msess:${MEMBER}`]: memberSignIn(OLD, ID) });
  await withFetch(async () => { throw new TypeError('fetch failed'); }, async () => { assert.deepEqual(await check(deaf.env), YES); });
});

// ─── API tokens ──────────────────────────────────────────────────────────────

const SECRET = '5'.repeat(64);
const ATOK = `atok:${createHash('sha256').update(SECRET).digest('hex')}`;   // a token is stored under the hash of its secret
const BEARER = { Authorization: `Bearer ${SECRET}` };
/** An API token as the worker stores it now: with the id of its repository. One from before has none. */
const apiToken = (repo, rid) => ({ id: 'abcd1234', repo, name: 'the newsletter script', paths: [''], keys: [], readonly: false, created: 5, exp: null, ...(rid ? { rid } : {}) });
const readFields = (env, headers = BEARER) => ask(env, 'GET', '/api/v1/fields?path=/', { headers });
const listPages = (env) => ask(env, 'GET', '/api/v1/pages?ref=main', { headers: BEARER });
const writeEdit = (env) => ask(env, 'PATCH', '/api/v1/edits', { headers: BEARER, body: { path: '/', edits: [{ key: 't', html: 'After' }] } });

test('API token: from the moment it is made, it carries the id of the repository it is for', async () => {
  const plain = world({ ...met(OLD) });
  await withFetch(github(same()), async () => {
    const made = await ask(plain.env, 'POST', '/admin/api-tokens', { headers: OWNER, body: { repo: OLD, name: 'the newsletter script' } });
    assert.equal(made.status, 200, JSON.stringify(made.json));
    const stored = plain.json(`atok:${createHash('sha256').update(made.json.token).digest('hex')}`);
    assert.deepEqual({ repo: stored.repo, rid: stored.rid }, { repo: OLD, rid: ID });
    assert.equal((await readFields(plain.env, { Authorization: `Bearer ${made.json.token}` })).status, 200);
  });
  // Made through a page that still has the old name, after everything moved.
  const after = world({ ...moved(NEW, OLD) });
  await withFetch(github(renamed()), async () => {
    const made = await ask(after.env, 'POST', '/admin/api-tokens', { headers: OWNER, body: { repo: OLD, name: 'made later' } });
    const stored = after.json(`atok:${createHash('sha256').update(made.json.token).digest('hex')}`);
    assert.deepEqual({ repo: stored.repo, rid: stored.rid }, { repo: NEW, rid: ID });
  });
});

test('API token, takeover: when the name answers as another repository the token gets 403 and one sentence, nothing of the request reaches GitHub, and it works again once the site says where the repository went', async () => {
  // The repository was renamed and its site never corrected. The App's token for the old name is still in hand.
  const w = world({ ...met(OLD), ...heard(OLD, ID, NEW), ...TOKEN(OLD), [ATOK]: apiToken(OLD, ID) });
  const names = renamed();
  await quietly(() => withFetch(github(names), async (calls) => {
    // A rename is not a takeover: the script goes on working.
    assert.equal((await readFields(w.env)).status, 200);
    assert.equal((await writeEdit(w.env)).status, 200);

    Object.assign(names, taken());
    w.kv.map.delete(`rsee:${OLD}`);
    calls.length = 0;
    for (const r of [await readFields(w.env), await listPages(w.env), await writeEdit(w.env)]) {
      assert.equal(r.status, 403, JSON.stringify(r.json));
      assert.equal(r.json.code, 'repo_changed');
      assert.match(r.json.error, /^This token was made for a different repository than the one that now answers to its name, so nothing was read or changed: /);
      assert.doesNotMatch(r.json.error, /[.!?]\s/, 'one sentence');
      assert.doesNotMatch(JSON.stringify(r.json), /Before|pages|fields/);
    }
    assert.deepEqual(carriedOut(calls), [], 'no page is listed, read or written in the repository that has the name now');
    assert.deepEqual(asks(calls), [`/repos/${OLD}`], 'GitHub was asked once who the name is');
    assert.deepEqual(w.json(ATOK), apiToken(OLD, ID), 'refused, not removed');
    calls.length = 0;
    assert.equal((await writeEdit(w.env)).status, 403);
    assert.deepEqual(calls, [], 'with the answer remembered, nothing at all is sent to GitHub');
    // A token the worker does not know is still simply unauthorized.
    assert.deepEqual((await readFields(w.env, { Authorization: `Bearer ${'0'.repeat(64)}` })).json, { error: 'unauthorized' });

    // The owner corrects the config: the token follows the repository to its name, and works.
    await corrected(w);
    assert.deepEqual(w.json(ATOK), apiToken(NEW, ID));
    calls.length = 0;
    assert.equal((await writeEdit(w.env)).status, 200);
    assert.deepEqual(carriedOut(calls).filter(c => c.startsWith('PUT')), [`PUT /repos/${NEW}/contents/index.html`]);
  }));
});

test('API token, normal: the check is one more KV read, GitHub is asked nothing extra, nothing is refused', async () => {
  const w = world({ ...met(OLD), ...heard(OLD), ...TOKEN(OLD), [ATOK]: apiToken(OLD, ID) });
  await withFetch(github(same()), async (calls) => {
    const r = await writeEdit(w.env);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(w.reads(), [ATOK, `rsee:${OLD}`, `itok:${OLD}`], 'two reads before tokens carried an id; the remembered answer is the third');
    assert.deepEqual(w.writes(), []);
    assert.deepEqual(carriedOut(calls), [`GET /repos/${OLD}/contents/index.html`, `PUT /repos/${OLD}/contents/index.html`]);
    assert.deepEqual(asks(calls), []);
    assert.equal((await readFields(w.env)).status, 200);
    assert.equal((await listPages(w.env)).status, 200);
    assert.deepEqual(asks(calls), []);
  });
});

test('API token from before ids were carried: it takes the id on record for its name the first time it is used, and stays the same token with the same expiry', async () => {
  const w = world({ ...met(OLD), ...heard(OLD), ...TOKEN(OLD), 'atok:other': apiToken('someone/else') });
  await w.kv.put(ATOK, JSON.stringify({ ...apiToken(OLD), exp: FAR * 1000 }), { expiration: FAR });
  await withFetch(github(same()), async (calls) => {
    assert.equal((await readFields(w.env)).status, 200, 'same name, same repository: no token stops working');
    assert.deepEqual(w.json(ATOK), { ...apiToken(OLD, ID), exp: FAR * 1000 }, 'the same key (the secret still works), now with the id');
    assert.equal(w.kv.expires.get(ATOK), FAR, 'and it still expires when it was going to');
    // From then on it is a token like any other: one read more than before, nothing written.
    w.ops.length = 0;
    assert.equal((await writeEdit(w.env)).status, 200);
    assert.deepEqual(w.reads(), [ATOK, `rsee:${OLD}`, `itok:${OLD}`]);
    assert.deepEqual(w.writes(), []);
    assert.deepEqual(w.json('atok:other'), apiToken('someone/else'), 'another site\'s token is not touched');
    assert.deepEqual(asks(calls), []);
  });

  // One that never expires still never does.
  const forever = world({ ...met(OLD), ...heard(OLD), ...TOKEN(OLD), [ATOK]: apiToken(OLD) });
  await withFetch(github(same()), async () => {
    assert.equal((await readFields(forever.env)).status, 200);
    assert.deepEqual(forever.json(ATOK), apiToken(OLD, ID));
    assert.equal(forever.kv.expires.has(ATOK), false);
  });

  // One that was revoked a moment ago is not brought back by taking its id.
  const revoked = world({ ...met(OLD), ...heard(OLD), ...TOKEN(OLD), [ATOK]: apiToken(OLD) });
  const KILN = { ...revoked.env.KILN, list: async (o) => { if (o.prefix === ATOK) revoked.kv.map.delete(ATOK); return revoked.kv.list(o); } };
  await withFetch(github(same()), async () => {
    await readFields({ ...revoked.env, KILN });
    assert.equal(revoked.kv.map.has(ATOK), false);
    assert.equal((await readFields(revoked.env)).status, 401);
  });

  // A name the worker has no id on record for: used as it always was, and left as it is.
  const unmet = world({ ...TOKEN(OLD), [ATOK]: apiToken(OLD) });
  await withFetch(github(same()), async (calls) => {
    assert.equal((await readFields(unmet.env)).status, 200);
    assert.deepEqual(unmet.json(ATOK), apiToken(OLD));
    assert.deepEqual(asks(calls), []);
  });

  // The name is on record as one repository and answers as another: the token is the first one's, and is not used.
  const held = world({ ...met(OLD), ...TOKEN(OLD), [ATOK]: apiToken(OLD) });
  await quietly(() => withFetch(github(taken()), async (calls) => {
    assert.equal((await writeEdit(held.env)).status, 403);
    assert.deepEqual(held.json(ATOK), apiToken(OLD, ID), 'it has taken the id of the repository the name is on record as');
    assert.deepEqual(carriedOut(calls), []);
    await corrected(held);
    assert.equal((await writeEdit(held.env)).status, 200, 'and works again under the name that repository has now');
  }));
});

test('API token, storage trouble: when the worker cannot read its records the request is carried out as before, and no token stops working', async () => {
  // The remembered answer cannot be read.
  const w = world({ ...met(OLD), ...heard(OLD), ...TOKEN(OLD), [ATOK]: apiToken(OLD, ID) });
  w.fail.push('get rsee:');
  await withFetch(github(same()), async () => {
    assert.equal((await readFields(w.env)).status, 200);
    assert.equal((await writeEdit(w.env)).status, 200);
  });
  assert.ok(w.reads().includes(`rsee:${OLD}`), 'it was tried');

  // The record of the name cannot be read: a token from before stays as it is, and works.
  const older = world({ ...met(OLD), ...heard(OLD), ...TOKEN(OLD), [ATOK]: apiToken(OLD) });
  older.fail.push('get rname:');
  await withFetch(github(same()), async () => { assert.equal((await writeEdit(older.env)).status, 200); });
  assert.deepEqual(older.json(ATOK), apiToken(OLD));

  // The id cannot be written (a free account out of writes for the day): it works, and takes it next time.
  const full = world({ ...met(OLD), ...heard(OLD), ...TOKEN(OLD), [ATOK]: apiToken(OLD) });
  full.fail.push('put atok:');
  await withFetch(github(same()), async () => {
    assert.equal((await readFields(full.env)).status, 200);
    assert.deepEqual(full.json(ATOK), apiToken(OLD));
    full.fail.length = 0;
    assert.equal((await readFields(full.env)).status, 200);
    assert.deepEqual(full.json(ATOK), apiToken(OLD, ID));
  });

  // GitHub cannot be asked who the name is (and nothing is remembered).
  const deaf = world({ ...met(OLD), ...TOKEN(OLD), [ATOK]: apiToken(OLD, ID) });
  const gh = github(same());
  await withFetch(async (url, init) => (url === `${GH}/repos/${OLD}` ? jsonRes({ message: 'Server Error' }, 500) : gh(url, init)), async (calls) => {
    assert.equal((await readFields(deaf.env)).status, 200);
    assert.deepEqual(asks(calls), [`/repos/${OLD}`], 'it was tried');
  });
});

// ─── Signing in ──────────────────────────────────────────────────────────────

test('sign-in: nobody is signed in under a name that answers as another repository: no session, no code for the members gate, and the person is told why', async () => {
  // The site never corrected its config, and its old name is another
  // repository's now. Ada and Bea are on the first repository's list, which
  // is the repository a session would be made for: the id on record for the
  // name, not whoever answers to it today.
  for (const email of [ADA.email, BEA.email]) {
    const w = world({ ...met(OLD), [`people:${OLD}`]: [ADA, BEA] }, GOOGLE);
    const r = await quietly(() => signIn(w, OLD, taken(), email));
    assert.equal(r.res.status, 403, email);
    assert.match(r.page, /Nobody can be signed in to this site right now/);
    assert.match(r.page, new RegExp(`You signed in as <strong>${email}</strong>, and that address is on the list`));
    assert.match(r.page, /the name now belongs to a different repository/);
    assert.match(r.page, /kiln doctor/);
    assert.deepEqual([...w.kv.map.keys()].filter(k => /^(esess|msess|gcode):/.test(k)), [], 'nothing is made that could be used later');
    assert.equal(w.json(`rname:${OLD}`).id, ID, 'and the name stays on record as the first repository');
  }
});

test('sign-in, normal and in trouble: one who is on the list is signed in, without GitHub being asked when its answer is remembered, and when the records cannot be read', async () => {
  const w = world({ ...met(OLD), ...heard(OLD), [`people:${OLD}`]: [ADA, BEA] }, GOOGLE);
  const editor = await signIn(w, OLD, same());
  assert.equal(editor.res.status, 302);
  assert.equal(editor.record.rid, ID);
  assert.deepEqual(editor.github, [], 'GitHub is not asked');
  const member = await signIn(w, OLD, same(), BEA.email);
  assert.equal(member.res.status, 302);
  assert.match(member.to, /\/members-login\.html\?to=.*#kiln-gcode=[a-f0-9]{32}$/);
  // A renamed repository whose site still has the old name: a rename is not a takeover.
  const moved = world({ ...met(OLD), [`people:${OLD}`]: [ADA] }, GOOGLE);
  assert.equal((await signIn(moved, OLD, renamed())).res.status, 302);
  // Storage trouble: the remembered answer cannot be read. Nobody is kept out for that.
  const hiccup = world({ ...met(OLD), ...heard(OLD), [`people:${OLD}`]: [ADA] }, GOOGLE);
  hiccup.fail.push('get rsee:');
  assert.equal((await signIn(hiccup, OLD, same())).res.status, 302);
  assert.ok(hiccup.reads().includes(`rsee:${OLD}`), 'it was tried');
  // The record of the name cannot be read: signed in, with a session that carries no id and is held to the record at each use.
  const blind = world({ ...met(OLD), ...heard(OLD), [`people:${OLD}`]: [ADA] }, GOOGLE);
  blind.fail.push('get rname:');
  const s = await signIn(blind, OLD, same());
  assert.equal(s.res.status, 302);
  assert.equal(s.record.rid, undefined);
});

// ─── When GitHub does not answer ─────────────────────────────────────────────

test('GitHub does not answer who a name is: comments, a members gate\'s check and a token\'s request are not kept waiting for it, and go on as before', { timeout: 15000 }, async () => {
  const w = world({ ...met(OLD), ...TOKEN(OLD), [`people:${OLD}`]: [ADA, BEA], [THREAD]: thread,
    [`esess:${SESSION}`]: editorSession(OLD, ID), [`msess:${MEMBER}`]: memberSignIn(OLD, ID), [ATOK]: apiToken(OLD, ID) });
  const gh = github(same());
  const never = new Promise(() => {});
  const started = Date.now();
  await withFetch((url, init) => (url === `${GH}/repos/${OLD}` ? never : gh(url, init)), async () => {
    const [comments, gate, script] = await Promise.all([
      ask(w.env, 'GET', `/comments?repo=${OLD}&path=index.html`, { headers: AS }),
      check(w.env),
      readFields(w.env),
    ]);
    assert.equal(comments.status, 200);
    assert.equal(comments.json.threads.length, 1);
    assert.deepEqual(gate, YES);
    assert.equal(script.status, 200);
  });
  const waited = Date.now() - started;
  assert.ok(waited >= 2000 && waited < 4500, `each waited about two and a half seconds, not for ever: ${waited} ms`);
  assert.equal(w.kv.map.has(`rsee:${OLD}`), false, 'and nothing was remembered that GitHub did not say');
});
