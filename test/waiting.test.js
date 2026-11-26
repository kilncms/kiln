/**
 * Changes waiting on the pages of a site, read from the browser's storage
 * (src/editor/waiting.js): which pages, how many edits, how old, enough to
 * name a page and go to it; dropping one page; and how long a copy is kept.
 * The storage is played here, as the browser's would hold it: text under keys.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitingPages, waitingTotal, dropPage, keptFor, KEEP, pendingKey, restoreKey } from '../src/editor/waiting.js';
import { draftRecord, pageRecord, readDraft } from '../src/editor/saved-edits.js';

const NOW = Date.UTC(2026, 10, 26, 12);
const HOUR = 3600 * 1000, DAY = 24 * HOUR;
const REPO = 'acme/site';
const SHA = '3b18e512dba79e4c8300dd08aeb37f8e728b8dad';

/** The browser's storage, as far as the editor uses it. `blocked` makes every call throw, as a browser with storage turned off does. */
function storage(entries = {}, { blocked = false } = {}) {
  const m = new Map(Object.entries(entries));
  const guard = (fn) => (...a) => { if (blocked) throw new Error('storage is blocked'); return fn(...a); };
  return {
    get length() { if (blocked) throw new Error('storage is blocked'); return m.size; },
    key: guard((i) => [...m.keys()][i] ?? null),
    getItem: guard((k) => (m.has(k) ? m.get(k) : null)),
    setItem: guard((k, v) => { m.set(k, String(v)); }),
    removeItem: guard((k) => { m.delete(k); }),
    keys: () => [...m.keys()],
  };
}

/** A page's saved copy as the editor writes it: n edits to the page's own parts, last written `ago` before NOW. */
function copy(path, { n = 1, ago = 0, title = '', url = null, shown = null, facts = true } = {}) {
  const pending = new Map(Array.from({ length: n }, (_, i) => [`part_${i + 1}`, { html: `Words ${i + 1}` }]));
  const record = draftRecord(pending, new Map(), NOW - ago, null, shown);
  return JSON.stringify(facts ? pageRecord(record, { page: { path, url: url || '/' + path.replace(/(^|\/)index\.html$/, '$1'), title, sha: SHA }, more: { part_1: { was: 'Old words' } } }) : record);
}

const site = () => storage({
  [pendingKey(REPO, 'index.html')]: copy('index.html', { n: 2, ago: 2 * HOUR, title: 'Home' }),
  [pendingKey(REPO, 'de/about.html')]: copy('de/about.html', { n: 3, ago: 2 * DAY, title: 'Über uns', url: '/de/about' }),
  [pendingKey(REPO, 'menu/index.html')]: copy('menu/index.html', { n: 1, ago: 5 * 60 * 1000, title: 'Menu' }),
  // other things the same browser keeps
  kiln_guide: '1',
  kiln_editor: JSON.stringify({ session: 'a'.repeat(64), repo: REPO }),
  [pendingKey('acme/site2', 'index.html')]: copy('index.html', { n: 9 }),
  [pendingKey('other/site', 'about.html')]: copy('about.html', { n: 9 }),
});

test('waiting: the pages of this site with changes waiting, the most recently changed first', () => {
  const pages = waitingPages(site(), REPO, { now: NOW });
  assert.deepEqual(pages.map(p => p.at), ['menu/index.html', 'index.html', 'de/about.html']);
  assert.deepEqual(pages[2], {
    key: 'kiln_pending:acme/site:de/about.html', at: 'de/about.html', path: 'de/about.html', url: '/de/about', title: 'Über uns', sha: SHA,
    count: 3, ts: NOW - 2 * DAY, age: 2 * DAY, left: 5 * DAY, whole: true, restoring: false,
  });
  assert.deepEqual(pages.map(p => [p.title, p.url, p.count]), [['Menu', '/menu/', 1], ['Home', '/', 2], ['Über uns', '/de/about', 3]]);
  assert.deepEqual(waitingTotal(pages), { pages: 3, edits: 6 });
  assert.deepEqual(waitingTotal([]), { pages: 0, edits: 0 });
});

test('waiting: another repository is never read, even one whose name begins the same', () => {
  assert.deepEqual(waitingPages(site(), 'acme/site2', { now: NOW }).map(p => [p.at, p.count]), [['index.html', 9]]);
  assert.deepEqual(waitingPages(site(), 'acme', { now: NOW }), []);
  assert.deepEqual(waitingPages(site(), '', { now: NOW }), []);
  assert.deepEqual(waitingPages(site(), undefined, { now: NOW }), []);
});

