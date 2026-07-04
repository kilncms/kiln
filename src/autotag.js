/**
 * Heuristic first-pass auto-tagger: given a page's HTML, decide which elements
 * are content and annotate them (data-cms / data-cms-attr / data-cms-repeat /
 * data-cms-menu) by splicing attributes at exact source offsets — the same
 * technique the engine uses, so hand-written formatting survives untouched.
 *
 * This is deliberately a FIRST PASS: conservative rules, reviewable via
 * `git diff`, refinable in the browser with Make-editable. It never touches
 * anything already annotated, so running it twice is a no-op.
 */

import { parse } from 'parse5';

const FIELD_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'blockquote', 'figcaption']);
const SKIP_SUBTREES = new Set(['script', 'style', 'svg', 'template', 'noscript']);
const CMS_ATTRS = ['data-cms', 'data-cms-repeat', 'data-cms-menu'];

const attrOf = (node, name) => node.attrs?.find(a => a.name === name)?.value;
const hasCms = (node) => !!node.attrs?.some(a => CMS_ATTRS.includes(a.name));

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
  const annotate = (node, attrs) => {
    const at = insertPoint(node);
    if (at === null) return false;
    splices.push({ offset: at, text: attrs });
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
    if (SKIP_SUBTREES.has(n.tagName) || (n.tagName && hasCms(n) && attrOf(n, 'data-cms') !== undefined)) return;
    const kids = elementChildren(n).filter(k => k.tagName !== 'template');
    if (n.tagName && !hasCms(n) && !insideRepeat(ancestors) && !inMenu(ancestors, n) && kids.length >= 3) {
      const sigs = kids.map(signature);
      const top = sigs.sort().filter((s, i, a) => s === a[0]).length >= 3 ? sigs[0] : null;
      const share = kids.filter(k => signature(k) === sigs[0]).length / kids.length;
      // all (or nearly all) children are the same kind of block, and blocks have content
      if (top && share >= 0.8 && textOf(kids[0]).length > 0 && !['table', 'tbody', 'thead', 'tfoot', 'tr', 'select', 'optgroup', 'datalist'].includes(n.tagName)) {
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
    if (n.tagName && !hasCms(n) && !insideRepeat(ancestors) && !inMenu(ancestors, n)) {
      if (FIELD_TAGS.has(n.tagName)) {
        const text = textOf(n);
        if (text.length >= 3 && !elementChildren(n).some(k => FIELD_TAGS.has(k.tagName))) {
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

  // Also tag footer content (contact lines etc.) when scope was <main>.
  if (main && body) {
    let footer = null;
    (function ff(n) { if (n.tagName === 'footer' && !footer) footer = n; for (const c of n.childNodes || []) ff(c); })(body);
    if (footer) {
      (function tagFields(n, ancestors) {
        if (SKIP_SUBTREES.has(n.tagName)) return;
        if (n.tagName && !hasCms(n) && !inMenu(ancestors, n) && FIELD_TAGS.has(n.tagName)) {
          const text = textOf(n);
          if (text.length >= 3) {
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
