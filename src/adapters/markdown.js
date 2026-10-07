/**
 * Markdown, read and written the way a person wrote it.
 *
 * Used by the editor (in the browser) and by the worker, so it imports
 * nothing: no parser package, no DOM. Four parts:
 *
 *  1. Blocks. A Markdown text split into its top-level blocks (paragraphs,
 *     headings, lists, quotes, code, tables, HTML, and in MDX the import and
 *     export lines, components and expressions), each with its exact place in
 *     the text. Nested blocks are read by reading a list item's or a quote's
 *     inside the same way.
 *  2. Inline. What a paragraph holds: words, bold, italic, struck-through
 *     text, code, links, pictures, line breaks, and the parts that are not
 *     words (HTML, and in MDX components and expressions). The emphasis rules
 *     are CommonMark's (the delimiter runs), which is what Astro, Eleventy,
 *     Hugo and Jekyll's renderers agree on for ordinary text.
 *  3. From the page back to Markdown. A block as the browser holds it after
 *     editing (any object with nodeType, tagName, childNodes and
 *     getAttribute) written as Markdown in the file's own style: the same
 *     bullet, the same emphasis marks, the same kind of line break.
 *  4. The change to make. Given the file's text, the page's blocks as they
 *     were read and as they are now, the smallest change to the text: blocks
 *     nobody touched keep every byte, and inside a changed block only the
 *     changed part is rewritten when that reads the same as the new block.
 */

// ─── 1. Blocks ───────────────────────────────────────────────────────────────

const HTML_BLOCK_6 = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt '
  + 'fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu '
  + 'menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));

/** Lines of `text` with their offsets: { start, end (before the line break), text, next (after it) }. */
export function lines(text) {
  const out = [];
  let i = 0;
  while (i <= text.length) {
    const nl = text.indexOf('\n', i);
    const end = nl === -1 ? text.length : nl;
    const lineEnd = end > i && text[end - 1] === '\r' ? end - 1 : end;
    out.push({ start: i, end: lineEnd, text: text.slice(i, lineEnd), next: nl === -1 ? text.length : nl + 1 });
    if (nl === -1) break;
    i = nl + 1;
  }
  if (out.length && out[out.length - 1].start === text.length && text.length) out.pop();
  return out;
}

const isBlank = (s) => /^[ \t]*$/.test(s);
/** Columns of leading white space, a tab to the next multiple of four. */
function indentOf(s) {
  let col = 0;
  for (const c of s) {
    if (c === ' ') col++;
    else if (c === '\t') col += 4 - (col % 4);
    else break;
  }
  return col;
}

