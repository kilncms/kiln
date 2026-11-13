/**
 * "Check this site": a short checklist of how one site is set up, for the
 * person who owns it.
 *
 * `kiln doctor` answers this in a terminal and /admin/cloud/diagnose answers
 * it for the operator. This is the same question answered on the site's row
 * in the dashboard: each line is one thing Kiln needs, with a yes or a no, a
 * plain sentence about what was found, and for a no what to press or do.
 *
 *   checkSite   reads the repository and the live site; changes nothing
 *
 * The lines, in order:
 *
 *   repository  Kiln can reach the repository (the GitHub App is installed)
 *   files       Kiln is in the repository: its files, and the two lines per page
 *   settings    assets/kiln-config.js names this service and this repository
 *   address     the site's address answers
 *   live        the live home page loads kiln.js, and kiln.js answers
 *   signin      the sign-in page at /kiln answers
 *
 * `ok` is true (yes), false (no) or null: not checked, because an earlier
 * line failed or because it cannot be told from here, and `detail` says which.
 *
 * The live site is somebody else's address, typed into a form, so it is asked
 * with care (see `visit`): https only, never a numbered or private address, a
 * time limit, redirects followed by hand and only within the site, a limit on
 * how much is read, and nothing sent along that identifies anyone.
 *
 * The route is in cloud.js (GET /cloud/sites/check).
 */

import { planPrepare, publicPlan, prepareSentence, withKilnTags, SETUP_COMMAND } from './prepare.js';

const GH = 'https://api.github.com';
const UA = 'kiln-cloud';
const INSTALL_URL = 'https://github.com/apps/kiln-cms/installations/new';
const CONFIG_FILE = 'assets/kiln-config.js';
const SIGN_IN_PAGE = 'kiln.html';
const HELP = 'info@kilncms.com';

/** How far a request to a customer's own address may go. */
export const LIMITS = { timeoutMs: 8000, redirects: 3, bodyBytes: 512 * 1024 };

const TITLES = {
  editing: 'Editing is switched on for this site',
  repository: 'Kiln can reach the repository',
  files: 'Kiln is in the repository',
  settings: 'The settings file names this service and this repository',
  address: 'The site\'s address answers',
  live: 'The live site loads Kiln',
  signin: 'The sign-in page answers',
  domain: 'The site\'s own domain is ready on Kiln\'s side',
};
const line = (id, ok, detail, more = {}) => ({ id, ok, title: TITLES[id], detail, ...more });
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const some = (list, total = list.length, most = 6) => list.slice(0, most).join(', ') + (total > most ? ` and ${total - most} more` : '');

// ─── The customer's own address, asked safely ─────────────────────────────────

/**
 * Why an address is not one this asks, or null when it may be asked:
 *   not_an_address  it does not read as a web address
 *   not_https       anything but https
 *   numbered        an IP address (the URL parser has already turned forms
 *                   such as 2130706433 and 0x7f.1 into dotted numbers)
 *   private         localhost, a name with no dot, or one ending in .local,
 *                   .internal or .localhost
 */
export function refusedAddress(address) {
  let u;
  try { u = new URL(address); } catch { return 'not_an_address'; }
  if (u.protocol !== 'https:') return 'not_https';
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[') || /^\d+(\.\d+){3}$/.test(host)) return 'numbered';
  if (host === 'localhost' || !host.includes('.') || /\.(local|internal|localhost)$/.test(host)) return 'private';
  return null;
}

const bare = (host) => host.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
/** The same site: the address itself or its www form, over https, on the same port. */
const sameSite = (a, b) => a.protocol === b.protocol && a.port === b.port && bare(a.hostname) === bare(b.hostname);

/** At most `limit` bytes of an answer, as text. `cut` says there was more. */
async function readSome(res, limit) {
  if (!res.body) return { text: '', cut: false };
  const reader = res.body.getReader();
  const parts = [];
  let size = 0, cut = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = limit - size;
    if (value.byteLength > room) { parts.push(value.subarray(0, room)); size = limit; cut = true; break; }
    parts.push(value);
    size += value.byteLength;
  }
  if (cut) { try { await reader.cancel(); } catch { /* it is not read any further either way */ } }
  const all = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { all.set(p, at); at += p.byteLength; }
  return { text: new TextDecoder().decode(all), cut };
}

