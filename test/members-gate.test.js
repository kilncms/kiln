/**
 * KLN-06 — the members gate (templates/functions/members/_middleware.js), the
 * Cloudflare Pages Function in front of everything under /members/.
 *
 * What can be shown here, without a deployed site: whatever path the edge
 * hands this function, a request without a valid member cookie is redirected
 * and the file is never served; and every answer, gated file included, is
 * marked `private, no-store` with `Vary: Cookie`.
 *
 * What cannot be shown here: which paths Cloudflare Pages routes to this
 * function in the first place. That needs a deployed members site.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { onRequest } from '../templates/functions/members/_middleware.js';
import { signToken, verifyToken, getCookie } from '../templates/functions/_kiln.js';

const SECRET = 'a-per-site-secret-of-reasonable-length';
const ORIGIN = 'https://club.example';
const env = { KILN_MEMBER_SECRET: SECRET };
const member = (over = {}, secret = SECRET) => signToken({ n: 'Ada', exp: Date.now() + 3600e3, t: 'ms', ...over }, secret);
const cookieHeader = (token) => ({ Cookie: `theme=dark; kiln_member=${encodeURIComponent(token)}; other=1` });

/** Run the gate. `served` counts how often the protected file was produced. */
async function gate(pathname, { headers = {}, asset, method = 'GET', gateEnv = env } = {}) {
  let served = 0;
  const next = async () => { served++; return asset ? asset() : new Response('MEMBERS ONLY', { headers: { 'Content-Type': 'text/html' } }); };
  const res = await onRequest({ request: new Request(ORIGIN + pathname, { method, headers }), env: gateEnv, next });
  return { res, served };
}

// Every way of spelling a path under /members that a client might try.
const VARIANTS = [
  '/members', '/members/', '/members/index.html', '/members/files/report.pdf', '/members/a/b/c.html',
  '/members/%2e%2e/index.html', '/members/%2E%2E/secret.html', '/members/..%2fsecret.pdf', '/members/.%2e/x',
  '//members/x.pdf', '/members//x.pdf', '/members/./x.pdf', '/members/x.pdf/', '/MEMBERS/x.pdf', '/Members/',
  '/members%2Fx.pdf', '/%6dembers/x.pdf', '/members;v=1/x.pdf', '/members/x.pdf?download=1', '/members/x.pdf#frag',
  '/members/%00.pdf', '/members/caf%C3%A9.pdf', '/members/a%20b.pdf',
];

test('KLN-06 members gate: without a cookie, every path variant is redirected to sign-in and the file is never served', async () => {
  for (const p of VARIANTS) {
    const { res, served } = await gate(p);
    assert.equal(res.status, 302, p);
    assert.equal(served, 0, `nothing served for ${p}`);
    const loc = new URL(res.headers.get('Location'));
    assert.equal(loc.origin, ORIGIN, `stays on the site: ${p}`);
    assert.equal(loc.pathname, '/members-login.html', p);
    assert.equal(loc.searchParams.get('to'), new URL(ORIGIN + p).pathname, `returns to the path asked for: ${p}`);
    assert.equal(await res.text(), '', 'no body');
  }
});

test('KLN-06 members gate: the redirect is never cached and varies on the cookie', async () => {
  for (const p of ['/members/', '/members/files/report.pdf']) {
    const { res } = await gate(p);
    assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
    assert.equal(res.headers.get('Vary'), 'Cookie');
  }
});

test('KLN-06 members gate: a gated page or file is served private, no-store, Vary: Cookie', async () => {
  const headers = cookieHeader(await member());
  for (const p of ['/members/', '/members/index.html', '/members/files/report.pdf']) {
    const { res, served } = await gate(p, { headers, asset: () => new Response('%PDF-1.7 secret', { headers: { 'Content-Type': 'application/pdf', ETag: '"abc"' } }) });
    assert.equal(served, 1, p);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Cache-Control'), 'private, no-store', p);
    assert.equal(res.headers.get('Vary'), 'Cookie', p);
    assert.equal(res.headers.get('Content-Type'), 'application/pdf', 'the file keeps its own headers');
    assert.equal(res.headers.get('ETag'), '"abc"');
    assert.equal(await res.text(), '%PDF-1.7 secret', 'and its body');
  }
});

test('KLN-06 members gate: a cache-friendly header on the file itself is replaced, and Vary is added to, not overwritten', async () => {
  const headers = cookieHeader(await member());
  const cached = await gate('/members/files/report.pdf', { headers, asset: () => new Response('x', { headers: { 'Cache-Control': 'public, max-age=14400', Vary: 'Accept-Encoding' } }) });
  assert.equal(cached.res.headers.get('Cache-Control'), 'private, no-store');
  assert.deepEqual(cached.res.headers.get('Vary').split(',').map(s => s.trim()), ['Accept-Encoding', 'Cookie']);
  const already = await gate('/members/', { headers, asset: () => new Response('x', { headers: { Vary: 'accept-encoding, cookie' } }) });
  assert.equal(already.res.headers.get('Vary'), 'accept-encoding, cookie', 'not listed twice');
});

