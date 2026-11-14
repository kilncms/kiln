/**
 * A site on Kiln's hosting looks after itself.
 *
 * The Kiln Cloud + hosting plan promises that nobody has anything to press:
 * choosing it adds Kiln to the site, marks a first pass of what can be edited,
 * and keeps the editor current. The three buttons of the dashboard do those
 * things one at a time (prepare.js, firstpass.js, update.js). This file runs
 * the same plans by itself, at two moments:
 *
 *   lookAfter           when a site is first put on Kiln's hosting, before its
 *                       first copy is made (cloud.js, POST /cloud/sites/hosting):
 *                       Kiln's files, the line of the settings file that gives a
 *                       suggestion a preview of its own, a character set on
 *                       every page, a first pass
 *   setPreviews         every five minutes (hosted.js, sweepHosting): a site that
 *                       was hosted before Kiln wrote that line is given it, once
 *   keepEditorsCurrent  every five minutes (hosted.js, sweepHosting): the
 *                       editor of a hosted site is brought up to the released one
 *
 * Nothing here stops a site from being hosted. A step that cannot be done is
 * reported with the reason and the next step is tried.
 *
 * A step that was not done is still owed, and a note says so (`hostowed:`).
 * While the note is there, the owner publishing the site again tries the
 * steps again (cloud.js), and the five-minute job tries them by itself when
 * the reason is one that can pass without anyone doing anything: GitHub or
 * the release did not answer, or the repository moved meanwhile (finishCare).
 * A reason only the owner can change, such as a protected branch, waits for
 * the owner. Either way the change is the one the owner asked for when they
 * put the site on Kiln's hosting, so it is made in their name.
 *
 * The character set is the one step that has no button. Kiln's hosting serves
 * a page as `text/html` and names no character set, so a page has to name its
 * own, or a browser may show é and curly quotes as other letters.
 *
 * KV:
 *   carelock:<site id>  '1'           one look-after at a time for a site (TTL 5 min)
 *   hostcare:<site id>  {at,steps}    how the last look-after went, for the dashboard (TTL 30 days)
 *   hostowed:<site id>  {at,tries,codes,author,worker}   a step is still owed, and whose request it was (TTL 14 days)
 *   hostupd:<site id>   a time        this site's editor was looked at for an update (TTL 24 hours)
 *   pvset:<site id>     a time        this site's settings file was looked at for its preview line
 *                                     (kept for good once the line is settled, 24 hours when it could not be written)
 */

import { planPrepare, applyPrepare, prepareSentence, PrepareError, readPages, commitChange, MAX_PAGES, readSettingsFile, withPreview } from './prepare.js';
import { previewPattern } from './hosting.js';
import { planFirstPass, applyFirstPass, firstPassSentence } from './firstpass.js';
import { planUpdate, applyUpdate, rememberLatest, noteRepoBuild, releasedBuild, knownSince } from './update.js';

const LOCK_S = 300;
const KEPT_S = 30 * 24 * 3600;
const DAY_S = 24 * 3600;
const SETTLE_MS = DAY_S * 1000;     // hosted sites take a released editor once the service has known it this long
const UPDATES_A_RUN = 2;            // sites one run looks at for a newer editor, at most
const OWED_S = 14 * DAY_S;          // how long a step that was not done stays owed
const OWED_TRIES = 8;               // the job tries this often by itself: about a day in all, then it waits for the owner
const OWED_WAIT_MS = 10 * 60 * 1000;                 // ten minutes after the first failure, then twice as long each time,
const OWED_WAIT_MAX_MS = 6 * 3600 * 1000;            // six hours at the most
// Reasons that can pass by themselves. Every other reason waits for the owner.
const PASSING = new Set(['github', 'moved', 'release']);
const UPDATE_SCAN = 20;             // sites one run asks about (was it looked at today?), at most

const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const names = (paths) => `${paths.slice(0, 6).join(', ')}${paths.length > 6 ? `, and ${paths.length - 6} more` : ''}`;

// ─── The character set ────────────────────────────────────────────────────────

export const CHARSET_TAG = '<meta charset="utf-8">';
// <meta charset=…>, and <meta http-equiv="Content-Type" content="…; charset=…"> alike.
const DECLARES = /<meta\b[^>]*\bcharset\s*=/i;
const HEAD = /<head(?:\s[^>]*)?>/i;
const COMMENT = /<!--[\s\S]*?(?:-->|$)/g;

