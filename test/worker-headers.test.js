/**
 * Every answer of the service tells browsers to come over HTTPS only and not to
 * guess a type, and a page of the service may not be shown inside another
 * site's frame. What each answer already said (its status, where a redirect
 * goes, its CORS headers, a policy of its own) is kept.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { fakeKV, withFetch, ORIGIN } from './worker-harness.js';

const env = () => ({ ALLOWED_ORIGINS: ORIGIN, KILN: fakeKV({ 'app:creds': { app_id: 1, slug: 'kiln-test', client_id: 'c', client_secret: 's', pk8: 'x' } }), CUSTOMER_MAIL_FROM: 'hello@kilncms.com', NOTIFY: { send: async () => ({}) } });
const get = (e, path, init = {}) => withFetch(async () => undefined, () => worker.fetch(new Request(`https://worker.example${path}`, init), e));

test('every answer carries HSTS and nosniff: JSON, a page, a redirect, a refusal, a preflight', async () => {
  const e = env();
  const answers = {
    json: await get(e, '/healthz'),
    page: await get(e, `/email/login?origin=${encodeURIComponent(ORIGIN)}&return_to=/&repo=acme/club`),
    redirect: await get(e, '/cloud/login'),
    refusal: await get(e, '/cloud/me'),
    preflight: await get(e, '/cloud/me', { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'GET' } }),
  };
  for (const [what, res] of Object.entries(answers)) {
    assert.equal(res.headers.get('Strict-Transport-Security'), 'max-age=31536000', what);
    assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff', what);
  }
  assert.equal(answers.refusal.status, 401);
  assert.equal(answers.redirect.status, 302);
  assert.match(answers.redirect.headers.get('Location'), /^https:\/\/github\.com\/login\/oauth\/authorize\?/, 'a redirect still goes where it went');
  assert.equal(answers.preflight.headers.get('Access-Control-Allow-Origin'), ORIGIN, 'CORS headers are kept');
});

test('a page of the service may not be framed; a JSON answer is left without frame rules', async () => {
  const e = env();
  const page = await get(e, `/email/login?origin=${encodeURIComponent(ORIGIN)}&return_to=/&repo=acme/club`);
  assert.match(page.headers.get('Content-Type'), /text\/html/);
  assert.equal(page.headers.get('X-Frame-Options'), 'DENY');
  assert.equal(page.headers.get('Content-Security-Policy'), "frame-ancestors 'none'");
  assert.equal(page.headers.get('Cache-Control'), 'no-store', 'what the page said of itself is kept');
  assert.ok((await page.text()).includes('<form'), 'and so is its body');
  const json = await get(e, '/healthz');
  assert.equal(json.headers.get('X-Frame-Options'), null);
});
