/**
 * Section scope, held by the server.
 *
 * An owner can limit an invited editor to some parts of a page: the
 * `data-cms` keys in the editor's scope (`keys`), matched exactly or by
 * prefix (keyInScope, the same rule the editor's screen, suggestions and API
 * tokens use). The editor's screen only offers those parts; this module is
 * what makes the limit true for a save sent straight at the worker.
 *
 * checkSectionWrite(oldText, newText, keys) compares the page's current file
 * with the one being saved and allows the save only when:
 *   - every part of the file OUTSIDE the editor's parts is byte-for-byte the
 *     same, in the same order (same marked parts, same text between them);
 *   - inside an allowed part, anything may change (the content guard in
 *     sanitize-guard.js still judges the markup, as for every editor write),
 *     except that it may not take in a part named for a key from elsewhere;
 *   - an allowed part's own start tag changes only in the settings an edit
 *     can make (the engine's attrNameAllowed: a picture's src/alt, a link's
 *     href, …), never its data-cms* markers. Swapping a <picture>'s image may
 *     drop that picture's <source> elements, as the engine's own swap does.
 *
 * Allowed parts: an element marked `data-cms` (not inside a list) or
 * `data-cms-repeat` whose key is in scope, with everything inside it. A
 * field inside a list is governed by its list, as on the editor's screen. A
 * list anchor (`data-cms-list`) and the site menu (`data-cms-menu`) are never
 * an editor's part: they belong to new pages and to the whole site.
 *
 * The page is read with parse5 and source offsets, the same way the engine
 * (src/engine.js indexHtml) reads it. Pure: no network, no worker state.
 */

import { parse } from 'parse5';
import { attrNameAllowed } from '../src/engine.js';

export const SECTION_CODE = 'section_scope';

/** Section-key scope: exact or prefix. No keys = the whole page. */
export function keyInScope(key, keys) {
  if (!Array.isArray(keys) || !keys.length) return true;
  return keys.some(p => key === p || String(key).startsWith(p));
}

/** Does this scope limit an editor to some parts of a page at all? */
export function hasSectionLimit(keys) {
  return Array.isArray(keys) && keys.length > 0 && !keys.includes('');
}

const KINDS = { 'data-cms': 'field', 'data-cms-list': 'list', 'data-cms-repeat': 'repeat', 'data-cms-menu': 'menu' };
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr']);
const HEAD_TAGS = new Set(['head', 'title', 'meta', 'link', 'base']);

const LIMITED = 'Your access covers only some parts of this page';
const refusal = (error, part = null) => ({ code: SECTION_CODE, error, ...(part ? { part } : {}) });

/** The refusals for whole-file changes a section-limited editor cannot make. */
export const SECTION_REFUSALS = {
  newPage: refusal(`${LIMITED}, so you cannot add a new page. Ask the site owner to add it.`),
  theme: refusal(`${LIMITED}, so you cannot change the site’s theme or stylesheets.`),
  otherFile: refusal(`${LIMITED}, so you can change only those parts, not other files of the site.`),
  duplicate: refusal(`${LIMITED}, so you cannot make a copy of a page or an entry.`),
  unreadable: refusal('This page’s file could not be read as plain UTF-8 text, so Kiln cannot check which parts this save changes. Ask the site owner to make this change.'),
};

/** A refusal for a scheduled edit to a part outside the editor's parts. */
export function scheduledKeyRefusal(key) {
  return refusal(`${LIMITED}: “${key}” is outside the parts you can edit, so it cannot be scheduled.`, key);
}

/**
 * Decode a file's bytes as UTF-8, refusing anything that is not (null). A
 * leading byte-order mark is kept, so "the same bytes" means the same bytes.
 */
export function strictUtf8(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return null; }
}
export function strictUtf8FromB64(b64) {
  let bin;
  try { bin = atob(String(b64).replace(/\s/g, '')); } catch { return null; }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return strictUtf8(bytes);
}

