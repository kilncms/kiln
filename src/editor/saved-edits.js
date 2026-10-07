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
 * It can also hold one thing that was being typed into a panel when a sign-in
 * was found to have ended (`typed`): a comment or a reply, the note for a
 * publish or a suggestion, the time chosen for a schedule, the name for a
 * version. That is written only while the person is being told, and is taken
 * out again when they stay on the page or when it has been put back.
 *
 * This is the shape of that copy and how it is read back. Pure, so it is
 * tested in node; main.js does the storage and puts the edits on the page.
 */

const WEEK = 7 * 24 * 3600 * 1000;   // how long a saved copy is offered back

/** Where typed words can be put back, and what the sentences call them there. */
export const TYPED = {
  comment: 'your comment',
  reply: 'your reply',
  note: 'your note',
  schedule: 'the time you chose',
  version: 'the name you typed',
};
const TYPED_MAX = 5000;

/**
 * What was being typed, as the saved copy holds it: { where, text } and what
 * says where it goes back (a comment's `anchor`, a reply's `thread`, a
 * schedule's `at`, a version's `sha`). null for anything else: what is read
 * back from the browser's storage is not taken on trust.
 */
export function typedRecord(typed) {
  if (!typed || typeof typed !== 'object' || !Object.hasOwn(TYPED, typed.where)) return null;
  if (typeof typed.text !== 'string' || !typed.text.trim() || typed.text.length > TYPED_MAX) return null;
  const out = { where: typed.where, text: typed.text };
  if (typed.anchor && typeof typed.anchor === 'object') {
    const a = typed.anchor, at = {};
    if (typeof a.key === 'string' && a.key.length <= 200) at.key = a.key;
    else if (typeof a.sel === 'string' && a.sel.length <= 200) at.sel = a.sel;
    for (const side of ['x', 'y']) if (typeof a[side] === 'number' && a[side] >= 0 && a[side] <= 100) at[side] = a[side];
    if (at.key || at.sel) out.anchor = at;
  }
  for (const k of ['thread', 'at', 'sha']) if (typeof typed[k] === 'string' && typed[k] && typed[k].length <= 100) out[k] = typed[k];
  return out;
}

/**
 * The saved copy for what is staged now: { ts, edits, source?, typed? }, or
 * null when there is nothing to save.
 *   pending:       Map key → { html?, attrs? }       (the page's own fields)
 *   pendingSource: Map ref → { value, type? }        (content-file fields)
 *   typed:         what was being typed into a panel (see typedRecord)
 * `source` and `typed` are left out when there is none, so a page without
 * them writes what it always wrote.
 */
export function draftRecord(pending, pendingSource, now = Date.now(), typed = null) {
  const t = typedRecord(typed);
  if (!pending.size && !pendingSource.size && !t) return null;
  const record = { ts: now, edits: Object.fromEntries(pending) };
  if (pendingSource.size) record.source = Object.fromEntries(pendingSource);
  if (t) record.typed = t;
  return record;
}

/**
 * What a saved copy offers back: { edits, source, count } and `typed` when it
 * holds something that was being typed, or null when it is unreadable, empty,
 * or older than a week.
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
    const entry = v.type ? { value: v.value, type: v.type } : { value: v.value };
    // A formatted text is Markdown, with the page's HTML and words beside it;
    // a picture field names the upload kept beside the draft. (The address a
    // new picture was shown from ends with the page, and is not kept.)
    if (v.md === true && typeof v.html === 'string' && typeof v.words === 'string') Object.assign(entry, { md: true, html: v.html, words: v.words });
    if (typeof v.upload === 'string' && /^[\w.-][\w./-]*$/.test(v.upload) && !v.upload.split('/').includes('..')) entry.upload = v.upload;
    source[ref] = entry;
  }
  const count = Object.keys(saved.edits).length + Object.keys(source).length;
  const typed = typedRecord(saved.typed);
  if (!count && !typed) return null;
  return typed ? { edits: saved.edits, source, count, typed } : { edits: saved.edits, source, count };
}

/** Whether a saved copy, read back, holds exactly the text edits staged now, and what was being typed. */
export function draftHolds(saved, pending, pendingSource, typed = null) {
  if (!saved || typeof saved !== 'object') return false;
  return JSON.stringify(saved.edits || {}) === JSON.stringify(Object.fromEntries(pending))
    && JSON.stringify(saved.source || {}) === JSON.stringify(Object.fromEntries(pendingSource))
    && JSON.stringify(typedRecord(saved.typed)) === JSON.stringify(typedRecord(typed));
}
