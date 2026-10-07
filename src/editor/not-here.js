/**
 * A tap on something that cannot be changed here.
 *
 * A page often shows one thing twice: a shirt in a row of favourites and
 * again in the full list, a phone number in the header and in the footer.
 * Whoever set the site up marked one of them as editable and not the other,
 * and to the person editing they look the same. A tap on the unmarked one
 * did nothing they could read.
 *
 * Where the editor can tell that what was tapped shows the same thing as a
 * part that CAN be changed, it says so and offers to go there:
 *
 *   - it is inside a link, one editable part is under a link to the same
 *     address, and (when it has words) that part reads the same; or
 *   - it is in no link, and exactly one editable part on the page reads the
 *     same.
 *
 * Anything less sure is left alone: several parts with the same words and
 * nothing to tell them apart, a link in the site's own menu (which must go on
 * being a link), a tap on a whole section. The editor makes nothing editable
 * here, and does not say the copy will follow the part it points to: on most
 * sites they are two separate pieces of the page.
 *
 * Pure, and tested in node; reading the page is main.js's.
 */

const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * tapped: { words, href, nav }  the words of what was tapped ('' for a
 *         picture), the address of the link it is in (or null), whether it is
 *         in the site's own menu, header or footer navigation
 * fields: [{ key, list, words, href }]  every editable part: its name, the
 *         list it is in (or null), its words, the address of the link it is
 *         in or under (or null)
 * Returns { field, same: 'words' | 'place' } or null.
 */
export function findTwin(tapped, fields) {
  if (tapped.nav) return null;
  const words = flat(tapped.words);
  if (words.length > 200) return null;
  if (tapped.href) {
    const there = fields.filter(f => f.href === tapped.href);
    if (!there.length) return null;
    if (words) {
      const same = there.filter(f => flat(f.words) === words);
      return same.length === 1 ? { field: same[0], same: 'words' } : null;
    }
    // no words of its own (a picture): the item it belongs to, when one list item leads there
    const lists = new Set(there.map(f => f.list));
    return lists.size === 1 && there[0].list ? { field: there[0], same: 'place' } : null;
  }
  if (words.length < 2) return null;
  const same = fields.filter(f => flat(f.words) === words);
  return same.length === 1 ? { field: same[0], same: 'words' } : null;
}

/**
 * What the status line says.
 *   { same: 'words' | 'place', name, list }  a twin was found: `list` is the
 *       readable name of the list it is in (or null), `name` the part's own
 *   { inBlock, picture }  no twin, but the tap was on an unmarked part of an
 *       editable block
 */
export function notHereWords(info) {
  if (info.same === 'words') return `This copy can’t be changed here. The same words can, in ${info.list || `“${info.name}”`}.`;
  if (info.same === 'place') return `This can’t be changed here. The same item is in ${info.list || `“${info.name}”`}, where its outlined parts can.`;
  return `This ${info.picture ? 'picture ' : ''}isn’t set up to be changed here. The outlined parts of this block are.`;
}
