/**
 * Find & replace across the site (src/editor/find-replace.js, used by the
 * Find & replace tool in main.js; the commit is commitFiles in src/github.js).
 *
 * The service counts a signed-in person's requests, 120 to the minute. The
 * tool read every page once for its preview and then sent every page with a
 * match in a request of its own before committing: up to 2N + 6 requests for
 * N pages, so a site of more than about 57 pages was told to wait part-way.
 * It now asks N + 7, as the Site menu tool does (test/menu-save.test.js), and
 * these tests hold it to one commit that is all or nothing, and to what it
 * finds and replaces being exactly what it found and replaced before.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  findEverywhere, replaceEverywhere, findPages, findReplaceRequests, countMatches, replaceAll, changedSinceText, FIND_PAGES_MAX,
} from '../src/editor/find-replace.js';
import { getFile, commitFiles, encodeContent } from '../src/github.js';

const main = readFileSync(new URL('../src/editor/main.js', import.meta.url), 'utf8');
const REPO = 'acme/site';
const page = (n, words = 'Call 404-555-0100 or 404-555-0100.') => `<!doctype html>\n<html><head><title>Page ${n}</title></head><body>\n<p data-cms="p${n}">${words}</p>\n</body></html>\n`;
const site = (n, quiet = () => false) => Object.fromEntries(Array.from({ length: n }, (_, i) =>
  [i ? `pages/p${i}.html` : 'index.html', quiet(i) ? page(i, 'Nothing to see.') : page(i)]));
const shaOf = (text) => createHash('sha1').update(text).digest('hex');

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
      if (method === 'GET' && /\/git\/trees\/main\?recursive=1$/.test(path)) {
        return { tree: [...live()].map(([p, text]) => ({ type: 'blob', path: p, sha: shaOf(text) })).concat([{ type: 'tree', path: 'pages', sha: 'dir' }]) };
      }
      if (method === 'GET' && (m = /\/contents\/(.+)\?ref=main/.exec(path))) { const text = live().get(decodeURIComponent(m[1])); return { content: encodeContent(text), sha: shaOf(text) }; }
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
  /** Somebody else publishes a page: a commit of their own on the branch. */
  const publish = (path, text) => { const next = new Map(live()); next.set(path, text); const t = `t${++n}`; trees.set(t, next); const c = `c${++n}`; commits.set(c, { tree: t }); head = c; };
  return { gh, calls, live, head: () => head, commits, publish, refuseWhen(fn) { refuse = fn; } };
}
const FIND = '404-555-0100', REPL = '470-555-0199';
const find = (repo, extra = {}) => findEverywhere({ gh: repo.gh, repo: REPO, branch: 'main', find: FIND, getFile, ...extra });
const replace = (repo, hits) => replaceEverywhere({ gh: repo.gh, repo: REPO, branch: 'main', hits, find: FIND, repl: REPL, commitFiles });

test('find & replace: sixty pages, every one with a match, take N + 7 requests and one commit', async () => {
  const repo = fakeRepo(site(60));
  const steps = [];
  const { pages, hits } = await find(repo, { onStep: s => steps.push(`${s.done}/${s.of}`) });
  assert.equal(pages, 60);
  assert.equal(hits.length, 60);
  assert.equal(repo.calls.length, 61, 'one listing and one read of each page, for the preview');
  assert.deepEqual([steps[0], steps[59]], ['1/60', '60/60']);
  const { changed, commit } = await replace(repo, hits);
  assert.equal(repo.calls.length, findReplaceRequests(60));
  assert.equal(findReplaceRequests(60), 67, 'it was 126: over the 120 the service allows in a minute');
  assert.ok(findReplaceRequests(FIND_PAGES_MAX) < 120, 'the most pages it ever searches fit in a minute');
  assert.equal(repo.calls.filter(c => /\/git\/blobs$/.test(c.path)).length, 0, 'no page is sent in a request of its own');
  assert.equal(repo.calls.filter(c => c.method === 'POST' && /\/git\/commits$/.test(c.path)).length, 1, 'one commit');
  assert.equal(repo.head(), commit.sha);
  assert.equal(repo.commits.get(commit.sha).message, 'Replace “404-555-0100” → “470-555-0199” on 60 pages (via Kiln)');
  assert.equal(changed.length, 60);
  for (const [path, text] of repo.live()) {
    assert.equal(countMatches(text, FIND), 0, path);
    assert.equal(countMatches(text, REPL), 2, path);
  }
});

test('find & replace: it finds what it found before, and changes only the pages with a match', async () => {
  const repo = fakeRepo({ ...site(6, i => i % 2 === 1), 'notes.txt': 'Call 404-555-0100', 'assets/app.js': '"404-555-0100"' });
  const before = new Map(repo.live());
  const { pages, hits } = await find(repo);
  assert.equal(pages, 6, 'web pages only');
  assert.deepEqual(hits.map(h => `${h.path}:${h.count}`), ['index.html:2', 'pages/p2.html:2', 'pages/p4.html:2']);
  const { changed } = await replace(repo, hits);
  assert.deepEqual(changed.map(c => c.path), ['index.html', 'pages/p2.html', 'pages/p4.html']);
  for (const [path, text] of repo.live()) {
    if (changed.some(c => c.path === path)) assert.equal(text, before.get(path).split(FIND).join(REPL), path);
    else assert.equal(text, before.get(path), `${path} is as it was`);
  }
  // as written: capitals count, and so do characters that mean something to a pattern
  assert.equal(countMatches('Tea. tea. TEA.', 'tea'), 1);
  assert.equal(countMatches('a.b a.b axb', 'a.b'), 2);
  assert.equal(replaceAll('$5 and $5', '$5', '$&'), '$& and $&');
  assert.equal(replaceAll('<p>one</p>', 'one', ''), '<p></p>');
});

