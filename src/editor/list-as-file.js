/**
 * Writing a list of blocks back into the page's file without touching what
 * the owner did not change.
 *
 * A list (`data-cms-repeat`) used to be published as the editor read it off
 * the page: the whole container, cleaned, written over what the file held.
 * Cleaning keeps only the markup the editor itself knows, so everything else
 * in every block went with it. A site whose cards each held a small inline
 * `<svg>` drawing lost all three drawings when the owner changed one card's
 * title, and the owner's own screen went on showing them.
 *
 * Now the file's own text is the thing that is written. Each block on the
 * page is traced to the block of the file it came from, and that block's text
 * is kept byte for byte. Only what the person changed is written into it: the
 * inside of a field whose words changed, an attribute a tool set (a picture's
 * address, a link, a block's tags). Blocks that moved are moved as text,
 * a copied block is the file's text of the block it was copied from, a block
 * that was removed goes. What a person typed or pasted is still cleaned, as
 * before: it is the only part that comes from the page.
 *
 * Why not teach the cleaner about safe SVG instead: a cleaner can only ever
 * know a list of things, and the next site holds something not on it (an
 * embed, an attribute a script reads, a custom element). Keeping the file's
 * text needs no such list, and it also keeps the file's own spacing and
 * quoting, so the commit shows the one change that was made.
 *
 * When a block cannot be traced to the file and cleaning would take something
 * out of it, nothing is written: `ok` is false, and the editor says so
 * (LIST_NOT_WHOLE) and publishes nothing.
 *
 * Pure, and tested in node. Reading a piece of HTML the way the editor stages
 * it needs a browser, so it is handed in as `read`.
 *
 * A block, as read:
 *   { html,    the block as the editor would write it by itself (cleaned)
 *     lost,    true when cleaning took something out of it
 *     parts }  the block's own element first, then every `data-cms` element
 *              in it, in order. Each: { key, html, own, attrs, inside } where
 *              key is null for a block that is not itself a field, `html` is
 *              its inside, `own` is its inside with the fields it holds
 *              emptied, `attrs` the attributes a tool may set, and `inside`
 *              the place in `parts` of the field holding it, or -1.
 */

import { parseFragment, defaultTreeAdapter, html as H } from 'parse5';
import { attrNameAllowed, safeUrl, safeStyle, attrValueRange, emitAttrValue, VOID_TAGS } from '../engine.js';

/** What the editor says when a list cannot be written without losing something. */
export const LIST_NOT_WHOLE = (name) => `Nothing was published. The list “${name}” holds something that Kiln cannot write back exactly as it is, so publishing would have changed more than you did. Your edits are still here. Reload the page and make the change again. If you see this again, that list has to be changed in the page’s file.`;
export const LIST_NOT_WHOLE_DRAFT = (name) => `The draft was not saved. The list “${name}” holds something that Kiln cannot write back exactly as it is. Your edits are still here.`;

/** Thrown where a list is turned into the text to write, when that cannot be done without loss. */
export class ListLoss extends Error {
  constructor(key) { super(`the list "${key}" cannot be written without loss`); this.name = 'ListLoss'; this.key = key; }
}

const context = (tag) => defaultTreeAdapter.createElement(String(tag || 'div').toLowerCase(), H.NS.HTML, []);
const blank = (s) => !/\S/.test(s);
const keysOf = (block) => block.parts.map(p => (p.key == null ? '' : `=${p.key}`)).join('\u0001');

/** Is this block of the page the same block as that one of the file? It reads the same, or has the same fields and at least one of them reads the same. */
const akin = (a, b) => a.html === b.html || (keysOf(a) === keysOf(b)
  && (!a.parts.some(p => p.key != null) || a.parts.some((p, k) => p.key != null && p.own === b.parts[k].own)));

/** Where each element at the top of `text` starts and ends. */
function topElements(tag, text) {
  const frag = parseFragment(context(tag), text, { sourceCodeLocationInfo: true });
  return frag.childNodes
    .filter(n => n.tagName && n.sourceCodeLocation)
    .map(n => ({ start: n.sourceCodeLocation.startOffset, end: n.sourceCodeLocation.endOffset }));
}

