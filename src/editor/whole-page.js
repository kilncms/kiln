/**
 * "Make this whole page editable": the second button in the bar of
 * make-editable mode.
 *
 * Marking a page one click at a time is slow on a page nobody has marked yet.
 * The setup tool and the dashboard already make a cautious first pass over a
 * whole page (src/autotag.js). This offers that same pass for the page that is
 * open, to whoever may use "Make text/images editable" on it. It only ever
 * adds marks, it is checked for exactly that on the very text that is written,
 * and it is saved as one change to this one page.
 *
 * Everything here is pure and tested in node: whether the button is offered,
 * what the pass would do to a page's text, the words of the question and of
 * each notice, the commit message, and how the editor knows the site has the
 * change. Reading the file, asking, writing and reloading are in main.js.
 */
import { autotag, onlyAddsMarks } from '../autotag.js';

export const WHOLE_PAGE_BUTTON = 'Make this whole page editable';
export const WHOLE_PAGE_READING = 'Reading this page…';
export const WHOLE_PAGE_SAVING = 'Saving…';
/** The status line once the change is saved, while the site rebuilds with it. */
export const WHOLE_PAGE_SAVED = 'Saved. This page reloads by itself when the site has the change, usually in under a minute.';
/** …and when the page is not reloaded for the person: the site is slow, or they have begun to edit. */
export const WHOLE_PAGE_RELOAD = 'The marks are saved. Reload this page in a minute to use them.';
/** What a failure is told with (plain-failure.js notDone). */
export const WHOLE_PAGE_NOT_DONE = 'Nothing on this page was marked.';

const KINDS = ['fields', 'images', 'repeats', 'menu'];
const isHtml = (path) => /\.html?$/i.test(String(path || ''));

/**
 * Whether the bar offers the button: only where pressing it can work.
 *
 *   canMake       "Make text/images editable" is this person's, on this page (grants.js)
 *   sandbox       the demo: there is no file to save
 *   sourceMode    the site builds its pages from content files
 *   sourceFields  this page shows parts that come from content files
 *   path          the page's own file in the repository ('' when it has none)
 *   sectionLimit  an invited editor limited to some parts of a page: the
 *                 service takes no change outside those parts from them, and
 *                 a first pass marks the whole page
 */
export function offersWholePage(where = {}) {
  if (!where.canMake || where.sandbox) return false;
  if (where.sourceMode || where.sourceFields) return false;
  if (where.sectionLimit) return false;
  return isHtml(where.path);
}

/**
 * What the first pass would do to a page's text. `state` is:
 *   'ready'    there is something to mark: { html, counts }
 *   'nothing'  the pass finds nothing more to mark
 *   'unsafe'   the pass would do more than add marks, or could not read the
 *              page at all. Nothing may be written.
 */
export function wholePagePass(text) {
  let out = null;
  try { out = autotag(String(text)); } catch { out = null; }
  if (!out || typeof out.html !== 'string') return { state: 'unsafe' };
  if (out.html === text) return { state: 'nothing' };
  if (!onlyAddsMarks(text, out.html)) return { state: 'unsafe' };
  const counts = Object.fromEntries(KINDS.map(k => [k, Number(out.counts?.[k]) || 0]));
  return { state: 'ready', html: out.html, counts };
}

/**
 * The text to write, worked out again from the file as it is at the moment of
 * writing: { html }, or { why } and nothing is written. The person agreed to
 * `agreed` (the counts in the question), so a file that has changed enough
 * since to give other counts is not written ('moved'): they are asked again.
 */
export function wholePageWrite(text, agreed) {
  const pass = wholePagePass(text);
  if (pass.state === 'unsafe') return { why: 'unsafe' };
  if (pass.state !== 'ready' || KINDS.some(k => pass.counts[k] !== (Number(agreed?.[k]) || 0))) return { why: 'moved' };
  return { html: pass.html };
}

/** Why nothing was written, as the editor says it (plain-failure.js said). */
export const WHOLE_PAGE_WHY = {
  unsafe: 'Kiln’s first pass would have changed more than marks on this page, which should never happen, so the page was left exactly as it is',
  moved: 'The page’s file changed while you were deciding, so please press the button again to see what would be marked now',
};