test('find & replace: a refusal at any point leaves every page as it was (all or nothing)', async () => {
  // during the preview's reads
  let repo = fakeRepo(site(14));
  let before = new Map(repo.live());
  repo.refuseWhen(({ nth }) => nth === 6);
  await assert.rejects(find(repo), e => e.status === 429 && e.data.code === 'too_often');
  assert.deepEqual([...repo.live()], [...before]);
  assert.equal(repo.calls.filter(c => c.method !== 'GET').length, 0, 'nothing was written');
  // at each request of the replace itself: the second listing, then the five of the commit
  for (let at = 1; at <= 6; at++) {
    repo = fakeRepo(site(14));
    before = new Map(repo.live());
    const { hits } = await find(repo);
    const done = repo.calls.length;
    repo.refuseWhen(({ nth }) => nth === done + at);
    await assert.rejects(replace(repo, hits), e => e.status === 429, `refused at request ${at} of the replace`);
    assert.equal(repo.head(), 'c0', `refused at request ${at}: the branch has not moved`);
    assert.deepEqual([...repo.live()], [...before]);
  }
});

test('find & replace: a page somebody published after the preview does not get its older words back', async () => {
  const repo = fakeRepo(site(5));
  const { hits } = await find(repo);
  const newer = page(2, 'New words, published while the preview was on the screen. Call 404-555-0100.');
  repo.publish('pages/p2.html', newer);
  const head = repo.head();
  const writes = repo.calls.filter(c => c.method !== 'GET').length;
  await assert.rejects(replace(repo, hits), e => {
    assert.deepEqual(e.changedSince, ['pages/p2.html']);
    assert.equal(e.message, 'Nothing was replaced. pages/p2.html has been changed since the matches were found. Press “Preview matches” again, then replace.');
    return true;
  });
  assert.equal(repo.head(), head);
  assert.equal(repo.live().get('pages/p2.html'), newer);
  assert.equal(repo.calls.filter(c => c.method !== 'GET').length, writes, 'nothing was written');
  // previewed again, it goes through, on the newer words
  const again = await find(repo);
  await replace(repo, again.hits);
  assert.equal(repo.live().get('pages/p2.html'), newer.split(FIND).join(REPL));
  assert.equal(changedSinceText(['a.html', 'b.html', 'c.html', 'd.html', 'e.html']), 'Nothing was replaced. a.html, b.html, c.html and 2 more have been changed since the matches were found. Press “Preview matches” again, then replace.');
});

test('find & replace: only web pages are searched, a hundred at the most', () => {
  const tree = { tree: [{ type: 'blob', path: 'index.html', sha: 'a' }, { type: 'tree', path: 'blog', sha: 'b' }, { type: 'blob', path: 'style.css', sha: 'c' },
    ...Array.from({ length: 150 }, (_, i) => ({ type: 'blob', path: `blog/p${i}.html`, sha: `s${i}` }))] };
  const pages = findPages(tree);
  assert.equal(pages.length, FIND_PAGES_MAX);
  assert.deepEqual(pages[0], { path: 'index.html', sha: 'a' });
  assert.deepEqual(findPages(null), []);
});

test('find & replace: the tool in the editor works through this, and says what it said before', () => {
  const panel = main.slice(main.indexOf('function findReplacePanel()'), main.indexOf('// ─── Drafts (kiln-drafts branch)'));
  assert.match(panel, /await findEverywhere\(\{ gh: state\.gh, repo: cfg\.repo, branch, find, getFile,/);
  assert.match(panel, /await replaceEverywhere\(\{ gh: state\.gh, repo: cfg\.repo, branch, hits, find, repl, commitFiles \}\)/);
  assert.equal(/getFile\(state\.gh/.test(panel), false, 'no page is read anywhere else');
  assert.equal(/await commitFiles\(/.test(panel), false, 'and none is saved anywhere else');
  // the same handling as the Site menu tool when the service says to wait
  assert.match(panel, /stopped\(err, 'replaced', typedIn\(m\)\) \|\| notDone\('Nothing was replaced\.', err\)/);
  assert.match(panel, /stopped\(err, '', typedIn\(m\)\) \|\| notDone\('The pages could not be searched\.', err\)/);
  for (const said of ['Scanning every page…', 'Scanning… ${done}/${of}', 'No matches for “${find}”.', 'Replace all (1 commit)', 'Committing…']) assert.ok(panel.includes(said), said);
  // a second preview takes the first one's "Replace all" away with it
  assert.match(panel, /m\.querySelectorAll\('\.kiln-fr-act'\)\.forEach\(old => old\.remove\(\)\);/);
  assert.match(panel, /if \(err\.changedSince\) \{ status\.textContent = changedSinceText\(err\.changedSince\); act\.remove\(\); out\.innerHTML = ''; return; \}/);
});