/** Where a block's own element and each field in it sit in the block's text, in the order `parts` has them. */
function locate(tag, raw) {
  const frag = parseFragment(context(tag), raw, { sourceCodeLocationInfo: true });
  const root = frag.childNodes.find(n => n.tagName);
  if (!root) return null;
  const out = [];
  let whole = true;
  const visit = (node, isRoot) => {
    if (!node.tagName) return;
    const cms = node.attrs.find(a => a.name === 'data-cms');
    if (isRoot || cms) {
      const loc = node.sourceCodeLocation, st = loc && loc.startTag;
      if (!st) { whole = false; return; }
      const tagText = raw.slice(st.startOffset, st.endOffset);
      const attrs = new Map();
      for (const [name, a] of Object.entries(st.attrs || {})) attrs.set(name, { start: a.startOffset, end: a.endOffset, value: attrValueRange(raw, a) });
      out.push({
        key: cms ? cms.value : null,
        start: st.startOffset,
        inner: VOID_TAGS.has(node.tagName) ? null : { start: st.endOffset, end: loc.endTag ? loc.endTag.startOffset : loc.endOffset },
        attrInsert: st.endOffset - (tagText.endsWith('/>') ? 2 : 1),
        attrs,
      });
    }
    for (const c of node.childNodes || []) visit(c, false);
  };
  visit(root, true);
  return whole ? out : null;
}

const attrText = (name, value) => (name === 'href' || name === 'src' ? safeUrl(value) : name === 'style' ? safeStyle(value) : String(value));

/**
 * The file's text of one block with what changed written into it: `now` is
 * the block as it is on the page, `was` the same block before the change.
 * Null when the places cannot be found in the text.
 */
function writeParts(tag, raw, now, was) {
  const locs = locate(tag, raw);
  if (!locs || locs.length !== now.parts.length || locs.length !== was.parts.length) return null;
  if (locs.some((l, k) => l.key !== (now.parts[k].key ?? null))) return null;
  const splices = [];
  let writtenUntil = -1;   // the end of a field already written whole: the fields inside it are in what was written
  for (let k = 0; k < locs.length; k++) {
    const l = locs[k], n = now.parts[k], w = was.parts[k];
    if (l.start < writtenUntil) continue;
    for (const name of new Set([...Object.keys(n.attrs || {}), ...Object.keys(w.attrs || {})])) {
      const to = (n.attrs || {})[name], from = (w.attrs || {})[name];
      if (to === from || !attrNameAllowed(name)) continue;
      const at = l.attrs.get(name);
      if (to === undefined) {
        // taken off: the attribute goes, with the space before it
        if (at) splices.push({ start: at.start - (/\s/.test(raw[at.start - 1] || '') ? 1 : 0), end: at.end, text: '' });
      } else if (at && at.value) {
        splices.push({ start: at.value.start, end: at.value.end, text: emitAttrValue(attrText(name, to), at.value.quote) });
      } else {
        const written = `${name}=${emitAttrValue(attrText(name, to), null)}`;
        if (at) splices.push({ start: at.start, end: at.end, text: written });
        else splices.push({ start: l.attrInsert, end: l.attrInsert, text: ` ${written}` });
      }
    }
    if (n.key != null && n.own !== w.own) {
      if (!l.inner) return null;
      splices.push({ start: l.inner.start, end: l.inner.end, text: String(n.html ?? '') });
      writtenUntil = l.inner.end;
    }
  }
  splices.sort((a, b) => b.start - a.start || b.end - a.end);
  let out = raw;
  for (const s of splices) out = out.slice(0, s.start) + s.text + out.slice(s.end);
  return out;
}

/**
 * The text to put inside a list in the file.
 *   tag:  the list's own tag name ('div', 'ul', 'tbody' …)
 *   text: what the file holds inside the list
 *   now:  the list as the editor staged it (HTML)
 *   base: the list as it was on the page before the change (HTML), when known:
 *         what `now` is compared with to tell what the person changed. Used
 *         only when it lines up with the file block for block; otherwise the
 *         file's own text is what `now` is compared with.
 *   lost: the places in `now` of blocks that cleaning took something out of
 *   read: (html) => the blocks in it, as described at the top
 * Returns { ok: true, html } or { ok: false, block } (the place of the block
 * that could not be written without loss).
 */