const RE = {
  atx: /^ {0,3}(#{1,6})(?:[ \t]|$)/,
  hr: /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/,
  fence: /^( {0,3})(`{3,}|~{3,})(.*)$/,
  quote: /^ {0,3}>/,
  item: /^( {0,3})([-+*]|\d{1,9}[.)])([ \t]+|$)/,
  setext: /^ {0,3}(=+|-+)[ \t]*$/,
  linkdef: /^ {0,3}\[(?!\^)(?:[^\]\\]|\\.)+\]:[ \t]*(?:<[^>]*>|\S+)/,
  footnote: /^ {0,3}\[\^[^\]]+\]:/,
  tableDelim: /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/,
};

function htmlStart(t, inParagraph) {
  if (/^ {0,3}<(?:script|pre|style|textarea)(?:[\s>]|$)/i.test(t)) return 1;
  if (/^ {0,3}<!--/.test(t)) return 2;
  if (/^ {0,3}<\?/.test(t)) return 3;
  if (/^ {0,3}<![A-Za-z]/.test(t)) return 4;
  if (/^ {0,3}<!\[CDATA\[/.test(t)) return 5;
  const m = /^ {0,3}<\/?([A-Za-z][A-Za-z0-9-]*)(?:[\s/>]|$)/.exec(t);
  if (m && HTML_BLOCK_6.has(m[1].toLowerCase())) return 6;
  if (!inParagraph && /^ {0,3}(?:<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][\w.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>|<\/[A-Za-z][A-Za-z0-9-]*\s*>)[ \t]*$/.test(t)) return 7;
  return 0;
}
const HTML_END = { 1: /<\/(?:script|pre|style|textarea)>/i, 2: /-->/, 3: /\?>/, 4: />/, 5: /\]\]>/ };

/** A list item marker: its kind (a bullet character, or a number's delimiter) and widths. */
function itemMarker(t) {
  const m = RE.item.exec(t);
  if (!m) return null;
  const ordered = /\d/.test(m[2]);
  const pad = m[3] ? (indentOf(m[3]) > 4 ? 1 : indentOf(m[3])) : 1;
  return {
    indent: m[1].length,
    marker: m[2],
    ordered,
    kind: ordered ? m[2].slice(-1) : m[2],
    number: ordered ? Number(m[2].slice(0, -1)) : null,
    content: m[1].length + m[2].length + pad,   // the column the item's text starts at
    empty: !m[3] || isBlank(t.slice(m[0].length)),
  };
}

function cells(row) {
  return row.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).length;
}

/**
 * Does line `t` start a block that ends a paragraph (CommonMark's
 * "can interrupt a paragraph")? In MDX a component or an expression on a line
 * of its own does too.
 */
function interrupts(t, { mdx }) {
  if (RE.atx.test(t) || RE.hr.test(t) || RE.fence.test(t) || RE.quote.test(t)) return true;
  const it = itemMarker(t);
  if (it && it.indent < 4 && !it.empty && (!it.ordered || it.number === 1)) return true;
  if (!mdx && htmlStart(t, true) && htmlStart(t, true) <= 6) return true;
  if (mdx && /^ {0,3}(?:<[A-Za-z/>]|\{)/.test(t)) return true;
  return false;
}

/** Where a JSX element that starts at `from` ends (index after it), counting nested elements of any name; -1 when it does not. */
function jsxEnd(text, from) {
  let depth = 0;
  let i = from;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '{') { const e = braceEnd(text, i); if (e < 0) return -1; i = e; continue; }
    if (c === '<') {
      if (text.startsWith('<!--', i)) { const e = text.indexOf('-->', i); if (e < 0) return -1; i = e + 3; continue; }
      const close = text[i + 1] === '/';
      const m = /^<\/?([A-Za-z_$][\w$.:-]*)?/.exec(text.slice(i, i + 200));
      // Read to the end of the tag, past quoted attribute values and expressions.
      let j = i + (m ? m[0].length : 1);
      let selfClosing = false;
      while (j < n && text[j] !== '>') {
        if (text[j] === '"' || text[j] === "'") { const q = text.indexOf(text[j], j + 1); if (q < 0) return -1; j = q + 1; continue; }
        if (text[j] === '{') { const e = braceEnd(text, j); if (e < 0) return -1; j = e; continue; }
        j++;
      }
      if (j >= n) return -1;
      selfClosing = text[j - 1] === '/';
      j++;
      if (close) depth--;
      else if (!selfClosing) depth++;
      i = j;
      if (depth <= 0) return i;
      continue;
    }
    if (depth <= 0) return i;
    i++;
  }
  return -1;
}

/** Index after the `}` that closes the `{` at `from`, skipping strings, comments and template literals; -1 when unclosed. */
function braceEnd(text, from) {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      for (i++; i < text.length && text[i] !== q; i++) if (text[i] === '\\') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); if (e < 0) return -1; i = e + 1; continue; }
    if (c === '/' && text[i + 1] === '/') { const e = text.indexOf('\n', i); if (e < 0) return -1; i = e; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i + 1; }
  }
  return -1;
}

/**
 * The top-level blocks of a Markdown text, in order:
 * [{ kind, start, end, ...detail }] where `start` and `end` are offsets into
 * `text` (end: just after the block's last character, before its line break).
 *
 * kind: paragraph | heading (level, setext) | list (ordered, kind) |
 *       blockquote | hr | code | html | comment | table | linkdef | footnote |
 *       esm | jsx | expression        (the last three only with { mdx: true })
 * A list also says where its numbers start (`number`).
 */
export function markdownBlocks(text, { mdx = false } = {}) {
  const L = lines(text);
  const blocks = [];
  let i = 0;
  const push = (kind, from, to, extra = {}) => blocks.push({ kind, start: L[from].start, end: L[to].end, ...extra });

  while (i < L.length) {
    const t = L[i].text;
    if (isBlank(t)) { i++; continue; }
    const ind = indentOf(t);

    if (mdx && ind < 4) {
      if (/^(?:import|export)\b/.test(t)) {
        let j = i;
        while (j + 1 < L.length && !isBlank(L[j + 1].text)) j++;
        push('esm', i, j); i = j + 1; continue;
      }
      if (/^ {0,3}<[A-Za-z>]/.test(t) || /^ {0,3}<\/[A-Za-z]/.test(t)) {
        const from = L[i].start + t.search(/</);
        const end = jsxEnd(text, from);
        if (end > 0) {
          let j = i;
          while (j + 1 < L.length && L[j].next <= end) j++;
          if (L[j].end < end) j++;
          // The rest of the closing line belongs to the element.
          push('jsx', i, Math.min(j, L.length - 1)); i = Math.min(j, L.length - 1) + 1; continue;
        }
      }
      if (/^ {0,3}\{/.test(t)) {
        const from = L[i].start + t.indexOf('{');
        const end = braceEnd(text, from);
        if (end > 0) {
          let j = i;
          while (j + 1 < L.length && L[j].end < end) j++;
          push(/^ {0,3}\{\s*\/\*/.test(t) ? 'comment' : 'expression', i, j); i = j + 1; continue;
        }
      }
    }

    const fence = RE.fence.exec(t);
    if (fence && !(fence[2][0] === '`' && fence[3].includes('`'))) {
      const ch = fence[2][0];
      const len = fence[2].length;
      let j = i + 1;
      while (j < L.length && !new RegExp(`^ {0,3}${ch === '`' ? '`' : '~'}{${len},}[ \\t]*$`).test(L[j].text)) j++;
      const last = Math.min(j, L.length - 1);
      push('code', i, last, { fenced: true, info: fence[3].trim() }); i = last + 1; continue;
    }
    if (ind >= 4) {
      let j = i;
      while (j + 1 < L.length && (isBlank(L[j + 1].text) || indentOf(L[j + 1].text) >= 4)) j++;
      while (isBlank(L[j].text)) j--;
      push('code', i, j, { fenced: false }); i = j + 1; continue;
    }
    const atx = RE.atx.exec(t);
    if (atx) { push('heading', i, i, { level: atx[1].length }); i++; continue; }
    if (RE.hr.test(t)) { push('hr', i, i); i++; continue; }

    if (!mdx) {
      const h = htmlStart(t, false);
      if (h) {
        let j = i;
        if (HTML_END[h]) {
          while (j < L.length && !HTML_END[h].test(L[j].text.slice(j === i ? t.indexOf('<') + 1 : 0))) j++;
          if (j >= L.length) j = L.length - 1;
        } else {
          while (j + 1 < L.length && !isBlank(L[j + 1].text)) j++;
        }
        push(h === 2 && /-->[ \t]*$/.test(L[j].text) ? 'comment' : 'html', i, j); i = j + 1; continue;
      }
    }

    if (RE.quote.test(t)) {
      let j = i;
      while (j + 1 < L.length) {
        const n = L[j + 1].text;
        if (isBlank(n)) break;
        if (RE.quote.test(n)) { j++; continue; }
        // A lazy line continues the quote's paragraph.
        if (!interrupts(n, { mdx }) && !isBlank(L[j].text.replace(/^ {0,3}>[ \t]?/, ''))) { j++; continue; }
        break;
      }
      push('blockquote', i, j); i = j + 1; continue;
    }

    if (RE.footnote.test(t)) {
      let j = i;
      while (j + 1 < L.length) {
        const n = L[j + 1].text;
        if (!isBlank(n) && (indentOf(n) >= 4 || (!interrupts(n, { mdx }) && !RE.footnote.test(n) && !isBlank(L[j].text)))) { j++; continue; }
        if (isBlank(n)) {
          let k = j + 1;
          while (k < L.length && isBlank(L[k].text)) k++;
          if (k < L.length && indentOf(L[k].text) >= 4) { j = k; continue; }
        }
        break;
      }
      push('footnote', i, j); i = j + 1; continue;
    }

    const item = itemMarker(t);
    if (item) {
      let j = i;
      let content = item.content;
      while (j + 1 < L.length) {
        const n = L[j + 1].text;
        if (isBlank(n)) {
          let k = j + 1;
          while (k < L.length && isBlank(L[k].text)) k++;
          if (k >= L.length) break;
          const next = L[k].text;
          const nm = itemMarker(next);
          if (indentOf(next) >= 2 && indentOf(next) >= Math.min(content, item.content)) { j = k; continue; }
          if (nm && nm.indent < 4 && nm.kind === item.kind && !RE.hr.test(next)) { j = k; content = nm.content; continue; }
          break;
        }
        const nm = itemMarker(n);
        if (RE.hr.test(n) && indentOf(n) < item.content) break;
        if (nm && nm.indent < item.content) {
          if (nm.kind === item.kind) { j++; content = nm.content; continue; }
          break;   // a different kind of marker starts another list
        }
        if (indentOf(n) >= 2) { j++; continue; }
        // A lazy line: it continues the item's paragraph.
        if (!interrupts(n, { mdx }) && !RE.setext.test(n)) { j++; continue; }
        break;
      }
      push('list', i, j, { ordered: item.ordered, marker: item.kind, number: item.number }); i = j + 1; continue;
    }

    if (RE.linkdef.test(t)) {
      let j = i;
      if (j + 1 < L.length && /^[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\))[ \t]*$/.test(L[j + 1].text)) j++;
      push('linkdef', i, j); i = j + 1; continue;
    }

    // A table: a row with a pipe, then a row of dashes with as many cells.
    if (i + 1 < L.length && t.includes('|') && RE.tableDelim.test(L[i + 1].text) && L[i + 1].text.includes('-')
      && cells(t) === cells(L[i + 1].text)) {
      let j = i + 1;
      while (j + 1 < L.length && !isBlank(L[j + 1].text) && !interrupts(L[j + 1].text, { mdx })) j++;
      push('table', i, j); i = j + 1; continue;
    }

    // A paragraph, which a line of = or - under it turns into a heading.
    let j = i;
    let setext = 0;
    while (j + 1 < L.length) {
      const n = L[j + 1].text;
      if (isBlank(n)) break;
      const s = RE.setext.exec(n);
      if (s && indentOf(n) < 4) { setext = s[1][0] === '=' ? 1 : 2; j++; break; }
      if (interrupts(n, { mdx })) break;
      j++;
    }
    if (setext) push('heading', i, j, { level: setext, setext: true });
    else push('paragraph', i, j);
    i = j + 1;
  }
  return blocks;
}

/** Blocks a renderer writes as a page element a person can type in. */
export const PROSE = new Set(['paragraph', 'heading', 'list', 'blockquote', 'hr']);

/** The page element a prose block becomes: P, H1…H6, UL, OL, BLOCKQUOTE, HR. */
export function blockTag(b) {
  if (b.kind === 'paragraph') return 'P';
  if (b.kind === 'heading') return `H${b.level}`;
  if (b.kind === 'list') return b.ordered ? 'OL' : 'UL';
  if (b.kind === 'blockquote') return 'BLOCKQUOTE';
  if (b.kind === 'hr') return 'HR';
  return '';
}

/** A quote's inside: each line without its `>` (and one space after it). */
export function quoteInside(text) {
  return text.split('\n').map(l => l.replace(/^ {0,3}>[ \t]?/, '')).join('\n');
}

/** A list's items, each as its own text with the marker and the item's indent taken away. */
export function listItems(text) {
  const L = lines(text);
  const items = [];
  let cur = null;
  let first = null;
  for (const l of L) {
    const m = itemMarker(l.text);
    if (m && (first === null || (m.indent < (cur?.content ?? 4) && m.kind === first.kind))) {
      if (!first) first = m;
      cur = { content: m.content, lines: [l.text.slice(Math.min(m.content, l.text.length))] };
      items.push(cur);
      continue;
    }
    if (!cur) continue;
    // A line indented as far as the item's text belongs to it, so does a lazy one.
    cur.lines.push(isBlank(l.text) ? '' : l.text.slice(Math.min(cur.content, indentOf(l.text))));
  }
  return items.map(it => {
    while (it.lines.length && isBlank(it.lines[it.lines.length - 1])) it.lines.pop();
    return it.lines.join('\n');
  });
}

/** Whether a list is loose (its items' paragraphs are separated by blank lines). */
export function listIsLoose(text) {
  return /\n[ \t]*\n[ \t]*\S/.test(text.replace(/\s+$/, ''));
}

// ─── 2. Inline ───────────────────────────────────────────────────────────────

const ESCAPABLE = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', middot: '·', bull: '•', deg: '°', times: '×', euro: '€', pound: '£' };

/**
 * Parse a block's inline text into nodes:
 *   { type: 'text', value } | { type: 'break' } (hard) | { type: 'soft' } |
 *   { type: 'code', value } | { type: 'strong' | 'em' | 'del', children } |
 *   { type: 'link', url, title, children, ref? } | { type: 'image', url, title, alt, raw } |
 *   { type: 'html', value } | { type: 'jsx', value } | { type: 'expr', value } |
 *   { type: 'footref', value }
 * `refs`: the reference definitions of the text it comes from (name → { url, title }).
 */
export function parseInline(src, { mdx = false, refs = {} } = {}) {
  const nodes = [];   // the flat list, delimiters as { type: 'delim' }
  let text = '';
  const flush = () => { if (text) { nodes.push({ type: 'text', value: text }); text = ''; } };
  let i = 0;
  const n = src.length;
  const delims = [];

  while (i < n) {
    const c = src[i];
    if (c === '\\') {
      if (src[i + 1] === '\n') { flush(); nodes.push({ type: 'break' }); i += 2; continue; }
      if (i + 1 < n && ESCAPABLE.test(src[i + 1])) { text += src[i + 1]; i += 2; continue; }
      text += '\\'; i++; continue;
    }
    if (c === '\n') {
      // Two spaces or more before the line break: a hard break.
      const m = / {2,}$/.exec(text);
      if (m) { text = text.slice(0, -m[0].length); flush(); nodes.push({ type: 'break' }); }
      else { text = text.replace(/ +$/, ''); flush(); nodes.push({ type: 'soft' }); }
      i++;
      while (src[i] === ' ' || src[i] === '\t') i++;
      continue;
    }
    if (c === '`') {
      let k = i;
      while (src[k] === '`') k++;
      const run = k - i;
      let j = k;
      let close = -1;
      while (j < n) {
        if (src[j] === '`') {
          let e = j;
          while (src[e] === '`') e++;
          if (e - j === run) { close = j; break; }
          j = e;
        } else j++;
      }
      if (close >= 0) {
        flush();
        let v = src.slice(k, close).replace(/\n/g, ' ');
        if (/^ .* $/.test(v) && !/^ +$/.test(v)) v = v.slice(1, -1);
        nodes.push({ type: 'code', value: v });
        i = close + run; continue;
      }
      text += src.slice(i, k); i = k; continue;
    }
    if (c === '&') {
      const m = /^&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));/.exec(src.slice(i, i + 40));
      if (m) {
        const v = m[1] ? String.fromCodePoint(Number(m[1]) || 0xfffd) : m[2] ? String.fromCodePoint(parseInt(m[2], 16) || 0xfffd) : ENTITIES[m[3]];
        if (v !== undefined) { text += v; i += m[0].length; continue; }
      }
      text += c; i++; continue;
    }
    if (c === '<') {
      const auto = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*)>/.exec(src.slice(i, i + 2048)) || /^<([^\s<>@]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)>/.exec(src.slice(i, i + 512));
      if (auto) {
        flush();
        const url = auto[1].includes('@') && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(auto[1]) ? `mailto:${auto[1]}` : auto[1];
        nodes.push({ type: 'link', url, title: '', children: [{ type: 'text', value: auto[1] }], auto: true });
        i += auto[0].length; continue;
      }
      if (mdx && /^<[A-Za-z>/]/.test(src.slice(i, i + 2))) {
        const end = jsxEnd(src, i);
        if (end > 0) { flush(); nodes.push({ type: 'jsx', value: src.slice(i, end) }); i = end; continue; }
      }
      const tag = /^<(?:[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][\w.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>|\/[A-Za-z][A-Za-z0-9-]*\s*>|!--[\s\S]*?-->)/.exec(src.slice(i, i + 4096));
      if (tag && !mdx) { flush(); nodes.push({ type: 'html', value: tag[0] }); i += tag[0].length; continue; }
      text += c; i++; continue;
    }
    if (mdx && c === '{') {
      const end = braceEnd(src, i);
      if (end > 0) { flush(); nodes.push({ type: 'expr', value: src.slice(i, end) }); i = end; continue; }
    }
    if (c === '[' && src[i + 1] === '^') {
      const m = /^\[\^([^\]\s]+)\]/.exec(src.slice(i, i + 200));
      if (m) { flush(); nodes.push({ type: 'footref', value: m[0] }); i += m[0].length; continue; }
    }
    if (c === '!' && src[i + 1] === '[') {
      flush();
      const d = { type: 'delim', char: '![', image: true, at: nodes.length, active: true, start: i };
      nodes.push(d); delims.push(d); i += 2; continue;
    }
    if (c === '[') {
      flush();
      const d = { type: 'delim', char: '[', at: nodes.length, active: true, start: i };
      nodes.push(d); delims.push(d); i++; continue;
    }
    if (c === ']') {
      // Look back for the bracket this closes.
      let opener = null;
      for (let k = delims.length - 1; k >= 0; k--) if (delims[k].char === '[' || delims[k].char === '![') { opener = delims[k]; break; }
      if (!opener) { text += c; i++; continue; }
      if (!opener.active) { delims.splice(delims.indexOf(opener), 1); text += c; i++; continue; }
      const after = src.slice(i + 1, i + 4096);
      let dest = null;
      let consumed = 0;
      let ref = null;
      const inl = /^\(\s*(?:<([^<>\n]*)>|((?:[^\s()\\]|\\.|\((?:[^\s()\\]|\\.)*\))*))(?:\s+("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^()\\]|\\.)*\)))?\s*\)/.exec(after);
      const label = src.slice(opener.start + opener.char.length, i);
      if (inl) {
        dest = { url: unescapeMd(inl[1] ?? inl[2] ?? ''), title: inl[3] ? unescapeMd(inl[3].slice(1, -1)) : '' };
        consumed = inl[0].length;
      } else {
        const full = /^\[((?:[^\]\\]|\\.){0,999})\]/.exec(after);
        const name = full ? (full[1] || label) : label;
        const def = refs[normalizeLabel(name)];
        if (def) { dest = def; consumed = full ? full[0].length : 0; ref = full ? (full[1] ? 'full' : 'collapsed') : 'shortcut'; }
      }
      if (!dest) { delims.splice(delims.indexOf(opener), 1); text += c; i++; continue; }
      flush();
      const children = nodes.splice(opener.at + 1);
      nodes.pop();   // the opener
      processEmphasis(children, delims.filter(d => d.char === '*' || d.char === '_' || d.char === '~').filter(d => children.includes(d)));
      for (const d of [...delims]) if (children.includes(d) || d === opener) delims.splice(delims.indexOf(d), 1);
      if (opener.image) {
        nodes.push({ type: 'image', url: dest.url, title: dest.title, alt: textOf(children), raw: src.slice(opener.start, i + 1 + consumed) });
      } else {
        nodes.push({ type: 'link', url: dest.url, title: dest.title, children, ref });
        // A link may not contain another link: earlier brackets stop opening links.
        for (const d of delims) if (d.char === '[') d.active = false;
      }
      i += 1 + consumed;
      continue;
    }
    if (c === '*' || c === '_' || (c === '~' && src[i + 1] === '~')) {
      let k = i;
      while (src[k] === c) k++;
      const run = src.slice(i, k);
      if (c === '~' && run.length > 2) { text += run; i = k; continue; }
      const before = i === 0 ? ' ' : src[i - 1];
      const after = k >= n ? ' ' : src[k];
      const ws = (ch) => /\s/u.test(ch);
      const punct = (ch) => /[\p{P}\p{S}]/u.test(ch);
      const left = !ws(after) && (!punct(after) || ws(before) || punct(before));
      const right = !ws(before) && (!punct(before) || ws(after) || punct(after));
      let canOpen = left;
      let canClose = right;
      if (c === '_') { canOpen = left && (!right || punct(before)); canClose = right && (!left || punct(after)); }
      flush();
      const d = { type: 'delim', char: c, count: run.length, orig: run.length, canOpen, canClose, at: nodes.length, active: true };
      nodes.push(d); delims.push(d);
      i = k; continue;
    }
    text += c; i++;
  }
  flush();
  processEmphasis(nodes, delims.filter(d => d.char === '*' || d.char === '_' || d.char === '~'));
  // Brackets that closed nothing are text.
  return mergeText(nodes.map(nd => (nd.type === 'delim' ? { type: 'text', value: nd.char === '![' ? '![' : nd.char.repeat(nd.count ?? 1) } : nd)));
}

