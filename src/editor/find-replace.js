/**
 * Find & replace across the site (the Find & replace tool in main.js).
 *
 * "Preview matches" reads every page once and counts the matches. "Replace
 * all" then saves every page that had one as ONE change: either each of them
 * has the new words or none has. Nothing is written until that one commit,
 * so a refusal part-way (the service or GitHub saying "asked too often", a
 * page that cannot be read) leaves the site exactly as it was.
 *
 * It asks as little as it can, because every request counts towards what the
 * Kiln service and GitHub allow in a minute: one request to list the files
 * and one to read each page for the preview; then one to list the files again
 * and five to commit, however many pages changed (the pages' new text rides in
 * the request that builds the tree, see commitFiles' `inlineText`). For a
 * site of N pages that is N + 7 requests, where it was up to 2N + 6: a second
 * request for every page that had a match.
 *
 * The second listing is there because the replacement is made in the text
 * that the preview read, and a person may look at the preview for a while. A
 * page somebody published in between would get its older words back. The
 * listing names each file's version, so one request says whether any page
 * with a match has changed since it was read; if one has, nothing is replaced
 * and the person is asked to preview again.
 *
 * What it changes. Only words a visitor reads or hears, and nothing else in
 * the file by a single byte. It used to replace in the whole text of the file
 * (`text.split(find).join(repl)`), so replacing "brine" also rewrote
 * href="/blog/the-monday-brine.html" and the link pointed at no page. Now the
 * page is read with parse5 and its source positions, as engine.js and
 * autotag.js do, and a replacement is written only at the exact place of:
 *
 *   the text between tags in the body, and the page's <title>
 *   these attributes, which are words for people: alt, title, aria-label,
 *   placeholder, and the content of <meta name="description"> and of the
 *   link-preview metas og:title, og:description, twitter:title,
 *   twitter:description
 *
 * Never a tag name, any other attribute (an address, a class, an id, data-*,
 * style, the names Kiln marks parts with), anything inside <script>, <style>,
 * <template>, <noscript> or a comment. Those places are counted, so the
 * preview can say how many hold the word and will not be changed.
 *
 * The person types the word as it reads on the page. The file may write it
 * with entities ("Salt &amp; vinegar"): the search is made in the text as it
 * reads, and each match is taken back to where it is written. What is typed
 * as the replacement is written so that it shows as typed: & < > (and the
 * quote of an attribute) go in as entities, and can never become markup.
 *
 * Capitals count, as they always did here: "Tea" does not find "tea". A word
 * that is split between two elements (<b>br</b>ine) is not found at all.
 *
 * Pure of the page: everything it needs is handed in, so it is tested in node
 * (test/find-replace.test.js).
 */
import { parse, parseFragment } from 'parse5';

/** No more pages than this are searched in one go. */
export const FIND_PAGES_MAX = 100;

/** The pages of a repository's file listing that are searched, each with its version. */
export function findPages(tree) {
  return ((tree && tree.tree) || [])
    .filter(t => t.type === 'blob' && typeof t.path === 'string' && t.path.endsWith('.html'))
    .map(t => ({ path: t.path, sha: t.sha }))
    .slice(0, FIND_PAGES_MAX);
}

/** How many requests a preview and a replace make between them on a site of `pages` pages. */
export const findReplaceRequests = (pages) => pages + 7;

/** How many times `find` is in `text`, as it is written (capitals and all). */
export const countMatches = (text, find) => (find ? text.split(find).length - 1 : 0);

/** Attributes that are words for people, on any element, and what the preview calls each. */
const WORD_ATTRS = new Map([['alt', 'Picture description'], ['title', 'Pop-up note'], ['aria-label', 'Label read aloud'], ['placeholder', 'Hint in a box']]);
/** The metas whose content is words: the description for search engines, and the link previews. */
const WORD_METAS = new Map([['description', 'Description for search engines'], ['og:title', 'Link preview'], ['og:description', 'Link preview'],
  ['twitter:title', 'Link preview'], ['twitter:description', 'Link preview']]);
