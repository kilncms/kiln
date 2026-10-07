/**
 * Entries of a collection on a site a generator builds: the decisions the
 * editor makes before it asks the worker for anything.
 *
 *   collectionsOn  which collections a page shows, the folder each keeps its
 *                  files in, and their usual extension
 *   entryFileName  a new entry's file name, from its title, never one that
 *                  is taken
 *   entryForm      what the editor's own box asks for a new entry: the
 *                  fields the collection's schema requires (and the title),
 *                  each as the kind of value it is
 *   entryValues    what was typed, checked, as front matter values
 *   draftRule      how the site marks a draft (draft: true, unless the
 *                  site's config names another field)
 *   orderRule      the field the collection is ordered by, when it has one
 *   moveEntry      the order values that move one entry up or down
 *
 * Pure; main.js draws the boxes and calls the worker.
 */

import { readableName } from './names.js';
import { fieldSchema, readSchemaDoc, valueProblem, problemSentence } from './source-schema.js';

/** The words of a title, made into a file name: 'Autumn walk: the hills' → 'autumn-walk-the-hills'. */
export function entrySlug(title) {
  const s = String(title || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  return s || 'entry';
}

/** `folder/slug.ext`, or `folder/slug-2.ext` and on when a name is taken. */
export function entryFileName(title, { folder, ext = '.md', taken = new Set() } = {}) {
  const base = `${folder ? `${folder}/` : ''}${entrySlug(title)}`;
  for (let n = 1; n < 100; n++) {
    const name = `${base}${n > 1 ? `-${n}` : ''}${ext}`;
    if (!taken.has(name)) return name;
  }
  return `${base}-${Date.now().toString(36)}${ext}`;
}

/**
 * The collections a page shows entries of: Map(collection → { name, folder,
 * ext, files }). `refs` are the parsed references on the page ({ path,
 * collection }). The folder is the one the collection's files share; the
 * extension the one most of them have.
 */
export function collectionsOn(refs) {
  const by = new Map();
  for (const r of refs || []) {
    if (!r?.collection || !r.path) continue;
    if (!by.has(r.collection)) by.set(r.collection, new Set());
    by.get(r.collection).add(r.path);
  }
  const out = new Map();
  for (const [name, set] of by) {
    const files = [...set].sort();
    const dirs = files.map(f => f.split('/').slice(0, -1));
    let common = dirs[0] || [];
    for (const d of dirs) { let i = 0; while (i < common.length && common[i] === d[i]) i++; common = common.slice(0, i); }
    const exts = files.map(f => (/\.[^./]+$/.exec(f) || ['.md'])[0].toLowerCase());
    const count = (e) => exts.filter(x => x === e).length;
    const ext = [...new Set(exts)].sort((a, b) => count(b) - count(a) || a.localeCompare(b))[0] || '.md';
    out.set(name, { name, folder: common.join('/'), ext, files });
  }
  return out;
}

const KIND_OF = (node) => {
  if (!node) return null;
  if (Array.isArray(node.enum)) return 'choice';
  if (node.type === 'string') {
    if (node.format === 'date' || node.format === 'date-time') return 'date';
    if (node.format === 'uri') return 'url';
    return 'text';
  }
  if (node.type === 'number' || node.type === 'integer') return 'number';
  if (node.type === 'boolean') return 'yesno';
  if (node.type === 'array' && node.items && ['string', 'number', 'integer'].includes(node.items.type)) return 'list';
  return null;
};

/**
 * What the new-entry box asks: { fields: [{ name, label, kind, required,
 * options?, max? }], cannot: [names] }. The title comes first; then every
 * field the schema requires and gives no default for. A required field the
 * box cannot hold (a group of fields, a picture) is in `cannot`, and the box
 * says so instead of making a file the build would turn away. Without a
 * schema, the box asks for a title.
 */
export function entryForm(doc, collection, { titleField = 'title', skip = [], pictures = [] } = {}) {
  const schema = readSchemaDoc(doc) && collection && Object.hasOwn(doc.collections, collection) ? doc.collections[collection] : null;
  if (!schema || schema.type !== 'object' || !schema.properties) {
    return { fields: [{ name: titleField, label: readableName(titleField), kind: 'text', required: true }], cannot: [], schema: false };
  }
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const names = Object.keys(schema.properties).filter(n => n !== '$schema' && !skip.includes(n));
  const wanted = names.filter(n => n === titleField || (required.has(n) && fieldSchema(doc, collection, [n])?.node?.default === undefined));
  wanted.sort((a, b) => (a === titleField ? -1 : b === titleField ? 1 : names.indexOf(a) - names.indexOf(b)));
  const fields = [];
  const cannot = [];
  for (const name of wanted) {
    const f = fieldSchema(doc, collection, [name]);
    const kind = pictures.includes(name) ? null : KIND_OF(f?.node);
    if (!kind) { if (required.has(name)) cannot.push(name); continue; }
    const field = { name, label: readableName(name), kind, required: required.has(name) };
    if (kind === 'choice') field.options = f.node.enum.map(String);
    if (Number.isInteger(f.node.maxLength)) field.max = f.node.maxLength;
    fields.push(field);
  }
  return { fields, cannot, schema: true };
}

/** What the box says when the schema asks for something it cannot hold. */
export function cannotSentence(cannot) {
  const names = cannot.map(n => readableName(n).toLowerCase());
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
  return `This collection needs ${list} for every entry, which can’t be filled in here. Ask the site’s owner to add the entry.`;
}

/**
 * What was typed in the box, checked and made into front matter values:
 * { fields } or { problem: { name, sentence } } for the first that will not do.
 * `typed` is { name: string } (a yes/no is 'true' or 'false').
 */
export function entryValues(form, typed, { doc = null, collection = null } = {}) {
  const fields = {};
  for (const f of form.fields) {
    const raw = String(typed?.[f.name] ?? '').trim();
    const say = (sentence) => ({ problem: { name: f.name, sentence } });
    if (!raw) {
      if (f.required && f.kind !== 'yesno') return say(`${f.label} is needed for every entry.`);
      if (f.kind === 'yesno' && f.required) { fields[f.name] = false; }
      continue;
    }
    if (f.kind === 'date') {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
      const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
      if (!d || d.getUTCDate() !== +m[3]) return say(`${f.label} needs to be a date written like 2026-09-20.`);
      fields[f.name] = raw;
      continue;
    }
    if (f.kind === 'number') {
      if (!/^-?\d+(\.\d+)?$/.test(raw)) return say(`${f.label} needs to be a number, such as 3.`);
      fields[f.name] = Number(raw);
      continue;
    }
    if (f.kind === 'yesno') { fields[f.name] = raw === 'true'; continue; }
    if (f.kind === 'list') { fields[f.name] = raw.split(',').map(s => s.trim()).filter(Boolean); continue; }
    if (f.kind === 'choice' && !f.options.includes(raw)) return say(`${f.label} needs to be one of: ${f.options.join(', ')}.`);
    const no = valueProblem(fieldSchema(doc, collection, [f.name]), raw);
    if (no) return say(`${f.label}: ${problemSentence(no)}`);
    fields[f.name] = raw;
  }
  return { fields };
}

/**
 * How the site marks an entry as a draft: { name, value } (the field, and the
 * value that means "draft"), or null when it has no way to. `draft: true`,
 * unless the Kiln config names another field (`draftField`, and
 * `draftValue` when false means draft, as `published: false` does). Without
 * a config field, only a site whose schema (or whose entries) has a yes/no
 * `draft` field has drafts: Kiln never invents a field a site does not read.
 */
export function draftRule({ doc = null, collection = null, cfg = {}, seen = [] } = {}) {
  if (typeof cfg.draftField === 'string' && /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(cfg.draftField)) {
    return { name: cfg.draftField, value: cfg.draftValue === false ? false : true };
  }
  const f = fieldSchema(doc, collection, ['draft']);
  if (f && f.node.type === 'boolean') return { name: 'draft', value: true };
  if (!f && !readSchemaDoc(doc) && seen.includes('draft')) return { name: 'draft', value: true };
  return null;
}

/** Whether an entry with these front matter values is a draft under `rule`. */
export function isDraft(rule, fields) {
  if (!rule) return false;
  const v = fields?.[rule.name];
  return rule.value === true ? v === true : v === false;
}

const ORDER_NAMES = ['order', 'sort', 'weight', 'position', 'priority'];

/** The number field a collection is ordered by: the config's `orderField`, else one with a usual name. */
export function orderRule({ doc = null, collection = null, cfg = {}, seen = [] } = {}) {
  if (typeof cfg.orderField === 'string' && /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(cfg.orderField)) return cfg.orderField;
  for (const name of ORDER_NAMES) {
    const f = fieldSchema(doc, collection, [name]);
    if (f && (f.node.type === 'number' || f.node.type === 'integer')) return name;
  }
  if (!readSchemaDoc(doc)) return ORDER_NAMES.find(n => seen.includes(n)) || null;
  return null;
}

/**
 * Move the entry at `index` of `list` ([{ file, order }], in the order the
 * page shows them) by `step` (-1 up, +1 down): the new order values, as
 * [{ file, value }] for the entries that change. Two neighbours with distinct
 * values swap them; otherwise the list is numbered again from 1 in its new
 * order. [] when there is nowhere to go.
 */
export function moveEntry(list, index, step) {
  const to = index + step;
  if (!Array.isArray(list) || index < 0 || index >= list.length || to < 0 || to >= list.length) return [];
  const a = list[index], b = list[to];
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  if (num(a.order) !== null && num(b.order) !== null && a.order !== b.order) {
    return [{ file: a.file, value: b.order }, { file: b.file, value: a.order }];
  }
  const next = list.slice();
  next.splice(index, 1);
  next.splice(to, 0, a);
  return next.map((e, i) => ({ file: e.file, value: i + 1 })).filter((e, i) => num(next[i].order) !== e.value);
}

/** What a version of a content file was, in words: Kiln's own commit lines plainly, anyone else's as written. */
export function versionWords(what) {
  const w = String(what || '').trim();
  if (/^Kiln: update /.test(w)) return 'Changed';
  if (/^Kiln: add /.test(w)) return 'Added';
  if (/^Kiln: copy /.test(w)) return 'Made as a copy';
  if (/^Kiln: remove /.test(w)) return 'Removed';
  if (/^Kiln: revert /.test(w)) return 'Went back to an earlier version';
  if (/^Kiln: duplicate /.test(w)) return 'Copied';
  if (/^Scheduled publish: /.test(w)) return 'Published on a schedule';
  return w.replace(/ \(via Kiln\)$/, '') || 'Changed';
}