/**
 * A page that says which character set it is written in. One that says so
 * already is returned as it is ('already'): a <meta charset=…>, a
 * <meta http-equiv="Content-Type" content="…charset=…">, or a byte order mark
 * at the very top. Otherwise the line goes in as the first thing inside
 * <head> ('added'); a page with no <head> cannot be done ('no-head'). Nothing
 * is ever removed or moved: the page that comes back is the page that went
 * in, with one insertion at most. What is inside a comment does not count.
 */
export function withCharset(html) {
  if (html.charCodeAt(0) === 0xFEFF) return { html, state: 'already' };
  // Comments are blanked, not cut, so every position stays where it was.
  const seen = html.replace(COMMENT, c => ' '.repeat(c.length));
  if (DECLARES.test(seen)) return { html, state: 'already' };
  const head = HEAD.exec(seen);
  if (!head) return { html, state: 'no-head' };
  const at = head.index + head[0].length;
  // <head> at the end of its line: the new line takes the next line's indentation.
  const next = /^(\r?\n)([ \t]*)(?=\S)/.exec(html.slice(at, at + 400));
  return { html: html.slice(0, at) + (next ? next[1] + next[2] : '') + CHARSET_TAG + html.slice(at), state: 'added' };
}

/**
 * Read the site's pages (the same pages adding Kiln reads) and work out which
 * would be given a character set. Writes nothing. `state` is 'ready' (some
 * page needs one), 'nothing', or one of readPages' reasons the pages were not
 * read. `pages.noHead` names the pages that say none and have no <head>.
 * `read` is what readPages answered, when the caller has read the pages already.
 */
export async function planCharset({ token, repo, read = null }) {
  const site = read || await readPages({ token, repo });
  if (site.state !== 'ok') return site;
  const changes = [], noHead = [];
  let already = 0;
  for (const f of site.files) {
    const out = withCharset(f.text);
    if (out.state === 'already') already++;
    else if (out.state === 'no-head') noHead.push(f.path);
    else changes.push({ path: f.path, mode: f.mode, text: out.html });
  }
  // Page templates that are whole pages (prepare.js: readPages): a new page is
  // made from one, so a template that names no character set makes pages that
  // name none. Kept apart from the pages, and called templates when spoken of.
  const templates = { changes: [], already: 0, noHead: [] };
  for (const f of site.templates || []) {
    const out = withCharset(f.text);
    if (out.state === 'already') templates.already++;
    else if (out.state === 'no-head') templates.noHead.push(f.path);
    else templates.changes.push({ path: f.path, mode: f.mode, text: out.html });
  }
  return {
    branch: site.branch, head: site.head, treeSha: site.treeSha,
    state: changes.length || templates.changes.length ? 'ready' : 'nothing',
    pages: { total: site.total, already, noHead, skipped: site.skipped },
    changes,
    templates,
  };
}

/**
 * Give the pages of a `ready` plan their character set: one commit, or a
 * PrepareError and nothing changed. `asked` ends the commit's message: how
 * the owner came to ask for it.
 */
export async function applyCharset({ token, repo, plan, author, asked = "when the site went on Kiln's hosting" }) {
  const templates = plan.templates?.changes || [];
  const n = plan.changes.length, t = templates.length;
  const tplSays = t ? `${count(t, 'page template now says so too', 'page templates now say so too')}, so a new page made from ${t === 1 ? 'it' : 'one'} reads as it should. ` : '';
  const message = `Say which character set each page is written in\n\n${n || !t ? `${count(n, 'page now says it is', 'pages now say they are')} written in UTF-8 (${CHARSET_TAG}, first in the head). ${tplSays}` : `${count(t, 'page template now says it is', 'page templates now say they are')} written in UTF-8 (${CHARSET_TAG}, first in the head), so a new page made from ${t === 1 ? 'it' : 'one'} reads as it should. `}`
    + `Kiln's hosting does not say this for a page, and without it a browser can show accented letters and curly quotes as other letters. Added for ${author.name} ${asked} (via Kiln)`;
  const commit = await commitChange({ token, repo, branch: plan.branch, head: plan.head, treeSha: plan.treeSha, texts: [...plan.changes, ...templates], message, author });
  return { ...commit, pages: n, templates: t };
}

