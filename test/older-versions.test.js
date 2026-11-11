import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { commitPager, commitsPageUrl, addPartRows, VERSIONS_PER_PAGE } from '../src/editor/older-versions.js';

// A fake transport: a file with `total` commits, newest first, paged the way
// GitHub pages them (per_page, page), with a failure that can be switched on.
function fakeTransport(total) {
  const all = Array.from({ length: total }, (_, i) => ({ sha: `c${total - i}`, commit: { message: `publish ${total - i}` } }));
  const calls = [];
  const t = {
    calls, all, failNext: false,
    async request(method, url) {
      calls.push(url);
      if (t.failNext) { t.failNext = false; const e = new Error('Bad gateway'); e.status = 502; throw e; }
      const q = new URL(url, 'https://x').searchParams;
      const per = Number(q.get('per_page')); const page = Number(q.get('page') || 1);
      return all.slice((page - 1) * per, page * per);
    },
  };
  return t;
}

test('the page url asks for one page of the file’s commits', () => {
  assert.equal(commitsPageUrl('acme/site', 'about us.html', 3), '/repos/acme/site/commits?path=about%20us.html&per_page=20&page=3');
});

test('older versions are reached page by page until GitHub sends fewer than a full page', async () => {
  const gh = fakeTransport(47);
  const p = commitPager(gh, 'acme/site', 'index.html');
  const a = await p.next(); assert.equal(a.length, 20); assert.equal(p.done, false);
  const b = await p.next(); assert.equal(b.length, 20); assert.equal(p.done, false);
  const c = await p.next(); assert.equal(c.length, 7); assert.equal(p.done, true);
  assert.equal(c.at(-1).sha, 'c1', 'the very first publish is reached');
  assert.deepEqual(await p.next(), []);
  assert.equal(gh.calls.length, 3);
  assert.match(gh.calls[1], /&page=2$/);
});

test('a page of exactly 20 versions asks once more, and an empty answer ends the list', async () => {
  const gh = fakeTransport(20);
  const p = commitPager(gh, 'acme/site', 'index.html');
  assert.equal((await p.next()).length, 20); assert.equal(p.done, false);
  assert.equal((await p.next()).length, 0); assert.equal(p.done, true);
});

test('pressing twice while a page loads asks GitHub only once', async () => {
  const gh = fakeTransport(45);
  const p = commitPager(gh, 'acme/site', 'index.html');
  await p.next();
  const [x, y] = await Promise.all([p.next(), p.next()]);
  assert.equal(x, y);
  assert.equal(gh.calls.length, 2);
});

test('a failed page can be tried again and asks for the same page', async () => {
  const gh = fakeTransport(30);
  const p = commitPager(gh, 'acme/site', 'index.html');
  await p.next();
  gh.failNext = true;
  await assert.rejects(p.next());
  assert.equal(p.loading, false);
  const again = await p.next();
  assert.equal(again.length, 10);
  assert.match(gh.calls[1], /&page=2$/); assert.match(gh.calls[2], /&page=2$/);
});

test('a version already listed is not listed twice when a new publish moves the pages along', async () => {
  const gh = fakeTransport(25);
  const p = commitPager(gh, 'acme/site', 'index.html');
  await p.next();
  // Someone publishes while History is open: every commit moves one place down.
  gh.all.unshift({ sha: 'c26' });
  const older = await p.next();
  assert.deepEqual(older.map(c => c.sha), ['c5', 'c4', 'c3', 'c2', 'c1'], 'c6 was on the first page already');
});

test('a section’s history adds only the versions where it changed, across pages', () => {
  const rows = [];
  addPartRows(rows, [{ c: 1, v: 'b' }, { c: 2, v: 'b' }, { c: 3, v: 'a' }]);
  assert.deepEqual(rows.map(r => r.c), [1, 3]);
  const added = addPartRows(rows, [{ c: 4, v: 'a' }, { c: 5, v: undefined }, { c: 6, v: 'z' }]);
  assert.deepEqual(added.map(r => r.c), [6]);
  assert.deepEqual(rows.map(r => r.v), ['b', 'a', 'z']);
});

test('History in the editor no longer stops at one fixed page of versions', () => {
  const src = readFileSync(new URL('../src/editor/main.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /per_page=20`/);
  assert.doesNotMatch(src, /per_page=15`/);
  assert.match(src, /commitPager\(state\.gh/);
  assert.equal(VERSIONS_PER_PAGE, 20);
});
