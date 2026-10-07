/**
 * Formatted text from a site's content files, edited on the page.
 *
 * An entry's body (or a field stamped `?type=markdown`) is Markdown in the
 * file and HTML on the page. To edit it with the same toolbar as a plain HTML
 * site, the editor reads the file, matches each block on the page to its
 * block in the file (by what it says), and when the person is done writes
 * back only what changed, in the file's own style (src/adapters/markdown.js).
 *
 * What the editor cannot write back exactly stays on the page as it renders
 * and is not editable: a table, a code block, raw HTML, and in MDX a
 * component or an expression. A paragraph that holds HTML or a component
 * inside it is kept the same way. Pictures in the text are kept as the file
 * wrote them (Astro shows its optimised copies at other addresses).
 *
 * DOM-light on purpose: every function takes an element with nodeType,
 * tagName, childNodes, getAttribute and setAttribute, so the tests run it on
 * real rendered HTML in node (test/tiny-dom.js).
 */

import {
  matchBlocks, blockMarkdown, sniffStyle, planBody, keptInlines, rewritable, domWords, plainWords, lines,
} from '../adapters/markdown.js';

export const KEEP_ATTR = 'data-kiln-keep';
const PROSE_TAGS = /^(?:P|H[1-6]|UL|OL|BLOCKQUOTE|HR)$/;

const kids = (el) => Array.from(el?.childNodes || []);
const tagOf = (n) => String(n?.tagName || '').toUpperCase();
const isWhite = (n) => n.nodeType === 3 && !String(n.nodeValue ?? n.data ?? '').trim();
const isComment = (n) => n.nodeType === 8;

/** The front matter fence and where the body starts, for YAML (---) and TOML (+++) front matter. */
export function bodyOf(fileText) {
  const t = String(fileText);
  const m = /^﻿?(---|\+\+\+)[ \t]*\r?\n/.exec(t);
  if (!m) return { start: 0, body: t };
  const close = new RegExp(`^${m[1] === '---' ? '(?:---|\\.\\.\\.)' : '\\+\\+\\+'}[ \\t]*(?:\\r?\\n|$)`, 'm').exec(t.slice(m[0].length));
  if (!close) return { start: 0, body: t };
  const start = m[0].length + close.index + close[0].length;
  return { start, body: t.slice(start) };
}

/**
 * The page's top-level parts of a formatted text: its blocks when it has
 * blocks, else (a short text rendered inside one element) the element itself
 * as one paragraph.
 */
function pageParts(el) {
  const parts = kids(el).filter(n => !isWhite(n) && !isComment(n));
  if (parts.some(n => n.nodeType === 3 || (n.nodeType === 1 && !PROSE_TAGS.test(tagOf(n)) && /^(?:A|B|STRONG|I|EM|CODE|SPAN|BR|S|DEL|IMG|SUP|SUB|MARK|U|SMALL|ABBR|Q|CITE|TIME)$/.test(tagOf(n))))) {
    return { inline: true, parts: [el] };
  }
  return { inline: false, parts };
}

/**
 * Get a formatted text ready to edit: match the page to the file's text,
 * keep (read-only, exactly as written) what cannot be written back, and say
 * what the page held. `text` is the Markdown the field holds in the file.
 *
 * Returns { ok: true, prep } or { ok: false, why } where `why` is
 * 'changed' (the file says something else than the page: someone changed it
 * since the page was built), 'unmatched' (the page and the file do not line
 * up), or 'empty'.
 */
