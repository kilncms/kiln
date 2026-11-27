/**
 * Kiln Cloud — the hosted tier on top of the kiln-auth worker.
 *
 * Routes (all behind handleCloud):
 *   GET  /cloud/login            → GitHub OAuth (identity only)
 *   GET  /cloud/login/google     → Google sign-in for a person with no GitHub account; Google returns to
 *                                  /google/callback (index.js), which hands a dashboard sign-in to googleDashboardSignIn
 *   (index.js /email/*, for=dashboard) → sign-in with a link or a code sent to any address, for a person with
 *                                  no GitHub account; index.js hands the confirmed address to emailDashboardSignIn
 *   GET  /cloud/callback         → upsert account, set session cookie, → dashboard
 *   GET  /cloud/me               → { account, sites }
 *   POST /cloud/sites            → register a site (verify repo install) → checkout URL
 *   GET  /cloud/sites/prepare    → what adding Kiln to the site's repository would change
 *   POST /cloud/sites/prepare    → add Kiln to the repository (prepare.js), in one commit
 *                                  (for a site Kiln hosts, both also cover the character-set
 *                                  line on pages and page templates that have none: `charset`
 *                                  in the answer, and a second commit of its own)
 *   GET  /cloud/sites/firstpass  → what a first pass at what can be edited would mark (for a site Astro builds: what it would move out of the templates, with a report of the rest)
 *   POST /cloud/sites/firstpass  → mark it (firstpass.js), in one commit
 *   POST /cloud/sites/remove     → cancel its subscription, then delete a site
 *   GET  /cloud/sites/update     → which Kiln editor the site's repository holds, and what an update would replace
 *   POST /cloud/sites/update     → replace the editor's files with the released ones (update.js), in one commit
 *   GET  /cloud/sites/check      → a checklist of how the site is set up (sitecheck.js); changes nothing
 *   GET  /cloud/sites/hosting    → where a hosted site stands (hosted.js)
 *   POST /cloud/sites/hosting    → put the site on Kiln's hosting, or publish it again (hosting.js)
 *   POST /cloud/sites/hosting/build → "Build again" for a site Astro builds: look now whether its build is done (hosted.js lookAgain)
 *   GET  /cloud/sites/domain     → where a hosted site's own domain stands, or a look at a domain that changes nothing (domain.js)
 *   POST /cloud/sites/domain     → set the domain up, ask whether its name servers have changed, or stop a set-up that is not live
 *   GET  /cloud/sites/domain/records → the domain's records as a file, for an owner who moves the domain away
 *   GET  /cloud/sites/files?site= → GitHub's short-lived link to a zip of a kept site's files, once the site has been paid for
 *   GET  /cloud/portal?site=     → "Manage billing": Stripe's Billing Portal for the customer the site's subscription belongs to
 *   POST /cloud/webhook/stripe   → Stripe webhook (signed) → set site status (billing.js has the Stripe calls)
 *   GET  /admin/cloud/overview   → (owner only) accounts, sites (with the editor build each runs), MRR
 *                                  and `customers`, `needs_you`, `funnel`: who has an account, how far each
 *                                  one got, and what needs the operator (buildCustomers)
 *   POST /cloud/account/came-from → {source, medium, campaign}: the campaign tags of the link the person
 *                                  followed, kept on a new account once (only while CAMPAIGN_TAGS is "on")
 *   POST /admin/cloud/needs/hide → (owner only) {key}: hide one line of `needs_you` for 30 days; {key, undo: true} shows it again
 *   GET  /admin/cloud/activity   → (owner only) the activity record, newest first (activity.js): ?account= or ?site=, limit, before
 *   GET  /admin/cloud/checks     → (owner only) the latest daily check of each site (daily-check.js)
 *   GET  /admin/cloud/totals     → (owner only) one line of totals a day for all of Kiln, newest first, up to 400 (daily-totals.js): ?limit=
 *   GET  /admin/cloud/security   → (owner only) the refusals of the last days by kind and hour (security-log.js): ?days= (7, at most 90)
  *   GET  /admin/cloud/problems   → (owner only) the problems of the last 14 days by kind and site, each kind marked new, ongoing or rising (problems.js)
 *   POST /admin/cloud/grant      → (owner only) manually set a site's status, or give it seven more free days
 *
 * Storage: D1 `kiln_cloud` (accounts, sites). KV `csess:<id>` for dashboard sessions.
 * Billing (billing.js): Stripe Managed Payments once STRIPE_SECRET_KEY is set. Without it,
 * sites register as `trialing` and checkout answers that the payment page could not be
 * opened (code `billing_not_configured`) until Stripe's keys are added.
 */

import { RUNBOOK_HTML } from './runbook.js';
import { billingOn, providerName, subscriptionOf, subscriptionProvider, subscriptionSql, stripeYearlyOn, stripeCloudYearlyOn, stripeCheckout, stripePortal, stripeCancel, stripeCall, verifyStripeSignature, stripeStoreMode, monthlyPrice, planForPrice, periodForPrice } from './billing.js';
import { troubleBody, forDashboard, githubSilent, UNCONFIRMED_GOOGLE, DASHBOARD_SIGN_IN_STOPPED, ACCOUNT_NOT_READY, NO_GOOGLE_SIGN_IN, EMAIL_ACCOUNT_NOT_READY, TWO_ACCOUNTS } from './signin-trouble.js';
import { startSignIn, startedHere, signInOver, STARTED_ELSEWHERE } from './signin-trouble.js';
import { customerMailOn, mailAddress, addressSql, accountAddress, sendOnce, siteAddedMail, siteStartedMail, trialEndingMail, trialEndedMail, editingStoppedMail, hostingEndingMail, domainNameServersMail, domainLiveMail, domainReminderMail, domainPutAwayMail, domainMovedMail, forwardOnMail, forwardWaitingMail, trialEndsAt, TRIAL_NOTICE_DAYS } from './mail.js';
import { planPrepare, applyPrepare, publicPlan, prepareSentence, PrepareError, SETUP_COMMAND, readPages, VIA_KILN, astroAfter, ASTRO_GUIDE } from './prepare.js';
import { planFirstPass, applyFirstPass, publicFirstPass, firstPassSentence, astroAfterSentences } from './firstpass.js';
import { planUpdate, applyUpdate, publicUpdate, updateSentence, editorStanding, rememberLatest, noteRepoBuild, UPDATE_COMMAND } from './update.js';
import { checkSite, editingOffLine, domainWaitingLine } from './sitecheck.js';
import { noteActivity, notePublished, noteSiteRemoved, forgetActivity, activityOn, activityPage } from './activity.js';
import { dailyCheckOn, latestChecks } from './daily-check.js';
import { totalsOn, totalsPage } from './daily-totals.js';
import { securityOn, noteSecurity, securityPage } from './security-log.js';
import { problemsOn, noteProblem, forgetProblems, problemsPage } from './problems.js';
import { hostingOn, hostingSentence, membersGateOn, previewPattern, serviceAddress } from './hosting.js';
import { keepsReady, inKeepOrg, keepSentence, keptSite, keptIds, keptNames, keptRemovedNote, keptStandsKey, startKept, freeDaysSentence, keptFilesLink, keptFilesName } from './keeps.js';
import { bringOn, bringIn, bringAgain, copyOf, copiesForAccount, copyAnswered, sweepCopies, MOST_ANSWER } from './bring.js';
import { hostingRow, hostingForAccount, publicHosting, publishSite, forgetHosting, siteForHostingAddress, lookAgain } from './hosted.js';
import { lookAfter, lookedAfter, careOwed, planCharset, applyCharset, charsetSentence, publicCharset } from './lookafter.js';
import {
  domainsOn, domainsReady, cleanDomain, lookUp, whatStops, sellerHelp, prepareDomain, domainStatus, removeWaitingDomain, exportRecords,
  siteAnswers, certificateReady, redirectToOne, alwaysHttps, LIMITS as DOMAIN_LIMITS,
  domainSentence, publicDomain, publicLook, domainRow, domainForName, domainsForAccount, saveDomain, forgetDomain, DomainError, TAKING_HOLD,
} from './domain.js';
import {
  mailStop, saysNoMail, switchMailOn, inboxState, addInbox, askAgain, canAskAgain, forward, stopForwarding, cleanLocal, cleanInbox, mailSentence,
  forwardRow, forwardsForAccount, forwardsConfirming, forwardsReady, saveForward, forgetForward, publicForward, ownsInbox, dropOtherAskings, inboxInUse, forgetInboxesOf, takeInboxLock, dropInboxLock, whatWaits, NO_CHANGE, MailError, MAIL_LIMITS,
} from './domain-mail.js';
import { registerReady, holderOf, registerSentence, offersForAccount, searchNames, registerName, siteRegistration, standingForAccount, publicRegistration, sweepRegistrations as sweepRegistered,
  sweepRenewals as sweepRenewed, registrationsForAccount, leaveName, registeredFor, removedNote, registrationsForOperator, freeRow, markRegistered, handedOver } from './register.js';

const GH = 'https://api.github.com';
const UA = 'kiln-cloud';
const INSTALL_URL = 'https://github.com/apps/kiln-cms/installations/new';
const NOT_YOUR_REPO = 'The GitHub account you signed in with cannot change that repository. Check the spelling, or sign in with the account that owns it.';

const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const uuid = () => crypto.randomUUID();

/**
 * This service's own address, for every address it hands out: a sign-in's
 * callback at GitHub or Google, a link in an email, the address a copying job
 * answers to, the one written into a site's settings. Never taken from how a
 * request happened to arrive: it is HOSTING_SERVICE_URL where that is set
 * (https only), and otherwise the request's host over https. A local
 * development server (localhost, 127.0.0.1) has no certificate and keeps its
 * own plain address.
 */
export function selfOrigin(url, env) {
  const fixed = serviceAddress(env);
  if (fixed) return fixed;
  return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname) ? url.origin : `https://${url.host}`;
}
// What a person signed in with Google is told when they ask for something that takes a GitHub account.
const NEEDS_GITHUB_TO_ADD = 'Adding a repository of your own needs a GitHub sign-in. Sign out, then sign in with GitHub.';
const NEEDS_GITHUB_FOR_SITE = 'This site is in a GitHub repository, and you are signed in with Google. Sign out, then sign in with GitHub.';
// Connecting GitHub to an account that began without it (the /cloud/link routes): what a person reads when it does not happen.
const LINK_NOT_READY = 'This Kiln service cannot connect a GitHub account yet. That is for whoever runs the service to put right. Nothing was changed.';
const LINK_ALREADY = 'You are signed in with GitHub already, so there is nothing to connect.';
const LINK_TOO_MANY = 'You have started connecting GitHub many times in a short while. Wait an hour, then try again.';
const LINK_EXPIRED = 'Connecting GitHub works once and for ten minutes, in the browser it was started in. This time it was used already, or the time ran out. Nothing was changed. Start again from the dashboard.';
const LINK_TAKEN = 'That GitHub account already has a Kiln account of its own, so it cannot be connected to this one. Nothing was changed. Connect a different GitHub account, or sign out and sign in with GitHub to use that one.';
const LINK_NOT_NOW = 'Kiln could not connect your GitHub account just now. Nothing was changed. Try again in a few minutes.';
const linkOther = (theirs, as) => (theirs
  ? `This Kiln account is connected to the GitHub account ${theirs}, and you came back from GitHub as ${as}. Nothing was changed. Sign in to GitHub as ${theirs}, then connect again.`
  : `This Kiln account is connected to another GitHub account, and you came back from GitHub as ${as}. Nothing was changed. Sign in to GitHub with the account you connected, then connect again.`);
// POST /cloud/account, from an account that began with Google or by email and has connected GitHub since.
const LINKED_ADDRESS = 'Kiln writes to the address this account was started with, the one Google or a sign-in link confirmed. Nobody confirms an address typed here, so it cannot take that one\'s place.';
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

// ─── Which repositories Kiln can reach for a person (GET /cloud/github) ───────

