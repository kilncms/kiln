/**
 * Heuristic first-pass auto-tagger: given a page's HTML, decide which elements
 * are content and annotate them (data-cms / data-cms-attr / data-cms-repeat /
 * data-cms-menu) by splicing attributes at exact source offsets — the same
 * technique the engine uses, so hand-written formatting survives untouched.
 *
 * This is deliberately a FIRST PASS: conservative rules, reviewable via
 * `git diff`, refinable in the browser with Make-editable. It never touches
 * anything already annotated, so running it twice is a no-op.
 *
 * "Never touches" is meant whole: a part that is already marked keeps its
 * inside and its outside. Nothing within it is marked (a paragraph in a marked
 * block of text would become a part inside a part), nothing that holds it is
 * marked (a heading around a marked link would swallow the link's own mark),
 * and a group of blocks with a mark anywhere inside is not turned into a list
 * (that would change how parts someone marked by hand are published).
 */

import { parse } from 'parse5';

const FIELD_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'blockquote', 'figcaption']);
const SKIP_SUBTREES = new Set(['script', 'style', 'svg', 'template', 'noscript']);
const CMS_ATTRS = ['data-cms', 'data-cms-repeat', 'data-cms-menu'];

const attrOf = (node, name) => node.attrs?.find(a => a.name === name)?.value;
const hasCms = (node) => !!node.attrs?.some(a => CMS_ATTRS.includes(a.name));
/** Marked itself in a way that makes its whole inside its own: a field, a menu, or a part that comes from a content file. */
const ownsInside = (node) => !!node.attrs?.some(a => a.name === 'data-cms' || a.name === 'data-cms-menu' || a.name === 'data-kiln-source');
/** True when anything under `node` (not `node` itself) is already marked, in the file or by this run (`now`). */
function holdsMarked(node, now) {
  for (const c of node.childNodes || []) {
    if (c.tagName && (hasCms(c) || now?.has(c) || attrOf(c, 'data-kiln-source') !== undefined || holdsMarked(c, now))) return true;
  }
  return false;
}
/**
 * True when a block holds something the pass marks inside a list (the same
 * rules as tagRepeatItem below). A group whose blocks hold none, such as a row
 * of short labels, is not made a list: its blocks could be copied and moved
 * but never reworded.
 */
function holdsMarkable(node) {
  if (SKIP_SUBTREES.has(node.tagName)) return false;
  if (node.tagName && !hasCms(node)) {
    if (/^h[1-6]$/.test(node.tagName) || ['p', 'figcaption', 'blockquote', 'time'].includes(node.tagName)) { if (textOf(node)) return true; }
    else if (node.tagName === 'img' && attrOf(node, 'src')) return true;
  }
  return (node.childNodes || []).some(c => c.tagName && holdsMarkable(c));
}
/** True when `node` is `root` or somewhere under it. */
function within(root, node) {
  for (let n = node; n; n = n.parentNode) if (n === root) return true;
  return false;
}

function textOf(node) {
  let out = '';
  (function walk(n) {
    if (n.nodeName === '#text') out += n.value;
    for (const c of n.childNodes || []) walk(c);
  })(node);
  return out.replace(/\s+/g, ' ').trim();
}

function slug(text, words = 3) {
  const s = String(text).toLowerCase().replace(/[^a-z0-9\s]+/g, ' ').trim()
    .split(/\s+/).slice(0, words).join('_');
  return s.replace(/^[0-9_]+/, '').slice(0, 28) || 'text';
}

/** tag + sorted classes — two siblings with the same signature are "the same kind of block" */
function signature(node) {
  const cls = (attrOf(node, 'class') || '').split(/\s+/).filter(Boolean).sort().join('.');
  return `${node.tagName}${cls ? '.' + cls : ''}`;
}

function elementChildren(node) {
  return (node.childNodes || []).filter(n => n.tagName);
}

/**
 * Analyze + annotate one page. Returns { html, counts } where counts =
 * { fields, images, repeats, menu } — all zero and html unchanged when there
 * is nothing (new) to tag.
 */
