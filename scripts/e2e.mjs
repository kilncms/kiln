#!/usr/bin/env node
/**
 * e2e — the editing loop against a deployed worker and a real repository, as
 * invited editors would drive it: through the worker's /gh proxy with editor
 * sessions, using the same transport and engine the editor bundle ships
 * (src/github.js, src/engine.js).
 *
 *   KILN_E2E_REPO=owner/throwaway GH_TOKEN=$(gh auth token) node scripts/e2e.mjs
 *   node scripts/e2e.mjs --smoke                  only the checks that write nothing
 *
 *   KILN_E2E_WORKER   the worker (default: the staging worker)
 *   KILN_E2E_REPO     the test repository, owner/name. Required. It must have
 *                     the worker's GitHub App installed, an index.html with at
 *                     least one data-cms field, and an empty file `.kiln-e2e`
 *                     at its root: that file is what allows this script to
 *                     write to the repository and to reset it afterwards.
 *   KILN_E2E_BRANCH   the branch the site is published from (default main)
 *   KILN_E2E_SITE     optional: the site's address. When set, the script also
 *                     waits for one edit to appear there.
 *   GH_TOKEN          a token with push access to the test repository. Used to
 *                     read the starting state and to put everything back; no
 *                     edit under test goes through it.
 *
 * It WRITES, so it only runs against staging or a local worker; any other
 * worker gets --smoke at most. It never touches the public demo.
 *
 * It leaves the repository as it found it. Before the first write it records
 * the branch head and the page's exact text; at the end, whatever happened,
 * it ends its sessions, deletes the branches and tags it created, and moves
 * the branch back to the recorded head. If someone else committed meanwhile
 * it resets nothing and says so.
 *
 * Editor sessions are normally made by Google sign-in, which a script cannot
 * do. This one writes short-lived sessions (15 minutes) straight into the
 * worker's KV with wrangler, which only a maintainer of that worker can do,
 * and deletes them at the end.
 *
 * What it cannot check, and prints at the end: Google sign-in itself, a
 * member being signed out after removal, and billing.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applyEdits, readValues } from '../src/engine.js';
import { makeGh, getFile, putFile, putBinaryFile, commitFiles, encodeContent } from '../src/github.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const STAGING_WORKER = 'https://kiln-auth-staging.erikkwilder.workers.dev';
const SENTINEL = '.kiln-e2e';
const SESSION_TTL = 900;
// A 1×1 PNG: a real image, so the worker's check of an upload's leading bytes passes.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

export class Stop extends Error {}

export function readConfig(env = process.env, argv = []) {
  const unknown = argv.filter(a => a !== '--smoke');
  if (unknown.length) throw new Stop(`Unknown option ${unknown[0]}. Use: node scripts/e2e.mjs [--smoke]`);
  const worker = (env.KILN_E2E_WORKER || STAGING_WORKER).replace(/\/+$/, '');
  const smoke = argv.includes('--smoke');
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(worker);
  if (!smoke && worker !== STAGING_WORKER && !local) {
    throw new Stop(`This script writes to a repository through the worker, and ${worker} is neither the staging worker nor a local one. Run it against staging (the default), or pass --smoke for the checks that write nothing.`);
  }
  const repo = env.KILN_E2E_REPO || '';
  if (!smoke && !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new Stop('Set KILN_E2E_REPO to the test repository (owner/name). There is no default: this script resets the repository it is pointed at.');
  }
  const token = env.GH_TOKEN || env.GITHUB_TOKEN || '';
  if (!smoke && !token) throw new Stop('Set GH_TOKEN to a token with push access to the test repository (for example GH_TOKEN=$(gh auth token)). It is used to read the starting state and to put everything back.');
  return { worker, repo, branch: env.KILN_E2E_BRANCH || 'main', site: (env.KILN_E2E_SITE || '').replace(/\/+$/, ''), field: env.KILN_E2E_FIELD || '', token, smoke, local };
}

/** The real network, clock and KV. Tests pass their own. */
export function realIo(cfg) {
  const where = cfg.local ? ['--local'] : ['--env', 'staging', '--remote'];
  const wrangler = (...args) => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js'), ...args, '--binding', 'KILN', ...where],
      { cwd: path.join(ROOT, 'worker'), encoding: 'utf8', env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' } });
    if (r.status !== 0) throw new Error(`wrangler ${args.slice(0, 3).join(' ')} failed: ${(r.stderr || r.stdout || '').trim().split('\n').pop()}`);
  };
  return {
    fetch: (url, init) => fetch(url, init),
    kvPut: (key, value, ttl) => wrangler('kv', 'key', 'put', key, value, '--ttl', String(ttl)),
    kvDelete: (key) => wrangler('kv', 'key', 'delete', key),
    log: (line) => console.log(line),
    sleep: (ms) => new Promise(r => setTimeout(r, ms)),
    now: () => Date.now(),
    hex: (bytes) => randomBytes(bytes).toString('hex'),
  };
}

