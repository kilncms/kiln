/**
 * The publish sheet: what is about to change, before it changes.
 *
 * Opens from every Publish control. Each unpublished edit is shown as before
 * and after in the page's own words, with a control to drop that one edit, a
 * line for a note that becomes the commit message, and warnings that do not
 * block. One primary action. On a phone it is a sheet along the bottom edge.
 *
 * Editor chrome only. main.js hands its seams in through openPublishSheet's
 * `deps`, the same pattern as palette.js, suggest.js and firstrun.js. Anything
 * that came from the page is written with textContent, never innerHTML.
 *
 * wordDiff, trimDiff, cleanNote, noteMessage, blockNames, blockChange,
 * imageSources, linkProblems, itemWarnings and the preview setting are pure
 * and exported for tests.
 */

const NOTE_MAX = 140;
const NO_PREVIEW_KEY = 'kiln_publish_nopreview';

// ─── pure helpers ────────────────────────────────────────────────────────────

const words = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);

/**
 * Word-level difference between two texts: [{ t: 'same' | 'del' | 'ins', s }].
 * Common words at both ends are matched first, so a long text with one changed
 * word costs nothing; a middle too large to compare is shown as replaced whole.
 */
export function wordDiff(before, after, cap = 400) {
  const a = words(before), b = words(after);
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const ma = a.slice(p, a.length - s), mb = b.slice(p, b.length - s);
  const out = [];
  const push = (t, w) => { const last = out[out.length - 1]; if (last && last.t === t) last.s += ' ' + w; else out.push({ t, s: w }); };
  for (const w of a.slice(0, p)) push('same', w);
  if (ma.length > cap || mb.length > cap) {
    for (const w of ma) push('del', w);
    for (const w of mb) push('ins', w);
  } else {
    // longest common subsequence over the middle
    const n = ma.length, m = mb.length;
    const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = ma[i] === mb[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (ma[i] === mb[j]) { push('same', ma[i]); i++; j++; }
      else if (L[i + 1][j] >= L[i][j + 1]) push('del', ma[i++]);
      else push('ins', mb[j++]);
    }
    while (i < n) push('del', ma[i++]);
    while (j < m) push('ins', mb[j++]);
  }
  for (const w of a.slice(a.length - s)) push('same', w);
  return out;
}

/** Shorten the unchanged stretches of a diff to a few words each side of a change. */
export function trimDiff(parts, keep = 6) {
  if (!parts.some(p => p.t !== 'same')) return parts;
  return parts.map((p, i) => {
    if (p.t !== 'same') return p;
    const w = p.s.split(' ');
    const first = i === 0, last = i === parts.length - 1;
    if (w.length <= keep * (first || last ? 1 : 2) + 1) return p;
    if (first) return { t: 'same', s: '… ' + w.slice(-keep).join(' ') };
    if (last) return { t: 'same', s: w.slice(0, keep).join(' ') + ' …' };
    return { t: 'same', s: w.slice(0, keep).join(' ') + ' … ' + w.slice(-keep).join(' ') };
  });
}

/**
 * The note as it may be stored: one line of plain text. Tags and control
 * characters are removed, runs of space collapsed, and the length capped.
 */
export function cleanNote(text, max = NOTE_MAX) {
  return String(text ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[<>]/g, ' ')
    .split('').map(ch => (invisible(ch.charCodeAt(0)) ? ' ' : ch)).join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
}

/** The commit message for a note; '' when there is no note (the caller keeps its own). */
export function noteMessage(note) {
  const n = cleanNote(note);
  return n ? `${n} (via Kiln)` : '';
}

// Code points that take no space or steer the text: controls, zero-width marks,
// line and paragraph separators, direction overrides, the byte-order mark.
const INVISIBLE = [[0x00, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2066, 0x2069], [0xfeff, 0xfeff]];
function invisible(code) { return INVISIBLE.some(([from, to]) => code >= from && code <= to); }

