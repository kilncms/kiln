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
const SKIP_DIRS = new Set(['node_modules', '_templates', 'functions', 'assets', 'dist', 'build', 'public', 'out', '_site']);
const OWN_PAGES = new Set(['kiln.html', 'members-login.html']);

export const EDITOR_FILES = [
  ['assets/kiln.js', 'dist/kiln.js'],
  ['assets/kiln-editor.js', 'dist/kiln-editor.js'],
  ['assets/kiln-features.js', 'dist/kiln-features.js'],
];
const HEADERS_FILE = ['_headers', 'templates/_headers'];
const CONFIG_FILE = 'assets/kiln-config.js';
const SIGN_IN_PAGE = 'kiln.html';

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

/** The settings file a site starts with. */
export function kilnConfigFile({ repo, branch, worker }) {
  return `window.KILN = {
  repo:   ${quoted(repo)},
  branch: ${quoted(branch)},
  worker: ${quoted(worker)},
  styles: [],
};
`;
}

/** Is this path one of the site's own pages? Build folders, tool folders and Kiln's own two pages are not. */
export function isSitePage(path) {
  const parts = String(path).split('/');
  const name = parts.pop();
  if (!name.endsWith('.html') || name.startsWith('.') || OWN_PAGES.has(name)) return false;
  return !parts.some(d => d.startsWith('.') || SKIP_DIRS.has(d));
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

function gh(token, method, path, body, accept) {
  return fetch(`${GH}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: accept || 'application/vnd.github+json', 'User-Agent': UA, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}
const refPath = (branch) => String(branch).split('/').map(encodeURIComponent).join('/');

/** Run `fn` over `items`, a few at a time, keeping their order. */
async function inTurn(items, fn) {
  const out = new Array(items.length);
  for (let i = 0; i < items.length; i += AT_ONCE) {
    const part = await Promise.all(items.slice(i, i + AT_ONCE).map((it, j) => fn(it, i + j)));
    part.forEach((v, j) => { out[i + j] = v; });
  }
  return out;
}

/** A file's text, exactly: null when it is not UTF-8 text (it is then left alone). */
async function readText(token, repo, sha) {
  const r = await gh(token, 'GET', `/repos/${repo}/git/blobs/${sha}`, null, 'application/vnd.github.raw');
  if (!r.ok) return { failed: true };
  try {
    // fatal: bytes that are not UTF-8 are refused, never guessed at. ignoreBOM:
    // a byte-order mark at the top stays in the text, so it is written back.
    return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await r.arrayBuffer()) };
  } catch { return { notText: true }; }
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
export async function planPrepare({ token, repo, worker }) {
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
  if (generator) return { ...base, state: 'built', generator: generator.displayName };
  const pages = entries.filter(e => isSitePage(e.path)).sort((a, b) => (a.path < b.path ? -1 : 1));
  if (!pages.length) return { ...base, state: 'no_pages' };
  if (tree.truncated || pages.length > MAX_PAGES) return { ...base, state: 'too_big', pageCount: pages.length };

  // Every page is read: whether it loads the editor already is in its text.
  const changes = [], skipped = [];
  let already = 0, unread = 0;
  const read = await inTurn(pages, (e) => (Number(e.size) > MAX_PAGE_BYTES ? { tooLarge: true } : readText(token, repo, e.sha)));
  pages.forEach((e, i) => {
    const r = read[i];
    if (r.failed) { unread++; return; }
    if (r.tooLarge) { skipped.push({ path: e.path, why: 'large' }); return; }
    if (r.notText) { skipped.push({ path: e.path, why: 'not_text' }); return; }
    const done = withKilnTags(r.text);
    if (done.state === 'already') already++;
    else if (done.state === 'no-body') skipped.push({ path: e.path, why: 'no_body' });
    else changes.push({ path: e.path, mode: e.mode || '100644', text: done.html });
  });
  // A page GitHub would not hand over might be one that needs the two lines:
  // saying "all done" or writing the rest would both be wrong.
  if (unread) return { state: 'github' };

  const have = new Set(paths);
  const ours = [...EDITOR_FILES.map(([to]) => to), CONFIG_FILE, SIGN_IN_PAGE, HEADERS_FILE[0]];
  let add = ours.filter(p => !have.has(p));
  const kept = ours.filter(p => have.has(p));
  // The security headers file comes along when Kiln is added. A site that has
  // Kiln and lacks only that file is not asked for a commit for its sake: the
  // editor works without it, and only some hosts read it.
  const ready = changes.length > 0 || add.some(p => p !== HEADERS_FILE[0]);
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
    files: { add, kept },
    otherWorker,
  };
}

/** What the dashboard is shown of a plan: counts and names, never a page's text. */
export function publicPlan(plan, { repo } = {}) {
  const out = { state: plan.state, repo, branch: plan.branch || null };
  if (plan.generator) out.generator = plan.generator;
  if (plan.pageCount) out.page_count = plan.pageCount;
  if (plan.pages) {
    out.pages = {
      total: plan.pages.total,
      already: plan.pages.already,
      add: plan.changes.length,
      add_names: plan.changes.slice(0, 12).map(c => c.path),
      skipped: plan.pages.skipped.slice(0, 20),
      skipped_count: plan.pages.skipped.length,
    };
    out.files = plan.files;
    if (plan.otherWorker) out.other_worker = plan.otherWorker;
  }
  return out;
}

export class PrepareError extends Error {
  constructor(code, detail = '') { super(code); this.code = code; this.detail = String(detail).slice(0, 200); }
}

function base64(buf) {
  const u = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}

async function must(res, code) {
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
  const fromRelease = [...EDITOR_FILES, HEADERS_FILE].filter(([to]) => wanted.has(to));
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
  if (wanted.has(CONFIG_FILE)) texts.push({ path: CONFIG_FILE, mode: '100644', text: kilnConfigFile({ repo, branch: plan.branch, worker }) });
  if (wanted.has(SIGN_IN_PAGE)) texts.push({ path: SIGN_IN_PAGE, mode: '100644', text: KILN_PAGE });
  texts.push(...plan.changes);

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
  let tree = plan.treeSha;
  for (const batch of batches) {
    if (!batch.length) continue;
    tree = (await must(await gh(token, 'POST', `/repos/${repo}/git/trees`, { base_tree: tree, tree: batch }), 'github')).sha;
  }

  const n = plan.changes.length;
  const message = `Add Kiln to this site\n\n${n ? `${n} page${n === 1 ? ' now loads' : 's now load'} the editor. ` : ''}Added from the Kiln dashboard by ${author.name}.`;
  const commit = await must(await gh(token, 'POST', `/repos/${repo}/git/commits`, { message, tree, parents: [plan.head], author: { ...author, date: new Date().toISOString() } }), 'github');

  const moved = await gh(token, 'PATCH', `/repos/${repo}/git/refs/heads/${refPath(plan.branch)}`, { sha: commit.sha, force: false });
  if (!moved.ok) {
    let why = '';
    try { why = (await moved.json())?.message || ''; } catch { /* no body */ }
    if (/fast.forward/i.test(why)) throw new PrepareError('moved', why);
    if (/protect|rule violation|required status|pull request/i.test(why) || moved.status === 403) throw new PrepareError('protected', why);
    throw new PrepareError('github', `${moved.status} ${why}`);
  }
  return { sha: commit.sha, url: `https://github.com/${repo}/commit/${commit.sha}`, pages: n, files: [...wanted] };
}

/** The sentence a person reads for each way this can end without a change. */
export function prepareSentence(code, { repo = 'the repository', generator = '', branch = 'main' } = {}) {
  switch (code) {
    case 'built': return `This site is built by ${generator || 'a site generator'} before it is published, so its pages are made from other files, and Kiln cannot add itself from here yet. Run the setup tool in the site's folder instead.`;
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
