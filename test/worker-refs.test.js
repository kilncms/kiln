/**
 * What an invited editor's session can do to a REF, driven through the
 * worker's real request handlers against an in-memory git repository
 * (commits, trees, blobs, branches) that plays GitHub.
 *
 * A ref decides what is live. The commit check on POST /git/commits only
 * covers commits made through the worker, so the ref write is where a commit
 * made anywhere else has to be caught.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REPO, editorEnv, withFetch, call, b64, jsonRes, githubWrites } from './worker-harness.js';

const GH = 'https://api.github.com';
const sha = (n) => String(n).padStart(40, '0').replace(/[^0-9a-f]/g, 'a');
const STAMP = { name: 'Sam (via Kiln)', email: 'kiln-editor@users.noreply.github.com' };
const OWNER = { name: 'Site Owner', email: 'owner@example.com' };
const PAGE = '<!doctype html><html><body><h1 data-cms="t">Hello</h1></body></html>';

/**
 * A tiny git repository. `files` is { path: text }; every commit names its
 * parents and its whole file set, like git does.
 */
function repo() {
  const blobs = new Map();     // sha → text
  const trees = new Map();     // sha → [{ path, mode, type, sha, size }]
  const commits = new Map();   // sha → { tree, parents, author }
  const branches = new Map();  // name → sha
  let n = 0;
  const blobOf = (text) => {
    for (const [k, v] of blobs) if (v === text) return k;
    const k = sha(`b${++n}`); blobs.set(k, text); return k;
  };
  const api = {
    blobs, trees, commits, branches, defaultBranch: 'main', fail: null,
    commit(files, parents = [], author = STAMP, mode = '100644') {
      const t = sha(`e${++n}`);
      trees.set(t, Object.entries(files).map(([path, text]) => ({ path, mode, type: 'blob', sha: blobOf(text), size: Buffer.byteLength(text) })));
      const c = sha(`c${++n}`);
      commits.set(c, { tree: t, parents, author });
      return c;
    },
    isAncestor(a, b) {         // is commit a reachable from commit b?
      const seen = new Set(); const todo = [b];
      while (todo.length) { const x = todo.pop(); if (x === a) return true; if (seen.has(x)) continue; seen.add(x); todo.push(...(commits.get(x)?.parents || [])); }
      return false;
    },
    handler: async (url, init) => {
      if (!url.startsWith(`${GH}/repos/${REPO}`)) return;
      const path = decodeURIComponent(url.slice(`${GH}/repos/${REPO}`.length).split('?')[0]);
      if (api.fail && api.fail(path, init)) return jsonRes({ message: 'boom' }, 500);
      if (init.method !== 'GET') return jsonRes({ ref: 'x', object: { sha: 'x' } }, init.method === 'POST' ? 201 : 200);
      if (path === '') return jsonRes({ default_branch: api.defaultBranch });
      let m;
      if ((m = /^\/git\/ref\/heads\/(.+)$/.exec(path))) return branches.has(m[1]) ? jsonRes({ object: { sha: branches.get(m[1]) } }) : undefined;
      if ((m = /^\/git\/commits\/(\w+)$/.exec(path))) {
        const c = commits.get(m[1]);
        return c ? jsonRes({ sha: m[1], tree: { sha: c.tree }, parents: c.parents.map(p => ({ sha: p })), author: c.author }) : undefined;
      }
      if ((m = /^\/git\/trees\/(\w+)$/.exec(path))) return trees.has(m[1]) ? jsonRes({ tree: trees.get(m[1]), truncated: false }) : undefined;
      if ((m = /^\/git\/blobs\/(\w+)$/.exec(path))) return blobs.has(m[1]) ? jsonRes({ content: b64(blobs.get(m[1])), encoding: 'base64' }) : undefined;
      if ((m = /^\/compare\/(\w+)\.\.\.(.+)$/.exec(path))) {
        const base = m[1]; const head = branches.get(m[2]);
        if (!commits.has(base) || !head) return;
        if (base === head) return jsonRes({ status: 'identical', ahead_by: 0, behind_by: 0 });
        if (api.isAncestor(base, head)) return jsonRes({ status: 'ahead', ahead_by: 1, behind_by: 0 });
        return jsonRes({ status: api.isAncestor(head, base) ? 'behind' : 'diverged', ahead_by: 0, behind_by: 1 });
      }
      if (path === '/branches') return jsonRes([...branches].map(([name, s]) => ({ name, commit: { sha: s } })));
    },
  };
  return api;
}

