/**
 * What an invited editor with limits is told (src/editor/your-pages.js).
 *
 * A tester limited to the pages under blog/ opened another page and read
 * "Signed in as Rosa. Click any outlined text to edit." with nothing outlined.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { placeSaid, placesSaid, limitsSaid, PLACES_SAID } from '../src/editor/your-pages.js';
import { startLine } from '../src/editor/grants.js';
import { restLine } from '../src/editor/went-live.js';

const main = readFileSync(new URL('../src/editor/main.js', import.meta.url), 'utf8');
const rosa = { user: 'Rosa', touch: false, scopeMode: null, comments: true, pageFile: true };

test('your pages: a folder reads as the pages under it, a single page as its address', () => {
  assert.equal(placeSaid('blog/'), 'the pages under /blog/');
  assert.equal(placeSaid('blog'), 'the pages under /blog/');
  assert.equal(placeSaid('/news/2026/'), 'the pages under /news/2026/');
  assert.equal(placeSaid('blog/**'), 'the pages under /blog/');
  assert.equal(placeSaid('about.html'), '/about.html');
  assert.equal(placeSaid('team/rosa.html'), '/team/rosa.html');
  assert.equal(placeSaid('blog/index.html'), '/blog/');
  assert.equal(placeSaid('index.html'), 'the home page');
  // A site served from a folder of its repository: the folder is not part of the address.
  assert.equal(placeSaid('site/blog/', 'site'), 'the pages under /blog/');
  assert.equal(placeSaid('site/about.html', '/site/'), '/about.html');
});

test('your pages: at most three places are named, then how many more', () => {
  assert.equal(PLACES_SAID, 3);
  assert.equal(placesSaid(['blog/']), 'the pages under /blog/');
  assert.equal(placesSaid(['blog/', 'about.html']), 'the pages under /blog/ and /about.html');
  assert.equal(placesSaid(['blog/', 'news/', 'about.html']), 'the pages under /blog/, the pages under /news/ and /about.html');
  assert.equal(placesSaid(['blog/', 'news/', 'about.html', 'a.html', 'b.html']),
    'the pages under /blog/, the pages under /news/, /about.html and 2 more');
  assert.equal(placesSaid(['blog/', 'blog', '/blog/']), 'the pages under /blog/', 'the same place is said once');
  for (const all of [[], null, undefined, ['**'], ['blog/', '*'], ['']]) assert.equal(placesSaid(all), '');
});

test('your pages: what follows the name on a page that is not theirs, and on one where some parts are', () => {
  assert.equal(limitsSaid({ pageMine: false, paths: ['blog/'] }),
    'This page is not one you can change. You can change: the pages under /blog/.');
  assert.equal(limitsSaid({ pageMine: false, paths: [] }), 'This page is not one you can change.');
  assert.equal(limitsSaid({ pageMine: true, partsLimited: true, anyPart: true }), 'You can change the outlined parts of this page.');
  assert.equal(limitsSaid({ pageMine: true, partsLimited: true, anyPart: false }), 'No part of this page is one you can change.');
  // Someone whose changes are suggestions is told so.
  assert.equal(limitsSaid({ pageMine: false, paths: ['blog/'], suggest: true }),
    'This page is not one you can suggest changes to. You can suggest changes to: the pages under /blog/.');
  assert.equal(limitsSaid({ pageMine: true, partsLimited: true, suggest: true }), 'You can suggest changes to the outlined parts of this page.');
  // No limits here: nothing is added.
  assert.equal(limitsSaid({ pageMine: true, partsLimited: false }), '');
  assert.equal(limitsSaid({}), '');
  assert.equal(limitsSaid(), '');
});

test('your pages: the first line and the line the editor rests on both say it, and never "click any outlined text"', () => {
  const notMine = limitsSaid({ pageMine: false, paths: ['blog/'] });
  const parts = limitsSaid({ pageMine: true, partsLimited: true });
  assert.equal(startLine({ ...rosa, limits: notMine }),
    'Signed in as Rosa. This page is not one you can change. You can change: the pages under /blog/.');
  assert.equal(startLine({ ...rosa, limits: parts }), 'Signed in as Rosa. You can change the outlined parts of this page.');
  assert.equal(startLine({ ...rosa, touch: true, limits: notMine }).includes('Tap any outlined'), false);
  assert.equal(startLine({ ...rosa, limits: '' }), 'Signed in as Rosa. Click any outlined text to edit.');
  // After a publish, and after "live", the line that comes back says the same.
  assert.equal(restLine('Rosa', null, { limits: notMine }),
    'Signed in as Rosa. This page is not one you can change. You can change: the pages under /blog/.');
  assert.equal(restLine('Rosa', { at: new Date(2026, 10, 12, 15, 52).getTime() }, { locale: 'en-US', limits: parts }),
    'Signed in as Rosa. You can change the outlined parts of this page. Your last publish went live at 3:52 PM.');
  assert.equal(restLine('Rosa', null, { limits: '' }), 'Signed in as Rosa');
  for (const line of [startLine({ ...rosa, limits: notMine }), startLine({ ...rosa, limits: parts }), restLine('Rosa', null, { limits: notMine })]) {
    assert.doesNotMatch(line, /[—–]| - /);
  }
});

test('your pages: the editor asks once what to say, and says it in each place the line is put', () => {
  const fn = main.slice(main.indexOf('function limitsHere()'), main.indexOf('\n}\n', main.indexOf('function limitsHere()')));
  assert.match(fn, /mode !== 'editor' \|\| cfg\.sandbox/, 'the owner and the demo have no limits');
  assert.match(fn, /state\.scope\?\.mode === 'review'/, 'someone who only comments has a line of their own');
  assert.match(fn, /pageMine: pageInScope\(\)/);
  assert.match(fn, /paths: state\.scope\?\.paths/);
  // The first line, the line it rests on, the bar's line, and the note on the page.
  assert.match(main, /startLine\(\{[^}]*\blimits\b[^}]*\}\)/);
  assert.match(main, /function restStatus\(\) \{\n  setStatus\(restLine\(state\.user, state\.lastLive, \{ limits: limitsHere\(\) \}\)/);
  assert.match(main, /setStatus\(restLine\(state\.user, null, \{ limits: limitsHere\(\) \}\), 'idle'\)/);
  assert.equal(main.includes('setStatus(`Signed in as ${state.user}`'), false);
  assert.equal(main.includes('Read-only here'), false, 'the note on the page says the same sentence as the line');
});
