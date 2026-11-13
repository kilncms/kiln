/**
 * Names, the way the person editing reads them.
 *
 * A field's name is the developer's ("hero_headline", "hero_img") and a theme
 * setting's is the stylesheet's ("--color-peri"). The editor showed them as
 * they are, or cut down wrongly ("hero_headline" became "hero"), to people
 * who were invited to change some words. These make a readable name out of
 * the stored one. Nothing stored changes: the page, the saved copy, the
 * commit message and every key the worker sees keep the name as it is, and
 * the raw name stays on screen for the owner (a title on the toolbar's label,
 * small print in Theme).
 *
 * Pure, so they are tested in node.
 */

import { isBuilderName, withoutBuilderLead } from '../builder-words.js';

// What developers shorten, said in full. Only whole words are changed.
const WORDS = {
  img: 'picture', image: 'picture', pic: 'picture', photo: 'picture',
  desc: 'description', sub: 'subheading', btn: 'button', cta: 'button', bg: 'background',
  txt: 'text', nav: 'menu', hdr: 'header', ftr: 'footer', addr: 'address', tel: 'phone',
  num: 'number', url: 'link', faq: 'FAQ',
};

/** A stamp the editor itself put into a name ("gallery_mf3k2a9x"): letters and digits mixed, never a word. */
const isStamp = (word) => word.length >= 5 && /\d/.test(word) && /^[a-z0-9]+$/i.test(word);

// A part named from a page builder's class ("elementor_widg_featured_products",
// "astra_shop_img_2") is shown without the builder's words in front:
// "Featured products", "Shop picture 2". The stored name stays as it is.
function wordsOf(name) {
  const words = String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')   // heroHeadline
    .split(/[_\-\s.]+/)
    .filter(w => w && !isStamp(w))
    .map(w => w.toLowerCase());
  return withoutBuilderLead(words).map(w => WORDS[w] || w);
}

const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** "hero_headline" → "hero headline", for the middle of a sentence ("Edited hero headline"). */
export function plainName(key) {
  if (key === undefined || key === null || key === '' || key === 'undefined') return 'a section';
  const words = wordsOf(String(key).replace(/^[+-]/, ''));
  // a name that was nothing but a builder's words has no words of its own to show
  return words.join(' ') || (isBuilderName(String(key)) ? 'a section' : String(key));
}

/** "hero_headline" → "Hero headline", "hero_img" → "Hero picture": a label on its own. */
export function readableName(key) {
  return capital(plainName(key));
}

// The word a stylesheet puts in front of each kind of setting, which the group's heading already says.
const LEAD = { color: /^(color|colour|clr)$/, font: /^(font|family|typeface)$/ };

// The short ending a stylesheet gives a size, said in full.
const SIZE = {
  xxs: 'extra extra small', '2xs': 'extra extra small', xs: 'extra small', sm: 'small', small: 'small',
  md: 'medium', medium: 'medium', lg: 'large', large: 'large', xl: 'extra large',
  xxl: 'extra extra large', '2xl': 'extra extra large',
};
const NTH = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth'];

// What a setting is for, told from its name: [the name, its label, the words for it in a sentence].
const SETTINGS = [
  [/^(r|radius|rounded|rounding|corner|corners)$/, 'corner roundness', 'the corner roundness'],
  [/^(maxw|max-w|max-width|page-width|content-width)$/, 'widest the page gets', 'how wide the page gets'],
  [/^(gutter|page-gutter|page-padding)$/, 'space at the page’s edges', 'the space at the page’s edges'],
  [/^(shadow|box-shadow)$/, 'shadow', 'the shadow'],
  [/^(s|space|spacing)$/, 'spacing', 'the spacing'],
];
// The same for a font: what it is used for is its name.
const FONTS = [
  [/^(display|heading|headings|title|titles)$/, 'heading font'],
  [/^(body|sans|text|copy)$/, 'text font'],
  [/^(mono|monospace|code)$/, 'font for code'],
];

/** One theme setting two ways: `label` on its own line, `phrase` for the middle of a sentence. */
function setting(name, kind) {
  let words = String(name).replace(/^--/, '').split(/[_\-\s]+/).filter(Boolean).map(w => w.toLowerCase());
  const lead = LEAD[kind];
  while (lead && words.length > 1 && lead.test(words[0])) words = words.slice(1);
  if (!words.length) return { label: String(name), phrase: String(name) };
  const full = (w) => SIZE[w] || WORDS[w] || w;

  if (kind === 'font') {
    const own = words.filter(w => !LEAD.font.test(w));
    const known = FONTS.find(([re]) => re.test(own.join('-')));
    const base = known ? known[1] : own.length ? `${own.map(full).join(' ')} font` : 'font';
    return { label: capital(base), phrase: `the ${base}` };
  }

  // The longest start of the name that says what the setting is for; what is left says which one.
  let known = null;
  let cut = words.length;
  if (kind !== 'color') {
    for (; cut > 0 && !known; cut--) known = SETTINGS.find(([re]) => re.test(words.slice(0, cut).join('-')));
    cut = known ? cut + 1 : words.length;
  }
  // A name Kiln does not know keeps its words; only a size or a number at its end is set apart.
  const last = words[words.length - 1];
  if (!known && words.length > 1 && (SIZE[last] || /^\d+$/.test(last))) cut = words.length - 1;
  const tail = words.slice(cut);
  const base = known ? known[1] : words.slice(0, cut).map(w => WORDS[w] || w).join(' ');
  const thing = known ? known[2] : `the ${base}${kind === 'color' && !/colou?r/.test(base) ? ' colour' : ''}`;

  let label = capital(base);
  let phrase = thing;
  if (tail.length === 1 && /^\d+$/.test(tail[0])) {
    const n = Number(tail[0]);
    if (kind === 'color') {
      const shade = NTH[n] ? `${NTH[n]} shade` : `shade ${n}`;
      label += `, ${shade}`;
      phrase = NTH[n] ? `the ${shade} of ${base}` : `${shade} of ${base}`;
    } else {
      label += `, step ${n}`;
      phrase = `step ${n} of ${thing}`;
    }
  } else if (tail.length) {
    const which = tail.map(full).join(' ');
    label += `, ${which}`;
    phrase = thing.startsWith('the ') ? `the ${which} ${thing.slice(4)}` : `${thing}, ${which}`;
  }
  // A name of two or three letters says too little alone: it is given the word for what it is.
  if (label.replace(/[^a-z]/gi, '').length < 4) label += kind === 'color' ? ' colour' : kind === 'size' ? ' size' : ' setting';
  return { label, phrase };
}

/**
 * A theme setting's name as a shop owner reads it: "--r-sm" → "Corner roundness, small",
 * "--maxw" → "Widest the page gets", "--cream-2" under Colours → "Cream, second shade",
 * "--display" under Fonts → "Heading font", "--color-ink-soft" → "Ink soft". A name Kiln
 * does not know is shown with its dashes as spaces: "--brand-ink" → "Brand ink".
 * `kind` is the group it is listed in ('color', 'font', 'size', 'other').
 */
export function tokenName(name, kind = 'other') {
  return setting(name, kind).label;
}

/** The same setting in the middle of a sentence: "the mustard colour", "the heading font", "how wide the page gets". */
export function tokenPhrase(name, kind = 'other') {
  return setting(name, kind).phrase;
}
