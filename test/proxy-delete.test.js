/**
 * "Delete draft" from a signed-in owner's browser.
 *
 * The editor asks the service to delete the page's file on the drafts branch
 * (DELETE /gh/repos/<repo>/contents/<path>). The service runs on another
 * address than the site, so the browser first asks it which methods it may
 * send. The answer left DELETE out, the browser never sent the request, and
 * the editor could only say "the site could not be reached" on a perfectly
 * good connection. A draft could not be deleted, and neither could a page.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { fakeKV, withFetch, jsonRes, call, editorEnv, ORIGIN, REPO } from './worker-harness.js';

const ID = 'b'.repeat(64);
const RID = 42;
const ownerEnv = () => ({
  ALLOWED_ORIGINS: ORIGIN,
  KILN: fakeKV({
    'app:creds': { app_id: 1, slug: 'kiln-cms', client_id: 'cid', client_secret: 'sec' },
    [`rsee:${REPO}`]: { id: RID, name: REPO },
    [`itok:${REPO}`]: 'installation-token',
    [`osess:${ID}`]: { v: 1, token: 'ghu_live', token_exp: Date.now() + 8 * 3600e3, refresh_token: 'ghr_live',
      login: 'rosa', uid: 7, repo: REPO, rid: RID, origin: ORIGIN, created: Date.now() },
  }),
});
const DRAFT = `/gh/repos/${REPO}/contents/about.html`;
const BODY = { message: 'Discard draft: about.html (via Kiln)', sha: 'abc123', branch: 'kiln-drafts' };

test('the browser is told it may send DELETE to the service', async () => {
  const res = await worker.fetch(new Request(`https://worker.example${DRAFT}`, {
    method: 'OPTIONS',
    headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'DELETE', 'Access-Control-Request-Headers': 'content-type,x-kiln-session' },
  }), ownerEnv());
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.ok(res.headers.get('Access-Control-Allow-Methods').split(/,\s*/).includes('DELETE'));
});

test('an owner deleting a draft: the request goes to GitHub in the owner\'s name, and the answer can be read by the page', async () => {
  const sent = [];
  await withFetch(async (url, init = {}) => {
    sent.push({ url: String(url), method: init.method || 'GET', auth: init.headers?.Authorization, body: init.body });
    if ((init.method || 'GET') === 'DELETE') return jsonRes({ commit: { sha: 'c0ffee' } });
    return jsonRes({ id: RID, full_name: REPO, permissions: { push: true } });
  }, async () => {
    const r = await call(ownerEnv(), 'DELETE', DRAFT, { body: BODY, session: ID });
    assert.equal(r.status, 200);
    assert.equal(r.json.commit.sha, 'c0ffee');
    assert.ok(r.res.headers.get('Access-Control-Allow-Methods').includes('DELETE'));
  });
  const del = sent.filter(s => s.method === 'DELETE');
  assert.equal(del.length, 1);
  assert.equal(del[0].url, `https://api.github.com/repos/${REPO}/contents/about.html`);
  assert.equal(del[0].auth, 'Bearer ghu_live');
  assert.equal(JSON.parse(del[0].body).branch, 'kiln-drafts');
});

test('an invited editor still cannot delete a file: being allowed to ask is not being allowed to do', async () => {
  const sent = [];
  await withFetch(async (url, init = {}) => { sent.push(init.method || 'GET'); return jsonRes({}); }, async () => {
    const r = await call(editorEnv(), 'DELETE', DRAFT, { body: { ...BODY, branch: 'main' } });
    assert.ok(r.status >= 400, `refused (${r.status})`);
  });
  assert.ok(!sent.includes('DELETE'), 'nothing was deleted on GitHub');
});
