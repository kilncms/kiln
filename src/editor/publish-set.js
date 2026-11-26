/**
 * Publishing many pages together: one commit, built on the commit it read.
 *
 * A person changes several pages, the changes wait in this browser (one saved
 * copy per page, saved-edits.js), and one publish writes them all as one
 * commit, so the site's host builds once.
 *
 * The order of work is what keeps somebody else's publish safe:
 *   1. read the branch's head commit and its list of files;
 *   2. read each page with waiting changes AT THAT COMMIT, and put the changes
 *      into that text part by part, comparing each part with what the person
 *      saw when they began;
 *   3. a change to a shared part goes into every page that carries the part;
 *   4. each new picture that a change names is sent as an object of its own;
 *   5. one tree and one commit are built on that head, and the branch is moved
 *      to it without force;
 *   6. if the branch has moved meanwhile the move is refused: everything is
 *      read again from the new head, three tries in all. Nothing is live until
 *      the branch moves, so nothing is ever half published.
 *
 * The many-page tools that came before (the Site menu, Find and replace, a
 * shared part) read the pages by the branch's name and then build on whatever
 * the branch holds a moment later, with no check of the parts. This is
 * stricter on both counts.
 *
 * What a saved copy must hold to be published without its page open, beside
 * `edits` (which stays exactly as it was):
 *   page: { path, sha }   the page's file in the repository, and the version
 *                         of that file the edits were made against
 *   more: { [key]: {      keyed like `edits`
 *     was,                the inside of the part in the file when the person began
 *     base,               for a list: the list as the page showed it before the edit
 *     shared } }          true for a part that is shared across pages
 * A copy written before those were kept is published without the check of
 * its parts, which is what a scheduled change does. A copy that does not name
 * its file cannot be published from here and is left waiting.
 *
 * Content files of a generated site (`source`) are not written here.
 *
 * Pure of the page: reading a list the way the editor stages it needs a
 * browser, so that is handed in as `readList`. Tested in node
 * (test/publish-set.test.js).
 */
import { indexHtml, applyEdits } from '../engine.js';
import { getFile, branchHead, commitFilesOn, HeadMoved } from '../github.js';
import { listAsFile, ListLoss } from './list-as-file.js';
import { savedPage, savedMore } from './saved-edits.js';

/** No more files than this are written in one set. */
export const SET_FILES_MAX = 100;
/** No more new pictures than this go in one set. */
export const SET_PICTURES_MAX = 20;
/** A change to a shared part is looked for on this many pages, as it always was. */
export const SET_SHARED_PAGES_MAX = 100;
/** How many times the set is built when the branch keeps moving. */
export const SET_TRIES = 3;

/** How many requests one publish makes: `pages` with waiting changes, `pictures` to send, `others` read for a shared part. */
export const setRequests = ({ pages = 0, pictures = 0, others = 0 } = {}) => pages + pictures + others + 6;

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The line shown for each step of a publish. */
export function setStepText(step) {
  if (step.step === 'reading') return `Reading ${plural(step.pages, 'page')}…`;
  if (step.step === 'checking') return step.pages === 1 ? 'Checking that nobody else changed it…' : 'Checking that nobody else changed them…';
  if (step.step === 'saving') return `Saving ${plural(step.pages, 'page')} as one change…`;
  if (step.step === 'again') return 'Somebody else published at the same moment. Checking again…';
  return '';
}

/** Said when parts were changed by somebody else since the person edited them: nothing was written. */
export const setConflictText = (n) => `${n === 1 ? '1 of these was' : `${n} of these were`} changed by someone else since you edited ${n === 1 ? 'it' : 'them'}. Nothing has been published yet.`;

/**
 * The edits as they go into this text of a page's file: main.js editsForFile,
 * with the reading of a list handed in. A list is written from the file's own
 * text with only what the person changed put into it (list-as-file.js).
 * `lists` is Map key → { entry, base }. Throws ListLoss when a list cannot be
 * written without losing something.
 */
export function editsForFile(text, edits, lists, readList) {
  const { fields } = indexHtml(text);
  return edits.map((e) => {
    const l = e.html !== undefined ? lists.get(e.key) : null;
    const f = l ? fields.get(e.key) : null;
    if (!f || f.kind !== 'repeat' || !f.inner || l.entry.whole) return e;
    if (typeof readList !== 'function') throw new ListLoss(e.key);
    const from = typeof l.entry.from === 'string';
    const res = listAsFile({
      tag: f.tag, text: from ? l.entry.from : text.slice(f.inner.start, f.inner.end), now: e.html,
      base: from ? null : l.base, lost: Array.isArray(l.entry.lost) ? l.entry.lost : [], read: (html) => readList(f.tag, html),
    });
    if (!res.ok) throw new ListLoss(e.key);
    return { ...e, html: res.html };
  });
}