/**
 * What the dashboard is shown of a character-set plan that could be made
 * ('ready' or 'nothing'): numbers, names and one sentence to show as it is,
 * never a page's text. For "Add Kiln to this site" on a site Kiln hosts
 * (cloud.js, /cloud/sites/prepare). `done` says the line has just been added.
 */
export function publicCharset(plan, { done = false } = {}) {
  const pages = plan.changes.length;
  const templates = plan.templates?.changes.length || 0;
  const noHead = [...plan.pages.noHead, ...(plan.templates?.noHead || [])];
  const what = [pages ? count(pages, 'page', 'pages') : '', templates ? count(templates, 'page template', 'page templates') : ''].filter(Boolean).join(' and ');
  const one = pages + templates === 1;
  let sentence;
  if (!what) sentence = 'Every page that can say which character set it is written in already says so.';
  else if (done) sentence = `${what} now ${one ? 'says' : 'say'} which character set ${one ? 'it is' : 'they are'} written in.`;
  else sentence = `${what} ${one ? 'does' : 'do'} not say which character set ${one ? 'it is' : 'they are'} written in. Kiln's hosting does not say it for a page, so letters such as é and curly quotes can show as other letters. Kiln will add the line ${CHARSET_TAG} at the top of the head of each.`;
  if (noHead.length) sentence += ` ${count(noHead.length, 'file has', 'files have')} no head for the line to go in, and ${noHead.length === 1 ? 'is' : 'are'} left as ${noHead.length === 1 ? 'it is' : 'they are'}: ${names(noHead)}.`;
  return {
    state: done ? 'done' : plan.state,
    pages, page_names: plan.changes.slice(0, 12).map(c => c.path),
    templates, template_names: (plan.templates?.changes || []).slice(0, 12).map(c => c.path),
    no_head: noHead.slice(0, 20),
    sentence,
  };
}

/** The sentences that differ from adding Kiln; the rest are prepareSentence's. */
export function charsetSentence(code, { repo = 'the repository', generator = '', branch = 'main' } = {}) {
  switch (code) {
    case 'built': return `This site is built by ${generator || 'a site generator'} before it is published, so its pages are made from other files, and Kiln does not change those from here. If letters such as é show wrongly on the hosted site, add ${CHARSET_TAG} to the top of the head in the site's layout.`;
    case 'too_big': return `This site has more than ${MAX_PAGES} pages, which is more than Kiln changes from here, so its pages were left as they are.`;
    case 'protected': return `The ${branch} branch of ${repo} does not take a direct change (it is protected), so Kiln could not add the line to its pages. Nothing was changed.`;
    case 'moved': return 'The repository changed while Kiln was working on it, so the pages were left as they are.';
    case 'github': return 'GitHub did not answer just now, so the pages were left as they are.';
    default: return prepareSentence(code, { repo, generator, branch });
  }
}

// ─── When a site is first put on Kiln's hosting ───────────────────────────────

// Why the pages of a repository could not be read at all. The next step would
// read them again and be told the same, so it is not asked.
const UNREAD = new Set(['no_access', 'github', 'empty', 'built', 'no_pages', 'too_big']);

/**
 * Get a site ready for Kiln's hosting, before its first copy: Kiln's files,
 * a character set on every page, and a first pass at what can be edited. Each
 * is its own commit in the owner's name (`author`), made only when there is
 * something to do. Returns one line per step:
 *
 *   { step: 'kiln' | 'charset' | 'marks', state: 'done' | 'nothing' | 'not_done', detail, commit?, code?, left? }
 *
 * `detail` is a sentence for the site's owner, `commit` is { sha, url } when
 * one was made, `code` says why a step was not done, and `left` names pages
 * the character set could not be added to. Never throws. Returns null when
 * another look-after of the same site is running.
 *
 * `firstpassAt` is the site's `firstpass_at` (a first pass is made once), and
 * `record.prepared(sha)` / `record.firstPass(sha)` write down what the two
 * buttons write down (cloud.js keeps the `sites` table).
 */
