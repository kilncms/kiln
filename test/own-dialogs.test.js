/**
 * The editor's own questions, and History's preview on the page
 * (src/editor/own-dialogs.js, and where main.js, comments.js and suggest.js
 * use it).
 *
 * Four things were still asked in the browser's own grey box: deleting a
 * comment thread, deleting a page (two boxes), signing out with edits
 * waiting, and the note when declining a suggestion. They are the editor's
 * own dialogs now. And History no longer shows a restore side by side in two
 * frames with scripts off, where a site that fades its sections in showed
 * them blank: the result is shown on the page itself.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ownDialogCopy, answerOf } from '../src/editor/own-dialogs.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (f) => readFileSync(path.join(ROOT, 'src', 'editor', f), 'utf8');
const main = read('main.js');

test('questions: each says what will happen, and its buttons say what they do', () => {
  const thread = ownDialogCopy('delete-thread');
  assert.equal(thread.title, 'Delete this comment thread?');
  assert.match(thread.body, /for everyone/);
  assert.match(thread.body, /can’t be brought back/);
  assert.deepEqual([thread.cancel, thread.go], ['Keep it', 'Delete thread']);
  assert.equal(thread.input, undefined);

  const page = ownDialogCopy('delete-page', { path: 'blog/first-post.html' });
  assert.equal(page.title, 'Delete this page?');
  assert.match(page.body, /^blog\/first-post\.html comes off the site/);
  assert.match(page.body, /bring it back/);
  assert.match(page.body, /Site menu/);
  // one dialog, not two boxes: the name is typed in it, and nothing is deleted until it matches
  assert.deepEqual(page.input, { label: 'To confirm, type the page’s file name: first-post.html', match: 'first-post.html' });
  assert.deepEqual([page.cancel, page.go], ['Keep the page', 'Delete page']);

  const one = ownDialogCopy('sign-out', { edits: 1 });
  assert.equal(one.title, 'Sign out and discard your edit?');
  assert.equal(one.body, 'You have 1 unpublished edit on this page. Signing out throws it away.');
  const many = ownDialogCopy('sign-out', { edits: 3 });
  assert.equal(many.title, 'Sign out and discard your edits?');
  assert.equal(many.body, 'You have 3 unpublished edits on this page. Signing out throws them away.');
  assert.deepEqual([many.cancel, many.go], ['Stay signed in', 'Discard and sign out']);

  const decline = ownDialogCopy('decline');
  assert.equal(decline.title, 'Decline this suggestion?');
  assert.match(decline.body, /Nothing on the site changes/);
  assert.deepEqual(decline.input, { label: 'A note for them (optional)' });
  assert.deepEqual([decline.cancel, decline.go], ['Cancel', 'Decline']);

  // plain words: nothing shouts, nothing uses a dash for punctuation, nothing says "OK"
  for (const c of [thread, page, one, many, decline]) {
    const all = [c.title, c.body, c.go, c.cancel, c.input?.label || ''].join(' ');
    assert.equal(/[!—–]| - |\bOK\b/.test(all), false, all);
  }
  assert.throws(() => ownDialogCopy('something else'));
});

test('questions: what a dialog answers', () => {
  // a plain question: yes
  assert.equal(answerOf(ownDialogCopy('delete-thread'), ''), true);
  // a note is whatever was typed, and may be empty
  assert.equal(answerOf(ownDialogCopy('decline'), '  Not this week  '), 'Not this week');
  assert.equal(answerOf(ownDialogCopy('decline'), ''), '');
  // a name to type: no answer until it is the name
  const page = ownDialogCopy('delete-page', { path: 'about.html' });
  assert.equal(answerOf(page, 'about'), null);
  assert.equal(answerOf(page, ' about.html '), 'about.html');
});

test('questions: no browser box is left where the four were', () => {
  const comments = read('comments.js');
  assert.equal(/\bconfirm\(/.test(comments), false);
  assert.match(comments, /askFirst\(showModal, ownDialogCopy\('delete-thread'\)\)/);
  const suggest = read('suggest.js');
  assert.equal(/window\.prompt\('Note for the editor/.test(suggest), false);
  assert.match(suggest, /askFirst\(deps\.modal, ownDialogCopy\('decline'\)\)/);
  // deleting a page
  const settings = main.slice(main.indexOf('function pageSettingsPanel('), main.indexOf('function findReplacePanel('));
  assert.equal(/\b(confirm|prompt)\(/.test(settings), false);
  assert.match(settings, /askFirst\(modal, ownDialogCopy\('delete-page', \{ path: state\.page\.path \}\)\)/);
  // signing out, from the menu and from the top bar, and whatever kind of edit is waiting
  assert.equal(/confirm\('Discard your unpublished edits and sign out\?'\)/.test(main), false);
  assert.match(main, /fab\.querySelector\('#kiln-signout'\)\.onclick = close\(signOut\);/);
  assert.match(main, /bar\.querySelector\('#kiln-signout'\)\.onclick = signOut;/);
  const out = main.slice(main.indexOf('async function signOut('), main.indexOf('async function signOut(') + 700);
  assert.match(out, /const edits = state\.pending\.size \+ state\.pendingSource\.size \+ state\.pendingStructural\.length \+ state\.pendingBinaries\.size;/);
  assert.match(out, /if \(edits && !\(await askFirst\(modal, ownDialogCopy\('sign-out', \{ edits \}\)\)\)\) return;/);
});

test('history: a restore is shown on the page itself, not in two frames with the scripts off', () => {
  assert.equal(/confirmRestoreVisual/.test(main), false);
  assert.equal(/kiln-vrestore/.test(main), false);
  assert.equal(/<iframe sandbox="" class=/.test(main), false);
  const hist = main.slice(main.indexOf('async function historyPanel('), main.indexOf('async function loadNamedVersions('));
  // each way back closes History and previews on the page, where Cancel puts everything back
  assert.equal((hist.match(/closeHistory\(\);\s*\n\s*const n = previewRestore\(/g) || []).length, 2);
  // the words in History no longer promise frames
  assert.match(hist, /Both show the result on the page first, with Cancel and Keep/);
});
