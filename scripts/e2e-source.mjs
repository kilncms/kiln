#!/usr/bin/env node
/**
 * e2e-source — source mode against a deployed worker and a real repository:
 * a site a generator builds (Astro), whose pages are rendered from content
 * files, edited as an invited editor would through the worker's
 * /source/commit and /source/revert. The sibling of scripts/e2e.mjs, which
 * does the same for plain-HTML sites; it shares that script's safety rules
 * and helpers.
 *
 *   KILN_E2E_REPO=owner/astro-test-repo GH_TOKEN=$(gh auth token) node scripts/e2e-source.mjs
 *   node scripts/e2e-source.mjs --smoke          only the checks that write nothing
 *
 *   KILN_E2E_WORKER, KILN_E2E_REPO, KILN_E2E_BRANCH, KILN_E2E_SITE, GH_TOKEN
 *                         as for e2e.mjs: staging by default, no default
 *                         repository, and the repository must carry `.kiln-e2e`
 *   KILN_E2E_SOURCE_FILE  the content file to edit (default
 *                         src/content/events/one.md). It needs `title` and
 *                         `venue` in its frontmatter.
 *   KILN_E2E_TEMPLATE     a template file of the site (default
 *                         src/pages/index.astro), used to show it is refused
 *
 * What it does, as editors made for the run:
 *   · publishes two fields of one content file and checks on GitHub that this
 *     was ONE commit, by the editor, touching only that file, and that exactly
 *     the two edited lines changed
 *   · has a second editor change a field the first one is about to publish,
 *     and checks that the first one's edit is left out with what the file says
 *     now, that the other field of the same publish is saved, and that the
 *     edit is written once it says what the file holds
 *   · tries what must be refused: text in the page template (source mode edits
 *     content files, never template code), a content file outside the editor's
 *     folders, the site's configuration, a delete, a content file written
 *     around the source endpoint, script markup in a value, a value of the
 *     wrong type, a suggest-only editor
 *   · undoes the change with /source/revert, the button the editor offers
 *     after a failed build, and checks the file is byte for byte what it was
 *   · puts the repository back as it found it, whatever happened
 *
 * What it cannot check, and prints at the end: the editor itself in a browser
 * on the built site, and a real failed build.
 */
import { pathToFileURL } from 'node:url';
import { getFile } from '../src/github.js';
import { readConfig, realIo, checklist, repoReady, editorSessions, putBack, patient, Stop } from './e2e.mjs';

const EDITOR_EMAIL = 'kiln-editor@users.noreply.github.com';
const CONFIG_PATHS = ['public/assets/kiln-config.js', 'assets/kiln-config.js'];