const safePath = (p) => typeof p === 'string' && !!p && !p.includes('\\') && p.split('/').every(s => s && s !== '.' && s !== '..');

/** One saved copy as this needs it. What is read back from the browser's storage is not taken on trust. */
function readCopy(copy) {
  if (!copy || typeof copy !== 'object' || !copy.edits || typeof copy.edits !== 'object') return null;
  // One reader for what the browser kept (saved-edits.js): a path, a version, and per part what it held.
  const page = savedPage(copy) || {};
  const more = savedMore(copy);
  const parts = [];
  for (const [key, entry] of Object.entries(copy.edits)) {
    if (!entry || typeof entry !== 'object') continue;
    const edits = [];
    if (typeof entry.html === 'string') edits.push({ key, html: entry.html });
    if (entry.attrs && typeof entry.attrs === 'object') {
      for (const [attr, value] of Object.entries(entry.attrs)) edits.push({ key, attr, value });
    }
    if (!edits.length) continue;
    const m = Object.hasOwn(more, key) ? more[key] : {};
    parts.push({
      key, entry, edits,
      was: typeof m.was === 'string' ? m.was : undefined,
      base: typeof m.base === 'string' ? m.base : null,
      shared: m.shared === true,
    });
  }
  return {
    copy, parts,
    path: page.path && safePath(page.path) ? page.path : null,
    // No version known means "compare part by part" (planSet's sameFile is then false), never "unchanged".
    sha: typeof page.sha === 'string' && page.sha ? page.sha : null,
    ts: Number(copy.ts) || 0,
  };
}

const valuesOf = (edits) => edits.map(e => String(e.html ?? e.value ?? ''));

/**
 * What a set would write, worked out from the files as they are at one commit.
 * Nothing is sent from here.
 *
 *   copies:   the saved copies (see the top)
 *   files:    Map path → the sha of that file's content at the commit
 *   complete: false when that list was cut short, so a missing path proves nothing
 *   read:     async (path) => the file's text at the commit, or null when it is not there
 *   readList: (tag, html) => the blocks of a list as the editor stages them
 *   answers:  conflicts returned by an earlier call, each with `pick` set to
 *             'mine' or 'theirs'. An answer counts only while the file still
 *             holds the words the person was shown.
 *   pictures: [{ path, base64 }] or a Map path → base64: the new pictures waiting
 *
 * Returns
 *   files:     [{ path, text }] to write
 *   pictures:  { send: [{ path, base64 }], kept: [path], unnamed: [path] }
 *              `kept` are named only by a change still waiting; `unnamed` by nothing
 *   published: [{ path, keys }] the waiting changes that are in `files`, or that the file already reads as
 *   left:      [{ path, key, reason }] still waiting: 'page_gone', 'part_gone',
 *              'not_applied', 'not_utf8', 'no_page' (that one carries `copy`)
 *   dropped:   [{ path, key, reason }] no longer wanted: 'theirs' (the person
 *              kept the other words), 'older' (a newer change to the same shared part stands)
 *   conflicts: [{ path, key, was, theirs, mine, shared }]
 *   blocked:   [{ path, key, reason }] 'list' (cannot be written without loss),
 *              'picture' (two different pictures under one name)
 *   over:      null, or { what: 'files' | 'pictures', count, max }
 *   unread:    [path] pages a shared part was not looked for on (not UTF-8)
 *   ok:        true when there is no conflict, nothing blocked and nothing over:
 *              only then may anything be written
 */
