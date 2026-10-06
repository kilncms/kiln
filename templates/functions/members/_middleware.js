/**
 * Gate for everything under /members/ — pages, PDFs, any static asset.
 * Runs at the edge before the static file is served. No cookie (or a bad
 * one) → redirect to the login page with a return path.
 *
 * The cookie is signed by this site and cannot be taken back, so a signature
 * alone would let a removed member in until it expired. Each sign-in therefore
 * carries a session id, and the gate asks the Kiln worker whether that sign-in
 * is still on the list: at most once every RECHECK_MS per browser (the answer
 * rides in a second short-lived signed cookie). If the worker cannot be
 * reached, the last "yes" stands in for up to OUTAGE_MS after it was given,
 * then the gate closes. So removing a member ends their access within about
 * five minutes, and within an hour at worst.
 *
 * Every answer from here is marked private and uncacheable. A gated page or
 * file must never be kept by a shared cache, or by the browser to be shown
 * again after sign-out, and what is served depends on the cookie.
 */
import { verifyToken, signToken, getCookie } from '../_kiln.js';

const NO_STORE = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };
export const RECHECK_MS = 5 * 60 * 1000;
export const OUTAGE_MS = 60 * 60 * 1000;
const COOKIE_ATTRS = 'Path=/; HttpOnly; Secure; SameSite=Lax';

/** The signed "checked just now" cookie: fresh until `c`, usable in an outage until `exp`. */
export async function checkedCookie(sid, secret, now = Date.now()) {
  const token = await signToken({ s: sid, c: now + RECHECK_MS, exp: now + OUTAGE_MS, t: 'mc' }, secret);
  return `kiln_member_ok=${encodeURIComponent(token)}; Max-Age=${OUTAGE_MS / 1000}; ${COOKIE_ATTRS}`;
}

/** true = still a member, false = no longer, null = the worker could not say. */
async function stillMember(env, origin, sid) {
  if (!env.KILN_WORKER) return null;
  try {
    const res = await fetch(`${env.KILN_WORKER}/members/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sid, origin }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.ok === true ? true : data.ok === false ? false : null;
  } catch {
    return null;
  }
}

export async function onRequest({ request, env, next }) {
  if (!env.KILN_MEMBER_SECRET) {
    return new Response('Members area not configured yet.', { status: 503, headers: NO_STORE });
  }
  const url = new URL(request.url);
  const toLogin = (signOut = false) => {
    const headers = new Headers({ Location: `${url.origin}/members-login.html?to=${encodeURIComponent(url.pathname)}`, ...NO_STORE });
    if (signOut) for (const name of ['kiln_member', 'kiln_member_ok']) headers.append('Set-Cookie', `${name}=; Max-Age=0; ${COOKIE_ATTRS}`);
    return new Response(null, { status: 302, headers });
  };
  const cookie = getCookie(request, 'kiln_member');
  const payload = cookie ? await verifyToken(cookie, env.KILN_MEMBER_SECRET) : null;
  if (!payload || payload.t !== 'ms') return toLogin();
  // A sign-in from before the list was re-checked has no session to ask
  // about: that member signs in once more.
  if (!/^[a-f0-9]{32}$/.test(payload.s || '')) return toLogin(true);

  const okCookie = getCookie(request, 'kiln_member_ok');
  const ok = okCookie ? await verifyToken(okCookie, env.KILN_MEMBER_SECRET) : null;   // null once OUTAGE_MS has passed
  const lastYes = ok && ok.t === 'mc' && ok.s === payload.s ? ok : null;
  let renewed = null;
  if (!lastYes || !(lastYes.c > Date.now())) {
    const answer = await stillMember(env, url.origin, payload.s);
    if (answer === false) return toLogin(true);
    if (answer === null && !lastYes) {
      return new Response('The members area cannot check your access right now. Try again in a minute.',
        { status: 503, headers: { ...NO_STORE, 'Retry-After': '60' } });
    }
    if (answer === true) renewed = await checkedCookie(payload.s, env.KILN_MEMBER_SECRET);
  }

  const res = await next();
  // Whatever the file itself said about caching, a gated one is never stored.
  const headers = new Headers(res.headers);
  headers.set('Cache-Control', NO_STORE['Cache-Control']);
  if (!/(^|,)\s*cookie\s*(,|$)/i.test(headers.get('Vary') || '')) headers.append('Vary', 'Cookie');
  if (renewed) headers.append('Set-Cookie', renewed);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
