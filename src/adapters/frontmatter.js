/**
 * Front matter: the block of fields at the top of a content file, in the
 * forms the generators read.
 *
 *   ---   YAML   ---      Astro, Eleventy, Hugo, Jekyll
 *   +++   TOML   +++      Astro, Hugo
 *   { JSON }              Hugo (an object at the very start of the file)
 *
 * One place that finds it, reads a field, writes a field surgically and
 * checks that the result still parses, whatever the form. Pure functions over
 * text (the YAML and TOML splicers do the writing).
 */

import { applyYamlEdits, readValue as readYaml, validateYaml, serializeScalar } from './yaml-splice.js';
import { applyTomlEdits, readTomlValue, validateToml, serializeTomlScalar } from './toml-splice.js';
import { applyJsonEdits, readJsonValue, validateJson, jsonObjectEnd } from './json-splice.js';

/** A field name Kiln may add or write at the top of front matter. */
export const PLAIN_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const NOT_FOUND = 'pointer not found in source';

/**
 * Where the front matter is: { format, fmStart, fmEnd, bodyStart } with
 * offsets into `text` (fmStart..fmEnd is the YAML/TOML/JSON itself, without
 * its fences), or null when the file has none.
 */
export function frontmatterRange(text) {
  const t = String(text);
  const bom = t.charCodeAt(0) === 0xfeff ? 1 : 0;
  const open = /^(---|\+\+\+)[ \t]*\r?\n/.exec(t.slice(bom));
  if (open) {
    const fence = open[1];
    const fmStart = bom + open[0].length;
    const close = fence === '---'
      ? /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(t.slice(fmStart))
      : /^\+\+\+[ \t]*(?:\r?\n|$)/m.exec(t.slice(fmStart));
    if (!close) return null;
    const lineStart = fmStart + close.index;
    return { format: fence === '---' ? 'yaml' : 'toml', fmStart, fmEnd: lineStart, bodyStart: lineStart + close[0].length };
  }
  if (t[bom] === '{') {
    const end = jsonObjectEnd(t, bom);
    if (end < 0) return null;
    let bodyStart = end;
    const nl = /^[ \t]*\r?\n/.exec(t.slice(end));
    if (nl) bodyStart += nl[0].length;
    return { format: 'json', fmStart: bom, fmEnd: end, bodyStart };
  }
  return null;
}

/**
 * Apply scalar edits to front matter text of `format`: { text, applied,
 * skipped } (text null when nothing may be written). An edit that says
 * `add: true` writes a top-level field the file does not have yet, on a line
 * of its own (a draft mark, an order, a page's description); every other edit
 * changes a value that is there, and only that.
 */
export function applyFrontmatterEdits(format, fmText, edits) {
  const run = format === 'toml' ? applyTomlEdits : format === 'json' ? applyJsonEdits : applyYamlEdits;
  const first = run(fmText, edits);
  const byKey = new Map(edits.map(e => [e.key, e]));
  const toAdd = first.skipped.filter(s => s.reason === NOT_FOUND && byKey.get(s.key)?.add === true
    && byKey.get(s.key).segs.length === 1 && PLAIN_NAME.test(byKey.get(s.key).segs[0]));
  if (!toAdd.length) return first;
  let out = first.text ?? fmText;
  const added = [];
  const left = [];
  for (const s of toAdd) {
    const e = byKey.get(s.key);
    const next = addField(format, out, e.segs[0], e.value, e.type);
    if (next === null) left.push({ key: e.key, reason: 'value does not fit the field type' });
    else { out = next; added.push(e.key); }
  }
  const bad = added.length ? validateFrontmatter(format, out) : null;
  if (bad) return { text: first.text, applied: first.applied, skipped: [...first.skipped.filter(s => !added.includes(s.key)), ...added.map(key => ({ key, reason: 'edit would corrupt the file: ' + bad }))] };
  const addedSet = new Set(added);
  return {
    text: out,
    applied: [...first.applied, ...added],
    skipped: [...first.skipped.filter(s => !addedSet.has(s.key) && !left.some(l => l.key === s.key)), ...left],
  };
}

