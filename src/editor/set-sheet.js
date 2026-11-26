/**
 * "Waiting on other pages": the words and the sorting behind the sheet that
 * publishes the edits waiting on several pages as one commit
 * (publish-sheet.js openSetSheet, publish-set.js publishSet).
 *
 * Pure, and tested in node (test/set-sheet.test.js). Nothing here reads the
 * page or the browser's storage: the caller hands in the saved copies and the
 * check a restored value passes (main.js safeToRestore).
 */
import { savedPage } from './saved-edits.js';

/** An invited editor's set holds no more pages than this: the service checks every page of the commit, twice. */
export const EDITOR_SET_PAGES_MAX = 20;

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The menu item: "Waiting on other pages (4)", the number being pages. */
export const waitingItemLabel = (pages) => `Waiting on other pages (${pages})`;

/** "edited 2 days ago", from how long ago the copy was written (ms), or '' when that is not known. */
export function editedAgo(age) {
  if (!Number.isFinite(age) || age < 0) return '';
  const min = Math.floor(age / 60000), hour = Math.floor(age / 3600000), day = Math.floor(age / 86400000);
  if (min < 1) return 'edited just now';
  if (hour < 1) return `edited ${plural(min, 'minute')} ago`;
  if (day < 1) return `edited ${plural(hour, 'hour')} ago`;
  return day === 1 ? 'edited yesterday' : `edited ${day} days ago`;
}

/** The main button: "Publish 7 edits on 3 pages". */
export function setLabel({ edits, pages }) {
  if (pages <= 1) return `Publish ${plural(edits, 'edit')}`;
  return `Publish ${plural(edits, 'edit')} on ${pages} pages`;
}

/** The question before a page's waiting changes are dropped. */
export function dropPageCopy(count, title) {
  const name = String(title || '').trim() || 'this page';
  return {
    title: count === 1 ? 'Drop this change?' : 'Drop these changes?',
    body: `Drop the ${count === 1 ? 'waiting change' : `${count} waiting changes`} on ${name}? ${count === 1 ? 'It has' : 'They have'} not been published.`,
    cancel: 'Keep them', go: 'Drop',
  };
}

/** The words of the page heading's two controls, the design's own. */
export const PAGE_CONTROLS = { open: 'Open', drop: 'Drop' };

/** The row under a change that a check held back. */
export const HELD_TEXT = 'This change holds code Kiln does not publish from here. Open the page to look at it.';
/** The heading's line for this page when it cannot go in a set. */
export const OWN_PUBLISH_TEXT = 'Published from the page itself';

/** The invited editor's limit, said in the sheet. */
export const editorLimitText = (max = EDITOR_SET_PAGES_MAX) => `Kiln publishes ${max} pages at a time for an invited editor. Publish these ${max} first, then the rest.`;
export const firstPagesLabel = (n) => `Publish these ${n} first`;

/** A set past one of publish-set.js's limits, said in the sheet. */
export function overText(over) {
  if (!over) return '';
  if (over.what === 'pictures') return `Kiln sends ${over.max} new pictures at a time, and these hold ${over.count}. Publish the first pages now, then the rest.`;
  return `Kiln publishes ${over.max} pages at a time, and this would change ${over.count}. Publish these ${over.max} first, then the rest.`;
}

/** Something that stops the whole set, said in the sheet. */
export function blockedText(blocked, nameOf = (p) => p) {
  const b = (blocked || [])[0];
  if (!b) return '';
  if (b.reason === 'picture') return `Two pages each added a different picture called ${String(b.path).split('/').pop()}. Publish one of those pages from the page itself first.`;
  return `A list on ${nameOf(b.path)} cannot be published from here without losing something. Open that page and publish it from there.`;
}

/** Why a change is still waiting after a set, for the done line. */
const LEFT_WHY = {
  part_gone: 'the part it changed is no longer on the page',
  not_applied: 'it could not be put into the page',
  page_gone: 'its page is no longer on the site',
  not_utf8: 'its page is not saved as plain text Kiln can write',
  no_page: 'Kiln does not know which file it belongs to',
};