export async function lookAfter(env, { site, token, author, worker, firstpassAt = null, record = {}, tries = 0 }) {
  const repo = site.repo;
  const lock = `carelock:${site.id}`;
  try {
    if (await env.KILN.get(lock)) return null;
    await env.KILN.put(lock, '1', { expirationTtl: LOCK_S });
  } catch { /* without the lock the commits still cannot collide: each moves the branch only from the commit it read */ }

  const steps = [];
  let unread = null;        // a plan that says the pages cannot be read
  let shut = null;          // the branch that took no direct change
  const made = (done) => ({ sha: done.sha, url: done.url });
  const failed = (step, e, sentence) => {
    const code = e instanceof PrepareError ? e.code : 'github';
    console.warn(JSON.stringify({ evt: 'lookafter_failed', step, repo, code, detail: e instanceof PrepareError ? e.detail : String(e?.message || e).slice(0, 200) }));
    return { step, state: 'not_done', code, detail: sentence(code) };
  };
  const noted = async (fn, sha) => { try { if (typeof fn === 'function') await fn(sha); } catch { /* the repository holds the change all the same */ } };

  try {
    // 1. Kiln's files, and the two lines on each page.
    let plan = null;
    const kilnSays = (code) => prepareSentence(code, { repo, generator: plan?.generator, branch: plan?.branch || undefined });
    try {
      plan = await planPrepare({ token, repo, worker });
      if (plan.state === 'prepared') {
        await noted(record.prepared, null);
        steps.push({ step: 'kiln', state: 'nothing', detail: 'Kiln was already on this site.' });
      } else if (plan.state !== 'ready') {
        if (UNREAD.has(plan.state)) unread = plan;
        steps.push({ step: 'kiln', state: 'not_done', code: plan.state, detail: kilnSays(plan.state) });
      } else {
        const done = await applyPrepare({ token, repo, worker, plan, author, ...(env.KILN_RELEASE_BASE ? { releaseBase: env.KILN_RELEASE_BASE } : {}) });
        await noted(record.prepared, done.sha);
        steps.push({ step: 'kiln', state: 'done', commit: made(done), detail: `Kiln added its files to ${repo}${done.pages ? `, and ${count(done.pages, 'page now loads', 'pages now load')} the editor` : ''}${done.layouts ? `, and ${count(done.layouts, 'layout file now loads', 'layout files now load')} the editor` : ''}.${done.templates ? ` ${count(done.templates, 'page template now loads', 'page templates now load')} the editor too, so a new page made from ${done.templates === 1 ? 'it' : 'one'} can be edited.` : ''}` });
      }
    } catch (e) {
      const line = failed('kiln', e, kilnSays);
      if (line.code === 'protected') shut = plan?.branch || 'main';
      steps.push(line);
    }

    // 2. The line of the settings file that gives a suggestion a preview of its own.
    // Not for a site Astro builds: a suggestion's branch holds source there, not pages, so it gets no preview.
    const previews = plan?.astro || /^astro_/.test(plan?.state || '') ? null : await previewsStep(env, { site, token, author, shut });
    if (previews) {
      steps.push(previews);
      await markPreviews(env, site.id, previews);
    }

    // 3. A character set on every page that names none.
    plan = null;
    const charsetSays = (code) => charsetSentence(code, { repo, generator: (plan || unread)?.generator, branch: shut || plan?.branch || undefined });
    try {
      if (unread) steps.push({ step: 'charset', state: 'not_done', code: unread.state, detail: charsetSays(unread.state) });
      else if (shut) steps.push({ step: 'charset', state: 'not_done', code: 'protected', detail: charsetSays('protected') });
      else {
        plan = await planCharset({ token, repo });
        const noHead = plan.pages?.noHead || [], tplNoHead = plan.templates?.noHead || [];
        const left = [...noHead, ...tplNoHead];
        const leftOf = (list, one, many) => (list.length ? `${count(list.length, one, many)} no <head> and ${list.length === 1 ? 'was' : 'were'} left as ${list.length === 1 ? 'it is' : 'they are'}: ${names(list)}.` : '');
        const leftSays = [leftOf(noHead, 'page has', 'pages have'), leftOf(tplNoHead, 'page template has', 'page templates have')].filter(Boolean).join(' ');
        if (plan.state === 'ready') {
          const done = await applyCharset({ token, repo, plan, author });
          steps.push({ step: 'charset', state: 'done', commit: made(done), ...(left.length ? { left } : {}),
            detail: (done.pages || !done.templates
              ? `${count(done.pages, 'page now says which character set it is', 'pages now say which character set they are')} written in, so every letter shows as it should.${done.templates ? ` ${count(done.templates, 'page template now says so too', 'page templates now say so too')}, so a new page made from ${done.templates === 1 ? 'it' : 'one'} reads as it should.` : ''}`
              : `${count(done.templates, 'page template now says which character set it is', 'page templates now say which character set they are')} written in, so a new page made from ${done.templates === 1 ? 'it' : 'one'} shows every letter as it should.`)
              + (leftSays ? ` ${leftSays}` : '') });
        } else if (plan.state === 'nothing' && left.length) {
          steps.push({ step: 'charset', state: 'not_done', code: 'no_head', left, detail: `${leftSays} A page says which character set it is written in inside its <head>, so Kiln could not add that.` });
        } else if (plan.state === 'nothing') {
          steps.push({ step: 'charset', state: 'nothing', detail: 'Every page already says which character set it is written in.' });
        } else {
          if (UNREAD.has(plan.state)) unread = plan;
          steps.push({ step: 'charset', state: 'not_done', code: plan.state, detail: charsetSays(plan.state) });
        }
      }
    } catch (e) {
      const line = failed('charset', e, charsetSays);
      if (line.code === 'protected') shut = plan?.branch || 'main';
      steps.push(line);
    }

    // 4. A first pass at what can be edited, once for a site.
    plan = null;
    const marksSay = (code) => firstPassSentence(code, { generator: (plan || unread)?.generator }) || prepareSentence(code, { repo, generator: (plan || unread)?.generator, branch: shut || plan?.branch || undefined });
    try {
      if (firstpassAt) steps.push({ step: 'marks', state: 'nothing', detail: 'A first pass at what can be edited was already made on this site.' });
      // A site Astro builds is marked from the dashboard, where its owner sees first what would move out of the templates.
      else if (unread && unread.state === 'built' && (unread.kind === 'astro' || /astro/i.test(String(unread.generator || '')))) steps.push({ step: 'marks', state: 'nothing', code: 'astro_button', detail: 'On a site Astro builds, Kiln does not mark text by itself. Press Mark what can be edited on this row: Kiln shows first how much of the text in your templates it can take, and moves it when you say.' });
      else if (unread) steps.push({ step: 'marks', state: 'not_done', code: unread.state, detail: marksSay(unread.state) });
      else if (shut) steps.push({ step: 'marks', state: 'not_done', code: 'protected', detail: marksSay('protected') });
      else {
        plan = await planFirstPass({ token, repo });
        if (plan.state === 'nothing') {
          await noted(record.firstPass, null);
          steps.push({ step: 'marks', state: 'nothing', detail: 'Kiln found nothing more to mark as editable on this site.' });
        } else if (plan.state !== 'ready') {
          steps.push({ step: 'marks', state: 'not_done', code: plan.state, detail: marksSay(plan.state) });
        } else {
          const done = await applyFirstPass({ token, repo, plan, author });
          await noted(record.firstPass, done.sha);
          steps.push({ step: 'marks', state: 'done', commit: made(done), detail: `Kiln marked a first pass of what can be edited on ${count(done.pages, 'page', 'pages')}. Any of it can be made plain again in the editor.` });
        }
      }
    } catch (e) { steps.push(failed('marks', e, marksSay)); }
  } finally {
    try { await env.KILN.delete(lock); } catch { /* it runs out by itself in five minutes */ }
  }
  try { await env.KILN.put(`hostcare:${site.id}`, JSON.stringify({ at: Date.now(), steps }), { expirationTtl: KEPT_S }); } catch { /* the answer to this request still says it */ }
  // What was not done is still owed; when everything is done nothing is.
  const codes = steps.filter(s => s.state === 'not_done').map(s => s.code || 'github');
  try {
    if (codes.length) await env.KILN.put(owedKey(site.id), JSON.stringify({ at: Date.now(), tries, codes, author: { name: author.name, email: author.email }, worker }), { expirationTtl: OWED_S });
    else await env.KILN.delete(owedKey(site.id));
  } catch { /* the owner publishing again before the site has been up still tries the steps */ }
  return steps;
}

