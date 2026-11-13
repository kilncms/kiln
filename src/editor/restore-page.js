/**
 * "Go back to this" in History & restore: the whole file of a page goes back
 * to how it was in an earlier version (the history dialog, previewRestore and
 * publish() in main.js call this; the publish sheet shows its line).
 *
 * It used to bring back only the parts of the page that are marked as
 * editable. The earlier version's editable parts were staged as ordinary
 * edits and written into today's file, so the page's title, its description
 * and everything else in the file stayed as they are now, and the change was
 * saved as "Edit about.html: …" with the status "Published.". When only the
 * title or the description differed it said the page already matched.
 *
 * Now a restore that is kept is remembered as one (`restoring`), and the
 * publish that follows writes that version's own text, with whatever the
 * person edited after keeping it put on top:
 *   - the file the publish starts from is the old version's, not today's;
 *   - the steps the restore itself staged to take away sections added since
 *     are left out, because the old text never had those sections;
 *   - the change is named in plain words, by the time of the version or by
 *     the name it was given;
 *   - the bar on the page, the publish sheet and the line afterwards all say
 *     that the page is being restored, and to what.
 * It is one new change on top of the history. Nothing is thrown away.
 *
 * `restoring` is { sha, path, when, name, text, keys, removed }:
 *   when     the version's time as the history list shows it ('' for a named one)
 *   name     the name of a named version ('' otherwise)
 *   text     the whole file as it was then (null after a reload: read again by sha)
 *   keys     the editable parts the restore staged as edits
 *   removed  the sections the restore staged a removal for
 *
 * Pure, and tested in node (test/restore-page.test.js).
 */
import { readHead } from '../engine.js';

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** "how it was on Nov 12, 7:50 PM", or "the version “Summer menu”" for a named one. */
export function restoreTo(r) {
  const name = oneLine(r?.name);
  return name ? `the version “${name}”` : `how it was on ${oneLine(r?.when)}`;
}

/** The name the change is saved under: "Restore about.html to how it was on Nov 12, 7:50 PM (via Kiln)". */
export function restoreMessage(path, r) {
  return `Restore ${path} to ${restoreTo(r)} (via Kiln)`;
}

/** The line at the top of the publish sheet while a restore is waiting. */
export function restoreSheetLine(r) {
  return `This page is being restored to ${restoreTo(r)}. Its whole file goes back, with the title and the description, as one new change in the history.`;
}

/** The status line after the publish, in place of "Published.". */
export function pageRestoredLine(r) {
  return `Restored this page to ${restoreTo(r)}.`;
}

/** After Keep. */
export const RESTORE_KEPT = 'Kept. Press Publish to restore the page.';
/** The bar on the page when no part that can be edited here differs. */
export const RESTORE_NOTHING_SHOWN = 'No part you can edit here changes.';
/** What the page is called while the site is watched for the change. */
export const RESTORE_DEPLOY_NAME = 'Your restored page';
/** A part the restore staged was taken out again (a row removed in the publish sheet, a draft saved). */
export const RESTORE_NOT_WHOLE = 'A part of the restore was taken out, so the page is no longer going back whole. The edits that are left will be published as ordinary edits.';
/** A suggestion cannot carry a whole file. */
export const RESTORE_SUGGEST_NOTE = 'A suggestion carries only the parts you can edit, so the title and the rest of the page’s file stay as they are.';
/** A person who may only suggest picked a version that differs in nothing a suggestion can carry. */
export const RESTORE_SUGGEST_NOTHING = 'That version differs only in parts a suggestion cannot carry, such as the page’s title.';
/** The publish of a restore was taken back with Undo. */
export const RESTORE_UNDONE = 'Undone. The site is back as it was, and the restore is waiting here again, not published.';
/** The old version could not be read again after a reload. */
export const RESTORE_NOT_READ = 'That version could not be read, so nothing was published.';
/** What going back does not do, said in the dialog. */
export const NOT_BROUGHT_BACK = 'Going back does not bring back things kept in other files: the site menu on other pages, the theme, and pictures that were removed from the site’s files.';
/** The same place in the demo, whose history keeps the editable parts only. */
export const DEMO_NOT_BROUGHT_BACK = 'In this demo the title, the description and the rest of the page’s file stay as they are. On a real site the whole page goes back.';

