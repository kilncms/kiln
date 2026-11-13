/**
 * One forwarded email address on a hosted site's own domain.
 *
 * A site that is live at its owner's domain (worker/domain.js) can have one
 * address there, such as hello@theirdomain.com, whose mail is passed on to an
 * inbox the owner already reads somewhere else. It only receives. Cloudflare
 * does the forwarding ("Email Routing"), and this module does Kiln's side:
 *
 *   1. see whether the domain may have it at all (hasOwnMail, sendsOwnMail,
 *      saysNoMail, mailStop): a domain with email of its own is never touched;
 *   2. switch forwarding on for the domain, which makes Cloudflare write the
 *      mail records itself (mailState, switchMailOn);
 *   3. have the inbox confirmed: Cloudflare emails it, and its owner presses
 *      the button in that email (inboxState, addInbox, askAgain);
 *   4. make the one rule, change it, or take it away (forward, stopForwarding).
 *
 * Kiln never says forwarding works before Cloudflare says the inbox is
 * confirmed: until then Cloudflare refuses the rule, and so does this module.
 *
 * What was tried against the real service (2026-11-13) is the state of a zone
 * before and after, the call that switches forwarding on and the records it
 * writes, the list of inboxes, and the refusal of a rule for an inbox that
 * has not confirmed (code 2054). What was not tried is marked where it is
 * used.
 *
 * Nothing here knows about accounts, plans or the dashboard, and nothing here
 * sends email: cloud.js decides who may ask, and tells people what happened.
 * The environment is the one worker/domain.js reads: HOSTING_ACCOUNT_ID and
 * HOSTING_API_TOKEN, a token that must hold "Email Routing Addresses Write"
 * for the account and "Email Routing Rules Write" for its zones.
 */
import { domainsOn, txtWords } from './domain.js';

const CF = 'https://api.cloudflare.com/client/v4';
const NOT_CONFIRMED = 2054;                       // Cloudflare's "Destination address is not verified"
const ZONE_GONE = 1001;                           // its "Invalid zone identifier", answered for a zone it no longer has
const NO_MAIL_SPF = 'v=spf1 -all';                // "nothing sends mail for this domain"
const ROUTING_SPF = '_spf.mx.cloudflare.net';     // what Cloudflare's own SPF note for forwarding names
const RULE_NAME = 'Kiln forwards ';               // how a rule Kiln made starts, so it is told from one made by hand
const PER_PAGE = 50;                              // the most inboxes or rules Cloudflare lists at once

export const MAIL_LIMITS = {
  againMs: 10 * 60 * 1000,   // "Send it again" at most this often
  remindDays: 7,             // an inbox that has not confirmed by then: the owner is reminded, once
  giveUpDays: 30,            // and by then Kiln stops asking about it
  addressPages: 20,          // pages of 50 inboxes read from the account's list
  recordPages: 20,           // pages of 100 records read from a zone, as worker/domain.js reads them
  local: 64,                 // the longest part before the @
  inbox: 254,                // the longest whole address
};

export class MailError extends Error {
  constructor(code, detail = '', codes = []) { super(code); this.code = code; this.detail = String(detail).slice(0, 300); this.codes = codes; }
}

const need = (env) => { if (!domainsOn(env)) throw new MailError('not_set_up'); };
const account = (env) => `/accounts/${env.HOSTING_ACCOUNT_ID}`;
const bare = (host) => String(host ?? '').trim().toLowerCase().replace(/\.$/, '');
const upper = (type) => String(type || '').toUpperCase();
const idOf = (thing) => thing?.id || thing?.tag || null;   // Cloudflare names the same id both ways

// ─── Does the domain have email of its own? ───────────────────────────────────
//
// These read a list of records in either shape: the kept records a domain's
// row holds ({ type, name, content, kind }, a mail server with its number in
// front, "10 mail.example.com"), or a zone's records as Cloudflare lists them.
// `name` is the domain. Left out, a record at any name counts, which errs on
// the side of leaving a domain alone.

