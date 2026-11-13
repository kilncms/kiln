/**
 * Kiln keeps the files: a site for someone with no GitHub account.
 *
 * A person who signed in to the dashboard with Google names a site and presses
 * Start. Kiln makes a private repository in a GitHub organization of its own,
 * fills it with Kiln's starter site, and registers it as that account's site.
 * The dashboard then puts it on Kiln's hosting with the route it already has.
 *
 * The repository is made with a second GitHub App, owned by that organization
 * and installed only there, because the main Kiln app may not create
 * repositories. The service is told about it with three settings:
 *
 *   KEEP_ORG       the organization's name ("kiln-sites")
 *   KEEP_APP_ID    the second app's id
 *   KEEP_APP_KEY   its private key, as the PEM text GitHub hands out
 *   KEEP_STARTER   optional: the public repository a new site starts as
 *                  (kilncms/kiln-demo unless set)
 *
 * Nothing in this file ever deletes, renames or transfers a repository. When
 * something fails after a repository was made, it is left where it is and the
 * operator is told its name.
 */
import { gh, refPath, inTurn, kilnConfigFile } from './prepare.js';
import { hostingOn, siteName, siteAddress } from './hosting.js';

const CONFIG_FILE = 'assets/kiln-config.js';
const DEFAULT_STARTER = 'kilncms/kiln-demo';
export const STARTS_AN_HOUR = 30;           // new kept sites the whole service starts in one hour
export const STARTS_A_WEEK = 3;             // sites one account starts in 7 days, the ones it removed counted too
export const STARTS_A_WEEK_PAYING = 10;     // the same for an account that pays for a site
const DAY = 86400000;
const WEEK = 7 * DAY;
export const START_MESSAGE = "Kiln's starter site";
export const KEPT_REPO_DAYS = 30;           // how long a removed site's repository is left before anyone may remove it by hand
const LOCK_S = 120;                         // one start at a time for an account; the lock runs out by itself
const TOKEN_S = 50 * 60;                    // GitHub's token lasts an hour
const MOST_FILES = 400;                     // each file is two requests, and one run of the service may make about a thousand
const NEW_REPO_WAITS = [0, 400, 900, 1500, 2500];   // milliseconds before each look for a new repository's first commit

export class KeepError extends Error {
  constructor(code, detail = '') { super(detail || code); this.code = code; this.detail = detail || code; }
}

export const keepOrg = (env) => String((env && env.KEEP_ORG) || '').trim();
export const starterRepo = (env) => String((env && env.KEEP_STARTER) || '').trim() || DEFAULT_STARTER;

/** The service has been told about the organization and the app that may make repositories in it. */
export function keepsOn(env) {
  return !!(env && keepOrg(env) && String(env.KEEP_APP_ID || '').trim() && String(env.KEEP_APP_KEY || '').trim());
}

/**
 * A site can be started here: the settings above, and Kiln's hosting, since a
 * kept site's address is the one the hosting gives it and it has no other.
 */
export function keepsReady(env) { return keepsOn(env) && hostingOn(env); }

/** Is this repository in the organization where Kiln keeps sites' files? Named by `KEEP_ORG`, in any letter case. */
export function inKeepOrg(env, repo) {
  const org = keepOrg(env).toLowerCase();
  return !!org && String(repo || '').split('/')[0].trim().toLowerCase() === org;
}

// ─── What a person reads ──────────────────────────────────────────────────────

const SENTENCES = {
  not_set_up: 'Starting a site is not switched on for this service yet. Write to info@kilncms.com and we will tell you when it is.',
  bad_name: 'Give your site a name of 2 to 60 characters, such as Oak Bakery, then press Start again.',
  busy: 'Kiln is already starting a site for you. Wait a minute, then reload this page to see it.',
  one_unpaid: 'You already have a site here that is not paid for. Subscribe for that site or remove it, then start a new one.',
  too_many: 'Kiln has started a lot of new sites in the last hour. Please try again in an hour.',
  not_started: 'Kiln could not start your site just now. Please try again in a few minutes.',
  half_made: 'Kiln could not finish starting your site, so it is not in your list. Please try again in a few minutes, and write to info@kilncms.com if it happens again.',
  in_keep_org: 'That repository is one Kiln keeps for a site, so it cannot be added here. Enter a repository of your own.',
};
const STATUS = { your_limit: 429, not_set_up: 409, bad_name: 400, busy: 409, one_unpaid: 409, too_many: 429, not_started: 502, half_made: 502, in_keep_org: 403 };