const REPO_NAME = /^[\w.-]+\/[\w.-]+$/;
/** A read of GitHub that never throws: the Response, or null when nothing came back. */
const ghAsk = (url, bearer, init = {}) => fetch(url, { ...init, headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/vnd.github+json', 'User-Agent': UA, ...(init.headers || {}) } }).catch(() => null);

/**
 * Where a person installs Kiln's GitHub App, or changes which repositories it
 * has. Built from the name of the App this service holds the keys of, so a
 * service with an App of its own (the test service, a self-hosted one) sends
 * people to that App and not to the main one.
 */
export function installUrl(c) {
  const slug = c && typeof c.slug === 'string' && /^[a-z0-9][a-z0-9-]*$/i.test(c.slug) ? c.slug : null;
  return slug ? `https://github.com/apps/${slug}/installations/new` : INSTALL_URL;
}
/** The same address, for whichever App this service holds the keys of. Never throws. */
async function installUrlFor(env) {
  try { return installUrl(await creds(env)); } catch { return INSTALL_URL; }
}

/** A repository's own website field, when it is a plain https address of a sensible length. Otherwise null. */
function httpsAddress(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s || s.length > 200 || !/^https:\/\//i.test(s)) return null;
  try { return new URL(s).protocol === 'https:' ? s : null; } catch { return null; }
}

/**
 * Can Kiln's App reach this one repository? true, false, or null when GitHub
 * did not answer (signin-trouble.js githubSilent). Asked as the App. Unlike
 * repoInstalled above it never throws, and a busy GitHub is not read as "no".
 */
export async function repoReach(env, repo) {
  try {
    const c = await creds(env);
    if (!c) return null;
    const r = await ghAsk(`${GH}/repos/${repo}/installation`, await appJwt(c));
    if (r && r.ok) return true;
    return githubSilent(r) ? null : false;
  } catch { return null; }
}

// The token that reads an account's list of repositories is kept under a name
// of its own, and for one minute only (see where it is written).
const listTokenKey = (installationId) => `itok-acct:${installationId}`;
async function listToken(env, jwt, installationId, { fresh = false } = {}) {
  if (!fresh) {
    const kept = await env.KILN.get(listTokenKey(installationId));
    if (kept) return { token: kept, kept: true };
  }
  const ask = (body) => ghAsk(`${GH}/app/installations/${installationId}/access_tokens`, jwt, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  // Asked for with leave to read what repositories there are and nothing else:
  // this token never has to read or change a file.
  let r = await ask({ permissions: { metadata: 'read' } });
  if (r && r.status === 422) r = await ask({});
  if (!r || !r.ok) return null;
  const tok = await r.json().catch(() => null);
  if (!tok || typeof tok.token !== 'string' || !tok.token) return null;
  // Kept for one minute only (the shortest the store keeps anything). Whether a token made before a repository was added to
  // the installation sees that repository was not tried against GitHub, and a list that is a minute behind is the most a
  // person waiting for their repository to show up should meet.
  await env.KILN.put(listTokenKey(installationId), tok.token, { expirationTtl: 60 });
  return { token: tok.token, kept: false };
}

/** GitHub's own list for one installation (the first 100), or null when it could not be read. */
async function installationRepos(env, jwt, installationId) {
  for (const fresh of [false, true]) {
    const t = await listToken(env, jwt, installationId, { fresh });
    if (!t) return null;
    const r = await ghAsk(`${GH}/installation/repositories?per_page=100`, t.token);
    if (r && r.ok) return r.json().catch(() => null);
    // A kept token GitHub no longer takes (it ends one after an hour): ask once more with a new one.
    if (!(t.kept && r && r.status === 401)) return null;
    await env.KILN.delete(listTokenKey(installationId));
  }
  return null;
}

/**
 * Kiln's App on a person's own GitHub account: is it installed, and which
 * repositories can it reach. GitHub is asked two things, in this order: as the
 * App, for the account's installation; then, with that installation's token,
 * for its repositories (the first 100; `more` says there are others).
 *
 * `installed` is true, false, or null when GitHub did not answer either
 * question (so nobody is told the App is missing because GitHub was busy).
 * Neither the token nor the installation's number is handed back, and the
 * list holds only what GitHub says the App can reach.
 */
export async function accountReach(env, { login, uid = null } = {}) {
  const unknown = { installed: null, selection: null, repos: [], more: false };
  const none = { installed: false, selection: null, repos: [], more: false };
  try {
    const c = await creds(env);
    if (!c || !login) return unknown;
    const jwt = await appJwt(c);
    const r = await ghAsk(`${GH}/users/${encodeURIComponent(login)}/installation`, jwt);
    if (!r || !r.ok) return githubSilent(r) ? unknown : none;
    const inst = await r.json().catch(() => null);
    if (!inst || !inst.id) return unknown;
    // A login can be given up and taken by somebody else after the sign-in.
    // GitHub's number for the person cannot, so an installation that belongs
    // to another number is not this person's, and its list is not shown.
    const owner = inst.target_id ?? inst.account?.id ?? null;
    if (uid != null && owner != null && String(owner) !== String(uid)) return none;
    const list = await installationRepos(env, jwt, inst.id);
    if (!list || !Array.isArray(list.repositories)) return unknown;
    const repos = list.repositories
      .filter(x => x && typeof x.full_name === 'string' && REPO_NAME.test(x.full_name))
      .map(x => ({ repo: x.full_name, private: x.private !== false, homepage: httpsAddress(x.homepage) }));
    const total = Number(list.total_count);
    return {
      installed: true,
      selection: inst.repository_selection === 'all' || inst.repository_selection === 'selected' ? inst.repository_selection : null,
      repos,
      more: Number.isFinite(total) ? total > list.repositories.length : list.repositories.length >= 100,
    };
  } catch { return unknown; }
}

// An answer about GitHub is kept for three seconds for the account, so several
// open tabs of the dashboard cost one ask. KV keeps nothing for less than a
// minute, so the entry carries its own time and is believed for three seconds.
// An answer GitHub did not give in full is never kept. `keptMs` may name a
// longer time for an answer: a "no" about one named repository is believed for
// a minute (REACH_NO_KEPT_MS), so a dashboard that looks every four seconds
// for a repository that is not there yet asks GitHub once a minute.
const REACH_KEPT_MS = 3000;
const REACH_NO_KEPT_MS = 60000;
async function keptReach(env, key, settled, ask, keptMs = () => REACH_KEPT_MS) {
  try {
    const kept = await env.KILN.get(key, 'json');
    const age = kept ? Date.now() - Number(kept.at) : NaN;
    if (kept && kept.answer && age >= 0 && age < keptMs(kept.answer)) return kept.answer;
  } catch { /* an entry that cannot be read is asked for again */ }
  const answer = await ask();
  if (settled(answer)) { try { await env.KILN.put(key, JSON.stringify({ at: Date.now(), answer }), { expirationTtl: Math.max(60, 2 * Math.ceil(keptMs(answer) / 1000)) }); } catch { /* the answer still goes out */ } }
  return answer;
}

// One account may ask about thirty different repositories in an hour. Every
// new name costs a request to GitHub, and the ones made as Kiln's App come out
// of one allowance that every customer's saving shares, so one account must
// not be able to spend it. The names asked this hour are kept under
// `cghn:<account id>:<hour>`; a name that is already among them is not counted
// again. False when this name would be the thirty-first. KV has no way to add
// one in a single step, so two requests at the same instant can both be let
// through: the limit is close to thirty, and the count per network address in
// index.js is the hard stop.
const REPO_NAMES_AN_HOUR = 30;
async function mayAskAbout(env, accountId, name) {
  const key = `cghn:${accountId}:${Math.floor(Date.now() / 3600000)}`;
  let names = [];
  try { const kept = await env.KILN.get(key, 'json'); if (Array.isArray(kept)) names = kept; } catch { /* a list that cannot be read starts again */ }
  if (names.includes(name)) return true;
  if (names.length >= REPO_NAMES_AN_HOUR) return false;
  try { await env.KILN.put(key, JSON.stringify([...names, name]), { expirationTtl: 7200 }); } catch { /* the question is still answered */ }
  return true;
}

/** Does the signed-in user (via their stored OAuth token) have push on the repo? */
export async function userCanPush(userToken, repo, opts = {}) {
  return (await userPushAnswer(userToken, repo, opts)) === 'yes';
}

/**
 * The same question with three answers: 'yes', 'no', or 'unsure' when GitHub
 * did not answer (signin-trouble.js githubSilent). A sign-in uses it so that
 * a busy GitHub is never read as "this site is not yours". Everything else
 * only acts on 'yes' (userCanPush).
 */
export async function userPushAnswer(userToken, repo, { fresh = false } = {}) {
  if (!userToken) return 'no';
  try {
    // `fresh`: the token was issued in this very request (a sign-in callback), see ghWithNewToken.
    const r = fresh
      ? await ghWithNewToken(`${GH}/repos/${repo}`, userToken)
      : await fetch(`${GH}/repos/${repo}`, { headers: { Authorization: `Bearer ${userToken}`, Accept: 'application/vnd.github+json', 'User-Agent': UA } });
    if (!r || !r.ok) return githubSilent(r) ? 'unsure' : 'no';
    const j = await r.json();
    return j.permissions && (j.permissions.push || j.permissions.admin || j.permissions.maintain) ? 'yes' : 'no';
  } catch { return 'unsure'; }
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

/**
 * The account of a person who signed in to the dashboard with GitHub: found by
 * GitHub's own number for them (`number`, the `id` of their sign-in), or made
 * the first time. A login is not permanent: a person can rename their GitHub
 * account and somebody else can then take the old name, so a login alone finds
 * an account only while that account has no number yet.
 *   1. The account with this number is the person's, whatever login it holds.
 *      When the login differs the person renamed, and the new one is written.
 *   2. Else the account with this login and no number is one from before
 *      accounts had numbers (migration 0012): it is used, once, and gets the
 *      number.
 *   3. Else a new account is made with both.
 * An account with this login and ANOTHER number is never used: the login
 * belongs to somebody else now. The table allows one account for a login, so
 * before a login is written on one row it is taken off any other row that still
 * carries it, in the same step, and the write cannot fail. A row that loses its
 * login keeps its number: its person is found by the number at their next
 * sign-in, and their login of that day is written then. A row that loses its
 * login and has no number can be reached by nobody (see the note in the rename
 * step below).
 *
 * Returns null, and changes nothing, for the one sign-in that cannot be placed:
 * GitHub gave no number and the login is on an account that has one.
 *
 * On a database migration 0012 has not reached, an account is found by its
 * login, as before.
 */
async function upsertAccount(env, login, email, number) {
  const db = env.kiln_cloud;
  const n = Number.isSafeInteger(number) && number > 0 ? number : null;
  const byNumber = () => db.prepare('SELECT * FROM accounts WHERE github_id = ?').bind(n).first();
  const withoutNumber = async () => {
    const id = uuid();
    await db.prepare('INSERT INTO accounts (id, github_login, email, created_at) VALUES (?,?,?,?)')
      .bind(id, login, email || null, Date.now()).run();
    await noteActivity(env, { account_id: id, kind: 'signed_up', by: 'person', detail: { way: 'github' } });
    return { id, github_login: login, email };
  };

  let mine;
  try { mine = await byNumber(); }   // with no number this finds nobody, and still tells whether the column is there
  catch (e) {
    // Only a missing column means "an older database". Any other trouble stops the sign-in:
    // it must never fall back to finding an account by its login.
    if (!/no such column/i.test(String(e?.message || e))) throw e;
    const existing = await db.prepare('SELECT * FROM accounts WHERE github_login = ?').bind(login).first();
    return existing || withoutNumber();
  }

  if (mine) {
    if (mine.github_login !== login) {
      // The person renamed. Another row may still carry their new login. Its person gave that
      // name up on GitHub, or this person could not hold it today. That row loses the login first.
      // If it has a number, its person still finds it. If it has none (an account from before
      // 0012 whose person has not signed in since), nobody can reach it any more, and that is
      // the safe side: the only person its login could let in is this one, who has an account,
      // and after them whoever takes the name next. It is logged so that a person at Kiln can
      // write the right number on it by hand.
      const other = await db.prepare('SELECT id, github_id FROM accounts WHERE github_login = ? AND id <> ?').bind(login, mine.id).first();
      await db.batch([
        db.prepare('UPDATE accounts SET github_login = NULL WHERE github_login = ? AND id <> ?').bind(login, mine.id),
        db.prepare('UPDATE accounts SET github_login = ? WHERE id = ?').bind(login, mine.id),
      ]);
      if (other) console.warn(JSON.stringify({ evt: 'account_login_taken_off', account: other.id, login, has_number: other.github_id != null, now_on: mine.id }));
      mine = { ...mine, github_login: login };
    }
    return mine;
  }

  const old = await db.prepare('SELECT * FROM accounts WHERE github_login = ? AND github_id IS NULL').bind(login).first();
  if (n === null) {
    // GitHub gave no number (it always does). Such a sign-in reaches an account without a
    // number, as before, and never one that has a number.
    if (old) return old;
    if (await db.prepare('SELECT id FROM accounts WHERE github_login = ?').bind(login).first()) return null;
    return withoutNumber();
  }
  if (old) {
    try { await db.prepare('UPDATE accounts SET github_id = ? WHERE id = ? AND github_id IS NULL').bind(n, old.id).run(); }
    catch { /* the same person signing in twice at the same moment: the number is on a row already */ }
    const now = await byNumber();
    if (now) return now;
    // Somebody with another number was given the old account a moment ago: this person gets a new one.
  }

  const id = uuid();
  try {
    await db.batch([
      // Only a row with a number gives up its login here, so no account is ever left unreachable by this step.
      db.prepare('UPDATE accounts SET github_login = NULL WHERE github_login = ? AND github_id IS NOT NULL').bind(login),
      db.prepare('INSERT INTO accounts (id, github_login, email, created_at, github_id) VALUES (?,?,?,?,?)').bind(id, login, email || null, Date.now(), n),
    ]);
  } catch (e) {
    const other = await byNumber();   // two sign-ins at the same moment: the other one made the account
    if (other) return other;
    throw e;
  }
  await noteActivity(env, { account_id: id, kind: 'signed_up', by: 'person', detail: { way: 'github' } });
  return { id, github_login: login, email, github_id: n };
}

/**
 * The account of a person who signed in to the dashboard with Google: found by
 * Google's own id for them, or made the first time, with the address and name
 * Google gave and no GitHub login. The one other account it can be is the one
 * an email sign-in made for the very address Google confirmed (emailAccount):
 * the person started with a link sent to that address, and Google confirming
 * it is the same proof, so that account gets Google's id and stays theirs.
 * An account that began with a GitHub sign-in is never found or changed here,
 * whatever its address, and neither is one that already has a Google id. An
 * account that began here and connected GitHub later (`linked_at`) is still
 * found, by the same Google id as before.
 */
async function googleAccount(env, { sub, email, name }) {
  const find = () => env.kiln_cloud.prepare('SELECT * FROM accounts WHERE google_sub = ?').bind(sub).first();
  // The address Google confirmed at this sign-in is written down every time, apart from `email`:
  // it is the only address Kiln writes to for this account (mail.js: accountAddress).
  const confirmed = async (id) => {
    try { await env.kiln_cloud.prepare('UPDATE accounts SET google_email = ? WHERE id = ?').bind(email || null, id).run(); }
    catch { /* a database migration 0009 has not reached: such an account is not written to */ }
  };
  const existing = await find();
  if (existing) { await confirmed(existing.id); return existing; }
  const started = await emailMadeAccount(env, email);
  if (started) {
    await env.kiln_cloud.prepare('UPDATE accounts SET google_sub = ?, name = COALESCE(name, ?) WHERE id = ? AND google_sub IS NULL').bind(sub, name || null, started.id).run();
    const now = await find();   // null only when another Google person took it a moment ago: this one gets a new account
    if (now) { await confirmed(now.id); return now; }
  }
  const id = uuid();
  try {
    await env.kiln_cloud.prepare('INSERT INTO accounts (id, github_login, email, name, google_sub, created_at) VALUES (?,?,?,?,?,?)')
      .bind(id, null, email || null, name || null, sub, Date.now()).run();
    await noteActivity(env, { account_id: id, kind: 'signed_up', by: 'person', detail: { way: 'google' } });
  } catch (e) {
    const other = await find();   // two sign-ins at the same moment: the other one made the account
    if (other) { await confirmed(other.id); return other; }
    throw e;
  }
  await confirmed(id);
  return { id, github_login: null, email: email || null, name: name || null, google_sub: sub };
}

/**
 * Which accounts a sign-in without GitHub may reach, as SQL: an account with
 * no GitHub login and no GitHub number, or one that began that way and
 * connected GitHub later (`linked_at`, migration 0019). An account that began
 * with a GitHub sign-in has no `linked_at` and is never one of them. `ask` is
 * given that condition and runs the query. A database migration 0019 has not
 * reached has no account that connected GitHub, so there the question is
 * asked again as it was before.
 */
const NO_GITHUB = '(github_login IS NULL AND github_id IS NULL)';
const NO_GITHUB_AT_FIRST = `(${NO_GITHUB} OR linked_at IS NOT NULL)`;
async function reachedWithoutGitHub(ask) {
  try { return await ask(NO_GITHUB_AT_FIRST); }
  catch (e) {
    if (!/no such column/i.test(String(e?.message || e))) throw e;
    return ask(NO_GITHUB);
  }
}

/** The account an email sign-in made for `email`, while it has no Google id: one with no GitHub, or one that connected GitHub later. Null on a database migration 0018 has not reached. */
async function emailMadeAccount(env, email) {
  const want = String(email || '').trim().toLowerCase();
  if (!want) return null;
  try { return await reachedWithoutGitHub((noGitHub) => env.kiln_cloud.prepare(`SELECT * FROM accounts WHERE signin_email = ? AND google_sub IS NULL AND ${noGitHub}`).bind(want).first()); }
  catch { return null; }
}

/**
 * Every account an address Kiln itself confirmed belongs to: the one an email
 * sign-in made for it (`signin_email`), and a Google account whose last
 * Google sign-in confirmed it (`google_email`). Never by `email`: GitHub
 * reports that one, or a person typed it, and nobody checked it. An account
 * that began with a GitHub sign-in is never one of them, whatever its
 * addresses. An account that began with one of these two and connected GitHub
 * later still is (reachedWithoutGitHub): its person keeps signing in the way
 * they started.
 */
async function confirmedAccounts(env, email) {
  const want = String(email || '').trim().toLowerCase();
  if (!mailAddress(want)) return [];
  const found = await reachedWithoutGitHub((noGitHub) => env.kiln_cloud.prepare(`SELECT * FROM accounts WHERE ${noGitHub}
      AND (signin_email = ? OR (google_sub IS NOT NULL AND lower(google_email) = ?))`).bind(want, want).all());
  return (found && found.results) || [];
}

/**
 * The account of a person who signed in to the dashboard with a link or a
 * code sent to `email` (index.js, the email sign-in): the one account that
 * address was confirmed for (confirmedAccounts), or, when there is none, a new
 * one with the address and no GitHub login, so a person can start with an
 * address alone. Answers { account }, or { twice: true } when the address
 * belongs to more than one account: Kiln cannot tell which is this person's,
 * so nobody is signed in. The database lets only one account have an address
 * in `signin_email`, so two sign-ins at the same moment make one account.
 */
async function emailAccount(env, email) {
  const want = String(email || '').trim().toLowerCase();
  if (!mailAddress(want)) throw new Error('no address');
  let found = await confirmedAccounts(env, want);
  if (found.length > 1) return { twice: true };
  if (found.length === 1) return { account: found[0] };
  const id = uuid();
  try {
    await env.kiln_cloud.prepare('INSERT INTO accounts (id, github_login, email, created_at, signin_email) VALUES (?,?,?,?,?)').bind(id, null, want, Date.now(), want).run();
    await noteActivity(env, { account_id: id, kind: 'signed_up', by: 'person', detail: { way: 'email' } });
  } catch (e) {
    found = await confirmedAccounts(env, want);   // two sign-ins at the same moment: the other one made the account
    if (found.length === 1) return { account: found[0] };
    throw e;
  }
  return { account: { id, github_login: null, email: want, name: null, google_sub: null, signin_email: want } };
}

// ─── Connecting GitHub to an account that began without it ───────────────────
//
// A person who signed in with Google or by email connects their GitHub account
// to the same Kiln account in four steps, and every one of them has to happen
// in the same browser:
//   1. POST /cloud/link/start, signed in. The dashboard is given a code that
//      works once and for ten minutes (`link:<code>` in KV), and keeps it.
//   2. GET /cloud/login?link=<code> sends the person to GitHub as any sign-in
//      does. GitHub is handed the usual state and never the code: the code is
//      kept beside that state in KV.
//   3. GET /cloud/callback. The code is taken away, GitHub says who the person
//      is, and that answer is put aside under a new key (`linkback:<key>`, ten
//      minutes). Nothing about any account changes and nobody is signed in.
//      The person goes back to the dashboard with the key.
//   4. POST /cloud/link/finish, signed in, with the key and the code. Only now
//      is the account changed, and only for a request that carries all three:
//      the session that asked in step 1, the code only that dashboard was
//      given, and the key only the browser that came back from GitHub was
//      given.
// Step 4 is why the address of step 2 is of no use to anybody else. A person
// who starts on their own account and passes that address to somebody else
// gets that somebody's GitHub answer put aside under a key they never see,
// and the somebody's browser holds neither the session nor the code. So one
// person's GitHub account is never fixed onto another person's Kiln account.

const LINK_CODE = /^[0-9a-f]{64}$/;
const hexOf = (bytes) => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
/** A code nobody can guess: 64 hex characters. */
const linkCode = () => hexOf(crypto.getRandomValues(new Uint8Array(32)));
/** What KV keeps in place of a session id or a code, so that neither can be read back out of a record that is not its own. */
async function fingerprint(secret) {
  return hexOf(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(secret)))));
}
/** The code a sign-in's kept state carries when it is a person connecting GitHub (/cloud/login?link=), or null for a plain sign-in. */
function linkOf(kept) {
  if (!kept || kept === '1') return null;
  try { const link = JSON.parse(kept).link; return LINK_CODE.test(String(link || '')) ? link : null; } catch { return null; }
}
/** The dashboard's address with `?link=<what>`: how the person is told how connecting went. */
function linkBack(dash, what) {
  try { const to = new URL(dash); to.searchParams.set('link', what); return to.toString(); }
  catch { return `${dash}?link=${what}`; }
}
/** Whether the database has `linked_at` (migration 0019). Without it nothing can be connected. */
async function canLink(env) {
  try { await env.kiln_cloud.prepare('SELECT linked_at FROM accounts LIMIT 1').first(); return true; } catch { return false; }
}
// One account may start connecting ten times in an hour: every start is a code
// in KV and can become a sign-in at GitHub. Counted under
// `linkn:<account id>:<hour>`. As for the repository names above, two requests
// at the same instant can both be let through, and the count per network
// address in index.js is the hard stop.
const LINKS_AN_HOUR = 10;
async function mayStartLink(env, accountId) {
  const key = `linkn:${accountId}:${Math.floor(Date.now() / 3600000)}`;
  let n = 0;
  try { n = Number(await env.KILN.get(key)) || 0; } catch { n = 0; }
  if (n >= LINKS_AN_HOUR) return false;
  try { await env.KILN.put(key, String(n + 1), { expirationTtl: 7200 }); } catch { /* the person is still let through */ }
  return true;
}

/**
 * Connects the GitHub person (`login`, and GitHub's number for them, `uid`) to
 * the account `accountId`, or says why not. It is the one place an account
 * that began without GitHub gets a GitHub login and number.
 *   - The account has GitHub already (the person is connecting again, to give
 *     a sign-in by email or with Google its GitHub part): the number must be
 *     the account's own. Nothing is written. Any other GitHub person is
 *     answered `other`, with the login the account is connected to.
 *   - The GitHub person already has an account, found by the number, or by the
 *     login on an account from before numbers were kept: `taken`. Two accounts
 *     are never made into one.
 *   - Else the login, the number and `linked_at` are written, on the condition
 *     that the account still has no GitHub. The database allows one account
 *     for a number, so of two accounts connecting the same GitHub person at
 *     the same moment one is written and the other is answered `taken`.
 * The account's addresses, its Google id and its name are never touched.
 * Answers { ok: true, connected } (`connected` false when nothing had to be
 * written) or { code, login? }.
 */
export async function connectGitHub(env, accountId, { login, uid } = {}, now = Date.now()) {
  const db = env.kiln_cloud;
  const n = Number.isSafeInteger(uid) && uid > 0 ? uid : null;
  const name = String(login || '');
  if (n === null || !name) return { code: 'expired' };
  const load = () => db.prepare('SELECT id, github_login, github_id FROM accounts WHERE id = ?').bind(accountId).first();
  const hasGitHub = (a) => a.github_login != null || a.github_id != null;
  const again = (a) => (a.github_id != null && Number(a.github_id) === n ? { ok: true, connected: false } : { code: 'other', login: a.github_login || null });
  let account = await load();
  if (!account) return { code: 'expired' };
  if (hasGitHub(account)) return again(account);
  const theirs = await db.prepare('SELECT id FROM accounts WHERE id <> ? AND (github_id = ? OR (github_id IS NULL AND github_login = ? COLLATE NOCASE))').bind(accountId, n, name).first();
  if (theirs) return { code: 'taken' };
  let written = 0;
  try {
    const done = await db.batch([
      // As at a GitHub sign-in (upsertAccount): a row with another number that still carries this login gave the name up on GitHub, and loses it here. Its person is found by their number.
      db.prepare('UPDATE accounts SET github_login = NULL WHERE github_login = ? AND github_id IS NOT NULL AND id <> ?').bind(name, accountId),
      db.prepare('UPDATE accounts SET github_login = ?, github_id = ?, linked_at = ? WHERE id = ? AND github_login IS NULL AND github_id IS NULL').bind(name, n, now, accountId),
    ]);
    written = Number(done && done[1] && done[1].meta && done[1].meta.changes) || 0;
  } catch (e) {
    // Only "somebody else has it" is an answer. Any other trouble is the caller's to report: nothing was written.
    if (!/constraint/i.test(String(e?.message || e))) throw e;
    return { code: 'taken' };
  }
  if (written) return { ok: true, connected: true };
  // Nothing was written: the account got a GitHub person a moment ago. The same one is fine, another is not.
  account = await load();
  return account && hasGitHub(account) ? again(account) : { code: 'taken' };
}

/**
 * GitHub sent back a person who is connecting it to the Kiln account they are
 * signed in to (step 3 above). Nobody is signed in here and no account is
 * found, made or changed: GitHub's answer is put aside for ten minutes under a
 * key that goes to this browser alone, and the dashboard finishes with it.
 * The person goes back to the dashboard with `?link=confirm#kc_link=<key>`,
 * with `?link=expired` when the code was used already or its time ran out, or
 * with `?link=failed` when GitHub did not say who they are.
 */
async function linkCameBack(request, env, url, { dash, code, state, linking, page }) {
  await env.KILN.delete(`cstate:${state}`);
  const back = (what, key = null) => signInOver(url, Response.redirect(`${linkBack(dash, what)}${key ? `#kc_link=${key}` : ''}`, 302));
  const stopped = async (stage, detail = '') => {
    console.warn(JSON.stringify({ evt: 'cloud_link_not_finished', stage, detail: String(detail || '').slice(0, 160) }));
    await noteProblem(env, { kind: 'signin_not_finished', detail: `link_${stage}` });   // the problem tally (problems.js)
    return back('failed');
  };
  // As for a sign-in: only the browser it was started in may go on.
  if (!startedHere(request, url, state)) {
    console.warn(JSON.stringify({ evt: 'cloud_link_not_finished', stage: 'cookie', detail: '' }));
    await noteProblem(env, { kind: 'signin_not_finished', detail: 'link_cookie' });   // the problem tally (problems.js)
    return page(troubleBody(forDashboard(STARTED_ELSEWHERE), { dashboard: dash }), STARTED_ELSEWHERE.status);
  }
  // The code works once: it is read and taken away before GitHub is asked anything.
  let asked = null;
  try { asked = await env.KILN.get(`link:${linking}`, 'json'); } catch { asked = null; }
  await env.KILN.delete(`link:${linking}`);
  if (!asked || !asked.account_id || !asked.by) return back('expired');
  if (!code) return stopped('github', url.searchParams.get('error') || '');
  const c = await creds(env);
  const tokRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: c.client_id, client_secret: c.client_secret, code }),
  });
  const tok = await tokRes.json().catch(() => ({}));
  if (!tok.access_token) return stopped('token', tok.error || tokRes.status);
  const user = await ghUser(tok.access_token, { fresh: true });
  // Without GitHub's number for the person nothing is connected: a login alone can change hands.
  if (!user || !user.login || !(Number.isSafeInteger(user.id) && user.id > 0)) return stopped('user');
  const key = linkCode();
  await env.KILN.put(`linkback:${key}`, JSON.stringify({ account_id: asked.account_id, by: asked.by, code: await fingerprint(linking), login: user.login, uid: user.id, gh: tok.access_token }), { expirationTtl: 600 });
  return back('confirm', key);
}

/** A dashboard session with no GitHub person behind it: the person signed in with Google, or with a link or a code sent to their address (`byEmail`). It is said of the session, never of the account: an account that connected GitHub has such a session whenever its person signs in by email or with Google, and that session holds no GitHub token. */
function withoutGitHub(sess) { return !!sess && !sess.login && !!(sess.google || sess.byEmail); }
/** The address Google or an email sign-in confirmed for such a session, and the name it goes by. */
const sessEmail = (sess) => (sess && (sess.google?.email || sess.byEmail?.email)) || null;
const sessName = (sess) => String((sess && (sess.google?.name || sess.byEmail?.name)) || '');

// POST /cloud/account, from a person who signed in with Google.
const GOOGLE_ADDRESS = 'Kiln writes to the address you signed in with. To use another address, sign in with that Google account.';
// The same, from a person who signed in with a link or a code sent to their address.
const EMAIL_ADDRESS = 'Kiln writes to the address you signed in with. To use another address, sign in with a link sent to that address.';
// POST /cloud/sites/editor: what a person reads when the editor of a site Kiln keeps the files of cannot be opened.
const EDITOR_NOT_UP = "Your site is not up yet. Press Put it on Kiln's hosting on the site's row first, then open the editor.";
const EDITOR_PLAN_ENDED = "Editing is switched off for this site, so its editor cannot be opened. Subscribe on the site's row, then open the editor again.";
// GET /cloud/sites/files: what a person reads when the site's files cannot be handed over.
const FILES_NOT_KEPT = "This site's files are in a GitHub repository of your own, so there is nothing to download here. Open the repository on GitHub to get them.";
const FILES_PAID_FIRST = "You can download this site's files once the site has been paid for. Subscribe on the site's row first.";
const FILES_NOT_NOW = 'GitHub did not answer just now, so Kiln could not get your files ready. Nothing was changed. Try again in a few minutes.';
const EDITOR_NOT_KEPT = "This site's files are in a GitHub repository of your own, so its editor opens at the site. Go to your site's address with /kiln at the end, and sign in with GitHub there.";
const EDITOR_NOT_OPENED = 'Kiln could not open the editor just now. Please try again in a few minutes.';
// GET /cloud/sites/check: a site Kiln keeps the files of has no other host, so until it is on Kiln's hosting there is no address to look at.
const CHECK_KEPT_NOT_UP = "Your site is not up yet. Press Put it on Kiln's hosting on the site's row, then check again.";

/** The name and the email an owner with no GitHub account goes by in their site's editor and on what they publish: the account's name, and the address Google or an email sign-in confirmed for them. */
async function editorPerson(env, sess) {
  let acct = null;
  try { acct = await env.kiln_cloud.prepare('SELECT name FROM accounts WHERE id = ?').bind(sess.account_id).first(); } catch { acct = null; }
  const email = String((await accountEmail(env, sess.account_id)) || sessEmail(sess) || '').trim();
  const name = String((acct && acct.name) || sessName(sess) || '').replace(/[\s\u0000-\u001f<>]+/g, ' ').trim()
    || email.split('@')[0] || String(sess.login || '') || 'Owner';
  return { name: name.slice(0, 60), email: email || null };
}

// ─── Fair use of the free days ───────────────────────────────────────────────
// What a person reads when a site they add gets no free days of its own.
const REPO_HAD_ITS_DAYS = "This repository has had its free days on Kiln, and they are over, so this site has none. Subscribe on the site's row to edit it.";
const ACCOUNT_HAD_ITS_DAYS = "Your free days began with the first site you added here, and they are over, so this site has none. Subscribe on the site's row to edit it.";
const ADDRESS_HAD_ITS_DAYS = "This site's address has had its free days on Kiln, and they are over, so this site has none. Subscribe on the site's row to edit it.";
const accountDaysLeft = (much) => `Your free days began with the first site you added here, so this site has ${much} left. Subscribe on the site's row before they end to keep editing it.`;
const repoDaysLeft = (much) => `This repository's free days began when it was first added to Kiln, so this site has ${much} left. Subscribe on the site's row before they end to keep editing it.`;
const addressDaysLeft = (much) => `This address's free days began when a site was first added to Kiln at it, so this site has ${much} left. Subscribe on the site's row before they end to keep editing it.`;
export const domainHadItsDays = (domain) => `${domain} has had its free days on Kiln, and they are over. Subscribe on the site's row to keep this site up at ${domain}.`;

/** GitHub's permanent number for the person who is signed in, or null (a session from before the number was kept, or a person signed in with Google). */
const githubNumber = (sess) => (sess && sess.uid != null && /^[1-9]\d*$/.test(String(sess.uid)) ? Number(sess.uid) : null);

/**
 * A repository's permanent number at GitHub, or null when GitHub does not
 * give it. Asked with the app's own token for the repository first, since a
 * person's token is often past its time while their dashboard is still open,
 * and then with the person's.
 */
async function repoNumber(env, tools, sess, repo) {
  const ask = async (token) => {
    if (!token) return null;
    const r = await ghAsk(`${GH}/repos/${repo}`, token);
    if (!r || !r.ok) return null;
    const j = await r.json().catch(() => null);
    return j && Number.isInteger(j.id) && j.id > 0 ? j.id : null;
  };
  let token = null;
  if (tools && typeof tools.installationToken === 'function') { try { token = await tools.installationToken(env, repo); } catch { token = null; } }
  try { return (await ask(token)) || (await ask(sess && sess.gh)); } catch { return null; }
}

/**
 * When a new site's free days began, and the sentence its owner reads about
 * them (null when the days start with this site). The days are counted from
 * the EARLIEST of three marks, each kept in KV for good, written the first
 * time the thing is seen and never written again:
 *   firstseen:<address>       the site's address, as it was typed
 *   firstseen:repo:<number>   the repository, by GitHub's permanent number for
 *                             it, so a new name or a new address is the same
 *                             repository
 *   firstseen:gh:<number>     the GitHub account, by GitHub's permanent number
 *                             for it. It is written for every account and
 *                             counted only for one that pays for no site (the
 *                             rule keeps.js follows for the sites Kiln keeps).
 * A number that is not known (GitHub did not give the repository's, or the
 * session is from before the account's was kept) is left out, and the other
 * marks count. No rule starts the days again: a person at Kiln deletes a mark
 * by hand when someone asks.
 */
export async function freeDayClock(env, { accountId, origin, repoId = null, ghId = null, now = Date.now() }) {
  const day = 86400 * 1000;
  const mark = async (key) => {
    const was = Number(await env.KILN.get(key)) || null;
    if (!was) await env.KILN.put(key, String(now));   // no expiry: the mark stays
    return was;
  };
  const address = await mark(`firstseen:${origin}`);
  const repository = Number.isInteger(repoId) && repoId > 0 ? await mark(`firstseen:repo:${repoId}`) : null;
  let account = Number.isInteger(ghId) && ghId > 0 ? await mark(`firstseen:gh:${ghId}`) : null;
  if (account) {
    let paying = false;
    try { paying = !!(await env.kiln_cloud.prepare("SELECT id FROM sites WHERE account_id = ? AND status = 'active' LIMIT 1").bind(accountId).first()); } catch { paying = false; }
    if (paying) account = null;
  }
  const began = Math.min(now, ...[address, repository, account].filter(Boolean));
  const ends = (t) => t + TRIAL_GRACE_DAYS * day;
  const over = ends(began) <= now;
  let sentence = null;
  if (over) sentence = repository && ends(repository) <= now ? REPO_HAD_ITS_DAYS : account && ends(account) <= now ? ACCOUNT_HAD_ITS_DAYS : ADDRESS_HAD_ITS_DAYS;
  else if (began < now) {
    // The days began before this site was added, so its owner is told why it has fewer than seven, by the mark they are counted from.
    // Counted as keeps.js freeDaysSentence counts them: part of a day is a day, and the last day is "less than one".
    const whole = Math.ceil((ends(began) - now) / day);
    const much = whole >= 2 ? `${whole} free days` : 'less than one free day';
    // Days that began a few hours ago still count as all seven, and then there is nothing to tell.
    if (whole < TRIAL_GRACE_DAYS) sentence = account && account === began ? accountDaysLeft(much) : repository && repository === began ? repoDaysLeft(much) : addressDaysLeft(much);
  }
  return { began, over, sentence };
}