const stripTags = (html) => String(html ?? '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/\s+/g, ' ').trim();

/** A name for each block in a list: its heading if it has one, else its first words. */
export function blockNames(blocks) {
  return blocks.map(html => {
    const h = String(html).match(/<(h[1-6]|strong|b|figcaption|dt)\b[^>]*>([\s\S]*?)<\/\1>/i);
    const name = stripTags(h ? h[2] : html) || (/<img\b/i.test(html) ? 'a picture' : 'an empty block');
    return name.length > 48 ? name.slice(0, 45).trimEnd() + '…' : name;
  });
}

/** Which named blocks were added to or removed from a list, and whether the rest moved. */
export function blockChange(beforeNames, afterNames) {
  const count = (list) => { const m = new Map(); for (const n of list) m.set(n, (m.get(n) || 0) + 1); return m; };
  const A = count(beforeNames), B = count(afterNames);
  const added = [], removed = [];
  for (const [n, c] of B) for (let i = (A.get(n) || 0); i < c; i++) added.push(n);
  for (const [n, c] of A) for (let i = (B.get(n) || 0); i < c; i++) removed.push(n);
  const keptA = beforeNames.filter(n => B.has(n)), keptB = afterNames.filter(n => A.has(n));
  const moved = !added.length && !removed.length && keptA.join('\n') !== keptB.join('\n');
  return { added, removed, moved };
}

/** Every picture address in a piece of HTML, in order. */
export function imageSources(html) {
  const out = [];
  for (const m of String(html ?? '').matchAll(/<img\b[^>]*>/gi)) {
    const src = m[0].match(/\ssrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const alt = m[0].match(/\salt\s*=\s*("([^"]*)"|'([^']*)')/i);
    out.push({ src: src ? (src[2] ?? src[3] ?? src[4] ?? '') : '', alt: alt ? (alt[2] ?? alt[3] ?? '') : null });
  }
  return out;
}

/**
 * Links in a piece of HTML that go nowhere, or that need checking.
 * Returns [{ href, text, problem: 'empty' | 'anchor' | 'check' }]:
 * empty = no address at all; anchor = "#name" (the caller checks the page has
 * it); check = an address on this site (the caller checks it exists).
 */
export function linkProblems(html, origin = '') {
  const out = [];
  for (const m of String(html ?? '').matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const h = m[1].match(/\shref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const href = (h ? (h[2] ?? h[3] ?? h[4] ?? '') : '').replace(/&amp;/g, '&').trim();
    const text = stripTags(m[2]).slice(0, 40) || 'a link';
    if (!h && !/\sname\s*=|\sid\s*=/i.test(m[1])) { out.push({ href: '', text, problem: 'empty' }); continue; }
    if (!h) continue;
    if (!href || href === '#' || /^javascript:/i.test(href)) out.push({ href, text, problem: 'empty' });
    else if (href[0] === '#') out.push({ href, text, problem: 'anchor' });
    else if (/^(mailto:|tel:|sms:|data:|blob:)/i.test(href)) continue;
    else if (/^(https?:)?\/\//i.test(href)) { if (origin && href.replace(/^\/\//, 'https://').startsWith(origin + '/')) out.push({ href, text, problem: 'check' }); }
    else out.push({ href, text, problem: 'check' });
  }
  return out;
}

/**
 * Warnings for one edit that can be told without the network. `item` is
 * { tag, afterText, images: [{ alt }] }. Returns [{ kind, text }].
 */
export function itemWarnings(item) {
  const out = [];
  if (/^h[1-6]$/i.test(item.tag || '') && !String(item.afterText ?? '').trim() && !(item.images || []).length) {
    out.push({ kind: 'empty-heading', text: 'This heading is empty.' });
  }
  const noAlt = (item.images || []).filter(i => i.changed !== false && !String(i.alt ?? '').trim()).length;
  if (noAlt) out.push({ kind: 'no-alt', text: noAlt > 1 ? `${noAlt} pictures have no description.` : 'This picture has no description.' });
  return out;
}

/** "Publish without the preview", remembered in this browser. Off by default. */
export function previewOff(storage) {
  try { return storage.getItem(NO_PREVIEW_KEY) === '1'; } catch { return false; }
}
export function setPreviewOff(storage, off) {
  try { if (off) storage.setItem(NO_PREVIEW_KEY, '1'); else storage.removeItem(NO_PREVIEW_KEY); } catch { /* storage blocked: stays on */ }
}

// ─── the sheet ───────────────────────────────────────────────────────────────

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

function diffLine(label, parts, side) {
  const row = el('div', 'kiln-ps-line');
  row.append(el('span', 'kiln-ps-tag', label));
  const body = el('span', `kiln-ps-text kiln-ps-${side}`);
  const show = parts.filter(p => p.t === 'same' || p.t === (side === 'before' ? 'del' : 'ins'));
  if (!show.length) body.append(el('span', 'kiln-ps-none', '(empty)'));
  show.forEach((p, i) => {
    if (i) body.append(' ');
    body.append(p.t === 'same' ? document.createTextNode(p.s) : el(p.t === 'del' ? 'del' : 'ins', null, p.s));
  });
  row.append(body);
  return row;
}

function thumb(src, label) {
  const fig = el('figure', 'kiln-ps-thumb');
  if (src) {
    const img = el('img');
    img.alt = '';
    img.loading = 'lazy';
    img.src = src;
    img.addEventListener('error', () => { img.replaceWith(el('span', 'kiln-ps-nopic', 'No preview')); });
    fig.append(img);
  } else fig.append(el('span', 'kiln-ps-nopic', 'None'));
  fig.append(el('figcaption', null, label));
  return fig;
}

function renderItem(item, deps, rerender) {
  const card = el('div', 'kiln-ps-item');
  card.dataset.id = item.id;
  const head = el('div', 'kiln-ps-head');
  head.append(el('strong', null, item.label));
  if (item.drop) {
    const drop = el('button', 'kiln-ps-drop', 'Drop');
    drop.type = 'button';
    drop.setAttribute('aria-label', `Drop the edit to ${item.label}`);
    drop.title = 'Leave this edit out and put the page back';
    drop.addEventListener('click', () => { item.drop(); rerender(); });
    head.append(drop);
  }
  card.append(head);
  for (const part of item.parts) {
    if (part.type === 'text') {
      const parts = trimDiff(wordDiff(part.before, part.after));
      if (part.name) card.append(el('div', 'kiln-ps-sub', part.name));
      card.append(diffLine('Before', parts, 'before'), diffLine('After', parts, 'after'));
    } else if (part.type === 'image') {
      const pair = el('div', 'kiln-ps-pics');
      pair.append(thumb(part.before, 'Before'), el('span', 'kiln-ps-arrow', '→'), thumb(part.after, 'After'));
      card.append(pair);
    } else if (part.type === 'note') {
      card.append(el('div', `kiln-ps-note kiln-ps-note--${part.tone || 'plain'}`, part.text));
    }
  }
  for (const w of item.warnings || []) {
    const row = el('button', 'kiln-ps-warn');
    row.type = 'button';
    row.append(el('span', 'kiln-ps-warn-mark', '!'), el('span', null, w.text), el('span', 'kiln-ps-warn-go', 'Show me'));
    row.addEventListener('click', () => deps.jump(item, w));
    card.append(row);
  }
  return card;
}

/**
 * Open the sheet.
 *
 * deps: {
 *   modal(html)            the editor's dialog helper
 *   items()                → [{ id, label, parts, warnings, drop?(), key? }] for what is unpublished now
 *   count()                → the number the Publish control shows
 *   label(n)               → the primary action's words ("Publish 3 edits", "Send for review")
 *   extra()                → a line for things with no row of their own (uploads), or ''
 *   checks(items, add)     optional: slow warnings; calls add(id, { kind, text }) as they arrive
 *   jump(item, warning)    close and take the person to the field
 *   publish(note)          do it; the sheet has already closed
 *   onChange()             the sheet opened, closed or lost an edit
 *   suggest                true for a suggest-only editor
 *   note                   optional: the line already typed under "What changed?" (a publish that was stopped)
 * }
 */
export function openPublishSheet(deps) {
  const m = deps.modal(`<h3 id="kiln-ps-title"></h3><div id="kiln-ps-list"></div>
    <p class="kiln-ps-extra" id="kiln-ps-extra" hidden></p>
    <label class="kiln-ps-notefield"><span>What changed?</span>
      <input type="text" id="kiln-ps-note" maxlength="${NOTE_MAX}" autocomplete="off" placeholder="${deps.suggest ? 'A line for the person who reviews it' : 'Optional. Saved with this change.'}"></label>
    <div class="kiln-modal-actions kiln-ps-actions">
      <button class="kiln-btn-ghost" data-close type="button">Cancel</button>
      <button class="kiln-btn-publish" id="kiln-pubsheet-go" type="button"></button>
    </div>`);
  m.classList.add('kiln-pubsheet');
  const card = m.querySelector('.kiln-modal-card');
  card.setAttribute('aria-labelledby', 'kiln-ps-title');
  const list = m.querySelector('#kiln-ps-list');
  const go = m.querySelector('#kiln-pubsheet-go');
  const note = m.querySelector('#kiln-ps-note');
  if (deps.note) note.value = cleanNote(deps.note);
  const late = new Map();   // id → warnings that arrived after the first draw

  const render = () => {
    const items = deps.items();
    const n = deps.count();
    if (!items.length && !n) { m.querySelector('[data-close]').click(); return; }
    m.querySelector('#kiln-ps-title').textContent = deps.suggest ? `Send ${n} change${n === 1 ? '' : 's'} for review` : (n ? `${n} change${n === 1 ? '' : 's'} to publish` : 'Ready to publish');
    go.textContent = deps.label(n);
    list.textContent = '';
    for (const item of items) {
      const all = [...(item.warnings || []), ...(late.get(item.id) || [])];
      list.append(renderItem({ ...item, warnings: all }, deps, () => { render(); deps.onChange?.(); }));
    }
    const extra = deps.extra?.() || '';
    const ex = m.querySelector('#kiln-ps-extra');
    ex.textContent = extra;
    ex.hidden = !extra;
    return items;
  };
  const items = render();
  if (!m.isConnected) return null;
  deps.checks?.(items || [], (id, w) => {
    if (!m.isConnected) return;
    const have = late.get(id) || [];
    if (have.some(x => x.text === w.text)) return;
    late.set(id, [...have, w]);
    render();
  });

  const publish = () => {
    if (go.disabled) return;
    const text = cleanNote(note.value);
    m.querySelector('[data-close]').click();
    deps.publish(text);
  };
  go.addEventListener('click', publish);
  m.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); publish(); }
  });
  // Tell the caller when the sheet goes away, however it was closed.
  new MutationObserver((_, mo) => { if (!m.isConnected) { mo.disconnect(); deps.onChange?.(); } })
    .observe(document.body, { childList: true });
  go.focus({ preventScroll: true });
  deps.onChange?.();
  return m;
}

