/**
 * Surgical TOML value replacement: the TOML twin of yaml-splice.js.
 *
 * Front matter between `+++` fences (Astro, Hugo) and Hugo's config are TOML.
 * As with YAML, the file is never re-serialised: the text is read once to find
 * where each value sits, the new value is written into exactly those bytes,
 * and comments, blank lines, key order and quoting survive byte-identical.
 *
 * A small, strict reader of TOML 1.0: bare, quoted and dotted keys, [tables]
 * and [[arrays of tables]], the four kinds of string, integers (decimal, hex,
 * octal, binary, with underscores), floats (inf and nan too), booleans,
 * dates and times, arrays (over several lines, with comments) and inline
 * tables. What it cannot read it refuses: a file that does not parse is never
 * written. Pure functions over text: no network, no filesystem.
 */

const MAX_TOML = 512 * 1024;

class TomlError extends Error {}

const BARE_KEY = /[A-Za-z0-9_-]/;

/**
 * Parse TOML text into { root, entries }. `entries` lists every scalar and
 * array value with its key path and byte range: { path: [...], start, end,
 * style, value }. Throws TomlError on anything it cannot read.
 */
export function parseToml(text) {
  if (typeof text !== 'string') throw new TomlError('not text');
  if (text.length > MAX_TOML) throw new TomlError('file too large');
  let i = 0;
  const root = {};
  const entries = [];
  let table = root;
  let tablePath = [];
  const defined = new Set();   // tables and keys already written, to refuse duplicates

  const err = (msg) => {
    const line = text.slice(0, i).split('\n').length;
    throw new TomlError(`${msg} (line ${line})`);
  };
  const peek = (n = 0) => text[i + n];
  const skipWs = () => { while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++; };
  const skipComment = () => {
    if (text[i] === '#') {
      while (i < text.length && text[i] !== '\n') {
        const c = text.charCodeAt(i);
        if ((c < 0x20 && c !== 0x09) || c === 0x7f) err('control character in a comment');
        i++;
      }
    }
  };
  const endOfLine = () => {
    skipWs(); skipComment();
    if (i >= text.length) return;
    if (text[i] === '\r' && text[i + 1] === '\n') { i += 2; return; }
    if (text[i] === '\n') { i++; return; }
    err('expected the end of the line');
  };
  // Blank lines, comments and new lines, as allowed inside an array.
  const skipWsNl = () => {
    for (;;) {
      skipWs(); skipComment();
      if (text[i] === '\n') { i++; continue; }
      if (text[i] === '\r' && text[i + 1] === '\n') { i += 2; continue; }
      break;
    }
  };

  function readKeyPart() {
    if (peek() === '"') return readBasicString(false).value;
    if (peek() === "'") return readLiteralString(false).value;
    const s = i;
    while (i < text.length && BARE_KEY.test(text[i])) i++;
    if (i === s) err('expected a key');
    return text.slice(s, i);
  }
  function readKey() {
    const parts = [readKeyPart()];
    for (;;) {
      skipWs();
      if (peek() !== '.') break;
      i++; skipWs();
      parts.push(readKeyPart());
    }
    return parts;
  }

  function readEscape() {
    const c = text[i++];
    const simple = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\', e: '\x1b' };
    if (c in simple) return simple[c];
    if (c === 'u' || c === 'U') {
      const n = c === 'u' ? 4 : 8;
      const hex = text.slice(i, i + n);
      if (!/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== n) err('bad unicode escape');
      i += n;
      const cp = parseInt(hex, 16);
      if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) err('bad unicode escape');
      return String.fromCodePoint(cp);
    }
    err('bad escape');
  }
  function readBasicString(multiAllowed = true) {
    if (multiAllowed && text.startsWith('"""', i)) {
      i += 3;
      if (text[i] === '\n') i++; else if (text[i] === '\r' && text[i + 1] === '\n') i += 2;
      let out = '';
      for (;;) {
        if (i >= text.length) err('unterminated string');
        if (text.startsWith('"""', i)) {
          // Up to two quotes may stand right before the closing three.
          let q = 3;
          while (text[i + q] === '"' && q < 5) q++;
          out += '"'.repeat(q - 3);
          i += q;
          return { value: out, style: 'multi-basic' };
        }
        const c = text[i];
        if (c === '\\') {
          i++;
          // A backslash at the end of a line trims the break and the white space after it.
          if (/^[ \t]*\r?\n/.test(text.slice(i, i + 64))) {
            while (i < text.length && /[ \t\r\n]/.test(text[i])) i++;
            continue;
          }
          out += readEscape();
          continue;
        }
        out += c; i++;
      }
    }
    i++;   // opening quote
    let out = '';
    for (;;) {
      if (i >= text.length || text[i] === '\n') err('unterminated string');
      const c = text[i];
      if (c === '"') { i++; return { value: out, style: 'basic' }; }
      if (c === '\\') { i++; out += readEscape(); continue; }
      out += c; i++;
    }
  }
  function readLiteralString(multiAllowed = true) {
    if (multiAllowed && text.startsWith("'''", i)) {
      i += 3;
      if (text[i] === '\n') i++; else if (text[i] === '\r' && text[i + 1] === '\n') i += 2;
      const close = text.indexOf("'''", i);
      if (close === -1) err('unterminated string');
      let q = 3;
      while (text[close + q] === "'" && q < 5) q++;
      const value = text.slice(i, close) + "'".repeat(q - 3);
      i = close + q;
      return { value, style: 'multi-literal' };
    }
    i++;
    const close = text.indexOf("'", i);
    const nl = text.indexOf('\n', i);
    if (close === -1 || (nl !== -1 && nl < close)) err('unterminated string');
    const value = text.slice(i, close);
    i = close + 1;
    return { value, style: 'literal' };
  }

  const DATE = /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})?)?/;
  const TIME = /^\d{2}:\d{2}:\d{2}(?:\.\d+)?/;
  function readBare() {
    const rest = text.slice(i, i + 64);
    let m;
    if ((m = /^(true|false)(?![A-Za-z0-9_])/.exec(rest))) { i += m[0].length; return { value: m[1] === 'true', style: 'bare', kind: 'boolean' }; }
    if ((m = DATE.exec(rest))) {
      // "1979-05-27 07:32:00": a space is a separator only when a time follows it.
      i += m[0].length;
      return { value: m[0], style: 'bare', kind: 'date' };
    }
    if ((m = TIME.exec(rest))) { i += m[0].length; return { value: m[0], style: 'bare', kind: 'time' }; }
    if ((m = /^[+-]?(inf|nan)(?![A-Za-z0-9_])/.exec(rest))) { i += m[0].length; return { value: m[0].replace('+', '').startsWith('-') ? -Infinity : (m[1] === 'nan' ? NaN : Infinity), style: 'bare', kind: 'number' }; }
    if ((m = /^0x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*|^0o[0-7](?:_?[0-7])*|^0b[01](?:_?[01])*/.exec(rest))) {
      i += m[0].length;
      return { value: Number(m[0].replace(/_/g, '')), style: 'bare', kind: 'number' };
    }
    if ((m = /^[+-]?(?:0|[1-9](?:_?\d)*)(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?/.exec(rest)) && m[0] && !/^[+-]?$/.test(m[0])) {
      i += m[0].length;
      return { value: Number(m[0].replace(/_/g, '')), style: 'bare', kind: 'number' };
    }
    err('expected a value');
  }

  function readValue(path) {
    const start = i;
    const c = peek();
    let v;
    if (c === '"') v = readBasicString();
    else if (c === "'") v = readLiteralString();
    else if (c === '[') v = readArray(path);
    else if (c === '{') v = readInlineTable(path);
    else v = readBare();
    v.start = start; v.end = i;
    if (v.style !== 'array' && v.style !== 'table') entries.push({ path, start, end: i, style: v.style, value: v.value, kind: v.kind || 'string' });
    else entries.push({ path, start, end: i, style: v.style, value: v.value, kind: v.style });
    return v;
  }
  function readArray(path) {
    i++;
    const out = [];
    for (;;) {
      skipWsNl();
      if (peek() === ']') { i++; return { value: out, style: 'array' }; }
      const v = readValue([...path, String(out.length)]);
      out.push(v.value);
      skipWsNl();
      if (peek() === ',') { i++; continue; }
      skipWsNl();
      if (peek() === ']') { i++; return { value: out, style: 'array' }; }
      err('expected , or ] in an array');
    }
  }
  function readInlineTable(path) {
    i++;
    const out = {};
    skipWs();
    if (peek() === '}') { i++; return { value: out, style: 'table' }; }
    for (;;) {
      skipWs();
      const key = readKey();
      skipWs();
      if (peek() !== '=') err('expected =');
      i++; skipWs();
      const v = readValue([...path, ...key]);
      setPath(out, key, v.value, path);
      skipWs();
      if (peek() === ',') { i++; continue; }
      if (peek() === '}') { i++; return { value: out, style: 'table' }; }
      err('expected , or } in an inline table');
    }
  }
  function setPath(obj, key, value, base) {
    let o = obj;
    for (let k = 0; k < key.length - 1; k++) {
      if (o[key[k]] === undefined) o[key[k]] = {};
      else if (typeof o[key[k]] !== 'object' || Array.isArray(o[key[k]])) err(`key ${key.slice(0, k + 1).join('.')} is already a value`);
      o = o[key[k]];
    }
    const id = [...base, ...key].join('\u0000');
    if (o[key[key.length - 1]] !== undefined || defined.has(id)) err(`key ${key.join('.')} is written twice`);
    defined.add(id);
    o[key[key.length - 1]] = value;
  }

  // The file, line by line.
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  while (i < text.length) {
    skipWsNl();
    if (i >= text.length) break;
    if (peek() === '[') {
      const arrayOfTables = peek(1) === '[';
      i += arrayOfTables ? 2 : 1;
      skipWs();
      const key = readKey();
      skipWs();
      if (arrayOfTables) { if (!text.startsWith(']]', i)) err('expected ]]'); i += 2; }
      else { if (peek() !== ']') err('expected ]'); i++; }
      endOfLine();
      let o = root;
      const path = [];
      for (let k = 0; k < key.length; k++) {
        const last = k === key.length - 1;
        path.push(key[k]);
        if (last && arrayOfTables) {
          if (o[key[k]] === undefined) o[key[k]] = [];
          if (!Array.isArray(o[key[k]])) err(`${key.join('.')} is not an array of tables`);
          const t = {};
          o[key[k]].push(t);
          path.push(String(o[key[k]].length - 1));
          o = t;
        } else {
          if (o[key[k]] === undefined) o[key[k]] = {};
          const next = o[key[k]];
          if (Array.isArray(next)) { o = next[next.length - 1]; path.push(String(next.length - 1)); }
          else if (typeof next === 'object') o = next;
          else err(`${key.slice(0, k + 1).join('.')} is already a value`);
        }
      }
      if (!arrayOfTables) {
        const id = 'table:' + path.join('\u0000');
        if (defined.has(id)) err(`table [${key.join('.')}] is written twice`);
        defined.add(id);
      }
      table = o; tablePath = path;
      continue;
    }
    const key = readKey();
    skipWs();
    if (peek() !== '=') err('expected =');
    i++; skipWs();
    const v = readValue([...tablePath, ...key]);
    setPath(table, key, v.value, tablePath);
    endOfLine();
  }
  return { root, entries };
}

