/**
 * kiln-editor — loaded only for authenticated admins and invited editors.
 *
 * Admin mode:  GitHub App user token, browser → api.github.com directly.
 * Editor mode: invited-editor (Google) session, browser → kiln-auth worker /gh/* proxy
 *              (the worker holds the installation token; no GitHub account needed).
 *
 * The page's HTML file in the repo is the source of truth. Edits are spliced
 * into the raw file at parse5 source offsets and committed; the host rebuilds.
 */

import DOMPurify from 'dompurify';
import { indexHtml, applyEdits, pageFileCandidates, editHead, readHead, readValues, findNthTag, annotateNthTag, appendIntoNthTag, insertAfterNthTag, removeAnnotations, removeKilnSection } from '../engine.js';
import {
  makeGh, getFile, resolvePageFile, editFile, putFile, putBinaryFile, commitFiles, deployState,
} from '../github.js';

const cfg = window.KILN || {};
const mode = window.__KILN_MODE || 'admin';
const ADMIN_KEY = 'kiln_admin';
const EDITOR_KEY = 'kiln_editor';
const PAUSE_KEY = 'kiln_pause';
// Declared here (not beside the sandbox helpers below) so they are initialized
// before init() runs at module load — initSandbox reads them synchronously.
const SANDBOX_KEY = 'kiln_sandbox';
const SANDBOX_TTL = 24 * 3600 * 1000;
// Default menu tools an invited editor gets when the admin hasn't customized them.
// (Declared up here — used by hasFeature() which runs during the init() call below;
// esbuild hoists const→var, so a later declaration would read undefined at boot.)
const EDITOR_DEFAULT_FEATURES = ['pagesettings', 'history', 'draft'];
const UNDO_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M3 7v6h6"/><path d="M3.5 13a9 9 0 1 0 2.6-8.4L3 7"/></svg>';

import { SANITIZE, CONTAINER_SANITIZE } from './sanitize.js';

// Any anchor opening a new tab gets rel="noopener" so the opened page can't
// reach back through window.opener (reverse tabnabbing).
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.getAttribute('target') === '_blank') {
    const rel = (node.getAttribute('rel') || '').split(/\s+/).filter(Boolean);
    if (!rel.includes('noopener')) rel.push('noopener');
    node.setAttribute('rel', rel.join(' '));
  }
});

const state = {
  gh: null,
  user: null,
  page: null,            // { path, text, sha }
  fields: null,          // indexHtml() of page.text
  pending: new Map(),    // key → { html?, attrs?: {name: value} }
  active: null,
  originals: new Map(),
  // Binary uploads (images/docs) queued for the NEXT Publish, so nothing is
  // committed to the repo until you actually publish (Discard leaves no orphans).
  // repoPath → base64
  pendingBinaries: new Map(),
  // Structural changes from "Make things editable" (annotate/unannotate the HTML),
  // applied to the source at Publish time — so they're pending like everything else.
  // [{ op:'annotate', tag, nth, attrs } | { op:'remove', key }]
  pendingStructural: [],
  // What each field/container looked like before any editing this session —
  // seeded at decoration, updated after each publish. The undo stack uses these
  // to put the DOM back when un-staging a change. (NOT state.baseline — that is
  // the publish-conflict snapshot set by loadPageSource.)
  undoBase: new Map(),        // key → clean innerHTML
  undoBaseAttrs: new Map(),   // key → { attrName: value }
};

// ─── Session undo/redo (⌘Z / ⌘⇧Z) ───────────────────────────────────────────
// Every staged change (text commit, block add/move/remove, image swap, restore
// from history) is one entry; undo un-stages it and puts the page back, redo
// re-applies. Typing INSIDE a field still uses the browser's native undo — this
// stack works at the "committed change" level, like Canva's.
const editHistory = { undo: [], redo: [] };
let undoBucket = null;   // when set, stagePending records into this composite entry
let activeOriginalHtml = null;   // the currently-edited element's own pre-edit HTML (for Esc)

/** Group several stagePending calls into ONE undo entry (e.g. a multi-section restore). */
function undoGroup(fn) {
  const mine = !undoBucket;
  if (mine) undoBucket = { steps: [] };
  try { fn(); } finally {
    if (mine) {
      const b = undoBucket; undoBucket = null;
      if (b.steps.length) pushUndoEntry(b);
    }
  }
}

function pushUndoEntry(entry) {
  editHistory.undo.push(entry);
  if (editHistory.undo.length > 100) editHistory.undo.shift();
  editHistory.redo.length = 0;
  updateUndoUi();
}

/** Queue a binary to be committed with the next Publish (not immediately). Returns nothing. */
function stageBinary(repoPath, base64) {
  state.pendingBinaries.set(repoPath, base64);
  refreshPublishButton();
}

init().catch(err => {
  console.error('[kiln]', err);
  if (err.kilnFriendly) {
    // A known, explainable failure (e.g. generated site): show it in-page.
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:50%;top:20px;transform:translateX(-50%);z-index:2147483647;'
      + 'max-width:460px;background:#1c1c28;color:#e7e7ee;font:14px/1.55 -apple-system,sans-serif;'
      + 'padding:18px 20px;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.4)';
    box.innerHTML = `<strong style="color:#fff">Kiln couldn’t open this page</strong><br>`
      + err.kilnFriendly.replace(/</g, '&lt;')
      + `<br><button style="margin-top:12px;background:#6366f1;color:#fff;border:0;border-radius:8px;padding:7px 14px;cursor:pointer;font:inherit">Dismiss</button>`;
    box.querySelector('button').onclick = () => box.remove();
    document.body.appendChild(box);
  } else {
    setStatus('Kiln failed to start — see console', 'error');
  }
});

async function init() {
  if (cfg.sandbox) return initSandbox();
  if (!cfg.repo || !cfg.worker) {
    console.error('[kiln] window.KILN.repo and .worker are required');
    return;
  }
  injectStyles();

  if (mode === 'admin') {
    const stored = JSON.parse(localStorage.getItem(ADMIN_KEY));
    state.gh = withAutoRefresh(makeGh({ mode: 'direct', token: () => JSON.parse(localStorage.getItem(ADMIN_KEY)).token }), stored);
    try {
      const user = await state.gh.request('GET', '/user');
      state.user = user.login;
    } catch (err) {
      console.warn('[kiln] token rejected, back to login', err);
      localStorage.removeItem(ADMIN_KEY);
      location.reload();
      return;
    }
  } else {
    const sess = JSON.parse(localStorage.getItem(EDITOR_KEY));
    if (!sess || sess.repo !== cfg.repo) {
      localStorage.removeItem(EDITOR_KEY);
      location.reload();
      return;
    }
    state.gh = makeGh({ mode: 'proxy', worker: cfg.worker, session: sess.session });
    state.user = sess.name;
  }

  await loadPageSource();
  // Editors: learn our path/section scope BEFORE decorating, so out-of-scope
  // content never grows an edit handle (best-effort — offline means no scope data).
  if (mode === 'editor' && !cfg.sandbox) await presencePing();
  renderAdminBar();
  decorateFields();
  offerPendingRestore();
  if (journalAll().length) runJournal();
  checkForDraft();
  startPresence();

  window.addEventListener('beforeunload', (e) => {
    if (state.pending.size || state.pendingBinaries.size || state.pendingStructural.length) { e.preventDefault(); e.returnValue = ''; }
  });
}

/** Admin tokens expire after 8h; refresh through the worker-held refresh token. */
function withAutoRefresh(gh, stored) {
  return {
    async request(method, path, body) {
      try {
        return await gh.request(method, path, body);
      } catch (err) {
        if (err.status !== 401 || !stored?.sid) throw err;
        const res = await fetch(`${cfg.worker}/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sid: stored.sid }),
        });
        const data = await res.json();
        if (!data.token) {
          localStorage.removeItem(ADMIN_KEY);
          location.reload();
          throw err;
        }
        localStorage.setItem(ADMIN_KEY, JSON.stringify({ ...stored, token: data.token, exp: data.exp }));
        return gh.request(method, path, body);
      }
    },
  };
}

// ─── Page source ─────────────────────────────────────────────────────────────

async function loadPageSource() {
  const candidates = pageFileCandidates(location.pathname, cfg.root || '');
  try {
    state.page = await resolvePageFile(state.gh, cfg.repo, candidates, cfg.branch || 'main');
  } catch (err) {
    if (err.status === 404) {
      // The URL doesn't map to an HTML file in the repo — almost always a site
      // built by a generator (Hugo/Jekyll/11ty/Next export) where the served
      // page has no matching source file. Explain it instead of a dead console error.
      err.kilnFriendly = `Kiln edits the HTML file for this page in your repo, but couldn't find one`
        + ` (looked for: ${candidates.join(', ')}). This usually means the site is produced by a`
        + ` build tool, so the page you see isn't committed as-is. Kiln works on sites whose pages`
        + ` are committed as HTML. See the docs.`;
    }
    throw err;
  }
  state.fields = indexHtml(state.page.text);
  // Snapshot every field's source value: publish uses this to detect when
  // ANOTHER editor changed the same field while we were editing (see publish()).
  state.baseline = readValues(state.page.text);
  for (const w of state.fields.warnings) console.warn('[kiln]', w);
}

/** Auth headers for worker endpoints, whichever way this session signed in. */
function workerAuthHeaders() {
  if (mode === 'admin') {
    const a = JSON.parse(localStorage.getItem(ADMIN_KEY) || 'null');
    return a ? { Authorization: `Bearer ${a.token}` } : {};
  }
  const e = JSON.parse(localStorage.getItem(EDITOR_KEY) || 'null');
  return e ? { 'X-Kiln-Session': e.session } : {};
}

// ─── Presence: who else is editing this page ─────────────────────────────────
// Advisory awareness, not locking — Kiln merges different-field edits cleanly
// at publish time, and same-field overwrites are gated by a confirm in publish().

let presenceTimer = null;
async function presencePing() {
  try {
    const res = await fetch(`${cfg.worker}/presence`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...workerAuthHeaders() },
      body: JSON.stringify({ repo: cfg.repo, path: location.pathname, name: state.user }),
    });
    if (!res.ok) return;
    const data = await res.json();
    if (data.scope) state.scope = data.scope;   // editor path/section grants (see decorateFields)
    // One row per person (an older worker sent one row per page they'd visited).
    const seen = new Map();
    for (const o of data.online || []) if (!seen.has(o.name)) seen.set(o.name, o);
    state.online = [...seen.values()];
    updatePresenceUI(data.others || []);
    updateOnlineChip();
  } catch { /* offline blip — presence is best-effort */ }
}

/** A small "who's online" pill in the Kiln menu header — everyone editing the site now. */
function updateOnlineChip() {
  const host = document.querySelector('#kiln-fab-menu .kiln-fab-head') || document.getElementById('kiln-topbar');
  if (!host) return;
  let chip = document.getElementById('kiln-online');
  const others = state.online || [];
  if (!others.length) { chip?.remove(); return; }
  if (!chip) {
    chip = document.createElement('button');
    chip.id = 'kiln-online';
    chip.type = 'button';
    host.appendChild(chip);
    chip.onclick = (e) => { e.stopPropagation(); whoIsOnlinePanel(); };
  }
  chip.innerHTML = `<span class="kiln-online-dot"></span>${others.length} online`;
  chip.title = 'See who else is editing the site';
}

function whoIsOnlinePanel() {
  const rows = (state.online || []).map(o => {
    const where = o.page && o.page !== location.pathname ? `<small>editing ${escapeHtml(o.page)}</small>` : '<small>on this page</small>';
    return `<div class="kiln-inv-row"><span><strong>${escapeHtml(o.name)}</strong> ${where}</span>
      <small class="kiln-dim">${escapeHtml(o.role || 'editor')}</small></div>`;
  }).join('');
  modal(`<h3>Editing right now</h3>
    <p class="kiln-dim">People signed into Kiln on this site in the last minute or so.</p>
    <div class="kiln-inv-list">${rows || '<p class="kiln-dim">Just you.</p>'}</div>
    <div class="kiln-modal-actions"><button class="kiln-btn-ghost" data-close>Close</button></div>`);
}

// ─── Editing scope (invited editors) ─────────────────────────────────────────
// Admins set per-person paths (enforced by the worker on every write) and
// optional section prefixes (data-cms key prefixes; guides the UI so editors
// only see handles on what they're meant to touch).

function pageInScope() {
  const ps = state.scope?.paths;
  if (!ps || !ps.length || ps.some(p => p === '' || p === '*' || p === '**')) return true;
  const f = String(state.page.path).replace(/^\/+/, '');
  return ps.some(p => {
    const pre = String(p).replace(/^\/+/, '').replace(/\/+$/, '');
    return !pre || f === pre || f.startsWith(pre + '/');
  });
}

function keyInScope(key) {
  const ks = state.scope?.keys;
  if (!ks || !ks.length) return true;
  return ks.some(p => key === p || key.startsWith(p));
}

/** Whether the current editor may use a given menu feature. Admins get everything. */
function hasFeature(feature) {
  if (mode === 'admin' || cfg.sandbox) return true;   // sandbox demo showcases everything
  const granted = state.scope?.features;
  const list = Array.isArray(granted) ? granted : EDITOR_DEFAULT_FEATURES;
  return list.includes(feature);
}

/** Hide menu items an invited editor hasn't been granted (applied after the bar renders). */
function applyFeatureGating() {
  if (mode === 'admin' || cfg.sandbox) return;
  const map = { 'kiln-menu': 'menu', 'kiln-findreplace': 'findreplace', 'kiln-newpost': 'newpost',
    'kiln-pagesettings': 'pagesettings', 'kiln-history': 'history', 'kiln-makeblock': 'makeeditable', 'kiln-addsection': 'makeeditable' };
  for (const [id, feat] of Object.entries(map)) {
    const el = document.getElementById(id);
    if (el && !hasFeature(feat)) el.style.display = 'none';
  }
  // Draft/Schedule live in the pending-edits group; gate them too.
  if (!hasFeature('draft')) { const d = document.getElementById('kiln-draft'); if (d) d.dataset.gated = '1'; }
  if (!hasFeature('schedule')) { const s = document.getElementById('kiln-schedule'); if (s) s.dataset.gated = '1'; }
}

function renderScopeNote() {
  if (document.getElementById('kiln-scope-note')) return;
  const paths = (state.scope?.paths || []).filter(p => p && p !== '**' && p !== '*');
  const note = document.createElement('div');
  note.id = 'kiln-scope-note';
  note.innerHTML = `<span class="kiln-presence-dot"></span>Read-only here — your editing access covers: <strong>${paths.map(escapeHtml).join(', ') || 'other pages'}</strong>`;
  document.body.appendChild(note);
}

function startPresence() {
  if (cfg.sandbox || presenceTimer) return;
  presencePing();
  presenceTimer = setInterval(presencePing, 30000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') presencePing();
  });
}

function updatePresenceUI(others) {
  state.othersEditing = others;
  let chip = document.getElementById('kiln-presence');
  if (!others.length) { chip?.remove(); return; }
  const label = others.length === 1
    ? `${others[0].name} is also editing this page`
    : `${others.map(o => o.name).join(', ')} are also editing this page`;
  if (!chip) {
    chip = document.createElement('div');
    chip.id = 'kiln-presence';
    document.body.appendChild(chip);
  }
  chip.innerHTML = `<span class="kiln-presence-dot"></span>${escapeHtml(label)} — your edits merge unless you change the same text`;
}

// ─── Field decoration + inline editing ───────────────────────────────────────

function decorateFields() {
  // Out-of-scope page for this editor: leave everything read-only, say why.
  if (mode === 'editor' && !pageInScope()) { renderScopeNote(); return; }

  document.querySelectorAll('[data-cms]').forEach((el) => {
    const key = el.getAttribute('data-cms');
    const source = state.fields.fields.get(key);
    const inRepeat = !!el.closest('[data-cms-repeat]');
    if (!source && !inRepeat) {
      console.warn(`[kiln] "${key}" is on the page but not in ${state.page.path}`);
      return;
    }
    if (source && (source.kind === 'list' || source.kind === 'menu')) return; // structural, never inline-editable
    // Fields inside a repeat publish through their container, so the CONTAINER's
    // scope governs them. Never set a per-field title inside a repeat — it would
    // be committed into the container HTML on the next reorder/edit.
    if (inRepeat) {
      if (keyInScope(el.closest('[data-cms-repeat]').getAttribute('data-cms-repeat'))) decorateField(el, key);
      return;
    }
    if (!keyInScope(key)) { el.title = 'Not in your editing scope'; return; }
    decorateField(el, key);
  });

  document.querySelectorAll('[data-cms-repeat]').forEach((container) => {
    const key = container.getAttribute('data-cms-repeat');
    if (!state.fields.fields.has(key)) {
      console.warn(`[kiln] repeat "${key}" not found in ${state.page.path}`);
      return;
    }
    if (!keyInScope(key)) { container.title = 'Not in your editing scope'; return; }
    setupRepeat(container, key);
  });

  // Clicking away SAVES your edit (staged for Publish). Esc reverts it.
  document.addEventListener('click', (e) => {
    if (state.active && !state.active.contains(e.target) && !e.target.closest('#kiln-toolbar')) {
      commitEdit(state.active, state.active.getAttribute('data-cms'));
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.active) cancelEditing();
  });

  // Clicking an image INSIDE a field being edited opens size/remove controls
  // for that one image (the style survives commit — the sanitizer allows it).
  document.addEventListener('click', (e) => {
    if (state.active && e.target.tagName === 'IMG' && state.active.contains(e.target)) {
      e.preventDefault();
      inlineImgPopover(e.target);
    }
  });
}

