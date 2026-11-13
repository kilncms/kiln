/**
 * What is already scheduled: when the menu shows it, and what each row says.
 *
 * A tester scheduled an edit and then could not find it. "Schedule for later…"
 * was in the Kiln menu only while the page held an unpublished edit, the list
 * of what is scheduled lived inside that dialog, and scheduling clears the
 * edit. So the only way back to the list, or to Cancel, was a throwaway edit.
 * The rows read "11/12/2026, 8:38:00 PM · by admin", Cancel asked nothing and
 * said nothing, and the page went on showing the scheduled words with no sign
 * that they were waiting.
 *
 * Here: whether the menu has the item and what it reads (scheduleItem), the
 * three things a row says (scheduledRow: what, when, who), the one question
 * Cancel asks, and the sentences after a schedule is made or cancelled.
 * main.js fetches the list and draws it; every word comes from this file.
 *
 * Who made a schedule: the service names an editor by the name they were
 * invited with, and every owner as "admin". So "by you" is said when this tab
 * made the schedule, or when an editor's own name is on it. An owner looking
 * at an owner's schedule made somewhere else is told "by the site owner",
 * which is true whichever owner it was.
 *
 * Pure, and tested in node (test/scheduled-changes.test.js).
 */
import { placeSaid } from './your-pages.js';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** The title of the dialog when it holds the list alone. */
export const LIST_TITLE = 'Scheduled changes';
/** The list when it is empty. */
export const NOTHING_SCHEDULED = 'Nothing is scheduled.';
/** The list while there are new pictures or added sections, which a schedule cannot carry. */
export const PUBLISH_FIRST = 'To schedule an edit, publish your new pictures and added sections first. A schedule carries words only.';
/** The two answers to the Cancel question. */
export const CANCEL_YES = 'Yes, cancel it';
export const CANCEL_NO = 'No, keep it';

/**
 * The schedule item in the Kiln menu.
 *   may        this person may schedule here
 *   edits      unpublished edits on the page that a schedule can carry
 *   scheduled  how many scheduled changes the service lists for this site
 *   label      what the item reads while there is something to schedule
 * `listOnly`: the dialog opens on the list, without the part that schedules.
 */
export function scheduleItem({ may = false, edits = 0, scheduled = 0, label = 'Schedule for later…' } = {}) {
  if (!may) return { show: false, label, listOnly: false };
  if (edits > 0) return { show: true, label, listOnly: false };
  if (scheduled > 0) return { show: true, label: `${LIST_TITLE} (${scheduled})`, listOnly: true };
  return { show: false, label, listOnly: false };
}

/** Whether this person's clock reads "8:45 PM" (true) or "20:45". */
function twelveHour(locale) {
  try { return new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions().hour12 !== false; } catch { return true; }
}

/**
 * A scheduled time in words, to the minute: "Thursday 12 November at 8:45 PM".
 * The year is said only when it is not this one.
 */
