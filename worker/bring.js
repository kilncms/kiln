/**
 * Bring my site in: a person types the address of the site they have
 * somewhere else, and Kiln copies it into plain files that it keeps for them.
 *
 * The copying is not done here. A job on a GitHub Actions runner does it with
 * Kiln's own tool (`kiln rescue`), and this service starts that job and is
 * told how it went. So the service itself never reads the address a person
 * typed: only the runner does, from outside Kiln's own network.
 *
 * The site is started the way any site Kiln keeps the files of is started
 * (keeps.js), except that its repository is left empty for the job to fill.
 * Three more settings say where the job lives:
 *
 *   CONVERT_SECRET    a long random text shared with the runner, which signs
 *                     its answer with it
 *   CONVERT_REPO      the repository that holds the job
 *                     (<KEEP_ORG>/kiln-converter unless set)
 *   CONVERT_WORKFLOW  the job's file there (convert.yml unless set)
 *
 * The job is started with the second app's token (keeps.js), which is why that
 * app may start jobs. Each try is one row of `conversions` (migration 0009),
 * and the row's id is the job's id.
 *
 * Nothing in this file ever deletes, renames or transfers a repository.
 */
import { gh, kilnConfigFile } from './prepare.js';
import { keepsReady, keepOrg, keepToken, forgetKeepToken, cleanName, startKept } from './keeps.js';
import { sendOnce, trialEndsAt, siteCopiedMail, copyFailedMail } from './mail.js';

const CONFIG_FILE = 'assets/kiln-config.js';
export const SETTINGS_MESSAGE = "This site's Kiln settings";
export const MOST_PAGES = 200;          // addresses the job tries for one copy
export const MOST_TRIES = 3;            // copies of one site, the first one counted
export const COPY_MINUTES = 30;         // a job that has said nothing for this long is given up on
export const BROUGHT_DAYS = 30;         // how long one free copy of a site stands in the way of the next
export const MOST_ANSWER = 300000;      // bytes of the job's answer
export const MOST_REPORT = 20000;       // characters of the report that are kept
export const HOST_SECONDS = 20;        // how long the owner's mail waits for the site to go up, where the work goes on after the answer
const SWEEP_AT_ONCE = 10;
const LOCK_S = 60;

// ─── Settings ─────────────────────────────────────────────────────────────────

export const convertSecret = (env) => String((env && env.CONVERT_SECRET) || '').trim();

export function convertRepo(env) {
  const set = String((env && env.CONVERT_REPO) || '').trim();
  return /^[\w.-]+\/[\w.-]+$/.test(set) ? set : `${keepOrg(env)}/kiln-converter`;
}

export function convertWorkflow(env) {
  const set = String((env && env.CONVERT_WORKFLOW) || '').trim();
  return /^[\w.-]+\.ya?ml$/.test(set) ? set : 'convert.yml';
}

/** A site can be brought in here: a site can be started (keeps.js), and the job's answer can be checked. */
export function bringOn(env) { return keepsReady(env) && !!convertSecret(env); }

// ─── What a person reads ──────────────────────────────────────────────────────

const SENTENCES = {
  not_set_up: 'Bringing a site in is not switched on for this service yet. Write to info@kilncms.com and we will tell you when it is.',
  not_mine: "Tick the box that says this is your site, or that you have its owner's permission to copy it.",
  no_address: 'Type the address of the site to copy, such as www.example.com.',
  bad_address: 'That does not look like the address of a site. Type the address the site opens at, such as www.example.com.',
  not_web: 'Kiln copies a site from a web address, which starts with http or https. Type the address the site opens at, such as www.example.com.',
  has_login: 'Take the name and password out of the address, then type it again, such as www.example.com.',
  not_public: 'Kiln can only copy a site that anyone can open on the web under its name. Type the address the site opens at, such as www.example.com.',
  bad_port: 'Take the port number out of the address, then type it again, such as www.example.com.',
  kiln_own: "That address is one of Kiln's own, so there is nothing to bring in. Type the address of the site you have somewhere else.",
  bad_name: 'Give your site a name of 2 to 60 characters, such as Oak Bakery, or leave the name empty, then try again.',
  not_now: 'Kiln cannot copy that site during the free days just now. Write to info@kilncms.com and we will help you bring it in.',
  no_job: "Kiln could not start copying the site just now. Wait a few minutes, then press Try again on the site's row.",
  no_such_site: 'That site is not on this account. Reload this page to see your sites.',
  no_copy: 'This site was not brought in from another address, so there is no copy to try again. Reload this page.',
  copied: 'This site is already copied. Press Open the editor on its row to change it.',
  still_copying: 'Kiln is still copying this site. Give it a few minutes, then reload this page.',
  no_more_tries: `Kiln has tried to copy this site ${MOST_TRIES} times. Write to info@kilncms.com and we will look at it with you.`,
  busy: 'Kiln is already starting the copy. Give it a minute, then reload this page.',
};
const STATUS = { not_set_up: 409, not_mine: 400, no_address: 400, bad_address: 400, not_web: 400, has_login: 400, not_public: 400, bad_port: 400, kiln_own: 400, bad_name: 400,
  not_now: 429, no_job: 502, no_such_site: 404, no_copy: 404, copied: 409, still_copying: 409, no_more_tries: 409, busy: 409 };

