/**
 * Saving the site menu to every page (src/editor/menu-save.js, used by the
 * Site menu tool in main.js; the commit is commitFiles in src/github.js).
 *
 * A tester's save stopped at "Updating menus… 4/14" with "too much was asked
 * of the site just now". The count on the screen was of pages being READ:
 * nothing had been written, and nothing was. The save was already one commit;
 * what refused it was the service's count of requests, which the save used up
 * by itself (2N + 6 requests for N pages). It now asks N + 6, and these tests
 * hold it to one commit that is all or nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { saveMenuEverywhere, menuPages, menuSaveRequests, menuStepText, MENU_PAGES_MAX } from '../src/editor/menu-save.js';
import { getFile, commitFiles, encodeContent } from '../src/github.js';
import { applyEdits } from '../src/engine.js';
import { editorEnv, withFetch, call, jsonRes, REPO } from './worker-harness.js';

const main = readFileSync(new URL('../src/editor/main.js', import.meta.url), 'utf8');
const pageHtml = (n, extra = '') => `<!doctype html>\n<html><head><title>Page ${n}</title></head><body>\n<nav data-cms-menu="main">\n  <a href="/">Home</a>\n</nav>\n<p>Words on page ${n}.</p>${extra}\n</body></html>\n`;
const NEW_MENU = '\n  <a href="/">Home</a>\n  <a href="/visit.html">Visit us</a>\n';
const site = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [i ? `pages/p${i}.html` : 'index.html', pageHtml(i)]));

/** A repository as the editor's requests see it: files, trees, commits and the branch, all in memory. */
function fakeRepo(files) {
  const calls = [];
  const trees = new Map([['t0', new Map(Object.entries(files))]]);
  const commits = new Map([['c0', { tree: 't0' }]]);
  let head = 'c0', n = 0, refuse = null;
  const live = () => trees.get(commits.get(head).tree);
  const gh = {
    async request(method, path, body) {
      calls.push({ method, path, body });
      if (refuse && refuse({ method, path, nth: calls.length })) {
        throw Object.assign(new Error('GitHub 429: '), { status: 429, data: { error: 'Too much was asked of the Kiln service from here in the last minute. Please wait a minute, then try again.', code: 'too_often', retry_after: 60 } });
      }
      let m;
      if (method === 'GET' && /\/git\/trees\/main\?recursive=1$/.test(path)) return { tree: [...live().keys()].map(p => ({ type: 'blob', path: p })).concat([{ type: 'tree', path: 'pages' }]) };
      if (method === 'GET' && (m = /\/contents\/(.+)\?ref=main/.exec(path))) return { content: encodeContent(live().get(decodeURIComponent(m[1]))), sha: `blob-${m[1]}` };
      if (method === 'GET' && /\/git\/ref\/heads%2Fmain$/.test(path)) return { object: { sha: head } };
      if (method === 'GET' && (m = /\/git\/commits\/(\w+)$/.exec(path))) return { tree: { sha: commits.get(m[1]).tree } };
      if (method === 'POST' && /\/git\/trees$/.test(path)) {
        const next = new Map(trees.get(body.base_tree));
        for (const e of body.tree) next.set(e.path, e.content);
        const sha = `t${++n}`; trees.set(sha, next); return { sha };
      }
      if (method === 'POST' && /\/git\/commits$/.test(path)) { const sha = `c${++n}`; commits.set(sha, { tree: body.tree, parents: body.parents, message: body.message }); return { sha }; }
      if (method === 'PATCH' && /\/git\/refs\/heads%2Fmain$/.test(path)) { head = body.sha; return {}; }
      throw Object.assign(new Error(`unexpected ${method} ${path}`), { status: 500 });
    },
  };
  return { gh, calls, live, head: () => head, commits, refuseWhen(fn) { refuse = fn; } };
}
const save = (repo, onStep) => saveMenuEverywhere({ gh: repo.gh, repo: 'o/r', branch: 'main', menuKey: 'main', newInner: NEW_MENU, getFile, applyEdits, commitFiles, onStep });
const writes = (repo) => repo.calls.filter(c => c.method !== 'GET');

