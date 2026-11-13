/**
 * What became of a suggestion, told to the person who made it, and the sign
 * an owner gets that one is waiting.
 *
 * A tester sent two suggestions as an invited person who may only suggest.
 * The owner approved one and declined the other, with a note. Back as the
 * suggester there was nothing anywhere about either: no status, no badge, no
 * menu entry. The owner's own dialog had promised "The person who suggested
 * it sees that it was declined, with your note if you write one." And the
 * owner's only sign that a suggestion waited was a number inside the menu.
 *
 * Here: whether the suggester's menu has "My suggestions" (myItem), what each
 * row of that list says (myRow), which of their suggestions were decided since
 * they last looked (newlyDecided), the one sentence the status line says about
 * them (decidedLine), the sentence an owner reads when suggestions wait
 * (waitingLine), and what the browser remembers of "last looked" (seenKey,
 * readSeen, keepSeen). suggest.js asks the service and draws; every word
 * comes from this file.
 *
 * "Last looked" is the service's time of the newest decision the person has
 * seen in the list, not this browser's clock, so a clock that is wrong here
 * hides nothing.
 *
 * Pure, and tested in node (test/my-suggestions.test.js).
 */

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** The menu entry and the title of its dialog. */
export const MY_TITLE = 'My suggestions';
/** The line under the title. */
export const MY_LEAD = 'What you sent for review, and what the owner of the site decided.';
/** The list when the service keeps none of theirs. */
export const MY_NONE = 'You have not sent a suggestion yet. Edit a page, then press Send for review.';
/** The list when it could not be read. */
export const MY_NOT_READ = 'Your suggestions could not be read. Close this and open it again in a moment.';
/** What the small dot on the Kiln button says to a pointer that rests on it. */
export const DOT_TITLE = 'There is news in the Kiln menu';

