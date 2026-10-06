/**
 * The demo's History (src/editor/tryout.js): this browser's publishes, with
 * the two ways back a real site offers. The demo's menu had no History at
 * all, and the guide's promise "You can't break the site for good" could not
 * be seen there. Also held here: the demo's menu is the menu of a real site,
 * each item opening its own dialog.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { historyEntry, withEntry, undoChanges, goBackChanges, partVersions, HISTORY_MAX, DEMO_HISTORY_EMPTY, DEMO_HISTORY_NOTE, demoSays } from '../src/editor/tryout.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const main = readFileSync(path.join(ROOT, 'src', 'editor', 'main.js'), 'utf8');
const part = (from, to) => main.slice(main.indexOf(from), main.indexOf(to, main.indexOf(from) + from.length));

/** A page as the demo publishes it: each publish is the staged edits and what they replaced. */
function demo() {
  const page = { hero: 'Soft shirts.', sub: 'The six.', pic: { src: '/img/a.jpg', alt: 'Six tees' } };
  let entries = [];
  let n = 0;
  return {
    page,
    get entries() { return entries; },
    publish(edits) {
      const pending = new Map(Object.entries(edits));
      const entry = historyEntry({ id: `p${++n}`, ts: n * 1000, message: `Edit index.html: ${[...pending.keys()].join(', ')} (via Kiln)`, pending,
        baseHtml: (key) => (typeof page[key] === 'string' ? page[key] : undefined),
        baseAttr: (key, name) => page[key]?.[name] });
      entries = withEntry(entries, entry);
      for (const [key, v] of pending) {
        if (v.html !== undefined) page[key] = v.html;
        if (v.attrs) page[key] = { ...page[key], ...v.attrs };
      }
      return entry;
    },
    apply(changes) {
      for (const c of changes) {
        if (c.value !== undefined) page[c.key] = c.value;
        if (c.attrs) page[c.key] = { ...page[c.key], ...c.attrs };
      }
    },
  };
}

test('demo history: a publish is kept as what it replaced, and can be undone on its own', () => {
  const d = demo();
  const first = d.publish({ hero: { html: 'First.' } });
  assert.deepEqual(first, { id: 'p1', ts: 1000, message: 'Edit index.html: hero (via Kiln)', before: { hero: { html: 'Soft shirts.' } } });
  assert.deepEqual(undoChanges(first), [{ key: 'hero', value: 'Soft shirts.' }]);
  // it goes through JSON on its way into the browser's storage
  assert.deepEqual(JSON.parse(JSON.stringify(first)), first);
});

test('demo history: publish twice, and the first one can be had back', () => {
  const d = demo();
  d.publish({ hero: { html: 'First.' } });
  d.publish({ hero: { html: 'Second.' } });
  assert.equal(d.page.hero, 'Second.');
  // "Go back to this" on the first publish: the page as it was right after it
  const back = goBackChanges(d.entries, 0);
  assert.deepEqual(back, [{ key: 'hero', value: 'First.' }]);
  d.apply(back);
  assert.equal(d.page.hero, 'First.');
  // on the newest there is nothing later to take back
  assert.deepEqual(goBackChanges(d.entries, d.entries.length - 1), []);
});

test('demo history: going back reaches over several publishes and leaves other parts alone', () => {
  const d = demo();
  d.publish({ hero: { html: 'One.' } });                              // 0
  d.publish({ sub: { html: 'Sub two.' } });                           // 1
  d.publish({ hero: { html: 'Three.' }, sub: { html: 'Sub three.' } }); // 2
  d.publish({ hero: { html: 'Four.' } });                             // 3
  // back to right after publish 1: hero as publish 0 left it, sub as publish 1 left it
  const back = goBackChanges(d.entries, 1);
  assert.deepEqual(back.sort((a, b) => a.key.localeCompare(b.key)), [{ key: 'hero', value: 'One.' }, { key: 'sub', value: 'Sub two.' }]);
  // back to right after publish 2 touches the hero only
  assert.deepEqual(goBackChanges(d.entries, 2), [{ key: 'hero', value: 'Three.' }]);
  // undoing publish 2 alone puts back what it found, whatever came later
  assert.deepEqual(undoChanges(d.entries[2]).sort((a, b) => a.key.localeCompare(b.key)), [{ key: 'hero', value: 'One.' }, { key: 'sub', value: 'Sub two.' }]);
});

test('demo history: a swapped picture comes back too, and an attribute that was not there is left out', () => {
  const d = demo();
  const swap = d.publish({ pic: { attrs: { src: 'data:image/webp;base64,AAAA', alt: 'A new picture', style: 'width:50%' } } });
  // src and alt were there before; style was not, so there is nothing to put back for it
  assert.deepEqual(swap.before, { pic: { attrs: { src: '/img/a.jpg', alt: 'Six tees' } } });
  assert.deepEqual(undoChanges(swap), [{ key: 'pic', attrs: { src: '/img/a.jpg', alt: 'Six tees' } }]);
  d.publish({ pic: { attrs: { src: 'data:image/webp;base64,BBBB' } } });
  // back to after the first swap: the first new picture, with the description it had
  assert.deepEqual(goBackChanges(d.entries, 0), [{ key: 'pic', attrs: { src: 'data:image/webp;base64,AAAA' } }]);
  // a publish that only added an attribute changes nothing that can be put back
  const d2 = demo();
  const only = d2.publish({ pic: { attrs: { style: 'width:50%' } } });
  assert.deepEqual(undoChanges(only), []);
});

