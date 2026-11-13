/**
 * Adding Kiln to a site's repository, from the dashboard.
 *
 * What the setup tool does in a terminal for a site whose pages are plain
 * files, done by the service through the GitHub App instead, so that nobody
 * needs a terminal: the editor's three files, the settings file, the /kiln
 * sign-in page, the security headers file, and the two script tags before
 * </body> on every page. It is one commit on the repository's default branch,
 * in the name of the person who asked for it.
 *
 * A site may keep page templates in a _templates folder, from which the
 * editor's "New post or page" makes each new page. A template that is a whole
 * page gets the same two lines in the same commit, or every page made from it
 * would have no editor. A template that is a piece of a page (a post card) is
 * never touched. Templates are counted and named apart from pages.
 *
 * Only what is missing is added. A file that is already in the repository is
 * never replaced (bringing the editor up to date is `kiln update`'s job), and
 * a page that already loads the editor is not touched. So asking twice changes
 * nothing the second time, and asking again after adding a page adds the two
 * lines to that page alone.
 *
 * A site that a generator builds (Astro, Eleventy, Hugo, Jekyll) is refused
 * with the reason: its pages are made from other files, and where Kiln's
 * files go depends on the build. The setup tool handles those.
 *
 *   planPrepare   reads the repository and says what would change; writes nothing
 *   applyPrepare  makes that change
 *   publicPlan    the part of a plan the dashboard is shown
 *
 * The routes are in cloud.js (GET and POST /cloud/sites/prepare).
 */

import { detectGenerators } from '../src/adapters/detect.js';

const GH = 'https://api.github.com';
const UA = 'kiln-cloud';

/** Where the editor's files are fetched from: what production runs (ENVIRONMENTS.md, "The release branch"). */
export const RELEASE_BASE = 'https://raw.githubusercontent.com/kilncms/kiln/release';
export const SETUP_COMMAND = 'npx github:kilncms/kiln#release';
export const MAX_PAGES = 400;                 // more pages than this is the setup tool's job
const MAX_PAGE_BYTES = 2 * 1024 * 1024;       // a page larger than this is left alone and named
const TREE_BATCH_BYTES = 1024 * 1024;         // text sent to GitHub in one request, at most
const AT_ONCE = 6;                            // a Worker waits on six connections at a time

// The same two lines, the same folders and the same sign-in page as the setup
// tool (cli/index.mjs: KILN_TAGS, sitePages, wireSite). test/cloud-prepare.test.js
// holds the two to each other.
export const KILN_TAGS = ['<script src="/assets/kiln-config.js"></script>', '<script src="/assets/kiln.js" defer></script>'];
const LOADS_KILN = /<script\b[^>]*\bsrc=["'][^"']*\bkiln\.js(?:\?[^"']*)?["']/i;
const SKIP_DIRS = new Set(['node_modules', '_templates', 'dist', '_site']);
// Build and host folders whose names are also ordinary words in a site's
// addresses (/lists/public/, /brand/assets/): left out only as the first
// folder of a path. Deeper down they are folders of pages.
const SKIP_TOP_DIRS = new Set(['functions', 'assets', 'build', 'public', 'out']);
const OWN_PAGES = new Set(['kiln.html', 'members-login.html']);

export const EDITOR_FILES = [
  ['assets/kiln.js', 'dist/kiln.js'],
  ['assets/kiln-editor.js', 'dist/kiln-editor.js'],
  ['assets/kiln-features.js', 'dist/kiln-features.js'],
];
const HEADERS_FILE = ['_headers', 'templates/_headers'];
const CONFIG_FILE = 'assets/kiln-config.js';
const SIGN_IN_PAGE = 'kiln.html';

// A site Astro builds, done the way the setup tool does it (cli/index.mjs:
// ASTRO_TAGS, astroShells, generatorPublicDir). Astro bundles any script it
// can read; `is:inline` tells it these two are files served as they are.
// Kiln's files go in the folder Astro copies into the built site as it is, and
// the helper a developer marks each value with goes beside the site's code.
export const ASTRO_TAGS = KILN_TAGS.map(t => t.replace('<script ', '<script is:inline '));
export const ASTRO_HELPER = ['src/lib/kiln-astro.mjs', 'integrations/astro/index.mjs'];
export const ASTRO_GUIDE = 'https://kilncms.com/docs';
export const MAX_ASTRO_FILES = 400;           // more .astro files than this is the setup tool's job
const ASTRO_SETTINGS = /^astro\.config\.(mjs|js|cjs|ts|mts)$/i;

/**
 * Kiln's own files in a site, each with the place it goes. `astro` is an
 * Astro plan's `astro` ({ publicDir }); with none, the places of a plain site.
 */
function ownFiles(astro) {
  const at = astro ? `${astro.publicDir}/` : '';
  return {
    release: [...EDITOR_FILES.map(([to, from]) => [at + to, from]), [at + HEADERS_FILE[0], HEADERS_FILE[1]], ...(astro ? [ASTRO_HELPER] : [])],
    config: at + CONFIG_FILE,
    signIn: at + SIGN_IN_PAGE,
    headers: at + HEADERS_FILE[0],
  };
}

export const KILN_PAGE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Sign in · Kiln</title>
</head><body>
<!-- Kiln entry point. Visiting /kiln shows the sign-in; there is no edit button on the site. -->
<script src="/assets/kiln-config.js"></script>
<script src="/assets/kiln.js" defer></script>
</body></html>
`;

const quoted = (s) => `'${String(s).replace(/[\\']/g, '\\$&').replace(/[\r\n]/g, '')}'`;

