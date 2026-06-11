/**
 * Kiln splice engine.
 *
 * The HTML file in the repo is the source of truth. We never reserialize the
 * document — we parse it with source locations (parse5, the same approach Vite
 * uses for index.html transforms) and splice replacements into the raw text at
 * exact character offsets. Everything outside the edited ranges is preserved
 * byte-for-byte, so diffs stay minimal and hand-authored formatting survives.
 *
 * Editable regions are declared in the HTML itself:
 *   <h1 data-cms="hero_headline">...</h1>      → inner HTML is editable
 *   <img data-cms-attr="src" data-cms="hero_img" src="...">  → attribute value editable
 */

import { parse } from 'parse5';

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr']);

/**
 * Scan raw HTML for data-cms fields.
 * Returns { fields: Map<key, field>, warnings: string[] }
 * field = { key, tag, inner: {start,end}|null, attrs: Map<name,{start,end}>, range: {start,end} }
 */
export function indexHtml(raw) {
  const doc = parse(raw, { sourceCodeLocationInfo: true });
  const fields = new Map();
  const warnings = [];

  walk(doc, (node) => {
    if (!node.attrs || !node.sourceCodeLocation) return;
    // data-cms        = click-editable content
    // data-cms-list   = structural splice anchor (prepend target, never editable)
    // data-cms-repeat = container of duplicatable/deletable blocks (staged whole)
    // data-cms-menu   = navigation container (rewritten across pages by menu editor)
    const KINDS = { 'data-cms': 'field', 'data-cms-list': 'list', 'data-cms-repeat': 'repeat', 'data-cms-menu': 'menu' };
    const keyAttr = node.attrs.find(a => KINDS[a.name]);
    if (!keyAttr) return;
    const kind = KINDS[keyAttr.name];
    const key = keyAttr.value;
    if (!key) { warnings.push('empty data-cms attribute ignored'); return; }
    if (fields.has(key)) {
      warnings.push(`duplicate data-cms key "${key}" — using first occurrence`);
      return;
    }

    const loc = node.sourceCodeLocation;
    const field = {
      key,
      kind,
      tag: node.tagName,
      range: { start: loc.startOffset, end: loc.endOffset },
      inner: null,
      attrs: new Map(),
    };

    if (loc.startTag && !VOID_TAGS.has(node.tagName)) {
      // No explicit end tag (e.g. an unclosed <p> the parser implicitly closed):
      // the element's content runs to wherever the parser ended it.
      const innerEnd = loc.endTag ? loc.endTag.startOffset : loc.endOffset;
      if (innerEnd >= loc.startTag.endOffset) {
        field.inner = { start: loc.startTag.endOffset, end: innerEnd };
      }
    }

    if (loc.startTag) {
      // Where a brand-new attribute can be inserted: just before the start
      // tag's closing '>' (or '/>').
      const tagText = raw.slice(loc.startTag.startOffset, loc.startTag.endOffset);
      field.attrInsert = loc.startTag.endOffset - (tagText.endsWith('/>') ? 2 : 1);
      if (loc.startTag.attrs) {
        for (const [name, aloc] of Object.entries(loc.startTag.attrs)) {
          const valueRange = attrValueRange(raw, aloc);
          if (valueRange) field.attrs.set(name, valueRange);
        }
      }
    }

    fields.set(key, field);
  });

  return { fields, warnings };
}

/**
 * Given the full attr source range (covers `name="value"`), locate just the
 * value text between the quotes. Handles double/single/unquoted. Returns null
 * for bare attributes with no value.
 */
function attrValueRange(raw, aloc) {
  const text = raw.slice(aloc.startOffset, aloc.endOffset);
  const eq = text.indexOf('=');
  if (eq === -1) return null;
  let i = eq + 1;
  while (i < text.length && /\s/.test(text[i])) i++;
  const q = text[i];
  if (q === '"' || q === "'") {
    const close = text.lastIndexOf(q);
    if (close <= i) return null;
    return { start: aloc.startOffset + i + 1, end: aloc.startOffset + close, quote: q };
  }
  return { start: aloc.startOffset + i, end: aloc.endOffset, quote: null };
}

