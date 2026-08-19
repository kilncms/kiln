/**
 * ⌘K command palette: jump to pages and fields, run menu actions, and search
 * text across the whole site. Editor chrome only — main.js hands its seams in
 * via initPalette(deps) (no circular import), and everything else initializes
 * lazily on open.
 */

const ACTIONS = [
  { id: 'kiln-publish', label: 'Publish' },
  { id: 'kiln-history', label: 'History & restore' },
  { id: 'kiln-findreplace', label: 'Find & replace' },
  { id: 'kiln-newpost', label: 'New post or page' },
  { id: 'kiln-menu', label: 'Site menu' },
  { id: 'kiln-pagesettings', label: 'Page settings' },
  { id: 'kiln-settings', label: 'Settings' },
  { id: 'kiln-online', label: 'Who’s online' },
];

let deps = null;
let wrap = null, input = null, listEl = null;
let items = [];          // selectable rows, in render order
let sel = 0;
let viewMode = 'list';   // 'list' | 'search'
let debTimer = null;
let renderedQ = '';
let searchToken = 0;     // bumped on re-render/close — abandons an in-flight search
let pages = null;        // scope-filtered repo paths (loaded once per page load)
let pagesPromise = null;
const fileCache = new Map();   // repo path → { flat, title } — session-lived, like histCache

export function initPalette(d) {
  if (deps) return;
  deps = d;
  document.addEventListener('keydown', (e) => {
    if ((e.key !== 'k' && e.key !== 'K') || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
    if (!isOpen()) {
      if (deps.state.active) return;   // mid inline edit — ⌘K must not steal the field
      const t = document.activeElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    }
    e.preventDefault();
    if (isOpen()) closePalette(); else openPalette();
  });
}

function isOpen() { return !!wrap && wrap.isConnected; }

function closePalette() {
  searchToken++;
  wrap?.querySelector('[data-close]')?.click();   // through modal()'s close, so its key trap unhooks
  wrap = null;
}

export function openPalette() {
  if (!deps) return;
  if (isOpen()) { closePalette(); return; }
  wrap = deps.modal(`<div class="kiln-palette">
    <input id="kiln-pal-q" class="kiln-pal-input" type="text" placeholder="Jump to a page, section, or action — or search the site…"
      autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Search and jump">
    <div id="kiln-pal-list" class="kiln-pal-list" role="listbox"></div>
    <div class="kiln-pal-foot">↑↓ choose · ↵ open · esc close</div></div>`);
  wrap.classList.add('kiln-palette-wrap');
  input = wrap.querySelector('#kiln-pal-q');
  listEl = wrap.querySelector('#kiln-pal-list');
  input.addEventListener('input', () => { clearTimeout(debTimer); debTimer = setTimeout(render, 120); });
  input.addEventListener('keydown', onInputKey);
  listEl.addEventListener('click', (e) => {
    const row = e.target.closest('[data-i]');
    if (row) runItem(+row.dataset.i);
  });
  listEl.addEventListener('pointermove', (e) => {
    const row = e.target.closest('[data-i]');
    if (row && +row.dataset.i !== sel) { sel = +row.dataset.i; paintSel(); }
  });
  sitePages();   // warm the page list; re-renders when it lands
  render();
}

function onInputKey(e) {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!items.length) return;
    sel = (sel + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
    paintSel();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (input.value.trim() !== renderedQ) render();   // flush a pending debounce first
    runItem(sel);
  }
}

function runItem(i) {
  clearTimeout(debTimer);   // a pending re-render must not wipe what we're acting on
  const it = items[i];
  if (!it) return;
  if (it.keep) { it.run(); return; }   // the "search site text" row stays in the palette
  closePalette();
  it.run();
}

function paintSel() {
  listEl.querySelectorAll('.kiln-pal-item').forEach((el) => {
    const on = +el.dataset.i === sel;
    el.classList.toggle('kiln-pal-on', on);
    el.setAttribute('aria-selected', on);
    if (on) el.scrollIntoView({ block: 'nearest' });
  });
}

/** Tiny subsequence scorer: consecutive-run + word-start bonuses; -1 = no match. */
function fuzzy(q, s) {
  q = q.toLowerCase(); s = String(s).toLowerCase();
  let qi = 0, run = 0, score = 0;
  for (let i = 0; i < s.length && qi < q.length; i++) {
    if (s[i] !== q[qi]) { run = 0; continue; }
    run++; qi++;
    score += run + ((i === 0 || / |\/|_|-|\./.test(s[i - 1])) ? 3 : 0);
  }
  return qi === q.length ? score - s.length / 50 : -1;
}