function normalizeLabel(s) {
  return String(s).trim().replace(/\s+/g, ' ').toLowerCase();
}

function unescapeMd(s) {
  return String(s).replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1');
}

/** CommonMark's "process emphasis", over a flat node list holding delimiter nodes. */
function processEmphasis(nodes, delims) {
  const list = delims.filter(d => nodes.includes(d));
  let ci = 0;
  while (ci < list.length) {
    const closer = list[ci];
    if (!closer.canClose || closer.count === 0) { ci++; continue; }
    let found = -1;
    for (let oi = ci - 1; oi >= 0; oi--) {
      const op = list[oi];
      if (op.char !== closer.char || !op.canOpen || op.count === 0) continue;
      if (closer.char === '~') { if (op.count !== closer.count) continue; }
      else if ((op.canClose || closer.canOpen) && (op.orig + closer.orig) % 3 === 0 && !(op.orig % 3 === 0 && closer.orig % 3 === 0)) continue;
      found = oi; break;
    }
    if (found < 0) { ci++; continue; }
    const opener = list[found];
    const use = closer.char === '~' ? closer.count : (opener.count >= 2 && closer.count >= 2 ? 2 : 1);
    const type = closer.char === '~' ? 'del' : use === 2 ? 'strong' : 'em';
    const oAt = nodes.indexOf(opener);
    const cAt = nodes.indexOf(closer);
    const inner = nodes.slice(oAt + 1, cAt).map(nd => (nd.type === 'delim' && !(nd.char === '*' || nd.char === '_' || nd.char === '~') ? nd : nd));
    // Delimiters between them that found no partner are text from here on.
    for (let k = found + 1; k < ci; k++) list[k].count = list[k].count;   // they stay in `inner` and become text below
    const node = { type, children: inner };
    nodes.splice(oAt + 1, cAt - oAt - 1, node);
    for (let k = ci - 1; k > found; k--) list.splice(k, 1);
    ci = found + 1;
    opener.count -= use;
    closer.count -= use;
    if (opener.count === 0) { nodes.splice(nodes.indexOf(opener), 1); list.splice(list.indexOf(opener), 1); ci--; }
    if (closer.count === 0) { nodes.splice(nodes.indexOf(closer), 1); list.splice(list.indexOf(closer), 1); }
  }
  // Inside each new node, unmatched delimiters are text.
  const fix = (arr) => {
    for (let k = 0; k < arr.length; k++) {
      const nd = arr[k];
      if (nd.type === 'delim' && (nd.char === '*' || nd.char === '_' || nd.char === '~')) arr[k] = { type: 'text', value: nd.char.repeat(nd.count) };
      else if (nd.children) fix(nd.children);
    }
  };
  fix(nodes);
}