const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const listed = (parts) => (parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0] || '');

/** "12 pieces of text, 3 pictures, 1 list of blocks and the menu" */
export function markedWords(counts = {}) {
  return listed([
    counts.fields ? count(counts.fields, 'piece of text', 'pieces of text') : '',
    counts.images ? count(counts.images, 'picture', 'pictures') : '',
    counts.repeats ? count(counts.repeats, 'list of blocks', 'lists of blocks') : '',
    counts.menu ? 'the menu' : '',
  ].filter(Boolean));
}

/**
 * What a dialog says: { title, body, go, cancel } for the question ('ask'),
 * { title, body, ok } for a notice. `body` is a list of short paragraphs.
 */
export function wholePageCopy(kind, info = {}) {
  if (kind === 'ask') {
    const c = info.counts || {};
    return { title: 'Make this whole page editable?',
      body: [
        `Kiln will mark ${markedWords(c)} on this page.${c.repeats ? ` In a list of blocks, editors can add, remove and reorder the blocks.` : ''}`,
        'It leaves tables, buttons and forms alone, and anything that is already marked. A visitor sees no difference.',
        'This is a first pass. Any part of it can be made plain again by clicking it in this same mode.',
        'It is saved at once as one change to this page, in your name. The page then reloads when the site has the change, usually in under a minute.',
      ],
      cancel: 'Cancel', go: 'Make them editable', risky: false };
  }
  if (kind === 'unpublished') {
    return { title: 'Publish or discard your changes first',
      body: ['This page has changes that are not published yet. Making the whole page editable saves the page at once, so please publish those changes or discard them, and then press the button again.'],
      ok: 'OK' };
  }
  if (kind === 'nothing') {
    return { title: 'There is nothing more to mark on this page',
      body: ['The first pass marks headings, paragraphs, quotes, captions, pictures, repeating blocks such as cards, and the menu. It found nothing more of that kind to mark here: what is left is already marked, or is part of something that is. Anything else can still be made editable by clicking it.'],
      ok: 'OK' };
  }
  if (kind === 'unsafe') {
    return { title: 'Nothing was changed',
      body: [`${WHOLE_PAGE_WHY.unsafe}. Parts of it can still be made editable one at a time, by clicking them.`],
      ok: 'OK' };
  }
  throw new Error(`no such dialog: ${kind}`);
}

/** The commit message, in the style of the editor's others ("Edit index.html: title (via Kiln)"). */
export function wholePageMessage(path, counts) {
  return `Mark a first pass of what can be edited on ${path}: ${markedWords(counts)} (via Kiln)`;
}

/** How many marks a page's text holds. */
export function marksIn(text) {
  return (String(text || '').match(/\sdata-cms(?:-repeat|-menu)?="/g) || []).length;
}

/**
 * What the editor leaves for itself across the reload (sessionStorage, under
 * WHOLE_PAGE_NOTE): which file was written and how many marks it then held.
 * GitHub can answer a read with a file as it was for a moment after a write,
 * and a fast host has the page out before that moment is over. The page would
 * then show the new marks while the file the editor read had none of them, and
 * a part is only editable when the file has its mark.
 */
export const WHOLE_PAGE_NOTE = 'kiln_whole_page';
export function wholePageNote(path, saved) {
  return JSON.stringify({ path: String(path || ''), marks: marksIn(saved) });
}
/** True when the file just read for `path` is still the one from before the write the note is about. */
export function fileIsBehind(note, path, text) {
  let n = null;
  try { n = typeof note === 'string' ? JSON.parse(note) : note; } catch { n = null; }
  if (!n || typeof n !== 'object' || !n.path || n.path !== path) return false;
  const want = Number(n.marks) || 0;
  return want > 0 && marksIn(text) < want;
}

/**
 * True once what the site serves for this page holds the marks that were
 * saved. Counted, not compared letter for letter: a host may serve a page a
 * little differently from its file (smaller, or with a line of its own added).
 */
export function servesMarks(served, saved) {
  const want = marksIn(saved);
  return want > 0 && marksIn(served) >= want;
}
