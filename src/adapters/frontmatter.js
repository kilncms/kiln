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

import { applyYamlEdits, readValue as readYaml, validateYaml } from './yaml-splice.js';
import { applyTomlEdits, readTomlValue, validateToml } from './toml-splice.js';
import { applyJsonEdits, readJsonValue, validateJson, jsonObjectEnd } from './json-splice.js';

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

/** Apply scalar edits to front matter text of `format`: { text, applied, skipped } (text null when nothing may be written). */
export function applyFrontmatterEdits(format, fmText, edits) {
  if (format === 'toml') return applyTomlEdits(fmText, edits);
  if (format === 'json') return applyJsonEdits(fmText, edits);
  return applyYamlEdits(fmText, edits);
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
