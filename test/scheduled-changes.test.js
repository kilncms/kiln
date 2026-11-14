/**
 * What is already scheduled can be seen and cancelled without a throwaway edit
 * (src/editor/scheduled-changes.js).
 *
 * A tester scheduled an edit, which clears it from the page, and the menu item
 * that holds the list went with it. The rows said "11/12/2026, 8:38:00 PM · by
 * admin", Cancel asked nothing and said nothing, and the dialog still read
 * "Nothing scheduled." right after a schedule was made.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  scheduleItem, scheduledWhenLong, scheduledWhat, scheduledBy, scheduledRow, mergeScheduled, keepRecent, readRecent, cancelQuestion, cancelledLine, scheduledLine,
  LIST_TITLE, NOTHING_SCHEDULED, PUBLISH_FIRST, CANCEL_YES, CANCEL_NO,
} from '../src/editor/scheduled-changes.js';

const main = readFileSync(new URL('../src/editor/main.js', import.meta.url), 'utf8');
const between = (from, to) => main.slice(main.indexOf(from), main.indexOf(to, main.indexOf(from)));
const at = new Date(2026, 10, 12, 20, 45, 30).getTime();
const now = new Date(2026, 10, 10).getTime();
const us = { locale: 'en-US', now };

test('scheduled changes: the menu item is there while there is an edit to schedule or something scheduled to see', () => {
  assert.deepEqual(scheduleItem({ may: true, edits: 2, scheduled: 0 }), { show: true, label: 'Schedule for later…', listOnly: false });
  assert.deepEqual(scheduleItem({ may: true, edits: 1, scheduled: 3 }), { show: true, label: 'Schedule for later…', listOnly: false });
  // The fault: the edit was scheduled, so the page holds none, and the item left the menu.
  assert.deepEqual(scheduleItem({ may: true, edits: 0, scheduled: 1 }), { show: true, label: 'Scheduled changes (1)', listOnly: true });
  assert.equal(scheduleItem({ may: true, edits: 0, scheduled: 12 }).label, 'Scheduled changes (12)');
  assert.equal(scheduleItem({ may: true, edits: 0, scheduled: 0 }).show, false);
  // Someone who may not schedule never has it, whatever is scheduled.
  assert.equal(scheduleItem({ may: false, edits: 2, scheduled: 4 }).show, false);
  assert.equal(scheduleItem({ may: false, edits: 0, scheduled: 4 }).show, false);
  // The bar's own short word is kept while there is something to schedule.
  assert.equal(scheduleItem({ may: true, edits: 1, label: 'Schedule' }).label, 'Schedule');
  assert.equal(scheduleItem().show, false);
});

test('scheduled changes: a row says what, when to the minute in words, and who', () => {
  assert.equal(scheduledWhenLong(at, us), 'Thursday 12 November at 8:45 PM');
  assert.equal(scheduledWhenLong(new Date(2026, 10, 12, 0, 5).getTime(), us), 'Thursday 12 November at 12:05 AM');
  assert.equal(scheduledWhenLong(new Date(2026, 10, 12, 12, 0).getTime(), us), 'Thursday 12 November at 12:00 PM');
  assert.equal(scheduledWhenLong(at, { locale: 'en-GB', now }), 'Thursday 12 November at 20:45');
  assert.equal(scheduledWhenLong(new Date(2027, 0, 4, 9, 0).getTime(), us), 'Monday 4 January 2027 at 9:00 AM');
  assert.doesNotMatch(scheduledWhenLong(at, us), /:\d\d:\d\d/, 'no seconds');
  assert.equal(scheduledWhenLong('nonsense', us), 'at a time Kiln could not read');

  assert.equal(scheduledWhat({ kind: 'page', path: 'index.html', desc: 'index.html (hero-title, intro)' }), 'The home page');
  assert.equal(scheduledWhat({ kind: 'page', path: 'about.html', desc: 'about.html (lede)' }), 'The page /about.html');
  assert.equal(scheduledWhat({ kind: 'page', path: 'site/blog/index.html' }, 'site'), 'The page /blog/');
  assert.equal(scheduledWhat({ kind: 'source', path: 'src/content/events/gala.md', desc: 'Gala night goes on the site' }), 'Gala night goes on the site');
  assert.equal(scheduledWhat({ kind: 'source', path: 'src/content/events/gala.md', desc: 'src/content/events/gala.md' }), 'The file gala.md');
  assert.equal(scheduledWhat({}), 'A page of this site');

  // The service names an editor by name and every owner as "admin".
  assert.equal(scheduledBy({ by: 'Rosa' }, { me: 'Rosa' }), 'by you');
  assert.equal(scheduledBy({ by: 'Rosa' }, { me: 'Sam' }), 'by Rosa');
  assert.equal(scheduledBy({ by: 'Rosa' }, { me: 'octocat', owner: true }), 'by Rosa');
  assert.equal(scheduledBy({ by: 'admin' }, { me: 'Rosa' }), 'by the site owner');
  assert.equal(scheduledBy({ by: 'admin' }, { me: 'octocat', owner: true }), 'by the site owner');
  assert.equal(scheduledBy({ by: 'admin' }, { me: 'octocat', owner: true, mine: true }), 'by you');
  // An editor who happens to be named as the owner signs in is not "you" to the owner.
  assert.equal(scheduledBy({ by: 'octocat' }, { me: 'octocat', owner: true }), 'by octocat');
  assert.equal(scheduledBy({}, { me: 'Rosa' }), '');
  for (const who of [scheduledBy({ by: 'admin' }), scheduledBy({ by: 'admin' }, { mine: true })]) assert.doesNotMatch(who, /admin/);

  assert.deepEqual(scheduledRow({ kind: 'page', path: 'index.html', at, by: 'admin' }, { ...us, owner: true, mine: true }),
    { what: 'The home page', when: 'Thursday 12 November at 8:45 PM', who: 'by you' });
});

test('scheduled changes: a schedule made or cancelled a moment ago is in or out of the list at once, though the service lists it late', () => {
  const t = new Date(2026, 10, 12, 19, 0).getTime();
  const old = { id: 'a', at: t + 3600000, path: 'about.html', by: 'Rosa' };
  const mine = { id: 'b', at: t + 1800000, path: 'index.html', by: 'admin', madeAt: t };
  // The fault: the list came back without the schedule just made, and the dialog said "Nothing scheduled."
  assert.deepEqual(mergeScheduled([], { made: [mine], now: t + 500 }).map(r => r.id), ['b']);
  assert.deepEqual(mergeScheduled([old], { made: [mine], now: t + 500 }).map(r => r.id), ['b', 'a'], 'soonest first');
  // Once the service lists it, it is there once.
  assert.deepEqual(mergeScheduled([old, { ...mine, madeAt: undefined }], { made: [mine], now: t + 500 }).map(r => r.id), ['b', 'a']);
  // Two minutes on, the service's list is believed: someone else may have cancelled it.
  assert.deepEqual(mergeScheduled([old], { made: [mine], now: t + 121000 }).map(r => r.id), ['a']);
  // A row cancelled here goes at once, listed late or not, and a row made and cancelled here does not come back.
  assert.deepEqual(mergeScheduled([old], { cancelled: new Map([['a', t]]), now: t + 500 }), []);
  assert.deepEqual(mergeScheduled([], { made: [mine], cancelled: new Map([['b', t + 100]]), now: t + 500 }), []);
  assert.deepEqual(mergeScheduled([old], { cancelled: new Map([['a', t]]), now: t + 121000 }).map(r => r.id), ['a'], 'still listed two minutes on: it was not cancelled');
  assert.deepEqual(mergeScheduled(), []);
});

test('scheduled changes: Cancel asks one question, and says afterwards that nothing was published', () => {
  const home = { kind: 'page', path: 'index.html', at, by: 'Rosa' };
  assert.equal(cancelQuestion(home, us), 'Cancel the change to the home page, scheduled for Thursday 12 November at 8:45 PM?');
  assert.equal(cancelQuestion({ kind: 'page', path: 'about.html', at }, us), 'Cancel the change to the page /about.html, scheduled for Thursday 12 November at 8:45 PM?');
  assert.equal(cancelQuestion({ kind: 'source', path: 'src/content/events/gala.md', desc: 'Gala night goes on the site', at }, us), 'Cancel “Gala night goes on the site”, scheduled for Thursday 12 November at 8:45 PM?');
  assert.equal(cancelQuestion({ kind: 'source', path: 'src/content/events/gala.md', at }, us), 'Cancel the change to the file gala.md, scheduled for Thursday 12 November at 8:45 PM?');
  assert.equal(cancelQuestion(home, us).match(/\?/g).length, 1, 'one question');
  assert.equal(cancelledLine(), 'That scheduled change was canceled. Nothing was published.');
  assert.equal(cancelledLine({ shownHere: true }), 'That scheduled change was canceled. Nothing was published. This page still shows the scheduled words. Reload it to see the page as it is on the site.');
  assert.equal(CANCEL_YES, 'Yes, cancel it');
  assert.equal(CANCEL_NO, 'No, keep it');
});

test('scheduled changes: after scheduling, the line says when, and that only the page here shows the words until then', () => {
  assert.equal(scheduledLine(at, us), 'Scheduled for Thursday 12 November at 8:45 PM. Until then the page here shows the scheduled words, and visitors still see the old ones.');
  for (const said of [scheduledLine(at, us), cancelledLine({ shownHere: true }), cancelQuestion({ path: 'index.html', at }, us), LIST_TITLE, NOTHING_SCHEDULED, PUBLISH_FIRST]) {
    assert.doesNotMatch(said, /[—–]/, said);
  }
});

test('scheduled changes: the editor draws the list from these words, again after each schedule and each cancel', () => {
  const panel = between('function schedulePanel(', '\nfunction scheduleSourcePanel(');
  // The row is what, when and who from here, with no time of its own making and no bare "by".
  assert.match(panel, /scheduledRow\(s, \{ me: state\.user, owner: mode === 'admin', mine: state\.scheduledMine\.has\(s\.id\)/);
  assert.doesNotMatch(panel, /toLocaleString\(\)\} · by/);
  assert.doesNotMatch(panel, /Nothing scheduled\./);
  // Cancel asks first, and the request is sent only from the "yes" button.
  assert.ok(panel.includes('cancelQuestion(s, '));
  assert.ok(panel.indexOf('cancelQuestion(s, ') < panel.indexOf("ask('/schedule/cancel'"));
  assert.ok(panel.indexOf("[data-yes]').onclick") < panel.indexOf("ask('/schedule/cancel'"));
  // After a cancel: the one sentence in the dialog and on the status line, which until then may say when the change was scheduled for.
  const cancelled = panel.slice(panel.indexOf("ask('/schedule/cancel'"), panel.indexOf('async function refreshList('));
  assert.match(cancelled, /const line = cancelledLine\(\{ shownHere: state\.scheduledMine\.has\(s\.id\) \}\);\s+status\.textContent = line;\s+setStatus\(line, 'idle', \{ hold: \d+ \}\);/);
  assert.ok(cancelled.indexOf('state.scheduledGone.set(s.id') < cancelled.indexOf('setStatus(line'), 'only once the cancel was taken');
  assert.doesNotMatch(cancelled.slice(0, cancelled.indexOf('state.scheduledGone.set(s.id')), /setStatus\(/);
  // After a schedule: the true sentence in the dialog and on the status line, the part that schedules goes, the list is drawn again.
  const made = panel.slice(panel.indexOf('retireStaged();'));
  assert.ok(made.includes('const line = scheduledLine(data.at);'));
  assert.ok(made.includes('status.textContent = line;'));
  assert.match(made, /setStatus\(line, 'idle', \{ hold: \d+ \}\)/);
  assert.ok(made.includes("for (const el of m.querySelectorAll('[data-make]')) el.remove();"));
  assert.match(made, /state\.scheduledMade\.push\(\{ id: data\.id, at: data\.at, /);
  assert.ok(made.indexOf('refreshList();') > 0 && made.indexOf('refreshList();') < made.indexOf('} catch (err)'));
  assert.doesNotMatch(panel, /You can close this/);
  // The list alone opens with no edit on the page.
  assert.doesNotMatch(panel, /if \(!state\.pending\.size\) return;/);
  // The menu item follows the count the service gives, and both menus open the list alone when there is nothing to schedule.
  const refresh = between('function refreshPublishButton()', '\nfunction ', );
  assert.ok(refresh.includes('scheduleItem({ may: !sched.dataset.gated, edits: nHtml, scheduled: state.scheduled, label: sched.dataset.label })'));
  assert.equal(main.match(/onclick = (close\()?openScheduleItem\)?;/g).length, 2, 'the menu and the bar');
  const fetched = between('async function fetchScheduled()', '\n}');
  assert.ok(fetched.includes('mergeScheduled(data.schedules || [], { made: state.scheduledMade, cancelled: state.scheduledGone })'));
  assert.ok(fetched.includes('refreshPublishButton();'));
});

test('scheduled: what is scheduled is counted when the page loads for the owner too, before the owner is sent past the tool limits', () => {
  // Found in a real browser on 0.6.5 before its release: after a reload the
  // owner's menu had no "Scheduled changes", because the count was asked for
  // only below the line that returns early for an owner.
  const gating = between('function applyFeatureGating()', '\n}');
  const asked = gating.indexOf('fetchScheduled().catch(() => {});');
  const ownerSentOn = gating.indexOf("if (mode === 'admin' || cfg.sandbox) { hideEmptyGroups(); return; }");
  assert.ok(asked > 0 && ownerSentOn > 0);
  assert.ok(asked < ownerSentOn, 'asked before the owner is sent on');
  assert.equal(gating.split('fetchScheduled()').length - 1, 1, 'and asked once');
  assert.match(gating, /if \(!cfg\.sandbox && !state\.scheduledAsked && \(mode === 'admin' \|\| \(hasFeature\('schedule'\) && !isSuggestMode\(\)\)\)\) \{/);
});

test('scheduled: what this browser scheduled or cancelled a moment ago is kept across a reload, for two minutes and no longer', () => {
  // Found in a real browser on 0.6.5 before its release: schedule, reload within the minute, and the
  // menu had no "Scheduled changes", because the service's list lags and the reload forgot what the tab knew.
  const now = 1_000_000_000_000;
  const made = [{ id: 'sched:a', at: now + 3600000, path: 'index.html', kind: 'page', by: 'admin', madeAt: now - 20000 }, { id: 'sched:old', at: now + 3600000, path: 'a.html', kind: 'page', by: 'Rosa', madeAt: now - 200000 }];
  const cancelled = new Map([['sched:b', now - 5000], ['sched:c', now - 500000]]);
  const text = keepRecent({ made, cancelled, now });
  const back = readRecent(text, { now: now + 30000 });
  assert.deepEqual(back.made, [made[0]]);
  assert.deepEqual([...back.cancelled], [['sched:b', now - 5000]]);
  // after the reload the count is right even though the service lists nothing yet, and a cancelled row stays out
  assert.equal(mergeScheduled([], { made: back.made, cancelled: back.cancelled, now: now + 30000 }).length, 1);
  assert.equal(mergeScheduled([{ id: 'sched:b', at: now + 100000 }], { made: back.made, cancelled: back.cancelled, now: now + 30000 }).some(r => r.id === 'sched:b'), false);
  // two minutes on, nothing of it is believed any more
  assert.deepEqual(readRecent(text, { now: now + 200000 }), { made: [], cancelled: new Map() });
  // and whatever else is found in the browser's store is not believed at all
  for (const junk of ['', 'null', '{', '[]', '{"made":"x","gone":7}', JSON.stringify({ made: [{ id: 5, at: 'soon', madeAt: now }, { id: 'x', at: now, madeAt: now + 99999 }], gone: [['y'], [3, now]] })]) {
    assert.deepEqual(readRecent(junk, { now }), { made: [], cancelled: new Map() }, junk);
  }
  assert.ok(main.includes('rememberRecentSchedules();') && main.includes('recallRecentSchedules();'));
});
