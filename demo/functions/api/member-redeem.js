/**
 * POST /api/member-redeem  { invite }
 * Verifies an invite token and sets the kiln_member session cookie (30 days).
 */
import { signToken, verifyToken, json } from '../_kiln.js';

export async function onRequestPost({ request, env }) {
  if (!env.KILN_MEMBER_SECRET) return json({ error: 'members area not configured' }, 503);

  const { invite } = await request.json().catch(() => ({}));
  const payload = await verifyToken(invite, env.KILN_MEMBER_SECRET);
  if (!payload || payload.t !== 'mi') return json({ error: 'invalid or expired invite' }, 403);

  const days = Math.min(Math.max(Number(payload.d) || 30, 1), 360);
  const session = await signToken(
    { n: payload.n, exp: Date.now() + days * 24 * 3600 * 1000, t: 'ms' },
    env.KILN_MEMBER_SECRET
  );
  return json({ ok: true, name: payload.n, days }, 200, {
    'Set-Cookie': `kiln_member=${encodeURIComponent(session)}; Path=/; Max-Age=${days * 24 * 3600}; HttpOnly; Secure; SameSite=Lax`,
  });
}