export async function planSet({ copies, files, complete = true, read, readList = null, answers = [], pictures = [], maxFiles = SET_FILES_MAX, onStep = () => {} }) {
  const left = [], dropped = [], conflicts = [], blocked = [], published = [], unread = [];
  const going = [], waiting = [];   // the values in the commit, and those of changes not in it
  const id = (path, key) => `${path}\u0000${key}`;
  const answered = new Map((answers || []).filter(a => a && typeof a === 'object').map(a => [id(a.path, a.key), a]));
  const leave = (path, part, reason, extra = {}) => { left.push({ path, key: part.key, reason, ...extra }); waiting.push(...valuesOf(part.edits)); };
  const text = async (path) => {
    try { return { text: await read(path) }; }
    catch (err) { if (err && err.code === 'NOT_UTF8') return { notUtf8: true }; throw err; }
  };

  // One file may have been edited at two addresses (/about and /about.html): the newer words for a part stand.
  const pages = new Map();
  for (const c of (copies || []).map(readCopy).filter(c => c && c.parts.length).sort((a, b) => a.ts - b.ts)) {
    if (!c.path) { for (const p of c.parts) leave(null, p, 'no_page', { copy: c.copy }); continue; }
    if (!pages.has(c.path)) pages.set(c.path, new Map());
    for (const p of c.parts) pages.get(c.path).set(p.key, { ...p, sha: c.sha, ts: c.ts });
  }

  // A shared part edited on two pages of the set: the newer edit is the one every page gets.
  const shared = new Map();
  for (const [path, parts] of pages) {
    for (const p of parts.values()) {
      if (p.shared && (!shared.has(p.key) || p.ts >= shared.get(p.key).part.ts)) shared.set(p.key, { part: p, from: path });
    }
  }

  onStep({ step: 'reading', pages: pages.size });
  const work = new Map();   // path → { text, edits, lists, keys }
  for (const [path, parts] of pages) {
    const got = files.has(path) || !complete ? await text(path) : { text: null };
    if (typeof got.text !== 'string') {
      for (const p of parts.values()) { leave(path, p, got.notUtf8 ? 'not_utf8' : 'page_gone'); if (shared.get(p.key)?.part === p) shared.delete(p.key); }
      continue;
    }
    const { fields } = indexHtml(got.text);
    const w = { text: got.text, edits: [], lists: new Map(), keys: new Set() };
    for (const p of parts.values()) {
      const stands = !p.shared || shared.get(p.key)?.part === p;
      if (!stands) { dropped.push({ path, key: p.key, reason: 'older' }); continue; }
      const out = () => { if (p.shared) shared.delete(p.key); };
      const f = fields.get(p.key);
      if (!f) { leave(path, p, 'part_gone'); out(); continue; }
      const theirs = f.inner ? got.text.slice(f.inner.start, f.inner.end) : null;
      const mine = typeof p.entry.html === 'string' ? p.entry.html : null;
      const sameFile = !!p.sha && p.sha === files.get(path);
      if (p.was !== undefined && !sameFile && theirs !== p.was && theirs !== mine) {
        const a = answered.get(id(path, p.key));
        const pick = a && a.theirs === theirs ? a.pick : null;
        if (pick === 'theirs') { dropped.push({ path, key: p.key, reason: 'theirs' }); out(); continue; }
        if (pick !== 'mine') { conflicts.push({ path, key: p.key, was: p.was, theirs, mine, shared: p.shared }); waiting.push(...valuesOf(p.edits)); continue; }
      }
      if (!p.shared) { w.edits.push(...p.edits); w.lists.set(p.key, p); w.keys.add(p.key); }
    }
    work.set(path, w);
  }
  onStep({ step: 'checking', pages: pages.size });

  // A shared part goes into every page that carries it. With a conflict
  // waiting for an answer nothing will be written, so no other page is read.
  if (shared.size && !conflicts.length) {
    const others = [...files.keys()].filter(p => p.endsWith('.html')).slice(0, SET_SHARED_PAGES_MAX);
    for (const path of new Set([...work.keys(), ...others])) {
      let w = work.get(path);
      if (!w) {
        const got = await text(path);
        if (got.notUtf8) unread.push(path);
        if (typeof got.text !== 'string') continue;
        w = { text: got.text, edits: [], lists: new Map(), keys: new Set() };
        work.set(path, w);
      }
      const { fields } = indexHtml(w.text);
      for (const [key, { part, from }] of shared) {
        if (!fields.has(key)) continue;
        w.edits.push(...part.edits);
        w.lists.set(key, part);
        if (path === from) w.keys.add(key);
      }
    }
  }

  const out = [];
  for (const [path, w] of work) {
    if (!w.edits.length) continue;
    let prepared;
    try { prepared = editsForFile(w.text, w.edits, w.lists, readList); }
    catch (err) {
      if (!(err instanceof ListLoss)) throw err;
      blocked.push({ path, key: err.key, reason: 'list' });
      continue;
    }
    const res = applyEdits(w.text, prepared);
    const applied = new Set(res.applied);
    const skipped = new Map(res.skipped.map(s => [s.key, s.reason]));
    // A part whose every edit was skipped never reached the file: it stays waiting, as a one-page publish keeps it.
    const gone = (key) => skipped.has(key) && !applied.has(key);
    const keys = [];
    for (const key of w.keys) {
      if (gone(key)) left.push({ path, key, reason: /not found in source/.test(skipped.get(key)) ? 'part_gone' : 'not_applied', why: skipped.get(key) });
      else keys.push(key);
    }
    if (keys.length) published.push({ path, keys });
    for (const e of w.edits) (gone(e.key) ? waiting : going).push(...valuesOf([e]));
    if (res.html !== w.text) out.push({ path, text: res.html });
  }

  // Only a picture that some change in the commit names is sent.
  const pics = new Map();
  for (const p of pictures instanceof Map ? [...pictures].map(([path, base64]) => ({ path, base64 })) : (pictures || [])) {
    if (!p || !safePath(p.path) || typeof p.base64 !== 'string') continue;
    if (pics.has(p.path) && pics.get(p.path) !== p.base64) { blocked.push({ path: p.path, key: null, reason: 'picture' }); continue; }
    pics.set(p.path, p.base64);
  }
  const names = (values, path) => { const base = path.split('/').pop(); return values.some(v => v.includes(base)); };
  const send = [], kept = [], unnamed = [];
  for (const [path, base64] of pics) {
    if (names(going, path)) send.push({ path, base64 });
    else if (names(waiting, path)) kept.push(path);
    else unnamed.push(path);
  }

  const over = out.length > maxFiles ? { what: 'files', count: out.length, max: maxFiles }
    : send.length > SET_PICTURES_MAX ? { what: 'pictures', count: send.length, max: SET_PICTURES_MAX } : null;
  return {
    files: out, pictures: { send, kept, unnamed }, published, left, dropped, conflicts, blocked, over, unread,
    ok: !conflicts.length && !blocked.length && !over,
  };
}