/** Mini popover for an image inside a rich-text field: width presets + remove. */
function inlineImgPopover(img) {
  document.getElementById('kiln-imgpop')?.remove();
  const pop = document.createElement('div');
  pop.id = 'kiln-imgpop';
  pop.innerHTML = `<span class="kiln-tb-label">image</span>
    ${['25%', '50%', '75%', '100%'].map(s => `<button class="kiln-tb-fmt" data-w="${s}">${s}</button>`).join('')}
    <button class="kiln-tb-fmt" data-w="orig" title="Original size">Auto</button>
    <button class="kiln-tb-fmt" data-x="1" title="Remove this image">✕</button>`;
  document.body.appendChild(pop);
  const r = img.getBoundingClientRect();
  const above = r.top - pop.offsetHeight - 8;
  pop.style.top = `${(above >= 8 ? above : r.bottom + 8) + window.scrollY}px`;
  pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)) + window.scrollX}px`;
  pop.querySelectorAll('button').forEach(b => {
    b.addEventListener('mousedown', (e) => e.preventDefault()); // keep the field's selection
    b.onclick = (e) => {
      e.stopPropagation(); e.preventDefault();
      if (b.dataset.x) { img.remove(); handle.remove(); pop.remove(); return; }
      if (b.dataset.w === 'orig') { img.style.removeProperty('width'); img.style.removeProperty('height'); }
      else { img.style.width = b.dataset.w; img.style.height = 'auto'; }
      window.dispatchEvent(new Event('resize')); // nudge the handle back into place
    };
  });
  // Inline images get the same corner drag handle as swappable ones (stage=false:
  // the surrounding field's commit persists the change).
  const handle = enableImageDragResize(img, null, false);
  const away = (e) => {
    if (!pop.contains(e.target) && e.target !== img && e.target !== handle) {
      pop.remove(); handle.remove(); document.removeEventListener('click', away, true);
    }
  };
  setTimeout(() => document.addEventListener('click', away, true), 0);
}

function decorateField(el, key) {
  el.classList.add('kiln-field');
  el.title = `Edit: ${key}`;
  // Seed the undo baseline with the pre-edit state (first decoration wins;
  // keys inside repeats stage via their container, so their entry is unused).
  if (!el.closest('[data-cms-repeat]') && !state.undoBase.has(key)) state.undoBase.set(key, el.innerHTML);
  const attrName = el.getAttribute('data-cms-attr');
  if (attrName && !state.undoBaseAttrs.has(key)) {
    state.undoBaseAttrs.set(key, { [attrName]: el.getAttribute(attrName) || '' });
  }
  el.addEventListener('click', (e) => {
    // Cmd/Ctrl+click on a link follows it even in edit mode.
    if ((e.metaKey || e.ctrlKey) && e.target.closest('a')) return;
    if (el.getAttribute('data-cms-attr') === 'src' && el.tagName === 'IMG') {
      e.preventDefault(); e.stopPropagation();
      imageToolbar(el, key);
      return;
    }
    e.preventDefault(); e.stopPropagation();
    if (state.active !== el) startEditing(el, key);
  });
}

// ─── Repeatable blocks ───────────────────────────────────────────────────────

function setupRepeat(container, key) {
  container.classList.add('kiln-repeat');
  // Re-runnable: drop this list's add/options buttons from a previous setup.
  // They're matched by key, NOT by scope — for tables the add button is parked
  // AFTER the table, so a scope-only cleanup let them pile up on every undo.
  document.querySelectorAll(`.kiln-repeat-add[data-kiln-add="${CSS.escape(key)}"]`).forEach(n => n.remove());
  container.querySelectorAll(':scope > .kiln-repeat-add').forEach(n => n.remove());
  if (!state.undoBase.has(key)) state.undoBase.set(key, containerCleanHtml(container).innerHTML);
  [...container.children].forEach((item) => attachItemControls(container, key, item));
  renderTagPreview(container);   // show filter pills if any block is already tagged

  // A visible "+ Add" so adding a card/document doesn't depend on discovering
  // the hover controls. It clones the last block, ready to edit.
  const add = document.createElement('button');
  add.className = 'kiln-repeat-add';
  add.dataset.kilnAdd = key;
  add.textContent = '+ Add block';
  add.onclick = (e) => {
    e.stopPropagation();
    const last = [...container.children].filter(c => !c.classList.contains('kiln-repeat-add')).pop();
    if (!last) return;
    const clone = last.cloneNode(true);
    clone.querySelectorAll('.kiln-item-ctl, .kiln-ctl-cell, #kiln-toolbar').forEach(n => n.remove());
    clone.classList.remove('kiln-repeat-item');
    clone.querySelectorAll('[data-cms]').forEach(n => {
      n.classList.remove('kiln-field', 'kiln-editing', 'kiln-modified');
      n.removeAttribute('contenteditable');
    });
    if (add.parentElement === container) container.insertBefore(clone, add);
    else container.appendChild(clone);
    clone.querySelectorAll('[data-cms]').forEach(n => decorateField(n, n.getAttribute('data-cms')));
    attachItemControls(container, key, clone);
    stageContainer(container, key);
    clone.scrollIntoView({ behavior: 'smooth', block: 'center' });
    clone.classList.add('kiln-flash');
    setTimeout(() => clone.classList.remove('kiln-flash'), 1600);
    setStatus('Block added — click its text to edit, then Publish', 'saved');
  };
  // Galleries and event lists are specialized repeats: adding gets a native
  // flow (multi-photo picker / structured event form) instead of clone-the-last.
  if (container.hasAttribute('data-kiln-gallery')) {
    // The visitor runtime (features.js) applies the thumbnail grid, but it
    // stands down during editing sessions — so the editor applies it itself,
    // or editors would see every photo full-size.
    container.classList.add('kiln-gallery-grid');
    applyGalleryThumb(container);
    add.textContent = '+ Add photos';
    add.onclick = (e) => { e.stopPropagation(); addGalleryPhotos(container, key, add); };
    const opts = document.createElement('button');
    opts.type = 'button';
    opts.className = 'kiln-repeat-add kiln-gallery-opts';
    opts.dataset.kilnAdd = key;
    opts.textContent = '⚙ Gallery options';
    opts.onclick = (e) => { e.stopPropagation(); galleryOptionsPanel(container, key); };
    container.appendChild(opts);
  } else if (container.hasAttribute('data-kiln-events')) {
    add.textContent = '+ Add event';
    add.onclick = (e) => { e.stopPropagation(); eventForm(container, key, null); };
  }

  // A <button> is not valid table content — for table-section repeats (e.g.
  // <tbody data-cms-repeat>) park the add button after the table itself so the
  // browser doesn't foster-parent it out of position.
  if (['TBODY', 'THEAD', 'TFOOT', 'TABLE', 'TR'].includes(container.tagName)) {
    const table = container.closest('table') || container;
    table.after(add);
  } else {
    container.appendChild(add);
  }
}

function attachItemControls(container, key, item) {
  if (item.querySelector(':scope > .kiln-item-ctl, :scope > .kiln-ctl-cell')) return;
  item.classList.add('kiln-repeat-item');
  const ctl = document.createElement('div');
  ctl.className = 'kiln-item-ctl';
  const isEvents = container.hasAttribute('data-kiln-events');
  ctl.innerHTML = `<button title="Move up">↑</button><button title="Move down">↓</button>`
    + `<button title="Duplicate this block">＋</button>`
    + (isEvents ? '<button title="Edit event details (date, time, location…)">📅</button>' : '')
    + `<button title="Tags — visitors get filter buttons for tagged lists">🏷</button>`
    + `<button title="Remove this block">✕</button>`;
  const btns = ctl.querySelectorAll('button');
  const [up, down, dup] = btns;
  const evBtn = isEvents ? btns[3] : null;
  const tagBtn = btns[isEvents ? 4 : 3];
  const del = btns[btns.length - 1];
  if (evBtn) evBtn.onclick = (e) => { e.stopPropagation(); eventForm(container, key, item); };
  tagBtn.onclick = (e) => { e.stopPropagation(); editItemTags(container, key, item); };
  const realSiblings = () => [...container.children].filter(c => !c.classList.contains('kiln-repeat-add'));
  up.onclick = (e) => {
    e.stopPropagation();
    const prev = item.previousElementSibling;
    if (prev && !prev.classList.contains('kiln-repeat-add')) {
      container.insertBefore(item, prev);
      stageContainer(container, key);
    }
  };
  down.onclick = (e) => {
    e.stopPropagation();
    const sibs = realSiblings();
    const next = item.nextElementSibling;
    if (next && sibs.includes(next)) {
      container.insertBefore(next, item);
      stageContainer(container, key);
    }
  };
  dup.onclick = (e) => {
    e.stopPropagation();
    const clone = item.cloneNode(true);
    clone.querySelectorAll('.kiln-item-ctl, .kiln-ctl-cell, #kiln-toolbar').forEach(n => n.remove());
    clone.classList.remove('kiln-repeat-item');
    clone.querySelectorAll('[data-cms]').forEach(n => {
      n.classList.remove('kiln-field', 'kiln-editing', 'kiln-modified');
      n.removeAttribute('contenteditable');
    });
    item.after(clone);
    clone.querySelectorAll('[data-cms]').forEach(n => decorateField(n, n.getAttribute('data-cms')));
    attachItemControls(container, key, clone);
    stageContainer(container, key);
  };
  del.onclick = (e) => {
    e.stopPropagation();
    if (realSiblings().length <= 1) { setStatus('Keep at least one block (edit it instead)', 'error'); return; }
    if (!confirm('Remove this block? (You can still Cancel by leaving without publishing.)')) return;
    item.remove();
    stageContainer(container, key);
  };
  // A <div> is not valid inside <tr> — anchor the controls in the row's last
  // cell instead so table rows get working move/duplicate/remove buttons too.
  if (item.tagName === 'TR') {
    // Never put controls inside a cell — the last cell is usually an editable
    // field, so the buttons would cover the text being typed and their glyphs
    // (↑↓＋🏷✕) would be swept into the committed value. A dedicated cell keeps
    // them out of every field; containerCleanHtml strips it before staging.
    const cell = document.createElement('td');
    cell.className = 'kiln-ctl-cell';
    cell.appendChild(ctl);
    item.appendChild(cell);
  } else {
    item.appendChild(ctl);
  }

  // Drag to reorder (↑↓ still work; this is for mouse users)
  item.draggable = true;
  item.addEventListener('dragstart', (e) => {
    if (state.active) { e.preventDefault(); return; }
    e.dataTransfer.effectAllowed = 'move';
    item.classList.add('kiln-dragging');
  });
  item.addEventListener('dragend', () => item.classList.remove('kiln-dragging'));
  item.addEventListener('dragover', (e) => {
    e.preventDefault();
    const dragging = container.querySelector('.kiln-dragging');
    if (!dragging || dragging === item) return;
    const r = item.getBoundingClientRect();
    const before = (e.clientY - r.top) < r.height / 2;
    container.insertBefore(dragging, before ? item : item.nextSibling);
  });
  item.addEventListener('drop', (e) => {
    e.preventDefault();
    stageContainer(container, key);
  });
}

/** Comma-tags on a repeat block → visitors get automatic filter pills. */
function editItemTags(container, key, item) {
  const cur = item.getAttribute('data-kiln-tags') || '';
  const m = modal(`
    <h3>Tags for this block</h3>
    <p class="kiln-dim">Comma-separated, e.g. <code>new, used, upcoming</code>. As soon as any block
    in this list has tags, visitors see filter buttons above the list — “All” plus one per tag.</p>
    <label>Tags <input type="text" id="kiln-tags-in" value="${escapeHtml(cur)}" placeholder="new, used, upcoming"></label>
    <div class="kiln-modal-actions">
      <button class="kiln-btn-ghost" data-close>Cancel</button>
      <button class="kiln-btn-publish" id="kiln-tags-go">Save tags</button>
    </div>`);
  m.querySelector('#kiln-tags-go').onclick = () => {
    const v = m.querySelector('#kiln-tags-in').value.split(',').map(s => s.trim()).filter(Boolean).join(', ');
    if (v) item.setAttribute('data-kiln-tags', v);
    else item.removeAttribute('data-kiln-tags');
    stageContainer(container, key);
    renderTagPreview(container);   // pills appear/update immediately
    m.remove();
    setStatus(v ? `Tagged “${v}” — filter buttons preview above the list. Publish to make them live for visitors.` : 'Tags removed — Publish to make it live', 'saved');
  };
}

/**
 * Live preview of the visitor-side filter pills while editing. Real visitors get
 * these from kiln-features.js after publish; the editor (and every always-editing
 * demo visitor) needs to SEE them appear the moment a block is tagged, so we
 * render an editor-owned bar here. It sits OUTSIDE the repeat container, so
 * stageContainer never captures it, and it's rebuilt on every tag change.
 */
function renderTagPreview(container) {
  const anchor = container.closest('table') || container;
  const parent = anchor.parentElement;
  if (!parent) return;
  const existing = parent.querySelector(':scope > .kiln-filterbar-preview');
  const items = [...container.children].filter(c => !c.classList.contains('kiln-repeat-add'));
  const tags = [];
  for (const it of items) for (const t of (it.getAttribute('data-kiln-tags') || '').split(',').map(s => s.trim()).filter(Boolean)) {
    if (!tags.includes(t)) tags.push(t);
  }
  if (!tags.length) { existing?.remove(); return; }
  const bar = existing || document.createElement('div');
  bar.className = 'kiln-filterbar-preview';
  bar.innerHTML = `<span class="kiln-fp-label">Filter preview</span>`;
  const mk = (label, tag) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'kiln-fp-pill'; b.textContent = label;
    if (tag === null) b.classList.add('kiln-fp-on');
    b.onclick = (e) => {
      e.stopPropagation();
      bar.querySelectorAll('.kiln-fp-pill').forEach(p => p.classList.remove('kiln-fp-on'));
      b.classList.add('kiln-fp-on');
      for (const it of items) {
        const mine = (it.getAttribute('data-kiln-tags') || '').split(',').map(s => s.trim());
        it.style.display = (!tag || mine.includes(tag)) ? '' : 'none';
      }
    };
    return b;
  };
  bar.appendChild(mk('All', null));
  tags.forEach(t => bar.appendChild(mk(t, t)));
  if (!existing) parent.insertBefore(bar, anchor);
}

/** Gallery repeats get a native multi-photo picker instead of clone-the-last-block. */
/** Gallery thumbnail size lives on the container as data-kiln-thumb (px). */
function applyGalleryThumb(container) {
  const t = parseInt(container.getAttribute('data-kiln-thumb'), 10);
  if (t) container.style.setProperty('--kiln-thumb', t + 'px');
  else container.style.removeProperty('--kiln-thumb');
}

function galleryOptionsPanel(container, key) {
  const cur = parseInt(container.getAttribute('data-kiln-thumb'), 10) || 180;
  const SIZES = [
    { v: 120, label: 'Small', hint: 'more photos per row' },
    { v: 180, label: 'Medium', hint: 'the default' },
    { v: 260, label: 'Large', hint: 'fewer, bigger thumbnails' },
  ];
  const m = modal(`
    <h3>Gallery options</h3>
    <p class="kiln-dim">Photos always show as a grid of thumbnails — visitors click one to open it
    full-screen with next/previous arrows.</p>
    <div class="kiln-roles">
      ${SIZES.map(s => `<label class="kiln-role"><input type="radio" name="kiln-gal-thumb" value="${s.v}" ${s.v === cur ? 'checked' : ''}>
        <span><strong>${s.label} thumbnails</strong><br><small>${s.hint}</small></span></label>`).join('')}
    </div>
    <div class="kiln-modal-actions">
      <button class="kiln-btn-ghost" data-close>Cancel</button>
      <button class="kiln-btn-publish" id="kiln-gal-go">Apply</button>
    </div>`);
  m.querySelector('#kiln-gal-go').onclick = () => {
    // A hand-set data-kiln-thumb (e.g. 200) matches no preset, so nothing is
    // checked — fall back to the current value instead of dereferencing null.
    const checked = m.querySelector('input[name="kiln-gal-thumb"]:checked');
    const v = checked ? checked.value : String(cur);
    container.setAttribute('data-kiln-thumb', v);
    applyGalleryThumb(container);
    if (!cfg.sandbox) stagePending(key, { attrs: { 'data-kiln-thumb': v } });
    m.remove();
    setStatus(cfg.sandbox ? 'Thumbnail size changed' : 'Thumbnail size changed — Publish to make it live', 'saved');
  };
}

function addGalleryPhotos(container, key, add) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.multiple = true;
  input.onchange = async () => {
    const files = [...input.files];
    if (!files.length) return;
    try {
      for (let i = 0; i < files.length; i++) {
        setStatus(`Uploading photo ${i + 1}/${files.length}…`, 'saving');
        const scaled = await downscale(files[i]);
        const fig = document.createElement('figure');
        const img = document.createElement('img');
        img.alt = '';
        img.loading = 'lazy';
        if (cfg.sandbox) {
          img.src = `data:image/${scaled.ext};base64,${scaled.base64}`;
        } else {
          const slug = files[i].name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'photo';
          const name = `${slug}-${Date.now().toString(36)}-${i}.${scaled.ext}`;
          const repoPath = (cfg.root ? cfg.root.replace(/\/+$/, '') + '/' : '') + `assets/uploads/${name}`;
          stageBinary(repoPath, scaled.base64);   // committed with Publish, not now
          img.src = URL.createObjectURL(scaled.blob);
          img.setAttribute('data-kiln-src', `/assets/uploads/${name}`);
        }
        const cap = document.createElement('figcaption');
        cap.setAttribute('data-cms', 'gallery_caption');
        fig.appendChild(img);
        fig.appendChild(cap);
        if (add.parentElement === container) container.insertBefore(fig, add);
        else container.appendChild(fig);
        decorateField(cap, 'gallery_caption');
        attachItemControls(container, key, fig);
      }
      stageContainer(container, key);
      setStatus(`${files.length} photo${files.length > 1 ? 's' : ''} added — Publish to put them live`, 'saved');
    } catch (err) {
      console.error('[kiln] gallery upload', err);
      setStatus('Photo upload failed', 'error');
    }
  };
  input.click();
}

/** Structured add/edit for events — writes the canonical event block markup. */
function eventForm(container, key, item) {
  const cur = { title: '', date: '', start: '', end: '', loc: '', link: '', desc: '' };
  if (item) {
    const times = item.querySelectorAll('time[datetime]');
    const dt = times[0]?.getAttribute('datetime') || '';
    cur.date = dt.slice(0, 10);
    cur.start = dt.slice(11, 16);
    cur.end = (times[1]?.getAttribute('datetime') || '').slice(11, 16);
    cur.title = item.querySelector('.kiln-ev-title, h1, h2, h3, h4')?.textContent.trim() || '';
    cur.loc = item.querySelector('.kiln-ev-loc')?.textContent.trim() || '';
    cur.link = item.querySelector('a.kiln-ev-link')?.getAttribute('href') || '';
    cur.desc = item.querySelector('.kiln-ev-desc')?.textContent.trim() || '';
  }
  const m = modal(`
    <h3>${item ? 'Edit event' : 'New event'}</h3>
    <label>Title <input type="text" id="kiln-ev-title" value="${escapeHtml(cur.title)}" placeholder="What's happening?"></label>
    <div class="kiln-2col">
      <label>Date <input type="date" id="kiln-ev-date" value="${cur.date}"></label>
      <label>Start time <input type="time" id="kiln-ev-start" value="${cur.start}"></label>
    </div>
    <div class="kiln-2col">
      <label>End time (optional) <input type="time" id="kiln-ev-end" value="${cur.end}"></label>
      <label>Location <input type="text" id="kiln-ev-loc" value="${escapeHtml(cur.loc)}" placeholder="Where?"></label>
    </div>
    <label>Link (tickets, Zoom, details — optional) <input type="text" id="kiln-ev-link" value="${escapeHtml(cur.link)}" placeholder="https://…"></label>
    <label>Details (optional) <input type="text" id="kiln-ev-desc" value="${escapeHtml(cur.desc)}"></label>
    <div class="kiln-modal-actions">
      <button class="kiln-btn-ghost" data-close>Cancel</button>
      <button class="kiln-btn-publish" id="kiln-ev-go">${item ? 'Save event' : 'Add event'}</button>
    </div>`);
  m.querySelector('#kiln-ev-go').onclick = () => {
    const v = (id) => m.querySelector('#kiln-ev-' + id).value.trim();
    const title = v('title'), date = v('date'), start = v('start');
    if (!title || !date) { m.querySelector('#kiln-ev-title').focus(); return; }
    const startIso = `${date}T${start || '00:00'}`;
    const endIso = v('end') ? `${date}T${v('end')}` : '';
    const dateLabel = new Date(startIso).toLocaleDateString(undefined,
      { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    const timeLabel = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const when = `<time datetime="${startIso}">${escapeHtml(dateLabel)}${start ? ' · ' + escapeHtml(timeLabel(startIso)) : ''}</time>`
      + (endIso ? ` – <time datetime="${endIso}">${escapeHtml(timeLabel(endIso))}</time>` : '');
    const html = `
      <h3 class="kiln-ev-title" data-cms="ev_title">${escapeHtml(title)}</h3>
      <p class="kiln-ev-when">${when}</p>
      ${v('loc') ? `<p class="kiln-ev-loc" data-cms="ev_loc">${escapeHtml(v('loc'))}</p>` : ''}
      ${v('desc') ? `<p class="kiln-ev-desc" data-cms="ev_desc">${escapeHtml(v('desc'))}</p>` : ''}
      ${v('link') ? `<p><a class="kiln-ev-link" href="${escapeHtml(safeUrl(v('link')))}">More info →</a></p>` : ''}`;
    let target = item;
    if (!target) {
      target = document.createElement('article');
      target.className = 'kiln-event';
      // Insert in date order among existing events (list view shows DOM order).
      const startDate = new Date(startIso);
      const siblings = [...container.children].filter(c => !c.classList.contains('kiln-repeat-add'));
      const after = siblings.find(s => {
        const t = s.querySelector('time[datetime]');
        return t && new Date(t.getAttribute('datetime')) > startDate;
      });
      if (after) container.insertBefore(target, after);
      else {
        const add = [...container.children].find(c => c.classList?.contains('kiln-repeat-add'));
        if (add) container.insertBefore(target, add); else container.appendChild(target);
      }
    }
    target.innerHTML = html;
    target.querySelectorAll('[data-cms]').forEach(n => decorateField(n, n.getAttribute('data-cms')));
    attachItemControls(container, key, target);
    stageContainer(container, key);
    m.remove();
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.add('kiln-flash');
    setTimeout(() => target.classList.remove('kiln-flash'), 1600);
    setStatus(`Event ${item ? 'updated' : 'added'} — Publish to make it live`, 'saved');
  };
}

/** Stage a repeat container's full cleaned innerHTML as one pending edit. */
/** A repeat container's content with every Kiln editing artifact stripped —
 *  the exact HTML that staging/publishing would write for it. */
function containerCleanHtml(container) {
  const clone = container.cloneNode(true);
  clone.querySelectorAll('.kiln-item-ctl, .kiln-ctl-cell, #kiln-toolbar, .kiln-repeat-add').forEach(n => n.remove());
  clone.querySelectorAll('[contenteditable]').forEach(n => n.removeAttribute('contenteditable'));
  clone.querySelectorAll('.kiln-field, .kiln-editing, .kiln-modified, .kiln-repeat-item, .kiln-row-editing, .kiln-flash, .kiln-dragging').forEach(n => {
    n.classList.remove('kiln-field', 'kiln-editing', 'kiln-modified', 'kiln-repeat-item', 'kiln-row-editing', 'kiln-flash', 'kiln-dragging');
    if (n.getAttribute('class') === '') n.removeAttribute('class');
    if (n.hasAttribute('data-cms')) n.removeAttribute('title');
    n.removeAttribute('draggable');
  });
  // Any leftover Kiln scope-note title (set on non-decorated out-of-scope nodes).
  clone.querySelectorAll('[title="Not in your editing scope"]').forEach(n => n.removeAttribute('title'));
  clone.querySelectorAll('img[data-kiln-src]').forEach(img => {
    img.setAttribute('src', img.getAttribute('data-kiln-src'));
    img.removeAttribute('data-kiln-src');
  });
  return clone;
}

function stageContainer(container, key) {
  const clone = containerCleanHtml(container);
  // Sanitize the cloned NODE in place rather than round-tripping through a
  // string: DOMPurify's string mode re-parses the fragment in <body> context,
  // where the HTML parser itself drops table tags (<tr>, <td>…) before the
  // allowlist is even consulted — that's what flattened a customer's
  // <tbody data-cms-repeat> schedule. IN_PLACE keeps the real tree.
  const hadChildren = clone.children.length;
  DOMPurify.sanitize(clone, { ...CONTAINER_SANITIZE, IN_PLACE: true });
  const html = clone.innerHTML;

  // Guard: if sanitizing still dropped the block's element structure (an
  // allowlist gap — e.g. a tag we didn't anticipate), REFUSE to stage rather
  // than publish flattened text that would permanently destroy the block.
  if (hadChildren && !clone.children.length) {
    console.error('[kiln] refusing to stage: sanitizing flattened block structure', { key, html });
    setStatus('This block uses markup Kiln couldn’t safely keep — edit NOT staged. Please report this.', 'error');
    return;
  }

  container.classList.add('kiln-modified');
  stagePending(key, { html });
}

function startEditing(el, key) {
  if (state.active) cancelEditing();
  state.active = el;
  if (!state.originals.has(key)) state.originals.set(key, el.innerHTML);
  // THIS element's own pre-edit content, for a correct Esc/cancel. The shared
  // state.originals map is keyed by data-cms name, which repeats across blocks —
  // restoring from it would paste a sibling block's text into this one.
  activeOriginalHtml = el.innerHTML;
  // Keep this row's floating controls out of the way while typing in it.
  el.closest('.kiln-repeat-item')?.classList.add('kiln-row-editing');
  el.classList.add('kiln-editing');
  el.contentEditable = 'true';
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  renderToolbar(el, key);
}

function cancelEditing() {
  const el = state.active;
  if (!el) return;
  const key = el.getAttribute('data-cms');
  el.contentEditable = 'false';
  el.classList.remove('kiln-editing');
  el.closest('.kiln-repeat-item')?.classList.remove('kiln-row-editing');
  // Restore THIS element's own content: its pending value if it isn't inside a
  // repeat (repeat fields stage under the container, never their own key), else
  // its captured pre-edit HTML — never the shared-key map, which holds a
  // sibling block's text.
  const inRepeat = !!el.closest('[data-cms-repeat]');
  const pendingEdit = inRepeat ? null : state.pending.get(key);
  el.innerHTML = pendingEdit?.html ?? activeOriginalHtml ?? el.innerHTML;
  state.active = null;
  activeOriginalHtml = null;
  removeToolbar();
}

function stagePending(key, patch, opts = {}) {
  const prev = state.pending.get(key);
  // Undo step: exact pending-map state before/after, plus the DOM values to
  // show for each direction (before = last staged value, else the baseline).
  let step = null;
  if (!opts.noUndo) {
    step = { key, prevEntry: prev ? JSON.parse(JSON.stringify(prev)) : undefined };
    if (patch.html !== undefined) {
      step.beforeHtml = prev?.html !== undefined ? prev.html : state.undoBase.get(key);
      step.afterHtml = patch.html;
    }
    if (patch.attrs) {
      const base = state.undoBaseAttrs.get(key) || {};
      step.attrsBefore = {}; step.attrsAfter = {};
      for (const [a, v] of Object.entries(patch.attrs)) {
        step.attrsBefore[a] = prev?.attrs?.[a] !== undefined ? prev.attrs[a] : base[a];
        step.attrsAfter[a] = v;
      }
    }
  }
  const cur = prev || {};
  if (patch.html !== undefined) cur.html = patch.html;
  if (patch.attrs) cur.attrs = { ...(cur.attrs || {}), ...patch.attrs };
  state.pending.set(key, cur);
  if (step) {
    step.nextEntry = JSON.parse(JSON.stringify(cur));
    if (undoBucket) undoBucket.steps.push(step);
    else pushUndoEntry({ steps: [step] });
  }
  refreshPublishButton();
}

/** Set a field/container's live DOM to `html` and re-wire editing handles. */
function applyKeyDom(key, html) {
  if (html === undefined) return null;
  const esc = CSS.escape(key);
  const rep = document.querySelector(`[data-cms-repeat="${esc}"]`);
  if (rep) {
    rep.innerHTML = html;
    setupRepeat(rep, key);
    rep.querySelectorAll('[data-cms]').forEach(n => decorateField(n, n.getAttribute('data-cms')));
    return rep;
  }
  const el = document.querySelector(`[data-cms="${esc}"]`);
  if (el) el.innerHTML = html;
  return el;
}

function applyUndoStep(s, dir) {
  if (s.structural) {   // a section that was added (gallery/events) — or removed
    // For an ADD, "before" = section gone; for a REMOVAL it's the mirror image.
    const wantPresent = s.structural.removed ? dir === 'before' : dir === 'after';
    if (wantPresent) {
      if (s.structural.place) s.structural.place();
      else (document.querySelector('main') || document.body).appendChild(s.structural.node);
    } else {
      s.structural.node.remove();
    }
    const opWanted = s.structural.removed ? !wantPresent : wantPresent;
    const i = s.structural.op ? state.pendingStructural.indexOf(s.structural.op)
      : state.pendingStructural.findIndex(op => op.html === s.structural.html);
    if (opWanted) { if (!cfg.sandbox && s.structural.op && i === -1) state.pendingStructural.push(s.structural.op); }
    else if (i !== -1) state.pendingStructural.splice(i, 1);
    return s.structural.node;
  }
  const entry = dir === 'before' ? s.prevEntry : s.nextEntry;
  if (entry === undefined) state.pending.delete(s.key);
  else state.pending.set(s.key, JSON.parse(JSON.stringify(entry)));
  const el = applyKeyDom(s.key, dir === 'before' ? s.beforeHtml : s.afterHtml);
  const attrs = dir === 'before' ? s.attrsBefore : s.attrsAfter;
  if (attrs) {
    document.querySelectorAll(`[data-cms="${CSS.escape(s.key)}"]`).forEach(n => {
      for (const [a, v] of Object.entries(attrs)) {
        // Undefined "before" for an image-swap attr means it didn't exist —
        // REMOVE it (don't skip), so an undone swap can't leave data-kiln-src
        // behind to be re-committed later. Also retire the orphaned upload.
        if (v === undefined) {
          if (a === 'data-kiln-src') {
            const orphan = n.getAttribute('data-kiln-src');
            if (orphan) for (const p of [...state.pendingBinaries.keys()]) if (p.endsWith(orphan.replace(/^\//, ''))) state.pendingBinaries.delete(p);
            n.removeAttribute(a);
          }
        } else n.setAttribute(a, v);
      }
    });
  }
  const modified = state.pending.has(s.key);
  const esc = CSS.escape(s.key);
  document.querySelectorAll(`[data-cms="${esc}"],[data-cms-repeat="${esc}"]`)
    .forEach(n => n.classList.toggle('kiln-modified', modified));
  return el || document.querySelector(`[data-cms="${esc}"],[data-cms-repeat="${esc}"]`);
}

function undoEdit() {
  // Mid-edit? Commit the field first so the in-progress change becomes the top
  // undo entry — then this undo takes the field back to how it was.
  if (state.active) commitEdit(state.active, state.active.getAttribute('data-cms'));
  const entry = editHistory.undo.pop();
  if (!entry) { setStatus('Nothing to undo', 'idle'); return; }
  let el = null;
  for (const s of [...entry.steps].reverse()) el = applyUndoStep(s, 'before') || el;
  editHistory.redo.push(entry);
  refreshPublishButton(); updateUndoUi();
  if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('kiln-flash'); setTimeout(() => el.classList.remove('kiln-flash'), 1200); }
  setStatus('Undone', 'saved');
}

function redoEdit() {
  const entry = editHistory.redo.pop();
  if (!entry) { setStatus('Nothing to redo', 'idle'); return; }
  let el = null;
  for (const s of entry.steps) el = applyUndoStep(s, 'after') || el;
  editHistory.undo.push(entry);
  refreshPublishButton(); updateUndoUi();
  if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('kiln-flash'); setTimeout(() => el.classList.remove('kiln-flash'), 1200); }
  setStatus('Redone', 'saved');
}

function updateUndoUi() {
  const wrap = document.getElementById('kiln-undo-wrap');
  if (!wrap) return;
  const canUndo = editHistory.undo.length > 0, canRedo = editHistory.redo.length > 0;
  wrap.hidden = !canUndo && !canRedo;
  const u = wrap.querySelector('#kiln-undo-btn'), r = wrap.querySelector('#kiln-redo-btn');
  if (u) u.disabled = !canUndo;
  if (r) r.disabled = !canRedo;
}

// ⌘Z / ⌘⇧Z (Ctrl+Z / Ctrl+Y on Windows). While TYPING in a field or input the
// browser's native undo applies; this only fires between edits.
document.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k !== 'z' && !(k === 'y' && e.ctrlKey)) return;
  const t = e.target;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
  if (document.getElementById('kiln-modal')) return;   // a dialog is open — leave keys alone
  e.preventDefault();
  if (k === 'y' || e.shiftKey) redoEdit(); else undoEdit();
});

/** The committed value of a field's HTML (sanitized rich text, or escaped plain text). */
function fieldValue(html, plain) {
  // Editing chrome can sit inside a field's DOM (row controls, the toolbar).
  // Remove it as ELEMENTS first — sanitizing alone strips the tags but keeps
  // their text, which is how ↑↓＋🏷✕ once ended up inside a table cell's value.
  const d = document.createElement('div');
  d.innerHTML = html;
  d.querySelectorAll('.kiln-item-ctl, .kiln-ctl-cell, .kiln-repeat-add, #kiln-toolbar').forEach(n => n.remove());
  if (plain) return escapeHtml(d.textContent);
  return DOMPurify.sanitize(d.innerHTML, SANITIZE);
}

function commitEdit(el, key) {
  const plain = el.hasAttribute('data-cms-plain');
  const value = fieldValue(el.innerHTML, plain);
  el.innerHTML = value;
  el.contentEditable = 'false';
  el.classList.remove('kiln-editing');
  el.closest('.kiln-repeat-item')?.classList.remove('kiln-row-editing');

  // Link elements: apply the toolbar's href before staging (scheme-sanitized).
  // Exclude the image toolbar's alt-text input, which shares the styling class
  // but is NOT an href — otherwise editing a link while an image toolbar is
  // open would write the alt text into the link's href.
  const hrefInput = el.tagName === 'A' ? document.querySelector('#kiln-toolbar .kiln-href-input:not([data-act="alt"])') : null;
  const hrefValue = hrefInput ? safeUrl(hrefInput.value) : null;
  const hrefChanged = hrefInput && hrefValue !== el.getAttribute('href');

  // Clicking into a field and back out WITHOUT changing anything must not create
  // a phantom edit (which would light up the badge and enable Publish/Discard).
  const original = state.originals.get(key);
  const unchanged = original !== undefined && fieldValue(original, plain) === value && !hrefChanged;
  if (unchanged) {
    state.originals.delete(key);
    state.active = null;
    removeToolbar();
    return;
  }

  el.classList.add('kiln-modified');
  if (hrefChanged) el.setAttribute('href', hrefValue);

  const repeat = el.closest('[data-cms-repeat]');
  if (repeat) {
    // Fields inside repeatable blocks publish as the whole container,
    // so duplicated blocks (with duplicate keys) stay unambiguous.
    stageContainer(repeat, repeat.getAttribute('data-cms-repeat'));
  } else {
    undoGroup(() => {
      stagePending(key, { html: committedHtml(el, plain, value) });
      if (hrefChanged) stagePending(key, { attrs: { href: hrefValue } });
    });
  }
  state.active = null;
  removeToolbar();
}

/** The HTML to commit for a field: blob previews are swapped for their real repo paths. */
function committedHtml(el, plain, fallback) {
  if (plain) return fallback;
  const clone = el.cloneNode(true);
  clone.querySelectorAll('.kiln-item-ctl, .kiln-ctl-cell, .kiln-repeat-add, #kiln-toolbar').forEach(n => n.remove());
  clone.querySelectorAll('img[data-kiln-src]').forEach(img => {
    img.setAttribute('src', img.getAttribute('data-kiln-src'));
    img.removeAttribute('data-kiln-src');
  });
  return DOMPurify.sanitize(clone.innerHTML, SANITIZE);
}

// ─── Images ──────────────────────────────────────────────────────────────────

/** Mini toolbar for images: replace, alt text, done. */
function imageToolbar(img, key) {
  removeToolbar();
  const tb = document.createElement('div');
  tb.id = 'kiln-toolbar';
  tb.innerHTML = `
    ${TB_GRIP}
    <span class="kiln-tb-label">${escapeHtml(key)}</span>
    <button class="kiln-tb-fmt kiln-tb-attach" data-act="replace">Replace image…</button>
    <span class="kiln-tb-hint">drag the ● corner to resize</span>
    <input class="kiln-href-input" data-act="alt" type="text" value="${escapeHtml(img.getAttribute('alt') || '')}"
      placeholder="Describe this image (alt text)" title="Alt text — read by screen readers and search engines">
    <button class="kiln-tb-save" data-act="done">Done</button>`;
  document.body.appendChild(tb);
  positionToolbar(tb, img);
  makeToolbarDraggable(tb);

  const altInput = tb.querySelector('[data-act="alt"]');
  const finish = () => {
    if (altInput.value !== (img.getAttribute('alt') || '')) {
      img.setAttribute('alt', altInput.value);
      img.classList.add('kiln-modified');
      const repeat = img.closest('[data-cms-repeat]');
      if (repeat) stageContainer(repeat, repeat.getAttribute('data-cms-repeat'));
      else stagePending(key, { attrs: { alt: altInput.value } });
    }
    tb.remove();
  };
  tb.querySelector('[data-act="replace"]').onclick = (e) => { e.stopPropagation(); pickImage(img, key); };

  const handle = enableImageDragResize(img, key);
  tb.querySelector('[data-act="done"]').onclick = (e) => { e.stopPropagation(); finish(); handle.remove(); };
  const away = (e) => {
    if (!tb.contains(e.target) && e.target !== img && e.target !== handle) {
      finish(); handle.remove(); document.removeEventListener('click', away);
    }
  };
  setTimeout(() => document.addEventListener('click', away), 0);
}

/**
 * A bottom-right drag handle on an editable image. Dragging live-resizes how the
 * image DISPLAYS; on release the file is resampled to be web-ready at that size,
 * while the largest version we have is retained (data-kiln-master) so you can
 * drag back up later without quality loss.
 */
function enableImageDragResize(img, key, stage = true) {
  document.querySelectorAll('.kiln-img-handle').forEach(h => h.remove());   // one at a time
  const handle = document.createElement('div');
  handle.className = 'kiln-img-handle';
  handle.title = 'Drag to resize — the file is re-sampled to fit';
  document.body.appendChild(handle);
  const place = () => {
    const r = img.getBoundingClientRect();
    handle.style.left = `${r.right + window.scrollX - 11}px`;
    handle.style.top = `${r.bottom + window.scrollY - 11}px`;
  };
  place();
  window.addEventListener('scroll', place, true);
  window.addEventListener('resize', place);
  handle.remove = ((orig) => function () {
    window.removeEventListener('scroll', place, true);
    window.removeEventListener('resize', place);
    orig.call(handle);
  })(handle.remove);

  let drag = null;
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault(); e.stopPropagation();
    drag = { startX: e.clientX, startW: img.getBoundingClientRect().width };
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('kiln-img-handle-on');
  });
  handle.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const w = Math.max(40, Math.round(drag.startW + (e.clientX - drag.startX)));
    const maxW = (img.parentElement?.getBoundingClientRect().width) || window.innerWidth;
    img.style.width = `${Math.min(w, Math.round(maxW))}px`;
    img.style.height = 'auto';
    place();
  });
  handle.addEventListener('pointerup', async (e) => {
    if (!drag) return;
    const finalW = img.getBoundingClientRect().width;
    drag = null;
    handle.classList.remove('kiln-img-handle-on');
    await resampleToDisplay(img, key, Math.round(finalW), stage);
    place();
  });
  return handle;
}

/** Load any URL (data:, blob:, /path) into an ImageBitmap. */
async function urlToBitmap(url) {
  const res = await fetch(url, { cache: 'no-store' });
  return createImageBitmap(await res.blob());
}

/**
 * Resample the retained master image to ~DPR×cssWidth and set it as the src.
 * `stage` false = the image lives inside a rich-text field being edited, so the
 * field's own commit persists it (no separate keyed staging).
 */
async function resampleToDisplay(img, key, cssWidth, stage = true) {
  try {
    // The master is the largest version we hold. First resize captures it.
    let master = img.getAttribute('data-kiln-master')
      || img.getAttribute('data-kiln-src') || img.getAttribute('src');
    master = safeUrl(master);
    // SVGs are vector — they scale losslessly, so there's nothing to re-sample.
    // Just set the display width and stage it.
    if (/\.svg(\?|#|$)/i.test(master) || /^data:image\/svg/i.test(master)) {
      img.style.width = `${cssWidth}px`;
      img.style.height = 'auto';
      img.removeAttribute('data-kiln-master');
      if (stage) stageImageEl(img, key);
      setStatus(`Sized to ${cssWidth}px — Publish to keep it`, 'saved');
      return;
    }
    img.setAttribute('data-kiln-master', master);
    setStatus('Re-sampling to fit…', 'saving');
    // Prefer the in-memory master bitmap (set when the image was added) so a
    // resize BEFORE publish resamples from the original, not a URL that isn't live.
    let bmp = masterBitmaps.get(master);
    if (!bmp) {
      // The master path may not be live yet (upload queued for the next
      // Publish) — fall back to what the image is showing right now.
      try { bmp = await urlToBitmap(master); }
      catch { bmp = await urlToBitmap(img.currentSrc || img.src); }
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const targetW = Math.max(1, Math.min(Math.round(cssWidth * dpr), bmp.width, 2400));
    const scaled = await bitmapToScaled(bmp, targetW);
    const blob = scaled.blob, base64 = scaled.base64;

    img.style.width = `${cssWidth}px`;
    img.style.height = 'auto';
    if (cfg.sandbox) {
      img.src = `data:image/webp;base64,${base64}`;
      if (stage) stageImageEl(img, key);
      setStatus(`Sized to ${cssWidth}px and re-sampled (${Math.round(blob.size / 1024)} KB) — Publish to keep it`, 'saved');
      return;
    }
    // Repeated drag-resizes supersede each other: drop the previous (uncommitted)
    // intermediate so we don't commit a pile of throwaway sizes on Publish.
    const prev = img.getAttribute('data-kiln-src');
    if (prev) state.pendingBinaries.delete((cfg.root ? cfg.root.replace(/\/+$/, '') + '/' : '') + prev.replace(/^\//, ''));
    const name = `img-${Date.now().toString(36)}.webp`;
    const repoPath = (cfg.root ? cfg.root.replace(/\/+$/, '') + '/' : '') + `assets/uploads/${name}`;
    stageBinary(repoPath, base64);   // committed with Publish, not now
    img.src = URL.createObjectURL(blob);
    img.setAttribute('data-kiln-src', `/assets/uploads/${name}`);
    if (stage) stageImageEl(img, key);
    setStatus(`Sized to ${cssWidth}px and re-sampled (${Math.round(blob.size / 1024)} KB) — Publish to put it live`, 'saved');
  } catch (err) {
    console.error('[kiln] resize', err);
    setStatus('Resize failed — see console', 'error');
  }
}

/** Stage an image element's current state (src/style/attrs) — container or single field. */
function stageImageEl(img, key) {
  img.classList.add('kiln-modified');
  const repeat = img.closest('[data-cms-repeat]');
  if (repeat) { stageContainer(repeat, repeat.getAttribute('data-cms-repeat')); return; }
  const attrs = { style: img.getAttribute('style') || '', 'data-kiln-master': img.getAttribute('data-kiln-master') || '' };
  if (cfg.sandbox) attrs.src = img.getAttribute('src');
  else attrs.src = safeUrl(img.getAttribute('data-kiln-src') || img.getAttribute('src'));
  stagePending(key, { attrs });
}

function pickImage(img, key) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      setStatus('Adding image…', 'saving');
      await addImageWithMaster(img, key, file);
    } catch (err) {
      console.error('[kiln] image upload', err);
      setStatus('Image upload failed', 'error');
    }
  };
  input.click();
}

// In-memory master bitmaps (url → ImageBitmap) so drag-resize can resample from
// the ORIGINAL even before it's been published (its repo URL isn't live yet).
const masterBitmaps = new Map();

/** Re-encode a bitmap to web-optimized webp at a target width. Returns {blob, base64}. */
async function bitmapToScaled(bmp, targetW) {
  const w = Math.max(1, Math.min(Math.round(targetW), bmp.width));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = Math.round(bmp.height * (w / bmp.width));
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise(r => canvas.toBlob(r, 'image/webp', 0.85))
    || await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.85));
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return { blob, base64: btoa(bin) };
}

/**
 * Add/replace an image the way the workflow wants: keep a high-res MASTER
 * (≤2400px, web-optimized) as the original, and display a web-optimized COPY
 * sized to how the image shows on the page. Dragging the corner later makes a
 * fresh copy from the master (so up-sizing stays sharp; the master is never
 * thrown away).
 */
async function addImageWithMaster(img, key, file) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssW = Math.round(img.getBoundingClientRect().width) || 600;
  const bmp = await createImageBitmap(file);
  const masterW = Math.min(bmp.width, 2400);
  const displayW = Math.min(Math.round(cssW * dpr), masterW);

  if (cfg.sandbox) {
    // Demo: no repo. Keep the master as a data URL (in the attr) + show a copy.
    const master = await bitmapToScaled(bmp, masterW);
    const display = await bitmapToScaled(bmp, displayW);
    img.setAttribute('data-kiln-master', `data:image/webp;base64,${master.base64}`);
    img.src = `data:image/webp;base64,${display.base64}`;
    img.classList.add('kiln-modified');
    const rpt = img.closest('[data-cms-repeat]');
    if (rpt) stageContainer(rpt, rpt.getAttribute('data-cms-repeat'));
    else stagePending(key, { attrs: { src: img.src, 'data-kiln-master': img.getAttribute('data-kiln-master') } });
    showResizeNow(img, key);
    setStatus('Image added — drag its ● corner to resize, then Publish', 'saved');
    return;
  }

  const stamp = Date.now().toString(36);
  const root = cfg.root ? cfg.root.replace(/\/+$/, '') + '/' : '';
  // Master (kept forever, referenced by data-kiln-master).
  const master = await bitmapToScaled(bmp, masterW);
  const masterUrl = `/assets/uploads/master-${stamp}.webp`;
  stageBinary(root + `assets/uploads/master-${stamp}.webp`, master.base64);
  img.setAttribute('data-kiln-master', masterUrl);
  masterBitmaps.set(masterUrl, bmp);   // so a resize before publish resamples from it
  // Display copy at the on-page size.
  const display = await bitmapToScaled(bmp, displayW);
  const dispUrl = `/assets/uploads/img-${stamp}.webp`;
  stageBinary(root + `assets/uploads/img-${stamp}.webp`, display.base64);
  img.src = URL.createObjectURL(display.blob);
  img.setAttribute('data-kiln-src', dispUrl);
  img.classList.add('kiln-modified');
  const repeat = img.closest('[data-cms-repeat]');
  if (repeat) stageContainer(repeat, repeat.getAttribute('data-cms-repeat'));
  else stageImageEl(img, key);
  showResizeNow(img, key);
  setStatus('Image added — drag its ● corner to resize, then Publish', 'saved');
}

/** Right after an image is added/replaced: put the resize handle on it NOW
 *  (before publish), and keep it until the user clicks elsewhere. */
function showResizeNow(img, key) {
  const handle = enableImageDragResize(img, key);
  img.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const away = (e) => {
    if (e.target === img || e.target === handle || e.target.closest('#kiln-toolbar, #kiln-imgpop, #kiln-modal')) return;
    handle.remove();
    document.removeEventListener('click', away, true);
  };
  setTimeout(() => document.addEventListener('click', away, true), 0);
}

/**
 * Re-encode the CURRENT image at a smaller max dimension (real resampling —
 * the file itself shrinks, not just how it displays), upload the result as a
 * new file, and stage the swap.
 */
async function resampleImage(img, key, maxDim) {
  try {
    setStatus(`Resampling to max ${maxDim}px…`, 'saving');
    const src = img.getAttribute('data-kiln-src') || img.getAttribute('src');
    const res = await fetch(src, { cache: 'no-store' });
    if (!res.ok) throw new Error(`could not fetch current image (${res.status})`);
    const blob0 = await res.blob();
    const baseName = (src.split('/').pop() || 'image').split('?')[0];
    const scaled = await downscale(new File([blob0], baseName, { type: blob0.type }), maxDim);
    await stageImageSwap(img, key, scaled, baseName);
    setStatus(`Resampled to max ${maxDim}px (${Math.round(scaled.blob.size / 1024)} KB) — Publish to put it live`, 'saved');
  } catch (err) {
    console.error('[kiln] resample', err);
    setStatus('Resample failed — see console', 'error');
  }
}

/** Shared tail of every image swap: sandbox keeps a data URL; real sites upload
 *  to the repo, preview locally, and stage the future URL. */
async function stageImageSwap(img, key, { blob, base64, ext }, originalName) {
  if (cfg.sandbox) {
    const dataUrl = `data:image/${ext};base64,${base64}`;
    img.src = dataUrl;
    img.classList.add('kiln-modified');
    const rpt = img.closest('[data-cms-repeat]');
    // Stage the data URL itself so the swap persists across reloads in the
    // visitor's own browser (repeats capture it inside the container HTML).
    if (rpt) stageContainer(rpt, rpt.getAttribute('data-cms-repeat'));
    else stagePending(key, { attrs: { src: dataUrl } });
    setStatus('Image added — hit Publish to save it to your demo', 'saved');
    return;
  }
  const slug = (String(originalName).replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'image');
  const name = `${slug}-${Date.now().toString(36)}.${ext}`;
  const repoPath = (cfg.root ? cfg.root.replace(/\/+$/, '') + '/' : '') + `assets/uploads/${name}`;
  const urlPath = `/assets/uploads/${name}`;
  stageBinary(repoPath, base64);   // committed with Publish, not now
  // Show the LOCAL image immediately — the real URL only exists after the
  // next deploy, so pointing at it now would render a broken image.
  img.src = URL.createObjectURL(blob);
  img.setAttribute('data-kiln-src', urlPath);
  img.classList.add('kiln-modified');
  const repeat = img.closest('[data-cms-repeat]');
  if (repeat) stageContainer(repeat, repeat.getAttribute('data-cms-repeat'));
  else stagePending(key, { attrs: { src: safeUrl(urlPath) } });
  setStatus('Image staged — hit Publish to put it live', 'saved');
}

/** Display-size change (how big it LOOKS — the file is untouched). */
function applyImageSize(img, key, val) {
  if (val === 'orig') { img.style.removeProperty('width'); img.style.removeProperty('height'); }
  else { img.style.width = val; img.style.height = 'auto'; }
  img.classList.add('kiln-modified');
  const repeat = img.closest('[data-cms-repeat]');
  if (repeat) stageContainer(repeat, repeat.getAttribute('data-cms-repeat'));
  else stagePending(key, { attrs: { style: img.getAttribute('style') || '' } });
  setStatus(val === 'orig' ? 'Size reset — Publish to save' : `Width set to ${val} — Publish to save`, 'saved');
}

async function downscale(file, maxDim = 1600) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise(r => canvas.toBlob(r, 'image/webp', 0.85))
    || await new Promise(r => canvas.toBlob(r, file.type, 0.85));
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return { blob, base64: btoa(bin), ext: blob.type === 'image/webp' ? 'webp' : (file.name.split('.').pop() || 'img') };
}

/** Insert an uploaded image at the cursor inside a rich-text field. */
function insertInlineImage(el) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      setStatus('Adding image…', 'saving');
      const { blob, base64, ext } = await downscale(file, 1200);
      // Demo sandbox: never touches GitHub — embed the image as a data URL so it
      // shows immediately and survives the sandbox's localStorage round-trip.
      if (cfg.sandbox) {
        el.focus();
        document.execCommand('insertHTML', false,
          `<img src="data:image/${ext};base64,${base64}" alt="" style="max-width:100%">`);
        const ins = [...el.querySelectorAll('img')].find(i => i.getAttribute('src')?.startsWith(`data:image/${ext};base64,`));
        if (ins) inlineImgPopover(ins);
        setStatus('Image added — resize it now if you like, then Save and Publish', 'saved');
        return;
      }
      const slug = (file.name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'image');
      const name = `${slug}-${Date.now().toString(36)}.${ext}`;
      const repoPath = (cfg.root ? cfg.root.replace(/\/+$/, '') + '/' : '') + `assets/uploads/${name}`;
      const urlPath = `/assets/uploads/${name}`;
      stageBinary(repoPath, base64);   // committed with Publish, not now
      const blobUrl = URL.createObjectURL(blob);
      masterBitmaps.set(urlPath, await createImageBitmap(blob));   // pre-publish resizes read this
      el.focus();
      document.execCommand('insertHTML', false,
        `<img src="${blobUrl}" data-kiln-src="${urlPath}" alt="" style="max-width:100%">`);
      const ins = el.querySelector(`img[src="${blobUrl}"]`);
      if (ins) inlineImgPopover(ins);
      setStatus('Image inserted — resize it now if you like, then Save and Publish', 'saved');
    } catch (err) {
      console.error('[kiln] inline image', err);
      setStatus('Image upload failed', 'error');
    }
  };
  input.click();
}

/** Upload any file (PDF, doc, …) and return { path, name, size }. Members pages upload into the gated folder. */
function uploadAnyFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return resolve(null);
      if (file.size > 15 * 1024 * 1024) { setStatus('Files over 15 MB don’t belong in a Git repo', 'error'); return resolve(null); }
      // Demo sandbox: hand back an in-browser blob URL instead of committing to
      // GitHub, so the demo can show a working document chip/card/link.
      if (cfg.sandbox) {
        setStatus(`${file.name} added (demo: stays in your browser)`, 'saved');
        return resolve({ path: URL.createObjectURL(file), name: file.name, size: file.size });
      }
      try {
        setStatus(`Uploading ${file.name}…`, 'saving');
        const buf = new Uint8Array(await file.arrayBuffer());
        let bin = '';
        for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        const safe = file.name.toLowerCase().replace(/[^a-z0-9.]+/g, '-');
        const gated = location.pathname.startsWith('/members');
        const dir = gated ? 'members/files' : 'assets/files';
        const repoPath = (cfg.root ? cfg.root.replace(/\/+$/, '') + '/' : '') + `${dir}/${safe}`;
        stageBinary(repoPath, btoa(bin));   // committed with Publish, not now
        setStatus(`${file.name} added ✓ ${gated ? '(members-only)' : ''} — goes live with your next Publish`, 'saved');
        resolve({ path: `/${dir}/${safe}`, name: file.name, size: file.size });
      } catch (err) {
        console.error('[kiln] file upload', err);
        setStatus('File upload failed', 'error');
        resolve(null);
      }
    };
    input.click();
  });
}

/**
 * Upload a document and insert it at the cursor as a text link, a chip, or a
 * card (the .kiln-doc styles ship in kiln-features.js for visitors).
 */
async function insertDocument(el, savedRange) {
  const key = el.getAttribute('data-cms');
  const up = await uploadAnyFile();
  if (!up) return;
  const pretty = up.size > 1024 * 1024 ? `${(up.size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(up.size / 1024))} KB`;
  const ext = (up.name.split('.').pop() || 'file').toUpperCase();
  const m = modal(`
    <h3>How should the document appear?</h3>
    <label>Label <input type="text" id="kiln-doc-label" value="${escapeHtml(up.name)}"></label>
    <div class="kiln-roles">
      <label class="kiln-role"><input type="radio" name="kiln-doc-kind" value="link" checked>
        <span><strong>Text link</strong><br><small>Reads like a normal link in the sentence.</small></span></label>
      <label class="kiln-role"><input type="radio" name="kiln-doc-kind" value="chip">
        <span><strong>Chip</strong><br><small>A small bordered button with a 📄 icon.</small></span></label>
      <label class="kiln-role"><input type="radio" name="kiln-doc-kind" value="card">
        <span><strong>Card</strong><br><small>A block with the name and file details (${escapeHtml(ext)} · ${escapeHtml(pretty)}).</small></span></label>
    </div>
    <h4>When clicked</h4>
    <div class="kiln-roles">
      <label class="kiln-role"><input type="radio" name="kiln-doc-open" value="view" checked>
        <span><strong>Open in a new tab</strong><br><small>Views the file in the browser (PDFs, images).</small></span></label>
      <label class="kiln-role"><input type="radio" name="kiln-doc-open" value="download">
        <span><strong>Download</strong><br><small>Saves the file to their device.</small></span></label>
    </div>
    <div class="kiln-modal-actions">
      <button class="kiln-btn-ghost" data-close>Cancel</button>
      <button class="kiln-btn-publish" id="kiln-doc-go">Insert</button>
    </div>`);
  m.querySelector('#kiln-doc-go').onclick = () => {
    const label = escapeHtml(m.querySelector('#kiln-doc-label').value.trim() || up.name);
    const kind = m.querySelector('input[name="kiln-doc-kind"]:checked').value;
    const openMode = m.querySelector('input[name="kiln-doc-open"]:checked').value;
    const href = escapeHtml(safeUrl(up.path));
    const behave = openMode === 'download' ? ' download' : ' target="_blank" rel="noopener"';
    const html = kind === 'link' ? `<a href="${href}"${behave}>${label}</a>`
      : kind === 'chip' ? `<a href="${href}" class="kiln-doc kiln-doc-chip"${behave}>📄 ${label}</a>`
      : `<a href="${href}" class="kiln-doc kiln-doc-card"${behave}><strong>${label}</strong><br><small>${escapeHtml(ext)} · ${escapeHtml(pretty)}</small></a>`;
    m.remove();
    // Insert directly via the DOM (not execCommand) — by the time this runs the
    // field may have left edit mode (interacting with this modal committed it),
    // so we can't rely on a live selection. Insert at the saved range if it's
    // still valid, else append to the field, then re-stage the field ourselves.
    const frag = document.createRange().createContextualFragment(html + '&nbsp;');
    let inserted = false;
    if (savedRange && el.contains(savedRange.startContainer)) {
      try { savedRange.collapse(false); savedRange.insertNode(frag); inserted = true; } catch { /* fall through */ }
    }
    if (!inserted) el.appendChild(frag);
    // Persist it: stage the field's new committed HTML (works whether or not it's
    // still the active edit).
    const repeat = el.closest('[data-cms-repeat]');
    if (repeat) stageContainer(repeat, repeat.getAttribute('data-cms-repeat'));
    else stagePending(key, { html: committedHtml(el, false) });
    el.classList.add('kiln-modified');
    setStatus('Document inserted — Publish when ready', 'saved');
  };
}

// ─── Publish ─────────────────────────────────────────────────────────────────

function flattenPending() {
  const edits = [];
  for (const [key, v] of state.pending) {
    if (v.html !== undefined) edits.push({ key, html: v.html });
    for (const [attr, value] of Object.entries(v.attrs || {})) edits.push({ key, attr, value });
  }
  return edits;
}

async function publish() {
  if (!state.pending.size && !state.pendingBinaries.size && !state.pendingStructural.length) return;
  if (cfg.sandbox) return publishSandbox();

  // Edits inside a data-cms-partial (e.g. a shared footer or header) fan out to
  // every page; everything else commits to the current page only.
  const partialKeys = new Set();
  for (const key of state.pending.keys()) {
    let el = null;
    try { el = document.querySelector('[data-cms="' + key + '"]'); } catch { el = null; }
    if (el && el.closest('[data-cms-partial]')) partialKeys.add(key);
  }
  const localEdits = [], partialEdits = [];
  for (const [key, v] of state.pending) {
    const bucket = partialKeys.has(key) ? partialEdits : localEdits;
    if (v.html !== undefined) bucket.push({ key, html: v.html });
    for (const [attr, value] of Object.entries(v.attrs || {})) bucket.push({ key, attr, value });
  }

  // Snapshot EXACTLY what we're committing. Publishing is async (GitHub round-trip),
  // and the editor stays live the whole time — the user can keep editing. So instead
  // of a blanket state.pending.clear() at the end (which would silently drop any edit
  // made mid-publish), we only retire the keys we actually sent, and only if they
  // haven't changed since. A re-edit of the same key, or a brand-new key, survives.
  const publishedSnapshot = new Map();
  for (const [key, v] of state.pending) publishedSnapshot.set(key, JSON.stringify(v));

  // Same-field conflict gate: if someone ELSE published a change to a field
  // we're about to write since we loaded the page, ask before overwriting.
  // (Different-field edits merge automatically — editFile re-applies our edits
  // by key against the fresh source.)
  if (localEdits.length && !(await confirmOverwrites(localEdits))) return;

  setStatus('Publishing — committing to GitHub…', 'saving');
  disablePublish(true);
  try {
    // Prune orphaned uploads before committing. A swap that queued an upload and
    // was then undone leaves the binary in pendingBinaries with no edit referencing
    // it — committing it would push a public, unreferenced file to the live site,
    // and its stale data-kiln-src marker would make watchDeploy point a live <img>
    // at that (now-absent) path. Keep only binaries whose filename actually appears
    // in a value we're about to commit.
    if (state.pendingBinaries.size) {
      const haystack = [
        ...localEdits.map(e => e.html ?? e.value ?? ''),
        ...partialEdits.map(e => e.html ?? e.value ?? ''),
        ...state.pendingStructural.map(s => s.html || ''),
      ].join('\n');
      for (const path of [...state.pendingBinaries.keys()]) {
        const base = path.split('/').pop();
        if (base && !haystack.includes(base)) {
          state.pendingBinaries.delete(path);
          try {
            document.querySelectorAll('img[data-kiln-src]').forEach(img => {
              if ((img.getAttribute('data-kiln-src') || '').split('/').pop() === base) img.removeAttribute('data-kiln-src');
            });
          } catch {}
        }
      }
    }
    // Commit any queued binaries (images/docs) FIRST, in one commit, so the files
    // exist before the page that references them goes live. Deferring them to here
    // is what makes "nothing is live until Publish" true (Discard = no orphans).
    if (state.pendingBinaries.size) {
      const files = [...state.pendingBinaries].map(([path, base64]) => ({ path, base64 }));
      await commitFiles(state.gh, cfg.repo, cfg.branch || 'main', files,
        `Upload ${files.length} file${files.length > 1 ? 's' : ''} (via Kiln)`);
      // Retire only the paths we sent; a file queued during the commit survives.
      for (const { path } of files) state.pendingBinaries.delete(path);
    }
    let result = null;
    // Track which keys actually made it into the commit vs. were skipped (e.g. a
    // key another editor un-annotated between load and publish). The final callback
    // run wins (editFile re-runs it on a sha-conflict retry).
    let appliedKeys = new Set(), skippedKeys = new Set();
    // Freeze the structural ops we're sending so a mid-publish addition can't get
    // applied to this commit (it would then be double-applied on the next Publish).
    const structuralOps = state.pendingStructural.slice();
    if (localEdits.length || structuralOps.length) {
      const structDesc = structuralOps.map(s => s.op === 'annotate' ? `+${s.key}`
        : s.op === 'remove' || s.op === 'removeSection' ? `-${s.key}`
        : `+${s.key || 'section'}`);
      result = await editFile(
        state.gh, cfg.repo, state.page.path, cfg.branch || 'main',
        (text) => {
          // Structural changes (make/unmake editable) first, so field edits can
          // reference newly-annotated keys; then splice the field edits.
          const t = applyStructural(text, structuralOps);
          const { html, applied, skipped } = applyEdits(t, localEdits);
          appliedKeys = new Set(applied);
          skippedKeys = new Set(skipped.map(s => s.key));
          for (const s of skipped) console.warn('[kiln] skipped:', s);
          return html;
        },
        `Edit ${state.page.path}: ${[...localEdits.map(e => e.key), ...structDesc].join(', ')} (via Kiln)`
      );
      // Drop only the structural ops we sent (they're appended, so the sent ones are
      // at the front); anything added mid-publish stays queued for the next Publish.
      state.pendingStructural.splice(0, structuralOps.length);
    }
    if (partialEdits.length) await publishPartials(partialEdits);
    // Retire only the keys we published and that are unchanged since the snapshot.
    // Anything the user edited (or added) during the commit stays pending and keeps
    // its "modified" marker, so the next Publish picks it up.
    for (const [key, snap] of publishedSnapshot) {
      // A field key whose every edit was skipped never reached the commit (it
      // vanished from source, e.g. another editor un-annotated it). Keep it pending
      // and modified rather than silently discarding the user's work.
      if (skippedKeys.has(key) && !appliedKeys.has(key)) continue;
      if (state.pending.has(key) && JSON.stringify(state.pending.get(key)) === snap) {
        state.pending.delete(key);
        state.originals.delete(key);
        // The published value is the new "unedited" state for session undo.
        try {
          const v = JSON.parse(snap);
          if (v.html !== undefined) state.undoBase.set(key, v.html);
          if (v.attrs) state.undoBaseAttrs.set(key, { ...(state.undoBaseAttrs.get(key) || {}), ...v.attrs });
        } catch {}
        try {
          document.querySelectorAll('[data-cms="' + CSS.escape(key) + '"].kiln-modified, [data-cms-repeat="' + CSS.escape(key) + '"].kiln-modified')
            .forEach(el => el.classList.remove('kiln-modified'));
        } catch {}
      }
    }
    // Undo/redo operate on STAGED changes. Once published, those entries would
    // desync the page from the now-live site (⌘Z would revert the DOM but stage
    // nothing), so retire the history at the publish boundary.
    editHistory.undo.length = 0;
    editHistory.redo.length = 0;
    updateUndoUi();
    await loadPageSource();
    refreshPublishButton();
    // Don't let a fully-skipped edit report success silently — tell the user it's
    // still pending because the section it targeted is gone from the page.
    const keptSkipped = [...skippedKeys].filter(k => !appliedKeys.has(k) && state.pending.has(k));
    if (keptSkipped.length) {
      setStatus(`${keptSkipped.length} edit${keptSkipped.length > 1 ? 's' : ''} couldn't be applied — that section no longer exists on the page. Still pending.`, 'error');
      return;
    }
    if (result && result.unchanged && !partialEdits.length) { setStatus('Nothing changed', 'idle'); return; }
    watchDeploy(result?.commit?.sha, result?.text);
  } catch (err) {
    console.error('[kiln] publish', err);
    setStatus('Publish failed — see console', 'error');
    disablePublish(false);
  }
}

