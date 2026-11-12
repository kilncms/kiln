/**
 * "Make this whole page editable" (src/editor/whole-page.js, and where
 * main.js and own-dialogs.js use it).
 *
 * Make-editable mode marked a page one click at a time. Its bar now also
 * offers the cautious first pass the setup tool and the dashboard make
 * (src/autotag.js), for the page that is open: asked about in the editor's own
 * dialog, checked to add nothing but marks, and saved as one change to this
 * one page by the same write Publish makes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  offersWholePage, wholePagePass, wholePageWrite, wholePageCopy, wholePageMessage, markedWords, marksIn, servesMarks,
  wholePageNote, fileIsBehind, WHOLE_PAGE_NOTE, WHOLE_PAGE_BUTTON, WHOLE_PAGE_SAVED, WHOLE_PAGE_RELOAD, WHOLE_PAGE_NOT_DONE, WHOLE_PAGE_WHY,
} from '../src/editor/whole-page.js';
import { autotag, onlyAddsMarks } from '../src/autotag.js';
import * as firstpass from '../worker/firstpass.js';
import { paragraphs } from '../src/editor/own-dialogs.js';
import { said, notDone } from '../src/editor/plain-failure.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (f) => readFileSync(path.join(ROOT, 'src', 'editor', f), 'utf8');
const main = read('main.js');

const PAGE = `<!doctype html>
<html><head><title>Bakery</title></head>
<body>
<header><nav><a href="/">Home</a><a href="/menu.html">Menu</a><a href="/about.html">About</a></nav></header>
<main>
  <section id="hero"><h1>Fresh bread daily</h1><p>Baked before sunrise, every day.</p><img src="/img/loaf.jpg" alt="A loaf"></section>
  <section id="team" class="cards">
    <div class="card"><h3>Ana</h3><p>Baker</p></div>
    <div class="card"><h3>Ben</h3><p>Counter</p></div>
    <div class="card"><h3>Cy</h3><p>Delivery</p></div>
  </section>
  <table><tr><td>Mon</td><td>8 to 4</td></tr></table>
  <form><button>Send</button></form>
</main>
</body></html>
`;

const here = { canMake: true, sandbox: false, sourceMode: false, sourceFields: false, path: 'index.html', sectionLimit: false };

test('the button is offered only where pressing it can work', () => {
  assert.equal(offersWholePage(here), true);
  assert.equal(offersWholePage({ ...here, path: 'blog/first-post.htm' }), true);
  // not this person's tool on this page (no grant, a suggest-only or comment-only seat, a page outside their paths)
  assert.equal(offersWholePage({ ...here, canMake: false }), false);
  // the demo has no file to save
  assert.equal(offersWholePage({ ...here, sandbox: true }), false);
  // a page built from content files: its marks are set in those files, not on the page
  assert.equal(offersWholePage({ ...here, sourceMode: true }), false);
  assert.equal(offersWholePage({ ...here, sourceFields: true }), false);
  assert.equal(offersWholePage({ ...here, path: '' }), false);
  assert.equal(offersWholePage({ ...here, path: 'src/content/about.md' }), false);
  // an editor limited to some parts of a page: the service would refuse marks outside them
  assert.equal(offersWholePage({ ...here, sectionLimit: true }), false);
  assert.equal(offersWholePage(), false);
});

test('the pass: what it would mark, and nothing but marks', () => {
  const pass = wholePagePass(PAGE);
  assert.equal(pass.state, 'ready');
  assert.deepEqual(pass.counts, autotag(PAGE).counts);
  assert.ok(pass.counts.fields > 0 && pass.counts.images === 1 && pass.counts.repeats === 1 && pass.counts.menu === 1);
  assert.equal(pass.html, autotag(PAGE).html);
  assert.equal(onlyAddsMarks(PAGE, pass.html), true);
  // tables, buttons and forms are left as they were
  assert.match(pass.html, /<table><tr><td>Mon<\/td><td>8 to 4<\/td><\/tr><\/table>/);
  assert.match(pass.html, /<form><button>Send<\/button><\/form>/);
  // a second pass finds nothing more
  assert.deepEqual(wholePagePass(pass.html), { state: 'nothing' });
  assert.deepEqual(wholePagePass('<p></p>'), { state: 'nothing' });
});

test('the check is the dashboard\'s own: one function, in src/autotag.js', () => {
  assert.equal(firstpass.onlyAddsMarks, onlyAddsMarks);
  assert.equal(onlyAddsMarks('<h1>Hi</h1>', '<h1 data-cms="title">Hi</h1>'), true);
  assert.equal(onlyAddsMarks('<h1>Hi</h1>', '<h1 data-cms="title">Ho</h1>'), false);
  assert.equal(onlyAddsMarks('<h1>Hi</h1>', '<h1 onclick="x()">Hi</h1>'), false);
});

test('at the moment of writing: worked out again on the file as it is then', () => {
  const agreed = wholePagePass(PAGE).counts;
  assert.deepEqual(wholePageWrite(PAGE, agreed), { html: autotag(PAGE).html });
  // someone changed a word meanwhile: the same marks, on their text
  const reworded = PAGE.replace('Fresh bread daily', 'Fresh bread, daily');
  const write = wholePageWrite(reworded, agreed);
  assert.equal(onlyAddsMarks(reworded, write.html), true);
  assert.match(write.html, /Fresh bread, daily/);
  // someone added a paragraph, or marked the page themselves: not what was agreed to, so nothing is written
  assert.deepEqual(wholePageWrite(PAGE.replace('<table>', '<p>One more line here.</p><table>'), agreed), { why: 'moved' });
  assert.deepEqual(wholePageWrite(autotag(PAGE).html, agreed), { why: 'moved' });
  for (const why of ['moved', 'unsafe']) {
    const line = notDone(WHOLE_PAGE_NOT_DONE, said(WHOLE_PAGE_WHY[why]));
    assert.match(line, /^Nothing on this page was marked\. .+\.$/);
  }
});

test('the question says how much, what is left alone, and how it is saved', () => {
  assert.equal(markedWords({ fields: 12, images: 3, repeats: 2, menu: 1 }), '12 pieces of text, 3 pictures, 2 lists of blocks and the menu');
  assert.equal(markedWords({ fields: 1, images: 1, repeats: 1, menu: 0 }), '1 piece of text, 1 picture and 1 list of blocks');
  assert.equal(markedWords({ fields: 4, images: 0, repeats: 0, menu: 0 }), '4 pieces of text');
  assert.equal(markedWords({ fields: 0, images: 0, repeats: 0, menu: 1 }), 'the menu');

  const ask = wholePageCopy('ask', { counts: { fields: 12, images: 3, repeats: 2, menu: 1 } });
  assert.equal(ask.title, 'Make this whole page editable?');
  assert.deepEqual([ask.cancel, ask.go], ['Cancel', 'Make them editable']);
  assert.equal(ask.risky, false);   // nothing is destroyed: the ordinary button, not the red one
  const words = ask.body.join(' ');
  assert.match(words, /Kiln will mark 12 pieces of text, 3 pictures, 2 lists of blocks and the menu on this page\./);
  assert.match(words, /add, remove and reorder the blocks/);
  assert.match(words, /leaves tables, buttons and forms alone, and anything that is already marked/);
  assert.match(words, /A visitor sees no difference\./);
  assert.match(words, /first pass\. Any part of it can be made plain again by clicking it in this same mode\./);
  assert.match(words, /saved at once as one change to this page, in your name\./);
  assert.match(words, /The page then reloads/);
  // no lists, no sentence about lists
  assert.doesNotMatch(wholePageCopy('ask', { counts: { fields: 2, images: 0, repeats: 0, menu: 0 } }).body.join(' '), /reorder/);
});

test('the notices: changes waiting, nothing to mark, and a pass that would do more than mark', () => {
  const waiting = wholePageCopy('unpublished');
  assert.match(waiting.title, /Publish or discard your changes first/);
  assert.match(waiting.body.join(' '), /saves the page at once/);
  const nothing = wholePageCopy('nothing');
  assert.equal(nothing.title, 'There is nothing more to mark on this page');
  const unsafe = wholePageCopy('unsafe');
  assert.equal(unsafe.title, 'Nothing was changed');
  assert.match(unsafe.body.join(' '), /left exactly as it is/);
  for (const c of [waiting, nothing, unsafe]) assert.equal(c.ok, 'OK');
  assert.throws(() => wholePageCopy('no-such'));
});

test('everything a person reads is plain: whole sentences, no dashes', () => {
  const read = [WHOLE_PAGE_BUTTON, WHOLE_PAGE_SAVED, WHOLE_PAGE_RELOAD, WHOLE_PAGE_NOT_DONE, ...Object.values(WHOLE_PAGE_WHY),
    wholePageMessage('index.html', { fields: 2, images: 1, repeats: 0, menu: 1 }),
    ...['unpublished', 'nothing', 'unsafe'].flatMap(k => { const c = wholePageCopy(k); return [c.title, ...c.body]; }),
    ...(() => { const c = wholePageCopy('ask', { counts: { fields: 2, images: 1, repeats: 1, menu: 1 } }); return [c.title, ...c.body, c.go, c.cancel]; })()];
  for (const line of read) assert.doesNotMatch(line, /[—–]| - /, line);
  for (const k of ['unpublished', 'nothing', 'unsafe']) for (const p of wholePageCopy(k).body) assert.match(p, /\.$/, p);
});

test('the commit message is in the style of the editor\'s others', () => {
  assert.equal(wholePageMessage('index.html', { fields: 12, images: 3, repeats: 1, menu: 1 }),
    'Mark a first pass of what can be edited on index.html: 12 pieces of text, 3 pictures, 1 list of blocks and the menu (via Kiln)');
});

test('the page is loaded again once the site serves it with the marks', () => {
  const saved = wholePagePass(PAGE).html;
  assert.ok(marksIn(saved) > marksIn(PAGE));
  assert.equal(servesMarks(PAGE, saved), false);            // the site has not rebuilt yet
  assert.equal(servesMarks(saved, saved), true);
  assert.equal(servesMarks(saved.replace(/\n\s*/g, '') + '<script src="/host.js"></script>', saved), true);   // a host that serves it a little differently
  assert.equal(servesMarks('', ''), false);
});