const at = (records, name) => (Array.isArray(records) ? records : []).filter(r => r && (!name || bare(r.name) === bare(name)));
const isMx = (r) => upper(r.type) === 'MX';
// The server an MX record names. "." is the "no mail here" one.
const mxServer = (r) => bare(String(r.content ?? '').trim().split(/\s+/).pop()) || '.';
// A record's SPF note in lowercase with single spaces, or null when it is not one.
const spfOf = (r) => {
  if (upper(r.type) !== 'TXT') return null;
  const words = txtWords(r.content).trim().toLowerCase().replace(/\s+/g, ' ');
  return /^v=spf1( |$)/.test(words) ? words : null;
};
const saysNothingReceives = (r) => isMx(r) && mxServer(r) === '.';
const saysNothingSends = (r) => spfOf(r) === NO_MAIL_SPF;

/** True when the records hold a mail server at the domain's bare name other than the "no mail here" one (`0 .`). */
export function hasOwnMail(records, name = '') {
  return at(records, name).some(r => isMx(r) && mxServer(r) !== '.');
}

/**
 * True when the records hold an SPF note at the bare name that lets some
 * server send for the domain: anything but "v=spf1 -all" and Cloudflare's own
 * note for forwarding. Such a domain sends email with no mail server of its
 * own. Switching forwarding on makes Cloudflare write an SPF note, and what
 * it does to one that is there already was not tried, so a domain like this
 * is left alone as one with email of its own is.
 */
export function sendsOwnMail(records, name = '') {
  return at(records, name).some(r => { const spf = spfOf(r); return !!spf && spf !== NO_MAIL_SPF && !spf.includes(ROUTING_SPF); });
}

/**
 * True for a domain that only says "no mail here": a mail server of `0 .`
 * and/or the note "v=spf1 -all" at the bare name, and no email of its own. A
 * parked domain says this. It may have forwarding, and those two records are
 * then replaced (switchMailOn), so a page says so first.
 */
export function saysNoMail(records, name = '') {
  if (hasOwnMail(records, name) || sendsOwnMail(records, name)) return false;
  return at(records, name).some(r => saysNothingReceives(r) || saysNothingSends(r));
}

/**
 * Why forwarding is not offered for a site's domain, as one of this module's
 * codes, or null when it may be. `domain` is the domain's row, or what
 * publicDomain makes of it with its records: forwarding is only for a domain
 * that is live, and never for one with email of its own. Whether the site may
 * be edited is for whoever calls this to know.
 */
export function mailStop(domain) {
  if (!domain || domain.state !== 'live') return 'not_live';
  let records = domain.records;
  if (typeof records === 'string') { try { records = JSON.parse(records); } catch { records = []; } }
  return hasOwnMail(records, domain.name) || sendsOwnMail(records, domain.name) ? 'has_own_mail' : null;
}

// ─── Cloudflare, with the token for the hosting account ───────────────────────

async function cloudflare(env, method, path, json) {
  const headers = { Authorization: `Bearer ${env.HOSTING_API_TOKEN}` };
  let body;
  if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  let res;
  try { res = await fetch(`${CF}${path}`, { method, headers, body }); }
  catch (e) { throw new MailError('cloudflare', `${method} ${path}: ${e?.message || e}`); }
  let data = null;
  try { data = await res.json(); } catch { /* an answer that is not JSON is a failure below */ }
  if (!res.ok || !data || data.success === false) {
    const errors = data?.errors || [];
    const why = errors.map(e => `${e.code || ''} ${e.message || ''}`.trim()).join('; ') || `status ${res.status}`;
    throw new MailError(res.status === 404 ? 'cloudflare_missing' : 'cloudflare', `${method} ${path}: ${why}`, errors.map(e => Number(e.code)).filter(Boolean));
  }
  return { result: data.result, info: data.result_info || null };
}

// Something that is not there any more. How Cloudflare answers for a rule or
// an inbox that is gone was not tried: a plain "not found" is read, and so are
// the words of the refusal.
const isGone = (e) => e instanceof MailError && (e.code === 'cloudflare_missing' || e.codes.includes(ZONE_GONE) || /not found|does not exist/i.test(e.detail));