export function listAsFile({ tag = 'div', text, now, base = null, lost = [], read }) {
  const src = String(text ?? '');
  // The file's blocks. An element at the top of the list that is no block to
  // the editor (a template, a script) is left where it is, like a comment.
  const blocks = [];
  for (const p of topElements(tag, src)) {
    const got = read(src.slice(p.start, p.end));
    if (got.length === 1) blocks.push({ ...p, read: got[0] });
  }
  const fileRead = blocks.map(b => b.read);
  let was = fileRead;
  if (base != null) {
    const b = read(base);
    if (b.length === blocks.length && b.every((r, i) => akin(r, fileRead[i]))) was = b;
  }
  const nowBlocks = read(now);

  // Which block of the file each block on the page came from.
  const from = nowBlocks.map(() => -1);
  const used = new Set();
  const take = (j, i) => { from[j] = i; used.add(i); };
  nowBlocks.forEach((n, j) => { if (was[j] && was[j].html === n.html) take(j, j); });
  nowBlocks.forEach((n, j) => {
    if (from[j] !== -1) return;
    const i = was.findIndex((w, k) => !used.has(k) && w.html === n.html);
    if (i !== -1) take(j, i);
  });
  // A block that was changed, or copied: the block with the same fields that it reads most like, the nearest first.
  nowBlocks.forEach((n, j) => {
    if (from[j] !== -1) return;
    let best = -1, top = -Infinity;
    was.forEach((w, i) => {
      if (keysOf(w) !== keysOf(n)) return;
      let alike = 0;
      w.parts.forEach((p, k) => { if (p.own === n.parts[k].own) alike++; });
      const score = alike * 4 + (used.has(i) ? 0 : 2) + (i === j ? 1 : 0) - Math.abs(i - j) / 1000;
      if (score > top) { top = score; best = i; }
    });
    if (best !== -1) take(j, best);
  });

  const out = [];
  for (let j = 0; j < nowBlocks.length; j++) {
    const n = nowBlocks[j], i = from[j];
    if (i === -1) {
      // Not from the file: a block the page made. Written as it was cleaned, unless cleaning took something out.
      if (lost.includes(j) || n.lost) return { ok: false, block: j };
      out.push({ i, text: n.html });
      continue;
    }
    const raw = src.slice(blocks[i].start, blocks[i].end);
    if (was[i].html === n.html) { out.push({ i, text: raw }); continue; }
    const written = writeParts(tag, raw, n, was[i]);
    if (written != null) { out.push({ i, text: written }); continue; }
    // The places could not be found. Writing the block as cleaned is safe only when cleaning takes nothing out of the file's own.
    if (lost.includes(j) || n.lost || fileRead[i].lost) return { ok: false, block: j };
    out.push({ i, text: n.html });
  }

  // Every block where it was: the file's text, with the changed blocks in place.
  if (out.length === blocks.length && out.every((o, m) => o.i === m)) {
    let s = '', at = 0;
    blocks.forEach((b, m) => { s += src.slice(at, b.start) + out[m].text; at = b.end; });
    return { ok: true, html: s + src.slice(at) };
  }
  // Blocks were added, removed or moved. Each keeps the space the file had before it.
  if (!blocks.length) return { ok: true, html: src + out.map(o => o.text).join('\n') };
  const lead = blocks.map((b, m) => src.slice(m ? blocks[m - 1].end : 0, b.start));
  const tail = src.slice(blocks[blocks.length - 1].end);
  const between = lead.slice(1).find(blank) ?? ((lead[0].match(/\s*$/) || [''])[0] || '\n');
  const leadUsed = new Set([0]);
  let s = lead[0];
  out.forEach((o, m) => {
    if (m) {
      if (o.i > 0 && !leadUsed.has(o.i) && blank(lead[o.i])) { s += lead[o.i]; leadUsed.add(o.i); }
      else s += between;
    }
    s += o.text;
  });
  // What stood before a block and is more than space (a comment, a template) stays, after the blocks.
  lead.forEach((l, i) => { if (i && !blank(l)) s += l; });
  return { ok: true, html: s + tail };
}