/**
 * A domain's own free days, for a site on Kiln's hosting that is not paid for.
 * The mark `firstseen:domain:<name, lower case>` is written, for good, when a
 * site that is not paid for goes live on the domain (`goesLive`), and holds
 * when that site's free days began. A later site that sets the domain up, or
 * goes live on it, has its free days counted from the mark: its row is brought
 * in line at once, and when the days are over the answer is the sentence its
 * owner reads. A site that is paid for is left alone and writes no mark.
 */
export async function domainFreeDays(env, siteId, name, { now = Date.now(), goesLive = false } = {}) {
  const domain = String(name || '').trim().toLowerCase();
  if (!domain) return null;
  try {
    const paidBy = await subscriptionSql(env);
    const s = await env.kiln_cloud.prepare(`SELECT id, status, created_at, ${paidBy} AS subscription_id FROM sites WHERE id = ?`).bind(siteId).first();
    if (!s || subscriptionOf(s) || s.status === 'active') return null;
    const key = `firstseen:domain:${domain}`;
    const mark = Number(await env.KILN.get(key)) || null;
    if (!mark) {
      if (goesLive) await env.KILN.put(key, String(Math.min(Number(s.created_at) || now, now)));   // no expiry
      return null;
    }
    const over = mark + TRIAL_GRACE_DAYS * 86400 * 1000 <= now;
    if (s.status === 'trialing' && mark < Number(s.created_at)) {
      await env.kiln_cloud.prepare(`UPDATE sites SET created_at = ?, status = ? WHERE id = ? AND status = 'trialing' AND ${paidBy} IS NULL`)
        .bind(mark, over ? 'canceled' : 'trialing', siteId).run();
    }
    return over ? domainHadItsDays(domain) : null;
  } catch (e) {
    console.warn(JSON.stringify({ evt: 'domain_free_days_not_read', site: siteId, name: domain, detail: String(e?.message || e).slice(0, 200) }));
    return null;
  }
}

/**
 * Writes a new site's row, on the free trial every new site gets, and answers
 * it. `kept` marks a site whose files Kiln keeps (keeps.js), which is the only
 * caller that names an `id`.
 */
async function registerSite(env, { id = uuid(), accountId, repo, origin, plan, kept = false, name = null, since = null, days = null, way = null }) {
  // Fair use: the free days are counted from the first time this address was
  // added, so removing a site and adding it again cannot start them again.
  // `days` is the clock of a site in a person's own repository, which counts
  // the repository and the GitHub account as well (freeDayClock).
  const now = Date.now();
  let createdAt = (days || await freeDayClock(env, { accountId, origin, now })).began;
  // A site Kiln keeps has a new address every time it is started, so the address cannot say whether
  // the free days were had before. They are counted for the account instead (keeps.js): `since` is
  // when the account's first kept site was started, for an account that pays for nothing.
  if (kept && Number(since) > 0 && Number(since) < createdAt) createdAt = Number(since);
  // A site whose free days are already over is written as ended at once, so it is never open for editing until the next sweep.
  const over = createdAt + TRIAL_GRACE_DAYS * 86400 * 1000 <= now;
  const site = { id, account_id: accountId, repo, origin, plan: plan === 'managed' ? 'managed' : 'cloud', status: over ? 'canceled' : 'trialing', created_at: createdAt };
  // `kept` arrives with migration 0008, so only a kept site's row names the column.
  // A kept site also keeps the name its owner typed for it.
  if (kept) {
    await env.kiln_cloud.prepare('INSERT INTO sites (id, account_id, repo, origin, plan, status, created_at, kept, name) VALUES (?,?,?,?,?,?,?,1,?)')
      .bind(site.id, site.account_id, site.repo, site.origin, site.plan, site.status, site.created_at, name ? String(name).slice(0, 60) : null).run();
  } else {
    await env.kiln_cloud.prepare('INSERT INTO sites (id, account_id, repo, origin, plan, status, created_at) VALUES (?,?,?,?,?,?,?)')
      .bind(site.id, site.account_id, site.repo, site.origin, site.plan, site.status, site.created_at).run();
  }
  await env.KILN.delete(`cloudgone:${String(site.repo).toLowerCase()}`);
  // The activity record (activity.js): which way the site came to Kiln.
  await noteActivity(env, { account_id: site.account_id, site_id: site.id, kind: 'site_added', by: 'person', detail: { way: way || (kept ? 'starter' : 'github') } });
  return site;
}

/** Who is signed in, for a note to the operator: the GitHub login, or the address Google or an email sign-in confirmed. */
export function signedInAs(sess) { return sess.login || sessEmail(sess) || (sess.byEmail ? 'somebody signed in by email' : 'somebody signed in with Google'); }

/**
 * Whose name a change made from the dashboard carries in the repository's
 * history. A person signed in with GitHub is the author as GitHub knows them.
 * A person signed in with Google, or by email, has no GitHub name: the author
 * is their own name with "(via Kiln)" after it (the part of the address before
 * the @ when Kiln knows no name), and the address Google or the email sign-in
 * confirmed for them (never one that was typed into the dashboard, which
 * nobody confirmed).
 */
export async function commitAuthor(env, sess) {
  if (sess.login) {
    const uid = sess.uid != null && /^\d+$/.test(String(sess.uid)) ? `${sess.uid}+` : '';
    return { name: sess.login, email: `${uid}${sess.login}@users.noreply.github.com` };
  }
  const email = (await accountEmail(env, sess.account_id)) || sessEmail(sess) || null;
  const name = sessName(sess).trim() || String(email || 'Somebody').split('@')[0];
  return { name: `${name}${VIA_KILN}`, email };
}

/**
 * Whose name a change carries when the service makes it for an account and
 * nobody is signed in (a site put up after its copy, bring.js): the account's
 * own name and address, in the form commitAuthor gives for that account. The
 * account's row does not keep GitHub's number for a person, so a GitHub
 * account's address is the one without it.
 */
export async function accountAuthor(env, accountId) {
  let acct = null;
  // `name` arrives with migration 0008: ask for it, then for the older columns alone.
  try { acct = await env.kiln_cloud.prepare('SELECT github_login, name, email FROM accounts WHERE id = ?').bind(accountId).first(); }
  catch { try { acct = await env.kiln_cloud.prepare('SELECT github_login, email FROM accounts WHERE id = ?').bind(accountId).first(); } catch { acct = null; } }
  return commitAuthor(env, { account_id: accountId, login: (acct && acct.github_login) || null, uid: null, google: { name: (acct && acct.name) || '', email: null } });   // the address is read by commitAuthor: the one Kiln may use for the account, or none
}

// ─── Billing ─────────────────────────────────────────────────────────────────

/**
 * True when this service sells the hosting plan by the year as well: Stripe
 * sells here and the plan's yearly price is set (STRIPE_PRICE_MANAGED_YEARLY).
 * Its amount lives with Stripe. Where it is not set, nothing here knows of a
 * yearly plan.
 */
export function yearlyOn(env) { return billingOn(env) && stripeYearlyOn(env); }
/** True when the plan without hosting is sold by the year as well (STRIPE_PRICE_CLOUD_YEARLY). It includes no domain. */
export function cloudYearlyOn(env) { return billingOn(env) && stripeCloudYearlyOn(env); }

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
    await noteProblem(env, { kind: 'email_not_sent', detail: 'operator' });   // the problem tally (problems.js)
  }
}

/**
 * The address Kiln writes to for a dashboard account, and starts a checkout with: the account's
 * own for a GitHub account, and for an account that signed in with Google the address Google
 * confirmed and no other (mail.js). Never fails a request.
 */
const accountEmail = (env, accountId) => accountAddress(env, accountId);

/**
 * Stripe's payment page for one site (billing.js). An account that has paid
 * before keeps its Stripe customer, so its sites share one billing page.
 * Answers the page's address, or null. Where Stripe's key is not set nobody
 * can pay, and the answer is null without anything being asked.
 */
async function startCheckout(env, site, { email = null, period = 'month', accountId = null } = {}) {
  if (!billingOn(env)) return null;
  return stripeCheckout(env, site, { email, period, customer: await stripeCustomerOf(env, site, accountId) });
}
async function stripeCustomerOf(env, site, accountId = null) {
  if (site && site.stripe_customer_id) return site.stripe_customer_id;
  try { return (await env.kiln_cloud.prepare('SELECT stripe_customer_id FROM accounts WHERE id = ?').bind(accountId || (site && site.account_id) || '').first())?.stripe_customer_id || null; }
  catch { return null; }   // a database migration 0017 has not reached
}
/** "Manage billing" for a site (a whole row of `sites`): Stripe's Billing Portal for the customer its subscription belongs to, or null for a site with no subscription. */
async function billingPage(env, site, accountId) {
  if (!site || subscriptionProvider(site) !== 'stripe') return null;
  return stripePortal(env, await stripeCustomerOf(env, site, accountId));
}
/** Cancel a site's subscription (a whole row of `sites`) at Stripe. The answer is stripeCancel's (billing.js); a site with no subscription answers `none`. */
export function cancelSubscription(env, site) {
  return stripeCancel(env, site && site.stripe_subscription_id);
}
/** The store line on the admin page: where the Stripe account stands, or `unconfigured` where its key is not set. */
const storeMode = (env) => stripeStoreMode(env);

const NOT_CANCELLED = 'This site has a subscription that could not be cancelled just now, so the site was not removed and nothing changed. '
  + 'Open Manage billing, cancel the subscription there, then remove the site.';