async function zoneRecords(env, zoneId) {
  const all = [];
  for (let page = 1; ; page++) {
    // Stopping short could miss a mail server, so too many is a failure, not a shorter list.
    if (page > MAIL_LIMITS.recordPages) throw new MailError('cloudflare', `more than ${MAIL_LIMITS.recordPages * 100} records`);
    const got = await cloudflare(env, 'GET', `/zones/${zoneId}/dns_records?per_page=100&page=${page}`);
    all.push(...(got.result || []));
    if (page >= Number(got.info?.total_pages || 1)) return all;
  }
}

// ─── Forwarding for the whole domain ──────────────────────────────────────────

/** Whether forwarding is switched on for a domain: { on, status }. `status` is Cloudflare's word, "ready" once its records are in place. */
export async function mailState(env, { zoneId }) {
  need(env);
  const got = (await cloudflare(env, 'GET', `/zones/${zoneId}/email/routing`)).result || {};
  return { on: got.enabled === true, status: got.status || null };
}

/**
 * Switch forwarding on for a domain. Cloudflare writes the records itself:
 * three mail servers and an SPF note at the bare name, and a signing key
 * beside them. Answers { on: true }, and does nothing but answer when it is
 * on and ready already.
 *
 * A "no mail here" mail server (`0 .`) and the note "v=spf1 -all" at the bare
 * name are deleted first, because they say the opposite. They are put back if
 * the switch then fails. A domain whose zone holds a mail server of its own,
 * or an SPF note that lets something send, is refused with
 * MailError('has_own_mail') before anything is changed: the zone is looked at
 * here as well as the kept records, so a record added since is seen.
 */
export async function switchMailOn(env, { zoneId, name = '' }) {
  need(env);
  const state = await mailState(env, { zoneId });
  if (state.on && state.status === 'ready') return { on: true };
  const domain = bare(name) || bare((await cloudflare(env, 'GET', `/zones/${zoneId}`)).result?.name);
  if (!domain) throw new MailError('cloudflare', 'the zone has no name');
  // Records Cloudflare wrote for forwarding earlier are its own, not the owner's.
  const records = (await zoneRecords(env, zoneId)).filter(r => !r.meta?.email_routing);
  if (hasOwnMail(records, domain) || sendsOwnMail(records, domain)) throw new MailError('has_own_mail');
  const opposite = at(records, domain).filter(r => saysNothingReceives(r) || saysNothingSends(r));
  const deleted = [];
  try {
    for (const r of opposite) { await cloudflare(env, 'DELETE', `/zones/${zoneId}/dns_records/${r.id}`); deleted.push(r); }
    const got = (await cloudflare(env, 'POST', `/zones/${zoneId}/email/routing/dns`, {})).result;
    if (got && got.enabled === false) throw new MailError('cloudflare', 'forwarding did not switch on');
  } catch (e) {
    // Nothing is left half done: the domain says "no mail here" again, as it did.
    for (const r of deleted) {
      try { await cloudflare(env, 'POST', `/zones/${zoneId}/dns_records`, { type: r.type, name: r.name, content: r.content, ttl: r.ttl || 1, ...(r.priority !== undefined ? { priority: r.priority } : {}) }); }
      catch (again) { console.warn(`[domain-mail] a "no mail here" record of ${domain} could not be put back: ${again?.detail || again?.message || again}`); }
    }
    throw e;
  }
  return { on: true };
}

// ─── The inbox mail is forwarded to ───────────────────────────────────────────
//
// The hosting account keeps one list of inboxes it may forward to, for all of
// its domains. An inbox is on it once for however many sites forward to it,
// and once its owner has confirmed it, it is confirmed for all of them. So an
// inbox that is confirmed is never removed here.

const seen = (a) => ({ id: idOf(a), verified: !!a.verified });
const sameInbox = (a, email) => String(a?.email || '').trim().toLowerCase() === email;