/** One request, with its time limit. Redirects are not followed here. */
async function once(url, { read, timeoutMs }) {
  const stop = new AbortController();
  const SLOW = {};
  let timer;
  const late = new Promise((_, no) => { timer = setTimeout(() => { stop.abort(); no(SLOW); }, timeoutMs); });
  try {
    return await Promise.race([late, (async () => {
      // No cookie, no Authorization, nothing that says who is asking.
      const res = await fetch(url, { method: 'GET', redirect: 'manual', signal: stop.signal, headers: { 'User-Agent': 'kiln-cloud-check', Accept: 'text/html,*/*;q=0.8' } });
      const out = { status: res.status, url, location: res.headers.get('location') };
      if (read && res.status === 200) Object.assign(out, await readSome(res, LIMITS.bodyBytes));
      else { try { await res.body?.cancel(); } catch { /* nothing was going to be read */ } }
      return out;
    })()]);
  } catch (e) {
    return { problem: e === SLOW ? 'slow' : 'no_answer', url };
  } finally { clearTimeout(timer); }
}

/**
 * One page of the customer's site. Never throws. The answer is the last one
 * in the chain, { status, url, text?, cut? }, or { problem, url, to? }:
 *
 *   not_an_address, not_https, numbered, private   see refusedAddress: nothing was asked
 *   elsewhere   it redirects to another site (`to`), which is not followed
 *   too_many    more redirects than LIMITS.redirects
 *   slow        no answer within the time limit
 *   no_answer   the request failed
 */
export async function visit(address, { read = false, timeoutMs = LIMITS.timeoutMs } = {}) {
  const refused = refusedAddress(address);
  if (refused) return { problem: refused, url: address };
  const site = new URL(address);
  let at = site.href;
  for (let hop = 0; hop <= LIMITS.redirects; hop++) {
    const res = await once(at, { read, timeoutMs });
    if (res.problem || !(res.status >= 300 && res.status < 400 && res.location)) return res;
    let next;
    try { next = new URL(res.location, at); } catch { return res; }
    next.username = ''; next.password = ''; next.hash = '';
    if (refusedAddress(next.href) || !sameSite(next, site)) return { problem: 'elsewhere', url: at, to: next.origin };
    at = next.href;
  }
  return { problem: 'too_many', url: at };
}

// ─── The repository ───────────────────────────────────────────────────────────

const gh = (token, path, accept) => fetch(`${GH}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: accept || 'application/vnd.github+json', 'User-Agent': UA } });
const named = (text, key) => text.match(new RegExp(`\\b${key}\\s*:\\s*['"\`]([^'"\`]+)['"\`]`))?.[1] || null;
const sameService = (a, b) => { try { return new URL(a).origin === new URL(b).origin; } catch { return a === b; } };

/**
 * The settings file as the repository holds it: { path, text }, { missing } or
 * { failed }. A site a generator builds keeps it in a folder of its own
 * (public/assets, say), so the nearest file of that name is taken.
 */
async function readSettings(token, repo, plan) {
  try {
    const listing = await gh(token, `/repos/${repo}/git/trees/${plan.treeSha}?recursive=1`);
    if (!listing.ok) return { failed: true };
    const found = ((await listing.json()).tree || [])
      .filter(e => e.type === 'blob' && (e.path === CONFIG_FILE || e.path.endsWith(`/${CONFIG_FILE}`)))
      .filter(e => !e.path.split('/').some(d => d === 'node_modules' || d.startsWith('.')))
      .sort((a, b) => a.path.length - b.path.length)[0];
    if (!found) return { missing: true };
    const blob = await gh(token, `/repos/${repo}/git/blobs/${found.sha}`, 'application/vnd.github.raw');
    if (!blob.ok) return { failed: true };
    return { path: found.path, text: await blob.text() };
  } catch { return { failed: true }; }
}

