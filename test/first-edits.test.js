/**
 * Small things a first-time client met (src/editor/first-edits.js, and where
 * main.js, palette.js and comments.js use it).
 *
 * "Add person" and "Add event" pressed with an empty form did nothing and
 * said nothing. "Esc cancels" was said to a phone. The publish sheet's title
 * read "Schedule these 1 edit". A note typed under "What changed?" was gone
 * after a publish that failed. The demo called its visitor "You · editor"
 * while showing them the owner's tools. People & access spoke to a developer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { missingEvent, missingPerson, scheduleTitle, pickBarWords, removedHold, PEOPLE_WORDS, tooBigForDemo, DEMO_PICTURE_MAX, headingVars, ADDED_CSS } from '../src/editor/first-edits.js';

const DIR = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'src', 'editor');
const read = (f) => readFileSync(path.join(DIR, f), 'utf8');
const main = read('main.js');
const plain = (s) => assert.equal(/[!—–]| - /.test(s), false, s);

test('an empty form says what is missing, and where', () => {
  assert.deepEqual(missingEvent({ title: '', date: '' }), { say: 'An event needs a title and a date.', at: 'title' });
  assert.deepEqual(missingEvent({ title: 'Sidewalk sale', date: '' }), { say: 'Choose the date of the event.', at: 'date' });
  assert.deepEqual(missingEvent({ title: '', date: '2026-10-17' }), { say: 'Give the event a title.', at: 'title' });
  assert.equal(missingEvent({ title: 'Sidewalk sale', date: '2026-10-17' }), null);
  assert.deepEqual(missingPerson({ email: '' }), { say: 'Type the Google email address of the person to add.', at: 'email' });
  assert.deepEqual(missingPerson({ email: 'pat at example' }), { say: 'An email address looks like name@example.com. This one is missing a part.', at: 'email' });
  assert.equal(missingPerson({ email: 'pat@example.com' }), null);
  for (const m of [missingEvent({}), missingEvent({ title: 'x' }), missingEvent({ date: 'x' }), missingPerson({}), missingPerson({ email: 'x' })]) plain(m.say);
  // both forms have a line to say it on, and say it
  assert.match(main, /id="kiln-ev-status" role="status"/);
  assert.match(main, /const lacks = missingEvent\(\{ title, date \}\);/);
  assert.match(main, /const lacks = missingPerson\(\{ email \}\);/);
});

test('"Schedule this edit", and never "these 1 edit"', () => {
  assert.equal(scheduleTitle(1), 'Schedule this edit');
  assert.equal(scheduleTitle(3), 'Schedule these 3 edits');
  assert.match(main, /<h3>\$\{scheduleTitle\(/);
  assert.equal(/Schedule these \$\{/.test(main), false);
});

test('advice about keys is for a keyboard, and a touch screen gets a button', () => {
  const mouse = pickBarWords({ touch: false }), finger = pickBarWords({ touch: true });
  assert.match(mouse, /^<strong>Where should it go\?<\/strong> Click a section/);
  assert.match(mouse, /<kbd>Esc<\/kbd> cancels\./);
  assert.match(finger, /^<strong>Where should it go\?<\/strong> Tap a section/);
  assert.equal(/Esc/.test(finger), false);
  // the bar has a Cancel button either way
  assert.match(main, /<button id="kiln-spot-cancel"[^>]*>Cancel<\/button>/);
  // Settings does not tell a phone to hover
  const settings = main.slice(main.indexOf('function settingsPanel('), main.indexOf('// ─── Element picker'));
  assert.match(settings, /touch \? 'tap it for the menu' : 'hover for the menu'/);
  // and anything marked for keys only is not shown where there is no hover
  assert.match(main, /@media \(hover:none\)\{\.kiln-keys-only\{display:none!important\}\}/);
  assert.match(read('comments.js'), /class="kiln-keys-only"><kbd>Esc<\/kbd> cancels/);
});

test('"Removed. Undo" stays its ten seconds: no timer set for an earlier line takes it away', () => {
  assert.equal(removedHold(), 10000);
  assert.match(main, /setStatus\('Removed\.', 'saved', \{ hold: removedHold\(\), tag: 'removed',/);
  // The demo draws its first line while the module is still being read. The timer's variable used to be declared
  // after that, so the first line's timer was forgotten, and hid whatever was showing four seconds into the visit.
  assert.ok(main.indexOf('let statusHideTimer = null;') < main.indexOf('init().catch('), 'declared before the editor starts');
  assert.ok(main.indexOf('let signInLine = null;') < main.indexOf('init().catch('));
  assert.equal((main.match(/let statusHideTimer = null;/g) || []).length, 1);
  // "Signed in as…" coming back after a publish does not replace a line that arrived meanwhile
  const idle = main.slice(main.indexOf('function setStatusIdle('), main.indexOf('function swapImagePreviews('));
  assert.match(idle, /const then = statusShown;/);
  assert.match(idle, /if \(statusShown !== then\) return;/);
});

test('the demo calls its visitor "You", not an editor: they hold every tool', () => {
  assert.equal((main.match(/mode === 'editor' && !cfg\.sandbox \? ' · editor' : ''/g) || []).length, 2);
});

test('a note typed under "What changed?" is still there after a demo publish that did not fit', () => {
  const pub = main.slice(main.indexOf('function publishSandbox('), main.indexOf('function renderSandboxBanner('));
  assert.match(pub, /keptNote = note \|\| '';\s*\n\s*setStatus\(/);
  assert.match(main, /if \(cfg\.sandbox\) return publishSandbox\(noteMsg, opts\.note\);/);
});

test('People & access is said to an owner', () => {
  const all = Object.values(PEOPLE_WORDS).join(' ');
  assert.equal(/Comma-separated|CNAME|_redirects|\.github|indefinite/.test(all), false, all);
  plain(all);
  assert.match(PEOPLE_WORDS.pagesHint, /whole site/);
  assert.match(PEOPLE_WORDS.pagesHint, /never theirs to change/);
  const panel = main.slice(main.indexOf('async function invitePanel('), main.indexOf('// ─── History (per-page restore points)'));
  assert.equal(/Comma-separated|CNAME|indefinite access|font-size:12px/.test(panel), false);
  // the AI tool is not offered where the site has no AI to use (a worker that says so; one that says nothing is left as it was)
  assert.match(panel, /if \(data\.aiConfigured === false\)/);
});

test('a picture too big for the demo is refused with its size and the limit', () => {
  assert.equal(DEMO_PICTURE_MAX, 1024 * 1024);
  assert.equal(tooBigForDemo(300 * 1024), null);
  const no = tooBigForDemo(Math.round(3.4 * 1024 * 1024));
  assert.equal(no, 'This picture is 3.4 MB once it is made web-sized, and the demo keeps pictures up to 1 MB in this browser. Try a smaller one here. A real site has no such limit.');
  plain(no);
  assert.match(tooBigForDemo(1024 * 1024 + 1), /^This picture is 1\.1 MB/);
});

test('the editor\'s dark surfaces can be read without the blur behind them', () => {
  const css = main.slice(main.indexOf('function injectStyles('));
  const bg = css.match(/--kiln-bg:rgba\(16,16,25,(\.\d+)\)/);
  assert.ok(bg, 'one colour for every dark surface');
  assert.ok(Number(bg[1]) >= 0.97, `the page shows through at ${bg[1]}`);
  // every surface that asks for a blur is that colour (or the dialog's scrim, which is meant to show the page dimmed)
  const sources = [css, read('firstrun.js'), read('comments.js'), read('palette.js'), read('publish-sheet.js'), read('image-picker.js')].join('\n');
  for (const rule of sources.match(/[^{}]+\{[^{}]*backdrop-filter:blur[^{}]*\}/g) || []) {
    if (/^\s*#kiln-modal\{/.test(rule.trim()) || /#kiln-modal\{/.test(rule.split('{')[0] + '{')) continue;
    assert.match(rule, /background:var\(--kiln-bg\)|background:#[0-9a-f]{3,6}\b|background:rgb\(/, rule.slice(0, 120));
  }
});

test('a picture is kept small enough for the demo, and dropping it frees what it held', () => {
  const enc = main.slice(main.indexOf('async function canvasToFile('), main.indexOf('async function bitmapToScaled('));
  // a browser that cannot write WebP hands back PNG: a photograph is written as JPEG there, a see-through picture stays PNG
  assert.match(enc, /if \(!blob \|\| blob\.type !== 'image\/webp'\)/);
  assert.match(enc, /const jpeg = seeThrough\(canvas\) \? null : await as\('image\/jpeg'\);/);
  // and the file is named for what was made, on a real site too
  assert.match(main, /`\/assets\/uploads\/master-\$\{stamp\}\.\$\{master\.ext\}`/);
  assert.match(main, /`\/assets\/uploads\/img-\$\{stamp\}\.\$\{display\.ext\}`/);
  assert.equal(/data:image\/webp;base64,\$\{/.test(main), false, 'nothing is called WebP that may not be');
  // the demo: refused before anything is kept, and the full-size original is never put in the browser's store
  const add = main.slice(main.indexOf('async function addImageWithMaster('), main.indexOf('function showResizeNow('));
  const demo = add.slice(add.indexOf('if (cfg.sandbox) {'), add.indexOf('const stamp ='));
  assert.ok(demo.indexOf('if (refusedByDemo(display)) return;') !== -1 && demo.indexOf('if (refusedByDemo(display)) return;') < demo.indexOf('img.src ='), 'refused before it is shown or staged');
  assert.match(demo, /stagePending\(key, \{ attrs: \{ src: img\.src \} \}\);/);
  assert.equal(/data-kiln-master', `data:/.test(main), false);
  // a saved copy that no longer fits does not leave an older one holding the room
  const save = main.slice(main.indexOf('function savePendingToStorage('), main.indexOf('function clearSavedPending('));
  assert.match(save, /catch \{[\s\S]*localStorage\.removeItem\(pendingStorageKey\(\)\)/);
  // what "no room" says points at the way out that keeps the rest
  assert.match(main, /const SANDBOX_FULL = 'This browser has no room left for the demo\. Drop a picture you have added, or press “Start over” to clear it\.';/);
});

test('an added events list arrives in the site\'s own heading type, and each event is set apart', () => {
  // read off the site's nearest heading, and safe to put in a style attribute
  assert.equal(headingVars({ fontFamily: '"Recoleta", Georgia, serif', fontWeight: '600', letterSpacing: '-0.5px', textTransform: 'none' }),
    "--kiln-h-font:'Recoleta', Georgia, serif;--kiln-h-weight:600;--kiln-h-spacing:-0.5px");
  assert.equal(headingVars({ fontFamily: 'x;}</style><script>', fontWeight: '700', letterSpacing: 'normal', textTransform: 'uppercase' }),
    '--kiln-h-font:x/stylescript;--kiln-h-weight:700;--kiln-h-case:uppercase');
  assert.equal(headingVars({}), '');
  assert.match(main, /<h2 class="kiln-added-title" data-cms="\$\{key\}_title">/);
  // only where the site has no styles of its own for an event: a site that has is left to them
  assert.match(main, /const plain = !siteStyles\('kiln-event'\);/);
  for (const rule of ADDED_CSS.split('\n')) assert.match(rule, /^\.kiln-plain /, rule.slice(0, 40));
  // the same rules for the person editing and for the visitor
  const features = readFileSync(path.join(DIR, '..', 'features.js'), 'utf8');
  for (const line of ADDED_CSS.split('\n')) assert.ok(features.includes(line), line.slice(0, 50));
  // put first in the head, so the site's own rules for these classes win
  assert.match(main, /added\.textContent = ADDED_CSS;\s*\n\s*document\.head\.insertBefore\(added, document\.head\.firstChild\);/);
});
