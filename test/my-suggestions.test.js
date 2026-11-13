// What became of a suggestion, told to the person who made it, and the sign an
// owner gets that one waits. The words (src/editor/my-suggestions.js), how the
// editor uses them, and what the service lets a suggester read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MY_TITLE, MY_LEAD, MY_NONE, MY_NOT_READ, DOT_TITLE, dayLong, pageName, pageAddress, myRow, myRows, myItem,
  newlyDecided, latestDecision, decidedLine, waitingLine, dotShown, seenKey, readSeen, keepSeen,
} from '../src/editor/my-suggestions.js';
import { editorEnv, call, REPO, SESSION } from './worker-harness.js';

const NOW = new Date(2026, 10, 13, 9, 0).getTime();          // Friday 13 November 2026
const THU = new Date(2026, 10, 12, 20, 45).getTime();        // Thursday 12 November 2026
const WED = new Date(2026, 10, 11, 8, 5).getTime();
const waiting = { id: 'a'.repeat(12), page: 'about.html', by: 'Sam', email: 'sam@example.com', ts: THU, note: '', edits: [], status: 'open', decided: null, commit: null };
const approved = { ...waiting, id: 'b'.repeat(12), ts: WED, status: 'approved', decided: { by: 'admin', ts: THU }, commit: { sha: 'abc', url: 'https://github.com/acme/site/commit/abc' } };
const declined = { ...waiting, id: 'c'.repeat(12), page: 'index.html', ts: WED, status: 'declined', decided: { by: 'admin', ts: THU + 1000, note: 'Not this month, the dates are not fixed yet.' } };

// ─── the words ───────────────────────────────────────────────────────────────

test('a page is named as a person would say it', () => {
  assert.equal(pageName('about.html'), 'About');
  assert.equal(pageName('index.html'), 'the home page');
  assert.equal(pageName('blog/index.html'), 'Blog');
  assert.equal(pageName('news/spring-fair_2027.html'), 'Spring fair 2027');
  assert.equal(pageName('site/about.html', 'site'), 'About');
  assert.equal(pageName('site/index.html', '/site/'), 'the home page');
  assert.equal(pageName(''), 'a page');
  assert.equal(pageAddress('index.html'), '/');
  assert.equal(pageAddress('blog/index.html'), '/blog/');
  assert.equal(pageAddress('site/about.html', 'site'), '/about.html');
});

test('a day is said in words, with the year only when it is not this one', () => {
  assert.equal(dayLong(THU, { now: NOW }), 'Thursday 12 November');
  assert.equal(dayLong(new Date(2025, 11, 31, 12).getTime(), { now: NOW }), 'Wednesday 31 December 2025');
  assert.equal(dayLong(undefined, { now: NOW }), '');
  assert.equal(dayLong(NaN, { now: NOW }), '');
});

test('a row says the page, when it was sent and where it stands', () => {
  assert.deepEqual(myRow(waiting, { now: NOW }), {
    page: 'About', where: '/about.html', sent: 'Sent on Thursday 12 November', stands: 'Waiting for the owner', note: '', state: 'open' });
  assert.deepEqual(myRow(approved, { now: NOW }), {
    page: 'About', where: '/about.html', sent: 'Sent on Wednesday 11 November', stands: 'Approved and published on Thursday 12 November', note: '', state: 'approved' });
  assert.deepEqual(myRow(declined, { now: NOW }), {
    page: 'The home page', where: '/', sent: 'Sent on Wednesday 11 November', stands: 'Declined on Thursday 12 November',
    note: 'The owner’s note: “Not this month, the dates are not fixed yet.”', state: 'declined' });
  assert.equal(myRow({ ...approved, commit: null }, { now: NOW }).stands, 'Approved on Thursday 12 November. The page already read that way.');
  assert.equal(myRow({ ...declined, decided: { by: 'admin' } }, { now: NOW }).stands, 'Declined', 'a decision kept without its day still reads as a sentence');
  assert.equal(myRow({ ...waiting, decided: { note: 'left over' } }, { now: NOW }).note, '', 'a waiting suggestion shows no note');
  assert.deepEqual(myRows([approved, waiting, declined], { now: NOW }).map(r => r.stands)[0], 'Waiting for the owner', 'the newest suggestion is first');
  assert.deepEqual(myRows(undefined), []);
});

test('the menu has "My suggestions" only for a person who may only suggest and has sent one', () => {
  assert.deepEqual(myItem({ suggest: true, count: 2 }), { show: true, label: 'My suggestions' });
  assert.equal(myItem({ suggest: true, count: 0 }).show, false);
  assert.equal(myItem({ suggest: false, count: 3 }).show, false);
  assert.equal(myItem().show, false);
  assert.equal(MY_TITLE, 'My suggestions');
});

