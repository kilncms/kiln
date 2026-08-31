/**
 * Source-mode provenance references (SOURCE-MODE-SPEC §4.3).
 *
 * A rendered element names its backing value with one attribute:
 *
 *   <h3 data-kiln-source="src/content/events/service.md#/frontmatter/title">
 *
 * NOTE — deviation from the spec's draft attribute name: the spec proposed
 * `data-kiln-src`, but that name already ships as the editor's TRANSIENT
 * staged-image marker (an <img> awaiting upload carries its future path in
 * data-kiln-src until publish resolves it into src). Reusing it would make the
 * image machinery mangle provenance and vice versa, so provenance is
 * `data-kiln-source`. Same format, same rules, different name.
 *
 * Format:  <repo-relative-path>#<RFC 6901 JSON Pointer>[?type=<field-type>]
 *
 * The attribute is served from a public page and must be treated as
 * attacker-controlled: parseSourceRef validates the path shape here, BEFORE
 * anything touches the commit proxy (spec §14), and the worker re-validates.
 */

export const SOURCE_ATTR = 'data-kiln-source';

const FIELD_TYPES = new Set(['string', 'text', 'markdown', 'date', 'time',
  'enum', 'boolean', 'number', 'url', 'image']);

/** RFC 6901: '/a/b~1c/0' → ['a', 'b/c', '0']. Returns null on malformed input. */
export function parsePointer(pointer) {
  if (typeof pointer !== 'string' || pointer === '' || pointer[0] !== '/') return null;
  const segs = pointer.split('/').slice(1).map(s => {
    // ~ must only appear as ~0 or ~1 (an unescaped trailing ~ is malformed).
    if (/~(?![01])/.test(s)) return null;
    return s.replaceAll('~1', '/').replaceAll('~0', '~');
  });
  if (segs.some(s => s === null)) return null;
  return segs;
}

/** ['a','b/c'] → '/a/b~1c' */
export function formatPointer(segs) {
  return '/' + segs.map(s => String(s).replaceAll('~', '~0').replaceAll('/', '~1')).join('/');
}

/**
 * Validate a repo-relative source path from a provenance attribute.
 * Returns the normalized path, or null if it is not safe to use.
 */
export function safeSourcePath(path) {
  if (typeof path !== 'string') return null;
  let p = path.trim();
  if (p.startsWith('./')) p = p.slice(2);
  if (p === '' || p.length > 512) return null;
  // Absolute paths, backslashes, control chars, URL schemes, traversal: out.
  if (p.startsWith('/') || p.includes('\\') || /[\u0000-\u001f\u007f]/.test(p)) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(p)) return null;
  const segs = p.split('/');
  if (segs.some(s => s === '' || s === '.' || s === '..')) return null;
  return p;
}

/**
 * Parse a full provenance reference: 'path#/pointer?type=date'.
 * Returns { path, pointer: string[], rawPointer, type } or null.
 * Never throws — a malformed attribute makes the field non-editable (§8.1).
 */
export function parseSourceRef(ref) {
  if (typeof ref !== 'string' || ref.length > 1024) return null;
  const hash = ref.indexOf('#');
  if (hash <= 0) return null;
  const path = safeSourcePath(ref.slice(0, hash));
  if (!path) return null;
  let frag = ref.slice(hash + 1);
  let type;
  const q = frag.indexOf('?');
  if (q !== -1) {
    const query = frag.slice(q + 1);
    frag = frag.slice(0, q);
    const m = /(?:^|&)type=([a-z]+)/.exec(query);
    if (m && FIELD_TYPES.has(m[1])) type = m[1];
  }
  const pointer = parsePointer(frag);
  if (!pointer || pointer.length === 0) return null;
  return { path, pointer, rawPointer: frag, type };
}
