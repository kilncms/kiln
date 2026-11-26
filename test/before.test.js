// What a waiting edit was made against is kept from when it was made (src/editor/before.js), so a page
// loaded again with its edits put back never publishes over words someone else published meanwhile.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { priorFacts, carried, keepWaiting, factsSha, changedUnder, reviewed } from '../src/editor/before.js';

const main = readFileSync(new URL('../src/editor/main.js', import.meta.url), 'utf8');
const OLD = 'a'.repeat(40), NEW = 'b'.repeat(40);

const stored = {
  edits: { about_headline: { html: 'Mine' }, team: { html: '<li>Ann</li><li>Bo</li>' } },
  source: { 'src/content/a.md#title': { value: 'T' } },
  ts: 1,
  page: { path: 'en/about.html', url: '/en/about.html', title: 'About', sha: OLD },
  more: { about_headline: { was: 'About' }, team: { was: '<li>Ann</li>', base: '<li>Ann</li>' } },
  sourceWas: { 'src/content/a.md#title': 'Old title' },
};

test('priorFacts reads what a kept copy says its edits were made against', () => {
  const p = priorFacts(stored);
  assert.equal(p.path, 'en/about.html');
  assert.equal(p.sha, OLD);
  assert.deepEqual(carried(p, 'about_headline'), { was: 'About' });
  assert.deepEqual(carried(p, 'team'), { was: '<li>Ann</li>', base: '<li>Ann</li>' });
  assert.equal(p.sourceWas['src/content/a.md#title'], 'Old title');
  assert.equal(carried(p, 'nothing_here'), null);
  // A copy from an editor before these facts were kept, or one that names no file, says nothing.
  assert.equal(priorFacts({ edits: stored.edits, ts: 1 }), null);
  assert.equal(priorFacts({ ...stored, page: { path: '../x' } }), null);
  assert.equal(priorFacts(null), null);
});

test('keepWaiting keeps only the parts still waiting', () => {
  const p = priorFacts(stored);
  const left = keepWaiting(p, { team: { html: 'x' } }, {});
  assert.deepEqual(Object.keys(left.more), ['team']);
  assert.deepEqual(left.sourceWas, {});
  assert.equal(keepWaiting(p, {}, {}), null, 'nothing waiting: nothing kept');
  assert.equal(keepWaiting(null, { team: {} }, {}), null);
});

test('factsSha keeps the older version while an edit rests on it', () => {
  const p = priorFacts(stored);
  assert.equal(factsSha(p, 'en/about.html', NEW), OLD);
  assert.equal(factsSha(null, 'en/about.html', NEW), NEW);
  assert.equal(factsSha(p, 'fi/about.html', NEW), NEW, 'another page');
  assert.equal(factsSha({ ...p, more: {} }, 'en/about.html', NEW), NEW, 'no edit rests on it any more');
});

test('without a put-back edit, the check is the one a one-page publish always made', () => {
  const values = () => ({ about_headline: 'Theirs', other: 'Same' });
  assert.deepEqual(changedUnder({ keys: ['about_headline'], freshSha: NEW, freshValues: () => { throw new Error('not read'); }, pageSha: NEW, baseline: { about_headline: 'About' } }), [], 'nothing changed under us');
  assert.deepEqual(changedUnder({ keys: ['about_headline'], freshSha: NEW, freshValues: values, pageSha: OLD, baseline: { about_headline: 'About' } }), ['about_headline']);
  assert.deepEqual(changedUnder({ keys: ['other'], freshSha: NEW, freshValues: values, pageSha: OLD, baseline: { other: 'Same' } }), [], 'their change is to another part');
});

test('an edit put back after a reload is compared with what it was made against (the defect found on staging)', () => {
  // I changed the heading while it read "About". Someone else published "About THEIRS". I reloaded:
  // the page now reads theirs and its version is the newest, and my edit was put back.
  const prior = priorFacts(stored);
  const freshValues = () => ({ about_headline: 'About THEIRS' });
  const got = changedUnder({ keys: ['about_headline'], freshSha: NEW, freshValues, pageSha: NEW, baseline: { about_headline: 'About THEIRS' }, prior });
  assert.deepEqual(got, ['about_headline'], 'asked, not written over');
  // Nobody changed it: the put-back edit rests on the same words the page reads, and nothing is asked.
  assert.deepEqual(changedUnder({ keys: ['about_headline'], freshSha: NEW, freshValues: () => ({ about_headline: 'About' }), pageSha: NEW, baseline: { about_headline: 'About' }, prior }), []);
});

test('"Reload & review": what was shown becomes what the edits rest on, so the question does not come back', () => {
  const prior = priorFacts(stored);
  const after = reviewed(prior, { path: 'en/about.html', sha: NEW, keys: ['about_headline'], values: { about_headline: 'About THEIRS' } });
  assert.equal(carried(after, 'about_headline').was, 'About THEIRS');
  assert.deepEqual(carried(after, 'team'), { was: '<li>Ann</li>', base: '<li>Ann</li>' }, 'the other parts keep theirs');
  assert.equal(after.sha, NEW);
  assert.deepEqual(changedUnder({ keys: ['about_headline'], freshSha: NEW, freshValues: () => ({ about_headline: 'About THEIRS' }), pageSha: NEW, baseline: { about_headline: 'About THEIRS' }, prior: after }), []);
  // With nothing put back before, the reviewed parts are all it holds.
  const fresh = reviewed(null, { path: 'en/about.html', sha: NEW, keys: ['about_headline'], values: { about_headline: 'T' } });
  assert.deepEqual(Object.keys(fresh.more), ['about_headline']);
});

test('the editor keeps and uses these facts in both publish paths', () => {
  const between = (a, b) => { const i = main.indexOf(a); assert.ok(i >= 0, a); return main.slice(i, main.indexOf(b, i)); };
  const facts = between('function pageFacts(record)', '\n}\n');
  assert.ok(facts.includes('keepWaiting(priorHere(), record.edits, record.source)'), 'pageFacts starts from what came back');
  assert.ok(facts.includes('carried(prior, key)') && facts.includes('factsSha(prior, state.page.path, state.page.sha)'));
  const offer = between('function offerPendingRestore()', '\n}\n');
  assert.ok(offer.includes('prior = priorFacts(stored)'), 'read when the copy is read, before any answer');
  assert.equal((offer.match(/restoreSaved\([^)]*prior\)/g) || []).length, 3, 'all three ways of putting edits back carry it');
  const restore = between('async function restoreSaved(', '\n}\n');
  assert.ok(restore.indexOf('state.before = prior') > restore.indexOf("n.classList.add('kiln-modified')"), 'set once the edits are staged again');
  const save = between('function savePendingToStorage()', '\n}\n');
  assert.ok(save.includes('state.before = record ? keepWaiting(priorHere(), record.edits, record.source) : null'));
  const confirm = between('async function confirmOverwrites(', '\n}\n');
  assert.ok(confirm.includes('changedUnder({') && confirm.includes('prior: priorHere()'), 'a one-page publish compares the same way');
  assert.ok(confirm.includes('state.before = reviewed(priorHere()'), '"Reload & review" keeps what was shown');
});
