/**
 * Try-out mode (`sandbox: true` in kiln-config.js): the public demo, where
 * every visitor edits a private copy that is kept in their own browser.
 *
 * Two things live here, both pure and tested in node:
 *
 *  - What the demo says where something cannot act without a real site. One
 *    shape for all of them ("Nothing is … in the demo. On a real site, ….")
 *    so that no menu item answers with an error, or with nothing.
 *
 *  - The history of this browser's publishes (below).
 */

const REAL = {
  preview: ['Nothing is shared in the demo', 'your edits are saved as a draft and you get a link that shows the page with them, before anything is published'],
  schedule: ['Nothing is scheduled in the demo', 'you pick a time and Kiln publishes these edits for you then'],
  suggestions: ['Nothing here in the demo', 'changes from people who may only suggest wait here for the owner to approve'],
  newpage: ['Nothing is created in the demo', 'this makes a new page from the site’s own template and puts it live in about a minute'],
  pagesettings: ['Nothing is saved in the demo', 'this changes the title and description that search results and link previews show'],
  menu: ['Nothing is saved in the demo', 'this changes the menu on every page at once'],
  findreplace: ['Nothing is replaced in the demo', 'this finds the words on every page and replaces them in one go'],
  people: ['Nobody is added in the demo', 'the people you add here sign in with Google and edit only what you let them'],
  ai: ['Nothing here in the demo', 'this rewrites, shortens or translates the text you are editing, using the site owner’s own AI key'],
  alt: ['Nothing here in the demo', 'this writes the picture’s description for you, using the site owner’s own AI key'],
  theme: ['Nothing is saved in the demo', 'Apply puts these colours and sizes on every page'],
  blocks: ['Nothing to add in the demo', 'this lists the ready-made sections the site’s owner has approved'],
};

/** What the demo says in place of `what` (a key of the list above). */
export function demoSays(what) {
  const [here, there] = REAL[what];
  return `${here}. On a real site, ${there}.`;
}

/** The first half alone, for a second telling in the same place ("Nothing is scheduled in the demo."). */
export function demoShort(what) {
  return `${REAL[what][0]}.`;
}

/** Every item the demo has a sentence for (for the test that reads them all). */
export const DEMO_ITEMS = Object.keys(REAL);

// What the demo's own Save as draft says.
export const DEMO_DRAFT_SAVED = 'Draft saved in this browser. Nothing is published, and this page will offer it back when you open it again.';

// ─── The history of this browser's publishes ─────────────────────────────────
// The demo keeps each publish as what it changed and what was there before,
// which is all it takes to undo one publish, or to go back to how the page was
// after an earlier one.

export const DEMO_HISTORY_EMPTY = 'Nothing is published yet in your demo. Publish an edit and it is listed here, with a way back.';
export const DEMO_HISTORY_NOTE = 'This is the history of your private demo, kept in this browser. On a real site every publish is kept in the site’s own history, with the name of the person who made it.';

export const HISTORY_MAX = 20;   // publishes kept per page

/**
 * One publish, as the demo's history keeps it: when, the note it was given,
 * and what each part it changed was just before (`before`). What a part
 * became is not kept twice: it is what the next publish to touch it found,
 * or what is published now.
 *   pending:  Map key → { html?, attrs? }, the edits being published
 *   baseHtml: (key) → the part's HTML before these edits
 *   baseAttr: (key, name) → an attribute's value before these edits
 * An attribute that was not there before is left out: there is nothing to
 * put back.
 */
export function historyEntry({ id, ts, message, pending, baseHtml, baseAttr }) {
  const before = {};
  for (const [key, v] of pending) {
    const was = {};
    if (v.html !== undefined) {
      const html = baseHtml(key);
      if (typeof html === 'string') was.html = html;
    }
    if (v.attrs) {
      was.attrs = {};
      for (const name of Object.keys(v.attrs)) {
        const value = baseAttr(key, name);
        if (typeof value === 'string') was.attrs[name] = value;
      }
    }
    before[key] = was;
  }
  return { id, ts, message: String(message || ''), before };
}

/** The history with one more publish, oldest first, no longer than `max`. */
export function withEntry(entries, entry, max = HISTORY_MAX) {
  return [...(Array.isArray(entries) ? entries : []), entry].slice(-max);
}

const change = (key, was) => {
  const out = { key };
  if (typeof was.html === 'string') out.value = was.html;
  if (was.attrs && Object.keys(was.attrs).length) out.attrs = { ...was.attrs };
  return out;
};
const real = (c) => c.value !== undefined || !!c.attrs;

/** "Undo this change": each part that publish changed, as it was just before it. [{ key, value?, attrs? }] */
export function undoChanges(entry) {
  return Object.entries(entry.before || {}).map(([key, was]) => change(key, was)).filter(real);
}

/**
 * "Go back to this": every part published since, as it was right after the
 * publish at `at` (entries are oldest first). The first later publish to
 * touch a part holds what that part was then.
 */
export function goBackChanges(entries, at) {
  const seen = new Map();
  for (let i = at + 1; i < entries.length; i++) {
    for (const [key, was] of Object.entries(entries[i].before || {})) {
      const got = seen.get(key) || { key };
      if (got.value === undefined && typeof was.html === 'string') got.value = was.html;
      for (const [name, value] of Object.entries(was.attrs || {})) {
        if (!got.attrs) got.attrs = {};
        if (!(name in got.attrs)) got.attrs[name] = value;
      }
      seen.set(key, got);
    }
  }
  return [...seen.values()].filter(real);
}

/**
 * The versions one part's HTML has had, newest first: [{ ts, value }], from
 * what is published now (`current`) back to what it was before the first
 * publish that changed it (ts null). Publishes that left it as it was are
 * left out.
 */
export function partVersions(entries, key, current) {
  const touched = entries.filter(e => typeof e.before?.[key]?.html === 'string');
  if (!touched.length || typeof current !== 'string') return [];
  const out = [];
  // what each publish made of it is what the next one found; the last one made what is there now
  for (let i = touched.length - 1; i >= 0; i--) {
    const value = i === touched.length - 1 ? current : touched[i + 1].before[key].html;
    if (!out.length || out[out.length - 1].value !== value) out.push({ ts: touched[i].ts, value });
  }
  const first = touched[0].before[key].html;
  if (out[out.length - 1].value !== first) out.push({ ts: null, value: first });
  return out;
}