export const keepSentence = (code) => SENTENCES[code] || SENTENCES.not_started;
const refusal = (code) => ({ ok: false, code, status: STATUS[code] || 502, error: keepSentence(code) });

/** "3 days", "5 hours": how long from now, rounded up so that it is never too short. */
function howLong(ms) {
  const hours = Math.max(1, Math.ceil(ms / 3600000));
  if (hours > 24) return `${Math.ceil(ms / DAY)} days`;
  return hours === 1 ? '1 hour' : `${hours} hours`;
}

/** What an account reads when it has started as many sites in 7 days as one account may. `wait` is how long until the oldest of them is 7 days old. */
export const ownLimitSentence = (most, wait) =>
  `You have started ${most} sites in the last 7 days, so you can start the next one in ${howLong(wait)}, and you can write to info@kilncms.com if you need more.`;

/**
 * What is true about the free days of a site that got no days of its own: an
 * account that pays for nothing has its free days once, counted from the first
 * site it ever started here. `since` is when that was, and null for a site
 * whose days start with it (then there is nothing to say). `days` is how long
 * the free days are.
 */
export function freeDaysSentence({ since, days, now = Date.now() } = {}) {
  if (!since) return null;
  const left = Number(since) + days * DAY - now;
  if (left <= 0) return "Your free days began with the first site you started here and they are over, so this site has none. Subscribe on the site's row to edit it and keep it up.";
  // Counted as the site's row in the dashboard counts them: part of a day is a day, and the last day is "less than one".
  const whole = Math.ceil(left / DAY);
  const much = whole >= 2 ? `${whole} free days` : 'less than one free day';
  return `Your free days began with the first site you started here, so this site has ${much} left. Subscribe on the site's row before they end to keep editing it.`;
}

/** What the person calls the site, tidied: 2 to 60 characters, or null. */
export function cleanName(name) {
  if (typeof name !== 'string') return null;
  const n = name.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim();
  const length = [...n].length;
  return length >= 2 && length <= 60 ? n : null;
}

/** The start of the repository's name: lowercase letters, digits and dashes, or "site". */
export function siteSlug(name) {
  return String(name || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'site';
}

// ─── The second app's token ───────────────────────────────────────────────────

const tokenKey = (env) => `keeptok:${keepOrg(env).toLowerCase()}:${String(env.KEEP_APP_ID || '').trim()}`;

/**
 * The app's private key the way the service's signer takes it: the base64
 * inside "BEGIN PRIVATE KEY". GitHub hands out the older "BEGIN RSA PRIVATE
 * KEY" form, which `pkcs1` rewraps (the service's own converter, handed in by
 * index.js). Null when the key cannot be read.
 */
export function keepKey(env, { pkcs1 = null } = {}) {
  const pem = String((env && env.KEEP_APP_KEY) || '').replace(/\\n/g, '\n').trim();
  if (/BEGIN RSA PRIVATE KEY/.test(pem)) {
    try { return typeof pkcs1 === 'function' ? (pkcs1(pem) || null) : null; } catch { return null; }
  }
  const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s/g, '');
  return body && /^[A-Za-z0-9+/=]+$/.test(body) ? body : null;
}

/**
 * Forgets the remembered token. GitHub answered 401 to it, so it is dead before
 * its 50 minutes are over, and the next `keepToken` asks GitHub for a new one.
 * Never throws: a token that could not be forgotten runs out by itself.
 */
export async function forgetKeepToken(env) {
  try { await env.KILN.delete(tokenKey(env)); } catch { /* it runs out by itself */ }
}

/**
 * A token that may make and write repositories in `KEEP_ORG`, kept for 50
 * minutes. `sign` is the service's signer for a GitHub App (cloud.js appJwt),
 * so both apps are signed for by the same code.
 */