/**
 * Whether an inbox is on the account's list and whether its owner has
 * confirmed it: { id, verified }, or null when it is not on the list. With
 * the `id` a row kept, that one inbox is asked for and the list is not read
 * (asking for one by id was not tried against the real service; an id that is
 * gone falls back to the list).
 */
export async function inboxState(env, { email, id = null }) {
  need(env);
  const want = String(email ?? '').trim().toLowerCase();
  if (id) {
    try {
      const one = (await cloudflare(env, 'GET', `${account(env)}/email/routing/addresses/${encodeURIComponent(id)}`)).result;
      if (one && (!want || sameInbox(one, want))) return seen(one);
    } catch (e) { if (!isGone(e)) throw e; }
  }
  if (!want) return null;
  for (let page = 1; page <= MAIL_LIMITS.addressPages; page++) {
    const list = (await cloudflare(env, 'GET', `${account(env)}/email/routing/addresses?per_page=${PER_PAGE}&page=${page}`)).result || [];
    const hit = list.find(a => sameInbox(a, want));
    if (hit) return seen(hit);
    if (list.length < PER_PAGE) break;
  }
  return null;
}

/**
 * Put an inbox on the account's list, which makes Cloudflare send it the
 * email with the button. Answers { id, verified, sent }. An inbox that is on
 * the list already is answered as it stands with `sent: false`: no second
 * email goes out (askAgain is for that).
 */
export async function addInbox(env, { email }) {
  need(env);
  const inbox = cleanInbox(email);
  const there = await inboxState(env, { email: inbox });
  if (there) return { ...there, sent: false };
  try {
    return { ...seen((await cloudflare(env, 'POST', `${account(env)}/email/routing/addresses`, { email: inbox })).result || {}), sent: true };
  } catch (e) {
    // Two people asking for one inbox at the same moment: the other was first.
    // (How Cloudflare refuses an inbox it has already was not tried; the words are read.)
    if (e instanceof MailError && /already|exists|duplicate/i.test(e.detail)) {
      const now = await inboxState(env, { email: inbox });
      if (now) return { ...now, sent: false };
    }
    throw e;
  }
}

/**
 * Have Cloudflare send its email again, by removing the inbox from the list
 * and adding it again. Only for an inbox that has not confirmed: one that has
 * is left exactly as it is, since other sites may forward to it. Answers
 * { id, verified, sent }; the id is a new one when the email was sent. Whoever
 * calls this keeps it to once every ten minutes (canAskAgain).
 */
export async function askAgain(env, { email }) {
  need(env);
  const inbox = cleanInbox(email);
  const there = await inboxState(env, { email: inbox });
  if (there?.verified) return { ...there, sent: false };
  if (there) {
    try { await cloudflare(env, 'DELETE', `${account(env)}/email/routing/addresses/${encodeURIComponent(there.id)}`); }
    catch (e) { if (!isGone(e)) throw e; }
  }
  return { ...seen((await cloudflare(env, 'POST', `${account(env)}/email/routing/addresses`, { email: inbox })).result || {}), sent: true };
}

/** True when a row's inbox may be sent the email again: ten minutes after the last one. */
export function canAskAgain(row, now = Date.now()) {
  return !row?.asked_at || now - Number(row.asked_at) >= MAIL_LIMITS.againMs;
}

// ─── The one rule ─────────────────────────────────────────────────────────────

// The rule Kiln made in a zone earlier, if it is still there. The zone's
// built-in catch-all rule (off, it drops mail) and any rule made by hand have
// other names and are left alone.
async function ruleKilnMade(env, zoneId) {
  const list = (await cloudflare(env, 'GET', `/zones/${zoneId}/email/routing/rules?per_page=${PER_PAGE}`)).result || [];
  return idOf(list.find(r => String(r?.name || '').startsWith(RULE_NAME)));
}

/**
 * Make the one rule that forwards `address` to `inbox`, or replace the one
 * that is there. Answers { ruleId }. With `ruleId` that rule is replaced, so
 * the address it forwarded before stops at once. Without it, a rule Kiln made
 * in the zone earlier is looked for and replaced, so a zone never ends up with
 * two addresses. A rule that was removed by hand is made again.
 *
 * Cloudflare refuses a rule whose inbox has not confirmed (code 2054): that
 * is MailError('not_confirmed'), and nothing was made.
 */
