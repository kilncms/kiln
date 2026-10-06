/**
 * KLR-08 — a repository is its id, not its name.
 *
 * Everything a site stores in the worker is filed under the `owner/name` in
 * its kiln-config.js. A repository that is renamed, or moved to another
 * account, keeps its id; GitHub answers to the old name only until someone
 * else takes it. These tests drive the real request handlers through the
 * three things that can then happen:
 *
 *   - the site keeps the old name in its config (it must keep working, and
 *     the worker must have the id on record);
 *   - the site's config is corrected (the people list must come along);
 *   - somebody else gets the old name (they must get nothing).
 *
 * GitHub is played by the harness: a table of names → { id, full_name }.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { fakeKV, withFetch, jsonRes, ORIGIN } from './worker-harness.js';
import { fakeD1, d1Skip } from './d1-fake.js';

const GH = 'https://api.github.com';
const OLD = 'oldowner/club';        // the name in the site's config
const NEW = 'NewOrg/club';          // what GitHub calls the repository now
const ID = 4242;                    // the repository
const SQUAT = 9001;                 // a different repository that later gets the old name
const ADA = { email: 'ada@example.com', name: 'Ada', role: 'editor', days: 30, paths: [''] };
const BEA = { email: 'bea@example.com', name: 'Bea', role: 'member', days: 30 };
const OWNER = { Authorization: 'Bearer gho_owner' };

/**
 * GitHub, as far as these tests need it. `names` maps a lowercased owner/name
 * to the repository GitHub answers with (a renamed repository answers to its
 * old name with its current one, as GitHub's redirect does). The App is
 * installed on every repository in the table.
 */
function github(names, { push = true } = {}) {
  return async (url, init) => {
    const u = new URL(url);
    if (u.origin !== GH) return undefined;
    const inst = u.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/installation$/);
    if (inst) return names[inst[1].toLowerCase()] ? jsonRes({ id: 77 }) : undefined;
    if (/^\/app\/installations\/77\/access_tokens$/.test(u.pathname) && init.method === 'POST') return jsonRes({ token: 'ghs_installation' }, 201);
    const repo = u.pathname.match(/^\/repos\/([^/]+\/[^/]+)$/);
    if (repo && init.method === 'GET') {
      const hit = names[repo[1].toLowerCase()];
      return hit ? jsonRes({ id: hit.id, full_name: hit.full_name, permissions: { push } }) : undefined;
    }
    return undefined;
  };
}
/** A real RSA key, so the worker can sign its App token the way it does in production. */
const { privateKey } = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const PK8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', privateKey)).toString('base64');

function world(seed = {}, extra = {}) {
  const kv = fakeKV({ 'app:creds': { app_id: 1, slug: 'kiln-test', client_id: 'c', client_secret: 's', pk8: PK8 }, ...seed });
  return { env: { ALLOWED_ORIGINS: ORIGIN, KILN: kv, ...extra }, kv, json: (k) => (kv.map.has(k) ? JSON.parse(kv.map.get(k)) : null) };
}
async function ask(env, method, path, { body, headers = {} } = {}) {
  const init = { method, headers: { Origin: ORIGIN, ...headers } };
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
  const res = await worker.fetch(new Request(`https://worker.example${path}`, init), env);
  let json = null;
  try { json = await res.clone().json(); } catch { /* not JSON */ }
  return { status: res.status, json };
}
const people = (env, repo) => ask(env, 'GET', `/admin/people?repo=${repo}`, { headers: OWNER });
const renamed = { [OLD.toLowerCase()]: { id: ID, full_name: NEW }, [NEW.toLowerCase()]: { id: ID, full_name: NEW } };

