/**
 * Changes waiting on the pages of a site, in this browser.
 *
 * Every page keeps its own copy of its unpublished edits in the browser's
 * storage (saved-edits.js), under a key made of the repository's name and the
 * page's path. This reads all of a site's copies at once: which pages have
 * changes waiting, how many, how old, and enough about each page to name it
 * and go to it. It also drops one page's copy, and says how long a copy is
 * kept.
 *
 * Pure: the storage is handed in (the browser's localStorage, or anything
 * with length, key(), getItem() and removeItem()), so it is tested in node.
 * What is read is not taken on trust (saved-edits.js savedPage), and a
 * storage that refuses is read as holding nothing.
 */
import { readDraft, savedPage, draftHolds, WEEK } from './saved-edits.js';
import { canJoinSet, setLabel } from './set-sheet.js';

const DAY = 24 * 3600 * 1000;

/**
 * How long waiting changes are kept, counted from the last change to their
 * page. A person publishing one page at a time is offered a copy back for a
 * week, as always. A person collecting changes across pages may take longer
 * than that over a set, and has a list that shows each page's age: 30 days.
 */
export const KEEP = { one: WEEK, together: 30 * DAY };
export function keptFor(way) { return way === 'together' ? KEEP.together : KEEP.one; }

/** Where a page's unpublished edits are kept: `at` is the page's file in the repository, or its address when the file is not known. */
export function pendingKey(repo, at) { return `kiln_pending:${repo}:${at}`; }
/** Where the mark of a waiting whole-page restore is kept, beside a page's saved edits (restore-page.js). */
export function restoreKey(key) { return 'kiln:restoring:' + key; }

function keysOf(storage) {
  const out = [];
  try {
    for (let i = 0; i < storage.length; i++) { const k = storage.key(i); if (typeof k === 'string') out.push(k); }
  } catch { /* storage blocked: nothing is kept */ }
  return out;
}

/**
 * The pages of `repo` with changes waiting in `storage`, the most recently
 * changed first:
 *   key        where the copy is kept
 *   at         the page as its key names it
 *   path       the page's file in the repository, or null when the copy was
 *              kept under the page's address (the file was not known)
 *   url        the page's address on the site, when the copy says (else null)
 *   title      the page's title, as text, when the copy says (else '')
 *   sha        the version of the file the edits were made against (else null)
 *   count      the number the Publish button showed for these edits
 *   ts, age    when the copy was last written, and how long ago (null when the copy does not say)
 *   left       how long until the copy is no longer offered (null with no ts)
 *   whole      true when the copy says what it needs to be published without
 *              its page open; false for a copy an editor from before this wrote
 *   restoring  true when a whole-page restore waits on that page as well, which
 *              no copy holds: such a page is published from the page itself
 * `keep` is how long a copy is offered (keptFor); one past that is not listed.
 * `except` names pages to leave out, by `at` (the page that is open, say).
 * A copy that cannot be read, holds no edit, or holds only something that
 * was being typed into a panel is not a page with changes waiting.
 */