/** Lines `repository` and `files`, from what planPrepare read. */
function repositoryLines(plan, { repo, installUrl, canAdd }) {
  if (plan.state === 'no_access') {
    return [
      line('repository', false, `The Kiln app is not installed on ${repo}, or it was removed, so Kiln cannot read or save anything there. Install it on that repository, then check again.`, { fix: { url: installUrl, label: 'Install the Kiln app' } }),
      line('files', null, 'Not checked, because Kiln cannot read the repository yet.'),
    ];
  }
  if (plan.state === 'github') {
    return [
      line('repository', null, 'Not checked: GitHub did not answer just now. Please check again in a minute.'),
      line('files', null, 'Not checked, because GitHub did not answer.'),
    ];
  }
  const reach = line('repository', true, `The Kiln app is installed on ${repo} and can read it.`);
  const shown = publicPlan(plan, { repo });
  if (plan.state === 'prepared') {
    const p = shown.pages;
    const left = p.skipped_count ? ` ${count(p.skipped_count, 'page was', 'pages were')} left out because Kiln could not read ${p.skipped_count === 1 ? 'it' : 'them'} as a web page: ${some(p.skipped.map(s => s.path), p.skipped_count)}.` : '';
    if (!p.already) return [reach, line('files', false, `Kiln's files are in ${repo}, but no page loads the editor.${left} To edit a page, add the two lines that load the editor to it by hand.`)];
    return [reach, line('files', true, `Kiln's files are in ${repo}, and ${p.already === 1 ? 'its one page loads' : `all ${p.already} of its pages load`} the editor.${left}`)];
  }
  if (plan.state === 'ready') {
    const p = shown.pages, add = shown.files.add;
    const said = [];
    if (p.add) said.push(`${count(p.add, 'page', 'pages')} out of ${p.total} ${p.add === 1 ? 'does' : 'do'} not have the two lines that load the editor: ${some(p.add_names, p.add)}.`);
    const t = shown.templates;
    if (t && t.add) said.push(`${count(t.add, 'page template does', 'page templates do')} not have them either, so a new page made from ${t.add === 1 ? 'it' : 'one'} would have no editor: ${some(t.add_names, t.add)}.`);
    if (add.length) said.push(`${add.length === 1 ? 'This file is' : 'These files are'} missing from ${repo}: ${some(add, add.length, 8)}.`);
    said.push(canAdd
      ? 'Press the button and Kiln shows you the change, then adds what is missing.'
      : 'Kiln can add what is missing once editing is switched back on for this site.');
    return [reach, line('files', false, said.join(' '), canAdd ? { fix: { action: 'prepare', label: 'Add Kiln to this site' } } : {})];
  }
  if (plan.state === 'built' || plan.state === 'too_big') {
    const why = plan.state === 'built'
      ? `This site is built by ${plan.generator || 'a site generator'} before it is published, so its pages are made from other files and Kiln cannot tell from the repository whether each page loads the editor.`
      : 'This site has more pages than Kiln reads from here.';
    return [reach, line('files', null, `Not checked. ${why} The setup tool handles a site like this: run it in the site's folder. The lines about the live site below still say whether the published pages load Kiln.`, { command: SETUP_COMMAND })];
  }
  // no_pages, empty: there is nothing here to add Kiln to yet.
  return [reach, line('files', false, prepareSentence(plan.state, { repo }))];
}