function matchSort(q, rows) {
  if (!q) return rows;
  return rows.map(r => ({ r, s: fuzzy(q, r.text) })).filter(x => x.s >= 0)
    .sort((a, b) => b.s - a.s).map(x => x.r);
}

/** Menu actions the signed-in user can see right now (gating stays single-sourced on the buttons). */
function actionRows() {
  const rows = [];
  for (const a of ACTIONS) {
    const el = document.getElementById(a.id);
    if (!el || el.disabled || getComputedStyle(el).display === 'none') continue;
    rows.push({ name: a.label, text: a.label, run: () => el.click() });
  }
  return rows;
}

function pageRows() {
  if (!pages) return [];
  return pages.map((p) => {
    const cur = p === deps.state.page?.path;
    const title = fileCache.get(p)?.title || '';
    return { name: pageUrl(p), text: `${p} ${pageUrl(p)} ${title}`, hint: cur ? 'this page' : title,
      run: cur ? () => {} : () => { location.href = encodeURI(pageUrl(p)); } };
  });
}

function fieldRows() {
  if (deps.mode === 'editor' && !deps.pageInScope()) return [];
  const rows = [], seen = new Set();
  for (const el of document.querySelectorAll('[data-cms],[data-cms-repeat]')) {
    const key = el.getAttribute('data-cms') || el.getAttribute('data-cms-repeat');
    if (!key || seen.has(key)) continue;
    if (el.hasAttribute('data-cms') && el.closest('[data-cms-repeat]')) continue;   // reached via its container
    if (!deps.keyInScope(key)) continue;
    seen.add(key);
    let snip = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 42);
    if (!snip && el.tagName === 'IMG') snip = el.getAttribute('alt') || '(image)';
    const name = deps.humanizeKey(key);
    rows.push({ name, text: `${name} ${key} ${snip}`, hint: snip, run: () => flashTo(el) });
  }
  return rows;
}

function render() {
  if (!isOpen()) return;
  clearTimeout(debTimer);
  viewMode = 'list';
  searchToken++;
  const q = renderedQ = input.value.trim();
  items = [];
  let html = '';
  const add = (sec, rows) => {
    if (!rows.length) return;
    html += `<div class="kiln-pal-sec">${sec}</div>`;
    for (const r of rows) {
      items.push(r);
      html += `<button type="button" class="kiln-pal-item" role="option" data-i="${items.length - 1}">`
        + `<span class="kiln-pal-name">${deps.escapeHtml(r.name)}</span>`
        + (r.hint ? `<small>${deps.escapeHtml(r.hint)}</small>` : '') + `</button>`;
    }
  };
  add('Actions', matchSort(q, actionRows()).slice(0, 8));
  add('Pages', matchSort(q, pageRows()).slice(0, 8));
  add('On this page', matchSort(q, fieldRows()).slice(0, 8));
  if (q.length >= 3 && deps.state.gh) {
    items.push({ keep: true, run: () => runSearch(q) });
    html += `<div class="kiln-pal-sec">Site text</div>`
      + `<button type="button" class="kiln-pal-item" role="option" data-i="${items.length - 1}">`
      + `<span class="kiln-pal-name">Search site text for “${deps.escapeHtml(q)}” ↵</span></button>`;
  }
  if (!items.length) html = `<div class="kiln-pal-note">${!pages && deps.state.gh ? 'Loading pages…' : 'Nothing matches.'}</div>`;
  listEl.innerHTML = html;
  sel = 0;
  paintSel();
}

// ─── Site-wide text search ───────────────────────────────────────────────────

function sitePages() {
  if (!deps.state.gh) { pages = pages || []; return Promise.resolve(pages); }   // sandbox: no repo
  if (!pagesPromise) {
    pagesPromise = deps.listSitePages().then((all) => {
      // Editors: only in-scope pages — never fetch (or list) what the UI scope hides.
      pages = deps.mode === 'editor' ? all.filter(p => deps.pageInScope(p)) : all;
      if (isOpen() && viewMode === 'list') render();
      return pages;
    }).catch(() => { pagesPromise = null; pages = pages || []; return pages; });
  }
  return pagesPromise;
}

/** Raw page HTML → { flat: visible text, title } for matching and snippets. */
function flatten(raw) {
  const doc = new DOMParser().parseFromString(raw, 'text/html');
  doc.querySelectorAll('script,style,noscript').forEach(n => n.remove());
  return { flat: (doc.body?.textContent || '').replace(/\s+/g, ' ').trim(), title: (doc.title || '').trim() };
}

