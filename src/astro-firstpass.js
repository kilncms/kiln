/**
 * A reader for the templates of a site that Astro builds (.astro files).
 *
 * On a plain HTML site the first pass (src/autotag.js) marks headings,
 * paragraphs, quotes and captions as editable. On a site Astro builds, the
 * words of a page are partly written in its templates and partly come from
 * content files or from code. This file reads one template and says which of
 * its text elements hold words only, written right there, so that a first
 * pass could take them safely, and exactly where each one is. It changes
 * nothing.
 *
 *   readAstro(text)    one .astro file: the safe text elements with their
 *                      places, and how many are left under each reason
 *   tallyAstro(files)  the numbers over many files
 *
 * Plain functions over a string: no parser package, nothing from the browser
 * and nothing from the Worker, so either side can use it.
 *
 * An .astro file is not HTML. It may open with a code fence (two `---`
 * lines), and its template holds `{ … }` code that may itself hold elements.
 * The reader walks the text once, from the end of the fence, keeping a stack
 * of what is open: an element (content is read as text) or a `{` (content is
 * read as code: strings, template strings and comments are stepped over, a
 * `<` before a letter opens an element). A file it cannot follow answers
 * `{ unread: true }`; it never throws.
 *
 * A text element is SAFE when all of these hold:
 *   - its tag is one of TEXT_TAGS, in lowercase (so it is not a component);
 *   - it is not inside `{ … }` (no loop, no condition, no other code);
 *   - its content is words only: no tag, no comment, no `{`, `}`, `<` or `&`;
 *   - no attribute of it holds code (`{ … }`, a spread, a template string) and
 *     it has no `set:html` or `set:text`;
 *   - neither it nor an element around it is already marked (`data-cms`,
 *     `data-kiln-source`, or a spread of kilnSource, kilnBody or kilnEntry);
 *   - it is in the template: not in the code fence, `<head>`, `<script>`,
 *     `<style>` or a comment (inside a component's slot is fine), and not in
 *     `<noscript>`, `<template>` or `<textarea>`, whose content a visitor's
 *     browser does not hold as elements;
 *   - it has at least one letter.
 * Every other element with one of those tags is counted under one reason, the
 * first of these that fits:
 *   marked    it, or an element around it, is already marked
 *   fromCode  its content is code only (`{ … }`, a component, `set:html`)
 *   mixed     words together with `{ … }`, or words with an attribute that
 *             holds code (the second kind is also counted in more.attrValue)
 *   withTags  words with tags, a comment or `&` among them
 *   inLoop    words only, but inside `{ … }`
 * Not counted at all (their numbers are in `more`): an element that holds
 * other text elements (holdsText: the ones inside are counted), one with no
 * letter in it (noWords), and one whose closing tag is missing (unclosed).
 */

/** The tags the first pass looks at: the same list as FIELD_TAGS in src/autotag.js. */
export const TEXT_TAGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'blockquote', 'figcaption'];

