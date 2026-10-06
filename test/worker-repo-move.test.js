/**
 * Everything a site stores follows a renamed repository.
 *
 * The worker files a site's data under the `owner/name` in its
 * kiln-config.js. worker-repo-identity.test.js covers the people list; these
 * tests cover the rest: comment threads, suggestions, scheduled publishes, API
 * tokens and sign-ins. They drive the real request handlers and the real cron
 * handler through what can happen to a renamed or transferred repository:
 *
 *   - the site's config is corrected: everything comes along, in bounded
 *     steps, and nothing is lost wherever a step stops;
 *   - while that is going on: nothing is hidden and nothing is counted twice;
 *   - the site keeps the old name: it keeps working, from wherever things
 *     are filed;
 *   - somebody else gets the old name: they get nothing, of any kind;
 *   - a publish scheduled before the rename: published once, to the
 *     repository it was made for.
 *
 * GitHub is played by the harness: a table of names → { id, full_name }.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { moveBounds } from '../worker/index.js';
import { fakeKV, withFetch, jsonRes, b64, ORIGIN } from './worker-harness.js';

const GH = 'https://api.github.com';
const { request: MOVE_OPS_PER_REQUEST, cron: MOVE_OPS_PER_CRON } = moveBounds();   // KV operations a move may spend in one request, in one cron run
const OLD = 'oldowner/club';        // the name the repository had
const NEW = 'NewOrg/club';          // what GitHub calls it now
const ID = 4242;                    // the repository
const SQUAT = 9001;                 // a different repository that later gets the old name
const ADA = { email: 'ada@example.com', name: 'Ada', role: 'editor', days: 30, paths: [''], features: ['comments', 'schedule'] };
const BEA = { email: 'bea@example.com', name: 'Bea', role: 'member', days: 30 };
const OWNER = { Authorization: 'Bearer gho_owner' };
const PAGE = '<!doctype html>\n<html><body>\n<h1 data-cms="t">Before</h1>\n</body></html>\n';
const SESSION = 'e'.repeat(64);
const MEMBER = 'b'.repeat(32);
const FAR = Math.floor(Date.now() / 1000) + 40 * 24 * 3600;   // an expiry, as KV reports one

/**
 * GitHub, as far as these tests need it. `names` maps a lowercased owner/name
 * to the repository GitHub answers with (a renamed repository answers to its
 * old name with its current one, as GitHub's redirect does). The App is
 * installed on every repository in the table, and every one has an index.html.
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
      return hit ? jsonRes({ id: hit.id, full_name: hit.full_name, permissions: { push: true } }) : undefined;
    }
    if ((m = p.match(/^\/repos\/([^/]+\/[^/]+)\/contents\/(.+)$/)) && names[m[1].toLowerCase()]) {
      return init.method === 'PUT' ? jsonRes({ commit: { sha: 'c0ffee' } }, 201) : jsonRes({ sha: 'cur', content: b64(PAGE) });
    }
    return undefined;
  };
}
const renamed = { [OLD.toLowerCase()]: { id: ID, full_name: NEW }, [NEW.toLowerCase()]: { id: ID, full_name: NEW } };
const taken = { [OLD.toLowerCase()]: { id: SQUAT, full_name: OLD }, [NEW.toLowerCase()]: { id: ID, full_name: NEW } };

/** A real RSA key, so the worker can sign its App token the way it does in production. */
const { privateKey } = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const PK8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', privateKey)).toString('base64');

function world(seed = {}, extra = {}) {
  const kv = fakeKV({ 'app:creds': { app_id: 1, slug: 'kiln-test', client_id: 'c', client_secret: 's', pk8: PK8 }, ...seed });
  const env = { ALLOWED_ORIGINS: ORIGIN, KILN: kv, ...extra };
  const json = (k) => (kv.map.has(k) ? JSON.parse(kv.map.get(k)) : null);
  const keys = (prefix) => [...kv.map.keys()].filter(k => k.startsWith(prefix)).sort();
  return { env, kv, json, keys };
}
async function ask(env, method, path, { body, headers = {} } = {}) {
  const init = { method, headers: { Origin: ORIGIN, ...headers } };
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
  const res = await worker.fetch(new Request(`https://worker.example${path}`, init), env);
  let json = null;
  try { json = await res.clone().json(); } catch { /* not JSON */ }
  return { status: res.status, json, res };
}
/** One cron run, without its log lines. */
async function cron(env) {
  const real = { log: console.log, error: console.error };
  console.log = () => {}; console.error = () => {};
  try { await worker.scheduled({}, env); } finally { console.log = real.log; console.error = real.error; }
}
/** Cron runs until no move is left unfinished. Returns how many it took. */
async function settle(w, max = 30) {
  for (let run = 1; run <= max; run++) {
    await cron(w.env);
    if (!w.keys('rmove:').length) return run;
  }
  throw new Error(`the move was not finished after ${max} cron runs`);
}

// ── What a site stores ──
const hex = (n) => n.toString(16).padStart(12, '0');
const thread = (id, page, text = `about ${page}`) => ({ id, page, status: 'open', anchor: null, created: Number.parseInt(id, 16), resolved: null, messages: [{ by: 'Ada', email: ADA.email, ts: 1, text }] });
const cmt = (repo, page, id) => `cmt:${repo}:${encodeURIComponent(page)}:${id}`;
const suggestion = (id, email = ADA.email) => ({ id, page: 'index.html', by: 'Ada', email, ts: Number.parseInt(id, 16), note: 'shorter', edits: [{ key: 't', html: 'After' }], branch: null, baseSha: null, status: 'open', decided: null, commit: null });
const token = (repo, id = 'abcd1234') => ({ id, repo, name: 'the newsletter script', paths: [''], keys: [], readonly: false, created: 5, exp: FAR * 1000 });
const schedule = (repo, at, over = {}) => ({ repo, path: 'index.html', branch: 'main', edits: [{ key: 't', html: 'After' }], content: null, message: 'Scheduled publish (via Kiln)', at, desc: 'index.html', by: 'admin', admin: true, ...over });
const editorSession = (repo) => ({ repo, name: 'Ada', role: 'editor', email: ADA.email, paths: [''], keys: [], features: ['comments', 'schedule'], mode: null, exp: null });
/** How the worker knows a repository it met under `name`, before anything moved. */
const met = (name, id = ID) => ({ [`rid:${id}`]: { id, name, at: 1 }, [`rname:${name.toLowerCase()}`]: { id, at: 1 } });
/** The same after everything moved from `was` to `name`. */
const moved = (name, was, id = ID) => ({ [`rid:${id}`]: { id, name, was, at: 2, moved: 3 }, [`rname:${name.toLowerCase()}`]: { id, at: 2 }, [`rname:${was.toLowerCase()}`]: { id, at: 1 } });

