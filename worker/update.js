/**
 * Bringing the editor in a site's repository up to the released one, from the
 * dashboard.
 *
 * What `kiln update` does in a terminal, done by the service through the
 * GitHub App instead, so that nobody needs a terminal: the editor's three
 * files in the site's repository are replaced with the released ones. It is
 * one commit on the repository's default branch, in the name of the person
 * who asked for it. (For a site Kiln hosts, the service does this by itself a
 * day after a release, lookafter.js: nobody asked, so that commit names no
 * person and GitHub shows it as made by the Kiln app.) A site with a members
 * area gets the current gate with it, as the terminal tool gives it.
 *
 * Only Kiln's own files are written, byte for byte as released. The site's
 * settings file, its pages and everything else stay as they are, and no
 * security headers file is added here (adding Kiln does that, prepare.js).
 *
 *   planUpdate      reads the repository and the release and says what would change; writes nothing
 *   applyUpdate     makes that change
 *   publicUpdate    the part of a plan the dashboard is shown
 *   editorStanding  which editor each site has and which is released, for /cloud/me
 *
 * The routes are in cloud.js (GET and POST /cloud/sites/update).
 *
 * KV:
 *   updlock:<site id>  '1'              one update at a time for a site (TTL 2 min)
 *   elatest            {stamp,at}       the released editor's stamp (kept 10 minutes; 5 when it could not be fetched)
 *   erepo:<repo>       {build,at}       the editor the repository held when this last read or updated it
 *   eseen:<stamp>      a time           when this service first knew of that released editor (TTL 180 days)
 */

import { RELEASE_BASE, SETUP_COMMAND, EDITOR_FILES, PrepareError, prepareSentence, gh, refPath, inTurn, readText, base64, must } from './prepare.js';

const UA = 'kiln-cloud';
export const UPDATE_COMMAND = `${SETUP_COMMAND} update`;

// A stamp names one build of the editor. dist/kiln.js starts with
// window.KILN_VERSION="<stamp>" and dist/VERSION holds the same stamp.
const STAMP = /^[\w.-]{1,40}$/;
const STAMP_IN_EDITOR = /\bKILN_VERSION\s*=\s*["']([\w.-]{1,40})["']/;
const VERSION_FILE = 'dist/VERSION';
const EDITOR = 'kiln.js';
const CONFIG = 'kiln-config.js';
/** The editor's files by name, and where each is in the release: [['kiln.js', 'dist/kiln.js'], …]. */
const EDITOR_NAMES = EDITOR_FILES.map(([to, from]) => [to.split('/').pop(), from]);

// The members gate is Kiln's code in the site's repository as well. The same
// files and the same routing rules as the terminal tool (cli/index.mjs:
// update, installRoutes). test/cloud-update.test.js holds the two to each other.
const GATE = 'functions/members/_middleware.js';
export const GATE_FILES = [
  ['functions/_kiln.js', 'templates/functions/_kiln.js'],
  ['functions/_middleware.js', 'templates/functions/_middleware.js'],
  ['functions/api/member-redeem-google.js', 'templates/functions/api/member-redeem-google.js'],
  [GATE, 'templates/functions/members/_middleware.js'],
];
const ROUTES_FILE = ['_routes.json', 'templates/_routes.json'];
export const ROUTES_WANTED = ['/members/*', '/api/member-redeem-google', '/*%*'];

const BUILD_DIRS = new Set(['dist', 'build', 'out', '_site']);
const stampIn = (text) => String(text || '').slice(0, 4000).match(STAMP_IN_EDITOR)?.[1] || null;
const sameService = (a, b) => { try { return new URL(a).origin === new URL(b).origin; } catch { return a === b; } };

/**
 * The folder that holds the site's kiln.js next to its settings file: assets/
 * on a site of plain files, <public folder>/assets/ on a site a generator
 * builds (Astro: public/assets/). '' is the top of the repository; null means
 * Kiln is not there. When a repository holds more than one such folder, the
 * site's own comes before a copy in a build folder.
 */
export function editorFolder(paths) {
  const have = new Set(paths);
  const rank = (dir) => {
    const parts = dir ? dir.split('/') : [];
    if (BUILD_DIRS.has(parts[0])) return 100 + parts.length;
    if (dir === 'assets') return 0;
    if (parts.length === 2 && parts[1] === 'assets') return 1;
    return 2 + parts.length;
  };
  const found = paths
    .filter(p => p === EDITOR || p.endsWith(`/${EDITOR}`))
    .map(p => p.slice(0, -EDITOR.length).replace(/\/$/, ''))
    .filter(dir => have.has(dir ? `${dir}/${CONFIG}` : CONFIG))
    .filter(dir => !dir.split('/').some(d => d.startsWith('.') || d === 'node_modules'))
    .sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1));
  return found.length ? found[0] : null;
}

