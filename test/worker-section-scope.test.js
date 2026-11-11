/**
 * An editor limited to some parts of a page, held to them by the worker on
 * every write path (worker/section-scope.js wired into worker/index.js):
 *
 *   PUT  /gh/…/contents/<page>         one file
 *   POST /gh/…/git/commits             pictures plus page in one commit
 *   POST /schedule, and the cron run that publishes it
 *   POST /source/duplicate
 *
 * Driven through the real handlers with an in-memory KV and a stand-in GitHub.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { applyEdits } from '../src/engine.js';
import { REPO, editorEnv, withFetch, call, b64, jsonRes, githubWrites, SAMPLES } from './worker-harness.js';

const PAGE = `<!doctype html><html><head><title>Bakery</title></head><body>
<h1 data-cms="hero_title">Fresh</h1>
<p data-cms="price">From $4</p>
<img data-cms="hero_img" data-cms-attr="src" src="/a.jpg" alt="Bread">
<script src="/assets/kiln.js" defer></script>
</body></html>`;
const LIMITED = { keys: ['hero_'] };
const edited = (edits) => applyEdits(PAGE, edits).html;

/** GitHub: the page's current blob is `cur`; every write is accepted. */
const github = async (url, init) => {
  if (init.method !== 'GET') return jsonRes({ content: {}, commit: { sha: 'c1' }, sha: 'new' }, 201);
  if (/\/git\/blobs\/cur$/.test(url)) return jsonRes({ content: b64(PAGE), encoding: 'base64' });
};
const put = (env, path, text, extra = {}) =>
  call(env, 'PUT', `/gh/repos/${REPO}/contents/${path}`, { body: { message: 'x', content: b64(text), branch: 'main', sha: 'cur', ...extra } });
const refusedHere = (r, part) => {
  assert.equal(r.status, 403, JSON.stringify(r.json));
  assert.equal(r.json.code, 'section_scope');
  assert.match(r.json.error, /Your access covers only some parts of this page/);
  if (part) assert.equal(r.json.part, part);
};

test('PUT: a section-limited editor’s change to their own part is saved', async () => {
  await withFetch(github, async (calls) => {
    const r = await put(editorEnv(LIMITED), 'index.html', edited([{ key: 'hero_title', html: 'Warm' }, { key: 'hero_img', attr: 'alt', value: 'Loaves' }]));
    assert.equal(r.status, 201);
    assert.equal(githubWrites(calls).length, 1);
  });
});

test('PUT: a change to a part outside the editor’s parts is refused and never reaches GitHub', async () => {
  await withFetch(github, async (calls) => {
    const r = await put(editorEnv(LIMITED), 'index.html', edited([{ key: 'hero_title', html: 'Warm' }, { key: 'price', html: 'Free' }]));
    refusedHere(r, 'price');
    assert.match(r.json.error, /“price”/);
    assert.equal(r.json.path, 'index.html');
    assert.equal(githubWrites(calls).length, 0);
  });
});

test('PUT: page settings, an attribute of a part outside, and a new page are refused', async () => {
  await withFetch(github, async (calls) => {
    const title = await put(editorEnv(LIMITED), 'index.html', PAGE.replace('<title>Bakery</title>', '<title>Cakes</title>'));
    refusedHere(title);
    assert.match(title.json.error, /page’s settings/);
    refusedHere(await put(editorEnv({ keys: ['price'] }), 'index.html', edited([{ key: 'hero_img', attr: 'src', value: '/b.jpg' }])), 'hero_img');
    const fresh = await put(editorEnv({ ...LIMITED, features: ['newpost'] }), 'new.html', PAGE, { sha: undefined });
    refusedHere(fresh);
    assert.match(fresh.json.error, /cannot add a new page/);
    assert.equal(githubWrites(calls).length, 0);
  });
});

test('PUT: a stylesheet is refused even with the Theme tool; an upload into the editor’s folder is not', async () => {
  await withFetch(github, async (calls) => {
    const css = await put(editorEnv({ ...LIMITED, features: ['theme'] }), 'assets/site.css', 'body{color:red}', { sha: undefined });
    refusedHere(css);
    assert.match(css.json.error, /theme/);
    assert.equal(githubWrites(calls).length, 0);
    const png = await call(editorEnv(LIMITED), 'PUT', `/gh/repos/${REPO}/contents/images/new.png`,
      { body: { message: 'x', content: Buffer.from(SAMPLES.png).toString('base64'), branch: 'main' } });
    assert.equal(png.status, 201);
  });
});