// How long editing stays on after a charge fails, while Stripe tries the card
// again. STRIPE_STATE, beside Stripe's webhook further down, says which
// subscription states start these days.
export const PAST_DUE_GRACE_DAYS = 7;

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
    const row = await env.kiln_cloud.prepare(`SELECT status, ${await subscriptionSql(env)} AS subscription_id FROM sites WHERE origin = ? LIMIT 1`).bind(origin).first();
    if (!row) return { known: false };
    return { known: true, status: row.status, trialEnded: row.status === 'canceled' && !subscriptionOf(row) };
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
// forever without ever subscribing. Expire `trialing` sites that never started a
// subscription once they pass the grace window; that drops them from the editable
// allowlist (a canceled site with no access_until has no access). A site that has a
// subscription is left alone: its state comes from Stripe's webhook and from nothing else.
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
  if (!subscriptionOf(site)) {
    if (site.status !== 'canceled' || !Number(site.created_at)) return null;
    return Number(site.created_at) + (TRIAL_GRACE_DAYS + HOSTING_AFTER_TRIAL_DAYS) * day;
  }
  if ((site.status !== 'canceled' && site.status !== 'past_due') || !Number(site.access_until)) return null;
  return Number(site.access_until) + HOSTING_AFTER_PAID_DAYS * day;
}
/** Why a hosted site comes down when hostingEndsAt says it does: the word kept on its record (hosting.js has the sentence). */
export const hostingEndReason = (site) => (subscriptionOf(site) ? 'plan_ended' : 'trial_ended');
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
  if (!subscriptionOf(site) || !deployed || !customerMailOn(env)) return plain;
  let email = site.email;
  if (email === undefined) {
    try { email = (await env.kiln_cloud.prepare(`SELECT ${await addressSql(env)} FROM sites s JOIN accounts a ON a.id = s.account_id WHERE s.id = ?`).bind(site.id).first())?.email; }
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
  // The sentence for a site that was taken down says where its files are, so only such a site is asked about.
  const kept = !!row && (row.reason === 'trial_ended' || row.reason === 'plan_ended') && !!(await keptSite(env, site.id));
  // `paid`: an owner who has subscribed since the site was taken down reads what to press, and one who has not reads to subscribe first.
  return publicHosting(row, { repo: site.repo, endsAt: down?.at || null, planEnded: Number(site.access_until) || null, kept, paid: siteHasAccess(site, now) });
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
    const account = { email: await accountEmail(env, accountId) };
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
    `SELECT s.id, s.repo, s.origin, ${await addressSql(env)}, h.url AS temp_url FROM sites s
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
    // The domain's own free days (domainFreeDays): the mark is written here, and a site that goes live on a domain that has had them gets no fresh ones.
    if (await domainFreeDays(env, s.id, name, { now, goesLive: true })) console.log(JSON.stringify({ evt: 'domain_free_days_over', repo: s.repo, name }));
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
    await noteActivity(env, { site_id: s.id, kind: 'domain_live', by: 'kiln' });
  } catch (e) {
    console.warn(JSON.stringify({ evt: 'domain_took_hold_failed', site: site?.id, name: row?.name, detail: why(e) }));
  }
  return { live };
}

const DOMAINS_PER_RUN = 10;                         // the five-minute job looks at this many domains at most; the rest wait their turn
const DOMAIN_REMIND_AFTER_DAYS = 14;                // a set-up that has waited this long gets one reminder
const DOMAIN_LIVE_LOOK_EVERY_MS = 60 * 60 * 1000;   // a live domain is looked at this often at most
const REGISTERED_LATE_MS = 60 * 60 * 1000;         // a name Kiln registered that still waits this long after its set-up began: the operator is told, once
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
      `SELECT d.*, s.repo, s.origin, ${await addressSql(env)}, h.url AS temp_url FROM domains d
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
      // A name Kiln registered for the site (register.js): nobody has name servers to change, so its owner is not reminded
      // and the set-up is never put away for waiting. When it still waits an hour after it began, the operator is told, once.
      const registeredLate = async () => {
        if (!r.registered || r.state !== 'waiting' || r.reminded_at || now - Number(r.created_at || now) < REGISTERED_LATE_MS) return false;
        await saveDomain(env, s.id, { reminded_at: now, checked_at: now });
        console.warn(JSON.stringify({ evt: 'registered_domain_late', repo: s.repo, name, status }));
        await notifyOwner(env, `${name} is registered and still not live after an hour`, [
          `Repository: ${s.repo}`,
          `Domain: ${name}`,
          `Cloudflare says its zone is: ${status}`,
          'Kiln registered this name for the site, so nobody has name servers to change. The name is safe and Kiln keeps looking every five minutes. This note is sent once.',
        ]);
        return true;
      };

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
        if (await registeredLate()) continue;
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
        // The operator hears of it too: the owner may write next, and the playbook says what each reason means.
        await notifyOwner(env, `Kiln: the set-up of ${name} was put away`, [`Site: ${s.repo}, ${r.origin || ''}`, `Why: ${reason}`, 'Its owner was told by email. Nothing is needed from you unless they write.']);
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
      if (r.registered) {
        if (await registeredLate()) continue;
      } else if (waited >= DOMAIN_LIMITS.waitDays * day) {
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
        `SELECT s.id, s.repo, s.account_id, ${await addressSql(env)}, d.name, d.zone_id, d.state AS domain_state FROM sites s
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
// What an email about a site that comes down says of its files and of its own
// domain: whether Kiln keeps the files (migration 0008) and the domain the
// site is live at (0006). A database those have not reached is asked without.
const LEAVING_COLUMNS = ', s.kept, d.name AS domain';
const LEAVING_JOIN = " LEFT JOIN domains d ON d.site_id = s.id AND d.state = 'live'";

export async function noticeEndingHosting(env, now = Date.now()) {
  const out = { sent: 0, undated: 0 };
  if (!env.kiln_cloud || !hostingOn(env)) return out;
  let rows = [];
  try {
    const address = await addressSql(env);
    const paidBy = await subscriptionSql(env, 's.');
    const ask = async (more, join) => env.kiln_cloud.prepare(
      `SELECT s.id, s.repo, s.origin, s.plan, s.status, s.access_until, s.created_at, ${paidBy} AS subscription_id, h.deployed_at, ${address}${more}
       FROM hosting h JOIN sites s ON s.id = h.site_id LEFT JOIN accounts a ON a.id = s.account_id${join}
       WHERE ${paidBy} IS NOT NULL AND s.status IN ('canceled','past_due') AND h.state NOT IN ('removing','ended')
       ORDER BY s.access_until`).all();
    rows = (await ask(LEAVING_COLUMNS, LEAVING_JOIN).catch(() => ask('', '')))?.results || [];
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
      const about = { origin: r.origin, plan: r.plan, repo: r.repo, endsAt: end, pastDue: r.status === 'past_due', dashboard, kept: !!r.kept, domain: r.domain || null, registered: await registeredFor(env, r.id) };
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
        const marker = `hostnodate:${r.id}:${subscriptionOf(r)}`;
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
    const address = await addressSql(env);
    const ask = async (more, join) => env.kiln_cloud.prepare(
      `SELECT s.id, s.origin, s.plan, s.created_at, ${address}${more} FROM sites s JOIN accounts a ON a.id = s.account_id${join}
       WHERE s.status = 'trialing' AND ${await subscriptionSql(env, 's.')} IS NULL AND s.created_at <= ? AND s.created_at > ?
       ORDER BY s.created_at LIMIT ${MAILS_PER_RUN}`
    ).bind(now - (TRIAL_GRACE_DAYS - TRIAL_NOTICE_DAYS) * day, now - TRIAL_GRACE_DAYS * day).all();
    const rows = await ask(LEAVING_COLUMNS, LEAVING_JOIN).catch(() => ask('', ''));
    for (const r of rows?.results || []) {
      if (!mailAddress(r.email)) continue;
      const res = await sendOnce(env, `trial-soon:${r.id}`, r.email, trialEndingMail({ origin: r.origin, plan: r.plan, kept: !!r.kept, domain: r.domain || null, endsAt: trialEndsAt(r.created_at, TRIAL_GRACE_DAYS), dashboard: env.CLOUD_DASHBOARD || 'https://app.kilncms.com' }));
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
    const address = await addressSql(env);
    const ask = async (more, join) => env.kiln_cloud.prepare(
      `SELECT s.id, s.repo, s.origin, s.plan, ${address}${more} FROM sites s LEFT JOIN accounts a ON a.id = s.account_id${join}
       WHERE s.status = 'trialing' AND ${await subscriptionSql(env, 's.')} IS NULL AND s.created_at < ?`
    ).bind(cutoff).all();
    expiring = await ask(LEAVING_COLUMNS, LEAVING_JOIN).catch(() => ask('', ''));
  } catch { /* a reduced D1 stand-in has no .all(): expiry still proceeds, just unannounced */ }
  await env.kiln_cloud.prepare(
    `UPDATE sites SET status = 'canceled' WHERE status = 'trialing' AND ${await subscriptionSql(env)} IS NULL AND created_at < ?`
  ).bind(cutoff).run();
  const rows = expiring?.results || [];
  // The activity record (activity.js): one line for each site whose free days just ended.
  if (activityOn(env)) for (const r of rows) if (r.id) await noteActivity(env, { site_id: r.id, kind: 'free_days_ended', by: 'kiln' });
  if (rows.length) {
    await notifyOwner(env, `Kiln: ${rows.length} trial${rows.length === 1 ? '' : 's'} expired unpaid`, rows.map(r => `${r.repo} (${r.origin})`));
    // The owner of each is told too, once: the trial used to end in silence.
    for (const r of rows.slice(0, MAILS_PER_RUN)) {
      if (r.id && mailAddress(r.email)) await sendOnce(env, `trial-ended:${r.id}`, r.email, trialEndedMail({ origin: r.origin, plan: r.plan, kept: !!r.kept, domain: r.domain || null, dashboard: env.CLOUD_DASHBOARD || 'https://app.kilncms.com' }));
    }
  }
}

/**
 * Seven more free days for one site, at the operator's word (POST
 * /admin/cloud/grant). A site's free days are counted from its `created_at`,
 * so that is what moves: seven days on when the days are still running, to
 * this moment when they are over (seven full days from now). The site is
 * `trialing` again, and Kiln's two notes about the end of the days can go
 * once more for the new end. Only a site with no subscription has free days:
 * one that is paid for is Stripe's to change. With `always` false (the
 * operator only set the status to `trialing`) it acts on a site whose days
 * are over and on nothing else, and answers null so the status is set as
 * before. The marks that stop free days from starting again for a site that
 * is removed and added once more (freeDayClock) are left as they are; the
 * mark of the site's own domain moves with the days.
 */
export async function moreFreeDays(env, siteId, { always = false, now = Date.now() } = {}) {
  const span = TRIAL_GRACE_DAYS * 86400 * 1000;
  const paidBy = await subscriptionSql(env);
  const s = await env.kiln_cloud.prepare(`SELECT id, status, created_at, ${paidBy} AS subscription_id FROM sites WHERE id = ?`).bind(String(siteId || '')).first();
  if (!s) return always ? { status: 404, body: { error: 'There is no such site.', code: 'no_such_site' } } : null;
  if (subscriptionOf(s)) return always ? { status: 409, body: { error: 'That site has a subscription, so it has no free days to add to. Its dates are changed in Stripe.', code: 'subscribed' } } : null;
  const ends = Number(s.created_at) + span;
  const over = !(ends > now);
  if (!always && !over) return null;
  const from = over ? now : ends;   // the new `created_at`: the days now end seven days after it
  await withAccessUntil(
    () => env.kiln_cloud.prepare(`UPDATE sites SET status = 'trialing', created_at = ?, access_until = NULL WHERE id = ? AND ${paidBy} IS NULL`).bind(from, s.id).run(),
    () => env.kiln_cloud.prepare(`UPDATE sites SET status = 'trialing', created_at = ? WHERE id = ? AND ${paidBy} IS NULL`).bind(from, s.id).run(),
  );
  // A site on a domain of its own: that domain's free days are counted from a mark of its own (domainFreeDays),
  // written when the site went live there. The days just given are the operator's word for the site wherever
  // it answers, so the mark moves with them: left behind, it would take the days back the next time the domain
  // is set up or goes live.
  try {
    const name = String((await domainRow(env, s.id))?.name || '').trim().toLowerCase();
    if (name) {
      const key = `firstseen:domain:${name}`;
      const mark = Number(await env.KILN.get(key)) || null;
      if (mark && mark < from) await env.KILN.put(key, String(from));
    }
  } catch { /* the mark stays where it was */ }
  // "Your free days end soon" and "your free days have ended" are sent once for a site (sendOnce): for the new end they may go again.
  for (const note of ['trial-soon', 'trial-ended']) { try { await env.KILN.delete(`mail:${note}:${s.id}`); } catch { /* the note then stays sent, and nothing else is lost */ } }
  await noteActivity(env, { site_id: s.id, kind: 'free_days_given', by: 'operator', detail: { days: TRIAL_GRACE_DAYS } });
  return { status: 200, body: { ok: true, status: 'trialing', trial_ends: from + span, days: TRIAL_GRACE_DAYS } };
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
  if (withoutGitHub(sess)) return false;   // the operator is a GitHub person: a Google or email sign-in is never the operator, whatever GitHub account its Kiln account is connected to
  const id = String(env.CLOUD_ADMIN_ID || '').trim();
  if (id) return /^\d+$/.test(id) && sess.uid != null && String(sess.uid) === id;
  return !!env.CLOUD_ADMIN && sess.login === env.CLOUD_ADMIN;
}

// When Kiln was added to each site's repository from the dashboard (or found
// already there). The columns arrive with migration 0003; a database it has
// not reached answers as if nothing were recorded, and nothing else changes.
/**
 * When a person was last at the dashboard (`accounts.last_seen`, migration
 * 0020), for the operator's list of customers. A sign-in always writes it.
 * The dashboard's own account request passes `olderThan`, and then it is
 * written only when what is stored is older than that, so an open dashboard
 * costs one write an hour: the database makes the comparison in the same
 * statement, and a statement that matches no row writes nothing. Never
 * throws: a database the column has not reached, or one that is not
 * answering, changes nothing for the person.
 */
const SEEN_EVERY = 3600 * 1000;

/**
 * The campaign tags a dashboard sent ({source, medium, campaign}, or the same
 * named utm_*), each trimmed, at most 80 characters of letters, digits, spaces
 * and . _ ~ + -; a tag that is anything else is left out. Null when none is
 * left. Nothing else of the request is kept.
 */
const CAME_FROM_WINDOW_MS = 3600 * 1000;   // tags describe how an account was made: they are taken in its first hour only
export function campaignTags(body) {
  const one = (k) => {
    const v = body && typeof body === 'object' ? (body[k] ?? body[`utm_${k}`]) : null;
    const t = typeof v === 'string' ? v.trim() : '';
    return t && t.length <= 80 && /^[\w .~+-]+$/.test(t) ? t : null;
  };
  const tags = { source: one('source'), medium: one('medium'), campaign: one('campaign') };
  return tags.source || tags.medium || tags.campaign ? tags : null;
}
export async function noteSeen(env, accountId, { now = Date.now(), olderThan = 0 } = {}) {
  try {
    if (!env.kiln_cloud || !accountId) return;
    await env.kiln_cloud.prepare('UPDATE accounts SET last_seen = ? WHERE id = ? AND (last_seen IS NULL OR last_seen <= ?)').bind(now, accountId, now - olderThan).run();
  } catch { /* nothing is recorded, and the request goes on */ }
}

/**
 * A change was saved to a repository through Kiln: every Cloud site of that
 * repository gets the moment (`sites.last_publish`, migration 0020). index.js
 * calls it wherever the worker itself learns that GitHub took a write to a
 * site's branch. At most one write a minute for a repository, by the same
 * comparison in the statement as `noteSeen`. A repository that is no Cloud
 * site matches no row. Never throws, so it cannot fail the save it follows.
 */
const PUBLISH_EVERY = 60 * 1000;
export async function notePublish(env, repo, { now = Date.now(), by = null, scheduled = false } = {}) {
  try {
    if (!env.kiln_cloud || typeof repo !== 'string' || !repo) return;
    await env.kiln_cloud.prepare('UPDATE sites SET last_publish = ? WHERE lower(repo) = lower(?) AND (last_publish IS NULL OR last_publish <= ?)').bind(now, repo, now - PUBLISH_EVERY).run();
  } catch { /* the save went through all the same */ }
  // The activity record (activity.js): every publish, the site and who published it (`by`: person for the
  // owner, editor for an invited editor), never what changed. It writes nothing while it is off.
  await notePublished(env, repo, { by, scheduled, at: now });
}

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
export async function markPrepared(env, siteId, commit, by = 'person') {
  try {
    await env.kiln_cloud.prepare('UPDATE sites SET prepared_at = COALESCE(prepared_at, ?), prepared_commit = COALESCE(?, prepared_commit) WHERE id = ?').bind(Date.now(), commit || null, siteId).run();
    await noteActivity(env, { site_id: siteId, kind: 'setup_step', by, detail: { step: 'kiln_added' } });
  } catch { /* the repository is prepared all the same; the dashboard offers the button again and is told so */ }
}
export async function markFirstPass(env, siteId, commit, by = 'person') {
  try {
    await env.kiln_cloud.prepare('UPDATE sites SET firstpass_at = COALESCE(firstpass_at, ?), firstpass_commit = COALESCE(?, firstpass_commit) WHERE id = ?').bind(Date.now(), commit || null, siteId).run();
    await noteActivity(env, { site_id: siteId, kind: 'setup_step', by, detail: { step: 'marked_for_editing' } });
  } catch { /* the pages are marked all the same; the dashboard offers the button again and is told there is nothing left */ }
}

/** Said to the owner of a site whose files Kiln keeps when the service cannot reach those files: nothing of theirs to install or to fix. */
const KEPT_NOT_REACHED = "Kiln could not reach your site's files just now. Wait a minute and try again. If it keeps happening, write to hello@kilncms.com.";
const keptNotReached = () => json({ error: KEPT_NOT_REACHED, code: 'not_reached' }, 502);

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
  // A person signed in with Google or by email holds no GitHub token, so there
  // is no repository they could be checked against. A kept site of their own
  // is the only site they reach, and every other one is refused. That is so
  // for an account that connected GitHub too, on the days its person signs in
  // without it: the session decides, not the account.
  if (withoutGitHub(sess) && !mine) return { response: json({ error: NEEDS_GITHUB_FOR_SITE, code: 'needs_github' }, 403) };
  const site = await withAccessUntil(
    () => env.kiln_cloud.prepare('SELECT id, repo, origin, plan, status, access_until FROM sites WHERE id = ? AND account_id = ?').bind(id || '', sess.account_id).first(),
    () => env.kiln_cloud.prepare('SELECT id, repo, origin, plan, status FROM sites WHERE id = ? AND account_id = ?').bind(id || '', sess.account_id).first(),
  );
  if (!site) {
    // The security log (security-log.js): a site on Kiln that is another account's, asked for by this one.
    if (id && securityOn(env) && await env.kiln_cloud.prepare('SELECT 1 AS y FROM sites WHERE id = ? AND account_id != ?').bind(String(id), sess.account_id).first().catch(() => null)) {
      await noteSecurity(env, { kind: 'cross_account', account_id: sess.account_id, site_id: id, detail: 'site' });
    }
    return { response: json({ error: 'That site is not on this account.', code: 'no_such_site' }, 404) };
  }
  const access = siteHasAccess(site);
  if (!access && needAccess) {
    return { response: json({ error: 'Editing is switched off for this site, so Kiln cannot change its repository. Subscribe on the site\'s row, then try again.', code: 'plan_ended' }, 403) };
  }
  const owner = String(site.repo).split('/')[0].toLowerCase();
  if (!mine && !(owner === String(sess.login || '').toLowerCase() || await userCanPush(sess.gh, site.repo))) {
    await noteSecurity(env, { kind: 'cross_account', account_id: sess.account_id, site_id: site.id, detail: 'repo' });   // the security log (security-log.js)
    return { response: json({ error: NOT_YOUR_REPO, code: 'not_yours' }, 403) };
  }
  let token = null;
  if (typeof tools.installationToken === 'function') {
    try { token = await tools.installationToken(env, site.repo); }
    catch (e) { if (needToken) throw e; }   // a route that answers without it says so itself
  }
  // The owner of a site whose files Kiln keeps has no GitHub account and nothing to install: when the
  // service cannot reach those files, that is Kiln's to put right, and the person is told so.
  if (!token && needToken && mine) { console.warn(JSON.stringify({ evt: 'kept_not_reached', repo: site.repo })); return { response: keptNotReached() }; }
  if (!token && needToken) return { response: json({ error: prepareSentence('no_access', { repo: site.repo }), code: 'no_access', install_url: await installUrlFor(env) }, 409) };
  return { site: mine ? { ...site, kept: 1 } : site, token, write, body, access };
}

const BUSY = 'Kiln is already putting this site up. Give it a minute, then reload this page.';
/** Who is acting, for the operator's note, when the service puts a site up after its copy and nobody is signed in. */
export const AFTER_A_COPY = 'Kiln, after a copy';

/**
 * Puts a site on Kiln's hosting for the first time, or publishes it again.
 * This is the one piece of code behind POST /cloud/sites/hosting, for a
 * signed-in owner, and behind the copying job's answer (hostCopied, below),
 * where nobody is signed in. Nobody is asked who they are here: the caller has
 * settled whose site it is, and hands in plain values.
 *
 *   site       the site's row: id, repo, origin, plan
 *   token      the token that reads and writes its repository
 *   accountId  the account the site is on, for the count of free hosted sites
 *   author     whose name the commits carry, { name, email }, or a function
 *              that answers it, which is asked only when a commit may be made
 *   by         who is acting, for the operator's note
 *   worker     this service's address
 *
 * Answers { status, body }, which the route sends as they are.
 */
export async function putOnHosting(env, { site, token, accountId, author, by, worker }) {
  if (!hostingOn(env)) return { status: 503, body: { error: hostingSentence('not_set_up'), code: 'not_set_up' } };
  if (site.plan !== 'managed') {
    return { status: 403, body: { error: 'Hosting is part of the Kiln Cloud + hosting plan. This site is on Kiln Cloud, where it stays on your own host.', code: 'not_on_plan' } };
  }
  const row = await hostingRow(env, site.id);
  // Until an account has paid for a site, it may have this many hosted ones.
  if (!row) {
    const unpaid = await env.kiln_cloud.prepare(
      `SELECT COUNT(*) n FROM hosting h JOIN sites s ON s.id = h.site_id WHERE s.account_id = ? AND ${await subscriptionSql(env, 's.')} IS NULL AND h.state != 'removing'`).bind(accountId).first().catch(() => ({ n: 0 }));
    const paid = await env.kiln_cloud.prepare(`SELECT COUNT(*) n FROM sites WHERE account_id = ? AND ${await subscriptionSql(env)} IS NOT NULL`).bind(accountId).first().catch(() => ({ n: 0 }));
    if (!Number(paid?.n) && Number(unpaid?.n) >= FREE_HOSTED_SITES) {
      return { status: 403, body: { error: `During the free days Kiln hosts ${FREE_HOSTED_SITES === 1 ? 'one site' : `${FREE_HOSTED_SITES} sites`} for an account. Subscribe for one of your sites, then put this one up.`, code: 'free_limit' } };
    }
  }
  let care = null;
  if (!row || !row.deployed_at || await careOwed(env, site.id)) {
    const who = typeof author === 'function' ? await author() : author;
    care = await lookAfter(env, {
      site, token, worker,
      author: who,
      firstpassAt: (await preparedTimes(env, accountId))[site.id]?.firstpass_at || null,
      record: { prepared: (sha) => markPrepared(env, site.id, sha, 'kiln'), firstPass: (sha) => markFirstPass(env, site.id, sha, 'kiln') },
    });
    if (!care) return { status: 409, body: { error: BUSY, code: 'busy' } };
  }
  const looked = care ? { looked_after: care } : {};
  const out = await publishSite(env, { site, token });
  if (out.state === 'busy') return { status: 409, body: { error: BUSY, code: 'busy', ...looked } };
  if (out.state === 'failed') return { status: 502, body: { error: out.error || hostingSentence(out.reason), code: out.reason || 'cloudflare', hosting: out, ...looked } };
  if (out.state === 'live' && !row) {
    await notifyOwner(env, `Kiln hosts ${site.repo}`, [`By: ${by}`, `Address: ${out.url}`, `Files: ${out.files}`,
      ...(care || []).map(c => `${c.step}: ${c.state}${c.code ? ` (${c.code})` : ''}${c.commit ? ` ${c.commit.url}` : ''}`)]);
  }
  return { status: 200, body: { ok: out.state === 'live', hosting: out, ...looked, ...(out.state !== 'live' ? { error: out.error, code: out.reason } : {}) } };
}

/**
 * Puts a site on Kiln's hosting right after its copy (bring.js), with nobody
 * signed in. Whose site it is was settled when the copy was asked for: it is
 * the account on the copy's row. The commits carry that account's own name
 * and address (accountAuthor). Answers { ok: true, url }, or { ok: false,
 * code, detail } with the site left as it was. Never throws.
 */
async function hostCopied(env, tools, { id, accountId, worker }) {
  try {
    const site = await withAccessUntil(
      () => env.kiln_cloud.prepare('SELECT id, repo, origin, plan, status, access_until FROM sites WHERE id = ? AND account_id = ? AND kept = 1').bind(id || '', accountId).first(),
      () => env.kiln_cloud.prepare('SELECT id, repo, origin, plan, status FROM sites WHERE id = ? AND account_id = ? AND kept = 1').bind(id || '', accountId).first(),
    );
    if (!site) return { ok: false, code: 'no_such_site', detail: 'the site is not on the account any more' };
    if (!siteHasAccess(site)) return { ok: false, code: 'plan_ended', detail: 'editing is switched off for the site' };
    const token = typeof tools.installationToken === 'function' ? await tools.installationToken(env, site.repo) : null;
    if (!token) return { ok: false, code: 'no_access', detail: `no token for ${site.repo}` };
    const put = await putOnHosting(env, { site, token, accountId, author: () => accountAuthor(env, accountId), by: AFTER_A_COPY, worker });
    const hosting = put.body.hosting || null;
    if (put.status === 200 && put.body.ok === true && hosting && hosting.url) return { ok: true, url: hosting.url };
    return { ok: false, code: String(put.body.code || (hosting && hosting.reason) || 'not_up'), detail: String(put.body.error || (hosting && hosting.error) || `answered ${put.status}`).slice(0, 300) };
  } catch (e) { return { ok: false, code: 'error', detail: String((e && (e.detail || e.message)) || e).slice(0, 300) }; }
}

/**
 * Opens the editor of a site whose files Kiln keeps, for the account that owns
 * it. This is the one piece of code behind "Open the editor" in the dashboard
 * (POST /cloud/sites/editor) and behind "Continue with Google" at the site
 * itself (keptOwnerAtSite, below). The caller has already settled whose site
 * it is and that Kiln keeps its files. Answers { url }, the address that
 * carries the new owner session, or { error, code, status } with nothing made.
 * `who` answers the name and email the person goes by (editorPerson). `at` is
 * the address the person is signing in from: the session then goes there and
 * nowhere else, and only if that address is this site for certain.
 */
async function openKeptEditor(env, tools, { site, accountId, who, at = null, returnTo = '/kiln' }) {
  if (!siteHasAccess(site)) return { error: EDITOR_PLAN_ENDED, code: 'plan_ended', status: 403 };
  const row = hostingOn(env) ? await hostingRow(env, site.id) : null;
  const hosting = row ? publicHosting(row, { repo: site.repo, kept: true }) : null;
  const up = !!(hosting && hosting.url && (hosting.state === 'live' || hosting.serving));
  // The session goes only to an address that is this site for certain: the
  // one on record, or the temporary one while a domain of its own still
  // waits for its name servers (what answers there is not this site yet).
  const isThisSite = async (address) => {
    try {
      const s = await cloudSiteForOrigin(env, new URL(address).origin);
      return !!s && (s.id === site.id || String(s.repo || '').toLowerCase() === String(site.repo).toLowerCase());
    } catch { return false; }
  };
  const address = !up ? null
    : at ? ((await isThisSite(at)) ? at : null)
      : (await isThisSite(site.origin)) ? site.origin : (await isThisSite(hosting.url)) ? hosting.url : null;
  if (!address) return { error: EDITOR_NOT_UP, code: 'not_up', status: 409 };
  const person = await who();
  let made = null;
  try {
    made = typeof tools.editorSession === 'function'
      ? await tools.editorSession(env, { accountId, name: person.name, email: person.email, repo: site.repo, origin: address, returnTo }) : null;
  } catch { made = null; }
  if (!made || !made.url) return { error: EDITOR_NOT_OPENED, code: 'not_opened', status: 502 };
  return { url: made.url };
}

// What the owner of a site Kiln keeps reads when they pressed Continue with Google at their site and its editor cannot be opened.
const AT_SITE_REFUSED = {
  plan_ended: { title: 'Editing is switched off for this site', words: "This is your site, but editing is switched off for it, so its editor cannot be opened. Open your Kiln dashboard and press Subscribe on the site's row, then sign in here again." },
  not_up: { title: 'Your site is not up at this address yet', words: "This is your site, but it is not up at this address yet. Open your Kiln dashboard, press Put it on Kiln's hosting on the site's row, then press Open the editor there." },
  not_opened: { title: 'Kiln could not open the editor just now', words: 'This is your site, but Kiln could not open its editor just now. Please try again in a few minutes.' },
};

/**
 * "Continue with Google", or a link or code sent by email, at a site
 * (index.js, signInAtSite), for the owner of a site whose files Kiln keeps.
 * Such an owner has no GitHub account, so these are their way back in once
 * their session has ended. `sub` is who Google says the person is. With no
 * `sub`, `email` is the address the person opened the link or typed the code
 * for, and their account is the one account that address was confirmed for
 * (confirmedAccounts, the same rule as the dashboard's email sign-in).
 * `repo` and `origin` are the site the sign-in was started from. Only that
 * account, and only when it owns a kept site (`kept = 1`) with that very
 * repository, is answered:
 * { url }, the address with the owner session POST /cloud/sites/editor makes,
 * or, when that route would refuse, { refused, status, title, words,
 * dashboard } for a plain page. Everybody else, and any trouble finding out,
 * is answered null: they go on to the site's list of people as before.
 */
export async function keptOwnerAtSite(env, { sub = null, email = null, name = null, repo, origin, returnTo = '/kiln' } = {}, tools = {}) {
  const bySub = typeof sub === 'string' && !!sub;
  if (!env.kiln_cloud || !repo || !origin || (!bySub && !mailAddress(String(email || '')))) return null;
  let account = null, site = null;
  try {
    if (bySub) account = await env.kiln_cloud.prepare('SELECT id FROM accounts WHERE google_sub = ?').bind(sub).first();
    else { const found = await confirmedAccounts(env, email); account = found.length === 1 ? found[0] : null; }
    if (!account || !account.id) return null;
    const find = (columns) => env.kiln_cloud.prepare(`SELECT ${columns} FROM sites WHERE account_id = ? AND lower(repo) = lower(?) AND kept = 1`).bind(account.id, String(repo)).first();
    site = await withAccessUntil(() => find('id, repo, origin, plan, status, access_until'), () => find('id, repo, origin, plan, status'));
  } catch { return null; }   // a database that cannot say whose site this is gives nobody an owner session
  if (!site) return null;
  const sess = bySub ? { account_id: account.id, google: { email, name } } : { account_id: account.id, byEmail: { email, name } };
  const opened = await openKeptEditor(env, tools, { site, accountId: account.id, who: () => editorPerson(env, sess), at: origin, returnTo });
  if (opened.url) return { url: opened.url };
  const said = AT_SITE_REFUSED[opened.code] || AT_SITE_REFUSED.not_opened;
  return { refused: opened.code, status: opened.status, title: said.title, words: said.words, dashboard: env.CLOUD_DASHBOARD || 'https://app.kilncms.com' };
}

/**
 * Whether `email` is the confirmed address (confirmedAccounts) of the one
 * account that owns the kept site with repository `repo`. Then a sign-in link
 * asked for at that site is sent to the address, as to a person on the site's
 * list, and keptOwnerAtSite lets its owner in. Never throws: what cannot be
 * read is a no.
 */
export async function keptOwnerAddress(env, { email, repo } = {}) {
  if (!env.kiln_cloud || !repo) return false;
  try {
    const found = await confirmedAccounts(env, email);
    if (found.length !== 1) return false;
    return !!(await env.kiln_cloud.prepare('SELECT id FROM sites WHERE account_id = ? AND lower(repo) = lower(?) AND kept = 1').bind(found[0].id, String(repo)).first());
  } catch { return false; }
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
  const refuse = async (trouble, detail = '') => {
    console.warn(JSON.stringify({ evt: 'cloud_signin_not_finished', stage: `google_${trouble.code}`, detail: String(detail || '').slice(0, 160) }));
    await noteProblem(env, { kind: 'signin_not_finished', detail: `dash_google_${trouble.code}` });   // the problem tally (problems.js)
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
  await noteSeen(env, account.id);
  return Response.redirect(`${dash}#kc_token=${sid}`, 302);   // the dashboard reads and keeps this, as after a GitHub sign-in
}

/**
 * The last step of an email sign-in to the dashboard. index.js hands it over
 * when the person opened the link or typed the code Kiln sent to `email` for
 * a request made from the dashboard (for=dashboard), so the address is theirs.
 * Their account is the one that address was confirmed for, or a new one
 * (emailAccount). They go back to the dashboard with `#kc_token=<sid>`, as
 * after a Google sign-in, and the session has `byEmail` with the address
 * where a Google one has `google`. Anything that goes wrong is a plain page
 * with the way back to the dashboard.
 */
export async function emailDashboardSignIn(env, { email } = {}, { page = plainPage } = {}) {
  const dash = env.CLOUD_DASHBOARD || 'https://app.kilncms.com';
  const refuse = async (trouble, detail = '') => {
    console.warn(JSON.stringify({ evt: 'cloud_signin_not_finished', stage: `email_${trouble.code}`, detail: String(detail || '').slice(0, 160) }));
    await noteProblem(env, { kind: 'signin_not_finished', detail: `dash_email_${trouble.code}` });   // the problem tally (problems.js)
    return page(troubleBody(forDashboard(trouble), { dashboard: dash }), trouble.status);
  };
  const address = mailAddress(String(email || '').trim().toLowerCase());
  if (!address || !env.kiln_cloud) return refuse(EMAIL_ACCOUNT_NOT_READY, address ? 'no database' : 'no address');
  let found;
  try { found = await emailAccount(env, address); }
  catch (e) { return refuse(EMAIL_ACCOUNT_NOT_READY, e && e.message); }
  if (found.twice) return refuse(TWO_ACCOUNTS);
  const sid = uuid();
  await env.KILN.put(`csess:${sid}`, JSON.stringify({ account_id: found.account.id, login: null, uid: null, gh: null, byEmail: { email: address, name: found.account.name || null } }), { expirationTtl: 30 * 24 * 3600 });
  await noteSeen(env, found.account.id);
  return Response.redirect(`${dash}#kc_token=${sid}`, 302);
}

// ─── Router ───────────────────────────────────────────────────────────────────

/** A site in the form /cloud/me lists it, from /cloud/me's own code, so the two can never differ. Null when it is not listed. */
async function listedSite(request, env, url, tools, id) {
  try {
    const me = new URL('/cloud/me', url);
    const listed = await handleCloud(new Request(me, { headers: { Authorization: request.headers.get('Authorization') || '' } }), env, me, '/cloud/me', tools);
    return ((await listed.json()).sites || []).find(s => s.id === id) || null;
  } catch { return null; }
}

/** The five-minute job's step for sites being brought in (bring.js): a copy whose job has said nothing for half an hour is given up on. Never throws. */
export function sweepBrings(env, { now = Date.now() } = {}) {
  return sweepCopies(env, { now, dashboard: env.CLOUD_DASHBOARD || 'https://app.kilncms.com', note: (subject, lines) => notifyOwner(env, subject, lines) });
}

export async function handleCloud(request, env, url, path, tools = {}) {
  const dash = env.CLOUD_DASHBOARD || 'https://app.kilncms.com';

  // A sign-in begun at another of this service's addresses (production's workers.dev one, from an old link)
  // starts again at its fixed address: the cookie that ties a sign-in to its browser belongs to one host,
  // and the callback comes back to the fixed one, so a sign-in begun elsewhere could never finish.
  if ((path === '/cloud/login' || path === '/cloud/login/google') && request.method === 'GET') {
    const own = selfOrigin(url, env);
    if (own !== url.origin && /^https:/.test(url.origin)) return Response.redirect(`${own}${url.pathname}${url.search}`, 307);
  }

  // GitHub OAuth — identity only.
  if (path === '/cloud/login') {
    // `?link=<code>`: a signed-in person is connecting GitHub to their account
    // (the /cloud/link routes). The code never goes to GitHub: it is kept
    // beside the state, and the callback finds it there. A code that is no
    // longer good sends the person straight back.
    const link = url.searchParams.get('link');
    if (link !== null && !(LINK_CODE.test(link) && await env.KILN.get(`link:${link}`))) return Response.redirect(linkBack(dash, 'expired'), 302);
    const c = await creds(env);
    const nonce = uuid();
    await env.KILN.put(`cstate:${nonce}`, link === null ? '1' : JSON.stringify({ link }), { expirationTtl: 600 });
    const params = new URLSearchParams({ client_id: c.client_id, redirect_uri: `${selfOrigin(url, env)}/cloud/callback`, state: nonce });
    // Connecting: GitHub shows its account picker, so the person chooses which GitHub account joins the Kiln
    // account they are signed in to, and the one the browser happens to be signed in to is never taken unasked.
    if (link !== null) params.set('prompt', 'select_account');
    return startSignIn(url, `https://github.com/login/oauth/authorize?${params}`, nonce);   // with the cookie that ties it to this browser
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
      client_id: env.GOOGLE_CLIENT_ID, redirect_uri: `${selfOrigin(url, env)}/google/callback`, response_type: 'code',
      scope: 'openid email profile', state: nonce, prompt: 'select_account',
    });
    return startSignIn(url, `https://accounts.google.com/o/oauth2/v2/auth?${params}`, nonce);   // with the cookie that ties it to this browser
  }

  if (path === '/cloud/callback') {
    // A sign-in that does not finish goes back to the dashboard, which says so
    // and offers the button again: the person used to be left on a line of
    // JSON. Why it failed is logged for the operator.
    const notFinished = async (stage, detail = '') => {
      console.warn(JSON.stringify({ evt: 'cloud_signin_not_finished', stage, detail: String(detail).slice(0, 160) }));
      await noteProblem(env, { kind: 'signin_not_finished', detail: `dash_github_${stage}` });   // the problem tally (problems.js)
      try { const back = new URL(dash); back.searchParams.set('signin', 'again'); return signInOver(url, Response.redirect(back.toString(), 302)); }
      catch { return json({ error: 'github sign-in failed' }, 401); }
    };
    const code = url.searchParams.get('code'), state = url.searchParams.get('state');
    const kept = state ? await env.KILN.get(`cstate:${state}`) : null;
    // A person connecting GitHub to the account they are signed in to is not signing in: that has its own ending.
    const linking = linkOf(kept);
    if (linking) return linkCameBack(request, env, url, { dash, code, state, linking, page: typeof tools.page === 'function' ? tools.page : plainPage });
    if (!code || !kept) return notFinished('state');
    await env.KILN.delete(`cstate:${state}`);
    // Only the browser the sign-in was started in may finish it
    // (signin-trouble.js). In any other, nobody is signed in, GitHub is not
    // asked who they are, and the person gets the page that says the sign-in
    // did not finish, with the way back to the dashboard.
    if (!startedHere(request, url, state)) {
      console.warn(JSON.stringify({ evt: 'cloud_signin_not_finished', stage: 'cookie', detail: '' }));
      await noteProblem(env, { kind: 'signin_not_finished', detail: 'dash_cookie' });   // the problem tally (problems.js)
      const page = typeof tools.page === 'function' ? tools.page : plainPage;
      return page(troubleBody(forDashboard(STARTED_ELSEWHERE), { dashboard: dash }), STARTED_ELSEWHERE.status);
    }
    const c = await creds(env);
    const tokRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: c.client_id, client_secret: c.client_secret, code }),
    });
    const tok = await tokRes.json().catch(() => ({}));
    if (!tok.access_token) return notFinished('token', tok.error || tokRes.status);
    const user = await ghUser(tok.access_token, { fresh: true });
    if (!user) return notFinished('user');
    const account = await upsertAccount(env, user.login, user.email, user.id);
    if (!account) return notFinished('user', 'GitHub gave no number, and the login is on an account that has one');
    const sid = uuid();
    // Keep the user's OAuth token server-side (never sent to the browser) so
    // /cloud/sites can verify the signer actually has push on the repo they're
    // registering — installation-existence is not authorization.
    // `uid` is GitHub's numeric user id: unlike the login, it cannot be
    // renamed away or registered by someone else later.
    const signedIn = { account_id: account.id, login: user.login, uid: user.id ?? null, gh: tok.access_token || null };
    await env.KILN.put(`csess:${sid}`, JSON.stringify(signedIn), { expirationTtl: 30 * 24 * 3600 });
    await noteSeen(env, account.id);
    // The security log (security-log.js): the operator's own sign-ins to the dashboard, about the operator only.
    if (isCloudAdmin(signedIn, env)) await noteSecurity(env, { kind: 'operator_signin', account_id: account.id, detail: 'github' });
    return signInOver(url, Response.redirect(`${dash}#kc_token=${sid}`, 302));   // dashboard reads + stores this
  }

  // Everything below needs a dashboard session (Authorization: Bearer <token>).
  const sess = await session(request, env);

  if (path === '/cloud/logout' && request.method === 'POST') {
    const sid = bearer(request);
    if (sid) await env.KILN.delete(`csess:${sid}`);
    return json({ ok: true });
  }

  // Step 1 of connecting GitHub (see connectGitHub above). Allowed for a
  // session that holds no GitHub token: an account with no GitHub yet, or one
  // that connected GitHub and signed in by email or with Google today. The
  // code is given to this dashboard alone, which keeps it for step 4.
  if (path === '/cloud/link/start' && request.method === 'POST') {
    if (!sess) return json({ error: 'not signed in' }, 401);
    if (!(await canLink(env))) return json({ error: LINK_NOT_READY, code: 'not_ready' }, 503);
    if (!withoutGitHub(sess) || sess.gh) return json({ error: LINK_ALREADY, code: 'already_connected' }, 409);
    const acct = await env.kiln_cloud.prepare('SELECT id, github_login, github_id FROM accounts WHERE id = ?').bind(sess.account_id).first();
    if (!acct) return json({ error: 'not signed in' }, 401);
    if (!(await mayStartLink(env, acct.id))) return json({ error: LINK_TOO_MANY, code: 'too_many' }, 429);
    const code = linkCode();
    await env.KILN.put(`link:${code}`, JSON.stringify({ account_id: acct.id, by: await fingerprint(bearer(request)) }), { expirationTtl: 600 });
    // `reconnect`: the account has GitHub already, and this gives the session its GitHub part.
    return json({ ok: true, url: `${selfOrigin(url, env)}/cloud/login?link=${code}`, code, reconnect: acct.github_login != null || acct.github_id != null }, 200, { 'Cache-Control': 'no-store' });
  }

  // Step 4: the one place the account is changed. The request must carry the
  // session that asked, the code that dashboard was given, and the key the
  // browser that came back from GitHub was given. The key works once, right
  // or wrong. On success the person gets a new session that holds the GitHub
  // token and still says how they signed in, and the one that asked is gone:
  // a copy of the old session id that somebody else may hold gains nothing.
  if (path === '/cloud/link/finish' && request.method === 'POST') {
    if (!sess) return json({ error: 'not signed in' }, 401);
    const { key, code } = await request.json().catch(() => ({}));
    const gone = () => json({ error: LINK_EXPIRED, code: 'expired' }, 410);
    if (!LINK_CODE.test(String(key || '')) || !LINK_CODE.test(String(code || ''))) return gone();
    let back = null;
    try { back = await env.KILN.get(`linkback:${key}`, 'json'); } catch { back = null; }
    if (!back) return gone();
    await env.KILN.delete(`linkback:${key}`);
    const asking = bearer(request);
    if (back.account_id !== sess.account_id || back.by !== await fingerprint(asking) || back.code !== await fingerprint(code)) return gone();
    if (!(await canLink(env))) return json({ error: LINK_NOT_READY, code: 'not_ready' }, 503);
    let out;
    try { out = await connectGitHub(env, sess.account_id, { login: back.login, uid: back.uid }); }
    catch (e) {
      console.warn(JSON.stringify({ evt: 'cloud_link_not_finished', stage: 'write', detail: String(e?.message || e).slice(0, 160) }));
      await noteProblem(env, { kind: 'signin_not_finished', detail: 'link_write' });   // the problem tally (problems.js)
      return json({ error: LINK_NOT_NOW, code: 'not_now' }, 503);
    }
    if (!out.ok) {
      if (out.code === 'other') return json({ error: linkOther(out.login, back.login), code: 'other', login: out.login }, 409);
      // The GitHub login is said back, so the dashboard can name the account that is taken. The person stays signed in as they are.
      return out.code === 'taken' ? json({ error: LINK_TAKEN, code: 'taken', login: back.login }, 409) : gone();
    }
    const sid = uuid();
    await env.KILN.put(`csess:${sid}`, JSON.stringify({
      account_id: sess.account_id, login: back.login, uid: back.uid, gh: back.gh,
      ...(sess.google ? { google: sess.google } : {}), ...(sess.byEmail ? { byEmail: sess.byEmail } : {}),
    }), { expirationTtl: 30 * 24 * 3600 });
    await env.KILN.delete(`csess:${asking}`);
    await noteSeen(env, sess.account_id);
    // `token` is the new session: the dashboard keeps it in place of the one it sent.
    return json({ ok: true, token: sid, login: back.login, connected: out.connected }, 200, { 'Cache-Control': 'no-store' });
  }

  if (path === '/cloud/me') {
    if (!sess) return json({ error: 'not signed in' }, 401);
    await noteSeen(env, sess.account_id, { olderThan: SEEN_EVERY });   // the operator's list says when each person was last here
    // `name` and `google_sub` arrive with migration 0008. A database it has not
    // reached has neither, and every account there signed in with GitHub.
    // `signin_email` arrives with migration 0018, `linked_at` with 0019.
    const asked = ['id, github_login, email, name, google_sub, signin_email, linked_at', 'id, github_login, email, name, google_sub, signin_email', 'id, github_login, email, name, google_sub', 'id, github_login, email'];
    let row;
    for (const columns of asked) {
      try { row = await env.kiln_cloud.prepare(`SELECT ${columns} FROM accounts WHERE id = ?`).bind(sess.account_id).first(); break; }
      catch (e) { if (columns === asked[asked.length - 1]) throw e; }
    }
    // `google` says the account has a Google id, `by_email` that an email sign-in made it. Neither id nor address of those stays here.
    // `linked` says the account began without GitHub and connected it later, and `github_session` that this
    // very session holds a GitHub token: a connected account that signed in by email or with Google today has none.
    const account = row ? { id: row.id, github_login: row.github_login || null, email: row.email ?? null, name: row.name || null, google: !!row.google_sub, by_email: !!row.signin_email, github_session: !!sess.gh, linked: !!row.linked_at } : null;
    // Such a person is shown the address Kiln writes to: the one Google or the email sign-in confirmed.
    if (account && (account.google || account.by_email)) account.email = await accountEmail(env, sess.account_id);
    const paidBy = await subscriptionSql(env);
    const sites = await withAccessUntil(
      () => env.kiln_cloud.prepare(`SELECT id, repo, origin, plan, status, access_until, created_at, ${paidBy} AS subscription_id FROM sites WHERE account_id = ? ORDER BY created_at DESC`).bind(sess.account_id).all(),
      () => env.kiln_cloud.prepare(`SELECT id, repo, origin, plan, status, created_at, ${paidBy} AS subscription_id FROM sites WHERE account_id = ? ORDER BY created_at DESC`).bind(sess.account_id).all(),
    );
    // `editable` is the worker's own answer, so the dashboard never has to
    // work out for itself what a status plus a date means. `trial_ends` is the
    // moment the free days run out for a site nobody has subscribed for yet
    // (the same rule expireStaleTrials applies); `subscribed` says a
    // subscription exists, without handing its id to the browser.
    const now = Date.now();
    const prepared = await preparedTimes(env, sess.account_id);
    const whole = Object.fromEntries((sites.results || []).map(s => [s.id, s]));   // each row as read, for what hosting has to say
    const rows = (sites.results || []).map(({ subscription_id: sub, ...r }) => ({
      ...r,
      prepared_at: prepared[r.id]?.prepared_at ?? null,
      firstpass_at: prepared[r.id]?.firstpass_at ?? null,
      editable: siteHasAccess(r, now),
      subscribed: !!sub,
      trial_ends: r.status === 'trialing' && !sub && Number(r.created_at) ? Number(r.created_at) + TRIAL_GRACE_DAYS * 86400 * 1000 : null,
    }));
    // `yearly: true` on a site paid by the year, so its row does not say it renews each month. A database
    // that migration 0016 has not reached has no yearly sites.
    try {
      const years = await env.kiln_cloud.prepare("SELECT id FROM sites WHERE account_id = ? AND billing_period = 'year'").bind(sess.account_id).all();
      const yearly = new Set((years.results || []).map(y => y.id));
      for (const r of rows) if (yearly.has(r.id)) r.yearly = true;
    } catch { /* no billing_period column yet */ }
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
    const called = keptHere.size ? await keptNames(env, sess.account_id) : {};
    for (const r of rows) if (keptHere.has(r.id)) { r.kept = true; if (called[r.id]) r.name = called[r.id]; }
    // `brings`: this service can copy a site in from somewhere else (bring.js).
    // A site that was brought in says in `bring` how its copy stands.
    const brought = keptHere.size ? await copiesForAccount(env, sess.account_id) : {};
    for (const r of rows) if (brought[r.id]) r.bring = brought[r.id];
    // `registers`: this service gets a new domain for a site on the yearly hosting plan (register.js). False unless it is
    // switched on. Each site's `new_domain` is then { offered: true } when its owner may choose a name,
    // { offered: false, registration } when a name is being registered or is registered for it, and null otherwise.
    const registers = can && await registerReady(env);
    if (registers) {
      const offers = await offersForAccount(env, sess.account_id, { up: (id) => isUp(hosted[id]), domains: owned, now });
      const standing = await standingForAccount(env, sess.account_id);
      for (const r of rows) r.new_domain = offers[r.id]?.offered ? { offered: true } : standing[r.id] ? { offered: false, registration: standing[r.id] } : null;
    }
    // `yearly`: the hosting plan can be paid by the year here (`/cloud/checkout?site=…&period=year`), and `yearly_cloud` the plan
    // without hosting. Each is absent where it cannot.
    // `operator`: whether this person runs the service, so the dashboard shows its Admin link without asking the admin page.
    return json({ account, operator: isCloudAdmin(sess, env), sites: rows, billing: billingOn(env), mail: customerMailOn(env), prepare: can, firstpass: can, editor_latest: editors.latest, hosting: can && hostingOn(env), domains, forwarding, keeps: can && keepsReady(env), brings: can && bringOn(env), registers, ...(billingOn(env) && yearlyOn(env) ? { yearly: true } : {}), ...(cloudYearlyOn(env) ? { yearly_cloud: true } : {}) });
  }

  // Which repositories Kiln's GitHub App can reach for the person signed in:
  // what lets the dashboard tick "Kiln can save to your files" by itself and
  // offer a list to choose from, where the person used to type a name from
  // memory. It reads and changes nothing. The list is for the person's own
  // account; `?repo=owner/name` asks about one repository, their own or an
  // organization's. `installed: null` means GitHub did not answer, so the
  // dashboard leaves what it shows as it is; for one named repository it is
  // also the answer when the repository is not the person's (`yours` is not
  // true), whatever is the case at GitHub.
  if (path === '/cloud/github' && request.method === 'GET') {
    if (!sess) return json({ error: 'not signed in' }, 401);
    // A person signed in with Google has no GitHub account for the App to be on.
    if (withoutGitHub(sess)) return json({ ok: true, installed: false, code: 'needs_github', repos: [] });
    const one = url.searchParams.get('repo');
    if (one !== null) {
      if (!REPO_NAME.test(one)) return json({ error: 'The repository should look like owner/name, for example acme/website.' }, 400);
      // The same answer adding it would get: a repository Kiln keeps for a site is nobody's to add.
      if (inKeepOrg(env, one)) return json({ error: keepSentence('in_keep_org'), code: 'in_keep_org' }, 403);
      // `yours` follows the rule of POST /cloud/sites below: a repository under
      // the person's own login is theirs, and any other is asked about with
      // their own GitHub sign-in. That question comes first, and GitHub is
      // asked as Kiln's App only for a repository that is the person's: a
      // made-up name under somebody else's login costs the asker's allowance
      // at GitHub and none of Kiln's, and nobody learns whether a stranger's
      // private repository exists or has Kiln on it (`installed` stays null).
      const mine = one.split('/')[0].toLowerCase() === String(sess.login || '').toLowerCase();
      const name = one.toLowerCase();
      const answer = await keptReach(env, `cgh:${sess.account_id}:${name}`, (a) => !a.many && (a.yours === false || (a.yours === true && a.installed !== null)), async () => {
        if (!(await mayAskAbout(env, sess.account_id, name))) return { many: true };
        const push = mine ? 'yes' : await userPushAnswer(sess.gh, one);
        if (push !== 'yes') return { installed: null, yours: push === 'no' ? false : null };
        return { installed: await repoReach(env, one), yours: true };
      }, (a) => (a.yours === false || a.installed === false ? REACH_NO_KEPT_MS : REACH_KEPT_MS));
      if (answer.many) return json({ error: 'You have asked about many repositories in a short time. Wait a few minutes, then try again.', code: 'too_many' }, 429);
      return json({ ok: true, repo: one, installed: answer.installed, yours: answer.yours });
    }
    const reach = await keptReach(env, `cgh:${sess.account_id}`, (a) => a.installed !== null, () => accountReach(env, { login: sess.login, uid: sess.uid ?? null }));
    // `added`: the account already has a site for that repository. Read now and
    // never kept, so a site added a second ago shows as added.
    let have = new Set();
    if (reach.repos.length) {
      const mineNow = await env.kiln_cloud.prepare('SELECT repo FROM sites WHERE account_id = ?').bind(sess.account_id).all();
      have = new Set((mineNow.results || []).map(s => String(s.repo || '').toLowerCase()));
    }
    const install_url = await installUrlFor(env);
    return json({
      ok: true,
      installed: reach.installed,
      selection: reach.selection,
      install_url,
      // GitHub opens the App's settings for the account at the same address
      // once the App is on it. GitHub's own address for that page holds the
      // installation's number, which stays on the service.
      manage_url: reach.installed === true ? install_url : null,
      repos: reach.repos.map(r => ({ ...r, added: have.has(r.repo.toLowerCase()) })),
      more: reach.more,
    });
  }

  // The address notices about the account's own sites go to (mail.js). The
  // account starts with whatever GitHub shows for the person, which is often
  // nothing; this is how they give one, change it, or take it away.
  if (path === '/cloud/account' && request.method === 'POST') {
    if (!sess) return json({ error: 'not signed in' }, 401);
    // Nobody confirms an address typed here, so an account that signed in with Google keeps the one Google confirmed.
    if (withoutGitHub(sess)) return json({ error: sess.google ? GOOGLE_ADDRESS : EMAIL_ADDRESS, code: 'google_address' }, 403);
    // The same holds for such an account after it connected GitHub, however its person signed in today:
    // it is the account that has a confirmed address, and Kiln keeps writing to that one (mail.js, addressSql).
    let began = null;
    try { began = await env.kiln_cloud.prepare('SELECT google_sub, signin_email FROM accounts WHERE id = ?').bind(sess.account_id).first(); }
    catch { try { began = await env.kiln_cloud.prepare('SELECT google_sub FROM accounts WHERE id = ?').bind(sess.account_id).first(); } catch { began = null; } }
    if (began && (began.google_sub || began.signin_email)) return json({ error: LINKED_ADDRESS, code: 'google_address' }, 403);
    const { email } = await request.json().catch(() => ({}));
    const clean = email === '' || email === null ? null : mailAddress(email);
    if (email !== '' && email !== null && !clean) return json({ error: 'That does not look like an email address. Please check it and try again.' }, 400);
    await env.kiln_cloud.prepare('UPDATE accounts SET email = ? WHERE id = ?').bind(clean, sess.account_id).run();
    return json({ ok: true, email: clean });
  }

  // The campaign tags of the link a person followed to Kiln (utm_source, utm_medium, utm_campaign), recorded on
  // their account once, in the first hour after it was made, so the operator can read the funnel per campaign.
  // First-party: the dashboard sends what it found in its own address, and nothing else is asked or kept. Off
  // unless the service's CAMPAIGN_TAGS setting is "on", which waits for the privacy page to say so.
  if (path === '/cloud/account/came-from' && request.method === 'POST') {
    if (!sess) return json({ error: 'not signed in' }, 401);
    if (String(env.CAMPAIGN_TAGS || '').trim() !== 'on') return json({ ok: true, recorded: false, reason: 'off' });
    const tags = campaignTags(await request.json().catch(() => ({})));
    if (!tags) return json({ ok: true, recorded: false, reason: 'none' });
    try {
      const r = await env.kiln_cloud.prepare(
        'UPDATE accounts SET utm_source = ?, utm_medium = ?, utm_campaign = ? WHERE id = ? AND utm_source IS NULL AND utm_medium IS NULL AND utm_campaign IS NULL AND created_at > ?',
      ).bind(tags.source, tags.medium, tags.campaign, sess.account_id, Date.now() - CAME_FROM_WINDOW_MS).run();
      return json({ ok: true, recorded: !!(r && r.meta && r.meta.changes) });
    } catch (e) {
      // Migration 0021 has not reached this database: there is nowhere to keep the tags, and asking again will not help.
      if (/utm_/.test(String((e && e.message) || e))) return json({ ok: true, recorded: false, reason: 'not_ready' });
      // Anything else is the database's trouble of the moment: the dashboard keeps the tags and sends them on its next load.
      return json({ error: 'The tags could not be kept just now.', code: 'try_again' }, 503);
    }
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
      return json({ error: 'The Kiln app is not installed on that repository yet.', install_url: await installUrlFor(env) }, 409);
    }
    const dupe = await env.kiln_cloud.prepare('SELECT id FROM sites WHERE origin = ?').bind(o).first();
    if (dupe) return json({ error: 'That site address is already on Kiln Cloud. If it is yours and you cannot see it here, write to hello@kilncms.com.' }, 409);
    // Fair use of the free days: counted from the first time this address, this repository or this GitHub account
    // was seen here (freeDayClock). When GitHub does not give the repository's number the site is added all the same.
    const days = await freeDayClock(env, { accountId: sess.account_id, origin: o, repoId: await repoNumber(env, tools, sess, repo), ghId: githubNumber(sess) });
    const site = await registerSite(env, { accountId: sess.account_id, repo, origin: o, plan, days, way: 'github' });
    // An address given with the form becomes the account's address for notices.
    if (mailAddress(email)) { try { await env.kiln_cloud.prepare('UPDATE accounts SET email = ? WHERE id = ?').bind(mailAddress(email), sess.account_id).run(); } catch { /* the site is added either way */ } }
    const to = await accountEmail(env, sess.account_id);
    const checkout = await startCheckout(env, site, { email: to, accountId: sess.account_id });
    // The mail about the free trial is for a site that has one.
    if (site.status === 'trialing') await sendOnce(env, `added:${site.id}`, to, siteAddedMail({ origin: site.origin, plan: site.plan, endsAt: trialEndsAt(site.created_at, TRIAL_GRACE_DAYS), dashboard: dash }));
    await notifyOwner(env, `New Kiln site: ${site.repo}`, [
      `Plan: ${site.plan} (${site.status === 'trialing' ? 'trialing' : 'its free days were already over'})`,
      `Origin: ${site.origin}`,
      `Registered by: ${signedInAs(sess)}`,
      checkout ? 'A checkout link was issued.' : 'No checkout: billing is not configured.',
    ]);
    // `free_days`: one sentence for the dashboard to show when this site got no free days of its own, or fewer than seven.
    return json({ ok: true, site, checkout, ...(days.sentence ? { free_days: days.sentence } : {}) });   // checkout is null until Stripe's keys are set
  }

  // Start a site whose files Kiln keeps (keeps.js), for someone with no GitHub
  // account: a private repository in Kiln's own organization, filled with the
  // starter site and registered to this account. The dashboard then puts it on
  // Kiln's hosting with the route it has for that, as for any site.
  if (path === '/cloud/sites/start' && request.method === 'POST') {
    if (!sess) return json({ error: 'not signed in' }, 401);
    const { name } = await request.json().catch(() => ({}));
    let typed = null;   // the name as it is put on the site's row: what the person typed, tidied
    let since = null;   // when this site's free days began, if they began with an earlier site of the account
    const out = await startKept(env, {
      accountId: sess.account_id, name, worker: selfOrigin(url, env), by: signedInAs(sess), sign: appJwt, pkcs1: tools.pkcs1 || null,
      register: ({ id, repo, origin, name, since: began }) => { typed = name; since = began; return registerSite(env, { id, accountId: sess.account_id, repo, origin, plan: 'managed', kept: true, name, since: began, way: 'starter' }); },
      forget: async (id) => { const out = await env.kiln_cloud.prepare('DELETE FROM sites WHERE id = ? AND account_id = ? AND kept = 1').bind(id, sess.account_id).run(); await forgetActivity(env, { site_id: id }); await forgetProblems(env, id); return out; },
      note: (subject, lines) => notifyOwner(env, subject, lines),
    });
    if (!out.ok) return json({ error: out.error, code: out.code }, out.status);
    // The welcome mail for a site Kiln keeps: once for the site, and only where
    // customer mail is on and the account has an address (sendOnce sees to
    // all three). The site is started whether or not the mail goes.
    try {
      const to = await accountEmail(env, sess.account_id);
      await sendOnce(env, `started:${out.site.id}`, to, siteStartedMail({ name: typed || name, address: out.site.origin, endsAt: trialEndsAt(out.site.created_at, TRIAL_GRACE_DAYS), dashboard: dash }));
    } catch { /* a mail that could not go is not a reason to fail the start */ }
    const site = await listedSite(request, env, url, tools, out.site.id);
    // `free_days`: one sentence for the dashboard to show when this site got no free days of its own.
    const freeDays = freeDaysSentence({ since, days: TRIAL_GRACE_DAYS });
    return json({ ok: true, site: site || { ...out.site, kept: true }, ...(freeDays ? { free_days: freeDays } : {}) });
  }

  // Bring my site in (bring.js): a site Kiln keeps the files of, started empty,
  // and a job outside the service that copies the person's old site into it.
  // The service never reads the address itself.
  if (path === '/cloud/sites/bring' && request.method === 'POST') {
    if (!sess) return json({ error: 'not signed in' }, 401);
    const { address, name, mine } = await request.json().catch(() => ({}));
    let since = null;   // as for a site that is started: when its free days began, if with an earlier site
    const out = await bringIn(env, {
      accountId: sess.account_id, address, name, mine, worker: selfOrigin(url, env), dashboard: dash, by: signedInAs(sess), sign: appJwt, pkcs1: tools.pkcs1 || null,
      register: ({ id, repo, origin, name, since: began }) => { since = began; return registerSite(env, { id, accountId: sess.account_id, repo, origin, plan: 'managed', kept: true, name, since: began, way: 'copied' }); },
      forget: async (id) => { const out = await env.kiln_cloud.prepare('DELETE FROM sites WHERE id = ? AND account_id = ? AND kept = 1').bind(id, sess.account_id).run(); await forgetActivity(env, { site_id: id }); await forgetProblems(env, id); return out; },
      note: (subject, lines) => notifyOwner(env, subject, lines),
    });
    if (!out.site) return json({ error: out.error, code: out.code }, out.status);
    const site = await listedSite(request, env, url, tools, out.site.id) || { ...out.site, kept: true, bring: out.bring };
    // The site is made either way. When its job could not be started, the answer says so and still carries the site.
    const freeDays = freeDaysSentence({ since, days: TRIAL_GRACE_DAYS });
    const more = freeDays ? { free_days: freeDays } : {};
    return out.ok ? json({ ok: true, site, ...more }) : json({ error: out.error, code: out.code, site, ...more }, out.status);
  }
  // How a site's copy stands, with the report of what was left out.
  if (path === '/cloud/sites/bring' && request.method === 'GET') {
    if (!sess) return json({ error: 'not signed in' }, 401);
    const out = await copyOf(env, { accountId: sess.account_id, id: url.searchParams.get('site') });
    return out.ok ? json({ ok: true, bring: out.bring }) : json({ error: out.error, code: out.code }, out.status);
  }
  // One more try for a copy that failed or has said nothing for half an hour.
  if (path === '/cloud/sites/bring/again' && request.method === 'POST') {
    if (!sess) return json({ error: 'not signed in' }, 401);
    const asked = await request.json().catch(() => ({}));
    const out = await bringAgain(env, { accountId: sess.account_id, id: asked.id ?? asked.site, worker: selfOrigin(url, env), sign: appJwt, pkcs1: tools.pkcs1 || null,
      note: (subject, lines) => notifyOwner(env, subject, lines) });
    return out.ok ? json({ ok: true, site: out.site, bring: out.bring }) : json({ error: out.error, code: out.code, ...(out.bring ? { bring: out.bring } : {}) }, out.status);
  }
  // The copying job answers here. Nobody is signed in: the answer is signed with CONVERT_SECRET.
  if (path === '/cloud/convert/done' && request.method === 'POST') {
    // The answer is read through a reader that stops at MOST_ANSWER bytes (index.js hands it over as
    // `tools.readBody`), whatever the request says about its own length: a body sent in pieces has no
    // Content-Length, and would otherwise be taken into memory whole before its size was looked at.
    // The reader gives text. A signed answer is JSON in UTF-8, so its signature is the same over the text.
    if (typeof tools.readBody !== 'function') return json({ error: 'not set up' }, 500);
    const read = await tools.readBody(request, MOST_ANSWER);
    if (read.tooLarge) return json({ error: 'too large' }, 413);
    const out = await copyAnswered(env, {
      body: read.text || '', signature: request.headers.get('X-Kiln-Signature'), worker: selfOrigin(url, env), dashboard: dash,
      trialDays: TRIAL_GRACE_DAYS, sign: appJwt, pkcs1: tools.pkcs1 || null, note: (subject, lines) => notifyOwner(env, subject, lines),
      // A copy that worked goes up on Kiln's hosting by itself, before the job has its answer.
      host: (site) => hostCopied(env, tools, { id: site.id, accountId: site.account_id, worker: selfOrigin(url, env) }),
      // The job waits for its answer while the site is put up, which takes about half a minute. Work handed on to
      // run after the answer (`tools.later`) is cut off by Cloudflare about 30 seconds in, which could stop the
      // publishing half way and send the owner a mail that says the site is not up while it is going up.
      later: null,
    });
    return json(out.body, out.status);
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
      const plan = await planPrepare({ token, repo: site.repo, worker: selfOrigin(url, env), read });
      // A site Astro builds has no pages of its own in the repository to add that line to.
      const charset = hosted && !plan.astro && (plan.state === 'ready' || plan.state === 'prepared') ? await planCharset({ token, repo: site.repo, read }) : null;
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
      if (plan.state === 'no_access') return site.kept ? keptNotReached() : refused('no_access', 409, { install_url: await installUrlFor(env) });
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
          ...(['built', 'too_big', 'astro_no_layout', 'astro_unusual'].includes(plan.state) ? { command: SETUP_COMMAND } : {}) };
        return json(body, write ? 409 : 200);
      }
      if (!write) return json({ ok: true, ...shown });

      let done;
      try {
        done = await applyPrepare({
          token, repo: site.repo, worker: selfOrigin(url, env), plan, author,
          ...(env.KILN_RELEASE_BASE ? { releaseBase: env.KILN_RELEASE_BASE } : {}),
        });
      } catch (e) {
        const code = e instanceof PrepareError ? e.code : 'github';
        console.warn(JSON.stringify({ evt: 'prepare_failed', repo: site.repo, code, detail: e instanceof PrepareError ? e.detail : String(e?.message || e).slice(0, 200) }));
        await noteProblem(env, { kind: 'setup_failed', site_id: site.id, detail: 'add_kiln' });   // the problem tally (problems.js)
        return refused(code, code === 'moved' || code === 'protected' ? 409 : 502, code === 'protected' ? { branch: plan.branch, command: SETUP_COMMAND } : {});
      }
      await markPrepared(env, site.id, done.sha);
      await notifyOwner(env, `Kiln added to ${site.repo}`, [
        `By: ${signedInAs(sess)}, from the dashboard`,
        `Pages: ${done.pages}. Page templates: ${done.templates || 0}.${done.layouts ? ` Layout files: ${done.layouts}.` : ''} Files: ${done.files.join(', ') || 'none'}`,
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
      // For a site Astro builds: what happens next, and where the guide is.
      const next = plan.astro ? { astro: { ...shown.astro, after: astroAfter({ hosted }), guide: ASTRO_GUIDE } } : {};
      return json({ ok: true, ...shown, ...next, state: 'done', commit: { sha: done.sha, url: done.url }, ...(line ? { charset: line } : {}) });
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
      const plan = await planFirstPass({ token, repo: site.repo, astroChange: true });
      const shown = publicFirstPass(plan, { repo: site.repo });
      if (plan.state === 'no_access') return site.kept ? keptNotReached() : refused('no_access', 409, { install_url: await installUrlFor(env) });
      if (plan.state === 'github') return refused('github', 502);
      // A site Astro builds with nothing safe to move out of its templates (or
      // with all of it moved already): looking gives the report. Pressing is
      // refused, and nothing is written. With something to move it is `ready`,
      // and goes the way of a plain site below.
      if (plan.state === 'report') {
        if (write) return json({ ok: false, ...shown, error: sentence('report'), code: 'report' }, 409);
        return json({ ok: true, ...shown });
      }
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
        await noteProblem(env, { kind: 'setup_failed', site_id: site.id, detail: 'first_pass' });   // the problem tally (problems.js)
        return refused(code, code === 'moved' || code === 'protected' ? 409 : 502, code === 'protected' ? { branch: plan.branch } : {});
      }
      await markFirstPass(env, site.id, done.sha);
      return json({ ok: true, ...shown, state: 'done', commit: { sha: done.sha, url: done.url }, ...(plan.astro ? { sentences: astroAfterSentences(plan) } : {}) });
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
  // "Build again", for a site Astro builds whose build is late or stopped. Kiln
  // cannot start a build (its App has no right to), so this looks at once at
  // what the five-minute job would look at later, and answers where it stands.
  if (path === '/cloud/sites/hosting/build' && request.method === 'POST') {
    const asked = await ownedSite(request, env, url, sess, tools, {});
    if (asked.response) return asked.response;
    const { site, token } = asked;
    const row = hostingOn(env) ? await hostingRow(env, site.id) : null;
    if (!row || !row.built || row.state === 'ended' || row.state === 'removing') {
      return json({ ok: false, code: 'not_built', error: 'This site is not waiting for a build, so there is nothing to look at again. Load the page again to see where the site stands.' }, 409);
    }
    await lookAgain(env, { site, token });
    return json({ ok: true, hosting: await shownHosting(env, await hostingRow(env, site.id), site) });
  }
  if (path === '/cloud/sites/hosting' && (request.method === 'GET' || request.method === 'POST')) {
    const write = request.method === 'POST';
    const asked = await ownedSite(request, env, url, sess, tools, write ? {} : { needToken: false, needAccess: false });
    if (asked.response) return asked.response;
    const { site, token } = asked;
    if (!write) {
      const available = hostingOn(env);
      const row = available ? await hostingRow(env, site.id) : null;
      const care = row ? await lookedAfter(env, site.id) : null;
      // A hosted site that may not be edited any more: the rest of its row says when it comes down.
      const rest = row && !asked.access
        ? await env.kiln_cloud.prepare(`SELECT created_at, ${await subscriptionSql(env)} AS subscription_id FROM sites WHERE id = ?`).bind(site.id).first().catch(() => null) : null;
      return json({ ok: true, available, on_plan: site.plan === 'managed', hosting: await shownHosting(env, row, { ...site, ...(rest || {}) }), ...(care ? { looked_after: care } : {}) });
    }
    const put = await putOnHosting(env, { site, token, accountId: sess.account_id, author: () => commitAuthor(env, sess), by: signedInAs(sess), worker: selfOrigin(url, env) });
    return json(put.body, put.status);
  }

  // A hosted site on its owner's own domain (domain.js). GET says where the
  // site's domain stands, or with `name` looks at a domain and changes
  // nothing. POST sets the domain up ("setup"), asks Cloudflare whether its
  // name servers have changed ("check"), or puts away a set-up that is not
  // live ("stop"). A site whose editing is switched off cannot start anything
  // new, and can still check, stop and take its records away, so nobody is
  // trapped. None of it reads the repository, so the App's token is not asked for.
  // A new domain through Kiln for a site on the yearly hosting plan (register.js): where a site stands, the
  // search, and the press that registers the chosen name. With the switch off none of this is a route at all.
  //   GET  /cloud/sites/newdomain?site=ID        → { ok, offered, holder, registration, domain? }
  //   GET  /cloud/sites/newdomain?site=ID&q=…    → { ok, asked, searches_left, names: [{ name, can, why?, sentence? }] }
  //   POST /cloud/sites/newdomain { id, action: "register", name, checked: true } → { ok, registration } or { error, code }
  //   GET  /cloud/sites/newdomain                → { ok, holder, registrations: [{ name, state, site, runs_until, renews, leave_from, leave_asked }] }
  //   POST /cloud/sites/newdomain { action: "leave", id?, name? } → { ok, when, sentence, registration } (found by account: the site may be gone)
  if (path === '/cloud/sites/newdomain' && request.method === 'GET' && await registerReady(env)) {
    // Without a site: the account's own registrations, also one whose site was removed.
    if (!url.searchParams.get('site')) {
      if (!sess) return json({ error: 'not signed in' }, 401);
      return json({ ok: true, holder: holderOf(env), registrations: await registrationsForAccount(env, sess.account_id) });
    }
    const asked = await ownedSite(request, env, url, sess, tools, { needToken: false, needAccess: false });
    if (asked.response) return asked.response;
    const { site } = asked;
    const typed = url.searchParams.get('q');
    // The state looks at Cloudflare first, at most every ten seconds, for a name that is still being asked for: so the offer below is today's.
    const reg = typed === null ? await siteRegistration(env, site.id, registerTools()) : null;
    const own = await domainRow(env, site.id);
    const up = isUp(await hostingRow(env, site.id));
    const offer = (await offersForAccount(env, sess.account_id, { up: () => up, domains: { [site.id]: own } }))[site.id] || { offered: false, why: 'search_failed', name: null };
    if (typed === null) {
      return json({ ok: true, offered: offer.offered, holder: holderOf(env), registration: publicRegistration(reg),
        ...(own && own.registered ? { domain: { name: own.name, state: own.state, registered: true } } : {}) });
    }
    if (!offer.offered) return json({ error: registerSentence(offer.why, { name: offer.name || undefined }), code: offer.why }, offer.why === 'not_paid' ? 403 : offer.why === 'search_failed' ? 503 : 409);
    const found = await searchNames(env, sess.account_id, typed, { timeZone: request.cf?.timezone || null });
    if (found.stop) return json({ error: registerSentence(found.stop, { time: found.time }), code: found.stop, ...(found.more || {}) }, found.status);
    return json(found);
  }
  // The press that registers. register.js writes the row first and sends the one call that can spend money
  // only for the request whose insert wrote it. An action this service does not know is no route.
  if (path === '/cloud/sites/newdomain' && request.method === 'POST' && await registerReady(env)) {
    // "Take this name with me" is answered by account, before any site is looked for: the name outlives its site.
    const peek = await request.clone().json().catch(() => ({}));
    if (peek && String(peek.action || '') === 'leave') {
      if (!sess) return json({ error: 'not signed in' }, 401);
      const left = await leaveName(env, sess.account_id, { site: peek.id ?? peek.site, name: peek.name }, registerTools());
      return json(left.body, left.status);
    }
    const asked = await ownedSite(request, env, url, sess, tools, { needToken: false, needAccess: false });
    if (asked.response) return asked.response;
    if (String(asked.body.action || '') === 'register') {
      const out = await registerName(env, { site: asked.site, name: asked.body.name, checked: asked.body.checked }, registerTools());
      return json(out.body, out.status);
    }
  }

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
        const failed = async (e, stage) => {
          const code = e instanceof DomainError ? e.code : 'cloudflare';
          console.warn(JSON.stringify({ evt: 'domain_setup_failed', repo: site.repo, name, stage, reason: code, detail: detail(e) }));
          await noteProblem(env, { kind: 'domain_failed', site_id: site.id, detail: stage });   // the problem tally (problems.js)
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
        // The domain's own free days: a site set up on a domain that has had them gets no fresh ones, and is told so.
        const hadDays = await domainFreeDays(env, site.id, name);
        return json({ ok: true, domain: publicDomain(fresh), ...(hadDays ? { free_days: hadDays } : {}) });
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
    let boxLock = null;   // the lock for an inbox a set-up takes off Cloudflare's list and puts on again (domain-mail.js takeInboxLock)
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
        const account = { email: await accountEmail(env, sess.account_id) };
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
        // An inbox this account has not shown to be its own is taken only when Cloudflare writes to it at this asking. One that a row
        // of any account forwards to or waits for (inboxInUse) is somebody's, and is refused before anything is made.
        const ours = await mine(inbox);
        const notOurs = () => refuse('inbox_elsewhere', 409, { address, inbox, name, forward: publicForward(row) });
        // On Cloudflare's list, confirmed or not, and no row of any account uses it or waits for it: it was left behind (by a
        // stop, or by an asking nobody finished). It is taken off the list and put on again, so Cloudflare writes to it afresh.
        let left = false;
        if (!ours) {
          let there;
          try { there = await inboxState(env, { email: inbox }); }
          catch (e) { return failed(e, 'inbox', { address, inbox }); }
          if (there && await inboxInUse(env, inbox)) return notOurs();
          left = !!there;
        }
        let box;
        try { await switchMailOn(env, { zoneId: domain.zone_id, name }); }
        catch (e) { return failed(e, 'switch', { address, inbox }); }
        // Taking a left-behind inbox off the list is tied to the look before it: the inbox's lock is held from here until this
        // request is over (the row is saved by then), and the rows are looked at once more with the lock held. A stop or another
        // set-up that is at work on the same inbox holds the lock, and this one is asked to try again in a moment.
        if (left) {
          boxLock = await takeInboxLock(env, inbox);
          if (!boxLock) return refuse('busy', 409, { forward: publicForward(row) });
          if (await inboxInUse(env, inbox)) return notOurs();   // a row was saved for it since the first look
        }
        try { box = left ? await askAgain(env, { email: inbox, afresh: true }) : await addInbox(env, { email: inbox }); }
        catch (e) { return failed(e, 'inbox', { address, inbox }); }
        // An inbox that is not this account's is taken only when Cloudflare wrote to it at this asking and it has still to press the
        // button. Somebody else asked for it in the same moment (nothing was sent), or Cloudflare took an inbox that was put back on
        // its list as confirmed already (no button to press): either way no rule is made for it.
        if (!ours && (!box.sent || box.verified)) return notOurs();
        // Asking for the same again while it waits keeps its clock: the reminder and the day Kiln stops waiting count from the first asking.
        // A row that waits for the same inbox keeps the time Cloudflare last wrote there, which is also the mark that it wrote at this row's asking.
        const again = !!waits && waits.address === address && waits.inbox === inbox;
        const sameInbox = !!waits && waits.inbox === inbox;
        // An address that works is not rewritten: the change is kept beside it until the new inbox confirms, and the old rule goes on forwarding.
        // The row names the account it is saved for, so the inbox is still this account's own after the site is removed (domain-mail.js
        // ownsInbox). It is written to a row that has none, and saveForward never changes one that is there.
        const saved = await saveForward(env, site.id, { account_id: sess.account_id, ...(works
          ? { want_address: address, want_inbox: inbox, want_inbox_id: box.id, ...(again ? {} : { want_since: now }), ...(box.sent ? { want_asked_at: now } : sameInbox ? {} : { want_asked_at: null }) }
          : { address, inbox, inbox_id: box.id, state: 'confirming', reason: null, ...(again ? {} : { created_at: now }), ...(box.sent ? { asked_at: now } : sameInbox ? {} : { asked_at: null }) }) });
        if (!saved) return refuse('not_set_up', 503);
        // From here on the inbox is asked for by this account. A row of any other account that waits for the same inbox loses its mark
        // that Cloudflare wrote at its asking, so the button pressed for this address never switches on somebody else's (dropOtherAskings).
        await dropOtherAskings(env, { accountId: sess.account_id, inbox });
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
        await dropOtherAskings(env, { accountId: sess.account_id, inbox: waits.inbox });   // the email that counts now is the one this account had sent
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
      // With the rule and the row gone, an inbox no other site forwards to or waits for is taken off Cloudflare's list, so that
      // setting the address up again has Cloudflare write to it afresh. Best effort: what Cloudflare does not take is logged, and the stop stands.
      if (await forgetForward(env, site.id)) await forgetInboxesOf(env, row, { repo: site.repo });
      console.log(JSON.stringify({ evt: 'forward_stopped', repo: site.repo, address: row.address }));
      return json({ ok: true, forward: null });
    } finally {
      await dropInboxLock(env, boxLock);
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

  // The files of a site Kiln keeps, for an owner who takes the site
  // elsewhere: the answer is GitHub's own short-lived link to one zip of the
  // repository, and a name for the file. With editing switched off too. Only
  // once the site has been paid for, where a site can be paid for at all: a
  // free trial is not a way to carry a ready-made site off. The link is told
  // to the dashboard alone and is never logged; the operator hears which
  // site's files were downloaded.
  if (path === '/cloud/sites/files' && request.method === 'GET') {
    const asked = await ownedSite(request, env, url, sess, {}, { needToken: false, needAccess: false });
    if (asked.response) return asked.response;
    const { site } = asked;
    const kept = await keptSite(env, site.id);
    if (!kept || kept.account_id !== sess.account_id) return json({ error: FILES_NOT_KEPT, code: 'not_kept' }, 403);
    const more = await env.kiln_cloud.prepare(`SELECT name, ${await subscriptionSql(env)} AS subscription_id FROM sites WHERE id = ? AND account_id = ?`).bind(site.id, sess.account_id).first().catch(() => null);
    if (billingOn(env) && !subscriptionOf(more)) return json({ error: FILES_PAID_FIRST, code: 'paid_first' }, 403);
    const link = await keptFilesLink(env, { repo: site.repo, sign: appJwt, pkcs1: tools.pkcs1 || null });
    if (!link.url) {
      console.warn(JSON.stringify({ evt: 'kept_files_failed', repo: site.repo, detail: String(link.error || '').slice(0, 300) }));
      return json({ error: FILES_NOT_NOW, code: 'github' }, 502);
    }
    // The operator hears of a site's download once an hour at most, however often the button is pressed.
    const toldKey = `filesnote:${site.id}`;
    if (!(await env.KILN.get(toldKey).catch(() => null))) {
      await env.KILN.put(toldKey, '1', { expirationTtl: 3600 }).catch(() => {});
      await notifyOwner(env, `Kiln: the files of ${site.repo} were downloaded`, [
        `By: ${signedInAs(sess)}`, `Site: ${more?.name ? `${more.name}, ` : ''}${site.origin}`,
        'They asked for the zip of the repository from the dashboard. Nothing was changed.',
      ]);
    }
    return json({ ok: true, url: link.url, name: keptFilesName({ name: more?.name, repo: site.repo }) }, 200, { 'Cache-Control': 'no-store' });
  }

  // Open the editor of a site whose files Kiln keeps. Its owner has no GitHub
  // account to sign in with at the site, so the dashboard asks here, and the
  // answer is the site's address with an owner session in its fragment: the
  // very address a GitHub sign-in sends an owner to (index.js makes both).
  // The session carries no GitHub token and reaches that one repository only.
  if (path === '/cloud/sites/editor' && request.method === 'POST') {
    const asked = await ownedSite(request, env, url, sess, {}, { needToken: false, needAccess: false });
    if (asked.response) return asked.response;
    const { site } = asked;
    const kept = await keptSite(env, site.id);
    if (!kept || kept.account_id !== sess.account_id) return json({ error: EDITOR_NOT_KEPT, code: 'not_kept' }, 403);
    const opened = await openKeptEditor(env, tools, { site, accountId: sess.account_id, who: () => editorPerson(env, sess) });
    if (!opened.url) return json({ error: opened.error, code: opened.code }, opened.status);
    return json({ ok: true, url: opened.url });
  }

  if (path === '/cloud/sites/remove' && request.method === 'POST') {
    if (!sess) return json({ error: 'not signed in' }, 401);
    const { id } = await request.json().catch(() => ({}));
    const site = await env.kiln_cloud.prepare('SELECT * FROM sites WHERE id = ? AND account_id = ?').bind(id || '', sess.account_id).first();
    if (!site) return json({ ok: true });   // not theirs, or already gone
    // Removing the site removes Manage billing with it, so the subscription
    // is cancelled first, and the site stays if that cannot be confirmed.
    const cancel = await cancelSubscription(env, site);
    if (!cancel.ok) return json({ error: NOT_CANCELLED, code: 'subscription_not_cancelled', reason: cancel.state }, 502);
    const kept = await keptSite(env, site.id);   // asked before the row goes
    const gone = await forgetHosting(env, site.id);   // a hosted site comes down with it, and so does its own domain
    await env.kiln_cloud.prepare('DELETE FROM sites WHERE id = ? AND account_id = ?').bind(site.id, sess.account_id).run();
    await noteSiteRemoved(env, { account_id: sess.account_id, site_id: site.id, by: 'person' });
    await forgetProblems(env, site.id);   // the problem tally (problems.js)
    // Its owner's editing session ends with it, at once and not a minute later (keptStands).
    if (kept && site.repo) { try { await env.KILN.delete(keptStandsKey(sess.account_id, site.repo)); } catch { /* it is forgotten within the minute anyway */ } }
    if (site.repo) await env.KILN.put(`cloudgone:${String(site.repo).toLowerCase()}`, JSON.stringify({ at: Date.now() }));
    // The repository of a site Kiln kept the files of is never touched here. The operator is told that nothing uses it now.
    if (kept && site.repo) { const told = keptRemovedNote({ repo: site.repo, by: signedInAs(sess) }); await notifyOwner(env, told.subject, told.lines); }
    return json({ ok: true, subscription: cancel.state, ...(cancel.ends_at ? { ends_at: cancel.ends_at } : {}), ...domainLeft(gone), ...(await nameLeft(env, site.id)) });
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
      const plan = await planUpdate({ token, repo: site.repo, worker: selfOrigin(url, env), releaseBase: env.KILN_RELEASE_BASE });
      const shown = publicUpdate(plan, { repo: site.repo });
      if (plan.state === 'no_access') return site.kept ? keptNotReached() : refused('no_access', 409, { install_url: await installUrlFor(env) });
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
        await noteProblem(env, { kind: 'setup_failed', site_id: site.id, detail: 'editor_update' });   // the problem tally (problems.js)
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
    const site = await env.kiln_cloud.prepare('SELECT * FROM sites WHERE id = ? AND account_id = ?').bind(url.searchParams.get('site'), sess.account_id).first();
    const portal = await billingPage(env, site, sess.account_id);
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
    // A site whose files Kiln keeps: its owner has never seen a repository, and the list is worded for them (sitecheck.js).
    const isKept = !!(await keptSite(env, site.id));
    const hosting = row ? publicHosting(row, { repo: site.repo, planEnded: Number(site.access_until) || null, kept: isKept, paid: access }) : null;
    const up = !!(hosting && hosting.url && (hosting.state === 'live' || hosting.serving));
    const down = hosting && !up
      ? hosting.error || (hosting.state === 'ended' ? 'Kiln took this site down from its hosting.' : 'Kiln is putting this site up now. Check again in a minute.')
      : isKept && !up ? CHECK_KEPT_NOT_UP : null;
    // Once the site's own domain is live, that is where it is looked at
    // (still as a hosted site: Kiln publishes there). A domain that still
    // waits for its name servers is not asked for anything: the address the
    // hosting gave is looked at, and one more line says what the domain waits for.
    const dom = up ? await domainRow(env, site.id) : null;
    const onDomain = !!(dom && dom.state === 'live' && dom.name);
    const lookAt = !up ? site.origin
      : !onDomain ? hosting.url
        : [dom.name, `www.${dom.name}`].includes(hostName(site.origin)) ? site.origin : `https://${dom.name}`;
    const checks = await checkSite({ token, repo: site.repo, origin: lookAt, hosted: up, ownDomain: onDomain, down, worker: selfOrigin(url, env), installUrl: await installUrlFor(env), canAdd: access, kept: isKept, membersOn: membersGateOn(env), preview: up ? previewPattern(env, site) : null });
    if (dom && dom.state === 'waiting' && dom.name) checks.push(domainWaitingLine({ name: dom.name, seller: publicDomain(dom, { records: false })?.seller?.name }));
    if (!access) {
      let sub = null;
      try { sub = await env.kiln_cloud.prepare(`SELECT ${await subscriptionSql(env)} AS subscription_id FROM sites WHERE id = ?`).bind(site.id).first(); } catch { /* worded as a trial that ended */ }
      checks.unshift(editingOffLine({ status: site.status, subscribed: !!subscriptionOf(sub) }));
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
    if (subscriptionOf(site) && !(site.status === 'canceled' && !siteHasAccess(site))) {
      return json({ error: site.status === 'canceled'
        ? 'This subscription is cancelled but paid up for now: resume it under Manage billing instead of paying again.'
        : 'This site already has a subscription. Use Manage billing to change it.' }, 409);
    }
    // `period=year` asks for the yearly form of the site's plan, where this service sells one.
    const period = url.searchParams.get('period') === 'year' ? 'year' : 'month';
    const checkout = await startCheckout(env, site, { email: await accountEmail(env, sess.account_id), period, accountId: sess.account_id });
    return checkout ? json({ url: checkout }) : json({ error: 'The payment page could not be opened just now. Nothing was charged. Try again in a minute, and write to hello@kilncms.com if it keeps happening.', code: 'billing_not_configured' }, 503);
  }

  // Stripe's webhook: the ONLY thing that flips a site to active.
  if (path === '/cloud/webhook/stripe' && request.method === 'POST') return stripeWebhook(request, env);

  // ── Admin (owner only) ──
  if (path.startsWith('/admin/cloud/')) {
    if (!isCloudAdmin(sess, env)) {
      await noteSecurity(env, { kind: 'cross_account', account_id: sess ? sess.account_id : null, detail: 'admin' });   // the security log (security-log.js)
      return json({ error: 'forbidden' }, 403);
    }
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
      const store = await storeMode(env);
      // What a site brings in a month: the price Stripe holds where it was read
      // (a yearly price counts as a twelfth of it each month), otherwise the
      // fixed monthly figures.
      const price = (p, period) => monthlyPrice(store, p, period);
      const mrr = active.reduce((m, s) => m + price(s.plan, s.billing_period), 0);
      const insights = buildInsights(rows, accounts.n, price);
      // Who the customers are, where each one stopped and who needs a word from the operator (buildCustomers).
      // It is read after everything the answer already had and left out whole when it cannot be read, so
      // nothing that was answered before depends on it.
      let people = {};
      try {
        people = buildCustomers(await customerAccounts(env), rows, { asking: sess.account_id });
        people.needs_you = await withoutHidden(env, people.needs_you);
      }
      // `customers_not_read` lets the admin page say so: without it a failed read looks the same as an older service.
      catch (e) { console.warn(JSON.stringify({ evt: 'cloud_customers_not_read', detail: String(e?.message || e).slice(0, 160) })); people = { customers_not_read: true }; }
      return json({ accounts: accounts.n, sites: rows, active: active.length, mrr: Number(mrr.toFixed(2)), store, insights, ...people });
    }
    // The daily site check (daily-check.js): the latest check of each site, for the admin pages. Nothing is read while it is off.
    if (path === '/admin/cloud/checks' && request.method === 'GET') {
      if (!dailyCheckOn(env)) return json({ ok: true, checking: false, checks: [] });
      try { return json({ ok: true, checking: true, checks: await latestChecks(env) }); }
      catch (e) { console.warn(JSON.stringify({ evt: 'site_checks_not_read', detail: String(e?.message || e).slice(0, 160) })); return json({ ok: true, checking: true, checks: [], not_read: true }); }
    }
    // The security log (security-log.js): the refusals of the last `days` (7, at most 90), the total of each
    // kind, of each kind in each hour, and the rows behind them. Nothing is read while it is off.
    if (path === '/admin/cloud/security' && request.method === 'GET') {
      if (!securityOn(env)) return json({ ok: true, recording: false, kinds: {}, hours: [], rows: [] });
      try { return json({ ok: true, recording: true, ...(await securityPage(env, { days: url.searchParams.get('days') ?? undefined })) }); }
      catch (e) { console.warn(JSON.stringify({ evt: 'security_not_read', detail: String(e?.message || e).slice(0, 160) })); return json({ ok: true, recording: true, kinds: {}, hours: [], rows: [], not_read: true }); }
    }
    // The problem tally (problems.js): the last 14 days by kind and site, each kind marked new (not seen in the 14
    // days before), ongoing, or rising (its last 7 days at least three times its usual a day), and by detail word.
    if (path === '/admin/cloud/problems' && request.method === 'GET') {
      if (!problemsOn(env)) return json({ ok: true, recording: false, kinds: [], sites: [], details: [] });
      try { return json({ ok: true, recording: true, ...(await problemsPage(env)) }); }
      catch (e) { console.warn(JSON.stringify({ evt: 'problems_not_read', detail: String(e?.message || e).slice(0, 160) })); return json({ ok: true, recording: true, kinds: [], sites: [], details: [], not_read: true }); }
    }
    // Daily totals (daily-totals.js): one line a day for the whole of Kiln, newest first, up to 400 (`limit`).
    // Nothing is read while it is off.
    if (path === '/admin/cloud/totals' && request.method === 'GET') {
      if (!totalsOn(env)) return json({ ok: true, recording: false, totals: [] });
      try { return json({ ok: true, recording: true, totals: await totalsPage(env, { limit: url.searchParams.get('limit') ?? undefined }) }); }
      catch (e) { console.warn(JSON.stringify({ evt: 'daily_totals_not_read', detail: String(e?.message || e).slice(0, 160) })); return json({ ok: true, recording: true, totals: [], not_read: true }); }
    }
    // The activity record (activity.js), newest first, for the admin pages: ?account=<id> or ?site=<id> or
    // neither; `limit` up to 200; `before` is the `next` of the page before. Nothing is read while it is off.
    if (path === '/admin/cloud/activity' && request.method === 'GET') {
      if (!activityOn(env)) return json({ ok: true, recording: false, activity: [], next: null });
      const q = url.searchParams;
      try { return json({ ok: true, recording: true, ...(await activityPage(env, { account: q.get('account'), site: q.get('site'), limit: q.get('limit'), before: q.get('before') })) }); }
      catch (e) { console.warn(JSON.stringify({ evt: 'activity_not_read', detail: String(e?.message || e).slice(0, 160) })); return json({ ok: true, recording: true, activity: [], next: null, not_read: true }); }
    }
    if (path === '/admin/cloud/grant' && request.method === 'POST') {
      const { site_id, status, more_days } = await request.json().catch(() => ({}));
      // `more_days: true`: seven more free days for a site nobody pays for (moreFreeDays). Setting such a
      // site to `trialing` when its days are over means the same, or the next run of expireStaleTrials
      // would close it again within five minutes and the operator's word would not have held.
      if (more_days === true || status === 'trialing') {
        const given = await moreFreeDays(env, site_id, { always: more_days === true });
        if (given) return json(given.body, given.status);
      }
      if (!['active', 'trialing', 'past_due', 'canceled'].includes(status)) return json({ error: 'bad status' }, 400);
      // The operator's word is final: no leftover date keeps a site open (or shut).
      await withAccessUntil(
        () => env.kiln_cloud.prepare('UPDATE sites SET status = ?, access_until = NULL WHERE id = ?').bind(status, site_id).run(),
        () => env.kiln_cloud.prepare('UPDATE sites SET status = ? WHERE id = ?').bind(status, site_id).run(),
      );
      await noteActivity(env, { site_id, kind: 'operator_status_set', by: 'operator', detail: { status } });
      return json({ ok: true });
    }
    // One line of "Needs you" hidden for NEEDS_HIDE_DAYS: someone the operator has already written to, or
    // one of the operator's own test accounts. If it is still so when the days are over, it is shown again.
    // `undo: true` shows it again at once (the admin page's Undo, right after Hide).
    if (path === '/admin/cloud/needs/hide' && request.method === 'POST') {
      const { key, undo } = await request.json().catch(() => ({}));
      if (typeof key !== 'string' || !NEED_KEY_RE.test(key)) return json({ error: 'That is not a line of Needs you.' }, 400);
      if (undo === true) { await env.KILN.delete(`nhide:${key}`); await noteLineHidden(env, key, true); return json({ ok: true, hidden: false }); }
      const until = Date.now() + NEEDS_HIDE_DAYS * 86400 * 1000;
      await env.KILN.put(`nhide:${key}`, JSON.stringify({ at: Date.now(), until }), { expirationTtl: NEEDS_HIDE_DAYS * 86400 });
      await noteLineHidden(env, key, false);
      return json({ ok: true, until });
    }
    if (path === '/admin/cloud/remove' && request.method === 'POST') {
      const { site_id, force } = await request.json().catch(() => ({}));
      const site = await env.kiln_cloud.prepare('SELECT * FROM sites WHERE id = ?').bind(site_id || '').first();
      if (!site) return json({ ok: true });
      // Same rule as the customer's own Remove. `force` is for the operator who
      // has already ended the subscription with the billing company by hand.
      const cancel = force ? { ok: true, state: 'forced' } : await cancelSubscription(env, site);
      if (!cancel.ok) {
        return json({ error: `subscription ${subscriptionOf(site)} could not be cancelled (${cancel.state}); cancel it in ${providerName(subscriptionProvider(site))}, then remove with force`, code: 'subscription_not_cancelled', reason: cancel.state }, 502);
      }
      const kept = await keptSite(env, site.id);   // asked before the row goes
      const gone = await forgetHosting(env, site.id);
      await env.kiln_cloud.prepare('DELETE FROM sites WHERE id = ?').bind(site.id).run();
      await noteSiteRemoved(env, { account_id: site.account_id, site_id: site.id, by: 'operator' });
      await forgetProblems(env, site.id);   // the problem tally (problems.js)
      // What the owner's own Remove does after the row is gone: their editing session ends, the site is marked as gone,
      // and for a site Kiln kept the files of, the operator gets the note that names the day its repository may be deleted.
      if (kept && site.repo) { try { await env.KILN.delete(keptStandsKey(site.account_id, site.repo)); } catch { /* it is forgotten within the minute anyway */ } }
      if (site.repo) await env.KILN.put(`cloudgone:${String(site.repo).toLowerCase()}`, JSON.stringify({ at: Date.now() }));
      if (kept && site.repo) { const told = keptRemovedNote({ repo: site.repo, by: `${signedInAs(sess)}, from the admin page` }); await notifyOwner(env, told.subject, told.lines); }
      return json({ ok: true, subscription: cancel.state, ...domainLeft(gone), ...(await nameLeft(env, site.id)) });
    }
    // A name Kiln registered (register.js): the list for the operator's page, and the three actions for a
    // registration nobody heard back about and for a name that has left. None of them can register anything.
    // With the switch off these are no routes.
    //   GET  /admin/cloud/registrations                          → { ok, registrations: [...] }
    //   POST /admin/cloud/registration/free       { id, name }   a stuck row becomes failed (the name typed out)
    //   POST /admin/cloud/registration/registered { id }         a stuck row becomes registered and goes on to its site
    //   POST /admin/cloud/registration/handed     { id }         a registered row becomes handed_over
    if (path.startsWith('/admin/cloud/registration') && await registerReady(env)) {
      if (path === '/admin/cloud/registrations' && request.method === 'GET') return json({ ok: true, registrations: await registrationsForOperator(env) });
      const act = request.method === 'POST' ? { '/admin/cloud/registration/free': freeRow, '/admin/cloud/registration/registered': markRegistered, '/admin/cloud/registration/handed': handedOver }[path] : null;
      if (act) {
        const done = await act(env, await request.json().catch(() => ({})), registerTools());
        return json(done.body, done.status);
      }
    }
    // Per-site troubleshooting: app-install check, live-site reachability, /kiln
    // entry check, editability (is the origin actually in the active/trialing
    // allowlist), and the subscription's live status at its billing company.
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

      if (site.stripe_subscription_id) {
        const r = await stripeCall(env, 'GET', `/subscriptions/${encodeURIComponent(site.stripe_subscription_id)}`);
        const st = r.ok ? r.body?.status : null;
        add('Stripe subscription', st === 'active' || st === 'trialing',
          r.status === 0 ? 'Stripe could not be reached' : `Stripe status: ${st || 'unknown'}${r.body?.cancel_at_period_end ? ', set to end with its period' : ''}`);
      } else {
        add('Stripe subscription', false, 'No subscription yet (trial or comped)');
      }
      return json({ site, checks });
    }
  }

  return null;  // not a cloud route
}