function mergeText(arr) {
  const out = [];
  for (const nd of arr) {
    if (nd.children) nd.children = mergeText(nd.children);
    if (nd.type === 'text' && !nd.value) continue;
    const prev = out[out.length - 1];
    if (nd.type === 'text' && prev && prev.type === 'text') prev.value += nd.value;
    else out.push(nd);
  }
  return out;
}

/** The words of inline nodes, as a reader sees them. */
export function textOf(nodes) {
  let s = '';
  for (const nd of nodes || []) {
    if (nd.type === 'text' || nd.type === 'code') s += nd.value;
    else if (nd.type === 'break' || nd.type === 'soft') s += '\n';
    else if (nd.type === 'image') s += nd.alt;
    else if (nd.children) s += textOf(nd.children);
  }
  return s;
}

/**
 * Text compared as a reader sees it: spacing does not count, typeset quotes,
 * dashes and dots are their plain forms, a non-breaking space is a space.
 */
export function plainWords(s) {
  return String(s)
    .replace(/[‘’‚′]/g, "'").replace(/[“”„″]/g, '"')
    .replace(/…/g, '...').replace(/—/g, '---').replace(/–/g, '--')
    .replace(/[\s ]+/g, ' ').trim();
}

/** The words a block of Markdown shows, nested blocks included. */
export function blockWords(text, opts = {}) {
  return plainWords(blockText(text, opts));
}

function blockText(text, opts) {
  const refs = opts.refs || {};
  const out = [];
  for (const b of markdownBlocks(text, opts)) {
    const raw = text.slice(b.start, b.end);
    if (b.kind === 'paragraph') out.push(textOf(parseInline(raw, { ...opts, refs })));
    else if (b.kind === 'heading') out.push(textOf(parseInline(headingInside(raw, b), { ...opts, refs })));
    else if (b.kind === 'blockquote') out.push(blockText(quoteInside(raw), opts));
    else if (b.kind === 'list') for (const it of listItems(raw)) out.push(blockText(it, opts));
    else if (b.kind === 'code') out.push(codeInside(raw, b));
  }
  return out.join(' ');
}