test('PUT: a page that is not UTF-8 is refused safely', async () => {
  const latin1 = Buffer.concat([Buffer.from(PAGE.replace('Fresh', 'Fr')), Buffer.from([0xe9])]);
  await withFetch(async (url, init) => {
    if (init.method !== 'GET') return jsonRes({ commit: { sha: 'c1' } }, 201);
    if (/\/git\/blobs\/cur$/.test(url)) return jsonRes({ content: latin1.toString('base64'), encoding: 'base64' });
  }, async (calls) => {
    const r = await put(editorEnv(LIMITED), 'index.html', PAGE);
    assert.equal(r.status, 403);
    assert.equal(r.json.code, 'section_scope');
    assert.match(r.json.error, /UTF-8/);
    assert.equal(githubWrites(calls).length, 0);
  });
});

test('PUT: no section limit, no new check (an editor with keys [] changes any part, as before)', async () => {
  await withFetch(github, async (calls) => {
    const r = await put(editorEnv({ keys: [] }), 'index.html', edited([{ key: 'price', html: 'Free' }]));
    assert.equal(r.status, 201);
    assert.equal(githubWrites(calls).length, 1);
  });
});

test('PUT: a draft on kiln-drafts is not held (it reaches the live page only as staged edits, checked then)', async () => {
  await withFetch(github, async () => {
    const r = await put(editorEnv(LIMITED), 'index.html', edited([{ key: 'price', html: 'Free' }]), { branch: 'kiln-drafts' });
    assert.equal(r.status, 201);
  });
});

// ─── git-data commits: pictures plus page ────────────────────────────────────

/** GitHub with a parent tree (index.html = PAGE) and a new tree of `files`. */
function treeGitHub(files) {
  const blobs = new Map([['pagecur', Buffer.from(PAGE)]]);
  const newTree = files.map((f, i) => {
    const sha = f.bytes === PAGE ? 'pagecur' : `b${i}`;
    if (!blobs.has(sha)) blobs.set(sha, Buffer.from(f.bytes));
    return { path: f.path, mode: '100644', type: 'blob', sha, size: blobs.get(sha).length };
  });
  const oldTree = [{ path: 'index.html', mode: '100644', type: 'blob', sha: 'pagecur', size: PAGE.length }];
  return async (url, init) => {
    if (init.method === 'POST' && url.endsWith('/git/commits')) return jsonRes({ sha: 'newcommit' }, 201);
    if (init.method !== 'GET') return jsonRes({ sha: 'x' }, 201);
    if (url.includes('/git/trees/newtree')) return jsonRes({ tree: newTree, truncated: false });
    if (url.includes('/git/trees/oldtree')) return jsonRes({ tree: oldTree, truncated: false });
    if (url.includes('/git/commits/parent')) return jsonRes({ tree: { sha: 'oldtree' } });
    const m = /\/git\/blobs\/(\w+)/.exec(url);
    if (m && blobs.has(m[1])) return jsonRes({ content: blobs.get(m[1]).toString('base64'), encoding: 'base64' });
  };
}
const commit = (env) => call(env, 'POST', `/gh/repos/${REPO}/git/commits`, { body: { message: 'Publish (via Kiln)', tree: 'newtree', parents: ['parent'] } });
const commitsMade = (calls) => calls.filter(c => c.method === 'POST' && c.url.endsWith('/git/commits'));

