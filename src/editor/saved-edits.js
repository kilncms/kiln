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
 * Beside all that, never inside it, the copy says enough about its page for
 * the edits to be published without the page open (waiting.js lists such
 * pages): `page`, `more` and `sourceWas`, described at pageRecord. An editor
 * from before they were added reads the copy as it always did, and this one
 * reads a copy without them as it always did.
 *
 * This is the shape of that copy and how it is read back. Pure, so it is
 * tested in node; main.js does the storage and puts the edits on the page.
 */

export const WEEK = 7 * 24 * 3600 * 1000;   // how long a saved copy is offered back

/**
 * The staged edits with what is being typed in a box still open laid over
 * them, as if the box had been left: html is the box's value now, base what
 * it was when the person began (undefined: not known). Words that change
 * nothing add nothing. The map given is never changed.
 */
export function openBoxEdit(pending, key, html, base) {
  if (typeof html !== 'string' || (base !== undefined && html === base)) return pending;
  if (pending.get(key)?.html === html) return pending;
  const out = new Map(pending);
  out.set(key, { ...(pending.get(key) || {}), html });
  return out;
}

/**
 * The same for a box inside a list, which is kept as the whole list: `now` and
 * `before` are the box's own words now and when it was opened, `listHtml` the
 * list as it would be staged with those words in it (null when it could not
 * be made safely). A box not changed adds nothing.
 */
export function openListEdit(pending, listKey, { now, before, listHtml }) {
  if (!listKey || typeof now !== 'string' || now === before || typeof listHtml !== 'string') return pending;
  const out = openBoxEdit(pending, listKey, listHtml);
  // A list brought back whole from a draft or an earlier version is the text
  // of a file, and is written as it is. Typed in since, it is no longer that
  // text: it is written from it, with the change put into it, as main.js
  // stagePending keeps it when the box is left (list-as-file.js).
  const was = pending.get(listKey);
  if (out !== pending && was && was.whole) {
    const { whole, ...rest } = out.get(listKey);
    out.set(listKey, { ...rest, from: was.html });
  }
  return out;
}

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
 *   shown:         the number the Publish button showed for these edits (a
 *                  picture and its description are two). Kept as `n`, so the
 *                  offer to bring them back says the same number.
 */
export function draftRecord(pending, pendingSource, now = Date.now(), typed = null, shown = null) {
  const t = typedRecord(typed);
  if (!pending.size && !pendingSource.size && !t) return null;
  const record = { ts: now, edits: Object.fromEntries(pending) };
  if (pendingSource.size) record.source = Object.fromEntries(pendingSource);
  if (t) record.typed = t;
  if (Number.isInteger(shown) && shown > 0 && (pending.size || pendingSource.size)) record.n = shown;
  return record;
}

/**
 * What a saved copy offers back: { edits, source, count } and `typed` when it
 * holds something that was being typed, or null when it is unreadable, empty,
 * or older than a week.
 * `known(ref)` says whether a content-file field is on this page and can be
 * edited now; an edit to one that is not is left behind.
 * `keep` is how long a copy is offered back: a week unless something else is
 * said (waiting.js keptFor).
 */