/** Nothing inside these is words on the page (and most of them do not read entities, so nothing could be written there safely). */
const NOT_WORDS = new Set(['script', 'style', 'template', 'noscript', 'iframe', 'noembed', 'noframes', 'xmp', 'plaintext']);
/** How many characters of the words around a place the preview shows, each side. */
const AROUND = 40;

/** The value of each wordy attribute of `el`, with where it is written in `html`. */
function attrRuns(el, html, runs) {
  const locs = el.sourceCodeLocation && el.sourceCodeLocation.attrs;
  if (!locs || !el.attrs) return;
  const named = (n) => { const a = el.attrs.find(x => x.name === n); return a ? a.value.trim().toLowerCase() : ''; };
  for (const a of el.attrs) {
    let where = WORD_ATTRS.get(a.name);
    if (!where && a.name === 'content' && el.tagName === 'meta') where = WORD_METAS.get(named('name')) || WORD_METAS.get(named('property'));
    const loc = locs[a.name];
    if (!where || !loc) continue;
    const src = html.slice(loc.startOffset, loc.endOffset);
    const m = /^[^\s=]+\s*=\s*(?:"([\s\S]*)"|'([\s\S]*)'|([\s\S]*))$/.exec(src);
    if (!m) continue;   // written with no value: no words
    const quote = m[1] !== undefined ? '"' : m[2] !== undefined ? "'" : '';
    const raw = m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3];
    const start = loc.endOffset - raw.length - (quote ? 1 : 0);
    runs.push({ start, end: start + raw.length, value: a.value, attr: true, quote, where });
  }
}

/** Every stretch of `html` that is words a visitor reads or hears, as { start, end, value, attr, quote, where }, in the file's order. */
function wordRuns(html) {
  const runs = [];
  const walk = (node, inBody, inTitle) => {
    for (const child of node.childNodes || []) {
      if (child.nodeName === '#text') {
        const loc = child.sourceCodeLocation;
        if (loc && (inBody || inTitle)) runs.push({ start: loc.startOffset, end: loc.endOffset, value: child.value, attr: false, quote: '', where: inTitle && !inBody ? 'Page title' : '' });
        continue;
      }
      if (!child.tagName) continue;   // a comment, the doctype
      attrRuns(child, html, runs);
      if (NOT_WORDS.has(child.tagName)) continue;
      walk(child, inBody || child.tagName === 'body', child.tagName === 'title');
    }
  };
  walk(parse(html, { sourceCodeLocationInfo: true }), false, false);
  return runs.sort((a, b) => a.start - b.start);
}

const refs = new Map();
/** What a character reference (`&amp;`, `&#39;`) reads as, by the parser's own rules; itself when it is not one. */
function readRef(ref, attr) {
  const key = (attr ? 'a' : 't') + ref;
  if (!refs.has(key)) {
    let out = ref;
    try {
      const frag = parseFragment(attr ? `<i title="${ref}"></i>` : ref);
      out = attr ? frag.childNodes[0].attrs[0].value : frag.childNodes.map(n => n.value || '').join('');
    } catch { /* as written */ }
    refs.set(key, out);
  }
  return refs.get(key);
}

