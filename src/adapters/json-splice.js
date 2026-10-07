/**
 * Surgical JSON value replacement, for JSON front matter (Hugo) and JSON data
 * files (`_data/*.json`, `data/*.json`). As with YAML and TOML, only the bytes
 * of the edited value change: the file's spacing and key order stay.
 */

const MAX_JSON = 512 * 1024;

/** Index just after the `}` that closes the object starting at `from`; -1 when it does not close. */
export function jsonObjectEnd(text, from) {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++; continue; }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') { depth--; if (depth === 0) return i + 1; }
  }
  return -1;
}

/** Every scalar value with its key path and byte range: [{ path, start, end, value }]. Throws on bad JSON. */
function scan(text) {
  let i = 0;
  const out = [];
  const ws = () => { while (/[ \t\r\n]/.test(text[i] || '')) i++; };
  const fail = (m) => { throw new Error(`${m} at ${i}`); };
  const str = () => {
    const s = i;
    if (text[i] !== '"') fail('expected a string');
    for (i++; i < text.length && text[i] !== '"'; i++) { if (text[i] === '\\') i++; else if (text.charCodeAt(i) < 0x20) fail('control character in a string'); }
    if (text[i] !== '"') fail('unterminated string');
    i++;
    return JSON.parse(text.slice(s, i));
  };
  const value = (path) => {
    ws();
    const s = i;
    const c = text[i];
    if (c === '{') {
      i++; ws();
      if (text[i] === '}') { i++; return; }
      for (;;) {
        ws(); const k = str(); ws();
        if (text[i] !== ':') fail('expected :'); i++;
        value([...path, k]); ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; return; }
        fail('expected , or }');
      }
    }
    if (c === '[') {
      i++; ws();
      if (text[i] === ']') { i++; return; }
      for (let n = 0; ; n++) {
        value([...path, String(n)]); ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; return; }
        fail('expected , or ]');
      }
    }
    let v;
    if (c === '"') v = str();
    else {
      const m = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i, i + 64));
      if (!m) fail('expected a value');
      i += m[0].length;
      v = JSON.parse(m[0]);
    }
    out.push({ path, start: s, end: i, value: v, quoted: c === '"' });
  };
  value([]);
  ws();
  if (i < text.length) fail('unexpected text after the value');
  return out;
}

export function validateJson(text) {
  if (typeof text !== 'string') return 'not text';
  if (text.length > MAX_JSON) return 'file too large';
  try { JSON.parse(text); scan(text); return null; } catch (e) { return String(e.message || e).split('\n')[0]; }
}

export function readJsonValue(text, segs) {
  let v;
  try { v = JSON.parse(text); } catch { return undefined; }
  for (const seg of segs) {
    if (v == null || typeof v !== 'object') return undefined;
    v = Array.isArray(v) ? v[Number(seg)] : v[seg];
  }
  return v;
}

/** Same contract as applyYamlEdits: edits [{ segs, value, type, key }] → { text, applied, skipped }. */
export function applyJsonEdits(text, edits) {
  const bad = validateJson(text);
  if (bad) return { text: null, applied: [], skipped: edits.map(e => ({ key: e.key, reason: 'file is not valid JSON: ' + bad })) };
  const entries = scan(text);
  const splices = [];
  const skipped = [];
  for (const e of edits) {
    const want = e.segs.join('\u0000');
    const hit = entries.find(x => x.path.join('\u0000') === want);
    if (!hit) {
      const container = readJsonValue(text, e.segs);
      skipped.push({ key: e.key, reason: container !== undefined ? 'type mismatch' : 'pointer not found in source' });
      continue;
    }
    let out;
    if (e.type === 'boolean') out = String(e.value === true || e.value === 'true');
    else if (e.type === 'number') { const n = Number(e.value); if (!Number.isFinite(n)) { skipped.push({ key: e.key, reason: 'value does not fit the field type' }); continue; } out = String(n); }
    else if (!hit.quoted && typeof e.value !== 'string') out = JSON.stringify(e.value);
    else out = JSON.stringify(String(e.value));
    // A number or a yes/no written as text where text stood stays text.
    if (hit.quoted && (e.type === 'boolean' || e.type === 'number')) out = JSON.stringify(out);
    splices.push({ start: hit.start, end: hit.end, text: out, key: e.key });
  }
  splices.sort((a, b) => b.start - a.start);
  let out = text;
  const applied = [];
  const seen = new Set();
  for (const s of splices) {
    if (seen.has(s.start)) { skipped.push({ key: s.key, reason: 'duplicate pointer' }); continue; }
    seen.add(s.start);
    out = out.slice(0, s.start) + s.text + out.slice(s.end);
    applied.push(s.key);
  }
  applied.reverse();
  const after = validateJson(out);
  if (after) return { text: null, applied: [], skipped: [...skipped, ...applied.map(key => ({ key, reason: 'edit would corrupt the file: ' + after }))] };
  return { text: out, applied, skipped };
}