/** Line `settings`. */
async function settingsLine(plan, { token, repo, worker, hosted = false }) {
  if (plan.state === 'no_access' || plan.state === 'github') return line('settings', null, 'Not checked, because Kiln could not read the repository.');
  if (!plan.treeSha) return line('settings', null, 'Not checked, because the repository has no files yet.');
  const file = await readSettings(token, repo, plan);
  if (file.failed) return line('settings', null, 'Not checked: GitHub did not answer just now. Please check again in a minute.');
  if (file.missing) {
    const how = plan.state === 'built' || plan.state === 'too_big' ? 'The setup tool writes it.' : 'It is added along with Kiln\'s other files (the line above).';
    return line('settings', null, `Not checked, because the settings file (${CONFIG_FILE}) is not in the repository yet. ${how}`);
  }
  const theirWorker = named(file.text, 'worker'), theirRepo = named(file.text, 'repo');
  const wrong = [];
  if (!theirWorker) wrong.push(`It has no worker line. Add one that reads worker: '${worker}'.`);
  else if (!sameService(theirWorker, worker)) wrong.push(`Its worker line names another sign-in service, ${theirWorker}. Change that line to worker: '${worker}'.`);
  if (!theirRepo) wrong.push(`It has no repo line. Add one that reads repo: '${repo}'.`);
  else if (theirRepo.toLowerCase() !== String(repo).toLowerCase()) wrong.push(`Its repo line names another repository, ${theirRepo}. Change that line to repo: '${repo}'.`);
  if (!wrong.length) return line('settings', true, `${file.path} names this service (${worker}) and this repository (${repo}).`);
  const where = `https://github.com/${repo}/edit/${String(plan.branch).split('/').map(encodeURIComponent).join('/')}/${file.path.split('/').map(encodeURIComponent).join('/')}`;
  return line('settings', false, `The settings file (${file.path}) needs a change. ${wrong.join(' ')} ${hosted ? 'Save the file. Kiln publishes it in a few seconds. Then check again.' : 'Save the file, wait for your host to publish it, and check again.'}`, { fix: { url: where, label: 'Open the settings file on GitHub' } });
}

// ─── The live site ────────────────────────────────────────────────────────────

const seconds = (ms) => count(ms / 1000, 'second', 'seconds');
/** What went wrong asking for `what` (an address), as a sentence. */
function problemSentence(res, what, timeoutMs) {
  switch (res.problem) {
    case 'slow': return `${what} did not answer within ${seconds(timeoutMs)}.`;
    case 'no_answer': return `${what} did not answer at all.`;
    case 'elsewhere': return `${what} sends visitors on to ${res.to}, which is a different address, and Kiln does not follow them there.`;
    case 'too_many': return `${what} sent Kiln from one address to the next more than ${LIMITS.redirects} times without showing a page.`;
    default: return `${what} answered with an error (${res.status}).`;
  }
}

