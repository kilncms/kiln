/**
 * What the site's own schema takes, so that nothing is committed that the
 * build would turn away.
 *
 * An Astro site checks each content file against its collection's schema
 * when it builds; a field that breaks it fails the build. Astro describes
 * those schemas as JSON Schema, and the Kiln integration publishes them with
 * the site, at /kiln-schema.json:
 *
 *   { "version": 1, "collections": { "posts": { "type": "object", "properties": { … }, "required": [ … ] } } }
 *
 * The editor reads it once, and before a value is staged asks whether the
 * field takes it: the length, a full web address, an email address, one of
 * a list. A site without the file is edited as before; nothing is guessed.
 *
 * Pure functions; the editor fetches the file.
 */

/** The schema file, checked: { collections } or null. */
export function readSchemaDoc(doc) {
  if (!doc || typeof doc !== 'object' || doc.version !== 1) return null;
  const c = doc.collections;
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
  return { collections: c };
}

/** A branch that can hold a value: `.nullable()` and unions are read as their first non-null branch. */
function solid(node) {
  if (!node || typeof node !== 'object') return null;
  const alts = node.anyOf || node.oneOf;
  if (Array.isArray(alts)) {
    const real = alts.find(a => a && a.type !== 'null');
    return real ? { ...real, ...(node.default !== undefined && { default: node.default }) } : null;
  }
  return node;
}

/**
 * The schema of one front matter field: { node, required } or null when the
 * site has no schema for it. `segs` are the field's keys below the front
 * matter ('cover', or 'cta', 'href').
 */
export function fieldSchema(doc, collection, segs) {
  const d = readSchemaDoc(doc);
  if (!d || !collection || !Object.hasOwn(d.collections, collection)) return null;
  let node = solid(d.collections[collection]);
  let required = true;
  for (const seg of segs) {
    if (!node) return null;
    if (node.type === 'array') { node = solid(node.items); required = false; continue; }
    if (!node.properties || !Object.hasOwn(node.properties, seg)) return null;
    required = Array.isArray(node.required) && node.required.includes(seg);
    node = solid(node.properties[seg]);
  }
  return node ? { node, required } : null;
}

/**
 * Whether the field takes `value`: null, or { code, … } for what it needs.
 * Codes: 'required', 'too-long' { n }, 'too-short' { n }, 'full-address',
 * 'email', 'not-in-list' { list }, 'pattern'.
 */
export function valueProblem(field, value) {
  if (!field) return null;
  const { node, required } = field;
  const v = String(value ?? '');
  if (!v.trim() && required && node.default === undefined) return { code: 'required' };
  if (node.type !== 'string') return null;
  if (!v && !required) return null;
  if (Array.isArray(node.enum) && !node.enum.includes(v)) return { code: 'not-in-list', list: node.enum.map(String) };
  const n = [...v].length;
  if (Number.isInteger(node.maxLength) && n > node.maxLength) return { code: 'too-long', n: node.maxLength };
  if (Number.isInteger(node.minLength) && n < node.minLength) return { code: node.minLength === 1 ? 'required' : 'too-short', n: node.minLength };
  if (node.format === 'uri' && !/^[a-z][a-z0-9+.-]*:\S+$/i.test(v)) return { code: 'full-address' };
  if (node.format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return { code: 'email' };
  if (typeof node.pattern === 'string') {
    let re = null;
    try { re = new RegExp(node.pattern, 'u'); } catch { re = null; }
    if (re && !re.test(v)) return { code: 'pattern' };
  }
  return null;
}

/** What the person is told, as a sentence. */
export function problemSentence(p) {
  if (!p) return '';
  if (p.code === 'required') return 'The site needs this filled in, so it can’t be left empty.';
  if (p.code === 'too-long') return `The site takes at most ${p.n} characters here.`;
  if (p.code === 'too-short') return `The site needs at least ${p.n} characters here.`;
  if (p.code === 'full-address') return 'The site needs a full web address here, starting with https://.';
  if (p.code === 'email') return 'The site needs an email address here, like name@example.com.';
  if (p.code === 'not-in-list') return `The site takes one of these here: ${p.list.join(', ')}.`;
  return 'The site needs this written in a particular way. Ask the site’s owner how.';
}