export const bringSentence = (code) => SENTENCES[code] || SENTENCES.no_job;
const refusal = (code) => ({ ok: false, code, status: STATUS[code] || 502, error: bringSentence(code) });

// Why a copy did not work, and what to try. The first is the reason in one
// sentence; the second is what to do while a try is left.
const COPY_FAILED = {
  unreachable: ['The site at that address did not answer, or it refused to be read.', 'Check that the address is right and that the site opens in a browser, then press Try again.'],
  blank: ['The pages came out blank, even when Kiln opened them in a browser.', 'If the site asks for a password or shows a coming soon page, switch that off, then press Try again.'],
  nothing: ['Kiln found no pages to copy at that address.', "Check that the address is the site's home page, then press Try again."],
  tool: ['The copy stopped before it was finished.', 'Press Try again, and write to info@kilncms.com if it stops a second time.'],
  no_answer: [`The copy did not finish in ${COPY_MINUTES} minutes.`, 'Press Try again, and write to info@kilncms.com if it happens a second time.'],
  no_job: ['Kiln could not start copying the site just now.', 'Wait a few minutes, then press Try again.'],
  removed: ['The site was removed before the copy was finished.', 'Start again from Bring my site in.'],
};
const NO_TRY_LEFT = `Kiln has tried ${MOST_TRIES} times. Write to info@kilncms.com and we will look at it with you.`;

/** { why, next }: why a copy failed, and what its owner does now. `again`: a try is left. */
export function copyTrouble(reason, { again = true } = {}) {
  const [why, next] = COPY_FAILED[reason] || COPY_FAILED.tool;
  return { why, next: again || reason === 'removed' ? next : NO_TRY_LEFT };
}
export const copySentence = (reason, opts) => { const t = copyTrouble(reason, opts); return `${t.why} ${t.next}`; };

// ─── The address ──────────────────────────────────────────────────────────────

const NOT_PUBLIC_ENDS = ['.local', '.internal', '.test', '.example', '.invalid', '.localhost'];
const NOT_WEB = /^(mailto|tel|sms|javascript|data|file|blob|about|ftp|sftp|ssh|ws|wss|view-source):/i;
// A name of letters, digits and dashes with a dot in it. The address is handed
// to a job that runs commands, so nothing else is let through, in the name or
// in what follows it.
const HOST = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const PATH = /^[\w\-.~/%+@,=]*$/;

/**
 * The address a person typed, as a web address a copy can be made from.
 * Answers { ok: true, address, host, source } or { ok: false, code, error }.
 * `source` is the host without "www.", which is what one copy of a site is
 * counted by. `own`: hosts of Kiln's own (the service, the dashboard);
 * `hostingSubdomain`: Kiln's hosting gives addresses that end in
 * `.<hostingSubdomain>.workers.dev`. A pure function: it reads nothing.
 */