test('a dialog\'s words may be several short paragraphs, each escaped', () => {
  assert.equal(paragraphs('One.'), '<p class="kiln-dim">One.</p>');
  assert.equal(paragraphs(['One.', 'Two <b>.']), '<p class="kiln-dim">One.</p><p class="kiln-dim">Two &lt;b&gt;.</p>');
  assert.equal(paragraphs(undefined), '');
});

test('main.js: the bar offers it, the editor\'s own dialogs ask and tell, and Publish\'s write saves it', () => {
  const bar = main.slice(main.indexOf('function makeEditableMode()'), main.indexOf('function suggestKey('));
  assert.match(bar, /offersWholePageHere\(\) \? `<button id="kiln-pick-all"/);
  const flow = main.slice(main.indexOf('async function wholePage('), main.indexOf('function suggestKey('));
  assert.ok(flow.length > 200);
  // no box of the browser's
  assert.doesNotMatch(flow, /\b(confirm|alert|prompt)\(/);
  assert.match(flow, /tell\(modal, wholePageCopy\('unpublished'\)\)/);
  assert.match(flow, /askFirst\(modal, wholePageCopy\('ask', \{ counts: plan\.counts \}\)\)/);
  // the same write Publish makes for a page, with the check on the text that is written
  assert.match(flow, /await editFile\(state\.gh, cfg\.repo, path, branch, \(text\) => \{/);
  assert.match(flow, /wholePageWrite\(text, plan\.counts\)/);
  assert.match(flow, /notDone\(WHOLE_PAGE_NOT_DONE, err\)/);
  // the marks are not switched on in the page as it stands: the page is loaded again
  assert.match(flow, /location\.reload\(\)/);
  assert.doesNotMatch(flow, /applyAnnotationToDom|decorateField/);
  // not in the demo, not on a page from content files, not for an editor limited to parts of a page
  const offer = main.slice(main.indexOf('function offersWholePageHere()'), main.indexOf('function anythingUnpublished()'));
  assert.match(offer, /sandbox: !!cfg\.sandbox/);
  assert.match(offer, /sourceMode: cfg\.mode === 'source'/);
  assert.match(offer, /sectionLimit: mode === 'editor' && !!state\.scope\?\.keys\?\.length/);
});

// ── After the reload: the file the editor reads must be the one that was saved ──

test('across the reload the editor notes which file it wrote and how many marks it held, and reads again while the file is behind', () => {
  const before = '<main><h1 data-cms="t">A</h1><p>B</p><p>C</p></main>';
  const saved = '<main><h1 data-cms="t">A</h1><p data-cms="b">B</p><p data-cms="c">C</p></main>';
  const note = wholePageNote('about.html', saved);
  assert.deepEqual(JSON.parse(note), { path: 'about.html', marks: 3 });
  assert.equal(fileIsBehind(note, 'about.html', before), true, 'GitHub answered with the file as it was');
  assert.equal(fileIsBehind(note, 'about.html', saved), false, 'the file that was saved');
  assert.equal(fileIsBehind(note, 'about.html', saved.replace('<p data-cms="c">C</p>', '<p data-cms="c">C</p><p data-cms="d">D</p>')), false, 'someone has marked more since');
  assert.equal(fileIsBehind(note, 'index.html', before), false, 'a note about another page says nothing here');
  for (const none of [null, undefined, '', 'not json', '{}', '{"path":"about.html"}', '{"path":"about.html","marks":0}', '[]', '7']) {
    assert.equal(fileIsBehind(none, 'about.html', before), false, `no usable note (${none}): the editor starts as it always did`);
  }
  assert.equal(typeof WHOLE_PAGE_NOTE, 'string');
});

test('main.js leaves the note before it reloads, and reads the file again after it, before deciding what is editable', () => {
  const main = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'editor', 'main.js'), 'utf8');
  const press = main.slice(main.indexOf('async function wholePage(btn)'));
  assert.ok(press.indexOf('sessionStorage.setItem(WHOLE_PAGE_NOTE, wholePageNote(path, result.text))') > 0 && press.indexOf('sessionStorage.setItem(WHOLE_PAGE_NOTE') < press.indexOf('location.reload()'), 'the note is left before the reload');
  const load = main.slice(main.indexOf('async function loadPageSource()'), main.indexOf('async function fileAfterWholePage()'));
  assert.ok(load.indexOf('await fileAfterWholePage();') > 0 && load.indexOf('await fileAfterWholePage();') < load.indexOf('state.fields = indexHtml(state.page.text)'), 'read again before the parts are listed');
  const again = main.slice(main.indexOf('async function fileAfterWholePage()'), main.indexOf('function workerAuthHeaders()'));
  assert.match(again, /sessionStorage\.removeItem\(WHOLE_PAGE_NOTE\)/, 'the note is used once');
  assert.match(again, /getFile\(state\.gh, cfg\.repo, state\.page\.path, cfg\.branch \|\| 'main', true\)/, 'past every store of earlier answers');
  assert.match(again, /i < 5/, 'and not for ever');
});
