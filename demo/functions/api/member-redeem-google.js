/**
 * POST /api/member-redeem-google  { code }
 * Exchanges a one-time code (minted by the kiln-auth worker after a verified
 * Google sign-in) for this site's member session cookie.
 */
import { signToken, json } from '../_kiln.js';

export async function onRequestPost({ request, env }) {
  if (!env.KILN_MEMBER_SECRET || !env.KILN_WORKER) {
    return json({ error: 'members area not configured (KILN_MEMBER_SECRET / KILN_WORKER)' }, 503);
  }
  const { code } = await request.json().catch(() => ({}));
  if (!code) return json({ error: 'missing code' }, 400);

  const res = await fetch(`${env.KILN_WORKER}/google/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  const data = await res.json();
  if (!res.ok || !data.ok) return json({ error: 'invalid or expired sign-in, try again' }, 403);

  const days = Math.min(Math.max(Number(data.days) || 30, 1), 360);
  const session = await signToken(
    { n: data.name, exp: Date.now() + days * 24 * 3600 * 1000, t: 'ms' },
    env.KILN_MEMBER_SECRET
  );
  return json({ ok: true, name: data.name, days }, 200, {
    'Set-Cookie': `kiln_member=${encodeURIComponent(session)}; Path=/; Max-Age=${days * 24 * 3600}; HttpOnly; Secure; SameSite=Lax`,
  });
}