export function autotag(raw) {
  const doc = parse(raw, { sourceCodeLocationInfo: true });
  const splices = [];   // { offset, text }
  const counts = { fields: 0, images: 0, repeats: 0, menu: 0 };
  const usedKeys = new Set();

  const uniq = (base) => {
    let k = base, i = 2;
    while (usedKeys.has(k)) k = `${base}_${i++}`;
    usedKeys.add(k);
    return k;
  };
  const insertPoint = (node) => {
    const loc = node.sourceCodeLocation?.startTag;
    if (!loc) return null;
    const text = raw.slice(loc.startOffset, loc.endOffset);
    return loc.endOffset - (text.endsWith('/>') ? 2 : 1);
  };
  const marked = new Set();   // what this run has marked: never the same element twice
  const annotate = (node, attrs) => {
    if (marked.has(node)) return false;
    const at = insertPoint(node);
    if (at === null) return false;
    splices.push({ offset: at, text: attrs });
    marked.add(node);
    return true;
  };

  // Pre-scan: existing keys stay reserved so generated ones can't collide.
  (function scan(n) {
    for (const a of n.attrs || []) if (CMS_ATTRS.includes(a.name)) usedKeys.add(a.value);
    for (const c of n.childNodes || []) scan(c);
  })(doc);

  // Locate landmarks.
  let main = null, header = null, firstNav = null, body = null;
  (function find(n) {
    if (n.tagName === 'main' && !main) main = n;
    if (n.tagName === 'header' && !header) header = n;
    if (n.tagName === 'nav' && !firstNav) firstNav = n;
    if (n.tagName === 'body' && !body) body = n;
    for (const c of n.childNodes || []) find(c);
  })(doc);

  // ── Menu: the primary nav (inside <header> if there is one) with ≥3 links ──
  const navHost = (function findNav(n) {
    if (n?.tagName === 'nav') return n;
    for (const c of n?.childNodes || []) { const f = findNav(c); if (f) return f; }
    return null;
  })(header) || firstNav;
  if (navHost && !hasCms(navHost)) {
    const links = [];
    (function la(n) { if (n.tagName === 'a') links.push(n); for (const c of n.childNodes || []) la(c); })(navHost);
    if (links.length >= 3 && annotate(navHost, ' data-cms-menu="main"')) counts.menu++;
  }

  // ── Section prefix for key names: nearest ancestor section/article id/class ──
  const UTILITY = new Set(['wrap', 'wrapper', 'container', 'inner', 'row', 'col', 'grid', 'flex',
    'reveal', 'rise', 'fade', 'animate', 'section', 'content', 'main', 'box', 'block', 'body']);
  const prefixFor = (ancestors) => {
    for (let i = ancestors.length - 1; i >= 0; i--) {
      const a = ancestors[i];
      if (!['section', 'article', 'aside', 'footer', 'header', 'div'].includes(a.tagName)) continue;
      const hints = [attrOf(a, 'id'), ...(attrOf(a, 'class') || '').split(/\s+/)].filter(Boolean);
      const hint = hints.find(h => /^[a-z]/i.test(h) && !UTILITY.has(h.toLowerCase().replace(/[-_]?\d+$/, '')));
      if (hint) return slug(hint, 2).slice(0, 14);
    }
    return 'page';
  };

  // ── Repeats: a container whose element children are ≥3 same-signature blocks ──
  const repeatContainers = new Set();
  const insideRepeat = (ancestors) => ancestors.some(a => repeatContainers.has(a) || a.attrs?.some(x => x.name === 'data-cms-repeat'));
  const inMenu = (ancestors, node) => [node, ...ancestors].some(a => a === navHost || a.tagName === 'nav');

  const scope = main || body || doc;
  (function findRepeats(n, ancestors) {
    if (SKIP_SUBTREES.has(n.tagName) || (n.tagName && ownsInside(n))) return;
    const kids = elementChildren(n).filter(k => k.tagName !== 'template');
    if (n.tagName && !hasCms(n) && !insideRepeat(ancestors) && !inMenu(ancestors, n) && kids.length >= 3 && !holdsMarked(n, marked)) {
      const sigs = kids.map(signature);
      const top = sigs.sort().filter((s, i, a) => s === a[0]).length >= 3 ? sigs[0] : null;
      const share = kids.filter(k => signature(k) === sigs[0]).length / kids.length;
      // all (or nearly all) children are the same kind of block, and blocks have content
      if (top && share >= 0.8 && textOf(kids[0]).length > 0 && !['table', 'tbody', 'thead', 'tfoot', 'tr', 'select', 'optgroup', 'datalist'].includes(n.tagName)
        && kids.filter(k => signature(k) === sigs[0]).every(holdsMarkable)) {
        const prefix = prefixFor([...ancestors, n]);
        const key = uniq(`${prefix}_items`);
        if (annotate(n, ` data-cms-repeat="${key}"`)) {
          counts.repeats++;
          repeatContainers.add(n);
          // Shared field keys across every block (Kiln's repeat convention).
          for (const item of elementChildren(n)) tagRepeatItem(item, key);
          return;   // don't descend further — fields are handled per item
        }
      }
    }
    for (const c of n.childNodes || []) if (c.tagName) findRepeats(c, [...ancestors, n]);
  })(scope, []);

  function tagRepeatItem(item, repKey) {
    let heads = 0, bodies = 0, imgs = 0;
    (function walk(n) {
      if (SKIP_SUBTREES.has(n.tagName)) return;
      if (n.tagName && !hasCms(n)) {
        if (/^h[1-6]$/.test(n.tagName) && textOf(n)) { annotate(n, ` data-cms="${repKey}_title${heads++ ? heads : ''}"`); counts.fields++; return; }
        if ((n.tagName === 'p' || n.tagName === 'figcaption' || n.tagName === 'blockquote') && textOf(n)) { annotate(n, ` data-cms="${repKey}_body${bodies++ ? bodies : ''}"`); counts.fields++; return; }
        if (n.tagName === 'time' && textOf(n)) { annotate(n, ` data-cms="${repKey}_when" data-cms-plain`); counts.fields++; return; }
        if (n.tagName === 'img' && attrOf(n, 'src')) { annotate(n, ` data-cms="${repKey}_img${imgs++ ? imgs : ''}" data-cms-attr="src"`); counts.images++; return; }
      }
      for (const c of n.childNodes || []) walk(c);
    })(item);
  }

  // ── Plain fields + images everywhere in scope (outside repeats/menu) ──
  (function tagFields(n, ancestors) {
    if (SKIP_SUBTREES.has(n.tagName) || repeatContainers.has(n)) return;
    if (n.tagName && ownsInside(n)) return;   // already marked: its inside is its own
    if (n.tagName && !hasCms(n) && !insideRepeat(ancestors) && !inMenu(ancestors, n)) {
      if (FIELD_TAGS.has(n.tagName)) {
        const text = textOf(n);
        if (text.length >= 3 && !elementChildren(n).some(k => FIELD_TAGS.has(k.tagName)) && !holdsMarked(n, marked)) {
          const key = uniq(`${prefixFor(ancestors)}_${slug(text)}`);
          if (annotate(n, ` data-cms="${key}"`)) counts.fields++;
          return;
        }
      }
      if (n.tagName === 'img' && attrOf(n, 'src')) {
        const key = uniq(`${prefixFor(ancestors)}_img`);
        if (annotate(n, ` data-cms="${key}" data-cms-attr="src"`)) counts.images++;
        return;
      }
    }
    for (const c of n.childNodes || []) if (c.tagName) tagFields(c, [...ancestors, n]);
  })(scope, []);

  // Also tag footer content (contact lines etc.) when scope was <main>. A
  // footer that lies inside <main> has had its pass already.
  if (main && body) {
    let footer = null;
    (function ff(n) { if (n.tagName === 'footer' && !footer) footer = n; for (const c of n.childNodes || []) ff(c); })(body);
    if (footer && !within(main, footer)) {
      (function tagFields(n, ancestors) {
        if (SKIP_SUBTREES.has(n.tagName) || repeatContainers.has(n)) return;
        if (n.tagName && (ownsInside(n) || marked.has(n) || attrOf(n, 'data-cms-repeat') !== undefined)) return;   // already marked: its inside is its own
        if (n.tagName && !hasCms(n) && !inMenu(ancestors, n) && FIELD_TAGS.has(n.tagName)) {
          const text = textOf(n);
          if (text.length >= 3 && !holdsMarked(n, marked)) {
            const key = uniq(`footer_${slug(text)}`);
            if (annotate(n, ` data-cms="${key}"`)) counts.fields++;
            return;
          }
        }
        for (const c of n.childNodes || []) if (c.tagName) tagFields(c, [...ancestors, n]);
      })(footer, []);
    }
  }

  if (!splices.length) return { html: raw, counts };
  splices.sort((a, b) => b.offset - a.offset);
  let html = raw;
  for (const s of splices) html = html.slice(0, s.offset) + s.text + html.slice(s.offset);
  return { html, counts };
}

