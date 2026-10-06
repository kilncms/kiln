/**
 * An ended sign-in is said the same way on every path of the editor that asks
 * the worker, not only at Publish (src/editor/sign-in-ended.js): the sentences
 * name what was being done, and the editor's sources are read here to show
 * that no path asks the worker, or shows a failed answer, around them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFailure, whatSurvives, publishEnded, publishRefused, publishTrouble, readRefused } from '../src/editor/sign-in-ended.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EDITOR = path.join(ROOT, 'src', 'editor');
const sources = () => readdirSync(EDITOR).filter(f => f.endsWith('.js')).map(f => ({ file: f, lines: readFileSync(path.join(EDITOR, f), 'utf8').split('\n') }));

const staged = (over = {}) => ({ edits: 0, source: 0, structural: 0, files: 0, ...over });
const ended = (did, counts, kept = { saved: true }, more = {}) => publishEnded({ way: 'google', counts, survives: whatSurvives(counts, kept), did, ...more });
/** Every word the editor uses for "what was being done". */
const DID = ['published', 'saved', 'scheduled', 'cancelled', 'sent', 'posted', 'changed', 'deleted', 'undone', 'created', 'replaced', 'added', 'removed', 'approved', 'declined'];

function assertPlain(text) {
  assert.equal(/!/.test(text), false, `an exclamation mark in: ${text}`);
  assert.equal(/[—–]|\s-\s/.test(text), false, `a dash as punctuation in: ${text}`);
}

test('everywhere: the dialog for an ended sign-in names what was being done, and is otherwise the one Publish shows', () => {
  const publish = ended('published', staged({ edits: 1 }));
  const schedule = ended('scheduled', staged({ edits: 1 }));
  assert.deepEqual(schedule, {
    title: 'Your sign-in has ended',
    status: 'Not scheduled: your sign-in has ended.',
    text: 'Nothing was scheduled. Your edit is saved in this browser and will be back on this page when you have signed in again with Google.',
    detail: '', signIn: true, copy: false, copyFirst: false,
  });
  assert.equal(schedule.title, publish.title);
  assert.equal(schedule.text.replace('scheduled', 'published'), publish.text, 'one sentence, one word apart');
  assert.equal(ended('saved', staged({ edits: 2 })).text, 'Nothing was saved. Your 2 edits are saved in this browser and will be back on this page when you have signed in again with Google.');
  assert.equal(ended('saved', staged({ edits: 2 })).status, 'Not saved: your sign-in has ended.');
});

test('everywhere: with nothing unpublished, what was being done is still named', () => {
  const comment = ended('posted', staged());
  assert.equal(comment.text, 'Nothing was posted. Please sign in again with Google to carry on.');
  assert.equal(comment.status, 'Not posted: your sign-in has ended.');
  assert.equal(comment.signIn, true);
  // a publish with nothing to send is the one that does not speak of it (as before)
  assert.equal(ended('published', staged()).text, 'Please sign in again with Google to carry on.');
});

test('everywhere: when something was only being read, the sentence does not speak of doing anything', () => {
  const idle = ended('', staged());
  assert.equal(idle.status, 'Your sign-in has ended.');
  assert.equal(idle.text, 'Please sign in again with Google to carry on.');
  const withEdit = ended('', staged({ edits: 1 }));
  assert.equal(withEdit.status, 'Your sign-in has ended.');
  assert.equal(withEdit.text, 'Your edit is saved in this browser and will be back on this page when you have signed in again with Google.');
  // the same answer as `publishing: false`, which is how the owner's token running out has been told
  assert.deepEqual(withEdit, publishEnded({ way: 'google', counts: staged({ edits: 1 }), survives: whatSurvives(staged({ edits: 1 }), { saved: true }), publishing: false }));
});

