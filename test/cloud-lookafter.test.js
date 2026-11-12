/**
 * A site on Kiln's hosting looks after itself (worker/lookafter.js): when it
 * is first put up it gets Kiln's files, a character set on every page and a
 * first pass at what can be edited, before its first copy is made (POST
 * /cloud/sites/hosting in worker/cloud.js); and the five-minute job keeps its
 * editor current (sweepHosting in worker/hosted.js). The real handlers run
 * over the SQLite-backed D1 stand-in, an in-memory GitHub per repository, an
 * in-memory Cloudflare and a stand-in for the release branch. Nothing here
 * touches the network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { fakeKV, withFetch, githubWrites } from './worker-harness.js';
import { cloudEnv, addSite, d1Skip } from './d1-fake.js';
import { fakeGitHub } from './github-fake.js';
import { fakeCloudflare } from './cloudflare-fake.js';
import { withCharset, CHARSET_TAG, charsetSentence } from '../worker/lookafter.js';
import { withKilnTags, kilnConfigFile, KILN_PAGE, KILN_TAGS } from '../worker/prepare.js';
import { autotag } from '../src/autotag.js';

const RELEASE = 'https://raw.githubusercontent.com/kilncms/kiln/release';
const HOUR = 3600 * 1000;
/** kiln.js as a build writes it: the stamp is at the top. */
const editor = (stamp) => `(function(){"use strict";var t=window.KILN||{};window.KILN_VERSION="${stamp}";/* the rest of kiln.js */})();\n`;
const release = (stamp) => ({
  'dist/VERSION': Buffer.from(`${stamp}\n`),
  'dist/kiln.js': Buffer.from(editor(stamp)),
  'dist/kiln-editor.js': Buffer.from(`/* editor ${stamp} */\n`),
  'dist/kiln-features.js': Buffer.from(`/* features ${stamp} */\n`),
  'templates/_headers': Buffer.from('/*\n  X-Content-Type-Options: nosniff\n'),
});
const page = (title) => `<!doctype html>\n<html lang="en">\n<head>\n  <title>${title}</title>\n</head>\n<body>\n  <h1>${title}</h1>\n  <p>Words about ${title} that its owner will want to change one day.</p>\n</body>\n</html>\n`;
const plain = { 'index.html': page('Home'), 'about.html': page('About'), 'assets/site.css': 'h1{}' };
/** A page as it is once Kiln has looked after it. */
const ready = (html) => autotag(withKilnTags(withCharset(html).html).html).html;
/** Kiln's own files in a site's repository, with the editor at `stamp`. */
const kilnFiles = (stamp, repo = 'ada/club') => ({
  'assets/kiln.js': editor(stamp), 'assets/kiln-editor.js': `/* editor ${stamp} */\n`, 'assets/kiln-features.js': `/* features ${stamp} */\n`,
  'assets/kiln-config.js': kilnConfigFile({ repo, branch: 'main', worker: 'https://worker.example' }), 'kiln.html': KILN_PAGE,
});
const lookedAfterSite = (stamp = 'r1', repo = 'ada/club') => ({ 'index.html': ready(page('Home')), 'about.html': ready(page('About')), 'assets/site.css': 'h1{}', ...kilnFiles(stamp, repo) });
const REFUSED = { message: 'Repository rule violations found\n\nChanges must be made through a pull request.' };

/**
 * One account (ada) and its hosted sites: `repos` is { 'ada/club': files, … },
 * one site per repository (ids s1, s2, …). `shut` names repositories whose
 * branch takes no direct change. `w.out` is the release branch, which a test
 * may swap.
 */