export async function forward(env, { zoneId, address, inbox, ruleId = null }) {
  need(env);
  const to = String(address ?? '').trim().toLowerCase();
  const [local, domain, ...more] = to.split('@');
  if (!local || !domain || more.length || /\s/.test(to)) throw new MailError('not_an_address');
  const reach = cleanInbox(inbox, domain);
  const rule = {
    name: `${RULE_NAME}${to}`,
    enabled: true,
    matchers: [{ type: 'literal', field: 'to', value: to }],
    actions: [{ type: 'forward', value: [reach] }],
  };
  try {
    const old = ruleId || await ruleKilnMade(env, zoneId);
    if (old) {
      // (Replacing a rule was not tried against the real service.)
      try { return { ruleId: idOf((await cloudflare(env, 'PUT', `/zones/${zoneId}/email/routing/rules/${encodeURIComponent(old)}`, rule)).result) || old }; }
      catch (e) { if (e.codes?.includes(ZONE_GONE) || !isGone(e)) throw e; }
    }
    const made = idOf((await cloudflare(env, 'POST', `/zones/${zoneId}/email/routing/rules`, rule)).result);
    if (!made) throw new MailError('cloudflare', 'the rule came back with no id');
    return { ruleId: made };
  } catch (e) {
    if (e instanceof MailError && (e.codes.includes(NOT_CONFIRMED) || /not verified/i.test(e.detail))) throw new MailError('not_confirmed', e.detail, e.codes);
    throw e;
  }
}

/**
 * Stop forwarding: the rule is deleted, and mail to the address is no longer
 * passed on. The domain's mail records are left, and forwarding stays
 * switched on for the domain, so nothing else about its mail changes by
 * surprise. A rule that is gone already is fine. Without `ruleId`, a rule
 * Kiln made in the zone earlier is looked for. Answers { stopped: true }.
 */
export async function stopForwarding(env, { zoneId, ruleId = null }) {
  need(env);
  try {
    const old = ruleId || await ruleKilnMade(env, zoneId);
    if (old) await cloudflare(env, 'DELETE', `/zones/${zoneId}/email/routing/rules/${encodeURIComponent(old)}`);
  } catch (e) { if (!isGone(e)) throw e; }
  return { stopped: true };
}

// ─── What a person types ──────────────────────────────────────────────────────

/**
 * The part before the @ that a person chose, such as "hello": lowercase
 * letters, digits, dots, dashes and underscores, 1 to 64 long, no dot at
 * either end and no two dots together. Capitals are made small. A whole
 * address is cut down to its first part when it is at the site's own domain
 * (`name`). Anything else throws MailError('not_an_address').
 */
export function cleanLocal(input, name = '') {
  let s = String(input ?? '').trim().toLowerCase();
  const cut = s.lastIndexOf('@');
  if (cut !== -1) {
    if (!name || bare(s.slice(cut + 1)) !== bare(name)) throw new MailError('not_an_address');
    s = s.slice(0, cut);
  }
  if (s.length > MAIL_LIMITS.local || !/^[a-z0-9._-]+$/.test(s) || s.startsWith('.') || s.endsWith('.') || s.includes('..')) throw new MailError('not_an_address');
  return s;
}

/**
 * The inbox mail is forwarded to: a plain email address, in lowercase, or
 * MailError('not_an_address'). Never one at the site's own domain (`name`):
 * forwarding hello@domain to something@domain would go round in a circle, and
 * that is MailError('same_domain').
 */