export async function keepToken(env, { sign, pkcs1 = null } = {}) {
  const cached = await env.KILN.get(tokenKey(env));
  if (cached) return cached;
  const pk8 = keepKey(env, { pkcs1 });
  if (!pk8) throw new KeepError('key', 'KEEP_APP_KEY is not a private key this service can read. Store the PEM text GitHub gave for the app, whole.');
  let jwt;
  try { jwt = await sign({ app_id: String(env.KEEP_APP_ID).trim(), pk8 }); }
  catch (e) { throw new KeepError('key', `KEEP_APP_KEY could not be signed with: ${String((e && e.message) || e).slice(0, 160)}`); }
  const org = keepOrg(env);
  const inst = await gh(jwt, 'GET', `/orgs/${encodeURIComponent(org)}/installation`);
  if (!inst.ok) throw new KeepError('installation', `GET /orgs/${org}/installation answered ${inst.status}: is the app installed on ${org}, and is KEEP_APP_ID its id?`);
  const { id } = await inst.json();
  const tok = await gh(jwt, 'POST', `/app/installations/${id}/access_tokens`);
  if (!tok.ok) throw new KeepError('installation', `POST /app/installations/${id}/access_tokens answered ${tok.status}`);
  const { token } = await tok.json();
  if (!token) throw new KeepError('installation', 'GitHub answered without a token');
  await env.KILN.put(tokenKey(env), token, { expirationTtl: TOKEN_S });
  return token;
}

// ─── Kept sites in the database ───────────────────────────────────────────────

/**
 * The row of a site Kiln keeps the files of, or null: for any other site, and
 * for a database migration 0008 has not reached. `kept = 1` is written by
 * startKept alone, so a row that has it was made here for the account on it.
 */
export async function keptSite(env, id) {
  if (!id) return null;
  try { return await env.kiln_cloud.prepare('SELECT id, account_id, repo FROM sites WHERE id = ? AND kept = 1').bind(String(id)).first() || null; }
  catch { return null; }
}

/** The ids of an account's kept sites. */
export async function keptIds(env, accountId) {
  try {
    const rows = await env.kiln_cloud.prepare('SELECT id FROM sites WHERE account_id = ? AND kept = 1').bind(accountId).all();
    return new Set((rows?.results || []).map(r => r.id));
  } catch { return new Set(); }
}

/** What the owner called each kept site of an account, by site id: the name as they typed it. */
export async function keptNames(env, accountId) {
  try {
    const rows = await env.kiln_cloud.prepare('SELECT id, name FROM sites WHERE account_id = ? AND kept = 1').bind(accountId).all();
    return Object.fromEntries((rows?.results || []).filter(r => r.name).map(r => [r.id, r.name]));
  } catch { return {}; }
}

/** What the operator is told when a kept site is removed. Its repository is not touched. */
export function keptRemovedNote({ repo, by = '', now = Date.now() }) {
  const day = new Date(now + KEPT_REPO_DAYS * 86400 * 1000).toISOString().slice(0, 10);
  return {
    subject: `Kiln no longer uses ${repo}`,
    lines: [
      `The site whose files Kiln kept in ${repo} was removed from the dashboard${by ? ` by ${by}` : ''}.`,
      `No site uses the repository ${repo} now. Kiln did not touch it.`,
      `It may be removed by hand after ${KEPT_REPO_DAYS} days, which is from ${day}.`,
    ],
  };
}

// ─── Starting a site ──────────────────────────────────────────────────────────

const base64 = (text) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

async function must(res, what, status = null) {
  if (!(status ? res.status === status : res.ok)) throw new KeepError('github', `${what} answered ${res.status}`);
  return res.json();
}

/** Only one of two presses that arrive together goes on: each writes its own mark, and the one still there is the holder. */
async function takeLock(env, key) {
  if (await env.KILN.get(key)) return false;
  const mine = crypto.randomUUID();
  await env.KILN.put(key, mine, { expirationTtl: LOCK_S });
  return (await env.KILN.get(key)) === mine;
}

/** The starter site's files, read before anything is made, so a starter that cannot be read leaves nothing behind. */
async function readStarter(env, token) {
  const repo = starterRepo(env);
  const about = await must(await gh(token, 'GET', `/repos/${repo}`), `GET /repos/${repo}`);
  const branch = about.default_branch || 'main';
  const listing = await must(await gh(token, 'GET', `/repos/${repo}/git/trees/${refPath(branch)}?recursive=1`), `GET /repos/${repo}/git/trees/${branch}`);
  if (listing.truncated) throw new KeepError('starter', `${repo} has more files than GitHub lists in one answer`);
  // Files only, as files: no links, no other repositories. The settings file is
  // written for the new site. A workflow is left out, because GitHub refuses a
  // commit that brings one from an app without leave to write workflows.
  const files = (listing.tree || []).filter(e => e.type === 'blob' && (e.mode === '100644' || e.mode === '100755')
    && e.path !== CONFIG_FILE && !e.path.startsWith('.github/workflows/'));
  if (!files.length) throw new KeepError('starter', `${repo} has no files`);
  if (files.length > MOST_FILES) throw new KeepError('starter', `${repo} has ${files.length} files, and a new site can start with ${MOST_FILES} at most`);
  return { repo, branch, files };
}

