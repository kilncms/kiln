/**
 * The page a person sees when signing in did not finish.
 *
 * They pressed "Continue with GitHub" or "Continue with Google" on a site's
 * sign-in page, were sent to that company, and came back here. When the last
 * step fails they are looking at this service's own address with nothing else
 * on the screen, so the page has to say in plain words what happened, whether
 * anything is wrong with their account (almost never), and what to do next.
 * What the company really answered is for whoever runs the service: it goes
 * in the log (`troubleLog`), not on the page. Seen for real on 2026-11-12:
 * GitHub answered a sign-in with 429 and the page showed its JSON.
 */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** One short line of what a company said, safe to show: no markup, no braces, at most 160 characters. */
function said(tok) {
  const t = tok && typeof tok === 'object' ? (tok.error_description || tok.message || tok.error || '') : '';
  return String(t).replace(/[{}<>]/g, '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, 160);
}
const waitWords = (s) => /wait a few minutes|rate limit|too many|restricted|slow down/i.test(s);

/**
 * GitHub did not hand over a sign-in. `status` is the HTTP status of its
 * answer, `tok` what it answered (null when that was not JSON).
 */
export function githubTrouble({ status = 0, tok = null } = {}) {
  const words = said(tok), code = tok && tok.error ? String(tok.error) : '';
  if (status === 429 || waitWords(words)) {
    return { code: 'wait', status: 503, heading: 'GitHub is asking everyone to wait a few minutes',
      words: 'GitHub is not letting sign-ins through to this site just now, and asks everyone to wait a few minutes. Nothing is wrong with your account or with the site. Go back to the site and sign in again in a few minutes.' };
  }
  if (code === 'bad_verification_code') {
    return { code: 'used', status: 400, heading: 'That sign-in was already used, or it took too long',
      words: 'GitHub’s sign-in step works once and for a few minutes. This one was used already (the page may have been opened twice) or the time ran out. Go back to the site and sign in again.' };
  }
  if (code === 'incorrect_client_credentials' || code === 'redirect_uri_mismatch' || code === 'unverified_user_email') {
    return { code: 'set_up', status: 502, heading: 'This sign-in service is not set up right',
      words: `GitHub did not accept this sign-in service’s own details. That is for whoever runs the service to put right, and nothing is wrong with your account.${words ? ` GitHub said: ${words}.` : ''}` };
  }
  if (status >= 500 || !tok) {
    return { code: 'no_answer', status: 502, heading: 'GitHub did not answer just now',
      words: 'GitHub did not finish its part of the sign-in. Nothing is wrong with your account. Go back to the site and sign in again in a minute.' };
  }
  return { code: 'refused', status: 400, heading: 'GitHub did not finish the sign-in',
    words: `GitHub did not sign you in this time.${words ? ` GitHub said: ${words}.` : ''} Go back to the site and sign in again.` };
}

/** The same for Google's last step. */
export function googleTrouble({ status = 0, tok = null } = {}) {
  const words = said(tok), code = tok && tok.error ? String(tok.error) : '';
  if (status === 429 || waitWords(words)) {
    return { code: 'wait', status: 503, heading: 'Google is asking everyone to wait a few minutes',
      words: 'Google is not letting sign-ins through to this site just now. Nothing is wrong with your account or with the site. Go back to the site and sign in again in a few minutes.' };
  }
  if (code === 'invalid_grant') {
    return { code: 'used', status: 400, heading: 'That sign-in was already used, or it took too long',
      words: 'Google’s sign-in step works once and for a few minutes. This one was used already (the page may have been opened twice) or the time ran out. Go back to the site and sign in again.' };
  }
  if (code === 'invalid_client' || code === 'unauthorized_client' || code === 'redirect_uri_mismatch') {
    return { code: 'set_up', status: 502, heading: 'This sign-in service is not set up right',
      words: `Google did not accept this sign-in service’s own details. That is for whoever runs the service to put right, and nothing is wrong with your account.${words ? ` Google said: ${words}.` : ''}` };
  }
  if (status >= 500 || !tok) {
    return { code: 'no_answer', status: 502, heading: 'Google did not answer just now',
      words: 'Google did not finish its part of the sign-in. Nothing is wrong with your account. Go back to the site and sign in again in a minute.' };
  }
  return { code: 'refused', status: 400, heading: 'Google did not finish the sign-in',
    words: `Google did not sign you in this time.${words ? ` Google said: ${words}.` : ''} Go back to the site and sign in again.` };
}

/** The sign-in came back without what it left with, or after its ten minutes. */
export const STALE_SIGN_IN = { code: 'stale', status: 400, heading: 'That sign-in is no longer good',
  words: 'A sign-in works once and for ten minutes. This one was used already or the time ran out. Go back to the site and sign in again.' };
/** The address of this page is missing the parts a sign-in comes back with. */
export const HALF_A_SIGN_IN = { code: 'half', status: 400, heading: 'This is not a whole sign-in',
  words: 'This page is where a sign-in comes back to, and it was opened without one. Go to the site you want to edit and sign in from its sign-in page.' };
/** Google could not confirm the address the person signed in with. */
export const UNCONFIRMED_GOOGLE = { code: 'unconfirmed', status: 403, heading: 'Google could not confirm your account',
  words: 'Google did not confirm that the address you signed in with is yours, so nobody was signed in. If the address is new, confirm it with Google first. Then go back to the site and sign in again.' };

/** Where "back to the site" goes: the sign-in page of the site the person came from, when that is a web address. */
export function backTo(origin) {
  try { const u = new URL(String(origin)); return u.protocol === 'https:' || u.hostname === 'localhost' || u.hostname === '127.0.0.1' ? `${u.origin}/kiln` : null; } catch { return null; }
}

/**
 * The same trouble for a person who was signing in to Kiln's dashboard, not to
 * a site: the way back is the dashboard, and the words say so.
 */
export function forDashboard(trouble) {
  const words = String(trouble.words)
    .replace(/o back to the site and sign in again/g, 'o back to the Kiln dashboard and sign in again')
    .replace('sign-ins through to this site just now', 'sign-ins through to Kiln just now')
    .replace('your account or with the site.', 'your account.');
  return { ...trouble, words };
}
/** Google sent a person who was signing in to the dashboard back without a sign-in (they pressed Cancel, or Google refused). */
export const DASHBOARD_SIGN_IN_STOPPED = { code: 'stopped', status: 400, heading: 'The sign-in did not finish',
  words: 'Google sent you back without signing you in. Nothing is wrong with your account. Go back to the Kiln dashboard and sign in again.' };
/** Google signed the person in, and Kiln could not find or make their account. */
export const ACCOUNT_NOT_READY = { code: 'account', status: 503, heading: 'Kiln could not open your account just now',
  words: 'Google signed you in, but Kiln could not open your account this time. Nothing is wrong with your Google account. Go back to the Kiln dashboard and sign in again in a few minutes. If it keeps happening, write to info@kilncms.com.' };
/** This service has no Google sign-in. */
export const NO_GOOGLE_SIGN_IN = { code: 'no_google', status: 503, heading: 'Google sign-in is not set up here yet',
  words: 'This Kiln service cannot sign anybody in with Google yet. That is for whoever runs the service to put right. Go back to the Kiln dashboard and sign in with GitHub, or write to info@kilncms.com.' };

/** The dashboard's address, when it is a real web address a person can be sent back to. */
function dashboardLink(address) {
  try { const u = new URL(String(address)); return u.protocol === 'https:' || u.hostname === 'localhost' || u.hostname === '127.0.0.1' ? u.toString() : null; } catch { return null; }
}

/**
 * The body of the page (the caller wraps it in the service's page): a heading,
 * the words, and the way back. `origin` is the site the person came from;
 * `dashboard` is the dashboard's address, for a person who came from there.
 */
export function troubleBody(trouble, { origin = null, dashboard = null } = {}) {
  const dash = dashboard ? dashboardLink(dashboard) : null;
  if (dash) return `<h1>${esc(trouble.heading)}</h1><p>${esc(trouble.words)}</p><p><a href="${esc(dash)}">Back to the Kiln dashboard</a></p>`;
  const back = backTo(origin);
  return `<h1>${esc(trouble.heading)}</h1><p>${esc(trouble.words)}</p>${back ? `<p><a href="${esc(back)}">Back to the sign-in page</a></p>` : ''}`;
}

/** One log line for whoever runs the service: what the company really answered, and never a token. */
export function troubleLog(who, trouble, { status = 0, tok = null } = {}) {
  return JSON.stringify({ evt: 'signin_trouble', who, code: trouble.code, status, error: tok && tok.error ? String(tok.error).slice(0, 80) : null, detail: said(tok) });
}

// ─── A dashboard sign-in belongs to the browser that started it ──────────────

/**
 * A sign-in to the dashboard belongs to the browser that started it.
 *
 * /cloud/login and /cloud/login/google (cloud.js) send the person to GitHub or
 * Google with a state, and set a cookie holding that state on the service's
 * own address. The two places a sign-in comes back to (/cloud/callback in
 * cloud.js, and the dashboard branch of /google/callback in index.js) finish
 * it only for a browser that sends the same state back in that cookie. So a
 * callback address that somebody started and then passed to another person
 * signs nobody in: the other person's browser has no such cookie.
 *
 * The cookie lasts ten minutes, as the state does, and is taken away again
 * when the sign-in ends either way.
 */

/**
 * What a person reads when a sign-in comes back to a browser that does not
 * hold its cookie. It is shown as the dashboard's other sign-in troubles above
 * are (troubleBody, with the way back to the dashboard).
 */
export const STARTED_ELSEWHERE = { code: 'elsewhere', status: 400, heading: 'The sign-in did not finish',
  words: 'Kiln could not tell that this sign-in was started in this browser, so nobody was signed in. Nothing is wrong with your account. Go back to the Kiln dashboard and sign in again. If it keeps happening, check that this browser accepts cookies from Kiln.' };

/** Local development (wrangler dev) is plain http, where a browser may not keep a Secure cookie. */
const local = (url) => url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);