/** A site with one published page on main, and its head commit. */
function site() {
  const r = repo();
  const base = r.commit({ 'index.html': PAGE, 'blog/a.html': PAGE, 'assets/site.css': 'h1{color:red}' }, [], OWNER);
  r.branches.set('main', base);
  return { r, base, files: { 'index.html': PAGE, 'blog/a.html': PAGE, 'assets/site.css': 'h1{color:red}' } };
}

const move = (env, branch, body, enc = false) =>
  call(env, 'PATCH', `/gh/repos/${REPO}/git/refs/${enc ? encodeURIComponent('heads/' + branch) : 'heads/' + branch}`, { body });
const create = (env, body) => call(env, 'POST', `/gh/repos/${REPO}/git/refs`, { body });
const refWrites = (calls) => githubWrites(calls).filter(c => c.url.includes('/git/refs'));

// ─── S1 · moving a branch ────────────────────────────────────────────────────

test('S1 ref update: a commit made through the session, directly on the head, moves the branch', async () => {
  const { r, base, files } = site();
  const next = r.commit({ ...files, 'blog/a.html': PAGE.replace('Hello', 'Hi') }, [base]);
  await withFetch(r.handler, async (calls) => {
    // The editor sends the ref name percent-encoded; both spellings are judged alike.
    for (const enc of [true, false]) {
      const res = await move(editorEnv(), 'main', { sha: next }, enc);
      assert.equal(res.status, 200, JSON.stringify(res.json));
    }
    const writes = refWrites(calls);
    assert.equal(writes.length, 2);
    assert.deepEqual(writes[0].body, { sha: next }, 'only the judged field is forwarded');
  });
});

test('S1 ref update: a fast-forward to another branch\'s head is refused', async () => {
  const { r, base, files } = site();
  // An unreleased branch two commits ahead of main, made by the owner.
  const d1 = r.commit({ ...files, 'index.html': PAGE.replace('Hello', 'Redesign') }, [base], OWNER);
  const d2 = r.commit({ ...files, 'index.html': PAGE.replace('Hello', 'Redesign 2') }, [d1], OWNER);
  r.branches.set('redesign', d2);
  await withFetch(r.handler, async (calls) => {
    const res = await move(editorEnv(), 'main', { sha: d2 });
    assert.equal(res.status, 403);
    assert.equal(res.json.code, 'ref_not_direct');
    assert.equal(refWrites(calls).length, 0, 'GitHub never sees the ref write');
  });
});

test('S1 ref update: an editor\'s own commit stacked on another branch\'s head is refused (it would bring that branch along)', async () => {
  const { r, base, files } = site();
  const d1 = r.commit({ ...files, 'index.html': PAGE.replace('Hello', 'Redesign') }, [base], OWNER);
  r.branches.set('redesign', d1);
  // In scope and stamped, so POST /git/commits would have accepted it against d1.
  const mine = r.commit({ ...files, 'index.html': PAGE.replace('Hello', 'Redesign'), 'blog/a.html': PAGE.replace('Hello', 'Mine') }, [d1]);
  await withFetch(r.handler, async (calls) => {
    const res = await move(editorEnv(), 'main', { sha: mine });
    assert.equal(res.status, 403);
    assert.equal(res.json.code, 'ref_not_direct');
    assert.equal(refWrites(calls).length, 0);
  });
});

test('S1 ref update: a commit touching a path outside the editor\'s scope is refused', async () => {
  const { r, base, files } = site();
  const next = r.commit({ ...files, 'index.html': PAGE.replace('Hello', 'Defaced') }, [base]);
  await withFetch(r.handler, async (calls) => {
    const res = await move(editorEnv({ paths: ['blog/'] }), 'main', { sha: next });
    assert.equal(res.status, 403);
    assert.match(res.json.error, /outside your scope/);
    assert.equal(res.json.path, 'index.html');
    assert.equal(refWrites(calls).length, 0);
  });
});

test('S1 ref update: a commit the worker did not create is refused, even when its change is clean and in scope', async () => {
  const { r, base, files } = site();
  const foreign = r.commit({ ...files, 'blog/a.html': PAGE.replace('Hello', 'Hi') }, [base], { name: 'Someone', email: 'someone@example.com' });
  await withFetch(r.handler, async (calls) => {
    const res = await move(editorEnv(), 'main', { sha: foreign });
    assert.equal(res.status, 403);
    assert.equal(res.json.code, 'ref_foreign_commit');
    assert.equal(refWrites(calls).length, 0);
  });
});

