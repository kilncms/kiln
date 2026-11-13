/**
 * Kiln Cloud — the hosted tier on top of the kiln-auth worker.
 *
 * Routes (all behind handleCloud):
 *   GET  /cloud/login            → GitHub OAuth (identity only)
 *   GET  /cloud/login/google     → Google sign-in for a person with no GitHub account; Google returns to
 *                                  /google/callback (index.js), which hands a dashboard sign-in to googleDashboardSignIn
 *   GET  /cloud/callback         → upsert account, set session cookie, → dashboard
 *   GET  /cloud/me               → { account, sites }
 *   POST /cloud/sites            → register a site (verify repo install) → checkout URL
 *   GET  /cloud/sites/prepare    → what adding Kiln to the site's repository would change
 *   POST /cloud/sites/prepare    → add Kiln to the repository (prepare.js), in one commit
 *                                  (for a site Kiln hosts, both also cover the character-set
 *                                  line on pages and page templates that have none: `charset`
 *                                  in the answer, and a second commit of its own)
 *   GET  /cloud/sites/firstpass  → what a first pass at what can be edited would mark
 *   POST /cloud/sites/firstpass  → mark it (firstpass.js), in one commit
 *   POST /cloud/sites/remove     → cancel its subscription, then delete a site
 *   GET  /cloud/sites/update     → which Kiln editor the site's repository holds, and what an update would replace
 *   POST /cloud/sites/update     → replace the editor's files with the released ones (update.js), in one commit
 *   GET  /cloud/sites/check      → a checklist of how the site is set up (sitecheck.js); changes nothing
 *   GET  /cloud/sites/hosting    → where a hosted site stands (hosted.js)
 *   POST /cloud/sites/hosting    → put the site on Kiln's hosting, or publish it again (hosting.js)
 *   GET  /cloud/sites/domain     → where a hosted site's own domain stands, or a look at a domain that changes nothing (domain.js)
 *   POST /cloud/sites/domain     → set the domain up, ask whether its name servers have changed, or stop a set-up that is not live
 *   GET  /cloud/sites/domain/records → the domain's records as a file, for an owner who moves the domain away
 *   GET  /cloud/portal?site=     → Lemon Squeezy customer-portal link
 *   POST /cloud/webhook/ls       → Lemon Squeezy webhook (signed) → set site status
 *   GET  /admin/cloud/overview   → (owner only) accounts, sites (with the editor build each runs), MRR
 *   POST /admin/cloud/grant      → (owner only) manually set a site's status
 *
 * Storage: D1 `kiln_cloud` (accounts, sites). KV `csess:<id>` for dashboard sessions.
 * Billing degrades gracefully: with no LS_* secrets, sites register as `trialing` and
 * checkout answers that the payment page could not be opened (code `billing_not_configured`)
 * until you add your Lemon Squeezy keys.
 */

import { RUNBOOK_HTML } from './runbook.js';
import { troubleBody, forDashboard, UNCONFIRMED_GOOGLE, DASHBOARD_SIGN_IN_STOPPED, ACCOUNT_NOT_READY, NO_GOOGLE_SIGN_IN } from './signin-trouble.js';
import { customerMailOn, mailAddress, sendOnce, siteAddedMail, trialEndingMail, trialEndedMail, editingStoppedMail, hostingEndingMail, domainNameServersMail, domainLiveMail, domainReminderMail, domainPutAwayMail, domainMovedMail, forwardOnMail, forwardWaitingMail, trialEndsAt, TRIAL_NOTICE_DAYS } from './mail.js';
import { planPrepare, applyPrepare, publicPlan, prepareSentence, PrepareError, SETUP_COMMAND, readPages } from './prepare.js';
import { planFirstPass, applyFirstPass, publicFirstPass, firstPassSentence } from './firstpass.js';
import { planUpdate, applyUpdate, publicUpdate, updateSentence, editorStanding, rememberLatest, noteRepoBuild, UPDATE_COMMAND } from './update.js';
import { checkSite, editingOffLine, domainWaitingLine } from './sitecheck.js';
import { hostingOn, hostingSentence } from './hosting.js';
import { keepsReady, inKeepOrg, keepSentence, keptSite, keptIds, keptRemovedNote, startKept } from './keeps.js';
import { hostingRow, hostingForAccount, publicHosting, publishSite, forgetHosting, siteForHostingAddress } from './hosted.js';
import { lookAfter, lookedAfter, careOwed, planCharset, applyCharset, charsetSentence, publicCharset } from './lookafter.js';
import {
  domainsOn, domainsReady, cleanDomain, lookUp, whatStops, sellerHelp, prepareDomain, domainStatus, removeWaitingDomain, exportRecords,
  siteAnswers, certificateReady, redirectToOne, alwaysHttps, LIMITS as DOMAIN_LIMITS,
  domainSentence, publicDomain, publicLook, domainRow, domainForName, domainsForAccount, saveDomain, forgetDomain, DomainError, TAKING_HOLD,
} from './domain.js';
import {
  mailStop, saysNoMail, switchMailOn, inboxState, addInbox, askAgain, canAskAgain, forward, stopForwarding, cleanLocal, cleanInbox, mailSentence,
  forwardRow, forwardsForAccount, forwardsConfirming, forwardsReady, saveForward, forgetForward, publicForward, ownsInbox, inboxAwaited, whatWaits, NO_CHANGE, MailError, MAIL_LIMITS,
} from './domain-mail.js';

const GH = 'https://api.github.com';
const LS = 'https://api.lemonsqueezy.com/v1';
const UA = 'kiln-cloud';
const INSTALL_URL = 'https://github.com/apps/kiln-cms/installations/new';
const NOT_YOUR_REPO = 'The GitHub account you signed in with cannot change that repository. Check the spelling, or sign in with the account that owns it.';

const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const uuid = () => crypto.randomUUID();
// What a person signed in with Google is told when they ask for something that takes a GitHub account.
const NEEDS_GITHUB_TO_ADD = 'Adding a repository of your own needs a GitHub sign-in. Sign out, then sign in with GitHub.';
const NEEDS_GITHUB_FOR_SITE = 'This site is in a GitHub repository, and you are signed in with Google. Sign out, then sign in with GitHub.';
// A bare page, for a caller that hands over none of its own (index.js hands its `html`).
const plainPage = (body, status = 200) => new Response(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kiln</title></head><body>${body}</body></html>`,
  { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// ─── GitHub identity (reuses the GitHub App's OAuth client) ───────────────────

async function creds(env) { return JSON.parse(await env.KILN.get('app:creds')); }

/**
 * A read made with a token GitHub issued a moment ago. GitHub can take a
 * second or two before a new token is accepted everywhere, and answers 401
 * (or a 5xx) meanwhile. Asked once, a sign-in that had just succeeded was
 * reported as failed, and an owner was told their own site was not theirs.
 * So the read is made again a few times, a little later each time, and only
 * for a token that is new: every other read keeps its single try.
 */
const NEW_TOKEN_WAITS = [0, 350, 800, 1400];   // milliseconds before each try
export async function ghWithNewToken(url, token, { waits = NEW_TOKEN_WAITS, sleep = (ms) => new Promise(r => setTimeout(r, ms)) } = {}) {
  let r = null;
  for (const wait of waits) {
    if (wait) await sleep(wait);
    try {
      r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': UA } });
    } catch { r = null; continue; }
    if (r.status !== 401 && r.status < 500) break;
  }
  return r;
}

async function ghUser(token, { fresh = false } = {}) {
  const r = fresh
    ? await ghWithNewToken(`${GH}/user`, token)
    : await fetch(`${GH}/user`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': UA } });
  return r && r.ok ? r.json() : null;
}

async function appJwt(c) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const body = b64url(new TextEncoder().encode(JSON.stringify({ iat: now - 60, exp: now + 540, iss: c.app_id })));
  const key = await crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(c.pk8), s => s.charCodeAt(0)),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(sig)}`;
}