// ─── Stripe's webhook ────────────────────────────────────────────────────────
//
// What each Stripe subscription status means for a site. Each one comes to a
// `status`, which the dashboard and the admin page show, and an `access`:
//   'yes'    editing is on
//   'until'  set to end, and paid up to a day: editing stays on until then
//   'grace'  a charge failed (or billing is paused): editing stays on for
//            PAST_DUE_GRACE_DAYS from the first such event, while Stripe
//            tries the card again
//   'no'     the subscription is over: editing is off, and the day it stopped
//            stays on the row (`access_until`, now in the past), because a
//            site Kiln hosts comes down a set number of days after that day
//            (hostingEndsAt)
//
// Stripe's statuses:
//   active               active, 'yes'. Once it is set to end with its period
//                        (`cancel_at_period_end`, or a `cancel_at` day):
//                        canceled, 'until' that day
//   trialing             trialing, 'yes' (Kiln asks Stripe for no trial; kept
//                        for a subscription the operator makes by hand)
//   past_due, unpaid,    past_due, 'grace'
//   paused
//   canceled             canceled, 'no'. Only this one ends access outright.
// `incomplete` and `incomplete_expired` (the first payment has not gone
// through) change nothing: the site keeps its free days.
const STRIPE_STATE = {
  active:   { status: 'active',   access: 'yes' },
  trialing: { status: 'trialing', access: 'yes' },
  past_due: { status: 'past_due', access: 'grace' },
  unpaid:   { status: 'past_due', access: 'grace' },
  paused:   { status: 'past_due', access: 'grace' },
  canceled: { status: 'canceled', access: 'no' },
};
/** What a Stripe subscription means for its site ({ status, access }), or null for a status that changes nothing. */
export function stripeStateFor(sub) {
  const base = sub && Object.prototype.hasOwnProperty.call(STRIPE_STATE, sub.status) ? STRIPE_STATE[sub.status] : null;
  if (!base) return null;
  if (base.status === 'active' && (sub.cancel_at_period_end || Number(sub.cancel_at))) return { status: 'canceled', access: 'until' };
  return base;
}
const secondsToMs = (v) => (Number(v) > 0 ? Number(v) * 1000 : null);
// Since API version 2025-03-31.basil the period's end is on the subscription's item, not on the subscription.
const periodEndOf = (sub) => secondsToMs(sub?.items?.data?.[0]?.current_period_end ?? sub?.current_period_end);
const priceOf = (sub) => sub?.items?.data?.[0]?.price?.id || null;
const idOf = (v) => (typeof v === 'string' ? v : v && typeof v === 'object' ? v.id || null : null);