/**
 * Publish the set as one commit. Returns what planSet returns, with
 *   commit: the commit made, or null when nothing was written: a conflict to
 *           answer, something blocked or over a limit (`ok` is false), or
 *           every file already reading as the changes want it
 *   head:   the commit everything was read at
 *   tries:  how many times it was built
 * Throws what a request threw. HeadMoved after the last try means the branch
 * kept moving; in every case nothing has been written unless `commit` is set.
 *
 *   message: the commit's message, or (plan) => the message, given what is really written
 *   onStep:  told { step: 'reading' | 'checking' | 'saving' | 'again', pages } (setStepText)
 *   wait:    how the pause before another try is taken (handed in for tests)
 */
export async function publishSet({ gh, repo, branch, copies, pictures = [], answers = [], message, readList = null, maxFiles = SET_FILES_MAX, tries = SET_TRIES, onStep = () => {}, wait = (ms) => new Promise(r => setTimeout(r, ms)) }) {
  if (typeof message !== 'string' && typeof message !== 'function') throw new TypeError('publishSet needs the commit message');
  const sent = new Map();    // pictures already sent, by path: a second try sends none twice
  const texts = new Map();   // files already read, by the sha of their content: a second try reads only what changed
  for (let attempt = 1; ; attempt++) {
    const head = await branchHead(gh, repo, branch);
    const listing = await gh.request('GET', `/repos/${repo}/git/trees/${head.tree}?recursive=1`);
    const files = new Map(((listing && listing.tree) || []).filter(t => t.type === 'blob' && typeof t.path === 'string').map(t => [t.path, t.sha]));
    const read = async (path) => {
      const known = files.get(path);
      if (known && texts.has(known)) return texts.get(known);
      try {
        const file = await getFile(gh, repo, path, head.sha);
        texts.set(file.sha, file.text);
        return file.text;
      } catch (err) {
        if (err.status === 404) return null;
        throw err;
      }
    };
    const plan = await planSet({ copies, files, complete: !(listing && listing.truncated), read, readList, answers, pictures, maxFiles, onStep });
    const all = [...plan.pictures.send, ...plan.files];
    if (!plan.ok || !all.length) return { ...plan, commit: null, head: head.sha, tries: attempt };
    onStep({ step: 'saving', pages: plan.files.length });
    try {
      const commit = await commitFilesOn(gh, repo, branch, head, all, typeof message === 'function' ? message(plan) : message, { sent });
      return { ...plan, commit, head: head.sha, tries: attempt };
    } catch (err) {
      if (!(err instanceof HeadMoved) || attempt >= tries) throw err;
      onStep({ step: 'again', pages: plan.files.length });
      await wait(500 * attempt * attempt);
    }
  }
}
