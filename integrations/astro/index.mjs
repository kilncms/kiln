/**
 * @kilncms/astro — Kiln source-mode provenance for Astro (v1, explicit helpers).
 *
 * Kiln edits the SOURCES a generated site is built from. For that, each
 * rendered value names where it lives with one attribute:
 *
 *   <h3 data-kiln-source="src/content/events/service.md#/frontmatter/title">
 *
 * These helpers stamp that attribute — one line per field, the same mental
 * model as annotating a hand-written page with data-cms:
 *
 *   <h3 {...kilnSource(entry, 'title')}>{entry.data.title}</h3>
 *   <div {...kilnBody(entry)}><Content /></div>
 *
 * Self-contained on purpose: no imports, no Kiln internals, safe to ship in
 * any Astro project. The helpers NEVER throw — a bad entry returns {} and the
 * build goes on; the field is simply not editable.
 *
 * Set KILN_DISABLE=1 in a build's environment to strip provenance from that
 * build (the helpers return {}), e.g. if you'd rather not publish your
 * repo's content paths on the production site.
 */

const ATTR = 'data-kiln-source';

/** Provenance disabled for this build? (checked per call, not at import). */
function disabled() {
  const v = typeof process !== 'undefined' ? process.env?.KILN_DISABLE : undefined;
  return v != null && v !== '' && v !== '0' && v !== 'false';
}

/** RFC 6901 pointer-segment escape: '~' → '~0', '/' → '~1'. */
function esc(seg) {
  return String(seg).replaceAll('~', '~0').replaceAll('/', '~1');
}

/**
 * Repo-relative path of a collection entry's file, forward slashes.
 *  - Content-layer entries (Astro 5+) carry `filePath`, already root-relative.
 *  - Legacy entries fall back to `src/content/<collection>/<id>` (legacy ids
 *    include the file extension; if one doesn't, .md is assumed).
 * Returns null when no safe repo-relative path can be derived.
 */
function entryPath(entry) {
  if (!entry || typeof entry !== 'object') return null;
  let p = entry.filePath;
  if (typeof p !== 'string' || !p) {
    if (typeof entry.collection !== 'string' || !entry.collection) return null;
    const id = entry.id != null ? String(entry.id) : '';
    if (!id) return null;
    p = `src/content/${entry.collection}/${id}${/\.(md|mdx|markdown)$/i.test(id) ? '' : '.md'}`;
  }
  p = p.replaceAll('\\', '/');
  if (p.startsWith('./')) p = p.slice(2);
  if (p.startsWith('/')) {
    // Absolute path from an unusual loader — recover the repo-relative tail.
    const i = p.indexOf('/src/');
    if (i === -1) return null;
    p = p.slice(i + 1);
  }
  return p;
}

/** Build the attrs object, or {} when disabled/underivable. */
function attrs(path, pointer, type) {
  if (!path) return {};
  let ref = `${path}#${pointer}`;
  if (typeof type === 'string' && /^[a-z]+$/.test(type)) ref += `?type=${type}`;
  return { [ATTR]: ref };
}

/**
 * Provenance attrs for one frontmatter field of a collection entry.
 *
 *   <h3 {...kilnSource(entry, 'title')}>{entry.data.title}</h3>
 *   <time {...kilnSource(entry, 'date', { type: 'date' })}>{fmt(entry.data.date)}</time>
 *   <span {...kilnSource(entry, ['venue', 'name'])}>{entry.data.venue.name}</span>
 *
 * `field` is a frontmatter key, or an array of keys/indexes for nested values.
 * `opts.type` (string|text|markdown|date|time|enum|boolean|number|url|image)
 * tells the editor how to validate — otherwise it degrades to string.
 * Returns {} when the entry can't be resolved or KILN_DISABLE is set.
 */
export function kilnSource(entry, field, opts = {}) {
  if (disabled()) return {};
  if (field == null || field === '') return {};
  const segs = Array.isArray(field) ? field : [field];
  if (!segs.length || segs.some(s => s == null || s === '')) return {};
  return attrs(entryPath(entry), `/frontmatter/${segs.map(esc).join('/')}`, opts && opts.type);
}

/**
 * Provenance attrs for the entry's markdown body (the whole of it):
 *
 *   <div {...kilnBody(entry)}><Content /></div>
 *
 * Note: Kiln edits .md bodies; .mdx bodies are code and stay read-only.
 */
export function kilnBody(entry) {
  if (disabled()) return {};
  return attrs(entryPath(entry), '/body');
}

let announced = false;

/**
 * The Astro integration. In v1 it is deliberately a no-op — provenance comes
 * from the explicit helpers above — so adding it to astro.config.mjs today
 * only announces how to use them. Automatic stamping of collection fields and
 * the .kiln/schema.json export land in a later version under this same entry
 * point, which is why it exists now.
 *
 *   import kiln from '@kilncms/astro';
 *   export default defineConfig({ integrations: [kiln()] });
 */
export default function kiln() {
  return {
    name: '@kilncms/astro',
    hooks: {
      'astro:config:setup'(ctx) {
        if (announced) return;
        announced = true;
        const log = ctx && ctx.logger && typeof ctx.logger.info === 'function'
          ? (m) => ctx.logger.info(m)
          : (m) => console.log(`[@kilncms/astro] ${m}`);
        log('Kiln provenance: use the kilnSource()/kilnBody() helpers; automatic stamping and schema export land later');
        if (disabled()) log('KILN_DISABLE is set — helpers emit no provenance in this build');
      },
    },
  };
}