/**
 * True → go ahead and publish. Checks the repo for changes other people made
 * to the SAME fields we're writing; if found, offers Reload & review (pending
 * edits survive reload via localStorage) or Publish anyway.
 */
async function confirmOverwrites(localEdits) {
  try {
    const fresh = await getFile(state.gh, cfg.repo, state.page.path, cfg.branch || 'main');
    if (fresh.sha === state.page.sha) return true;         // nothing changed under us
    const freshVals = readValues(fresh.text);
    const base = state.baseline || {};
    const conflicted = [...new Set(localEdits.map(e => e.key))]
      .filter(k => k in freshVals && k in base && freshVals[k] !== base[k]);
    if (!conflicted.length) return true;                   // their edits touch other fields — clean merge
    return await new Promise((resolve) => {
      const m = modal(`
        <h3>Someone else changed this page</h3>
        <p class="kiln-dim">While you were editing, another editor published changes to
        <strong>${conflicted.map(escapeHtml).join(', ')}</strong> — the same content you're about to publish.
        Publishing now replaces their version with yours.</p>
        <div class="kiln-modal-actions">
          <button class="kiln-btn-ghost" id="kiln-conf-reload">Reload &amp; review (keeps your edits)</button>
          <button class="kiln-btn-publish" id="kiln-conf-mine">Publish mine anyway</button>
        </div>`);
      m.querySelector('#kiln-conf-reload').onclick = () => { savePendingToStorage(); location.reload(); };
      m.querySelector('#kiln-conf-mine').onclick = () => { m.remove(); resolve(true); };
      m.addEventListener('click', (e) => {
        if (e.target === m || e.target.closest('[data-close]')) resolve(false);
      });
    });
  } catch { return true; /* pre-flight is best-effort — publish still merges by key */ }
}