/** `count` comment threads on three pages and `sugs` suggestions, filed under `repo`. */
function stored(repo, count, sugs = 0) {
  const seed = {};
  for (let i = 1; i <= count; i++) { const page = ['index.html', 'about.html', 'blog/post.html'][i % 3]; seed[cmt(repo, page, hex(i))] = thread(hex(i), page); }
  for (let i = 1; i <= sugs; i++) seed[`sug:${repo}:${hex(0xa000 + i)}`] = suggestion(hex(0xa000 + i));
  return seed;
}
const comments = (env, repo, page, headers = OWNER) => ask(env, 'GET', `/comments?repo=${repo}&path=${encodeURIComponent(page)}`, { headers });
const counts = (env, repo, headers = OWNER) => ask(env, 'GET', `/comments/counts?repo=${repo}`, { headers });

// ─── The config is corrected: everything comes along ─────────────────────────

test('rename: comment threads come along when the site starts using the new name, and none stays behind', async () => {
  const w = world({ ...met(OLD), ...stored(OLD, 6) });
  const before = new Map(w.kv.map);
  await withFetch(github(renamed), async () => {
    const r = await comments(w.env, NEW, 'index.html');
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.threads.map(t => t.id).sort(), [hex(3), hex(6)]);
    assert.equal((await counts(w.env, NEW)).json.total, 6);
  });
  assert.equal(w.keys(`cmt:${OLD}:`).length, 0, 'nothing is left under the old name');
  assert.equal(w.keys(`cmt:${NEW}:`).length, 6);
  for (let i = 1; i <= 6; i++) {
    const page = ['index.html', 'about.html', 'blog/post.html'][i % 3];
    assert.equal(w.kv.map.get(cmt(NEW, page, hex(i))), before.get(cmt(OLD, page, hex(i))), 'each thread is moved as it was, byte for byte');
  }
  assert.equal(w.json(`rid:${ID}`).name, NEW);
});

test('rename: suggestions come along, open and decided alike', async () => {
  const w = world({ ...met(OLD), ...stored(OLD, 0, 3), [`sug:${OLD}:${hex(0xb001)}`]: { ...suggestion(hex(0xb001)), status: 'declined', decided: { by: 'admin', ts: 9 } } });
  await withFetch(github(renamed), async () => {
    const r = await ask(w.env, 'GET', `/suggestions?repo=${NEW}`, { headers: OWNER });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.suggestions.length, 4);
    assert.deepEqual(r.json.counts, { open: 3 });
  });
  assert.equal(w.keys(`sug:${OLD}:`).length, 0);
  assert.equal(w.keys(`sug:${NEW}:`).length, 4);
  assert.equal(w.json(`sug:${NEW}:${hex(0xb001)}`).status, 'declined');
});

test('rename: API tokens come along, each still the same token with the same expiry', async () => {
  const w = world({ ...met(OLD), 'atok:other': token('someone/else', 'ffff0000') });
  await w.kv.put('atok:hash1', JSON.stringify(token(OLD)), { expiration: FAR });
  await w.kv.put('atok:hash2', JSON.stringify({ ...token(OLD, 'beef0001'), exp: null }));
  await withFetch(github(renamed), async () => {
    const r = await ask(w.env, 'GET', `/admin/api-tokens?repo=${NEW}`, { headers: OWNER });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.tokens.map(t => t.id).sort(), ['abcd1234', 'beef0001']);
  });
  assert.deepEqual(w.json('atok:hash1'), { ...token(OLD), repo: NEW }, 'the same key (the secret still works), now naming the new name');
  assert.equal(w.kv.expires.get('atok:hash1'), FAR, 'and it still expires when it was going to');
  assert.equal(w.json('atok:hash2').repo, NEW);
  assert.equal(w.kv.expires.has('atok:hash2'), false, 'a token that never expires still never does');
  assert.equal(w.json('atok:other').repo, 'someone/else', 'another site\'s token is not touched');
});

test('rename: scheduled publishes come along, and are shown under the new name before the cron has got to them', async () => {
  const at = Date.now() + 3 * 24 * 3600 * 1000;
  const w = world({ ...met(OLD), 'sched:other': schedule('someone/else', at) });
  await w.kv.put(`sched:${'1'.repeat(32)}`, JSON.stringify(schedule(OLD, at)), { expiration: FAR });
  await withFetch(github(renamed), async (calls) => {
    const r = await ask(w.env, 'GET', `/schedules?repo=${NEW}`, { headers: OWNER });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.schedules.map(s => s.id), ['1'.repeat(32)], 'listed at once, though the record still names the old name');
    assert.equal(w.json(`sched:${'1'.repeat(32)}`).repo, OLD);
    await cron(w.env);
    assert.equal(w.json(`sched:${'1'.repeat(32)}`).repo, NEW, 'the cron pass files it under the new name');
    assert.equal(w.kv.expires.get(`sched:${'1'.repeat(32)}`), FAR, 'with the expiry it had');
    assert.equal(w.json('sched:other').repo, 'someone/else');
    assert.equal(calls.filter(c => c.method === 'PUT').length, 0, 'nothing is published: it is not due');
    // It can still be cancelled under either name.
    assert.equal((await ask(w.env, 'POST', '/schedule/cancel', { headers: OWNER, body: { repo: OLD, id: '1'.repeat(32) } })).status, 200);
  });
  assert.equal(w.kv.map.has(`sched:${'1'.repeat(32)}`), false);
});

test('rename: a member stays signed in (the sign-in moves); an editor signs in again (the session under the old name ends)', async () => {
  const w = world({ ...met(OLD), [`people:${OLD}`]: [ADA, BEA], [`esess:${'f'.repeat(64)}`]: editorSession('someone/else') });
  await w.kv.put(`msess:${MEMBER}`, JSON.stringify({ repo: OLD, email: BEA.email, origin: ORIGIN }), { expiration: FAR });
  await w.kv.put(`esess:${SESSION}`, JSON.stringify(editorSession(OLD)), { expiration: FAR });
  await withFetch(github(renamed), async () => {
    assert.equal((await comments(w.env, NEW, 'index.html')).status, 200);
    assert.deepEqual(w.json(`msess:${MEMBER}`), { repo: NEW, email: BEA.email, origin: ORIGIN });
    assert.equal(w.kv.expires.get(`msess:${MEMBER}`), FAR);
    assert.deepEqual((await ask(w.env, 'POST', '/members/check', { body: { sid: MEMBER, origin: ORIGIN } })).json, { ok: true }, 'the members gate still lets Bea in');
    assert.equal(w.kv.map.has(`esess:${SESSION}`), false, 'no session is left that only the old name knows');
    assert.equal(w.kv.map.has(`esess:${'f'.repeat(64)}`), true, 'another site\'s session is not touched');
    // What an editor's browser still holds is refused, under either name.
    assert.equal((await comments(w.env, OLD, 'index.html', { 'X-Kiln-Session': SESSION })).status, 401);
    assert.equal((await ask(w.env, 'GET', `/gh/repos/${NEW}/contents/index.html`, { headers: { 'X-Kiln-Session': SESSION } })).status, 401);
  });
});