/**
 * The settings file a site starts with. `siteName` is what its owner calls
 * the site, written only for a site that was given one (a site whose files
 * Kiln keeps, keeps.js); the sign-in page shows it. `preview` is the pattern
 * of the site's preview addresses on Kiln's hosting (hosting.js:
 * previewPattern), written only for a site that has one: with it the editor
 * writes a suggestion to a branch of its own and shows "Open preview".
 * `mode` and `adapter` are written for a site a generator builds ('source' and
 * 'astro'): the editor then changes the files the site is built from.
 */
export function kilnConfigFile({ repo, branch, worker, siteName = '', preview = '', mode = '', adapter = '' }) {
  return `window.KILN = {
  repo:   ${quoted(repo)},
  branch: ${quoted(branch)},
  worker: ${quoted(worker)},
${mode ? `  mode:   ${quoted(mode)},\n` : ''}${adapter ? `  adapter: ${quoted(adapter)},\n` : ''}${preview ? `  preview: ${quoted(preview)},\n` : ''}${siteName ? `  siteName: ${quoted(siteName)},\n` : ''}  styles: [],
};
`;
}

// ─── The preview line of the settings file ───────────────────────────────────
//
// On Cloudflare Pages or Netlify the owner types `preview:` into the settings
// file by hand. On Kiln's hosting Kiln writes it (lookafter.js: previewsStep),
// into a file its owner may have changed since, so one line goes in and every
// other character stays as it was.

/** A preview pattern Kiln's hosting wrote, for whichever site and service (hosting.js: previewPattern). */
const HOSTING_PREVIEW = /^https:\/\/[a-z0-9-]*pv-[a-z0-9]{8}-\{branch\}\.[^\s/]+\.workers\.dev$/i;
export const isHostingPreview = (value) => HOSTING_PREVIEW.test(String(value));

/**
 * The settings object, read as far as this file needs: every key written
 * directly in `window.KILN = { … }` ({ name, at, after, comma }: where the key
 * starts and ends, and where the comma after its value stands, or -1), the
 * places where a new line of the object may begin (`lineStarts`), and where
 * the object closes (`end`). A word in a comment, in a string or inside a
 * value's own brackets is not a key. Null when there is no such object, or it
 * never closes.
 */
function settingsKeys(src) {
  const open = /window\.KILN\s*=\s*\{/.exec(src);
  if (!open) return null;
  const keys = [], lineStarts = new Set();
  let i = open.index + open[0].length, depth = 1, wantKey = true, last = null;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { const n = src.indexOf('\n', i); i = n < 0 ? src.length : n; continue; }
    if (c === '/' && src[i + 1] === '*') { const n = src.indexOf('*/', i + 2); i = n < 0 ? src.length : n + 2; continue; }
    if (c === '\n') { if (depth === 1) lineStarts.add(i + 1); i++; continue; }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      if (depth === 1 && wantKey) { last = { name: src.slice(i + 1, j), at: i, after: j + 1, comma: -1 }; keys.push(last); wantKey = false; }
      i = j + 1; continue;
    }
    if (c === '{' || c === '[' || c === '(') { depth++; i++; continue; }
    if (c === '}' || c === ']' || c === ')') { depth--; i++; continue; }
    if (depth === 1 && c === ',') { if (last) last.comma = i; last = null; wantKey = true; i++; continue; }
    if (depth === 1 && wantKey && /[A-Za-z_$]/.test(c)) {
      const word = /^[\w$]+/.exec(src.slice(i, i + 100))[0];
      last = { name: word, at: i, after: i + word.length, comma: -1 }; keys.push(last); wantKey = false;
      i += word.length; continue;
    }
    i++;
  }
  return depth === 0 ? { keys, lineStarts, end: i - 1 } : null;
}

/**
 * The plain quoted value of one key: what it says, and where in the file the
 * words between its quotes stand. Null for any other kind of value (two
 * strings joined, a name, a call).
 */