/** A day in words: "Thursday 12 November". The year is said only when it is not this one. '' when unreadable. */
export function dayLong(ts, { now = Date.now() } = {}) {
  const d = new Date(ts);
  if (!Number.isFinite(ts) || ts <= 0 || Number.isNaN(d.getTime())) return '';
  const year = d.getFullYear() === new Date(now).getFullYear() ? '' : ` ${d.getFullYear()}`;
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}${year}`;
}

/** A page's file with the site's folder taken off: "site/about.html" in "site" is "about.html". */
function tidy(path, root = '') {
  let p = String(path || '').replace(/^\/+/, '');
  const r = String(root || '').replace(/^\/+|\/+$/g, '');
  if (r && (p === r || p.startsWith(r + '/'))) p = p.slice(r.length + 1);
  return p;
}

/**
 * A page named in a sentence: "the home page" for index.html, "About" for
 * about.html, "Blog" for blog/index.html, "Spring fair" for news/spring-fair.html.
 */
export function pageName(path, root = '') {
  const p = tidy(path, root);
  if (!p) return 'a page';
  if (p === 'index.html' || p === 'index.htm') return 'the home page';
  const parts = p.split('/').filter(Boolean);
  let last = parts.pop() || '';
  if (/^index\.html?$/i.test(last) && parts.length) last = parts.pop();
  const words = last.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').trim();
  if (!words) return 'a page';
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A page's address on the site: "/", "/about.html", "/blog/". */
export function pageAddress(path, root = '') {
  const p = tidy(path, root);
  return `/${p.replace(/(^|\/)index\.html?$/i, '$1')}`;
}

const on = (day) => (day ? ` on ${day}` : '');
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * What one row of "My suggestions" says.
 *   page    "About", "The home page"
 *   where   "/about.html"
 *   sent    "Sent on Thursday 12 November"
 *   stands  "Waiting for the owner", "Approved and published on …", "Declined on …"
 *   note    the owner's note, when one was written with a decline or an approval
 *   state   'open' | 'approved' | 'declined'
 */
export function myRow(sug = {}, { root = '', now } = {}) {
  const state = sug.status === 'approved' || sug.status === 'declined' ? sug.status : 'open';
  const day = dayLong(sug.decided?.ts, { now });
  let stands = 'Waiting for the owner';
  if (state === 'approved') stands = sug.commit ? `Approved and published${on(day)}` : `Approved${on(day)}. The page already read that way.`;
  if (state === 'declined') stands = `Declined${on(day)}`;
  const note = String(sug.decided?.note || '').trim();
  const sent = dayLong(sug.ts, { now });
  return {
    page: cap(pageName(sug.page, root)),
    where: pageAddress(sug.page, root),
    sent: sent ? `Sent on ${sent}` : 'Sent',
    stands,
    note: state !== 'open' && note ? `The owner’s note: “${note}”` : '',
    state,
  };
}

/** Every row, the newest suggestion first. */
export function myRows(list = [], opts = {}) {
  return [...(Array.isArray(list) ? list : [])].sort((a, b) => (b.ts || 0) - (a.ts || 0)).map(s => myRow(s, opts));
}

/** Whether the suggester's menu has "My suggestions": only for a person who may only suggest, and only when the service keeps one of theirs. */
export function myItem({ suggest = false, count = 0 } = {}) {
  return { show: !!suggest && count > 0, label: MY_TITLE };
}

/** Their suggestions that were decided after `since` (a time from the service), the newest decision first. */
export function newlyDecided(list = [], since = 0) {
  return (Array.isArray(list) ? list : [])
    .filter(s => s && (s.status === 'approved' || s.status === 'declined') && Number.isFinite(s.decided?.ts) && s.decided.ts > since)
    .sort((a, b) => b.decided.ts - a.decided.ts);
}

/** The newest decision's time in a list, 0 when nothing is decided. */
export function latestDecision(list = []) {
  return newlyDecided(list, 0).reduce((t, s) => Math.max(t, s.decided.ts), 0);
}

/**
 * The one sentence the status line says about what was decided.
 *   "Your suggestion for About was approved and is live."
 *   "Your suggestion for About was declined: Not this month."
 * More than one is counted, with where to read them.
 */
export function decidedLine(news = [], { root = '' } = {}) {
  if (!news.length) return '';
  if (news.length > 1) return `${news.length} of your suggestions were decided. Open the Kiln menu, then My suggestions, to read what the owner decided.`;
  const s = news[0];
  const name = pageName(s.page, root);
  if (s.status === 'approved') return s.commit ? `Your suggestion for ${name} was approved and is live.` : `Your suggestion for ${name} was approved. The page already read that way.`;
  const note = String(s.decided?.note || '').trim();
  return note ? `Your suggestion for ${name} was declined: ${note}` : `Your suggestion for ${name} was declined.`;
}

/** What an owner reads, once on each page load, while suggestions wait. */
export function waitingLine(n) {
  if (!(n > 0)) return '';
  return n === 1
    ? '1 suggestion is waiting for you: Kiln menu, then Suggestions.'
    : `${n} suggestions are waiting for you: Kiln menu, then Suggestions.`;
}

/** Whether the Kiln button shows its small dot. */
export function dotShown({ admin = false, waiting = 0, mine = [], looked = 0 } = {}) {
  return admin ? waiting > 0 : newlyDecided(mine, looked).length > 0;
}

/** Where this browser keeps "last looked" for one person on one site. */
export function seenKey(repo, name) {
  return `kiln_sug_seen:${repo || ''}:${name || ''}`;
}

/**
 * "Last looked", as the browser keeps it: `looked` is the newest decision the
 * person has seen in the list, `told` the newest one the status line has
 * said. Anything that does not read as that is taken as never looked.
 */
export function readSeen(text) {
  let kept = null;
  try { kept = JSON.parse(text || 'null'); } catch { kept = null; }
  const time = (t) => (Number.isFinite(t) && t > 0 ? t : 0);
  return { looked: time(kept?.looked), told: time(kept?.told) };
}
export function keepSeen({ looked = 0, told = 0 } = {}) {
  return JSON.stringify({ looked: Number(looked) || 0, told: Number(told) || 0 });
}