test('rename: the move is done when the old name is empty: the record says so and nothing is left to finish', async () => {
  const w = world({ ...met(OLD), ...stored(OLD, 5, 2), [`people:${OLD}`]: [ADA], 'atok:h': token(OLD) });
  await withFetch(github(renamed), async () => {
    await comments(w.env, NEW, 'index.html');
    await settle(w);
  });
  const rec = w.json(`rid:${ID}`);
  assert.deepEqual({ name: rec.name, was: rec.was, from: rec.from }, { name: NEW, was: OLD, from: undefined });
  assert.equal(typeof rec.moved, 'number');
  assert.deepEqual(w.keys('rmove:'), []);
  assert.deepEqual([...w.kv.map.keys()].filter(k => k.includes(OLD) && !k.startsWith('rname:')), [], 'no key is filed under the old name');
  assert.deepEqual([...w.kv.map.values()].filter(v => v.includes(`"repo":"${OLD}"`)), [], 'and no record names it');
  assert.equal(w.json(`rname:${OLD}`).id, ID, 'the old name stays on record as this repository, for a site that still uses it');
});

// ─── Nothing is lost if the worker stops halfway ─────────────────────────────

/** The same KV, cut off after `allowed` operations: what a request that hits a limit, or dies, leaves behind. */
function cutOff(kv, allowed, onDelete = () => {}) {
  let left = allowed;
  const op = (name) => async (...args) => {
    if (left-- <= 0) throw new Error('worker stopped');
    if (name === 'delete') onDelete(args[0]);
    return kv[name](...args);
  };
  return { map: kv.map, expires: kv.expires, get: op('get'), put: op('put'), delete: op('delete'), list: op('list') };
}

test('rename: nothing is lost wherever the worker stops: every thread and suggestion is under one name or the other at every moment, and all arrive', async () => {
  const w = world({ ...met(OLD), ...stored(OLD, 140, 35), [`people:${OLD}`]: [ADA, BEA] });
  const original = [...w.kv.map].filter(([k]) => /^(cmt|sug|people):/.test(k));
  assert.equal(original.length, 140 + 35 + 1);
  const everythingIsSomewhere = (when) => {
    for (const [key, value] of original) {
      const copies = [key, key.replace(`:${OLD}`, `:${NEW}`)].map(k => w.kv.map.get(k)).filter(v => v !== undefined);
      assert.ok(copies.length >= 1, `${key} is nowhere ${when}`);
      for (const c of copies) assert.equal(c, value, `${key} changed ${when}`);
    }
  };
  // A key under the old name is only ever removed once its copy under the new name is there.
  const copiedFirst = (key) => {
    if (!key.includes(`:${OLD}`) || !/^(cmt|sug|people):/.test(key)) return;
    assert.ok(w.kv.map.has(key.replace(`:${OLD}`, `:${NEW}`)), `${key} was removed before its copy existed`);
  };
  const allowances = [3, 9, 14, 23, 31, 17, 50, 8, 77, 26, 120, 41];
  let rounds = 0;
  await withFetch(github(renamed), async () => {
    for (; rounds < 600; rounds++) {
      const env = { ...w.env, KILN: cutOff(w.kv, allowances[rounds % allowances.length], copiedFirst) };
      // Requests and cron runs alike, each cut off somewhere else.
      if (rounds % 5 === 4) await cron(env);
      else {
        const real = console.error; console.error = () => {};
        try { await comments(env, NEW, 'index.html'); } finally { console.error = real; }
      }
      everythingIsSomewhere(`after round ${rounds}`);
      const rec = w.json(`rid:${ID}`);
      if (rec && rec.moved && !w.keys('rmove:').length) break;
    }
  });
  assert.ok(rounds < 600, 'the move finishes, cut off every time');
  assert.equal(w.keys(`cmt:${OLD}:`).length + w.keys(`sug:${OLD}:`).length, 0, 'the old name is empty');
  assert.equal(w.kv.map.has(`people:${OLD}`), false);
  assert.equal(w.keys(`cmt:${NEW}:`).length, 140);
  assert.equal(w.keys(`sug:${NEW}:`).length, 35);
  everythingIsSomewhere('at the end');
});

test('rename: the work is bounded: a request moves about a dozen threads, a cron run about a hundred, never more', async () => {
  const w = world({ ...met(OLD), ...stored(OLD, 400) });
  const left = () => w.keys(`cmt:${OLD}:`).length;
  let ops = 0;
  const counting = { map: w.kv.map, expires: w.kv.expires };
  for (const name of ['get', 'put', 'delete', 'list']) counting[name] = (...a) => { ops++; return w.kv[name](...a); };
  const env = { ...w.env, KILN: counting };
  await withFetch(github(renamed), async () => {
    await comments(env, NEW, 'none.html');           // the request that starts the move
    const afterFirst = left();
    assert.ok(afterFirst < 400 && afterFirst >= 400 - MOVE_OPS_PER_REQUEST / 4, `the first request moved ${400 - afterFirst}`);
    // A later request: what it spends on the move is at most the bound.
    // (Reading a page with no threads costs it a handful of operations more.)
    ops = 0;
    await comments(env, NEW, 'none.html');
    const moved2 = afterFirst - left();
    assert.ok(moved2 >= 8 && moved2 <= MOVE_OPS_PER_REQUEST / 4, `a request moved ${moved2}`);
    assert.ok(ops <= MOVE_OPS_PER_REQUEST + 10, `a request made ${ops} KV operations`);
    // The badge count does not move anything: it already reads up to a thousand threads.
    const beforeCounts = left();
    assert.equal((await counts(env, NEW)).json.total, 400);
    assert.equal(left(), beforeCounts);
    // A cron run.
    ops = 0;
    const beforeCron = left();
    await cron(env);
    const movedCron = beforeCron - left();
    assert.ok(movedCron >= 80 && movedCron <= MOVE_OPS_PER_CRON / 4, `a cron run moved ${movedCron}`);
    assert.ok(ops <= MOVE_OPS_PER_CRON + 10, `a cron run made ${ops} KV operations`);
    // And cron alone finishes it, with nobody making requests.
    const runs = await settle(w);
    assert.ok(runs <= 5, `finished after ${runs} more cron runs`);
  });
  assert.equal(left(), 0);
  assert.equal(w.keys(`cmt:${NEW}:`).length, 400);
});

test('rename: a move whose record of progress is lost is picked up again from the repository\'s own record', async () => {
  const w = world({ ...stored(OLD, 4), [`rid:${ID}`]: { id: ID, name: NEW, was: OLD, at: 2, from: [OLD] }, [`rname:${NEW.toLowerCase()}`]: { id: ID }, [`rname:${OLD}`]: { id: ID } });
  await withFetch(github(renamed), async () => {
    assert.equal((await comments(w.env, NEW, 'index.html')).json.threads.length, 1);
    await settle(w);
  });
  assert.equal(w.keys(`cmt:${NEW}:`).length, 4);
  assert.equal(w.json(`rid:${ID}`).from, undefined);
});

// ─── While a move is in progress: nothing hidden, nothing counted twice ──────

