/**
 * Gate for everything under /members/ — pages, PDFs, any static asset.
 * Runs at the edge before the static file is served. No cookie (or a bad
 * one) → redirect to the login page with a return path.
 */
import { verifyToken, getCookie } from '../_kiln.js';

export async function onRequest({ request, env, next }) {
  if (!env.KILN_MEMBER_SECRET) {
    return new Response('Members area not configured yet.', { status: 503 });
  }
  const cookie = getCookie(request, 'kiln_member');
  const payload = cookie ? await verifyToken(cookie, env.KILN_MEMBER_SECRET) : null;
  if (!payload || payload.t !== 'ms') {
    const to = new URL(request.url).pathname;
    return Response.redirect(
      `${new URL(request.url).origin}/members-login.html?to=${encodeURIComponent(to)}`, 302);
  }
  return next();
}