const owedKey = (siteId) => `hostowed:${siteId}`;

/** The note that a step is still owed for a site ({ at, tries, codes, author, worker }), or null. Never throws. */
export async function careOwed(env, siteId) {
  try {
    const n = await env.KILN.get(owedKey(siteId), 'json');
    const whole = n && Array.isArray(n.codes) && n.codes.length && typeof n.author?.name === 'string' && n.author.name
      && typeof n.author?.email === 'string' && /^https:\/\/[^\s/]+$/.test(String(n.worker || ''));
    return whole ? { at: Number(n.at) || 0, tries: Number(n.tries) || 0, codes: n.codes.map(String), author: { name: n.author.name, email: n.author.email }, worker: n.worker } : null;
  } catch { return null; }
}

/** When the job may try an owed step again: ten minutes after the last try, then twice as long each time, six hours at most. */
export const owedDue = (note) => note.at + Math.min(OWED_WAIT_MAX_MS, OWED_WAIT_MS * 2 ** note.tries);

/**
 * The five-minute job's part in what is owed: for ONE hosted site whose note
 * names a reason that can pass by itself, and whose wait is over, the steps
 * are tried again as the owner asked for them. `sites` are hosted sites that
 * may be edited ({ id, repo, firstpass_at }); `record.prepared(siteId, sha)`
 * and `record.firstPass(siteId, sha)` write down what the buttons write down.
 * Returns { tried, finished }. Never throws.
 */