/** Apply shared-partial edits to every page that carries those keys, in one commit. */
async function publishPartials(edits) {
  const branch = cfg.branch || 'main';
  const tree = await state.gh.request('GET',
    `/repos/${cfg.repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
  const htmlFiles = tree.tree.filter(t => t.type === 'blob' && t.path.endsWith('.html')).map(t => t.path).slice(0, 100);
  const changed = [];
  for (const p of htmlFiles) {
    const file = await getFile(state.gh, cfg.repo, p, branch);
    const { html, applied } = applyEdits(file.text, edits);
    if (applied.length) changed.push({ path: p, text: html });
  }
  if (changed.length) {
    await commitFiles(state.gh, cfg.repo, branch, changed,
      `Update shared content on ${changed.length} page${changed.length > 1 ? 's' : ''} (via Kiln)`);
  }
}

// ─── Demo sandbox (cfg.sandbox) ───────────────────────────────────────────────
// A private, local-only editing experience: every visitor is auto-signed-in,
// edits live only in their own browser (never committed, never shared), and the
// whole thing resets after 24h. Nothing one visitor types is ever shown to another.

function sandboxStore() {
  try { return JSON.parse(localStorage.getItem(SANDBOX_KEY)) || {}; } catch (e) { return {}; }
}
function sandboxSave(o) {
  try { localStorage.setItem(SANDBOX_KEY, JSON.stringify(o)); return true; }
  catch (e) { return false; }   // out of local space (e.g. many large images)
}
function sandboxPath() { return (location.pathname.replace(/\/index\.html$/, '/').replace(/\.html$/, '') || '/'); }

function sandboxTTLCheck() {
  const s = sandboxStore();
  if (s._createdAt && Date.now() - s._createdAt > SANDBOX_TTL) localStorage.removeItem(SANDBOX_KEY);
}

/** Apply saved field-level edits (small diffs, not whole pages) to the live DOM. */
function applySandboxEdits(edits) {
  for (const key in edits) {
    const v = edits[key];
    let el = null;
    try { el = document.querySelector('[data-cms="' + key + '"], [data-cms-repeat="' + key + '"], [data-cms-menu="' + key + '"]'); } catch { el = null; }
    if (!el) continue;
    if (v.html !== undefined) el.innerHTML = v.html;
    if (v.attrs) for (const a in v.attrs) el.setAttribute(a, v.attrs[a]);
  }
}

function restoreSandboxPage() {
  const s = sandboxStore();
  const edits = s.pages && s.pages[sandboxPath()];
  if (edits) applySandboxEdits(edits);
}

function publishSandbox() {
  const s = sandboxStore();
  s._createdAt = s._createdAt || Date.now();
  s.pages = s.pages || {};
  const page = s.pages[sandboxPath()] || {};
  for (const [key, v] of state.pending) {
    const cur = page[key] || {};
    if (v.html !== undefined) cur.html = v.html;
    if (v.attrs) cur.attrs = Object.assign(cur.attrs || {}, v.attrs);
    page[key] = cur;
  }
  s.pages[sandboxPath()] = page;
  if (!sandboxSave(s)) {
    setStatus('This demo ran low on local browser space — click "Start over" to reset, or try smaller images.', 'error');
    return;   // keep pending edits so the visitor can retry
  }
  state.pending.clear();
  state.originals.clear();
  document.querySelectorAll('.kiln-modified').forEach(el => el.classList.remove('kiln-modified'));
  refreshPublishButton();
  setStatus('Saved to your private demo. Only you can see this — a real Kiln site commits to GitHub and your host publishes it in about a minute.', 'saved');
}

function renderSandboxBanner() {
  const st = document.createElement('style');
  st.textContent = `
  #kiln-sandbox-banner{position:fixed;left:50%;transform:translateX(-50%);bottom:18px;z-index:2147482000;
    display:flex;align-items:center;gap:13px;background:#1c1c28;color:#fff;border-radius:999px;
    padding:9px 9px 9px 18px;font:13px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
    box-shadow:0 10px 34px rgba(0,0,0,.34);max-width:94vw}
  #kiln-sandbox-banner b{color:#fff}
  #kiln-sandbox-banner button{background:#fff;color:#1c1c28;border:0;border-radius:999px;
    padding:7px 15px;font:600 12px sans-serif;cursor:pointer;white-space:nowrap}
  [data-kiln-sandbox] #kiln-newpost,[data-kiln-sandbox] #kiln-menu,[data-kiln-sandbox] #kiln-pagesettings,
  [data-kiln-sandbox] #kiln-findreplace,[data-kiln-sandbox] #kiln-history,[data-kiln-sandbox] #kiln-signout{display:none!important}`;
  document.head.appendChild(st);
  const b = document.createElement('div');
  b.id = 'kiln-sandbox-banner';
  b.innerHTML = '<span><b>Your private demo.</b> Click any text or image to edit, then hit Publish. Saved only for you; resets in 24h.</span><button id="kiln-sandbox-reset">Start over</button>';
  document.body.appendChild(b);
  b.querySelector('#kiln-sandbox-reset').onclick = () => { localStorage.removeItem(SANDBOX_KEY); location.reload(); };
}

async function initSandbox() {
  injectStyles();
  document.documentElement.setAttribute('data-kiln-sandbox', '1');
  sandboxTTLCheck();
  state.user = 'You';
  restoreSandboxPage();
  // Use the live DOM as the "source" so fields index cleanly and there is no repo fetch.
  state.page = { path: sandboxPath(), text: document.documentElement.outerHTML };
  state.fields = indexHtml(state.page.text);
  renderAdminBar();
  decorateFields();
  renderSandboxBanner();
}

/**
 * Publish verification — by checking REALITY, not deployment metadata.
 * (Hosts skip superseded builds, so a commit's deployment record can hang
 * forever even though the change shipped inside a later build.)
 *
 *   compare — fetch a page and hash-compare against the exact text we committed
 *   url     — a brand-new file's URL starts answering 200
 *
 * Every publish goes into a localStorage journal, so closing a modal — or the
 * whole tab — never strands you: verification resumes on the next page load
 * and announces when the change is confirmed live.
 */
function djb2(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return String(h);
}
const journalKey = () => `kiln_publishing:${cfg.repo}`;
function journalAll() {
  try { return JSON.parse(localStorage.getItem(journalKey())) || []; } catch { return []; }
}
function journalSave(list) {
  try { localStorage.setItem(journalKey(), JSON.stringify(list)); } catch { /* ignore */ }
}
function journalAdd(entry) {
  const list = journalAll().filter(e => e.target !== entry.target);
  list.push({ ...entry, id: Math.random().toString(36).slice(2), started: Date.now() });
  journalSave(list);
  runJournal();
}

let journalTimer = null;
function runJournal() {
  if (journalTimer) return;
  const tick = async () => {
    const list = journalAll();
    if (!list.length) { clearInterval(journalTimer); journalTimer = null; setStatusIdle(); return; }
    const keep = [];
    for (const e of list) {
      let live = false;
      try {
        if (e.type === 'url') {
          live = (await fetch(`${e.target}${e.target.includes('?') ? '&' : '?'}kilncb=${Date.now()}`,
            { method: 'HEAD', cache: 'no-store' })).ok;
        } else {
          const res = await fetch(`${e.target}?kilncb=${Date.now()}`, { cache: 'no-store' });
          live = res.ok && djb2(await res.text()) === e.expect;
        }
      } catch { /* network blip — keep waiting */ }
      if (live) {
        setStatus(`${e.desc} — live ✓`, 'saved');
        if (e.target === location.pathname || e.target === location.pathname + location.search) swapImagePreviews();
      } else if (Date.now() - e.started > 6 * 60 * 1000) {
        setStatus(`${e.desc} — published ✓ (taking longer than usual to appear; it will)`, 'saved');
      } else {
        keep.push(e);
      }
    }
    journalSave(keep);
    if (keep.length) {
      setStatus(`Publishing ${keep.length === 1 ? `“${keep[0].desc}”` : keep.length + ' changes'}… usually under a minute`, 'saving');
    }
  };
  journalTimer = setInterval(tick, 6000);
  tick();
}

function setStatusIdle() {
  setTimeout(() => setStatus(`Signed in as ${state.user}`, 'idle'), 4000);
}

function swapImagePreviews() {
  document.querySelectorAll('img[data-kiln-src]').forEach(img => {
    if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
    img.src = img.getAttribute('data-kiln-src');
    img.removeAttribute('data-kiln-src');
  });
}

/** Compatibility wrapper: page-edit publishes register a compare entry. */
function watchDeploy(_sha, committedText) {
  if (committedText) {
    journalAdd({ type: 'compare', target: location.pathname, expect: djb2(committedText), desc: 'Your page edit' });
  } else {
    setStatus('Published to GitHub ✓', 'saved');
    setStatusIdle();
  }
}

// ─── New post / new page ─────────────────────────────────────────────────────

function newContent() {
  const m = modal(`
    <h3>Create something new</h3>
    <div class="kiln-roles">
      <label class="kiln-role"><input type="radio" name="kiln-new-kind" value="post" checked>
        <span><strong>Blog post</strong><br><small>Appears in the journal automatically.</small></span></label>
      <label class="kiln-role"><input type="radio" name="kiln-new-kind" value="page">
        <span><strong>Page</strong><br><small>A standalone page (e.g. /services.html). Add it to the menu afterwards.</small></span></label>
    </div>
    <label>Title <input type="text" id="kiln-np-title" placeholder="What's it called?"></label>
    <div class="kiln-modal-actions">
      <button class="kiln-btn-ghost" data-close>Cancel</button>
      <button class="kiln-btn-publish" id="kiln-np-go">Create</button>
    </div>`);
  m.querySelector('#kiln-np-go').onclick = async () => {
    const title = m.querySelector('#kiln-np-title').value.trim();
    const kind = m.querySelector('input[name="kiln-new-kind"]:checked').value;
    if (!title) return;
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || kind;
    const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const root = cfg.root ? cfg.root.replace(/\/+$/, '') + '/' : '';
    const branch = cfg.branch || 'main';
    const href = kind === 'post' ? `/blog/${slug}.html` : `/${slug}.html`;
    const body = m.querySelector('.kiln-modal-body');
    body.innerHTML = `<h3>Publishing “${escapeHtml(title)}”</h3>
      <p class="kiln-np-step" id="kiln-np-status">Committing to GitHub…</p>
      <div class="kiln-modal-actions">
        <button class="kiln-btn-ghost" data-close>Close</button>
        <button class="kiln-btn-publish" id="kiln-np-open" disabled>Open it →</button>
      </div>`;
    const status = body.querySelector('#kiln-np-status');
    const openBtn = body.querySelector('#kiln-np-open');
    try {
      const filePath = root + href.slice(1);
      const exists = await getFile(state.gh, cfg.repo, filePath, branch).catch(err => {
        if (err.status === 404) return null;
        throw err;
      });
      if (exists) throw new Error(`${href} already exists — pick a different title`);

      const files = [];
      if (kind === 'post') {
        const tpl = await getFile(state.gh, cfg.repo, root + '_templates/post.html', branch);
        const cardTpl = await getFile(state.gh, cfg.repo, root + '_templates/post-card.html', branch);
        const blogIndex = await getFile(state.gh, cfg.repo, root + 'blog/index.html', branch);
        const postHtml = applyEdits(tpl.text, [
          { key: 'post_title', html: escapeHtml(title) },
          { key: 'post_date', html: escapeHtml(date) },
        ]).html.replaceAll('{{title}}', escapeHtml(title));
        const card = cardTpl.text
          .replaceAll('{{title}}', escapeHtml(title))
          .replaceAll('{{href}}', href)
          .replaceAll('{{date}}', escapeHtml(date));
        const newIndex = applyEdits(blogIndex.text, [{ key: 'post_list', prepend: '\n      ' + card.trim() }]);
        if (!newIndex.applied.length) throw new Error('blog/index.html needs a data-cms-list="post_list" container');
        files.push({ path: filePath, text: postHtml }, { path: root + 'blog/index.html', text: newIndex.html });
      } else {
        const tpl = await getFile(state.gh, cfg.repo, root + '_templates/page.html', branch);
        const pageHtml = applyEdits(tpl.text, [
          { key: 'page_title', html: escapeHtml(title) },
        ]).html.replaceAll('{{title}}', escapeHtml(title));
        files.push({ path: filePath, text: pageHtml });
      }

      const commit = await commitFiles(state.gh, cfg.repo, branch, files,
        `New ${kind}: ${title} (via Kiln)`);

      journalAdd({ type: 'url', target: href, desc: `New ${kind} “${title}”` });
      status.innerHTML = `Committed ✓ — the site is rebuilding (usually under a minute).<br>
        <small>Safe to close this window: Kiln keeps watching in the background and the link below
        starts working the moment the ${kind} is live${kind === 'page' ? ' — then add it to your navigation via <strong>Site menu</strong>' : ''}.</small>`;
      const started = Date.now();
      const poll = async () => {
        if (!document.body.contains(m)) return;
        try {
          const r = await fetch(`${href}?kilncb=${Date.now()}`, { method: 'HEAD', cache: 'no-store' });
          if (r.ok) {
            status.innerHTML = `<strong>Live ✓</strong> — open it and click into the text to write.${
              kind === 'page' ? ' Then add it to your navigation via <strong>Site menu</strong>.' : ''}`;
            openBtn.disabled = false;
            openBtn.onclick = () => { window.location.assign(href); };
            return;
          }
        } catch { /* keep polling */ }
        if (Date.now() - started > 5 * 60 * 1000) {
          status.textContent = 'Still building — Kiln keeps watching in the background. The page WILL appear; check the journal/menu in a minute.';
          return;
        }
        setTimeout(poll, 5000);
      };
      poll();
    } catch (err) {
      console.error('[kiln] new', kind, err);
      status.textContent = err.status === 404
        ? `This site has no ${kind} template (_templates/${kind}.html) — see the docs.`
        : `Failed: ${err.message}`;
    }
  };
}

// ─── Menu editor ─────────────────────────────────────────────────────────────

function menuEditor() {
  const menuField = [...state.fields.fields.values()].find(f => f.kind === 'menu');
  if (!menuField) {
    modal(`<h3>No editable menu</h3>
      <p class="kiln-dim">This page's navigation isn't marked with <code>data-cms-menu</code>,
      so Kiln can't manage it. See the docs to enable menu editing.</p>
      <div class="kiln-modal-actions"><button class="kiln-btn-ghost" data-close>Close</button></div>`);
    return;
  }
  // Parse the current items from this page's source.
  const innerHtml = state.page.text.slice(menuField.inner.start, menuField.inner.end);
  const docFrag = new DOMParser().parseFromString(innerHtml, 'text/html');
  let rows = [...docFrag.querySelectorAll('a')].map(a => ({
    label: a.textContent.trim(), href: a.getAttribute('href') || '/',
  }));
  // Preserve the item wrapper (e.g. <ul><li><a>) so list-based navs keep their
  // markup instead of being flattened to bare <a> on the next menu edit.
  const anchors = [...docFrag.querySelectorAll('a')];
  const itemTag = anchors.length && anchors.every(a => a.parentElement && a.parentElement.tagName === 'LI')
    ? 'li' : null;

  const m = modal(`
    <h3>Site menu</h3>
    <p class="kiln-dim">Changes apply to <strong>every page</strong> of the site (and to the
    templates, so new pages get the updated menu) in one commit.</p>
    <div id="kiln-menu-rows"></div>
    <button class="kiln-btn-ghost" id="kiln-menu-add">+ Add menu item</button>
    <div class="kiln-modal-actions">
      <button class="kiln-btn-ghost" data-close>Cancel</button>
      <button class="kiln-btn-publish" id="kiln-menu-save">Save to all pages</button>
    </div>
    <p class="kiln-np-step" id="kiln-menu-status"></p>`);

  const rowsEl = m.querySelector('#kiln-menu-rows');
  function render() {
    rowsEl.innerHTML = '';
    rows.forEach((row, i) => {
      const div = document.createElement('div');
      div.className = 'kiln-menu-row';
      div.innerHTML = `
        <input type="text" class="kiln-menu-label" value="${escapeHtml(row.label)}" placeholder="Label">
        <input type="text" class="kiln-menu-href" value="${escapeHtml(row.href)}" placeholder="/page.html">
        <button title="Move up">↑</button><button title="Move down">↓</button><button title="Remove">✕</button>`;
      const [up, down, del] = div.querySelectorAll('button');
      div.querySelector('.kiln-menu-label').oninput = (e) => { rows[i].label = e.target.value; };
      div.querySelector('.kiln-menu-href').oninput = (e) => { rows[i].href = e.target.value; };
      up.onclick = () => { if (i > 0) { [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]]; render(); } };
      down.onclick = () => { if (i < rows.length - 1) { [rows[i + 1], rows[i]] = [rows[i], rows[i + 1]]; render(); } };
      del.onclick = () => { rows.splice(i, 1); render(); };
      rowsEl.appendChild(div);
    });
  }
  render();
  m.querySelector('#kiln-menu-add').onclick = () => { rows.push({ label: 'New item', href: '/' }); render(); };

  m.querySelector('#kiln-menu-save').onclick = async () => {
    const status = m.querySelector('#kiln-menu-status');
    const menuKey = menuField.key;
    const wrap = (a) => itemTag ? `<${itemTag}>${a}</${itemTag}>` : a;
    const newInner = '\n      ' + rows
      .filter(r => r.label.trim())
      // safeUrl() the href before it's spliced: menu inner-HTML bypasses DOMPurify,
      // and escapeHtml alone doesn't neutralize javascript:/data: schemes, so an
      // editor could otherwise plant script on every page's nav. (safeUrl mirrors
      // the engine's own href gate.)
      .map(r => wrap(`<a href="${escapeHtml(safeUrl(r.href.trim() || '/'))}">${escapeHtml(r.label.trim())}</a>`))
      .join('\n      ') + '\n    ';
    try {
      status.textContent = 'Step 1 of 3 · Finding the site’s pages…';
      const branch = cfg.branch || 'main';
      const tree = await state.gh.request('GET',
        `/repos/${cfg.repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
      const htmlFiles = tree.tree
        .filter(t => t.type === 'blob' && t.path.endsWith('.html'))
        .map(t => t.path)
        .slice(0, 100);

      const changed = [];
      let skippedPages = 0;
      for (let i = 0; i < htmlFiles.length; i++) {
        status.textContent = `Updating menus… ${i + 1}/${htmlFiles.length}`;
        const file = await getFile(state.gh, cfg.repo, htmlFiles[i], branch);
        const result = applyEdits(file.text, [{ key: menuKey, html: newInner }]);
        if (result.applied.length) changed.push({ path: htmlFiles[i], text: result.html });
        else skippedPages++;
      }
      if (!changed.length) throw new Error('no pages have a matching data-cms-menu container');

      status.textContent = `Committing ${changed.length} page${changed.length > 1 ? 's' : ''} as one change…`;
      const commit = await commitFiles(state.gh, cfg.repo, branch, changed,
        `Update menu on ${changed.length} pages (via Kiln)`);
      const thisPage = changed.find(c => c.path === state.page.path);
      if (thisPage) journalAdd({ type: 'compare', target: location.pathname, expect: djb2(thisPage.text), desc: 'Menu update' });
      status.innerHTML = `Step 2 of 3 · Committed ✓ — the site is rebuilding.
        ${skippedPages ? skippedPages + ' page(s) had no managed menu and were left alone.' : ''}<br>
        <small><strong>Safe to close this window</strong> — Kiln keeps watching in the background and
        will say “Menu update — live ✓” by the Kiln button when it's done.</small>`;
      const started = Date.now();
      const poll = async () => {
        if (!document.body.contains(m)) return;
        try {
          const res = await fetch(`${location.pathname}?kilncb=${Date.now()}`, { cache: 'no-store' });
          if (thisPage && res.ok && djb2(await res.text()) === djb2(thisPage.text)) {
            status.innerHTML = 'Step 3 of 3 · <strong>Menu is live on every page ✓</strong>';
            const actions = m.querySelector('.kiln-modal-actions');
            actions.innerHTML = '<button class="kiln-btn-publish" id="kiln-menu-reload">Reload to see it</button>';
            actions.querySelector('#kiln-menu-reload').onclick = () => location.reload();
            return;
          }
        } catch { /* keep polling */ }
        if (Date.now() - started > 5 * 60 * 1000) { status.textContent = 'Still building — watching continues in the background. Safe to close.'; return; }
        setTimeout(poll, 5000);
      };
      poll();
    } catch (err) {
      console.error('[kiln] menu', err);
      status.textContent = `Failed: ${err.message}`;
    }
  };
}

// ─── People & access (admin only) ────────────────────────────────────────────

// Pull the editable sections out of a page's raw HTML (data-cms / -repeat / -menu),
// each with a short text snippet so admins can tell WHAT a key like "hiw2_body" is.
// DOMParser doesn't execute scripts, so parsing repo HTML here is inert.
function extractSections(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out = [], seen = new Set();
  doc.querySelectorAll('[data-cms],[data-cms-repeat],[data-cms-menu]').forEach(el => {
    const key = el.getAttribute('data-cms') || el.getAttribute('data-cms-repeat') || el.getAttribute('data-cms-menu');
    if (!key || seen.has(key)) return;
    seen.add(key);
    let snippet = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 44);
    if (!snippet && el.tagName === 'IMG') snippet = el.getAttribute('alt') || '(image)';
    out.push({ key, snippet });
  });
  return out;
}

// The site's .html pages, cached per panel-open. Folders in the scope expand to the
// pages they contain so "Choose sections" can group by real page.
let _sitePagesCache = null;
async function listSitePages() {
  if (_sitePagesCache) return _sitePagesCache;
  const tree = await state.gh.request('GET',
    `/repos/${cfg.repo}/git/trees/${encodeURIComponent(cfg.branch || 'main')}?recursive=1`);
  _sitePagesCache = tree.tree.filter(t => t.type === 'blob' && t.path.endsWith('.html')
    && !t.path.startsWith('_templates/')).map(t => t.path);
  return _sitePagesCache;
}

async function invitePanel() {
  _sitePagesCache = null;   // fresh each time the panel opens
  const m = modal(`
    <h3>People &amp; access</h3>
    <p class="kiln-dim" id="kiln-gstatus">Checking Google sign-in…</p>
    <div id="kiln-people-form" style="display:none">
      <label>Google email <input type="email" id="kiln-p-email" placeholder="them@gmail.com"></label>
      <div class="kiln-2col">
        <label>Name <input type="text" id="kiln-p-name" placeholder="Claudia"></label>
        <label>Access (days) <input type="number" id="kiln-p-days" value="90" min="1" max="360"></label>
      </div>
      <label style="font-weight:normal;display:inline-flex;gap:6px;align-items:center;margin:2px 0 4px"><input type="checkbox" id="kiln-p-never"> Never expires (indefinite access)</label>
      <div class="kiln-roles">
        <label class="kiln-role"><input type="radio" name="kiln-p-role" value="editor" checked>
          <span><strong>Editor</strong><br><small>Edits pages, images, posts. Signs in with their Google account.</small></span></label>
        <label class="kiln-role"><input type="radio" name="kiln-p-role" value="member">
          <span><strong>Member</strong><br><small>Views the members-only area and documents. Cannot edit.</small></span></label>
      </div>
      <label id="kiln-p-paths-wrap">Pages this editor can edit
        <input type="text" id="kiln-p-paths" placeholder="whole site — or e.g. blog, about.html"></label>
      <p class="kiln-dim" id="kiln-p-paths-hint" style="margin:-2px 0 6px;font-size:12px">Comma-separated folders or files they may edit. Leave blank for the whole site.
        <button type="button" class="kiln-btn-pick" id="kiln-p-pick" aria-expanded="false">▾ Choose pages</button><br>
        Editors can never touch CNAME, _redirects, or .github.</p>
      <div id="kiln-p-pages" class="kiln-pick-box" style="display:none"></div>
      <label id="kiln-p-keys-wrap">Sections they can edit (optional)
        <input type="text" id="kiln-p-keys" placeholder="everything — or pick sections below"></label>
      <p class="kiln-dim" id="kiln-p-keys-hint" style="margin:-2px 0 6px;font-size:12px">Leave blank for every section of the pages above. Sections are grouped by page.
        <button type="button" class="kiln-btn-pick" id="kiln-p-keypick" aria-expanded="false">▾ Choose sections</button></p>
      <div id="kiln-p-keylist" class="kiln-pick-box" style="display:none"></div>
      <div id="kiln-p-feat-wrap">
        <label style="margin-bottom:2px">Tools this editor can use</label>
        <div id="kiln-p-features" style="display:grid;grid-template-columns:1fr 1fr;gap:4px 12px;margin:2px 0 8px"></div>
        <p class="kiln-dim" style="margin:-2px 0 6px;font-size:12px">Editing text and images is always allowed. People &amp; access and site Settings stay owner-only.</p>
      </div>
      <div class="kiln-modal-actions" style="justify-content:flex-start;margin-top:8px">
        <button class="kiln-btn-publish" id="kiln-p-add">Add person</button>
      </div>
      <div id="kiln-people-list" class="kiln-inv-list" style="margin-top:10px">Loading…</div>
    </div>
    <div class="kiln-modal-actions"><button class="kiln-btn-ghost" data-close>Close</button></div>`);

  const admin = () => JSON.parse(localStorage.getItem(ADMIN_KEY));

  // Feature checkboxes (which menu tools an editor may use). Defaults on: the
  // low-risk content tools; off: site-wide/structural tools.
  const FEATURES = [
    { v: 'pagesettings', label: 'Page settings', def: true },
    { v: 'history', label: 'History & restore', def: true },
    { v: 'draft', label: 'Save drafts', def: true },
    { v: 'newpost', label: 'New posts & pages', def: false },
    { v: 'schedule', label: 'Schedule publishing', def: false },
    { v: 'menu', label: 'Edit site menu', def: false },
    { v: 'findreplace', label: 'Find & replace', def: false },
    { v: 'makeeditable', label: 'Make things editable', def: false },
  ];
  m.querySelector('#kiln-p-features').innerHTML = FEATURES.map(f =>
    `<label style="font-weight:normal;display:inline-flex;gap:6px;align-items:center;font-size:12.5px;margin:0">
      <input type="checkbox" class="kiln-p-feat" value="${f.v}" ${f.def ? 'checked' : ''}> ${escapeHtml(f.label)}</label>`).join('');

  // Show the scope fields only when adding an editor.
  const scopeEls = ['#kiln-p-paths-wrap', '#kiln-p-paths-hint', '#kiln-p-keys-wrap', '#kiln-p-keys-hint', '#kiln-p-feat-wrap']
    .map(s => m.querySelector(s));
  function syncRole() {
    const isEditor = m.querySelector('input[name="kiln-p-role"]:checked').value === 'editor';
    scopeEls.forEach(el => { el.style.display = isEditor ? '' : 'none'; });
    if (!isEditor) { m.querySelector('#kiln-p-pages').style.display = 'none'; m.querySelector('#kiln-p-keylist').style.display = 'none'; }
    else if (m.querySelector('#kiln-p-pages').style.display === 'none') m.querySelector('#kiln-p-pick').click();  // auto-open the page checklist
  }

  // "Choose sections" — checklist of editable fields, GROUPED BY PAGE. Pulls the
  // pages the editor is scoped to (or the whole site if unscoped) and lists each
  // page's sections under its own heading, plus a "whole page" catch-all per page.
  const keyPickBtn = m.querySelector('#kiln-p-keypick');
  keyPickBtn.onclick = async (e) => {
    e.preventDefault();
    const box = m.querySelector('#kiln-p-keylist');
    if (box.style.display !== 'none') { box.style.display = 'none'; keyPickBtn.setAttribute('aria-expanded', 'false'); return; }
    box.style.display = ''; keyPickBtn.setAttribute('aria-expanded', 'true');
    const input = m.querySelector('#kiln-p-keys');
    const selected = () => new Set(input.value.split(',').map(s => s.trim()).filter(Boolean));
    const writeBack = (v, on) => { const cur = selected(); if (on) cur.add(v); else cur.delete(v); input.value = [...cur].join(', '); };

    box.innerHTML = '<p class="kiln-dim" style="margin:6px 2px">Loading sections…</p>';
    // Resolve which pages to show sections for, honoring the page scope (folders expand).
    let pages;
    try {
      const scope = m.querySelector('#kiln-p-paths').value.split(',').map(s => s.trim()).filter(Boolean);
      if (!scope.length) {
        pages = await listSitePages();
      } else {
        const all = await listSitePages();
        pages = [];
        for (const s of scope) {
          if (s.endsWith('.html')) { if (!pages.includes(s)) pages.push(s); }
          else all.filter(p => p === s || p.startsWith(s.replace(/\/$/, '') + '/')).forEach(p => { if (!pages.includes(p)) pages.push(p); });
        }
        if (!pages.includes(state.page.path)) pages.unshift(state.page.path);
      }
    } catch { pages = [state.page.path]; }
    pages = pages.slice(0, 25);

    // Fetch each page's sections+snippets (current page parses its own source — no round-trip).
    const groups = [];
    for (const path of pages) {
      if (path === state.page.path) { groups.push({ path, sections: extractSections(state.page.text) }); continue; }
      try { const f = await getFile(state.gh, cfg.repo, path, cfg.branch || 'main'); groups.push({ path, sections: extractSections(f.text) }); }
      catch { groups.push({ path, sections: [], err: true }); }
    }

    box.innerHTML = '';
    let any = false;
    for (const g of groups) {
      const head = document.createElement('div');
      head.className = 'kiln-pick-group';
      head.textContent = g.path + (g.path === state.page.path ? '  · this page' : '');
      box.appendChild(head);
      if (g.err) { const p = document.createElement('p'); p.className = 'kiln-dim'; p.style.margin = '2px'; p.textContent = "Couldn't load this page."; box.appendChild(p); continue; }
      if (!g.sections.length) { const p = document.createElement('p'); p.className = 'kiln-dim'; p.style.margin = '2px'; p.textContent = 'No named sections.'; box.appendChild(p); continue; }
      any = true;
      const prefixes = [...new Set(g.sections.map(s => (s.key.match(/^[a-z0-9]+_/i) || [])[0]).filter(Boolean))];
      const opts = [
        ...prefixes.map(p => ({ v: p, label: `${p}∗`, snippet: `everything starting “${p}”` })),
        ...g.sections.map(s => ({ v: s.key, label: s.key, snippet: s.snippet })),
      ];
      for (const o of opts) {
        const row = document.createElement('label');
        row.style.cssText = 'display:flex;gap:8px;align-items:baseline;font-size:12.5px;margin:0;padding:4px 2px';
        row.innerHTML = `<input type="checkbox" value="${escapeHtml(o.v)}" ${selected().has(o.v) ? 'checked' : ''} style="flex:none;align-self:center">
          <span style="flex:none;font-weight:600">${escapeHtml(o.label)}</span>
          ${o.snippet ? `<span class="kiln-dim" style="margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">“${escapeHtml(o.snippet)}${o.snippet.length >= 44 ? '…' : ''}”</span>` : ''}`;
        row.querySelector('input').onchange = (ev) => writeBack(o.v, ev.target.checked);
        box.appendChild(row);
      }
    }
    if (!any && !groups.some(g => g.sections.length)) box.innerHTML = '<p class="kiln-dim" style="margin:6px 2px">These pages have no named sections yet.</p>';
  };

  // "Choose pages" — checkbox list of the site's pages/folders, written back
  // into the comma-separated paths field (which stays hand-editable).
  const pagePickBtn = m.querySelector('#kiln-p-pick');
  pagePickBtn.onclick = async (e) => {
    e.preventDefault();
    const box = m.querySelector('#kiln-p-pages');
    if (box.style.display !== 'none') { box.style.display = 'none'; pagePickBtn.setAttribute('aria-expanded', 'false'); return; }
    box.style.display = ''; pagePickBtn.setAttribute('aria-expanded', 'true');
    box.innerHTML = '<p class="kiln-dim" style="margin:6px 2px">Loading pages…</p>';
    try {
      const pages = (await listSitePages()).slice(0, 100);
      const dirs = [...new Set(pages.filter(p => p.includes('/')).map(p => p.split('/')[0]))];
      const options = [...dirs.map(d => ({ v: d, label: `${d}/ (folder)` })), ...pages.map(p => ({ v: p, label: p }))];
      const input = m.querySelector('#kiln-p-paths');
      const selected = () => new Set(input.value.split(',').map(s => s.trim()).filter(Boolean));
      box.innerHTML = '';
      for (const o of options) {
        const row = document.createElement('label');
        row.style.cssText = 'display:flex;gap:8px;align-items:center;font-size:12.5px;margin:0;padding:4px 2px';
        row.innerHTML = `<input type="checkbox" value="${escapeHtml(o.v)}" ${selected().has(o.v) ? 'checked' : ''}> ${escapeHtml(o.label)}`;
        row.querySelector('input').onchange = (ev) => {
          const cur = selected();
          if (ev.target.checked) cur.add(o.v); else cur.delete(o.v);
          input.value = [...cur].join(', ');
        };
        box.appendChild(row);
      }
    } catch (err) {
      box.innerHTML = `<p class="kiln-dim" style="margin:6px 2px">Couldn't load the page list: ${escapeHtml(err.message)}</p>`;
    }
  };
  m.querySelectorAll('input[name="kiln-p-role"]').forEach(r => r.addEventListener('change', syncRole));
  syncRole();

  // "Never expires" disables the days field; the add handler then sends days:0 (indefinite).
  const neverCb = m.querySelector('#kiln-p-never');
  const daysInput = m.querySelector('#kiln-p-days');
  neverCb.addEventListener('change', () => { daysInput.disabled = neverCb.checked; });

  async function refreshPeople() {
    const status = m.querySelector('#kiln-gstatus');
    const form = m.querySelector('#kiln-people-form');
    try {
      const res = await fetch(`${cfg.worker}/admin/people?repo=${encodeURIComponent(cfg.repo)}`, {
        headers: { Authorization: `Bearer ${admin().token}` },
      });
      const data = await res.json();
      if (!data.googleConfigured) {
        status.innerHTML = 'To invite editors and members, add Google sign-in to your auth worker: set '
          + '<code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> (see the README). '
          + 'People then sign in with their own Google account — no passwords, no links.';
        form.style.display = 'none';
        return;
      }
      status.textContent = 'People here sign in with their Google account. Removing someone revokes their access immediately, including any active session.';
      form.style.display = '';
      const list = m.querySelector('#kiln-people-list');
      list.innerHTML = (data.people || []).length ? '' : '<p class="kiln-dim">Nobody yet — add the first person above.</p>';
      for (const p of data.people || []) {
        const realPaths = (p.paths || []).filter(x => x && x !== '' && x !== '**');
        const keyScope = (p.keys || []).length ? ` · sections: ${p.keys.join(', ')}` : '';
        const scope = p.role === 'editor' ? ((realPaths.length ? realPaths.join(', ') : 'whole site') + keyScope) : '';
        const row = document.createElement('div');
        row.className = 'kiln-inv-row';
        row.innerHTML = `<span><strong>${escapeHtml(p.name)}</strong>
          <small>${escapeHtml(p.email)} · ${escapeHtml(p.role)}${scope ? ' · ' + escapeHtml(scope) : ''} · ${p.days ? p.days + 'd' : 'never expires'}</small></span>
          <button class="kiln-btn-ghost">Remove</button>`;
        row.querySelector('button').onclick = async () => {
          await fetch(`${cfg.worker}/admin/people/remove`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin().token}` },
            body: JSON.stringify({ repo: cfg.repo, email: p.email }),
          });
          refreshPeople();
        };
        list.appendChild(row);
      }
    } catch {
      status.textContent = 'Could not reach the auth worker.';
    }
  }
  refreshPeople();

  m.querySelector('#kiln-p-add').onclick = async () => {
    const email = m.querySelector('#kiln-p-email').value.trim();
    const name = m.querySelector('#kiln-p-name').value.trim();
    const days = m.querySelector('#kiln-p-never').checked ? 0 : m.querySelector('#kiln-p-days').value;
    const role = m.querySelector('input[name="kiln-p-role"]:checked').value;
    const paths = m.querySelector('#kiln-p-paths').value.trim();
    const keys = m.querySelector('#kiln-p-keys').value.trim();
    const features = [...m.querySelectorAll('.kiln-p-feat:checked')].map(c => c.value);
    if (!email) return;
    const res = await fetch(`${cfg.worker}/admin/people`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin().token}` },
      body: JSON.stringify({ repo: cfg.repo, email, name, role, days, paths, keys, features }),
    });
    const data = await res.json();
    if (data.ok) {
      m.querySelector('#kiln-p-email').value = '';
      m.querySelector('#kiln-p-name').value = '';
      m.querySelector('#kiln-p-paths').value = '';
      m.querySelector('#kiln-p-keys').value = '';
      refreshPeople();
    }
  };
}

