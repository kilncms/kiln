/**
 * "Go back to this" returns the whole file of a page, head included
 * (src/editor/restore-page.js, used by the history dialog, previewRestore and
 * publish() in main.js, and by the publish sheet).
 *
 * A tester's "Go back to this" was saved as "Edit about.html: -events_mwe9ooml"
 * with the status "Published.", and the page's title and description stayed as
 * they were: only the parts marked as editable were brought back, as ordinary
 * edits written into today's file. These tests hold a restore to writing the
 * old version's own text, to its own name in the history, and to words that
 * say what happens.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyEdits, readValues, readHead } from '../src/engine.js';
import * as R from '../src/editor/restore-page.js';

const page = ({ title, description, css, intro, note, extra = '' }) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <meta name="description" content="${description}">
  <link rel="stylesheet" href="${css}">
</head>
<body>
  <main>
    <h1 data-cms="about_title">About us</h1>
    <p data-cms="about_intro">${intro}</p>
    <p class="note">${note}</p>${extra}
  </main>
</body>
</html>
`;
const THEN = page({ title: 'About the bakery', description: 'Bread since 1984.', css: '/old.css', intro: 'We bake every morning.', note: 'Closed on Mondays.' });
const NOW = page({ title: 'About', description: 'Bread and cakes.', css: '/new.css', intro: 'We bake every morning and most nights.', note: 'Open every day.',
  extra: '\n    <p data-cms="about_hours">Nine to five.</p>' });

/** The edits Keep stages: every editable part of the old version that reads differently today. */
function staged(nowText, thenText) {
  const now = readValues(nowText), then = readValues(thenText);
  return Object.keys(then).filter(k => now[k] !== then[k]).map(key => ({ key, html: then[key] }));
}
/** What publish() writes: its editFile step, with the part that decides what it starts from taken from the module. */
function publishWrites(fileNow, edits, ops, restoring) {
  const start = R.restoreStart(fileNow, ops, restoring);
  return { html: applyEdits(start.text, edits).html, ops: start.ops };
}
const restoring = (over = {}) => ({ sha: 'a1b2c3d4e5', path: 'about.html', when: 'Nov 12, 7:50 PM', name: '', text: THEN, keys: ['about_intro'], removed: [], ...over });

test('restore: the fault, the editable parts written into today’s file leave the head and the rest as they are now', () => {
  const oldWay = applyEdits(NOW, staged(NOW, THEN)).html;
  assert.notEqual(oldWay, THEN);
  assert.equal(readHead(oldWay).title, 'About');
  assert.match(oldWay, /Open every day\./);
});

test('restore: the publish writes the old version’s whole file, byte for byte', () => {
  const out = publishWrites(NOW, staged(NOW, THEN), [], restoring());
  assert.equal(out.html, THEN);
  assert.deepEqual(readHead(out.html), { title: 'About the bakery', description: 'Bread since 1984.', ogImage: '' });
});

test('restore: a version that differs only in its title is a restore too', () => {
  const titled = THEN.replace('About the bakery', 'Our story');
  assert.deepEqual(staged(titled, THEN), [], 'no editable part differs');
  assert.equal(R.differsFromNow(titled, THEN), true);
  assert.equal(R.differsFromNow(THEN, THEN), false);
  assert.equal(publishWrites(titled, [], [], restoring({ keys: [] })).html, THEN);
});

test('restore: what was edited after Keep goes on top of the old version', () => {
  const edits = [...staged(NOW, THEN), { key: 'about_title', html: 'About our bakery' }];
  const out = publishWrites(NOW, edits, [], restoring());
  assert.equal(out.html, THEN.replace('>About us</h1>', '>About our bakery</h1>'));
});

test('restore: the removals the restore staged itself are left out, every other step stays', () => {
  const mine = { op: 'removeSection', key: 'events_mwe9ooml' };
  const other = { op: 'removeSection', key: 'gallery_k2' };
  const made = { op: 'annotate', tag: 'p', nth: 2, attrs: { 'data-cms': 'note' } };
  const out = publishWrites(NOW, [], [mine, other, made], restoring({ removed: ['events_mwe9ooml'] }));
  assert.deepEqual(out.ops, [other, made]);
});

test('restore: with no restore waiting a publish starts from today’s file with every step, as always', () => {
  const ops = [{ op: 'removeSection', key: 'events_mwe9ooml' }];
  assert.deepEqual(R.restoreStart(NOW, ops, null), { text: NOW, ops });
  assert.deepEqual(R.restoreStart(NOW, undefined, null), { text: NOW, ops: [] });
  // A mark read back after a reload has no text yet: publish() reads it by sha before it gets here.
  assert.equal(R.restoreStart(NOW, ops, restoring({ text: null })).text, NOW);
});

test('restore: the change is named in plain words, by its time or by its name', () => {
  assert.equal(R.restoreMessage('about.html', { when: 'Nov 12, 7:50 PM' }), 'Restore about.html to how it was on Nov 12, 7:50 PM (via Kiln)');
  assert.equal(R.restoreMessage('about.html', { name: 'summer menu', when: 'Nov 12, 2026' }), 'Restore about.html to the version “summer menu” (via Kiln)');
  assert.equal(R.restoreMessage('a.html', { name: 'two\nlines' }).includes('\n'), false);
  // The history list reads it as "Went back to an earlier version" (describeCommit in main.js).
  assert.match(R.restoreMessage('about.html', { when: 'Nov 12, 7:50 PM' }), /^(Undo|Restore) .*\(via Kiln\)$/);
  assert.doesNotMatch(R.restoreMessage('about.html', { when: 'Nov 12, 7:50 PM' }), /^Edit /);
});