/**
 * POST /cloud/webhook/stripe. The signature is checked before anything is
 * read, and a body that fails it is never looked at (400). Stripe sends again
 * whatever was not answered with 2xx, and may send an event twice or out of
 * order: an event id that was handled answers `replayed` and changes nothing,
 * and a change older than the last one applied to a subscription is left out.
 * The id is written down only after the change is made, so a database that
 * fails leaves Stripe's next try to do it.
 */
async function stripeWebhook(request, env) {
  const bodyText = await request.text();
  if (!(await verifyStripeSignature(request.headers.get('Stripe-Signature'), bodyText, env.STRIPE_WEBHOOK_SECRET))) {
    console.warn(JSON.stringify({ evt: 'webhook_rejected', provider: 'stripe', reason: env.STRIPE_WEBHOOK_SECRET ? 'bad or old signature' : 'no webhook secret configured', bytes: bodyText.length }));
    await noteSecurity(env, { kind: 'bad_signature', detail: 'stripe' });   // the security log (security-log.js)
    return json({ error: 'bad signature' }, 400);
  }
  let evt;
  try { evt = JSON.parse(bodyText); } catch { return json({ error: 'not json' }, 400); }
  if (!evt || !evt.id) return json({ ok: true, ignored: 'no event id' });
  const evtKey = `stripeevt:${evt.id}`;
  if (await env.KILN.get(evtKey)) return json({ ok: true, replayed: true });
  const type = String(evt.type || '');
  const obj = (evt.data && evt.data.object) || {};
  const at = secondsToMs(evt.created) ?? Date.now();
  let out;
  if (type === 'checkout.session.completed') out = await stripeCheckoutDone(env, obj, at);
  else if (type === 'customer.subscription.created' || type === 'customer.subscription.updated' || type === 'customer.subscription.deleted') out = await stripeSubscriptionChanged(env, type, obj, at);
  else if (type === 'invoice.payment_failed') out = await stripePaymentFailed(env, obj, at);
  else if (type === 'charge.refunded' || type === 'charge.dispute.created' || type === 'charge.dispute.closed') out = await stripeChargeEvent(env, type, obj);
  else out = { ignored: type || 'no type' };
  await env.KILN.put(evtKey, '1', { expirationTtl: 7 * 24 * 3600 });
  return json({ ok: true, ...out });
}

