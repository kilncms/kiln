/**
 * What a person had typed into a panel when a sign-in was found to have ended
 * (a comment, a reply, a note, a time, a name) is never lost: the saved copy
 * holds it beside the unpublished edits (src/editor/saved-edits.js), the
 * dialog says so, and where it cannot be held the dialog says that instead and
 * puts "Copy my text" first (src/editor/sign-in-ended.js).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { draftRecord, readDraft, draftHolds, typedRecord, TYPED } from '../src/editor/saved-edits.js';
import { whatSurvives, publishEnded, publishRefused, backAfterSignIn } from '../src/editor/sign-in-ended.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const NOW = Date.UTC(2026, 9, 6, 12);
const none = new Map();
const oneEdit = new Map([['hero_headline', { html: 'Fresh bread' }]]);
const comment = { where: 'comment', text: 'The price on the third card is out of date.', anchor: { key: 'card_title', x: 12.5, y: 40 } };
const staged = (over = {}) => ({ edits: 0, source: 0, structural: 0, files: 0, ...over });
const ended = (did, counts, typed, kept = { saved: true }, more = {}) => publishEnded({ way: 'google', counts, survives: whatSurvives(counts, kept), did, typed, ...more });

function assertPlain(text) {
  assert.equal(/!/.test(text), false, `an exclamation mark in: ${text}`);
  assert.equal(/[—–]|\s-\s/.test(text), false, `a dash as punctuation in: ${text}`);
}

// ─── the saved copy ──────────────────────────────────────────────────────────

test('typed: the saved copy holds what was being typed, beside the edits or on its own', () => {
  assert.deepEqual(draftRecord(oneEdit, none, NOW, comment), { ts: NOW, edits: { hero_headline: { html: 'Fresh bread' } }, typed: comment });
  // nothing unpublished, and a comment half written: there is still something to save
  assert.deepEqual(draftRecord(none, none, NOW, comment), { ts: NOW, edits: {}, typed: comment });
  // with nothing typed the copy is what it always was, byte for byte
  assert.equal(JSON.stringify(draftRecord(oneEdit, none, NOW)), JSON.stringify({ ts: NOW, edits: { hero_headline: { html: 'Fresh bread' } } }));
  assert.equal(JSON.stringify(draftRecord(oneEdit, none, NOW, null)), JSON.stringify(draftRecord(oneEdit, none, NOW)));
  assert.equal(draftRecord(none, none, NOW, null), null);
});

test('typed: each kind is held with what says where it goes back', () => {
  assert.deepEqual(typedRecord({ where: 'reply', text: 'Yes, until June.', thread: 't1' }), { where: 'reply', text: 'Yes, until June.', thread: 't1' });
  assert.deepEqual(typedRecord({ where: 'schedule', text: '17 May 2031, 09:30', at: '2031-05-17T09:30' }), { where: 'schedule', text: '17 May 2031, 09:30', at: '2031-05-17T09:30' });
  assert.deepEqual(typedRecord({ where: 'version', text: 'Summer menu', sha: 'c2' }), { where: 'version', text: 'Summer menu', sha: 'c2' });
  assert.deepEqual(typedRecord({ where: 'note', text: 'Corrected the opening line' }), { where: 'note', text: 'Corrected the opening line' });
  // a comment pinned by a selector instead of a field's key
  assert.deepEqual(typedRecord({ where: 'comment', text: 'Here', anchor: { sel: 'main > p:nth-of-type(2)', x: 50, y: 0 } }).anchor, { sel: 'main > p:nth-of-type(2)', x: 50, y: 0 });
  // a comment with no place on the page is still a comment
  assert.deepEqual(typedRecord({ where: 'comment', text: 'General note' }), { where: 'comment', text: 'General note' });
  // every kind has a name the sentences use
  for (const where of ['comment', 'reply', 'note', 'schedule', 'version']) assert.equal(typeof TYPED[where], 'string');
});

test('typed: what is read back from the browser\'s storage is not taken on trust', () => {
  for (const bad of [null, undefined, 'a comment', 7, [], {}, { where: 'comment' }, { where: 'comment', text: '' }, { where: 'comment', text: '   ' },
    { where: 'comment', text: 7 }, { where: 'elsewhere', text: 'x' }, { where: '__proto__', text: 'x' }, { where: 'toString', text: 'x' },
    { where: 'comment', text: 'x'.repeat(5001) }]) {
    assert.equal(typedRecord(bad), null, JSON.stringify(bad));
  }
  // only the fields that mean something are kept, and only as text and numbers
  const odd = typedRecord({ where: 'comment', text: 'ok', anchor: { key: 'a', sel: 'b', x: 'left', y: 250, onclick: 'x' }, thread: { id: 1 }, at: 9, sha: 'x'.repeat(101), html: '<b>' });
  assert.deepEqual(odd, { where: 'comment', text: 'ok', anchor: { key: 'a' } });
  assert.deepEqual(typedRecord({ where: 'comment', text: 'ok', anchor: { x: 1, y: 2 } }), { where: 'comment', text: 'ok' }, 'a place with neither a key nor a selector is no place');
  assert.deepEqual(typedRecord({ where: 'comment', text: 'ok', anchor: 'everywhere' }), { where: 'comment', text: 'ok' });
});

test('typed: read back, it is offered with the edits or on its own, and an unreadable one is left behind', () => {
  const both = readDraft({ ts: NOW, edits: { hero_headline: { html: 'Fresh bread' } }, typed: comment }, { now: NOW });
  assert.deepEqual(both, { edits: { hero_headline: { html: 'Fresh bread' } }, source: {}, count: 1, typed: comment });
  const alone = readDraft({ ts: NOW, edits: {}, typed: comment }, { now: NOW });
  assert.deepEqual(alone, { edits: {}, source: {}, count: 0, typed: comment });
  // without it, the answer is exactly what it was before this could be held
  assert.deepEqual(readDraft({ ts: NOW, edits: { a: { html: 'x' } } }, { now: NOW }), { edits: { a: { html: 'x' } }, source: {}, count: 1 });
  assert.equal(readDraft({ ts: NOW, edits: {} }, { now: NOW }), null);
  assert.deepEqual(readDraft({ ts: NOW, edits: { a: { html: 'x' } }, typed: { where: 'nowhere', text: 'x' } }, { now: NOW }), { edits: { a: { html: 'x' } }, source: {}, count: 1 });
  assert.equal(readDraft({ ts: NOW, edits: {}, typed: { where: 'comment', text: '' } }, { now: NOW }), null);
  // a week old: gone, as the edits are
  assert.equal(readDraft({ ts: NOW - 8 * 24 * 3600 * 1000, edits: {}, typed: comment }, { now: NOW }), null);
});

test('typed: nothing is promised until the copy, read back, holds it', () => {
  const record = JSON.parse(JSON.stringify(draftRecord(oneEdit, none, NOW, comment)));
  assert.equal(draftHolds(record, oneEdit, none, comment), true);
  assert.equal(draftHolds(record, oneEdit, none, { ...comment, text: 'Something else' }), false);
  assert.equal(draftHolds(record, oneEdit, none, null), false, 'the copy holds a comment nobody is writing');
  assert.equal(draftHolds(JSON.parse(JSON.stringify(draftRecord(oneEdit, none, NOW))), oneEdit, none, comment), false, 'the comment is not in the copy');
  // as before, when nothing is being typed
  assert.equal(draftHolds(JSON.parse(JSON.stringify(draftRecord(oneEdit, none, NOW))), oneEdit, none), true);
});

// ─── what the dialog says ────────────────────────────────────────────────────

test('typed: a comment with nothing else unpublished is saved and will be back', () => {
  const d = ended('posted', staged(), { name: TYPED.comment, kept: true });
  assert.deepEqual(d, {
    title: 'Your sign-in has ended',
    status: 'Not posted: your sign-in has ended.',
    text: 'Nothing was posted. Your comment is saved in this browser and will be back on this page when you have signed in again with Google.',
    detail: '', signIn: true, copy: false, copyFirst: false,
  });
  assert.equal(ended('saved', staged(), { name: TYPED.version, kept: true }).text,
    'Nothing was saved. The name you typed is saved in this browser and will be back on this page when you have signed in again with Google.');
});

test('typed: with unpublished edits, both are said to come back, in one sentence', () => {
  assert.equal(ended('scheduled', staged({ edits: 1 }), { name: TYPED.schedule, kept: true }).text,
    'Nothing was scheduled. Your edit is saved in this browser and will be back on this page when you have signed in again with Google, and so will the time you chose.');
  assert.equal(ended('sent', staged({ edits: 3 }), { name: TYPED.note, kept: true }).text,
    'Nothing was sent. Your 3 edits are saved in this browser and will be back on this page when you have signed in again with Google, and so will your note.');
  assert.equal(ended('posted', staged({ edits: 1 }), { name: TYPED.reply, kept: true }).text,
    'Nothing was posted. Your edit is saved in this browser and will be back on this page when you have signed in again with Google, and so will your reply.');
  // Publish itself, with a line typed under "What changed?"
  assert.equal(ended('published', staged({ edits: 1 }), { name: TYPED.note, kept: true }).text,
    'Nothing was published. Your edit is saved in this browser and will be back on this page when you have signed in again with Google, and so will your note.');
});

test('typed: what the saved copy cannot hold is said before the person leaves, and copying comes first', () => {
  const panel = { name: 'what you typed here', kept: false };
  const alone = ended('published', staged(), panel);
  assert.equal(alone.text, 'Nothing was published. Signing in again with Google loads this page afresh. What you typed here cannot be saved and will need typing again. Copy your text first to be sure of it.');
  assert.deepEqual([alone.signIn, alone.copy, alone.copyFirst], [true, true, true]);
  const withEdit = ended('saved', staged({ edits: 1 }), panel);
  assert.equal(withEdit.text, 'Nothing was saved. Signing in again with Google loads this page afresh. Your edit is saved in this browser and will be back. What you typed here cannot be saved and will need typing again. Copy your text first to be sure of it.');
  assert.equal(withEdit.copyFirst, true);
  // something only being read (a search across the site), with boxes filled in
  assert.equal(ended('', staged(), panel).text, 'Signing in again with Google loads this page afresh. What you typed here cannot be saved and will need typing again. Copy your text first to be sure of it.');
  // the browser could not write the copy at all: a comment is then not kept either
  const unsaved = ended('posted', staged(), { name: TYPED.comment, kept: false }, { saved: false });
  assert.equal(unsaved.text, 'Nothing was posted. Signing in again with Google loads this page afresh. Your comment cannot be saved and will need typing again. Copy your text first to be sure of it.');
  assert.equal(unsaved.copyFirst, true);
});

test('typed: kept beside something that is not, each is said for itself', () => {
  const d = ended('posted', staged({ edits: 1, structural: 1 }), { name: TYPED.comment, kept: true });
  assert.equal(d.text, 'Nothing was posted. Signing in again with Google loads this page afresh. Your edit is saved in this browser and will be back. Parts you made editable, added or removed cannot be saved and will need doing again. Your comment is saved in this browser and will be back. Copy your text first to be sure of it.');
  assert.deepEqual([d.copy, d.copyFirst], [true, false]);
  const only = ended('posted', staged({ structural: 1 }), { name: TYPED.comment, kept: true }, { saved: true });
  assert.equal(only.text, 'Nothing was posted. Signing in again with Google loads this page afresh. Parts you made editable, added or removed cannot be saved and will need doing again. Your comment is saved in this browser and will be back.');
  assert.deepEqual([only.copy, only.copyFirst], [true, false]);
});

test('typed: when the owner has something to correct, or the answer is 403, the words are still there and can be copied', () => {
  const owner = ended('posted', staged(), { name: TYPED.comment, kept: true }, { saved: true }, { ownerMust: true, message: 'Run kiln doctor.' });
  assert.equal(owner.text, 'Nothing was posted. The site’s owner has something to correct before anyone can sign in again, so please ask them. Your comment is still here, but only until this page is closed: copy your text to keep it.');
  assert.deepEqual([owner.signIn, owner.copy], [false, true]);
  const refused = publishRefused({ way: 'google', reason: 'outside your editing scope', counts: staged(), did: 'posted', typed: { name: TYPED.comment, kept: false } });
  assert.equal(refused.text, 'Your sign-in does not allow this change, so nothing was posted. Your comment is still here: copy your text to keep it, and ask the site’s owner.');
  assert.deepEqual([refused.signIn, refused.copy], [false, true]);
  // with an edit staged, the sentence about the edit already says to copy
  assert.equal(publishRefused({ way: 'google', reason: '', counts: staged({ edits: 1 }), did: 'scheduled', typed: { name: TYPED.schedule, kept: false } }).copy, true);
});

test('typed: after signing in again the status line says what is back', () => {
  assert.equal(backAfterSignIn(0, 0, TYPED.comment), 'You are signed in again, and your comment is back on this page.');
  assert.equal(backAfterSignIn(0, 0, TYPED.version), 'You are signed in again, and the name you typed is back on this page.');
  assert.equal(backAfterSignIn(1, 0, TYPED.schedule), 'You are signed in again, and your edit is back on this page, with the time you chose. Publish when ready.');
  assert.equal(backAfterSignIn(2, 1, TYPED.note), 'You are signed in again, and your 2 edits are back on this page, with the files they added and your note. Publish when ready.');
  // as before, when nothing was being typed
  assert.equal(backAfterSignIn(1), 'You are signed in again, and your edit is back on this page. Publish when ready.');
  assert.equal(backAfterSignIn(3, 2), 'You are signed in again, and your 3 edits are back on this page, with the files they added. Publish when ready.');
});

test('typed: every sentence that speaks of it is plain', () => {
  const all = [];
  const names = [...Object.values(TYPED), 'what you typed here', 'what you asked for'];
  for (const name of names) {
    for (const kept of [true, false]) {
      for (const counts of [staged(), staged({ edits: 1 }), staged({ edits: 2, structural: 1, files: 1 })]) {
        for (const saved of [true, false]) {
          for (const more of [{}, { ownerMust: true, message: 'Run kiln doctor.' }]) {
            const d = ended('posted', counts, { name, kept: kept && saved }, { saved }, more);
            all.push(d.status, d.text);
            assert.equal(d.copy || /will be back on this page when/.test(d.text), true, `words that are not said to come back can be copied: ${d.text}`);
          }
        }
        all.push(publishRefused({ way: 'google', reason: '', counts, did: 'posted', typed: { name, kept: false } }).text);
      }
    }
    all.push(backAfterSignIn(0, 0, name), backAfterSignIn(1, 1, name));
  }
  for (const text of all) assertPlain(text);
});

// ─── the editor's sources ────────────────────────────────────────────────────

test('typed: the dialog goes over the open panel instead of replacing it, and the saved copy carries what was typed', () => {
  const main = readFileSync(path.join(ROOT, 'src', 'editor', 'main.js'), 'utf8');
  // the one dialog for an ended or refused sign-in is opened over whatever is open
  const dialog = main.slice(main.indexOf('function stoppedDialog('), main.indexOf('/** One sentence, at most one button'));
  assert.match(dialog, /\{ over: true, onClose: stays \}/);
  // the copy is written with what was typed, read back with it, and offered back with it
  assert.match(main, /draftRecord\(state\.pending, state\.pendingSource, Date\.now\(\), state\.typed\)/);
  assert.ok(main.includes('state.pending, state.pendingSource, state.typed)'), 'draftHolds is asked about what was typed too');
  assert.match(main, /saved\.typed \? resumeTyped\(saved\.typed\)/);
  // each place that has words in a box hands them over when it is stopped
  for (const where of ['comment', 'reply']) assert.match(readFileSync(path.join(ROOT, 'src', 'editor', 'comments.js'), 'utf8'), new RegExp(`keep: \\{ where: '${where}'`));
  for (const where of ['schedule', 'version', 'note']) assert.match(main, new RegExp(`keep: \\{ where: '${where}'`));
});