async function makeRepo(env, token, { name, id }) {
  const org = keepOrg(env);
  const repoName = `${siteSlug(name)}-${id.slice(0, 8)}`;
  const ours = `${org}/${repoName}`;
  let r;
  try {
    r = await gh(token, 'POST', `/orgs/${encodeURIComponent(org)}/repos`, {
      name: repoName, private: true, auto_init: true, has_issues: false, has_projects: false, has_wiki: false,
      description: `${name}: a site whose files Kiln keeps`,
    });
  } catch (e) {
    // No answer came back, so nobody knows whether GitHub made it.
    const err = new KeepError('no_repo', `POST /orgs/${org}/repos got no answer: ${String((e && e.message) || e).slice(0, 160)}`);
    err.maybe = ours;
    throw err;
  }
  if (r.status !== 201) {
    if (r.status === 401) await forgetKeepToken(env);
    throw new KeepError('no_repo', `POST /orgs/${org}/repos answered ${r.status}`);
  }
  const j = await r.json().catch(() => ({}));
  // GitHub's own spelling of the name, which is the one its push notices carry.
  const repo = String(j.full_name || '').toLowerCase() === ours.toLowerCase() ? j.full_name : ours;
  return { repo, branch: j.default_branch || 'main', private: j.private === true };
}

/** The commit GitHub starts a new repository with. It can take a moment to be there. */
async function firstCommit(token, repo, branch, sleep) {
  for (const wait of NEW_REPO_WAITS) {
    if (wait) await sleep(wait);
    const r = await gh(token, 'GET', `/repos/${repo}/git/ref/heads/${refPath(branch)}`);
    if (r.ok) { const sha = (await r.json())?.object?.sha; if (sha) return sha; }
    else if (r.status !== 404 && r.status !== 409) throw new KeepError('github', `GET /repos/${repo}/git/ref/heads/${branch} answered ${r.status}`);
  }
  throw new KeepError('github', `the first commit of ${repo} was not there after a few seconds`);
}

/** Copies the starter's files into the new repository as one commit on top of its first one, with this site's settings file. */
async function fill(token, { starter, repo, branch, config, sleep }) {
  const head = await firstCommit(token, repo, branch, sleep);
  const entries = await inTurn(starter.files, async (f) => {
    const from = await must(await gh(token, 'GET', `/repos/${starter.repo}/git/blobs/${f.sha}`), `GET /repos/${starter.repo}/git/blobs (${f.path})`);
    const content = from.encoding === 'base64' ? String(from.content || '').replace(/\s/g, '') : base64(String(from.content || ''));
    const to = await must(await gh(token, 'POST', `/repos/${repo}/git/blobs`, { content, encoding: 'base64' }), `POST /repos/${repo}/git/blobs (${f.path})`, 201);
    return { path: f.path, mode: f.mode, type: 'blob', sha: to.sha };
  });
  const settings = await must(await gh(token, 'POST', `/repos/${repo}/git/blobs`, { content: base64(config), encoding: 'base64' }), `POST /repos/${repo}/git/blobs (${CONFIG_FILE})`, 201);
  entries.push({ path: CONFIG_FILE, mode: '100644', type: 'blob', sha: settings.sha });
  // No base tree: the new site is the starter's files and nothing else.
  const tree = await must(await gh(token, 'POST', `/repos/${repo}/git/trees`, { tree: entries }), `POST /repos/${repo}/git/trees`, 201);
  const commit = await must(await gh(token, 'POST', `/repos/${repo}/git/commits`, { message: START_MESSAGE, tree: tree.sha, parents: [head] }), `POST /repos/${repo}/git/commits`, 201);
  await must(await gh(token, 'PATCH', `/repos/${repo}/git/refs/heads/${refPath(branch)}`, { sha: commit.sha, force: false }), `PATCH /repos/${repo}/git/refs/heads/${branch}`);
  return { commit: commit.sha, files: entries.length };
}