/** Line `address`, from the answer to the home page. */
function addressLine(home, base, timeoutMs, hosted = false, ownDomain = false) {
  if (home.status === 200) return line('address', true, !hosted ? `${base} answers.` : ownDomain ? `${base} answers. That is this site's own domain, and Kiln's hosting answers there.` : `${base} answers. That is the address Kiln's hosting gave this site.`);
  const open = { fix: { url: base, label: 'Open your site' } };
  const said = problemSentence(home, base, timeoutMs);
  // The address is Kiln's own and so is the host: there is nothing for the
  // owner to look at anywhere else, and publishing again is what puts it right.
  // Its own domain, live on Kiln's hosting: what the owner can have changed is where its name servers point.
  if (hosted && ownDomain) return line('address', false, `${said} That is this site's own domain, which is live on Kiln's hosting. If you changed its name servers away from Kiln, change them back where you bought the domain. If you did not, press Publish again on the site's row and check again in a minute. If it still does not answer, write to ${HELP}.`, open);
  if (hosted) return line('address', false, `${said} That is the address Kiln's hosting gave this site, so there is nothing for you to change at a host. Press Publish again on the site's row and check again in a minute. If it still does not answer, write to ${HELP}.`, open);
  switch (home.problem) {
    case 'not_an_address': return line('address', false, `This site was added with "${base}", which is not a full web address, so Kiln cannot look at it. Write to ${HELP} and we will change the address.`);
    case 'not_https': return line('address', false, `This site was added with the address ${base}. Kiln only looks at addresses that start with https://, so it did not ask this one. If your site answers at an https:// address, write to ${HELP} and we will change it.`);
    case 'numbered': return line('address', false, `This site was added with the address ${base}, which is a number and not a name on the public web, so Kiln does not look at it. Write to ${HELP} and we will change it to the site's own name.`);
    case 'private': return line('address', false, `This site was added with the address ${base}, which only works on your own computer or network, so Kiln cannot look at it from here. Write to ${HELP} and we will change it to the address your visitors use.`);
    case 'elsewhere': return line('address', false, `${said} If your site has moved to that address, write to ${HELP} and we will change it.`, open);
    case 'too_many': return line('address', false, `${said} Open the address in your browser to see where it ends up, and look at the forwarding rules at your host.`, open);
    case 'slow': return line('address', false, `${said} Open it in your browser. If it opens there, check again in a minute. If it does not, your host is where to look.`, open);
    case 'no_answer': return line('address', false, `${said} Check that the address is spelled right and that the site is published at your host.`, open);
    default: return line('address', false, `${said} Kiln could not look at the page. Open it in your browser to see what your visitors see. If it opens for you, your host may be turning away visits that do not come from a browser, and the lines below cannot be checked from here.`, open);
  }
}