const SITE_COLUMNS = 'id, account_id, repo, origin, plan, stripe_subscription_id';
async function stripeSite(env, siteId, subId) {
  const db = env.kiln_cloud;
  const byId = siteId ? await db.prepare(`SELECT ${SITE_COLUMNS} FROM sites WHERE id = ?`).bind(String(siteId)).first() : null;
  return byId || (subId ? await db.prepare(`SELECT ${SITE_COLUMNS} FROM sites WHERE stripe_subscription_id = ?`).bind(String(subId)).first() : null);
}
async function keepStripeCustomer(env, site, customer) {
  if (!customer) return;
  await env.kiln_cloud.prepare('UPDATE sites SET stripe_customer_id = ? WHERE id = ?').bind(customer, site.id).run();
  try { await env.kiln_cloud.prepare('UPDATE accounts SET stripe_customer_id = ? WHERE id = ? AND stripe_customer_id IS NULL').bind(customer, site.account_id).run(); } catch { /* not worth failing a billing event for */ }
}

/**
 * Put a subscription's state on its site, and the day its access runs to
 * (`access_until`). A site already in its grace keeps the day it was given: a
 * second failed charge does not start the days again. For a subscription that
 * is over, a day already on the row and already past is kept as it is (the
 * paid time, or the grace, ran out then, and the owner of a hosted site has
 * been written to about that day); otherwise the day is the moment the
 * subscription ended, never later than now. Answers false when a later change
 * was applied already, and then changes nothing.
 */
async function applyStripeState(env, { site, subId, state, at, end = null }) {
  const lastKey = `stripeat:${subId}`;
  const last = Number(await env.KILN.get(lastKey)) || 0;
  if (at < last) return false;
  const until = state.access === 'until' ? end : state.access === 'grace' ? at + PAST_DUE_GRACE_DAYS * 86400 * 1000 : null;
  const endedAt = state.access === 'no' ? Math.min(end ?? Infinity, at, Date.now()) : null;
  const setUntil = state.access === 'grace'
    ? "access_until = CASE WHEN status = 'past_due' AND access_until IS NOT NULL THEN access_until ELSE ? END"
    : state.access === 'no' ? 'access_until = MIN(COALESCE(access_until, ?), ?)'
    : 'access_until = ?';
  const untilArgs = state.access === 'no' ? [endedAt, endedAt] : [until];
  await env.kiln_cloud.prepare(`UPDATE sites SET ${setUntil}, status = ?, stripe_subscription_id = ? WHERE id = ?`).bind(...untilArgs, state.status, String(subId), site.id).run();
  await env.KILN.put(lastKey, String(at), { expirationTtl: 400 * 86400 });
  return { status: state.status, until };
}

// A Checkout Session was paid: the site, its customer and its subscription are tied together, and the site is active.
// The activity record (activity.js): how a site's payment stood before a notice from Stripe changes it,
// read only while the record is on. `paid_until` arrives with migration 0016; without it a renewal is
// told only by a charge that went through after one failed.
async function paidBefore(env, siteId) {
  if (!activityOn(env)) return null;
  try { return await env.kiln_cloud.prepare('SELECT status, stripe_subscription_id AS sub, paid_until FROM sites WHERE id = ?').bind(siteId).first(); }
  catch { try { return await env.kiln_cloud.prepare('SELECT status, stripe_subscription_id AS sub FROM sites WHERE id = ?').bind(siteId).first(); } catch { return null; } }
}