/**
 * Apply a batch of edits to raw HTML.
 * edits: [{ key, html }]            → replace inner HTML of the keyed element
 *        [{ key, attr, value }]     → replace an attribute value on the keyed element
 * Returns { html, applied: [...keys], skipped: [{key, reason}] }
 *
 * All offsets come from one parse of the input, and splices are applied in
 * descending offset order so earlier ranges stay valid. Overlapping edits
 * (nested data-cms elements edited in the same batch) are detected and the
 * inner one is skipped.
 */
export function applyEdits(raw, edits) {
  const { fields } = indexHtml(raw);
  const splices = [];
  const applied = [];
  const skipped = [];

  for (const edit of edits) {
    const field = fields.get(edit.key);
    if (!field) { skipped.push({ key: edit.key, reason: 'key not found in source' }); continue; }

    if (edit.prepend !== undefined) {
      if (!field.inner) { skipped.push({ key: edit.key, reason: 'element has no editable inner content (void or unclosed)' }); continue; }
      splices.push({ start: field.inner.start, end: field.inner.start, text: String(edit.prepend), key: edit.key });
    } else if (edit.attr !== undefined) {
      const range = field.attrs.get(edit.attr);
      if (!range) {
        // Attribute doesn't exist in the source yet — insert it into the start tag.
        if (field.attrInsert === undefined || !/^[a-zA-Z][\w-]*$/.test(edit.attr)) {
          skipped.push({ key: edit.key, reason: `attribute "${edit.attr}" not found` });
          continue;
        }
        const value = String(edit.value).replaceAll('"', '&quot;');
        splices.push({ start: field.attrInsert, end: field.attrInsert, text: ` ${edit.attr}="${value}"`, key: edit.key });
        continue;
      }
      const value = range.quote === "'"
        ? String(edit.value).replaceAll("'", '&#39;')
        : String(edit.value).replaceAll('"', '&quot;');
      splices.push({ start: range.start, end: range.end, text: value, key: edit.key });
    } else {
      if (!field.inner) { skipped.push({ key: edit.key, reason: 'element has no editable inner content (void or unclosed)' }); continue; }
      splices.push({ start: field.inner.start, end: field.inner.end, text: String(edit.html), key: edit.key });
    }
  }

  // Reject overlaps: sort ascending, compare neighbours, drop the inner (later-starting) one.
  splices.sort((a, b) => a.start - b.start || a.end - b.end);
  const clean = [];
  for (const s of splices) {
    const prev = clean[clean.length - 1];
    if (prev && s.start < prev.end) {
      skipped.push({ key: s.key, reason: `overlaps edit of "${prev.key}" (nested data-cms) — skipped` });
      continue;
    }
    clean.push(s);
  }

  // Apply in descending order so offsets stay valid.
  let out = raw;
  for (const s of [...clean].reverse()) {
    out = out.slice(0, s.start) + s.text + out.slice(s.end);
    applied.push(s.key);
  }

  return { html: out, applied: applied.reverse(), skipped };
}

/** Read the current source values for every field (for change detection / cancel). */
export function readValues(raw) {
  const { fields } = indexHtml(raw);
  const values = {};
  for (const [key, f] of fields) {
    values[key] = f.inner ? raw.slice(f.inner.start, f.inner.end) : null;
  }
  return values;
}

/**
 * Map a URL pathname to candidate repo file paths, most likely first.
 *   '/'           → ['index.html']
 *   '/about/'     → ['about/index.html']
 *   '/about.html' → ['about.html']
 *   '/about'      → ['about.html', 'about/index.html']
 * `root` is an optional repo subdirectory the site is served from (e.g. 'demo').
 */
export function pageFileCandidates(pathname, root = '') {
  let p = decodeURIComponent(pathname).replace(/^\/+/, '');
  const prefix = root ? root.replace(/\/+$/, '') + '/' : '';
  if (p === '' ) return [prefix + 'index.html'];
  if (p.endsWith('/')) return [prefix + p + 'index.html'];
  const last = p.split('/').pop();
  if (last.includes('.')) return [prefix + p];
  return [prefix + p + '.html', prefix + p + '/index.html'];
}

function walk(node, fn) {
  fn(node);
  const kids = node.childNodes || [];
  for (const child of kids) walk(child, fn);
  // template elements keep children in .content
  if (node.content) walk(node.content, fn);
}
