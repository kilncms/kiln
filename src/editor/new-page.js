/**
 * "New post or page": the page that is written, and what the person is told
 * when the site lacks what a new post or page is made from.
 *
 * A new page is a copy of the site's starting page (`_templates/page.html`,
 * or `_templates/post.html` for a post) with the title put in. Two things
 * went wrong with that on a tester's site:
 *
 *   1. The starting page had neither Kiln's two script lines nor a line
 *      naming its character set. The page that was made could not be edited
 *      in Kiln, and its accents were shown as other letters. Whatever the
 *      starting page holds, the page that is written now names its character
 *      set and loads Kiln, each added only where it is missing (readyPage).
 *   2. A site with no starting page, or with no list for posts, was told
 *      "see the docs", or to add a data-cms-list container. missingWords and
 *      noPostList say what is missing and what the owner can do today.
 *
 * Everything here is pure and tested in node. Reading the files, asking and
 * committing are in main.js.
 */

// ─── The page that is written ─────────────────────────────────────────────────

export const CHARSET_TAG = '<meta charset="utf-8">';
/** Where Kiln's two files are when the page that is open does not say. */
export const KILN_FILES = { config: '/assets/kiln-config.js', editor: '/assets/kiln.js' };

// The same rule the service uses when a site goes on Kiln's hosting (worker/lookafter.js withCharset).
const DECLARES = /<meta\b[^>]*\bcharset\s*=/i;
const HEAD = /<head(?:\s[^>]*)?>/i;
const COMMENT = /<!--[\s\S]*?(?:-->|$)/g;
const blank = (html) => html.replace(COMMENT, c => ' '.repeat(c.length));   // positions stay where they were
const SCRIPT = /<script\b[^>]*>/gi;
const srcOf = (tag) => { const m = /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag); return m ? (m[1] ?? m[2] ?? m[3] ?? '') : ''; };
const fileOf = (src) => src.split(/[?#]/)[0].split('/').pop();
const attr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** The `<script src>` tag on a page that loads the file called `name`, as { index, tag, src }, or null. */
function scriptFor(html, name) {
  const seen = blank(html);
  for (const m of seen.matchAll(SCRIPT)) if (fileOf(srcOf(m[0])) === name) return { index: m.index, tag: m[0], src: srcOf(m[0]) };
  return null;
}

/**
 * Where a page loads Kiln's two files from, read off the page that is open:
 * `scripts` is the `src` of each of its script tags, as written, and `page`
 * its own address. An address written from where the page is (`assets/kiln.js`,
 * `../assets/kiln.js`) becomes one from the top of the site, because the new
 * page may be in another folder; one on another site is kept whole. A file
 * the open page does not load comes back as null.
 */
export function kilnFilesOn(scripts, page = 'https://site.example/') {
  const find = (name) => {
    const src = (scripts || []).find(s => fileOf(String(s || '')) === name);
    if (!src) return null;
    try {
      const at = new URL(src, page), here = new URL(page);
      return at.origin === here.origin ? at.pathname + at.search : at.href;
    } catch { return null; }
  };
  return { config: find('kiln-config.js'), editor: find('kiln.js') };
}

/** `html` with `lines` put in at `at`, each on a line of its own with the indentation of the line they go in front of. */
function linesBefore(html, at, lines) {
  const lead = html.slice(html.lastIndexOf('\n', at - 1) + 1, at);
  const own = /^[ \t]*$/.test(lead);   // what follows is at the start of its line
  return html.slice(0, at) + lines.map(l => l + '\n' + (own ? lead : '')).join('') + html.slice(at);
}

function withCharset(html) {
  if (html.charCodeAt(0) === 0xFEFF) return { html, added: false };   // a byte order mark says it
  const seen = blank(html);
  if (DECLARES.test(seen)) return { html, added: false };
  const head = HEAD.exec(seen);
  if (head) {
    const at = head.index + head[0].length;
    // <head> at the end of its line: the new line takes the next line's indentation.
    const next = /^(\r?\n)([ \t]*)(?=\S)/.exec(html.slice(at, at + 400));
    return { html: html.slice(0, at) + (next ? next[1] + next[2] : '') + CHARSET_TAG + html.slice(at), added: true };
  }
  // No head: a browser makes one for the line when it comes before anything that is shown.
  const top = /<html(?:\s[^>]*)?>/i.exec(seen) || /<!doctype[^>]*>/i.exec(seen);
  const at = top ? top.index + top[0].length : 0;
  return { html: html.slice(0, at) + (top ? '\n' : '') + CHARSET_TAG + (top ? '' : '\n') + html.slice(at), added: true };
}

function withKiln(html, files) {
  const config = files?.config === undefined ? KILN_FILES.config : files.config;
  const editor = files?.editor || KILN_FILES.editor;
  const seen = blank(html);
  const hasEditor = scriptFor(html, 'kiln.js');
  // The settings file: only where this site's pages load one, and never on a page that sets Kiln up in its own script.
  const wantsConfig = !!config && !scriptFor(html, 'kiln-config.js') && !/\bKILN_CONFIG\b/.test(seen);
  const lines = [], added = [];
  if (wantsConfig) { lines.push(`<script src="${attr(config)}"></script>`); added.push('config'); }
  if (!hasEditor) { lines.push(`<script src="${attr(editor)}" defer></script>`); added.push('editor'); }
  if (!lines.length) return { html, added };
  // The settings go in front of the editor that reads them; both go at the end of the body.
  let at = hasEditor ? hasEditor.index : seen.toLowerCase().lastIndexOf('</body>');
  if (at === -1) at = seen.toLowerCase().lastIndexOf('</html>');
  if (at === -1) return { html: html + (!html || html.endsWith('\n') ? '' : '\n') + lines.join('\n') + '\n', added };
  return { html: linesBefore(html, at, lines), added };
}

/**
 * A page as Kiln writes it when it makes a new post or page. Whatever the
 * site's starting page holds, what comes back names its character set
 * (`<meta charset="utf-8">`, first in the head, when it names none) and loads
 * Kiln (the settings file and the editor, before `</body>`, from where this
 * site's pages load them). Each is added only when it is missing, and nothing
 * else on the page is touched. `added` lists what was put in: 'charset',
 * 'config', 'editor'.
 */
export function readyPage(html, files) {
  const text = String(html ?? '');
  const a = withCharset(text);
  const b = withKiln(a.html, files);
  return { html: b.html, added: [...(a.added ? ['charset'] : []), ...b.added] };
}

// ─── What the person is told ──────────────────────────────────────────────────

const SETUP = 'Kiln cannot make that file for you yet. Whoever set up the site can add it, and then this button works.';

/**
 * A file a new post or page is made from is not in the site's files. `what`
 * is 'page', 'post', 'card' or 'blog'. The sentence follows "Nothing was
 * created." (plain-failure.js notDone).
 */
export function missingWords(what) {
  if (what === 'page') {
    return `This site has no starting page for Kiln to copy when it makes a new page. That is a file named _templates/page.html, kept with the site's other files: a copy of one of the site's pages with its words taken out. ${SETUP}`;
  }
  if (what === 'post') {
    return `This site has no starting page for Kiln to copy when it makes a new blog post. That is a file named _templates/post.html, kept with the site's other files: a copy of one of the site's posts with its words taken out. ${SETUP} Until then, choose Page above to make an ordinary page.`;
  }
  if (what === 'card') {
    return `This site has no pattern for the card that shows a new post on the blog page. That is a file named _templates/post-card.html, kept with the site's other files. ${SETUP} Until then, choose Page above to make an ordinary page.`;
  }
  return 'This site has no blog page for a new post to be listed on (a file named blog/index.html). Choose Page above to make an ordinary page, and link to it from the page where you list what you write.';
}

/**
 * The blog page is there and has no place Kiln knows as the list of posts.
 * `blocks` is true when it has a list of blocks the person can add to by hand
 * ("+ Add block"). The sentence follows "Nothing was created.".
 */
export function noPostList({ blocks = false } = {}) {
  const today = blocks
    ? 'What you can do today: choose Page above to make the page. Then open the blog page, press "+ Add block" under its list to copy a card, type the new title over the old one, and use the link button to point the card at the new page.'
    : 'What you can do today: choose Page above to make the page, then link to it from the blog page yourself.';
  return `Kiln does not know which part of the blog page is the list of posts, so it has nowhere to put the new post's card. ${today} To have Kiln add the card by itself, whoever set up the site marks that list in blog/index.html with data-cms-list="post_list".`;
}