export function cleanAddress(text, { own = [], hostingSubdomain = '' } = {}) {
  const no = (code) => ({ ok: false, code, error: SENTENCES[code] });
  if (typeof text !== 'string' || !text.trim()) return no('no_address');
  let t = text.trim();
  if (t.length > 2000 || /[\s\u0000-\u001f\u007f\\]/.test(t)) return no('bad_address');
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(t);
  if (scheme) { if (!/^https?$/i.test(scheme[1])) return no('not_web'); }
  else if (NOT_WEB.test(t)) return no('not_web');
  else t = `https://${t.replace(/^\/+/, '')}`;
  let u;
  try { u = new URL(t); } catch { return no('bad_address'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return no('not_web');
  if (u.username || u.password) return no('has_login');
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return no('bad_address');
  const ours = own.map(h => String(h || '').toLowerCase()).filter(Boolean);
  const hosting = String(hostingSubdomain || '').trim().toLowerCase();
  if (ours.includes(host) || host === 'kilncms.com' || host.endsWith('.kilncms.com') || (hosting && host.endsWith(`.${hosting}.workers.dev`))) return no('kiln_own');
  if (host.startsWith('[') || /^\d+(\.\d+){3}$/.test(host) || host === 'localhost' || !host.includes('.')) return no('not_public');
  if (NOT_PUBLIC_ENDS.some(end => host.endsWith(end))) return no('not_public');
  if (!HOST.test(host)) return no('bad_address');
  if (u.port && u.port !== '80' && u.port !== '443') return no('bad_port');
  if (!PATH.test(u.pathname)) return no('bad_address');
  // A port that was typed says which of the two it is; a query and a fragment are dropped.
  const protocol = u.port === '443' ? 'https:' : u.port === '80' ? 'http:' : u.protocol;
  const address = `${protocol}//${host}${u.pathname === '/' ? '' : u.pathname}`;
  if (address.length > 300) return no('bad_address');
  return { ok: true, address, host, source: host.replace(/^www\./, '') };
}

const hostOf = (address) => { try { return new URL(address).hostname.toLowerCase(); } catch { return ''; } };

/** What cleanAddress is told about this service: its own host, the dashboard's, and the hosting's addresses. */
export function ownAddresses(env, addresses = []) {
  return { own: addresses.map(hostOf).filter(Boolean), hostingSubdomain: String((env && env.HOSTING_SUBDOMAIN) || '') };
}

// ─── The job's answer is signed ───────────────────────────────────────────────

const bytesOf = (text) => new TextEncoder().encode(text);
const hmacKey = (secret) => crypto.subtle.importKey('raw', bytesOf(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

/** The header the job sends with its answer: "sha256=" and the hex HMAC-SHA256 of the body, bytes or text, with the shared secret. */
export async function signAnswer(secret, body) {
  const mac = await crypto.subtle.sign('HMAC', await hmacKey(secret), typeof body === 'string' ? bytesOf(body) : body);
  return `sha256=${[...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('')}`;
}

/** Is `header` that signature of `body`? The comparing is WebCrypto's own, which takes the same time for a right and a wrong one. */
export async function signedRight(secret, body, header) {
  const m = /^sha256=([0-9a-f]{64})$/i.exec(String(header || '').trim());
  if (!secret || !m) return false;
  const given = new Uint8Array(m[1].match(/../g).map(h => parseInt(h, 16)));
  try { return await crypto.subtle.verify('HMAC', await hmacKey(secret), given, typeof body === 'string' ? bytesOf(body) : body); }
  catch { return false; }
}

// ─── Copies in the database ───────────────────────────────────────────────────

const newJob = () => crypto.randomUUID().replace(/-/g, '');
const changed = (r) => Number(r && r.meta && r.meta.changes) > 0;
const broughtKey = (source) => `brought:${source}`;
const base64 = (text) => btoa(String.fromCharCode(...bytesOf(text)));
const stale = (row, now) => row.state === 'copying' && now - Number(row.asked_at || 0) > COPY_MINUTES * 60000;

/** The newest try for a site, or null: also for a database migration 0009 has not reached. */
async function lastCopy(env, siteId) {
  try { return await env.kiln_cloud.prepare('SELECT * FROM conversions WHERE site_id = ? ORDER BY tries DESC, created_at DESC LIMIT 1').bind(siteId).first() || null; }
  catch { return null; }
}

async function ownSite(env, accountId, id) {
  if (!id) return null;
  try { return await env.kiln_cloud.prepare('SELECT id, account_id, repo, origin, name, created_at FROM sites WHERE id = ? AND account_id = ? AND kept = 1').bind(String(id), accountId).first() || null; }
  catch { return null; }
}

async function ownerEmail(env, accountId) {
  try { return (await env.kiln_cloud.prepare('SELECT email FROM accounts WHERE id = ?').bind(accountId).first())?.email || null; }
  catch { return null; }
}

async function hasPaidSite(env, accountId) {
  try { return Number((await env.kiln_cloud.prepare('SELECT COUNT(*) n FROM sites WHERE account_id = ? AND ls_subscription_id IS NOT NULL').bind(accountId).first())?.n) > 0; }
  catch { return false; }
}

/** What the dashboard is told about a copy. `report`: with the report, for the one who asks about one site. */
export function shownCopy(row, { now = Date.now(), report = false } = {}) {
  if (!row) return null;
  const left = Number(row.tries) < MOST_TRIES;
  return {
    state: row.state, address: row.address, asked_at: row.asked_at ?? null, done_at: row.done_at ?? null,
    pages: row.pages ?? null, rendered: Number(row.rendered) === 1,
    error: row.state === 'failed' ? copySentence(row.reason, { again: left }) : null,
    again: left && (row.state === 'failed' || stale(row, now)),
    ...(report ? { report: row.report || '', tries: Number(row.tries) || 1 } : {}),
  };
}

/** The newest copy of each of an account's sites that was brought in, by site id (for /cloud/me). */
export async function copiesForAccount(env, accountId, { now = Date.now() } = {}) {
  const out = {};
  try {
    const rows = await env.kiln_cloud.prepare(
      'SELECT site_id, address, state, reason, pages, rendered, tries, asked_at, done_at FROM conversions WHERE account_id = ? ORDER BY tries DESC, created_at DESC').bind(accountId).all();
    for (const r of rows?.results || []) if (!out[r.site_id]) out[r.site_id] = shownCopy(r, { now });
  } catch { /* a database migration 0009 has not reached: no site was brought in */ }
  return out;
}

/** GET /cloud/sites/bring?site=<id>: the same, with the report. */
export async function copyOf(env, { accountId, id, now = Date.now() } = {}) {
  const site = await ownSite(env, accountId, id);
  if (!site) return refusal('no_such_site');
  return { ok: true, bring: shownCopy(await lastCopy(env, site.id), { now, report: true }) };
}

// ─── Starting the job ─────────────────────────────────────────────────────────

/**
 * Starts the job for one row of `conversions`. true when GitHub took it. A
 * 401 means the remembered token is dead: it is forgotten (keeps.js) and the
 * start is tried once more with a new one. When GitHub still did not take it,
 * the row is failed with `no_job`, the operator is told, and the site and its
 * repository are left as they are.
 */
async function startJob(env, { job, address, repo, worker, sign, pkcs1, note, now }) {
  const where = `/repos/${convertRepo(env)}/actions/workflows/${convertWorkflow(env)}/dispatches`;
  let detail;
  try {
    const start = async () => gh(await keepToken(env, { sign, pkcs1 }), 'POST', where,
      { ref: 'main', inputs: { job, address, repo, back: `${worker}/cloud/convert/done`, pages: String(MOST_PAGES) } });
    let r = await start();
    // 401: the remembered token is dead before its 50 minutes are over. It is forgotten, and the start is tried once more with a new one.
    if (r.status === 401) { await forgetKeepToken(env); r = await start(); }
    if (r.ok) return true;
    detail = `POST ${where} answered ${r.status}`;
  } catch (e) { detail = String((e && (e.detail || e.message)) || e).slice(0, 300); }
  console.warn(JSON.stringify({ evt: 'bring_job_not_started', job, repo, detail }));
  try { await env.kiln_cloud.prepare("UPDATE conversions SET state = 'failed', reason = 'no_job', done_at = ?, updated_at = ? WHERE id = ? AND state = 'copying'").bind(now, now, job).run(); }
  catch { /* the five-minute job gives it up in half an hour */ }
  try {
    await note(`Kiln could not start copying ${address} into ${repo}`, [`Job: ${job}`, `What went wrong: ${detail}`,
      `The site and the repository ${repo} were left as they are. Its owner can press Try again.`]);
  } catch { /* logged above */ }
  return false;
}

const writeRow = (env, { job, siteId, accountId, address, branch, tries, now }) => env.kiln_cloud.prepare(
  'INSERT INTO conversions (id, site_id, account_id, address, branch, state, tries, asked_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
  .bind(job, siteId, accountId, address, branch || 'main', 'copying', tries, now, now, now).run();

/**
 * POST /cloud/sites/bring: starts a site Kiln keeps the files of, empty, and
 * the job that fills it from `address`.
 *
 *   address, name, mine   what the person sent: the old site's address, what
 *                         they call the site (or nothing), and the tick
 *   worker                this service's address: the job answers there
 *   dashboard             the dashboard's address, which is not a site to copy
 *   by, sign, pkcs1, register, forget, note   as startKept takes them
 *
 * Answers { ok: true, site, bring }, or { ok: false, code, status, error }.
 * When the site was made and the job could not be started, the refusal also
 * carries `site` and `bring`: the site stays, and its owner can try again.
 */
export async function bringIn(env, { accountId, address, name, mine, worker, dashboard = '', by = '', sign, pkcs1 = null, register, forget = async () => {},
  note = async () => {}, now = Date.now() } = {}) {
  if (!bringOn(env)) return refusal('not_set_up');
  if (mine !== true) return refusal('not_mine');
  const at = cleanAddress(address, ownAddresses(env, [worker, dashboard]));
  if (!at.ok) return refusal(at.code);
  let called = at.source.slice(0, 60);
  if (name != null && String(name).trim() !== '') {
    called = cleanName(name);
    if (!called) return refusal('bad_name');
  }
  const job = newJob();
  let paid = false;
  const out = await startKept(env, {
    accountId, name: called, worker, by, sign, pkcs1, register, forget, note, now, empty: true,
    about: [`Being copied from: ${at.address}`, `Job: ${job}`],
    mayStart: async () => {
      // The table the copy is written down in, before anything is made.
      try { await env.kiln_cloud.prepare('SELECT id FROM conversions LIMIT 1').first(); } catch { return refusal('not_set_up'); }
      // One free copy of a site in 30 days, whoever asks. An account that pays for a site is not held to it.
      paid = await hasPaidSite(env, accountId);
      return !paid && await env.KILN.get(broughtKey(at.source)) ? refusal('not_now') : null;
    },
    onMade: ({ id, branch }) => writeRow(env, { job, siteId: id, accountId, address: at.address, branch, tries: 1, now }),
  });
  if (!out.ok) return out;
  if (!paid) { try { await env.KILN.put(broughtKey(at.source), String(now), { expirationTtl: BROUGHT_DAYS * 86400 }); } catch { /* the copy goes on */ } }
  const started = await startJob(env, { job, address: at.address, repo: out.repo, worker, sign, pkcs1, note, now });
  const bring = shownCopy(await lastCopy(env, out.site.id), { now });
  return started ? { ok: true, site: out.site, bring } : { ...refusal('no_job'), site: out.site, bring };
}

/** POST /cloud/sites/bring/again: one more try for a copy that failed, or that has said nothing for 30 minutes. */
export async function bringAgain(env, { accountId, id, worker, sign, pkcs1 = null, note = async () => {}, now = Date.now() } = {}) {
  if (!bringOn(env)) return refusal('not_set_up');
  const site = await ownSite(env, accountId, id);
  if (!site) return refusal('no_such_site');
  const last = await lastCopy(env, site.id);
  if (!last) return refusal('no_copy');
  if (last.state === 'done') return refusal('copied');
  const late = stale(last, now);
  if (last.state === 'copying' && !late) return refusal('still_copying');
  if (Number(last.tries) >= MOST_TRIES) return refusal('no_more_tries');
  const lock = `bringlock:${site.id}`;
  if (await env.KILN.get(lock)) return refusal('busy');
  await env.KILN.put(lock, '1', { expirationTtl: LOCK_S });
  try {
    // The try that said nothing is given up on first, so its answer, if it ever comes, changes nothing.
    if (late) await env.kiln_cloud.prepare("UPDATE conversions SET state = 'failed', reason = 'no_answer', done_at = ?, updated_at = ? WHERE id = ? AND state = 'copying'").bind(now, now, last.id).run();
    const job = newJob();
    await writeRow(env, { job, siteId: site.id, accountId, address: last.address, branch: last.branch, tries: Number(last.tries) + 1, now });
    const started = await startJob(env, { job, address: last.address, repo: site.repo, worker, sign, pkcs1, note, now });
    const bring = shownCopy(await lastCopy(env, site.id), { now });
    return started ? { ok: true, site: site.id, bring } : { ...refusal('no_job'), site: site.id, bring };
  } catch (e) {
    console.warn(JSON.stringify({ evt: 'bring_again_failed', site: site.id, detail: String((e && e.message) || e).slice(0, 300) }));
    return refusal('no_job');
  } finally {
    try { await env.KILN.delete(lock); } catch { /* it runs out by itself in a minute */ }
  }
}

// ─── The job's answer ─────────────────────────────────────────────────────────

/** The report as the dashboard shows it: without the steps written for a person at a terminal, and no longer than it may be. */
export function cutReport(report) {
  if (typeof report !== 'string') return '';
  const at = report.search(/^## Next steps/m);
  return withoutCommands(at >= 0 ? report.slice(0, at) : report).trimEnd().slice(0, MOST_REPORT);
}

/**
 * The report is written by a tool for a person at a terminal, and some of its
 * sentences tell the reader to run a command. A customer reading it in the
 * dashboard has no terminal, and the job has already made those choices for
 * them, so those sentences are left out: a block of commands, a sentence that
 * names an option of the tool (--render, --max-pages) or a command, and the
 * option's name in brackets after a sentence that is otherwise plain.
 */
const COMMAND = /--[a-z][a-z-]+|\bnpx\b|\bnpm install\b|\bgit (init|add|commit|push)\b|\bgh repo\b/;
export function withoutCommands(text) {
  const out = [];
  let code = false;
  for (const raw of String(text || '').split('\n')) {
    if (/^\s*```/.test(raw)) { code = !code; continue; }
    if (code) continue;
    let line = raw.replace(/\s*\((?:`?--[a-z][a-z-]+`?(?:,\s*)?)+\)/g, '');
    if (COMMAND.test(line)) {
      const lead = (line.match(/^\s*(?:[-*]|\d+\.)\s+/) || [''])[0];
      const kept = line.slice(lead.length).split(/(?<=[.!?:])\s+/).filter(part => !COMMAND.test(part));
      // A sentence that only led up to a command ("Run this instead:") goes with it.
      while (kept.length && /:$/.test(kept[kept.length - 1])) kept.pop();
      if (!kept.length) continue;
      line = lead + kept.join(' ');
    }
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** Writes the site's own settings file into its repository, over the one the copy may have brought. */
async function writeSettings(env, { site, branch, worker, sign, pkcs1 }) {
  const token = await keepToken(env, { sign, pkcs1 });
  const on = branch || 'main';
  const where = `/repos/${site.repo}/contents/${CONFIG_FILE}`;
  const have = await gh(token, 'GET', `${where}?ref=${encodeURIComponent(on)}`);
  if (!have.ok && have.status !== 404) throw new Error(`GET ${where} answered ${have.status}`);
  const sha = have.ok ? ((await have.json())?.sha || null) : null;
  const content = base64(kilnConfigFile({ repo: site.repo, branch: on, worker, siteName: site.name || '' }));
  const r = await gh(token, 'PUT', where, { message: SETTINGS_MESSAGE, content, branch: on, ...(sha ? { sha } : {}) });
  if (!r.ok) throw new Error(`PUT ${where} answered ${r.status}`);
}

/** The mail a copy ends with: once for a try, and only where customer mail is on and the account has an address (sendOnce). */
async function tellOwner(env, row, { site, state, reason, pages = 0, dashboard, trialDays, up = false, address = null }) {
  try {
    const to = await ownerEmail(env, row.account_id);
    if (state === 'done') {
      // `up`: the site is on Kiln's hosting already, at `address`. Otherwise the mail says which button puts it up.
      await sendOnce(env, `copied:${row.id}`, to, siteCopiedMail({ name: site.name, address: (up && address) || site.origin, up, from: row.address, pages, endsAt: trialEndsAt(site.created_at, trialDays), dashboard }));
    } else {
      const again = Number(row.tries) < MOST_TRIES;
      await sendOnce(env, `copyfailed:${row.id}`, to, copyFailedMail({ address: row.address, ...copyTrouble(reason, { again }), again, dashboard }));
    }
  } catch { /* a mail that could not go changes nothing about the copy */ }
}

/**
 * What follows a copy that worked: the site is put on Kiln's hosting, and then
 * its owner is written to. A site that could not be put up changes nothing
 * about the copy, which stays done: the mail says which button puts it up, and
 * the operator is told. `wait` (ms) is how long the mail waits for the site,
 * where this runs after the answer and has little time left: a site that is
 * slower than that is written about as not up yet, and may still go up.
 * Never throws.
 */
async function putUpAndTell(env, row, { site, pages, dashboard, trialDays, host, note, wait = 0 }) {
  let up = null, timer = null;
  try {
    const going = Promise.resolve().then(() => host(site));
    going.catch(() => {});
    const slow = new Promise((answer) => { if (wait > 0) timer = setTimeout(() => answer({ ok: false, code: 'slow', detail: `the site was not up after ${Math.round(wait / 1000)} seconds, and it may still go up` }), wait); });
    up = await Promise.race([going, slow]);
  } catch (e) { up = { ok: false, code: 'error', detail: String((e && (e.detail || e.message)) || e).slice(0, 300) }; }
  finally { if (timer) clearTimeout(timer); }
  const isUp = !!up && up.ok === true;
  await tellOwner(env, row, { site, state: 'done', pages, dashboard, trialDays, up: isUp, address: isUp ? up.url : null });
  if (isUp) return;
  const detail = `${(up && up.code) || 'not_up'}: ${String((up && up.detail) || 'no reason was given').replace(/\s+/g, ' ').slice(0, 300)}`;
  console.warn(JSON.stringify({ evt: 'bring_not_hosted', job: row.id, repo: site.repo, detail }));
  try {
    await note(`Kiln could not put ${site.repo} on its hosting after its copy`, [`Job: ${row.id}`, `What went wrong: ${detail}`,
      "The copy is done and stays done. Its owner was told that Put it on Kiln's hosting on the site's row puts the site up."]);
  } catch { /* logged above */ }
}

/**
 * POST /cloud/convert/done: the job says how a copy went.
 *
 *   body        the request's body as it arrived, bytes or text
 *   signature   its X-Kiln-Signature header
 *   worker      this service's address, for the site's settings file
 *   dashboard, trialDays   for the mail
 *   host        (site) → puts the copied site on Kiln's hosting (cloud.js
 *               hostCopied) and answers { ok: true, url } or { ok: false,
 *               code, detail }. Without it the site is not put up, and the
 *               mail says which button does that.
 *   later       (promise) → lets work go on after the answer is sent
 *               (`ctx.waitUntil`). With it the job has its answer at once and
 *               the site goes up afterwards; without it the answer waits.
 *
 * A copy that worked is marked done first. Then the site is put on Kiln's
 * hosting and its owner is written to: that the site is up and where, or,
 * when it could not be put up, that the copy is there and which button puts
 * it up. The copy is done either way.
 *
 * Answers { status, body }. A wrong or missing signature is 401 and changes
 * nothing. An answer for a job that is not being copied any more (a second
 * delivery, a try that was given up on, a job nobody knows) is 200 with
 * `already: true` and changes nothing.
 */
export async function copyAnswered(env, { body, signature, worker, dashboard = '', trialDays = 7, sign, pkcs1 = null, note = async () => {}, host = null, later = null,
  hostWait = HOST_SECONDS * 1000, now = Date.now() } = {}) {
  const size = typeof body === 'string' ? body.length : (body ? body.byteLength : 0);
  if (size > MOST_ANSWER) return { status: 413, body: { error: 'too large' } };
  if (!(await signedRight(convertSecret(env), body || '', signature))) return { status: 401, body: { error: 'bad signature' } };
  let said = null;
  try { said = JSON.parse(typeof body === 'string' ? body : new TextDecoder().decode(body)); } catch { /* answered below */ }
  if (!said || typeof said !== 'object' || Array.isArray(said)) return { status: 400, body: { error: 'not JSON' } };
  const job = String(said.job || '');
  let row = null;
  if (/^[0-9a-f]{32}$/.test(job)) {
    try { row = await env.kiln_cloud.prepare('SELECT * FROM conversions WHERE id = ?').bind(job).first() || null; }
    catch { return { status: 503, body: { error: 'try again' } }; }
  }
  if (!row || row.state !== 'copying') return { status: 200, body: { ok: true, already: true } };

  const site = await ownSite(env, row.account_id, row.site_id);
  const pages = Math.max(0, Math.min(100000, Math.floor(Number(said.pages) || 0)));
  const rendered = said.rendered === true ? 1 : 0;
  let state = 'failed', reason = null;
  if (!site) reason = 'removed';
  else if (said.ok === true && pages >= 1) state = 'done';
  else reason = said.ok === true ? 'nothing' : (['unreachable', 'blank', 'nothing'].includes(said.reason) ? said.reason : 'tool');

  if (state === 'done') {
    // The settings first: a copy is not called done while its editor could not open.
    try { await writeSettings(env, { site, branch: row.branch, worker, sign, pkcs1 }); }
    catch (e) {
      const detail = String((e && (e.detail || e.message)) || e).slice(0, 300);
      console.warn(JSON.stringify({ evt: 'bring_settings_failed', job, repo: site.repo, detail }));
      try { await note(`Kiln could not write the settings of ${site.repo} after its copy`, [`Job: ${job}`, `What went wrong: ${detail}`, 'The copy is still marked as being made. The job may send its answer again.']); } catch { /* logged above */ }
      return { status: 502, body: { error: 'settings not written, send the answer again' } };
    }
  }
  const took = await env.kiln_cloud.prepare("UPDATE conversions SET state = ?, reason = ?, pages = ?, rendered = ?, report = ?, done_at = ?, updated_at = ? WHERE id = ? AND state = 'copying'")
    .bind(state, reason, pages, rendered, cutReport(said.report), now, now, job).run();
  if (!changed(took)) return { status: 200, body: { ok: true, already: true } };
  if (site && state === 'done' && typeof host === 'function') {
    const waits = typeof later === 'function';
    const work = putUpAndTell(env, row, { site, pages, dashboard, trialDays, host, note, wait: waits ? hostWait : 0 });
    if (waits) later(work); else await work;
  } else if (site) await tellOwner(env, row, { site, state, reason, pages, dashboard, trialDays });
  if (reason === 'tool') {
    try { await note(`Kiln's copy of ${row.address} stopped`, [`Job: ${job}`, `Repository: ${site.repo}`, `What the job said: ${String(said.reason || 'nothing').replace(/\s+/g, ' ').slice(0, 300)}`, `Try: ${row.tries} of ${MOST_TRIES}`]); }
    catch { /* the row says it */ }
  }
  return { status: 200, body: { ok: true, state } };
}

// ─── The five-minute job ──────────────────────────────────────────────────────

/**
 * Gives up on a copy whose job has said nothing for 30 minutes: the row is
 * failed with `no_answer`, its owner gets the mail, and the operator is told.
 * Ten at most in one run. Never throws.
 */
export async function sweepCopies(env, { now = Date.now(), note = async () => {}, dashboard = '' } = {}) {
  const out = { failed: 0 };
  if (!env || !env.kiln_cloud || !convertSecret(env)) return out;
  try {
    const rows = await env.kiln_cloud.prepare("SELECT * FROM conversions WHERE state = 'copying' AND asked_at < ? ORDER BY asked_at LIMIT ?").bind(now - COPY_MINUTES * 60000, SWEEP_AT_ONCE).all();
    for (const row of rows?.results || []) {
      try {
        const took = await env.kiln_cloud.prepare("UPDATE conversions SET state = 'failed', reason = 'no_answer', done_at = ?, updated_at = ? WHERE id = ? AND state = 'copying'").bind(now, now, row.id).run();
        if (!changed(took)) continue;
        out.failed++;
        const site = await ownSite(env, row.account_id, row.site_id);
        if (site) await tellOwner(env, row, { site, state: 'failed', reason: 'no_answer', dashboard });
        try {
          await note(`Kiln's copy of ${row.address} gave no answer in ${COPY_MINUTES} minutes`, [`Job: ${row.id}`, `Repository: ${site ? site.repo : 'the site was removed'}`,
            `Try: ${row.tries} of ${MOST_TRIES}`, `Look for the job's run in ${convertRepo(env)} on GitHub. The site's owner was told and can press Try again while a try is left.`]);
        } catch { /* the row says it */ }
      } catch (e) { console.warn(JSON.stringify({ evt: 'bring_sweep_row_failed', job: row.id, detail: String((e && e.message) || e).slice(0, 300) })); }
    }
  } catch (e) { console.warn(JSON.stringify({ evt: 'bring_sweep_failed', detail: String((e && e.message) || e).slice(0, 300) })); }
  return out;
}