test('menu: fourteen pages are saved as one commit, in N + 6 requests, and every page then has the new menu', async () => {
  const repo = fakeRepo({ ...site(14), 'assets/site.css': 'body{}', 'README.md': '# site' });
  const before = new Map(repo.live());
  const steps = [];
  const out = await save(repo, (s) => steps.push(menuStepText(s)));
  assert.equal(out.changed.length, 14);
  assert.equal(out.skipped, 0);
  // One commit, on top of what was there, and the branch moved once, to it.
  assert.deepEqual(writes(repo).map(c => `${c.method} ${c.path.replace('/repos/o/r', '')}`), ['POST /git/trees', 'POST /git/commits', 'PATCH /git/refs/heads%2Fmain']);
  assert.equal(repo.commits.size, 2);
  assert.equal(repo.head(), out.commit.sha);
  assert.deepEqual(repo.commits.get(repo.head()).parents, ['c0']);
  assert.equal(repo.commits.get(repo.head()).message, 'Update menu on 14 pages (via Kiln)');
  // No request per page on the way out: no blob each, no file written one at a time.
  assert.equal(repo.calls.filter(c => /\/git\/blobs|\/contents\//.test(c.path) && c.method !== 'GET').length, 0);
  assert.equal(repo.calls.length, menuSaveRequests(14));
  assert.equal(menuSaveRequests(14), 20);
  // Every page has the new menu and is otherwise byte for byte what it was; other files are untouched.
  for (const [path, text] of repo.live()) {
    if (!path.endsWith('.html')) { assert.equal(text, before.get(path)); continue; }
    assert.ok(text.includes('<a href="/visit.html">Visit us</a>'), path);
    assert.equal(text, before.get(path).replace('\n  <a href="/">Home</a>\n', NEW_MENU), path);
  }
  assert.deepEqual([steps[0], steps[5], steps.at(-1)], ['Step 1 of 3 · Finding the site’s pages…', 'Step 1 of 3 · Reading the site’s pages… 5/14', 'Saving the menu on 14 pages as one change…']);
});

test('menu: a refusal at any point leaves every page as it was (all or nothing)', async () => {
  const stops = {
    'while the fifth page is read': ({ method, path }) => method === 'GET' && path.includes('/contents/pages/p4.html'),
    'when the files are listed': ({ path }) => path.includes('/git/trees/main'),
    'when the new files are handed over': ({ method, path }) => method === 'POST' && path.endsWith('/git/trees'),
    'when the commit is made': ({ method, path }) => method === 'POST' && path.endsWith('/git/commits'),
    'when the branch is moved': ({ method }) => method === 'PATCH',
  };
  for (const [when, fn] of Object.entries(stops)) {
    const repo = fakeRepo(site(14));
    const before = new Map(repo.live());
    repo.refuseWhen(fn);
    await assert.rejects(save(repo), (err) => err.status === 429 && err.data.retry_after === 60, when);
    assert.equal(repo.head(), 'c0', when);
    assert.deepEqual([...repo.live()], [...before], `${when}: the site is as it was`);
    for (const text of repo.live().values()) assert.ok(!text.includes('Visit us'), when);
  }
  // Stopped while reading (what the tester saw at 4/14): nothing at all had been sent to be written.
  const repo = fakeRepo(site(14));
  repo.refuseWhen(stops['while the fifth page is read']);
  await assert.rejects(save(repo));
  assert.equal(writes(repo).length, 0);
});

test('menu: a page without the menu is left alone, and a site where no page has it gets no commit', async () => {
  const repo = fakeRepo({ ...site(3), 'plain.html': '<!doctype html><html><body><p>No menu here.</p></body></html>' });
  const out = await save(repo);
  assert.deepEqual([out.changed.length, out.skipped], [3, 1]);
  assert.equal(repo.live().get('plain.html'), '<!doctype html><html><body><p>No menu here.</p></body></html>');
  assert.equal(repo.commits.get(repo.head()).message, 'Update menu on 3 pages (via Kiln)');

  const none = fakeRepo({ 'a.html': '<html><body><p>a</p></body></html>', 'b.html': '<html><body><p>b</p></body></html>' });
  assert.deepEqual(await save(none), { changed: [], skipped: 2, same: 0, commit: null });
  assert.equal(writes(none).length, 0);
});

test('menu: a large site goes over in a few requests of about a megabyte, still as one commit', async () => {
  const filler = `<p>${'x'.repeat(400 * 1024)}</p>`;
  const repo = fakeRepo(Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`p${i}.html`, pageHtml(i, filler)])));
  const out = await save(repo);
  const trees = repo.calls.filter(c => c.method === 'POST' && c.path.endsWith('/git/trees'));
  assert.equal(trees.length, 3, 'two pages of 400 KB to a request');
  for (const t of trees) assert.ok(JSON.stringify(t.body).length < 1.2 * 1024 * 1024);
  assert.deepEqual(trees.map(t => t.body.base_tree), ['t0', 't1', 't2'], 'each built on the one before');
  assert.equal(repo.calls.filter(c => c.method === 'POST' && c.path.endsWith('/git/commits')).length, 1);
  assert.equal(repo.calls.filter(c => c.method === 'PATCH').length, 1);
  assert.equal(out.changed.length, 6);
  for (const text of repo.live().values()) assert.ok(text.includes('Visit us'));
});