/** A heading's words, without its # marks (or its underline). */
export function headingInside(raw, b) {
  if (b.setext) return raw.split('\n').slice(0, -1).map(l => l.trim()).join('\n');
  return raw.replace(/^ {0,3}#{1,6}(?:[ \t]+|$)/, '').replace(/(?:^|[ \t]+)#+[ \t]*$/, '').trim();
}

function codeInside(raw, b) {
  if (!b.fenced) return raw.split('\n').map(l => l.replace(/^ {4}|^\t/, '')).join('\n');
  const ls = raw.split('\n');
  return ls.slice(1, /^ {0,3}(`{3,}|~{3,})[ \t]*$/.test(ls[ls.length - 1]) && ls.length > 1 ? -1 : undefined).join('\n');
}

/** The reference definitions in a text: label → { url, title }. */
export function linkRefs(text, opts = {}) {
  const refs = {};
  for (const b of markdownBlocks(text, opts)) {
    if (b.kind !== 'linkdef') continue;
    const m = /^ {0,3}\[((?:[^\]\\]|\\.)+)\]:[ \t]*(?:<([^>]*)>|(\S+))(?:\s+("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^()\\]|\\.)*\)))?/.exec(text.slice(b.start, b.end));
    if (m) {
      const key = normalizeLabel(m[1]);
      if (!refs[key]) refs[key] = { url: unescapeMd(m[2] ?? m[3]), title: m[4] ? unescapeMd(m[4].slice(1, -1)) : '' };
    }
  }
  return refs;
}

/**
 * A text's shape, as one string: which blocks, which marks around which
 * words, which links to where. Two texts with the same shape render the same
 * page (white space inside a paragraph aside).
 */
export function shapeOf(text, opts = {}) {
  const refs = opts.refs || linkRefs(text, opts);
  const o = { ...opts, refs };
  return markdownBlocks(text, opts).map(b => {
    const raw = text.slice(b.start, b.end);
    if (b.kind === 'paragraph') return `p(${inlineShape(parseInline(raw, o))})`;
    if (b.kind === 'heading') return `h${b.level}(${inlineShape(parseInline(headingInside(raw, b), o))})`;
    if (b.kind === 'blockquote') return `q(${shapeOf(quoteInside(raw), o)})`;
    if (b.kind === 'list') {
      const loose = listIsLoose(raw);
      return `${b.ordered ? `ol${b.number === 1 ? '' : b.number}` : 'ul'}(${listItems(raw).map(it => `li(${loose ? shapeOf(it, o) : shapeOf(it, o).replace(/^p\((.*)\)$/s, '$1')})`).join('')})`;
    }
    if (b.kind === 'hr') return 'hr';
    if (b.kind === 'linkdef') return '';
    return `${b.kind}[${raw}]`;
  }).filter(Boolean).join('');
}

/** Typeset and plain forms of quotes, dashes and dots read the same: a site's renderer makes one of the other. */
function typo(s) {
  return String(s).replace(/[\u2018\u2019\u201A\u2032]/g, "'").replace(/[\u201C\u201D\u201E\u2033]/g, '"')
    .replace(/\u2026/g, '...').replace(/\u2014/g, '---').replace(/\u2013/g, '--').replace(/\u00a0/g, ' ');
}

function inlineShape(nodes) {
  let s = '';
  let words = '';   // text and soft line breaks read as one run of words
  const flush = () => { if (words) { s += JSON.stringify(words.replace(/\s+/g, ' ')); words = ''; } };
  for (const nd of nodes) {
    if (nd.type === 'text') { words += typo(nd.value); continue; }
    if (nd.type === 'soft') { words += ' '; continue; }
    flush();
    if (nd.type === 'break') s += 'br';
    else if (nd.type === 'code') s += `code${JSON.stringify(nd.value)}`;
    else if (nd.type === 'image') s += `img(${JSON.stringify(nd.url)},${JSON.stringify(nd.alt)})`;
    else if (nd.type === 'link') s += `a(${JSON.stringify(nd.url)}:${inlineShape(nd.children)})`;
    else if (nd.type === 'strong' || nd.type === 'em' || nd.type === 'del') s += `${nd.type}(${inlineShape(nd.children)})`;
    else s += `${nd.type}[${nd.value}]`;
  }
  flush();
  return s;
}

// ─── 3. From the page back to Markdown ───────────────────────────────────────

/** The file's own ways of writing things, read from its text; the common defaults where it has none. */
export function sniffStyle(text) {
  const style = { bullet: '-', delim: '.', em: '*', strong: '**', hr: '---', br: '\\', fence: '```' };
  const bl = /^ {0,3}([-+*])[ \t]+\S/m.exec(text.replace(/^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, ''));
  if (bl) style.bullet = bl[1];
  const ol = /^ {0,3}\d{1,9}([.)])[ \t]+\S/m.exec(text);
  if (ol) style.delim = ol[1];
  const st = /(\*\*|__)(?=\S)[\s\S]*?\S\1/.exec(text);
  if (st) style.strong = st[1];
  const em = /(?:^|[^*_\w])([*_])(?=[^\s*_])[^*_\n]*?[^\s*_]\1(?![*_\w])/.exec(text);
  if (em) style.em = em[1];
  const hr = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/m.exec(text);
  if (hr) style.hr = hr[0].trim();
  if (/ {2,}\n\S/.test(text) && !/\\\n/.test(text)) style.br = '  ';
  const fence = /^ {0,3}(~{3,})/m.exec(text);
  if (fence && !/^ {0,3}`{3,}/m.test(text)) style.fence = '~~~';
  return style;
}

const KEEP = 'data-kiln-keep';
/** The token that stands for a part kept exactly as the file has it (a picture, a component). */
export const keptToken = (n) => `${n}`;
const KEPT_TOKEN = /(\d+)/g;

const childList = (node) => Array.from(node?.childNodes || []);
const tagOf = (node) => String(node?.tagName || '').toUpperCase();
const attr = (node, name) => (typeof node?.getAttribute === 'function' ? node.getAttribute(name) : null);

/** Text written so that Markdown reads it as the same words. */
export function escapeText(s, { mdx = false, lineStart = false } = {}) {
  let out = String(s).replace(/ /g, ' ')
    .replace(/[\\`*_[\]<]/g, '\\$&')
    .replace(/~~/g, '\\~\\~')
    .replace(/&(?=#?\w+;)/g, '\\&')
    .replace(/!(?=\\\[)/g, '\\!');
  if (mdx) out = out.replace(/[{}]/g, '\\$&');
  if (lineStart) out = out.replace(/^([ \t]*)([#>+-]|\d+(?=[.)][ \t]|[.)]$))/gm, (m, sp, ch) => `${sp}\\${ch}`).replace(/^([ \t]*)(=+)[ \t]*$/gm, '$1\\$2');
  return out;
}

function codeSpan(v) {
  const runs = (v.match(/`+/g) || []).map(r => r.length);
  let n = 1;
  while (runs.includes(n)) n++;
  const tick = '`'.repeat(n);
  const pad = /^`|`$|^ .* $/.test(v) ? ' ' : '';
  return `${tick}${pad}${v}${pad}${tick}`;
}

function linkDest(url) {
  const u = String(url || '');
  if (u === '' || /[\s<>()]/.test(u)) return `<${u.replace(/[<>]/g, (c) => encodeURIComponent(c))}>`;
  return u;
}

/** A node's inside as inline Markdown. */
export function inlineMarkdown(node, style, opts = {}) {
  let out = '';
  for (const ch of childList(node)) {
    let part = inlineOf(ch, style, opts);
    // After a hard break the next line starts at once: the page keeps the
    // file's line break as white space, which must not become a blank line.
    if (/(?:\\|  )\n$/.test(out)) part = part.replace(/^[ \t]*\n?[ \t]*/, '');
    out += part;
  }
  return out;
}

function inlineOf(node, style, opts) {
  if (node.nodeType === 3) return escapeText(String(node.nodeValue ?? node.data ?? '').replace(/[ \t]*\n[ \t]*/g, '\n'), opts);
  if (node.nodeType !== 1) return '';
  const tag = tagOf(node);
  const keep = attr(node, KEEP);
  if (keep !== null && keep !== '') return keptToken(keep);
  const inner = () => inlineMarkdown(node, style, opts);
  if (tag === 'BR') return style.br === '  ' ? '  \n' : '\\\n';
  if (tag === 'STRONG' || tag === 'B') return wrap(inner(), style.strong);
  if (tag === 'EM' || tag === 'I') return wrap(inner(), style.em);
  if (tag === 'DEL' || tag === 'S' || tag === 'STRIKE') return wrap(inner(), '~~');
  if (tag === 'CODE') return codeSpan(String(node.textContent ?? ''));
  if (tag === 'A') {
    const href = attr(node, 'href') || '';
    const words = inner();
    const title = attr(node, 'title');
    if (!title && /^(?:https?:|mailto:)/i.test(href) && words === escapeText(href.replace(/^mailto:/i, ''), opts) && !/[\s<>]/.test(href)) return `<${href.replace(/^mailto:/i, '')}>`;
    return `[${words}](${linkDest(href)}${title ? ` "${title.replace(/"/g, '\\"')}"` : ''})`;
  }
  if (tag === 'IMG') {
    const alt = attr(node, 'alt') || '';
    const title = attr(node, 'title');
    return `![${escapeText(alt, opts)}](${linkDest(attr(node, 'src') || '')}${title ? ` "${title.replace(/"/g, '\\"')}"` : ''})`;
  }
  if (/^(?:P|DIV|H[1-6]|LI|BLOCKQUOTE)$/.test(tag)) return inner();
  return inner();   // a span, a mark, an underline: their words
}

/** Marks around words: the white space at the edges stays outside the marks, as Markdown needs. */
function wrap(s, mark) {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s);
  if (!m[2]) return s;
  return `${m[1]}${mark}${m[2]}${mark}${m[3]}`;
}

/**
 * A page block as Markdown: P, H1–H6, UL/OL (nested), BLOCKQUOTE, HR, and any
 * other element as the blocks inside it. No line break at the end.
 */
export function blockMarkdown(node, style, opts = {}) {
  const tag = tagOf(node);
  if (node.nodeType === 3) return escapeText(String(node.nodeValue ?? node.data ?? '').trim(), { ...opts, lineStart: true });
  const keep = attr(node, KEEP);
  if (keep !== null && keep !== '') return keptToken(keep);
  if (tag === 'P') return trimLines(escapeLineStarts(inlineMarkdown(node, style, opts), opts));
  const h = /^H([1-6])$/.exec(tag);
  if (h) return `${'#'.repeat(+h[1])} ${inlineMarkdown(node, style, opts).replace(/\\?\n|  \n/g, ' ').replace(/\s+/g, ' ').trim()}`;
  if (tag === 'HR') return style.hr || '---';
  if (tag === 'UL' || tag === 'OL') return listMarkdown(node, style, opts);
  if (tag === 'BLOCKQUOTE') {
    const inside = blocksMarkdown(node, style, opts);
    return inside.split('\n').map(l => (l ? `> ${l}` : '>')).join('\n');
  }
  if (tag === 'PRE') {
    const code = String(node.textContent ?? '').replace(/\n$/, '');
    const fence = style.fence === '~~~' ? '~~~' : '```';
    let f = fence;
    while (code.includes(f)) f += fence[0];
    return `${f}\n${code}\n${f}`;
  }
  return blocksMarkdown(node, style, opts);
}

/** Lines that would start a block are given a backslash, so they stay words. */
function escapeLineStarts(s, opts) {
  return s.split('\n').map((l, k) => (k === 0 || !/^\\\s*$/.test(l) ? l : l)).join('\n')
    .replace(/(^|\n)([ \t]*)([#>+-]|\d+(?=[.)](?:[ \t]|$)))/g, (m, nl, sp, ch) => `${nl}${sp}\\${ch}`)
    .replace(/(^|\n)([ \t]*)(=+|-+)[ \t]*(?=\n|$)/g, (m, nl, sp, ch) => `${nl}${sp}\\${ch}`);
}

function trimLines(s) {
  return s.replace(/^[ \t]+|[ \t]+$/g, '').replace(/[ \t]+\n/g, (m) => (/ {2}\n$/.test(m) ? '  \n' : '\n'));
}

/** The blocks inside an element (a quote, a list item, a div) as Markdown, a blank line between. */
export function blocksMarkdown(node, style, opts = {}, sep = '\n\n') {
  const parts = [];
  let inline = [];
  const flushInline = () => {
    if (!inline.length) return;
    const s = inline.map(ch => inlineOf(ch, style, opts)).join('');
    if (s.trim()) parts.push(trimLines(escapeLineStarts(s.replace(/^\s+|\s+$/g, ''), opts)));
    inline = [];
  };
  for (const ch of childList(node)) {
    const tag = tagOf(ch);
    const isBlock = ch.nodeType === 1 && /^(?:P|DIV|H[1-6]|UL|OL|BLOCKQUOTE|HR|PRE|TABLE|SECTION|ASIDE|FIGURE|DL)$/.test(tag);
    if (isBlock || (ch.nodeType === 1 && attr(ch, KEEP) !== null && attr(ch, KEEP) !== '' && isBlockKeep(ch))) {
      flushInline();
      const md = blockMarkdown(ch, style, opts);
      if (md.trim()) parts.push(md);
    } else inline.push(ch);
  }
  flushInline();
  return parts.join(sep);
}

const isBlockKeep = (node) => /^(?:PRE|TABLE|DIV|SECTION|ASIDE|FIGURE|IFRAME|VIDEO|DL|DETAILS|HR)$/.test(tagOf(node));

function listMarkdown(node, style, opts) {
  const ordered = tagOf(node) === 'OL';
  const start = ordered ? Number(attr(node, 'start') || 1) || 1 : 1;
  const items = childList(node).filter(ch => tagOf(ch) === 'LI');
  const loose = items.some(li => childList(li).some(ch => tagOf(ch) === 'P'));
  const out = items.map((li, k) => {
    const marker = ordered ? `${start + k}${style.delim}` : style.bullet;
    const inside = blocksMarkdown(li, style, opts, loose ? '\n\n' : '\n');
    const pad = ' '.repeat(marker.length + 1);
    const ls = (inside || '').split('\n');
    return `${marker} ${ls[0]}` + ls.slice(1).map(l => (l ? `\n${pad}${l}` : '\n')).join('');
  });
  return out.join(loose ? '\n\n' : '\n');
}

// ─── 4. The change to make ───────────────────────────────────────────────────

/**
 * Myers' diff of two sequences: the pairs of indexes that are the same, in
 * order. `eq(a, b)` compares two items. Used for characters and for blocks.
 */
export function matchPairs(a, b, eq = (x, y) => x === y) {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const v = new Map([[1, 0]]);
  const trace = [];
  outer: for (let d = 0; d <= max; d++) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1))) ? (v.get(k + 1) ?? 0) : (v.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && eq(a[x], b[y])) { x++; y++; }
      v.set(k, x);
      if (x >= n && y >= m) { trace.push(new Map(v)); break outer; }
    }
    if (d > 4000) return null;   // too different to be worth matching piece by piece
  }
  // Walk back through the trace for the matched pairs.
  const pairs = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 2; d >= 0 && (x > 0 || y > 0); d--) {
    const vv = trace[d];
    const k = x - y;
    const prevK = (k === -d || (k !== d && (vv.get(k - 1) ?? -1) < (vv.get(k + 1) ?? -1))) ? k + 1 : k - 1;
    const prevX = vv.get(prevK) ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { pairs.push([x - 1, y - 1]); x--; y--; }
    x = prevX; y = prevY;
  }
  return pairs.reverse();
}

const MARK_CHARS = /[*_~`[\]()!<>\\#]/;

/**
 * Rewrite one block of the file with the least change. `src` is the block as
 * the file has it, `was` and `now` the block as the page had it and has it,
 * both written by blockMarkdown. Returns the new text for the block, or null
 * when no change to it would read as `now` does.
 *
 * The part of `was` that differs from `now` (widened so it neither starts
 * nor ends inside a run of marks) is found in `src` by matching characters,
 * and only that part is replaced. That keeps the file's own line breaks,
 * marks and links everywhere else. The result is accepted only when it has
 * the shape `now` has (shapeOf); otherwise the whole block is written as
 * `now`, when the block holds nothing that would be lost by that.
 */
export function rewriteBlock(src, was, now, opts = {}) {
  if (was === now) return src;
  const refs = opts.refs || {};
  const target = shapeOf(now, { ...opts, refs });
  let p = 0;
  while (p < was.length && p < now.length && was[p] === now[p]) p++;
  let s = 0;
  while (s < was.length - p && s < now.length - p && was[was.length - 1 - s] === now[now.length - 1 - s]) s++;
  while (p > 0 && MARK_CHARS.test(was[p - 1])) p--;
  while (s > 0 && MARK_CHARS.test(was[was.length - s])) s--;
  // Widen to whole words, so a changed word is not stitched to half of an old one.
  while (p > 0 && /[\p{L}\p{N}]/u.test(was[p - 1]) && /[\p{L}\p{N}]/u.test(was[p] ?? '')) p--;
  while (s > 0 && /[\p{L}\p{N}]/u.test(was[was.length - s]) && /[\p{L}\p{N}]/u.test(was[was.length - s - 1] ?? '')) s--;
  const pairs = matchPairs(was, src);
  if (pairs) {
    const fwd = new Map(pairs);
    const at = (x, dir) => {
      // The place in src that stands where position x stands in `was`.
      if (dir < 0) { for (let k = x - 1; k >= 0; k--) if (fwd.has(k)) return fwd.get(k) + 1; return 0; }
      for (let k = x; k < was.length; k++) if (fwd.has(k)) return fwd.get(k);
      return src.length;
    };
    const a = at(p, -1);
    const b = at(was.length - s, 1);
    if (a <= b) {
      const candidate = src.slice(0, a) + now.slice(p, now.length - s) + src.slice(b);
      if (shapeOf(candidate, { ...opts, refs }) === target) return candidate;
    }
  }
  return rewritable(src, opts) ? now : null;
}

/**
 * Whether a block can be written afresh from the page without losing
 * anything: nothing in it that the page cannot give back (HTML, a component,
 * an expression, a footnote mark, a reference picture).
 */
export function rewritable(src, opts = {}) {
  let ok = true;
  const walk = (nodes) => {
    for (const nd of nodes) {
      if (['html', 'jsx', 'expr', 'footref'].includes(nd.type)) ok = false;
      if (nd.children) walk(nd.children);
    }
  };
  const visit = (text) => {
    for (const b of markdownBlocks(text, opts)) {
      const raw = text.slice(b.start, b.end);
      if (b.kind === 'paragraph') walk(parseInline(raw, opts));
      else if (b.kind === 'heading') walk(parseInline(headingInside(raw, b), opts));
      else if (b.kind === 'blockquote') visit(quoteInside(raw));
      else if (b.kind === 'list') listItems(raw).forEach(visit);
      else if (!PROSE.has(b.kind) && b.kind !== 'linkdef') ok = false;
    }
  };
  visit(src);
  return ok;
}

/**
 * The parts of a text that are kept exactly as written, in order: pictures
 * (so a picture the page shows by another address, as Astro's optimised
 * ones are, goes back as the file wrote it) and, in MDX, components and
 * expressions inside paragraphs. Returns [{ type, raw }].
 */
export function keptInlines(text, opts = {}) {
  const out = [];
  const walk = (nodes) => {
    for (const nd of nodes) {
      if (nd.type === 'image') out.push({ type: 'image', raw: nd.raw, alt: nd.alt });
      else if (nd.type === 'jsx' || nd.type === 'expr' || nd.type === 'html' || nd.type === 'footref') out.push({ type: nd.type, raw: nd.value });
      if (nd.children) walk(nd.children);
    }
  };
  const visit = (t) => {
    for (const b of markdownBlocks(t, opts)) {
      const raw = t.slice(b.start, b.end);
      if (b.kind === 'paragraph') walk(parseInline(raw, opts));
      else if (b.kind === 'heading') walk(parseInline(headingInside(raw, b), opts));
      else if (b.kind === 'blockquote') visit(quoteInside(raw));
      else if (b.kind === 'list') listItems(raw).forEach(visit);
    }
  };
  visit(text);
  return out;
}

/** Put back the parts a page block stood for with tokens: `kept` is [raw text by token number]. */
export function restoreKept(md, kept) {
  let bad = false;
  const out = md.replace(KEPT_TOKEN, (m, n) => {
    const raw = kept[Number(n)];
    if (typeof raw !== 'string') { bad = true; return ''; }
    return raw;
  });
  return bad ? null : out;
}

/**
 * The new text of a whole Markdown body, changed only where the page was.
 *
 *   text     the body as the file has it
 *   source   its prose blocks, in order, as matched to the page's (from matchBlocks)
 *   before   the page's blocks when editing began: [{ md } | { keep: id }]
 *   after    the page's blocks now, the same way
 *   kept     the raw text each token number stands for
 *   style    sniffStyle(text)
 *
 * Returns { text } or { error } with a reason a person can be told.
 */
export function planBody({ text, source, before, after, kept = [], opts = {} }) {
  const keepsBefore = before.filter(b => 'keep' in b).map(b => b.keep);
  const keepsAfter = after.filter(b => 'keep' in b).map(b => b.keep);
  if (keepsBefore.join('|') !== keepsAfter.join('|')) return { error: 'kept-moved' };
  const proseBefore = before.filter(b => 'md' in b);
  const proseAfter = after.filter(b => 'md' in b);
  if (proseBefore.length !== source.length) return { error: 'unmatched' };

  const pairs = matchPairs(proseBefore.map(b => b.md), proseAfter.map(b => b.md)) || [];
  const matchedB = new Map(pairs);                  // before index → after index
  const matchedA = new Map(pairs.map(([x, y]) => [y, x]));
  // Changed blocks between two that stayed are paired in order; the rest were removed or added.
  const replaced = new Map();   // before index → after index
  const removed = [];
  const added = [];             // after indexes
  let bi = 0;
  let ai = 0;
  const anchors = [...pairs, [proseBefore.length, proseAfter.length]];
  for (const [nb, na] of anchors) {
    const gb = [];
    const ga = [];
    for (; bi < nb; bi++) if (!matchedB.has(bi)) gb.push(bi);
    for (; ai < na; ai++) if (!matchedA.has(ai)) ga.push(ai);
    const k = Math.min(gb.length, ga.length);
    for (let q = 0; q < k; q++) replaced.set(gb[q], ga[q]);
    removed.push(...gb.slice(k));
    added.push(...ga.slice(k));
    bi = nb + 1; ai = na + 1;
  }

  const refs = opts.refs || linkRefs(text, opts);
  const splices = [];
  for (const [b, a] of replaced) {
    const blk = source[b];
    const src = text.slice(blk.start, blk.end);
    const now = restoreKept(proseAfter[a].md, kept);
    const was = restoreKept(proseBefore[b].md, kept);
    if (now === null || was === null) return { error: 'unknown-part' };
    const next = rewriteBlock(src, was, now, { ...opts, refs });
    if (next === null) return { error: 'not-writable' };
    splices.push({ start: blk.start, end: blk.end, text: next });
  }
  for (const b of removed) {
    const blk = source[b];
    // The block and the blank lines after it go; the last block takes the blank lines before it.
    let end = blk.end;
    while (end < text.length && /[ \t\r\n]/.test(text[end])) end++;
    let start = blk.start;
    if (end >= text.length) { while (start > 0 && /[ \t\r\n]/.test(text[start - 1])) start--; end = blk.end; }
    splices.push({ start, end, text: '' });
  }
  // An added block goes after the block before it on the page, or before the one after it.
  const afterSeq = after.map((b, k) => ('md' in b ? { prose: proseAfter.indexOf(b) } : { keep: b.keep }));
  for (const a of added) {
    const md = restoreKept(proseAfter[a].md, kept);
    if (md === null) return { error: 'unknown-part' };
    const pos = afterSeq.findIndex(x => x.prose === a);
    let anchor = null;
    for (let k = pos - 1; k >= 0; k--) {
      if ('keep' in afterSeq[k]) break;
      const before = matchedA.has(afterSeq[k].prose) ? matchedA.get(afterSeq[k].prose) : [...replaced].find(([, y]) => y === afterSeq[k].prose)?.[0];
      if (before !== undefined) { anchor = { at: source[before].end, text: `\n\n${md}` }; break; }
    }
    if (!anchor) {
      for (let k = pos + 1; k < afterSeq.length; k++) {
        if ('keep' in afterSeq[k]) break;
        const before = matchedA.has(afterSeq[k].prose) ? matchedA.get(afterSeq[k].prose) : [...replaced].find(([, y]) => y === afterSeq[k].prose)?.[0];
        if (before !== undefined) { anchor = { at: source[before].start, text: `${md}\n\n` }; break; }
      }
    }
    if (!anchor && !source.length && !keepsAfter.length) {
      const lead = /^\s*/.exec(text)[0].length;
      anchor = { at: lead, text: text.trim() ? `${md}\n\n` : `${md}\n` };
    }
    if (!anchor) return { error: 'ambiguous' };
    splices.push({ start: anchor.at, end: anchor.at, text: anchor.text, order: pos });
  }
  splices.sort((x, y) => y.start - x.start || (y.order ?? 0) - (x.order ?? 0));
  let out = text;
  for (const sp of splices) out = out.slice(0, sp.start) + sp.text + out.slice(sp.end);
  return { text: out };
}

/**
 * Match the page's prose blocks to the file's, in order, by what they say.
 * `page`: [{ tag, words }] for the page's prose blocks. Returns the file's
 * prose blocks (one for each page block) or { error: 'unmatched' | 'changed', at }.
 * A component, an expression or HTML inside a paragraph shows words the file
 * does not hold as words: there, any words are taken.
 */
export function matchBlocks(text, page, opts = {}) {
  const refs = opts.refs || linkRefs(text, opts);
  const source = markdownBlocks(text, opts).filter(b => PROSE.has(b.kind));
  if (source.length !== page.length) return { error: 'unmatched', at: Math.min(source.length, page.length) };
  for (let k = 0; k < source.length; k++) {
    const b = source[k];
    if (blockTag(b) !== page[k].tag) return { error: 'unmatched', at: k };
    const pattern = wordsPattern(text.slice(b.start, b.end), { ...opts, refs });
    if (!pattern.test(plainWords(page[k].words))) return { error: 'changed', at: k };
  }
  return { blocks: source, refs };
}

const WILD = '\u0000';
/** A pattern for the words a block shows: its words, and any words where a component, an expression or HTML stands. */
export function wordsPattern(text, opts = {}) {
  const raw = plainWords(blockTextWild(text, opts));
  const parts = raw.split(WILD).map(p => p.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${parts.join('.*?')}$`.replace(/(\.\*\?)+/g, '.*?').replace(/^\^\.\*\?\s*/, '^.*?').replace(/\s*\.\*\?\$$/, '.*?$').replace(/ ?\.\*\? ?/g, '.*?'), 's');
}

