/**
 * What an invited editor with limits is told about the page they are on.
 *
 * An editor can be given only some pages (say, those under blog/) or only
 * some parts of pages (names that start with, say, about_). A tester signed in
 * as one, opened a page outside their pages, and read "Signed in as Rosa.
 * Click any outlined text to edit." Nothing was outlined and Publish did
 * nothing. The line now says what is true and what they can do instead:
 *
 *   Signed in as Rosa. This page is not one you can change. You can change:
 *   the pages under /blog/.
 *
 *   Signed in as Rosa. You can change the outlined parts of this page.
 *
 * The same words follow the name wherever the line the editor rests on is put
 * back (grants.js startLine, went-live.js restLine), and the note that stays on
 * a page that is not theirs says them too.
 *
 * Pure, and tested in node (test/your-pages.test.js).
 */

/** How many places are named before "and N more". */
export const PLACES_SAID = 3;

const everything = (p) => p === '' || p === '*' || p === '**';

/** A granted path as the repository has it, without the site's own folder in front. */
function tidy(path, root) {
  let p = String(path == null ? '' : path).trim().replace(/^\/+/, '').replace(/\/\*{1,2}$/, '/');
  const r = String(root || '').replace(/^\/+|\/+$/g, '');
  if (r && (p === r || p.startsWith(r + '/'))) p = p.slice(r.length + 1);
  return p;
}

/**
 * One granted path in plain words. A folder reads "the pages under /blog/".
 * A single page reads its address: "/about.html", "/blog/" for blog/index.html,
 * and "the home page" for index.html.
 */
export function placeSaid(path, root = '') {
  const p = tidy(path, root);
  const last = p.split('/').pop();
  if (!/\.[a-z0-9]+$/i.test(last)) return `the pages under /${p.replace(/\/+$/, '')}${p.replace(/\/+$/, '') ? '/' : ''}`;
  if (p === 'index.html') return 'the home page';
  if (last === 'index.html') return `/${p.slice(0, -'index.html'.length)}`;
  return `/${p}`;
}

/**
 * Every granted path in one phrase: "A", "A and B", "A, B and C", and from the
 * fourth on "A, B, C and 2 more". '' when the person has every page.
 */
export function placesSaid(paths, root = '') {
  const list = Array.isArray(paths) ? paths.map(p => String(p == null ? '' : p).trim()) : [];
  if (!list.length || list.some(everything)) return '';
  const said = [...new Set(list.map(p => placeSaid(p, root)))];
  if (said.length > PLACES_SAID) return `${said.slice(0, PLACES_SAID).join(', ')} and ${said.length - PLACES_SAID} more`;
  if (said.length === 1) return said[0];
  return `${said.slice(0, -1).join(', ')} and ${said[said.length - 1]}`;
}

/**
 * What follows "Signed in as NAME." for a person with limits, or '' when the
 * whole page is theirs.
 *
 *   who: { pageMine, paths, root, partsLimited, anyPart, suggest }
 *   pageMine      false when this page is outside their pages
 *   paths         the pages and folders they were given
 *   root          the folder of the repository the site is served from, if any
 *   partsLimited  they were given only some parts of pages
 *   anyPart       false when no part of this page is one of theirs
 *   suggest       their changes are suggestions for the owner to approve
 */
export function limitsSaid(who = {}) {
  const change = who.suggest ? 'suggest changes to' : 'change';
  if (who.pageMine === false) {
    const places = placesSaid(who.paths, who.root);
    return `This page is not one you can ${change}.${places ? ` You can ${change}: ${places}.` : ''}`;
  }
  if (!who.partsLimited) return '';
  if (who.anyPart === false) return `No part of this page is one you can ${change}.`;
  return `You can ${change} the outlined parts of this page.`;
}