async function stripeCheckoutDone(env, s, at) {
  if (s.mode !== 'subscription') return { ignored: 'not a subscription checkout' };
  const subId = idOf(s.subscription), customer = idOf(s.customer);
  const site = await stripeSite(env, (s.metadata && s.metadata.site_id) || s.client_reference_id, subId);
  if (!site || !subId) return { ignored: 'no site or no subscription' };
  await keepStripeCustomer(env, site, customer);
  // The address the customer gave when paying, kept for notices when the account has none.
  const email = mailAddress((s.customer_details && s.customer_details.email) || s.customer_email);
  if (email) { try { await env.kiln_cloud.prepare("UPDATE accounts SET email = ? WHERE id = ? AND (email IS NULL OR email = '')").bind(email, site.account_id).run(); } catch { /* not worth failing a billing event for */ } }
  if (s.payment_status !== 'paid' && s.payment_status !== 'no_payment_required') {
    await env.kiln_cloud.prepare('UPDATE sites SET stripe_subscription_id = ? WHERE id = ?').bind(subId, site.id).run();
    return { waiting: 'payment not complete yet' };
  }
  const was = await paidBefore(env, site.id);   // for the activity record, below
  const applied = await applyStripeState(env, { site, subId, state: STRIPE_STATE.active, at });
  // The activity record (activity.js): a subscription that started, unless this site was already paid by it.
  if (applied && was && !(was.status === 'active' && was.sub === subId)) await noteActivity(env, { account_id: site.account_id, site_id: site.id, kind: 'subscription_started', by: 'stripe', detail: { plan: site.plan } });
  return applied ? {} : { ignored: 'older than the last change' };
}

// A subscription was made, changed or ended.
async function stripeSubscriptionChanged(env, type, sub, at) {
  const subId = idOf(sub);
  const site = await stripeSite(env, sub.metadata && sub.metadata.site_id, subId);
  if (!site || !subId) return { ignored: 'unknown site' };
  const state = type === 'customer.subscription.deleted' ? STRIPE_STATE.canceled : stripeStateFor(sub);
  if (!state) return { ignored: `status ${sub.status || 'unknown'}` };
  // A subscription the site has left behind (it was paid again later by another one) cannot end or hold up the one that pays now.
  if (site.stripe_subscription_id && site.stripe_subscription_id !== subId && state.access !== 'yes') return { ignored: 'not the subscription this site is paid by now' };
  const was = await paidBefore(env, site.id);   // as it stood, for the activity record below (read only while it is on)
  await keepStripeCustomer(env, site, idOf(sub.customer));
  const end = state.access === 'until' ? (secondsToMs(sub.cancel_at) ?? periodEndOf(sub))
    : state.access === 'no' ? secondsToMs(sub.ended_at) : null;
  const applied = await applyStripeState(env, { site, subId, state, at, end });
  if (!applied) return { ignored: 'older than the last change' };
  // Paid by the month or by the year, and up to when (migration 0016), from the price that is paid for.
  const price = priceOf(sub);
  const period = periodForPrice(env, price);
  if (period) {
    const paidUntil = state.access === 'yes' && state.status === 'active' ? periodEndOf(sub) : state.access === 'until' ? end : null;
    const set = paidUntil === null ? 'billing_period = ?' : 'billing_period = ?, paid_until = ?';
    await env.kiln_cloud.prepare(`UPDATE sites SET ${set} WHERE id = ?`).bind(...(paidUntil === null ? [period] : [period, paidUntil]), site.id).run();
  }
  // The plan on record is the plan that is paid for (the customer or the operator can change the price in Stripe).
  const paidPlan = planForPrice(env, price);
  let planNote = null;
  if (paidPlan && site.plan !== paidPlan) {
    try {
      await env.kiln_cloud.prepare('UPDATE sites SET plan = ? WHERE id = ?').bind(paidPlan, site.id).run();
      planNote = `Plan: now ${paidPlan} (was ${site.plan || 'not set'}), because that is the plan the subscription pays for.`;
    } catch (e) {
      planNote = `Plan: the subscription pays for ${paidPlan} but the site says ${site.plan || 'nothing'}, and the record could not be changed (${String(e?.message || e).slice(0, 120)}).`;
    }
  }
  // The activity record (activity.js): a subscription that started, was paid again (a renewal, or a charge
  // that went through after one failed) or ended. Nothing about the card or the amount.
  // A subscription set to end with its period (paid until then, stored as cancelled) is the clearest sign a
  // customer is leaving; set back before the end, it is said again with `undo`.
  const ending = !!was && type !== 'customer.subscription.deleted' && state.access === 'until' && was.status === 'active' && was.sub === subId;
  const resumed = !!was && type !== 'customer.subscription.deleted' && state.access === 'yes' && state.status === 'active'
    && was.status === 'canceled' && was.sub === subId && Number(was.paid_until) > Date.now();
  if (ending || resumed) await noteActivity(env, { account_id: site.account_id, site_id: site.id, kind: 'subscription_ending', by: 'stripe', detail: { plan: paidPlan || site.plan, period, ...(resumed ? { undo: true } : {}) } });
  const paidKind = !was || ending || resumed ? null : type === 'customer.subscription.deleted' ? 'subscription_ended'
    : state.access !== 'yes' || state.status !== 'active' ? null
    : was.sub !== subId || !['active', 'past_due'].includes(was.status) ? 'subscription_started'
    : was.status === 'past_due' || (Number(was.paid_until) > 0 && Number(periodEndOf(sub)) > Number(was.paid_until)) ? 'subscription_renewed' : null;
  if (paidKind) await noteActivity(env, { account_id: site.account_id, site_id: site.id, kind: paidKind, by: 'stripe', detail: { plan: paidPlan || site.plan, period } });
  await notifyOwner(env, `Kiln billing: ${type} → ${state.status}`, [
    `Site: ${site.repo || site.id} (${site.origin || 'origin unknown'})`,
    `Status: ${state.status}${applied.until ? `, access until ${new Date(applied.until).toISOString()}` : ''}`,
    `Billing: Stripe, subscription ${subId}`,
    ...(planNote ? [planNote] : []),
  ]);
  return {};
}

// A renewal could not be charged: the site's grace starts (or keeps the day it already has).
async function stripePaymentFailed(env, inv, at) {
  const details = (inv.parent && inv.parent.subscription_details) || {};
  const subId = idOf(details.subscription) || idOf(inv.subscription);
  const site = subId ? await stripeSite(env, details.metadata && details.metadata.site_id, subId) : null;
  if (!site) return { ignored: 'no subscription this service knows' };
  const applied = await applyStripeState(env, { site, subId, state: STRIPE_STATE.past_due, at });
  if (!applied) return { ignored: 'older than the last change' };
  await noteActivity(env, { account_id: site.account_id, site_id: site.id, kind: 'payment_failed', by: 'stripe' });
  await notifyOwner(env, 'Kiln billing: invoice.payment_failed → past_due', [
    `Site: ${site.repo || site.id} (${site.origin || 'origin unknown'})`,
    `Status: past_due, access until ${new Date(applied.until).toISOString()} unless a later charge goes through`,
    `Billing: Stripe, subscription ${subId}`,
  ]);
  return {};
}

/**
 * A charge refunded, a payment disputed, or a dispute closed: one line in the
 * activity record (activity.js: `refund`, `dispute_opened`, `dispute_closed`,
 * by `stripe`) for the site the charge paid for, with the outcome of a closed
 * dispute and nothing else: never the amount, the card or the reason given. A
 * dispute opened is also an alert to the operator (notifyOwner, "Kiln alert:"),
 * whether the record is on or not; the other two read nothing while it is off.
 * The site is found by the invoice the charge carries, where Stripe sends it
 * along, else by the charge's customer (keepStripeCustomer): the one site that
 * customer pays for, or, when it pays for several, the account alone. A
 * dispute's notice names only its charge, so the charge is asked of Stripe. A
 * charge that is no site's is ignored with a log line.
 */
async function stripeChargeEvent(env, type, obj) {
  const kind = type === 'charge.refunded' ? 'refund' : type === 'charge.dispute.created' ? 'dispute_opened' : 'dispute_closed';
  if (kind !== 'dispute_opened' && !activityOn(env)) return { ignored: type };
  const charge = kind === 'refund' ? obj : typeof obj.charge === 'string' ? await stripeChargeOf(env, obj.charge) : obj.charge;
  const found = charge && typeof charge === 'object' ? await chargeSite(env, charge) : null;
  if (!found) {
    console.log(JSON.stringify({ evt: 'stripe_charge_unknown', type }));
    return { ignored: 'no site this service knows' };
  }
  const { site, account_id } = found;
  await noteActivity(env, { account_id, site_id: site ? site.id : null, kind, by: 'stripe', detail: kind === 'dispute_closed' ? { outcome: obj.status } : null });
  if (kind === 'dispute_opened') {
    const due = secondsToMs(obj.evidence_details && obj.evidence_details.due_by);
    await notifyOwner(env, `Kiln alert: a payment was disputed${site ? ` (${site.repo || site.id})` : ''}`, [
      site ? `Site: ${site.repo || site.id} (${site.origin || 'origin unknown'})` : `Account: ${account_id}, which pays for more than one site`,
      `Dispute: ${idOf(obj) || 'no id'}, on charge ${idOf(charge) || 'unknown'}`,
      `Answer it in Stripe before ${due ? new Date(due).toISOString() : 'its deadline'}; unanswered, the money stays with the customer.`,
    ]);
  }
  return {};
}

/** A charge, asked of Stripe by its id; null where Stripe has none. It throws when Stripe could not be asked, so the notice is answered 500 and Stripe sends it again. */
async function stripeChargeOf(env, id) {
  if (!/^(ch|py)_[A-Za-z0-9]{1,200}$/.test(id) || !env.STRIPE_SECRET_KEY) return null;
  const r = await stripeCall(env, 'GET', `/charges/${id}`);
  if (r.ok && r.body && typeof r.body === 'object') return r.body;
  if (r.status === 404) return null;
  throw new Error(`Stripe could not be asked about a disputed charge (${r.status || 'no answer'})`);
}

/** The site a charge paid for and its account, as stripeChargeEvent says; null when it is no site's. */
async function chargeSite(env, charge) {
  const inv = charge.invoice && typeof charge.invoice === 'object' ? charge.invoice : null;
  const details = (inv && inv.parent && inv.parent.subscription_details) || {};
  const subId = inv ? idOf(details.subscription) || idOf(inv.subscription) : null;
  const byInvoice = subId ? await stripeSite(env, details.metadata && details.metadata.site_id, subId) : null;
  if (byInvoice) return { site: byInvoice, account_id: byInvoice.account_id };
  const customer = idOf(charge.customer);
  if (!customer) return null;
  const rows = (await env.kiln_cloud.prepare(`SELECT ${SITE_COLUMNS} FROM sites WHERE stripe_customer_id = ? ORDER BY created_at LIMIT 5`).bind(String(customer)).all())?.results || [];
  if (!rows.length || rows.some(r => r.account_id !== rows[0].account_id)) return null;
  return { site: rows.length === 1 ? rows[0] : null, account_id: rows[0].account_id };
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
    if (s.status === 'active') { if (s.plan === 'managed') mrrManaged += price('managed', s.billing_period); else mrrCloud += price('cloud', s.billing_period); }
    if (now - s.created_at < 30 * day) signups30++;
    if (now - s.created_at < 7 * day) signups7++;
    // Self-serve trials (no subscription) auto-expire 7 days after creation.
    if (s.status === 'trialing' && !subscriptionOf(s)) {
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

/**
 * Every account, newest first, with the address Kiln may write to (mail.js,
 * addressSql). Each column that arrived with a later migration is asked for,
 * then done without: the campaign tags (0021), `last_seen` (0020), `linked_at`
 * (0019), `signin_email` (0018), `name` and `google_sub` (0008).
 */
async function customerAccounts(env) {
  const address = await addressSql(env);
  const asked = [
    'a.name, a.google_sub, a.signin_email, a.linked_at, a.last_seen, a.utm_source, a.utm_medium, a.utm_campaign',
    'a.name, a.google_sub, a.signin_email, a.linked_at, a.last_seen',
    'a.name, a.google_sub, a.signin_email, a.linked_at',
    'a.name, a.google_sub, a.signin_email',
    'a.name, a.google_sub',
    'NULL AS name',
  ];
  for (const columns of asked) {
    try { return (await env.kiln_cloud.prepare(`SELECT a.id, a.github_login, a.created_at, ${columns}, ${address} FROM accounts a ORDER BY a.created_at DESC, a.id`).all()).results || []; }
    catch (e) { if (columns === asked[asked.length - 1]) throw e; }
  }
  return [];
}

/**
 * How far a site's set-up has got, in the operator's words. The dashboard
 * calls a site set up once Kiln is in its repository (`prepared_at`) or Kiln
 * keeps its files (`kept`); "ready to edit" is one step on: a first pass of
 * what can be edited is marked (`firstpass_at`), or Kiln made the site itself
 * (`kept`), or a change has already been published through Kiln, or someone
 * has had the editor open on the site (`editor_seen`, which the overview
 * reads for each site before this is asked). The last two show that the site
 * can be edited whoever marked it: a site its owner prepared by hand has no
 * first pass, and one in use before migration 0020 has no publish recorded.
 */
function siteSetUp(s) {
  if (s.firstpass_at || s.kept || s.last_publish || s.editor_seen) return 'ready to edit';
  return s.prepared_at ? 'kiln added' : 'not started';
}

// The furthest an account got, in order. Each one counts as having reached every stage before it.
const STAGES = ['signed up', 'added a site', 'set up', 'published', 'paying'];
const FUNNEL_KEYS = ['signed_up', 'added_site', 'set_up', 'published', 'paying'];
// What the operator is told needs them, most urgent first, with the few words the admin page puts on each.
const NEEDS = [['trial_no_address', 'Trial ending, no address'], ['payment_failed', 'Payment failed'], ['trial_ended', 'Trial ended, not subscribed'], ['stuck_setup', 'Stuck in set-up'], ['no_site', 'No site yet']];
const NEEDS_TRIAL_DAYS = 3;     // a trial that ends within this many days
const NEEDS_AFTER_DAYS = 2;     // a site or an account is left alone for its first two days
const NEEDS_UNTIL_DAYS = 30;    // an account with no site is no longer news after a month
const NEEDS_ENDED_DAYS = 7;     // free days that ran out with nobody subscribing are news for a week
const NEEDS_HIDE_DAYS = 30;     // a line the operator hid stays hidden this long, and comes back if it is still so then
/**
 * What a line of `needs_you` is known and hidden by: its kind, the account, and the site or "-". A line
 * about a day (free days that end or ended, the day editing stops after a failed charge) carries that day
 * too, so hiding it hides this occurrence only: the next failed charge, or the end of days given later,
 * is a new line.
 */
const needKey = (kind, accountId, siteId, when = null) => `${kind}:${accountId}:${siteId || '-'}${Number(when) > 0 ? `:${Math.floor(Number(when))}` : ''}`;
// The activity record (activity.js): the operator hid a line of Needs you, or showed it again. Its key names the kind of line, the account and the site.
const noteLineHidden = (env, key, undo) => { const [line, account, site] = String(key).split(':'); return noteActivity(env, { account_id: account, site_id: site && site !== '-' ? site : null, kind: 'operator_line_hidden', by: 'operator', detail: { line, ...(undo ? { undo: true } : {}) } }); };
const NEED_KEY_RE = /^(trial_no_address|trial_ended|payment_failed|stuck_setup|no_site):[\w-]{1,80}:[\w-]{1,80}(:\d{1,16})?$/;
/**
 * `needs_you` without the lines the operator hid (KV `nhide:<key>`, written by
 * POST /admin/cloud/needs/hide). Each is read by its own key, not listed, so a
 * line hidden a moment ago stays hidden on the next load. KV not answering
 * leaves every line shown.
 */
async function withoutHidden(env, list) {
  if (!Array.isArray(list) || !list.length) return list || [];
  const shown = await Promise.all(list.map(async (n) => {
    try { return (await env.KILN.get(`nhide:${n.key}`)) ? null : n; } catch { return n; }
  }));
  return shown.filter(Boolean);
}

/**
 * The operator's view of the customers, from every account (customerAccounts)
 * and the site rows the overview already read:
 *   customers  one entry for an account, newest first, with its sites
 *   needs_you  the few things only the operator can do something about
 *   funnel     how many accounts reached at least each stage
 * `asking` is the operator's own account. It, and any other account Kiln
 * writes to at the same address (the operator signing in with Google or by
 * email to try the dashboard), is listed like any other with `operator: true`,
 * but is never in `needs_you` and is not counted in `funnel`: neither is about
 * a customer. Each line of `needs_you` has a `key` (kind, account, site) that
 * the operator can hide it by (POST /admin/cloud/needs/hide). Nothing here is
 * a token or an id at Stripe or GitHub. `paying` means a subscription that is
 * running or whose last charge failed: a site the operator set to active by
 * hand has no subscription and is not counted.
 */
export function buildCustomers(accounts, rows, { now = Date.now(), asking = null } = {}) {
  const day = 86400 * 1000;
  const opAddress = String((asking && accounts.find(a => a.id === asking)?.email) || '').toLowerCase() || null;
  const dayOf = (t) => new Date(Number(t)).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
  const daysAgo = (t) => { const n = Math.floor((now - Number(t)) / day); return n === 1 ? '1 day ago' : `${n} days ago`; };
  const host = (origin) => { try { return new URL(origin).host; } catch { return null; } };
  const byAccount = new Map();
  for (const s of rows) { if (!byAccount.has(s.account_id)) byAccount.set(s.account_id, []); byAccount.get(s.account_id).push(s); }
  const needs = Object.fromEntries(NEEDS.map(([kind]) => [kind, []]));
  const labels = Object.fromEntries(NEEDS);
  const funnel = Object.fromEntries(FUNNEL_KEYS.map(k => [k, 0]));
  const customers = accounts.map(a => {
    const address = a.email || null;
    // The operator's other accounts are known by the operator's address, and only where that address was
    // confirmed for the account (Google's, or the one an emailed link went to). An address typed into the
    // dashboard by a person signed in with GitHub is confirmed by nobody, and marks nobody as the operator.
    const confirmed = !!(a.google_sub || a.signin_email);
    const operator = a.id === asking || (confirmed && !!opAddress && !!address && address.toLowerCase() === opAddress);
    const login = a.github_login || null;
    const who = login ? `@${login}` : a.name || address || 'no name';
    // How each sentence ends: what the operator can do, given how this person can be reached.
    const reach = (then, alone) => address ? `write to them at ${address}${then}`
      : login ? `Kiln has no address for them, so reach them on GitHub as @${login}${then}`
        : `Kiln has no address for them and they have no GitHub login, so ${alone}`;
    const own = byAccount.get(a.id) || [];
    const sites = own.map(s => ({
      id: s.id,
      label: s.name || s.repo || host(s.origin) || s.id,
      origin: s.origin || null,
      plan: s.plan,
      status: s.status,
      kept: !!s.kept,
      trial_ends: s.status === 'trialing' && !subscriptionOf(s) && Number(s.created_at) ? trialEndsAt(s.created_at, TRIAL_GRACE_DAYS) : null,
      // Free days that ran out with nobody subscribing: closed, never paid for, and no day left from a plan.
      trial_ended: s.status === 'canceled' && !subscriptionOf(s) && !Number(s.access_until) && Number(s.created_at) ? trialEndsAt(s.created_at, TRIAL_GRACE_DAYS) : null,
      paid_until: s.paid_until ?? null,
      billing_period: s.billing_period ?? null,
      access_until: s.access_until ?? null,
      set_up: siteSetUp(s),
      last_publish: s.last_publish ?? null,
    }));
    let reached = sites.length ? 1 : 0;
    if (sites.some(s => s.set_up !== 'not started')) reached = 2;
    if (sites.some(s => s.last_publish)) reached = 3;
    if (own.some(s => (s.status === 'active' || s.status === 'past_due') && subscriptionOf(s))) reached = 4;
    if (!operator) for (let i = 0; i <= reached; i++) funnel[FUNNEL_KEYS[i]]++;
    // The operator's own accounts are nobody the operator has to write to.
    // `when`: the day the line is about, where it has one (it goes into the key). `more_days`: the operator can give this site seven more free days from the line.
    const need = (kind, site, at, detail, { when = null, more_days = false } = {}) => operator ? null : needs[kind].push({ at, row: { kind, account_id: a.id, site_id: site ? site.id : null, key: needKey(kind, a.id, site ? site.id : null, when), who, label: labels[kind], detail, ...(more_days ? { more_days: true } : {}) } });
    sites.forEach((s, i) => {
      const added = Number(own[i].created_at) || 0;
      if (s.trial_ends && !address && s.trial_ends > now && s.trial_ends - now <= NEEDS_TRIAL_DAYS * day) {
        need('trial_no_address', s, s.trial_ends, `The free days of ${s.label} end on ${dayOf(s.trial_ends)} and Kiln's reminder cannot reach this person: ${reach(', or give the site seven more free days', 'all you can do is give the site seven more free days')}.`, { when: s.trial_ends, more_days: true });
      }
      if (s.trial_ended && s.trial_ended <= now && now - s.trial_ended < NEEDS_ENDED_DAYS * day) {
        need('trial_ended', s, -s.trial_ended, `The free days of ${s.label} ended on ${dayOf(s.trial_ended)} and nobody subscribed, so editing is off: ${reach(' and ask what held them back, or give the site seven more free days', 'all you can do is give the site seven more free days')}.`, { when: s.trial_ended, more_days: true });
      }
      if (s.status === 'past_due') {
        need('payment_failed', s, s.access_until || Infinity, `The last charge for ${s.label} did not go through${s.access_until ? ` and editing stops on ${dayOf(s.access_until)} unless a later one does` : ''}: ${reach(', or look at the subscription in Stripe', 'look at the subscription in Stripe')}.`, { when: s.access_until });
      }
      if (s.status !== 'canceled' && s.set_up !== 'ready to edit' && added && now - added > NEEDS_AFTER_DAYS * day) {
        const where = s.set_up === 'kiln added' ? 'Kiln is in its repository, but nothing is marked for editing yet' : 'Kiln is not in its repository yet';
        need('stuck_setup', s, added, `${s.label} was added ${daysAgo(added)} and ${where}: ${reach(' and offer to help', 'there is nobody to write to')}.`);
      }
    });
    const since = Number(a.created_at) || 0;
    if (!sites.length && since && now - since > NEEDS_AFTER_DAYS * day && now - since < NEEDS_UNTIL_DAYS * day) {
      need('no_site', null, -since, `Signed up ${daysAgo(since)} and has not added a site: ${reach(' and ask what stopped them', 'there is nobody to write to')}.`);
    }
    return {
      id: a.id, who,
      signs_in: [login && 'github', a.google_sub && 'google', a.signin_email && 'email'].filter(Boolean),
      linked: !!a.linked_at,
      address,
      created_at: a.created_at ?? null,
      last_seen: a.last_seen ?? null,
      stage: STAGES[reached],
      operator,
      came_from: a.utm_source || a.utm_medium || a.utm_campaign ? { source: a.utm_source || null, medium: a.utm_medium || null, campaign: a.utm_campaign || null } : null,
      sites,
    };
  });
  // Within a kind: the trial that ends soonest, the access that stops soonest, the trial that ended last, the site stuck longest, the newest sign-up.
  const needs_you = NEEDS.flatMap(([kind]) => needs[kind].sort((x, y) => x.at - y.at).map(n => n.row));
  return { customers, needs_you, funnel };
}

// What register.js is handed from here: how the operator is written to, and what "up on Kiln's hosting" means.
function registerTools() { return { notify: notifyOwner, up: isUp, access: siteHasAccess }; }

/** What the answer to removing a site says of a name Kiln registered for it: the name stays registered, and removing the site does not hand it over. */
async function nameLeft(env, siteId) {
  const held = await registeredFor(env, siteId);
  return held ? { registration: { name: held.name, runs_until: held.until, note: removedNote(held) } } : {};
}

/**
 * Such a name later on, in the five-minute job after `sweepRegistrations`
 * (register.js): renewal follows the plan, the registration is read back once
 * a day, its owner is reminded before it runs out, and the operator hears of
 * a name that ran out or may leave. It registers nothing. Never throws.
 */
export function sweepRenewals(env, { now = Date.now() } = {}) {
  return sweepRenewed(env, { ...registerTools(), now });
}

/**
 * A name Kiln registered for a site on the yearly hosting plan, in the
 * five-minute job after the domains (register.js): one that is still being
 * asked for is looked at, and one that is registered is put on its site. It
 * registers nothing. Never throws.
 */
export function sweepRegistrations(env, { now = Date.now() } = {}) {
  return sweepRegistered(env, { ...registerTools(), now });
}