function blockTextWild(text, opts) {
  const refs = opts.refs || {};
  const inline = (raw) => wildText(parseInline(raw, { ...opts, refs }));
  const out = [];
  for (const b of markdownBlocks(text, opts)) {
    const raw = text.slice(b.start, b.end);
    if (b.kind === 'paragraph') out.push(inline(raw));
    else if (b.kind === 'heading') out.push(inline(headingInside(raw, b)));
    else if (b.kind === 'blockquote') out.push(blockTextWild(quoteInside(raw), opts));
    else if (b.kind === 'list') for (const it of listItems(raw)) out.push(blockTextWild(it, opts));
    else if (b.kind === 'code') out.push(codeInside(raw, b));
    else if (b.kind !== 'linkdef') out.push(WILD);
  }
  return out.join(' ');
}

function wildText(nodes) {
  let s = '';
  for (const nd of nodes || []) {
    if (nd.type === 'text' || nd.type === 'code') s += nd.value;
    else if (nd.type === 'break' || nd.type === 'soft') s += '\n';
    else if (nd.type === 'image') s += nd.alt;
    else if (nd.type === 'html' || nd.type === 'jsx' || nd.type === 'expr' || nd.type === 'footref') s += WILD;
    else if (nd.children) s += wildText(nd.children);
  }
  return s;
}

