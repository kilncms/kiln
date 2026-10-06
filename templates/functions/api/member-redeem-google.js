/**
 * POST /api/member-redeem-google  { code }
 * Exchanges a one-time code (minted by the kiln-auth worker after a verified
 * Google sign-in) for this site's member session cookie.
 */
import { signToken, json } from '../_kiln.js';
import { checkedCookie } from '../members/_middleware.js';

export async function onRequestPost({ request, env }) {
  if (!env.KILN_MEMBER_SECRET || !env.KILN_WORKER) {
    return json({ error: 'members area not configured (KILN_MEMBER_SECRET / KILN_WORKER)' }, 503);
  }
  const { code } = await request.json().catch(() => ({}));
  if (!code) return json({ error: 'missing code' }, 400);

  // Send our own origin so the worker can enforce that this code was minted for
  // THIS site (cross-tenant member bypass guard).
  const res = await fetch(`${env.KILN_WORKER}/google/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // `session` asks for an id the gate can re-check, so that removing a
    // member from the list ends this sign-in.
    body: JSON.stringify({ code, origin: new URL(request.url).origin, session: true }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) return json({ error: 'invalid or expired sign-in, try again' }, 403);
  // A worker from before member sign-ins could be ended sends no id, and the
  // gate would turn the cookie away. Say what to do instead of looping.
  if (!/^[a-f0-9]{32}$/.test(data.sid || '')) {
    return json({ error: 'this site\'s Kiln worker is older than its members gate: update the worker, then sign in again' }, 503);
  }

  const days = Number(data.days) === 0 ? 0 : Math.min(Math.max(Number(data.days) || 30, 1), 360);
  const maxAge = days ? days * 24 * 3600 : 10 * 365 * 24 * 3600;  // days:0 = never expires; keep the cookie ~10y
  const session = await signToken(
    { n: data.name, exp: days ? Date.now() + days * 24 * 3600 * 1000 : null, t: 'ms', s: data.sid },
    env.KILN_MEMBER_SECRET
  );
  // The worker has just vouched for this member, so the first re-check is due
  // in a few minutes, not on the very next request.
  const headers = new Headers({ 'Content-Type': 'application/json' });
  headers.append('Set-Cookie', `kiln_member=${encodeURIComponent(session)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`);
  headers.append('Set-Cookie', await checkedCookie(data.sid, env.KILN_MEMBER_SECRET));
  return new Response(JSON.stringify({ ok: true, name: data.name, days }), { status: 200, headers });
}
