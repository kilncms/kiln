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
 * Added to astro.config.mjs as an integration, it also publishes the
 * collections' schemas with the site, at /kiln-schema.json, so the editor
 * can refuse a value the next build would turn away.
 *
 * Set KILN_DISABLE=1 in a build's environment to strip provenance from that
 * build (the helpers return {} and no schema is published), e.g. if you'd
 * rather not publish your repo's content paths on the production site.
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

/** The reference for one field: path#pointer, with its type and its collection when known; null when underivable. */
function ref(path, pointer, type, collection) {
  if (!path) return null;
  const q = [];
  if (typeof type === 'string' && /^[a-z]+$/.test(type)) q.push(`type=${type}`);
  if (typeof collection === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(collection)) q.push(`c=${collection}`);
  return `${path}#${pointer}${q.length ? `?${q.join('&')}` : ''}`;
}

/** The front matter pointer for a key or an array of keys/indexes; null when unusable. */
function fmPointer(field) {
  if (field == null || field === '') return null;
  const segs = Array.isArray(field) ? field : [field];
  if (!segs.length || segs.some(s => s == null || s === '')) return null;
  return `/frontmatter/${segs.map(esc).join('/')}`;
}

/** Build the attrs object, or {} when disabled/underivable. */
function attrs(path, pointer, type, collection) {
  const r = ref(path, pointer, type, collection);
  return r ? { [ATTR]: r } : {};
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
 *
 * A picture and a link carry a second field:
 *
 *   <img {...kilnSource(entry, 'cover', { type: 'image', alt: 'coverAlt' })} src={…} alt={entry.data.coverAlt} />
 *   <a {...kilnSource(entry, ['cta', 'label'], { href: ['cta', 'href'] })} href={entry.data.cta.href}>{entry.data.cta.label}</a>
 *
 * `opts.alt` names the field that holds the picture's description, and
 * `opts.href` the field that holds the link's address.
 * Returns {} when the entry can't be resolved or KILN_DISABLE is set.
 */
export function kilnSource(entry, field, opts = {}) {
  if (disabled()) return {};
  const pointer = fmPointer(field);
  if (!pointer) return {};
  const path = entryPath(entry);
  const collection = entry && entry.collection;
  const out = attrs(path, pointer, opts && opts.type, collection);
  if (!out[ATTR]) return {};
  const alt = opts && fmPointer(opts.alt);
  if (alt) out[`${ATTR}-alt`] = ref(path, alt, undefined, collection);
  const href = opts && fmPointer(opts.href);
  if (href) out[`${ATTR}-href`] = ref(path, href, 'url', collection);
  return out;
}

/**
 * Provenance attrs for the entry's markdown body (the whole of it):
 *
 *   <div {...kilnBody(entry)}><Content /></div>
 *
 * The body is edited with the toolbar and written back as Markdown. In .mdx
 * the prose is editable; imports, exports, components and expressions stay
 * exactly as written.
 */
export function kilnBody(entry) {
  if (disabled()) return {};
  return attrs(entryPath(entry), '/body');
}

/**
 * Marks the element that shows one entry: a card in a list, or the article
 * on the entry's own page. The editor puts the entry's own controls there
 * (copy, remove, draft, schedule, move up or down, history):
 *
 *   <li {...kilnEntry(post)}>…</li>
 */
export function kilnEntry(entry) {
  if (disabled()) return {};
  const path = entryPath(entry);
  if (!path) return {};
  const collection = entry && entry.collection;
  const c = typeof collection === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(collection) ? `?c=${collection}` : '';
  return { 'data-kiln-entry': `${path}${c}` };
}

let announced = false;

/**
 * The Astro integration. Provenance comes from the explicit helpers above;
 * the integration publishes the collections' schemas with the built site, at
 * /kiln-schema.json, as Astro itself describes them (JSON Schema, from
 * .astro/collections/). The editor reads it to refuse a value the next build
 * would turn away: one too long, an address that is not a full one, a field
 * the site requires left empty.
 *
 *   import kiln from '@kilncms/astro';
 *   export default defineConfig({ integrations: [kiln()] });
 */
export default function kiln() {
  let root = null;
  return {
    name: '@kilncms/astro',
    hooks: {
      'astro:config:setup'(ctx) {
        if (ctx && ctx.config && ctx.config.root) root = ctx.config.root;
        if (announced) return;
        announced = true;
        const log = ctx && ctx.logger && typeof ctx.logger.info === 'function'
          ? (m) => ctx.logger.info(m)
          : (m) => console.log(`[@kilncms/astro] ${m}`);
        log('Kiln provenance: use the kilnSource()/kilnBody() helpers; the collections\' schemas are published as /kiln-schema.json');
        if (disabled()) log('KILN_DISABLE is set — helpers emit no provenance in this build');
      },
      async 'astro:build:done'(ctx) {
        // Never fails a build: a site without schemas is edited as before.
        try {
          if (disabled() || !root || !ctx || !ctx.dir) return;
          const fs = await import('node:fs/promises');
          const from = new URL('.astro/collections/', root);
          const collections = {};
          for (const name of (await fs.readdir(from).catch(() => [])).sort()) {
            const m = /^([A-Za-z0-9_-]{1,64})\.schema\.json$/.exec(name);
            if (!m) continue;
            try { collections[m[1]] = JSON.parse(await fs.readFile(new URL(name, from), 'utf8')); } catch { /* left out */ }
          }
          if (!Object.keys(collections).length) return;
          await fs.writeFile(new URL('kiln-schema.json', ctx.dir), JSON.stringify({ version: 1, collections }));
        } catch (err) {
          const warn = ctx && ctx.logger && typeof ctx.logger.warn === 'function' ? (m) => ctx.logger.warn(m) : (m) => console.warn(`[@kilncms/astro] ${m}`);
          warn(`kiln-schema.json was not written: ${err && err.message ? err.message : err}`);
        }
      },
    },
  };
}