test('rename in progress: every thread is seen once: the ones already moved, the ones not yet moved, and one that is under both for a moment', async () => {
  const w = world({ ...met(OLD), ...stored(OLD, 90) });
  await withFetch(github(renamed), async () => {
    await comments(w.env, NEW, 'none.html');     // starts the move; a first few threads go over
    const [there, here] = [w.keys(`cmt:${OLD}:`).length, w.keys(`cmt:${NEW}:`).length];
    assert.ok(there > 0 && here > 0 && there + here === 90, `in progress: ${there} not yet moved, ${here} moved`);
    // A thread copied to the new name whose old key is not yet removed: where a step was cut short.
    const straggler = w.keys(`cmt:${OLD}:`)[0];
    w.kv.map.set(straggler.replace(OLD, NEW), w.kv.map.get(straggler));
    for (const name of [NEW, OLD]) {
      const c = await counts(w.env, name);
      assert.equal(c.json.total, 90, `asked as ${name}: not ${there} (hidden), not 91 (twice)`);
      assert.deepEqual(c.json.counts, { 'index.html': 30, 'about.html': 30, 'blog/post.html': 30 });
    }
    const page = await comments(w.env, NEW, 'about.html');
    assert.equal(page.json.threads.length, 30);
    assert.equal(new Set(page.json.threads.map(t => t.id)).size, 30, 'no thread twice');
    assert.ok(w.keys(`cmt:${OLD}:`).length > 0, 'and the move is still going on');
  });
});

test('rename in progress: threads that move while a request is reading them are still read, once', async () => {
  const w = world({ ...met(OLD), ...stored(OLD, 90) });
  await withFetch(github(renamed), async () => {
    await comments(w.env, NEW, 'none.html');
    const pending = w.keys(`cmt:${OLD}:`).length;
    assert.ok(pending > 60);
    // The request has listed both names; before it reads a single thread, a cron run moves every one that was left.
    let ran = false;
    const KILN = { ...w.kv, list: async (o) => {
      const page = await w.kv.list(o);
      if (!ran && o.prefix === `cmt:${NEW}:`) { ran = true; await cron(w.env); }
      return page;
    } };
    const c = await counts({ ...w.env, KILN }, NEW);
    assert.equal(ran, true);
    assert.equal(w.keys(`cmt:${OLD}:`).length, 0, 'everything moved under the reader\'s feet');
    assert.equal(c.json.total, 90);
  });
});

test('rename in progress: taking someone off the list ends their sessions and their schedules under both names', async () => {
  const w = world({ ...met(OLD), ...stored(OLD, 200), [`people:${OLD}`]: [ADA, BEA],
    [`esess:${SESSION}`]: editorSession(OLD), [`msess:${MEMBER}`]: { repo: OLD, email: BEA.email, origin: ORIGIN },
    [`sched:${'d'.repeat(32)}`]: schedule(OLD, Date.now() + 3600e3, { by: 'Ada', byEmail: ADA.email, admin: false }) });
  await withFetch(github(renamed), async () => {
    await comments(w.env, NEW, 'none.html');
    assert.ok(w.kv.map.has(`esess:${SESSION}`) && w.json(`msess:${MEMBER}`).repo === OLD, 'the move has not got to the sessions yet');
    for (const email of [ADA.email, BEA.email]) {
      assert.equal((await ask(w.env, 'POST', '/admin/people/remove', { headers: OWNER, body: { repo: NEW, email } })).status, 200);
    }
    assert.equal(w.kv.map.has(`esess:${SESSION}`), false);
    assert.equal(w.kv.map.has(`msess:${MEMBER}`), false);
    assert.equal(w.kv.map.has(`sched:${'d'.repeat(32)}`), false);
    await settle(w);
  });
  assert.deepEqual(w.json(`people:${NEW}`), []);
  assert.equal(w.kv.map.has(`people:${OLD}`), false);
});

test('rename in progress: a new comment, a reply, a resolve and a delete made meanwhile are all still true when the move is done', async () => {
  const w = world({ ...met(OLD), ...stored(OLD, 120), [`people:${OLD}`]: [ADA] });
  const last = (n) => w.keys(`cmt:${OLD}:${encodeURIComponent('index.html')}:`).slice(-n)[0].slice(-12);   // the threads a move gets to last
  await withFetch(github(renamed), async () => {
    await comments(w.env, NEW, 'none.html');
    // A new thread.
    const fresh = await ask(w.env, 'POST', '/comments', { headers: OWNER, body: { repo: NEW, path: 'index.html', text: 'written while moving' } });
    assert.equal(fresh.status, 200, JSON.stringify(fresh.json));
    assert.ok(w.kv.map.has(cmt(NEW, 'index.html', fresh.json.thread.id)), 'filed under the new name at once');
    // A reply to a thread that has not moved yet.
    const replied = last(1);
    assert.ok(w.kv.map.has(cmt(OLD, 'index.html', replied)), 'the thread replied to is still under the old name');
    const reply = await ask(w.env, 'POST', '/comments', { headers: OWNER, body: { repo: NEW, path: 'index.html', thread: replied, text: 'a reply while moving' } });
    assert.equal(reply.status, 200, JSON.stringify(reply.json));
    assert.equal(reply.json.thread.messages.length, 2);
    assert.equal(w.kv.map.has(cmt(OLD, 'index.html', replied)), false, 'the reply is not left under the old name alone');
    // Resolving another.
    const resolved = last(1);
    assert.notEqual(resolved, replied);
    assert.equal((await ask(w.env, 'POST', '/comments/resolve', { headers: OWNER, body: { repo: NEW, path: 'index.html', thread: resolved, resolved: true } })).json.thread.status, 'resolved');
    // Deleting a third.
    const deleted = last(1);
    assert.equal((await ask(w.env, 'POST', '/comments/delete', { headers: OWNER, body: { repo: NEW, path: 'index.html', thread: deleted } })).status, 200);
    assert.ok(w.keys(`cmt:${OLD}:`).length > 0, 'all of that happened while the move was still going on');
    await settle(w);
    const page = (await comments(w.env, NEW, 'index.html')).json.threads;
    assert.equal(page.length, 40 + 1 - 1);
    assert.equal(page.find(t => t.id === fresh.json.thread.id).messages[0].text, 'written while moving');
    assert.deepEqual(page.find(t => t.id === replied).messages.map(m => m.text), ['about index.html', 'a reply while moving']);
    assert.equal(page.find(t => t.id === resolved).status, 'resolved');
    assert.equal(page.some(t => t.id === deleted), false, 'the move did not bring the deleted thread back');
  });
  assert.equal(w.keys(`cmt:${OLD}:`).length, 0);
  assert.equal(w.keys(`cmt:${NEW}:`).length, 120);
});

