/**
 * Tool grants (People & access → which tools an editor may use) are held by
 * the worker, not only by which buttons the editor shows. Driven through the
 * real request handlers; GitHub is played by test/worker-harness.js.
 *
 * A session with `features: null` has the default set (page settings,
 * history, drafts), exactly as the editor bundle treats it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REPO, editorEnv, withFetch, call, b64, jsonRes, githubWrites } from './worker-harness.js';

const GH = 'https://api.github.com';
const PAGE = '<!doctype html><html><body><h1 data-cms="t">Hello</h1></body></html>';
const h = (n) => String(n).padStart(40, '0');

const accept = async (url, init) => {
  if (init.method !== 'GET') return jsonRes({ content: {}, commit: { sha: 'c1' }, sha: 'new' }, 201);
  if (/\/git\/blobs\//.test(url)) return jsonRes({ content: b64(PAGE), encoding: 'base64' });
};
const put = (env, path, text, extra = {}) =>
  call(env, 'PUT', `/gh/repos/${REPO}/contents/${path}`, { body: { message: 'x', content: b64(text), branch: 'main', ...extra } });
const refused = (r, grant) => {
  assert.equal(r.status, 403, JSON.stringify(r.json));
  assert.equal(r.json.code, 'grant_required');
  assert.equal(r.json.grant, grant);
};

/** GitHub with one commit on main and one proposed commit on top of it. */
function twoCommits(before, after) {
  const entries = (files) => Object.entries(files).map(([path, text], i) => ({ path, mode: '100644', type: 'blob', sha: h(`${text.length}${i}`), size: text.length }));
  const stamp = { name: 'Sam (via Kiln)', email: 'kiln-editor@users.noreply.github.com' };
  return async (url, init) => {
    if (init.method !== 'GET') return jsonRes({ sha: h(9) }, 201);
    if (/\/git\/ref\/heads\//.test(url)) return jsonRes({ object: { sha: h(1) } });
    if (url.endsWith(`/git/commits/${h(1)}`)) return jsonRes({ sha: h(1), tree: { sha: 'oldtree' }, parents: [] });
    if (url.endsWith(`/git/commits/${h(2)}`)) return jsonRes({ sha: h(2), tree: { sha: 'newtree' }, parents: [{ sha: h(1) }], author: stamp });
    if (url.includes('/git/trees/oldtree')) return jsonRes({ tree: entries(before), truncated: false });
    if (url.includes('/git/trees/newtree')) return jsonRes({ tree: entries(after), truncated: false });
    if (/\/git\/blobs\//.test(url)) return jsonRes({ content: b64(PAGE), encoding: 'base64' });
    if (url === `${GH}/repos/${REPO}`) return jsonRes({ default_branch: 'main' });
    if (url.includes('/compare/')) return jsonRes({ status: 'identical', ahead_by: 0, behind_by: 0 });
  };
}
const postCommit = (env) => call(env, 'POST', `/gh/repos/${REPO}/git/commits`, { body: { message: 'x', tree: 'newtree', parents: [h(1)] } });
const moveMain = (env, branch = 'main') => call(env, 'PATCH', `/gh/repos/${REPO}/git/refs/heads/${branch}`, { body: { sha: h(2) } });

// ─── Theme: stylesheets ──────────────────────────────────────────────────────

test('S3 theme: without the Theme grant a stylesheet cannot be written, by any route', async () => {
  const css = { 'index.html': PAGE, 'assets/site.css': 'h1{color:red}' };
  await withFetch(twoCommits(css, { ...css, 'assets/site.css': 'h1{color:blue}!' }), async (calls) => {
    for (const features of [null, [], ['pagesettings', 'history', 'draft', 'newpost']]) {
      const env = editorEnv({ features });
      refused(await put(env, 'assets/site.css', 'h1{color:blue}', { sha: 'x' }), 'theme');
      refused(await put(env, 'assets/new.css', 'h1{color:blue}'), 'theme');
      refused(await call(env, 'POST', `/gh/repos/${REPO}/git/trees`, { body: { base_tree: 'oldtree', tree: [{ path: 'assets/site.css', mode: '100644', type: 'blob', content: 'x{}' }] } }), 'theme');
      refused(await postCommit(env), 'theme');
      refused(await moveMain(env), 'theme');
    }
    assert.equal(githubWrites(calls).length, 0, 'nothing reaches GitHub');
  });
});

test('S3 theme: with the grant the same writes go through', async () => {
  const css = { 'index.html': PAGE, 'assets/site.css': 'h1{color:red}' };
  await withFetch(twoCommits(css, { ...css, 'assets/site.css': 'h1{color:blue}!' }), async () => {
    const env = editorEnv({ features: ['theme'] });
    assert.equal((await put(env, 'assets/site.css', 'h1{color:blue}', { sha: 'x' })).status, 201);
    assert.equal((await postCommit(env)).status, 201);
    assert.equal((await moveMain(env)).status, 201);
  });
});

// ─── New post / page ─────────────────────────────────────────────────────────

test('S3 new page: without the grant a page that does not exist yet cannot be added to a published branch', async () => {
  await withFetch(twoCommits({ 'index.html': PAGE }, { 'index.html': PAGE, 'blog/new.html': PAGE + ' ' }), async (calls) => {
    const env = editorEnv();
    refused(await put(env, 'blog/new.html', PAGE), 'newpost');                       // no sha = create
    refused(await put(env, 'blog/new.html', PAGE, { branch: undefined }), 'newpost'); // no branch = the default branch
    refused(await put(env, 'blog/new.html', PAGE, { branch: 'staging' }), 'newpost');
    // The commit itself is inert; it is refused where it would go live.
    assert.equal((await postCommit(env)).status, 201);
    refused(await moveMain(env), 'newpost');
    assert.equal(githubWrites(calls).filter(c => !c.url.endsWith('/git/commits')).length, 0);
  });
});

test('S3 new page: editing an existing page, uploading a picture and working on a scratch branch need no such grant', async () => {
  await withFetch(twoCommits({ 'index.html': PAGE }, { 'index.html': PAGE + ' ', 'assets/uploads/a.png': 'x' }), async () => {
    const env = editorEnv();
    assert.equal((await put(env, 'index.html', PAGE, { sha: 'x' })).status, 201);
    // A stale drafts branch may not have the page yet: saving a draft creates it there.
    assert.equal((await put(env, 'blog/new.html', PAGE, { branch: 'kiln-drafts' })).status, 201);
    assert.equal((await put(editorEnv({ mode: 'suggest' }), 'blog/new.html', PAGE, { branch: 'kiln/suggest-sam-1' })).status, 201);
  });
  await withFetch(twoCommits({ 'index.html': PAGE }, { 'index.html': PAGE, 'blog/new.html': PAGE + ' ' }), async () => {
    assert.equal((await moveMain(editorEnv({ features: ['newpost'] }))).status, 201);
    assert.equal((await moveMain(editorEnv({ mode: 'suggest', features: [] }), 'kiln/suggest-sam-1')).status, 201);
  });
});

// ─── Drafts ──────────────────────────────────────────────────────────────────

test('S3 drafts: without the Drafts grant nothing is written to kiln-drafts and the branch cannot be created', async () => {
  await withFetch(twoCommits({ 'index.html': PAGE }, { 'index.html': PAGE + ' ' }), async (calls) => {
    const env = editorEnv({ features: ['theme'] });
    refused(await put(env, 'index.html', PAGE, { sha: 'x', branch: 'kiln-drafts' }), 'draft');
    refused(await call(env, 'POST', `/gh/repos/${REPO}/git/refs`, { body: { ref: 'refs/heads/kiln-drafts', sha: h(1) } }), 'draft');
    refused(await moveMain(env, 'kiln-drafts'), 'draft');
    assert.equal(githubWrites(calls).length, 0);
    // The default set includes drafts.
    const dflt = editorEnv();
    assert.equal((await put(dflt, 'index.html', PAGE, { sha: 'x', branch: 'kiln-drafts' })).status, 201);
    assert.equal((await call(dflt, 'POST', `/gh/repos/${REPO}/git/refs`, { body: { ref: 'refs/heads/kiln-drafts', sha: h(1) } })).status, 201);
  });
});

// ─── Schedule and comments ───────────────────────────────────────────────────

test('S3 schedule: POST /schedule takes the Schedule grant', async () => {
  const at = new Date(Date.now() + 3600e3).toISOString();
  const sched = (env) => call(env, 'POST', '/schedule', { body: { repo: REPO, path: 'index.html', edits: [{ key: 't', html: 'Hi' }], at } });
  await withFetch(accept, async () => {
    const without = editorEnv();
    refused(await sched(without), 'schedule');
    assert.equal((await without.KILN.list({ prefix: 'sched:' })).keys.length, 0);
    const withGrant = editorEnv({ features: ['schedule'] });
    assert.equal((await sched(withGrant)).status, 200);
    assert.equal((await withGrant.KILN.list({ prefix: 'sched:' })).keys.length, 1);
  });
});

test('S3 comments: writing a comment takes the Comments grant; a review seat is comment-only and keeps it', async () => {
  const post = (env) => call(env, 'POST', '/comments', { body: { repo: REPO, path: '/index.html', text: 'Typo here' } });
  await withFetch(accept, async () => {
    const without = editorEnv();
    refused(await post(without), 'comments');
    assert.equal((await without.KILN.list({ prefix: 'cmt:' })).keys.length, 0);
    const granted = await post(editorEnv({ features: ['comments'] }));
    assert.equal(granted.status, 200, JSON.stringify(granted.json));
    const review = await post(editorEnv({ mode: 'review', features: null }));
    assert.equal(review.status, 200, JSON.stringify(review.json));
    const thread = granted.json.thread?.id || granted.json.id;
    refused(await call(without, 'POST', '/comments/resolve', { body: { repo: REPO, path: '/index.html', thread: thread || 'a'.repeat(12), resolved: true } }), 'comments');
  });
});