test('waiting: the page that is open can be left out', () => {
  assert.deepEqual(waitingPages(site(), REPO, { now: NOW, except: ['index.html'] }).map(p => p.at), ['menu/index.html', 'de/about.html']);
  assert.deepEqual(waitingPages(site(), REPO, { now: NOW, except: 'menu/index.html' }).map(p => p.at), ['index.html', 'de/about.html']);
});

test('waiting: the count is the number the Publish button showed, as "Pick up where you left off?" says it', () => {
  // a picture and its description are two things on the button and one edit in the copy
  const s = storage({ [pendingKey(REPO, 'index.html')]: copy('index.html', { n: 1, shown: 2 }) });
  const [page] = waitingPages(s, REPO, { now: NOW });
  assert.equal(page.count, 2);
  assert.equal(page.count, readDraft(JSON.parse(s.getItem(page.key)), { now: NOW }).count);
});

test('waiting: a copy is listed for a week, or for 30 days by someone collecting changes across pages', () => {
  assert.equal(keptFor('one'), 7 * DAY);
  assert.equal(keptFor('together'), 30 * DAY);
  assert.equal(keptFor(undefined), 7 * DAY, 'not said: a week, as always');
  assert.equal(keptFor('forever'), 7 * DAY);
  assert.deepEqual(KEEP, { one: 7 * DAY, together: 30 * DAY });
  const s = storage({
    [pendingKey(REPO, 'a.html')]: copy('a.html', { ago: 7 * DAY }),
    [pendingKey(REPO, 'b.html')]: copy('b.html', { ago: 7 * DAY + 1 }),
    [pendingKey(REPO, 'c.html')]: copy('c.html', { ago: 30 * DAY }),
    [pendingKey(REPO, 'd.html')]: copy('d.html', { ago: 30 * DAY + 1 }),
  });
  assert.deepEqual(waitingPages(s, REPO, { now: NOW }).map(p => p.at), ['a.html']);
  assert.deepEqual(waitingPages(s, REPO, { now: NOW, keep: keptFor('one') }).map(p => [p.at, p.left]), [['a.html', 0]]);
  assert.deepEqual(waitingPages(s, REPO, { now: NOW, keep: keptFor('together') }).map(p => [p.at, p.left]), [['a.html', 23 * DAY], ['b.html', 23 * DAY - 1], ['c.html', 0]]);
  assert.equal(s.keys().length, 4, 'reading the list removes nothing');
});

test('waiting: a copy written by an editor from before is listed, named by its key', () => {
  const s = storage({
    [pendingKey(REPO, 'about.html')]: copy('about.html', { n: 2, ago: HOUR, facts: false }),
    // kept under the page's address, because its file was not known
    [pendingKey(REPO, '/contact/')]: copy('contact/index.html', { n: 1, ago: 2 * HOUR, facts: false }),
  });
  assert.deepEqual(waitingPages(s, REPO, { now: NOW }).map(p => ({ at: p.at, path: p.path, url: p.url, title: p.title, sha: p.sha, count: p.count, whole: p.whole })), [
    { at: 'about.html', path: 'about.html', url: null, title: '', sha: null, count: 2, whole: false },
    { at: '/contact/', path: null, url: '/contact/', title: '', sha: null, count: 1, whole: false },
  ]);
});

test('waiting: what cannot be read, or holds no edit, is not a page with changes waiting', () => {
  const s = storage({
    [pendingKey(REPO, 'broken.html')]: '{"ts":',
    [pendingKey(REPO, 'empty.html')]: JSON.stringify({ ts: NOW, edits: {} }),
    [pendingKey(REPO, 'text.html')]: 'null',
    [pendingKey(REPO, 'list.html')]: '[1,2]',
    [pendingKey(REPO, 'noedits.html')]: JSON.stringify({ ts: NOW, page: { path: 'noedits.html' } }),
    // only a note that was being typed when a sign-in ended: offered back on its page, and not a change to publish
    [pendingKey(REPO, 'typed.html')]: JSON.stringify(draftRecord(new Map(), new Map(), NOW, { where: 'note', text: 'Autumn menu' })),
    [pendingKey(REPO, '')]: copy('index.html'),
    [restoreKey(pendingKey(REPO, 'gone.html'))]: '{"sha":"x"}',
    [pendingKey(REPO, 'good.html')]: copy('good.html'),
  });
  assert.deepEqual(waitingPages(s, REPO, { now: NOW }).map(p => p.at), ['good.html']);
});