export async function finishCare(env, sites, { installationToken, record = {}, now = Date.now() } = {}) {
  let tried = 0, finished = 0;
  try {
    for (const s of sites.slice(0, UPDATE_SCAN)) {
      const note = await careOwed(env, s.id);
      if (!note || note.tries >= OWED_TRIES || !note.codes.some(c => PASSING.has(c)) || now < owedDue(note)) continue;
      const token = await installationToken(env, s.repo);
      if (!token) continue;
      tried++;
      const steps = await lookAfter(env, {
        site: s, token, author: note.author, worker: note.worker, firstpassAt: s.firstpass_at || null, tries: note.tries + 1,
        record: { prepared: (sha) => record.prepared?.(s.id, sha), firstPass: (sha) => record.firstPass?.(s.id, sha) },
      });
      if (steps && steps.every(l => l.state !== 'not_done')) finished++;
      console.log(JSON.stringify({ evt: 'lookafter_again', repo: s.repo, try: note.tries + 1, steps: (steps || []).map(l => `${l.step}:${l.state}${l.code ? `(${l.code})` : ''}`) }));
      break;   // one site a run: a look-after reads every page of a site
    }
  } catch (e) {
    console.warn(JSON.stringify({ evt: 'lookafter_again_failed', detail: String(e?.message || e).slice(0, 200) }));
  }
  return { tried, finished };
}

// ─── Previews of suggestions ──────────────────────────────────────────────────
//
// The editor writes a suggestion to a branch of its own, and shows "Open
// preview", only when the site's settings file has a `preview:` line. Kiln's
// hosting puts such a branch up at an address of its own (hosted.js:
// putPreview), so on a hosted site Kiln writes the line too.

const PREVIEWS_MESSAGE = 'Kiln: suggestions on this site get a preview of their own';
const PREVIEWS_A_RUN = 3;           // sites one run gives the line to, at most
const RUN_MS = 5 * 60 * 1000;       // how often the job runs
const pvKey = (siteId) => `pvset:${siteId}`;

/** The sentence a person reads when the settings file could not be given its preview line. */
export function previewsSentence(code, { repo = 'the repository', branch = 'main' } = {}) {
  const before = 'Suggestions on this site work as before, without a preview.';
  switch (code) {
    case 'no_settings': return `Kiln found no settings file (assets/kiln-config.js) in ${repo}, so the settings file could not be changed. ${before}`;
    case 'settings': return `Kiln could not tell where its line belongs in the settings file of this site, so the settings file could not be changed. ${before}`;
    case 'protected': return `The ${branch} branch of ${repo} does not take a direct change (it is protected), so the settings file could not be changed. ${before}`;
    case 'no_access': return `The Kiln app is not installed on ${repo}, or it was removed, so the settings file could not be changed. ${before}`;
    case 'moved': return `The repository changed while Kiln was working on it, so the settings file could not be changed this time. ${before}`;
    default: return `GitHub did not answer just now, so the settings file could not be changed. ${before}`;
  }
}

/**
 * The previews step for one hosted site: read its settings file, and where it
 * has no `preview:` line (or an older one of Kiln's hosting) write the site's
 * own as one commit. With `author` the commit is in that person's name;
 * without, it names nobody and GitHub shows it as made by the Kiln app.
 * `shut` names a branch that has just refused a direct change: it is not
 * asked again. Returns one line as lookAfter's steps do, or null when this
 * service hosts nothing. Never throws.
 */