// ─── History (per-page restore points) ───────────────────────────────────────

const histCache = new Map();   // sha → file text (avoid re-fetching per field/commit)
async function histFile(sha) {
  if (!histCache.has(sha)) histCache.set(sha, (await getFile(state.gh, cfg.repo, state.page.path, sha)).text);
  return histCache.get(sha);
}

/** "hero_headline" → "hero headline"; strips leading +/- and generated suffixes. */
function humanizeKey(k) {
  if (k === undefined || k === null || k === 'undefined') return 'a section';
  return String(k).replace(/^[+-]/, '').replace(/_[a-z0-9]{5,}$/i, '').replace(/[_-]+/g, ' ').trim() || k;
}

/** Turn a commit message into something a layperson can read in a history list. */
function describeCommit(msg) {
  const first = String(msg).split('\n')[0];
  let m;
  if ((m = first.match(/^Edit [^:]+: (.+?) \(via Kiln\)$/))) {
    const keys = [...new Set(m[1].split(', ').map(humanizeKey))];
    return 'Edited ' + keys.slice(0, 3).join(', ') + (keys.length > 3 ? ` and ${keys.length - 3} more` : '');
  }
  if ((m = first.match(/^Upload (\d+) file/))) return `Added ${m[1]} photo${+m[1] > 1 ? 's' : ''} or file${+m[1] > 1 ? 's' : ''}`;
  if (/^(Undo|Restore) .*\(via Kiln\)$/.test(first)) return 'Went back to an earlier version';
  if (/^Publish draft/.test(first)) return 'Published a saved draft';
  if (/^Publish scheduled/.test(first)) return 'A scheduled publish went live';
  return first.slice(0, 64);
}

/** The value a key currently has on the page (staged edit wins over live source). */
function currentValueFor(key, sourceVals) {
  const pend = state.pending.get(key);
  if (pend?.html !== undefined) return pend.html;
  return sourceVals[key];
}

/** A key's current DOM content, cleaned the way staging would write it. */
function currentDomHtmlFor(key) {
  const esc = CSS.escape(key);
  const rep = document.querySelector(`[data-cms-repeat="${esc}"]`);
  if (rep) return containerCleanHtml(rep).innerHTML;
  return document.querySelector(`[data-cms="${esc}"]`)?.innerHTML;
}

/**
 * Apply a set of {key, value} changes to the LIVE page as a preview, with a
 * floating Keep/Cancel bar. Keep stages them as normal pending edits (published
 * with the Publish button, undoable with ⌘Z); Cancel puts everything back.
 * Nothing touches GitHub here.
 */
function previewRestore(changes, label, note, removals = []) {
  document.getElementById('kiln-previewbar')?.remove();
  const applied = [];
  for (const { key, value } of changes) {
    const before = currentDomHtmlFor(key);
    if (before === undefined) continue;              // section not on this page
    const el = applyKeyDom(key, value);
    if (!el) continue;
    el.classList.add('kiln-modified', 'kiln-flash');
    setTimeout(() => el.classList.remove('kiln-flash'), 1600);
    applied.push({ key, value, before, el });
  }
  // Sections that must DISAPPEAR for this restore (e.g. a gallery that publish
  // added): preview by hiding; Keep stages a removeSection op.
  const removed = [];
  const seenNodes = new Set();
  for (const key of removals) {
    const esc = CSS.escape(key);
    const el = document.querySelector(`[data-cms-repeat="${esc}"], [data-cms="${esc}"]`);
    const sec = el?.closest('.kiln-added') || (el?.hasAttribute('data-cms-repeat') ? el : null);
    if (!sec || seenNodes.has(sec)) continue;
    seenNodes.add(sec);
    const repKey = sec.querySelector('[data-cms-repeat]')?.getAttribute('data-cms-repeat')
      || sec.getAttribute('data-cms-repeat') || key;
    sec.style.display = 'none';
    removed.push({ node: sec, key: repKey });
  }
  if (!applied.length && !removed.length) return 0;
  (applied[0]?.el || removed[0]?.node.previousElementSibling || document.body)
    .scrollIntoView({ behavior: 'smooth', block: 'center' });
  const bar = document.createElement('div');
  bar.id = 'kiln-previewbar';
  const nChanged = applied.length + removed.length;
  bar.innerHTML = `<span><strong>Previewing:</strong> ${label} — ${nChanged} section${nChanged > 1 ? 's' : ''} changed${removed.length ? ` (${removed.length} removed)` : ''}.
    ${note ? `<small>${note}</small>` : ''} <small>Nothing is live yet.</small></span>
    <button class="kiln-btn-ghost" id="kiln-pv-cancel">Cancel</button>
    <button class="kiln-btn-publish" id="kiln-pv-keep">Keep — then Publish</button>`;
  document.body.appendChild(bar);
  bar.querySelector('#kiln-pv-keep').onclick = () => {
    undoGroup(() => {
      for (const a of applied) stagePending(a.key, { html: a.value });
      for (const r of removed) {
        const parent = r.node.parentElement, next = r.node.nextSibling;
        const op = cfg.sandbox ? null : { op: 'removeSection', key: r.key };
        if (op) state.pendingStructural.push(op);
        r.node.style.display = '';
        r.node.remove();
        undoBucket.steps.push({ structural: { node: r.node, op, html: null, removed: true,
          place: () => parent.insertBefore(r.node, next) } });
      }
    });
    refreshPublishButton();
    bar.remove();
    setStatus(`Kept ${applied.length + removed.length} restored section${applied.length + removed.length > 1 ? 's' : ''} — hit Publish to make it live (⌘Z undoes)`, 'saved');
  };
  bar.querySelector('#kiln-pv-cancel').onclick = () => {
    for (const a of applied) {
      applyKeyDom(a.key, a.before);
      if (!state.pending.has(a.key)) {
        const esc = CSS.escape(a.key);
        document.querySelectorAll(`[data-cms="${esc}"],[data-cms-repeat="${esc}"]`).forEach(n => n.classList.remove('kiln-modified'));
      }
    }
    for (const r of removed) r.node.style.display = '';
    bar.remove();
    setStatus('Preview cancelled — the page is back to how it was', 'idle');
  };
  return applied.length + removed.length;
}

async function historyPanel() {
  const m = modal(`
    <h3>Page history</h3>
    <p class="kiln-dim">Every publish saves a version of this page. <strong>Undo this change</strong> takes
    back just what that publish changed; <strong>Go back to this</strong> returns the whole page to how it
    was then. Both only <em>preview</em> the result on the page first — nothing changes on the live site
    until you hit Publish. (For one section's history, click into it and press its ${'↻'} clock button.)</p>
    <div id="kiln-hist" class="kiln-inv-list">Loading…</div>
    <p class="kiln-np-step" id="kiln-hist-status"></p>`);
  const status = m.querySelector('#kiln-hist-status');

  if (cfg.sandbox) {
    m.querySelector('#kiln-hist').innerHTML =
      '<p class="kiln-dim">The demo doesn’t keep saved versions — a real Kiln site saves one on every publish. Use ⌘Z to undo your edits here.</p>';
    return;
  }

  let commits = [];
  try {
    commits = await state.gh.request('GET',
      `/repos/${cfg.repo}/commits?path=${encodeURIComponent(state.page.path)}&per_page=20`);
  } catch (err) { status.textContent = `Could not load history: ${err.message}`; return; }

  const list = m.querySelector('#kiln-hist');
  list.innerHTML = commits.length ? '' : '<p class="kiln-dim">No saved versions yet — they appear after your first publish.</p>';
  const spin = (msg) => { status.innerHTML = `<span class="kiln-spin"></span> ${msg}`; };

  // Undo ONE publish: put back the sections it changed, leave everything since.
  const undoCommit = async (c) => {
    const parentSha = c.parents?.[0]?.sha;
    if (!parentSha) { status.textContent = 'This is the very first version — there’s nothing before it to go back to.'; return; }
    spin('Comparing with the version before it…');
    const before = readValues(await histFile(parentSha));
    const after = readValues(await histFile(c.sha));
    const changes = [], removals = [];
    for (const key of Object.keys(after)) {
      if (before[key] === undefined) { removals.push(key); continue; }   // that publish ADDED this — undo = remove it
      if (before[key] !== after[key]) changes.push({ key, value: before[key] });
    }
    const n = previewRestore(changes, `undo “${escapeHtml(describeCommit(c.commit.message))}”`, '', removals);
    if (n) m.remove();
    else status.textContent = changes.length || removals.length
      ? 'Those sections aren’t on this page anymore, so there’s nothing to put back.'
      : 'That publish didn’t change any section content on this page (it may have been photos or layout).';
  };

  // Whole-page: every section back to how it was at that version.
  const restoreVersion = async (c, when) => {
    spin('Reading that version…');
    const vals = readValues(await histFile(c.sha));
    const curVals = readValues(state.page.text);
    const changes = [], removals = [];
    for (const [key, value] of Object.entries(vals)) {
      if (currentValueFor(key, curVals) !== value) changes.push({ key, value });
    }
    let gone = 0;
    for (const key of Object.keys(curVals)) {
      if (vals[key] !== undefined) continue;
      // Kiln-added sections (galleries/events) get removed with the restore;
      // anything else that merely wasn't annotated back then stays as it is.
      const el = document.querySelector(`[data-cms-repeat="${CSS.escape(key)}"], [data-cms="${CSS.escape(key)}"]`);
      if (el?.closest('.kiln-added')) removals.push(key); else gone++;
    }
    const note = gone ? `${gone} section${gone > 1 ? 's' : ''} added since then stay as they are.` : '';
    const n = previewRestore(changes, `the page as it was ${escapeHtml(when)}`, note, removals);
    if (n) m.remove();
    else status.textContent = 'The page already matches that version.';
  };

  commits.forEach((c, i) => {
    const div = document.createElement('div');
    div.className = 'kiln-inv-row kiln-hist-row';
    const when = new Date(c.commit.author.date).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    div.innerHTML = `<span><strong>${escapeHtml(describeCommit(c.commit.message))}</strong>
      <small>${i === 0 ? '<b class="kiln-hist-live">live now</b> · ' : ''}${when} · ${escapeHtml(c.commit.author.name)}</small></span>
      <span class="kiln-hist-acts">
        <button class="kiln-btn-ghost" data-act="undo" title="Put back just what this publish changed">${UNDO_ICON} Undo this change</button>
        ${i === 0 ? '' : '<button class="kiln-btn-ghost" data-act="restore" title="Every section back to how it was at this point">Go back to this</button>'}
      </span>`;
    div.querySelector('[data-act="undo"]').onclick = () => undoCommit(c).catch(err => { status.textContent = `Couldn’t compare versions: ${err.message}`; });
    const rBtn = div.querySelector('[data-act="restore"]');
    if (rBtn) rBtn.onclick = () => restoreVersion(c, when).catch(err => { status.textContent = `Couldn’t read that version: ${err.message}`; });
    list.appendChild(div);
  });
}

/**
 * Preview reverting one field to a past value: apply it to the live DOM (visible
 * preview), stage it as a pending edit, and let the user Publish or Undo. Both
 * before AND after a prior publish — it's just a staged field edit either way.
 */
function previewFieldRevert(key, value, histModal) {
  histModal?.remove();
  const n = previewRestore([{ key, value }], `“${escapeHtml(humanizeKey(key))}” from an earlier version`, '');
  if (!n) setStatus('That section isn’t on this page anymore', 'error');
}


/**
 * Per-section history: reached by clicking into a section and pressing the clock
 * button. Shows this one field's past versions (newest first) with an Undo that
 * PREVIEWS the change in the page before you keep it.
 */
async function fieldHistoryPanel(key, isRepeat = false) {
  if (state.active) commitEdit(state.active, state.active.getAttribute('data-cms'));
  const m = modal(`
    <h3>History for this section</h3>
    <p class="kiln-dim"><code>${escapeHtml(key)}</code> — pick an earlier version to preview it in the
    page, then keep or undo. ${isRepeat
      ? 'This is a set of blocks (rows share their fields), so history covers the whole set.'
      : 'Only this section changes.'}</p>
    <div id="kiln-fh" class="kiln-inv-list">Loading…</div>`);
  const box = m.querySelector('#kiln-fh');

  const rows = [];
  // Unpublished edit first (undo-before-publish).
  const pend = state.pending.get(key);
  const esc = CSS.escape(key);
  const liveEl = document.querySelector(`[data-cms="${esc}"], [data-cms-repeat="${esc}"]`);

  if (cfg.sandbox) {
    box.innerHTML = '<p class="kiln-dim">The demo doesn’t keep saved history — that comes with a real Kiln site. You can still undo an unpublished edit on the page.</p>';
    return;
  }
  try {
    const commits = await state.gh.request('GET',
      `/repos/${cfg.repo}/commits?path=${encodeURIComponent(state.page.path)}&per_page=15`);
    let lastVal = null;
    for (const c of commits.slice(0, 12)) {
      const text = await histFile(c.sha);
      const v = readValues(text)[key];
      if (v === undefined) continue;
      if (v !== lastVal) { rows.push({ c, v }); lastVal = v; }
    }
    box.innerHTML = '';
    if (pend && pend.html !== undefined && pend.html !== (rows[0] && rows[0].v)) {
      const r = document.createElement('div');
      r.className = 'kiln-inv-row';
      r.style.borderColor = 'rgba(251,191,36,.55)';
      r.innerHTML = `<span><span class="kiln-hist-prev">${histPreview(pend.html)}</span><small>your unpublished edit</small></span>
        <button class="kiln-btn-ghost">${UNDO_ICON} Undo this</button>`;
      r.querySelector('button').onclick = () => {
        state.pending.delete(key);
        // applyKeyDom handles both plain fields and repeat containers (which
        // need their editing handles re-wired after an innerHTML reset).
        if (rows[0] && rows[0].v !== undefined && rows[0].v !== null) applyKeyDom(key, rows[0].v);
        document.querySelectorAll(`[data-cms="${esc}"], [data-cms-repeat="${esc}"]`).forEach(n => n.classList.remove('kiln-modified'));
        refreshPublishButton(); m.remove();
        setStatus(`Undid the unpublished edit to “${key}”`, 'saved');
      };
      box.appendChild(r);
    }
    if (!rows.length && !box.children.length) { box.innerHTML = '<p class="kiln-dim">No saved history for this section yet — it appears here after your first publish.</p>'; return; }
    rows.forEach(({ c, v }, i) => {
      const when = new Date(c.commit.author.date).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      const r = document.createElement('div');
      r.className = 'kiln-inv-row';
      // Top row = what's live: its Undo goes back to the previous version.
      // Older rows: "Go back to this" previews that version. Everything previews
      // on the page first; nothing is live until Publish.
      const btnHtml = i === 0
        ? (rows.length > 1 ? `<button class="kiln-btn-ghost" title="Put this section back to the version before">${UNDO_ICON} Undo this change</button>` : '')
        : `<button class="kiln-btn-ghost">${UNDO_ICON} Go back to this</button>`;
      r.innerHTML = `<span><span class="kiln-hist-prev">${histPreview(v)}</span>
        <small>${i === 0 ? '<b class="kiln-hist-live">live now</b> · ' : ''}${when} · ${escapeHtml(c.commit.author.name)}</small></span>
        ${btnHtml}`;
      const btn = r.querySelector('button');
      if (btn) btn.onclick = () => previewFieldRevert(key, i === 0 ? rows[1].v : v, m);
      box.appendChild(r);
    });
  } catch (err) { box.innerHTML = `<p class="kiln-dim">Couldn’t load history: ${escapeHtml(err.message)}</p>`; }
}

function histPreview(html) {
  return escapeHtml((new DOMParser().parseFromString(html, 'text/html').body.textContent || '').trim().slice(0, 80)) || '<em>(empty)</em>';
}

// ─── Page settings (title + meta description) ────────────────────────────────

function pageSettingsPanel() {
  const cur = readHead(state.page.text);
  const m = modal(`
    <h3>Page settings — ${escapeHtml(state.page.path)}</h3>
    <label>Page title (browser tab + search results)
      <input type="text" id="kiln-ps-title" value="${escapeHtml(cur.title)}"></label>
    <label>Description (search results &amp; link previews)
      <input type="text" id="kiln-ps-desc" value="${escapeHtml(cur.description)}" maxlength="200"></label>
    <label>Social image URL (link previews — optional)
      <input type="text" id="kiln-ps-ogimg" value="${escapeHtml(cur.ogImage || '')}" placeholder="/assets/img/social.jpg"></label>
    <div class="kiln-modal-actions">
      <button class="kiln-btn-ghost" data-close>Cancel</button>
      <button class="kiln-btn-publish" id="kiln-ps-go">Publish</button>
    </div>
    <p class="kiln-np-step" id="kiln-ps-status"></p>
    ${mode === 'admin' ? `<hr class="kiln-hr"><h4>Danger zone</h4>
      <div class="kiln-inv-row" style="border-color:#fecaca">
        <span><strong>Delete this page</strong><small>Removes ${escapeHtml(state.page.path)} from the site. History keeps it recoverable.</small></span>
        <button class="kiln-btn-ghost" id="kiln-ps-del">Delete page…</button>
      </div>` : ''}`);
  m.querySelector('#kiln-ps-go').onclick = async () => {
    const title = m.querySelector('#kiln-ps-title').value;
    const description = m.querySelector('#kiln-ps-desc').value;
    const ogImage = m.querySelector('#kiln-ps-ogimg').value;
    const status = m.querySelector('#kiln-ps-status');
    status.textContent = 'Publishing…';
    try {
      const result = await editFile(state.gh, cfg.repo, state.page.path, cfg.branch || 'main',
        (text) => editHead(text, { title, description, ogImage }),
        `Page settings: ${state.page.path} (via Kiln)`);
      if (result.unchanged) { status.textContent = 'Nothing changed.'; return; }
      await loadPageSource();
      journalAdd({ type: 'compare', target: location.pathname, expect: djb2(result.text), desc: 'Page settings' });
      status.textContent = 'Committed ✓ — safe to close; Kiln will confirm when live.';
    } catch (err) { status.textContent = `Failed: ${err.message}`; }
  };
  const delBtn = m.querySelector('#kiln-ps-del');
  if (delBtn) delBtn.onclick = () => {
    const status = m.querySelector('#kiln-ps-status');
    const name = state.page.path.split('/').pop();
    if (!confirm(`Delete ${state.page.path}?\n\nThe page comes off the live site on the next deploy. It stays in the site's Git history, so it can be recovered. Remember to remove it from your Site menu too.`)) return;
    if (prompt(`Type the file name to confirm: ${name}`) !== name) { status.textContent = 'Name didn’t match — not deleted.'; return; }
    status.textContent = 'Deleting…';
    (async () => {
      try {
        const file = await getFile(state.gh, cfg.repo, state.page.path, cfg.branch || 'main');
        await state.gh.request('DELETE', `/repos/${cfg.repo}/contents/${state.page.path.split('/').map(encodeURIComponent).join('/')}`,
          { message: `Delete ${state.page.path} (via Kiln)`, sha: file.sha, branch: cfg.branch || 'main' });
        status.innerHTML = 'Deleted ✓ — the page comes off the site on the next deploy. <strong>Open Site menu to remove its link.</strong>';
      } catch (err) { status.textContent = `Delete failed: ${err.message}`; }
    })();
  };
}

// ─── Find & replace (site-wide) ──────────────────────────────────────────────

