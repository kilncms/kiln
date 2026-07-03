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
const SAFE_ATTRS = new Set(['href', 'src', 'alt', 'title', 'class', 'target', 'rel', 'width', 'height', 'style']);
function attrNameAllowed(name) {
  if (SAFE_ATTRS.has(name)) return true;
  // data-* is fine (e.g. data-kiln-src/master/tags) except the structural data-cms* set.
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
 * Inline-style values may size and space things (the editor's image resize
 * writes width/height styles) but never smuggle in fetches or behaviors:
 * url(), expression(), @import and friends are rejected wholesale.
 */
export function safeStyle(value) {
  const v = String(value);
  if (/url\s*\(|expression\s*\(|javascript:|@import|behavior\s*:|binding\s*:|-moz-binding/i.test(v)) return '';
  return v;
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
      // href/src values get scheme-sanitized, style values CSS-sanitized, as
      // defense-in-depth (attribute splices bypass DOMPurify).
      const attrVal = (edit.attr === 'href' || edit.attr === 'src') ? safeUrl(edit.value)
        : edit.attr === 'style' ? safeStyle(edit.value)
        : String(edit.value);
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

/**
 * Make-editable support: locate the Nth occurrence (0-based, tree order) of a
 * tag in the raw source. Returns { start, end, attrInsert, text } for its start
 * tag, or null. The editor computes the same N against the live DOM (with
 * Kiln-injected elements filtered out), so N lines the two worlds up.
 */
export function findNthTag(raw, tag, nth) {
  const doc = parse(raw, { sourceCodeLocationInfo: true });
  const t = String(tag).toLowerCase();
  let i = -1, found = null;
  walk(doc, (node) => {
    if (found || node.tagName !== t || !node.sourceCodeLocation?.startTag) return;
    i++;
    if (i === nth) found = node;
  });
  if (!found) return null;
  const loc = found.sourceCodeLocation.startTag;
  const text = raw.slice(loc.startOffset, loc.endOffset);
  return {
    start: loc.startOffset,
    end: loc.endOffset,
    attrInsert: loc.endOffset - (text.endsWith('/>') ? 2 : 1),
    text,
    innerText: textOf(found),
  };
}

/** Concatenated text content of a parse5 node (for sanity-matching DOM ↔ source). */
function textOf(node) {
  let out = '';
  walk(node, (n) => { if (n.nodeName === '#text') out += n.value; });
  return out;
}

/**
 * Append HTML just before the Nth <tag>'s closing tag (i.e. at the end of its
 * inner content). Used to add a new section into a container (e.g. <main>).
 * Returns new HTML, or null if the element/end tag can't be located.
 */
export function appendIntoNthTag(raw, tag, nth, html) {
  const doc = parse(raw, { sourceCodeLocationInfo: true });
  const t = String(tag).toLowerCase();
  let i = -1, found = null;
  walk(doc, (node) => {
    if (found || node.tagName !== t || !node.sourceCodeLocation?.startTag) return;
    i++;
    if (i === nth) found = node;
  });
  if (!found || !found.sourceCodeLocation.endTag) return null;
  const at = found.sourceCodeLocation.endTag.startOffset;
  return raw.slice(0, at) + html + raw.slice(at);
}

/**
 * Insert HTML immediately AFTER the Nth <tag>'s closing tag — used to place a
 * new section below an existing one anywhere in the page (not just at the end
 * of <main>). Returns new HTML, or null if the element can't be located.
 */
export function insertAfterNthTag(raw, tag, nth, html) {
  const doc = parse(raw, { sourceCodeLocationInfo: true });
  const t = String(tag).toLowerCase();
  let i = -1, found = null;
  walk(doc, (node) => {
    if (found || node.tagName !== t || !node.sourceCodeLocation?.startTag) return;
    i++;
    if (i === nth) found = node;
  });
  if (!found) return null;
  const loc = found.sourceCodeLocation;
  const at = loc.endTag ? loc.endTag.endOffset : loc.startTag.endOffset;  // void tags: after the start tag
  return raw.slice(0, at) + html + raw.slice(at);
}

/**
 * Insert Kiln annotation attributes into the Nth <tag>'s start tag.
 * attrs must be a pre-built string like ` data-cms="hero_note"`.
 * Returns the new HTML, or null if the element can't be located.
 */
export function annotateNthTag(raw, tag, nth, attrs) {
  const node = findNthTag(raw, tag, nth);
  if (!node) return null;
  return raw.slice(0, node.attrInsert) + attrs + raw.slice(node.attrInsert);
}

/**
 * Remove every Kiln annotation (data-cms*, data-kiln-gallery/events/filters)
 * from the element indexed under `key`. Returns new HTML or null.
 */
/**
 * Remove a Kiln-added section from the source: the element carrying
 * data-cms-repeat="key", or its enclosing .kiln-added wrapper if there is one
 * (that's the <section> "Add a gallery or events" writes). Returns new HTML,
 * or null if the key can't be located.
 */
export function removeKilnSection(raw, key) {
  const doc = parse(raw, { sourceCodeLocationInfo: true });
  let target = null;
  const containsKey = (node) => {
    let hit = false;
    walk(node, (n) => {
      if (hit || !n.attrs) return;
      if (n.attrs.some(a => a.name === 'data-cms-repeat' && a.value === key)) hit = true;
    });
    return hit;
  };
  walk(doc, (node) => {
    if (target || !node.attrs || !node.sourceCodeLocation?.startTag) return;
    const cls = node.attrs.find(a => a.name === 'class')?.value || '';
    if (/\bkiln-added\b/.test(cls) && containsKey(node)) target = node;
  });
  if (!target) {
    walk(doc, (node) => {
      if (target || !node.attrs || !node.sourceCodeLocation?.startTag) return;
      if (node.attrs.some(a => a.name === 'data-cms-repeat' && a.value === key)) target = node;
    });
  }
  if (!target) return null;
  const loc = target.sourceCodeLocation;
  const start = loc.startTag.startOffset;
  const end = loc.endTag ? loc.endTag.endOffset : loc.startTag.endOffset;
  return raw.slice(0, start) + raw.slice(end);
}

export function removeAnnotations(raw, key) {
  const { fields } = indexHtml(raw);
  const f = fields.get(key);
  if (!f || f.attrInsert === undefined) return null;
  const selfClosing = raw.slice(f.attrInsert, f.attrInsert + 2) === '/>';
  const tagEnd = f.attrInsert + (selfClosing ? 2 : 1);
  const startTag = raw.slice(f.range.start, tagEnd);
  const cleaned = startTag.replace(
    /\s+data-(?:cms(?:-attr|-plain|-repeat|-menu|-list)?|kiln-(?:gallery|events|filters|tags))(?:="[^"]*"|='[^']*'|=[^\s>]+)?/gi, '');
  if (cleaned === startTag) return raw;
  return raw.slice(0, f.range.start) + cleaned + raw.slice(tagEnd);
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
export function editHead(raw, { title, description, ogImage }) {
  const doc = parse(raw, { sourceCodeLocationInfo: true });
  let titleNode = null, metaDesc = null, headNode = null, ogImgNode = null;
  walk(doc, (n) => {
    if (n.tagName === 'title' && !titleNode) titleNode = n;
    if (n.tagName === 'head' && !headNode) headNode = n;
    if (n.tagName === 'meta' && n.attrs?.some(a => a.name === 'name' && a.value === 'description')) metaDesc = n;
    if (n.tagName === 'meta' && n.attrs?.some(a => a.name === 'property' && a.value === 'og:image')) ogImgNode = n;
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
  if (ogImage !== undefined && ogImage !== '') {
    const url = safeUrl(ogImage);
    if (ogImgNode?.sourceCodeLocation) {
      const loc = ogImgNode.sourceCodeLocation.attrs?.content;
      const range = loc && attrValueRange(raw, loc);
      if (range) splices.push({ start: range.start, end: range.end, text: emitAttrValue(url, range.quote) });
    } else if (titleNode?.sourceCodeLocation) {
      const at = titleNode.sourceCodeLocation.endOffset;
      splices.push({ start: at, end: at, text: `\n  <meta property="og:image" content="${esc(url)}" />` });
    } else if (headNode?.sourceCodeLocation?.startTag) {
      const at = headNode.sourceCodeLocation.startTag.endOffset;
      splices.push({ start: at, end: at, text: `\n  <meta property="og:image" content="${esc(url)}" />` });
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
  let title = '', description = '', ogImage = '';
  walk(doc, (n) => {
    if (n.tagName === 'title' && n.childNodes?.[0]?.value) title = n.childNodes[0].value;
    if (n.tagName === 'meta' && n.attrs?.some(a => a.name === 'name' && a.value === 'description')) {
      description = n.attrs.find(a => a.name === 'content')?.value || '';
    }
    if (n.tagName === 'meta' && n.attrs?.some(a => a.name === 'property' && a.value === 'og:image')) {
      ogImage = n.attrs.find(a => a.name === 'content')?.value || '';
    }
  });
  return { title, description, ogImage };
}

function walk(node, fn) {
  fn(node);
  const kids = node.childNodes || [];
  for (const child of kids) walk(child, fn);
  // template elements keep children in .content
  if (node.content) walk(node.content, fn);
}