test('what was decided since the person last looked', () => {
  const all = [waiting, approved, declined];
  assert.deepEqual(newlyDecided(all, 0).map(s => s.id), [declined.id, approved.id], 'the newest decision first, and never one that still waits');
  assert.deepEqual(newlyDecided(all, THU).map(s => s.id), [declined.id]);
  assert.deepEqual(newlyDecided(all, THU + 1000), []);
  assert.deepEqual(newlyDecided([{ status: 'approved', decided: null }, null, { status: 'declined', decided: { ts: 'soon' } }], 0), []);
  assert.equal(latestDecision(all), THU + 1000);
  assert.equal(latestDecision([waiting]), 0);
});

test('the status line says what became of a suggestion in one sentence', () => {
  assert.equal(decidedLine([approved]), 'Your suggestion for About was approved and is live.');
  assert.equal(decidedLine([declined]), 'Your suggestion for the home page was declined: Not this month, the dates are not fixed yet.');
  assert.equal(decidedLine([{ ...declined, page: 'about.html', decided: { ts: THU } }]), 'Your suggestion for About was declined.');
  assert.equal(decidedLine([{ ...approved, commit: null }]), 'Your suggestion for About was approved. The page already read that way.');
  assert.equal(decidedLine([declined, approved]), '2 of your suggestions were decided. Open the Kiln menu, then My suggestions, to read what the owner decided.');
  assert.equal(decidedLine([]), '');
});

test('an owner reads how many suggestions wait and where to find them', () => {
  assert.equal(waitingLine(1), '1 suggestion is waiting for you: Kiln menu, then Suggestions.');
  assert.equal(waitingLine(3), '3 suggestions are waiting for you: Kiln menu, then Suggestions.');
  assert.equal(waitingLine(0), '');
});

test('the dot: for an owner while anything waits, for a suggester until they have looked', () => {
  assert.equal(dotShown({ admin: true, waiting: 1 }), true);
  assert.equal(dotShown({ admin: true, waiting: 0 }), false);
  assert.equal(dotShown({ mine: [waiting] }), false, 'a suggestion that still waits is no news');
  assert.equal(dotShown({ mine: [waiting, approved], looked: 0 }), true);
  assert.equal(dotShown({ mine: [waiting, approved], looked: THU }), false, 'looking at the list clears it');
  assert.equal(dotShown({ mine: [approved, declined], looked: THU }), true, 'a later decision brings it back');
});

test('"last looked" is kept per person and per site, and anything unreadable counts as never looked', () => {
  assert.equal(seenKey('acme/site', 'Sam'), 'kiln_sug_seen:acme/site:Sam');
  assert.notEqual(seenKey('acme/site', 'Sam'), seenKey('acme/site', 'Ana'));
  assert.deepEqual(readSeen(keepSeen({ looked: THU, told: THU + 5 })), { looked: THU, told: THU + 5 });
  for (const bad of [null, '', 'not json', '[]', '{"looked":"x","told":-4}', '{"looked":null}']) assert.deepEqual(readSeen(bad), { looked: 0, told: 0 });
});

test('no sentence a person reads has an em dash', () => {
  const said = [MY_TITLE, MY_LEAD, MY_NONE, MY_NOT_READ, DOT_TITLE, waitingLine(1), waitingLine(2), decidedLine([approved]), decidedLine([declined]),
    decidedLine([approved, declined]), ...Object.values(myRow(declined, { now: NOW })), ...Object.values(myRow(approved, { now: NOW }))];
  for (const line of said) assert.doesNotMatch(String(line), /—|–/);
});

// ─── the editor ──────────────────────────────────────────────────────────────