test('S1 ref update: a commit made elsewhere with the editor stamp forged is still held to the content guard and the file-type gate', async () => {
  const { r, base, files } = site();
  const script = r.commit({ ...files, 'blog/a.html': PAGE.replace('</body>', '<script>alert(1)</script></body>') }, [base]);
  const svg = r.commit({ ...files, 'blog/x.svg': '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>' }, [base]);
  const workflow = r.commit({ ...files, '.github/workflows/x.yml': 'on: push' }, [base]);
  const link = r.commit({ ...files, 'blog/b.html': '../secret' }, [base], STAMP, '120000');
  await withFetch(r.handler, async (calls) => {
    const a = await move(editorEnv(), 'main', { sha: script });
    assert.equal(a.status, 403);
    assert.match(a.json.error, /scripts or executable markup/);
    const b = await move(editorEnv(), 'main', { sha: svg });
    assert.equal(b.status, 403);
    assert.equal(b.json.code, 'file_active');
    const c = await move(editorEnv(), 'main', { sha: workflow });
    assert.equal(c.status, 403);
    assert.match(c.json.error, /forbidden path/);
    const d = await move(editorEnv(), 'main', { sha: link });
    assert.equal(d.status, 403);
    assert.match(d.json.error, /regular files/);
    assert.equal(refWrites(calls).length, 0);
  });
});

test('S1 ref update: a merge commit, a commit that is not in the repository, and a rollback are refused', async () => {
  const { r, base, files } = site();
  const side = r.commit({ ...files, 'index.html': PAGE.replace('Hello', 'Side') }, [base], OWNER);
  const merge = r.commit({ ...files, 'index.html': PAGE.replace('Hello', 'Side') }, [base, side]);
  const next = r.commit({ ...files, 'blog/a.html': PAGE.replace('Hello', 'Hi') }, [base]);
  r.branches.set('main', next);
  await withFetch(r.handler, async (calls) => {
    r.branches.set('main', base);
    assert.equal((await move(editorEnv(), 'main', { sha: merge })).json.code, 'ref_not_direct');
    assert.equal((await move(editorEnv(), 'main', { sha: sha('missing') })).status, 403);
    r.branches.set('main', next);
    assert.equal((await move(editorEnv(), 'main', { sha: base })).json.code, 'ref_not_direct', 'moving back to the parent');
    assert.equal(refWrites(calls).length, 0);
  });
});

test('S1 ref update: force, tags, a missing branch and unreadable bodies are refused; the current head is a no-op', async () => {
  const { r, base, files } = site();
  const next = r.commit({ ...files, 'blog/a.html': PAGE.replace('Hello', 'Hi') }, [base]);
  await withFetch(r.handler, async (calls) => {
    const env = editorEnv();
    assert.equal((await move(env, 'main', { sha: next, force: true })).status, 403);
    assert.equal((await call(env, 'PATCH', `/gh/repos/${REPO}/git/refs/tags/v1`, { body: { sha: next } })).status, 403);
    assert.equal((await call(env, 'PATCH', `/gh/repos/${REPO}/git/refs`, { body: { sha: next } })).status, 403);
    assert.equal((await move(env, 'nope', { sha: next })).status, 404);
    assert.equal((await move(env, 'main', 'not json')).status, 400);
    assert.equal((await move(env, 'main', { sha: 'abc123' })).status, 400);
    assert.equal((await move(env, 'main', [next])).status, 400);
    assert.equal(refWrites(calls).length, 0);
    assert.equal((await move(env, 'main', { sha: base })).status, 200);
    assert.equal(refWrites(calls).length, 1);
  });
});

test('S1 ref update: fails closed when GitHub cannot be asked', async () => {
  const { r, base, files } = site();
  const next = r.commit({ ...files, 'blog/a.html': PAGE.replace('Hello', 'Hi') }, [base]);
  await withFetch(r.handler, async (calls) => {
    for (const broken of ['/git/ref/', '/git/commits/', '/git/trees/']) {
      r.fail = (path, init) => init.method === 'GET' && path.includes(broken);
      const res = await move(editorEnv(), 'main', { sha: next });
      assert.equal(res.status, 502, broken);
    }
    assert.equal(refWrites(calls).length, 0);
  });
});