export function prepare(el, text, { mdx = false } = {}) {
  const { inline, parts } = pageParts(el);
  if (!parts.length && !String(text).trim()) return { ok: false, why: 'empty' };
  const prose = inline ? parts : parts.filter(n => n.nodeType === 1 && PROSE_TAGS.test(tagOf(n)));
  const page = prose.map(n => ({ tag: inline ? 'P' : tagOf(n), words: domWords(n) }));
  const m = matchBlocks(text, page, { mdx });
  if (m.error) return { ok: false, why: m.error, at: m.at };
  const style = sniffStyle(text);
  const opts = { mdx, refs: m.refs };

  // Pictures in the text: kept as the file wrote them, matched in order by their descriptions.
  const kept = [];
  const images = keptInlines(text, opts).filter(k => k.type === 'image');
  const pageImages = [];
  const collect = (n) => { for (const c of kids(n)) { if (tagOf(c) === 'IMG') pageImages.push(c); else if (c.nodeType === 1) collect(c); } };
  for (const n of prose) collect(n);
  const imagesMatch = images.length === pageImages.length
    && images.every((im, k) => plainWords(im.alt) === plainWords(pageImages[k].getAttribute('alt') || ''));

  // Blocks: what stays as written, and what can be typed in.
  let keep = 0;
  const lock = (n) => { n.setAttribute(KEEP_ATTR, `b${keep++}`); n.setAttribute('contenteditable', 'false'); };
  const source = [];
  prose.forEach((n, k) => {
    const blk = m.blocks[k];
    const raw = text.slice(blk.start, blk.end);
    const hasImage = /!\[/.test(raw);
    if (!rewritable(raw, opts) || (hasImage && !imagesMatch) || inline && !rewritable(raw, opts)) {
      if (inline) return;   // nothing of a one-part text can be locked apart from it: the caller locks the field
      lock(n);
      return;
    }
    source.push(blk);
  });
  if (inline && !source.length) return { ok: false, why: 'unwritable' };
  if (!inline) for (const n of parts) if (!(n.nodeType === 1 && PROSE_TAGS.test(tagOf(n)))) {
    if (n.nodeType === 1) lock(n);
    else return { ok: false, why: 'unmatched' };   // loose words at the top level: nothing to anchor them to
  }
  if (imagesMatch) pageImages.forEach((img, k) => {
    kept[k] = images[k].raw;
    img.setAttribute(KEEP_ATTR, String(k));
  });
  const prep = { text, inline, style, kept, source, opts };
  prep.before = readPage(el, prep);
  return { ok: true, prep };
}

/** The page's blocks now: [{ md } | { keep }], in the file's style. */
export function readPage(el, prep) {
  if (prep.inline) return [{ md: blockMarkdown(wrapP(el), prep.style, prep.opts) }];
  const out = [];
  for (const n of kids(el)) {
    if (isWhite(n) || isComment(n)) continue;
    const keep = n.nodeType === 1 ? n.getAttribute(KEEP_ATTR) : null;
    if (keep && keep[0] === 'b') { out.push({ keep }); continue; }
    if (n.nodeType === 3) { out.push({ md: blockMarkdown(n, prep.style, prep.opts) }); continue; }
    if (n.nodeType !== 1) continue;
    // A block the browser made while typing (a DIV for a new line) is a paragraph.
    const md = blockMarkdown(n, prep.style, prep.opts);
    if (md.trim()) out.push({ md });
  }
  return out;
}

/** A one-part text read as a paragraph: the element's inside, under a P. */
function wrapP(el) {
  return { nodeType: 1, tagName: 'P', childNodes: kids(el), getAttribute: () => null, textContent: el.textContent };
}

/**
 * The field's new text, changed only where the page was: { text } or
 * { error } (see planBody), or { unchanged: true }.
 */
export function plan(el, prep) {
  const after = readPage(el, prep);
  if (JSON.stringify(after) === JSON.stringify(prep.before)) return { unchanged: true };
  const r = planBody({ text: prep.text, source: prep.source, before: prep.before, after, kept: prep.kept, opts: prep.opts });
  if (r.error) return r;
  if (r.text === prep.text) return { unchanged: true };
  return { text: r.text };
}

/** Why a formatted text cannot be edited here, as a sentence; null when it can. */
export function prepSentence(why) {
  if (why === 'changed') return 'This text was changed on the site after this page was made. It can be edited here once the site has rebuilt: reload the page in a minute.';
  if (why === 'unmatched') return 'Kiln could not match this text on the page to its file, so it is left as it is. Ask the site’s owner to change it.';
  if (why === 'unwritable') return 'This text holds parts Kiln can’t write back exactly, so it is left as it is. Ask the site’s owner to change it.';
  if (why === 'unreadable') return 'The file this text comes from could not be read, so it can’t be edited here right now. Reload the page to try again.';
  return 'This text can’t be edited here. Ask the site’s owner to change it.';
}

/** What a person is told when they click a part that is kept as the file has it. */
export function keepSentence(node) {
  const tag = String(node?.tagName || '').toUpperCase();
  if (tag === 'TABLE') return 'This table is kept as the file has it: Kiln can’t edit tables in content files yet. Ask the site’s owner to change it.';
  if (tag === 'PRE') return 'This code is kept as the file has it, so it can’t be edited here. Ask the site’s owner to change it.';
  return 'This part is kept exactly as the file has it (a component, HTML or a part with them inside), so it can’t be edited here. Ask the site’s owner to change it.';
}

/** Why an edit to a formatted text was not kept, as a sentence. */
export function planSentence(error) {
  if (error === 'kept-moved') return 'A part Kiln keeps exactly as it is (a table, code, a picture block or a component) was removed or moved. Press Revert to put it back.';
  if (error === 'ambiguous') return 'Kiln can’t tell where the new paragraph goes between the parts it keeps as they are. Type it next to another paragraph instead.';
  if (error === 'not-writable') return 'This change can’t be written back to the file without losing part of it. Press Revert, then change it a different way.';
  if (error === 'unknown-part') return 'A picture or a part kept as written was copied, and Kiln can’t write the copy back. Press Revert to undo it.';
  return 'This change can’t be written back to the file. Press Revert to undo it.';
}

/**
 * What the editor marked on the page for editing, taken off again: the
 * attributes on kept parts and on pictures. (The page keeps no trace of
 * the editor once it is done.)
 */
export function unmark(el) {
  const walk = (n) => {
    for (const c of kids(n)) {
      if (c.nodeType !== 1) continue;
      if (c.getAttribute(KEEP_ATTR) !== null) { c.removeAttribute(KEEP_ATTR); if (c.getAttribute('contenteditable') === 'false') c.removeAttribute('contenteditable'); }
      walk(c);
    }
  };
  walk(el);
}

/** The words of a formatted text for the publish sheet, from its page HTML. */
export function sheetWords(el) {
  return lines(plainWords(domWords(el).replace(/\n+/g, '\n'))).map(l => l.text).join('\n');
}
