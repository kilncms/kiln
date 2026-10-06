/**
 * Unpublished edits, saved in this browser.
 *
 * Every staged text edit is written to localStorage as it is made, and offered
 * back on the next visit to the page ("Pick up where you left off?"): after a
 * closed tab, a crash, or signing in again when a sign-in has ended. Uploads
 * waiting for Publish are kept beside it (pending-files.js).
 *
 * The saved copy holds text edits to the page's own HTML and, since source
 * mode, text edits to the content files a generated page is made from. It
 * does not hold changes to what is editable, or added and removed sections.
 *
 * This is the shape of that copy and how it is read back. Pure, so it is
 * tested in node; main.js does the storage and puts the edits on the page.
 */

const WEEK = 7 * 24 * 3600 * 1000;   // how long a saved copy is offered back

/**
 * The saved copy for what is staged now: { ts, edits, source? }, or null when
 * there is nothing to save.
 *   pending:       Map key → { html?, attrs? }       (the page's own fields)
 *   pendingSource: Map ref → { value, type? }        (content-file fields)
 * `source` is left out when there is none, so a page without content-file
 * fields writes what it always wrote.
 */
export function draftRecord(pending, pendingSource, now = Date.now()) {
  if (!pending.size && !pendingSource.size) return null;
  const record = { ts: now, edits: Object.fromEntries(pending) };
  if (pendingSource.size) record.source = Object.fromEntries(pendingSource);
  return record;
}

/**
 * What a saved copy offers back: { edits, source, count }, or null when it is
 * unreadable, empty, or older than a week.
 * `known(ref)` says whether a content-file field is on this page and can be
 * edited now; an edit to one that is not is left behind.
 */
export function readDraft(saved, { now = Date.now(), known = () => true } = {}) {
  if (!saved || typeof saved !== 'object' || !saved.edits || typeof saved.edits !== 'object') return null;
  if (now - saved.ts > WEEK) return null;
  const source = {};
  const stored = saved.source && typeof saved.source === 'object' ? saved.source : {};
  for (const [ref, v] of Object.entries(stored)) {
    if (!v || typeof v.value !== 'string' || !known(ref)) continue;
    source[ref] = v.type ? { value: v.value, type: v.type } : { value: v.value };
  }
  const count = Object.keys(saved.edits).length + Object.keys(source).length;
  return count ? { edits: saved.edits, source, count } : null;
}

/** Whether a saved copy, read back, holds exactly the text edits staged now. */
export function draftHolds(saved, pending, pendingSource) {
  if (!saved || typeof saved !== 'object') return false;
  return JSON.stringify(saved.edits || {}) === JSON.stringify(Object.fromEntries(pending))
    && JSON.stringify(saved.source || {}) === JSON.stringify(Object.fromEntries(pendingSource));
}