/**
 * The paragraph under "Page history" (HTML, fixed words only). The demo's
 * history brings back the parts that can be edited, and says so.
 */
export function historyIntro({ demo = false } = {}) {
  const goBack = demo
    ? 'returns the parts of the page you can edit to how they were then'
    : 'returns the whole page to how it was then, with its title and description, as one new change in the history that throws nothing away';
  return 'Every publish saves a version of this page. <strong>Undo this change</strong> takes back just what that '
    + `publish changed. <strong>Go back to this</strong> ${goBack}. Both show the result on the page first, with `
    + 'Cancel and Keep. Nothing changes on the live site until you publish. (For one section’s history, click into '
    + 'it and press its ↻ clock button.)';
}

/**
 * What goes back that the page cannot show before it happens, in sentences
 * for the bar with Cancel and Keep. `gone`: how many editable parts of today's
 * page that version does not have. Plain text: the caller escapes it.
 */
export function restoreNote(nowText, thenText, gone = 0) {
  if (nowText === thenText) return '';
  const now = readHead(nowText), then = readHead(thenText);
  const out = [];
  if (then.title !== now.title) {
    out.push(then.title ? `The page’s title goes back to “${oneLine(then.title)}”.` : 'The page goes back to having no title.');
  }
  if (then.description !== now.description) out.push('Its description goes back to how it was then.');
  if (gone > 0) {
    out.push(`${gone} part${gone > 1 ? 's' : ''} added or made editable since then ${gone > 1 ? 'go' : 'goes'} back too, which this preview cannot show.`);
  }
  out.push('Everything else in this page’s file goes back as well, also what cannot be edited here.');
  return out.join(' ');
}

/** Is this version's file different from today's at all? A page whose title alone differs is. */
export function differsFromNow(nowText, thenText) {
  return typeof thenText === 'string' && thenText !== nowText;
}

/**
 * What the publish starts from. With a restore waiting: the old version's
 * text, and the staged steps without the removals the restore itself staged
 * (that text never had those sections). Without one: today's file and every
 * step, as always. The edits waiting are then written on top by the caller,
 * so what the person changed after keeping the restore is kept.
 */
export function restoreStart(fileText, structuralOps, restoring) {
  const ops = structuralOps || [];
  if (!restoring || typeof restoring.text !== 'string') return { text: fileText, ops };
  const removed = new Set(restoring.removed || []);
  return { text: restoring.text, ops: ops.filter(o => !(o.op === 'removeSection' && removed.has(o.key))) };
}

/**
 * Is the restore still whole? Every part it staged must still be waiting (its
 * words may have been edited since). When one was taken out again the page
 * shows today's words there, and a publish from the old text would write the
 * old ones: what is published must be what is shown, so the restore is let go.
 */
export function restoreHolds(restoring, pendingKeys) {
  const waiting = new Set(pendingKeys);
  return (restoring?.keys || []).every(k => waiting.has(k));
}

/** What the browser keeps of a waiting restore beside the saved edits: never the file's text. */
export function restoreMark(r) {
  return { sha: r.sha, path: r.path, when: r.when || '', name: r.name || '', keys: [...(r.keys || [])], removed: [...(r.removed || [])] };
}

/** That mark read back for this page, or null. The text is read again by sha when it is published. */
export function readRestoreMark(json, path) {
  let m = null;
  try { m = JSON.parse(json); } catch { return null; }
  if (!m || typeof m !== 'object' || typeof m.sha !== 'string' || !/^[0-9a-f]{7,64}$/i.test(m.sha)) return null;
  if (!path || m.path !== path) return null;
  if (!Array.isArray(m.keys) || !Array.isArray(m.removed)) return null;
  const strings = (a) => a.filter(x => typeof x === 'string');
  return { sha: m.sha, path: m.path, when: oneLine(m.when), name: oneLine(m.name), text: null, keys: strings(m.keys), removed: strings(m.removed) };
}