export async function run(cfg, rawIo, env = process.env) {
  const io = patient(rawIo, cfg);
  const { checks, record, step, refused } = checklist(io);
  const W = cfg.worker;
  const R = cfg.repo;
  const FILE = env.KILN_E2E_SOURCE_FILE || 'src/content/events/one.md';
  const TEMPLATE = env.KILN_E2E_TEMPLATE || 'src/pages/index.astro';
  const folder = FILE.slice(0, FILE.lastIndexOf('/') + 1);
  const json = (body, headers = {}) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

  const runId = io.hex(4);
  const editors = editorSessions(cfg, io);
  let owner = null;
  let start = null;
  let original = null;
  let templateText = null;
  let lastOurs = null;
  let wrote = false;
  let health = {};

  try {
    await step('worker answers /healthz and can edit Astro sources', async () => {
      const res = await io.fetch(`${W}/healthz`, {});
      const h = await res.json().catch(() => ({}));
      if (res.status !== 200 || h.ok !== true) throw new Error(`${W}/healthz answered ${res.status}`);
      if (!(h.modes || []).includes('source') || !(h.adapters || []).includes('astro')) throw new Error(`this worker does not report source mode with the astro adapter (modes ${JSON.stringify(h.modes)}, adapters ${JSON.stringify(h.adapters)})`);
      health = h;
      return `version ${h.version || '?'}, build ${h.build || 'not reported'}`;
    });
    // Without a session nothing here answers. (These write nothing.)
    const probe = R || 'kilncms/kiln';
    await refused('source commit refuses a caller with no session', () => io.fetch(`${W}/source/commit`, json({ repo: probe, adapter: 'astro', file: FILE, edits: [{ pointer: '/frontmatter/title', value: 'x' }] })), 401);
    await refused('source revert refuses a caller with no session', () => io.fetch(`${W}/source/revert`, json({ repo: probe, file: FILE, toSha: 'f'.repeat(40) })), 401);
    await refused('source commit refuses an unknown session', () => io.fetch(`${W}/source/commit`, json({ repo: probe, adapter: 'astro', file: FILE, edits: [{ pointer: '/frontmatter/title', value: 'x' }] }, { 'X-Kiln-Session': 'f'.repeat(64) })), 401);
    if (cfg.smoke) return finish();

    owner = await repoReady(cfg, io, { step });
    await step('the site is set up for source mode (its kiln-config.js says so)', async () => {
      let text = null; let at = null;
      for (const p of CONFIG_PATHS) { try { text = (await getFile(owner, R, p, cfg.branch)).text; at = p; break; } catch { /* try the next place */ } }
      if (text === null) throw new Error(`no kiln-config.js at ${CONFIG_PATHS.join(' or ')}`);
      if (!/\bmode\s*:\s*['"]source['"]/.test(text) || !/\badapter\s*:\s*['"]astro['"]/.test(text)) throw new Error(`${at} does not say mode: 'source', adapter: 'astro'`);
      const worker = /\bworker\s*:\s*['"]([^'"]+)['"]/.exec(text)?.[1] || '';
      return worker.replace(/\/+$/, '') === W ? at : `${at}; note: it names the worker ${worker || '(none)'}, and this run uses ${W}`;
    });
    const fm = (text, key) => { const i = text.split('\n').findIndex(l => l.startsWith(`${key}:`)); return i; };
    await step('starting state recorded', async () => {
      start = (await owner.request('GET', `/repos/${R}/git/ref/${encodeURIComponent('heads/' + cfg.branch)}`)).object.sha;
      original = (await getFile(owner, R, FILE, cfg.branch)).text;
      templateText = (await getFile(owner, R, TEMPLATE, cfg.branch)).text;
      if (!original.startsWith('---') || fm(original, 'title') < 0 || fm(original, 'venue') < 0) throw new Error(`${FILE} needs frontmatter with title and venue (set KILN_E2E_SOURCE_FILE to a file that has them)`);
      return `${cfg.branch} at ${start.slice(0, 7)}; editing title and venue in ${FILE}`;
    });

    let scoped, whole, suggest;
    await step(`three short-lived editor sessions made (${folder} only; the whole site; suggest-only)`, async () => {
      scoped = await editors.make('events', { paths: [folder] });
      whole = await editors.make('site');
      suggest = await editors.make('suggest', { mode: 'suggest' });
      await editors.settle(scoped);
    });
    const head = async () => (await owner.request('GET', `/repos/${R}/git/ref/${encodeURIComponent('heads/' + cfg.branch)}`)).object.sha;
    const commitBody = (file, edits, extra = {}) => ({ repo: R, branch: cfg.branch, adapter: 'astro', file, edits, ...extra });
    const P = `/repos/${R}`;

    // ── Publish: two fields of one content file ──
    await step('editor reads the content file through the worker', async () => {
      if ((await getFile(scoped.gh, R, FILE, cfg.branch)).text !== original) throw new Error('what the proxy returned is not what the repository holds');
    });
    const title = `E2E title ${runId}`;
    const venue = `E2E venue ${runId}`;
    let published = null;
    await step('editor publishes two fields of one content file', async () => {
      const res = await scoped.post('/source/commit', commitBody(FILE, [
        { pointer: '/frontmatter/title', value: title },
        { pointer: '/frontmatter/venue', value: venue },
      ], { message: `E2E ${runId}: edit title and venue (via Kiln)` }));
      const body = await res.json().catch(() => ({}));
      if (res.status !== 200 || !body.ok || !body.commit?.sha) throw new Error(`answered ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
      if ((body.applied || []).length !== 2 || (body.skipped || []).length) throw new Error(`applied ${JSON.stringify(body.applied)}, skipped ${JSON.stringify(body.skipped)}`);
      published = body.commit.sha;
      lastOurs = await head(); wrote = true;
      return published.slice(0, 7);
    });
    await step('on GitHub: one commit, by the editor, touching only that file', async () => {
      if (lastOurs !== published) throw new Error(`the branch is at ${lastOurs.slice(0, 7)}, not at the commit the worker reported`);
      const cmp = await owner.request('GET', `${P}/compare/${start}...${published}`);
      const commits = cmp.commits || [];
      if (cmp.total_commits !== 1 || commits.length !== 1 || commits[0].sha !== published) throw new Error(`${cmp.total_commits} commits since the start, expected exactly one`);
      const a = commits[0].commit?.author || {};
      if (a.email !== EDITOR_EMAIL || a.name !== `${scoped.name} (via Kiln)`) throw new Error(`the commit's author is ${a.name} <${a.email}>`);
      const files = (cmp.files || []).map(f => f.filename);
      if (files.length !== 1 || files[0] !== FILE) throw new Error(`the commit touches ${JSON.stringify(files)}`);
      return `${a.name}; ${files[0]}`;
    });
    await step('on GitHub: exactly the two edited lines changed; every other line is what it was', async () => {
      const now = (await getFile(owner, R, FILE, cfg.branch)).text;
      const before = original.split('\n'); const after = now.split('\n');
      if (before.length !== after.length) throw new Error(`the file went from ${before.length} lines to ${after.length}`);
      const changed = before.map((l, i) => (l === after[i] ? -1 : i)).filter(i => i >= 0);
      const want = [fm(original, 'title'), fm(original, 'venue')].sort((x, y) => x - y);
      if (JSON.stringify(changed) !== JSON.stringify(want)) throw new Error(`lines ${changed.map(i => i + 1).join(', ')} changed; expected lines ${want.map(i => i + 1).join(', ')}`);
      if (!after[fm(original, 'title')].startsWith('title:') || !after[fm(original, 'title')].includes(title)) throw new Error(`the title line is now: ${after[fm(original, 'title')]}`);
      if (!after[fm(original, 'venue')].startsWith('venue:') || !after[fm(original, 'venue')].includes(venue)) throw new Error(`the venue line is now: ${after[fm(original, 'venue')]}`);
      return `lines ${want.map(i => i + 1).join(' and ')} of ${before.length}`;
    });
    if (cfg.site) {
      await step(`the edit appears on ${cfg.site} once the site has rebuilt`, async () => {
        for (let i = 0; i < 60; i++) {
          try { if ((await (await io.fetch(`${cfg.site}/?e2e=${io.now()}`, { headers: { 'Cache-Control': 'no-cache' } })).text()).includes(title)) return `after about ${i * 7} seconds`; } catch { /* keep waiting */ }
          await io.sleep(7000);
        }
        throw new Error('not there after 7 minutes: is the site building from this repository?');
      });
    }

    // ── Someone else changed the same field ──
    // The editor's page still shows the title it published; meanwhile another
    // editor changes that title. An edit says what its field held when it was
    // read (`was`), and the worker does not write over a field that no longer
    // says that.
    const theirs = `E2E theirs ${runId}`;
    const mine = `E2E mine ${runId}`;
    const venueTwo = `E2E venue two ${runId}`;
    let afterTheirs = null;
    await step('someone else changes the title (a second editor, saying what the title was)', async () => {
      const res = await whole.post('/source/commit', commitBody(FILE, [{ pointer: '/frontmatter/title', value: theirs, was: title }],
        { message: `E2E ${runId}: someone else changes the title (via Kiln)` }));
      const body = await res.json().catch(() => ({}));
      if (res.status === 200) lastOurs = await head();
      if (res.status !== 200 || !body.ok || (body.applied || []).length !== 1) throw new Error(`answered ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
      afterTheirs = (await getFile(owner, R, FILE, cfg.branch)).text;
      return body.commit.sha.slice(0, 7);
    });
    await step('the first editor publishes the old title and the venue: the title is left out with what the file says now, the venue is saved', async () => {
      const res = await scoped.post('/source/commit', commitBody(FILE, [
        { pointer: '/frontmatter/title', value: mine, was: title },
        { pointer: '/frontmatter/venue', value: venueTwo, was: venue },
      ], { message: `E2E ${runId}: edit title and venue again (via Kiln)` }));
      const body = await res.json().catch(() => ({}));
      if (res.status === 200) lastOurs = await head();   // whatever it wrote is ours to put back
      const older = health.sourceWas === true ? '' : ' (this worker does not report sourceWas in /healthz: it is from before this check, and writes over the field without asking)';
      if (res.status !== 200 || !body.ok) throw new Error(`answered ${res.status} ${JSON.stringify(body).slice(0, 200)}${older}`);
      const skipped = body.skipped || [];
      if ((body.applied || []).length !== 1 || skipped.length !== 1) throw new Error(`applied ${JSON.stringify(body.applied)}, skipped ${JSON.stringify(skipped)}${older}`);
      if (!/^changed since it was read/.test(skipped[0].reason || '') || skipped[0].current !== theirs) throw new Error(`the title was skipped as ${JSON.stringify(skipped[0])}, expected "changed since it was read" with current ${JSON.stringify(theirs)}`);
      return `left out: ${skipped[0].reason}`;
    });
    await step('on GitHub: their title is still there, and only the venue line changed', async () => {
      const now = (await getFile(owner, R, FILE, cfg.branch)).text;
      const before = afterTheirs.split('\n'); const after = now.split('\n');
      const changed = before.map((l, i) => (l === after[i] ? -1 : i)).filter(i => i >= 0);
      if (before.length !== after.length || JSON.stringify(changed) !== JSON.stringify([fm(original, 'venue')])) throw new Error(`lines ${changed.map(i => i + 1).join(', ')} changed; expected only line ${fm(original, 'venue') + 1}`);
      if (!after[fm(original, 'title')].includes(theirs)) throw new Error(`the title line is now: ${after[fm(original, 'title')]}`);
      if (!after[fm(original, 'venue')].includes(venueTwo)) throw new Error(`the venue line is now: ${after[fm(original, 'venue')]}`);
    });
    await step('the first editor chooses their own title: the same edit, saying what the file holds now, is written', async () => {
      const res = await scoped.post('/source/commit', commitBody(FILE, [{ pointer: '/frontmatter/title', value: mine, was: theirs }],
        { message: `E2E ${runId}: the title, knowingly (via Kiln)` }));
      const body = await res.json().catch(() => ({}));
      if (res.status === 200) lastOurs = await head();
      if (res.status !== 200 || !body.ok || (body.applied || []).length !== 1 || (body.skipped || []).length) throw new Error(`answered ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
      const line = (await getFile(owner, R, FILE, cfg.branch)).text.split('\n')[fm(original, 'title')];
      if (!line.includes(mine)) throw new Error(`the title line is now: ${line}`);
    });

    // ── What must be refused. Each is tried for real. ──
    const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
    await refused('refused: text that lives in the page template, as a source edit (source mode edits content files only)',
      () => whole.post('/source/commit', commitBody(TEMPLATE, [{ pointer: '/body', value: 'changed' }])), 400, 'file type not editable');
    await refused('refused: the page template written directly through the proxy', async () => {
      const cur = await getFile(whole.gh, R, TEMPLATE, cfg.branch);
      return whole.raw('PUT', `${P}/contents/${TEMPLATE}`, { message: 'x', branch: cfg.branch, sha: cur.sha, content: b64(cur.text.replace('</body>', '<p>changed</p></body>')) });
    }, 415, 'file_type');
    await refused('refused: a content file outside the editor\'s folders', () => scoped.post('/source/commit', commitBody('src/content/site/home.md', [{ pointer: '/frontmatter/heading', value: 'changed' }])), 403, 'outside your editing scope');
    await refused('refused: the site\'s configuration', () => whole.post('/source/commit', commitBody('astro.config.mjs', [{ pointer: '/body', value: 'export default {}' }])), 403, 'forbidden path');
    await refused('refused: deleting the content file (a tree entry with no content)', () => scoped.raw('POST', `${P}/git/trees`, { base_tree: start, tree: [{ path: FILE, mode: '100644', type: 'blob', sha: null }] }), 403, 'no_delete');
    await refused('refused: the content file written around the source endpoint', async () => {
      const cur = await getFile(scoped.gh, R, FILE, cfg.branch);
      return scoped.raw('PUT', `${P}/contents/${FILE}`, { message: 'x', branch: cfg.branch, sha: cur.sha, content: b64('---\ntitle: replaced\n---\n') });
    }, 415, 'file_type');
    await refused('refused: script markup in a value', () => scoped.post('/source/commit', commitBody(FILE, [{ pointer: '/frontmatter/title', value: '<script>alert(1)</script>' }])), 422, 'no edits could be applied');
    await refused('refused: a time that is not a time', () => scoped.post('/source/commit', commitBody(FILE, [{ pointer: '/frontmatter/start', value: '25:99', type: 'time' }])), 422, 'no edits could be applied');
    await refused('refused: a suggest-only editor publishing a source edit', () => suggest.post('/source/commit', commitBody(FILE, [{ pointer: '/frontmatter/title', value: 'nope' }])), 403, 'suggest-mode');
    await step('none of the refused requests changed the branch', async () => {
      if (await head() !== lastOurs) throw new Error('the branch moved');
      if ((await getFile(owner, R, TEMPLATE, cfg.branch)).text !== templateText) throw new Error('the page template changed');
    });

    // ── Undo, as the editor offers after a failed build ──
    let undone = null;
    const beforeUndo = lastOurs;
    await step('editor undoes the change (what the editor offers after a failed build)', async () => {
      const res = await scoped.post('/source/revert', { repo: R, branch: cfg.branch, file: FILE, toSha: start });
      const body = await res.json().catch(() => ({}));
      if (res.status !== 200 || !body.ok || !body.commit?.sha) throw new Error(`answered ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
      undone = body.commit.sha;
      lastOurs = await head();
      return undone.slice(0, 7);
    });
    await step('on GitHub: the content file is byte for byte what it was, in one more commit by the editor', async () => {
      if (lastOurs !== undone) throw new Error('the branch is not at the undo commit');
      if ((await getFile(owner, R, FILE, cfg.branch)).text !== original) throw new Error('the file is not what it was');
      const c = await owner.request('GET', `${P}/git/commits/${undone}`);
      if (c.author?.email !== EDITOR_EMAIL || (c.parents || []).length !== 1 || c.parents[0].sha !== beforeUndo) throw new Error(`unexpected commit: author ${c.author?.email}, parents ${JSON.stringify((c.parents || []).map(x => x.sha.slice(0, 7)))}`);
    });
  } catch (err) {
    if (!(err instanceof Stop)) record('the run itself', false, err.message);
  } finally {
    await putBack({ cfg, io, record, owner, sessions: editors.keys, start, lastOurs, wrote, run: runId,
      same: async () => (await getFile(owner, R, FILE, cfg.branch)).text === original && (await getFile(owner, R, TEMPLATE, cfg.branch)).text === templateText });
  }
  return finish();

  function finish() {
    const failed = checks.filter(c => !c.ok);
    io.log(`\n${checks.length - failed.length}/${checks.length} checks passed${cfg.smoke ? ' (smoke: nothing was written)' : ''}`);
    if (!cfg.smoke) {
      io.log(`\nNot covered here, check by hand on the built site:
  · sign in at /kiln, click an event's title on the page, type, Publish: Saved → Building… → Published
  · change that title in the repository, then publish another change to it from the page that still
    shows the old one: the editor asks "Someone else changed this", with Theirs and Yours
  · text written in the page template itself shows no edit outline (it is not editable in source mode)
  · a publish that breaks the build offers "Undo this change", and using it rebuilds the site`);
    }
    return { ok: failed.length === 0, checks };
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    const cfg = readConfig(process.env, process.argv.slice(2));
    console.log(`Kiln source-mode e2e against ${cfg.worker}${cfg.smoke ? ' (smoke)' : `, repository ${cfg.repo}`}\n`);
    const result = await run(cfg, realIo(cfg));
    process.exit(result.ok ? 0 : 1);
  } catch (err) {
    console.error(err instanceof Stop ? err.message : `✗ ${err.stack || err.message}`);
    process.exit(2);
  }
}