test('rename in progress: suggestions are listed once each, and one decided meanwhile stays decided', async () => {
  const w = world({ ...met(OLD), ...stored(OLD, 0, 60) });
  await withFetch(github(renamed), async () => {
    const first = await ask(w.env, 'GET', `/suggestions?repo=${NEW}`, { headers: OWNER });
    assert.equal(first.json.suggestions.length, 60);
    assert.ok(w.keys(`sug:${OLD}:`).length > 0 && w.keys(`sug:${NEW}:`).length > 0, 'in progress');
    const pending = w.keys(`sug:${OLD}:`).slice(-1)[0].slice(-12);
    const decline = await ask(w.env, 'POST', '/suggestions/decide', { headers: OWNER, body: { repo: NEW, id: pending, approve: false, note: 'not now' } });
    assert.equal(decline.status, 200, JSON.stringify(decline.json));
    assert.equal(w.json(`sug:${NEW}:${pending}`).status, 'declined');
    const again = await ask(w.env, 'GET', `/suggestions?repo=${OLD}`, { headers: OWNER });
    assert.equal(again.json.suggestions.length, 60, 'the site\'s old name sees the same sixty');
    assert.deepEqual(again.json.counts, { open: 59 });
    await settle(w);
    const done = await ask(w.env, 'GET', `/suggestions?repo=${NEW}`, { headers: OWNER });
    assert.deepEqual(done.json.counts, { open: 59 });
    assert.equal(done.json.suggestions.find(s => s.id === pending).decided.note, 'not now');
  });
  assert.equal(w.keys(`sug:${OLD}:`).length, 0);
});

test('rename in progress: tokens and schedules are listed under both names, moved or not, and a new one is filed under the new name', async () => {
  const at = Date.now() + 24 * 3600 * 1000;
  const w = world({ ...met(OLD), ...stored(OLD, 200), 'atok:h': token(OLD), [`sched:${'2'.repeat(32)}`]: schedule(OLD, at) });
  await withFetch(github(renamed), async () => {
    for (const name of [NEW, OLD]) {
      assert.deepEqual((await ask(w.env, 'GET', `/admin/api-tokens?repo=${name}`, { headers: OWNER })).json.tokens.map(t => t.id), ['abcd1234'], name);
      assert.deepEqual((await ask(w.env, 'GET', `/schedules?repo=${name}`, { headers: OWNER })).json.schedules.map(s => s.id), ['2'.repeat(32)], name);
    }
    assert.ok(w.keys(`cmt:${OLD}:`).length > 0, 'in progress');
    // Made through a page that still has the old config.
    const made = await ask(w.env, 'POST', '/admin/api-tokens', { headers: OWNER, body: { repo: OLD, name: 'made meanwhile' } });
    assert.equal(made.status, 200, JSON.stringify(made.json));
    const later = await ask(w.env, 'POST', '/schedule', { headers: OWNER, body: { repo: OLD, path: 'index.html', edits: [{ key: 't', html: 'Later' }], at: new Date(at).toISOString() } });
    assert.equal(later.status, 200, JSON.stringify(later.json));
    assert.equal(w.json(`sched:${later.json.id}`).repo, NEW);
    assert.equal(Object.values(Object.fromEntries(w.kv.map)).filter(v => v.includes('made meanwhile') && v.includes(`"repo":"${NEW}"`)).length, 1);
    assert.equal((await ask(w.env, 'POST', '/admin/api-tokens/revoke', { headers: OWNER, body: { repo: NEW, id: 'abcd1234' } })).status, 200, 'a token can be revoked under the new name wherever its record has got to');
  });
  assert.equal(w.kv.map.has('atok:h'), false);
});

// ─── A site that still uses the old name keeps working ───────────────────────

test('old name: a site that never changed its config works as before: nothing moves, nothing is asked twice', async () => {
  const at = Date.now() + 24 * 3600 * 1000;
  const w = world({ ...met(OLD), ...stored(OLD, 3, 2), 'atok:h': token(OLD), [`sched:${'3'.repeat(32)}`]: schedule(OLD, at) });
  await withFetch(github(renamed), async () => {
    assert.equal((await counts(w.env, OLD)).json.total, 3);
    assert.equal((await ask(w.env, 'GET', `/suggestions?repo=${OLD}`, { headers: OWNER })).json.suggestions.length, 2);
    assert.equal((await ask(w.env, 'GET', `/admin/api-tokens?repo=${OLD}`, { headers: OWNER })).json.tokens.length, 1);
    assert.equal((await ask(w.env, 'GET', `/schedules?repo=${OLD}`, { headers: OWNER })).json.schedules.length, 1);
    await cron(w.env);
  });
  assert.equal(w.json(`rid:${ID}`).name, OLD);
  assert.equal(w.keys(`cmt:${OLD}:`).length, 3);
  assert.deepEqual(w.keys('rmove:'), []);
  assert.equal([...w.kv.map.keys()].some(k => k.includes(NEW)), false, 'nothing was filed under the new name');
});

test('old name: after the move, a site still using the old name reads and writes the same things: comments, suggestions, schedules, tokens', async () => {
  const at = Date.now() + 24 * 3600 * 1000;
  const w = world({ ...moved(NEW, OLD), ...stored(NEW, 3, 2), 'atok:h': token(NEW), [`sched:${'4'.repeat(32)}`]: schedule(NEW, at), [`people:${NEW}`]: [ADA] });
  await withFetch(github(renamed), async () => {
    assert.equal((await counts(w.env, OLD)).json.total, 3);
    assert.deepEqual((await comments(w.env, OLD, 'index.html')).json.threads.map(t => t.id), [hex(3)]);
    assert.equal((await ask(w.env, 'GET', `/suggestions?repo=${OLD}`, { headers: OWNER })).json.suggestions.length, 2);
    assert.deepEqual((await ask(w.env, 'GET', `/admin/api-tokens?repo=${OLD}`, { headers: OWNER })).json.tokens.map(t => t.id), ['abcd1234']);
    assert.deepEqual((await ask(w.env, 'GET', `/schedules?repo=${OLD}`, { headers: OWNER })).json.schedules.map(s => s.id), ['4'.repeat(32)]);
    // What it writes goes into the one place.
    const c = await ask(w.env, 'POST', '/comments', { headers: OWNER, body: { repo: OLD, path: 'index.html', text: 'from the old config' } });
    assert.equal(c.status, 200, JSON.stringify(c.json));
    assert.equal((await ask(w.env, 'POST', '/comments', { headers: OWNER, body: { repo: OLD, path: 'index.html', thread: hex(3), text: 'and a reply' } })).json.thread.messages.length, 2);
    assert.equal((await ask(w.env, 'POST', '/suggestions/decide', { headers: OWNER, body: { repo: OLD, id: hex(0xa001), approve: false } })).json.suggestion.status, 'declined');
    assert.equal((await ask(w.env, 'POST', '/schedule/cancel', { headers: OWNER, body: { repo: OLD, id: '4'.repeat(32) } })).status, 200);
    assert.equal((await ask(w.env, 'POST', '/admin/api-tokens/revoke', { headers: OWNER, body: { repo: OLD, id: 'abcd1234' } })).status, 200);
  });
  assert.equal(w.keys(`cmt:${NEW}:`).length, 4);
  assert.equal(w.json(cmt(NEW, 'index.html', hex(3))).messages.length, 2);
  assert.equal(w.json(`sug:${NEW}:${hex(0xa001)}`).status, 'declined');
  assert.deepEqual([...w.kv.map.keys()].filter(k => /^(cmt|sug|people):/.test(k) && k.includes(OLD)), [], 'nothing is filed under the old name again');
  assert.equal(w.json(`rid:${ID}`).name, NEW, 'and nothing is moved back');
});