/** Parse-check TOML. Returns the first problem as a sentence, or null when clean. */
export function validateToml(text) {
  try { parseToml(text); return null; } catch (e) { return String(e && e.message || e); }
}

/** The value at `segs` (key path, array indexes as strings), or undefined. */
export function readTomlValue(text, segs) {
  let v;
  try { v = parseToml(text).root; } catch { return undefined; }
  for (const seg of segs) {
    if (v == null || typeof v !== 'object') return undefined;
    v = Array.isArray(v) ? v[Number(seg)] : v[seg];
  }
  return v;
}

/** Where the value at `segs` is written: { start, end, style, kind } or { error }. */
export function locateTomlValue(text, segs) {
  let parsed;
  try { parsed = parseToml(text); } catch { return { error: 'unparseable TOML' }; }
  const want = segs.join('\u0000');
  const hit = parsed.entries.find(e => e.path.join('\u0000') === want);
  if (!hit) {
    // Inside a value that is not a table or an array, or not there at all.
    return { error: 'pointer not found in source' };
  }
  if (hit.style === 'array' || hit.style === 'table') return { error: 'type mismatch' };
  return { start: hit.start, end: hit.end, style: hit.style, kind: hit.kind };
}

const isDate = (s) => /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})?)?$/.test(s);

function basicQuoted(s) {
  return '"' + String(s).replace(/[\\"\u0000-\u001f\u007f]/g, (c) => {
    const short = { '\\': '\\\\', '"': '\\"', '\b': '\\b', '\t': '\\t', '\n': '\\n', '\f': '\\f', '\r': '\\r' };
    return short[c] || '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0');
  }) + '"';
}

