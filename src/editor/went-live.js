/**
 * What the editor says after Publish, and when it says it.
 *
 * Three things went wrong here for a person testing the editor.
 *
 * "live ✓" was said on one good answer from the site. The copies of a site
 * around the network do not all change at the same moment, so the next
 * request, a few seconds later, could still get the old page. Now the page
 * has to come back holding the change several times in a row, a little apart
 * (`stillThere`), before the line says it is live.
 *
 * The line then went back to "Signed in as …" a few seconds later, and anyone
 * who had looked away never saw it. Now it stays for half a minute, and the
 * line the editor rests on afterwards says when the last publish went live
 * (`restLine`), for as long as the page is open.
 *
 * And once the line said "Not published" about a change that was published:
 * the commit had been made, and a step after it (reading the file back) was
 * turned away. Nothing that happens after the commit is told as a failed
 * publish any more. When the editor cannot watch the change go live it says
 * that it cannot tell, and how to check.
 *
 * Pure, and tested in node; main.js does the asking and the showing.
 */

/** Good answers in a row before "live" is said, and the wait between them. */
export const LIVE_ANSWERS = 3;
export const LIVE_ANSWER_GAP = 2000;
/** How long "live ✓" stays on the line: on a phone the line covers the page, so it is shorter there. */
export const LIVE_STAYS = 30000;
export const LIVE_STAYS_PHONE = 10000;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * The page has just come back holding the change, once. Ask again, a little
 * apart, until it has done so `answers` times in all. One miss, or one
 * request that fails, and it is not live yet: the caller goes on waiting.
 */
export async function stillThere(ask, { answers = LIVE_ANSWERS, gap = LIVE_ANSWER_GAP, wait = sleep } = {}) {
  for (let n = 1; n < answers; n++) {
    await wait(gap);
    let ok = false;
    try { ok = !!(await ask()); } catch { ok = false; }
    if (!ok) return false;
  }
  return true;
}

/** A time of day as this person's own clock shows it: "3:52 PM". */
export function clockTime(at, locale) {
  try { return new Date(at).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' }); } catch { return ''; }
}

/**
 * A line the editor rests on, with when the last publish went live said after
 * it. Said once however often the line is shown again: an earlier note of it
 * is taken off first.
 */
export function withLastLive(line, lastLive, { locale } = {}) {
  const base = String(line || '').replace(/\.? ?Your last publish went live[^.]*\.$/, '');
  if (!lastLive || !lastLive.at) return base + (/[.!?]$/.test(String(line || '')) && !/[.!?]$/.test(base) ? '.' : '');
  const when = clockTime(lastLive.at, locale);
  return `${base}${/[.!?]$/.test(base) ? '' : '.'} Your last publish went live${when ? ` at ${when}` : ''}.`;
}

/** The line the editor rests on when nothing is happening. After a publish went live it goes on saying so. */
export function restLine(user, lastLive, opts) {
  const who = `Signed in as ${user}`;
  return lastLive && lastLive.at ? withLastLive(who, lastLive, opts) : who;
}

/** Six minutes on, the page still does not hold the change. It was saved; why it does not show is not known. */
export const PUBLISHED_NOT_SEEN = 'Published, but this page is not showing the change yet and Kiln cannot tell why. Reload the page in a few minutes to see it. History in the Kiln menu shows that it was saved.';
/** The commit was made and something after it stopped: the change is published, and cannot be watched. */
export const PUBLISHED_NOT_WATCHED = 'Published. Kiln could not go on to watch the change reach your site, so it cannot tell you when it is live. Reload this page in a minute to see it. History in the Kiln menu shows that it was saved.';
/** This page's file was committed; the parts shared with other pages were not. */
export const SHARED_NOT_PUBLISHED = 'The changes to this page are published. The parts it shares with other pages are not yet, because the site could not take them just now. Your edits are still here, so press Publish again in a minute.';