/** Up to 3 case-insensitive matches with ~80 chars of context each. */
function findSnippets(flat, q) {
  const hay = flat.toLowerCase(), needle = q.toLowerCase(), out = [];
  let at = 0;
  while (out.length < 3) {
    const i = hay.indexOf(needle, at);
    if (i < 0) break;
    const a = Math.max(0, i - 38), b = Math.min(flat.length, i + needle.length + 38);
    out.push({ pre: (a > 0 ? '…' : '') + flat.slice(a, i), hit: flat.slice(i, i + needle.length),
      post: flat.slice(i + needle.length, b) + (b < flat.length ? '…' : '') });
    at = i + needle.length;
  }
  return out;
}

async function runSearch(q) {
  const token = ++searchToken;
  viewMode = 'search';
  items = [];
  sel = 0;
  listEl.innerHTML = `<div class="kiln-pal-note" id="kiln-pal-prog">Searching…</div>`;
  const st = deps.state;
  if (st.page?.path && st.page.text && !fileCache.has(st.page.path)) fileCache.set(st.page.path, flatten(st.page.text));
  const paths = (await sitePages()).slice(0, 100);
  if (token !== searchToken || !isOpen()) return;
  const hits = [];
  let next = 0, done = 0;
  const work = async () => {
    while (next < paths.length && token === searchToken && isOpen()) {
      const p = paths[next++];
      try {
        if (!fileCache.has(p)) fileCache.set(p, flatten((await deps.fetchFile(p)).text));
        if (token !== searchToken) return;
        const f = fileCache.get(p);
        const snips = findSnippets(f.flat, q);
        if (snips.length) { hits.push({ path: p, title: f.title, snips }); renderHits(q, hits, done, paths.length); }
      } catch { /* unreadable file — skip it */ }
      done++;
      const n = listEl.querySelector('#kiln-pal-prog');
      if (n) n.textContent = `Searching… ${done}/${paths.length}`;
    }
  };
  await Promise.all([work(), work(), work(), work(), work(), work()]);
  if (token === searchToken && isOpen()) renderHits(q, hits, paths.length, paths.length);
}

function renderHits(q, hits, done, total) {
  if (viewMode !== 'search' || !isOpen()) return;
  items = [];
  let html = done < total
    ? `<div class="kiln-pal-note" id="kiln-pal-prog">Searching… ${done}/${total}</div>`
    : (hits.length ? '' : `<div class="kiln-pal-note">No matches for “${deps.escapeHtml(q)}”.</div>`);
  for (const h of hits) {
    html += `<div class="kiln-pal-sec">${deps.escapeHtml(pageUrl(h.path))}${h.title ? ` — ${deps.escapeHtml(h.title)}` : ''}</div>`;
    for (const s of h.snips) {
      items.push({ run: () => gotoMatch(h.path, q) });
      html += `<button type="button" class="kiln-pal-item kiln-pal-snip" role="option" data-i="${items.length - 1}">`
        + `<span class="kiln-pal-name">${deps.escapeHtml(s.pre)}<span class="kiln-pal-hit">${deps.escapeHtml(s.hit)}</span>${deps.escapeHtml(s.post)}</span></button>`;
    }
  }
  listEl.innerHTML = html;
  sel = Math.max(0, Math.min(sel, items.length - 1));
  paintSel();
}

function gotoMatch(path, q) {
  if (path !== deps.state.page?.path) { location.href = encodeURI(pageUrl(path)); return; }
  const ql = q.toLowerCase();
  const el = [...document.querySelectorAll('[data-cms],[data-cms-repeat]')]
    .filter(n => (n.textContent || '').replace(/\s+/g, ' ').toLowerCase().includes(ql))
    .sort((a, b) => a.textContent.length - b.textContent.length)[0];   // most specific container
  if (el) flashTo(el);
  else deps.setStatus('That text is on this page but outside its editable sections', 'idle');
}

function flashTo(el) {
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.remove('kiln-flash');
  void el.offsetWidth;   // restart the animation
  el.classList.add('kiln-flash');
  setTimeout(() => el.classList.remove('kiln-flash'), 1500);
}

/** Repo path → served URL (inverse of pageFileCandidates, honoring cfg.root). */
function pageUrl(p) {
  let u = String(p);
  const root = (deps.cfg.root || '').replace(/^\/+|\/+$/g, '');
  if (root && u.startsWith(root + '/')) u = u.slice(root.length + 1);
  if (u === 'index.html') u = '';
  else if (u.endsWith('/index.html')) u = u.slice(0, -10);   // keep the trailing slash
  return '/' + u;
}