/**
 * Starts a site whose files Kiln keeps, for the account `accountId`.
 *
 *   name      what the person calls the site
 *   worker    this service's address, for the site's settings file
 *   by        who is signed in, for the operator's notes
 *   sign      the service's signer for a GitHub App
 *   pkcs1     the service's converter for the older form of a private key
 *   register  ({ id, repo, origin, name, since }) → the new row of `sites`, with
 *             kept = 1. `since` is when the free days of this site began: null
 *             for days of its own, else when the account's first site was
 *             started (an account that pays for nothing has its free days once)
 *   forget    (id) → takes that row away again
 *   note      (subject, lines) → a note to the operator
 *
 * A site that is brought in from somewhere else (bring.js) starts the same
 * way, except that its repository is not filled with the starter: a job
 * outside the service fills it. For that:
 *
 *   empty     true: the starter is not read and nothing is written after
 *             GitHub's own first commit
 *   mayStart  () → null, or a refusal { ok: false, code, status, error }. One
 *             more look at fair use, after the ones here and before anything
 *             is made
 *   onMade    ({ id, site, repo, branch, name }) → what must be written down
 *             with the new row. If it throws, the start fails as any other
 *             failure after the repository was made does
 *   about     more lines for the note to the operator
 *
 * Answers { ok: true, site, repo, branch, name, files, commit, since } or { ok:
 * false, code, status, error }, where `error` is the one sentence the person
 * reads.
 */
export async function startKept(env, { accountId, name, worker, by = '', sign, pkcs1 = null, register, forget = async () => {}, note = async () => {},
  sleep = (ms) => new Promise(r => setTimeout(r, ms)), now = Date.now(),
  empty = false, mayStart = async () => null, onMade = async () => {}, about = [] } = {}) {
  if (!keepsReady(env)) return refusal('not_set_up');
  const called = cleanName(name);
  if (!called) return refusal('bad_name');
  const lock = `keeplock:${accountId}`;
  let held = false, made = null, id = null, counted = null, stays = false;
  try {
    held = await takeLock(env, lock);
    if (!held) return refusal('busy');
    // Fair use, before anything is made. The look comes after the lock: a second
    // press that arrives as the first one finishes finds the site it registered.
    const mine = (await env.kiln_cloud.prepare('SELECT id, status, kept FROM sites WHERE account_id = ?').bind(accountId).all())?.results || [];
    if (mine.some(s => s.kept && s.status !== 'active')) return refusal('one_unpaid');
    // What this account has started in 7 days, the sites it removed counted too.
    // One statement writes this start's row only while the account is under its
    // number, so two requests at once cannot both get past it. The row stays
    // once a repository is asked for, and is taken away again if the start ends
    // before that (the `finally` below).
    const paying = mine.some(s => s.status === 'active');
    const most = paying ? STARTS_A_WEEK_PAYING : STARTS_A_WEEK;
    const row = crypto.randomUUID();
    let wrote;
    try {
      wrote = await env.kiln_cloud.prepare('INSERT INTO kept_starts (id, account_id, at) SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM kept_starts WHERE account_id = ? AND at > ?) < ?')
        .bind(row, accountId, now, accountId, now - WEEK, most).run();
    } catch { return refusal('not_set_up'); }   // a database the table has not reached (migration 0009)
    if (!(Number(wrote && wrote.meta && wrote.meta.changes) > 0)) {
      const oldest = await env.kiln_cloud.prepare('SELECT MIN(at) AS at FROM kept_starts WHERE account_id = ? AND at > ?').bind(accountId, now - WEEK).first();
      return { ok: false, code: 'your_limit', status: STATUS.your_limit, error: ownLimitSentence(most, Number(oldest && oldest.at) + WEEK - now) };
    }
    counted = row;
    // An account that pays for nothing has its free days once: they began with the first site it started here.
    const first = paying ? null : await env.kiln_cloud.prepare('SELECT MIN(at) AS at FROM kept_starts WHERE account_id = ? AND site_id IS NOT NULL').bind(accountId).first();
    const since = Number(first && first.at) || null;
    // The whole service's count comes after the account's own, so only a start that passed it is counted there.
    const hour = `keepstarts:${Math.floor(now / 3600000)}`;
    const started = Number(await env.KILN.get(hour)) || 0;
    if (started >= STARTS_AN_HOUR) return refusal('too_many');
    const no = await mayStart();
    if (no) return no;

    const token = await keepToken(env, { sign, pkcs1 });
    const starter = empty ? null : await readStarter(env, token);
    await env.KILN.put(hour, String(started + 1), { expirationTtl: 2 * 3600 });
    // One new id for both: the repository's name ends with the start of the site's id.
    id = crypto.randomUUID();
    stays = true;   // from here on a repository may have been made, so this start is counted whatever follows
    made = await makeRepo(env, token, { name: called, id });
    if (!made.private) throw new KeepError('not_private', `${made.repo} was made, and GitHub does not say it is private`);
    // An empty one keeps GitHub's first commit and nothing else: whoever asked for it fills it, settings file and all.
    const filled = empty ? { files: 0, commit: null }
      : await fill(token, { starter, repo: made.repo, branch: made.branch, config: kilnConfigFile({ repo: made.repo, branch: made.branch, worker, siteName: called }), sleep });
    // The address Kiln's hosting will give it, from the same function the hosting uses.
    const origin = siteAddress(env, siteName(env, { repo: made.repo, id }));
    const site = await register({ id, repo: made.repo, origin, name: called, since });
    await onMade({ id, site, repo: made.repo, branch: made.branch, name: called });
    // The start's row names its site once the site is in the account's list. The first such row is where the account's free days began.
    try { await env.kiln_cloud.prepare('UPDATE kept_starts SET site_id = ? WHERE id = ?').bind(id, counted).run(); } catch { /* the site is started either way */ }
    try {
      await note(`Kiln started a site and keeps its files: ${made.repo}`, [`Name: ${called}`, `Address it will have: ${origin}`, `Started by: ${by}`,
        ...(empty ? [] : [`Files: ${filled.files}`, `Commit: ${filled.commit}`]), ...about]);
    } catch { /* the site is started either way */ }
    return { ok: true, site, repo: made.repo, branch: made.branch, name: called, files: filled.files, commit: filled.commit, since };
  } catch (e) {
    const detail = String((e && (e.detail || e.message)) || e).slice(0, 300);
    console.warn(JSON.stringify({ evt: 'keep_start_failed', code: (e && e.code) || 'error', repo: made ? made.repo : null, detail }));
    if (!made) {
      if (e && e.maybe) { try { await note(`Kiln may have made ${e.maybe} and no site uses it`, [`Started by: ${by}`, `What went wrong: ${detail}`, 'Look for the repository on GitHub. If it is there, no site uses it and it may be removed by hand.']); } catch { /* logged above */ } }
      return refusal('not_started');
    }
    // The repository stays where it is. The row, if it was written, does not.
    try { await forget(id); } catch { /* the operator is told below */ }
    try {
      await note(`Kiln made ${made.repo} and could not finish starting the site`, [`Name: ${called}`, `Started by: ${by}`, `What went wrong: ${detail}`,
        `The repository ${made.repo} was left where it is. No site uses it, and it may be removed by hand.`]);
    } catch { /* logged above */ }
    return refusal('half_made');
  } finally {
    if (counted && !stays) { try { await env.kiln_cloud.prepare('DELETE FROM kept_starts WHERE id = ?').bind(counted).run(); } catch { /* it counts against the account for 7 days at most */ } }
    if (held) { try { await env.KILN.delete(lock); } catch { /* it runs out by itself in two minutes */ } }
  }
}