function findReplacePanel() {
  const m = modal(`
    <h3>Find &amp; replace across the site</h3>
    <label>Find <input type="text" id="kiln-fr-find" placeholder="Old phone number, name, address…"></label>
    <label>Replace with <input type="text" id="kiln-fr-repl"></label>
    <div class="kiln-modal-actions" style="justify-content:flex-start">
      <button class="kiln-btn-publish" id="kiln-fr-scan">Preview matches</button>
    </div>
    <div id="kiln-fr-out" class="kiln-inv-list" style="margin-top:8px"></div>
    <p class="kiln-np-step" id="kiln-fr-status"></p>`);
  const status = m.querySelector('#kiln-fr-status');
  m.querySelector('#kiln-fr-scan').onclick = async () => {
    const find = m.querySelector('#kiln-fr-find').value;
    const repl = m.querySelector('#kiln-fr-repl').value;
    const out = m.querySelector('#kiln-fr-out');
    if (!find || find.length < 2) { status.textContent = 'Type at least 2 characters to find.'; return; }
    status.textContent = 'Scanning every page…';
    out.innerHTML = '';
    try {
      const branch = cfg.branch || 'main';
      const tree = await state.gh.request('GET', `/repos/${cfg.repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
      const files = tree.tree.filter(x => x.type === 'blob' && x.path.endsWith('.html')).map(x => x.path).slice(0, 100);
      const hits = [];
      for (let i = 0; i < files.length; i++) {
        status.textContent = `Scanning… ${i + 1}/${files.length}`;
        const f = await getFile(state.gh, cfg.repo, files[i], branch);
        const count = f.text.split(find).length - 1;
        if (count) hits.push({ path: files[i], count, text: f.text });
      }
      if (!hits.length) { status.textContent = `No matches for “${find}”.`; return; }
      out.innerHTML = hits.map(h => `<div class="kiln-inv-row"><span>${escapeHtml(h.path)}</span><small>${h.count}×</small></div>`).join('');
      status.innerHTML = `${hits.reduce((n, h) => n + h.count, 0)} match(es) in ${hits.length} file(s).
        <strong>This replaces matches anywhere in the page source</strong> — review on GitHub afterwards if unsure.`;
      const act = document.createElement('div');
      act.className = 'kiln-modal-actions';
      act.innerHTML = `<button class="kiln-btn-ghost" data-close>Cancel</button>
        <button class="kiln-btn-publish">Replace all (1 commit)</button>`;
      out.after(act);
      act.querySelector('.kiln-btn-publish').onclick = async () => {
        status.textContent = 'Committing…';
        try {
          const changed = hits.map(h => ({ path: h.path, text: h.text.split(find).join(repl) }));
          await commitFiles(state.gh, cfg.repo, branch, changed, `Replace “${find}” → “${repl}” on ${changed.length} pages (via Kiln)`);
          const thisPage = changed.find(c => c.path === state.page.path);
          if (thisPage) journalAdd({ type: 'compare', target: location.pathname, expect: djb2(thisPage.text), desc: 'Find & replace' });
          status.textContent = 'Committed ✓ — rebuilding. Safe to close; Kiln will confirm when live.';
          act.remove();
        } catch (err) { status.textContent = `Failed: ${err.message}`; }
      };
    } catch (err) { status.textContent = `Scan failed: ${err.message}`; }
  };
}

// ─── Drafts (kiln-drafts branch) ─────────────────────────────────────────────

const DRAFT_BRANCH = 'kiln-drafts';

async function ensureDraftBranch() {
  try {
    await state.gh.request('GET', `/repos/${cfg.repo}/git/ref/${encodeURIComponent('heads/' + DRAFT_BRANCH)}`);
  } catch {
    const main = await state.gh.request('GET', `/repos/${cfg.repo}/git/ref/${encodeURIComponent('heads/' + (cfg.branch || 'main'))}`);
    await state.gh.request('POST', `/repos/${cfg.repo}/git/refs`, { ref: `refs/heads/${DRAFT_BRANCH}`, sha: main.object.sha });
  }
}

async function saveDraft() {
  if (!state.pending.size) return;
  // Drafts save only text/attribute edits. Uploaded images and added sections
  // live in pendingBinaries/pendingStructural, which a draft can't carry — a
  // draft referencing an uncommitted image would publish a broken link, and an
  // annotation-dependent edit would be silently dropped. Make the user publish
  // (or discard) those first rather than lose them.
  if (state.pendingBinaries.size || state.pendingStructural.length) {
    setStatus('Publish your new images / added sections first — drafts save text edits only', 'error');
    return;
  }
  setStatus('Saving draft…', 'saving');
  try {
    await ensureDraftBranch();
    const edits = flattenPending();
    const drafted = applyEdits(state.page.text, edits).html;
    let sha;
    try { sha = (await getFile(state.gh, cfg.repo, state.page.path, DRAFT_BRANCH)).sha; } catch { /* new draft */ }
    await putFile(state.gh, cfg.repo, state.page.path, {
      text: drafted, sha, branch: DRAFT_BRANCH,
      message: `Draft: ${state.page.path} (via Kiln)`,
    });
    state.pending.clear();
    clearSavedPending();
    // Retire undo history at the draft boundary too: the edits now live in the
    // draft branch, so ⌘Z would revert the DOM while the draft still carries them
    // (and redo would re-stage an already-saved edit for a second commit).
    editHistory.undo.length = 0;
    editHistory.redo.length = 0;
    updateUndoUi();
    document.querySelectorAll('.kiln-modified').forEach(el => el.classList.remove('kiln-modified'));
    refreshPublishButton();
    setStatus('Draft saved ✓ — nothing is live; resume it any time from this page', 'saved');
  } catch (err) {
    console.error('[kiln] draft', err);
    setStatus(`Draft failed: ${err.message}`, 'error');
  }
}

async function checkForDraft() {
  let draft;
  try { draft = await getFile(state.gh, cfg.repo, state.page.path, DRAFT_BRANCH); } catch { return; }
  if (!draft || djb2(draft.text) === djb2(state.page.text)) return;
  const m = modal(`
    <h3>There's a saved draft of this page</h3>
    <p class="kiln-dim">It isn't live. Resume editing it, publish it as-is, or leave it for later.</p>
    <div class="kiln-modal-actions">
      <button class="kiln-btn-ghost" data-close>Later</button>
      ${mode === 'admin' ? '<button class="kiln-btn-ghost" id="kiln-dr-del">Delete draft</button>' : ''}
      <button class="kiln-btn-ghost" id="kiln-dr-pub">Publish it now</button>
      <button class="kiln-btn-publish" id="kiln-dr-resume">Resume draft</button>
    </div>
    <p class="kiln-np-step" id="kiln-dr-status"></p>`);
  const status = m.querySelector('#kiln-dr-status');
  m.querySelector('#kiln-dr-resume').onclick = () => {
    const draftFields = indexHtml(draft.text).fields;
    let applied = 0;
    for (const [key, f] of draftFields) {
      if (!f.inner) continue;
      const value = draft.text.slice(f.inner.start, f.inner.end);
      const liveF = state.fields.fields.get(key);
      const liveValue = liveF?.inner ? state.page.text.slice(liveF.inner.start, liveF.inner.end) : null;
      if (value === liveValue) continue;
      const el = document.querySelector(`[data-cms="${CSS.escape(key)}"]`);
      if (el && !el.closest('[data-cms-repeat]')) {
        el.innerHTML = value;
        el.classList.add('kiln-modified');
        stagePending(key, { html: value });
        applied++;
      } else if (liveF?.kind === 'repeat' || el?.hasAttribute('data-cms-repeat')) {
        const cont = document.querySelector(`[data-cms-repeat="${CSS.escape(key)}"]`);
        if (cont) { cont.innerHTML = value; setupRepeat(cont, key); cont.querySelectorAll('[data-cms]').forEach(n => decorateField(n, n.getAttribute('data-cms'))); stagePending(key, { html: value }); applied++; }
      }
    }
    refreshPublishButton();
    setStatus(`Draft loaded (${applied} change${applied === 1 ? '' : 's'}) — Publish when ready`, 'saved');
    m.remove();
  };
  m.querySelector('#kiln-dr-pub').onclick = async () => {
    status.textContent = 'Publishing draft…';
    try {
      const result = await editFile(state.gh, cfg.repo, state.page.path, cfg.branch || 'main',
        () => draft.text, `Publish draft: ${state.page.path} (via Kiln)`);
      journalAdd({ type: 'compare', target: location.pathname, expect: djb2(draft.text), desc: 'Draft publish' });
      await loadPageSource();
      status.textContent = 'Published ✓ — your site rebuilds now; the change goes live in about a minute.';
    } catch (err) { status.textContent = `Failed: ${err.message}`; }
  };
  const del = m.querySelector('#kiln-dr-del');
  if (del) del.onclick = async () => {
    status.textContent = 'Deleting…';
    try {
      await state.gh.request('DELETE', `/repos/${cfg.repo}/contents/${state.page.path.split('/').map(encodeURIComponent).join('/')}`,
        { message: `Discard draft: ${state.page.path} (via Kiln)`, sha: draft.sha, branch: DRAFT_BRANCH });
      status.textContent = 'Draft deleted.';
      setTimeout(() => m.remove(), 600);
    } catch (err) { status.textContent = `Failed: ${err.message}`; }
  };
}

// ─── Scheduled publishing ────────────────────────────────────────────────────

function schedulePanel() {
  if (!state.pending.size) return;
  // Scheduling re-applies text edits later against the live source; it can't
  // carry queued image uploads or added sections (same reason as drafts).
  if (state.pendingBinaries.size || state.pendingStructural.length) {
    setStatus('Publish your new images / added sections first — scheduling covers text edits only', 'error');
    return;
  }
  const inOneHour = new Date(Date.now() + 3600000 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const m = modal(`
    <h3>Schedule these ${state.pending.size} edit${state.pending.size > 1 ? 's' : ''}</h3>
    <p class="kiln-dim">Kiln commits them automatically at the time you pick (checked every 5 minutes), then the site rebuilds.</p>
    <label>Publish at <input type="datetime-local" id="kiln-sc-at" value="${inOneHour}"></label>
    <div class="kiln-modal-actions">
      <button class="kiln-btn-ghost" data-close>Cancel</button>
      <button class="kiln-btn-publish" id="kiln-sc-go">Schedule</button>
    </div>
    <h4>Already scheduled</h4>
    <div id="kiln-sc-list" class="kiln-inv-list">Loading…</div>
    <p class="kiln-np-step" id="kiln-sc-status"></p>`);
  const status = m.querySelector('#kiln-sc-status');
  const authHeaders = () => {
    if (mode === 'admin') return { Authorization: `Bearer ${JSON.parse(localStorage.getItem(ADMIN_KEY)).token}` };
    return { 'X-Kiln-Session': JSON.parse(localStorage.getItem(EDITOR_KEY)).session };
  };
  async function refreshList() {
    const list = m.querySelector('#kiln-sc-list');
    try {
      const res = await fetch(`${cfg.worker}/schedules?repo=${encodeURIComponent(cfg.repo)}`, { headers: authHeaders() });
      const data = await res.json();
      list.innerHTML = (data.schedules || []).length ? '' : '<p class="kiln-dim">Nothing scheduled.</p>';
      for (const s of data.schedules || []) {
        const row = document.createElement('div');
        row.className = 'kiln-inv-row';
        row.innerHTML = `<span><strong>${escapeHtml(s.desc)}</strong>
          <small>${new Date(s.at).toLocaleString()} · by ${escapeHtml(s.by)}</small></span>
          <button class="kiln-btn-ghost">Cancel</button>`;
        row.querySelector('button').onclick = async () => {
          await fetch(`${cfg.worker}/schedule/cancel`, { method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({ repo: cfg.repo, id: s.id }) });
          refreshList();
        };
        list.appendChild(row);
      }
    } catch { list.innerHTML = '<p class="kiln-dim">Could not load.</p>'; }
  }
  refreshList();
  m.querySelector('#kiln-sc-go').onclick = async () => {
    const at = m.querySelector('#kiln-sc-at').value;
    if (!at) return;
    status.textContent = 'Scheduling…';
    try {
      // Send field-level edits (not a full-page snapshot): the worker re-applies
      // them against the live source at fire time, so edits published in the
      // meantime aren't wiped.
      const edits = flattenPending();
      const res = await fetch(`${cfg.worker}/schedule`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ repo: cfg.repo, path: state.page.path, branch: cfg.branch || 'main',
          edits, at: new Date(at).toISOString(),
          message: `Scheduled edit: ${state.page.path} (via Kiln)`,
          desc: `${state.page.path} (${[...state.pending.keys()].slice(0, 3).join(', ')})` }) });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'failed');
      state.pending.clear();
      clearSavedPending();
      // The edits now live in the schedule on the worker; retire undo history so
      // ⌘Z can't revert the DOM out from under an already-scheduled edit (and redo
      // can't re-stage it for a duplicate publish).
      editHistory.undo.length = 0;
      editHistory.redo.length = 0;
      updateUndoUi();
      document.querySelectorAll('.kiln-modified').forEach(el => el.classList.remove('kiln-modified'));
      refreshPublishButton();
      status.textContent = `Scheduled for ${new Date(data.at).toLocaleString()} ✓ — safe to close.`;
      refreshList();
    } catch (err) { status.textContent = `Failed: ${err.message}`; }
  };
}

// ─── Settings (admin) ────────────────────────────────────────────────────────

function settingsPanel() {
  const ui = localStorage.getItem('kiln_ui_mode') || 'fab';
  const auth = cfg.auth || {};
  const isAdmin = mode === 'admin';
  const m = modal(`
    <h3>Settings</h3>
    <h4>Your editor (this browser)</h4>
    <div class="kiln-roles">
      <label class="kiln-role"><input type="radio" name="kiln-uimode" value="fab" ${ui === 'fab' ? 'checked' : ''}>
        <span><strong>Floating button</strong><br><small>Draggable circle; hover for the menu.</small></span></label>
      <label class="kiln-role"><input type="radio" name="kiln-uimode" value="bar" ${ui === 'bar' ? 'checked' : ''}>
        <span><strong>Top bar</strong><br><small>Fixed bar with all actions visible.</small></span></label>
    </div>
    ${isAdmin ? `
    <h4>This site (applies to everyone, committed to the repo)</h4>
    <label class="kiln-role"><input type="checkbox" id="kiln-set-google" ${auth.google !== false ? 'checked' : ''}>
      <span><strong>Google sign-in</strong><br><small>Invited editors and members sign in with their Google account at yoursite.com/kiln.</small></span></label>` : ''}
    <div class="kiln-modal-actions">
      <button class="kiln-btn-ghost" data-close>Close</button>
      <button class="kiln-btn-publish" id="kiln-set-save">Save</button>
    </div>
    <p class="kiln-np-step" id="kiln-set-status"></p>`);
  const status = m.querySelector('#kiln-set-status');
  m.querySelector('#kiln-set-save').onclick = async () => {
    const newUi = m.querySelector('input[name="kiln-uimode"]:checked').value;
    const uiChanged = newUi !== ui;
    localStorage.setItem('kiln_ui_mode', newUi);
    const google = isAdmin ? m.querySelector('#kiln-set-google').checked : (cfg.auth?.google !== false);
    const siteChanged = isAdmin && google !== (cfg.auth?.google !== false);
    if (!siteChanged) {
      status.textContent = uiChanged ? 'Saved — reloading to apply your editor layout…' : 'Saved.';
      if (uiChanged) setTimeout(() => location.reload(), 600);
      return;
    }
    status.textContent = 'Committing site settings…';
    try {
      const cfgPath = (cfg.root ? cfg.root.replace(/\/+$/, '') + '/' : '') + 'assets/kiln-config.js';
      const result = await editFile(state.gh, cfg.repo, cfgPath, cfg.branch || 'main', (text) => {
        let out = text;
        const flags = `\n  // Managed by Kiln Settings\n  auth: { google: ${google} },\n`;
        out = out.replace(/\n\s*\/\/ Managed by Kiln Settings\n\s*(loginButton:[^\n]*\n\s*)?auth:[^\n]*\n/, '\n');
        out = out.replace(/\n\s*loginButton:[^\n]*\n/, '\n');
        const close = out.lastIndexOf('};');
        return out.slice(0, close) + flags + out.slice(close);
      }, 'Kiln settings (via Kiln)');
      journalAdd({ type: 'compare', target: '/assets/kiln-config.js', expect: djb2(result.text), desc: 'Site settings' });
      status.textContent = 'Committed ✓ — applies to everyone after the rebuild (~1 min).' + (uiChanged ? ' Reloading…' : '');
      if (uiChanged) setTimeout(() => location.reload(), 1500);
    } catch (err) { status.textContent = `Failed: ${err.message}`; }
  };
}

// ─── Make things editable (admin) ────────────────────────────────────────────
// Kiln annotates its own HTML: pick any element on the page and Kiln splices
// the data-cms attributes into the repo file (or strips them off again). The
// live DOM is mapped to the source by counting same-tag elements in tree order,
// with Kiln-injected chrome filtered out, then sanity-checked by text content.

const PICKABLE = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'span', 'a', 'li', 'ul', 'ol',
  'img', 'div', 'section', 'article', 'figure', 'figcaption', 'blockquote', 'small', 'strong',
  'em', 'td', 'th', 'tr', 'tbody', 'table', 'time', 'dl', 'dt', 'dd', 'caption', 'address']);

const KILN_CHROME = '#kiln-fab-wrap,#kiln-topbar,#kiln-toolbar,#kiln-modal,#kiln-imgpop,#kiln-previewbar,'
  + '#kiln-presence,#kiln-pickbar,#kiln-sandbox-banner,#kiln-scope-note,.kiln-item-ctl,.kiln-ctl-cell,.kiln-repeat-add,'
  + '.kiln-filterbar,.kiln-filterbar-preview,.kiln-evbar,.kiln-img-handle';

function isKilnChrome(el) { return !!el.closest(KILN_CHROME); }

/** The DOM index of `el` among same-tag elements, skipping Kiln-injected ones. */
function domNth(el) {
  const all = [...document.getElementsByTagName(el.tagName)].filter(e => !isKilnChrome(e));
  return all.indexOf(el);
}

let pickMode = null;

function exitPickMode() {
  if (!pickMode) return;
  document.removeEventListener('mouseover', pickMode.over, true);
  document.removeEventListener('click', pickMode.click, true);
  document.removeEventListener('keydown', pickMode.esc, true);
  document.querySelectorAll('.kiln-pick-hover').forEach(n => n.classList.remove('kiln-pick-hover'));
  pickMode.bar.remove();
  // Restore the Kiln button/bar that we hid on entry.
  document.getElementById('kiln-fab-wrap')?.style.removeProperty('display');
  document.getElementById('kiln-topbar')?.style.removeProperty('display');
  pickMode = null;
}

/** The element pick-mode would act on for a given event target. */
function pickCandidate(target) {
  if (!(target instanceof Element) || isKilnChrome(target)) return null;
  // Already-annotated ancestor wins — that's what "remove editing" targets.
  const annotated = target.closest('[data-cms], [data-cms-repeat], [data-cms-menu]');
  if (annotated && !isKilnChrome(annotated)) return annotated;
  for (let el = target; el && el !== document.body; el = el.parentElement) {
    if (PICKABLE.has(el.tagName.toLowerCase())) return el;
  }
  return null;
}

/** Add a NEW gallery or events section to the page (distinct from make-editable,
 *  which annotates EXISTING content). Inserts a starter block, staged for Publish. */
function addSectionFlow() {
  const m = modal(`
    <h3>Add a section</h3>
    <p class="kiln-dim">Pick what to add, then click where on the page it should go.</p>
    <div class="kiln-roles">
      <label class="kiln-role"><input type="radio" name="kiln-add-kind" value="gallery" checked>
        <span><strong>Photo gallery</strong><br><small>Upload photos; visitors get a grid and a full-screen lightbox.</small></span></label>
      <label class="kiln-role"><input type="radio" name="kiln-add-kind" value="events">
        <span><strong>Events list</strong><br><small>Add events with a form; visitors get list + month/week/day calendar.</small></span></label>
    </div>
    <div class="kiln-modal-actions">
      <button class="kiln-btn-ghost" data-close>Cancel</button>
      <button class="kiln-btn-publish" id="kiln-add-go">Choose where →</button>
    </div>`);
  m.querySelector('#kiln-add-go').onclick = () => {
    const kind = m.querySelector('input[name="kiln-add-kind"]:checked').value;
    m.remove();
    pickSectionSpot(kind);
  };
}

/** Click-to-place: hover top-level page sections, click to insert after one. */
function pickSectionSpot(kind) {
  const host = document.querySelector('main') || document.body;
  // Candidate anchors: the page's top-level blocks (skip Kiln chrome).
  const anchors = [...host.children].filter(c => !isKilnChrome(c) && c.getBoundingClientRect().height > 20);
  const bar = document.createElement('div');
  bar.id = 'kiln-pickbar';
  bar.innerHTML = `<span><strong>Where should it go?</strong> Click a section to add the new one right
    below it. <kbd>Esc</kbd> cancels.</span> <button id="kiln-spot-end">Put it at the end</button>`;
  document.body.appendChild(bar);
  let hovered = null;
  const mark = (el) => {
    hovered?.classList.remove('kiln-spot-hover');
    hovered = el;
    el?.classList.add('kiln-spot-hover');
  };
  const over = (e) => {
    if (e.target.closest('#kiln-pickbar')) { mark(null); return; }
    mark(anchors.find(a => a.contains(e.target)) || null);
  };
  const done = (anchor) => {
    cleanup();
    insertNewSection(kind, anchor);   // null anchor = end of page
  };
  const click = (e) => {
    if (e.target.closest('#kiln-pickbar')) return;
    e.preventDefault(); e.stopPropagation();
    const a = anchors.find(x => x.contains(e.target));
    if (a) done(a);
  };
  const key = (e) => { if (e.key === 'Escape') { cleanup(); setStatus('Add cancelled', 'idle'); } };
  function cleanup() {
    mark(null);
    bar.remove();
    document.removeEventListener('mouseover', over, true);
    document.removeEventListener('click', click, true);
    document.removeEventListener('keydown', key, true);
  }
  bar.querySelector('#kiln-spot-end').onclick = (e) => { e.stopPropagation(); done(null); };
  document.addEventListener('mouseover', over, true);
  document.addEventListener('click', click, true);
  document.addEventListener('keydown', key, true);
}

function insertNewSection(kind, anchor) {
  const stamp = Date.now().toString(36);
  const key = `${kind}_${stamp}`;
  const attr = kind === 'gallery' ? 'data-kiln-gallery' : 'data-kiln-events';
  const heading = kind === 'gallery' ? 'Gallery' : 'Events';
  const html = `\n<section class="kiln-added" style="padding:2.5rem 0"><div style="max-width:1080px;margin:0 auto;padding:0 1.25rem">`
    + `<h2 data-cms="${key}_title">${heading}</h2><div data-cms-repeat="${key}" ${attr}></div></div></section>\n`;
  const host = document.querySelector('main') || document.body;
  const wrap = document.createElement('div'); wrap.innerHTML = html.trim();
  const node = wrap.firstElementChild;
  // Live preview at the chosen spot; the same position is staged for the source.
  let op = null;
  if (anchor) {
    const tag = anchor.tagName.toLowerCase();
    const nth = domNth(anchor);
    anchor.after(node);
    op = { op: 'insertAfter', tag, nth, html, key };
  } else {
    host.appendChild(node);
    op = { op: 'appendMain', html, key };
  }
  node.querySelectorAll('[data-cms]').forEach(n => decorateField(n, n.getAttribute('data-cms')));
  setupRepeat(node.querySelector('[data-cms-repeat]'), key);
  // Stage it (sandbox: preview-only; real site: applied to the source at Publish).
  if (!cfg.sandbox) { state.pendingStructural.push(op); refreshPublishButton(); }
  pushUndoEntry({ steps: [{ structural: { node, op: cfg.sandbox ? null : op, html, place: () => anchor ? anchor.after(node) : host.appendChild(node) } }] });
  node.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setStatus(`Added a ${kind} — click “+ Add ${kind === 'gallery' ? 'photos' : 'event'}”, then Publish`, 'saved');
}

function makeEditableMode() {
  if (pickMode) return exitPickMode();
  // Hide the Kiln button/menu and top bar so they can't intercept picks and
  // aren't left visible-but-dead behind the pick bar.
  const fab = document.getElementById('kiln-fab-wrap'); if (fab) fab.style.display = 'none';
  const top = document.getElementById('kiln-topbar'); if (top) top.style.display = 'none';
  const bar = document.createElement('div');
  bar.id = 'kiln-pickbar';
  bar.innerHTML = `<span><strong>Make-editable mode.</strong> Click anything to make it editable.
    Click something already editable to remove editing. <kbd>Esc</kbd> exits.</span>
    <button id="kiln-pick-exit">Done</button>`;
  document.body.appendChild(bar);
  const over = (e) => {
    document.querySelectorAll('.kiln-pick-hover').forEach(n => n.classList.remove('kiln-pick-hover'));
    const c = pickCandidate(e.target);
    if (c) c.classList.add('kiln-pick-hover');
  };
  const click = (e) => {
    if (e.target.closest('#kiln-pickbar, #kiln-modal')) return;
    e.preventDefault();
    e.stopPropagation();
    const el = pickCandidate(e.target);
    if (!el) return;
    if (el.hasAttribute('data-cms') || el.hasAttribute('data-cms-repeat') || el.hasAttribute('data-cms-menu')) {
      unmakeDialog(el);
    } else {
      makeDialog(el);
    }
  };
  const esc = (e) => { if (e.key === 'Escape') exitPickMode(); };
  bar.querySelector('#kiln-pick-exit').onclick = exitPickMode;
  document.addEventListener('mouseover', over, true);
  document.addEventListener('click', click, true);
  document.addEventListener('keydown', esc, true);
  pickMode = { bar, over, click, esc };
}

function suggestKey(el) {
  const base = (el.textContent || el.getAttribute('alt') || el.tagName).trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').split('_').slice(0, 3).join('_')
    || el.tagName.toLowerCase();
  let key = base.slice(0, 40), n = 2;
  while (state.fields.fields.has(key)) key = `${base.slice(0, 38)}_${n++}`;
  return key;
}

/** ≥2 children with the same tag → looks like a list of blocks. */
function looksRepeatable(el) {
  const kids = [...el.children].filter(k => !isKilnChrome(k));
  if (kids.length < 2) return false;
  return kids.every(k => k.tagName === kids[0].tagName);
}

function makeDialog(el) {
  const tag = el.tagName.toLowerCase();
  const isImg = tag === 'img';
  const repeatable = !isImg && looksRepeatable(el);
  // A container can host a gallery/events list even when empty — the "+ Add"
  // button seeds the first item — so offer those on any block-level box, not
  // only ones that already contain a list.
  const isContainer = !isImg && (el.children.length >= 1
    || ['div', 'section', 'ul', 'ol', 'aside', 'article', 'figure', 'main'].includes(tag));
  const snippet = (el.textContent || el.getAttribute('alt') || '').trim().slice(0, 70);
  const inRepeat = !!el.closest('[data-cms-repeat]');
  const key = suggestKey(el);
  const kinds = isImg
    ? [{ v: 'img', t: 'Swappable image', d: 'Click to replace, resize, and set alt text.' }]
    : [
      { v: 'text', t: 'Editable text', d: 'Click-to-edit with formatting, links, images.' },
      { v: 'plain', t: 'Plain text only', d: 'No formatting allowed — safest for headings and labels.' },
      ...(repeatable && !inRepeat ? [
        { v: 'repeat', t: 'Repeating blocks', d: 'Editors can add, remove, reorder, and tag the blocks inside.' },
      ] : []),
    ];
  const m = modal(`
    <h3>Make this editable</h3>
    <p class="kiln-dim">&lt;${escapeHtml(tag)}&gt; ${snippet ? '· “' + escapeHtml(snippet) + '…”' : ''}</p>
    <div class="kiln-roles">
      ${kinds.map((k, i) => `<label class="kiln-role"><input type="radio" name="kiln-mk-kind" value="${k.v}" ${i === 0 ? 'checked' : ''}>
        <span><strong>${k.t}</strong><br><small>${k.d}</small></span></label>`).join('')}
    </div>
    <label>Field name <input type="text" id="kiln-mk-key" value="${escapeHtml(key)}" pattern="[a-z0-9_]+"></label>
    <p class="kiln-dim">Lowercase letters, numbers, underscores. This is the label editors see on the toolbar.</p>
    <div class="kiln-modal-actions">
      <button class="kiln-btn-ghost" data-close>Cancel</button>
      <button class="kiln-btn-publish" id="kiln-mk-go">Make editable</button>
    </div>
    <p class="kiln-np-step" id="kiln-mk-status"></p>`);
  m.querySelector('#kiln-mk-go').onclick = async () => {
    const kind = m.querySelector('input[name="kiln-mk-kind"]:checked').value;
    const k = m.querySelector('#kiln-mk-key').value.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_');
    const status = m.querySelector('#kiln-mk-status');
    if (!k) return;
    if (state.fields.fields.has(k)) { status.textContent = `"${k}" is already used on this page — pick another name.`; return; }
    status.textContent = 'Committing…';
    try {
      await annotateElement(el, kind, k);
      m.remove();
    } catch (err) {
      console.error('[kiln] make-editable', err);
      status.textContent = `Failed: ${err.message}`;
    }
  };
}

function applyAnnotationToDom(el, kind, key) {
  // Reflect the new annotation in the live DOM so it's usable without a reload.
  if (kind === 'img') {
    el.setAttribute('data-cms', key);
    el.setAttribute('data-cms-attr', 'src');
    decorateField(el, key);
  } else if (kind === 'repeat' || kind === 'gallery' || kind === 'events') {
    el.setAttribute('data-cms-repeat', key);
    if (kind === 'gallery') el.setAttribute('data-kiln-gallery', '');
    if (kind === 'events') el.setAttribute('data-kiln-events', '');
    setupRepeat(el, key);
    el.querySelectorAll('[data-cms]').forEach(n => decorateField(n, n.getAttribute('data-cms')));
  } else {
    el.setAttribute('data-cms', key);
    if (kind === 'plain') el.setAttribute('data-cms-plain', '');
    decorateField(el, key);
  }
}

async function annotateElement(el, kind, key) {
  const tag = el.tagName.toLowerCase();
  const nth = domNth(el);
  if (nth < 0) throw new Error('lost track of the element — reload and try again');
  const domText = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  // Demo sandbox: no repo to commit to — just wire it up live for the session.
  if (cfg.sandbox) {
    applyAnnotationToDom(el, kind, key);
    state.fields = indexHtml(document.documentElement.outerHTML);
    setStatus(`“${key}” is now editable ✓ (demo: for this session)`, 'saved');
    return;
  }
  const attrs = kind === 'img' ? ` data-cms="${key}" data-cms-attr="src"`
    : kind === 'repeat' ? ` data-cms-repeat="${key}"`
    : kind === 'gallery' ? ` data-cms-repeat="${key}" data-kiln-gallery`
    : kind === 'events' ? ` data-cms-repeat="${key}" data-kiln-events`
    : kind === 'plain' ? ` data-cms="${key}" data-cms-plain`
    : ` data-cms="${key}"`;
  // Verify we can locate it in the CURRENT source (fail early), then STAGE the
  // annotation — it's applied to the file at Publish, so it's pending like any
  // other edit (nothing auto-commits).
  const node = findNthTag(state.page.text, tag, nth);
  if (!node) throw new Error('could not locate this element in the page source. If the site builds this page with JavaScript, annotate the source file by hand.');
  const srcText = node.innerText.replace(/\s+/g, ' ').trim().slice(0, 60);
  if (domText && srcText && domText !== srcText) {
    // Often the site's own JS rewrote the text (dates, counters). The element
    // POSITION still matches, so annotating is safe — but confirm, because the
    // editor will show (and could overwrite) the source version, not the
    // script's output.
    if (!confirm(`Heads up: this text reads differently in the page source`
      + ` (a script on your site may update it on load).\n\nOn screen: “${domText}”\nIn source: “${srcText}”\n\n`
      + `Making it editable means edits replace the SOURCE text, and your script may keep changing what visitors see. Make it editable anyway?`)) {
      throw new Error('cancelled — the source text didn’t match what’s on screen.');
    }
  }
  state.pendingStructural.push({ op: 'annotate', tag, nth, attrs, key });
  applyAnnotationToDom(el, kind, key);
  refreshPublishButton();
  setStatus(`“${key}” is now editable — Publish to save it to the site`, 'saved');
}