/**
 * Serialise one value the way its place was written: a quoted string keeps
 * its quotes (a literal one becomes a basic one only when the new text holds
 * a quote or a line break it cannot); a multi-line string stays multi-line;
 * a number, a yes/no and a date are written bare where they were bare.
 * Returns null when the value cannot be written there.
 */
export function serializeTomlScalar(value, { type, style, kind } = {}) {
  if (type === 'boolean' || (type === undefined && typeof value === 'boolean')) {
    if (style !== 'bare' && style !== undefined) return basicQuoted(value === true || value === 'true' ? 'true' : 'false');
    return value === true || value === 'true' ? 'true' : 'false';
  }
  if (type === 'number' || (type === undefined && typeof value === 'number')) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    if (style !== 'bare' && style !== undefined) return basicQuoted(String(n));
    return String(n);
  }
  const s = String(value);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s)) return null;
  if (style === 'bare') {
    // A date written bare stays a date; text where a bare value stood is quoted.
    if ((type === 'date' || kind === 'date') && isDate(s)) return s;
    if (type === 'time' && /^\d{2}:\d{2}(:\d{2})?$/.test(s)) return s.length === 5 ? `${s}:00` : s;
    return basicQuoted(s);
  }
  if (style === 'literal') return /['\r\n]/.test(s) ? basicQuoted(s) : `'${s}'`;
  if (style === 'multi-literal') return s.includes("'''") || /'$/.test(s) ? multiBasic(s) : `'''\n${s}'''`;
  if (style === 'multi-basic') return multiBasic(s);
  return basicQuoted(s);
}

function multiBasic(s) {
  const body = s.replace(/\\/g, '\\\\').replace(/"""/g, '""\\"').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  return `"""\n${body.endsWith('"') ? body.slice(0, -1) + '\\"' : body}"""`;
}

/**
 * Apply scalar edits to TOML text, surgically. Same contract as
 * applyYamlEdits: edits [{ segs, value, type, key }] → { text, applied, skipped }.
 * A file that does not parse is never written, and neither is a result that
 * would not parse.
 */
export function applyTomlEdits(text, edits) {
  const probe = validateToml(text);
  if (probe) return { text: null, applied: [], skipped: edits.map(e => ({ key: e.key, reason: 'file is not valid TOML: ' + probe })) };
  const splices = [];
  const applied = [];
  const skipped = [];
  for (const e of edits) {
    const loc = locateTomlValue(text, e.segs);
    if (loc.error) { skipped.push({ key: e.key, reason: loc.error }); continue; }
    const out = serializeTomlScalar(e.value, { type: e.type, style: loc.style, kind: loc.kind });
    if (out === null) { skipped.push({ key: e.key, reason: 'value does not fit the field type' }); continue; }
    splices.push({ start: loc.start, end: loc.end, text: out, key: e.key });
  }
  splices.sort((a, b) => a.start - b.start);
  const clean = [];
  for (const s of splices) {
    const prev = clean[clean.length - 1];
    if (prev && s.start < prev.end) { skipped.push({ key: s.key, reason: `duplicate pointer of "${prev.key}"` }); continue; }
    clean.push(s);
  }
  let out = text;
  for (const s of [...clean].reverse()) {
    out = out.slice(0, s.start) + s.text + out.slice(s.end);
    applied.push(s.key);
  }
  applied.reverse();
  if (applied.length) {
    const bad = validateToml(out);
    if (bad) return { text: null, applied: [], skipped: [...skipped, ...applied.map(key => ({ key, reason: 'edit would corrupt the file: ' + bad }))] };
  }
  return { text: out, applied, skipped };
}