/**
 * The cookie's name. On the real service it starts with `__Host-`: a browser
 * takes such a cookie only from this very address over https, so no other
 * address under the same domain can plant one. That needs Secure, so local
 * development has the plain name.
 */
export const signInCookieName = (url) => (local(url) ? 'kiln_signin' : '__Host-kiln_signin');

const cookie = (url, value, maxAge) =>
  `${signInCookieName(url)}=${value}; HttpOnly; ${local(url) ? '' : 'Secure; '}SameSite=Lax; Path=/; Max-Age=${maxAge}`;

/** The redirect that starts a sign-in: on to `to`, with the cookie that ties the state to this browser. */
export function startSignIn(url, to, state) {
  return new Response(null, { status: 302, headers: { Location: to, 'Set-Cookie': cookie(url, state, 600) } });
}

/** Whether this request comes from the browser in which the sign-in with this state was started. */
export function startedHere(request, url, state) {
  if (!state || !request || !request.headers) return false;
  const name = `${signInCookieName(url)}=`;
  return (request.headers.get('Cookie') || '').split(';').map(c => c.trim()).some(c => c.startsWith(name) && c.slice(name.length) === String(state));
}

/** The same answer, with the sign-in's cookie taken away: the sign-in is over, however it ended. */
export function signInOver(url, res) {
  const headers = new Headers(res.headers);
  headers.append('Set-Cookie', cookie(url, '', 0));
  return new Response(res.body, { status: res.status, headers });
}
