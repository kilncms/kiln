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
import { readDraft, savedPage, WEEK } from './saved-edits.js';

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