/** Apply all staged structural changes (annotate/unannotate) to raw page HTML. */
function applyStructural(text, ops) {
  let t = text;
  for (const s of (ops || state.pendingStructural)) {
    if (s.op === 'annotate') t = annotateNthTag(t, s.tag, s.nth, s.attrs) || t;
    else if (s.op === 'remove') { const out = removeAnnotations(t, s.key); if (out !== null) t = out; }
    else if (s.op === 'appendMain') { const out = appendIntoNthTag(t, 'main', 0, s.html) || appendIntoNthTag(t, 'body', 0, s.html); if (out) t = out; }
    else if (s.op === 'removeSection') { const out = removeKilnSection(t, s.key); if (out !== null) t = out; }
    else if (s.op === 'insertAfter') {
      // Place after the chosen element; if it can't be found in source anymore
      // (page changed underneath us), fall back to the end of <main>.
      const out = insertAfterNthTag(t, s.tag, s.nth, s.html)
        || appendIntoNthTag(t, 'main', 0, s.html) || appendIntoNthTag(t, 'body', 0, s.html);
      if (out) t = out;
    }
  }
  return t;
}

function unmakeDialog(el) {
  const key = el.getAttribute('data-cms') || el.getAttribute('data-cms-repeat') || el.getAttribute('data-cms-menu');
  const kindLabel = el.hasAttribute('data-cms-repeat') ? 'repeating blocks'
    : el.hasAttribute('data-cms-menu') ? 'managed menu' : 'editable field';
  // Keys repeat inside block lists; only the first (indexed) element maps to source.
  const first = document.querySelector(`[data-cms="${CSS.escape(key)}"], [data-cms-repeat="${CSS.escape(key)}"], [data-cms-menu="${CSS.escape(key)}"]`);
  if (first !== el && el.closest('[data-cms-repeat]') !== el) {
    setStatus('Blocks in a list share their field names — remove editing on the FIRST block, or on the list itself.', 'error');
    return;
  }
  const m = modal(`
    <h3>Remove editing from “${escapeHtml(key)}”?</h3>
    <p class="kiln-dim">This ${kindLabel} stops being editable in Kiln. The content itself stays
    exactly as it is — only the editing annotation is removed. You can make it editable again any time.</p>
    <div class="kiln-modal-actions">
      <button class="kiln-btn-ghost" data-close>Cancel</button>
      <button class="kiln-btn-publish" id="kiln-um-go">Remove editing</button>
    </div>
    <p class="kiln-np-step" id="kiln-um-status"></p>`);
  const stripDom = () => {
    ['data-cms', 'data-cms-attr', 'data-cms-plain', 'data-cms-repeat', 'data-cms-menu', 'data-kiln-gallery', 'data-kiln-events']
      .forEach(a => el.removeAttribute(a));
    el.classList.remove('kiln-field', 'kiln-repeat');
    el.removeAttribute('title');
  };
  m.querySelector('#kiln-um-go').onclick = () => {
    // Demo sandbox: no repo — just strip it from the live DOM for the session.
    if (cfg.sandbox) {
      stripDom();
      state.fields = indexHtml(document.documentElement.outerHTML);
      m.remove();
      setStatus(`“${key}” is no longer editable (demo)`, 'saved');
      return;
    }
    // Stage the removal — applied at Publish, pending like any other edit.
    state.pendingStructural.push({ op: 'remove', key });
    stripDom();
    // Drop any pending field edit for this now-unmanaged key.
    state.pending.delete(key);
    refreshPublishButton();
    m.remove();
    setStatus(`“${key}” will stop being editable — Publish to save`, 'saved');
  };
}

// ─── Done / exit ─────────────────────────────────────────────────────────────

function doneEditing() {
  if (state.pending.size || state.pendingBinaries.size || state.pendingStructural.length) {
    const m = modal(`
      <h3>You have ${state.pending.size || state.pendingBinaries.size} unpublished edit${(state.pending.size || state.pendingBinaries.size) > 1 ? 's' : ''}</h3>
      <p class="kiln-dim">Publish them first, or discard and exit?</p>
      <div class="kiln-modal-actions">
        <button class="kiln-btn-ghost" data-close>Keep editing</button>
        <button class="kiln-btn-ghost" id="kiln-discard">Discard &amp; exit</button>
        <button class="kiln-btn-publish" id="kiln-pub-exit">Publish first</button>
      </div>`);
    m.querySelector('#kiln-discard').onclick = () => {
      state.pending.clear(); state.pendingBinaries.clear(); state.pendingStructural = [];
      editHistory.undo.length = 0; editHistory.redo.length = 0;
      exitEditMode();
    };
    m.querySelector('#kiln-pub-exit').onclick = async () => { m.remove(); await publish(); };
    return;
  }
  exitEditMode();
}

function exitEditMode() {
  sessionStorage.setItem(PAUSE_KEY, '1');
  location.reload();
}

// ─── UI chrome ───────────────────────────────────────────────────────────────

/**
 * The Kiln FAB — a draggable floating button that expands into the action
 * menu. Replaces the old fixed top bar so the site itself stays unobstructed.
 * Position is remembered per-browser.
 */
function renderAdminBar() {
  if ((localStorage.getItem('kiln_ui_mode') || 'fab') === 'bar') { renderTopBar(); return; }
  const fab = document.createElement('div');
  fab.id = 'kiln-fab-wrap';
  fab.innerHTML = `
    <div id="kiln-fab-menu" hidden>
      <div class="kiln-fab-head">
        <span class="kiln-brand">Kiln</span>
        <span class="kiln-user">${escapeHtml(state.user)}${mode === 'editor' ? ' · editor' : ''}</span>
      </div>
      <button id="kiln-publish" class="kiln-fab-item kiln-fab-primary" disabled>Publish</button>
      <div id="kiln-grp-edits" class="kiln-fab-group" hidden>
        <div class="kiln-fab-label">Your unpublished edits</div>
        <button id="kiln-draft" class="kiln-fab-item">Save as draft</button>
        <button id="kiln-schedule" class="kiln-fab-item">Schedule for later…</button>
        <button id="kiln-discard" class="kiln-fab-item kiln-fab-danger">Discard edits</button>
      </div>
      <div class="kiln-fab-group">
        <div class="kiln-fab-label">This page</div>
        <button id="kiln-newpost" class="kiln-fab-item">＋ New post or page</button>
        <button id="kiln-pagesettings" class="kiln-fab-item">Page settings</button>
        <button id="kiln-history" class="kiln-fab-item">History &amp; restore</button>
        ${mode === 'admin' || cfg.sandbox ? '<button id="kiln-addsection" class="kiln-fab-item">＋ Add a gallery or events</button>' : ''}
      ${mode === 'admin' || cfg.sandbox ? '<button id="kiln-makeblock" class="kiln-fab-item">✨ Make text/images editable</button>' : ''}
      </div>
      <div class="kiln-fab-group">
        <div class="kiln-fab-label">Whole site</div>
        <button id="kiln-menu" class="kiln-fab-item">Site menu</button>
        <button id="kiln-findreplace" class="kiln-fab-item">Find &amp; replace</button>
        ${mode === 'admin' ? '<button id="kiln-invite" class="kiln-fab-item">People &amp; access</button>' : ''}
        <button id="kiln-settings" class="kiln-fab-item">Settings</button>
      </div>
      <div class="kiln-fab-foot">
        <button id="kiln-done" title="Hide Kiln and browse normally (stays signed in — return via the Resume button or yoursite.com/kiln)">Done editing</button>
        <button id="kiln-signout">Sign out</button>
      </div>
    </div>
    <button id="kiln-fab" title="Kiln — drag me anywhere" aria-label="Kiln editing menu">
      <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
      <span id="kiln-fab-badge" hidden></span>
    </button>
    <div id="kiln-undo-wrap" hidden>
      <button id="kiln-undo-btn" title="Undo last change (⌘Z)">${UNDO_ICON} Undo</button>
      <button id="kiln-redo-btn" title="Redo (⌘⇧Z)"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M21 7v6h-6"/><path d="M20.5 13a9 9 0 1 1-2.6-8.4L21 7"/></svg> Redo</button>
    </div>
    <div class="kiln-status" id="kiln-status" hidden></div>`;
  document.body.appendChild(fab);
  fab.querySelector('#kiln-undo-btn').onclick = (e) => { e.stopPropagation(); undoEdit(); };
  fab.querySelector('#kiln-redo-btn').onclick = (e) => { e.stopPropagation(); redoEdit(); };

  // Restore position (default: bottom-right).
  function clampFab() {
    const r = fab.getBoundingClientRect();
    if (r.left < 4 || r.top < 4 || r.right > window.innerWidth - 4 || r.bottom > window.innerHeight - 4) {
      const x = Math.max(8, Math.min(r.left, window.innerWidth - 56));
      const y = Math.max(8, Math.min(r.top, window.innerHeight - 56));
      fab.style.left = x + 'px'; fab.style.top = y + 'px';
      fab.style.right = 'auto'; fab.style.bottom = 'auto';
      localStorage.setItem('kiln_fab_pos', JSON.stringify({ x, y }));
    }
  }
  try {
    const pos = JSON.parse(localStorage.getItem('kiln_fab_pos'));
    if (pos) {
      fab.style.left = pos.x + 'px'; fab.style.top = pos.y + 'px';
      fab.style.right = 'auto'; fab.style.bottom = 'auto';
    }
  } catch { /* default position */ }
  requestAnimationFrame(clampFab);
  window.addEventListener('resize', clampFab);

  const btn = fab.querySelector('#kiln-fab');
  const menu = fab.querySelector('#kiln-fab-menu');

  // Drag with a click/drag threshold so taps still open the menu.
  let drag = null;
  btn.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY, left: fab.offsetLeft, top: fab.offsetTop, moved: false };
    btn.setPointerCapture(e.pointerId);
  });
  btn.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 6) drag.moved = true;
    if (drag.moved) {
      menu.hidden = true;
      const x = Math.min(Math.max(drag.left + dx, 8), window.innerWidth - 56);
      const y = Math.min(Math.max(drag.top + dy, 8), window.innerHeight - 56);
      fab.style.left = x + 'px'; fab.style.top = y + 'px';
      fab.style.right = 'auto'; fab.style.bottom = 'auto';
    }
  });
  btn.addEventListener('pointerup', () => {
    if (drag && drag.moved) {
      localStorage.setItem('kiln_fab_pos', JSON.stringify({ x: fab.offsetLeft, y: fab.offsetTop }));
    } else {
      if (menu.hidden) positionMenu(); else menu.hidden = true;
    }
    drag = null;
  });

  function positionMenu() {
    // Fixed coordinates, measured then clamped — works wherever the FAB is parked.
    menu.style.position = 'fixed';
    menu.style.visibility = 'hidden';
    menu.hidden = false;
    const br = btn.getBoundingClientRect();
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    let left = br.right - mw;                       // right-align to the button…
    left = Math.max(8, Math.min(left, window.innerWidth - mw - 8));   // …then clamp
    let top = br.top > window.innerHeight / 2 ? br.top - mh - 10 : br.bottom + 10;
    top = Math.max(8, Math.min(top, window.innerHeight - mh - 8));
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
    menu.style.right = 'auto';
    menu.style.bottom = 'auto';
    menu.style.visibility = 'visible';
  }

  document.addEventListener('click', (e) => {
    if (!fab.contains(e.target)) menu.hidden = true;
  });

  // Hover opens the menu (click still works for touch); leaving the area closes it.
  let hoverTimer = null;
  fab.addEventListener('mouseenter', () => {
    clearTimeout(hoverTimer);
    if (menu.hidden) positionMenu();
  });
  menu.addEventListener('mouseenter', () => clearTimeout(hoverTimer));
  menu.addEventListener('mouseleave', () => {
    hoverTimer = setTimeout(() => { menu.hidden = true; }, 250);
  });
  fab.addEventListener('mouseleave', () => {
    hoverTimer = setTimeout(() => { menu.hidden = true; }, 350);
  });

  const close = (fn) => () => { menu.hidden = true; fn(); };
  fab.querySelector('#kiln-publish').onclick = close(publish);
  fab.querySelector('#kiln-newpost').onclick = close(newContent);
  fab.querySelector('#kiln-menu').onclick = close(menuEditor);
  fab.querySelector('#kiln-history').onclick = close(historyPanel);
  fab.querySelector('#kiln-done').onclick = close(doneEditing);
  fab.querySelector('#kiln-discard').onclick = close(discardEdits);
  fab.querySelector('#kiln-pagesettings').onclick = close(pageSettingsPanel);
  fab.querySelector('#kiln-findreplace').onclick = close(findReplacePanel);
  fab.querySelector('#kiln-schedule').onclick = close(schedulePanel);
  fab.querySelector('#kiln-draft').onclick = close(saveDraft);
  const settingsBtn = fab.querySelector('#kiln-settings');
  if (settingsBtn) settingsBtn.onclick = close(settingsPanel);
  fab.querySelector('#kiln-signout').onclick = () => {
    if (state.pending.size && !confirm('Discard your unpublished edits and sign out?')) return;
    clearSavedPending();
    window.Kiln.logout();
  };
  const inviteBtn = fab.querySelector('#kiln-invite');
  if (inviteBtn) inviteBtn.onclick = close(invitePanel);
  const makeBtn = fab.querySelector('#kiln-makeblock');
  if (makeBtn) makeBtn.onclick = close(makeEditableMode);
  const addSecBtn = fab.querySelector('#kiln-addsection');
  if (addSecBtn) addSecBtn.onclick = close(addSectionFlow);

  applyFeatureGating();
  updateOnlineChip();
  setStatus(`Signed in as ${state.user} — click any outlined text to edit`, 'idle');
}

function renderTopBar() {
  const bar = document.createElement('div');
  bar.id = 'kiln-topbar';
  bar.innerHTML = `
    <span class="kiln-brand">Kiln</span>
    <span class="kiln-user">${escapeHtml(state.user)}${mode === 'editor' ? ' · editor' : ''}</span>
    <span class="kiln-status" id="kiln-status" hidden></span>
    <span class="kiln-bar-spacer"></span>
    <span id="kiln-undo-wrap" hidden>
      <button id="kiln-undo-btn" class="kiln-btn-ghost" title="Undo last change (⌘Z)" aria-label="Undo">${UNDO_ICON}</button>
      <button id="kiln-redo-btn" class="kiln-btn-ghost" title="Redo (⌘⇧Z)" aria-label="Redo"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M21 7v6h-6"/><path d="M20.5 13a9 9 0 1 1-2.6-8.4L21 7"/></svg></button>
    </span>
    <button id="kiln-newpost" class="kiln-btn-ghost">+ New</button>
    <button id="kiln-menu" class="kiln-btn-ghost">Menu</button>
    <button id="kiln-pagesettings" class="kiln-btn-ghost">Page</button>
    <button id="kiln-findreplace" class="kiln-btn-ghost">Replace</button>
    <button id="kiln-history" class="kiln-btn-ghost">History</button>
    ${mode === 'admin' || cfg.sandbox ? '<button id="kiln-addsection" class="kiln-btn-ghost" title="Add a gallery or events section">＋ Add</button><button id="kiln-makeblock" class="kiln-btn-ghost" title="Make text/images editable">✨ Editable</button>' : ''}${mode === 'admin' ? '<button id="kiln-invite" class="kiln-btn-ghost">People</button>' : ''}
    <button id="kiln-settings" class="kiln-btn-ghost">Settings</button>
    <button id="kiln-draft" class="kiln-btn-ghost" hidden>Draft</button>
    <button id="kiln-schedule" class="kiln-btn-ghost" hidden>Schedule</button>
    <button id="kiln-discard" class="kiln-btn-ghost" hidden>Discard</button>
    <button id="kiln-publish" class="kiln-btn-publish" disabled>Publish</button>
    <button id="kiln-done" class="kiln-btn-ghost">Done</button>
    <button id="kiln-signout" class="kiln-btn-link">sign out</button>`;
  document.body.prepend(bar);
  bar.querySelector('#kiln-undo-btn').onclick = undoEdit;
  bar.querySelector('#kiln-redo-btn').onclick = redoEdit;
  bar.querySelector('#kiln-publish').onclick = publish;
  bar.querySelector('#kiln-newpost').onclick = newContent;
  bar.querySelector('#kiln-menu').onclick = menuEditor;
  bar.querySelector('#kiln-pagesettings').onclick = pageSettingsPanel;
  bar.querySelector('#kiln-findreplace').onclick = findReplacePanel;
  bar.querySelector('#kiln-history').onclick = historyPanel;
  bar.querySelector('#kiln-done').onclick = doneEditing;
  bar.querySelector('#kiln-discard').onclick = discardEdits;
  bar.querySelector('#kiln-draft').onclick = saveDraft;
  bar.querySelector('#kiln-schedule').onclick = schedulePanel;
  bar.querySelector('#kiln-signout').onclick = () => {
    if (state.pending.size && !confirm('Discard your unpublished edits and sign out?')) return;
    clearSavedPending();
    window.Kiln.logout();
  };
  const inviteBtn = bar.querySelector('#kiln-invite');
  if (inviteBtn) inviteBtn.onclick = invitePanel;
  const makeBtn = bar.querySelector('#kiln-makeblock');
  if (makeBtn) makeBtn.onclick = makeEditableMode;
  const addSecBtn = bar.querySelector('#kiln-addsection');
  if (addSecBtn) addSecBtn.onclick = addSectionFlow;
  const settingsBtn = bar.querySelector('#kiln-settings');
  if (settingsBtn) settingsBtn.onclick = settingsPanel;
  applyFeatureGating();
  updateOnlineChip();
  setStatus(`Signed in as ${state.user}`, 'idle');
}

function discardEdits() {
  if (!state.pending.size) return;
  const m = modal(`
    <h3>Discard ${state.pending.size} unpublished edit${state.pending.size > 1 ? 's' : ''}?</h3>
    <p class="kiln-dim">The page goes back to what's currently live. This can't be undone.</p>
    <div class="kiln-modal-actions">
      <button class="kiln-btn-ghost" data-close>Keep editing</button>
      <button class="kiln-btn-publish" id="kiln-disc-go">Discard</button>
    </div>`);
  m.querySelector('#kiln-disc-go').onclick = () => {
    state.pending.clear();
    state.pendingBinaries.clear();   // queued uploads were never committed — just drop them
    state.pendingStructural = [];
    clearSavedPending();
    location.reload();
  };
}

/**
 * Place the toolbar where it does NOT cover the element being edited:
 * above it when there's room, below it otherwise, and only as a last resort
 * pinned inside the viewport (where the drag handle saves the day). Must run
 * AFTER the toolbar is in the DOM so its real (possibly wrapped) size is known.
 */
function positionToolbar(tb, el) {
  const r = el.getBoundingClientRect();
  const th = tb.offsetHeight, tw = tb.offsetWidth;
  let top;
  if (r.top - th - 10 >= 8) top = r.top - th - 10;                      // above the element
  else if (r.bottom + 10 + th <= window.innerHeight - 8) top = r.bottom + 10;  // below it
  else top = Math.max(8, window.innerHeight - th - 12);                 // pinned; drag to taste
  const left = Math.max(8, Math.min(r.left, window.innerWidth - tw - 8));
  tb.style.top = `${top + window.scrollY}px`;
  tb.style.left = `${left + window.scrollX}px`;
}

/** Drag anywhere on the toolbar chrome (not its buttons/inputs) to move it. */
function makeToolbarDraggable(tb) {
  let drag = null;
  tb.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button, input, select, a')) return;
    drag = { x: e.clientX, y: e.clientY, left: parseFloat(tb.style.left) || 0, top: parseFloat(tb.style.top) || 0 };
    tb.setPointerCapture(e.pointerId);
    tb.classList.add('kiln-tb-dragging');
    e.preventDefault();
  });
  tb.addEventListener('pointermove', (e) => {
    if (!drag) return;
    tb.style.left = `${drag.left + e.clientX - drag.x}px`;
    tb.style.top = `${drag.top + e.clientY - drag.y}px`;
  });
  const end = () => { drag = null; tb.classList.remove('kiln-tb-dragging'); };
  tb.addEventListener('pointerup', end);
  tb.addEventListener('pointercancel', end);
}

const TB_GRIP = '<span class="kiln-tb-grip" title="Drag to move this toolbar" aria-hidden="true">⠿</span>';

function renderToolbar(el, key) {
  removeToolbar();
  const tb = document.createElement('div');
  tb.id = 'kiln-toolbar';
  const isLink = el.tagName === 'A';
  const plain = el.hasAttribute('data-cms-plain');
  const styles = Array.isArray(cfg.styles) ? cfg.styles : [];
  const LINK_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>';
  const IMG_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>';
  const HIST_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><path d="M12 7v5l3 2"/></svg>';
  tb.innerHTML = `
    ${TB_GRIP}
    <span class="kiln-tb-label">${escapeHtml(key)}</span>
    ${plain ? '' : `
      <select class="kiln-style-select" title="Text format and site styles">
        <option value="">Style</option>
        <optgroup label="Format">
          <option value="fmt:p">Body</option>
          <option value="fmt:h2">Heading</option>
          <option value="fmt:h3">Subheading</option>
          <option value="fmt:blockquote">Quote</option>
        </optgroup>
        ${styles.length ? `<optgroup label="Site styles">
          ${styles.map(s => `<option value="cls:${escapeHtml(s.class)}">${escapeHtml(s.label)}</option>`).join('')}
        </optgroup>` : ''}
      </select>
      <button class="kiln-tb-fmt" data-cmd="bold" title="Bold"><b>B</b></button>
      <button class="kiln-tb-fmt" data-cmd="italic" title="Italic"><i>I</i></button>
      <button class="kiln-tb-fmt" data-cmd="underline" title="Underline"><u>U</u></button>
      <button class="kiln-tb-fmt" data-cmd="insertUnorderedList" title="Bullet list">≔</button>
      <button class="kiln-tb-fmt" data-cmd="insertOrderedList" title="Numbered list">1.</button>
      <button class="kiln-tb-fmt" data-cmd="link" title="Turn selection into a link">${LINK_ICON}</button>
      <button class="kiln-tb-fmt" data-cmd="img" title="Insert an image at the cursor">${IMG_ICON}</button>
      <button class="kiln-tb-fmt" data-cmd="doc" title="Upload a document (PDF, doc…) and insert it at the cursor">📄</button>
      <button class="kiln-tb-fmt kiln-tb-clear" data-cmd="removeFormat" title="Clear formatting">Clear</button>`}
    ${isLink ? `<input class="kiln-href-input" type="text" value="${escapeHtml(el.getAttribute('href') || '')}" title="Where this links to" placeholder="/page.html or https://…">
      <button class="kiln-tb-fmt kiln-tb-attach" data-cmd="attach" title="Upload a file (PDF, doc…) and point this link at it">Attach file…</button>` : ''}
    <span class="kiln-tb-gap"></span>
    <button class="kiln-tb-fmt" data-cmd="hist" title="This section's history — undo to a previous version">${HIST_ICON}</button>
    <button class="kiln-tb-save" title="Keep this edit (you can still Esc-revert until you click away)">Done</button>
    <button class="kiln-tb-cancel" title="Throw away this edit (Esc)">Revert</button>`;
  document.body.appendChild(tb);
  positionToolbar(tb, el);
  makeToolbarDraggable(tb);

  tb.querySelectorAll('.kiln-tb-fmt').forEach(btn => {
    btn.addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const cmd = btn.dataset.cmd;
      if (cmd === 'link') {
        const url = window.prompt('Link to (URL or /page):', 'https://');
        if (url) document.execCommand('createLink', false, url);
      } else if (cmd === 'img') {
        insertInlineImage(el);
      } else if (cmd === 'doc') {
        const sel = window.getSelection();
        const savedRange = sel.rangeCount && el.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
        insertDocument(el, savedRange);
      } else if (cmd === 'attach') {
        const input = tb.querySelector('.kiln-href-input');
        const up = await uploadAnyFile();
        if (up && input) input.value = up.path;
      } else if (cmd === 'hist') {
        // Fields inside a repeat share their key across every block (each table
        // row reuses sd_notes etc.), so per-field history is ambiguous — track
        // and restore the CONTAINER, which is also how these fields publish.
        const rep = el.closest('[data-cms-repeat]');
        fieldHistoryPanel(rep ? rep.getAttribute('data-cms-repeat') : key, !!rep);
        return;
      } else {
        document.execCommand(cmd, false, null);
      }
      el.focus();
    });
  });
  const styleSelect = tb.querySelector('.kiln-style-select');
  if (styleSelect) {
    styleSelect.addEventListener('mousedown', (e) => e.stopPropagation());
    styleSelect.addEventListener('change', (e) => {
      e.stopPropagation();
      const value = styleSelect.value;
      styleSelect.value = '';
      if (!value) return;
      const sel = window.getSelection();
      const inField = sel.rangeCount && el.contains(sel.anchorNode);
      if (value.startsWith('fmt:')) {
        // Block format: works on the block the cursor is in (no selection needed).
        if (!inField) { el.focus(); }
        document.execCommand('formatBlock', false, value.slice(4));
      } else if (value.startsWith('cls:')) {
        const cls = value.slice(4);
        if (inField && !sel.isCollapsed) {
          const range = sel.getRangeAt(0);
          const span = document.createElement('span');
          span.className = cls;
          try {
            range.surroundContents(span);
          } catch {
            span.appendChild(range.extractContents());
            range.insertNode(span);
          }
        } else {
          setStatus('Select some text first, then pick a site style', 'idle');
        }
      }
      el.focus();
    });
  }
  tb.querySelector('.kiln-tb-save').onclick = (e) => { e.stopPropagation(); commitEdit(el, key); };
  tb.querySelector('.kiln-tb-cancel').onclick = (e) => { e.stopPropagation(); cancelEditing(); };
}

function removeToolbar() { document.getElementById('kiln-toolbar')?.remove(); }

function modal(bodyHtml) {
  document.getElementById('kiln-modal')?.remove();
  const wrap = document.createElement('div');
  wrap.id = 'kiln-modal';
  wrap.innerHTML = `<div class="kiln-modal-card" role="dialog" aria-modal="true" tabindex="-1">`
    + `<button class="kiln-modal-x" data-close aria-label="Close">✕</button>`
    + `<div class="kiln-modal-body">${bodyHtml}</div></div>`;
  const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey, true); };
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap || e.target.closest('[data-close]')) close();
  });
  // Esc closes; Tab is trapped inside the dialog so keyboard focus can't wander
  // onto the page behind it.
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
    if (e.key !== 'Tab') return;
    const f = [...wrap.querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')]
      .filter(el => !el.disabled && el.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(wrap);
  (wrap.querySelector('input') || wrap.querySelector('.kiln-modal-card')).focus();
  return wrap;
}

function refreshPublishButton() {
  const n = state.pending.size;
  // A queued upload with no field edit still needs a Publish to commit it.
  const anything = n || state.pendingBinaries.size || state.pendingStructural.length;
  const btn = document.getElementById('kiln-publish');
  if (btn) {
    btn.disabled = !anything;
    btn.textContent = n ? `Publish ${n} edit${n > 1 ? 's' : ''}` : (anything ? 'Publish' : 'Publish');
  }
  const badge = document.getElementById('kiln-fab-badge');
  if (badge) { badge.hidden = !anything; badge.textContent = n || (state.pendingBinaries.size || state.pendingStructural.length ? '•' : ''); }
  // The whole "unpublished edits" group appears only when there's something to act on.
  const grp = document.getElementById('kiln-grp-edits');
  if (grp) grp.hidden = !anything;
  const discard = document.getElementById('kiln-discard');
  if (discard) discard.textContent = n ? `Discard ${n} edit${n > 1 ? 's' : ''}` : 'Discard edits';
  // Draft + Schedule need actual field edits (not just an uploaded binary), and
  // an editor must be granted them (dataset.gated set by applyFeatureGating).
  const sched = document.getElementById('kiln-schedule');
  if (sched) sched.style.display = (n && !sched.dataset.gated) ? '' : 'none';
  const draftBtn = document.getElementById('kiln-draft');
  if (draftBtn) draftBtn.style.display = (n && !draftBtn.dataset.gated) ? '' : 'none';
  savePendingToStorage();
}

function disablePublish(yes) {
  const btn = document.getElementById('kiln-publish');
  if (btn) btn.disabled = yes || !state.pending.size;
}

let statusHideTimer = null;
function setStatus(text, kind) {
  const el = document.getElementById('kiln-status');
  if (!el) return;
  // A spinner rides alongside busy ('saving') states so publishing/uploading
  // reads as active work, not a frozen label.
  el.innerHTML = (kind === 'saving' ? '<span class="kiln-spin" aria-hidden="true"></span>' : '')
    + `<span>${escapeHtml(text)}</span>`;
  el.className = `kiln-status kiln-status--${kind}`;
  el.hidden = false;
  clearTimeout(statusHideTimer);
  // Busy/error states stay visible; calm states fade away on their own.
  if (kind === 'idle' || kind === 'saved') {
    statusHideTimer = setTimeout(() => { el.hidden = true; }, 6000);
  }
}

// ─── Crash-proof pending edits ───────────────────────────────────────────────

function pendingStorageKey() {
  return `kiln_pending:${cfg.repo}:${state.page?.path || location.pathname}`;
}

function savePendingToStorage() {
  try {
    if (!state.pending.size) { localStorage.removeItem(pendingStorageKey()); return; }
    localStorage.setItem(pendingStorageKey(),
      JSON.stringify({ ts: Date.now(), edits: Object.fromEntries(state.pending) }));
  } catch { /* storage full — nonfatal */ }
}

function clearSavedPending() {
  try { localStorage.removeItem(pendingStorageKey()); } catch { /* ignore */ }
}

/** If the tab crashed/closed with staged edits, offer to bring them back. */
function offerPendingRestore() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(pendingStorageKey())); } catch { return; }
  if (!saved || !saved.edits || Date.now() - saved.ts > 7 * 24 * 3600 * 1000) return;
  const keys = Object.keys(saved.edits);
  if (!keys.length) return;
  const m = modal(`
    <h3>Pick up where you left off?</h3>
    <p class="kiln-dim">You have ${keys.length} unpublished edit${keys.length > 1 ? 's' : ''} from
    ${new Date(saved.ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
    on this page (${keys.map(escapeHtml).join(', ')}).</p>
    <div class="kiln-modal-actions">
      <button class="kiln-btn-ghost" id="kiln-rest-no">Discard them</button>
      <button class="kiln-btn-publish" id="kiln-rest-yes">Restore edits</button>
    </div>`);
  m.querySelector('#kiln-rest-no').onclick = () => { clearSavedPending(); m.remove(); };
  m.querySelector('#kiln-rest-yes').onclick = () => {
    for (const [key, edit] of Object.entries(saved.edits)) {
      state.pending.set(key, edit);
      const esc = CSS.escape(key);
      // applyKeyDom handles BOTH plain fields and repeat containers (re-wiring the
      // repeat). The old code skipped repeats, so the DOM showed the un-restored
      // content while Publish committed the restored html — publishing what wasn't
      // previewed. Also restore attr edits (href/src/style), which were dropped.
      if (edit.html !== undefined) applyKeyDom(key, edit.html);
      if (edit.attrs) {
        document.querySelectorAll(`[data-cms="${esc}"]`).forEach(n => {
          for (const [a, v] of Object.entries(edit.attrs)) if (v !== undefined && v !== null) n.setAttribute(a, v);
        });
      }
      document.querySelectorAll(`[data-cms="${esc}"], [data-cms-repeat="${esc}"]`)
        .forEach(n => n.classList.add('kiln-modified'));
    }
    refreshPublishButton();
    setStatus(`${keys.length} edit${keys.length > 1 ? 's' : ''} restored — Publish when ready`, 'saved');
    m.remove();
  };
}

