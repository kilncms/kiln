/**
 * Plain http is never answered: every request over it is sent to the same
 * address over https (301 for a read, 308 for anything that sends a body, so a
 * POST stays a POST), and every address the service hands out (a sign-in's
 * callback, an emailed link) is built from its fixed https address, never from
 * how a request arrived. A local development server keeps plain http.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { selfOrigin } from '../worker/cloud.js';
import { fakeKV, withFetch, ORIGIN } from './worker-harness.js';

const CREDS = { app_id: 1, slug: 'kiln-test', client_id: 'c', client_secret: 's', pk8: 'x' };
const env = (extra = {}) => ({ ALLOWED_ORIGINS: ORIGIN, KILN: fakeKV({ 'app:creds': CREDS }), GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsecret', ...extra });
const ask = (e, url, init = {}) => withFetch(async () => undefined, () => worker.fetch(new Request(url, { redirect: 'manual', ...init }), e));

test('a request over plain http is sent to the same address over https, and nothing is answered over http', async () => {
  const e = env();
  for (const [method, status] of [['GET', 301], ['HEAD', 301], ['POST', 308], ['PUT', 308], ['DELETE', 308], ['OPTIONS', 308]]) {
    const res = await ask(e, 'http://auth.example/cloud/login?next=1&a=b', { method, ...(method === 'POST' || method === 'PUT' ? { body: '{}' } : {}) });
    assert.equal(res.status, status, method);
    assert.equal(res.headers.get('Location'), 'https://auth.example/cloud/login?next=1&a=b', method);
    assert.equal(await res.text(), '', `${method}: no body over http`);
  }
  assert.equal((await ask(e, 'http://auth.example/healthz')).headers.get('Location'), 'https://auth.example/healthz');
  assert.equal(e.KILN.map.size, 1, 'nothing was started or stored for a request over http');
});

test('a local development server keeps plain http', async () => {
  for (const base of ['http://localhost:8787', 'http://127.0.0.1:8787']) {
    const res = await ask(env(), `${base}/healthz`);
    assert.equal(res.status, 200, base);
  }
});

test('the service\'s own address is fixed where it is set, and https otherwise, whatever the request says', () => {
  const at = (u) => new URL(u);
  assert.equal(selfOrigin(at('https://auth.example/x'), {}), 'https://auth.example');
  assert.equal(selfOrigin(at('http://auth.example/x'), {}), 'https://auth.example', 'never http');
  assert.equal(selfOrigin(at('https://kiln-auth.someone.workers.dev/x'), { HOSTING_SERVICE_URL: 'https://auth.example/' }), 'https://auth.example', 'the set address wins');
  assert.equal(selfOrigin(at('https://auth.example/x'), { HOSTING_SERVICE_URL: 'http://auth.example' }), 'https://auth.example', 'a plain http setting is not used');
  assert.equal(selfOrigin(at('http://localhost:8787/x'), {}), 'http://localhost:8787');
  assert.equal(selfOrigin(at('http://127.0.0.1:8787/x'), {}), 'http://127.0.0.1:8787');
});

test('every sign-in sends its callback to the fixed https address, whatever host the request came to', async () => {
  const e = env({ HOSTING_SERVICE_URL: 'https://auth.example' });
  const callbackOf = async (base, path) => new URL((await ask(e, `${base}${path}`)).headers.get('Location')).searchParams.get('redirect_uri');
  assert.equal(await callbackOf('https://auth.example', '/cloud/login'), 'https://auth.example/cloud/callback');
  assert.equal(await callbackOf('https://auth.example', '/cloud/login/google'), 'https://auth.example/google/callback');
  // The editor's sign-in at a site keeps nothing in the browser, so it may begin at any of the service's addresses.
  assert.equal(await callbackOf('https://kiln-auth.someone.workers.dev', `/auth/login?origin=${encodeURIComponent(ORIGIN)}&return_to=/`), 'https://auth.example/auth/callback');
});

test('a dashboard sign-in begun at another of the service\'s addresses starts again at the fixed one, so it can finish', async () => {
  // The cookie that ties a sign-in to its browser belongs to the host that set it, and the callback comes
  // back to the fixed address: begun elsewhere, the two would never meet.
  const e = env({ HOSTING_SERVICE_URL: 'https://auth.example' });
  const before = e.KILN.map.size;
  for (const path of ['/cloud/login', '/cloud/login/google', '/cloud/login?link=abc']) {
    const res = await ask(e, `https://kiln-auth.someone.workers.dev${path}`);
    assert.equal(res.status, 307, path);
    assert.equal(res.headers.get('Location'), `https://auth.example${path}`, path);
    assert.equal(res.headers.get('Set-Cookie'), null, `${path}: no cookie on the wrong host`);
  }
  assert.equal(e.KILN.map.size, before, 'and nothing is started there');
  // At the fixed address the sign-in starts, with its cookie and its callback on the one host.
  const start = await ask(e, 'https://auth.example/cloud/login');
  assert.equal(start.status, 302);
  assert.match(start.headers.get('Set-Cookie') || '', /__Host-/);
  assert.equal(new URL(start.headers.get('Location')).searchParams.get('redirect_uri'), 'https://auth.example/cloud/callback');
  // A service with no fixed address of its own (someone running Kiln themselves) starts where it is asked.
  const own = env();
  assert.equal((await ask(own, 'https://kiln.someone.example/cloud/login')).status, 302);
});
