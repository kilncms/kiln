/**
 * The address a new page or post gets from its title.
 *
 * It used to keep the letters a to z and the digits and put a hyphen in place
 * of everything else, so every accented letter was dropped: "L'été d'Émile à
 * Noël" became /l-t-d-mile-no-l.html. An accented letter now becomes its plain
 * letter (/l-ete-d-emile-a-noel.html), and the few letters that are not a
 * plain letter with a mark on it are spelled out (ß as ss, æ as ae, ø as o).
 *
 * Pure, and tested in node.
 */

// Letters that are not a plain letter with a mark on it, so taking marks off leaves them as they are.
const LETTERS = {
  'ß': 'ss', 'æ': 'ae', 'œ': 'oe', 'ø': 'o', 'đ': 'd', 'ð': 'd', 'þ': 'th', 'ł': 'l', 'ħ': 'h', 'ı': 'i', 'ĸ': 'k', 'ŋ': 'n', 'ſ': 's',
};
const ADDRESS_MAX = 64;

/**
 * A title as the last part of an address: lower case, plain letters and
 * digits, a hyphen wherever anything else stood. "Straße" is `strasse`,
 * "Smørrebrød" is `smorrebrod`, "Año Nuevo" is `ano-nuevo`. Empty when the
 * title has no letter or digit that can be written plainly.
 */
export function plainAddress(title) {
  return String(title ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')   // é is e with a mark: the mark goes, the e stays
    .toLowerCase()
    .replace(/[ßæœøđðþłħıĸŋſ]/g, c => LETTERS[c])
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, ADDRESS_MAX).replace(/-+$/, '');
}

/**
 * The address of a new page or post. A title with nothing in it that can be
 * written plainly (one in Japanese, Greek or Cyrillic, or only signs) still
 * gets an address of its own: the kind and `stamp`, a few letters and digits
 * that differ each time (main.js passes the time). It used to get the bare
 * word "page" or "post", which only the first such title could have. The
 * title itself is on the page as it was typed.
 */
export function pageAddress(title, { kind = 'page', stamp = '' } = {}) {
  const plain = plainAddress(title);
  if (plain) return plain;
  const tail = plainAddress(stamp);
  return tail ? `${kind}-${tail}` : kind;
}