export async function run(cfg, io) {
  const checks = [];
  const record = (name, ok, detail = '') => { checks.push({ name, ok, detail }); io.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`); };
  /** A step that must succeed. A failure is recorded and ends the run (cleanup still happens). */
  const step = async (name, fn) => {
    try { const detail = await fn(); record(name, true, detail || ''); }
    catch (err) { record(name, false, err.message); throw new Stop(name); }
  };
  /** A request that must be refused with this status (and this code, if given). Being let through is the failure. */
  const refused = async (name, send, status, code) => {
    let got;
    try { const res = await send(); got = { status: res.status, body: await res.json().catch(() => ({})) }; }
    catch (err) { got = { status: err.status || 0, body: err.data || {} }; }
    const statuses = [].concat(status);
    const ok = statuses.includes(got.status) && (!code || got.body.code === code || new RegExp(code).test(got.body.error || ''));
    record(name, ok, ok ? `${got.status}${got.body.code ? ` ${got.body.code}` : ''}` : `expected ${statuses.join(' or ')}${code ? ` ${code}` : ''}, got ${got.status} ${JSON.stringify(got.body).slice(0, 160)}`);
    if (!ok) throw new Stop(name);
  };
  const W = cfg.worker;
  const R = cfg.repo;
  const json = (body, headers = {}) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const getJson = async (url, headers = {}) => { const res = await io.fetch(url, { headers }); return { status: res.status, body: await res.json().catch(() => ({})) }; };

  const run = io.hex(4);
  const sessions = [];       // KV keys to delete
  const refsMade = [];       // 'heads/x' | 'tags/y' this run created
  let owner = null;          // direct transport with the maintainer's token
  let start = null;          // branch head before the first write
  let original = null;       // the page's exact text before the first write
  let lastOurs = null;       // the newest commit this run put on the branch
  let wrote = false;

  try {
    // ── The worker answers, and says what it is ──
    await step('worker answers /healthz', async () => {
      const h = await getJson(`${W}/healthz`);
      if (h.status !== 200 || h.body.ok !== true) throw new Error(`${W}/healthz answered ${h.status}`);
      return `version ${h.body.version || '?'}, build ${h.body.build || 'not reported'}`;
    });

    // ── Nothing works without a session or a token (these write nothing) ──
    const probe = R || 'kilncms/kiln';
    await refused('proxy refuses a request with no session', () => io.fetch(`${W}/gh/repos/${probe}/contents/index.html`), 401);
    await refused('proxy refuses an unknown session', () => io.fetch(`${W}/gh/repos/${probe}/contents/index.html`, { headers: { 'X-Kiln-Session': 'f'.repeat(64) } }), 401);
    await refused('API refuses a request with no token', () => io.fetch(`${W}/api/v1/pages`), 401);
    await refused('API refuses an unknown token', () => io.fetch(`${W}/api/v1/pages`, { headers: { Authorization: `Bearer ${'f'.repeat(64)}` } }), 401);
    await refused('comments refuse an anonymous reader', () => io.fetch(`${W}/comments?repo=${probe}&path=index.html`), 401);
    await refused('suggestions refuse an anonymous reader', () => io.fetch(`${W}/suggestions?repo=${probe}`), [401, 403]);
    await refused('AI assist refuses an anonymous caller', () => io.fetch(`${W}/ai/assist`, json({ repo: probe, kind: 'improve', text: 'hi' })), [401, 403]);
    await refused('API tokens cannot be made without push access', () => io.fetch(`${W}/admin/api-tokens`, json({ repo: probe, name: 'nope' })), [401, 403]);
    await refused('people cannot be listed without push access', () => io.fetch(`${W}/admin/people?repo=${probe}`), [401, 403]);
    await refused('member check refuses a malformed id', () => io.fetch(`${W}/members/check`, json({ sid: '../people', origin: 'https://x.example' })), 400);
    await step('member check says no for a sign-in it does not know', async () => {
      const res = await io.fetch(`${W}/members/check`, json({ sid: 'e'.repeat(32), origin: 'https://x.example' }));
      const body = await res.json();
      if (res.status !== 200 || body.ok !== false) throw new Error(`answered ${res.status} ${JSON.stringify(body)}`);
    });
    if (cfg.smoke) return finish();

    // ── The test repository is ready, and is a test repository ──
    await step('worker has its GitHub App', async () => {
      const s = await getJson(`${W}/setup/status`);
      if (!s.body.configured) throw new Error(`no App registered: open ${W}/setup once and click the button`);
      return s.body.slug || '';
    });
    await step(`the App is installed on ${R}`, async () => {
      const s = await getJson(`${W}/setup/install-check?repo=${R}`);
      if (!s.body.installed) throw new Error('not installed: install the App on this repository, then run this again');
    });
    owner = makeGh({ mode: 'direct', token: () => cfg.token, fetchImpl: io.fetch });
    await step('the token can push to the test repository', async () => {
      const r = await owner.request('GET', `/repos/${R}`);
      if (!(r.permissions && (r.permissions.push || r.permissions.admin))) throw new Error('GH_TOKEN has no push access to it');
    });
    await step(`the repository is marked as a test repository (${SENTINEL})`, async () => {
      try { await owner.request('GET', `/repos/${R}/contents/${SENTINEL}?ref=${encodeURIComponent(cfg.branch)}`); }
      catch { throw new Error(`there is no ${SENTINEL} file at its root, so this script will not write to it. Add an empty file with that name to a repository you are happy to have reset, then run this again`); }
    });
    let field;
    await step('starting state recorded', async () => {
      start = (await owner.request('GET', `/repos/${R}/git/ref/${encodeURIComponent('heads/' + cfg.branch)}`)).object.sha;
      original = (await getFile(owner, R, 'index.html', cfg.branch)).text;
      const values = readValues(original);
      field = cfg.field || Object.keys(values).find(k => typeof values[k] === 'string' && values[k].trim() && !/</.test(values[k]));
      if (!field || values[field] === undefined) throw new Error('index.html has no plain-text data-cms field to edit (set KILN_E2E_FIELD to one)');
      return `${cfg.branch} at ${start.slice(0, 7)}; editing the field "${field}"`;
    });

    // ── Three editors, as People & access would make them ──
    const editor = async (label, extra) => {
      const id = io.hex(32);
      const key = `esess:${id}`;
      sessions.push(key);
      await io.kvPut(key, JSON.stringify({ repo: R, name: `Kiln E2E ${label}`, role: 'editor', email: `e2e-${label}@kilncms.invalid`, paths: [''], keys: [], features: null, mode: null, exp: io.now() + SESSION_TTL * 1000, ...extra }), SESSION_TTL);
      return { id, gh: makeGh({ mode: 'proxy', worker: W, session: id, fetchImpl: io.fetch }), raw: (method, p, body) => io.fetch(`${W}/gh${p}`, { method, headers: { 'X-Kiln-Session': id, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }) };
    };
    let plain, granted, suggest;
    await step('three short-lived editor sessions made (default tools; New page + Theme; suggest-only)', async () => {
      plain = await editor('default', {});
      granted = await editor('granted', { features: ['newpost', 'theme', 'draft', 'pagesettings', 'history'] });
      suggest = await editor('suggest', { mode: 'suggest' });
      // KV may take a moment to show a new key at the edge.
      for (let i = 0; i < 20; i++) {
        const res = await plain.raw('GET', `/repos/${R}`);
        if (res.status !== 401) return;
        await io.sleep(1500);
      }
      throw new Error('the worker still does not know the session after 30 seconds');
    });
    const head = async () => (await owner.request('GET', `/repos/${R}/git/ref/${encodeURIComponent('heads/' + cfg.branch)}`)).object.sha;
    const noted = async () => { lastOurs = await head(); wrote = true; };
    const P = `/repos/${R}`;

    // ── An editor with the default tools ──
    await step('editor reads the page through the worker', async () => {
      const seen = await getFile(plain.gh, R, 'index.html', cfg.branch);
      if (seen.text !== original) throw new Error('what the proxy returned is not what the repository holds');
    });
    const marker = `Kiln e2e ${run} at ${new Date(io.now()).toISOString()}`;
    await step('editor publishes a text edit', async () => {
      const cur = await getFile(plain.gh, R, 'index.html', cfg.branch);
      const next = applyEdits(cur.text, [{ key: field, html: marker }]);
      if (next.applied.length !== 1) throw new Error(`the field "${field}" could not be edited`);
      await putFile(plain.gh, R, 'index.html', { text: next.html, sha: cur.sha, branch: cfg.branch, message: `E2E ${run}: edit ${field} (via Kiln)` });
      await noted();
      if (!(await getFile(owner, R, 'index.html', cfg.branch)).text.includes(marker)) throw new Error('the repository does not hold the edit');
      return lastOurs.slice(0, 7);
    });
    if (cfg.site) {
      await step(`the edit appears on ${cfg.site}`, async () => {
        for (let i = 0; i < 40; i++) {
          try { if ((await (await io.fetch(`${cfg.site}/?e2e=${io.now()}`, { headers: { 'Cache-Control': 'no-cache' } })).text()).includes(marker)) return `after about ${i * 7} seconds`; } catch { /* keep waiting */ }
          await io.sleep(7000);
        }
        throw new Error('not there after 280 seconds: is the site deploying from this repository?');
      });
    }
    await step('editor puts the page back, byte for byte', async () => {
      const cur = await getFile(plain.gh, R, 'index.html', cfg.branch);
      await putFile(plain.gh, R, 'index.html', { text: original, sha: cur.sha, branch: cfg.branch, message: `E2E ${run}: restore ${field} (via Kiln)` });
      await noted();
      if ((await getFile(owner, R, 'index.html', cfg.branch)).text !== original) throw new Error('the page is not what it was');
    });
    await step('editor publishes two pictures in one commit (the staged-upload path: blobs, tree, commit, branch move)', async () => {
      const c = await commitFiles(plain.gh, R, cfg.branch, [
        { path: `assets/uploads/kiln-e2e-${run}-a.png`, base64: PNG },
        { path: `assets/uploads/kiln-e2e-${run}-b.png`, base64: PNG },
      ], `E2E ${run}: upload 2 files (via Kiln)`);
      await noted();
      if (lastOurs !== c.sha) throw new Error('the branch is not at the commit that was made');
      return c.sha.slice(0, 7);
    });
    await step('editor saves a draft (a new kiln-drafts branch, then a write to it)', async () => {
      let exists = true;
      try { await plain.gh.request('GET', `${P}/git/ref/${encodeURIComponent('heads/kiln-drafts')}`); } catch { exists = false; }
      if (!exists) { await plain.gh.request('POST', `${P}/git/refs`, { ref: 'refs/heads/kiln-drafts', sha: await head() }); refsMade.push('heads/kiln-drafts'); }
      let sha;
      try { sha = (await getFile(plain.gh, R, 'index.html', 'kiln-drafts')).sha; } catch { /* a new draft */ }
      await putFile(plain.gh, R, 'index.html', { text: applyEdits(original, [{ key: field, html: `draft ${run}` }]).html, sha, branch: 'kiln-drafts', message: `E2E ${run}: draft (via Kiln)` });
      return exists ? 'the branch was already there; left in place' : 'branch created';
    });
    await step('editor names a version (a tag on an earlier commit)', async () => {
      const name = `kiln/${Math.floor(io.now() / 1000)}-e2e-${run}`;
      await plain.gh.request('POST', `${P}/git/refs`, { ref: `refs/tags/${name}`, sha: start });
      refsMade.push(`tags/${name}`);
    });

    // ── What that editor must NOT be able to do. Each is tried for real. ──
    const b64 = (text) => encodeContent(text);
    await refused('refused: an SVG upload', () => plain.raw('PUT', `${P}/contents/assets/uploads/kiln-e2e-${run}.svg`, { message: 'x', branch: cfg.branch, content: b64('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>') }), 403, 'file_active');
    await refused('refused: a script added to a page', async () => {
      const cur = await getFile(plain.gh, R, 'index.html', cfg.branch);
      return plain.raw('PUT', `${P}/contents/index.html`, { message: 'x', branch: cfg.branch, sha: cur.sha, content: b64(cur.text.replace(/<\/body>/i, '<script>alert(1)</script></body>')) });
    }, 403, 'scripts or executable markup');
    await refused('refused: a workflow file', () => plain.raw('PUT', `${P}/contents/.github/workflows/kiln-e2e.yml`, { message: 'x', branch: cfg.branch, content: b64('on: push\n') }), 403, 'forbidden path');
    await refused('refused: deleting a file (a tree entry with no content)', () => plain.raw('POST', `${P}/git/trees`, { base_tree: start, tree: [{ path: 'index.html', mode: '100644', type: 'blob', sha: null }] }), 403, 'no_delete');
    await refused('refused: moving the branch back to an earlier commit', () => plain.raw('PATCH', `${P}/git/refs/heads/${cfg.branch}`, { sha: start }), 403, 'ref_not_direct');
    await refused('refused: a forced branch update', () => plain.raw('PATCH', `${P}/git/refs/heads/${cfg.branch}`, { sha: start, force: true }), 403, 'force');
    await refused('refused: a new branch at a commit the repository does not have', () => plain.raw('POST', `${P}/git/refs`, { ref: `refs/heads/kiln/e2e-${run}-x`, sha: 'f'.repeat(40) }), 403, 'ref_not_ancestor');
    await refused('refused: a stylesheet, without the Theme tool', () => plain.raw('PUT', `${P}/contents/assets/kiln-e2e-${run}.css`, { message: 'x', branch: cfg.branch, content: b64('h1{color:red}') }), 403, 'grant_required');
    await refused('refused: a new page, without the New page tool', () => plain.raw('PUT', `${P}/contents/kiln-e2e-${run}.html`, { message: 'x', branch: cfg.branch, content: b64('<!doctype html><title>x</title><p>x</p>') }), 403, 'grant_required');
    await step('none of the refused requests changed the branch', async () => {
      if (await head() !== lastOurs) throw new Error('the branch moved');
    });

    // ── An editor who was given New page and Theme ──
    await step('granted editor publishes a new page and a picture in one commit', async () => {
      const c = await commitFiles(granted.gh, R, cfg.branch, [
        { path: `kiln-e2e-${run}.html`, text: `<!doctype html>\n<html><head><title>E2E ${run}</title></head>\n<body>\n<h1 data-cms="t">E2E ${run}</h1>\n</body></html>\n` },
        { path: `assets/uploads/kiln-e2e-${run}-c.png`, base64: PNG },
      ], `E2E ${run}: new page (via Kiln)`);
      await noted();
      return c.sha.slice(0, 7);
    });
    await step('granted editor writes a stylesheet', async () => {
      await putFile(granted.gh, R, `assets/kiln-e2e-${run}.css`, { text: 'h1 { color: inherit; }\n', branch: cfg.branch, message: `E2E ${run}: stylesheet (via Kiln)` });
      await noted();
    });

    // ── A suggest-only editor ──
    await refused('refused: a suggest-only editor publishing straight to the site', async () => {
      const cur = await getFile(suggest.gh, R, 'index.html', cfg.branch);
      return suggest.raw('PUT', `${P}/contents/index.html`, { message: 'x', branch: cfg.branch, sha: cur.sha, content: b64(applyEdits(cur.text, [{ key: field, html: 'nope' }]).html) });
    }, 403, 'suggest-mode');
    await step('suggest-only editor writes its preview to its own scratch branch', async () => {
      const name = `kiln/suggest-e2e-${run}`;
      await suggest.gh.request('POST', `${P}/git/refs`, { ref: `refs/heads/${name}`, sha: await head() });
      refsMade.push(`heads/${name}`);
      const cur = await getFile(suggest.gh, R, 'index.html', name);
      await putFile(suggest.gh, R, 'index.html', { text: applyEdits(cur.text, [{ key: field, html: `suggested ${run}` }]).html, sha: cur.sha, branch: name, message: `E2E ${run}: suggestion preview (via Kiln)` });
    });
  } catch (err) {
    if (!(err instanceof Stop)) record('the run itself', false, err.message);
  } finally {
    // ── Put everything back, whatever happened ──
    for (const key of sessions) {
      try { await io.kvDelete(key); } catch (err) { record(`cleanup: end session ${key.slice(0, 14)}…`, false, `${err.message}; it expires by itself within 15 minutes`); }
    }
    if (sessions.length) io.log(`   ended ${sessions.length} editor session${sessions.length > 1 ? 's' : ''}`);
    if (owner && start) {
      for (const ref of refsMade) {
        try { await owner.request('DELETE', `/repos/${R}/git/refs/${ref.split('/').map(encodeURIComponent).join('/')}`); }
        catch (err) { record(`cleanup: delete ${ref}`, false, err.message); }
      }
      try {
        const now = (await owner.request('GET', `/repos/${R}/git/ref/${encodeURIComponent('heads/' + cfg.branch)}`)).object.sha;
        if (now === start) record('cleanup: the repository is as it was found', true, wrote ? '' : 'nothing had been written');
        else if (now !== lastOurs) record('cleanup: the repository is as it was found', false, `${cfg.branch} is at ${now.slice(0, 7)}, which this run did not put there: someone else committed meanwhile, so nothing was reset. This run's commits are the ones whose message starts "E2E ${run}"`);
        else {
          await owner.request('PATCH', `/repos/${R}/git/refs/${encodeURIComponent('heads/' + cfg.branch)}`, { sha: start, force: true });
          const text = (await getFile(owner, R, 'index.html', cfg.branch)).text;
          const back = (await owner.request('GET', `/repos/${R}/git/ref/${encodeURIComponent('heads/' + cfg.branch)}`)).object.sha === start && text === original;
          record('cleanup: the repository is as it was found', back, back ? `${cfg.branch} back at ${start.slice(0, 7)}; ${refsMade.length} branch${refsMade.length === 1 ? '' : 'es'} and tags removed` : 'the reset did not take');
        }
      } catch (err) { record('cleanup: the repository is as it was found', false, err.message); }
    }
  }
  return finish();

  function finish() {
    const failed = checks.filter(c => !c.ok);
    io.log(`\n${checks.length - failed.length}/${checks.length} checks passed${cfg.smoke ? ' (smoke: nothing was written)' : ''}`);
    if (!cfg.smoke) {
      io.log(`\nNot covered here, check by hand on staging:
  · Google sign-in as an invited editor and as a member
  · a member is signed out within five minutes of being removed in People & access
  · Kiln Cloud with billing in test mode: cancel keeps editing until the period ends; Remove cancels the subscription
  · npx github:kilncms/kiln doctor in the test site prints the versions line`);
    }
    return { ok: failed.length === 0, checks };
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    const cfg = readConfig(process.env, process.argv.slice(2));
    console.log(`Kiln e2e against ${cfg.worker}${cfg.smoke ? ' (smoke)' : `, repository ${cfg.repo}`}\n`);
    const result = await run(cfg, realIo(cfg));
    process.exit(result.ok ? 0 : 1);
  } catch (err) {
    console.error(err instanceof Stop ? err.message : `✗ ${err.stack || err.message}`);
    process.exit(2);
  }
}