test('git-data commit: a picture plus the editor’s own part is committed; the page changed outside is refused', async () => {
  const png = Buffer.from(SAMPLES.png);
  await withFetch(treeGitHub([{ path: 'index.html', bytes: edited([{ key: 'hero_img', attr: 'src', value: '/images/new.png' }]) }, { path: 'images/new.png', bytes: png }]), async (calls) => {
    const r = await commit(editorEnv(LIMITED));
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(commitsMade(calls).length, 1);
  });
  await withFetch(treeGitHub([{ path: 'index.html', bytes: edited([{ key: 'hero_img', attr: 'src', value: '/images/new.png' }, { key: 'price', html: 'Free' }]) }, { path: 'images/new.png', bytes: png }]), async (calls) => {
    const r = await commit(editorEnv(LIMITED));
    refusedHere(r, 'price');
    assert.equal(r.json.path, 'index.html');
    assert.equal(commitsMade(calls).length, 0);
  });
  // A new page in the commit: refused.
  await withFetch(treeGitHub([{ path: 'index.html', bytes: PAGE }, { path: 'news/new.html', bytes: PAGE }]), async (calls) => {
    const r = await commit(editorEnv({ ...LIMITED, features: ['newpost'] }));
    refusedHere(r);
    assert.equal(r.json.path, 'news/new.html');
    assert.equal(commitsMade(calls).length, 0);
  });
  // The same commit from an editor with no section limit goes through, as before.
  await withFetch(treeGitHub([{ path: 'index.html', bytes: edited([{ key: 'price', html: 'Free' }]) }]), async (calls) => {
    assert.equal((await commit(editorEnv())).status, 201);
    assert.equal(commitsMade(calls).length, 1);
  });
});

// ─── Scheduled publishes ─────────────────────────────────────────────────────

test('POST /schedule: a scheduled edit to a part outside the editor’s parts is refused when it is made', async () => {
  const at = new Date(Date.now() + 3600e3).toISOString();
  const sched = (env, edits) => call(env, 'POST', '/schedule', { body: { repo: REPO, path: 'index.html', edits, at } });
  await withFetch(github, async () => {
    const env = editorEnv({ ...LIMITED, features: ['schedule'] });
    const r = await sched(env, [{ key: 'hero_title', html: 'Later' }, { key: 'price', html: 'Free' }]);
    refusedHere(r, 'price');
    assert.equal((await env.KILN.list({ prefix: 'sched:' })).keys.length, 0);
    assert.equal((await sched(env, [{ key: 'hero_title', html: 'Later' }])).status, 200);
    assert.equal((await env.KILN.list({ prefix: 'sched:' })).keys.length, 1);
  });
});

test('cron: a scheduled publish is held to the author’s parts as they are when it fires', async () => {
  const person = (keys) => [{ email: 'sam@example.com', name: 'Sam', role: 'editor', days: 30, paths: [''], features: ['schedule'], ...(keys ? { keys } : {}) }];
  const entry = (edits) => ({ repo: REPO, path: 'index.html', branch: 'main', edits, message: 'm', at: Date.now() - 1000, by: 'Sam', byEmail: 'sam@example.com', admin: false });
  const gh = async (url, init) => {
    if (init.method === 'PUT') return jsonRes({ commit: { sha: 'c1' } }, 201);
    if (url.includes('/contents/')) return jsonRes({ sha: 'cur', content: b64(PAGE) });
  };
  for (const [why, keys, edits, writes] of [
    ['own part', ['hero_'], [{ key: 'hero_title', html: 'Later' }], 1],
    ['made before the limit narrowed', ['hero_img'], [{ key: 'hero_title', html: 'Later' }], 0],
    ['a part outside', ['hero_'], [{ key: 'price', html: 'Free' }], 0],
    ['no limit', null, [{ key: 'price', html: 'Free' }], 1],
  ]) {
    const env = editorEnv({}, { [`people:${REPO}`]: person(keys), 'sched:one': entry(edits) });
    await withFetch(gh, async (calls) => {
      await worker.scheduled({}, env);
      assert.equal(githubWrites(calls).length, writes, why);
      assert.equal((await env.KILN.list({ prefix: 'sched:' })).keys.length, 0, `${why}: the schedule is gone (published or dropped)`);
    });
  }
});

test('POST /source/duplicate: a section-limited editor cannot copy a page', async () => {
  await withFetch(github, async (calls) => {
    const r = await call(editorEnv(LIMITED), 'POST', '/source/duplicate', { body: { repo: REPO, file: 'index.html' } });
    refusedHere(r);
    assert.match(r.json.error, /copy/);
    assert.equal(githubWrites(calls).length, 0);
  });
});