export async function previewsStep(env, { site, token, author = null, shut = null }) {
  const pattern = previewPattern(env, site);
  if (!pattern) return null;
  const repo = site.repo;
  if (shut) return { step: 'previews', state: 'not_done', code: 'protected', detail: previewsSentence('protected', { repo, branch: shut }) };
  let file = null;
  const notDone = (code) => ({ step: 'previews', state: 'not_done', code, detail: previewsSentence(code, { repo, branch: file?.branch || undefined }) });
  try {
    file = await readSettingsFile({ token, repo });
    if (file.state === 'missing' || file.state === 'empty') return notDone('no_settings');
    if (file.state === 'not_text') return notDone('settings');
    if (file.state !== 'ok') return notDone(file.state);
    const out = withPreview(file.text, pattern);
    if (out.state === 'same') return { step: 'previews', state: 'nothing', detail: 'Suggestions on this site already get a preview of their own.' };
    if (out.state === 'has_own') return { step: 'previews', state: 'nothing', detail: 'The settings file already names where previews are, so Kiln left it as it is.' };
    if (out.state !== 'done') return notDone('settings');
    const done = await commitChange({ token, repo, branch: file.branch, head: file.head, treeSha: file.treeSha, texts: [{ path: file.path, mode: file.mode, text: out.text }], message: PREVIEWS_MESSAGE, author });
    return { step: 'previews', state: 'done', commit: { sha: done.sha, url: done.url }, detail: 'A suggestion or a shared draft on this site now gets a preview address of its own. Kiln added one line to the settings file for that.' };
  } catch (e) {
    const code = e instanceof PrepareError ? e.code : 'github';
    console.warn(JSON.stringify({ evt: 'lookafter_failed', step: 'previews', repo, code, detail: e instanceof PrepareError ? e.detail : String(e?.message || e).slice(0, 200) }));
    return notDone(code);
  }
}

/** Write down that a site's settings file was looked at: for good once the line is settled, for a day when it could not be written. */
async function markPreviews(env, siteId, line, now = Date.now()) {
  try {
    if (line.state === 'not_done') await env.KILN.put(pvKey(siteId), String(now), { expirationTtl: DAY_S });
    else await env.KILN.put(pvKey(siteId), String(now));
  } catch { /* the site is looked at again on the next run */ }
}

/**
 * The five-minute job's part in previews: a site that was on Kiln's hosting
 * before Kiln wrote the preview line gets the previews step, once. `sites` are
 * hosted sites that are live and may be edited ({ id, repo }). A site with a
 * mark (`pvset:`) is passed over; at most three sites a run are given the
 * step. The mark stays for good once the line is there or the owner has their
 * own, and for a day when the file could not be changed, so such a site is
 * looked at once a day. The step holds the same lock as lookAfter, so the two
 * never write to one site at once.
 *
 * Nobody asked for this commit at the moment it is made, so it names no
 * person: GitHub shows it as made by the Kiln app, as it does the editor's
 * updates. It moves the branch, and what publishes a hosted site when its
 * branch moves publishes this too (hosted.js). Never throws.
 */
export async function setPreviews(env, sites, { installationToken, now = Date.now() } = {}) {
  let looked = 0, added = 0;
  try {
    if (!sites.length || !previewPattern(env, sites[0])) return { looked, added };
    // With more sites than one run asks about, each run starts further along the list, so every site has its turn.
    const from = sites.length > UPDATE_SCAN ? (Math.floor(now / RUN_MS) * UPDATE_SCAN) % sites.length : 0;
    const asked = [...sites.slice(from), ...sites.slice(0, from)].slice(0, UPDATE_SCAN);
    for (const s of asked) {
      if (looked >= PREVIEWS_A_RUN) break;
      try {
        if (await env.KILN.get(pvKey(s.id))) continue;
        const lock = `carelock:${s.id}`;
        if (await env.KILN.get(lock)) continue;   // a look-after of this site is running, and it has this step
        looked++;
        const token = await installationToken(env, s.repo);
        let line = null;
        if (!token) line = { step: 'previews', state: 'not_done', code: 'no_access', detail: previewsSentence('no_access', { repo: s.repo }) };
        else {
          await env.KILN.put(lock, '1', { expirationTtl: LOCK_S });
          try { line = await previewsStep(env, { site: s, token }); } finally {
            try { await env.KILN.delete(lock); } catch { /* it runs out by itself in five minutes */ }
          }
        }
        if (!line) continue;
        await markPreviews(env, s.id, line, now);
        if (line.state === 'done') added++;
        console.log(JSON.stringify({ evt: 'hosting_previews_set', repo: s.repo, state: line.state, ...(line.code ? { code: line.code } : {}), ...(line.commit ? { commit: line.commit.sha } : {}) }));
      } catch (e) {
        console.warn(JSON.stringify({ evt: 'hosting_previews_not_set', repo: s.repo, detail: String(e?.message || e).slice(0, 200) }));
      }
    }
  } catch (e) {
    console.warn(JSON.stringify({ evt: 'hosting_previews_failed', detail: String(e?.message || e).slice(0, 200) }));
  }
  return { looked, added };
}

