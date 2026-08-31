/**
 * Astro source adapter (SOURCE-MODE-SPEC §4.2, §16.1).
 *
 * Teaches Kiln to edit the SOURCES an Astro site is built from — markdown
 * content-collection entries and their YAML frontmatter — instead of the
 * generated HTML. Pure functions over text: no network, no filesystem, no
 * credentials (§14). All writes are surgical splices; everything outside an
 * edited value round-trips byte-identical (§8.3).
 *
 * Pointer roots this adapter understands (§4.3):
 *   /frontmatter/<key>[/…]   a value in the entry's YAML frontmatter
 *   /body                    the markdown body, whole
 *
 * File support:
 *   .md / .markdown  — frontmatter + body
 *   .mdx             — frontmatter ONLY; an MDX body is executable
 *                      (imports/JSX), and Kiln never edits code (§8.4).
 */

import { parsePointer } from './pointer.js';
import { applyYamlEdits, readValue, validateYaml } from './yaml-splice.js';
import { detectScore } from './detect.js';

const MD_EXT = /\.(md|markdown)$/i;
const MDX_EXT = /\.mdx$/i;

/** Locate the frontmatter fence block. Returns ranges into `text` or null. */
function frontmatterRange(text) {
  const open = /^﻿?---\r?\n/.exec(text);
  if (!open) return null;
  const fmStart = open[0].length;
  const m = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(text.slice(fmStart));
  if (!m) return null;
  const lineStart = fmStart + m.index;
  return {
    fmStart,
    fmEnd: lineStart,                       // exclusive; the closing fence line is not YAML
    bodyStart: lineStart + m[0].length,     // first byte after the closing fence line
  };
}

/** Parse a source file into the addressable shape read()/tests use. */
function parseSource(text, path) {
  const r = frontmatterRange(text);
  if (!r) return { frontmatter: null, fmText: null, bodyStart: 0, body: text };
  return {
    frontmatter: { start: r.fmStart, end: r.fmEnd },
    fmText: text.slice(r.fmStart, r.fmEnd),
    bodyStart: r.bodyStart,
    body: text.slice(r.bodyStart),
  };
}

export default {
  id: 'astro',
  displayName: 'Astro',

  /** Which file paths this adapter will write at all. */
  canEdit(path) {
    return MD_EXT.test(String(path || '')) || MDX_EXT.test(String(path || ''));
  },

  /** Confidence 0..1 that a shallow file listing is an Astro repo (§7.1). */
  detect(files) {
    return detectScore('astro', files);
  },

  /**
   * Which source file(s) could have produced this URL, best guess first.
   * Informational in v1 — provenance attributes carry the real file per field.
   */
  mapRoute(pathname) {
    let p = String(pathname || '/').replace(/^\/+/, '').replace(/\/+$/, '');
    if (p === '') p = 'index';
    const base = `src/pages/${p}`;
    return [`${base}.astro`, `${base}.md`, `${base}/index.astro`, `${base}/index.md`];
  },

  /** Parse a source file into an addressable tree. */
  parse(text, path) {
    return parseSource(String(text), path);
  },

  /** Read one pointer's current value (editor prefill, tests). */
  read(parsed, pointer) {
    const segs = Array.isArray(pointer) ? pointer : parsePointer(String(pointer));
    if (!segs || !segs.length) return undefined;
    if (segs[0] === 'body' && segs.length === 1) return parsed.body;
    if (segs[0] === 'frontmatter' && segs.length > 1 && parsed.fmText != null) {
      return readValue(parsed.fmText, segs.slice(1));
    }
    return undefined;
  },

  /**
   * Apply edits and re-serialise. Mirrors engine.applyEdits()'s contract:
   *   edits: [{ pointer: '/frontmatter/title', value, type?, key? }]
   *   returns { content, applied: [key], skipped: [{ key, reason }] }
   * Never throws on a bad pointer — skips it with a reason (§8.1). A file this
   * adapter cannot parse is never written.
   */
  applyEdits(text, edits, path) {
    const raw = String(text);
    const applied = [];
    const skipped = [];
    const fmEdits = [];
    let bodyEdit = null;

    const mdx = MDX_EXT.test(String(path || ''));
    if (!this.canEdit(path)) {
      return { content: raw, applied: [], skipped: (edits || []).map(e => ({ key: e.key ?? e.pointer, reason: 'file type not editable by this adapter' })) };
    }

    for (const e of edits || []) {
      const key = e.key ?? e.pointer;
      const segs = parsePointer(String(e.pointer || ''));
      if (!segs || !segs.length) { skipped.push({ key, reason: 'malformed pointer' }); continue; }
      if (segs[0] === 'frontmatter' && segs.length > 1) {
        fmEdits.push({ key, segs: segs.slice(1), value: e.value, type: e.type });
      } else if (segs[0] === 'body' && segs.length === 1) {
        if (mdx) { skipped.push({ key, reason: 'MDX body is code — edit frontmatter fields only' }); continue; }
        if (bodyEdit) { skipped.push({ key, reason: `duplicate pointer of "${bodyEdit.key}"` }); continue; }
        if (typeof e.value !== 'string') { skipped.push({ key, reason: 'body must be text' }); continue; }
        bodyEdit = { key, value: e.value };
      } else {
        skipped.push({ key, reason: 'unsupported pointer root' });
      }
    }

    const src = parseSource(raw, path);
    let out = raw;

    if (fmEdits.length) {
      if (!src.frontmatter) {
        for (const e of fmEdits) skipped.push({ key: e.key, reason: 'file has no frontmatter' });
      } else {
        const r = applyYamlEdits(src.fmText, fmEdits);
        skipped.push(...r.skipped);
        if (r.text !== null && r.applied.length) {
          out = out.slice(0, src.frontmatter.start) + r.text + out.slice(src.frontmatter.end);
          applied.push(...r.applied);
        }
      }
    }

    if (bodyEdit) {
      // Recompute the body offset against the (possibly re-spliced) text.
      const now = parseSource(out, path);
      const start = now.bodyStart;
      // Preserve the file's final-newline convention.
      const hadFinalNl = /\r?\n$/.test(out) || out.length === start;
      let v = bodyEdit.value;
      if (hadFinalNl && !/\n$/.test(v)) v += '\n';
      out = out.slice(0, start) + v;
      applied.push(bodyEdit.key);
    }

    return { content: out, applied, skipped };
  },

  /** Cheap pre-commit validation (§9). Returns null, or a plain reason. */
  validate(text, path) {
    const src = parseSource(String(text), path);
    if (src.frontmatter) {
      const bad = validateYaml(src.fmText);
      if (bad) return 'frontmatter is not valid YAML: ' + bad;
    }
    return null;
  },

  /** What Kiln should tell the host / the wizard should verify (§15). */
  buildHints() {
    return { framework: 'Astro', buildCommand: 'astro build', minNodeVersion: 18, outputDir: 'dist' };
  },

  /** Paths an editor may never reach, beyond the global refusal list (§8.4). */
  sensitivePaths() {
    return ['.kiln/', 'astro.config.mjs', 'astro.config.js', 'astro.config.ts', 'src/content.config.ts', 'src/content/config.ts'];
  },
};