test('waiting: page facts that were tampered with are not used, and the key still names the page', () => {
  const tampered = (page, at = 'about.html') => {
    const record = JSON.parse(copy(at, { title: 'About us' }));
    record.page = page;
    return waitingPages(storage({ [pendingKey(REPO, at)]: JSON.stringify(record) }), REPO, { now: NOW })[0];
  };
  // facts that name another file are another page's: none of them is used
  let p = tampered({ path: 'admin/secret.html', url: '/admin/secret', title: 'Click me', sha: SHA });
  assert.deepEqual([p.path, p.url, p.title, p.sha, p.whole, p.count], ['about.html', null, '', null, false, 1]);
  // an address that leads off the site or runs something is dropped; the rest of the facts stand
  for (const url of ['javascript:alert(1)', 'https://elsewhere.example/', '//elsewhere.example/']) {
    p = tampered({ path: 'about.html', url, title: 'About us', sha: SHA });
    assert.deepEqual([p.path, p.url, p.title, p.whole], ['about.html', null, 'About us', true], url);
  }
  p = tampered('about.html');
  assert.deepEqual([p.path, p.title, p.whole], ['about.html', '', false]);
  // a copy with no time, or a time that is not one, has no age and is still listed (as it is still offered back on its page)
  const record = JSON.parse(copy('about.html'));
  for (const ts of [undefined, 'yesterday']) {
    [p] = waitingPages(storage({ [pendingKey(REPO, 'about.html')]: JSON.stringify({ ...record, ts }) }), REPO, { now: NOW });
    assert.deepEqual([p.ts, p.age, p.left], [null, null, null], String(ts));
    assert.ok(readDraft({ ...record, ts }, { now: NOW }), 'and its own page offers it back');
  }
  // a time of nothing reads as long ago: its own page does not offer it back, and it is not listed
  assert.equal(readDraft({ ...record, ts: null }, { now: NOW }), null);
  assert.deepEqual(waitingPages(storage({ [pendingKey(REPO, 'about.html')]: JSON.stringify({ ...record, ts: null }) }), REPO, { now: NOW }), []);
  // a time ahead of this browser's clock is no age at all, not a negative one
  [p] = waitingPages(storage({ [pendingKey(REPO, 'about.html')]: JSON.stringify({ ...record, ts: NOW + HOUR }) }), REPO, { now: NOW });
  assert.deepEqual([p.age, p.left], [0, 7 * DAY]);
});

test('waiting: a page where a whole-page restore waits as well is marked, since no copy holds the restore', () => {
  const s = site();
  s.setItem(restoreKey(pendingKey(REPO, 'index.html')), JSON.stringify({ sha: SHA }));
  assert.deepEqual(waitingPages(s, REPO, { now: NOW }).map(p => [p.at, p.restoring]), [['menu/index.html', false], ['index.html', true], ['de/about.html', false]]);
});

test('waiting: dropping one page removes its copy and its restore mark, and nothing else', () => {
  const s = site();
  s.setItem(restoreKey(pendingKey(REPO, 'index.html')), JSON.stringify({ sha: SHA }));
  s.setItem(restoreKey(pendingKey(REPO, 'menu/index.html')), JSON.stringify({ sha: SHA }));
  const before = s.keys();
  assert.equal(dropPage(s, REPO, 'index.html'), 'kiln_pending:acme/site:index.html', 'the key, for the pictures kept beside the copy');
  assert.deepEqual(s.keys(), before.filter(k => k !== pendingKey(REPO, 'index.html') && k !== restoreKey(pendingKey(REPO, 'index.html'))));
  assert.deepEqual(waitingPages(s, REPO, { now: NOW }).map(p => p.at), ['menu/index.html', 'de/about.html']);
  assert.equal(waitingPages(s, 'acme/site2', { now: NOW }).length, 1, 'the same page of another repository is still waiting');
  // nothing there to drop
  assert.equal(dropPage(s, REPO, 'index.html'), null);
  assert.equal(dropPage(s, REPO, 'never.html'), null);
  for (const at of ['', null, undefined, 7]) assert.equal(dropPage(s, REPO, at), null);
  assert.equal(dropPage(s, '', 'menu/index.html'), null);
  assert.equal(dropPage(null, REPO, 'menu/index.html'), null);
  assert.equal(s.keys().length, before.length - 2);
});

test('waiting: a browser that refuses storage has nothing waiting, and says so without an error', () => {
  const blocked = storage({ [pendingKey(REPO, 'index.html')]: copy('index.html') }, { blocked: true });
  assert.deepEqual(waitingPages(blocked, REPO, { now: NOW }), []);
  assert.equal(dropPage(blocked, REPO, 'index.html'), null);
  assert.deepEqual(waitingPages(null, REPO, { now: NOW }), []);
  assert.deepEqual(waitingPages({}, REPO, { now: NOW }), []);
});