/** How the last look-after of a site went (the lines lookAfter returned), or null. Never throws. */
export async function lookedAfter(env, siteId) {
  try {
    const kept = await env.KILN.get(`hostcare:${siteId}`, 'json');
    return kept && Array.isArray(kept.steps) ? kept.steps : null;
  } catch { return null; }
}

// ─── Keeping the editor current ───────────────────────────────────────────────

/**
 * Bring the editor of hosted sites up to the released one, by itself. `sites`
 * are hosted sites that are live and may be edited ({ id, repo }). In one run
 * at most two sites are looked at, and one site is looked at once in 24
 * hours. A released editor is taken up only once this service has known of it
 * for 24 hours, so Kiln's own sites always run a new editor first.
 *
 * The commit names no person (update.js): GitHub shows it as made by the Kiln
 * app. It moves the branch, and what publishes a hosted site when its branch
 * moves publishes this too (hosted.js); nothing is copied from here. One
 * site's failure is logged and the next site is still looked at. Never throws.
 */
export async function keepEditorsCurrent(env, sites, { installationToken, now = Date.now() } = {}) {
  let looked = 0, updated = 0;
  try {
    const due = [];
    for (const s of sites.slice(0, UPDATE_SCAN)) {
      if (due.length >= UPDATES_A_RUN) break;
      if (!(await env.KILN.get(`hostupd:${s.id}`))) due.push(s);
    }
    if (!due.length) return { looked, updated };
    // No site is looked at while the released editor is newer than a day here.
    const released = await releasedBuild(env, env.KILN_RELEASE_BASE);
    if (!released.stamp || !released.since || now - released.since < SETTLE_MS) return { looked, updated };

    for (const s of due) {
      try {
        const token = await installationToken(env, s.repo);
        if (!token) continue;
        await env.KILN.put(`hostupd:${s.id}`, String(now), { expirationTtl: DAY_S });
        looked++;
        const plan = await planUpdate({ token, repo: s.repo, releaseBase: env.KILN_RELEASE_BASE });
        if (plan.state === 'current') { await noteRepoBuild(env, s.repo, plan.installed); continue; }
        if (plan.state !== 'behind') {
          // 'absent' is a site Kiln was never added to: nothing to keep current.
          if (plan.state !== 'absent') console.warn(JSON.stringify({ evt: 'hosting_editor_not_updated', repo: s.repo, reason: plan.state }));
          continue;
        }
        await rememberLatest(env, plan.latest);
        await noteRepoBuild(env, s.repo, plan.installed);
        // The release may have moved on since it was last read: that editor waits its day too.
        const since = await knownSince(env, plan.latest);
        if (!since || now - since < SETTLE_MS) continue;
        const done = await applyUpdate({ token, repo: s.repo, plan, releaseBase: env.KILN_RELEASE_BASE });
        await noteRepoBuild(env, s.repo, done.to);
        updated++;
        console.log(JSON.stringify({ evt: 'hosting_editor_updated', repo: s.repo, from: done.from || null, to: done.to, commit: done.sha }));
      } catch (e) {
        console.warn(JSON.stringify({ evt: 'hosting_editor_not_updated', repo: s.repo, reason: e instanceof PrepareError ? e.code : 'github', detail: e instanceof PrepareError ? e.detail : String(e?.message || e).slice(0, 200) }));
      }
    }
  } catch (e) {
    console.warn(JSON.stringify({ evt: 'hosting_editors_failed', detail: String(e?.message || e).slice(0, 200) }));
  }
  return { looked, updated };
}
