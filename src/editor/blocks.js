/**
 * kiln-blocks — the block library + section chrome ("+ Add section").
 *
 * Every `_blocks/*.html` file in the site repo is a block: a ready-made,
 * dev/AI-approved section (a single top-level element with data-cms fields
 * inside) that editors can drop between any two top-level sections of a page.
 * Hovering the gap between sections shows a slim "+ Add section" divider;
 * clicking it opens a picker with a live, style-accurate preview of each
 * block. Inserts are sanitized, key-deduped against the page, and staged as
 * pendingStructural ops — published through the exact pipeline the existing
 * "＋ Add a gallery or events" flow uses. Hovering a removable section (one
 * removeKilnSection can locate by its data-cms-repeat key, or one whose
 * insert is still pending) shows a "✕ Remove section" affordance.
 *
 * Editor chrome only — main.js hands its seams in via initBlocks(deps) (no
 * circular import, same pattern as suggest.js/comments.js). The pure helpers
 * up top are exported for node unit tests and must stay DOM-free.
 */

// ─── Pure helpers (node-testable — no DOM access here) ───────────────────────

// data-cms / -repeat / -menu / -list attributes and their key values. The
// leading [\s"'] capture stands in for a lookbehind (older Safari can't parse
// lookbehind — a bad regex LITERAL would break the whole editor at load).
// data-cms-attr / data-cms-plain deliberately don't match: -attr's value is an
// attribute NAME, -plain is a bare flag.
const CMS_KEY_RE = /([\s"'])(data-cms(?:-repeat|-menu|-list)?)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;

/** Distinct data-cms(-repeat/-menu/-list) key values used in an HTML snippet. */
export function collectCmsKeys(html) {
  const keys = new Set();
  for (const m of String(html ?? '').matchAll(CMS_KEY_RE)) {
    const v = (m[4] ?? m[5] ?? m[6] ?? '').trim();
    if (v) keys.add(v);
  }
  return keys;
}

/**
 * Rename any block key that collides with `taken` (the page's keys + keys in
 * already-pending inserts) to `key_2`, `key_3`, … A key repeated INSIDE the
 * block (cards in a repeat share their field names) renames consistently to
 * the same new name. Returns { html, renames: Map<old, new> }.
 */
export function uniquifyCmsKeys(html, taken) {
  const src = String(html ?? '');
  const takenSet = new Set(taken || []);
  const own = collectCmsKeys(src);
  const used = new Set([...takenSet, ...own]);   // renames must dodge both worlds
  const renames = new Map();
  for (const k of own) {
    if (!takenSet.has(k)) continue;
    let n = 2, next = `${k}_${n}`;
    while (used.has(next)) next = `${k}_${++n}`;
    used.add(next);
    renames.set(k, next);
  }
  if (!renames.size) return { html: src, renames };
  const out = src.replace(CMS_KEY_RE, (full, pre, attr, _q, dq, sq, uq) => {
    const v = (dq ?? sq ?? uq ?? '').trim();
    const r = renames.get(v);
    if (!r) return full;
    const quote = dq !== undefined ? '"' : sq !== undefined ? "'" : '"';
    return `${pre}${attr}=${quote}${r}${quote}`;
  });
  return { html: out, renames };
}

/**
 * A block file's optional manifest: FIRST line `<!-- kiln-block: {"title":…,
 * "description":…} -->`. Returns { title, description, html } — title and
 * description null when absent/unparsable, html with the comment stripped.
 */
export function parseBlockManifest(text) {
  const src = String(text ?? '');
  const m = src.match(/^\uFEFF?[ \t]*<!--\s*kiln-block\s*:\s*(\{[\s\S]*?\})\s*-->[ \t]*\r?\n?/);
  let meta = null;
  if (m) { try { meta = JSON.parse(m[1]); } catch { meta = null; } }
  return {
    title: meta && typeof meta.title === 'string' && meta.title.trim() ? meta.title.trim() : null,
    description: meta && typeof meta.description === 'string' ? meta.description.trim() : null,
    html: m ? src.slice(m[0].length) : src,
  };
}

/** "_blocks/feature-cards.html" → "Feature cards" (fallback when no manifest). */
export function blockTitleFromPath(path) {
  const base = String(path ?? '').split('/').pop().replace(/\.html?$/i, '');
  const words = base.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : base;
}

// The starter block "Create this example block" commits — also shown verbatim
// as the copy-pasteable example in the picker's empty state.
export const EXAMPLE_BLOCK = `<!-- kiln-block: {"title":"Feature cards","description":"A heading with three editable cards."} -->
<section style="padding:2.5rem 1.25rem">
  <div style="max-width:1080px;margin:0 auto">
    <h2 data-cms="cards_title">Why choose us</h2>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:1.25rem" data-cms-repeat="cards">
      <div><h3 data-cms="card_title">Fast</h3><p data-cms="card_body">A line about this.</p></div>
      <div><h3 data-cms="card_title">Friendly</h3><p data-cms="card_body">A line about this.</p></div>
      <div><h3 data-cms="card_title">Fair</h3><p data-cms="card_body">A line about this.</p></div>
    </div>
  </div>
</section>
`;

// ─── Chrome (browser-only from here down) ────────────────────────────────────

let deps = null;
let layer = null;         // #kiln-blocks-layer — absolute overlay, joins KILN_CHROME
let host = null;          // <main> (fallback <body>) — same target as appendMain
let gaps = [];            // divider elements, one per boundary (last = end slot)
let lastSecs = [];        // sections as of the last refresh (for hover hit-tests)
let removeBtn = null;     // the floating "✕ Remove section" affordance
let removeTarget = null;  // { sec, info } while removeBtn is showing
let ro = null, observed = [], rafPending = false;
let _blocksPromise = null;                  // session cache: the parsed block list
const insertedNodes = new WeakMap();        // section node → its pending insert op

export function initBlocks(d) {
  if (deps) return;
  deps = d;
  const { mode, state, hasFeature, pageInScope } = deps;
  if (mode === 'editor') {
    if (!hasFeature('blocks')) return;
    if (state.scope?.mode === 'review') return;      // comment-only seats
    if (!pageInScope()) return;                      // read-only page for this editor
  }
  // Deferred: in the sandbox init runs synchronously at module load, before
  // main.js's own module consts (KILN_CHROME etc.) are initialized.
  requestAnimationFrame(buildChrome);
}

function buildChrome() {
  if (layer) return;
  host = document.querySelector('main') || document.body;
  layer = document.createElement('div');
  layer.id = 'kiln-blocks-layer';
  document.body.appendChild(layer);

  removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'kiln-block-remove';
  removeBtn.textContent = '✕ Remove section';
  removeBtn.hidden = true;
  removeBtn.onclick = onRemoveClick;
  layer.appendChild(removeBtn);

  // Reposition when sections change (insert/remove/undo) or resize. The
  // ResizeObserver also catches late reflows (images loading into a section).
  new MutationObserver(scheduleRefresh).observe(host, { childList: true });
  ro = new ResizeObserver(scheduleRefresh);
  window.addEventListener('resize', scheduleRefresh);
  document.addEventListener('mouseover', onHover, true);
  refresh();
}

function scheduleRefresh() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(refresh);
}

/** The page's top-level sections: direct children of <main>, skipping chrome. */
function pageSections() {
  return [...host.children].filter(c =>
    !deps.isKilnChrome(c) && c.getBoundingClientRect().height > 20);
}

function refresh() {
  rafPending = false;
  if (!layer) return;
  const secs = pageSections();
  lastSecs = secs;
  // Watch host + sections for size changes — but only RE-observe when the set
  // actually changed: observe() fires an initial notification, so blindly
  // re-observing here would schedule refresh forever.
  const wanted = [host, ...secs];
  if (wanted.length !== observed.length || wanted.some((el, i) => el !== observed[i])) {
    ro.disconnect();
    observed = wanted;
    observed.forEach(el => ro.observe(el));
  }

  // One divider per boundary AFTER each section; the last doubles as the end
  // slot (appendMain). An empty page still gets the end slot.
  const want = Math.max(secs.length, 1);
  while (gaps.length > want) gaps.pop().remove();
  while (gaps.length < want) {
    const gap = document.createElement('div');
    gap.className = 'kiln-block-gap';
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = '＋ Add section';
    b.onclick = (e) => { e.stopPropagation(); openPicker(gap._anchor || null); };
    gap.appendChild(b);
    layer.appendChild(gap);
    gaps.push(gap);
  }
  const hostRect = host.getBoundingClientRect();
  const left = hostRect.left + scrollX, width = Math.max(hostRect.width, 120);
  const rects = secs.map(s => s.getBoundingClientRect());
  gaps.forEach((gap, i) => {
    // Between two sections the divider sits on the seam; after the last (or on
    // an empty page) it's the end slot.
    const between = i < secs.length - 1;
    const y = !secs.length ? hostRect.top + scrollY + 12
      : between ? (rects[i].bottom + rects[i + 1].top) / 2 + scrollY
      : rects[i].bottom + scrollY + 6;
    gap._anchor = between ? secs[i] : null;   // null = end of page (appendMain)
    gap.style.top = y + 'px';
    gap.style.left = left + 'px';
    gap.style.width = width + 'px';
  });
}

// ─── "✕ Remove section" ──────────────────────────────────────────────────────

/** The data-cms-repeat key removeKilnSection would locate this section by. */
function removableSectionKey(sec) {
  if (/\bkiln-added\b/.test(sec.getAttribute('class') || '')) {
    const k = sec.querySelector('[data-cms-repeat]')?.getAttribute('data-cms-repeat');
    if (k) return k;
  }
  return sec.getAttribute('data-cms-repeat') || null;
}

/** A pending insert op (this session, not yet published) that created `sec`. */
function pendingInsertOp(sec) {
  const { state } = deps;
  const direct = insertedNodes.get(sec);
  if (direct && state.pendingStructural.includes(direct)) return direct;
  // The gallery/events flow doesn't register nodes here — match by repeat key.
  const key = removableSectionKey(sec);
  if (!key) return null;
  return state.pendingStructural.find(o =>
    (o.op === 'insertAfter' || o.op === 'appendMain') && o.key === key) || null;
}

/**
 * How this section can be removed, or null. Never offers a remove that publish
 * can't perform: a published section must carry (or wrap, via .kiln-added) a
 * data-cms-repeat key that resolves in the page SOURCE.
 */
function removableInfo(sec) {
  const { state, cfg, mode, keyInScope } = deps;
  const pendingOp = pendingInsertOp(sec);
  if (pendingOp) return { pendingOp };               // remove = withdraw the insert
  const key = removableSectionKey(sec);
  if (!key) return null;
  if (mode === 'editor' && !keyInScope(key)) return null;
  if (!cfg.sandbox && !state.fields?.fields?.has(key)) return null;
  return { key };
}

function onHover(e) {
  if (!removeBtn || document.getElementById('kiln-modal')) return;
  const t = e.target;
  if (!(t instanceof Element)) return;
  if (t === removeBtn || removeBtn.contains(t)) return;     // keep it clickable
  const sec = !deps.isKilnChrome(t) ? lastSecs.find(s => s === t || s.contains(t)) : null;
  const info = sec ? removableInfo(sec) : null;
  if (!info) {
    if (!t.closest('#kiln-blocks-layer')) hideRemove();
    return;
  }
  const r = sec.getBoundingClientRect();
  removeTarget = { sec, info };
  removeBtn.hidden = false;
  removeBtn.style.top = (r.top + scrollY + 8) + 'px';
  removeBtn.style.left = (r.right + scrollX - 8) + 'px';   // translateX(-100%) in CSS
}

function hideRemove() {
  removeTarget = null;
  if (removeBtn) removeBtn.hidden = true;
}

function onRemoveClick() {
  if (!removeTarget) return;
  const { state, cfg, pushUndoEntry, refreshPublishButton, setStatus } = deps;
  const { sec, info } = removeTarget;
  hideRemove();
  const parent = sec.parentElement, next = sec.nextSibling;
  const place = () => parent.insertBefore(sec, next);
  if (info.pendingOp) {
    // Not published yet — withdraw the staged insert (op and node travel
    // together; `unstaged` tells applyUndoStep both were present "before").
    const i = state.pendingStructural.indexOf(info.pendingOp);
    if (i !== -1) state.pendingStructural.splice(i, 1);
    sec.remove();
    pushUndoEntry({ steps: [{ structural: { node: sec, op: cfg.sandbox ? null : info.pendingOp, html: info.pendingOp.html, unstaged: true, place } }] });
    setStatus('Section removed (it was never published) — ⌘Z restores it', 'saved');
  } else {
    const op = cfg.sandbox ? null : { op: 'removeSection', key: info.key };
    if (op) state.pendingStructural.push(op);
    sec.remove();
    pushUndoEntry({ steps: [{ structural: { node: sec, op, html: null, removed: true, place } }] });
    setStatus(cfg.sandbox ? 'Section removed (demo) — ⌘Z undoes'
      : 'Section removed — Publish to make it real (⌘Z undoes)', 'saved');
  }
  refreshPublishButton();
  scheduleRefresh();
}

// ─── The block picker ────────────────────────────────────────────────────────

/** Fetch + parse `_blocks/*.html` from the repo (git trees; cached per session). */
async function loadBlocks() {
  if (!_blocksPromise) {
    _blocksPromise = (async () => {
      const { cfg, ghRequest, fetchFile, sanitizeBlock } = deps;
      const tree = await ghRequest('GET',
        `/repos/${cfg.repo}/git/trees/${encodeURIComponent(cfg.branch || 'main')}?recursive=1`);
      const paths = (tree.tree || [])
        .filter(t => t.type === 'blob' && /^_blocks\/[^/]+\.html$/.test(t.path))
        .map(t => t.path).sort();
      const blocks = await Promise.all(paths.map(async (path) => {
        const { text } = await fetchFile(path);
        const { title, description, html } = parseBlockManifest(text);
        return {
          path,
          slug: path.split('/').pop().replace(/\.html?$/i, ''),
          title: title || blockTitleFromPath(path),
          description: description || '',
          clean: sanitizeBlock(html),   // scripts/handlers gone before preview OR insert
        };
      }));
      return blocks.filter(b => b.clean && b.clean.trim());
    })();
  }
  try { return await _blocksPromise; }
  catch (err) { _blocksPromise = null; throw err; }   // a failed fetch isn't cached
}

/** The page's own look, for style-accurate previews: head stylesheets + inline styles. */
function pageStyleHead() {
  const { escapeHtml } = deps;
  let out = '';
  document.head.querySelectorAll('link[rel="stylesheet"],style:not([data-kiln])').forEach(el => {
    if (el.tagName === 'LINK') {
      out += `<link rel="stylesheet" href="${escapeHtml(el.href)}"${el.media ? ` media="${escapeHtml(el.media)}"` : ''}>`;
    } else {
      out += `<style>${el.textContent}</style>`;
    }
  });
  return out;
}

async function openPicker(anchor) {
  const { cfg, modal, setStatus, escapeHtml } = deps;
  if (cfg.sandbox) {
    setStatus('The demo has no repo — a real Kiln site lists its approved sections from _blocks/', 'idle');
    return;
  }
  const m = modal(`
    <h3>Add a section</h3>
    <p class="kiln-dim" id="kiln-blk-sub">Ready-made sections from this site's block library
    (<code>_blocks/</code> in the repo) — the one you pick lands where you clicked.</p>
    <div id="kiln-blk-list" class="kiln-inv-list"><p class="kiln-dim">Loading blocks…</p></div>
    <div class="kiln-modal-actions"><button class="kiln-btn-ghost" data-close>Cancel</button></div>`);
  m.querySelector('.kiln-modal-card').classList.add('kiln-blk-card');
  let blocks;
  try { blocks = await loadBlocks(); }
  catch (err) {
    console.error('[kiln] blocks', err);
    const list = m.querySelector('#kiln-blk-list');
    if (list) list.innerHTML = `<p class="kiln-dim">Couldn’t load the block library: ${escapeHtml(err.message)}</p>`;
    return;
  }
  if (!m.isConnected) return;    // closed while loading
  if (!blocks.length) return renderEmptyState(m, anchor);
  renderBlockList(m, blocks, anchor);
}

function renderBlockList(m, blocks, anchor) {
  const { escapeHtml } = deps;
  const list = m.querySelector('#kiln-blk-list');
  list.innerHTML = '';
  const styleHead = pageStyleHead();
  // Previews render lazily as rows scroll into view (an iframe per block is
  // real work — don't pay for the ones below the fold).
  const io = typeof IntersectionObserver !== 'undefined'
    ? new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (en.isIntersecting) { renderPreview(en.target, styleHead); io.unobserve(en.target); }
      }
    }, { rootMargin: '150px' })
    : null;
  for (const b of blocks) {
    const row = document.createElement('div');
    row.className = 'kiln-blk-row';
    row.title = b.path;
    row.innerHTML = `<div class="kiln-blk-prev" aria-hidden="true"></div>
      <div class="kiln-blk-meta"><strong>${escapeHtml(b.title)}</strong>
        ${b.description ? `<small>${escapeHtml(b.description)}</small>` : ''}</div>
      <button type="button" class="kiln-btn-publish kiln-blk-add">Add</button>`;
    row.querySelector('.kiln-blk-add').onclick = () => { m.remove(); insertBlock(b, anchor); };
    list.appendChild(row);
    const prev = row.querySelector('.kiln-blk-prev');
    prev._block = b;
    if (io) io.observe(prev); else renderPreview(prev, styleHead);
  }
}