const UNIT = /&(?:#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);?|\r\n?|[\s\S]/gu;
/**
 * `raw` as it reads, and for each character of that where it is written:
 * { out, at }. `at[i]` is the place in `raw` of character i of `out`, or -1
 * inside something written as one piece (an entity that reads as two characters).
 */
function asRead(raw, attr) {
  let out = '';
  const at = [];
  const put = (rawAt, s) => { at.push(rawAt); for (let k = 1; k < s.length; k++) at.push(-1); out += s; };
  for (const m of raw.matchAll(UNIT)) {
    const s = m[0];
    if (s[0] === '&' && s.length > 1) {
      const read = readRef(s, attr);
      if (read !== s) { put(m.index, read); continue; }
      for (let k = 0; k < s.length; k++) put(m.index + k, s[k]);   // not a reference: its characters as written
      continue;
    }
    put(m.index, s[0] === '\r' ? '\n' : s);
  }
  at.push(raw.length);
  return { out, at };
}

/**
 * Where `find` is in one stretch of words: { spans, missed }. Each span is
 * { from, to } in `raw` and `at` in the words as read. `missed` counts a
 * match that cannot be written back exactly (the stretch does not read as the
 * parser read it, or the match starts or ends inside one entity): it is left
 * alone and counted with the places that are not changed.
 */
function spansIn(run, raw, find) {
  const value = run.value;
  if (!find || !value.includes(find)) return { spans: [], missed: 0 };
  let map = null, skip = 0;
  if (raw !== value) {
    map = asRead(raw, run.attr);
    // The parser drops a line break straight after <pre> or <textarea>.
    if (map.out !== value) { if (map.out[0] === '\n' && map.out.slice(1) === value) skip = 1; else return { spans: [], missed: countMatches(value, find) }; }
  }
  const spans = [];
  let missed = 0;
  for (let i = value.indexOf(find); i !== -1; i = value.indexOf(find, i + find.length)) {
    const from = map ? map.at[i + skip] : i, to = map ? map.at[i + skip + find.length] : i + find.length;
    if (from < 0 || to < 0) missed++; else spans.push({ from, to, at: i });
  }
  return { spans, missed };
}

/** `repl` written so that it shows as typed in this stretch, and can never be markup. */
function written(repl, run) {
  if (!run.attr) return repl.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (run.quote === '"') return repl.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (run.quote === "'") return repl.replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return repl.replace(/[&\s"'=<>`]/g, c => `&#${c.charCodeAt(0)};`);   // a value written without quotes
}

/** The words either side of a place, for the preview: { where, pre, post }. */
function around(run, at, find) {
  const v = run.value, end = at + find.length;
  const tidy = (s) => s.replace(/\s+/g, ' ');
  let pre = tidy(v.slice(Math.max(0, at - 200), at)).replace(/^ /, '');
  let post = tidy(v.slice(end, end + 200)).replace(/ $/, '');
  if (at > 200 || pre.length > AROUND) pre = `…${pre.slice(-AROUND).replace(/^\S* /, '')}`;
  if (v.length - end > 200 || post.length > AROUND) post = `${post.slice(0, AROUND).replace(/ \S*$/, '')}…`;
  return { where: run.where, pre, post };
}

/**
 * `html` with `find` replaced by `repl` in the words a visitor reads or
 * hears, and every other byte as it was. Returns
 *   text     the new file
 *   count    how many places were changed
 *   left     how many more places hold `find` and were NOT changed: an
 *            address, a class, an id, a script, a style, a comment
 *   samples  the first few places, as { where, pre, post }: the words before
 *            and after, as they read on the page
 */
export function replaceWords(html, find, repl = '', { samples = 3 } = {}) {
  let out = '', pos = 0, count = 0, left = 0;
  const shown = [];
  for (const run of wordRuns(html)) {
    if (run.start < pos || run.end < run.start) continue;   // never write over a place twice
    const gap = html.slice(pos, run.start), raw = html.slice(run.start, run.end);
    left += countMatches(gap, find);
    const { spans, missed } = spansIn(run, raw, find);
    left += missed;
    let piece = '', p = 0;
    for (const s of spans) {
      piece += raw.slice(p, s.from) + written(repl, run);
      p = s.to;
      if (shown.length < samples) shown.push(around(run, s.at, find));
    }
    piece += raw.slice(p);
    // A value written without quotes cannot be left empty: the next attribute would become its value.
    if (spans.length && run.attr && !run.quote && piece === '') piece = '""';
    out += gap + piece;
    count += spans.length;
    pos = run.end;
  }
  left += countMatches(html.slice(pos), find);
  return { text: out + html.slice(pos), count, left, samples: shown };
}

const places = (n) => `${n} ${n === 1 ? 'place' : 'places'}`;
const pagesOf = (n) => `${n} ${n === 1 ? 'page' : 'pages'}`;

/** The sentence that says what is left alone, and how many such places hold the word. */
export function leftAloneText(find, left) {
  const what = 'Addresses of links and pictures, style names and scripts are left alone';
  if (!left) return `${what}.`;
  return `${what}: “${find}” is also in ${left === 1 ? '1 such place' : `${left} such places`} on this site, and ${left === 1 ? 'it' : 'they'} will not be changed.`;
}

/** What the preview says under its list of pages. */
export function previewText(find, count, pages, left) {
  return `${places(count)} on ${pagesOf(pages)} would change. Only words a visitor reads or hears are replaced. ${leftAloneText(find, left)}`;
}

/** What is said when no words would change. */
export function noMatchText(find, left) {
  const tips = 'Capitals count, and a word that is partly in bold or partly in a link is not found.';
  if (!left) return `No matches for “${find}”. ${tips}`;
  return `“${find}” is not in any words a visitor reads, so nothing would be replaced. ${leftAloneText(find, left)} ${tips}`;
}

/** What is said once the replacing is done. `watching`: this page is one of them, so the line by the Kiln button will say when it is live. */
export function replacedText(count, pages, left, watching) {
  const next = watching ? 'The site is updating, and Kiln will say when this page shows it.' : 'The site is updating, and will show it in a minute or two.';
  const kept = left ? ` ${left === 1 ? '1 other place' : `${left} other places`} in addresses, style names or scripts ${left === 1 ? 'was' : 'were'} left as ${left === 1 ? 'it was' : 'they were'}.` : '';
  return `Replaced in ${places(count)} on ${pagesOf(pages)}. ${next} You can close this.${kept}`;
}

const listing = (gh, repo, branch) => gh.request('GET', `/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);

/**
 * Read every page once and say where `find` is. Returns { pages, hits, left }:
 * `pages` is how many were read; `hits` is each page with words that would
 * change, as { path, count, left, samples, text, sha }; `left` is how many
 * places on the whole site hold `find` where it is not changed (addresses,
 * style names, scripts), on pages with a match and on pages without.
 * `onStep` is told { done, of } as each is read.
 */
export async function findEverywhere({ gh, repo, branch, find, getFile, onStep = () => {} }) {
  const pages = findPages(await listing(gh, repo, branch));
  const hits = [];
  let left = 0;
  for (let i = 0; i < pages.length; i++) {
    onStep({ done: i + 1, of: pages.length });
    const file = await getFile(gh, repo, pages[i].path, branch);
    const found = replaceWords(file.text, find, '');
    left += found.left;
    if (found.count) hits.push({ path: pages[i].path, count: found.count, left: found.left, samples: found.samples, text: file.text, sha: file.sha });
  }
  return { pages: pages.length, hits, left };
}

/** The line that says a page changed between the preview and the replace. */
export function changedSinceText(paths) {
  const shown = paths.slice(0, 3).join(', ');
  const more = paths.length > 3 ? ` and ${paths.length - 3} more` : '';
  return `Nothing was replaced. ${paths.length === 1 ? `${shown} has` : `${shown}${more} have`} been changed since the matches were found. Press “Preview matches” again, then replace.`;
}

/**
 * Replace `find` with `repl` in the words of every page of `hits`, as one
 * commit. Returns { changed, commit, count }: `count` is how many places were
 * really changed. Throws what a request threw, or an error whose
 * `changedSince` lists the pages that are no longer as the preview read them;
 * either way nothing has been written unless the commit itself was made.
 */
export async function replaceEverywhere({ gh, repo, branch, hits, find, repl, commitFiles }) {
  const tree = await listing(gh, repo, branch);
  const now = new Map(((tree && tree.tree) || []).filter(t => t.type === 'blob').map(t => [t.path, t.sha]));
  // A listing GitHub cut short may leave a page out: that page is not called changed.
  const moved = hits.filter(h => h.sha && (now.has(h.path) ? now.get(h.path) !== h.sha : !tree.truncated)).map(h => h.path);
  if (moved.length) {
    const err = new Error(changedSinceText(moved));
    err.changedSince = moved;
    throw err;
  }
  const changed = hits.map(h => { const r = replaceWords(h.text, find, repl, { samples: 0 }); return { path: h.path, text: r.text, count: r.count }; })
    .filter(c => c.count);
  const commit = await commitFiles(gh, repo, branch, changed.map(c => ({ path: c.path, text: c.text })),
    `Replace “${find}” → “${repl}” on ${changed.length} pages (via Kiln)`, { inlineText: true });
  return { changed, commit, count: changed.reduce((n, c) => n + c.count, 0) };
}