function quotedValue(src, key, end) {
  const m = /^\s*:\s*(['"])((?:\\.|(?!\1)[^\\\r\n])*)\1/.exec(src.slice(key.after, end));
  if (!m) return null;
  const to = key.after + m[0].length - 1, from = to - m[2].length;
  if (src.slice(to + 1, key.comma < 0 ? end : key.comma).trim()) return null;
  return { value: m[2].replace(/\\(.)/g, '$1'), from, to };
}

/**
 * A settings file's text with the line that gives suggestions on a hosted
 * site a preview of their own. `pattern` is the site's (hosting.js:
 * previewPattern). Answers { state, text? }:
 *
 *   has_own   the file names previews already, and not on Kiln's hosting (its
 *             owner typed a pattern for Cloudflare Pages or Netlify): never touched
 *   same      it holds exactly this pattern already
 *   done      `text` is the file with the line: written straight after the
 *             `worker:` line when there was none, or in the place of an older
 *             pattern of Kiln's hosting (the site was moved or added again)
 *   unknown   Kiln cannot tell where the line belongs (no `worker:` line of
 *             its own in a `window.KILN = {` object): never touched
 *
 * Every other character of the file stays as it was: comments, order, quotes
 * and line endings. `preview` counts only as a property of the settings
 * object itself, with or without quotes around it; the word in a comment or
 * inside another value does not.
 */
export function withPreview(text, pattern) {
  const src = String(text ?? '');
  const want = String(pattern || '');
  if (!want || /['"`\\\r\n]/.test(want)) return { state: 'unknown' };
  const obj = settingsKeys(src);
  if (!obj) return { state: 'unknown' };

  // Where a file names previews twice, a browser goes by the last.
  const had = obj.keys.filter(k => k.name === 'preview').pop();
  if (had) {
    const v = quotedValue(src, had, obj.end);
    if (v && v.value === want) return { state: 'same' };
    if (!v || !isHostingPreview(v.value)) return { state: 'has_own' };
    return { state: 'done', text: src.slice(0, v.from) + want + src.slice(v.to) };
  }

  const worker = obj.keys.find(k => k.name === 'worker' && /^[ \t]*$/.test(src.slice(src.lastIndexOf('\n', k.at - 1) + 1, k.at)));
  if (!worker) return { state: 'unknown' };
  // The new line goes after the line `worker:` ends on, so that line has to
  // hold the whole of it, comma and all, and the object has to go on below.
  const nl = src.indexOf('\n', worker.at);
  if (nl < 0 || worker.comma < 0 || worker.comma > nl || !obj.lineStarts.has(nl + 1)) return { state: 'unknown' };
  const eol = src[nl - 1] === '\r' ? '\r\n' : '\n';
  return { state: 'done', text: `${src.slice(0, nl + 1)}  preview: ${quoted(want)},${eol}${src.slice(nl + 1)}` };
}

/** Is this path one of the site's own pages? Build folders, tool folders and Kiln's own two pages are not. */
export function isSitePage(path) {
  const parts = String(path).split('/');
  const name = parts.pop();
  if (!name.endsWith('.html') || name.startsWith('.') || OWN_PAGES.has(name)) return false;
  return !parts.some((d, i) => d.startsWith('.') || SKIP_DIRS.has(d) || (i === 0 && SKIP_TOP_DIRS.has(d)));
}

// The folder the editor's "New post or page" reads its templates from
// (src/editor/main.js: _templates/page.html, post.html, post-card.html).
const TEMPLATE_DIR = '_templates';
export const MAX_TEMPLATES = 40;              // templates beyond this many are left as they are
// What makes a template a whole page and not a piece of one. The setup tool
// has the same line (cli/index.mjs); test/cloud-templates.test.js holds the two to each other.
const WHOLE_PAGE = /<(?:html|head|body)(?:\s[^>]*)?>/i;

/** Is this path a page template: a web page file in a _templates folder, anywhere a page of the site could be? */
export function isPageTemplate(path) {
  const parts = String(path).split('/');
  const dirs = parts.slice(0, -1);
  if (!dirs.includes(TEMPLATE_DIR)) return false;
  return isSitePage([...dirs.filter(d => d !== TEMPLATE_DIR), parts[parts.length - 1]].join('/'));
}

/** Is this template a whole page (it has <html>, or a <head> or a <body>), and not a piece of one such as a post card? Comments do not count. */
export function isWholePage(html) {
  return WHOLE_PAGE.test(String(html).replace(/<!--[\s\S]*?(?:-->|$)/g, ''));
}

/**
 * A page with the two script tags before its last </body>. A page that
 * already loads kiln.js is returned as it is ('already'); one with no </body>
 * cannot be done ('no-body'). The settings tag is not repeated if it is there.
 */
export function withKilnTags(html, lines = KILN_TAGS) {
  if (LOADS_KILN.test(html)) return { html, state: 'already' };
  const at = html.toLowerCase().lastIndexOf('</body>');
  if (at === -1) return { html, state: 'no-body' };
  const nl = html.includes('\r\n') ? '\r\n' : '\n';
  const tags = lines.filter(t => !(t.includes('kiln-config.js') && /kiln-config\.js/.test(html)));
  const lineStart = html.lastIndexOf('\n', at - 1) + 1;
  const before = html.slice(lineStart, at);
  // </body> on a line of its own: the tags take that line's indentation.
  if (/^[ \t]*$/.test(before)) {
    return { html: html.slice(0, lineStart) + tags.map(t => before + t + nl).join('') + html.slice(lineStart), state: 'added' };
  }
  return { html: html.slice(0, at) + nl + tags.join(nl) + nl + html.slice(at), state: 'added' };
}

// ─── GitHub, with the App's token for this repository ─────────────────────────

export function gh(token, method, path, body, accept) {
  return fetch(`${GH}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: accept || 'application/vnd.github+json', 'User-Agent': UA, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}
export const refPath = (branch) => String(branch).split('/').map(encodeURIComponent).join('/');

/**
 * What the author's name of every commit ends with that Kiln writes for a
 * person who works in the editor ("Ana (via Kiln)"). The service writes it in
 * one spelling, from here, because a preview is only put up for a branch whose
 * new commits all carry it (hosted.js).
 */
export const VIA_KILN = ' (via Kiln)';

/** Run `fn` over `items`, a few at a time, keeping their order. */
export async function inTurn(items, fn) {
  const out = new Array(items.length);
  for (let i = 0; i < items.length; i += AT_ONCE) {
    const part = await Promise.all(items.slice(i, i + AT_ONCE).map((it, j) => fn(it, i + j)));
    part.forEach((v, j) => { out[i + j] = v; });
  }
  return out;
}

/** A file's text, exactly: null when it is not UTF-8 text (it is then left alone). */
export async function readText(token, repo, sha) {
  const r = await gh(token, 'GET', `/repos/${repo}/git/blobs/${sha}`, null, 'application/vnd.github.raw');
  if (!r.ok) return { failed: true };
  try {
    // fatal: bytes that are not UTF-8 are refused, never guessed at. ignoreBOM:
    // a byte-order mark at the top stays in the text, so it is written back.
    return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await r.arrayBuffer()) };
  } catch { return { notText: true }; }
}

/**
 * The settings file among a repository's files as GitHub lists them, or null.
 * A site a generator builds keeps it in a folder of its own (public/assets,
 * say), so the nearest file of that name is taken.
 */
export function settingsEntry(entries) {
  return (entries || [])
    .filter(e => e.type === 'blob' && (e.path === CONFIG_FILE || e.path.endsWith(`/${CONFIG_FILE}`)))
    .filter(e => !e.path.split('/').some(d => d === 'node_modules' || d.startsWith('.')))
    .sort((a, b) => a.path.length - b.path.length)[0] || null;
}

/**
 * The settings file as the repository's main branch holds it, with what a
 * commit on top of it needs: { state: 'ok', branch, head, treeSha, path, mode,
 * text }. Any other `state` says why there is none to change: 'no_access',
 * 'github', 'empty' (no files yet), 'missing' (no settings file) or 'not_text'.
 * Writes nothing.
 */
export async function readSettingsFile({ token, repo }) {
  const meta = await gh(token, 'GET', `/repos/${repo}`);
  if ([401, 403, 404].includes(meta.status)) return { state: 'no_access' };
  if (!meta.ok) return { state: 'github' };
  const branch = (await meta.json()).default_branch || 'main';
  const ref = await gh(token, 'GET', `/repos/${repo}/git/ref/heads/${refPath(branch)}`);
  if (ref.status === 404 || ref.status === 409) return { state: 'empty', branch };
  if (!ref.ok) return { state: 'github' };
  const head = (await ref.json())?.object?.sha;
  const commit = await gh(token, 'GET', `/repos/${repo}/git/commits/${head}`);
  if (!commit.ok) return { state: 'github' };
  const treeSha = (await commit.json())?.tree?.sha;
  const listing = await gh(token, 'GET', `/repos/${repo}/git/trees/${treeSha}?recursive=1`);
  if (!listing.ok) return { state: 'github' };
  const base = { branch, head, treeSha };
  const found = settingsEntry((await listing.json()).tree);
  if (!found) return { ...base, state: 'missing' };
  const file = await readText(token, repo, found.sha);
  if (file.failed) return { ...base, state: 'github' };
  if (file.notText) return { ...base, state: 'not_text' };
  return { ...base, state: 'ok', path: found.path, mode: found.mode || '100644', text: file.text };
}

/**
 * Read the repository and work out what adding Kiln would change. Writes
 * nothing. `state` says where it stands:
 *
 *   ready      there is something to add (`changes` and `files.add` say what)
 *   prepared   Kiln is already on every page and every file is there
 *   built      a generator builds this site: the setup tool's job
 *   no_pages   no pages found
 *   too_big    more pages than this adds itself to
 *   empty      the repository has no files yet
 *   no_access  the App cannot read the repository (not installed, or removed)
 *   github     GitHub did not answer
 */
/**
 * Read a repository as a site of plain pages: its default branch, the commit
 * it stands at, every file's path, and the text of every page. Used by each
 * thing the dashboard does to a site's pages (adding Kiln, the first pass at
 * what can be edited). `state` is 'ok', or why the pages were not read:
 * 'no_access', 'github', 'empty', 'built' (with `generator`), 'no_pages',
 * 'too_big' (with `pageCount`). With 'ok': `files` holds each readable page as
 * { path, mode, text }, and `skipped` the ones left alone ({ path, why }:
 * 'large', 'not_text'). `templates` holds, in the same shape, each page
 * template that is a whole page (isPageTemplate, isWholePage); a template
 * that is a piece of a page is not in it, so nothing ever changes one. Adding
 * Kiln and the character set use `templates`; the first pass at what can be
 * edited does not, because a template's words are stand-ins for a page's.
 */
export async function readPages({ token, repo }) {
  const meta = await gh(token, 'GET', `/repos/${repo}`);
  if ([401, 403, 404].includes(meta.status)) return { state: 'no_access' };
  if (!meta.ok) return { state: 'github' };
  const branch = (await meta.json()).default_branch || 'main';
  const ref = await gh(token, 'GET', `/repos/${repo}/git/ref/heads/${refPath(branch)}`);
  if (ref.status === 404 || ref.status === 409) return { state: 'empty', branch };
  if (!ref.ok) return { state: 'github' };
  const head = (await ref.json())?.object?.sha;
  const commit = await gh(token, 'GET', `/repos/${repo}/git/commits/${head}`);
  if (!commit.ok) return { state: 'github' };
  const treeSha = (await commit.json())?.tree?.sha;
  const listing = await gh(token, 'GET', `/repos/${repo}/git/trees/${treeSha}?recursive=1`);
  if (!listing.ok) return { state: 'github' };
  const tree = await listing.json();
  const entries = (tree.tree || []).filter(e => e.type === 'blob');
  const paths = entries.map(e => e.path);
  const base = { branch, head, treeSha };

  const generator = detectGenerators(paths).find(g => g.confidence >= 0.5);
  // `kind`, `entries` and `cut` are for adding Kiln to a site Astro builds (planPrepareAstro).
  if (generator) return { ...base, state: 'built', generator: generator.displayName, kind: generator.id, entries, paths, cut: !!tree.truncated };
  const pages = entries.filter(e => isSitePage(e.path)).sort((a, b) => (a.path < b.path ? -1 : 1));
  if (!pages.length) return { ...base, state: 'no_pages' };
  if (tree.truncated || pages.length > MAX_PAGES) return { ...base, state: 'too_big', pageCount: pages.length };

  // Every page is read: what it needs is in its text.
  const files = [], skipped = [];
  let unread = 0;
  const read = await inTurn(pages, (e) => (Number(e.size) > MAX_PAGE_BYTES ? { tooLarge: true } : readText(token, repo, e.sha)));
  pages.forEach((e, i) => {
    const r = read[i];
    if (r.failed) unread++;
    else if (r.tooLarge) skipped.push({ path: e.path, why: 'large' });
    else if (r.notText) skipped.push({ path: e.path, why: 'not_text' });
    else files.push({ path: e.path, mode: e.mode || '100644', text: r.text });
  });
  // A page GitHub would not hand over might be one that needs changing:
  // saying "all done" or writing the rest would both be wrong.
  if (unread) return { state: 'github' };

  // Page templates: read like pages, and only the whole pages among them are
  // handed on. One that is too large or is not text is left as it is.
  const templates = [];
  const drafts = entries.filter(e => isPageTemplate(e.path)).sort((a, b) => (a.path < b.path ? -1 : 1)).slice(0, MAX_TEMPLATES);
  const drawn = await inTurn(drafts, (e) => (Number(e.size) > MAX_PAGE_BYTES ? { tooLarge: true } : readText(token, repo, e.sha)));
  if (drawn.some(r => r.failed)) return { state: 'github' };
  drafts.forEach((e, i) => {
    const r = drawn[i];
    if (typeof r.text === 'string' && isWholePage(r.text)) templates.push({ path: e.path, mode: e.mode || '100644', text: r.text });
  });
  return { ...base, state: 'ok', entries, paths, total: pages.length, files, skipped, templates };
}

export async function planPrepare({ token, repo, worker, read = null, astro = true }) {
  // `read` is what readPages answered, when the caller has read the pages already.
  const site = read || await readPages({ token, repo });
  // A site Astro builds is added to in its own way. Any other generator is the
  // setup tool's job. `astro: false` is for a caller that only asks about a
  // site's own pages (sitecheck.js): it is told 'built', as it always was.
  if (astro && site.state === 'built' && site.kind === 'astro' && site.entries) return planPrepareAstro({ token, repo, worker, site });
  if (site.state !== 'ok') return site;
  const { entries, paths } = site;
  const base = { branch: site.branch, head: site.head, treeSha: site.treeSha };
  const pages = { length: site.total };
  const changes = [], skipped = [...site.skipped];
  let already = 0;
  for (const f of site.files) {
    const done = withKilnTags(f.text);
    if (done.state === 'already') already++;
    else if (done.state === 'no-body') skipped.push({ path: f.path, why: 'no_body' });
    else changes.push({ path: f.path, mode: f.mode, text: done.html });
  }
  skipped.sort((x, y) => (x.path < y.path ? -1 : 1));

  // Page templates that are whole pages: the same two lines, kept apart from
  // the pages so that what is shown and said calls them what they are.
  const templates = { changes: [], already: 0, skipped: [] };
  for (const f of site.templates || []) {
    const done = withKilnTags(f.text);
    if (done.state === 'already') templates.already++;
    else if (done.state === 'no-body') templates.skipped.push({ path: f.path, why: 'no_body' });
    else templates.changes.push({ path: f.path, mode: f.mode, text: done.html });
  }

  const have = new Set(paths);
  const ours = [...EDITOR_FILES.map(([to]) => to), CONFIG_FILE, SIGN_IN_PAGE, HEADERS_FILE[0]];
  let add = ours.filter(p => !have.has(p));
  const kept = ours.filter(p => have.has(p));
  // The security headers file comes along when Kiln is added. A site that has
  // Kiln and lacks only that file is not asked for a commit for its sake: the
  // editor works without it, and only some hosts read it.
  const ready = changes.length > 0 || templates.changes.length > 0 || add.some(p => p !== HEADERS_FILE[0]);
  if (!ready) add = [];

  // Settings that were already there are the owner's. If they name another
  // sign-in service the editor will go there, so say so; change nothing.
  let otherWorker = null;
  if (have.has(CONFIG_FILE)) {
    const cfg = await readText(token, repo, entries.find(e => e.path === CONFIG_FILE).sha);
    const named = cfg.text ? cfg.text.match(/\bworker\s*:\s*['"`]([^'"`]+)['"`]/)?.[1] : null;
    const same = (a, b) => { try { return new URL(a).origin === new URL(b).origin; } catch { return a === b; } };
    if (named && worker && !same(named, worker)) otherWorker = named;
  }

  return {
    ...base,
    state: ready ? 'ready' : 'prepared',
    pages: { total: pages.length, already, skipped },
    changes,
    templates,
    files: { add, kept },
    otherWorker,
  };
}

/**
 * What adding Kiln would change in a repository Astro builds, from what
 * readPages answered about it. Writes nothing. Kiln's files go in the public
 * folder, the helper in src/lib, and the two lines in every .astro file under
 * src/ that closes <body> (a layout, as a rule). Astro's own settings file is
 * read and never written. `state` is 'ready' or 'prepared' as for a plain
 * site, or why nothing can be added from here:
 *
 *   astro_no_layout  no .astro file under src/ closes <body>
 *   astro_unusual    the settings name a base, a source folder, a build folder
 *                    or a public folder that is not a plain name; or there are
 *                    more .astro files than this reads
 *   github           GitHub did not answer
 */
export async function planPrepareAstro({ token, repo, worker, site }) {
  const { entries } = site;
  const base = { branch: site.branch, head: site.head, treeSha: site.treeSha, generator: site.generator };
  const stop = (state) => ({ ...base, state });

  let publicDir = 'public';
  const settings = entries.find(e => ASTRO_SETTINGS.test(e.path));
  if (settings) {
    const file = Number(settings.size) > MAX_PAGE_BYTES ? { notText: true } : await readText(token, repo, settings.sha);
    if (file.failed) return { state: 'github' };
    if (typeof file.text !== 'string') return stop('astro_unusual');
    // Comments are left out, so a setting that is only talked about does not count.
    const src = file.text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    if (/\b(?:base|srcDir|outDir)\s*:/.test(src)) return stop('astro_unusual');
    if (/\bpublicDir\s*:/.test(src)) {
      const named = src.match(/\bpublicDir\s*:\s*['"`](?:\.\/)?([^'"`]+?)\/?['"`]/)?.[1];
      if (!named || !/^[\w.-]+(\/[\w.-]+)*$/.test(named) || named.split('/').some(d => d === '.' || d === '..')) return stop('astro_unusual');
      publicDir = named;
    }
  }

  const astro = entries
    .filter(e => e.path.startsWith('src/') && e.path.endsWith('.astro') && !e.path.split('/').some(d => d.startsWith('.') || d === 'node_modules'))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  if (site.cut || astro.length > MAX_ASTRO_FILES) return stop('astro_unusual');
  const read = await inTurn(astro, (e) => (Number(e.size) > MAX_PAGE_BYTES ? { tooLarge: true } : readText(token, repo, e.sha)));
  // A file GitHub would not hand over might be the layout.
  if (read.some(r => r.failed)) return { state: 'github' };
  const changes = [];
  let already = 0;
  astro.forEach((e, i) => {
    const text = read[i].text;
    if (typeof text !== 'string' || !/<\/body>/i.test(text)) return;
    const done = withKilnTags(text, ASTRO_TAGS);
    if (done.state === 'already') already++;
    else if (done.state === 'added') changes.push({ path: e.path, mode: e.mode || '100644', text: done.html });
  });
  if (!changes.length && !already) return stop('astro_no_layout');

  // Kiln's own files: only what is missing, and never in place of a file that is there.
  const own = ownFiles({ publicDir });
  const have = new Set(site.paths);
  const ours = [...EDITOR_FILES.map(([to]) => `${publicDir}/${to}`), own.config, own.signIn, own.headers, ASTRO_HELPER[0]];
  let add = ours.filter(p => !have.has(p));
  const kept = ours.filter(p => have.has(p));
  const ready = changes.length > 0 || add.some(p => p !== own.headers);
  if (!ready) add = [];

  let otherWorker = null;
  if (have.has(own.config)) {
    const cfg = await readText(token, repo, entries.find(e => e.path === own.config).sha);
    const named = cfg.text ? cfg.text.match(/\bworker\s*:\s*['"`]([^'"`]+)['"`]/)?.[1] : null;
    const same = (a, b) => { try { return new URL(a).origin === new URL(b).origin; } catch { return a === b; } };
    if (named && worker && !same(named, worker)) otherWorker = named;
  }
  return { ...base, state: ready ? 'ready' : 'prepared', astro: { publicDir, already }, changes, files: { add, kept }, otherWorker };
}

const listed = (names) => {
  const shown = names.slice(0, 12), more = names.length - shown.length;
  if (more) return `${shown.join(', ')} and ${more} more`;
  return shown.length < 3 ? shown.join(' and ') : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
};

/** What a person reads before Kiln is added to a site Astro builds: what the one change will be. */
export function astroBefore(plan) {
  const names = plan.changes.map(c => c.path), add = plan.files.add;
  const files = !add.length ? '' : add.every(p => p === ASTRO_HELPER[0]) ? 'one file of its own to the src folder' : `its own files to the ${plan.astro.publicDir} folder`;
  const lines = !names.length ? '' : names.length === 1 ? `two lines to your layout file, ${names[0]}` : `two lines to each of your ${names.length} layout files, ${listed(names)}`;
  return `Astro builds this site. Kiln will add ${[files, lines].filter(Boolean).join(' and ')}. Your pages and your words stay as they are. Press Add Kiln to make this change.`;
}

/**
 * What a person reads once Kiln is in a repository Astro builds. On a host of
 * their own the push starts a build; on Kiln's hosting nothing builds an Astro
 * site yet, so nothing is said of one. Marking what can be edited is by hand
 * for now, and the guide at ASTRO_GUIDE shows it.
 */
export function astroAfter({ hosted = false } = {}) {
  return [
    hosted ? 'Kiln is in your repository.' : 'Kiln is in your repository. Your host is building the site again, which usually takes a minute or two. Then open your site\'s address with /kiln at the end and sign in.',
    'Nothing on your pages can be edited yet. The person who built the site adds one line for each part you want to edit, and the setup guide shows how.',
  ];
}

/** What the dashboard is shown of a plan: counts and names, never a page's text. */
export function publicPlan(plan, { repo } = {}) {
  const out = { state: plan.state, repo, branch: plan.branch || null };
  if (plan.generator) out.generator = plan.generator;
  if (plan.pageCount) out.page_count = plan.pageCount;
  if (plan.astro) {
    // A site Astro builds: the layout files by name, and the sentence that says
    // what the change will be. `pages` is there, empty, for a dashboard that
    // was loaded before it knew of `astro`.
    out.astro = {
      public_dir: plan.astro.publicDir,
      layouts: { already: plan.astro.already, add: plan.changes.length, add_names: plan.changes.slice(0, 12).map(c => c.path) },
      ...(plan.state === 'ready' ? { before: astroBefore(plan) } : {}),
    };
    out.pages = { total: 0, already: 0, add: 0, add_names: [], skipped: [], skipped_count: 0 };
    out.files = plan.files;
    if (plan.otherWorker) out.other_worker = plan.otherWorker;
    return out;
  }
  if (plan.pages) {
    out.pages = {
      total: plan.pages.total,
      already: plan.pages.already,
      add: plan.changes.length,
      add_names: plan.changes.slice(0, 12).map(c => c.path),
      skipped: plan.pages.skipped.slice(0, 20),
      skipped_count: plan.pages.skipped.length,
    };
    // Page templates, named as templates, and only when the site has any.
    const t = plan.templates;
    if (t && (t.changes.length || t.already || t.skipped.length)) {
      out.templates = { already: t.already, add: t.changes.length, add_names: t.changes.slice(0, 12).map(c => c.path), skipped: t.skipped.slice(0, 20) };
    }
    out.files = plan.files;
    if (plan.otherWorker) out.other_worker = plan.otherWorker;
  }
  return out;
}

export class PrepareError extends Error {
  constructor(code, detail = '') { super(code); this.code = code; this.detail = String(detail).slice(0, 200); }
}

export function base64(buf) {
  const u = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function must(res, code) {
  if (res.ok) return res.json();
  let detail = '';
  try { detail = (await res.json())?.message || ''; } catch { /* no body */ }
  throw new PrepareError(code, `${res.status} ${detail}`);
}

/**
 * Make the change a `ready` plan describes: one commit on top of the commit
 * the plan read, moved onto the branch only if the branch is still there. A
 * repository that changed meanwhile, or a branch that takes no direct change,
 * leaves everything as it was and says so (PrepareError: code).
 *
 *   release   Kiln's own files could not be fetched
 *   moved     the repository changed while this was working
 *   protected the branch does not take a direct change
 *   github    anything else GitHub refused
 */
export async function applyPrepare({ token, repo, worker, plan, author, releaseBase = RELEASE_BASE }) {
  const wanted = new Set(plan.files.add);
  const entries = [];

  // Kiln's own files, byte for byte as released.
  const own = ownFiles(plan.astro);
  const fromRelease = own.release.filter(([to]) => wanted.has(to));
  const fetched = await inTurn(fromRelease, async ([to, from]) => {
    let r;
    try { r = await fetch(`${String(releaseBase).replace(/\/+$/, '')}/${from}`, { headers: { 'User-Agent': UA } }); } catch (e) { throw new PrepareError('release', `${from}: ${e?.message || e}`); }
    if (!r.ok) throw new PrepareError('release', `${from}: ${r.status}`);
    const bytes = await r.arrayBuffer();
    if (!bytes.byteLength) throw new PrepareError('release', `${from}: empty`);
    return { to, bytes };
  });
  for (const f of fetched) {
    const blob = await must(await gh(token, 'POST', `/repos/${repo}/git/blobs`, { content: base64(f.bytes), encoding: 'base64' }), 'github');
    entries.push({ path: f.to, mode: '100644', type: 'blob', sha: blob.sha });
  }

  // The site's own settings, the sign-in page, and each page with its two lines.
  const texts = [];
  if (wanted.has(own.config)) texts.push({ path: own.config, mode: '100644', text: kilnConfigFile({ repo, branch: plan.branch, worker, ...(plan.astro ? { mode: 'source', adapter: 'astro' } : {}) }) });
  if (wanted.has(own.signIn)) texts.push({ path: own.signIn, mode: '100644', text: KILN_PAGE });
  const templates = plan.templates?.changes || [];
  texts.push(...plan.changes, ...templates);

  const n = plan.changes.length, t = templates.length;
  const message = plan.astro
    ? `Add Kiln to this site\n\n${n ? `${n} layout file${n === 1 ? ' now loads' : 's now load'} the editor, so every page built from ${n === 1 ? 'it' : 'them'} does too. ` : ''}Added from the Kiln dashboard by ${author.name}.`
    : `Add Kiln to this site\n\n${n ? `${n} page${n === 1 ? ' now loads' : 's now load'} the editor. ` : ''}`
    + `${t ? `${t} page template${t === 1 ? ' now loads' : 's now load'} the editor too, so a new page made from ${t === 1 ? 'it' : 'one'} can be edited. ` : ''}Added from the Kiln dashboard by ${author.name}.`;
  const commit = await commitChange({ token, repo, branch: plan.branch, head: plan.head, treeSha: plan.treeSha, entries, texts, message, author });
  // On a site Astro builds the two lines went into layout files, not pages.
  return { ...commit, pages: plan.astro ? 0 : n, templates: t, files: [...wanted], ...(plan.astro ? { layouts: n } : {}) };
}

/**
 * One commit on top of `head`, moved onto `branch` only if the branch is still
 * there: `entries` are files already stored at GitHub ({ path, mode, type,
 * sha }), `texts` are files given as text ({ path, mode, text }). A repository
 * that changed meanwhile, or a branch that takes no direct change, leaves
 * everything as it was (PrepareError: 'moved', 'protected', or 'github').
 * With no `author` the commit names nobody, and GitHub records it as made by
 * the Kiln app.
 */
export async function commitChange({ token, repo, branch, head, treeSha, entries = [], texts = [], message, author }) {
  // Trees are built one on the other, about a megabyte of text at a time, so
  // no single request to GitHub is large.
  const batches = [[...entries]];
  let size = 0;
  for (const t of texts) {
    const bytes = t.text.length;
    if (size && size + bytes > TREE_BATCH_BYTES) { batches.push([]); size = 0; }
    batches[batches.length - 1].push({ path: t.path, mode: t.mode, type: 'blob', content: t.text });
    size += bytes;
  }
  let tree = treeSha;
  for (const batch of batches) {
    if (!batch.length) continue;
    tree = (await must(await gh(token, 'POST', `/repos/${repo}/git/trees`, { base_tree: tree, tree: batch }), 'github')).sha;
  }
  const commit = await must(await gh(token, 'POST', `/repos/${repo}/git/commits`, { message, tree, parents: [head], ...(author ? { author: { ...author, date: new Date().toISOString() } } : {}) }), 'github');
  const moved = await gh(token, 'PATCH', `/repos/${repo}/git/refs/heads/${refPath(branch)}`, { sha: commit.sha, force: false });
  if (!moved.ok) {
    let why = '';
    try { why = (await moved.json())?.message || ''; } catch { /* no body */ }
    if (/fast.forward/i.test(why)) throw new PrepareError('moved', why);
    if (/protect|rule violation|required status|pull request/i.test(why) || moved.status === 403) throw new PrepareError('protected', why);
    throw new PrepareError('github', `${moved.status} ${why}`);
  }
  return { sha: commit.sha, url: `https://github.com/${repo}/commit/${commit.sha}` };
}

/** The sentence a person reads for each way this can end without a change. */
export function prepareSentence(code, { repo = 'the repository', generator = '', branch = 'main' } = {}) {
  switch (code) {
    case 'built': return `This site is built by ${generator || 'a site generator'} before it is published, so its pages are made from other files, and Kiln cannot add itself from here yet. Run the setup tool in the site's folder instead.`;
    case 'astro_no_layout': return 'Kiln could not find the file that ends your pages (a layout with a closing body tag) in the src folder. Nothing was changed. Ask the person who built the site to run the setup tool in the site\'s folder.';
    case 'astro_unusual': return 'This site is set up in a way Kiln does not add itself to from here yet. Nothing was changed. Ask the person who built the site to run the setup tool in the site\'s folder.';
    case 'no_pages': return `Kiln found no web pages (files ending in .html) in ${repo}. It looks at the top of the repository and in its folders, apart from build folders such as public and dist. If the site's pages are in another repository, add that one instead.`;
    case 'too_big': return `This site has more than ${MAX_PAGES} pages, which is more than Kiln adds itself to from here. Run the setup tool in the site's folder instead.`;
    case 'empty': return `${repo} has no files yet. Put the site's pages in it first, then come back.`;
    case 'no_access': return 'The Kiln app is not installed on that repository yet, or it was removed.';
    case 'release': return 'Kiln could not fetch its own editor files just now. Nothing was changed. Please try again in a minute.';
    case 'moved': return 'The repository changed while Kiln was working on it. Nothing was changed. Please press the button again.';
    case 'protected': return `The ${branch} branch of ${repo} does not take a direct change (it is protected), so Kiln could not add itself. Nothing was changed. Run the setup tool in the site's folder and merge its change the way your repository asks.`;
    case 'busy': return 'Kiln is already making this change. Give it a minute, then reload this page.';
    default: return 'GitHub did not answer just now. Nothing was changed. Please try again in a minute.';
  }
}