/** The line when a set is done: "Published 3 pages as one change. 1 edit is still waiting: …". */
export function setDoneText({ pages, left = [] }) {
  const head = pages ? `Published ${plural(pages, 'page')} as one change.` : 'Nothing needed publishing: the pages already read that way.';
  if (!left.length) return pages ? `${head} The site is rebuilding once.` : head;
  const reasons = [...new Set(left.map(l => l.reason))];
  const why = reasons.length === 1 && LEFT_WHY[reasons[0]] ? `: ${LEFT_WHY[reasons[0]]}` : '';
  return `${head} ${left.length === 1 ? '1 edit is' : `${left.length} edits are`} still waiting${why}.`;
}

/**
 * A saved copy of a page that is not open, with every HTML value that fails
 * `safe` taken out. Those stay waiting in storage and are not published.
 * Returns { copy, held: [key] }; `copy` is null when nothing is left to send.
 */
export function holdBack(saved, safe) {
  if (!saved || typeof saved !== 'object' || !saved.edits || typeof saved.edits !== 'object') return { copy: null, held: [] };
  const edits = {}, held = [];
  for (const [key, e] of Object.entries(saved.edits)) {
    if (!e || typeof e !== 'object') continue;
    const values = [e.html, ...(e.attrs && typeof e.attrs === 'object' ? Object.values(e.attrs) : [])];
    let ok = true;
    try { ok = (e.html === undefined || typeof e.html === 'string') && safe(e.html); } catch { ok = false; }
    if (ok && e.attrs) ok = values.slice(1).every(v => typeof v === 'string' && !/^\s*(javascript|vbscript|data:text\/html)/i.test(v));
    if (ok) edits[key] = e; else held.push(key);
  }
  if (!Object.keys(edits).length) return { copy: null, held };
  // A content-file edit (`source`) is never in a set in this step: it is left out of the copy that is sent.
  const { source, sourceWas, ...rest } = saved;
  return { copy: { ...rest, edits }, held };
}

/**
 * A saved copy with the parts that were published (or dropped for theirs)
 * taken out. Returns the copy to write back, or null when nothing is left in
 * it, so the caller removes it. The number the button showed is not kept: it
 * no longer counts what is left.
 */
export function withoutKeys(saved, keys) {
  if (!saved || typeof saved !== 'object' || !saved.edits) return null;
  const gone = new Set(keys);
  const edits = {}, more = {};
  for (const [k, v] of Object.entries(saved.edits)) if (!gone.has(k)) edits[k] = v;
  if (saved.more && typeof saved.more === 'object') for (const [k, v] of Object.entries(saved.more)) if (!gone.has(k) && Object.hasOwn(edits, k)) more[k] = v;
  const source = saved.source && typeof saved.source === 'object' ? saved.source : {};
  if (!Object.keys(edits).length && !Object.keys(source).length && !saved.typed) return null;
  const { n, ...rest } = saved;
  const out = { ...rest, edits };
  if (saved.more) out.more = more;
  return out;
}

/** The file a saved copy is for, read with care (saved-edits.js savedPage), or null. */
export function copyPath(saved) {
  return savedPage(saved)?.path || null;
}

/**
 * Whether this page's staged changes can go in a set: text and attribute
 * edits and new pictures only. Anything else (an added or removed section, a
 * part made editable, a whole-page restore, a content-file edit, a page whose
 * file is not known) is published from the page itself.
 */
export function canJoinSet({ path, structural = 0, restoring = false, source = 0 }) {
  return !!path && !structural && !restoring && !source;
}

/**
 * Which pages go in this publish: the first `max`, this page first. `pages`
 * are { path } in the order the sheet shows them. Returns the paths.
 */
export function firstPages(pages, max) {
  const seen = [];
  for (const p of pages) if (p.path && !seen.includes(p.path)) seen.push(p.path);
  return Number.isFinite(max) && max > 0 ? seen.slice(0, max) : seen;
}