export function readDraft(saved, { now = Date.now(), known = () => true, keep = WEEK } = {}) {
  if (!saved || typeof saved !== 'object' || !saved.edits || typeof saved.edits !== 'object') return null;
  if (now - saved.ts > (Number.isFinite(keep) && keep > 0 ? keep : WEEK)) return null;
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
  // The number to say: the one the Publish button showed when this was saved.
  // The parts are counted instead when that was not kept, or when an edit is left behind here.
  const parts = Object.keys(saved.edits).length + Object.keys(source).length;
  const whole = Object.keys(source).length === Object.keys(stored).length;
  const count = parts && whole && Number.isInteger(saved.n) && saved.n > 0 ? saved.n : parts;
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

// ─── What lets a page's edits be published without the page open ─────────────
// Three fields beside `edits` and `source`:
//   page:      { path, url?, title?, sha? }: the page's file in the repository,
//              its address on the site, its title, and the version of the file
//              the edits were made against (git's name for the file's text).
//   more:      { key: { was?, base?, shared? } }, keyed like `edits`:
//                was     the part's text in the file when the person began, to
//                        tell "someone changed this part" from "someone changed
//                        another part";
//                base    an edited list as the page showed it before the edit,
//                        which a list needs to be written back without losing
//                        what the editor's cleaner does not know (list-as-file.js);
//                shared  true for an edit inside a part shared across pages
//                        (data-cms-partial), which goes to every page that has it.
//   sourceWas: { ref: value }, keyed like `source`: what a content-file field
//              held when the page was read (source-fields.js readAs), sent with
//              the edit so the service does not write over someone else's change.
// What is read back from the browser's storage is not taken on trust: each
// reader below gives only what is of the right kind, and nothing for the rest.

const PATH_MAX = 1024, URL_MAX = 2048, TITLE_MAX = 300;
const plainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// No control character anywhere in a path or an address (a tab or a new line inside one is dropped by browsers, which would change where it leads).
const clean = (s) => !/[\u0000-\u001f\u007f]/.test(s);

/** A file's path in the repository: relative, no "." or ".." step, no empty step, no backslash. */
function repoPath(v) {
  if (typeof v !== 'string' || !v || v.length > PATH_MAX || !clean(v) || v.includes('\\')) return null;
  return v.split('/').every(step => step && step !== '.' && step !== '..') ? v : null;
}
/** An address on this site: a path from the site's root, and never another site, a scheme or a script. */
function siteUrl(v) {
  if (typeof v !== 'string' || v.length > URL_MAX || !clean(v) || v.includes('\\')) return null;
  return /^\/(?!\/)/.test(v) ? v : null;
}

/**
 * The page a saved copy belongs to: { path } with `url`, `title` and `sha` when
 * the copy holds them as they should be, or null when it names no file (a copy
 * from an editor before this, or one that was tampered with). The title is
 * text and is to be shown as text.
 */
export function savedPage(saved) {
  const p = plainObject(saved) && plainObject(saved.page) ? saved.page : null;
  const path = p ? repoPath(p.path) : null;
  if (!path) return null;
  const out = { path };
  const url = siteUrl(p.url);
  if (url) out.url = url;
  if (typeof p.title === 'string' && p.title.trim()) out.title = p.title.trim().slice(0, TITLE_MAX);
  if (typeof p.sha === 'string' && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(p.sha)) out.sha = p.sha;
  return out;
}

/**
 * What a saved copy holds beside each of its edits: { key: { was?, base?,
 * shared? } }, only for keys `edits` holds, and only what is of the right
 * kind. `base` is kept only beside an edit that holds HTML. An edit with
 * nothing beside it is left out, and so is everything in a copy from before.
 */
export function savedMore(saved) {
  const out = {};
  if (!plainObject(saved) || !plainObject(saved.edits) || !plainObject(saved.more)) return out;
  for (const [key, edit] of Object.entries(saved.edits)) {
    const m = Object.hasOwn(saved.more, key) ? saved.more[key] : null;
    if (!plainObject(m) || !plainObject(edit)) continue;
    const one = {};
    if (typeof m.was === 'string') one.was = m.was;
    if (typeof m.base === 'string' && edit.html !== undefined) one.base = m.base;
    if (m.shared === true) one.shared = true;
    if (Object.keys(one).length) Object.defineProperty(out, key, { value: one, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

const scalar = (v) => typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));
/** A value a content-file field can hold as it is sent to the service: text, a number, yes or no, or a short list of those. */
const fieldValue = (v) => scalar(v) || (Array.isArray(v) && v.length <= 200 && v.every(scalar));

/**
 * What each content-file field of a saved copy held when its page was read:
 * { ref: value }, only for the fields `source` holds an edit to. A field
 * with nothing known is left out, and its edit is sent as it always was.
 */
export function savedSourceWas(saved) {
  const out = {};
  if (!plainObject(saved) || !plainObject(saved.source) || !plainObject(saved.sourceWas)) return out;
  for (const ref of Object.keys(saved.source)) {
    if (!Object.hasOwn(saved.sourceWas, ref) || !fieldValue(saved.sourceWas[ref])) continue;
    Object.defineProperty(out, ref, { value: saved.sourceWas[ref], enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/**
 * A saved copy (what draftRecord gives) with what is known of its page put
 * beside the edits: `page`, `more` and `sourceWas` as described above, each
 * only when there is something of the right kind to say. `edits`, `source`,
 * `typed`, `n` and `ts` are the same objects, untouched, so what is offered
 * back and what "it is saved" means do not change. A copy with no edits (only
 * something that was being typed) is given back as it is, and so is null.
 */
export function pageRecord(record, { page, more, sourceWas } = {}) {
  if (!record || (!Object.keys(record.edits || {}).length && !Object.keys(record.source || {}).length)) return record;
  const out = { ...record };
  delete out.page; delete out.more; delete out.sourceWas;
  const p = savedPage({ page });
  if (p) out.page = p;
  const m = savedMore({ edits: record.edits, more });
  if (Object.keys(m).length) out.more = m;
  const w = savedSourceWas({ source: record.source, sourceWas });
  if (Object.keys(w).length) out.sourceWas = w;
  return out;
}
