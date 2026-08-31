/**
 * Surgical YAML value replacement (SOURCE-MODE-SPEC §8.3).
 *
 * The frontmatter in the repo is the source of truth. We never reserialize the
 * document — that destroys comments, key order, quoting style and blank lines,
 * which is data loss dressed as a successful save. Instead we parse with the
 * `yaml` package's CST (concrete syntax tree — every token keeps its exact
 * byte offset and original text) purely to LOCATE a value, then splice the
 * replacement into the raw text, exactly as src/engine.js does for HTML.
 *
 * Everything outside the edited value round-trips byte-identical.
 *
 * Safety properties:
 *  - the CST never resolves aliases or custom tags, so a billion-laughs bomb
 *    in customer frontmatter cannot expand here (§14);
 *  - an aliased value is refused rather than guessed at;
 *  - a file that fails to parse is never written ("a bad parse never writes a
 *    byte", §8.1) — locate errors surface as per-key skip reasons.
 */

import { Parser, CST, parseDocument } from 'yaml';

const MAX_YAML = 512 * 1024; // frontmatter far beyond this is not a content file

/**
 * Length of the value token's own text — its header (block scalars) plus its
 * source. Deliberately NOT CST.stringify(token): that also stringifies the
 * token's trailing trivia (the spaces and `# comment` after a value), and a
 * trailing comment must survive an edit untouched (§8.3).
 */
function tokenLength(token) {
  const props = (token.props || []).reduce((n, t) => n + (t.source ? t.source.length : 0), 0);
  return props + (token.source ? token.source.length : 0);
}

/**
 * Walk the CST to the value token addressed by `segs` (array of key/index
 * segments, e.g. ['title'] or ['tags', '1']).
 * Returns { token, item, parent } or { error }.
 */
function locateToken(root, segs) {
  let node = root;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (!node || typeof node !== 'object') return { error: 'pointer not found in source' };
    if (node.type === 'block-map' || node.type === 'flow-collection' && node.start?.source === '{') {
      const items = node.items || [];
      let hit = null;
      for (const item of items) {
        if (!item.key) continue;
        const k = CST.resolveAsScalar(item.key);
        if (k && String(k.value) === seg) { hit = item; break; }
      }
      if (!hit) return { error: 'pointer not found in source' };
      if (i === segs.length - 1) return finishItem(hit, node);
      node = hit.value;
    } else if (node.type === 'block-seq' || node.type === 'flow-collection') {
      if (!/^\d+$/.test(seg)) return { error: 'type mismatch' };
      const idx = Number(seg);
      // Flow collections interleave separators; count only real entries.
      const entries = (node.items || []).filter(it => it.value || it.key);
      const item = entries[idx];
      if (!item) return { error: 'pointer not found in source' };
      // Sequence entries put the value in .value (block) or .key/.value (flow).
      const target = item.value ? item : { value: item.key, start: item.start };
      if (i === segs.length - 1) return finishItem(target, node);
      node = target.value;
    } else {
      // Trying to descend into a scalar.
      return { error: 'type mismatch' };
    }
  }
  return { error: 'pointer not found in source' };
}

/** Resolve a map/seq item into a splice target. */
function finishItem(item, parent) {
  const v = item.value;
  if (!v) {
    // `key:` with no value — the splice point is right after the ':' separator.
    const sep = (item.sep || []).find(t => t.type === 'map-value-ind');
    if (!sep) return { error: 'pointer not found in source' };
    return { insertAfter: sep.offset + sep.source.length, item, parent };
  }
  if (v.type === 'alias') return { error: 'value is a YAML alias — edit it at its anchor' };
  if (v.type === 'block-map' || v.type === 'block-seq' || v.type === 'flow-collection') {
    return { error: 'type mismatch' }; // scalar edits only address scalar values
  }
  return { token: v, item, parent };
}

/** Values YAML would silently retype if left unquoted. */
function looksLikeYamlLiteral(s) {
  return /^(true|false|yes|no|on|off|null|~|)$/i.test(s)
    || /^[+-]?(\d[\d_]*)(\.\d*)?([eE][+-]?\d+)?$/.test(s)
    || /^[+-]?\.(inf|Inf|INF)$/.test(s) || /^\.(nan|NaN|NAN)$/.test(s)
    || /^\d{4}-\d{2}-\d{2}/.test(s);
}