function world(repos = { 'ada/club': plain }, { site = {}, kv: seed = {}, out = release('r2'), shut = [] } = {}) {
  const names = Object.keys(repos);
  const ghs = Object.fromEntries(names.map(r => [r, fakeGitHub({ repo: r, files: repos[r] })]));
  const cf = fakeCloudflare();
  const env = cloudEnv(fakeKV({ ...Object.fromEntries(names.map(r => [`itok:${r}`, 'inst-token'])), ...seed }), {
    HOSTING_ACCOUNT_ID: cf.account, HOSTING_API_TOKEN: cf.token, HOSTING_SUBDOMAIN: 'kiln-sites',
  });
  env.KILN.map.set('csess:tok', JSON.stringify({ account_id: 'acct-1', login: 'ada', uid: 42, gh: 'gho_x' }));   // a session that knows GitHub's number for ada
  names.forEach((r, i) => addSite(env, { id: `s${i + 1}`, repo: r, origin: `https://${r.split('/')[1]}.example`, plan: 'managed', status: 'trialing', ...site }));
  const w = { gh: ghs[names[0]], ghs, cf, env, out, shut: new Set(shut) };
  w.handler = async (url, init) => {
    if (url.startsWith(`${RELEASE}/`)) { const f = w.out[url.slice(RELEASE.length + 1)]; return f ? new Response(f) : undefined; }
    const hit = await cf.handler(url, init);
    if (hit) return hit;
    for (const r of names) {
      if (!url.startsWith(`https://api.github.com/repos/${r}`)) continue;
      if (w.shut.has(r) && init.method === 'PATCH' && url.includes('/git/refs/heads/')) return new Response(JSON.stringify(REFUSED), { status: 422, headers: { 'Content-Type': 'application/json' } });
      return ghs[r].handler(url, init);
    }
    return undefined;
  };
  return w;
}
const ask = (env, method, pathname, body) => worker.fetch(new Request(`https://worker.example${pathname}`, {
  method, headers: { Authorization: 'Bearer tok', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
}), env);
const switchOn = (env, id = 's1') => ask(env, 'POST', '/cloud/sites/hosting', { id });
const siteRow = (env, id = 's1') => env.kiln_cloud.row('SELECT prepared_at, prepared_commit, firstpass_at, firstpass_commit FROM sites WHERE id = ?', id);
const hosted = (env, id = 's1') => env.kiln_cloud.row('SELECT * FROM hosting WHERE site_id = ?', id);
const served = (w, path, id = 's1') => w.cf.serve(hosted(w.env, id).name, path)?.bytes.toString() ?? null;
const states = (lines) => lines.map(l => [l.step, l.state]);
const sweep = (env) => worker.scheduled({}, env);
const commitsMade = (calls) => calls.filter(c => c.method === 'POST' && /\/git\/commits$/.test(c.url));
/** Run `fn` and hand back every line it sent to console.warn, parsed. */
async function warnings(fn) {
  const real = console.warn; const lines = [];
  console.warn = (s) => { try { lines.push(JSON.parse(s)); } catch { lines.push({ text: String(s) }); } };
  try { await fn(); } finally { console.warn = real; }
  return lines;
}
/**
 * If `after` is exactly `before` with one run of characters put in, every run
 * that could have been (the same change can be read as starting at more than
 * one place when the run repeats what is next to it). Otherwise none.
 */
function oneInsertion(before, after) {
  const added = after.length - before.length;
  const runs = [];
  for (let at = 0; added > 0 && at <= before.length; at++) {
    if (after.slice(0, at) + after.slice(at + added) === before) runs.push(after.slice(at, at + added));
    if (before[at] !== after[at]) break;
  }
  return runs;
}

// ─── The character set, as a function of a page ───────────────────────────────

test('charset: a page that names none gets the line first in its head, and every other byte stays as it was', () => {
  const cases = {
    'head on its own line': ['<!doctype html>\n<html>\n<head>\n  <title>T</title>\n</head>\n<body>é</body>\n</html>\n', `<head>\n  ${CHARSET_TAG}\n  <title>`],
    'tabs and Windows line ends': ['<html>\r\n<head>\r\n\t<title>T</title>\r\n</head>\r\n</html>\r\n', `<head>\r\n\t${CHARSET_TAG}\r\n\t<title>`],
    'all on one line': ['<!doctype html><html><head><title>T</title></head><body></body></html>', `<head>${CHARSET_TAG}<title>`],
    'capitals and attributes': ['<HTML><HEAD profile="x">\n<TITLE>T</TITLE></HEAD></HTML>', `<HEAD profile="x">\n${CHARSET_TAG}\n<TITLE>`],
    'an empty line after the head tag': ['<head>\n\n  <title>T</title></head>', `<head>${CHARSET_TAG}\n\n  <title>`],
    'a charset that is only in a comment': ['<head>\n  <!-- <meta charset="utf-8"> -->\n  <title>T</title>\n</head>', `<head>\n  ${CHARSET_TAG}\n  <!-- <meta`],
    'a head tag in a comment before the real one': ['<!-- <head> --><html><head><title>T</title></head></html>', `--><html><head>${CHARSET_TAG}<title>`],
    'a header further down': ['<head><title>T</title></head><body><header>Top</header></body>', `<head>${CHARSET_TAG}<title>`],
  };
  for (const [why, [html, expected]] of Object.entries(cases)) {
    const out = withCharset(html);
    assert.equal(out.state, 'added', why);
    assert.ok(out.html.includes(expected), `${why}: ${out.html}`);
    assert.ok(oneInsertion(html, out.html).some(run => run.endsWith(CHARSET_TAG) && run.slice(0, -CHARSET_TAG.length).trim() === ''), `${why}: one insertion, of the line and white space before it`);
    assert.equal(out.html.split(CHARSET_TAG).length, html.split(CHARSET_TAG).length + 1, `${why}: the line goes in once`);
    assert.equal(withCharset(out.html).state, 'already', `${why}: asking twice changes nothing`);
    assert.equal(withCharset(out.html).html, out.html, why);
  }
});

test('charset: a page that names one, in any of the three ways, is left alone, and so is a page with no head', () => {
  const named = {
    'meta charset': '<html><head><meta charset="utf-8"><title>T</title></head></html>',
    'meta charset, another one, unquoted, in capitals': '<html><head><title>T</title>\n<META CHARSET=windows-1252></head></html>',
    'the older http-equiv line': '<html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"><title>T</title></head></html>',
    'http-equiv with single quotes and the attributes the other way round': "<head><meta content='text/html; charset=ISO-8859-1' http-equiv='content-type'></head>",
    'a byte order mark at the very top': '﻿<!doctype html><html><head><title>T</title></head></html>',
  };
  for (const [why, html] of Object.entries(named)) assert.deepEqual(withCharset(html), { html, state: 'already' }, why);
  for (const html of ['<!doctype html><h1>No head at all</h1>', '<html><body><header>Only a header</header></body></html>', '<!-- <head> -->\n<p>Only in a comment</p>', '']) {
    assert.deepEqual(withCharset(html), { html, state: 'no-head' }, html);
  }
  // The sentences of this step are its own where adding Kiln's would say the wrong thing.
  assert.match(charsetSentence('protected', { repo: 'ada/club', branch: 'main' }), /could not add the line to its pages\. Nothing was changed\.$/);
  assert.match(charsetSentence('built', { generator: 'Astro' }), /built by Astro/);
  assert.match(charsetSentence('no_access'), /not installed on that repository yet/);
  assert.equal(charsetSentence('github'), 'GitHub did not answer just now, so the pages were left as they are.', 'this step has no button to press again');
  for (const code of ['built', 'too_big', 'protected', 'moved', 'github']) assert.doesNotMatch(charsetSentence(code), /—/);
});

// ─── When a site is first put on Kiln's hosting ───────────────────────────────

test('look after: a plain site put on hosting gets Kiln, a character set and a first pass, each as a commit in the owner\'s name, and the first copy holds them', { skip: d1Skip }, async () => {
  const w = world();
  const before = w.gh.head();
  await withFetch(w.handler, async (calls) => {
    const res = await switchOn(w.env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.deepEqual(states(body.looked_after), [['kiln', 'done'], ['charset', 'done'], ['marks', 'done']]);
    const [kiln, charset, marks] = body.looked_after;
    // Three commits, one on the other, and the site is made from the last.
    assert.deepEqual(w.gh.commits.get(kiln.commit.sha).parents, [before]);
    assert.deepEqual(w.gh.commits.get(charset.commit.sha).parents, [kiln.commit.sha]);
    assert.deepEqual(w.gh.commits.get(marks.commit.sha).parents, [charset.commit.sha]);
    assert.equal(w.gh.head(), marks.commit.sha);
    assert.equal(body.hosting.state, 'live');
    assert.equal(body.hosting.commit, marks.commit.sha);
    assert.equal(kiln.commit.url, `https://github.com/ada/club/commit/${kiln.commit.sha}`);
    for (const line of body.looked_after) {
      assert.deepEqual(w.gh.commits.get(line.commit.sha).author.name, 'ada', line.step);
      assert.equal(w.gh.commits.get(line.commit.sha).author.email, '42+ada@users.noreply.github.com', line.step);
      assert.match(line.detail, /^[A-Z0-9].*\.$/s, 'a sentence');
      assert.doesNotMatch(line.detail, /—/);
    }
    assert.match(kiln.detail, /Kiln added its files to ada\/club, and 2 pages now load the editor\./);
    assert.equal(charset.detail, '2 pages now say which character set they are written in, so every letter shows as it should.');
    assert.match(marks.detail, /first pass of what can be edited on 2 pages/);
    assert.match(w.gh.commits.get(charset.commit.sha).message, /^Say which character set each page is written in\n\n2 pages now say they are written in UTF-8 [\s\S]* Added for ada when the site went on Kiln's hosting \(via Kiln\)$/);
    assert.equal(commitsMade(calls).length, 3);

    // What the site's record says is what the two buttons would have written.
    const rec = siteRow(w.env);
    assert.equal(rec.prepared_commit, kiln.commit.sha);
    assert.equal(rec.firstpass_commit, marks.commit.sha);
    assert.ok(rec.prepared_at > 0 && rec.firstpass_at > 0);

    // The dashboard can ask again later, and is told the same.
    const standing = await (await ask(w.env, 'GET', '/cloud/sites/hosting?site=s1')).json();
    assert.deepEqual(standing.looked_after, body.looked_after);
    const me = await (await ask(w.env, 'GET', '/cloud/me')).json();
    assert.deepEqual(me.sites[0].looked_after, body.looked_after);
    assert.ok(me.sites[0].prepared_at > 0 && me.sites[0].firstpass_at > 0);
  });
  // The repository, and so the first copy, holds all three.
  const home = w.gh.read('index.html');
  assert.ok(home.includes(`<head>\n  ${CHARSET_TAG}\n  <title>Home</title>`));
  for (const tag of KILN_TAGS) assert.ok(home.includes(tag), tag);
  assert.match(home, /<h1 [^>]*data-cms/);
  assert.equal(served(w, '/index.html'), home);
  assert.equal(served(w, '/about.html'), w.gh.read('about.html'));
  assert.equal(served(w, '/assets/kiln.js'), editor('r2'));
  assert.ok(served(w, '/kiln.html').includes('kiln.js'));
  assert.equal(w.gh.read('assets/site.css'), 'h1{}');
  // Kept for the dashboard for thirty days, and nothing is left locked.
  const days = (w.env.KILN.expires.get('hostcare:s1') - Date.now() / 1000) / 86400;
  assert.ok(days > 29.9 && days <= 30, `kept for ${days} days`);
  assert.equal(await w.env.KILN.get('carelock:s1'), null);
  assert.equal(await w.env.KILN.get('hostlock:s1'), null);
});

test('look after: a site that already has all three gets no commit', { skip: d1Skip }, async () => {
  const w = world({ 'ada/club': lookedAfterSite() });
  const before = w.gh.head();
  await withFetch(w.handler, async (calls) => {
    const res = await switchOn(w.env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(states(body.looked_after), [['kiln', 'nothing'], ['charset', 'nothing'], ['marks', 'nothing']]);
    assert.deepEqual(body.looked_after.map(l => l.detail), [
      'Kiln was already on this site.',
      'Every page already says which character set it is written in.',
      'Kiln found nothing more to mark as editable on this site.',
    ]);
    assert.equal(body.looked_after.some(l => l.commit), false);
    assert.deepEqual(githubWrites(calls), [], 'the repository is only read');
    assert.equal(calls.some(c => c.url.startsWith(RELEASE)), false, 'and nothing is fetched from the release');
    assert.equal(body.hosting.state, 'live');
    assert.equal(body.hosting.commit, before);
  });
  assert.equal(w.gh.head(), before);
  // It is on record that there was nothing to do, as the buttons record it.
  const rec = siteRow(w.env);
  assert.ok(rec.prepared_at > 0 && rec.firstpass_at > 0);
  assert.equal(rec.prepared_commit, null);
  assert.equal(rec.firstpass_commit, null);

  // A site whose first pass is on record is not marked again, whatever its pages hold.
  const once = world({ 'ada/club': { 'index.html': withKilnTags(withCharset(page('Home')).html).html, ...kilnFiles('r1') } });
  once.env.kiln_cloud.exec("UPDATE sites SET firstpass_at = 5 WHERE id = 's1'");
  await withFetch(once.handler, async (calls) => {
    const body = await (await switchOn(once.env)).json();
    assert.deepEqual(states(body.looked_after), [['kiln', 'nothing'], ['charset', 'nothing'], ['marks', 'nothing']]);
    assert.match(body.looked_after[2].detail, /was already made on this site/);
    assert.deepEqual(githubWrites(calls), []);
  });
  assert.doesNotMatch(once.gh.read('index.html'), /data-cms/);
});

test('look after: pages that name a character set are left as they are, and a page with no head is named and left alone', { skip: d1Skip }, async () => {
  const kept = {
    'meta.html': '<!doctype html><html><head><meta charset="utf-8"><title>M</title></head><body><p>é</p></body></html>\n',
    'equiv.html': '<!doctype html><html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"><title>E</title></head><body><p>é</p></body></html>\n',
    'bom.html': '﻿<!doctype html><html><head><title>B</title></head><body><p>é</p></body></html>\n',
    'nohead.html': '<!doctype html><body><p>No head here.</p></body>\n',
  };
  const tagged = Object.fromEntries(Object.entries(kept).map(([p, html]) => [p, withKilnTags(html).html]));
  const w = world({ 'ada/club': { ...tagged, 'index.html': withKilnTags(page('Home')).html, ...kilnFiles('r1') } });
  w.env.kiln_cloud.exec("UPDATE sites SET firstpass_at = 5 WHERE id = 's1'");
  await withFetch(w.handler, async (calls) => {
    const body = await (await switchOn(w.env)).json();
    assert.deepEqual(states(body.looked_after), [['kiln', 'nothing'], ['charset', 'done'], ['marks', 'nothing']]);
    const charset = body.looked_after[1];
    assert.deepEqual(charset.left, ['nohead.html']);
    assert.equal(charset.detail, '1 page now says which character set it is written in, so every letter shows as it should. 1 page has no <head> and was left as it is: nohead.html.');
    assert.equal(commitsMade(calls).length, 1);
    assert.equal(body.hosting.state, 'live');
  });
  for (const [p, html] of Object.entries(tagged)) assert.equal(w.gh.read(p), html, `${p} is as it was`);
  assert.equal(w.gh.read('bom.html').charCodeAt(0), 0xFEFF);
  assert.ok(oneInsertion(withKilnTags(page('Home')).html, w.gh.read('index.html')).includes(`\n  ${CHARSET_TAG}`), 'the one page that named none has the line and nothing else new');
  assert.equal(served(w, '/nohead.html'), tagged['nohead.html']);

  // With nothing else to do, the step says it could not be done for that page, and writes nothing.
  const only = world({ 'ada/club': { 'index.html': tagged['nohead.html'], 'meta.html': tagged['meta.html'], ...kilnFiles('r1') } });
  only.env.kiln_cloud.exec("UPDATE sites SET firstpass_at = 5 WHERE id = 's1'");
  await withFetch(only.handler, async (calls) => {
    const body = await (await switchOn(only.env)).json();
    const charset = body.looked_after[1];
    assert.deepEqual([charset.state, charset.code, charset.left], ['not_done', 'no_head', ['index.html']]);
    assert.match(charset.detail, /^1 page has no <head> and was left as it is: index\.html\. /);
    assert.deepEqual(githubWrites(calls), []);
    assert.equal(body.hosting.state, 'live');
  });
});

test('look after: a step that cannot be done is reported and does not stop the site from being put up', { skip: d1Skip }, async () => {
  // A branch that takes no direct change: nothing is written, the site goes up as it is.
  const w = world({ 'ada/club': plain }, { shut: ['ada/club'] });
  const before = w.gh.head();
  const logged = await warnings(() => withFetch(w.handler, async (calls) => {
    const res = await switchOn(w.env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.hosting.state, 'live');
    assert.deepEqual(body.looked_after.map(l => [l.step, l.state, l.code]), [['kiln', 'not_done', 'protected'], ['charset', 'not_done', 'protected'], ['marks', 'not_done', 'protected']]);
    assert.match(body.looked_after[0].detail, /The main branch of ada\/club does not take a direct change \(it is protected\), so Kiln could not add itself\./);
    assert.match(body.looked_after[1].detail, /so Kiln could not add the line to its pages\./);
    assert.equal(body.looked_after.some(l => l.commit), false);
    assert.equal(calls.filter(c => c.method === 'PATCH').length, 1, 'the branch is asked once, not once a step');
  }));
  assert.equal(w.gh.head(), before);
  assert.equal(served(w, '/index.html'), plain['index.html']);
  assert.deepEqual(logged.filter(l => l.evt === 'lookafter_failed').map(l => [l.step, l.repo, l.code]), [['kiln', 'ada/club', 'protected']]);
  const rec = siteRow(w.env);
  assert.equal(rec.prepared_at, null);
  assert.equal(rec.firstpass_at, null);

  // Kiln's own files out of reach: that step is not done, the other two are.
  const r = world({ 'ada/club': plain }, { out: {} });
  await warnings(() => withFetch(r.handler, async () => {
    const body = await (await switchOn(r.env)).json();
    assert.deepEqual(body.looked_after.map(l => [l.step, l.state, l.code]), [['kiln', 'not_done', 'release'], ['charset', 'done', undefined], ['marks', 'done', undefined]]);
    assert.match(body.looked_after[0].detail, /could not fetch its own editor files just now/);
    assert.equal(body.hosting.state, 'live');
    assert.equal(body.hosting.commit, r.gh.head());
  }));
  assert.ok(served(r, '/index.html').includes(CHARSET_TAG));
  assert.equal(r.gh.read('assets/kiln.js'), null);
  assert.equal(siteRow(r.env).prepared_at, null);
  assert.ok(siteRow(r.env).firstpass_at > 0);

  // A repository with no pages: every step says so once, and hosting says what it says today.
  const e = world({ 'ada/club': { 'README.md': '# soon' } });
  await withFetch(e.handler, async (calls) => {
    const body = await (await switchOn(e.env)).json();
    assert.deepEqual(body.looked_after.map(l => [l.step, l.state, l.code]), [['kiln', 'not_done', 'no_pages'], ['charset', 'not_done', 'no_pages'], ['marks', 'not_done', 'no_pages']]);
    assert.equal(body.code, 'no_home');
    assert.equal(body.hosting.state, 'waiting');
    assert.deepEqual(githubWrites(calls), []);
  });

  // While one look-after runs, a second press is told to wait and does nothing.
  const b = world();
  await b.env.KILN.put('carelock:s1', '1');
  await withFetch(b.handler, async (calls) => {
    const res = await switchOn(b.env);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, 'busy');
    assert.deepEqual(calls.filter(c => c.url.includes('cloudflare') || c.method !== 'GET'), []);
  });
});

test('look after: publishing a site that is already up does not repeat the steps', { skip: d1Skip }, async () => {
  const w = world();
  await withFetch(w.handler, async (calls) => {
    const first = await (await switchOn(w.env)).json();
    assert.deepEqual(states(first.looked_after), [['kiln', 'done'], ['charset', 'done'], ['marks', 'done']]);
    // The owner adds a page by hand, then presses Publish again.
    w.gh.commit({ 'news.html': page('News') });
    const n = calls.length;
    const res = await switchOn(w.env);
    assert.equal(res.status, 200);
    const again = await res.json();
    assert.equal(again.hosting.state, 'live');
    assert.equal('looked_after' in again, false);
    assert.deepEqual(githubWrites(calls.slice(n)), []);
    assert.equal(calls.slice(n).some(c => c.url.startsWith(RELEASE)), false);
    // What was done the first time is still what the dashboard is told.
    assert.deepEqual((await (await ask(w.env, 'GET', '/cloud/sites/hosting?site=s1')).json()).looked_after, first.looked_after);
  });
  assert.equal(w.gh.read('news.html'), page('News'));
  assert.equal(served(w, '/news.html'), page('News'));
});

// ─── Keeping the editor current ───────────────────────────────────────────────

/** Three paid, hosted, live sites whose editor is r1, looked at by the sweep in the order s1, s2, s3. */
async function fleet(n = 3, opts = {}) {
  const repos = ['ada/one', 'ada/two', 'ada/three'].slice(0, n);
  const w = world(Object.fromEntries(repos.map(r => [r, lookedAfterSite('r1', r)])), { site: { status: 'active', ls_subscription_id: '77' }, ...opts });
  await withFetch(w.handler, async () => { for (let i = 1; i <= n; i++) assert.equal((await switchOn(w.env, `s${i}`)).status, 200); });
  for (let i = 1; i <= n; i++) w.env.kiln_cloud.exec('UPDATE hosting SET checked_at = ? WHERE site_id = ?', i, `s${i}`);
  w.editors = () => repos.map(r => w.ghs[r].read('assets/kiln.js').match(/KILN_VERSION="(\w+)"/)[1]);
  w.waiting = () => [...w.env.KILN.map.keys()].filter(k => k.startsWith('hostupd:')).sort();
  return w;
}
const knownFor = (w, stamp, hours) => w.env.KILN.put(`eseen:${stamp}`, String(Date.now() - hours * HOUR));

test('editor: hosted sites take a released editor once it has been known for a day, two sites a run, as a commit by Kiln itself', { skip: d1Skip }, async () => {
  const w = await fleet();
  await withFetch(w.handler, async (calls) => {
    // The release is new to this service: nothing is looked at, only the time is noted.
    await sweep(w.env);
    assert.deepEqual(w.editors(), ['r1', 'r1', 'r1']);
    assert.deepEqual(githubWrites(calls), []);
    assert.deepEqual(w.waiting(), []);
    const noted = Number(await w.env.KILN.get('eseen:r2'));
    assert.ok(Date.now() - noted < 60 * 1000, 'the first sight of r2 is on record');
    // Twenty-three hours on, still nothing.
    await knownFor(w, 'r2', 23);
    const seen = await w.env.KILN.get('eseen:r2');
    await sweep(w.env);
    assert.deepEqual(w.editors(), ['r1', 'r1', 'r1']);
    assert.deepEqual(githubWrites(calls), []);
    assert.equal(await w.env.KILN.get('eseen:r2'), seen, 'the first sight is never moved');

    // A day on: two sites this run.
    await knownFor(w, 'r2', 25);
    const n = calls.length;
    await sweep(w.env);
    assert.deepEqual(w.editors(), ['r2', 'r2', 'r1']);
    assert.deepEqual(w.waiting(), ['hostupd:s1', 'hostupd:s2']);
    const hours = (w.env.KILN.expires.get('hostupd:s1') - Date.now() / 1000) / 3600;
    assert.ok(hours > 23.9 && hours <= 24, `a site is not looked at again for ${hours} hours`);
    // The commit names no person, so GitHub records it as the Kiln app's own.
    const made = commitsMade(calls.slice(n));
    assert.equal(made.length, 2);
    for (const c of made) {
      assert.equal('author' in c.body, false);
      assert.equal('committer' in c.body, false);
      assert.match(c.body.message, /^Update the Kiln editor\n\nThe editor's files are now version r2 \(they were version r1\)\. Updated by Kiln itself, which keeps the editor current on a site it hosts\.$/);
    }
    assert.equal(w.ghs['ada/one'].read('assets/kiln-editor.js'), '/* editor r2 */\n');
    assert.equal(w.ghs['ada/one'].read('assets/kiln-config.js'), kilnConfigFile({ repo: 'ada/one', branch: 'main', worker: 'https://worker.example' }), 'the site\'s settings are its own');
    assert.equal(w.ghs['ada/one'].read('index.html'), ready(page('Home')));
    // The same run's look at each repository publishes what moved.
    assert.equal(served(w, '/assets/kiln.js', 's1'), editor('r2'));
    assert.equal(served(w, '/assets/kiln.js', 's2'), editor('r2'));
    assert.equal(served(w, '/assets/kiln.js', 's3'), editor('r1'));
    assert.deepEqual(JSON.parse(await w.env.KILN.get('erepo:ada/one')).build, 'r2');

    // The next run takes the third, and the one after that has nothing to do.
    await sweep(w.env);
    assert.deepEqual(w.editors(), ['r2', 'r2', 'r2']);
    const m = calls.length;
    await sweep(w.env);
    assert.deepEqual(githubWrites(calls.slice(m)), []);
    assert.equal(calls.slice(m).some(c => c.url.startsWith(RELEASE)), false, 'with every site looked at today, the release is not even asked about');
  });
});

test('editor: one site is looked at once a day, and an editor released since the last look waits its own day', { skip: d1Skip }, async () => {
  const w = await fleet(2);
  await withFetch(w.handler, async (calls) => {
    await sweep(w.env);
    await knownFor(w, 'r2', 25);
    await sweep(w.env);
    assert.deepEqual(w.editors(), ['r2', 'r2']);
    // r3 comes out, and a day goes by for it, but both sites were looked at today.
    w.out = release('r3');
    await knownFor(w, 'r3', 25);
    const n = calls.length;
    await sweep(w.env);
    await sweep(w.env);
    assert.deepEqual(w.editors(), ['r2', 'r2']);
    assert.deepEqual(githubWrites(calls.slice(n)), []);
    // A day after it was last looked at, a site is looked at again.
    await w.env.KILN.delete('hostupd:s1');
    await sweep(w.env);
    assert.deepEqual(w.editors(), ['r3', 'r2']);

    // r4 comes out an hour after the service last read the release: the site
    // that is looked at finds it, and leaves it until it has been known a day.
    w.out = release('r4');
    await w.env.KILN.delete('hostupd:s2');
    const m = calls.length;
    await sweep(w.env);
    assert.deepEqual(w.editors(), ['r3', 'r2']);
    assert.deepEqual(githubWrites(calls.slice(m)), []);
    assert.ok(Date.now() - Number(await w.env.KILN.get('eseen:r4')) < 60 * 1000);
    assert.deepEqual(w.waiting(), ['hostupd:s1', 'hostupd:s2']);
  });
});

test('editor: a site that cannot be updated is logged and does not stop the next one, and a site that may not be edited is left alone', { skip: d1Skip }, async () => {
  const w = await fleet(3, { shut: ['ada/one'] });
  w.env.kiln_cloud.exec("UPDATE sites SET status = 'canceled', ls_subscription_id = NULL WHERE id = 's3'");
  await knownFor(w, 'r2', 25);
  const logged = await warnings(() => withFetch(w.handler, async () => { await sweep(w.env); }));
  assert.deepEqual(w.editors(), ['r1', 'r2', 'r1']);
  const line = logged.find(l => l.evt === 'hosting_editor_not_updated');
  assert.deepEqual([line.repo, line.reason], ['ada/one', 'protected']);
  // The one that failed is tried again tomorrow, not every five minutes.
  assert.deepEqual(w.waiting(), ['hostupd:s1', 'hostupd:s2']);
  await warnings(() => withFetch(w.handler, async (calls) => {
    await sweep(w.env);
    assert.deepEqual(githubWrites(calls), []);
  }));
  assert.deepEqual(w.editors(), ['r1', 'r2', 'r1'], 's3 may not be edited, so its repository is not touched');

  // GitHub not answering for one repository, and no editor at all in another.
  const g = await fleet(2);
  g.ghs['ada/two'].commit({ 'assets/kiln.js': null });
  await knownFor(g, 'r2', 25);
  g.ghs['ada/one'].failOn((method, path) => method === 'GET' && path.startsWith('/git/trees/'));
  const lines = await warnings(() => withFetch(g.handler, async () => { await sweep(g.env); }));
  assert.deepEqual(lines.filter(l => l.evt === 'hosting_editor_not_updated').map(l => [l.repo, l.reason]), [['ada/one', 'github']]);
  assert.equal(g.ghs['ada/one'].read('assets/kiln.js'), editor('r1'));
});
