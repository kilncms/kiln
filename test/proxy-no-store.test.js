/**
 * Nothing that came from GitHub through the service is kept by a browser.
 *
 * GitHub names the day a file last changed. An answer that carries that day
 * and no rule about keeping it is kept by a browser for a tenth of the file's
 * age: a page nobody had changed for a month was read from that copy for
 * three days, so after a publish the editor went on working from the file as
 * it was before. Every /gh/* answer now says "no-store", for an invited
 * editor and for an owner (test/owner-sessions.test.js holds the owner's).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { fakeKV, withFetch } from './worker-harness.js';
import { fakeGitHub } from './github-fake.js';

const REPO = 'acme/site';
const SESS = 'c'.repeat(64);
const PAGE = '<!doctype html>\n<html><body><h1 data-cms="title">A site</h1></body></html>\n';

function setup() {
  const gh = fakeGitHub({ repo: REPO, files: { 'index.html': PAGE } });
  const kv = fakeKV({
    'app:creds': { slug: 'kiln-cms', app_id: 1, client_id: 'cid' },
    [`itok:${REPO}`]: 'installation-token',
    [`esess:${SESS}`]: { repo: REPO, name: 'Sam', role: 'editor', email: 'sam@example.com', paths: [''], keys: [], features: null, mode: null, exp: null },
  });
  const ask = (path, init = {}) => worker.fetch(new Request(`https://worker.example${path}`, { ...init, headers: { 'X-Kiln-Session': SESS, 'Content-Type': 'application/json', ...(init.headers || {}) } }), { KILN: kv, ALLOWED_ORIGINS: '' });
  return { gh, ask };
}

test('a file an invited editor reads through the service is never kept by the browser', async () => {
  const s = setup();
  await withFetch(s.gh.handler, async () => {
    const res = await s.ask(`/gh/repos/${REPO}/contents/index.html?ref=main`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('last-modified'), null, 'and it carries no day a browser could reckon a keeping time from');
    assert.equal(res.headers.get('etag'), null);
    assert.match(Buffer.from((await res.json()).content, 'base64').toString(), /A site/);
  });
});

test('nor is the answer to a write, or to a read of something that is not there', async () => {
  const s = setup();
  await withFetch(s.gh.handler, async () => {
    const cur = await (await s.ask(`/gh/repos/${REPO}/contents/index.html?ref=main`)).json();
    const put = await s.ask(`/gh/repos/${REPO}/contents/index.html`, { method: 'PUT', body: JSON.stringify({ message: 'Edit index.html: title (via Kiln)', branch: 'main', sha: cur.sha, content: Buffer.from(PAGE.replace('A site', 'A better site')).toString('base64') }) });
    assert.equal(put.status, 200);
    assert.equal(put.headers.get('cache-control'), 'no-store');
    const missing = await s.ask(`/gh/repos/${REPO}/contents/nothing-here.html?ref=main`);
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get('cache-control'), 'no-store');
  });
});
