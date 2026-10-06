/**
 * KLN-05 — comment threads respect an editor's path scope. An editor granted
 * only blog/ must not read, count, post to or resolve threads on other pages;
 * the owner still sees everything.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REPO, ORIGIN, editorEnv, fakeKV, withFetch, call, jsonRes } from './worker-harness.js';

const thread = (id, page, text, status = 'open') =>
  ({ id, page, status, anchor: null, created: Number.parseInt(id.slice(0, 4), 16), resolved: null, messages: [{ by: 'Owner', ts: 1, text }] });
const key = (page, id) => `cmt:${REPO}:${encodeURIComponent(page)}:${id}`;
const SEED = {
  [key('secret.html', 'aaaaaaaaaaaa')]: thread('aaaaaaaaaaaa', 'secret.html', 'the launch date is the 12th'),
  [key('pricing/index.html', 'bbbbbbbbbbbb')]: thread('bbbbbbbbbbbb', 'pricing/index.html', 'raise it to 19'),
  [key('blog/post.html', 'cccccccccccc')]: thread('cccccccccccc', 'blog/post.html', 'typo in the title'),
  [key('blog/old.html', 'dddddddddddd')]: thread('dddddddddddd', 'blog/old.html', 'done', 'resolved'),
  [key('blogroll.html', 'eeeeeeeeeeee')]: thread('eeeeeeeeeeee', 'blogroll.html', 'not the blog folder'),
};
const scoped = (session = {}) => editorEnv({ paths: ['blog'], features: ['comments'], ...session }, SEED);
const noGitHub = async () => undefined;
const list = (env, page, opts) => call(env, 'GET', `/comments?repo=${REPO}&path=${encodeURIComponent(page)}`, opts);

test('KLN-05 GET /comments: a blog/-scoped editor cannot read threads on a page outside the grant', async () => {
  await withFetch(noGitHub, async () => {
    for (const page of ['secret.html', 'pricing/index.html', 'blogroll.html', '/secret.html']) {
      const r = await list(scoped(), page);
      assert.equal(r.status, 403, page);
      assert.equal(r.json.error, 'outside your editing scope');
      assert.equal(JSON.stringify(r.json).includes('launch date'), false);
    }
    const ok = await list(scoped(), 'blog/post.html');
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json.threads.map(t => t.id), ['cccccccccccc']);
  });
});

test('KLN-05 GET /comments/counts: out-of-scope pages are left out, names and all', async () => {
  await withFetch(noGitHub, async () => {
    const r = await call(scoped(), 'GET', `/comments/counts?repo=${REPO}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.counts, { 'blog/post.html': 1 });
    assert.equal(r.json.total, 1);
    // A whole-site editor still gets every open thread.
    const all = await call(editorEnv({}, SEED), 'GET', `/comments/counts?repo=${REPO}`);
    assert.deepEqual(all.json.counts, { 'secret.html': 1, 'pricing/index.html': 1, 'blog/post.html': 1, 'blogroll.html': 1 });
    assert.equal(all.json.total, 4);
  });
});

test('KLN-05 POST /comments: no new thread and no reply on a page outside the grant', async () => {
  await withFetch(noGitHub, async () => {
    const env = scoped();
    const before = env.KILN.map.size;
    const fresh = await call(env, 'POST', '/comments', { body: { repo: REPO, path: 'secret.html', text: 'spam' } });
    assert.equal(fresh.status, 403);
    assert.equal(fresh.json.error, 'outside your editing scope');
    const reply = await call(env, 'POST', '/comments', { body: { repo: REPO, path: 'secret.html', thread: 'aaaaaaaaaaaa', text: 'me too' } });
    assert.equal(reply.status, 403);
    assert.equal(env.KILN.map.size, before, 'nothing was stored');
    assert.equal(JSON.parse(env.KILN.map.get(key('secret.html', 'aaaaaaaaaaaa'))).messages.length, 1, 'the thread is untouched');
    // In scope: both still work.
    const mine = await call(env, 'POST', '/comments', { body: { repo: REPO, path: 'blog/post.html', text: 'fixed' } });
    assert.equal(mine.status, 200);
    assert.equal(mine.json.thread.messages[0].by, 'Sam');
    assert.equal((await call(env, 'POST', '/comments', { body: { repo: REPO, path: 'blog/post.html', thread: 'cccccccccccc', text: 'on it' } })).status, 200);
  });
});

test('KLN-05 POST /comments/resolve: a thread outside the grant cannot be resolved or reopened', async () => {
  await withFetch(noGitHub, async () => {
    const env = scoped();
    const r = await call(env, 'POST', '/comments/resolve', { body: { repo: REPO, path: 'secret.html', thread: 'aaaaaaaaaaaa', resolved: true } });
    assert.equal(r.status, 403);
    assert.equal(JSON.parse(env.KILN.map.get(key('secret.html', 'aaaaaaaaaaaa'))).status, 'open');
    const ok = await call(env, 'POST', '/comments/resolve', { body: { repo: REPO, path: 'blog/post.html', thread: 'cccccccccccc', resolved: true } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.thread.status, 'resolved');
  });
});

test('KLN-05 comments: a comment-only reviewer is held to the same paths', async () => {
  await withFetch(noGitHub, async () => {
    const env = scoped({ mode: 'review' });
    assert.equal((await list(env, 'secret.html')).status, 403);
    assert.equal((await call(env, 'POST', '/comments', { body: { repo: REPO, path: 'secret.html', text: 'hi' } })).status, 403);
    assert.equal((await call(env, 'POST', '/comments', { body: { repo: REPO, path: 'blog/post.html', text: 'hi' } })).status, 200);
  });
});

test('KLN-05 comments: scope is by folder boundary, and several grants add up', async () => {
  await withFetch(noGitHub, async () => {
    const env = editorEnv({ paths: ['blog', 'pricing/index.html'], features: ['comments'] }, SEED);
    assert.equal((await list(env, 'pricing/index.html')).status, 200);
    assert.equal((await list(env, 'blog/old.html')).status, 200);
    assert.equal((await list(env, 'blogroll.html')).status, 403);     // "blog" is not a prefix of "blogroll.html"
    assert.equal((await list(env, 'pricing/other.html')).status, 403);
    const counts = await call(env, 'GET', `/comments/counts?repo=${REPO}`);
    assert.deepEqual(counts.json.counts, { 'pricing/index.html': 1, 'blog/post.html': 1 });
  });
});

test('KLN-05 comments: the owner still reads, counts and posts everywhere', async () => {
  const env = { ALLOWED_ORIGINS: ORIGIN, KILN: fakeKV(SEED) };
  const owner = { session: null, headers: { Authorization: 'Bearer owner-token' } };
  await withFetch(async (url) => url === `https://api.github.com/repos/${REPO}` ? jsonRes({ permissions: { push: true } }) : undefined, async () => {
    assert.equal((await list(env, 'secret.html', owner)).json.threads.length, 1);
    const counts = await call(env, 'GET', `/comments/counts?repo=${REPO}`, owner);
    assert.equal(counts.json.total, 4);
    assert.equal((await call(env, 'POST', '/comments', { ...owner, body: { repo: REPO, path: 'secret.html', text: 'noted' } })).status, 200);
  });
});