function escapeHtml(s) {
  return String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

/**
 * Neutralize dangerous URL schemes on href/src values. Attribute edits bypass
 * DOMPurify, so this is the gate. Allows relative/anchor/query URLs and the
 * http:, https:, mailto:, tel: schemes; everything else (javascript:, data:,
 * vbscript:, obfuscated "java\tscript:", …) collapses to a harmless '#'.
 */
function safeUrl(value) {
  const v = String(value);
  // Strip control + whitespace chars so "java\tscript:" can't slip past the scheme test.
  const stripped = v.replace(/[\u0000-\u001f\u007f ]/g, '');
  // Relative paths, anchors, query strings, and bare fragments are always fine.
  if (stripped === '' || /^[\/#.?]/.test(stripped)) return v;
  const scheme = stripped.match(/^[a-z][a-z0-9+.-]*:/i);
  if (!scheme) return v; // no scheme at all (e.g. "page.html") — relative, allow
  return /^(https?|mailto|tel):$/i.test(scheme[0]) ? v : '#';
}

function injectStyles() {
  const style = document.createElement('style');
  style.textContent = `
:root{--kiln-bg:rgba(16,16,25,.92);--kiln-accent:#6366f1;--kiln-accent-h:#4f46e5;--kiln-ok:#34d399;
  --kiln-warn:#fbbf24;--kiln-err:#f87171;--kiln-font:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',sans-serif}
#kiln-fab-wrap{position:fixed;bottom:20px;right:20px;z-index:999999;font-family:var(--kiln-font)}
#kiln-fab-wrap #kiln-undo-wrap{display:flex;flex-direction:row;gap:6px;position:absolute;right:0;bottom:58px}
#kiln-fab-wrap #kiln-undo-wrap[hidden]{display:none!important}
#kiln-fab-wrap #kiln-undo-wrap button{height:32px;padding:0 13px;border-radius:999px;border:none;cursor:pointer;
  background:#fff;color:#374151;box-shadow:0 3px 12px rgba(0,0,0,.18);display:inline-flex;align-items:center;gap:6px;
  font:600 12.5px var(--kiln-font);white-space:nowrap;transition:all .13s}
#kiln-fab-wrap #kiln-undo-wrap button:hover:not(:disabled){background:#eef2ff;color:var(--kiln-accent)}
#kiln-fab-wrap #kiln-undo-wrap button:disabled{opacity:.35;cursor:default}
#kiln-topbar #kiln-undo-wrap{display:inline-flex;gap:4px}
#kiln-topbar #kiln-undo-wrap[hidden]{display:none!important}
#kiln-topbar #kiln-undo-wrap button:disabled{opacity:.35}
#kiln-fab{position:relative;width:48px;height:48px;border-radius:50%;border:none;cursor:grab;
  background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;display:flex;align-items:center;
  justify-content:center;box-shadow:0 6px 24px rgba(79,70,229,.45),0 2px 6px rgba(0,0,0,.2);
  transition:transform .15s,box-shadow .15s;touch-action:none}
#kiln-fab:hover{transform:scale(1.07);box-shadow:0 8px 30px rgba(79,70,229,.55)}
#kiln-fab:active{cursor:grabbing}
#kiln-fab-badge{position:absolute;top:-4px;right:-4px;min-width:18px;height:18px;border-radius:9px;
  background:var(--kiln-warn);color:#1c1300;font-size:11px;font-weight:700;display:flex;
  align-items:center;justify-content:center;padding:0 5px;box-shadow:0 1px 4px rgba(0,0,0,.3)}
#kiln-fab-badge[hidden]{display:none!important}
#kiln-fab-menu[hidden]{display:none!important}
#kiln-fab-menu{position:absolute;width:230px;background:var(--kiln-bg);-webkit-backdrop-filter:blur(16px);
  backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,.09);border-radius:16px;padding:8px;
  box-shadow:0 18px 50px rgba(0,0,0,.4);display:flex;flex-direction:column;gap:3px}
.kiln-fab-head{display:flex;align-items:center;gap:8px;padding:6px 10px 8px}
.kiln-brand{font-weight:700;letter-spacing:.02em;font-size:14px;
  background:linear-gradient(135deg,#a5b4fc,#818cf8);-webkit-background-clip:text;background-clip:text;color:transparent}
.kiln-user{color:#9ca3af;font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kiln-fab-item{display:block;width:100%;text-align:left;background:none;border:none;color:#d6d8e1;
  padding:9px 10px;border-radius:9px;cursor:pointer;font-size:13px;font-family:var(--kiln-font);transition:background .12s}
.kiln-fab-item:hover{background:rgba(255,255,255,.08);color:#fff}
.kiln-fab-group{display:flex;flex-direction:column;gap:2px;border-top:1px solid rgba(255,255,255,.07);margin-top:4px;padding-top:5px}
.kiln-fab-group[hidden]{display:none}
.kiln-fab-label{font:600 9.5px var(--kiln-font);letter-spacing:.09em;text-transform:uppercase;color:#6b7280;padding:2px 10px 4px}
.kiln-fab-danger{color:#f9a8a8}
.kiln-fab-danger:hover{background:rgba(248,113,113,.16);color:#fff}
.kiln-fab-primary{background:var(--kiln-accent);color:#fff;font-weight:600;text-align:center}
.kiln-fab-primary:hover{background:var(--kiln-accent-h);color:#fff}
.kiln-fab-primary:disabled{opacity:.4;cursor:default;background:rgba(255,255,255,.08);color:#9ca3af;font-weight:500}
.kiln-fab-foot{display:flex;justify-content:space-between;border-top:1px solid rgba(255,255,255,.08);
  margin-top:4px;padding-top:6px}
.kiln-fab-foot button{background:none;border:none;color:#8b8e9c;font-size:11.5px;cursor:pointer;
  padding:5px 8px;border-radius:7px;font-family:var(--kiln-font)}
.kiln-fab-foot button:hover{color:#fff;background:rgba(255,255,255,.07)}
.kiln-status{position:absolute;white-space:nowrap;right:56px;top:50%;transform:translateY(-50%);
  background:var(--kiln-bg);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);
  color:#d6d8e1;font-size:12px;padding:8px 13px;border-radius:11px;border:1px solid rgba(255,255,255,.09);
  box-shadow:0 6px 22px rgba(0,0,0,.3);max-width:70vw;overflow:hidden;text-overflow:ellipsis}
.kiln-status{display:flex;align-items:center;gap:8px}
.kiln-status--saving{color:var(--kiln-warn)}
.kiln-spin{flex:none;width:13px;height:13px;border-radius:50%;border:2px solid rgba(251,191,36,.3);
  border-top-color:var(--kiln-warn);animation:kilnspin .7s linear infinite}
@keyframes kilnspin{to{transform:rotate(360deg)}}
.kiln-status--saved{color:var(--kiln-ok)}
.kiln-status--error{color:var(--kiln-err)}
.kiln-btn-publish{background:var(--kiln-accent);color:#fff;border:none;padding:7px 16px;border-radius:9px;
  cursor:pointer;font-size:13px;font-weight:600;font-family:var(--kiln-font);transition:background .15s,transform .1s}
.kiln-btn-publish:hover:not(:disabled){background:var(--kiln-accent-h);transform:translateY(-1px)}
.kiln-btn-publish:disabled{opacity:.35;cursor:default}
.kiln-btn-ghost{background:rgba(255,255,255,.06);color:#c7c9d4;border:1px solid rgba(255,255,255,.1);
  padding:6px 12px;border-radius:9px;cursor:pointer;font-size:12.5px;font-family:var(--kiln-font);
  white-space:nowrap;transition:all .15s}
.kiln-btn-ghost:hover{color:#fff;background:rgba(255,255,255,.12)}
.kiln-field{cursor:pointer;outline:2px dashed transparent;outline-offset:4px;border-radius:4px;transition:outline-color .15s}
.kiln-field:hover{outline-color:rgba(99,102,241,.75)}
.kiln-field.kiln-editing{outline:2px solid var(--kiln-accent);cursor:text;padding:2px 4px;min-width:40px}
.kiln-field.kiln-modified{outline:2px solid var(--kiln-warn)}
img.kiln-field:hover{outline-style:solid;filter:brightness(.9)}
.kiln-flash{animation:kilnflash 1.4s ease}
@keyframes kilnflash{0%{outline:3px solid var(--kiln-ok);outline-offset:6px}100%{outline:3px solid transparent;outline-offset:4px}}
#kiln-toolbar{position:absolute;background:var(--kiln-bg);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);
  color:#fff;padding:7px 9px;border-radius:12px;display:flex;align-items:center;gap:6px;
  font-family:var(--kiln-font);font-size:12px;z-index:999999;border:1px solid rgba(255,255,255,.08);
  box-shadow:0 10px 32px rgba(0,0,0,.35);flex-wrap:wrap;max-width:92vw}
.kiln-tb-label{color:#8b8e9c;margin-right:2px;font-size:11px}
.kiln-tb-hint{color:#8b8e9c;font-size:11px;font-style:italic}
#kiln-toolbar{cursor:grab;touch-action:none}
#kiln-pickbar{position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:9999998;display:flex;
  align-items:center;gap:14px;background:var(--kiln-bg);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);
  color:#d6d8e1;font:13px/1.45 var(--kiln-font);padding:10px 16px;border-radius:13px;
  border:1px solid rgba(255,255,255,.1);box-shadow:0 12px 40px rgba(0,0,0,.4);max-width:92vw}
#kiln-pickbar strong{color:#fff}
#kiln-pickbar kbd{background:rgba(255,255,255,.12);border-radius:4px;padding:1px 5px;font-size:11px}
#kiln-pickbar button{background:var(--kiln-accent);color:#fff;border:none;border-radius:8px;
  padding:6px 14px;font:600 12px var(--kiln-font);cursor:pointer;white-space:nowrap}
/* Restore-preview bar: same placement as the pick bar; the page shows the older
   version behind it until Keep or Cancel. */
#kiln-previewbar{position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:9999998;display:flex;
  align-items:center;gap:12px;background:var(--kiln-bg);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);
  color:#d6d8e1;font:13px/1.45 var(--kiln-font);padding:10px 16px;border-radius:13px;
  border:1px solid rgba(255,255,255,.1);box-shadow:0 12px 40px rgba(0,0,0,.4);max-width:92vw}
#kiln-previewbar strong{color:#fff}
#kiln-previewbar small{display:block;color:#9ca3af;font-size:11.5px}
#kiln-previewbar .kiln-btn-publish{white-space:nowrap}
.kiln-hist-row{flex-wrap:wrap}
.kiln-hist-acts{display:flex;gap:6px;flex:none}
.kiln-hist-acts .kiln-btn-ghost{font-size:11.5px;padding:5px 10px;white-space:nowrap}
/* Ghost buttons are styled for the dark menu — inside white modals (history
   rows) they were almost invisible. Give them real contrast there. */
.kiln-modal-body .kiln-inv-row .kiln-btn-ghost,.kiln-modal-body .kiln-hist-acts .kiln-btn-ghost{
  color:#1f2937;background:#f3f4f6;border:1px solid #cfd4db;font-weight:600}
.kiln-modal-body .kiln-inv-row .kiln-btn-ghost:hover,.kiln-modal-body .kiln-hist-acts .kiln-btn-ghost:hover{
  color:#fff;background:var(--kiln-accent);border-color:var(--kiln-accent)}
.kiln-hist-live{color:#059669;font-weight:700}
.kiln-pick-hover{outline:2px dashed #34d399!important;outline-offset:3px;cursor:copy!important}
.kiln-spot-hover{outline:2px dashed var(--kiln-accent)!important;outline-offset:4px;cursor:copy!important;position:relative}
.kiln-spot-hover::after{content:"new section goes here ↓";position:absolute;left:50%;bottom:-14px;transform:translateX(-50%);
  z-index:999999;background:var(--kiln-accent);color:#fff;font:600 12px var(--kiln-font);padding:4px 12px;border-radius:999px;white-space:nowrap}
.kiln-pick-hover[data-cms],.kiln-pick-hover[data-cms-repeat],.kiln-pick-hover[data-cms-menu]{outline-color:#f87171!important;cursor:not-allowed!important}
.kiln-img-handle{position:absolute;width:22px;height:22px;border-radius:50%;background:var(--kiln-accent);
  border:2.5px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.35);cursor:nwse-resize;z-index:9999998;touch-action:none}
.kiln-img-handle::after{content:"";position:absolute;inset:5px;border-right:2px solid #fff;border-bottom:2px solid #fff;
  border-radius:0 0 2px 0}
.kiln-img-handle-on{transform:scale(1.15)}
#kiln-imgpop{position:absolute;background:var(--kiln-bg);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);
  color:#fff;padding:6px 8px;border-radius:11px;display:flex;align-items:center;gap:5px;
  font-family:var(--kiln-font);font-size:12px;z-index:9999999;border:1px solid rgba(255,255,255,.08);
  box-shadow:0 10px 32px rgba(0,0,0,.35)}
#kiln-toolbar.kiln-tb-dragging{cursor:grabbing;opacity:.92}
.kiln-tb-grip{color:#6b7280;font-size:13px;line-height:1;padding:2px 1px;cursor:grab;user-select:none}
#kiln-toolbar.kiln-tb-dragging .kiln-tb-grip{cursor:grabbing}
.kiln-tb-gap{flex:0 0 2px;width:1px;height:18px;background:rgba(255,255,255,.12)}
.kiln-tb-fmt{background:rgba(255,255,255,.08);color:#e7e7ee;border:none;min-width:27px;height:26px;
  border-radius:7px;cursor:pointer;font-size:12px;display:inline-flex;align-items:center;justify-content:center;
  padding:0 6px;font-family:var(--kiln-font);transition:background .12s}
.kiln-tb-fmt:hover{background:rgba(99,102,241,.55)}
.kiln-tb-clear,.kiln-tb-attach{font-size:11.5px}
.kiln-href-input{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.12);color:#fff;
  border-radius:7px;padding:5px 8px;font-size:12px;width:190px;font-family:var(--kiln-font)}
.kiln-href-input::placeholder{color:#6b7280}
.kiln-tb-save{background:var(--kiln-accent);color:#fff;border:none;padding:5px 12px;border-radius:7px;
  cursor:pointer;font-size:12px;font-weight:600;font-family:var(--kiln-font)}
.kiln-tb-save:hover{background:var(--kiln-accent-h)}
.kiln-tb-cancel{background:transparent;color:#8b8e9c;border:none;padding:5px 8px;cursor:pointer;
  font-size:12px;font-family:var(--kiln-font)}
.kiln-tb-cancel:hover{color:#fff}
.kiln-style-select{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.12);color:#fff;
  border-radius:7px;padding:4px 5px;font-size:12px;max-width:120px;font-family:var(--kiln-font)}
.kiln-style-select option,.kiln-style-select optgroup{color:#1c1c28}
#kiln-modal{position:fixed;inset:0;background:rgba(10,10,18,.45);-webkit-backdrop-filter:blur(6px);
  backdrop-filter:blur(6px);z-index:9999999;display:flex;align-items:flex-start;justify-content:center;
  padding-top:9vh;font-family:var(--kiln-font)}
.kiln-modal-card{position:relative;background:#fff;color:#1c1c28;border-radius:18px;max-width:500px;width:92%;
  box-shadow:0 24px 80px rgba(0,0,0,.3);max-height:86vh;overflow:hidden;display:flex;flex-direction:column}
/* The X lives on the (non-scrolling) card, so it stays pinned in the corner while
   the body scrolls underneath — previously it sat in the scroll area and vanished. */
.kiln-modal-x{position:absolute;top:12px;right:12px;z-index:3;width:30px;height:30px;border-radius:50%;
  border:none;background:#eceef1;color:#4b5563;font-size:14px;cursor:pointer;display:flex;align-items:center;
  justify-content:center;transition:all .13s;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.kiln-modal-x:hover{background:#dfe2e6;color:#111}
.kiln-modal-body{padding:24px;overflow-y:auto;overflow-x:hidden;flex:1 1 auto;min-height:0}
.kiln-modal-body h3{margin:0 0 14px;font-size:17px;font-weight:700;letter-spacing:-.01em;padding-right:34px}
.kiln-tabs{display:flex;gap:6px;margin:0 0 14px;border-bottom:1.5px solid #eef0f3}
.kiln-tab{background:none;border:none;border-bottom:2px solid transparent;margin-bottom:-1.5px;color:#6b7280;
  font:600 13px var(--kiln-font);padding:7px 10px;cursor:pointer}
.kiln-tab:hover{color:#111}
.kiln-tab-on{color:var(--kiln-accent);border-bottom-color:var(--kiln-accent)}
.kiln-hist-prev{color:#374151;font-size:13px}
.kiln-modal-body h4{margin:16px 0 8px;font-size:11.5px;text-transform:uppercase;letter-spacing:.06em;color:#9ca3af}
.kiln-modal-body label{display:block;font-size:13px;color:#4b5563;margin-bottom:10px}
.kiln-modal-body input[type=text],.kiln-modal-body input[type=email],.kiln-modal-body input[type=number]{
  width:100%;padding:10px;border:1.5px solid #e5e7eb;border-radius:10px;font-size:14px;margin-top:4px;
  font-family:var(--kiln-font);transition:border-color .15s;outline:none}
.kiln-modal-body input:focus{border-color:var(--kiln-accent)}
.kiln-2col{display:grid;grid-template-columns:1.4fr 1fr;gap:10px}
@media(max-width:480px){.kiln-2col{grid-template-columns:1fr}
  .kiln-tb-fmt{min-width:34px;height:34px}
  #kiln-toolbar .kiln-href-input{width:100%}
  .kiln-item-ctl button{width:34px;height:34px}}
.kiln-modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
.kiln-modal-actions .kiln-btn-ghost{color:#4b5563;border-color:#e5e7eb;background:#f9fafb}
.kiln-modal-actions .kiln-btn-ghost:hover{color:#111;background:#f3f4f6}
.kiln-roles{display:flex;flex-direction:column;gap:8px;margin:10px 0}
.kiln-role{display:flex;gap:10px;align-items:flex-start;border:1.5px solid #e5e7eb;border-radius:12px;
  padding:11px;cursor:pointer;transition:all .15s}
.kiln-role:has(input:checked){border-color:var(--kiln-accent);background:#eef2ff}
.kiln-role small{color:#6b7280;line-height:1.45}
.kiln-summary{cursor:pointer;font-size:13px;color:#6b7280;padding:4px 0;font-weight:600}
.kiln-linkrow{display:flex;gap:8px;margin-top:8px}
.kiln-linkrow input{flex:1;font-size:12px;color:#374151}
.kiln-inv-ok{font-size:13px;color:#059669;margin-top:12px}
.kiln-hr{border:none;border-top:1px solid #f3f4f6;margin:18px 0 10px}
/* A clearly-clickable "pick from a list" button — the ghost style was too muted to read as an action. */
.kiln-btn-pick{display:inline-flex;align-items:center;gap:5px;margin-left:6px;padding:4px 11px;font:600 12px var(--kiln-font);
  color:var(--kiln-accent);background:#eef2ff;border:1.5px solid var(--kiln-accent);border-radius:8px;cursor:pointer;
  vertical-align:middle;transition:all .13s}
.kiln-btn-pick:hover{background:var(--kiln-accent);color:#fff}
.kiln-btn-pick[aria-expanded=true]{background:var(--kiln-accent);color:#fff}
/* Picker checklists sit INSIDE the scrolling modal body — no inner scroll (that made
   the dreaded scroll-within-a-scroll); the whole modal scrolls as one surface. */
.kiln-pick-box{margin:0 0 10px;border:1.5px solid #eef0f3;border-radius:10px;padding:4px 10px}
.kiln-pick-box .kiln-pick-group{font:700 11px var(--kiln-font);text-transform:uppercase;letter-spacing:.05em;
  color:#6b7280;margin:9px 0 3px;padding-top:8px;border-top:1px solid #f3f4f6}
.kiln-pick-box .kiln-pick-group:first-child{border-top:none;padding-top:2px;margin-top:4px}
.kiln-inv-list{display:flex;flex-direction:column;gap:6px}
.kiln-inv-row{display:flex;justify-content:space-between;align-items:center;border:1.5px solid #f3f4f6;
  border-radius:10px;padding:9px 12px;font-size:13px;gap:8px}
.kiln-inv-row small{color:#9ca3af;display:block;margin-top:1px}
.kiln-dim{color:#9ca3af;font-size:12px;margin-top:10px;line-height:1.5}
.kiln-np-step{font-size:13px;color:#4b5563;min-height:20px;line-height:1.5}
.kiln-repeat-item{position:relative}
.kiln-item-ctl{position:absolute;top:8px;right:8px;display:flex;gap:5px;z-index:9999;opacity:0;transition:opacity .15s}
.kiln-repeat-item:hover>.kiln-item-ctl{opacity:1}
.kiln-row-editing .kiln-item-ctl{opacity:0!important;pointer-events:none}
/* Table rows keep their controls in a dedicated end-of-row cell (a floating
   overlay would cover the last column's text while typing). */
.kiln-ctl-cell{width:1%;white-space:nowrap;vertical-align:middle;background:none!important;border:none!important;padding:2px 4px!important}
.kiln-ctl-cell .kiln-item-ctl{position:static;display:flex;opacity:0}
.kiln-repeat-item:hover .kiln-ctl-cell .kiln-item-ctl{opacity:1}
/* An empty field being edited must still show a caret and accept clicks. */
.kiln-editing:empty{min-width:70px;min-height:1.15em;display:inline-block}
td.kiln-editing:empty,th.kiln-editing:empty{display:table-cell}
.kiln-editing{caret-color:var(--kiln-accent)}
/* Touch devices have no hover: keep block controls permanently visible so
   move/duplicate/tag/remove (and the only reorder path on a phone) are reachable. */
@media(hover:none){.kiln-item-ctl{opacity:1}}
.kiln-item-ctl button{background:var(--kiln-bg);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);
  color:#fff;border:1px solid rgba(255,255,255,.1);width:27px;height:27px;border-radius:8px;
  cursor:pointer;font-size:13px;box-shadow:0 4px 12px rgba(0,0,0,.25);transition:background .12s}
.kiln-item-ctl button:hover{background:var(--kiln-accent)}
.kiln-repeat-add{display:block;margin:10px auto 0;background:rgba(99,102,241,.08);color:var(--kiln-accent);
  border:1.5px dashed rgba(99,102,241,.5);border-radius:10px;padding:8px 18px;cursor:pointer;
  font-size:13px;font-weight:600;font-family:var(--kiln-font);transition:all .15s}
.kiln-repeat-add:hover{background:rgba(99,102,241,.16)}
/* Gallery thumbnail grid — mirrors features.js so EDITORS see thumbnails too
   (the visitor runtime stands down during editing sessions). */
.kiln-gallery-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(var(--kiln-thumb,180px),1fr));gap:10px}
.kiln-gallery-grid figure{margin:0}
.kiln-gallery-grid img{width:100%;height:100%;aspect-ratio:1/1;object-fit:cover;border-radius:8px;display:block}
.kiln-gallery-grid figcaption{font-size:.8em;opacity:.75;padding:4px 2px}
.kiln-gallery-grid .kiln-repeat-add,.kiln-gallery-grid .kiln-gallery-opts{align-self:center;aspect-ratio:auto}
.kiln-gallery-opts{font-size:12px!important;opacity:.85}
.kiln-filterbar-preview{display:flex;flex-wrap:wrap;gap:7px;align-items:center;margin:0 0 14px;
  padding:8px 10px;border:1.5px dashed rgba(99,102,241,.4);border-radius:11px;background:rgba(99,102,241,.05)}
.kiln-fp-label{font:600 10.5px var(--kiln-font);letter-spacing:.08em;text-transform:uppercase;color:var(--kiln-accent);margin-right:2px}
.kiln-fp-pill{border:1.5px solid rgba(99,102,241,.4);background:#fff;color:#4b5563;border-radius:999px;
  padding:4px 13px;font:500 12.5px var(--kiln-font);cursor:pointer;transition:all .13s}
.kiln-fp-pill:hover{border-color:var(--kiln-accent)}
.kiln-fp-pill.kiln-fp-on{background:var(--kiln-accent);color:#fff;border-color:var(--kiln-accent);font-weight:600}
.kiln-menu-row{display:flex;gap:6px;margin-bottom:6px;align-items:center}
.kiln-menu-row input{flex:1;padding:8px!important;margin:0!important}
.kiln-menu-row .kiln-menu-href{flex:1.2}
.kiln-menu-row button{background:#f9fafb;border:1.5px solid #e5e7eb;border-radius:8px;width:28px;height:34px;
  cursor:pointer;font-size:12px;transition:background .12s}
.kiln-menu-row button:hover{background:#eef2ff}
#kiln-topbar{position:fixed;top:0;left:0;right:0;height:46px;background:var(--kiln-bg);
  -webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);color:#e7e7ee;display:flex;
  align-items:center;gap:8px;padding:0 12px;z-index:99999;font-family:var(--kiln-font);
  font-size:13px;border-bottom:1px solid rgba(255,255,255,.07);overflow-x:auto}
#kiln-topbar .kiln-status{position:static;transform:none;box-shadow:none;border:none;background:none;max-width:30vw}
.kiln-bar-spacer{flex:1}
body:has(#kiln-topbar){padding-top:46px!important}
.kiln-dragging{opacity:.45;outline:2px dashed var(--kiln-accent)!important}
#kiln-scope-note{position:fixed;left:16px;bottom:16px;z-index:999998;display:flex;align-items:center;gap:8px;
  background:var(--kiln-bg);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);color:#d6d8e1;
  font:12px/1.4 var(--kiln-font);padding:8px 13px;border-radius:11px;border:1px solid rgba(255,255,255,.14);
  box-shadow:0 6px 22px rgba(0,0,0,.3);max-width:74vw}
#kiln-presence{position:fixed;left:16px;bottom:16px;z-index:999998;display:flex;align-items:center;gap:8px;
  background:var(--kiln-bg);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);color:#fbbf24;
  font:12px/1.4 var(--kiln-font);padding:8px 13px;border-radius:11px;border:1px solid rgba(251,191,36,.35);
  box-shadow:0 6px 22px rgba(0,0,0,.3);max-width:74vw}
.kiln-presence-dot{width:8px;height:8px;border-radius:50%;background:#fbbf24;flex:none;
  animation:kilnpulse 2s ease-in-out infinite}
#kiln-online{display:inline-flex;align-items:center;gap:6px;margin-left:auto;background:rgba(52,211,153,.14);
  color:#34d399;border:1px solid rgba(52,211,153,.3);border-radius:999px;padding:3px 10px;font:600 11px var(--kiln-font);cursor:pointer}
#kiln-online:hover{background:rgba(52,211,153,.22)}
.kiln-online-dot{width:7px;height:7px;border-radius:50%;background:#34d399;animation:kilnpulse 2s ease-in-out infinite}
#kiln-topbar #kiln-online{margin-left:8px}
@keyframes kilnpulse{0%,100%{opacity:1}50%{opacity:.35}}
#kiln-menu-add{margin-top:4px;color:#4b5563;border-color:#e5e7eb;background:#f9fafb}`;
  document.head.appendChild(style);
}