const NOT_PUBLISHED = 'Your host has not published the change yet, or it publishes from another repository or branch. Wait a minute or two and check again. If nothing changes, look at which repository and branch your host publishes from.';
/** The same for a site on Kiln's hosting, where Kiln is the one that publishes. */
const NOT_PUBLISHED_BY_KILN = 'Kiln has not published the change yet. Press Publish again on the site\'s row, wait a few seconds, and check again.';
const KILN_SRC = /<script\b[^>]*\bsrc=["']([^"']*\bkiln\.js(?:\?[^"']*)?)["']/i;

/** Lines `live` and `signin`. */
async function liveLines(home, base, plan, timeoutMs, hosted = false) {
  const notPublished = hosted ? NOT_PUBLISHED_BY_KILN : NOT_PUBLISHED;
  if (home.status !== 200) {
    const why = 'Not checked, because the site\'s address did not answer with a page.';
    return [line('live', null, why), line('signin', null, why)];
  }
  const inRepo = plan.state === 'prepared';
  const builtElsewhere = plan.state === 'built' || plan.state === 'too_big';
  const next = inRepo ? notPublished
    : builtElsewhere ? 'Run the setup tool in the site\'s folder, publish the site, and check again.'
    : hosted ? 'Add Kiln to the repository first (see the line about the repository above). Kiln publishes it in a few seconds. Then check again.'
    : 'Add Kiln to the repository first (see the line about the repository above), wait for your host to publish it, and check again.';
  const loads = withKilnTags(home.text || '').state === 'already';

  // Where the page says the editor is, when that is on this site; else where Kiln puts it.
  let asset = `${base}/assets/kiln.js`;
  if (loads) {
    try {
      const src = new URL(home.text.match(KILN_SRC)[1], home.url);
      src.hash = '';
      if (sameSite(src, new URL(base)) && !refusedAddress(src.href)) asset = src.href;
    } catch { /* the usual place */ }
  }
  const signInAt = `${base}/kiln`;
  const [file, signIn] = await Promise.all([
    loads ? visit(asset, { timeoutMs }) : null,
    visit(signInAt, { timeoutMs }),
  ]);

  let live;
  if (loads && file.status === 200) live = line('live', true, `The home page at ${base} loads Kiln, and the editor's file (${asset}) answers.`);
  else if (loads) live = line('live', false, `The home page at ${base} asks for the editor's file, but ${problemSentence(file, asset, timeoutMs)} ${inRepo ? `The file is in your repository. ${notPublished}` : next}`);
  else if (home.cut) live = line('live', null, `Not checked. The home page at ${base} is larger than ${LIMITS.bodyBytes / 1024} KB. Kiln reads only the first ${LIMITS.bodyBytes / 1024} KB of a page, and the line that loads the editor was not in that part, so it cannot say whether the page loads Kiln.`);
  else live = line('live', false, `${inRepo ? `Kiln is in your repository, but the home page at ${base} does not load it yet.` : `The home page at ${base} does not load Kiln.`} ${next}`);

  let signin;
  if (signIn.status === 200) signin = line('signin', true, `The sign-in page is at ${signInAt}. Open it to sign in and edit.`);
  else {
    const has = inRepo || (plan.files && plan.files.kept.includes(SIGN_IN_PAGE));
    signin = line('signin', false, `${problemSentence(signIn, `The sign-in page at ${signInAt}`, timeoutMs)} ${has ? `The page (${SIGN_IN_PAGE}) is in your repository. ${notPublished}` : builtElsewhere ? next : `The page (${SIGN_IN_PAGE}) is not in your repository yet. ${next}`}`);
  }
  return [live, signin];
}

// ─── A site whose files Kiln keeps ────────────────────────────────────────────

const KEPT_FILES = "your site's files";
const KEPT_UNREAD = `Not checked, because Kiln could not read ${KEPT_FILES} just now. Please check again in a minute.`;
const KEPT_WRITE_IN = 'Write to info@kilncms.com and say which site it is, and a person will put it right.';

/**
 * The list for a site whose files Kiln keeps (keeps.js). Its owner has never
 * seen a repository or GitHub and can change nothing there, and Kiln's own
 * organization always has the app. So the line about installing the app is
 * left out, no line sends the person to GitHub, and where a sentence says
 * "repository", or names it, it says "your site's files". `unread`: Kiln
 * could not read the files this time, which the left-out line would have said.
 * Only the lines of a kept site come through here: every other site's
 * sentences are untouched.
 */
function keptLines(checks, { repo, unread }) {
  const say = (s) => String(s)
    .split(` and this repository (${repo}).`).join(` and ${KEPT_FILES}.`)
    .split(`Kiln's files are in ${repo}`).join(`Kiln's files are among ${KEPT_FILES}`)
    .split('the repository has no files yet').join('your site has no files yet')
    .split('To edit a page, add the two lines that load the editor to it by hand.').join(KEPT_WRITE_IN)
    .split(String(repo)).join(KEPT_FILES)
    .replace(/\b(?:the|this|that|your) repository\b/g, KEPT_FILES)
    .replace(/\bGitHub did not answer(?: just now)?/g, `Kiln could not read ${KEPT_FILES} just now`);
  return checks.filter(c => c.id !== 'repository').map((c) => {
    const out = { ...c, title: say(c.title) };
    const toGitHub = !!(c.fix && c.fix.url && /^https:\/\/github\.com\//.test(c.fix.url));
    if (toGitHub) delete out.fix;
    if (unread && (c.id === 'files' || c.id === 'settings')) out.detail = KEPT_UNREAD;
    else if (toGitHub && c.id === 'settings') out.detail = `${String(c.detail).split(' needs a change.')[0]} needs a change that only Kiln can make. ${KEPT_WRITE_IN}`;
    else out.detail = say(c.detail);
    return out;
  });
}

// ─── The whole list ───────────────────────────────────────────────────────────

/**
 * The checklist for one site. Reads the repository (with the App's `token`
 * for it; none means the App is not installed) and the live site at `origin`.
 * Writes nothing and never throws: whatever goes wrong becomes a line.
 * `worker` is this service's own address, which the settings file should
 * name. `canAdd` false means editing is switched off for the site, so the
 * "Add Kiln to this site" action is not offered.
 *
 * A site on Kiln's hosting: `origin` is then the address the hosting gave it
 * and `hosted` is true, so the lines say that Kiln publishes a change and
 * never send its owner to "your host". When that site is not online (it was
 * taken down, or has not gone up yet) `down` is the sentence that says why:
 * no address is asked for anything, and the three lines about the live site
 * say that instead. A hosted site whose own domain is live is looked at
 * there: `origin` is then the domain and `ownDomain` is true, so the line
 * about the address says whose address it is.
 *
 * A site whose files Kiln keeps: `kept` is true, and the list is worded for a
 * person who has never seen a repository (keptLines, above). Nothing changes
 * for any other site.
 */
export async function checkSite({ token, repo, origin, worker, installUrl = INSTALL_URL, canAdd = true, timeoutMs = LIMITS.timeoutMs, hosted = false, ownDomain = false, down = null, kept = false }) {
  const checks = [];
  let unread = false;   // Kiln could not read the files this time
  try {
    let base = String(origin || '');
    try { base = new URL(base).origin === 'null' ? base : new URL(base).origin; } catch { /* said in the address line */ }
    const [plan, home] = await Promise.all([
      token ? planPrepare({ token, repo, worker }).catch(() => ({ state: 'github' })) : { state: 'no_access' },
      down ? null : visit(`${base}/`, { read: true, timeoutMs }),
    ]);
    unread = plan.state === 'no_access' || plan.state === 'github';
    checks.push(...repositoryLines(plan, { repo, installUrl, canAdd }));
    checks.push(await settingsLine(plan, { token, repo, worker, hosted: hosted || !!down }));
    if (down) {
      const why = 'Not checked, because the site is not online.';
      checks.push(line('address', false, String(down)), line('live', null, why), line('signin', null, why));
    } else {
      checks.push(addressLine(home, base, timeoutMs, hosted, hosted && ownDomain));
      checks.push(...await liveLines(home, base, plan, timeoutMs, hosted));
    }
  } catch (e) {
    console.warn(JSON.stringify({ evt: 'site_check_failed', repo, detail: String(e?.message || e).slice(0, 200) }));
    for (const id of ['repository', 'files', 'settings', 'address', 'live', 'signin']) {
      if (!checks.some(c => c.id === id)) checks.push(line(id, null, 'Not checked: Kiln could not finish this check just now. Please check again in a minute.'));
    }
  }
  return kept ? keptLines(checks, { repo, unread }) : checks;
}

/**
 * The line that goes at the top when editing is switched off for a site: why,
 * and which of the row's own buttons switches it back on.
 */
/**
 * Line `domain`, for a hosted site whose own domain still waits for its name
 * servers: the check goes on looking at the address the hosting gave the
 * site, and this line says what the domain waits for. `seller` is the name of
 * the company the domain was bought from, when Kiln knows it.
 */
export function domainWaitingLine({ name, seller = null }) {
  return line('domain', true, `${name} is ready on Kiln's side and waits for its name servers to be changed at ${seller || 'the company you bought the domain from'}. The site's row in the dashboard shows the two names to enter there. Until then, this check looks at the address Kiln's hosting gave the site.`);
}

export function editingOffLine({ status, subscribed }) {
  if (status === 'past_due') {
    return line('editing', false, 'Editing is switched off for this site, because a payment did not go through. Update your card under Manage billing to switch it back on. Your site and its files are untouched.', { fix: { action: 'portal', label: 'Manage billing' } });
  }
  return line('editing', false, `Editing is switched off for this site, because ${subscribed ? 'its plan has ended' : 'its free trial has ended'}. Subscribe to switch it back on. Your site and its files are untouched. The rest of this list still says how the site is set up.`, { fix: { action: 'subscribe', label: 'Subscribe' } });
}