test('KLN-06 members gate: status codes pass through with the headers still set (304, 404, 206)', async () => {
  const headers = cookieHeader(await member());
  for (const [status, body] of [[304, null], [404, 'not found'], [206, 'part']]) {
    const { res } = await gate('/members/files/report.pdf', { headers, asset: () => new Response(body, { status }) });
    assert.equal(res.status, status);
    assert.equal(res.headers.get('Cache-Control'), 'private, no-store', `status ${status}`);
    assert.match(res.headers.get('Vary'), /Cookie/);
  }
});

test('KLN-06 members gate: a cookie that is forged, expired, the wrong kind or from another site does not open the gate', async () => {
  const good = await member();
  const [body, sig] = good.split('.');
  const flipped = sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A');
  const bad = {
    'tampered signature': `${body}.${flipped}`,
    'tampered payload': `${Buffer.from(JSON.stringify({ n: 'Eve', t: 'ms' })).toString('base64url')}.${sig}`,
    'expired': await member({ exp: Date.now() - 1000 }),
    'an invite token, not a session': await member({ t: 'mi' }),
    'no type at all': await signToken({ n: 'Ada', exp: Date.now() + 3600e3 }, SECRET),
    'signed with another site\'s secret': await member({}, 'a-different-sites-secret'),
    'no signature': body,
    'empty signature': `${body}.`,
    'garbage': 'not-a-token',
    'unsigned JSON': JSON.stringify({ n: 'Eve', t: 'ms' }),
  };
  for (const [what, token] of Object.entries(bad)) {
    for (const p of ['/members/', '/members/files/report.pdf', '//members/x.pdf', '/members/%2e%2e/index.html']) {
      const { res, served } = await gate(p, { headers: cookieHeader(token) });
      assert.equal(res.status, 302, `${what} @ ${p}`);
      assert.equal(served, 0, `${what} @ ${p}`);
      assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
    }
  }
});

test('KLN-06 members gate: a cookie value that does not even decode is treated as no cookie, not a crash', async () => {
  for (const raw of ['%E0%A4%A', '%', '%zz', '%C0%80']) {
    const { res, served } = await gate('/members/', { headers: { Cookie: `kiln_member=${raw}` } });
    assert.equal(res.status, 302, raw);
    assert.equal(served, 0, raw);
  }
  assert.equal(getCookie(new Request(ORIGIN, { headers: { Cookie: 'kiln_member=%E0%A4%A' } }), 'kiln_member'), null);
  assert.equal(getCookie(new Request(ORIGIN, { headers: { Cookie: 'a=1; kiln_member=x%20y' } }), 'kiln_member'), 'x y');
  assert.equal(getCookie(new Request(ORIGIN), 'kiln_member'), null);
});

test('KLN-06 members gate: a valid member is let in on every path variant, with or without an expiry', async () => {
  const forever = await signToken({ n: 'Ada', exp: null, t: 'ms' }, SECRET);   // "never expires" access
  for (const token of [await member(), forever]) {
    for (const p of VARIANTS) {
      const { res, served } = await gate(p, { headers: cookieHeader(token) });
      assert.equal(served, 1, p);
      assert.equal(res.status, 200, p);
      assert.equal(res.headers.get('Cache-Control'), 'private, no-store', p);
    }
  }
  assert.equal((await verifyToken(forever, SECRET)).n, 'Ada');
});

test('KLN-06 members gate: every method is gated, not just GET', async () => {
  for (const method of ['HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS']) {
    const { res, served } = await gate('/members/files/report.pdf', { method });
    assert.equal(res.status, 302, method);
    assert.equal(served, 0, method);
  }
});

test('KLN-06 members gate: an unconfigured site answers 503 and serves nothing, cookie or not', async () => {
  for (const headers of [{}, cookieHeader(await member())]) {
    const { res, served } = await gate('/members/', { headers, gateEnv: {} });
    assert.equal(res.status, 503);
    assert.equal(served, 0);
    assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
  }
});

test('KLN-06 members gate: the return path cannot send someone off the site after sign-in', () => {
  // The gate hands the login page the path that was asked for. The login page
  // only follows it if it is a plain same-site path — read its guard and try it.
  const html = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'members-login.html'), 'utf8');
  const m = /if \(!(\/.+\/)\.test\(to\)\) to = '\/members\/';/.exec(html);
  assert.ok(m, 'the login page still guards its return path');
  const sameSite = new RegExp(m[1].slice(1, -1));
  for (const to of ['/members/', '/members/files/report.pdf', '/members/a%20b.pdf']) assert.equal(sameSite.test(to), true, to);
  for (const to of ['//evil.example/x', '/\\evil.example/x', 'https://evil.example/', 'javascript:alert(1)', 'evil.example', '']) {
    assert.equal(sameSite.test(to), false, to);
  }
  // …including the one variant that reaches the gate looking like another host.
  assert.equal(sameSite.test(new URL(ORIGIN + '//members/x.pdf').pathname), false);
});