test('the editor draws the signs for an owner and for a suggester', () => {
  const main = readFileSync(new URL('../src/editor/main.js', import.meta.url), 'utf8');
  const suggest = readFileSync(new URL('../src/editor/suggest.js', import.meta.url), 'utf8');
  assert.match(main, /<button id="kiln-mysuggestions" class="kiln-fab-item" hidden>\$\{escapeHtml\(MY_TITLE\)\}<\/button>/);
  assert.match(main, /<span id="kiln-fab-dot" title="\$\{escapeHtml\(DOT_TITLE\)\}" hidden><\/span>/);
  assert.match(main, /fab\.querySelector\('#kiln-mysuggestions'\)\.onclick = close\(mySuggestionsPanel\);/);
  assert.match(main, /if \(\(mode === 'admin' \|\| isSuggestMode\(\)\) && presenceTickN % 3 === 1\) refreshSuggestBadge\(\);/);
  assert.match(main, /suggestMode: isSuggestMode,/);
  assert.match(main, /startSuggestSigns\(\);/);
  assert.match(main, /#kiln-fab-dot\[hidden\]\{display:none!important\}/);
  // an owner is told once on each page load, a suggester once for each decision, and looking clears the dot
  assert.match(suggest, /if \(signs\.waiting > 0 && !saidWaiting\) \{\n\s+saidWaiting = true;\n\s+deps\.setStatus\(waitingLine\(signs\.waiting\), 'idle'\);/);
  assert.match(suggest, /const untold = newlyDecided\(mine, Math\.max\(seen\.looked, seen\.told\)\);/);
  assert.match(suggest, /seenKeep\(\{ looked: Math\.max\(seen\.looked, latest\), told: Math\.max\(seen\.told, latest\) \}\);/);
  // what the browser keeps is read and written inside try/catch
  assert.match(suggest, /try \{ kept = readSeen\(localStorage\.getItem\(seenKey\(deps\.cfg\.repo, deps\.state\.user\)\)\); \} catch \{/);
  assert.match(suggest, /try \{ localStorage\.setItem\(seenKey\(deps\.cfg\.repo, deps\.state\.user\), keepSeen\(seen\)\); \} catch \{/);
  // the owner's note is somebody else's writing: it never goes in as markup
  const panel = suggest.slice(suggest.indexOf('export async function mySuggestionsPanel()'), suggest.indexOf('export async function suggestionsPanel()'));
  assert.ok(panel.length > 0);
  assert.doesNotMatch(panel, /innerHTML/);
});

// ─── the service ─────────────────────────────────────────────────────────────

const ANA = 'b'.repeat(64);
const OLD = 'c'.repeat(64);
const sug = (id, more) => ({ id: id.repeat(12), page: 'about.html', by: 'Sam', email: 'sam@example.com', ts: WED, note: '', edits: [{ key: 'intro', html: 'Hello' }],
  branch: null, baseSha: null, status: 'open', decided: null, commit: null, ...more });
const site = () => editorEnv({ mode: 'suggest' }, {
  [`esess:${ANA}`]: { repo: REPO, name: 'Ana', role: 'editor', email: 'ana@example.com', paths: [''], keys: [], features: null, mode: 'suggest' },
  [`esess:${OLD}`]: { repo: REPO, name: 'Sam', role: 'editor', paths: [''], keys: [], features: null, mode: 'suggest' },   // a sign-in kept without an address
  [`sug:${REPO}:${'1'.repeat(12)}`]: sug('1'),
  [`sug:${REPO}:${'2'.repeat(12)}`]: sug('2', { ts: THU, status: 'declined', decided: { by: 'admin', ts: THU + 1000, note: 'Not this month.' } }),
  [`sug:${REPO}:${'3'.repeat(12)}`]: sug('3', { status: 'approved', decided: { by: 'admin', ts: THU }, commit: { sha: 'abc', url: 'https://github.com/acme/site/commit/abc' } }),
  [`sug:${REPO}:${'4'.repeat(12)}`]: sug('4', { by: 'Ana', email: 'ana@example.com', note: 'Ana’s own' }),
  [`sug:${REPO}:${'5'.repeat(12)}`]: sug('5', { by: 'Sam', email: undefined, note: 'kept without an address' }),
  [`sug:${REPO}:${'6'.repeat(12)}`]: sug('6', { by: 'Zed', email: undefined }),
});
const list = (env, session) => call(env, 'GET', `/suggestions?repo=${encodeURIComponent(REPO)}`, { session });

test('a suggester reads their own suggestions, with what was decided, when, and the note', async () => {
  const res = await list(site(), SESSION);
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.suggestions.map(s => s.id[0]).sort(), ['1', '2', '3']);
  assert.equal(res.json.counts.open, 1);
  const declinedOne = res.json.suggestions.find(s => s.id[0] === '2');
  assert.equal(declinedOne.status, 'declined');
  assert.deepEqual(declinedOne.decided, { by: 'admin', ts: THU + 1000, note: 'Not this month.' });
  const approvedOne = res.json.suggestions.find(s => s.id[0] === '3');
  assert.equal(approvedOne.status, 'approved');
  assert.equal(approvedOne.decided.ts, THU);
  assert.ok(approvedOne.commit.url);
});

test('a suggester never reads anybody else\'s suggestion', async () => {
  const env = site();
  const ana = await list(env, ANA);
  assert.deepEqual(ana.json.suggestions.map(s => s.id[0]), ['4']);
  assert.ok(ana.json.suggestions.every(s => s.email === 'ana@example.com'));
  // Two missing addresses are not a match: a sign-in without one reads what was sent under its own name, and nothing else.
  const old = await list(env, OLD);
  assert.deepEqual(old.json.suggestions.map(s => s.id[0]), ['5']);
  // Sam, who has an address, does not read the one kept without an address under the same name.
  assert.ok(!(await list(env, SESSION)).json.suggestions.some(s => s.id[0] === '5' || s.id[0] === '6' || s.id[0] === '4'));
});

test('nobody reads suggestions without being signed in, and a suggester cannot decide one', async () => {
  const env = site();
  assert.equal((await list(env, null)).status, 401);
  const res = await call(env, 'POST', '/suggestions/decide', { body: { repo: REPO, id: '4'.repeat(12), approve: true } });
  assert.equal(res.status, 403);
  assert.equal(JSON.parse(env.KILN.map.get(`sug:${REPO}:${'4'.repeat(12)}`)).status, 'open');
});