test('everywhere: what cannot be kept, and an owner who has something to correct, are told as at Publish', () => {
  const unsaved = ended('scheduled', staged({ edits: 2 }), { saved: false });
  assert.equal(unsaved.text, 'Nothing was scheduled. Signing in again with Google loads this page afresh. This browser could not save your edits, so they will not be here afterwards. Copy your text first to be sure of it.');
  assert.equal(unsaved.copyFirst, true);
  const owner = ended('sent', staged({ edits: 1 }), { saved: true }, { ownerMust: true, message: 'Run kiln doctor.' });
  assert.equal(owner.text, 'Nothing was sent. The site’s owner has something to correct before anyone can sign in again, so please ask them. Your edit is saved in this browser for a week: copy your text to keep it longer.');
  assert.equal(owner.detail, 'For the owner: Run kiln doctor.');
  assert.equal(owner.signIn, false);
});

test('everywhere: a 403 names what was not done, keeps the sign-in, and shows the answer\'s reason', () => {
  const d = publishRefused({ way: 'google', reason: 'your access does not include scheduling', counts: staged({ edits: 1 }), did: 'scheduled' });
  assert.deepEqual(d, {
    title: 'This was not scheduled',
    status: 'Not scheduled: your sign-in does not allow this change.',
    text: 'Your sign-in does not allow this change, so nothing was scheduled. Your edit is still on this page: copy your text to keep it, and ask the site’s owner.',
    detail: 'The answer was: your access does not include scheduling',
    signIn: false, copy: true,
  });
  const comment = publishRefused({ way: 'google', reason: 'outside your editing scope', counts: staged(), did: 'posted' });
  assert.equal(comment.text, 'Your sign-in does not allow this change, so nothing was posted. Please ask the site’s owner.');
  assert.equal(comment.copy, false);
});

test('everywhere: a 403 on something that was only being read is one line, and says the person is still signed in', () => {
  assert.equal(readRefused({ way: 'google', reason: 'outside your editing scope' }),
    'The site did not allow this. You are still signed in, so please ask the site’s owner. The answer was: outside your editing scope');
  assert.equal(readRefused({ way: 'github' }), 'The site did not allow this. You are still signed in, so please check that you can still read the repository on GitHub.');
});

test('everywhere: trouble names what was not done, or nothing when something was being read', () => {
  const none = readFailure(new TypeError('Failed to fetch'));
  const failing = readFailure({ status: 502, data: {} });
  const busy = readFailure({ status: 429, data: { error: 'rate limited, slow down' } });
  assert.equal(publishTrouble(none, { edits: 1, source: 0 }, 'scheduled'), 'Not scheduled: the site could not be reached. Your edit is still here, so please check your connection and try again.');
  assert.equal(publishTrouble(failing, { edits: 0, source: 0 }, 'posted'), 'Not posted: the site had a problem just now. Nothing was lost, so please try again in a moment.');
  assert.equal(publishTrouble(busy, { edits: 2, source: 0 }, 'saved'), 'Not saved: too much was asked of the site just now. Your 2 edits are still here, so please try again in a minute.');
  assert.equal(publishTrouble(none, { edits: 0, source: 0 }, ''), 'The site could not be reached. Nothing was lost, so please check your connection and try again.');
  assert.equal(publishTrouble(failing, { edits: 1, source: 0 }, ''), 'The site had a problem just now. Your edit is still here, so please try again in a moment.');
  assert.equal(publishTrouble(busy, { edits: 0, source: 0 }, ''), 'Too much was asked of the site just now. Nothing was lost, so please try again in a minute.');
  // Publish itself reads as it always has
  assert.equal(publishTrouble(failing, { edits: 1, source: 0 }), 'Not published: the site had a problem just now. Your edit is still here, so please try again in a moment.');
});

test('everywhere: every sentence, for every thing that can be stopped, is plain', () => {
  const all = [readRefused({ way: 'google', reason: '' }), readRefused({ way: 'github', reason: '' })];
  const troubles = [readFailure(new TypeError('Failed to fetch')), readFailure({ status: 500 }), readFailure({ status: 429 })];
  for (const did of [...DID, '']) {
    for (const counts of [staged(), staged({ edits: 1 }), staged({ edits: 2, structural: 1, files: 1 })]) {
      for (const way of ['google', 'github']) {
        for (const kept of [{ saved: true, filesKept: 1 }, { saved: false }]) {
          for (const more of [{}, { ownerMust: true, message: 'Run kiln doctor.' }]) {
            const d = publishEnded({ way, counts, survives: whatSurvives(counts, kept), did, ...more });
            all.push(d.title, d.status, d.text);
          }
        }
        if (did) { const r = publishRefused({ way, reason: '', counts, did }); all.push(r.title, r.status, r.text); }
      }
      for (const f of troubles) all.push(publishTrouble(f, counts, did));
    }
  }
  for (const text of all) assertPlain(text);
  assert.ok(all.every(t => /^[A-Z]/.test(t)), 'each starts with a capital');
});