export function publishSheetCss(mobileMq) {
  return `
.kiln-pubsheet .kiln-modal-card{max-width:560px}
.kiln-pubsheet .kiln-modal-body{display:flex;flex-direction:column;padding:22px 22px 0}
.kiln-pubsheet h3{margin-bottom:12px}
#kiln-ps-list{display:flex;flex-direction:column;gap:10px;overflow-y:auto;min-height:0;flex:1 1 auto;margin:0 -6px;padding:0 6px 2px}
.kiln-ps-item{border:1.5px solid #e9ebef;border-radius:12px;padding:11px 12px 12px;background:#fff}
.kiln-ps-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:0 0 7px}
.kiln-ps-head strong{font:600 13px/1.3 var(--kiln-font);color:#1c1c28;overflow-wrap:anywhere;text-transform:capitalize}
.kiln-ps-drop{flex:none;background:none;border:1px solid #e5e7eb;border-radius:999px;color:#6b7280;font:600 11.5px var(--kiln-font);
  padding:4px 11px;cursor:pointer}
.kiln-ps-drop:hover,.kiln-ps-drop:focus-visible{color:#b91c1c;border-color:#fca5a5;background:#fef2f2;outline:none}
.kiln-ps-sub{font:600 11.5px var(--kiln-font);color:#6b7280;margin:8px 0 3px}
.kiln-ps-line{display:grid;grid-template-columns:46px 1fr;gap:8px;align-items:baseline;margin:3px 0}
.kiln-ps-tag{font:600 9.5px var(--kiln-font);letter-spacing:.08em;text-transform:uppercase;color:#9ca3af}
.kiln-ps-text{font:13.5px/1.5 var(--kiln-font);overflow-wrap:anywhere}
.kiln-ps-before{color:#6b7280}
.kiln-ps-after{color:#111827}
.kiln-ps-text del{background:#fee2e2;color:#991b1b;text-decoration:line-through;border-radius:4px;padding:0 3px}
.kiln-ps-text ins{background:#dcfce7;color:#14532d;text-decoration:none;font-weight:600;border-radius:4px;padding:0 3px}
.kiln-ps-none{color:#9ca3af;font-style:italic}
.kiln-ps-pics{display:flex;align-items:center;gap:12px;margin:4px 0 2px}
.kiln-ps-thumb{margin:0;display:flex;flex-direction:column;align-items:center;gap:4px}
.kiln-ps-thumb img,.kiln-ps-nopic{width:84px;height:64px;border-radius:9px;object-fit:cover;background:#f3f4f6;border:1px solid #e5e7eb;display:block}
.kiln-ps-nopic{display:flex;align-items:center;justify-content:center;font:11px var(--kiln-font);color:#9ca3af}
.kiln-ps-thumb figcaption{font:600 9.5px var(--kiln-font);letter-spacing:.08em;text-transform:uppercase;color:#9ca3af}
.kiln-ps-arrow{color:#9ca3af;font-size:16px;margin-bottom:16px}
.kiln-ps-note{font:13px/1.45 var(--kiln-font);color:#374151;margin:3px 0}
.kiln-ps-note--add{color:#14532d}
.kiln-ps-note--remove{color:#991b1b}
.kiln-ps-warn{display:flex;align-items:center;gap:8px;width:100%;text-align:left;margin:9px 0 0;padding:7px 10px;border-radius:9px;
  background:#fffbeb;border:1px solid #fde68a;color:#78350f;font:12.5px/1.35 var(--kiln-font);cursor:pointer}
.kiln-ps-warn:hover,.kiln-ps-warn:focus-visible{background:#fef3c7;outline:none;border-color:#f59e0b}
.kiln-ps-warn-mark{flex:none;width:16px;height:16px;border-radius:50%;background:#f59e0b;color:#fff;font:700 11px/16px var(--kiln-font);text-align:center}
.kiln-ps-warn-go{margin-left:auto;flex:none;font-weight:600;text-decoration:underline}
.kiln-ps-extra{margin:10px 0 0;font:12.5px var(--kiln-font);color:#6b7280}
.kiln-pubsheet .kiln-ps-notefield{margin:14px 0 0;font:600 12px var(--kiln-font);color:#4b5563}
.kiln-pubsheet .kiln-ps-notefield input{font-weight:400}
.kiln-pubsheet .kiln-ps-actions{margin:14px -22px 0;padding:12px 22px;border-top:1px solid #eef0f3;background:#fafafb}
.kiln-pubsheet #kiln-pubsheet-go{min-width:150px;padding:9px 18px;font-size:14px}
/* The first-visit guide points at the button from above: leave it a strip of its own. */
.kiln-pubsheet.kiln-guided .kiln-ps-notefield{margin-bottom:56px}
@media ${mobileMq}{
#kiln-modal.kiln-pubsheet{align-items:flex-end;padding-top:0}
.kiln-pubsheet .kiln-modal-card{width:100%;max-width:none;border-radius:18px 18px 0 0;max-height:88vh;max-height:88dvh}
.kiln-pubsheet .kiln-modal-body{padding:18px 16px 0}
.kiln-pubsheet .kiln-ps-actions{margin:12px -16px 0;padding:10px 16px calc(10px + env(safe-area-inset-bottom,0px))}
.kiln-pubsheet .kiln-ps-actions button{min-height:46px;font-size:15px}
.kiln-pubsheet .kiln-ps-actions .kiln-btn-ghost{flex:0 0 auto;padding:0 18px}
.kiln-pubsheet #kiln-pubsheet-go{flex:1 1 auto}
.kiln-pubsheet .kiln-ps-notefield input{font-size:16px}
.kiln-ps-drop{min-height:34px;padding:4px 14px;font-size:12.5px}
.kiln-ps-warn{min-height:40px}
}`;
}