export function waitingPages(storage, repo, { now = Date.now(), keep = WEEK, except = [] } = {}) {
  const pages = [];
  if (!storage || typeof repo !== 'string' || !repo) return pages;
  const mine = pendingKey(repo, '');
  const skip = new Set([].concat(except || []));
  for (const key of keysOf(storage)) {
    if (!key.startsWith(mine) || key.length === mine.length) continue;
    const at = key.slice(mine.length);
    if (skip.has(at)) continue;
    let saved = null;
    try { saved = JSON.parse(storage.getItem(key)); } catch { continue; }
    const draft = readDraft(saved, { now, keep });
    if (!draft || !draft.count) continue;
    // The key is where the editor wrote the copy, and it is what names the
    // page. Page facts that name another file are not this page's: none are used.
    const said = savedPage(saved);
    const page = said && said.path === at ? said : null;
    const ts = Number.isFinite(saved.ts) ? saved.ts : null;
    const age = ts === null ? null : Math.max(0, now - ts);
    let restoring = false;
    try { restoring = storage.getItem(restoreKey(key)) != null; } catch { /* not known: nothing is said */ }
    pages.push({
      key, at,
      path: page ? page.path : (at.startsWith('/') ? null : at),
      url: page?.url || (at.startsWith('/') ? at : null),
      title: page?.title || '',
      sha: page?.sha || null,
      count: draft.count,
      ts, age,
      left: age === null ? null : Math.max(0, keep - age),
      whole: !!page,
      restoring,
    });
  }
  return pages.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0) || (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/** How much is waiting in all: { pages, edits }. */
export function waitingTotal(pages) {
  return { pages: pages.length, edits: pages.reduce((n, p) => n + p.count, 0) };
}

/**
 * Drop the changes waiting on one page: its saved copy, and the mark of a
 * whole-page restore beside it. Returns the key the copy was kept under, so
 * the caller can forget the pictures kept beside it (pending-files.js
 * forgetFiles), or null when there was nothing to drop or the storage refused.
 * No other page's copy is touched.
 */
export function dropPage(storage, repo, at) {
  if (!storage || typeof repo !== 'string' || !repo || typeof at !== 'string' || !at) return null;
  const key = pendingKey(repo, at);
  try {
    if (storage.getItem(key) == null) return null;
    storage.removeItem(key);
    storage.removeItem(restoreKey(key));
    return key;
  } catch { return null; }
}

// ─── The way of working: "One page at a time" or "Several pages together" ────

/** Where this browser keeps its way of working. Nothing kept means "One page at a time". */
export const WAY_KEY = 'kiln_way';

/** The two options of the choice in Settings, in its own words. */
export const WAYS = [
  { value: 'one', name: 'One page at a time', line: "Publish sends this page's changes." },
  { value: 'together', name: 'Several pages together', line: 'Changes wait in this browser while you move between pages. One Publish sends them all as one change, so the site rebuilds once.' },
];

/** This browser's way of working: 'together' only when it was chosen; 'one' for anything else, a storage that refuses included. */
export function readWay(storage) {
  try { return storage && storage.getItem(WAY_KEY) === 'together' ? 'together' : 'one'; } catch { return 'one'; }
}

/** Keep the choice. "One page at a time" is kept as nothing at all, as it was before there was a choice. */
export function setWay(storage, way) {
  try { if (way === 'together') storage.setItem(WAY_KEY, 'together'); else storage.removeItem(WAY_KEY); } catch { /* storage blocked: one page at a time */ }
}

/**
 * Whether the choice is offered, and so whether it counts: not in the demo,
 * not to a person who may only suggest or only comment. For them the way of
 * working is always one page at a time.
 */
export function wayOffered({ sandbox = false, suggest = false, review = false } = {}) {
  return !sandbox && !suggest && !review;
}

/** The way of working that applies: what this browser chose, where the choice is offered; else 'one'. */
export function wayNow(storage, who = {}) {
  return wayOffered(who) ? readWay(storage) : 'one';
}

/**
 * The Publish button's words in "Several pages together", or '' for the
 * words it has today. `edits` and `pages` count everything a set would send;
 * `here` is whether this page is one of those pages. With edits on this page
 * only, it reads as today.
 */
export function togetherLabel({ edits = 0, pages = 0, here = false } = {}) {
  if (!pages || !edits) return '';
  if (here && pages === 1) return '';
  if (!here && pages === 1) return `Publish ${edits} edit${edits === 1 ? '' : 's'} on 1 other page`;
  return setLabel({ edits, pages });
}

/**
 * Whether leaving this page is safe without the browser's "Leave site?"
 * question, in "Several pages together". True only when all of these hold:
 *   - the copy read back from storage (`stored`, parsed) holds exactly the
 *     edits on the page now, what is in an open box included, and what was
 *     being typed in a panel (saved-edits.js draftHolds);
 *   - nothing on the page is outside what a set can carry (set-sheet.js
 *     canJoinSet: no added or removed section, no part made editable, no
 *     whole-page restore, no content-file edit, the page's file is known);
 *   - every new picture is kept in the browser's picture store (`kept`).
 * Anything else, a copy that could not be written or read included, is false.
 */
export function leaveIsSafe({ way = 'one', stored = null, edits = new Map(), source = new Map(), typed = null,
  path = null, structural = 0, restoring = false, pictures = [], kept = new Set() } = {}) {
  if (way !== 'together' || !stored || typeof stored !== 'object') return false;
  if (!edits || !edits.size) return false;
  if (!canJoinSet({ path, structural, restoring, source: source ? source.size : 0 })) return false;
  if ([...pictures].some(p => !kept.has(p))) return false;
  try { return draftHolds(stored, edits, source || new Map(), typed); } catch { return false; }
}

/** The status line when a page's waiting edits are put back on arrival. `notShown`: how many could not be shown on the page. */
export function backLine(n, notShown = 0) {
  const head = n === 1 ? 'Your waiting edit on this page is back. Not published yet.'
    : `Your ${n} waiting edits on this page are back. Not published yet.`;
  if (!notShown) return head;
  return `${head} ${notShown === 1 ? '1 of them' : `${notShown} of them`} could not be shown on the page, because ${notShown === 1 ? 'it holds' : 'they hold'} code Kiln does not put back by itself.`;
}

/** The status line when the saved copy could not be written. Said once per page load. */
export const NO_ROOM_TEXT = 'This browser has no room to keep these edits. Publish this page before you leave it.';
