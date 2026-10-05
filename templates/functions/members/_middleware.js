/**
 * Gate for everything under /members/ — pages, PDFs, any static asset.
 * Runs at the edge before the static file is served. No cookie (or a bad
 * one) → redirect to the login page with a return path.
 *
 * Every answer from here is marked private and uncacheable. A gated page or
 * file must never be kept by a shared cache, or by the browser to be shown
 * again after sign-out, and what is served depends on the cookie.
 */
import { verifyToken, getCookie } from '../_kiln.js';

const NO_STORE = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };

export async function onRequest({ request, env, next }) {
  if (!env.KILN_MEMBER_SECRET) {
    return new Response('Members area not configured yet.', { status: 503, headers: NO_STORE });
  }
  const cookie = getCookie(request, 'kiln_member');
  const payload = cookie ? await verifyToken(cookie, env.KILN_MEMBER_SECRET) : null;
  if (!payload || payload.t !== 'ms') {
    const url = new URL(request.url);
    return new Response(null, {
      status: 302,
      headers: { Location: `${url.origin}/members-login.html?to=${encodeURIComponent(url.pathname)}`, ...NO_STORE },
    });
  }
  const res = await next();
  // Whatever the file itself said about caching, a gated one is never stored.
  const headers = new Headers(res.headers);
  headers.set('Cache-Control', NO_STORE['Cache-Control']);
  if (!/(^|,)\s*cookie\s*(,|$)/i.test(headers.get('Vary') || '')) headers.append('Vary', 'Cookie');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