test('restore: the sheet and the line afterwards say the page is being restored, and to what', () => {
  const r = restoring();
  assert.equal(R.restoreSheetLine(r), 'This page is being restored to how it was on Nov 12, 7:50 PM. Its whole file goes back, with the title and the description, as one new change in the history.');
  assert.equal(R.pageRestoredLine(r), 'Restored this page to how it was on Nov 12, 7:50 PM.');
  assert.equal(R.pageRestoredLine(restoring({ name: 'summer menu' })), 'Restored this page to the version “summer menu”.');
});

test('restore: the bar says what goes back that the page cannot show', () => {
  const note = R.restoreNote(NOW, THEN, 1);
  assert.match(note, /The page’s title goes back to “About the bakery”\./);
  assert.match(note, /Its description goes back to how it was then\./);
  assert.match(note, /1 part added or made editable since then goes back too, which this preview cannot show\./);
  assert.match(note, /Everything else in this page’s file goes back as well, also what cannot be edited here\.$/);
  assert.match(R.restoreNote(NOW, THEN, 2), /2 parts added or made editable since then go back too/);
  const titled = R.restoreNote(THEN.replace('About the bakery', 'Our story'), THEN);
  assert.match(titled, /title goes back/);
  assert.doesNotMatch(titled, /description|made editable/);
  assert.match(R.restoreNote(THEN, THEN.replace('<title>About the bakery</title>', '<title></title>')), /The page goes back to having no title\./);
  assert.equal(R.restoreNote(THEN, THEN), '');
});

test('restore: it is whole only while every part it staged is still waiting', () => {
  const r = restoring({ keys: ['about_intro', 'about_title'] });
  assert.equal(R.restoreHolds(r, ['about_intro', 'about_title', 'something_else']), true);
  assert.equal(R.restoreHolds(r, new Map([['about_intro', {}], ['about_title', {}]]).keys()), true);
  assert.equal(R.restoreHolds(r, ['about_intro']), false, 'a part taken out again shows today’s words');
  assert.equal(R.restoreHolds(restoring({ keys: [] }), []), true, 'a restore of the title alone stages no part');
});

test('restore: the browser keeps a small mark of a waiting restore, never the file’s text', () => {
  const r = restoring({ removed: ['events_mwe9ooml'] });
  const json = JSON.stringify(R.restoreMark(r));
  assert.equal(json.includes('bakery'), false);
  assert.deepEqual(R.readRestoreMark(json, 'about.html'),
    { sha: 'a1b2c3d4e5', path: 'about.html', when: 'Nov 12, 7:50 PM', name: '', text: null, keys: ['about_intro'], removed: ['events_mwe9ooml'] });
  assert.equal(R.readRestoreMark(json, 'index.html'), null, 'another page’s mark is not this page’s');
  assert.equal(R.readRestoreMark(null, 'about.html'), null);
  assert.equal(R.readRestoreMark('{not json', 'about.html'), null);
  assert.equal(R.readRestoreMark(JSON.stringify({ ...R.restoreMark(r), sha: '../../x' }), 'about.html'), null);
  assert.equal(R.readRestoreMark(JSON.stringify({ sha: 'a1b2c3d4e5', path: 'about.html' }), 'about.html'), null);
});

test('restore: the dialog says what going back does and what it does not bring back', () => {
  const real = R.historyIntro(), demo = R.historyIntro({ demo: true });
  assert.match(real, /<strong>Go back to this<\/strong> returns the whole page to how it was then, with its title and description, as one new change in the history that throws nothing away\./);
  assert.match(demo, /<strong>Go back to this<\/strong> returns the parts of the page you can edit to how they were then\./);
  assert.doesNotMatch(demo, /whole page/, 'the demo keeps the editable parts only, and does not promise more');
  for (const word of ['the site menu on other pages', 'the theme', 'pictures that were removed']) assert.ok(R.NOT_BROUGHT_BACK.includes(word), word);
  assert.match(R.DEMO_NOT_BROUGHT_BACK, /the title, the description and the rest of the page’s file stay as they are/);
});

test('restore: every sentence is a plain one, with no dash standing in for a comma', () => {
  const said = [
    ...Object.values(R).filter(v => typeof v === 'string'),
    R.historyIntro(), R.historyIntro({ demo: true }), R.restoreNote(NOW, THEN, 2),
    R.restoreSheetLine(restoring()), R.pageRestoredLine(restoring()), R.restoreMessage('about.html', restoring()),
  ];
  assert.ok(said.length > 12);
  for (const s of said) {
    assert.doesNotMatch(s, /[—–]/, s);
    if (s !== R.RESTORE_DEPLOY_NAME) assert.match(s, /[.)]$/, s);   // that one is a name, and the status line puts it into its sentence
  }
});

test('restore: main.js hands the publish, the sheet, the status line and Undo to this module', () => {
  const main = readFileSync(new URL('../src/editor/main.js', import.meta.url), 'utf8');
  for (const piece of [
    'const start = restoreStart(text, structuralOps, restoring);',
    'restoreMessage(state.page.path, restoring)',
    'lead: () => (restoreWaiting() && !suggest ? restoreSheetLine(state.restoring) : \'\')',
    'rec.restoring ? pageRestoredLine(rec.restoring)',
    'undoBucket.steps.push({ restoring, restoringBefore: state.restoring });',
    'state.restoring = dir === \'before\' ? (s.restoringBefore || null) : s.restoring;',
    'previewRestore(changes, `the page as it was ${what}`, escapeHtml(note), removals, whole)',
  ]) assert.ok(main.includes(piece), piece);
  assert.doesNotMatch(main, /added since then stay as they are/);
  const sheet = readFileSync(new URL('../src/editor/publish-sheet.js', import.meta.url), 'utf8');
  assert.ok(sheet.includes('if (!items.length && !n && !lead)'), 'a restore that changes no row keeps the sheet open');
});