test('S1 ref update: a suggest-mode session is held to the same check on its own scratch branch', async () => {
  const { r, base, files } = site();
  r.branches.set('kiln/suggest-sam', base);
  const d1 = r.commit({ ...files, 'index.html': PAGE.replace('Hello', 'Redesign') }, [base], OWNER);
  const d2 = r.commit({ ...files, 'index.html': PAGE.replace('Hello', 'Redesign 2') }, [d1], OWNER);
  const ok = r.commit({ ...files, 'blog/a.html': PAGE.replace('Hello', 'Hi') }, [base]);
  await withFetch(r.handler, async (calls) => {
    const env = editorEnv({ mode: 'suggest' });
    assert.equal((await move(env, 'kiln/suggest-sam', { sha: d2 })).json.code, 'ref_not_direct');
    assert.equal(refWrites(calls).length, 0);
    assert.equal((await move(env, 'kiln/suggest-sam', { sha: ok })).status, 200);
  });
});

// ─── S1 · creating a ref ─────────────────────────────────────────────────────

test('S1 new ref: drafts, suggestion previews and named versions start from a commit the default branch has', async () => {
  const { r, base, files } = site();
  const next = r.commit({ ...files, 'blog/a.html': PAGE.replace('Hello', 'Hi') }, [base]);
  r.branches.set('main', next);
  await withFetch(r.handler, async (calls) => {
    const env = editorEnv();
    assert.equal((await create(env, { ref: 'refs/heads/kiln-drafts', sha: next })).status, 201);
    assert.equal((await create(env, { ref: 'refs/heads/kiln/suggest-sam-1', sha: base })).status, 201, 'an older commit of main');
    assert.equal((await create(env, { ref: 'refs/tags/kiln/1700000000-launch', sha: base })).status, 201);
    const writes = refWrites(calls);
    assert.equal(writes.length, 3);
    assert.deepEqual(writes[0].body, { ref: 'refs/heads/kiln-drafts', sha: next });
  });
});

test('S1 new ref: a commit the default branch does not contain is refused', async () => {
  const { r, base, files } = site();
  const loose = r.commit({ ...files, 'index.html': PAGE.replace('Hello', 'From a fork') }, [base], OWNER);   // on no branch
  const unrelated = r.commit({ 'index.html': '<script>1</script>' }, [], OWNER);
  await withFetch(r.handler, async (calls) => {
    const env = editorEnv();
    for (const target of [loose, unrelated, sha('missing')]) {
      const res = await create(env, { ref: 'refs/heads/kiln-drafts', sha: target });
      assert.equal(res.status, 403);
      assert.equal(res.json.code, 'ref_not_ancestor');
    }
    assert.equal((await create(env, { ref: 'refs/tags/kiln/1-x', sha: loose })).status, 403);
    assert.equal(refWrites(calls).length, 0);
  });
});

test('S1 new ref: a site published from a branch other than the default starts drafts from that branch\'s head', async () => {
  const { r, base, files } = site();
  const live = r.commit({ ...files, 'blog/a.html': PAGE.replace('Hello', 'Live') }, [base], OWNER);
  r.branches.set('live', live);   // ahead of main, the default
  await withFetch(r.handler, async (calls) => {
    assert.equal((await create(editorEnv(), { ref: 'refs/heads/kiln-drafts', sha: live })).status, 201);
    assert.equal(refWrites(calls).length, 1);
  });
});

test('S1 new ref: only branches and tags, with a full sha; fails closed when GitHub cannot be asked', async () => {
  const { r, base } = site();
  await withFetch(r.handler, async (calls) => {
    const env = editorEnv();
    assert.equal((await create(env, { ref: 'refs/pull/1/head', sha: base })).status, 403);
    assert.equal((await create(env, { ref: 'refs/heads/', sha: base })).status, 403);
    assert.equal((await create(env, { sha: base })).status, 403);
    assert.equal((await create(env, { ref: 'refs/heads/kiln-drafts', sha: 'main' })).status, 400);
    assert.equal((await create(env, { ref: 'refs/heads/kiln-drafts', sha: base, force: true })).status, 403);
    r.fail = (path, init) => init.method === 'GET' && path === '';
    assert.equal((await create(env, { ref: 'refs/heads/kiln-drafts', sha: base })).status, 502);
    r.fail = (path, init) => init.method === 'GET' && path.startsWith('/compare/');
    assert.equal((await create(env, { ref: 'refs/heads/kiln-drafts', sha: base })).status, 502);
    assert.equal(refWrites(calls).length, 0);
  });
});