test('old name: an editor who signs in through a site with the old config gets a session on the repository, and it works under either name', async () => {
  const w = world({ ...moved(NEW, OLD), ...stored(NEW, 3), [`people:${NEW}`]: [ADA], 'gstate:n1': { origin: ORIGIN, returnTo: '/', repo: OLD } },
    { GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsecret' });
  const gh = github(renamed);
  await withFetch(async (url, init) => {
    if (url === 'https://oauth2.googleapis.com/token') return jsonRes({ id_token: 'idt' });
    if (url.startsWith('https://oauth2.googleapis.com/tokeninfo')) return jsonRes({ aud: 'gid', email_verified: 'true', email: ADA.email, name: 'Ada' });
    return gh(url, init);
  }, async (calls) => {
    const res = await worker.fetch(new Request('https://worker.example/google/callback?code=c&state=n1'), w.env);
    assert.equal(res.status, 302);
    const frag = new URLSearchParams(new URL(res.headers.get('Location')).hash.slice(1));
    assert.equal(frag.get('kiln-repo'), OLD, 'the site is told the name it asked with: that is what its editor compares');
    const sid = frag.get('kiln-esession');
    assert.equal(w.json(`esess:${sid}`).repo, NEW, 'the session itself is filed where the repository\'s things are');
    const as = { 'X-Kiln-Session': sid };
    // The worker's own routes, asked the way the old config asks.
    assert.deepEqual((await comments(w.env, OLD, 'index.html', as)).json.threads.map(t => t.id), [hex(3)]);
    assert.equal((await ask(w.env, 'POST', '/comments', { headers: as, body: { repo: OLD, path: 'index.html', text: 'hello' } })).status, 200);
    assert.equal((await ask(w.env, 'POST', '/presence', { headers: as, body: { repo: OLD, path: '/', name: 'x' } })).status, 200);
    // The commit proxy: the old name in the path reaches the same repository.
    calls.length = 0;
    const viaOld = await ask(w.env, 'GET', `/gh/repos/${OLD}/contents/index.html?ref=main`, { headers: as });
    assert.equal(viaOld.status, 200, JSON.stringify(viaOld.json));
    assert.deepEqual(calls.filter(c => c.url.includes('/contents/')).map(c => c.url), [`${GH}/repos/${NEW}/contents/index.html?ref=main`]);
    assert.equal((await ask(w.env, 'GET', `/gh/repos/${NEW}/contents/index.html`, { headers: as })).status, 200, 'and so does the new one');
    // No other repository's name is let through.
    assert.equal((await ask(w.env, 'GET', '/gh/repos/someone/else/contents/index.html', { headers: as })).status, 403);
    assert.equal((await comments(w.env, 'someone/else', 'index.html', as)).status, 401);
    // Taking Ada off the list ends it, whichever name the owner's page has.
    assert.equal((await ask(w.env, 'POST', '/admin/people/remove', { headers: OWNER, body: { repo: NEW, email: ADA.email } })).status, 200);
    assert.equal(w.kv.map.has(`esess:${sid}`), false);
  });
});

test('old name: what was last heard about the old name does not move everything back', async () => {
  // A minute before the rename the worker asked GitHub about the old name, and remembers "this is its current name".
  const w = world({ ...met(OLD), ...stored(OLD, 5), [`rsee:${OLD}`]: { id: ID, name: OLD } });
  await withFetch(github(renamed), async () => {
    await comments(w.env, NEW, 'index.html');              // the corrected site: the move begins
    await comments(w.env, OLD, 'index.html');              // a page still open with the old config
    await comments(w.env, NEW, 'index.html');
    await settle(w);
  });
  assert.equal(w.json(`rid:${ID}`).name, NEW);
  assert.equal(w.keys(`cmt:${NEW}:`).length, 5);
  assert.equal(w.keys(`cmt:${OLD}:`).length, 0);
});

test('rename twice: a second rename before the first move is finished takes everything to the name the repository has now', async () => {
  const MID = 'oldowner/society';
  const names = { ...renamed, [MID.toLowerCase()]: { id: ID, full_name: NEW } };
  const w = world({ ...stored(OLD, 30), ...stored(MID, 0, 4), [cmt(MID, 'index.html', hex(900))]: thread(hex(900), 'index.html'),
    [`rid:${ID}`]: { id: ID, name: MID, was: OLD, at: 2, from: [OLD] }, [`rname:${OLD}`]: { id: ID }, [`rname:${MID}`]: { id: ID }, [`rmove:${ID}`]: { id: ID, to: MID, at: 2, done: { atok: true } } });
  await withFetch(github(names), async () => {
    assert.equal((await counts(w.env, NEW)).json.total, 31);
    await comments(w.env, NEW, 'index.html');
    await settle(w);
    assert.equal((await counts(w.env, MID)).json.total, 31, 'either earlier name still reads it all');
  });
  assert.equal(w.keys(`cmt:${NEW}:`).length, 31);
  assert.equal(w.keys(`sug:${NEW}:`).length, 4);
  assert.deepEqual([...w.kv.map.keys()].filter(k => /^(cmt|sug):/.test(k) && !k.includes(NEW)), []);
  const rec = w.json(`rid:${ID}`);
  assert.deepEqual({ name: rec.name, from: rec.from }, { name: NEW, from: undefined });
});

test('earlier release: a repository whose people were moved by the release before this one has the rest follow on its next request', async () => {
  // What that release left: the people under the new name, everything else under the old one, and no record of the old name.
  const w = world({ ...stored(OLD, 4, 1), [cmt(NEW, 'index.html', hex(800))]: thread(hex(800), 'index.html'), 'atok:h': token(OLD),
    [`people:${NEW}`]: [ADA], [`rid:${ID}`]: { id: ID, name: NEW, was: OLD, at: 2 }, [`rname:${NEW.toLowerCase()}`]: { id: ID } });
  await withFetch(github(renamed), async () => {
    assert.equal((await counts(w.env, NEW)).json.total, 5, 'seen at once');
    await comments(w.env, NEW, 'index.html');
    await settle(w);
  });
  assert.equal(w.keys(`cmt:${NEW}:`).length, 5);
  assert.equal(w.keys(`sug:${NEW}:`).length, 1);
  assert.equal(w.json('atok:h').repo, NEW);
  assert.equal(typeof w.json(`rid:${ID}`).moved, 'number');
  // …unless the old name has become another repository's on this worker: what is under it is not taken.
  const other = world({ ...stored(OLD, 2), [`people:${NEW}`]: [ADA], [`rid:${ID}`]: { id: ID, name: NEW, was: OLD, at: 2 }, [`rname:${NEW.toLowerCase()}`]: { id: ID }, ...met(OLD, SQUAT) });
  await withFetch(github(taken), async () => {
    assert.equal((await counts(other.env, NEW)).json.total, 0);
  });
  assert.equal(other.keys(`cmt:${OLD}:`).length, 2);
  assert.equal(other.keys(`cmt:${NEW}:`).length, 0);
});

// ─── A takeover gets nothing ─────────────────────────────────────────────────
// The repository moved away and its site was never corrected: its things are
// still under the old name. Then somebody else gets that name, installs the
// App, and can push to what is now a different repository.

const mallory = { Authorization: 'Bearer gho_mallory' };

test('takeover: comment threads of the repository that had the name are not shown to its new holder, and cannot be added to or deleted', async () => {
  const w = world({ ...met(OLD), ...stored(OLD, 3) });
  const before = new Map(w.kv.map);
  await withFetch(github(taken), async () => {
    for (const r of [await comments(w.env, OLD, 'index.html', mallory), await counts(w.env, OLD, mallory)]) {
      assert.equal(r.status, 401);
      assert.doesNotMatch(JSON.stringify(r.json), /about|index\.html|threads|counts/);
    }
    assert.equal((await ask(w.env, 'POST', '/comments', { headers: mallory, body: { repo: OLD, path: 'index.html', text: 'mine now' } })).status, 401);
    assert.equal((await ask(w.env, 'POST', '/comments', { headers: mallory, body: { repo: OLD, path: 'index.html', thread: hex(3), text: 'me too' } })).status, 401);
    assert.equal((await ask(w.env, 'POST', '/comments/delete', { headers: mallory, body: { repo: OLD, path: 'index.html', thread: hex(3) } })).status, 401);
    assert.deepEqual((await ask(w.env, 'GET', `/setup/install-check?repo=${OLD}`)).json, { repo: OLD, installed: true, renamed: false, reused: true }, 'and kiln doctor is told');
  });
  assert.deepEqual([...w.kv.map].filter(([k]) => k.startsWith('cmt:')), [...before].filter(([k]) => k.startsWith('cmt:')), 'the threads are as they were');
  assert.equal(w.json(`rname:${OLD}`).id, ID, 'and the name is still on record as the first repository');
});

test('takeover: suggestions of the repository that had the name are not shown to its new holder, and cannot be decided', async () => {
  const w = world({ ...met(OLD), ...stored(OLD, 0, 2) });
  await withFetch(github(taken), async (calls) => {
    const list = await ask(w.env, 'GET', `/suggestions?repo=${OLD}`, { headers: mallory });
    assert.equal(list.status, 401);
    assert.equal(list.json.suggestions, undefined);
    assert.equal((await ask(w.env, 'POST', '/suggestions/decide', { headers: mallory, body: { repo: OLD, id: hex(0xa001), approve: true } })).status, 401);
    assert.equal(calls.filter(c => c.method === 'PUT').length, 0, 'nothing of it is committed to the other repository');
  });
  assert.equal(w.json(`sug:${OLD}:${hex(0xa001)}`).status, 'open');
  assert.equal(w.json(`rname:${OLD}`).id, ID);
});

test('takeover: a scheduled publish of the repository that had the name is not shown, not cancelled, and never published into the other repository', async () => {
  const w = world({ ...met(OLD), [`sched:${'5'.repeat(32)}`]: schedule(OLD, Date.now() - 60000) });
  await withFetch(github(taken), async (calls) => {
    const list = await ask(w.env, 'GET', `/schedules?repo=${OLD}`, { headers: mallory });
    assert.equal(list.status, 403);
    assert.equal(list.json.schedules, undefined);
    assert.equal((await ask(w.env, 'POST', '/schedule/cancel', { headers: mallory, body: { repo: OLD, id: '5'.repeat(32) } })).status, 403);
    await cron(w.env);     // it is due
    await cron(w.env);
    assert.deepEqual(calls.filter(c => c.method === 'PUT'), [], 'the cron does not publish it to whatever answers to the name now');
  });
  assert.equal(w.json(`sched:${'5'.repeat(32)}`).repo, OLD, 'it waits where it is, for its own site to say where the repository went');
  assert.equal(w.json(`rname:${OLD}`).id, ID);
});

test('takeover: API tokens of the repository that had the name are not listed, revoked or added to by its new holder', async () => {
  const w = world({ ...met(OLD), 'atok:h': token(OLD) });
  await withFetch(github(taken), async () => {
    const list = await ask(w.env, 'GET', `/admin/api-tokens?repo=${OLD}`, { headers: mallory });
    assert.equal(list.status, 403);
    assert.equal(list.json.code, 'repo_changed');
    assert.equal(list.json.tokens, undefined);
    assert.equal((await ask(w.env, 'POST', '/admin/api-tokens/revoke', { headers: mallory, body: { repo: OLD, id: 'abcd1234' } })).status, 403);
    assert.equal((await ask(w.env, 'POST', '/admin/api-tokens', { headers: mallory, body: { repo: OLD, name: 'mine' } })).status, 403);
  });
  assert.deepEqual(w.json('atok:h'), token(OLD));
  assert.deepEqual(w.keys('atok:'), ['atok:h']);
  assert.equal(w.json(`rname:${OLD}`).id, ID);
});

test('takeover: nothing of either repository is moved: the new holder\'s own things stay where they are, and the first repository\'s stay under the name', async () => {
  // The other repository was already known to this worker under another name, with a thread of its own.
  const FIRST = 'mallory/first';
  const names = { ...taken, [FIRST]: { id: SQUAT, full_name: OLD } };
  const w = world({ ...met(OLD), ...stored(OLD, 3, 1), ...met(FIRST, SQUAT), [cmt(FIRST, 'index.html', hex(700))]: thread(hex(700), 'index.html'),
    [`msess:${MEMBER}`]: { repo: OLD, email: BEA.email, origin: ORIGIN } });
  const before = new Map(w.kv.map);
  await withFetch(github(names), async () => {
    assert.equal((await comments(w.env, OLD, 'index.html', mallory)).status, 401);
    // A request that needs no GitHub sign-in at all and makes the worker look for the name's people.
    assert.deepEqual((await ask(w.env, 'POST', '/members/check', { body: { sid: MEMBER, origin: ORIGIN } })).json, { ok: false });
    await cron(w.env);
  });
  assert.equal(w.json(`rid:${SQUAT}`).name, FIRST, 'the other repository was not turned over to the held name');
  assert.deepEqual(w.keys('cmt:'), [...before.keys()].filter(k => k.startsWith('cmt:')).sort());
  assert.deepEqual(w.keys('sug:'), [...before.keys()].filter(k => k.startsWith('sug:')).sort());
  assert.deepEqual(w.keys('rmove:'), []);
});

test('takeover while a move is going on: the name is held until everything under it has left', async () => {
  const w = world({ ...met(OLD), ...stored(OLD, 60) });
  await withFetch(github(renamed), async () => { await comments(w.env, NEW, 'none.html'); });
  assert.ok(w.keys(`cmt:${OLD}:`).length > 0, 'in progress');
  w.kv.map.delete(`rsee:${OLD}`); w.kv.map.delete(`itok:${OLD}`);
  await withFetch(github(taken), async () => {
    assert.equal((await counts(w.env, OLD, mallory)).status, 401);
    assert.equal((await ask(w.env, 'GET', `/admin/people?repo=${OLD}`, { headers: mallory })).status, 403);
    // The repository itself carries on under its new name, and its move finishes.
    assert.equal((await counts(w.env, NEW)).json.total, 60);
    await comments(w.env, NEW, 'index.html');
    await settle(w);
    assert.equal(w.keys(`cmt:${NEW}:`).length, 60);
    // Now the old name holds nothing: its new holder starts clean, with a shelf of their own.
    const mine = await counts(w.env, OLD, mallory);
    assert.equal(mine.status, 200);
    assert.deepEqual(mine.json, { counts: {}, total: 0 });
    assert.equal((await ask(w.env, 'POST', '/comments', { headers: mallory, body: { repo: OLD, path: 'index.html', text: 'a first thread' } })).status, 200);
    assert.deepEqual((await ask(w.env, 'GET', `/admin/api-tokens?repo=${OLD}`, { headers: mallory })).json, { tokens: [] });
  });
  assert.equal(w.json(`rname:${OLD}`).id, SQUAT);
  assert.equal(w.keys(`cmt:${OLD}:`).length, 1);
  assert.equal(w.keys(`cmt:${NEW}:`).length, 60, 'and the first repository\'s threads are untouched');
});

// ─── A scheduled publish: once, to the right repository ──────────────────────

const publishes = (calls) => calls.filter(c => c.method === 'PUT').map(c => c.url);

test('schedule: due while the site still has the old name, it is published once, to the repository under its current name', async () => {
  const w = world({ ...met(OLD), [`sched:${'6'.repeat(32)}`]: schedule(OLD, Date.now() - 60000) });
  await withFetch(github(renamed), async (calls) => {
    await cron(w.env);
    await cron(w.env);
    assert.deepEqual(publishes(calls), [`${GH}/repos/${NEW}/contents/index.html`]);
    assert.equal(calls.find(c => c.method === 'PUT').body.content, b64(PAGE.replace('Before', 'After')));
  });
  assert.deepEqual(w.keys('sched:'), []);
  assert.equal(w.json(`rid:${ID}`).name, OLD, 'publishing moves nothing');
});

test('schedule: due while the move is going on, it is published once: not twice (moved, then published again), not never', async () => {
  const id = '7'.repeat(32);
  const w = world({ ...met(OLD), ...stored(OLD, 300), [`sched:${id}`]: schedule(OLD, Date.now() - 60000), [`sched:${'8'.repeat(32)}`]: schedule(OLD, Date.now() + 3600e3) });
  await withFetch(github(renamed), async (calls) => {
    await comments(w.env, NEW, 'none.html');      // the move begins; the schedules still name the old name
    assert.equal(w.json(`sched:${id}`).repo, OLD);
    await cron(w.env);
    assert.deepEqual(publishes(calls), [`${GH}/repos/${NEW}/contents/index.html`]);
    assert.equal(w.kv.map.has(`sched:${id}`), false);
    assert.equal(w.json(`sched:${'8'.repeat(32)}`).repo, NEW, 'the one that is not due yet is filed under the new name');
    await comments(w.env, NEW, 'none.html');
    await settle(w);
    assert.equal(publishes(calls).length, 1, 'requests and cron runs for the rest of the move publish nothing more');
  });
});

test('schedule: one that became due under the new name is published once, and an editor\'s own is still checked against the people list', async () => {
  const id = '9'.repeat(32);
  const w = world({ ...moved(NEW, OLD), [`people:${NEW}`]: [ADA],
    [`sched:${id}`]: schedule(NEW, Date.now() - 60000, { by: 'Ada', byEmail: ADA.email, admin: false }),
    [`sched:${'a'.repeat(32)}`]: schedule(NEW, Date.now() - 60000, { by: 'Gone', byEmail: 'gone@example.com', admin: false }) });
  await withFetch(github(renamed), async (calls) => {
    await cron(w.env);
    await cron(w.env);
    assert.deepEqual(publishes(calls), [`${GH}/repos/${NEW}/contents/index.html`]);
  });
  assert.deepEqual(w.keys('sched:'), [], 'one fired; the one whose author is no longer an editor was dropped');
});

test('schedule: a worker with no cron running still finishes a move: after an hour a request files the schedules under the new name itself', async () => {
  const id = 'c'.repeat(32);
  const seed = (at) => ({ ...stored(OLD, 2), [`sched:${id}`]: schedule(OLD, Date.now() + 3600e3),
    [`rid:${ID}`]: { id: ID, name: NEW, was: OLD, at, from: [OLD] }, [`rname:${NEW.toLowerCase()}`]: { id: ID }, [`rname:${OLD}`]: { id: ID }, [`rmove:${ID}`]: { id: ID, to: NEW, at, done: {} } });
  // A move that began a minute ago leaves schedules to the cron, which is the only other thing that writes them.
  const recent = world(seed(Date.now() - 60000));
  await withFetch(github(renamed), async () => { await comments(recent.env, NEW, 'index.html'); await comments(recent.env, NEW, 'index.html'); });
  assert.equal(recent.json(`sched:${id}`).repo, OLD);
  assert.equal(recent.keys('rmove:').length, 1, 'and is not finished until they are');
  const stuck = world(seed(Date.now() - 61 * 60 * 1000));
  await withFetch(github(renamed), async () => { await comments(stuck.env, NEW, 'index.html'); });
  assert.equal(stuck.json(`sched:${id}`).repo, NEW);
  assert.deepEqual(stuck.keys('rmove:'), []);
  assert.equal(typeof stuck.json(`rid:${ID}`).moved, 'number');
});

// ─── What kiln doctor relies on ──────────────────────────────────────────────

test('doctor: a repository deleted and made again under the same name is held by what is stored, and released by removing the name\'s record, as doctor advises', async () => {
  // The first repository is gone; a new one has its name. Its owner is the same person, on their own worker.
  const w = world({ ...met(OLD), ...stored(OLD, 2, 1), 'atok:h': token(OLD) });
  const again = { [OLD.toLowerCase()]: { id: SQUAT, full_name: OLD } };
  await withFetch(github(again), async () => {
    assert.equal((await counts(w.env, OLD)).status, 401);
    assert.equal((await ask(w.env, 'GET', `/setup/install-check?repo=${OLD}`)).json.reused, true);
    w.kv.map.delete(`rname:${OLD}`);       // npx wrangler kv key delete "rname:oldowner/club" --binding KILN
    assert.equal((await counts(w.env, OLD)).json.total, 2, 'what is stored under the name belongs to the repository that has it now');
    assert.equal((await ask(w.env, 'GET', `/admin/api-tokens?repo=${OLD}`, { headers: OWNER })).json.tokens.length, 1);
    assert.equal((await ask(w.env, 'GET', `/setup/install-check?repo=${OLD}`)).json.reused, false);
  });
  assert.equal(w.json(`rname:${OLD}`).id, SQUAT);
});

// ─── The worker has to start ─────────────────────────────────────────────────

test('worker module: every named export is a function (the Workers runtime refuses to start a worker with any other kind)', async () => {
  const mod = await import('../worker/index.js');
  for (const [name, value] of Object.entries(mod)) {
    if (name !== 'default') assert.equal(typeof value, 'function', `export ${name}`);
  }
});