test('menu: only web pages are looked at, a hundred at the most', () => {
  const tree = { tree: [{ type: 'blob', path: 'index.html' }, { type: 'tree', path: 'blog.html' }, { type: 'blob', path: 'site.css' }, { type: 'blob', path: '_templates/page.html' },
    ...Array.from({ length: 150 }, (_, i) => ({ type: 'blob', path: `p/${i}.html` }))] };
  const pages = menuPages(tree);
  assert.equal(pages.length, MENU_PAGES_MAX);
  assert.deepEqual(pages.slice(0, 2), ['index.html', '_templates/page.html'], 'a page template carries the menu too, so new pages start with it');
  assert.deepEqual(menuPages(null), []);
});

test('menu: commitFiles without the option still sends each file by itself, as "new post" expects', async () => {
  const repo = fakeRepo(site(2));
  const sent = [];
  const gh = { request: async (method, path, body) => { if (method === 'POST' && path.endsWith('/git/blobs')) { sent.push(body); return { sha: `b${sent.length}` }; } return repo.gh.request(method, path, body && Array.isArray(body.tree) ? { ...body, tree: body.tree.map(e => ({ ...e, content: 'x' })) } : body); } };
  await commitFiles(gh, 'o/r', 'main', [{ path: 'a.html', text: '<p>a</p>' }, { path: 'pic.png', base64: 'AAAA' }], 'two files');
  assert.equal(sent.length, 2);
  // With the option, a picture still goes by itself (it is not text) and the page rides in the tree.
  sent.length = 0;
  await commitFiles(gh, 'o/r', 'main', [{ path: 'a.html', text: '<p>a</p>' }, { path: 'pic.png', base64: 'AAAA' }], 'two files', { inlineText: true });
  assert.deepEqual(sent, [{ content: 'AAAA', encoding: 'base64' }]);
});

test('menu: the Site menu tool saves through this, and its lines are plain', () => {
  const tool = main.slice(main.indexOf("m.querySelector('#kiln-menu-save').onclick"), main.indexOf('// ─── People & access (admin only)'));
  assert.match(tool, /await saveMenuEverywhere\(\{/);
  assert.doesNotMatch(tool, /putFile\(|editFile\(/, 'no page is written by itself');
  assert.doesNotMatch(main, /Updating menus/);
  for (const step of [{ step: 'finding' }, { step: 'reading', done: 3, of: 14 }, { step: 'committing', pages: 1 }, { step: 'committing', pages: 14 }]) {
    assert.doesNotMatch(menuStepText(step), /—|\bcommit/i);
  }
  assert.equal(menuStepText({ step: 'committing', pages: 1 }), 'Saving the menu on 1 page as one change…');
});

test('menu: the service takes an invited editor\'s pages inside the tree request, and still refuses a file an editor may not write', async () => {
  const env = editorEnv();
  await withFetch((url, init) => (url.endsWith('/git/trees') && init.method === 'POST' ? jsonRes({ sha: 'newtree' }, 201) : undefined), async (calls) => {
    const tree = [{ path: 'index.html', mode: '100644', type: 'blob', content: pageHtml(0) }, { path: 'about.html', mode: '100644', type: 'blob', content: pageHtml(1) }];
    const ok = await call(env, 'POST', `/gh/repos/${REPO}/git/trees`, { body: { base_tree: 'abc', tree } });
    assert.equal(ok.status, 201);
    assert.deepEqual(calls.at(-1).body.tree, tree, 'handed to GitHub as sent');
    const sent = calls.length;
    const bad = await call(env, 'POST', `/gh/repos/${REPO}/git/trees`, { body: { base_tree: 'abc', tree: [...tree, { path: '.github/workflows/x.yml', mode: '100644', type: 'blob', content: 'on: push' }] } });
    assert.equal(bad.status, 403);
    assert.equal(calls.length, sent, 'nothing reached GitHub');
  });
});