/** The released editor's stamp, read from the release itself. Null when it cannot be had. */
async function releasedStamp(releaseBase, { waitMs = 0 } = {}) {
  try {
    const patience = waitMs && typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? { signal: AbortSignal.timeout(waitMs) } : {};
    const r = await fetch(`${String(releaseBase || RELEASE_BASE).replace(/\/+$/, '')}/${VERSION_FILE}`, { headers: { 'User-Agent': UA }, ...patience });
    if (!r.ok) return null;
    const stamp = (await r.text()).trim();
    return STAMP.test(stamp) ? stamp : null;
  } catch { return null; }
}

/**
 * Read the repository and the release and work out what an update would
 * change. Writes nothing. `state` says where it stands:
 *
 *   behind     the released editor is another one (`files` says what is replaced or added)
 *   current    the repository already holds the released editor
 *   absent     Kiln's editor is not in the repository: add Kiln first
 *   too_big    more files than GitHub lists in one answer: the terminal tool's job
 *   no_access  the App cannot read the repository (not installed, or removed)
 *   release    the release could not be read
 *   github     GitHub did not answer
 */
export async function planUpdate({ token, repo, worker, releaseBase = RELEASE_BASE }) {
  const meta = await gh(token, 'GET', `/repos/${repo}`);
  if ([401, 403, 404].includes(meta.status)) return { state: 'no_access' };
  if (!meta.ok) return { state: 'github' };
  const branch = (await meta.json()).default_branch || 'main';
  const ref = await gh(token, 'GET', `/repos/${repo}/git/ref/heads/${refPath(branch)}`);
  if (ref.status === 404 || ref.status === 409) return { state: 'absent', branch };
  if (!ref.ok) return { state: 'github' };
  const head = (await ref.json())?.object?.sha;
  const commit = await gh(token, 'GET', `/repos/${repo}/git/commits/${head}`);
  if (!commit.ok) return { state: 'github' };
  const treeSha = (await commit.json())?.tree?.sha;
  const listing = await gh(token, 'GET', `/repos/${repo}/git/trees/${treeSha}?recursive=1`);
  if (!listing.ok) return { state: 'github' };
  const tree = await listing.json();
  const base = { branch, head, treeSha };
  // A list GitHub cut short might be missing the very files this looks for.
  if (tree.truncated) return { ...base, state: 'too_big' };
  const entries = new Map((tree.tree || []).filter(e => e.type === 'blob').map(e => [e.path, e]));

  const dir = editorFolder([...entries.keys()]);
  if (dir === null) return { ...base, state: 'absent' };
  const at = (name) => (dir ? `${dir}/${name}` : name);

  // Which editor the repository holds is written at the top of its kiln.js.
  // One with no stamp there is older than the stamp, so it is behind.
  const mine = await readText(token, repo, entries.get(at(EDITOR)).sha);
  if (mine.failed) return { state: 'github' };
  const installed = stampIn(mine.text);
  const latest = await releasedStamp(releaseBase);
  if (!latest) return { ...base, state: 'release', dir, installed };
  if (installed === latest) return { ...base, state: 'current', dir, installed, latest };

  const files = EDITOR_NAMES.map(([name, from]) => ({ path: at(name), from }));

  // A site with a members area gets the current gate too, but only when its
  // settings name this service, which answers the gate's question. Against
  // another service, which may be older, the new gate could lock members out,
  // so there it is left alone and the dashboard says so.
  let gate = null, routesMissing = null, otherWorker = null;
  if (entries.has(GATE)) {
    const cfg = await readText(token, repo, entries.get(at(CONFIG)).sha);
    if (cfg.failed) return { state: 'github' };
    const named = cfg.text ? cfg.text.match(/\bworker\s*:\s*['"`]([^'"`]+)['"`]/)?.[1] : null;
    if (named && worker && sameService(named, worker)) {
      gate = 'refresh';
      files.push(...GATE_FILES.map(([path, from]) => ({ path, from })));
      // The routing file is added when there is none. One that is there is the
      // owner's: it is left alone, and any rule it lacks is named.
      if (!entries.has(ROUTES_FILE[0])) files.push({ path: ROUTES_FILE[0], from: ROUTES_FILE[1] });
      else {
        const routes = await readText(token, repo, entries.get(ROUTES_FILE[0]).sha);
        if (routes.failed) return { state: 'github' };
        let have = [];
        try { have = JSON.parse(routes.text).include || []; } catch { /* unreadable: every rule is named */ }
        const missing = ROUTES_WANTED.filter(r => !have.includes(r));
        if (missing.length) routesMissing = missing;
      }
    } else {
      gate = 'left';
      otherWorker = named || null;
    }
  }
  for (const f of files) {
    const e = entries.get(f.path);
    f.had = e?.sha || null;
    f.mode = e?.mode === '100755' ? '100755' : '100644';
  }
  return { ...base, state: 'behind', dir, installed, latest, files, gate, routesMissing, otherWorker };
}

/** What the dashboard is shown of a plan: names and stamps. */
export function publicUpdate(plan, { repo } = {}) {
  const out = { state: plan.state, repo, branch: plan.branch || null };
  if (plan.dir !== undefined) out.folder = plan.dir;
  if (plan.installed !== undefined) out.installed = plan.installed;
  if (plan.latest) out.latest = plan.latest;
  if (plan.files) {
    out.files = { replace: plan.files.filter(f => f.had).map(f => f.path), add: plan.files.filter(f => !f.had).map(f => f.path) };
    if (plan.gate) out.members_gate = plan.gate;
    if (plan.routesMissing) out.routes_missing = plan.routesMissing;
    if (plan.otherWorker) out.other_worker = plan.otherWorker;
  }
  return out;
}

/**
 * Make the change a `behind` plan describes: one commit on top of the commit
 * the plan read, moved onto the branch only if the branch is still there.
 * Every released file is in hand before anything is written. A repository
 * that changed meanwhile, or a branch that takes no direct change, leaves
 * everything as it was and says so (PrepareError: code, as in prepare.js).
 *
 *   release   Kiln's own files could not be fetched, or are not the release the plan read
 *   moved     the repository changed while this was working
 *   protected the branch does not take a direct change
 *   github    anything else GitHub refused
 */
export async function applyUpdate({ token, repo, plan, author, releaseBase = RELEASE_BASE }) {
  const root = String(releaseBase || RELEASE_BASE).replace(/\/+$/, '');
  const fetched = await inTurn(plan.files, async (f) => {
    let r;
    try { r = await fetch(`${root}/${f.from}`, { headers: { 'User-Agent': UA } }); } catch (e) { throw new PrepareError('release', `${f.from}: ${e?.message || e}`); }
    if (!r.ok) throw new PrepareError('release', `${f.from}: ${r.status}`);
    const bytes = await r.arrayBuffer();
    if (!bytes.byteLength) throw new PrepareError('release', `${f.from}: empty`);
    return { ...f, bytes };
  });
  // A release can come out between reading its stamp and fetching its files.
  // The editor that is written is the one the person was shown, or nothing is.
  const editor = fetched.find(f => f.from === EDITOR_NAMES[0][1]);
  const got = stampIn(new TextDecoder().decode(new Uint8Array(editor.bytes).subarray(0, 4000)));
  if (got !== plan.latest) throw new PrepareError('release', `${editor.from} is ${got || 'unstamped'}, ${VERSION_FILE} said ${plan.latest}`);

  // Kiln's own files, byte for byte as released. One that is already the
  // released file is not in the change.
  const entries = [];
  for (const f of fetched) {
    const blob = await must(await gh(token, 'POST', `/repos/${repo}/git/blobs`, { content: base64(f.bytes), encoding: 'base64' }), 'github');
    if (blob.sha !== f.had) entries.push({ path: f.path, mode: f.mode, type: 'blob', sha: blob.sha });
  }
  const tree = (await must(await gh(token, 'POST', `/repos/${repo}/git/trees`, { base_tree: plan.treeSha, tree: entries }), 'github')).sha;

  // With no `author` the commit names nobody: GitHub then records it as made
  // by the app whose token this is, which is the truth when the service
  // updates a site it hosts by itself.
  const message = `Update the Kiln editor\n\nThe editor's files are now version ${plan.latest}${plan.installed ? ` (they were version ${plan.installed})` : ''}. `
    + `${plan.gate === 'refresh' ? 'The files that guard the members area are the current ones too. ' : ''}`
    + (author ? `Updated from the Kiln dashboard by ${author.name}.` : 'Updated by Kiln itself, which keeps the editor current on a site it hosts.');
  const commit = await must(await gh(token, 'POST', `/repos/${repo}/git/commits`, { message, tree, parents: [plan.head], ...(author ? { author: { ...author, date: new Date().toISOString() } } : {}) }), 'github');

  const moved = await gh(token, 'PATCH', `/repos/${repo}/git/refs/heads/${refPath(plan.branch)}`, { sha: commit.sha, force: false });
  if (!moved.ok) {
    let why = '';
    try { why = (await moved.json())?.message || ''; } catch { /* no body */ }
    if (/fast.forward/i.test(why)) throw new PrepareError('moved', why);
    if (/protect|rule violation|required status|pull request/i.test(why) || moved.status === 403) throw new PrepareError('protected', why);
    throw new PrepareError('github', `${moved.status} ${why}`);
  }
  return { sha: commit.sha, url: `https://github.com/${repo}/commit/${commit.sha}`, files: entries.map(e => e.path), from: plan.installed, to: plan.latest };
}

/** The sentence a person reads for each way this can end without a change. */
export function updateSentence(code, { repo = 'the repository', branch = 'main' } = {}) {
  switch (code) {
    case 'absent': return `Kiln's editor is not in ${repo} yet, so there is nothing to update. Add Kiln to this site first, then come back.`;
    case 'too_big': return `${repo} has more files than Kiln can look through from here. Run the update in a terminal, in the site's folder, instead.`;
    case 'protected': return `The ${branch} branch of ${repo} does not take a direct change (it is protected), so Kiln could not update its editor there. Nothing was changed. Run the update in a terminal, in the site's folder, and merge its change the way your repository asks.`;
    default: return prepareSentence(code, { repo, branch });   // no_access, release, moved, busy, and GitHub not answering
  }
}

// ─── What the service remembers, so the dashboard need not read a repository ──

const LATEST_KEY = 'elatest';
// How long the released stamp is believed before the release is read again.
// Ten minutes: after a release the dashboard offers "Update Kiln" within ten
// minutes, and the release is read at most once in that time however often a
// dashboard is opened. (The update route itself always reads it fresh.)
const LATEST_TTL_S = 600;
const LATEST_RETRY_S = 300;
const SEEN_TTL_S = 180 * 24 * 3600;
const repoKey = (repo) => `erepo:${repo}`;
const seenKey = (stamp) => `eseen:${stamp}`;
const known = (v) => (v && typeof v.build === 'string' && STAMP.test(v.build) ? { build: v.build, at: Number(v.at) || 0 } : null);

/** The released stamp was just read from the release: keep it, so /cloud/me agrees with what the person was shown. */
export async function rememberLatest(env, stamp) {
  if (!STAMP.test(stamp || '')) return;
  try { await env.KILN.put(LATEST_KEY, JSON.stringify({ stamp, at: Date.now() }), { expirationTtl: LATEST_TTL_S }); } catch { /* it is fetched again next time */ }
  await noteSeen(env, stamp);
}

// `elatest` says which editor is released and lasts ten minutes, so it cannot say
// how long the service has known of that editor. This does: written the first
// time a stamp is seen, and never moved after that.
async function noteSeen(env, stamp) {
  try {
    if (!(await env.KILN.get(seenKey(stamp)))) await env.KILN.put(seenKey(stamp), String(Date.now()), { expirationTtl: SEEN_TTL_S });
  } catch { /* it is noted the next time the stamp is read */ }
}

/** When this service first knew of the released editor `stamp` (a time in milliseconds), or null. */
export async function knownSince(env, stamp) {
  if (!STAMP.test(stamp || '')) return null;
  try { return Number(await env.KILN.get(seenKey(stamp))) || null; } catch { return null; }
}

/** The released editor and when this service first knew of it: { stamp, since }, either null when it is not known. */
export async function releasedBuild(env, releaseBase) {
  const stamp = await latestStamp(env, releaseBase);
  const since = stamp ? await knownSince(env, stamp) : null;
  if (stamp && !since) await noteSeen(env, stamp);   // known from now on
  return { stamp, since };
}

/** The editor a repository was just seen to hold, or was just given. */
export async function noteRepoBuild(env, repo, build) {
  if (!STAMP.test(build || '')) return;
  try { await env.KILN.put(repoKey(repo), JSON.stringify({ build, at: Date.now() })); } catch { /* the dashboard offers the button again and is told the site is up to date */ }
}

/**
 * The released stamp, kept for ten minutes. A release that cannot be read is
 * not asked again for five minutes. What is kept says when it was read, and
 * is believed only that long by its own time as well: the store may hand
 * back a value for a while after it was due to go.
 */
async function latestStamp(env, releaseBase) {
  try {
    const had = await env.KILN.get(LATEST_KEY, 'json');
    if (had && 'stamp' in had) {
      const stamp = STAMP.test(had.stamp || '') ? had.stamp : null;
      const age = Date.now() - Number(had.at);
      if (age < (stamp ? LATEST_TTL_S : LATEST_RETRY_S) * 1000) return stamp;   // no time on it, or too old: read again
    }
  } catch { return null; }
  const stamp = await releasedStamp(releaseBase, { waitMs: 3000 });
  try { await env.KILN.put(LATEST_KEY, JSON.stringify({ stamp, at: Date.now() }), { expirationTtl: stamp ? LATEST_TTL_S : LATEST_RETRY_S }); } catch { /* asked again next time */ }
  if (stamp) await noteSeen(env, stamp);
  return stamp;
}

/**
 * For /cloud/me: which editor each of these repositories has, and which one
 * is released, so the dashboard can say an update exists. { latest, builds }
 * with builds[repo] a stamp or null. It never throws and never holds the
 * dashboard up: whatever cannot be had is null.
 *
 * Two things are known about a site's editor: what its signed-in editors last
 * said they run (`ebuild:<repo>`, index.js noteEditorBuild), and what this
 * service last saw in the repository (`erepo:<repo>`). If either is the
 * released editor the site is up to date, whatever the other says: editors go
 * on running the copy their browser has until the host has published the
 * change and they open a page again. Otherwise the later of the two stands.
 *
 * The release is asked about only when some site's editor is known, since
 * without one there is nothing to compare it with.
 */
export async function editorStanding(env, repos, releaseBase) {
  const builds = {};
  const seen = {};
  try {
    await Promise.all([...new Set(repos)].map(async (repo) => {
      builds[repo] = null;
      try {
        const [said, held] = await Promise.all([env.KILN.get(`ebuild:${repo}`, 'json'), env.KILN.get(repoKey(repo), 'json')]);
        seen[repo] = [known(said), known(held)].filter(Boolean).sort((a, b) => b.at - a.at);
      } catch { /* not known */ }
    }));
    if (!Object.values(seen).some(s => s.length)) return { latest: null, builds };
    const latest = await latestStamp(env, releaseBase);
    for (const [repo, s] of Object.entries(seen)) builds[repo] = latest && s.some(k => k.build === latest) ? latest : (s[0]?.build || null);
    return { latest, builds };
  } catch { return { latest: null, builds }; }
}
