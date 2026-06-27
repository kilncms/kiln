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

// Attribute names the splice engine is allowed to write or overwrite. Anything
// else (on* handlers, style, srcdoc, …) is rejected so an edit can't inject
// script-bearing attributes. data-* is allowed except data-cms* (structural).
const SAFE_ATTRS = new Set(['href', 'src', 'alt', 'title', 'class', 'target', 'rel', 'width', 'height']);
function attrNameAllowed(name) {
  if (SAFE_ATTRS.has(name)) return true;
  if (/^data-/i.test(name) && !/^data-cms/i.test(name)) return true;
  return false;
}

/**
 * Defense-in-depth URL scheme sanitization for href/src attribute values.
 * Editor-side staging also sanitizes, but attribute splices bypass DOMPurify,
 * so the engine independently neutralizes dangerous schemes. Allows relative/
 * anchor/query URLs and http:, https:, mailto:, tel: only; everything else
 * (javascript:, data:, vbscript:, obfuscated "java\tscript:") becomes '#'.
 */
function safeUrl(value) {
  const v = String(value);
  const stripped = v.replace(/[\u0000-\u001f\u007f ]/g, '');
  if (stripped === '' || /^[\/#.?]/.test(stripped)) return v;
  const scheme = stripped.match(/^[a-z][a-z0-9+.-]*:/i);
  if (!scheme) return v;
  return /^(https?|mailto|tel):$/i.test(scheme[0]) ? v : '#';
}

/**
 * Scan raw HTML for data-cms fields.
 * Returns { fields: Map<key, field>, warnings: string[] }
 * field = { key, tag, inner: {start,end}|null, attrs: Map<name,{start,end}>, range: {start,end} }
 */
/** True if any ancestor of `node` carries the given attribute (e.g. data-cms-repeat). */
function ancestorHasAttr(node, attr) {
  for (let p = node.parentNode; p; p = p.parentNode) {
    if (p.attrs && p.attrs.some(a => a.name === attr)) return true;
  }
  return false;
}

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
      // Repeated keys inside a data-cms-repeat are expected (every card reuses them);
      // only the splice index dedupes them. Only warn for duplicates OUTSIDE a repeat.
      if (!ancestorHasAttr(node, 'data-cms-repeat')) {
        warnings.push(`duplicate data-cms key "${key}" — using first occurrence`);
      }
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

    // Responsive images: if this swappable <img> sits inside a <picture>, record the
    // sibling <source> ranges so a src-swap can strip them. A <source srcset> would
    // otherwise keep serving the old image and shadow the swap on modern browsers.
    if (node.tagName === 'img' && node.attrs.some(a => a.name === 'data-cms-attr')
        && node.parentNode && node.parentNode.tagName === 'picture') {
      field.pictureSources = [];
      for (const sib of node.parentNode.childNodes || []) {
        if (sib.tagName === 'source' && sib.sourceCodeLocation) {
          field.pictureSources.push({
            start: sib.sourceCodeLocation.startOffset,
            end: sib.sourceCodeLocation.endOffset,
          });
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
 * Produce the splice text for an attribute value, given the source quoting.
 *  - double-quoted source: escape " (and & for correctness); value text only.
 *  - single-quoted source: escape ' and & (so HTML entities like &colon; can't
 *    reconstitute a javascript: scheme after the browser decodes them).
 *  - UNQUOTED source: the range covers a bare value, so a raw splice could break
 *    out of the attribute (e.g. `/y onmouseover=alert(1)`). Emit a fully-escaped,
 *    DOUBLE-QUOTED value INCLUDING the quotes, turning `name=` + this into a
 *    well-formed `name="…"`.
 */
function emitAttrValue(value, quote) {
  const v = String(value);
  if (quote === "'") return v.replaceAll('&', '&amp;').replaceAll("'", '&#39;');
  if (quote === '"') return v.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
  // Unquoted: wrap in double quotes; escape & and " so the value can't break out.
  return '"' + v.replaceAll('&', '&amp;').replaceAll('"', '&quot;') + '"';
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
      // Gate the attribute NAME against a fixed safe set so on* handlers,
      // style, srcdoc, etc. can never be written or overwritten.
      if (!attrNameAllowed(edit.attr)) {
        skipped.push({ key: edit.key, reason: `attribute "${edit.attr}" not allowed` });
        continue;
      }
      // href/src values get scheme-sanitized as defense-in-depth (splices bypass DOMPurify).
      const attrVal = (edit.attr === 'href' || edit.attr === 'src') ? safeUrl(edit.value) : String(edit.value);
      const range = field.attrs.get(edit.attr);
      if (!range) {
        // Attribute doesn't exist in the source yet — insert it into the start tag.
        if (field.attrInsert === undefined) {
          skipped.push({ key: edit.key, reason: `attribute "${edit.attr}" not found` });
          continue;
        }
        const value = attrVal.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
        splices.push({ start: field.attrInsert, end: field.attrInsert, text: ` ${edit.attr}="${value}"`, key: edit.key });
        continue;
      }
      splices.push({ start: range.start, end: range.end, text: emitAttrValue(attrVal, range.quote), key: edit.key });
      // When swapping a <picture>'s <img src>, also delete the sibling <source>
      // elements so they don't keep showing the old image.
      if (edit.attr === 'src' && field.pictureSources) {
        for (const ps of field.pictureSources) {
          splices.push({ start: ps.start, end: ps.end, text: '', key: edit.key });
        }
      }
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

/**
 * Edit <head> bits: page <title> and meta[name=description].
 * Splices in place; inserts the meta tag (after <title>) if missing.
 */
export function editHead(raw, { title, description }) {
  const doc = parse(raw, { sourceCodeLocationInfo: true });
  let titleNode = null, metaDesc = null, headNode = null;
  walk(doc, (n) => {
    if (n.tagName === 'title' && !titleNode) titleNode = n;
    if (n.tagName === 'head' && !headNode) headNode = n;
    if (n.tagName === 'meta' && n.attrs?.some(a => a.name === 'name' && a.value === 'description')) metaDesc = n;
  });
  const splices = [];
  const esc = (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
  if (title !== undefined && titleNode?.sourceCodeLocation?.startTag && titleNode.sourceCodeLocation.endTag) {
    splices.push({ start: titleNode.sourceCodeLocation.startTag.endOffset,
      end: titleNode.sourceCodeLocation.endTag.startOffset, text: esc(title) });
  }
  if (description !== undefined) {
    if (metaDesc?.sourceCodeLocation) {
      const loc = metaDesc.sourceCodeLocation.attrs?.content;
      if (loc) {
        const range = attrValueRange(raw, loc);
        // Use the safe quoting emitter so an unquoted source attribute (content=foo)
        // gets a properly double-quoted value instead of a splice that can break out.
        if (range) splices.push({ start: range.start, end: range.end, text: emitAttrValue(description, range.quote) });
      } else {
        const at = metaDesc.sourceCodeLocation.endOffset - (raw.slice(metaDesc.sourceCodeLocation.startOffset, metaDesc.sourceCodeLocation.endOffset).endsWith('/>') ? 2 : 1);
        splices.push({ start: at, end: at, text: ` content="${esc(description)}"` });
      }
    } else if (titleNode?.sourceCodeLocation) {
      const at = titleNode.sourceCodeLocation.endOffset;
      splices.push({ start: at, end: at, text: `\n  <meta name="description" content="${esc(description)}" />` });
    } else if (headNode?.sourceCodeLocation?.startTag) {
      const at = headNode.sourceCodeLocation.startTag.endOffset;
      splices.push({ start: at, end: at, text: `\n  <meta name="description" content="${esc(description)}" />` });
    }
  }
  let out = raw;
  for (const s of splices.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, s.start) + s.text + out.slice(s.end);
  }
  return out;
}

/** Read current head bits for prefilling the page-settings panel. */
export function readHead(raw) {
  const doc = parse(raw, { sourceCodeLocationInfo: true });
  let title = '', description = '';
  walk(doc, (n) => {
    if (n.tagName === 'title' && n.childNodes?.[0]?.value) title = n.childNodes[0].value;
    if (n.tagName === 'meta' && n.attrs?.some(a => a.name === 'name' && a.value === 'description')) {
      description = n.attrs.find(a => a.name === 'content')?.value || '';
    }
  });
  return { title, description };
}

function walk(node, fn) {
  fn(node);
  const kids = node.childNodes || [];
  for (const child of kids) walk(child, fn);
  // template elements keep children in .content
  if (node.content) walk(node.content, fn);
}