/** A value as one field's line would hold it, or null when it cannot be one. */
function fieldValue(format, value, type) {
  const t = type || (typeof value === 'boolean' ? 'boolean' : typeof value === 'number' ? 'number'
    : typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? 'date' : undefined);
  if (Array.isArray(value)) {
    if (!value.every(v => ['string', 'number', 'boolean'].includes(typeof v))) return null;
    const items = value.map(v => fieldValue(format, v));
    if (items.some(i => i === null)) return null;
    return `[${items.join(', ')}]`;
  }
  if (!['string', 'number', 'boolean'].includes(typeof value)) return null;
  if (format === 'toml') return serializeTomlScalar(value, { type: t, style: t === 'date' ? 'bare' : undefined });
  if (format === 'json') {
    if (t === 'boolean') return value === true || value === 'true' ? 'true' : 'false';
    if (t === 'number') { const n = Number(value); return Number.isFinite(n) ? String(n) : null; }
    return JSON.stringify(String(value));
  }
  if (value === '') return '""';
  return serializeScalar(value, { type: t, flow: false });
}

/** Front matter text with one more top-level field, or null. */
function addField(format, text, name, value, type) {
  const v = fieldValue(format, value, type);
  if (v === null) return null;
  if (format === 'json') {
    const end = text.lastIndexOf('}');
    if (end < 0) return null;
    const inside = text.slice(text.indexOf('{') + 1, end);
    const line = `${JSON.stringify(name)}: ${v}`;
    if (!inside.trim()) return `${text.slice(0, text.indexOf('{') + 1)}\n  ${line}\n${text.slice(end)}`;
    const before = text.slice(0, end).replace(/\s*$/, '');
    return `${before},\n  ${line}${text.slice(before.length)}`;
  }
  const line = format === 'toml' ? `${name} = ${v}\n` : `${name}: ${v}\n`;
  if (format === 'toml') {
    // Top-level fields come before the first [table].
    const table = /^[ \t]*\[/m.exec(text);
    if (table) {
      let at = table.index;
      while (at > 0 && /\n/.test(text[at - 1]) && /\n/.test(text[at - 2] || '')) at--;   // above the blank lines that set the table apart
      return text.slice(0, at) + line + text.slice(at);
    }
  }
  const sep = text && !text.endsWith('\n') ? '\n' : '';
  return text + sep + line;
}

/**
 * The front matter of a new entry, in `format` ('yaml' or 'toml'), one plain
 * field per line, in the order given. Text, numbers, yes/no, dates
 * (YYYY-MM-DD) and lists of those; anything else is left out.
 */
export function frontmatterText(format, fields) {
  let out = '';
  for (const [name, value] of Object.entries(fields || {})) {
    if (!PLAIN_NAME.test(name)) continue;
    const v = fieldValue(format, value);
    if (v === null) continue;
    out += format === 'toml' ? `${name} = ${v}\n` : `${name}: ${v}\n`;
  }
  return out;
}

/** The value at `segs` in front matter text of `format`. */
export function readFrontmatterValue(format, fmText, segs) {
  if (format === 'toml') return readTomlValue(fmText, segs);
  if (format === 'json') return readJsonValue(fmText, segs);
  return readYaml(fmText, segs);
}

/** null when front matter text of `format` parses, else its first problem. */
export function validateFrontmatter(format, fmText) {
  if (format === 'toml') return validateToml(fmText);
  if (format === 'json') return validateJson(fmText);
  return validateYaml(fmText);
}

/** The name a person reads for a format, in a sentence. */
export function formatName(format) {
  return format === 'toml' ? 'TOML' : format === 'json' ? 'JSON' : 'YAML';
}