export function scheduledWhenLong(at, { locale, now = Date.now() } = {}) {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return 'at a time Kiln could not read';
  const h = d.getHours();
  const min = String(d.getMinutes()).padStart(2, '0');
  const time = twelveHour(locale) ? `${h % 12 || 12}:${min} ${h < 12 ? 'AM' : 'PM'}` : `${String(h).padStart(2, '0')}:${min}`;
  const year = d.getFullYear() === new Date(now).getFullYear() ? '' : ` ${d.getFullYear()}`;
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}${year} at ${time}`;
}

/** What a row changes, in plain words. `root`: the folder the site's pages are in. */
export function scheduledWhat(row = {}, root = '') {
  if (row.kind === 'source') {
    const desc = String(row.desc || '').trim();
    return desc && desc !== row.path ? desc : `The file ${String(row.path || '').split('/').pop() || 'for this site'}`;
  }
  if (!row.path) return 'A page of this site';
  const place = placeSaid(row.path, root);
  return place === 'the home page' ? 'The home page' : `The page ${place}`;
}

/**
 * Who scheduled it: "by you", "by Rosa", "by the site owner".
 *   me     the name this person is signed in under
 *   owner  this person is an owner of the site
 *   mine   this tab made the schedule
 */
export function scheduledBy(row = {}, { me = '', owner = false, mine = false } = {}) {
  if (mine) return 'by you';
  const by = String(row.by || '').trim();
  if (!by) return '';
  if (by === 'admin') return 'by the site owner';
  if (!owner && me && by === me) return 'by you';
  return `by ${by}`;
}

/** The three things a row says. */
export function scheduledRow(row = {}, { me = '', owner = false, mine = false, root = '', locale, now } = {}) {
  return {
    what: scheduledWhat(row, root),
    when: scheduledWhenLong(row.at, { locale, now }),
    who: scheduledBy(row, { me, owner, mine }),
  };
}

/**
 * The list the dialog shows: what the service lists, put right for what this
 * tab did a moment ago. The service's list can lag by up to a minute, which is
 * why the dialog read "Nothing scheduled." just after a schedule was made, and
 * would show a cancelled row again.
 *   made       rows this tab scheduled, each with `madeAt` (ms)
 *   cancelled  Map of id to the time (ms) this tab cancelled it
 * A row made here is added until the service lists it, for two minutes at
 * most. A row cancelled here is left out for the same two minutes.
 */
export function mergeScheduled(listed = [], { made = [], cancelled = new Map(), now = Date.now(), lag = 120000 } = {}) {
  const have = new Set(listed.map(r => r.id));
  const rows = listed.filter(r => !(cancelled.has(r.id) && now - cancelled.get(r.id) < lag));
  for (const r of made) {
    if (!have.has(r.id) && !cancelled.has(r.id) && now - r.madeAt < lag && r.at > now) rows.push(r);
  }
  return rows.sort((a, b) => a.at - b.at);
}

/**
 * What this browser remembers of the changes it scheduled and cancelled a
 * moment ago, so the menu is right after a reload as well. The service's list
 * can be a minute behind, and a reload used to forget what the tab knew: the
 * menu then had no "Scheduled changes" for a change scheduled seconds before.
 * `keepRecent` gives the text to keep (rows and cancellations younger than
 * the lag), and `readRecent` reads it back, dropping what has grown old or
 * does not look right. Nothing here is trusted beyond the two minutes.
 */
export function keepRecent({ made = [], cancelled = new Map(), now = Date.now(), lag = 120000 } = {}) {
  return JSON.stringify({
    made: made.filter(r => r && r.id && now - r.madeAt < lag).map(r => ({ id: String(r.id), at: Number(r.at), path: String(r.path || ''), kind: String(r.kind || 'page'), by: String(r.by || ''), madeAt: Number(r.madeAt) })),
    gone: [...cancelled].filter(([, t]) => now - t < lag).map(([id, t]) => [String(id), Number(t)]),
  });
}
export function readRecent(text, { now = Date.now(), lag = 120000 } = {}) {
  let kept = null;
  try { kept = JSON.parse(text || 'null'); } catch { kept = null; }
  const fresh = (t) => Number.isFinite(t) && t <= now && now - t < lag;
  const made = (Array.isArray(kept?.made) ? kept.made : []).filter(r => r && typeof r.id === 'string' && r.id && Number.isFinite(r.at) && fresh(r.madeAt))
    .map(r => ({ id: r.id, at: r.at, path: String(r.path || ''), kind: String(r.kind || 'page'), by: String(r.by || ''), madeAt: r.madeAt }));
  const cancelled = new Map((Array.isArray(kept?.gone) ? kept.gone : []).filter(g => Array.isArray(g) && typeof g[0] === 'string' && fresh(g[1])).map(g => [g[0], g[1]]));
  return { made, cancelled };
}

/** The one question Cancel asks before anything is cancelled. */
export function cancelQuestion(row = {}, { root = '', locale, now } = {}) {
  const what = scheduledWhat(row, root);
  const when = scheduledWhenLong(row.at, { locale, now });
  // A content file's row is already a sentence of its own ("Gala night goes on the site").
  if (row.kind === 'source' && !what.startsWith('The file ')) return `Cancel “${what}”, scheduled for ${when}?`;
  return `Cancel the change to ${what.charAt(0).toLowerCase()}${what.slice(1)}, scheduled for ${when}?`;
}

/** After a cancel. `shownHere`: this page still shows the words that were scheduled. */
export function cancelledLine({ shownHere = false } = {}) {
  return 'That scheduled change was cancelled. Nothing was published.'
    + (shownHere ? ' This page still shows the scheduled words. Reload it to see the page as it is on the site.' : '');
}

/** After a schedule is made: when it will be published, and what the page here shows until then. */
export function scheduledLine(at, { locale, now } = {}) {
  return `Scheduled for ${scheduledWhenLong(at, { locale, now })}. Until then the page here shows the scheduled words, and visitors still see the old ones.`;
}