// Everything below needs the worker to sign its App token and fetch an
// installation token from the stand-in GitHub: check that first.
test('KLR-08 harness: the worker can mint an installation token against the stand-in GitHub', async () => {
  const w = world();
  await withFetch(github(renamed), async () => {
    const r = await ask(w.env, 'GET', `/setup/install-check?repo=${OLD}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.installed, true, JSON.stringify(r.json));
  });
});

test('KLR-08 the worker puts a repository\'s id on record the first time it meets it: by the owner\'s request, or by its own token', async () => {
  // …when the owner asks for anything
  const a = world({ [`people:${OLD}`]: [ADA] });
  await withFetch(github({ [OLD.toLowerCase()]: { id: ID, full_name: OLD } }), async () => {
    assert.equal((await people(a.env, OLD)).status, 200);
  });
  assert.equal(a.json(`rname:${OLD}`).id, ID);
  assert.deepEqual({ id: a.json(`rid:${ID}`).id, name: a.json(`rid:${ID}`).name }, { id: ID, name: OLD });
  // …and when the worker fetches an App token for a site nobody owns the session of (an editor at work)
  const b = world();
  await withFetch(github({ [OLD.toLowerCase()]: { id: ID, full_name: OLD } }), async () => {
    await ask(b.env, 'GET', `/setup/install-check?repo=${OLD}`);
  });
  assert.equal(b.json(`rname:${OLD}`).id, ID);
  assert.equal(b.json(`rid:${ID}`).name, OLD);
});

test('KLR-08 a renamed or transferred repository whose site still has the old name keeps working, and the id is on record', async () => {
  const w = world({ [`people:${OLD}`]: [ADA, BEA] });
  await withFetch(github(renamed), async () => {
    const r = await people(w.env, OLD);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.people.map(p => p.email), [ADA.email, BEA.email]);
  });
  assert.equal(w.json(`rid:${ID}`).name, OLD, 'the list is filed under the name the site uses');
  assert.ok(w.kv.map.has(`people:${OLD}`));
});

test('KLR-08 when the config is corrected, the people list comes along: nobody has to be added again', async () => {
  const w = world({ [`people:${OLD}`]: [ADA, BEA] });
  await withFetch(github(renamed), async () => {
    await people(w.env, OLD);                    // life before: the id goes on record
    const r = await people(w.env, NEW);          // the owner opens People after correcting kiln-config.js
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.people.map(p => p.email), [ADA.email, BEA.email]);
  });
  assert.deepEqual(w.json(`people:${NEW}`).map(p => p.email), [ADA.email, BEA.email], 'filed under the new name');
  assert.equal(w.kv.map.has(`people:${OLD}`), false, 'and no longer under the old one');
  assert.equal(w.json(`rid:${ID}`).name, NEW);
  assert.equal(w.json(`rid:${ID}`).was, OLD);
  assert.equal(w.json(`rname:${NEW.toLowerCase()}`).id, ID);
  assert.equal(w.kv.map.has(`rsee:${OLD}`), false, 'what was last heard about the old name is dropped: it said the name was current');
  // The old name stays on record as this repository. That is what answers a
  // site that still uses it, and it holds nothing: a later holder of the name
  // starts clean (worker-repo-move.test.js).
  assert.equal(w.json(`rname:${OLD}`).id, ID);
});

test('KLR-08 the list also comes along when the first one to use the new name is not the owner: a Google sign-in has no GitHub token', async () => {
  const w = world({ [`people:${OLD}`]: [ADA], [`rid:${ID}`]: { id: ID, name: OLD }, [`rname:${OLD}`]: { id: ID },
    'gstate:n1': { origin: ORIGIN, returnTo: '/', repo: NEW } }, { GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsecret' });
  const gh = github(renamed);
  await withFetch(async (url, init) => {
    if (url === 'https://oauth2.googleapis.com/token') return jsonRes({ id_token: 'idt' });
    if (url.startsWith('https://oauth2.googleapis.com/tokeninfo')) return jsonRes({ aud: 'gid', email_verified: 'true', email: ADA.email, name: 'Ada' });
    return gh(url, init);
  }, async () => {
    const res = await worker.fetch(new Request('https://worker.example/google/callback?code=c&state=n1'), w.env);
    assert.equal(res.status, 302, 'Ada is on the list, so she is signed in');
    assert.match(res.headers.get('Location'), /#kiln-esession=[a-f0-9]{64}/);
  });
  assert.deepEqual(w.json(`people:${NEW}`).map(p => p.email), [ADA.email]);
});

test('KLR-08 a sign-in that still carries the old name is answered from where the list now is', async () => {
  // The list has moved to the new name; a member's sign-in record from before still says the old one.
  const w = world({ [`people:${NEW}`]: [BEA], [`rid:${ID}`]: { id: ID, name: NEW, was: OLD }, [`rname:${NEW.toLowerCase()}`]: { id: ID },
    [`msess:${'b'.repeat(32)}`]: { repo: OLD, email: BEA.email, origin: ORIGIN } });
  await withFetch(github(renamed), async () => {
    const r = await ask(w.env, 'POST', '/members/check', { body: { sid: 'b'.repeat(32), origin: ORIGIN } });
    assert.deepEqual(r.json, { ok: true });
  });
  assert.equal(w.kv.map.has(`people:${OLD}`), false, 'nothing is copied back under the old name');
  assert.equal(w.json(`rid:${ID}`).name, NEW);
});

test('KLR-08 a change made under the old name goes into the one list, not a second one', async () => {
  const w = world({ [`people:${NEW}`]: [ADA], [`rid:${ID}`]: { id: ID, name: NEW, was: OLD }, [`rname:${NEW.toLowerCase()}`]: { id: ID } });
  await withFetch(github(renamed), async () => {
    const r = await ask(w.env, 'POST', '/admin/people', { headers: OWNER, body: { repo: OLD, ...BEA } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const gone = await ask(w.env, 'POST', '/admin/people/remove', { headers: OWNER, body: { repo: OLD, email: ADA.email } });
    assert.equal(gone.status, 200);
  });
  assert.deepEqual(w.json(`people:${NEW}`).map(p => p.email), [BEA.email]);
  assert.equal(w.kv.map.has(`people:${OLD}`), false);
});

test('KLR-08 somebody else gets the old name while the list is still filed under it: they get nothing, and cannot change it', async () => {
  // The repository moved away; its site was never corrected. Its people are still under the old name.
  const w = world({ [`people:${OLD}`]: [ADA, BEA], [`rid:${ID}`]: { id: ID, name: OLD }, [`rname:${OLD}`]: { id: ID } });
  const taken = { [OLD.toLowerCase()]: { id: SQUAT, full_name: OLD } };   // the old name is now a different repository, which they can push to
  await withFetch(github(taken), async () => {
    const list = await people(w.env, OLD);
    assert.equal(list.status, 403);
    assert.equal(list.json.code, 'repo_changed');
    assert.match(list.json.error, /different repository than the one these people were added to/);
    assert.equal(list.json.people, undefined, 'no names, no addresses');
    const add = await ask(w.env, 'POST', '/admin/people', { headers: OWNER, body: { repo: OLD, email: 'mallory@example.com', role: 'member' } });
    assert.equal(add.status, 403);
    const remove = await ask(w.env, 'POST', '/admin/people/remove', { headers: OWNER, body: { repo: OLD, email: ADA.email } });
    assert.equal(remove.status, 403);
    // …and the other owner routes that read what is stored under a name.
    assert.equal((await ask(w.env, 'GET', `/admin/api-tokens?repo=${OLD}`, { headers: OWNER })).status, 403);
  });
  assert.deepEqual(w.json(`people:${OLD}`).map(p => p.email), [ADA.email, BEA.email], 'the list is as it was');
  assert.equal(w.json(`rname:${OLD}`).id, ID, 'and the name is still on record as the first repository');
});

test('KLR-08 once the real site has moved its list, the old name is simply free: its new holder starts with an empty list of their own', async () => {
  const w = world({ [`people:${NEW}`]: [ADA], [`rid:${ID}`]: { id: ID, name: NEW, was: OLD }, [`rname:${NEW.toLowerCase()}`]: { id: ID } });
  const world2 = { [OLD.toLowerCase()]: { id: SQUAT, full_name: OLD }, [NEW.toLowerCase()]: { id: ID, full_name: NEW } };
  await withFetch(github(world2), async () => {
    const r = await people(w.env, OLD);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.people, [], 'not the list of the repository that used to have the name');
    await ask(w.env, 'POST', '/admin/people', { headers: OWNER, body: { repo: OLD, email: 'theirs@example.com', role: 'editor' } });
  });
  assert.deepEqual(w.json(`people:${OLD}`).map(p => p.email), ['theirs@example.com']);
  assert.deepEqual(w.json(`people:${NEW}`).map(p => p.email), [ADA.email], 'the first site\'s list is untouched');
  assert.equal(w.json(`rname:${OLD}`).id, SQUAT);
});

test('KLR-08 a takeover is not followed on stale word: what was last heard about a name is dropped when the name changes hands', async () => {
  // Ten minutes ago the old name still redirected to the first repository, and the worker remembers that.
  const w = world({ [`people:${NEW}`]: [ADA], [`rid:${ID}`]: { id: ID, name: NEW, was: OLD }, [`rname:${NEW.toLowerCase()}`]: { id: ID },
    [`rsee:${OLD}`]: { id: ID, name: NEW } });
  await withFetch(github({ [OLD.toLowerCase()]: { id: SQUAT, full_name: OLD }, [NEW.toLowerCase()]: { id: ID, full_name: NEW } }), async () => {
    const r = await people(w.env, OLD);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.people, [], 'the remembered answer is not used to read the first repository\'s list');
  });
});

test('KLR-08 a name with nothing stored under it is not held: a repository deleted and made again just carries on', async () => {
  const w = world({ [`rid:${ID}`]: { id: ID, name: OLD }, [`rname:${OLD}`]: { id: ID } });
  await withFetch(github({ [OLD.toLowerCase()]: { id: SQUAT, full_name: OLD } }), async () => {
    const r = await people(w.env, OLD);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.people, []);
  });
  assert.equal(w.json(`rname:${OLD}`).id, SQUAT);
});

test('KLR-08 the member sign-in check compares repositories, not spellings: an origin registered under the new name accepts a site whose config has the old one', { skip: d1Skip }, async () => {
  const db = fakeD1();
  db.exec("INSERT INTO accounts (id, github_login, created_at) VALUES ('a1', 'owner', 1)");
  db.exec("INSERT INTO sites (id, account_id, repo, origin, plan, status, created_at) VALUES ('s1', 'a1', ?, ?, 'cloud', 'active', 1)", NEW, ORIGIN);
  const code = 'c'.repeat(32);
  const w = world({ [`gcode:${code}`]: { name: 'Bea', days: 30, repo: OLD, origin: ORIGIN, email: BEA.email } }, { kiln_cloud: db });
  await withFetch(github(renamed), async () => {
    const r = await ask(w.env, 'POST', '/google/claim', { body: { code, origin: ORIGIN } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.ok, true);
  });
  // A different repository under the other name is still refused.
  const w2 = world({ [`gcode:${code}`]: { name: 'Mal', days: 30, repo: OLD, origin: ORIGIN, email: 'mal@example.com' } }, { kiln_cloud: db });
  await withFetch(github({ [OLD.toLowerCase()]: { id: SQUAT, full_name: OLD }, [NEW.toLowerCase()]: { id: ID, full_name: NEW } }), async () => {
    const r = await ask(w2.env, 'POST', '/google/claim', { body: { code, origin: ORIGIN } });
    assert.equal(r.status, 403);
  });
});

test('KLR-08 Kiln Cloud: the site\'s registration follows the repository too', { skip: d1Skip }, async () => {
  const db = fakeD1();
  db.exec("INSERT INTO accounts (id, github_login, created_at) VALUES ('a1', 'owner', 1)");
  db.exec("INSERT INTO sites (id, account_id, repo, origin, plan, status, created_at) VALUES ('s1', 'a1', ?, ?, 'cloud', 'active', 1)", OLD, ORIGIN);
  const w = world({ [`people:${OLD}`]: [ADA], [`rid:${ID}`]: { id: ID, name: OLD }, [`rname:${OLD}`]: { id: ID } }, { kiln_cloud: db });
  await withFetch(github(renamed), async () => { await people(w.env, NEW); });
  assert.equal(db.row('SELECT repo FROM sites WHERE id = ?', 's1').repo, NEW);
});

test('KLR-08 /setup/install-check tells kiln doctor about a rename and about a name that changed hands, in two yes-or-no answers', async () => {
  const current = world();
  await withFetch(github({ [NEW.toLowerCase()]: { id: ID, full_name: NEW } }), async () => {
    assert.deepEqual((await ask(current.env, 'GET', `/setup/install-check?repo=${NEW}`)).json, { repo: NEW, installed: true, renamed: false, reused: false });
    // Only the spelling's case differs: that is the same name.
    assert.equal((await ask(current.env, 'GET', `/setup/install-check?repo=${NEW.toLowerCase()}`)).json.renamed, false);
  });
  const moved = world();
  await withFetch(github(renamed), async () => {
    const r = await ask(moved.env, 'GET', `/setup/install-check?repo=${OLD}`);
    assert.deepEqual(r.json, { repo: OLD, installed: true, renamed: true, reused: false });
    assert.doesNotMatch(JSON.stringify(r.json), /NewOrg/, 'the current name of a repository is not handed to whoever asks about an old one');
  });
  const taken = world({ [`people:${OLD}`]: [ADA], [`rid:${ID}`]: { id: ID, name: OLD }, [`rname:${OLD}`]: { id: ID } });
  await withFetch(github({ [OLD.toLowerCase()]: { id: SQUAT, full_name: OLD } }), async () => {
    assert.deepEqual((await ask(taken.env, 'GET', `/setup/install-check?repo=${OLD}`)).json, { repo: OLD, installed: true, renamed: false, reused: true });
  });
  const none = world();
  await withFetch(github({}), async () => {
    assert.deepEqual((await ask(none.env, 'GET', '/setup/install-check?repo=nobody/nothing')).json, { repo: 'nobody/nothing', installed: false });
  });
});

test('KLR-08 what an older editor or CLI sends still works: GitHub answering without an id changes nothing', async () => {
  const w = world({ [`people:${OLD}`]: [ADA] });
  await withFetch(async (url) => (url === `${GH}/repos/${OLD}` ? jsonRes({ permissions: { push: true } }) : undefined), async () => {
    const r = await people(w.env, OLD);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.people.map(p => p.email), [ADA.email]);
  });
  assert.equal([...w.kv.map.keys()].some(k => /^r(id|name|see):/.test(k)), false, 'nothing is put on record without an id');
});

test('KLR-08 GitHub or storage trouble while following never turns a sign-in into an error: the list is just empty', async () => {
  const w = world({ [`rid:${ID}`]: { id: ID, name: OLD }, [`people:${OLD}`]: [ADA] });
  await withFetch(async (url, init) => {
    if (url === `${GH}/repos/${NEW}` && (init.headers.Authorization || '').includes('gho_owner')) return jsonRes({ id: ID, full_name: NEW, permissions: { push: true } });
    throw new TypeError('fetch failed');   // every App call fails
  }, async () => {
    const r = await people(w.env, NEW);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.people, []);
  });
  assert.deepEqual(w.json(`people:${OLD}`).map(p => p.email), [ADA.email], 'and nothing was moved or lost');
});