// ─── The owner's editor (index.js: an owner session with no GitHub token) ────

export const KEPT_STANDS_SECONDS = 60;
export const keptStandsKey = (accountId, repo) => `keptup:${String(accountId)}:${String(repo).toLowerCase()}`;

/**
 * Does a kept site still stand: a row for this repository, on this account,
 * with `kept` set? The owner's editing session and what they scheduled lean on
 * it. true or false, or null when the database could not be asked (then
 * nothing is ended: the next request asks again). A yes is remembered for a
 * minute, so editing is not a database read on every call; removing the site
 * forgets it at once (cloud.js).
 */
export async function keptStands(env, { repo, account_id: accountId } = {}) {
  if (!env || !env.kiln_cloud || !repo || !accountId) return false;
  const key = keptStandsKey(accountId, repo);
  try { if (await env.KILN.get(key)) return true; } catch { /* the database answers instead */ }
  let row = null;
  try { row = await env.kiln_cloud.prepare('SELECT id FROM sites WHERE lower(repo) = lower(?) AND account_id = ? AND kept = 1').bind(String(repo), String(accountId)).first(); }
  catch { return null; }
  if (!row) return false;
  try { await env.KILN.put(key, '1', { expirationTtl: KEPT_STANDS_SECONDS }); } catch { /* asked again next time */ }
  return true;
}