/** Every element with its offsets; marked parts in tree order, each told whether it is the editor's. */
function indexPage(raw, keys) {
  const doc = parse(raw, { sourceCodeLocationInfo: true });
  const elements = [];
  const marked = [];
  const visit = (node, ctx) => {
    let here = ctx;
    if (node.tagName && node.sourceCodeLocation) {
      const loc = node.sourceCodeLocation;
      const el = { tag: node.tagName, start: loc.startOffset, end: loc.endOffset, depth: ctx.depth, head: ctx.head || HEAD_TAGS.has(node.tagName), mark: null };
      elements.push(el);
      here = { ...ctx, depth: ctx.depth + 1, head: el.head };
      const keyAttr = (node.attrs || []).find(a => KINDS[a.name]);
      if (keyAttr && keyAttr.value && loc.startTag) {
        const kind = KINDS[keyAttr.name];
        const key = keyAttr.value;
        let inner = null;
        if (!VOID_TAGS.has(node.tagName)) {
          const innerEnd = loc.endTag ? loc.endTag.startOffset : loc.endOffset;
          if (innerEnd >= loc.startTag.endOffset) inner = { start: loc.startTag.endOffset, end: innerEnd };
        }
        const allowed = !ctx.top && keyInScope(key, keys)
          && (kind === 'repeat' || (kind === 'field' && !ctx.inRepeat));
        const m = {
          kind, key, tag: node.tagName, el,
          startTag: { start: loc.startTag.startOffset, end: loc.startTag.endOffset },
          inner, attrs: new Map((node.attrs || []).map(a => [a.name, a.value])),
          allowed, top: ctx.top,   // top: the editor's part this one sits inside, or null
          inRepeat: ctx.inRepeat,
          sources: null,
        };
        el.mark = m;
        // A swappable picture: its <source> siblings, which a src swap drops.
        if (allowed && node.tagName === 'img' && node.parentNode && node.parentNode.tagName === 'picture') {
          m.sources = (node.parentNode.childNodes || [])
            .filter(s => s.tagName === 'source' && s.sourceCodeLocation)
            .map(s => ({ start: s.sourceCodeLocation.startOffset, end: s.sourceCodeLocation.endOffset }));
        }
        marked.push(m);
        here = { ...here, top: ctx.top || (allowed ? m : null), inRepeat: ctx.inRepeat || kind === 'repeat' };
      }
    }
    for (const c of node.childNodes || []) visit(c, here);
  };
  visit(doc, { depth: 0, head: false, top: null, inRepeat: false });
  return { elements, marked };
}

/** The text of a page outside the editor's parts, as pieces between those parts. */
function outsidePieces(raw, parts, cuts = []) {
  const ranges = [];
  for (const m of parts) {
    ranges.push({ ...m.startTag, sep: true });
    if (m.inner) ranges.push({ ...m.inner, sep: true });
  }
  for (const c of cuts) ranges.push({ ...c, sep: false });
  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  const pieces = [];
  let cur = { text: '', spans: [] };
  let at = 0;
  for (const r of ranges) {
    if (r.start < at) return null;   // overlapping ranges: nothing this module can vouch for
    cur.text += raw.slice(at, r.start);
    cur.spans.push([at, r.start]);
    at = r.end;
    if (r.sep) { pieces.push(cur); cur = { text: '', spans: [] }; }
  }
  cur.text += raw.slice(at);
  cur.spans.push([at, raw.length]);
  pieces.push(cur);
  return pieces;
}

/** Where in the old file a change at `offset` is, in words. */
function describeAt(index, offset) {
  let best = null, bestMark = null;
  for (const el of index.elements) {
    if (offset < el.start || offset >= el.end) continue;
    if (!best || el.depth > best.depth) best = el;
    // The editor's own parts are not "outside"; a change at one's end tag is named by what holds it.
    // A field inside a list is named by its list, which governs it.
    if (el.mark && !el.mark.allowed && !el.mark.top && !(el.mark.kind === 'field' && el.mark.inRepeat) && (!bestMark || el.depth > bestMark.el.depth)) bestMark = el.mark;
  }
  if (bestMark) return describePart(bestMark);
  if (best && best.head) return { what: 'the page’s settings (its title, description or other details in the page’s head)', part: null };
  if (best && best.tag !== 'html' && best.tag !== 'body') return { what: `a part of the page outside your parts (a <${best.tag}> element)`, part: null };
  return { what: 'the page outside your parts', part: null };
}
function describePart(m) {
  if (m.kind === 'menu') return { what: `the site menu (“${m.key}”)`, part: m.key };
  return { what: `“${m.key}”, a part outside the parts you can edit`, part: m.key };
}

function firstDifference(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return n;
}
function oldOffset(piece, i) {
  let left = i;
  for (const [s, e] of piece.spans) {
    if (left < e - s) return s + left;
    left -= e - s;
  }
  const last = piece.spans[piece.spans.length - 1];
  return last ? last[1] : 0;
}