/** Is the Kiln app installed on this repo, AND does this user have access to it? */
async function repoInstalled(env, repo) {
  const c = await creds(env);
  const jwt = await appJwt(c);
  const r = await fetch(`${GH}/repos/${repo}/installation`, { headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json', 'User-Agent': UA } });
  return r.ok;
}

/** Does the signed-in user (via their stored OAuth token) have push on the repo? */
export async function userCanPush(userToken, repo, { fresh = false } = {}) {
  if (!userToken) return false;
  try {
    // `fresh`: the token was issued in this very request (a sign-in callback), see ghWithNewToken.
    const r = fresh
      ? await ghWithNewToken(`${GH}/repos/${repo}`, userToken)
      : await fetch(`${GH}/repos/${repo}`, { headers: { Authorization: `Bearer ${userToken}`, Accept: 'application/vnd.github+json', 'User-Agent': UA } });
    if (!r || !r.ok) return false;
    const j = await r.json();
    return !!(j.permissions && (j.permissions.push || j.permissions.admin || j.permissions.maintain));
  } catch { return false; }
}

// ─── Dashboard sessions (KV) ──────────────────────────────────────────────────

// Bearer-token sessions (the dashboard lives on a different origin than this API,
// so cookies aren't usable — the token rides in the OAuth-return fragment, the
// dashboard stores it, and sends it as Authorization: Bearer on every call).
function bearer(request) {
  const a = request.headers.get('Authorization') || '';
  return a.startsWith('Bearer ') ? a.slice(7).trim() : null;
}
async function session(request, env) {
  const sid = bearer(request);
  if (!sid) return null;
  const raw = await env.KILN.get(`csess:${sid}`);
  return raw ? JSON.parse(raw) : null;
}

// ─── Accounts + sites (D1) ────────────────────────────────────────────────────

async function upsertAccount(env, login, email) {
  const existing = await env.kiln_cloud.prepare('SELECT * FROM accounts WHERE github_login = ?').bind(login).first();
  if (existing) return existing;
  const id = uuid();
  await env.kiln_cloud.prepare('INSERT INTO accounts (id, github_login, email, created_at) VALUES (?,?,?,?)')
    .bind(id, login, email || null, Date.now()).run();
  return { id, github_login: login, email, ls_customer_id: null };
}

/**
 * The account of a person who signed in to the dashboard with Google: found by
 * Google's own id for them, or made the first time, with the address and name
 * Google gave and no GitHub login. Nothing else is looked at. An account that
 * signed in with GitHub is never found or changed here, whatever its address,
 * and two accounts with the same address stay two accounts.
 */
async function googleAccount(env, { sub, email, name }) {
  const find = () => env.kiln_cloud.prepare('SELECT * FROM accounts WHERE google_sub = ?').bind(sub).first();
  const existing = await find();
  if (existing) return existing;
  const id = uuid();
  try {
    await env.kiln_cloud.prepare('INSERT INTO accounts (id, github_login, email, name, google_sub, created_at) VALUES (?,?,?,?,?,?)')
      .bind(id, null, email || null, name || null, sub, Date.now()).run();
  } catch (e) {
    const other = await find();   // two sign-ins at the same moment: the other one made the account
    if (other) return other;
    throw e;
  }
  return { id, github_login: null, email: email || null, name: name || null, google_sub: sub, ls_customer_id: null };
}

/** A dashboard session with no GitHub person behind it: the person signed in with Google. */
function withoutGitHub(sess) { return !!sess && !sess.login && !!sess.google; }

/**
 * Writes a new site's row, on the free trial every new site gets, and answers
 * it. `kept` marks a site whose files Kiln keeps (keeps.js), which is the only
 * caller that names an `id`.
 */
async function registerSite(env, { id = uuid(), accountId, repo, origin, plan, kept = false }) {
  // Anti-abuse: the 7-day self-serve trial clock is anchored to the FIRST time
  // this origin was ever registered, so removing + re-adding a site can't farm
  // a fresh trial indefinitely. (First registration records the timestamp.)
  const firstSeenKey = `firstseen:${origin}`;
  let createdAt = Date.now();
  const prior = await env.KILN.get(firstSeenKey);
  if (prior) createdAt = Number(prior) || createdAt;
  else await env.KILN.put(firstSeenKey, String(createdAt));   // no TTL: a permanent trial marker
  const site = { id, account_id: accountId, repo, origin, plan: plan === 'managed' ? 'managed' : 'cloud', status: 'trialing', created_at: createdAt };
  // `kept` arrives with migration 0008, so only a kept site's row names the column.
  await env.kiln_cloud.prepare(`INSERT INTO sites (id, account_id, repo, origin, plan, status, created_at${kept ? ', kept' : ''}) VALUES (?,?,?,?,?,?,?${kept ? ',1' : ''})`)
    .bind(site.id, site.account_id, site.repo, site.origin, site.plan, site.status, site.created_at).run();
  await env.KILN.delete(`cloudgone:${String(site.repo).toLowerCase()}`);
  return site;
}

/** Who is signed in, for a note to the operator: the GitHub login, or the Google address. */
export function signedInAs(sess) { return sess.login || sess.google?.email || 'somebody signed in with Google'; }

/**
 * Whose name a change made from the dashboard carries in the repository's
 * history. A person signed in with GitHub is the author as GitHub knows them.
 * A person signed in with Google has no GitHub name: the author is their own
 * name with "(via Kiln)" after it, and the address on their account.
 */
export async function commitAuthor(env, sess) {
  if (sess.login) {
    const uid = sess.uid != null && /^\d+$/.test(String(sess.uid)) ? `${sess.uid}+` : '';
    return { name: sess.login, email: `${uid}${sess.login}@users.noreply.github.com` };
  }
  const email = (await accountEmail(env, sess.account_id)) || sess.google?.email || null;
  const name = String(sess.google?.name || '').trim() || String(email || 'Somebody').split('@')[0];
  return { name: `${name} (via Kiln)`, email };
}

// ─── Lemon Squeezy ────────────────────────────────────────────────────────────

function lsConfigured(env) { return !!(env.LS_API_KEY && env.LS_STORE_ID); }

function lsVariant(env, plan) { return plan === 'managed' ? env.LS_VARIANT_MANAGED : env.LS_VARIANT_CLOUD; }

// Live/test mode of the LS store, inferred from whether the Cloud variant is published
// (variants sit `pending` until the store is activated for live payments, then `published`).
async function lsStoreMode(env) {
  if (!lsConfigured(env) || !env.LS_VARIANT_CLOUD) return { mode: 'unconfigured' };
  try {
    const r = await fetch(`${LS}/variants/${env.LS_VARIANT_CLOUD}`, {
      headers: { Authorization: `Bearer ${env.LS_API_KEY}`, Accept: 'application/vnd.api+json' },
    });
    if (!r.ok) return { mode: 'unknown' };
    const status = (await r.json())?.data?.attributes?.status || 'unknown';
    return { mode: status === 'published' ? 'live' : 'test', variant_status: status };
  } catch { return { mode: 'unknown' }; }
}

/**
 * One short mail to the operator (a new site, a billing change) through the
 * send_email binding. Production-only wiring: without the NOTIFY binding and
 * the NOTIFY_TO secret (a verified Email Routing destination) this does
 * nothing. A failure to send never fails the request — it leaves a log line.
 * Exported for tests, which pass a fake binding; production wraps the same
 * fields in cloudflare:email's EmailMessage.
 */
export async function notifyOwner(env, subject, lines) {
  if (!env.NOTIFY || !env.NOTIFY_TO) return;
  try {
    const from = env.NOTIFY_FROM || 'notify@kilncms.com';
    const raw = [
      `From: Kiln <${from}>`,
      `To: <${env.NOTIFY_TO}>`,
      `Subject: ${String(subject).replace(/[\r\n]+/g, ' ').slice(0, 180)}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${uuid()}@kilncms.com>`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      ...lines.map(String), '',
    ].join('\r\n');
    let message = { from, to: env.NOTIFY_TO, raw };
    try {
      const { EmailMessage } = await import('cloudflare:email');
      message = new EmailMessage(from, env.NOTIFY_TO, raw);
    } catch { /* node (tests, local dev): the fake binding takes the plain shape */ }
    await env.NOTIFY.send(message);
  } catch (e) {
    console.warn(JSON.stringify({ evt: 'notify_failed', err: String(e?.message || e).slice(0, 200) }));
  }
}

/** Which plan a Lemon Squeezy variant is, or null for one this worker does not sell. */
export function planForVariant(env, variantId) {
  if (variantId == null || variantId === '') return null;
  const v = String(variantId);
  if (env.LS_VARIANT_MANAGED && v === String(env.LS_VARIANT_MANAGED)) return 'managed';
  if (env.LS_VARIANT_CLOUD && v === String(env.LS_VARIANT_CLOUD)) return 'cloud';
  return null;
}

/**
 * A checkout for one site. It offers only the plan the site was added with
 * (a product's other variants are switched off for this checkout, so nobody
 * pays the smaller price for the larger plan by picking it on the payment
 * page), fills in the account's email when there is one, and sends the
 * customer back to the dashboard once they have paid: without `redirect_url`
 * they are left on Lemon Squeezy's own page with no way back to their site.
 */
async function lsCheckout(env, site, { email = null } = {}) {
  const variant = lsVariant(env, site.plan);
  if (!lsConfigured(env) || !variant) return null;
  let back = env.CLOUD_DASHBOARD || 'https://app.kilncms.com', after = back;
  try { const u = new URL(back); u.searchParams.set('subscribed', site.id); after = u.toString(); back = new URL(back).toString(); } catch { /* a dashboard address that is no URL: sent as it is */ }
  const variantId = Number(variant);
  const prefill = typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? { email } : {};
  const body = {
    data: {
      type: 'checkouts',
      attributes: {
        checkout_data: { ...prefill, custom: { site_id: site.id } },
        // The free days are Kiln's own: seven, counted from the day the site was
        // added, with no card. A trial set on the product in Lemon Squeezy would
        // add its own days on top once a card is entered, so it is skipped here.
        checkout_options: { skip_trial: true },
        product_options: {
          redirect_url: after,
          receipt_button_text: 'Open your Kiln dashboard',
          receipt_link_url: back,
          ...(Number.isInteger(variantId) && variantId > 0 ? { enabled_variants: [variantId] } : {}),
        },
      },
      relationships: {
        store: { data: { type: 'stores', id: String(env.LS_STORE_ID) } },
        variant: { data: { type: 'variants', id: String(variant) } },
      },
    },
  };
  const r = await fetch(`${LS}/checkouts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.LS_API_KEY}`, 'Content-Type': 'application/vnd.api+json', Accept: 'application/vnd.api+json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) return null;
  const d = await r.json();
  return d?.data?.attributes?.url || null;
}

/** The email on a dashboard account, for the checkout to start with. Never fails a request. */
async function accountEmail(env, accountId) {
  try { return (await env.kiln_cloud.prepare('SELECT email FROM accounts WHERE id = ?').bind(accountId).first())?.email || null; }
  catch { return null; }
}

async function lsPortal(env, subscriptionId) {
  if (!lsConfigured(env) || !subscriptionId) return null;
  const r = await fetch(`${LS}/subscriptions/${subscriptionId}`, {
    headers: { Authorization: `Bearer ${env.LS_API_KEY}`, Accept: 'application/vnd.api+json' },
  });
  if (!r.ok) return null;
  const d = await r.json();
  return d?.data?.attributes?.urls?.customer_portal || null;
}

/**
 * End a subscription before its site is forgotten. `ok` is true only when no
 * further charge can follow: the site never had a subscription, Lemon Squeezy
 * says it has already ended, or Lemon Squeezy confirmed the cancellation just
 * now. Anything else (billing not configured here, Lemon Squeezy not
 * answering, a subscription this key cannot see) is "not known to be
 * cancelled", and the caller keeps the site so the customer can still reach
 * Manage billing.
 */
export async function lsCancel(env, subscriptionId) {
  if (!subscriptionId) return { ok: true, state: 'none' };
  if (!lsConfigured(env)) return { ok: false, state: 'billing_not_configured' };
  const headers = { Authorization: `Bearer ${env.LS_API_KEY}`, Accept: 'application/vnd.api+json' };
  const ended = (a) => !!a && (a.status === 'cancelled' || a.status === 'expired');
  try {
    const cur = await fetch(`${LS}/subscriptions/${subscriptionId}`, { headers });
    // 404 is not "nothing to cancel": a key for the other mode (test/live)
    // cannot see a subscription that is still charging.
    if (!cur.ok) return { ok: false, state: cur.status === 404 ? 'subscription_not_found' : 'billing_unreachable' };
    const before = (await cur.json())?.data?.attributes;
    if (ended(before)) return { ok: true, state: 'already_cancelled', ends_at: before.ends_at || null };
    const res = await fetch(`${LS}/subscriptions/${subscriptionId}`, { method: 'DELETE', headers });
    if (!res.ok) return { ok: false, state: 'cancel_refused' };
    const after = (await res.json())?.data?.attributes;
    return ended(after) ? { ok: true, state: 'cancelled', ends_at: after.ends_at || null } : { ok: false, state: 'cancel_refused' };
  } catch {
    return { ok: false, state: 'billing_unreachable' };
  }
}

const NOT_CANCELLED = 'This site has a subscription that could not be cancelled just now, so the site was not removed and nothing changed. '
  + 'Open Manage billing, cancel the subscription there, then remove the site.';

async function verifyLsSignature(request, bodyText, env) {
  const sig = request.headers.get('X-Signature');
  if (!sig || !env.LS_WEBHOOK_SECRET) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.LS_WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(bodyText));
  const expected = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('');
  // constant-time-ish compare
  if (expected.length !== sig.length) return false;
  let diff = 0; for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

// What each Lemon Squeezy subscription status means for a site.
//   status   what the dashboard and the admin page show
//   access   'yes'    editing is on
//            'until'  cancelled, and paid up to `ends_at`: editing stays on until then
//            'grace'  a charge failed (or billing is paused): editing stays on for
//                     PAST_DUE_GRACE_DAYS from the first such event, while Lemon
//                     Squeezy retries the card
//            'no'     the subscription is over: editing is off, and the day it
//                     stopped stays on the row (`access_until`, now in the past),
//                     because a site Kiln hosts comes down a set number of days
//                     after that day (hostingEndsAt)
// Only `expired` ends access outright.
export const PAST_DUE_GRACE_DAYS = 7;
const LS_STATE = {
  active:    { status: 'active',   access: 'yes' },
  on_trial:  { status: 'trialing', access: 'yes' },
  cancelled: { status: 'canceled', access: 'until' },
  expired:   { status: 'canceled', access: 'no' },
  past_due:  { status: 'past_due', access: 'grace' },
  unpaid:    { status: 'past_due', access: 'grace' },
  paused:    { status: 'past_due', access: 'grace' },
};

// A site may be edited while it is active or trialing, or, after that, until
// its `access_until` passes. One rule, in SQL for the request path and in JS
// for the admin page.
const ACCESS_SQL = "(status IN ('active','trialing') OR (status IN ('canceled','past_due') AND access_until > ?))";
export function siteHasAccess(site, now = Date.now()) {
  if (!site) return false;
  if (site.status === 'active' || site.status === 'trialing') return true;
  return (site.status === 'canceled' || site.status === 'past_due') && Number(site.access_until) > now;
}

// `access_until` arrives with migration 0002, which is applied before this
// worker is deployed. Should the worker ever run against a database without
// it, every statement that names the column falls back to the one that does
// not, so sites that are paid up keep working either way.
async function withAccessUntil(run, fallback) {
  try { return await run(); }
  catch (e) {
    if (/access_until/.test(String((e && e.message) || e))) return fallback();
    throw e;
  }
}

/**
 * True when a repository belongs to Kiln Cloud and none of its sites may be
 * edited any more (the plan ended, or a failed payment ran out its grace).
 * Then its API tokens and scheduled publishes stop too, as editing has. A
 * repository with no Cloud site at all (a self-hosted worker, or a site the
 * canonical instance lists by hand) is never "ended". If the database cannot
 * be read, the answer is false: an outage must not stop paying sites.
 */
export async function repoPlanEnded(env, repo, now = Date.now()) {
  if (!env.kiln_cloud || !repo) return false;
  try {
    const rows = await withAccessUntil(
      () => env.kiln_cloud.prepare('SELECT status, access_until FROM sites WHERE lower(repo) = lower(?)').bind(String(repo)).all(),
      () => env.kiln_cloud.prepare('SELECT status FROM sites WHERE lower(repo) = lower(?)').bind(String(repo)).all(),
    );
    const sites = rows?.results || [];
    // A site removed from Kiln Cloud leaves a marker: without it, a repository
    // with no row would count as "never on Cloud" and its tokens and schedules
    // would start working again after Remove.
    if (!sites.length) return !!(await env.KILN?.get(`cloudgone:${String(repo).toLowerCase()}`));
    return !sites.some(s => siteHasAccess(s, now));
  } catch {
    return false;
  }
}

/**
 * Where a site address stands on Kiln Cloud, for the sign-in page to say in
 * plain words why it will not sign anyone in: nobody has added the address
 * (`known: false`), or it was added and may not be edited any more (its free
 * trial ran out, or its plan ended). Null when this worker keeps no Cloud
 * sites at all, or the database cannot be read.
 */
export async function cloudOriginStanding(env, origin) {
  if (!env.kiln_cloud || !origin) return null;
  try {
    const row = await env.kiln_cloud.prepare('SELECT status, ls_subscription_id FROM sites WHERE origin = ? LIMIT 1').bind(origin).first();
    if (!row) return { known: false };
    return { known: true, status: row.status, trialEnded: row.status === 'canceled' && !row.ls_subscription_id };
  } catch {
    return null;
  }
}

/** The site row for an origin that may be edited right now, or null. */
export async function cloudSiteForOrigin(env, origin, now = Date.now()) {
  if (!env.kiln_cloud || !origin) return null;
  const named = await siteNamedByOrigin(env, origin, now);
  // A hosted site answers at two addresses: the one on record, which is its
  // own domain once that is live, and its temporary address, before and
  // after. A domain that still waits for its name servers is neither yet,
  // even where it already is the address on record: until the name servers
  // change, what answers there is not this site.
  if (named && !(await ownDomainStillWaits(env, origin))) return named;
  return siteForHostingAddress(env, origin, (s) => siteHasAccess(s, now));
}

/**
 * Is this address the own domain (the bare name or the `www` one) of the site
 * that has it on record, with that site's set-up still waiting? Only the
 * site's own set-up counts: somebody else's set-up for the same name takes
 * nothing from a site that has the address on record.
 */
async function ownDomainStillWaits(env, origin) {
  let host = '';
  try { host = new URL(origin).host; } catch { return false; }
  try {
    return !!(await env.kiln_cloud.prepare(
      `SELECT d.site_id FROM domains d JOIN sites s ON s.id = d.site_id WHERE s.origin = ? AND d.state = 'waiting' AND d.name IN (?, ?) LIMIT 1`)
      .bind(origin, host, host.replace(/^www\./, '')).first());
  } catch { return false; }   // a database the domains table has not reached: no site has a domain
}
async function siteNamedByOrigin(env, origin, now) {
  return withAccessUntil(
    () => env.kiln_cloud.prepare(`SELECT repo, status, access_until FROM sites WHERE origin = ? AND ${ACCESS_SQL} LIMIT 1`).bind(origin, now).first(),
    () => env.kiln_cloud.prepare("SELECT repo, status FROM sites WHERE origin = ? AND status IN ('active','trialing') LIMIT 1").bind(origin).first(),
  );
}

// Cron housekeeping: a site registers as `trialing` immediately so the owner can set up
// and preview before paying — but that grace can't be open-ended, or a site could edit
// forever without ever subscribing. Expire `trialing` sites that never started a Lemon
// Squeezy subscription once they pass the grace window; that drops them from the editable
// allowlist (a canceled site with no access_until has no access). Real LS trials carry an
// ls_subscription_id and are untouched — their lifecycle is driven entirely by webhooks.
const TRIAL_GRACE_DAYS = 7;
const FREE_HOSTED_SITES = 2;    // hosted sites an account may have before it has paid for any
export const HOSTING_AFTER_TRIAL_DAYS = 3;   // a hosted site whose free days ran out unpaid stays up this long, then comes down
export const HOSTING_AFTER_PAID_DAYS = 30;   // a hosted site that was paid for stays up this long after its plan ended, then comes down
export const HOSTING_NOTICE_DAYS = 7;        // its owner is told once more this many days before it comes down

/**
 * When a hosted site comes down, or null for "not for now". Two cases:
 *
 *   a free trial nobody subscribed for   HOSTING_AFTER_TRIAL_DAYS after it ran out
 *   a site that was paid for             HOSTING_AFTER_PAID_DAYS after the day it
 *                                        could last be edited (`access_until`: the
 *                                        end of the paid time after a cancellation,
 *                                        or of the grace after a failed payment)
 *
 * A site that may be edited is never on its way down. Nor is a paid site with
 * no `access_until` on record: there is no day to count from, and a site is
 * not taken down by guesswork (noticeEndingHosting tells the operator instead).
 */
export function hostingEndsAt(site, now = Date.now()) {
  if (!site || siteHasAccess(site, now)) return null;
  const day = 86400 * 1000;
  if (!site.ls_subscription_id) {
    if (site.status !== 'canceled' || !Number(site.created_at)) return null;
    return Number(site.created_at) + (TRIAL_GRACE_DAYS + HOSTING_AFTER_TRIAL_DAYS) * day;
  }
  if ((site.status !== 'canceled' && site.status !== 'past_due') || !Number(site.access_until)) return null;
  return Number(site.access_until) + HOSTING_AFTER_PAID_DAYS * day;
}
/** Why a hosted site comes down when hostingEndsAt says it does: the word kept on its record (hosting.js has the sentence). */
export const hostingEndReason = (site) => (site && site.ls_subscription_id ? 'plan_ended' : 'trial_ended');
/** The key of the last notice for one ending of a paid hosted site (mail.js sendOnce keeps `mail:<key>` with the time it went). */
const lastNoticeKey = (site) => `hosting-ending:${site.id}:${site.access_until}`;

/**
 * When a hosted site really comes down: { at, ready }, or null when it is not
 * on its way down. `at` is the day the dashboard and the last notice name, and
 * the sweep takes the site down once `ready` is true and `at` has come.
 *
 * It is hostingEndsAt's day, with one promise on top for a site that was paid
 * for and is online: where its owner can be written to (customer mail is on
 * and the account has an address), the site never comes down sooner than
 * HOSTING_NOTICE_DAYS after the last notice went. Normally that notice goes a
 * week ahead and changes nothing. Found late (the job did not run, mail was
 * off, a day on the row far in the past), the notice goes first and names a
 * day a week on, and the site waits for it: `ready` is false until it has
 * gone. With nobody to write to, the day is the day.
 *
 * `site` is the site's row (`email`, the account's address, is read when the
 * row does not carry it); `deployed` says whether the site is up at all.
 */
export async function hostingDownAt(env, site, { now = Date.now(), deployed = true } = {}) {
  const end = hostingEndsAt(site, now);
  if (!end) return null;
  const plain = { at: end, ready: true };
  if (!site.ls_subscription_id || !deployed || !customerMailOn(env)) return plain;
  let email = site.email;
  if (email === undefined) {
    try { email = (await env.kiln_cloud.prepare('SELECT a.email FROM sites s JOIN accounts a ON a.id = s.account_id WHERE s.id = ?').bind(site.id).first())?.email; }
    catch { email = null; }
  }
  if (!mailAddress(email)) return plain;
  const week = HOSTING_NOTICE_DAYS * 86400 * 1000;
  let told = 0;
  try { told = Number(await env.KILN.get(`mail:${lastNoticeKey(site)}`)) || 0; }
  catch { return { at: Math.max(end, now + week), ready: false }; }   // not known whether it went: not taken down on a guess
  return told ? { at: Math.max(end, told + week), ready: true } : { at: Math.max(end, now + week), ready: false };
}

/**
 * The operator hears when a hosted site is taken down (hosted.js calls this
 * from the sweep). `domain` is what hosted.js domainComesDown answered: a site
 * that was live at its own domain gets one more sentence. Never throws.
 */
export async function hostingEndedNote(env, site, reason, domain = null) {
  try {
    await notifyOwner(env, `Kiln took ${site.repo} down from its hosting`, [
      reason === 'plan_ended'
        ? `Its plan ended and ${HOSTING_AFTER_PAID_DAYS} days have passed. Where the account has an address, its owner was written to when editing stopped and again a week before today.`
        : 'Its free days ran out and nobody subscribed for it.',
      `Repository: ${site.repo}`,
      'Nothing was deleted from the repository. Its owner can subscribe and put the site up again from the dashboard.',
      ...(domain?.live && domain.name ? [liveDomainLeftNote(domain.name)] : []),
    ]);
  } catch { /* the site is down all the same, and the log says so */ }
}

/** What the answer to removing a site says of a domain it was live at: its name, and a sentence about what stays and how to move it away. */
function domainLeft(gone) {
  if (!gone?.domain?.live || !gone.domain.name) return {};
  const shown = publicDomain(gone.domain.row, { records: false });
  return { domain: { name: gone.domain.name, note: domainSentence('site_removed', { name: gone.domain.name, seller: shown?.seller?.name }) } };
}

/** The one more sentence of that note, for a site that was live at its own domain. */
export const liveDomainLeftNote = (name) => `The site was live at ${name}, so Kiln detached it from that domain and left the rest alone: the other records of ${name}, such as its email, keep working, and to move the domain away its owner downloads its records from the dashboard and then changes its name servers where the domain was bought.`;

/** What the dashboard is shown of a hosted site, with the day it comes down when it is on its way down. `site` is its whole row. */
async function shownHosting(env, row, site, now = Date.now()) {
  const down = row && row.state !== 'ended' && row.state !== 'removing' ? await hostingDownAt(env, site, { now, deployed: !!row.deployed_at }) : null;
  return publicHosting(row, { repo: site.repo, endsAt: down?.at || null, planEnded: Number(site.access_until) || null });
}
// ─── A hosted site on its owner's own domain (domain.js) ─────────────────────

const DOMAIN_LOCK_S = 120;                 // one set-up at a time for a site; the lock runs out by itself
const DOMAIN_CHECK_EVERY_MS = 60 * 1000;   // Cloudflare is asked to look at a site's domain again this often at most

/** True when a site is up on Kiln's hosting. Only such a site can answer at its owner's domain. */
const isUp = (row) => !!(row && row.deployed_at && row.state !== 'ended' && row.state !== 'removing');

/** True when this service can put a site on its owner's domain at all: it hosts sites, and the database has the table. */
async function domainsAvailable(env) {
  return hostingOn(env) && domainsOn(env) && await domainsReady(env);
}

/**
 * Look at a domain for a site, and change nothing: { name, look, stop }.
 * `look` is what domain.js could read (a part it could not read is empty),
 * and `stop` is the code of what stands in the way of a set-up, or null. What
 * can be known without asking anybody outside is looked at first, so a domain
 * that cannot be set up anyway costs no lookups. The set-up runs this again
 * itself: what the dashboard was told earlier is never trusted.
 */
async function lookAtDomain(env, site, typed) {
  const nothing = (name) => ({ name, registered: null, seller: null, nameServers: [], dnssec: null, atCloudflare: false, mail: false, found: [] });
  let name;
  try { name = cleanDomain(typed); }
  catch { return { name: null, look: nothing(String(typed ?? '').trim().slice(0, 253)), stop: 'not_a_domain' }; }
  const stopped = (stop) => ({ name, look: nothing(name), stop });
  if (!(await domainsAvailable(env))) return stopped('not_set_up');
  if (!isUp(await hostingRow(env, site.id))) return stopped('not_hosted');
  const mine = await domainRow(env, site.id);
  if (mine && (mine.state === 'waiting' || mine.state === 'live')) return stopped('has_one');
  const holder = await domainForName(env, name);
  if (holder && holder.site_id !== site.id) return stopped('taken');
  const look = await lookUp(name);
  return { name, look, stop: whatStops(look) };
}

// One set-up of a domain, for a mail that goes once for it: the zone, and the
// moment the set-up began. A set-up that takes up the zone its last try left
// (domain.js prepareDomain) is a set-up of its own, and is written about again.
const oneSetUp = (row) => `${row.zone_id}:${Number(row.created_at) || 0}`;

/**
 * The owner is written to with the two name servers to enter (mail.js), where
 * this service writes to customers and the account has an address. Once for
 * one set-up: the key holds the zone and when the set-up began, so a set-up
 * that is started again later is written about again. Never throws.
 */
async function tellNameServers(env, accountId, site, row) {
  try {
    if (!customerMailOn(env)) return;
    const account = await env.kiln_cloud.prepare('SELECT email FROM accounts WHERE id = ?').bind(accountId).first();
    if (!mailAddress(account?.email)) return;
    const d = publicDomain(row);
    await sendOnce(env, `domain-ns:${site.id}:${oneSetUp(row)}`, account.email, domainNameServersMail({
      origin: site.origin, name: d.name, nameServers: d.name_servers, seller: d.seller, helpUrl: d.seller?.help_url || sellerHelp(null).url,
      records: d.records, givesUpAt: d.gives_up_at, dashboard: env.CLOUD_DASHBOARD || 'https://app.kilncms.com',
    }));
  } catch { /* the set-up is made all the same, and the dashboard shows the two name servers */ }
}

const hostName = (address) => { try { return new URL(address).host; } catch { return ''; } };
const why = (e) => (e instanceof DomainError ? e.detail || e.code : String(e?.message || e)).slice(0, 300);

/**
 * What the domain steps need to know of a site, read afresh: its repository,
 * its address on record, its owner's address, and the temporary address
 * Kiln's hosting gave it. Null when the site is not there.
 */
async function siteForDomain(env, siteId) {
  return env.kiln_cloud.prepare(
    `SELECT s.id, s.repo, s.origin, a.email, h.url AS temp_url FROM sites s
       LEFT JOIN accounts a ON a.id = s.account_id LEFT JOIN hosting h ON h.site_id = s.id WHERE s.id = ?`).bind(siteId).first();
}

/**
 * One of the emails about a domain (mail.js), where this service writes to
 * customers and the owner has an address. Once for one set-up: the key holds
 * the kind and the zone. Never throws; the answer is sendOnce's.
 */
async function tellAboutDomain(env, kind, s, row, mail) {
  try {
    if (!customerMailOn(env) || !mailAddress(s?.email)) return { ok: false, reason: 'not sent' };
    return await sendOnce(env, `domain-${kind}:${s.id}:${oneSetUp(row)}`, s.email, mail);
  } catch { return { ok: false, reason: 'send failed' }; }
}

/** Set a site's address on record. A failure is logged and stops nothing; the answer says whether it was written. */
async function setAddressOnRecord(env, s, address, name) {
  try { await env.kiln_cloud.prepare('UPDATE sites SET origin = ? WHERE id = ?').bind(address, s.id).run(); return true; }
  catch (e) { console.warn(JSON.stringify({ evt: 'domain_address_not_set', repo: s.repo, name, address, detail: why(e) })); return false; }
}

/**
 * The step that makes a domain live. POST /cloud/sites/domain with action
 * "check" calls it the moment Cloudflare says the domain's name servers point
 * at Kiln, and the five-minute job (sweepDomains) calls it for every waiting
 * domain whose zone has become active. In this order:
 *   1. the site must answer at https://<name>/ (domain.js siteAnswers). When
 *      it does not yet (a certificate takes a few minutes), nothing is
 *      changed, a line says so, and the answer is { live: false }: the next
 *      run looks again;
 *   2. the row becomes `live`, with `live_at`;
 *   3. the site's address on record (`sites.origin`) becomes https://<name>,
 *      or https://www.<name> when the address on record already was the
 *      `www` one;
 *   4. the other of the two names is sent on to that one (redirectToOne) and
 *      HTTPS is switched on for every visitor (alwaysHttps). A failure of
 *      either is logged and does not stop the domain going live;
 *   5. the owner is written to, once, that the site is live at the domain.
 * It never throws: what goes wrong is logged, and the answer says whether the
 * domain is live now. `row` is the site's row in `domains`; of `site` only
 * the id is used, and the rest is read afresh.
 *
 * While the certificate or the site is waited for, the answer also says which
 * (`waitingFor`: 'certificate' or 'site_answering'), and the row's `reason`
 * becomes TAKING_HOLD, so that nobody is promised a day on which the set-up
 * is put away (domain.js publicDomain): the zone answers for the domain now.
 */
export async function domainTookHold(env, { site, row, now = Date.now() } = {}) {
  let live = false;
  try {
    if (!site?.id || !row?.name || !row.zone_id) return { live };
    if (row.state === 'live') return { live: true };
    if (row.state !== 'waiting') return { live };
    const name = row.name;
    const s = await siteForDomain(env, site.id);
    if (!s) return { live };
    // The button and the five-minute job can both get here: what the other one finished is not done twice.
    const fresh = await domainRow(env, s.id);
    if (fresh && fresh.state === 'live' && fresh.zone_id === row.zone_id) return { live: true };
    const holding = async (waitingFor) => {
      try { if ((fresh || row).reason !== TAKING_HOLD) await saveDomain(env, s.id, { reason: TAKING_HOLD }); }
      catch (e) { console.warn(JSON.stringify({ evt: 'domain_taking_hold_not_written', repo: s.repo, name, detail: why(e) })); }
      return { live, waitingFor };
    };
    // The certificate first: this service can reach the site inside
    // Cloudflare's network before a browser can (domain.js certificateReady),
    // so the site answering here does not mean it answers a visitor.
    let secure = false;
    try { secure = await certificateReady(env, { zoneId: row.zone_id, name }); }
    catch (e) { console.warn(JSON.stringify({ evt: 'domain_certificate_not_asked', repo: s.repo, name, detail: String(e?.detail || e?.message || e).slice(0, 200) })); }
    if (!secure) {
      console.log(JSON.stringify({ evt: 'domain_certificate_not_ready', repo: s.repo, name }));
      return await holding('certificate');
    }
    if (!(await siteAnswers(name))) {
      console.log(JSON.stringify({ evt: 'domain_not_answering_yet', repo: s.repo, name }));
      return await holding('site_answering');
    }
    if (!(await saveDomain(env, s.id, { state: 'live', reason: null, live_at: now, checked_at: now }))) return { live };
    live = true;
    const www = hostName(s.origin) === `www.${name}`;
    const address = `https://${www ? 'www.' : ''}${name}`;
    await setAddressOnRecord(env, s, address, name);
    let oneAddress = true;
    for (const [step, run] of [['redirect', () => redirectToOne(env, { zoneId: row.zone_id, name, www })], ['https', () => alwaysHttps(env, { zoneId: row.zone_id })]]) {
      try { await run(); }
      catch (e) { oneAddress = false; console.warn(JSON.stringify({ evt: 'domain_one_address_failed', step, repo: s.repo, name, detail: why(e) })); }
    }
    await tellAboutDomain(env, 'live', s, row, domainLiveMail({ name, address, tempUrl: s.temp_url, oneAddress, dashboard: env.CLOUD_DASHBOARD || 'https://app.kilncms.com' }));
    console.log(JSON.stringify({ evt: 'domain_live', repo: s.repo, name, address }));
  } catch (e) {
    console.warn(JSON.stringify({ evt: 'domain_took_hold_failed', site: site?.id, name: row?.name, detail: why(e) }));
  }
  return { live };
}

const DOMAINS_PER_RUN = 10;                         // the five-minute job looks at this many domains at most; the rest wait their turn
const DOMAIN_REMIND_AFTER_DAYS = 14;                // a set-up that has waited this long gets one reminder
const DOMAIN_LIVE_LOOK_EVERY_MS = 60 * 60 * 1000;   // a live domain is looked at this often at most
const DOMAIN_STUCK_AFTER_MS = 24 * 60 * 60 * 1000;  // name servers that changed this long ago, with the domain still not live: somebody must look

/**
 * A domain whose name servers changed more than a day ago and which is still
 * not live. A certificate takes minutes, so by now something is wrong that
 * waiting will not mend. One line for the operator's alerting and one note
 * to the operator, once for one set-up: the marker `domainstuck:<site id>:
 * <zone id>:<when the set-up began>` is written to KV before either goes and
 * never runs out, so a domain that could not be marked is not told about (it
 * would be told every five minutes otherwise). The owner is not written to,
 * and nothing is removed: the zone answers for the domain. Returns true when
 * the line was written. Never throws.
 */
async function domainStuck(env, s, row, { waitingFor, since, now }) {
  try {
    const marker = `domainstuck:${s.id}:${oneSetUp(row)}`;
    if (await env.KILN.get(marker)) return false;
    await env.KILN.put(marker, String(now));
    const name = row.name;
    const hours = Math.floor((now - since) / (60 * 60 * 1000));
    console.warn(JSON.stringify({ evt: 'domain_stuck', repo: s.repo, name, waiting_for: waitingFor, hours }));
    await notifyOwner(env, `Kiln: ${name} is still not live ${hours} hours after its name servers changed`, [
      `Repository: ${s.repo}`,
      `Domain: ${name}`,
      waitingFor === 'certificate'
        ? `The name servers of ${name} have pointed at Kiln's hosting for ${hours} hours, and Cloudflare still has no working certificate for ${name} and www.${name}.`
        : `The name servers of ${name} have pointed at Kiln's hosting for ${hours} hours and the certificate is ready, but https://${name}/ does not answer with the site.`,
      waitingFor === 'certificate'
        ? `Please open ${name} in the hosting account at Cloudflare, look at the edge certificates under SSL/TLS, and see why none has been issued.`
        : `Please open https://${name}/ in a browser, and check in the hosting account at Cloudflare that ${name} and www.${name} are attached to the site's Worker.`,
      'Kiln keeps trying every five minutes and makes the domain live by itself once this is mended. Nothing was removed, and the owner has not been written to. You are told once for this domain.',
    ]);
    return true;
  } catch { return false; }   // not marked, so not told: the next run tries again
}

/**
 * The five-minute job for domains. At most DOMAINS_PER_RUN a run, the one
 * looked at longest ago first, and every one it looks at has its
 * `checked_at` moved on, so a domain that keeps failing cannot hold up the
 * rest. It never throws: what goes wrong for one domain is logged and the
 * next is tried. Cloudflare is asked where each zone stands (domainStatus).
 *
 * A domain that waits:
 *   - the zone has been active for more than DOMAIN_STUCK_AFTER_MS (by the
 *     zone's own `activated_on`, or since the set-up began where that is
 *     later) and the domain is still not live: the operator is told, once
 *     (domainStuck). The row goes on waiting and nothing is removed;
 *   - the zone is active: domainTookHold makes it live, or leaves it waiting
 *     while the site does not answer there yet;
 *   - the zone is gone, or its name servers were changed and changed away
 *     again: the row is `put_away` (reason `gone` or `moved`) and the owner
 *     is written to once. A row that is put away is never looked at again;
 *   - it has waited 25 days (domain.js LIMITS.waitDays): the waiting zone is
 *     removed, the row is `put_away` with reason `not_changed`, and the owner
 *     is written to;
 *   - the zone was moved away before this set-up began (the set-up took up
 *     the zone its last try left, and the name servers have not come back
 *     yet): it goes on waiting;
 *   - it has waited DOMAIN_REMIND_AFTER_DAYS and nobody was reminded: one
 *     reminder, and `reminded_at`. Where the owner cannot be written to, or
 *     the mail did not go, `reminded_at` stays empty.
 *
 * A domain that is live, looked at once an hour at most: when the owner has
 * pointed its name servers elsewhere (or Cloudflare no longer has the zone),
 * the row is `put_away` with reason `moved`, the site's address on record
 * goes back to the temporary address Kiln's hosting gave it, and the owner
 * is written to. Nothing is deleted: the zone may still answer for email.
 *
 * Returns { looked, live, reminded, putAway, moved, stuck, failed }.
 */
export async function sweepDomains(env, { now = Date.now() } = {}) {
  const out = { looked: 0, live: 0, reminded: 0, putAway: 0, moved: 0, stuck: 0, failed: 0 };
  let rows = [];
  try {
    if (!env.kiln_cloud || !(await domainsAvailable(env))) return out;
    rows = (await env.kiln_cloud.prepare(
      `SELECT d.*, s.repo, s.origin, a.email, h.url AS temp_url FROM domains d
         JOIN sites s ON s.id = d.site_id LEFT JOIN accounts a ON a.id = s.account_id LEFT JOIN hosting h ON h.site_id = d.site_id
        WHERE d.zone_id IS NOT NULL AND (d.state = 'waiting' OR (d.state = 'live' AND COALESCE(d.checked_at, 0) <= ?))
        ORDER BY COALESCE(d.checked_at, 0) ASC, d.created_at ASC LIMIT ?`).bind(now - DOMAIN_LIVE_LOOK_EVERY_MS, DOMAINS_PER_RUN).all())?.results || [];
  } catch (e) {
    console.warn(JSON.stringify({ evt: 'domain_sweep_failed', detail: why(e) }));
    return out;
  }
  const dashboard = env.CLOUD_DASHBOARD || 'https://app.kilncms.com';
  const day = 86400 * 1000;
  for (const r of rows) {
    out.looked++;
    try {
      const s = { id: r.site_id, repo: r.repo, origin: r.origin, email: r.email, temp_url: r.temp_url };
      const name = r.name;
      const looked = () => saveDomain(env, s.id, { checked_at: now });
      const { status, activatedOn } = await domainStatus(env, { zoneId: r.zone_id });

      if (r.state === 'live') {
        if (status !== 'moved' && status !== 'gone') { await looked(); continue; }
        await saveDomain(env, s.id, { state: 'put_away', reason: 'moved', checked_at: now });
        // Back to the temporary address, unless the address on record is no longer the domain's.
        const back = r.temp_url && [name, `www.${name}`].includes(hostName(r.origin)) && await setAddressOnRecord(env, s, r.temp_url, name);
        await tellAboutDomain(env, 'moved', s, r, domainMovedMail({ name, tempUrl: back ? r.temp_url : null, dashboard }));
        console.log(JSON.stringify({ evt: 'domain_moved_away', repo: s.repo, name, status }));
        out.moved++;
        continue;
      }

      if (status === 'active') {
        const took = await domainTookHold(env, { site: s, row: r, now });
        if (took.live) { out.live++; continue; }
        await looked();
        // Counted from the later of the two: a set-up that took up a zone which was active already has had only its own time.
        const since = Math.max(activatedOn || 0, Number(r.created_at) || 0);
        if (took.waitingFor && activatedOn && now - since > DOMAIN_STUCK_AFTER_MS && await domainStuck(env, s, r, { waitingFor: took.waitingFor, since, now })) out.stuck++;
        continue;
      }
      const putAway = async (reason) => {
        await saveDomain(env, s.id, { state: 'put_away', reason, checked_at: now });
        await tellAboutDomain(env, 'away', s, r, domainPutAwayMail({ origin: r.origin, name, reason, waitDays: DOMAIN_LIMITS.waitDays, dashboard }));
        console.log(JSON.stringify({ evt: 'domain_put_away', repo: s.repo, name, reason }));
        out.putAway++;
      };
      // A set-up that took up the zone its last try left can find that zone still "moved": the name servers moved away
      // before this set-up began, and the owner has not pointed them back yet. That is a set-up that waits, not one that
      // was changed away again. Cloudflare drops such a zone after about a week, and then it is put away as gone.
      if (status === 'moved' && activatedOn && activatedOn < Number(r.created_at || 0)) { await looked(); continue; }
      if (status === 'gone' || status === 'moved') { await putAway(status); continue; }
      // Cloudflare says the zone waits after all: the day the set-up is put away is promised again.
      if (r.reason === TAKING_HOLD) await saveDomain(env, s.id, { reason: null });

      const waited = now - Number(r.created_at || now);
      if (waited >= DOMAIN_LIMITS.waitDays * day) {
        // Only a zone that still waits is removed. One that changed in this very moment is left for the next run.
        if ((await removeWaitingDomain(env, { zoneId: r.zone_id })).removed) { await putAway('not_changed'); continue; }
      } else if (waited >= DOMAIN_REMIND_AFTER_DAYS * day && !r.reminded_at) {
        const d = publicDomain(r, { records: false });
        const sent = await tellAboutDomain(env, 'remind', s, r, domainReminderMail({
          origin: r.origin, name, nameServers: d.name_servers, seller: d.seller, helpUrl: d.seller?.help_url || sellerHelp(null).url, givesUpAt: d.gives_up_at, dashboard,
        }));
        if (sent.ok || sent.reason === 'already sent') {
          await saveDomain(env, s.id, { reminded_at: now, checked_at: now });
          if (sent.ok) out.reminded++;
          continue;
        }
      }
      await looked();
    } catch (e) {
      out.failed++;
      console.warn(JSON.stringify({ evt: 'domain_sweep_one_failed', repo: r.repo, name: r.name, state: r.state, detail: why(e) }));
      try { await saveDomain(env, r.site_id, { checked_at: now }); } catch { /* it is tried again on the next run */ }
    }
  }
  return out;
}

// ─── One forwarded email address on a hosted site's own domain ───────────────
//
// domain-mail.js does the work at Cloudflare and keeps the `forwards` table.
// Here are the step that switches an address on once its inbox has confirmed,
// the mails about it, and the five-minute look at the inboxes that wait.

const FORWARD_LOCK_S = 120;      // one change at a time for a site's forwarded address; the lock runs out by itself
const FORWARDS_PER_RUN = 10;     // the five-minute job asks about this many waiting inboxes at most
const forwardLock = (siteId) => `forwardlock:${siteId}`;
// The refusals a person can do something about, and the status each is answered with. Anything else is "cloudflare".
const FORWARD_STATUS = { cloudflare: 502, not_set_up: 503, no_domain: 409, not_live: 409, has_own_mail: 409, not_confirmed: 409, inbox_elsewhere: 409, not_an_address: 400, same_domain: 400 };
const whyMail = (e) => (e instanceof MailError ? e.detail || e.code : String(e?.message || e)).slice(0, 300);

/** True when this service can forward an address at a site's own domain: it can put sites on their domains, and the database has the table. */
async function forwardingAvailable(env) {
  return await domainsAvailable(env) && await forwardsReady(env);
}

/** Why an address cannot be forwarded at a site's domain (`domain` is its row), as a code of domain-mail.js, or null. */
const forwardStop = (domain) => (!domain?.name ? 'no_domain' : mailStop(domain));
/** The records Kiln kept of a domain when its zone was made, as a list. */
const keptRecords = (domain) => { let r = domain?.records; if (typeof r === 'string') { try { r = JSON.parse(r); } catch { r = []; } } return Array.isArray(r) ? r : []; };

/**
 * One of the emails about a forwarded address (mail.js), where this service
 * writes to customers and the account has an address. Once for one asking:
 * the key holds the kind, the site and when the address was asked for, so an
 * address that is changed later is written about again. Never throws.
 */
async function tellAboutForward(env, kind, s, row, mail) {
  try {
    if (!customerMailOn(env) || !mailAddress(s?.email)) return { ok: false, reason: 'not sent' };
    return await sendOnce(env, `forward-${kind}:${s.id}:${Number(row.created_at) || 0}`, s.email, mail);
  } catch { return { ok: false, reason: 'send failed' }; }
}

/**
 * The step that switches a forwarded address on. Whoever calls it has heard
 * from Cloudflare that the inbox confirmed: the one rule is made (or the
 * earlier one replaced, so an earlier address stops at this moment), the row
 * becomes `on`, and the owner is written to, once. `s` is { id, repo, email }.
 * It throws what domain-mail.js forward throws, and the row is then as it was.
 * For a row that is `on` with a change waiting beside it (domain-mail.js
 * whatWaits), the rule is replaced with the wanted address and inbox, the row
 * takes them and holds no change any more, and the owner is written to about
 * the new address.
 */
async function forwardingOn(env, { s, row, zoneId, inboxId = null, now = Date.now() }) {
  const w = whatWaits(row) || { address: row.address, inbox: row.inbox, since: row.created_at, change: false };
  const made = await forward(env, { zoneId, address: w.address, inbox: w.inbox, ruleId: row.rule_id || null });
  await saveForward(env, s.id, w.change
    ? { address: w.address, inbox: w.inbox, inbox_id: inboxId || w.inbox_id, rule_id: made.ruleId, on_at: now, created_at: w.since || now, asked_at: w.asked_at, ...NO_CHANGE }
    : { state: 'on', rule_id: made.ruleId, on_at: now, ...(inboxId ? { inbox_id: inboxId } : {}) });
  console.log(JSON.stringify({ evt: 'forward_on', repo: s.repo, address: w.address, ...(w.change ? { was: row.address } : {}) }));
  await tellAboutForward(env, 'on', s, { created_at: w.since }, forwardOnMail({ address: w.address, inbox: w.inbox, dashboard: env.CLOUD_DASHBOARD || 'https://app.kilncms.com' }));
}

/**
 * The five-minute look at the forwarded addresses whose inbox has not
 * confirmed yet: at most FORWARDS_PER_RUN a run, the one looked at longest
 * ago first. For each, Cloudflare is asked whether the inbox has confirmed:
 *   - it has: the rule is made, the row becomes `on`, the owner is written to;
 *   - not after 7 days: the owner is reminded, once, whose inbox must press
 *     the button and where "Send it again" is;
 *   - not after 30 days: the row becomes `off` with the reason
 *     `never_confirmed`, and nothing more is asked. Nothing at Cloudflare is
 *     changed by that.
 * A change that waits beside an address that works (domain-mail.js whatWaits)
 * is looked at in the same way. When its inbox confirms, the rule is replaced
 * and the row takes the new address and inbox. The reminder is about the
 * change. After 30 days only the change is dropped: the address that works is
 * left exactly as it is, and nothing is switched off.
 * An inbox that has confirmed, though not at this account's asking
 * (domain-mail.js ownsInbox), gets no rule: its row becomes `failed` with the
 * reason `inbox_elsewhere`, and is counted with the ones given up on.
 * A site whose domain is no longer live is not asked about (no rule could be
 * made for it), and its row is given up on after the same 30 days. A row the
 * dashboard is at work on (its lock) is left for the next run. It never
 * throws: what goes wrong for one row is logged, and the next row is looked at.
 *
 * Returns { looked, on, reminded, gaveUp, failed }.
 */
export async function sweepForwards(env, { now = Date.now() } = {}) {
  const out = { looked: 0, on: 0, reminded: 0, gaveUp: 0, failed: 0 };
  let rows = [];
  try {
    if (!env.kiln_cloud || !(await forwardingAvailable(env))) return out;
    rows = await forwardsConfirming(env, FORWARDS_PER_RUN);
  } catch (e) {
    console.warn(JSON.stringify({ evt: 'forward_sweep_failed', detail: whyMail(e) }));
    return out;
  }
  const dashboard = env.CLOUD_DASHBOARD || 'https://app.kilncms.com';
  const day = 86400 * 1000;
  for (const r of rows) {
    out.looked++;
    try {
      if (await env.KILN.get(forwardLock(r.site_id))) continue;   // a press in the dashboard is at work on this one
      const s = await env.kiln_cloud.prepare(
        `SELECT s.id, s.repo, s.account_id, a.email, d.name, d.zone_id, d.state AS domain_state FROM sites s
           LEFT JOIN accounts a ON a.id = s.account_id LEFT JOIN domains d ON d.site_id = s.id WHERE s.id = ?`).bind(r.site_id).first();
      const w = whatWaits(r);
      if (!w) continue;   // it was settled between the reading and this look
      // Giving up on a first set-up marks the row. Giving up on a change only drops the change: the address that works stays on.
      const giveUp = async (state, reason) => {
        await saveForward(env, r.site_id, w.change ? NO_CHANGE : { state, reason });
        console.log(JSON.stringify({ evt: w.change ? 'forward_change_dropped' : 'forward_gave_up', repo: s?.repo || null, address: w.address, reason }));
        out.gaveUp++;
      };
      const waited = now - Number(w.since || now);
      const live = !!s && s.domain_state === 'live' && !!s.zone_id;
      if (live) {
        const box = await inboxState(env, { email: w.inbox, id: w.inbox_id });
        if (box?.verified) {
          // Confirmed at Cloudflare is confirmed for every customer at once: the rule is made only for an inbox this account has shown to be its own.
          if (!(await ownsInbox(env, { accountId: s.account_id, inbox: w.inbox }))) { await giveUp('failed', 'inbox_elsewhere'); continue; }
          await forwardingOn(env, { s, row: r, zoneId: s.zone_id, inboxId: box.id, now }); out.on++; continue;
        }
      }
      if (!s || waited >= MAIL_LIMITS.giveUpDays * day) {
        await giveUp('off', s ? 'never_confirmed' : 'site_removed');
        continue;
      }
      if (live && waited >= MAIL_LIMITS.remindDays * day) {
        const sent = await tellAboutForward(env, 'remind', s, { created_at: w.since }, forwardWaitingMail({
          address: w.address, inbox: w.inbox, givesUpAt: Number(w.since) + MAIL_LIMITS.giveUpDays * day, dashboard,
          ...(w.change ? { keeps: { address: r.address, inbox: r.inbox } } : {}),
        }));
        if (sent.ok) out.reminded++;
      }
      await saveForward(env, r.site_id, {});   // looked at: the next run begins with the rows that have waited longer for a look
    } catch (e) {
      out.failed++;
      console.warn(JSON.stringify({ evt: 'forward_sweep_one_failed', site: r.site_id, address: r.address, detail: whyMail(e) }));
      try { await saveForward(env, r.site_id, {}); } catch { /* it is tried again on the next run */ }
    }
  }
  return out;
}

const MAILS_PER_RUN = 25;   // a run writes to this many people at most; the rest wait five minutes

/**
 * A site Kiln hosts, that was paid for, and whose plan has ended (cancelled
 * and run out, or a payment that failed and used up its grace) stays up for
 * HOSTING_AFTER_PAID_DAYS, and its owner is written to twice (mail.js): when
 * editing has stopped, with the day the site comes down, and once more
 * HOSTING_NOTICE_DAYS before that day. Each goes once for one ending: the key
 * holds the site and its `access_until`, so a site that is subscribed again
 * and ends again later is written to again. Only one of the two goes in a
 * run, so a site first seen in its last week gets the second one alone. A
 * site first seen on or after its day gets the second one too, naming a day
 * a week on: it is never taken down before that notice has had its week
 * (hostingDownAt). sweepHosting, which runs after this, takes the site down.
 *
 * A paid site with no `access_until` has no day to count from. It is left
 * up, and the operator is told, once for that site and subscription: the
 * marker `hostnodate:<site id>:<subscription id>` is written to KV before the
 * note goes and never runs out, so a note that could not be marked is not
 * sent (it would go every five minutes otherwise).
 *
 * Never throws: a failure leaves a line, and the sweep goes on.
 */
export async function noticeEndingHosting(env, now = Date.now()) {
  const out = { sent: 0, undated: 0 };
  if (!env.kiln_cloud || !hostingOn(env)) return out;
  let rows = [];
  try {
    rows = (await env.kiln_cloud.prepare(
      `SELECT s.id, s.repo, s.origin, s.plan, s.status, s.access_until, s.created_at, s.ls_subscription_id, h.deployed_at, a.email
       FROM hosting h JOIN sites s ON s.id = h.site_id LEFT JOIN accounts a ON a.id = s.account_id
       WHERE s.ls_subscription_id IS NOT NULL AND s.status IN ('canceled','past_due') AND h.state NOT IN ('removing','ended')
       ORDER BY s.access_until`).all())?.results || [];
  } catch { return out; }   // a database migration 0005 (or 0002) has not reached: nothing to say
  try {
    const mailOn = customerMailOn(env);
    const dashboard = env.CLOUD_DASHBOARD || 'https://app.kilncms.com';
    const undated = [];
    for (const r of rows) {
      if (siteHasAccess(r, now)) continue;
      const end = hostingEndsAt(r, now);
      if (!end) { undated.push(r); continue; }
      // Not for a site that never went up: nothing of it is online.
      if (!mailOn || out.sent >= MAILS_PER_RUN || !r.deployed_at || !mailAddress(r.email)) continue;
      const about = { origin: r.origin, plan: r.plan, repo: r.repo, endsAt: end, pastDue: r.status === 'past_due', dashboard };
      let res;
      if (now >= end - HOSTING_NOTICE_DAYS * 86400 * 1000) {
        // The last notice names the day the site really comes down: its own
        // day, or a week from now when this notice is late.
        const down = await hostingDownAt(env, r, { now });
        if (!down || down.ready) continue;   // it has gone already
        res = await sendOnce(env, lastNoticeKey(r), r.email, hostingEndingMail({ ...about, endsAt: down.at }));
      } else {
        res = await sendOnce(env, `hosting-stays:${r.id}:${r.access_until}`, r.email, editingStoppedMail(about));
      }
      if (res.ok) out.sent++;
    }
    out.undated = undated.length;
    if (undated.length && env.NOTIFY && env.NOTIFY_TO) {
      const fresh = [];
      for (const r of undated) {
        const marker = `hostnodate:${r.id}:${r.ls_subscription_id}`;
        try {
          if (await env.KILN.get(marker)) continue;
          await env.KILN.put(marker, String(now));
          fresh.push(r);
        } catch { /* not marked, so not told: the next run tries again */ }
      }
      if (fresh.length) {
        await notifyOwner(env, `Kiln: ${fresh.length} hosted site${fresh.length === 1 ? '' : 's'} with a plan that ended and no end date`, [
          'Kiln hosts these, their plan has ended or a payment failed, and the record has no day on which editing stopped (access_until is empty).',
          `Kiln takes a paid site down ${HOSTING_AFTER_PAID_DAYS} days after that day, so with no day it leaves the site up and writes nothing to its owner. Please look at each one. You are told once for each.`,
          '',
          ...fresh.map(r => `${r.repo} (${r.origin}), status ${r.status}`),
        ]);
      }
    }
  } catch (e) {
    console.warn(JSON.stringify({ evt: 'hosting_notices_failed', err: String(e?.message || e).slice(0, 200) }));
  }
  return out;
}

/**
 * Two days before a free trial runs out, its owner is told, once (mail.js).
 * Only a trial nobody has subscribed for, and only where the account has an
 * address. A failure here never stops the expiry that follows it.
 */
export async function remindEndingTrials(env, now = Date.now()) {
  if (!env.kiln_cloud || !customerMailOn(env)) return 0;
  const day = 86400 * 1000;
  let sent = 0;
  try {
    const rows = await env.kiln_cloud.prepare(
      `SELECT s.id, s.origin, s.plan, s.created_at, a.email FROM sites s JOIN accounts a ON a.id = s.account_id
       WHERE s.status = 'trialing' AND s.ls_subscription_id IS NULL AND s.created_at <= ? AND s.created_at > ?
       ORDER BY s.created_at LIMIT ${MAILS_PER_RUN}`
    ).bind(now - (TRIAL_GRACE_DAYS - TRIAL_NOTICE_DAYS) * day, now - TRIAL_GRACE_DAYS * day).all();
    for (const r of rows?.results || []) {
      if (!mailAddress(r.email)) continue;
      const res = await sendOnce(env, `trial-soon:${r.id}`, r.email, trialEndingMail({ origin: r.origin, plan: r.plan, endsAt: trialEndsAt(r.created_at, TRIAL_GRACE_DAYS), dashboard: env.CLOUD_DASHBOARD || 'https://app.kilncms.com' }));
      if (res.ok) sent++;
    }
  } catch (e) {
    console.warn(JSON.stringify({ evt: 'trial_reminders_failed', err: String(e?.message || e).slice(0, 200) }));
  }
  return sent;
}

export async function expireStaleTrials(env) {
  if (!env.kiln_cloud) return;
  await remindEndingTrials(env);
  const cutoff = Date.now() - TRIAL_GRACE_DAYS * 86400 * 1000;
  // Read what is about to expire first, so the operator hears WHICH sites went
  // quiet, and each owner can be told. The cron is the only writer of this
  // transition, so the gap between the read and the write cannot double-report.
  let expiring = null;
  try {
    expiring = await env.kiln_cloud.prepare(
      `SELECT s.id, s.repo, s.origin, s.plan, a.email FROM sites s LEFT JOIN accounts a ON a.id = s.account_id
       WHERE s.status = 'trialing' AND s.ls_subscription_id IS NULL AND s.created_at < ?`
    ).bind(cutoff).all();
  } catch { /* a reduced D1 stand-in has no .all(): expiry still proceeds, just unannounced */ }
  await env.kiln_cloud.prepare(
    "UPDATE sites SET status = 'canceled' WHERE status = 'trialing' AND ls_subscription_id IS NULL AND created_at < ?"
  ).bind(cutoff).run();
  const rows = expiring?.results || [];
  if (rows.length) {
    await notifyOwner(env, `Kiln: ${rows.length} trial${rows.length === 1 ? '' : 's'} expired unpaid`, rows.map(r => `${r.repo} (${r.origin})`));
    // The owner of each is told too, once: the trial used to end in silence.
    for (const r of rows.slice(0, MAILS_PER_RUN)) {
      if (r.id && mailAddress(r.email)) await sendOnce(env, `trial-ended:${r.id}`, r.email, trialEndedMail({ origin: r.origin, plan: r.plan, dashboard: env.CLOUD_DASHBOARD || 'https://app.kilncms.com' }));
    }
  }
}

/**
 * Is this dashboard session the operator? Identity is GitHub's numeric user
 * id (CLOUD_ADMIN_ID): a login can be renamed, and the old name is then free
 * for anyone to register. The login (CLOUD_ADMIN) is compared only when no id
 * is configured, so a worker set up before this keeps working until it is.
 * With an id configured, a session that carries none (signed in before the id
 * was recorded) is not the operator: sign in again.
 */
export function isCloudAdmin(sess, env) {
  if (!sess) return false;
  if (withoutGitHub(sess)) return false;   // the operator is a GitHub person: a Google sign-in is never the operator
  const id = String(env.CLOUD_ADMIN_ID || '').trim();
  if (id) return /^\d+$/.test(id) && sess.uid != null && String(sess.uid) === id;
  return !!env.CLOUD_ADMIN && sess.login === env.CLOUD_ADMIN;
}

// When Kiln was added to each site's repository from the dashboard (or found
// already there). The columns arrive with migration 0003; a database it has
// not reached answers as if nothing were recorded, and nothing else changes.
async function preparedTimes(env, accountId) {
  const read = async (cols) => {
    const rows = await env.kiln_cloud.prepare(`SELECT id, ${cols} FROM sites WHERE account_id = ?`).bind(accountId).all();
    return Object.fromEntries((rows?.results || []).map(r => [r.id, { prepared_at: r.prepared_at || null, firstpass_at: r.firstpass_at || null }]));
  };
  // Each column arrives with its own migration (0003, 0004): ask for both,
  // then for the older one alone, then answer that nothing is recorded.
  try { return await read('prepared_at, firstpass_at'); } catch { /* 0004 has not reached this database */ }
  try { return await read('prepared_at'); } catch { return {}; }
}
export async function markPrepared(env, siteId, commit) {
  try {
    await env.kiln_cloud.prepare('UPDATE sites SET prepared_at = COALESCE(prepared_at, ?), prepared_commit = COALESCE(?, prepared_commit) WHERE id = ?').bind(Date.now(), commit || null, siteId).run();
  } catch { /* the repository is prepared all the same; the dashboard offers the button again and is told so */ }
}
export async function markFirstPass(env, siteId, commit) {
  try {
    await env.kiln_cloud.prepare('UPDATE sites SET firstpass_at = COALESCE(firstpass_at, ?), firstpass_commit = COALESCE(?, firstpass_commit) WHERE id = ?').bind(Date.now(), commit || null, siteId).run();
  } catch { /* the pages are marked all the same; the dashboard offers the button again and is told there is nothing left */ }
}

/**
 * The site a dashboard request names, checked once for every route that reads
 * or changes a site's repository for its owner (GET ?site=<id>, or POST with
 * { id } in the body). In order: the person is signed in; the site is on
 * their account; it may be edited (a trial that ran out, or a plan that
 * ended, stops this as it stops editing); the person may still change the
 * repository (asked again, because that can have changed since the site was
 * added); and the Kiln app can reach the repository. The answer is
 * { site, token, write, body, access } or { response }, the refusal to send back.
 *
 * A route that only reads, and has something to say about a site that may
 * not be edited or that the app cannot reach, asks for `needAccess: false`
 * or `needToken: false`. It is then handed `access` (false when editing is
 * switched off) and `token` (null when the app cannot reach the repository)
 * and answers for itself.
 */
async function ownedSite(request, env, url, sess, tools = {}, { needToken = true, needAccess = true } = {}) {
  if (!sess) return { response: json({ error: 'not signed in' }, 401) };
  const write = request.method === 'POST';
  const body = write ? await request.json().catch(() => ({})) : {};
  // A POST names the site `id`. `site` is taken too: it is the word the design of the domain routes uses.
  const id = write ? (body.id ?? body.site) : url.searchParams.get('site');
  // A site whose files Kiln keeps (`kept = 1`, keeps.js) belongs to the account
  // on its row, however that account signs in, and GitHub is not asked about it.
  const kept = await keptSite(env, id);
  const mine = !!kept && kept.account_id === sess.account_id;
  // A person signed in with Google has no GitHub account, so there is no
  // repository they could be checked against. A kept site of their own is the
  // only site they reach, and every other one is refused.
  if (withoutGitHub(sess) && !mine) return { response: json({ error: NEEDS_GITHUB_FOR_SITE, code: 'needs_github' }, 403) };
  const site = await withAccessUntil(
    () => env.kiln_cloud.prepare('SELECT id, repo, origin, plan, status, access_until FROM sites WHERE id = ? AND account_id = ?').bind(id || '', sess.account_id).first(),
    () => env.kiln_cloud.prepare('SELECT id, repo, origin, plan, status FROM sites WHERE id = ? AND account_id = ?').bind(id || '', sess.account_id).first(),
  );
  if (!site) return { response: json({ error: 'That site is not on this account.', code: 'no_such_site' }, 404) };
  const access = siteHasAccess(site);
  if (!access && needAccess) {
    return { response: json({ error: 'Editing is switched off for this site, so Kiln cannot change its repository. Subscribe on the site\'s row, then try again.', code: 'plan_ended' }, 403) };
  }
  const owner = String(site.repo).split('/')[0].toLowerCase();
  if (!mine && !(owner === String(sess.login || '').toLowerCase() || await userCanPush(sess.gh, site.repo))) return { response: json({ error: NOT_YOUR_REPO, code: 'not_yours' }, 403) };
  let token = null;
  if (typeof tools.installationToken === 'function') {
    try { token = await tools.installationToken(env, site.repo); }
    catch (e) { if (needToken) throw e; }   // a route that answers without it says so itself
  }
  if (!token && needToken) return { response: json({ error: prepareSentence('no_access', { repo: site.repo }), code: 'no_access', install_url: INSTALL_URL }, 409) };
  return { site, token, write, body, access };
}

/**
 * The last step of a Google sign-in to the dashboard. index.js's
 * /google/callback hands it over when the state it kept says
 * `for: 'dashboard'` (written by /cloud/login/google below), together with
 * `identity`: its own swap of Google's code for who the person is, so there is
 * one copy of that. Only an address Google has confirmed is taken. The person
 * then goes back to the dashboard with `#kc_token=<sid>`, exactly as after a
 * GitHub sign-in, and the session says there is no GitHub person behind it.
 * Anything that goes wrong is a plain page with the way back to the dashboard.
 * Called with no `identity`, Google sent the person back without a sign-in.
 */
export async function googleDashboardSignIn(env, state, { identity = null, page = plainPage } = {}) {
  const dash = (state && state.dash) || env.CLOUD_DASHBOARD || 'https://app.kilncms.com';
  const refuse = (trouble, detail = '') => {
    console.warn(JSON.stringify({ evt: 'cloud_signin_not_finished', stage: `google_${trouble.code}`, detail: String(detail || '').slice(0, 160) }));
    return page(troubleBody(forDashboard(trouble), { dashboard: dash }), trouble.status);
  };
  if (typeof identity !== 'function') return refuse(DASHBOARD_SIGN_IN_STOPPED);
  const who = await identity();
  if (!who || who.trouble) return refuse((who && who.trouble) || DASHBOARD_SIGN_IN_STOPPED);
  const info = who.info || {};
  const sub = String(info.sub || '').trim();
  const email = mailAddress(String(info.email || '').toLowerCase());
  if (!sub || !email || String(info.email_verified) !== 'true') return refuse(UNCONFIRMED_GOOGLE);
  const name = String(info.name || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120) || null;
  let account;
  try { account = await googleAccount(env, { sub, email, name }); }
  catch (e) { return refuse(ACCOUNT_NOT_READY, e && e.message); }
  const sid = uuid();
  await env.KILN.put(`csess:${sid}`, JSON.stringify({ account_id: account.id, login: null, uid: null, gh: null, google: { sub, email, name } }), { expirationTtl: 30 * 24 * 3600 });
  return Response.redirect(`${dash}#kc_token=${sid}`, 302);   // the dashboard reads and keeps this, as after a GitHub sign-in
}

// ─── Router ───────────────────────────────────────────────────────────────────

export async function handleCloud(request, env, url, path, tools = {}) {
  const dash = env.CLOUD_DASHBOARD || 'https://app.kilncms.com';

  // GitHub OAuth — identity only.
  if (path === '/cloud/login') {
    const c = await creds(env);
    const nonce = uuid();
    await env.KILN.put(`cstate:${nonce}`, '1', { expirationTtl: 600 });
    const params = new URLSearchParams({ client_id: c.client_id, redirect_uri: `${url.origin}/cloud/callback`, state: nonce });
    return Response.redirect(`https://github.com/login/oauth/authorize?${params}`, 302);
  }

  // The same for a person with no GitHub account: Google says who they are.
  // Google sends them back to /google/callback (index.js), the one address it
  // already has for this service, and the state kept here says the sign-in is
  // for the dashboard, so that callback hands it to googleDashboardSignIn.
  // Where the person goes back to is this service's own setting, as it is for
  // /cloud/login: nothing in the request can name another place.
  if (path === '/cloud/login/google') {
    const page = typeof tools.page === 'function' ? tools.page : plainPage;
    if (!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET)) return page(troubleBody(NO_GOOGLE_SIGN_IN, { dashboard: dash }), NO_GOOGLE_SIGN_IN.status);
    const nonce = uuid();
    await env.KILN.put(`gstate:${nonce}`, JSON.stringify({ for: 'dashboard', dash }), { expirationTtl: 600 });
    const params = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID, redirect_uri: `${url.origin}/google/callback`, response_type: 'code',
      scope: 'openid email profile', state: nonce, prompt: 'select_account',
    });
    return Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`, 302);
  }

  if (path === '/cloud/callback') {
    // A sign-in that does not finish goes back to the dashboard, which says so
    // and offers the button again: the person used to be left on a line of
    // JSON. Why it failed is logged for the operator.
    const notFinished = (stage, detail = '') => {
      console.warn(JSON.stringify({ evt: 'cloud_signin_not_finished', stage, detail: String(detail).slice(0, 160) }));
      try { const back = new URL(dash); back.searchParams.set('signin', 'again'); return Response.redirect(back.toString(), 302); }
      catch { return json({ error: 'github sign-in failed' }, 401); }
    };
    const code = url.searchParams.get('code'), state = url.searchParams.get('state');
    if (!code || !state || !(await env.KILN.get(`cstate:${state}`))) return notFinished('state');
    await env.KILN.delete(`cstate:${state}`);
    const c = await creds(env);
    const tokRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: c.client_id, client_secret: c.client_secret, code }),
    });
    const tok = await tokRes.json().catch(() => ({}));
    if (!tok.access_token) return notFinished('token', tok.error || tokRes.status);
    const user = await ghUser(tok.access_token, { fresh: true });
    if (!user) return notFinished('user');
    const account = await upsertAccount(env, user.login, user.email);
    const sid = uuid();
    // Keep the user's OAuth token server-side (never sent to the browser) so
    // /cloud/sites can verify the signer actually has push on the repo they're
    // registering — installation-existence is not authorization.
    // `uid` is GitHub's numeric user id: unlike the login, it cannot be
    // renamed away or registered by someone else later.
    await env.KILN.put(`csess:${sid}`, JSON.stringify({ account_id: account.id, login: user.login, uid: user.id ?? null, gh: tok.access_token || null }), { expirationTtl: 30 * 24 * 3600 });
    return Response.redirect(`${dash}#kc_token=${sid}`, 302);   // dashboard reads + stores this
  }

  // Everything below needs a dashboard session (Authorization: Bearer <token>).
  const sess = await session(request, env);

  if (path === '/cloud/logout' && request.method === 'POST') {
    const sid = bearer(request);
    if (sid) await env.KILN.delete(`csess:${sid}`);
    return json({ ok: true });
  }

  if (path === '/cloud/me') {
    if (!sess) return json({ error: 'not signed in' }, 401);
    // `name` and `google_sub` arrive with migration 0008. A database it has not
    // reached has neither, and every account there signed in with GitHub.
    let row;
    try { row = await env.kiln_cloud.prepare('SELECT id, github_login, email, ls_customer_id, name, google_sub FROM accounts WHERE id = ?').bind(sess.account_id).first(); }
    catch { row = await env.kiln_cloud.prepare('SELECT id, github_login, email, ls_customer_id FROM accounts WHERE id = ?').bind(sess.account_id).first(); }
    // `google` says the person signs in with Google. Google's id for them stays here.
    const account = row ? { id: row.id, github_login: row.github_login || null, email: row.email ?? null, ls_customer_id: row.ls_customer_id ?? null, name: row.name || null, google: !!row.google_sub } : null;
    const sites = await withAccessUntil(
      () => env.kiln_cloud.prepare('SELECT id, repo, origin, plan, status, access_until, created_at, ls_subscription_id FROM sites WHERE account_id = ? ORDER BY created_at DESC').bind(sess.account_id).all(),
      () => env.kiln_cloud.prepare('SELECT id, repo, origin, plan, status, created_at, ls_subscription_id FROM sites WHERE account_id = ? ORDER BY created_at DESC').bind(sess.account_id).all(),
    );
    // `editable` is the worker's own answer, so the dashboard never has to
    // work out for itself what a status plus a date means. `trial_ends` is the
    // moment the free days run out for a site nobody has subscribed for yet
    // (the same rule expireStaleTrials applies); `subscribed` says a Lemon
    // Squeezy subscription exists, without handing its id to the browser.
    const now = Date.now();
    const prepared = await preparedTimes(env, sess.account_id);
    const whole = Object.fromEntries((sites.results || []).map(s => [s.id, s]));   // each row as read, for what hosting has to say
    const rows = (sites.results || []).map(({ ls_subscription_id: sub, ...r }) => ({
      ...r,
      prepared_at: prepared[r.id]?.prepared_at ?? null,
      firstpass_at: prepared[r.id]?.firstpass_at ?? null,
      editable: siteHasAccess(r, now),
      subscribed: !!sub,
      trial_ends: r.status === 'trialing' && !sub && Number(r.created_at) ? Number(r.created_at) + TRIAL_GRACE_DAYS * 86400 * 1000 : null,
    }));
    // Which Kiln editor each site has (`editor_build`) and which one is released
    // (`editor_latest`), so the dashboard can offer an update without reading a
    // repository (update.js). Either is null when it is not known.
    const editors = await editorStanding(env, rows.map(r => r.repo), env.KILN_RELEASE_BASE).catch(() => ({ latest: null, builds: {} }));
    for (const r of rows) r.editor_build = editors.builds[r.repo] ?? null;
    // Where each hosted site stands (hosted.js), and whether this service hosts sites at all.
    const hosted = hostingOn(env) ? await hostingForAccount(env, sess.account_id) : {};
    for (const r of rows) r.hosting = await shownHosting(env, hosted[r.id], whole[r.id], now);
    // What Kiln did for a hosted site when it was first put up (lookafter.js), while that is kept.
    await Promise.all(rows.filter(r => r.hosting).map(async (r) => { const care = await lookedAfter(env, r.id); if (care) r.looked_after = care; }));
    // `prepare`, `firstpass`: this service can add Kiln to a repository itself, and mark a first pass of what can be edited.
    const can = typeof tools.installationToken === 'function';
    // `domains`: this service can put a hosted site on its owner's own domain. Each site's `domain` says where
    // that stands (domain.js), without the records Kiln kept, which the site's own panel asks for.
    const domains = can && await domainsAvailable(env);
    const owned = domains ? await domainsForAccount(env, sess.account_id) : {};
    for (const r of rows) r.domain = publicDomain(owned[r.id] || null, { records: false });
    // `forwarding`: this service can forward one email address at a site's own domain to an inbox its owner already reads.
    // Each site's `forward` says where that stands (domain-mail.js), or is null.
    const forwarding = !!domains && await forwardsReady(env);
    const forwards = forwarding ? await forwardsForAccount(env, sess.account_id) : {};
    for (const r of rows) r.forward = publicForward(forwards[r.id] || null);
    // A domain that came with email of its own is never forwarded for, and the site's row says so instead of offering it.
    if (forwarding) for (const r of rows) if (r.domain && mailStop(owned[r.id]) === 'has_own_mail') r.domain.own_mail = true;
    // `keeps`: this service can start a site whose files Kiln keeps, for someone with no GitHub account (keeps.js).
    // Each such site says `kept`.
    const keptHere = await keptIds(env, sess.account_id);
    for (const r of rows) if (keptHere.has(r.id)) r.kept = true;
    return json({ account, sites: rows, billing: lsConfigured(env), mail: customerMailOn(env), prepare: can, firstpass: can, editor_latest: editors.latest, hosting: can && hostingOn(env), domains, forwarding, keeps: can && keepsReady(env) });
  }

  // The address notices about the account's own sites go to (mail.js). The
  // account starts with whatever GitHub shows for the person, which is often
  // nothing; this is how they give one, change it, or take it away.
  if (path === '/cloud/account' && request.method === 'POST') {
    if (!sess) return json({ error: 'not signed in' }, 401);
    const { email } = await request.json().catch(() => ({}));
    const clean = email === '' || email === null ? null : mailAddress(email);
    if (email !== '' && email !== null && !clean) return json({ error: 'That does not look like an email address. Please check it and try again.' }, 400);
    await env.kiln_cloud.prepare('UPDATE accounts SET email = ? WHERE id = ?').bind(clean, sess.account_id).run();
    return json({ ok: true, email: clean });
  }

  if (path === '/cloud/sites' && request.method === 'POST') {
    if (!sess) return json({ error: 'not signed in' }, 401);
    // A person signed in with Google has no GitHub account to own a repository with.
    if (withoutGitHub(sess)) return json({ error: NEEDS_GITHUB_TO_ADD, code: 'needs_github' }, 403);
    const { repo, origin, plan, email } = await request.json().catch(() => ({}));
    if (!repo || !origin) return json({ error: 'Enter both the repository and the live site address.' }, 400);
    if (email !== undefined && email !== null && email !== '' && !mailAddress(email)) return json({ error: 'That does not look like an email address. Please check it and try again.' }, 400);
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return json({ error: 'The repository should look like owner/name, for example acme/website.' }, 400);
    // A repository in the organization where Kiln keeps sites' files is nobody's to add: such a site is started, never added.
    if (inKeepOrg(env, repo)) return json({ error: keepSentence('in_keep_org'), code: 'in_keep_org' }, 403);
    let o; try { o = new URL(origin).origin; } catch { return json({ error: 'The live site address should be a full web address, such as https://yoursite.com.' }, 400); }
    // Ownership: the signer must actually own/push this repo. Installation
    // existence is NOT authorization. A repo under the signer's own account
    // (owner === their login) is theirs by definition; otherwise (an org repo)
    // verify push via their token. The owner-match first means an expired user
    // token can't wrongly block someone registering their own personal repo.
    const owner = repo.split('/')[0].toLowerCase();
    const ownsIt = owner === String(sess.login || '').toLowerCase() || await userCanPush(sess.gh, repo);
    if (!ownsIt) {
      return json({ error: NOT_YOUR_REPO }, 403);
    }
    if (!(await repoInstalled(env, repo))) {
      return json({ error: 'The Kiln app is not installed on that repository yet.', install_url: INSTALL_URL }, 409);
    }
    const dupe = await env.kiln_cloud.prepare('SELECT id FROM sites WHERE origin = ?').bind(o).first();
    if (dupe) return json({ error: 'That site address is already on Kiln Cloud. If it is yours and you cannot see it here, write to info@kilncms.com.' }, 409);
    const site = await registerSite(env, { accountId: sess.account_id, repo, origin: o, plan });
    // An address given with the form becomes the account's address for notices.
    if (mailAddress(email)) { try { await env.kiln_cloud.prepare('UPDATE accounts SET email = ? WHERE id = ?').bind(mailAddress(email), sess.account_id).run(); } catch { /* the site is added either way */ } }
    const to = await accountEmail(env, sess.account_id);
    const checkout = await lsCheckout(env, site, { email: to });
    await sendOnce(env, `added:${site.id}`, to, siteAddedMail({ origin: site.origin, plan: site.plan, endsAt: trialEndsAt(site.created_at, TRIAL_GRACE_DAYS), dashboard: dash }));
    await notifyOwner(env, `New Kiln site: ${site.repo}`, [
      `Plan: ${site.plan} (trialing)`,
      `Origin: ${site.origin}`,
      `Registered by: ${signedInAs(sess)}`,
      checkout ? 'A checkout link was issued.' : 'No checkout: billing is not configured.',
    ]);
    return json({ ok: true, site, checkout });   // checkout null until LS is configured
  }

  // Start a site whose files Kiln keeps (keeps.js), for someone with no GitHub
  // account: a private repository in Kiln's own organization, filled with the
  // starter site and registered to this account. The dashboard then puts it on
  // Kiln's hosting with the route it has for that, as for any site.
  if (path === '/cloud/sites/start' && request.method === 'POST') {
    if (!sess) return json({ error: 'not signed in' }, 401);
    const { name } = await request.json().catch(() => ({}));
    const out = await startKept(env, {
      accountId: sess.account_id, name, worker: url.origin, by: signedInAs(sess), sign: appJwt, pkcs1: tools.pkcs1 || null,
      register: ({ id, repo, origin }) => registerSite(env, { id, accountId: sess.account_id, repo, origin, plan: 'managed', kept: true }),
      forget: (id) => env.kiln_cloud.prepare('DELETE FROM sites WHERE id = ? AND account_id = ? AND kept = 1').bind(id, sess.account_id).run(),
      note: (subject, lines) => notifyOwner(env, subject, lines),
    });
    if (!out.ok) return json({ error: out.error, code: out.code }, out.status);
    // The site in the form /cloud/me lists it, from /cloud/me's own code, so the two can never differ.
    let site = null;
    try {
      const me = new URL('/cloud/me', url);
      const listed = await handleCloud(new Request(me, { headers: { Authorization: request.headers.get('Authorization') || '' } }), env, me, '/cloud/me', tools);
      site = ((await listed.json()).sites || []).find(s => s.id === out.site.id) || null;
    } catch { /* the plain row, below */ }
    return json({ ok: true, site: site || { ...out.site, kept: true } });
  }

  // Add Kiln to the site's repository (prepare.js), so nobody needs a terminal.
  // GET says what would change and writes nothing; POST makes the change, as
  // one commit in the account holder's name.
  if (path === '/cloud/sites/prepare' && (request.method === 'GET' || request.method === 'POST')) {
    const asked = await ownedSite(request, env, url, sess, tools);
    if (asked.response) return asked.response;
    const { site, token, write } = asked;
    const refused = (code, status, extra = {}) => json({ error: prepareSentence(code, { repo: site.repo, ...extra }), code, ...extra }, status);

    // One at a time for a site: two tabs pressing the button make one commit.
    const lock = `preplock:${site.id}`;
    if (write) {
      if (await env.KILN.get(lock)) return refused('busy', 409);
      await env.KILN.put(lock, '1', { expirationTtl: 120 });
    }
    try {
      // A site Kiln hosts is also looked at for pages and page templates that
      // do not say which character set they are written in: Kiln's hosting
      // does not say it for them (lookafter.js). The pages are read once for
      // both. A site Kiln does not host is asked nothing more than before.
      const hosted = hostingOn(env) && !!(await hostingRow(env, site.id));
      const read = hosted ? await readPages({ token, repo: site.repo }) : null;
      const plan = await planPrepare({ token, repo: site.repo, worker: url.origin, read });
      const charset = hosted && (plan.state === 'ready' || plan.state === 'prepared') ? await planCharset({ token, repo: site.repo, read }) : null;
      const owed = !!charset && charset.state === 'ready';
      const shown = { ...publicPlan(plan, { repo: site.repo }), ...(charset ? { charset: publicCharset(charset) } : {}) };
      const author = await commitAuthor(env, sess);
      // The character-set line is its own commit, as it is when a site first
      // goes on Kiln's hosting: the commit says the one thing it does, a site
      // made ready either way has the same history, and if one of the two
      // cannot be made the other still stands. Never throws: { commit } or { code }.
      const addCharset = async (from) => {
        try {
          const done = await applyCharset({ token, repo: site.repo, plan: from, author, asked: 'from the dashboard' });
          await notifyOwner(env, `Character set named on the pages of ${site.repo}`, [`By: ${signedInAs(sess)}, from the dashboard`, `Pages: ${done.pages}. Page templates: ${done.templates}`, done.url]);
          return { commit: { sha: done.sha, url: done.url } };
        } catch (e) {
          const code = e instanceof PrepareError ? e.code : 'github';
          console.warn(JSON.stringify({ evt: 'charset_failed', repo: site.repo, code, detail: e instanceof PrepareError ? e.detail : String(e?.message || e).slice(0, 200) }));
          return { code };
        }
      };
      if (plan.state === 'no_access') return refused('no_access', 409, { install_url: INSTALL_URL });
      if (plan.state === 'github') return refused('github', 502);
      if (plan.state === 'prepared') {
        await markPrepared(env, site.id, null);
        if (!owed) return json({ ok: true, ...shown });
        // Kiln is on every page, and the character-set line is still to add:
        // that is what the button's one press does.
        if (!write) return json({ ok: true, ...shown, state: 'ready' });
        const out = await addCharset(charset);
        if (out.code) {
          return json({ error: charsetSentence(out.code, { repo: site.repo, branch: charset.branch }), code: out.code, ...(out.code === 'protected' ? { branch: charset.branch } : {}) },
            out.code === 'moved' || out.code === 'protected' ? 409 : 502);
        }
        return json({ ok: true, ...shown, state: 'done', commit: out.commit, charset: { ...publicCharset(charset, { done: true }), commit: out.commit } });
      }
      if (plan.state !== 'ready') {
        // A site this cannot take: say why, and what does take it.
        const body = { ok: false, ...shown, error: prepareSentence(plan.state, { repo: site.repo, generator: plan.generator }), code: plan.state,
          ...(plan.state === 'built' || plan.state === 'too_big' ? { command: SETUP_COMMAND } : {}) };
        return json(body, write ? 409 : 200);
      }
      if (!write) return json({ ok: true, ...shown });

      let done;
      try {
        done = await applyPrepare({
          token, repo: site.repo, worker: url.origin, plan, author,
          ...(env.KILN_RELEASE_BASE ? { releaseBase: env.KILN_RELEASE_BASE } : {}),
        });
      } catch (e) {
        const code = e instanceof PrepareError ? e.code : 'github';
        console.warn(JSON.stringify({ evt: 'prepare_failed', repo: site.repo, code, detail: e instanceof PrepareError ? e.detail : String(e?.message || e).slice(0, 200) }));
        return refused(code, code === 'moved' || code === 'protected' ? 409 : 502, code === 'protected' ? { branch: plan.branch, command: SETUP_COMMAND } : {});
      }
      await markPrepared(env, site.id, done.sha);
      await notifyOwner(env, `Kiln added to ${site.repo}`, [
        `By: ${signedInAs(sess)}, from the dashboard`,
        `Pages: ${done.pages}. Page templates: ${done.templates || 0}. Files: ${done.files.join(', ') || 'none'}`,
        done.url,
      ]);
      // Then the character-set line, on the repository as adding Kiln left it.
      // If it cannot be added now, Kiln is added all the same: the answer
      // says so, and the button offers the line again.
      let line = null;
      if (owed) {
        const again = await planCharset({ token, repo: site.repo });
        if (again.state === 'ready') {
          const out = await addCharset(again);
          line = out.code
            ? { ...publicCharset(again), state: 'not_done', code: out.code, error: charsetSentence(out.code, { repo: site.repo, branch: again.branch }) }
            : { ...publicCharset(again, { done: true }), commit: out.commit };
        } else if (again.state === 'nothing') line = publicCharset(again);
        else line = { ...shown.charset, state: 'not_done', code: again.state, error: charsetSentence(again.state, { repo: site.repo, generator: again.generator, branch: again.branch }) };
      }
      return json({ ok: true, ...shown, state: 'done', commit: { sha: done.sha, url: done.url }, ...(line ? { charset: line } : {}) });
    } finally {
      if (write) { try { await env.KILN.delete(lock); } catch { /* it runs out by itself in two minutes */ } }
    }
  }

  // A first pass at what can be edited (firstpass.js): the setup tool's
  // cautious pass over every page, with one press. GET says what it would
  // mark and writes nothing; POST marks it, as one commit in the owner's name.
  if (path === '/cloud/sites/firstpass' && (request.method === 'GET' || request.method === 'POST')) {
    const asked = await ownedSite(request, env, url, sess, tools);
    if (asked.response) return asked.response;
    const { site, token, write } = asked;
    const sentence = (code, extra = {}) => firstPassSentence(code, extra) || prepareSentence(code, { repo: site.repo, ...extra });
    const refused = (code, status, extra = {}) => json({ error: sentence(code, extra), code, ...extra }, status);
    const lock = `fplock:${site.id}`;
    if (write) {
      if (await env.KILN.get(lock)) return refused('busy', 409);
      await env.KILN.put(lock, '1', { expirationTtl: 120 });
    }
    try {
      const plan = await planFirstPass({ token, repo: site.repo });
      const shown = publicFirstPass(plan, { repo: site.repo });
      if (plan.state === 'no_access') return refused('no_access', 409, { install_url: INSTALL_URL });
      if (plan.state === 'github') return refused('github', 502);
      if (plan.state === 'nothing') {
        await markFirstPass(env, site.id, null);
        return json({ ok: true, ...shown });
      }
      if (plan.state !== 'ready') {
        return json({ ok: false, ...shown, error: sentence(plan.state, { generator: plan.generator }), code: plan.state }, write ? 409 : 200);
      }
      if (!write) return json({ ok: true, ...shown });

      const author = await commitAuthor(env, sess);
      let done;
      try {
        done = await applyFirstPass({ token, repo: site.repo, plan, author });
      } catch (e) {
        const code = e instanceof PrepareError ? e.code : 'github';
        console.warn(JSON.stringify({ evt: 'firstpass_failed', repo: site.repo, code, detail: e instanceof PrepareError ? e.detail : String(e?.message || e).slice(0, 200) }));
        return refused(code, code === 'moved' || code === 'protected' ? 409 : 502, code === 'protected' ? { branch: plan.branch } : {});
      }
      await markFirstPass(env, site.id, done.sha);
      return json({ ok: true, ...shown, state: 'done', commit: { sha: done.sha, url: done.url } });
    } finally {
      if (write) { try { await env.KILN.delete(lock); } catch { /* it runs out by itself in two minutes */ } }
    }
  }

  // Hosting (the Kiln Cloud + hosting plan): the site's files are copied from
  // its repository to Kiln's Cloudflare and served there. GET says where a
  // site stands; POST puts it up for the first time, or publishes it again.
  // A site that has never been up is looked after first (lookafter.js): Kiln's
  // files, a character set on every page and a first pass at what can be
  // edited, so the first copy already holds them. `looked_after` says how each
  // went; none of it can stop the site from being put up. A step that was not
  // done is still owed, and while it is, publishing again tries it again.
  if (path === '/cloud/sites/hosting' && (request.method === 'GET' || request.method === 'POST')) {
    const write = request.method === 'POST';
    const asked = await ownedSite(request, env, url, sess, tools, write ? {} : { needToken: false, needAccess: false });
    if (asked.response) return asked.response;
    const { site, token } = asked;
    const available = hostingOn(env);
    const row = available ? await hostingRow(env, site.id) : null;
    if (!write) {
      const care = row ? await lookedAfter(env, site.id) : null;
      // A hosted site that may not be edited any more: the rest of its row says when it comes down.
      const rest = row && !asked.access
        ? await env.kiln_cloud.prepare('SELECT created_at, ls_subscription_id FROM sites WHERE id = ?').bind(site.id).first().catch(() => null) : null;
      return json({ ok: true, available, on_plan: site.plan === 'managed', hosting: await shownHosting(env, row, { ...site, ...(rest || {}) }), ...(care ? { looked_after: care } : {}) });
    }
    if (!available) return json({ error: hostingSentence('not_set_up'), code: 'not_set_up' }, 503);
    if (site.plan !== 'managed') {
      return json({ error: 'Hosting is part of the Kiln Cloud + hosting plan. This site is on Kiln Cloud, where it stays on your own host.', code: 'not_on_plan' }, 403);
    }
    // Until an account has paid for a site, it may have this many hosted ones.
    if (!row) {
      const unpaid = await env.kiln_cloud.prepare(
        "SELECT COUNT(*) n FROM hosting h JOIN sites s ON s.id = h.site_id WHERE s.account_id = ? AND s.ls_subscription_id IS NULL AND h.state != 'removing'").bind(sess.account_id).first().catch(() => ({ n: 0 }));
      const paid = await env.kiln_cloud.prepare('SELECT COUNT(*) n FROM sites WHERE account_id = ? AND ls_subscription_id IS NOT NULL').bind(sess.account_id).first().catch(() => ({ n: 0 }));
      if (!Number(paid?.n) && Number(unpaid?.n) >= FREE_HOSTED_SITES) {
        return json({ error: `During the free days Kiln hosts ${FREE_HOSTED_SITES === 1 ? 'one site' : `${FREE_HOSTED_SITES} sites`} for an account. Subscribe for one of your sites, then put this one up.`, code: 'free_limit' }, 403);
      }
    }
    const BUSY = 'Kiln is already putting this site up. Give it a minute, then reload this page.';
    let care = null;
    if (!row || !row.deployed_at || await careOwed(env, site.id)) {
      const author = await commitAuthor(env, sess);
      care = await lookAfter(env, {
        site, token, worker: url.origin,
        author,
        firstpassAt: (await preparedTimes(env, sess.account_id))[site.id]?.firstpass_at || null,
        record: { prepared: (sha) => markPrepared(env, site.id, sha), firstPass: (sha) => markFirstPass(env, site.id, sha) },
      });
      if (!care) return json({ error: BUSY, code: 'busy' }, 409);
    }
    const looked = care ? { looked_after: care } : {};
    const out = await publishSite(env, { site, token });
    if (out.state === 'busy') return json({ error: BUSY, code: 'busy', ...looked }, 409);
    if (out.state === 'failed') return json({ error: out.error || hostingSentence(out.reason), code: out.reason || 'cloudflare', hosting: out, ...looked }, 502);
    if (out.state === 'live' && !row) {
      await notifyOwner(env, `Kiln hosts ${site.repo}`, [`By: ${signedInAs(sess)}`, `Address: ${out.url}`, `Files: ${out.files}`,
        ...(care || []).map(c => `${c.step}: ${c.state}${c.code ? ` (${c.code})` : ''}${c.commit ? ` ${c.commit.url}` : ''}`)]);
    }
    return json({ ok: out.state === 'live', hosting: out, ...looked, ...(out.state !== 'live' ? { error: out.error, code: out.reason } : {}) });
  }

  // A hosted site on its owner's own domain (domain.js). GET says where the
  // site's domain stands, or with `name` looks at a domain and changes
  // nothing. POST sets the domain up ("setup"), asks Cloudflare whether its
  // name servers have changed ("check"), or puts away a set-up that is not
  // live ("stop"). A site whose editing is switched off cannot start anything
  // new, and can still check, stop and take its records away, so nobody is
  // trapped. None of it reads the repository, so the App's token is not asked for.
  if (path === '/cloud/sites/domain' && (request.method === 'GET' || request.method === 'POST')) {
    const asked = await ownedSite(request, env, url, sess, tools, { needToken: false, needAccess: false });
    if (asked.response) return asked.response;
    const { site, body } = asked;
    const row = await domainRow(env, site.id);
    const sellerOf = (r) => (r && (r.seller || r.seller_id) ? sellerHelp({ name: r.seller, id: r.seller_id }).name : null);
    const refuse = (code, status, { name = row?.name || null, seller = sellerOf(row), ...extra } = {}) => json({ error: domainSentence(code, { name, seller }), code, ...extra }, status);
    const detail = (e) => (e instanceof DomainError ? e.detail || e.code : String(e?.message || e).slice(0, 300));

    if (request.method === 'GET') {
      const typed = url.searchParams.get('name');
      if (typed === null) return json({ ok: true, domain: publicDomain(row) });
      if (!asked.access) return refuse('plan_ended', 403);
      const { look, stop } = await lookAtDomain(env, site, typed);
      return json({ ok: true, look: publicLook(look, stop) });
    }

    const action = String(body.action || '');
    if (action === 'setup') {
      if (!asked.access) return refuse('plan_ended', 403);
      // One set-up at a time for a site, so that two presses do not make two
      // zones. The look comes after the lock: a second press that arrives as
      // the first one finishes finds the first one's row, and stops there.
      const lock = `domainlock:${site.id}`;
      if (await env.KILN.get(lock)) return refuse('busy', 409);
      await env.KILN.put(lock, '1', { expirationTtl: DOMAIN_LOCK_S });
      try {
        const { name, look, stop } = await lookAtDomain(env, site, body.name);
        const seller = look.seller ? sellerHelp(look.seller).name : null;
        if (stop) return refuse(stop, stop === 'not_a_domain' ? 400 : stop === 'not_set_up' ? 503 : 409, { name, seller });
        const failed = (e, stage) => {
          const code = e instanceof DomainError ? e.code : 'cloudflare';
          console.warn(JSON.stringify({ evt: 'domain_setup_failed', repo: site.repo, name, stage, reason: code, detail: detail(e) }));
          return refuse(code, code === 'cloudflare' ? 502 : code === 'not_set_up' ? 503 : 409, { name, seller });
        };
        const host = await hostingRow(env, site.id);
        // The site's own last set-up of this same name, put away with its zone: Cloudflare may still hold that zone, and
        // would refuse a second one for the name. domain.js takes it up again where it is there, and makes a new one where it is not.
        const before = await domainRow(env, site.id);
        const earlier = before && before.zone_id && before.name === name && before.state !== 'waiting' && before.state !== 'live' ? before.zone_id : null;
        let made;
        try { made = await prepareDomain(env, { name, worker: host.name, look, earlier }); }
        catch (e) { return failed(e, 'prepare'); }   // domain.js has taken away again whatever it made
        const again = !!earlier && made.zoneId === earlier;
        try {
          const saved = await saveDomain(env, site.id, {
            name, zone_id: made.zoneId, state: 'waiting', ns1: made.nameServers[0], ns2: made.nameServers[1], old_name_servers: made.oldNameServers,
            seller: look.seller?.name || null, seller_id: look.seller?.id || null, records: made.records,
          });
          if (!saved) throw new DomainError('not_set_up');
        } catch (e) {
          // A zone nobody remembers would wait in the hosting account with the site's two names on it: it is taken away again.
          // One that was taken up again is still remembered by the row that was put away, so it stays.
          try { if (!again) await removeWaitingDomain(env, { zoneId: made.zoneId }); }
          catch (left) { console.warn(JSON.stringify({ evt: 'domain_cleanup_failed', name, zone: made.zoneId, detail: detail(left) })); }
          return failed(e, 'record');
        }
        const fresh = await domainRow(env, site.id);
        await tellNameServers(env, sess.account_id, site, fresh);
        await notifyOwner(env, `Kiln is setting up ${name} for ${site.repo}`, [
          `By: ${signedInAs(sess)}`, ...(again ? ['This is the zone from its last set-up, taken up again. No new zone was made.'] : []), `Name servers to enter: ${made.nameServers.join(', ')}`, `Bought at: ${seller || 'not known'}`, `Records kept: ${made.records.length}`,
          'The site goes live at the domain once its owner has changed the name servers.']);
        return json({ ok: true, domain: publicDomain(fresh) });
      } finally {
        try { await env.KILN.delete(lock); } catch { /* it runs out by itself in two minutes */ }
      }
    }

    if (action === 'check') {
      if (!row) return refuse('no_domain', 404);
      const now = Date.now();
      let changed = false;
      // Only a domain that waits has anything to ask about, and Cloudflare is
      // asked once a minute at most for a site: sooner, what is known is the answer.
      if (row.state === 'waiting' && row.zone_id && now - Number(row.checked_at || 0) >= DOMAIN_CHECK_EVERY_MS) {
        let status;
        try { ({ status } = await domainStatus(env, { zoneId: row.zone_id, recheck: true })); }
        catch (e) {
          console.warn(JSON.stringify({ evt: 'domain_check_failed', repo: site.repo, name: row.name, detail: detail(e) }));
          return refuse('not_asked', 502, { domain: publicDomain(row) });
        }
        try { await saveDomain(env, site.id, { checked_at: now }); } catch { /* the answer is right all the same; the next press asks again */ }
        if (status === 'active') changed = !(await domainTookHold(env, { site, row, now })).live;
      }
      const fresh = await domainRow(env, site.id);
      // `changed`: Cloudflare has seen the new name servers, and the site is not live at the domain yet.
      return json({ ok: true, domain: publicDomain(fresh), ...(changed && fresh && fresh.state === 'waiting' ? { changed: true } : {}) });
    }

    if (action === 'stop') {
      if (!row) return json({ ok: true, domain: null });   // nothing is set up, which is what was asked for
      if (row.state === 'live') return refuse('is_live', 409, { domain: publicDomain(row) });
      if (row.zone_id) {
        let gone;
        // domain.js takes a zone away only while it still waits: one that has taken hold may be answering for somebody's email.
        try { gone = await removeWaitingDomain(env, { zoneId: row.zone_id }); }
        catch (e) {
          console.warn(JSON.stringify({ evt: 'domain_stop_failed', repo: site.repo, name: row.name, detail: detail(e) }));
          return refuse('not_asked', 502, { domain: publicDomain(row) });
        }
        // The name servers were changed while this waited. The zone answers for the domain now, so the set-up is not thrown away.
        if (row.state === 'waiting' && !gone.removed && gone.status === 'active') return refuse('changed', 409, { domain: publicDomain(row) });
      }
      await forgetDomain(env, site.id);
      return json({ ok: true, domain: null });
    }

    return refuse('bad_action', 400);
  }

  // One forwarded email address at a hosted site's own domain (domain-mail.js):
  // what stands and whether it is offered (GET), and setting it up, asking
  // whether the inbox has confirmed, having the confirmation email sent again,
  // and stopping it (POST). With editing switched off nothing new is set up,
  // and what was asked for earlier can still be looked at, finished and stopped.
  if (path === '/cloud/sites/mail' && (request.method === 'GET' || request.method === 'POST')) {
    const asked = await ownedSite(request, env, url, sess, tools, { needToken: false, needAccess: false });
    if (asked.response) return asked.response;
    const { site, body } = asked;
    let row = await forwardRow(env, site.id);
    const refuse = (code, status, { address = row?.address || null, inbox = row?.inbox || null, name = null, ...extra } = {}) => json({ error: mailSentence(code, { address, inbox, name }), code, ...extra }, status);

    if (request.method === 'GET') {
      const can = await forwardingAvailable(env);
      const domain = can ? await domainRow(env, site.id) : null;
      const stop = !can ? 'not_set_up' : forwardStop(domain) || (asked.access ? null : 'plan_ended');
      // A parked domain says "no mail here". Forwarding replaces the two records that say so (domain-mail.js switchMailOn), and the look says so first.
      const note = !stop && !row && saysNoMail(keptRecords(domain), domain.name) ? mailSentence('says_no_mail', { name: domain.name }) : null;
      return json({ ok: true, forward: publicForward(row), offered: !stop, why: stop ? mailSentence(stop, { name: domain?.name || null }) : null, ...(note ? { note } : {}) });
    }

    const action = String(body.action || '');
    if (!['setup', 'check', 'again', 'stop'].includes(action)) return refuse('bad_action', 400);
    if (action === 'setup' && !asked.access) return refuse('plan_ended', 403);
    // One change at a time for a site, so that two presses (or a press and the
    // five-minute job) do not make two rules. The row is read again after the
    // lock: a second press that arrives as the first one finishes finds what the first one wrote.
    const lock = forwardLock(site.id);
    if (await env.KILN.get(lock)) return refuse('busy', 409, { forward: publicForward(row) });
    await env.KILN.put(lock, '1', { expirationTtl: FORWARD_LOCK_S });
    try {
      row = await forwardRow(env, site.id);
      if (action !== 'setup' && !row) return action === 'stop' ? json({ ok: true, forward: null }) : refuse('no_forward', 404);   // stopping nothing is what was asked for
      const now = Date.now();
      const domain = await domainRow(env, site.id);
      const name = domain?.name || null;
      const live = domain?.state === 'live' && !!domain.zone_id;
      const standing = async (extra = {}) => json({ ok: true, forward: publicForward(await forwardRow(env, site.id)), ...extra });
      const failed = async (e, stage, extra = {}) => {
        const code = e instanceof MailError && FORWARD_STATUS[e.code] ? e.code : 'cloudflare';
        console.warn(JSON.stringify({ evt: 'forward_failed', repo: site.repo, action, stage, reason: code, detail: whyMail(e) }));
        return refuse(code, FORWARD_STATUS[code], { name, forward: publicForward(await forwardRow(env, site.id)), ...extra });
      };
      // The inbox has confirmed: the rule is made, and the account's own address is written to.
      const switchOn = async (waiting, inboxId) => {
        const account = await env.kiln_cloud.prepare('SELECT email FROM accounts WHERE id = ?').bind(sess.account_id).first();
        await forwardingOn(env, { s: { id: site.id, repo: site.repo, email: account?.email }, row: waiting, zoneId: domain.zone_id, inboxId, now });
      };

      // All the hosted domains share one Cloudflare account, so an inbox that confirmed there confirmed for every customer at once.
      // A rule is made only for an inbox this Kiln account has shown to be its own (domain-mail.js ownsInbox). A waiting row that fails that stops here.
      const mine = (inbox) => ownsInbox(env, { accountId: sess.account_id, inbox });
      const elsewhere = async () => {
        // A first set-up stops here. A change that waited is dropped, and the address that works beside it stays on.
        await saveForward(env, site.id, whatWaits(row)?.change ? NO_CHANGE : { state: 'failed', reason: 'inbox_elsewhere' });
        console.warn(JSON.stringify({ evt: 'forward_failed', repo: site.repo, action, stage: 'inbox', reason: 'inbox_elsewhere' }));
        return refuse('inbox_elsewhere', 409, { name, forward: publicForward(await forwardRow(env, site.id)) });
      };

      if (action === 'setup') {
        if (!(await forwardingAvailable(env))) return refuse('not_set_up', 503);
        const stop = forwardStop(domain);
        if (stop) return refuse(stop, 409, { name });
        let address, inbox;
        try { address = `${cleanLocal(body.local, name)}@${name}`; inbox = cleanInbox(body.inbox, name); }
        catch (e) { return refuse(e instanceof MailError && e.code === 'same_domain' ? 'same_domain' : 'not_an_address', 400, { address: null, inbox: null, name }); }
        const same = !!row && row.address === address && row.inbox === inbox;
        const works = row?.state === 'on';   // an address that works stays exactly as it is while a change to it waits
        const waits = whatWaits(row);        // what the row waits for now: a first set-up, or a change beside an address that works
        if (same && works && waits) await saveForward(env, site.id, NO_CHANGE);   // what works was asked for again: the change that waited is dropped
        if (same && works) return standing({ sent: false });   // it stands as asked
        // An inbox this account has not shown to be its own is taken only when Cloudflare writes to it at this asking. One that has
        // confirmed already (at somebody else's asking), or that somebody else still waits for, is refused before anything is made.
        const ours = await mine(inbox);
        const notOurs = () => refuse('inbox_elsewhere', 409, { address, inbox, name, forward: publicForward(row) });
        let left = false;   // on Cloudflare's list, not confirmed, and nobody waits for it any more: the email is sent afresh
        if (!ours) {
          let there;
          try { there = await inboxState(env, { email: inbox }); }
          catch (e) { return failed(e, 'inbox', { address, inbox }); }
          if (there && (there.verified || await inboxAwaited(env, inbox))) return notOurs();
          left = !!there;
        }
        let box;
        try { await switchMailOn(env, { zoneId: domain.zone_id, name }); }
        catch (e) { return failed(e, 'switch', { address, inbox }); }
        try { box = left ? await askAgain(env, { email: inbox }) : await addInbox(env, { email: inbox }); }
        catch (e) { return failed(e, 'inbox', { address, inbox }); }
        if (!ours && !box.sent) return notOurs();   // somebody else asked for it in the same moment
        // Asking for the same again while it waits keeps its clock: the reminder and the day Kiln stops waiting count from the first asking.
        // A row that waits for the same inbox keeps the time Cloudflare last wrote there, which is also the mark that it wrote at this row's asking.
        const again = !!waits && waits.address === address && waits.inbox === inbox;
        const sameInbox = !!waits && waits.inbox === inbox;
        // An address that works is not rewritten: the change is kept beside it until the new inbox confirms, and the old rule goes on forwarding.
        const saved = await saveForward(env, site.id, works
          ? { want_address: address, want_inbox: inbox, want_inbox_id: box.id, ...(again ? {} : { want_since: now }), ...(box.sent ? { want_asked_at: now } : sameInbox ? {} : { want_asked_at: null }) }
          : { address, inbox, inbox_id: box.id, state: 'confirming', reason: null, ...(again ? {} : { created_at: now }), ...(box.sent ? { asked_at: now } : sameInbox ? {} : { asked_at: null }) });
        if (!saved) return refuse('not_set_up', 503);
        // An inbox of this account's that confirmed earlier gets no second email: the rule is made at once.
        if (box.verified) {
          try { await switchOn(await forwardRow(env, site.id), box.id); }
          catch (e) { return failed(e, 'rule', { address, inbox }); }   // the row waits, and the five-minute job tries the rule again
        }
        return standing({ sent: !!box.sent });
      }

      if (action === 'check') {
        // Only an address that waits, at a domain that is live, has anything to ask about.
        const waits = whatWaits(row);
        if (!waits || !live) return json({ ok: true, forward: publicForward(row) });
        let box;
        try { box = await inboxState(env, { email: waits.inbox, id: waits.inbox_id }); }
        catch (e) { return failed(e, 'inbox'); }
        if (box?.verified) {
          if (!(await mine(waits.inbox))) return elsewhere();
          try { await switchOn(row, box.id); }
          catch (e) { return failed(e, 'rule', { address: waits.address, inbox: waits.inbox }); }
        }
        return standing();
      }

      if (action === 'again') {
        const waits = whatWaits(row);
        if (!waits) return json({ ok: true, forward: publicForward(row), sent: false });
        if (!canAskAgain(waits, now)) return refuse('too_soon', 429, { address: waits.address, inbox: waits.inbox, forward: publicForward(row) });
        if (!(await mine(waits.inbox))) return elsewhere();   // nobody is written to at the asking of an account the inbox never agreed to
        let box;
        try { box = await askAgain(env, { email: waits.inbox }); }
        catch (e) { return failed(e, 'inbox'); }
        await saveForward(env, site.id, waits.change ? { want_inbox_id: box.id, ...(box.sent ? { want_asked_at: now } : {}) } : { inbox_id: box.id, ...(box.sent ? { asked_at: now } : {}) });   // the inbox has a new id after this
        if (box.verified && live) {
          try { await switchOn(row, box.id); }
          catch (e) { return failed(e, 'rule'); }
        }
        return standing({ sent: !!box.sent });
      }

      // stop: the rule goes and the row is forgotten. The domain's mail records stay, so nothing bounces differently by surprise.
      if (domain?.zone_id) {
        try { await stopForwarding(env, { zoneId: domain.zone_id, ruleId: row.rule_id || null }); }
        catch (e) { return failed(e, 'stop'); }
      }
      await forgetForward(env, site.id);
      console.log(JSON.stringify({ evt: 'forward_stopped', repo: site.repo, address: row.address }));
      return json({ ok: true, forward: null });
    } finally {
      try { await env.KILN.delete(lock); } catch { /* it runs out by itself in two minutes */ }
    }
  }

  // The domain's records as one text file, for an owner who moves the domain
  // away: they hand it to whoever answers for the domain next. It is there
  // whatever state the set-up is in, and with editing switched off.
  if (path === '/cloud/sites/domain/records' && request.method === 'GET') {
    const asked = await ownedSite(request, env, url, sess, tools, { needToken: false, needAccess: false });
    if (asked.response) return asked.response;
    const row = await domainRow(env, asked.site.id);
    const refuse = (code, status) => json({ error: domainSentence(code, { name: row?.name || null }), code }, status);
    if (!row) return refuse('no_domain', 404);
    if (!row.zone_id) return refuse('no_records', 404);
    let text;
    try { text = await exportRecords(env, { zoneId: row.zone_id }); }
    catch (e) {
      if (e instanceof DomainError && e.code === 'no_records') return refuse('no_records', 404);
      console.warn(JSON.stringify({ evt: 'domain_records_failed', repo: asked.site.repo, name: row.name, detail: e instanceof DomainError ? e.detail || e.code : String(e?.message || e).slice(0, 300) }));
      return refuse('not_asked', 502);
    }
    // The dashboard is at another address than this service, so it is told that it may read the file's name.
    return new Response(text, { status: 200, headers: {
      'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="${row.name}-records.txt"`,
      'Access-Control-Expose-Headers': 'Content-Disposition', 'Cache-Control': 'no-store',
    } });
  }

  if (path === '/cloud/sites/remove' && request.method === 'POST') {
    if (!sess) return json({ error: 'not signed in' }, 401);
    const { id } = await request.json().catch(() => ({}));
    const site = await env.kiln_cloud.prepare('SELECT id, repo, ls_subscription_id FROM sites WHERE id = ? AND account_id = ?').bind(id || '', sess.account_id).first();
    if (!site) return json({ ok: true });   // not theirs, or already gone
    // Removing the site removes Manage billing with it, so the subscription
    // is cancelled first, and the site stays if that cannot be confirmed.
    const cancel = await lsCancel(env, site.ls_subscription_id);
    if (!cancel.ok) return json({ error: NOT_CANCELLED, code: 'subscription_not_cancelled', reason: cancel.state }, 502);
    const kept = await keptSite(env, site.id);   // asked before the row goes
    const gone = await forgetHosting(env, site.id);   // a hosted site comes down with it, and so does its own domain
    await env.kiln_cloud.prepare('DELETE FROM sites WHERE id = ? AND account_id = ?').bind(site.id, sess.account_id).run();
    if (site.repo) await env.KILN.put(`cloudgone:${String(site.repo).toLowerCase()}`, JSON.stringify({ at: Date.now() }));
    // The repository of a site Kiln kept the files of is never touched here. The operator is told that nothing uses it now.
    if (kept && site.repo) { const told = keptRemovedNote({ repo: site.repo, by: signedInAs(sess) }); await notifyOwner(env, told.subject, told.lines); }
    return json({ ok: true, subscription: cancel.state, ...(cancel.ends_at ? { ends_at: cancel.ends_at } : {}), ...domainLeft(gone) });
  }

  // Bring the Kiln editor in the site's repository up to the released one
  // (update.js), so nobody needs a terminal for that either. GET says which
  // editor the repository holds and what would be replaced, and writes
  // nothing; POST replaces Kiln's own files, as one commit in the account
  // holder's name.
  if (path === '/cloud/sites/update' && (request.method === 'GET' || request.method === 'POST')) {
    const asked = await ownedSite(request, env, url, sess, tools);
    if (asked.response) return asked.response;
    const { site, token, write } = asked;
    const refused = (code, status, extra = {}) => json({ error: updateSentence(code, { repo: site.repo, ...extra }), code, ...extra }, status);

    // One at a time for a site: two tabs pressing the button make one commit.
    const lock = `updlock:${site.id}`;
    if (write) {
      if (await env.KILN.get(lock)) return refused('busy', 409);
      await env.KILN.put(lock, '1', { expirationTtl: 120 });
    }
    try {
      const plan = await planUpdate({ token, repo: site.repo, worker: url.origin, releaseBase: env.KILN_RELEASE_BASE });
      const shown = publicUpdate(plan, { repo: site.repo });
      if (plan.state === 'no_access') return refused('no_access', 409, { install_url: INSTALL_URL });
      if (plan.state === 'github' || plan.state === 'release') return refused(plan.state, 502);
      if (plan.state !== 'behind' && plan.state !== 'current') {
        // Nothing here to update: say why, and what to do.
        return json({ ok: false, ...shown, error: updateSentence(plan.state, { repo: site.repo }), code: plan.state, ...(plan.state === 'too_big' ? { command: UPDATE_COMMAND } : {}) }, write ? 409 : 200);
      }
      // What was just read is the best answer to which editor this site has
      // and which is released: /cloud/me goes by it from here on.
      await rememberLatest(env, plan.latest);
      await noteRepoBuild(env, site.repo, plan.installed);
      if (plan.state === 'current' || !write) return json({ ok: true, ...shown });

      const author = await commitAuthor(env, sess);
      let done;
      try {
        done = await applyUpdate({
          token, repo: site.repo, plan,
          author,
          releaseBase: env.KILN_RELEASE_BASE,
        });
      } catch (e) {
        const code = e instanceof PrepareError ? e.code : 'github';
        console.warn(JSON.stringify({ evt: 'update_failed', repo: site.repo, code, detail: e instanceof PrepareError ? e.detail : String(e?.message || e).slice(0, 200) }));
        return refused(code, code === 'moved' || code === 'protected' ? 409 : 502, code === 'protected' ? { branch: plan.branch, command: UPDATE_COMMAND } : {});
      }
      await noteRepoBuild(env, site.repo, done.to);
      await notifyOwner(env, `Kiln editor updated in ${site.repo}`, [
        `By: ${signedInAs(sess)}, from the dashboard`,
        `Editor: ${done.from || 'an unstamped one'} to ${done.to}. Files: ${done.files.join(', ') || 'none'}`,
        done.url,
      ]);
      return json({ ok: true, ...shown, state: 'done', commit: { sha: done.sha, url: done.url } });
    } finally {
      if (write) { try { await env.KILN.delete(lock); } catch { /* it runs out by itself in two minutes */ } }
    }
  }

  if (path === '/cloud/portal') {
    if (!sess) return json({ error: 'not signed in' }, 401);
    const site = await env.kiln_cloud.prepare('SELECT ls_subscription_id FROM sites WHERE id = ? AND account_id = ?').bind(url.searchParams.get('site'), sess.account_id).first();
    const portal = site ? await lsPortal(env, site.ls_subscription_id) : null;
    return portal ? json({ url: portal }) : json({ error: 'There is no subscription for this site yet, so there is no billing page to open.' }, 404);
  }

  // "Check this site": a checklist of how the site is set up, for its owner
  // (sitecheck.js). It reads the repository and the live site and changes
  // nothing. It answers when the Kiln app is not installed and when editing
  // is switched off too, because each of those is a line in the list.
  if (path === '/cloud/sites/check' && request.method === 'GET') {
    const asked = await ownedSite(request, env, url, sess, tools, { needToken: false, needAccess: false });
    if (asked.response) return asked.response;
    const { site, token, access } = asked;
    // A site on Kiln's hosting answers at the address the hosting gave it, and
    // its own domain is not pointed there, so that address is the one to look
    // at. When the site is not online, the list says why and asks no address.
    const row = hostingOn(env) ? await hostingRow(env, site.id) : null;
    const hosting = row ? publicHosting(row, { repo: site.repo, planEnded: Number(site.access_until) || null }) : null;
    const up = !!(hosting && hosting.url && (hosting.state === 'live' || hosting.serving));
    const down = hosting && !up
      ? hosting.error || (hosting.state === 'ended' ? 'Kiln took this site down from its hosting.' : 'Kiln is putting this site up now. Check again in a minute.')
      : null;
    // Once the site's own domain is live, that is where it is looked at
    // (still as a hosted site: Kiln publishes there). A domain that still
    // waits for its name servers is not asked for anything: the address the
    // hosting gave is looked at, and one more line says what the domain waits for.
    const dom = up ? await domainRow(env, site.id) : null;
    const onDomain = !!(dom && dom.state === 'live' && dom.name);
    const lookAt = !up ? site.origin
      : !onDomain ? hosting.url
        : [dom.name, `www.${dom.name}`].includes(hostName(site.origin)) ? site.origin : `https://${dom.name}`;
    const checks = await checkSite({ token, repo: site.repo, origin: lookAt, hosted: up, ownDomain: onDomain, down, worker: url.origin, installUrl: INSTALL_URL, canAdd: access });
    if (dom && dom.state === 'waiting' && dom.name) checks.push(domainWaitingLine({ name: dom.name, seller: publicDomain(dom, { records: false })?.seller?.name }));
    if (!access) {
      let sub = null;
      try { sub = await env.kiln_cloud.prepare('SELECT ls_subscription_id FROM sites WHERE id = ?').bind(site.id).first(); } catch { /* worded as a trial that ended */ }
      checks.unshift(editingOffLine({ status: site.status, subscribed: !!(sub && sub.ls_subscription_id) }));
    }
    return json({ ok: true, repo: site.repo, origin: site.origin, looked_at: down ? null : lookAt, checks, all_ok: checks.every(c => c.ok === true) });
  }

  // Fresh checkout link for a site that has no live subscription yet (trial,
  // abandoned checkout, or canceled) — so a customer can pay without having to
  // remove and re-add the site (which would re-anchor their trial clock).
  if (path === '/cloud/checkout') {
    if (!sess) return json({ error: 'not signed in' }, 401);
    const site = await env.kiln_cloud.prepare('SELECT * FROM sites WHERE id = ? AND account_id = ?').bind(url.searchParams.get('site'), sess.account_id).first();
    if (!site) return json({ error: 'no such site' }, 404);
    // A subscription that has run out (cancelled, nothing paid left) does not
    // stop a new one; one still paid up is resumed under Manage billing, so
    // nobody pays twice for the same days.
    if (site.ls_subscription_id && !(site.status === 'canceled' && !siteHasAccess(site))) {
      return json({ error: site.status === 'canceled'
        ? 'This subscription is cancelled but paid up for now: resume it under Manage billing instead of paying again.'
        : 'This site already has a subscription. Use Manage billing to change it.' }, 409);
    }
    const checkout = await lsCheckout(env, site, { email: await accountEmail(env, sess.account_id) });
    return checkout ? json({ url: checkout }) : json({ error: 'The payment page could not be opened just now. Nothing was charged. Try again in a minute, and write to info@kilncms.com if it keeps happening.', code: 'billing_not_configured' }, 503);
  }

  // Lemon Squeezy webhook — the ONLY thing that flips a site to active.
  if (path === '/cloud/webhook/ls' && request.method === 'POST') {
    const bodyText = await request.text();
    if (!(await verifyLsSignature(request, bodyText, env))) {
      // A rejected webhook is a paying customer's status not arriving (or
      // someone probing). Either way it should leave a line.
      console.warn(JSON.stringify({ evt: 'webhook_rejected', reason: env.LS_WEBHOOK_SECRET ? 'bad signature' : 'no webhook secret configured', bytes: bodyText.length }));
      return json({ error: 'bad signature' }, 401);
    }
    const evt = JSON.parse(bodyText);
    // Act ONLY on subscription lifecycle events. Order/invoice events
    // (order_created, subscription_payment_success) carry status "paid", which
    // is not a subscription status — mapping it would wrongly flip a paying site
    // to past_due on its first purchase and every renewal, and would store an
    // order id in ls_subscription_id (breaking the portal lookup).
    const eventName = evt?.meta?.event_name || '';
    const isSubscription = eventName.startsWith('subscription_')
      && !eventName.startsWith('subscription_payment_')
      && evt?.data?.type === 'subscriptions';
    if (!isSubscription) return json({ ok: true, ignored: eventName || 'non-subscription' });

    const siteId = evt?.meta?.custom_data?.site_id;
    const subId = evt?.data?.id;   // a real subscription id, given the guard above
    const lsStatus = evt?.data?.attributes?.status;
    // Ignore unknown statuses rather than downgrading a paying site to past_due.
    const state = Object.prototype.hasOwnProperty.call(LS_STATE, lsStatus) ? LS_STATE[lsStatus] : null;
    if (!state) return json({ ok: true, ignored: `unknown status ${lsStatus}` });
    const status = state.status;
    const attrs = evt.data.attributes;
    const ms = (v) => { const t = Date.parse(v || ''); return Number.isFinite(t) ? t : null; };
    // Cancelled: paid up to ends_at. A grace runs from the event's own time, so
    // a delivery that arrives late, or again, cannot stretch it.
    const until = state.access === 'until' ? ms(attrs.ends_at)
      : state.access === 'grace' ? (ms(attrs.updated_at) ?? Date.now()) + PAST_DUE_GRACE_DAYS * 86400 * 1000
      : null;
    // A site already in its grace keeps the date it was given: a second failed
    // charge (past_due → unpaid) does not start the seven days again.
    // Over for good: editing stops now. A day already on the row and already
    // past is kept as it is (the paid time, or the grace, ran out then, and the
    // owner of a hosted site has been written to about that day); otherwise the
    // day is the moment the subscription ended, never later than now.
    const endedAt = state.access === 'no' ? Math.min(ms(attrs.ends_at) ?? Infinity, ms(attrs.updated_at) ?? Infinity, Date.now()) : null;
    const setUntil = state.access === 'grace'
      ? "access_until = CASE WHEN status = 'past_due' AND access_until IS NOT NULL THEN access_until ELSE ? END"
      : state.access === 'no' ? 'access_until = MIN(COALESCE(access_until, ?), ?)'
      : 'access_until = ?';
    const untilArgs = state.access === 'no' ? [endedAt, endedAt] : [until];
    // Replay guard: a captured valid delivery could otherwise be re-POSTed to
    // flip a re-subscribed customer back to canceled. Dedupe on a stable id
    // (updated_at makes the same subscription's DISTINCT transitions unique,
    // while a byte-identical replay is rejected).
    const evtKey = `lsevt:${subId || siteId}:${evt?.data?.attributes?.updated_at || ''}:${lsStatus}`;
    if (await env.KILN.get(evtKey)) return json({ ok: true, replayed: true });
    // Apply the state change FIRST, then record the dedupe key — otherwise a D1
    // failure would leave the key set and silently drop LS's retry of this event.
    if (siteId) {
      await withAccessUntil(
        () => env.kiln_cloud.prepare(`UPDATE sites SET ${setUntil}, status = ?, ls_subscription_id = ? WHERE id = ?`).bind(...untilArgs, status, subId || null, siteId).run(),
        () => env.kiln_cloud.prepare('UPDATE sites SET status = ?, ls_subscription_id = ? WHERE id = ?').bind(status, subId || null, siteId).run(),
      );
    } else if (subId) {
      await withAccessUntil(
        () => env.kiln_cloud.prepare(`UPDATE sites SET ${setUntil}, status = ? WHERE ls_subscription_id = ?`).bind(...untilArgs, status, subId).run(),
        () => env.kiln_cloud.prepare('UPDATE sites SET status = ? WHERE ls_subscription_id = ?').bind(status, subId).run(),
      );
    }
    await env.KILN.put(evtKey, '1', { expirationTtl: 7 * 24 * 3600 });
    const siteRow = siteId || subId
      ? await env.kiln_cloud.prepare('SELECT id, repo, origin, plan FROM sites WHERE id = ? OR ls_subscription_id = ?').bind(siteId || '', subId || '').first().catch(() => null)
      : null;
    // The plan on record is the plan that is being paid for. A checkout offers
    // one plan only, but a subscription can be moved to the other one later
    // (in Lemon Squeezy, or by the operator), and the operator has to hear of
    // it: the plan with hosting is work on our side.
    // The address the customer gave when paying, kept for notices when the account has none.
    if (siteRow && mailAddress(attrs.user_email)) {
      try { await env.kiln_cloud.prepare("UPDATE accounts SET email = ? WHERE id = (SELECT account_id FROM sites WHERE id = ?) AND (email IS NULL OR email = '')").bind(mailAddress(attrs.user_email), siteRow.id).run(); } catch { /* not worth failing a billing event for */ }
    }
    const paidPlan = planForVariant(env, attrs.variant_id);
    let planNote = null;
    if (siteRow && paidPlan && siteRow.plan !== paidPlan) {
      try {
        await env.kiln_cloud.prepare('UPDATE sites SET plan = ? WHERE id = ?').bind(paidPlan, siteRow.id).run();
        planNote = `Plan: now ${paidPlan} (was ${siteRow.plan || 'not set'}), because that is the plan the subscription pays for.`;
      } catch (e) {
        planNote = `Plan: the subscription pays for ${paidPlan} but the site says ${siteRow.plan || 'nothing'}, and the record could not be changed (${String(e?.message || e).slice(0, 120)}).`;
      }
    }
    await notifyOwner(env, `Kiln billing: ${eventName} → ${status}`, [
      `Site: ${siteRow?.repo || siteId || subId || 'unknown'} (${siteRow?.origin || 'origin unknown'})`,
      `Status: ${status}${until ? `, access until ${new Date(until).toISOString()}` : ''}`,
      ...(planNote ? [planNote] : []),
    ]);
    return json({ ok: true });
  }

  // ── Admin (owner only) ──
  if (path.startsWith('/admin/cloud/')) {
    if (!isCloudAdmin(sess, env)) return json({ error: 'forbidden' }, 403);
    // The operator's playbook — served ONLY to the authenticated super-admin, so
    // the ops details never sit in public HTML. The dashboard opens it in a tab.
    if (path === '/admin/cloud/runbook') {
      return new Response(RUNBOOK_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex' } });
    }
    if (path === '/admin/cloud/overview') {
      const accounts = await env.kiln_cloud.prepare('SELECT COUNT(*) n FROM accounts').first();
      const sites = await env.kiln_cloud.prepare('SELECT s.*, a.github_login, a.email FROM sites s JOIN accounts a ON a.id = s.account_id ORDER BY s.created_at DESC').all();
      const rows = sites.results || [];
      // Which editor each site runs, from what its editors' sessions say (KLR-18; index.js noteEditorBuild).
      for (const r of rows) {
        let eb = null;
        try { eb = r.repo ? await env.KILN.get(`ebuild:${r.repo}`, 'json') : null; } catch { eb = null; }
        r.editor_build = eb?.build || null;
        r.editor_seen = eb?.at || null;
        r.who = r.github_login || r.email || null;   // an account that signed in with Google has no login: its address stands for it
      }
      const active = rows.filter(s => s.status === 'active');
      const price = (p) => p === 'managed' ? 14.99 : 4.99;
      const mrr = active.reduce((m, s) => m + price(s.plan), 0);
      const store = await lsStoreMode(env);
      const insights = buildInsights(rows, accounts.n, price);
      return json({ accounts: accounts.n, sites: rows, active: active.length, mrr: Number(mrr.toFixed(2)), store, insights });
    }
    if (path === '/admin/cloud/grant' && request.method === 'POST') {
      const { site_id, status } = await request.json().catch(() => ({}));
      if (!['active', 'trialing', 'past_due', 'canceled'].includes(status)) return json({ error: 'bad status' }, 400);
      // The operator's word is final: no leftover date keeps a site open (or shut).
      await withAccessUntil(
        () => env.kiln_cloud.prepare('UPDATE sites SET status = ?, access_until = NULL WHERE id = ?').bind(status, site_id).run(),
        () => env.kiln_cloud.prepare('UPDATE sites SET status = ? WHERE id = ?').bind(status, site_id).run(),
      );
      return json({ ok: true });
    }
    if (path === '/admin/cloud/remove' && request.method === 'POST') {
      const { site_id, force } = await request.json().catch(() => ({}));
      const site = await env.kiln_cloud.prepare('SELECT id, ls_subscription_id FROM sites WHERE id = ?').bind(site_id || '').first();
      if (!site) return json({ ok: true });
      // Same rule as the customer's own Remove. `force` is for the operator who
      // has already ended the subscription in Lemon Squeezy by hand.
      const cancel = force ? { ok: true, state: 'forced' } : await lsCancel(env, site.ls_subscription_id);
      if (!cancel.ok) {
        return json({ error: `subscription ${site.ls_subscription_id} could not be cancelled (${cancel.state}); cancel it in Lemon Squeezy, then remove with force`, code: 'subscription_not_cancelled', reason: cancel.state }, 502);
      }
      const gone = await forgetHosting(env, site.id);
      await env.kiln_cloud.prepare('DELETE FROM sites WHERE id = ?').bind(site.id).run();
      return json({ ok: true, subscription: cancel.state, ...domainLeft(gone) });
    }
    // Per-site troubleshooting: app-install check, live-site reachability, /kiln
    // entry check, editability (is the origin actually in the active/trialing
    // allowlist), and live Lemon Squeezy subscription status.
    if (path === '/admin/cloud/diagnose') {
      const id = url.searchParams.get('site');
      const site = await env.kiln_cloud.prepare('SELECT s.*, a.github_login, a.email FROM sites s JOIN accounts a ON a.id = s.account_id WHERE s.id = ?').bind(id).first();
      if (!site) return json({ error: 'not found' }, 404);
      const checks = [];
      const add = (name, ok, detail) => checks.push({ name, ok, detail });

      const installed = await repoInstalled(env, site.repo);
      add('GitHub App installed on repo', installed,
        installed ? `kiln-cms is installed on ${site.repo}` : `Not installed — customer must add it at github.com/apps/kiln-cms`);

      const until = Number(site.access_until) ? ` and access runs until ${new Date(Number(site.access_until)).toISOString().slice(0, 10)}` : '';
      add('Site editable (allowlisted)', siteHasAccess(site),
        `Status is "${site.status}"${until} — editing is on for active and trialing sites, to the end of the paid period after a cancellation, and for ${PAST_DUE_GRACE_DAYS} days after a failed payment`);

      let reachable = false, reachDetail = 'no response';
      try {
        const r = await fetch(site.origin, { method: 'HEAD', redirect: 'manual' });
        reachable = r.status < 500;
        reachDetail = `HTTP ${r.status}`;
      } catch (e) { reachDetail = String(e.message || e); }
      add('Live site reachable', reachable, `${site.origin} → ${reachDetail}`);

      let kilnEntry = false, entryDetail = 'not found';
      try {
        const r = await fetch(site.origin.replace(/\/$/, '') + '/kiln', { method: 'HEAD' });
        kilnEntry = r.ok;
        entryDetail = `HTTP ${r.status}`;
      } catch (e) { entryDetail = String(e.message || e); }
      add('/kiln sign-in page present', kilnEntry, `${site.origin}/kiln → ${entryDetail}`);

      if (site.ls_subscription_id) {
        try {
          const r = await fetch(`${LS}/subscriptions/${site.ls_subscription_id}`,
            { headers: { Authorization: `Bearer ${env.LS_API_KEY}`, Accept: 'application/vnd.api+json' } });
          const d = r.ok ? await r.json() : null;
          const st = d?.data?.attributes?.status;
          add('Lemon Squeezy subscription', st === 'active' || st === 'on_trial', `LS status: ${st || 'unknown'}`);
        } catch (e) { add('Lemon Squeezy subscription', false, String(e.message || e)); }
      } else {
        add('Lemon Squeezy subscription', false, 'No subscription yet (trial or comped)');
      }
      return json({ site, checks });
    }
  }

  return null;  // not a cloud route
}

/** Revenue + lifecycle breakdowns computed from the sites table (no history table needed). */
function buildInsights(rows, accountCount, price) {
  const byStatus = { active: 0, trialing: 0, past_due: 0, canceled: 0 };
  const byPlan = { cloud: 0, managed: 0 };
  let mrrCloud = 0, mrrManaged = 0;
  const now = Date.now();
  const day = 86400 * 1000;
  let signups30 = 0, signups7 = 0;
  const trialsExpiring = [];
  for (const s of rows) {
    if (byStatus[s.status] !== undefined) byStatus[s.status]++;
    if (byPlan[s.plan] !== undefined) byPlan[s.plan]++;
    if (s.status === 'active') { if (s.plan === 'managed') mrrManaged += price('managed'); else mrrCloud += price('cloud'); }
    if (now - s.created_at < 30 * day) signups30++;
    if (now - s.created_at < 7 * day) signups7++;
    // Self-serve trials (no LS subscription) auto-expire 7 days after creation.
    if (s.status === 'trialing' && !s.ls_subscription_id) {
      const daysLeft = Math.ceil((s.created_at + 7 * day - now) / day);
      trialsExpiring.push({ id: s.id, repo: s.repo, github_login: s.github_login || null, email: s.email || null, who: s.github_login || s.email || null, daysLeft });
    }
  }
  const paying = byStatus.active;
  const everConverted = paying + byStatus.past_due + byStatus.canceled; // rough denominator
  const conversion = everConverted ? Math.round((paying / everConverted) * 100) : null;
  return {
    byStatus, byPlan,
    mrrCloud: Number(mrrCloud.toFixed(2)), mrrManaged: Number(mrrManaged.toFixed(2)),
    arr: Number(((mrrCloud + mrrManaged) * 12).toFixed(2)),
    signups30, signups7,
    trialsExpiring: trialsExpiring.sort((a, b) => a.daysLeft - b.daysLeft),
    conversion,
  };
}