const TEXT = new Set(TEXT_TAGS);
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style']);
const UNSEEN = new Set(['head', 'noscript', 'template', 'textarea']);   // text elements inside these are not counted
const MAX_OPEN = 512;        // elements open at once; a template nested deeper than this is not followed
const MAX_OPEN_TEXT = 32;    // text elements open inside one another
const HELPER = /\bkiln(?:Source|Body|Entry)\s*\(/;   // any of Kiln's helpers marks the element itself
const HELPER_INSIDE = /\bkiln(?:Source|Body)\s*\(/;   // these two also make what is inside it editable
const NBSP = /&(?:nbsp|#160|#x[aA]0);/y;
const LETTER = /\p{L}/u;
const SPACE = /\s/;
const BRACE = { brace: true };

const isSpace = (c) => c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === '\f';
const isLetter = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
const lineEnd = (s, i) => { const k = s.indexOf('\n', i); return k < 0 ? s.length : k; };

/** After the quoted string that opens at i. A string that is not closed on its own line ends at the line's end. */
function skipQuote(s, i) {
  const q = s[i];
  let j = i + 1;
  for (; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') { j++; continue; }
    if (c === q) return j + 1;
    if (c === '\n') return j;
  }
  return s.length;
}

/** After the template string that opens at i, or -1. */
function skipTemplate(s, i) {
  let j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '`') return j + 1;
    if (c === '$' && s[j + 1] === '{') { j = skipBraces(s, j + 1); if (j < 0) return -1; continue; }
    j++;
  }
  return -1;
}

/** After the `}` that closes the `{` at i, with what is between read as code, or -1. */
function skipBraces(s, i) {
  let depth = 0, j = i;
  while (j < s.length) {
    const c = s[j];
    if (c === '"' || c === "'") { j = skipQuote(s, j); continue; }
    if (c === '`') { j = skipTemplate(s, j); if (j < 0) return -1; continue; }
    if (c === '/' && s[j + 1] === '/') { j = lineEnd(s, j); continue; }
    if (c === '/' && s[j + 1] === '*') { const k = s.indexOf('*/', j + 2); if (k < 0) return -1; j = k + 2; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return j + 1;
    j++;
  }
  return -1;
}

/**
 * Where the template starts: after the code fence, 0 when the file has none,
 * -1 when the fence's end cannot be told. The end is looked for twice, once
 * reading the fence as code (a `---` line inside a string or a comment is not
 * the end) and once line by line; when the two disagree the file is not read.
 */
function templateStart(s) {
  let i = s.charCodeAt(0) === 0xFEFF ? 1 : 0;
  while (i < s.length && isSpace(s[i])) i++;
  if (!s.startsWith('---', i)) return 0;
  const from = i + 3;

  let asCode = -1, fresh = false;   // fresh: nothing but spaces since the line began
  for (let j = from; j < s.length;) {
    const c = s[j];
    if (c === '\n') { fresh = true; j++; continue; }
    if (fresh && (c === ' ' || c === '\t' || c === '\r')) { j++; continue; }
    if (fresh && s.startsWith('---', j)) { asCode = j; break; }
    fresh = false;
    if (c === '"' || c === "'") { j = skipQuote(s, j); continue; }
    if (c === '`') { j = skipTemplate(s, j); if (j < 0) break; continue; }
    if (c === '/' && s[j + 1] === '/') { j = lineEnd(s, j); continue; }
    if (c === '/' && s[j + 1] === '*') { const k = s.indexOf('*/', j + 2); if (k < 0) break; j = k + 2; continue; }
    j++;
  }

  let byLine = -1;
  for (let k = s.indexOf('\n', from); k >= 0; k = s.indexOf('\n', k + 1)) {
    let m = k + 1;
    while (s[m] === ' ' || s[m] === '\t' || s[m] === '\r') m++;
    if (s.startsWith('---', m)) { byLine = m; break; }
  }
  return asCode >= 0 && asCode === byLine ? asCode + 3 : -1;
}

/** A tag's attributes from j to its `>`: where it ends and what matters about them, or null. */
function readAttrs(s, j) {
  const n = s.length;
  const a = { end: -1, self: false, code: false, set: false, raw: false, own: false, inside: false };
  for (;;) {
    while (j < n && isSpace(s[j])) j++;
    if (j >= n) return null;
    const c = s[j];
    if (c === '>') { a.end = j + 1; return a; }
    if (c === '/') { if (s[j + 1] === '>') { a.end = j + 2; a.self = true; return a; } j++; continue; }
    if (c === '<') return null;
    if (c === '=') { j++; continue; }
    if (c === '{') {                       // a spread or a shorthand: {...props}, {name}
      const k = skipBraces(s, j);
      if (k < 0) return null;
      const code = s.slice(j, k);
      a.code = true;
      if (HELPER.test(code)) a.own = true;
      if (HELPER_INSIDE.test(code)) a.inside = true;
      j = k; continue;
    }
    if (c === '"' || c === "'") { const k = s.indexOf(c, j + 1); if (k < 0) return null; j = k + 1; continue; }
    if (c === '`') { const k = skipTemplate(s, j); if (k < 0) return null; a.code = true; j = k; continue; }

    const at = j;
    while (j < n && !isSpace(s[j]) && s[j] !== '=' && s[j] !== '>' && s[j] !== '{' && s[j] !== '<' && !(s[j] === '/' && s[j + 1] === '>')) j++;
    const name = s.slice(at, j);
    let k = j;
    while (k < n && isSpace(s[k])) k++;
    if (s[k] === '=') {
      k++;
      while (k < n && isSpace(s[k])) k++;
      const v = s[k];
      if (v === '"' || v === "'") { const e = s.indexOf(v, k + 1); if (e < 0) return null; j = e + 1; }
      else if (v === '`') { const e = skipTemplate(s, k); if (e < 0) return null; a.code = true; j = e; }
      else if (v === '{') { const e = skipBraces(s, k); if (e < 0) return null; a.code = true; j = e; }
      else { j = k; while (j < n && !isSpace(s[j]) && s[j] !== '>' && !(s[j] === '/' && s[j + 1] === '>')) j++; }
    }
    if (name === 'set:html' || name === 'set:text') a.set = true;
    else if (name === 'is:raw') a.raw = true;
    else if (name === 'data-cms' || name === 'data-kiln-source') a.own = a.inside = true;
    else if (name.startsWith('data-cms-') || name.startsWith('data-kiln-')) a.own = true;
  }
}

/** After the closing tag of a `<script>` or `<style>` whose content starts at `from`, or -1. */
function rawEnd(s, from, name) {
  for (let k = s.indexOf('</', from); k >= 0; k = s.indexOf('</', k + 2)) {
    if (s.slice(k + 2, k + 2 + name.length).toLowerCase() === name) { const e = s.indexOf('>', k); return e < 0 ? -1 : e + 1; }
  }
  return -1;
}

function read(text) {
  const n = text.length;
  const safe = [];
  const left = { mixed: 0, fromCode: 0, withTags: 0, inLoop: 0, marked: 0 };
  const more = { unclosed: 0, noWords: 0, holdsText: 0, attrValue: 0 };
  const stack = [];   // what is open: elements and `{`
  const open = [];    // the text elements among them, outermost first
  let braces = 0, marked = 0, head = 0;   // how many `{`, marked elements and unseen parts (UNSEEN) are open
  let breaks = null;

  const lineOf = (pos) => {
    if (!breaks) { breaks = []; for (let k = text.indexOf('\n'); k >= 0; k = text.indexOf('\n', k + 1)) breaks.push(k); }
    let lo = 0, hi = breaks.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (breaks[mid] < pos) lo = mid + 1; else hi = mid; }
    return lo + 1;
  };
  const touch = (flag) => { for (const f of open) f[flag] = true; };

  /** A text element is over (`close` is where its closing tag starts, `end` where that tag ends): count it. */
  const settle = (f, close, end) => {
    if (f.head) return;
    if (f.holds) { more.holdsText++; return; }
    if (f.marked) { left.marked++; return; }
    if (f.set) { left.fromCode++; return; }
    if (f.expr) { if (f.text) left.mixed++; else left.fromCode++; return; }
    if (f.code) { if (f.text) left.withTags++; else left.fromCode++; return; }
    if (f.tags || f.amp || f.odd) { if (f.text || f.wordAmp || f.odd) left.withTags++; else more.noWords++; return; }
    let a = f.openEnd, b = close;
    while (a < b && SPACE.test(text[a])) a++;
    while (b > a && SPACE.test(text[b - 1])) b--;
    const words = text.slice(a, b);
    if (!LETTER.test(words)) { more.noWords++; return; }
    if (f.loop) { left.inLoop++; return; }
    if (f.attr) { left.mixed++; more.attrValue++; return; }
    safe.push({ tag: f.tag, start: f.start, end, innerStart: a, innerEnd: b, words, line: lineOf(f.start), openEnd: f.openEnd });
  };
  const leave = (frame) => {
    if (frame.inside) marked--;
    if (frame.head) head--;
    if (frame.field) open.pop();
  };
  const unclosed = (frame) => { leave(frame); if (frame.field && !frame.field.head) more.unclosed++; };

  /** The tag that opens at `at`: where it ends, or -1 when it cannot be followed. */
  const openTag = (at) => {
    let j = at + 1, name = '', a;
    if (text[j] === '>') a = { end: j + 1 };                 // <> opens a fragment
    else {
      while (j < n && !isSpace(text[j]) && text[j] !== '>' && text[j] !== '{' && !(text[j] === '/' && text[j + 1] === '>')) j++;
      name = text.slice(at + 1, j);
      a = readAttrs(text, j);
      if (!a || a.raw) return -1;                            // is:raw is not followed
    }
    const isText = TEXT.has(name);
    const fromCode = name === 'slot' || /^[A-Z]/.test(name) || name.includes('.') || name.includes(':');
    for (const f of open) { f.tags = true; if (isText) f.holds = true; if (fromCode) f.code = true; }
    const field = isText ? {
      tag: name, start: at, openEnd: a.end, loop: braces > 0, marked: !!a.own || marked > 0, head: head > 0, attr: !!a.code, set: !!a.set,
      tags: false, holds: false, code: false, expr: false, text: false, amp: false, wordAmp: false, odd: false,
    } : null;
    if (a.self || VOID.has(name)) { if (field) settle(field, a.end, a.end); return a.end; }
    if (RAW.has(name)) return rawEnd(text, a.end, name);
    if (stack.length >= MAX_OPEN || open.length >= MAX_OPEN_TEXT) return -1;
    const unseen = UNSEEN.has(name);
    stack.push({ name, field, inside: !!a.inside, head: unseen });
    if (a.inside) marked++;
    if (unseen) head++;
    if (field) open.push(field);
    return a.end;
  };

  /** The closing tag at `at`: where it ends, or -1. A close that matches nothing open here is not followed. */
  const closeTag = (at) => {
    let j = at + 2;
    while (j < n && text[j] !== '>' && text[j] !== '<' && !isSpace(text[j])) j++;
    const name = text.slice(at + 2, j);
    while (j < n && isSpace(text[j])) j++;
    if (text[j] !== '>') return -1;
    const end = j + 1;
    if (VOID.has(name)) return end;
    let k = stack.length - 1;
    while (k >= 0 && !stack[k].brace && stack[k].name !== name) k--;
    if (k < 0 || stack[k].brace) return -1;
    while (stack.length - 1 > k) unclosed(stack.pop());
    const frame = stack.pop();
    leave(frame);
    if (frame.field) settle(frame.field, at, end);
    return end;
  };

  let i = templateStart(text);
  if (i < 0) return null;
  while (i < n) {
    const c = text[i];
    const inCode = stack.length > 0 && stack[stack.length - 1].brace === true;

    if (c === '<') {
      const next = text[i + 1];
      if (text.startsWith('<!--', i)) {
        if (!inCode) touch('tags');
        const k = text.indexOf('-->', i + 4);
        i = k < 0 ? n : k + 3;
        continue;
      }
      if (isLetter(next) || next === '>') { i = openTag(i); if (i < 0) return null; continue; }
      if (inCode) { if (next === '/') return null; i++; continue; }   // a comparison; a close with nothing open is not followed
      if (next === '/') { i = closeTag(i); if (i < 0) return null; continue; }
      if (next === '!') { const k = text.indexOf('>', i); if (k < 0) return null; i = k + 1; continue; }   // <!doctype html>
      touch('odd'); i++; continue;                                    // a bare < among the words
    }

    if (inCode) {
      if (c === '"' || c === "'") { i = skipQuote(text, i); continue; }
      if (c === '`') { i = skipTemplate(text, i); if (i < 0) return null; continue; }
      if (c === '/' && text[i + 1] === '/') { i = lineEnd(text, i); continue; }
      if (c === '/' && text[i + 1] === '*') { const k = text.indexOf('*/', i + 2); if (k < 0) return null; i = k + 2; continue; }
      if (c === '{') { stack.push(BRACE); braces++; }
      else if (c === '}') { stack.pop(); braces--; }
      i++; continue;
    }

    if (c === '{') { touch('expr'); stack.push(BRACE); braces++; i++; continue; }
    if (c === '}') return null;            // a `}` that closes nothing: the walk has lost its place
    if (c === '&') {
      touch('amp');
      NBSP.lastIndex = i;
      if (NBSP.test(text)) i = NBSP.lastIndex; else { touch('wordAmp'); i++; }
      continue;
    }
    let k = i + 1;
    while (k < n && text[k] !== '<' && text[k] !== '{' && text[k] !== '}' && text[k] !== '&') k++;
    if (open.length && /\S/.test(text.slice(i, k))) touch('text');
    i = k;
  }
  if (braces > 0) return null;
  while (stack.length) unclosed(stack.pop());

  const total = safe.length + left.mixed + left.fromCode + left.withTags + left.inLoop + left.marked;
  return { safe, left, total, more };
}

/**
 * Read one .astro file. Answers
 *   { safe: [{ tag, start, end, innerStart, innerEnd, words, line, openEnd }], left: { mixed, fromCode, withTags, inLoop, marked }, total, more }
 * or `{ unread: true }` for a file it cannot follow. Never throws.
 *
 * Every number is a place in `text` as it was given (a byte-order mark and
 * Windows line ends are counted like any other character):
 *   start..end            the whole element, from its `<` to the `>` of its closing tag
 *   openEnd               just after the `>` of its opening tag
 *   innerStart..innerEnd  the words, without the space around them, so that
 *                         text.slice(innerStart, innerEnd) === words
 *   line                  the line the element starts on, from 1
 */
export function readAstro(text) {
  if (typeof text !== 'string') return { unread: true };
  try { return read(text) || { unread: true }; } catch { return { unread: true }; }
}

const REASONS = ['mixed', 'fromCode', 'withTags', 'inLoop', 'marked'];

/**
 * The numbers over many files. `files` is [{ path, text }]; a file whose text
 * is not a string (too large, not text) counts as one that could not be read.
 * Answers { files, total, safe, left, unread: [path], perFile: [{ path, total, safe, left }] },
 * perFile with the most safe text first.
 */
export function tallyAstro(files) {
  const out = { files: 0, total: 0, safe: 0, left: Object.fromEntries(REASONS.map(r => [r, 0])), unread: [], perFile: [] };
  for (const f of files || []) {
    out.files++;
    const r = readAstro(f?.text);
    if (r.unread) { out.unread.push(f?.path); continue; }
    out.total += r.total;
    out.safe += r.safe.length;
    for (const k of REASONS) out.left[k] += r.left[k];
    out.perFile.push({ path: f.path, total: r.total, safe: r.safe.length, left: { ...r.left } });
  }
  out.unread.sort();
  out.perFile.sort((x, y) => (y.safe - x.safe) || (y.total - x.total) || (x.path < y.path ? -1 : 1));
  return out;
}