// What the pass may add to a page, and nothing else: one or more data-cms
// attributes with a plain value. (A run found by walking the two texts side by
// side can start or end one space off, so a space is allowed at either end.)
// Sticky: it is tried at the exact place where the two texts part.
const EDGE = /[\s>/]/;   // what may stand next to a mark inside a tag
const MARKS_RUN = / ?(?:data-cms(?:-[a-z]+)*(?:="[a-z0-9_-]*")? ?)+/y;

/**
 * True when `after` is `before` with nothing but marks added: every character
 * of the page is still there, in order, and each added run is a data-cms
 * attribute. The two are walked side by side once. Where they part, what was
 * added has to be marks from that very character on, and the page's own text
 * has to pick up right after them.
 *
 * (It used to look for where the page's own text picked up again by its next
 * twelve characters. Two marks less than twelve characters apart, as in
 * `<h3>Ana</h3><p>`, were then read as one long run that was not marks, and a
 * page with a short heading was refused although only marks had been added.
 * And a bare `data-cms` run together with the attribute after it passed.)
 */
export function onlyAddsMarks(before, after) {
  if (after.length < before.length) return false;
  let i = 0, j = 0;
  while (j < after.length) {
    if (i < before.length && before[i] === after[j]) { i++; j++; continue; }
    MARKS_RUN.lastIndex = j;
    const run = MARKS_RUN.exec(after);
    if (!run) return false;
    // The marks stand apart from what is around them: `data-cmsclass="x"` is
    // not a mark put in front of `class="x"`.
    const end = j + run[0].length;
    if (!run[0].startsWith(' ') && !EDGE.test(after[j - 1] || '')) return false;
    if (!run[0].endsWith(' ') && !EDGE.test(after[end] || '>')) return false;
    j = end;
  }
  return i === before.length;
}
