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

import { Parser, CST, parseDocument, parse } from 'yaml';

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

/**
 * Text a YAML reader would take for something else if it stood unquoted: a
 * yes/no in any of its spellings, nothing at all, a number (a leading zero,
 * an underscore, hex and octal included), a time or any other run of
 * sixty-based digits (YAML 1.1 reads 18:30 as the number 1110), a date.
 */
function looksLikeYamlLiteral(s) {
  return /^(true|false|yes|no|on|off|y|n|null|~|)$/i.test(s)
    || /^[+-]?(\d[\d_]*(\.[\d_]*)?|\.\d[\d_]*)([eE][+-]?\d+)?$/.test(s)
    || /^[+-]?0[xob][0-9a-f_]+$/i.test(s)
    || /^[+-]?\d[\d_]*(:[0-5]?\d)+(\.[\d_]*)?$/.test(s)
    || /^[+-]?\.(inf|Inf|INF)$/.test(s) || /^\.(nan|NaN|NAN)$/.test(s)
    || /^\d{4}-\d{1,2}-\d{1,2}/.test(s);
}

/** Is this string safe to emit as a plain (unquoted) YAML scalar? */
function plainSafe(s) {
  if (s === '' || s !== s.trim()) return false;
  if (s.includes('\n') || s.includes(': ') || s.includes(' #')) return false;
  if (/[:#]$/.test(s)) return false;
  // A leading # would turn the whole value into a comment, and the field into nothing.
  if (/^[-?:,\[\]{}&*!|>'"%@`#]/.test(s)) return false;
  if (/[\u0000-\u001f\u007f]/.test(s)) return false;
  return true;
}

/** Does `text`, standing as a value, read back as exactly the string `s`, in YAML 1.2 and in 1.1? */
function readsBackAs(text, s) {
  try {
    return ['1.2', '1.1'].every(version => parse(`k: ${text}\n`, { version, logLevel: 'silent' }).k === s);
  } catch { return false; }
}

/** `s` between single quotes, or null when it cannot stand on one single-quoted line. */
function singleQuoted(s) {
  if (/[\u0000-\u001f\u007f]/.test(s)) return null;
  return `'${s.replaceAll("'", "''")}'`;
}

/**
 * Serialise one replacement value the way its line was written.
 *  - a line that was quoted stays quoted, in the quotes it had, whatever the
 *    value is: a number between quotes is text to the site that reads it;
 *  - on an unquoted line (or a field that had no value) a yes/no, a number
 *    and a date are written bare, because that is what they are meant to be;
 *  - a time is quoted there, and so is any text a YAML reader could take for
 *    something else (looksLikeYamlLiteral) or could not read back as written;
 *  - everything else stays unquoted (inside [ ] or { }, only without a comma
 *    or a bracket, which would end the value there). New quotes are double quotes: JSON
 *    string escaping is a strict subset of YAML double-quoted style, so
 *    JSON.stringify output is always valid YAML.
 */
export function serializeScalar(value, { type, originalStyle, flow = false, header, indent } = {}) {
  let s;
  // A block of text (| or >) stays a block, its lines indented as they were.
  // A folded one (>) is written literal (|): folding would join the lines the
  // text means to keep apart. The chomping mark (-, +) stays.
  if (originalStyle === 'block' && type !== 'boolean' && type !== 'number' && typeof value === 'string' && indent) {
    const text = value.replace(/\r\n/g, '\n');
    const chomp = /[-+]/.exec(header || '')?.[0] || '';
    const body = chomp === '+' ? text : text.replace(/\n+$/, '');
    // A first line that starts with a space, or a tab anywhere at a line's start, needs an indentation mark: write it quoted instead.
    if (!/^[ \t]/.test(body) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body) && body !== '') {
      return `|${chomp}\n` + body.split('\n').map(l => (l ? indent + l : '')).join('\n');
    }
  }
  if (type === 'boolean') s = value === true || value === 'true' ? 'true' : 'false';
  else if (type === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    s = String(n);
  } else s = String(value);
  if ((type === 'date' || type === 'time') && !plainSafe(s)) return null;
  if (originalStyle === 'single') return singleQuoted(s) ?? JSON.stringify(s);
  if (originalStyle === 'double') return JSON.stringify(s);
  if (type === 'boolean' || type === 'number' || type === 'date') return s;
  if (type === 'time') return JSON.stringify(s);
  const wantPlain = (originalStyle === 'plain' || originalStyle === undefined)
    && plainSafe(s) && !looksLikeYamlLiteral(s) && readsBackAs(s, s) && !(flow && /[,\[\]{}]/.test(s));
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
  const style = styleOf(res.token);
  if (style === 'block') {
    const header = (res.token.props || []).find(t => t.type === 'block-scalar-header')?.source || '|';
    const firstLine = /^([ ]*)\S/m.exec(res.token.source || '');
    const keyCol = (() => { const ls = yamlText.lastIndexOf('\n', start - 1) + 1; return /^ */.exec(yamlText.slice(ls))[0].length; })();
    return { start, end, style, header, indent: firstLine ? firstLine[1] : ' '.repeat(keyCol + 2), flow: false };
  }
  // Inside [ ] or { } a comma or a bracket ends an unquoted value.
  return { start, end, style, flow: res.parent?.type === 'flow-collection' };
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
    const out = serializeScalar(e.value, { type: e.type, originalStyle: loc.style, flow: loc.flow, header: loc.header, indent: loc.indent });
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