/** Is this string safe to emit as a plain (unquoted) YAML scalar? */
function plainSafe(s) {
  if (s === '' || s !== s.trim()) return false;
  if (s.includes('\n') || s.includes(': ') || s.includes(' #')) return false;
  if (/[:#]$/.test(s)) return false;
  if (/^[-?:,\[\]{}&*!|>'"%@`]/.test(s)) return false;
  if (/[\u0000-\u001f\u007f]/.test(s)) return false;
  return true;
}

/**
 * Serialise one replacement value in a style that fits where it lands.
 *  - typed booleans/numbers emit bare literals;
 *  - dates/times emit bare ISO text (validated by the caller);
 *  - strings stay plain only when the original was plain AND the new value is
 *    unambiguous; anything else emits a double-quoted scalar. JSON string
 *    escaping is a strict subset of YAML double-quoted style, so
 *    JSON.stringify output is always valid YAML.
 */
export function serializeScalar(value, { type, originalStyle } = {}) {
  if (type === 'boolean') return value === true || value === 'true' ? 'true' : 'false';
  if (type === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return String(n);
  }
  const s = String(value);
  if (type === 'date' || type === 'time') return plainSafe(s) ? s : null;
  const wantPlain = (originalStyle === 'plain' || originalStyle === undefined)
    && plainSafe(s) && !looksLikeYamlLiteral(s);
  return wantPlain ? s : JSON.stringify(s);
}

function styleOf(token) {
  if (!token) return undefined;
  if (token.type === 'scalar') return 'plain';
  if (token.type === 'single-quoted-scalar') return 'single';
  if (token.type === 'double-quoted-scalar') return 'double';
  if (token.type === 'block-scalar') return 'block';
  return undefined;
}

/**
 * Locate the byte range of the value at `segs` inside raw YAML text.
 * Returns { start, end, style } (end exclusive), { insertAt } for an empty
 * value, or { error }.
 */
export function locateValue(yamlText, segs) {
  if (typeof yamlText !== 'string' || yamlText.length > MAX_YAML) return { error: 'file too large' };
  let docs;
  try { docs = [...new Parser().parse(yamlText)]; } catch { return { error: 'unparseable YAML' }; }
  const doc = docs.find(d => d.type === 'document');
  if (!doc || !doc.value) return { error: 'unparseable YAML' };
  const res = locateToken(doc.value, segs);
  if (res.error) return res;
  if (res.insertAfter !== undefined) return { insertAt: res.insertAfter };
  const start = res.token.offset;
  let end = start + tokenLength(res.token);
  // A block scalar's source runs through its final line break; the break
  // belongs to the document's line structure, not the value — keep it.
  while (end > start && (yamlText[end - 1] === '\n' || yamlText[end - 1] === '\r')) end--;
  return { start, end, style: styleOf(res.token) };
}

/**
 * Apply a batch of scalar edits to raw YAML text, surgically.
 * edits: [{ segs, value, type? , key }]  (key = caller's identifier for reporting)
 * Returns { text, applied: [key], skipped: [{ key, reason }] }.
 * Mirrors engine.applyEdits: one parse supplies every offset; splices apply in
 * descending order; overlapping edits keep the first and skip the rest.
 */
export function applyYamlEdits(yamlText, edits) {
  // A file that does not parse is never written (§8.1).
  const probe = validateYaml(yamlText);
  if (probe) return { text: null, applied: [], skipped: edits.map(e => ({ key: e.key, reason: 'file is not valid YAML: ' + probe })) };

  const splices = [];
  const applied = [];
  const skipped = [];
  for (const e of edits) {
    const loc = locateValue(yamlText, e.segs);
    if (loc.error) { skipped.push({ key: e.key, reason: loc.error }); continue; }
    const out = serializeScalar(e.value, { type: e.type, originalStyle: loc.style });
    if (out === null) { skipped.push({ key: e.key, reason: 'value does not fit the field type' }); continue; }
    if (loc.insertAt !== undefined) {
      splices.push({ start: loc.insertAt, end: loc.insertAt, text: ' ' + out, key: e.key });
    } else {
      splices.push({ start: loc.start, end: loc.end, text: out, key: e.key });
    }
  }

  splices.sort((a, b) => a.start - b.start || a.end - b.end);
  const clean = [];
  for (const s of splices) {
    const prev = clean[clean.length - 1];
    if (prev && s.start < prev.end) { skipped.push({ key: s.key, reason: `overlaps edit of "${prev.key}"` }); continue; }
    // Two inserts at the same point (duplicate pointer) also collide.
    if (prev && s.start === prev.start && s.end === prev.end) { skipped.push({ key: s.key, reason: `duplicate pointer of "${prev.key}"` }); continue; }
    clean.push(s);
  }

  let out = yamlText;
  for (const s of [...clean].reverse()) {
    out = out.slice(0, s.start) + s.text + out.slice(s.end);
    applied.push(s.key);
  }
  applied.reverse();

  // Belt and braces: if our own splice somehow produced unparseable YAML,
  // refuse the write rather than committing a broken file.
  if (applied.length) {
    const bad = validateYaml(out);
    if (bad) {
      return { text: null, applied: [], skipped: [...skipped, ...applied.map(key => ({ key, reason: 'edit would corrupt the file: ' + bad }))] };
    }
  }
  return { text: out, applied, skipped };
}

/** Parse-check YAML. Returns the first error message, or null when clean. */
export function validateYaml(yamlText) {
  if (typeof yamlText !== 'string') return 'not text';
  if (yamlText.length > MAX_YAML) return 'file too large';
  try {
    const doc = parseDocument(yamlText, { logLevel: 'silent' });
    if (doc.errors && doc.errors.length) return doc.errors[0].message.split('\n')[0];
    return null;
  } catch (err) {
    return String(err && err.message || err).split('\n')[0];
  }
}

/** Read the current value at `segs` (prefill/tests). Alias-expansion capped. */
export function readValue(yamlText, segs) {
  try {
    const doc = parseDocument(yamlText, { logLevel: 'silent', maxAliasCount: 100 });
    if (doc.errors && doc.errors.length) return undefined;
    let v = doc.toJS();
    for (const seg of segs) {
      if (v == null || typeof v !== 'object') return undefined;
      v = Array.isArray(v) ? v[Number(seg)] : v[seg];
    }
    return v;
  } catch { return undefined; }
}