// ─── the editor's sources ────────────────────────────────────────────────────

test('everywhere: the worker is asked through one door, which every answer about the sign-in passes', () => {
  // The only places that may call fetch on the worker themselves: the door, the
  // token renewal it relies on, and the capability check, which is not signed.
  const allowed = [/\/auth\/refresh/, /\/healthz/];
  const direct = [];
  for (const { file, lines } of sources()) {
    if (file === 'worker-call.js') continue;
    lines.forEach((line, i) => {
      if (/\bfetch\(/.test(line) && /cfg\.worker/.test(line) && !allowed.some(re => re.test(line))) direct.push(`${file}:${i + 1}`);
      if (/workerAuthHeaders\(\)/.test(line) && !/^function workerAuthHeaders/.test(line)) direct.push(`${file}:${i + 1} builds the sign-in headers itself`);
    });
  }
  assert.deepEqual(direct, []);
  const main = readFileSync(path.join(EDITOR, 'main.js'), 'utf8');
  assert.match(main, /const ask = makeAsk\(\{[^}]*headers: workerAuthHeaders[^}]*stands: signInStands[^}]*ended: signInGone/s);
  assert.equal((main.match(/state\.gh = watched\(/g) || []).length, 2, 'both GitHub transports (the owner\'s and the proxy) are watched');
  // nothing reads the stored sign-in to build a header of its own
  assert.equal(/Bearer \$\{(?:admin\(\)|JSON\.parse\(localStorage\.getItem\(ADMIN_KEY\)\))\.token\}/.test(main.replace(/function workerAuthHeaders\(\) \{[\s\S]*?\n\}/, '')), false);
});

test('everywhere: no failed answer is shown in its own words before it is asked what it means', () => {
  // A line that puts an error's message in front of the person must first go
  // through stopped() / say() (main.js), failed() (AI assist), or readFailure,
  // on that line or just above it in the same handler.
  const told = /\b(stopped|say|failed|readFailure)\(/;
  // Not answers from the worker:
  const notAnAnswer = [
    /make-editable|annotateElement/,                         // finding the element in the page source: no request is made
    /data = Number\.isInteger\(err\.status\)/,               // source edits: the answer is read with readFailure two lines on
  ];
  const raw = [];
  for (const { file, lines } of sources()) {
    lines.forEach((line, i) => {
      if (!/\$\{(err|e2|e)\.message\}/.test(line) || /console\./.test(line)) return;
      const near = lines.slice(Math.max(0, i - 3), i + 1).join('\n');
      if (told.test(near) || notAnAnswer.some(re => re.test(near))) return;
      raw.push(`${file}:${i + 1}  ${line.trim().slice(0, 100)}`);
    });
  }
  assert.deepEqual(raw, []);
});

test('everywhere: each thing that can be stopped is named with a word the sentences are tested with', () => {
  const used = new Set();
  for (const { lines } of sources()) {
    for (const line of lines) {
      for (const m of line.matchAll(/\b(?:stopped|say)\((?:err|e2|e), (?:approve \? )?'([a-z]*)'(?: : '([a-z]*)')?/g)) { used.add(m[1]); if (m[2]) used.add(m[2]); }
      for (const m of line.matchAll(/\bact\((?:send|res|this), '([a-z]+)'/g)) used.add(m[1]);
    }
  }
  used.delete('');
  assert.ok(used.size >= 10, `found ${[...used].join(', ')}`);
  for (const word of used) assert.ok(DID.includes(word), `"${word}" is not among the words the sentences are tested with`);
});