/** The words a page block shows, a picture counted by its description (as blockWords counts it). */
export function domWords(node) {
  if (!node) return '';
  if (node.nodeType === 3) return String(node.nodeValue ?? node.data ?? '');
  if (node.nodeType !== 1) return '';
  if (tagOf(node) === 'IMG') return attr(node, 'alt') || '';
  if (tagOf(node) === 'BR') return '\n';
  const inside = childList(node).map(domWords).join('');
  // A block's words are apart from the next block's, however the page wrote them.
  return /^(?:P|LI|H[1-6]|BLOCKQUOTE|UL|OL|DIV|TR|TD|TH|PRE|DD|DT|FIGCAPTION|SECTION|ASIDE)$/.test(tagOf(node)) ? `\n${inside}\n` : inside;
}

// ─── What may not change, and what may not be added ──────────────────────────

/**
 * The code in an MDX text, in order: its import and export lines, its
 * components and expressions (on lines of their own or inside a paragraph).
 * A change may move none of it, change none of it and add none of it: the
 * site runs it when it builds.
 */
export function mdxCode(text) {
  const out = [];
  const visit = (t) => {
    for (const b of markdownBlocks(t, { mdx: true })) {
      const raw = t.slice(b.start, b.end);
      if (b.kind === 'esm' || b.kind === 'jsx' || b.kind === 'expression' || b.kind === 'comment') out.push(raw);
      else if (b.kind === 'paragraph' || b.kind === 'heading') walk(parseInline(b.kind === 'heading' ? headingInside(raw, b) : raw, { mdx: true }));
      else if (b.kind === 'blockquote') visit(quoteInside(raw));
      else if (b.kind === 'list') listItems(raw).forEach(visit);
      else if (b.kind === 'html') out.push(raw);
    }
  };
  const walk = (nodes) => {
    for (const nd of nodes) {
      if (nd.type === 'jsx' || nd.type === 'expr' || nd.type === 'html') out.push(nd.value);
      if (nd.children) walk(nd.children);
    }
  };
  visit(String(text));
  return out;
}