/** A live thumbnail: the sanitized block inside a fully-sandboxed iframe, wearing the page's stylesheets. */
function renderPreview(prevEl, styleHead) {
  const { escapeHtml } = deps;
  const b = prevEl._block;
  if (!b) return;
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', '');       // no scripts, opaque origin — belt & braces on top of sanitize
  iframe.tabIndex = -1;
  const W = 1100;                           // laid out at desktop width, scaled down to the thumb
  const scale = Math.max(0.06, (prevEl.clientWidth || 230) / W);
  iframe.style.width = W + 'px';
  iframe.style.height = Math.ceil((prevEl.clientHeight || 120) / scale) + 'px';
  iframe.style.transform = `scale(${scale})`;
  // (Clicks can't reach it anyway: the iframe itself is pointer-events:none.)
  iframe.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><base href="${escapeHtml(location.href)}">`
    + styleHead
    + `<style>html,body{margin:0!important;padding:0!important;overflow:hidden}</style>`
    + `</head><body>${b.clean}</body></html>`;
  prevEl.textContent = '';
  prevEl.appendChild(iframe);
}

function insertBlock(block, anchor) {
  const { state, decorateField, setupRepeat, stageSectionInsert, setStatus } = deps;
  // Keys already spoken for: the page source + everything staged but unpublished.
  const taken = new Set(state.fields?.fields ? [...state.fields.fields.keys()] : []);
  for (const op of state.pendingStructural) {
    if (op.key) taken.add(op.key);
    if (op.html) for (const k of collectCmsKeys(op.html)) taken.add(k);
  }
  const { html } = uniquifyCmsKeys(block.clean, taken);
  const wrap = document.createElement('div');
  wrap.innerHTML = html.trim();
  let node = wrap.firstElementChild;
  if (!node) { setStatus('That block is empty after sanitizing', 'error'); return; }
  if (wrap.children.length > 1) {
    // The convention is ONE top-level element; wrap a multi-root block so the
    // insert (and a later remove) treats it as one section.
    node = document.createElement('section');
    while (wrap.firstChild) node.appendChild(wrap.firstChild);
  }
  // Same marker the gallery/events flow writes: removeKilnSection can then
  // remove the whole section by any repeat key inside it.
  node.classList.add('kiln-added');
  const outer = '\n' + node.outerHTML + '\n';   // captured BEFORE editing chrome decorates it
  const key = node.getAttribute('data-cms-repeat')
    || node.querySelector('[data-cms-repeat]')?.getAttribute('data-cms-repeat')
    || node.querySelector('[data-cms]')?.getAttribute('data-cms')
    || block.slug;
  const op = stageSectionInsert({ node, html: outer, key, anchor });
  if (op) insertedNodes.set(node, op);
  // Wire it for editing right away (repeat containers first, then fields).
  if (node.hasAttribute('data-cms-repeat')) setupRepeat(node, node.getAttribute('data-cms-repeat'));
  node.querySelectorAll('[data-cms-repeat]').forEach(c => setupRepeat(c, c.getAttribute('data-cms-repeat')));
  node.querySelectorAll('[data-cms]').forEach(n => decorateField(n, n.getAttribute('data-cms')));
  setStatus(`“${block.title}” added — edit it, then Publish (⌘Z undoes)`, 'saved');
  scheduleRefresh();
}

// ─── Empty state: teach the convention ───────────────────────────────────────

function renderEmptyState(m, anchor) {
  const { mode, escapeHtml, cfg, putRepoFile, setStatus } = deps;
  m.querySelector('#kiln-blk-sub')?.remove();
  m.querySelector('#kiln-blk-list').innerHTML = `
    <p class="kiln-dim">No block library yet. A block is a ready-made, on-brand section anyone
    editing the site can drop between sections — no code involved. Whoever builds the site (a
    developer, or an AI given <code>KILN_PROMPT.md</code>) creates them: each <code>.html</code>
    file in <code>_blocks/</code> at the repo root is one block — a single top-level element
    with <code>data-cms</code> fields, named by an optional first-line manifest comment.
    Blocks are content-only: scripts and event handlers are stripped on insert.</p>
    <pre class="kiln-blk-ex">${escapeHtml(EXAMPLE_BLOCK)}</pre>
    ${mode === 'admin' ? `<div class="kiln-modal-actions" style="justify-content:flex-start;margin-top:8px">
      <button type="button" class="kiln-btn-publish" id="kiln-blk-example">Create this example block</button></div>
    <p class="kiln-np-step" id="kiln-blk-exstatus"></p>` : ''}`;
  const btn = m.querySelector('#kiln-blk-example');
  if (!btn) return;
  btn.onclick = async () => {
    const status = m.querySelector('#kiln-blk-exstatus');
    btn.disabled = true;
    status.textContent = 'Committing the block…';
    try {
      await putRepoFile('_blocks/feature-cards.html', {
        text: EXAMPLE_BLOCK,
        branch: cfg.branch || 'main',
        message: 'Add _blocks/feature-cards.html — starter block (via Kiln)',
      });
      _blocksPromise = null;                 // the library just changed
      m.remove();
      setStatus('Example block committed ✓', 'saved');
      openPicker(anchor);
    } catch (err) {
      console.error('[kiln] example block', err);
      btn.disabled = false;
      status.textContent = `Failed: ${err.message}`;
    }
  };
}