/**
 * Does saving `newText` over `oldText` change anything outside the parts
 * `keys` allows? null when the save may go ahead (or when `keys` sets no
 * limit), else { code, error, part? } with the first thing changed outside.
 */
export function checkSectionWrite(oldText, newText, keys) {
  if (!hasSectionLimit(keys)) return null;
  if (typeof oldText !== 'string' || typeof newText !== 'string') return SECTION_REFUSALS.unreadable;
  if (oldText === newText) return null;
  let a, b;
  try { a = indexPage(oldText, keys); b = indexPage(newText, keys); }
  catch { return SECTION_REFUSALS.unreadable; }
  const changed = (d) => refusal(`${LIMITED}. This save also changes ${d.what}, so it was not saved.`, d.part);

  const aTop = a.marked.filter(m => !m.top);
  const bTop = b.marked.filter(m => !m.top);
  const aParts = aTop.filter(m => m.allowed), bParts = bTop.filter(m => m.allowed);
  const moved = (m) => refusal(`${LIMITED}. This save adds, removes or moves ${describePart(m).what}, so it was not saved.`, m.key);

  // 1. Everything between and around the editor's parts, byte for byte. (When
  //    the editor's parts line up, this also names a change most exactly.)
  const sameParts = aParts.length === bParts.length
    && aParts.every((x, i) => x.kind === bParts[i].kind && x.key === bParts[i].key && x.tag === bParts[i].tag);
  if (sameParts) {
    const cuts = [];
    for (let i = 0; i < aParts.length; i++) {
      const x = aParts[i], y = bParts[i];
      if (x.sources && x.sources.length && x.attrs.get('src') !== y.attrs.get('src') && !(y.sources && y.sources.length)) cuts.push(...x.sources);
    }
    const pa = outsidePieces(oldText, aParts, cuts) || outsidePieces(oldText, aParts);
    const pb = outsidePieces(newText, bParts);
    if (!pa || !pb || pa.length !== pb.length) return changed({ what: 'the page outside your parts', part: null });
    for (let i = 0; i < pa.length; i++) {
      if (pa[i].text === pb[i].text) continue;
      const d = describeAt(a, oldOffset(pa[i], firstDifference(pa[i].text, pb[i].text)));
      // Nothing marked holds the change, but a part was added or removed: step 2 names it.
      if (!d.part && aTop.length !== bTop.length) break;
      return changed(d);
    }
  }

  // 2. The same marked parts outside the editor's parts, in the same order, as
  //    the page is read: the same bytes outside can still be read another way
  //    if something inside one of the editor's parts was left open.
  const n = Math.min(aTop.length, bTop.length);
  for (let i = 0; i < n; i++) {
    const x = aTop[i], y = bTop[i];
    if (x.kind === y.kind && x.key === y.key && x.tag === y.tag && x.allowed === y.allowed) continue;
    const isIn = (list, m) => list.some(o => o.key === m.key && o.kind === m.kind);
    if (!isIn(aTop, y)) return moved(y);   // added
    if (!isIn(bTop, x)) return moved(x);   // removed
    return moved(x.allowed ? y : x);
  }
  if (aTop.length !== bTop.length) return moved(aTop.length > bTop.length ? aTop[n] : bTop[n]);
  if (!sameParts) return changed({ what: 'the page outside your parts', part: null });   // step 2 differs first; kept as a floor

  // 3. Each of the editor's parts: only the settings an edit can make, and no
  //    part taken in from elsewhere.
  for (let i = 0; i < aParts.length; i++) {
    const x = aParts[i], y = bParts[i];
    for (const name of new Set([...x.attrs.keys(), ...y.attrs.keys()])) {
      if (x.attrs.get(name) === y.attrs.get(name)) continue;
      if (!attrNameAllowed(name)) {
        return refusal(`${LIMITED}. This save changes the “${name}” setting of “${x.key}”, which an edit cannot change, so it was not saved.`, x.key);
      }
    }
    const had = new Set(a.marked.filter(m => m.top === x).map(m => m.key));
    for (const m of b.marked) {
      if (m.top !== y || had.has(m.key) || keyInScope(m.key, keys)) continue;
      return refusal(`${LIMITED}. This save puts a part named “${m.key}” inside “${x.key}”, and that name is outside the parts you can edit, so it was not saved.`, m.key);
    }
  }
  return null;
}