const DANGEROUS_URL = /^(?:javascript|vbscript):|^data:(?:text\/html|image\/svg)/;

/** Link and picture addresses in Markdown that would run code when followed: ['url:…']. */
export function riskyUrls(text, opts = {}) {
  const out = [];
  const refs = linkRefs(text, opts);
  const look = (url) => {
    const u = String(url || '').replace(/[\u0000- ]/g, '').toLowerCase();
    if (DANGEROUS_URL.test(u)) out.push('url:' + String(url).trim());
  };
  for (const r of Object.values(refs)) look(r.url);
  const walk = (nodes) => {
    for (const nd of nodes) {
      if (nd.type === 'link' || nd.type === 'image') look(nd.url);
      if (nd.children) walk(nd.children);
    }
  };
  const visit = (t) => {
    for (const b of markdownBlocks(t, opts)) {
      const raw = t.slice(b.start, b.end);
      if (b.kind === 'paragraph') walk(parseInline(raw, { ...opts, refs }));
      else if (b.kind === 'heading') walk(parseInline(headingInside(raw, b), { ...opts, refs }));
      else if (b.kind === 'blockquote') visit(quoteInside(raw));
      else if (b.kind === 'list') listItems(raw).forEach(visit);
    }
  };
  visit(String(text));
  return out;
}