export function cleanInbox(input, name = '') {
  const s = String(input ?? '').trim().toLowerCase();
  const m = /^([a-z0-9.!#$%&'*+/=?^_`{|}~-]+)@([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)$/.exec(s);
  if (!m || s.length > MAIL_LIMITS.inbox || m[1].length > MAIL_LIMITS.local || m[1].startsWith('.') || m[1].endsWith('.') || m[1].includes('..')) throw new MailError('not_an_address');
  if (name && m[2] === bare(name)) throw new MailError('same_domain');
  return s;
}

// ─── What a person reads ──────────────────────────────────────────────────────

/** The sentence for one of this module's codes: what stands, and what to do next. A code it does not know gets the one for a call that failed. */
export function mailSentence(code, { address = null, inbox = null, name = null } = {}) {
  const domain = name || (address && String(address).split('@')[1]) || null;
  const theDomain = domain || 'this domain';
  const startDomain = domain || 'This domain';
  const theAddress = address || `the address at ${theDomain}`;
  const theInbox = inbox ? `The inbox ${inbox}` : 'The inbox you gave';
  switch (code) {
    case 'not_confirmed': return `${theInbox} has not confirmed yet. Cloudflare sent an email there: open it and press the button in it, and Kiln will switch ${theAddress} on by itself. If the email is not there, look in the spam folder, or press "Send it again".`;
    case 'too_soon': return `Cloudflare sent the email${inbox ? ` to ${inbox}` : ''} a few minutes ago. Look for it there, and in the spam folder. If it has not come ten minutes after the last one, press "Send it again" once more.`;
    case 'not_an_address': return `Kiln could not use what was typed. For the address at ${theDomain}, type the part before the @ with letters, numbers, dots, dashes or underscores, such as hello. For the inbox, type a whole email address, such as you@example.com.`;
    case 'same_domain': return `Mail for ${theDomain} cannot be forwarded to an inbox at ${theDomain}, because it would go round in a circle. Give an inbox you already read somewhere else, such as a Gmail or Outlook address.`;
    case 'has_own_mail': return `${startDomain} has email of its own, which keeps working as it is. Kiln changes nothing there. To forward an address, set that up with the company that runs that email.`;
    case 'not_live': return `${startDomain} is not live on Kiln yet. Finish setting up the domain first, then come back here to forward an address.`;
    case 'not_set_up': return 'Forwarding an address is not switched on for this service yet. Write to Kiln and it will be set up for you by hand.';
    case 'says_no_mail': return `${startDomain} says today that it takes no email. When you forward an address, Kiln replaces the two records that say so, and the domain takes email for that one address.`;
    case 'no_domain': return 'This site does not have a domain of its own on Kiln yet. Set up the domain on the site\'s row first, then come back here to forward an address.';
    case 'plan_ended': return 'Editing is switched off for this site, so Kiln cannot set up a forwarded address for it. Subscribe on the site\'s row, then try again.';
    case 'busy': return 'Kiln is already working on the forwarded address for this site. Wait a minute, then look at the site\'s row again.';
    case 'no_forward': return 'No address is forwarded for this site yet. To set one up, press "Forward an address" on the site\'s row.';
    case 'bad_action': return 'Kiln did not understand that request. Reload the dashboard and try again.';
    case 'never_confirmed': return `${theInbox} did not confirm within ${MAIL_LIMITS.giveUpDays} days, so Kiln stopped waiting. Nothing of yours was changed. To try again, press "Forward an address" on the site's row.`;
    default: return `Kiln could not finish this with Cloudflare just now. Your site and any email you already have are as they were. Try again in a few minutes.`;
  }
}

// ─── What the service remembers (the `forwards` table, migration 0007) ────────

/** The forwarded address of a site, or null. Never fails the page that asks. */
export async function forwardRow(env, siteId) {
  try { return await env.kiln_cloud.prepare('SELECT * FROM forwards WHERE site_id = ?').bind(siteId).first(); }
  catch { return null; }   // a database migration 0007 has not reached: no site has one
}

/** Every forwarded address of one account's sites, by site id. Never fails the page that asks. */
export async function forwardsForAccount(env, accountId) {
  try {
    const rows = await env.kiln_cloud.prepare('SELECT f.* FROM forwards f JOIN sites s ON s.id = f.site_id WHERE s.account_id = ?').bind(accountId).all();
    return Object.fromEntries((rows?.results || []).map(r => [r.site_id, r]));
  } catch { return {}; }
}

/**
 * The rows whose inbox has not confirmed yet, the one written longest ago
 * first, for the five-minute look. A look that writes each row it reads, even
 * with nothing to change (saveForward(env, id, {})), reaches every row in
 * turn however many there are. Never throws.
 */
export async function forwardsConfirming(env, limit = 10) {
  try { return (await env.kiln_cloud.prepare("SELECT * FROM forwards WHERE state = 'confirming' ORDER BY updated_at ASC LIMIT ?").bind(limit).all())?.results || []; }
  catch { return []; }
}

/** True when the database has the `forwards` table, which is to say migration 0007 has reached it. */
export async function forwardsReady(env) {
  try { await env.kiln_cloud.prepare('SELECT site_id FROM forwards LIMIT 1').first(); return true; }
  catch { return false; }
}

const COLUMNS = ['address', 'inbox', 'inbox_id', 'rule_id', 'state', 'reason', 'asked_at', 'on_at', 'created_at'];

/**
 * Write a site's row: made when the site has none (it needs an address and an
 * inbox, and starts as 'confirming'), changed otherwise. A row whose state
 * changes loses its reason unless the same write gives one; one that becomes
 * 'on' gets its `on_at`, and one that goes back to 'confirming' loses it.
 * Returns true when it was written and false when the table is not there yet.
 */
export async function saveForward(env, siteId, fields = {}) {
  const now = Date.now();
  let f = {};
  for (const c of COLUMNS) if (fields[c] !== undefined) f[c] = fields[c];
  for (const c of ['address', 'inbox']) if (typeof f[c] === 'string') f[c] = f[c].trim().toLowerCase();
  try {
    const db = env.kiln_cloud;
    const was = await db.prepare('SELECT state FROM forwards WHERE site_id = ?').bind(siteId).first();
    if (!was) {
      if (!f.address || !f.inbox) throw new MailError('not_an_address');
      f = { state: 'confirming', created_at: now, ...f, updated_at: now };
      if (f.state === 'on' && !f.on_at) f.on_at = now;
      const cols = Object.keys(f);
      await db.prepare(`INSERT INTO forwards (site_id, ${cols.join(', ')}) VALUES (?${', ?'.repeat(cols.length)})`).bind(siteId, ...cols.map(c => f[c])).run();
    } else {
      // A row that moves on leaves the last state's reason behind, unless this write gives one.
      if (f.state && f.state !== was.state) f = { reason: null, ...(f.state === 'on' ? { on_at: now } : f.state === 'confirming' ? { on_at: null } : {}), ...f };
      const cols = Object.keys(f);
      await db.prepare(`UPDATE forwards SET ${cols.map(c => `${c} = ?`).join(', ')}${cols.length ? ', ' : ''}updated_at = ? WHERE site_id = ?`).bind(...cols.map(c => f[c]), now, siteId).run();
    }
    return true;
  } catch (e) {
    if (/no such table/i.test(String(e?.message || e))) return false;
    throw e;
  }
}

/** Forget a site's forwarded address. Nothing at Cloudflare is touched: whoever calls this has dealt with the rule first, or means to leave it. Never throws. */
export async function forgetForward(env, siteId) {
  try { await env.kiln_cloud.prepare('DELETE FROM forwards WHERE site_id = ?').bind(siteId).run(); return true; }
  catch { return false; }
}

/**
 * What the dashboard is told about a site's forwarded address: { address,
 * inbox, state, since, on_at } and `error`, the sentence for a row that
 * stopped short. `on_at` is only given while it is on. Never an id: the
 * inbox's and the rule's are handles nobody outside needs.
 */
export function publicForward(row) {
  if (!row) return null;
  const out = {
    address: row.address,
    inbox: row.inbox,
    state: row.state,
    since: row.created_at || null,
    on_at: row.state === 'on' ? (row.on_at || null) : null,
  };
  if (row.state !== 'on' && row.reason) out.error = mailSentence(row.reason, { address: row.address, inbox: row.inbox });
  return out;
}