test('demo history: one part\'s versions, newest first, down to what it was before the first publish', () => {
  const d = demo();
  d.publish({ hero: { html: 'First.' } });
  d.publish({ sub: { html: 'Sub two.' } });
  d.publish({ hero: { html: 'Second.' } });
  assert.deepEqual(partVersions(d.entries, 'hero', d.page.hero), [{ ts: 3000, value: 'Second.' }, { ts: 1000, value: 'First.' }, { ts: null, value: 'Soft shirts.' }]);
  assert.deepEqual(partVersions(d.entries, 'sub', d.page.sub), [{ ts: 2000, value: 'Sub two.' }, { ts: null, value: 'The six.' }]);
  // never published: no versions
  assert.deepEqual(partVersions(d.entries, 'pic', undefined), []);
  assert.deepEqual(partVersions([], 'hero', 'Soft shirts.'), []);
  // published back to what it was: the same words twice in a row are one version
  d.publish({ hero: { html: 'Second.' } });
  assert.equal(partVersions(d.entries, 'hero', d.page.hero).filter(v => v.value === 'Second.').length, 1);
});

test('demo history: it keeps the last twenty publishes of a page', () => {
  let entries = [];
  for (let i = 0; i < HISTORY_MAX + 5; i++) entries = withEntry(entries, { id: `p${i}`, ts: i, message: '', before: {} });
  assert.equal(entries.length, HISTORY_MAX);
  assert.equal(entries[0].id, 'p5');
  assert.equal(entries[entries.length - 1].id, `p${HISTORY_MAX + 4}`);
  assert.deepEqual(withEntry(undefined, { id: 'a' }), [{ id: 'a' }]);
});

test('demo history: what it says is plain', () => {
  for (const text of [DEMO_HISTORY_EMPTY, DEMO_HISTORY_NOTE]) {
    assert.equal(/!|[—–]|\s-\s/.test(text), false, text);
    assert.equal(/commit|Git|repo\b|branch/i.test(text), false, text);
  }
});

test('demo history: a publish in the demo goes into it, and "Published. Undo" takes it out again', () => {
  const publish = part('function publishSandbox(', '\n}\n');
  assert.match(publish, /historyEntry\(\{ id: /);
  assert.match(publish, /if \(entry\) s\.history\[sandboxPath\(\)\] = withEntry\(earlier, entry\);/);
  assert.match(publish, /historyId: entry\?\.id/);
  const undo = part('function undoSandboxPublish(', '\n}\n');
  assert.match(undo, /s\.history\[sandboxPath\(\)\]\.filter\(e => e\.id !== rec\.historyId\)/);
});

test('demo history: History, and one section\'s clock, list the demo\'s publishes', () => {
  const panel = part('async function historyPanel(', '\n}\n');
  assert.match(panel, /if \(cfg\.sandbox\) \{ demoHistory\(m\); return; \}/);
  const demoPanel = part('function demoHistory(', '\n}\n');
  assert.match(demoPanel, /undoChanges\(pub\)/);
  assert.match(demoPanel, /goBackChanges\(entries, at\)/);
  assert.match(demoPanel, /previewRestore\(todo, label, ''\)/);
  const clock = part('async function fieldHistoryPanel(', '\nfunction histPreview(');
  assert.match(clock, /partVersions\(store\.history\?\.\[sandboxPath\(\)\] \|\| \[\], key, /);
  // the two sentences that said the demo keeps no history are gone
  assert.equal(/The demo doesn’t keep saved (versions|history)/.test(main), false);
});

test('demo menu: the items a real site\'s menu has are shown in the demo', () => {
  // they were in the page and hidden by one rule
  const hidden = (main.match(/\[data-kiln-sandbox\] #kiln-[a-z]+/g) || []).map(s => s.split('#')[1]).sort();
  assert.deepEqual(hidden, ['kiln-comments', 'kiln-signout']);
  // People & access is drawn for the owner, and for the demo
  assert.equal((main.match(/mode === 'admin' \|\| cfg\.sandbox \? '<button id="kiln-invite"/g) || []).length, 2);
});

test('demo menu: each of those dialogs says the demo\'s sentence where it would act, and asks nothing of a site', () => {
  const says = (fn, end, item) => {
    const body = part(fn, end);
    const at = body.indexOf(`demoSays('${item}')`);
    assert.ok(at !== -1, `${fn} says it`);
    return { body, at };
  };
  // new page: before the form is put away and the repository is asked
  let d = says('function newContent()', '\n}\n', 'newpage');
  assert.ok(d.at < d.body.indexOf('getFile(state.gh'), 'new page');
  d = says('function pageSettingsPanel()', '\n}\n', 'pagesettings');
  assert.ok(d.at < d.body.indexOf('editFile(state.gh'), 'page settings');
  d = says('function menuEditor()', '\n}\n', 'menu');
  assert.ok(d.at < d.body.indexOf("state.gh.request('GET'"), 'site menu');
  d = says('function findReplacePanel()', '\n}\n', 'findreplace');
  assert.ok(d.at < d.body.indexOf("state.gh.request('GET'"), 'find and replace');
  d = says('async function invitePanel()', '\n}\n\n// ─── History', 'people');
  assert.ok(d.at < d.body.indexOf('await ask(`/admin/people'), 'people');
  // the list of pages People offers comes from the page itself in the demo
  const pages = part('async function listSitePages()', '\n}\n');
  assert.ok(pages.indexOf('if (cfg.sandbox) {') !== -1 && pages.indexOf('if (cfg.sandbox) {') < pages.indexOf("state.gh.request('GET'"));
  for (const item of ['newpage', 'pagesettings', 'menu', 'findreplace', 'people']) assert.match(demoSays(item), /^(Nothing|Nobody) is \w+ in the demo\. On a real site, /);
});
