/**
 * POST /api/member-invite  { name }
 * Authorization: Bearer <GitHub token of someone with push access to KILN_REPO>
 *
 * Mints a member invite link token (30 days to redeem). Only people who can
 * already push to the site's repo — i.e. its admins — can mint invites.
 */
import { signToken, json } from '../_kiln.js';

export async function onRequestPost({ request, env }) {
  if (!env.KILN_MEMBER_SECRET || !env.KILN_REPO) {
    return json({ error: 'members area not configured (KILN_MEMBER_SECRET / KILN_REPO)' }, 503);
  }
  const auth = (request.headers.get('Authorization') || '').replace(/^(token|Bearer)\s+/i, '');
  if (!auth) return json({ error: 'missing Authorization' }, 401);

  const { name, days } = await request.json().catch(() => ({}));
  if (!name || String(name).length > 64) return json({ error: 'bad name' }, 400);
  const accessDays = Math.min(Math.max(Number(days) || 30, 1), 360);

  const res = await fetch(`https://api.github.com/repos/${env.KILN_REPO}`, {
    headers: {
      Authorization: `Bearer ${auth}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'kiln-members',
    },
  });
  if (!res.ok) return json({ error: 'github check failed', status: res.status }, 403);
  const repo = await res.json();
  if (!repo.permissions?.push) return json({ error: 'you need push access to invite members' }, 403);

  const invite = await signToken(
    { n: String(name), exp: Date.now() + accessDays * 24 * 3600 * 1000, t: 'mi', d: accessDays },
    env.KILN_MEMBER_SECRET
  );
  return json({ invite, days: accessDays });
}
