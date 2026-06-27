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
import { indexHtml, applyEdits, pageFileCandidates, editHead, readHead } from '../engine.js';
import {
  makeGh, getFile, resolvePageFile, editFile, putBinaryFile, commitFiles, deployState,
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

const SANITIZE = {
  ALLOWED_TAGS: ['a', 'abbr', 'b', 'blockquote', 'br', 'code', 'em', 'h1', 'h2', 'h3', 'h4',
    'h5', 'h6', 'i', 'img', 'li', 'mark', 'ol', 'p', 's', 'small', 'span', 'strong', 'sub',
    'sup', 'u', 'ul'],
  ALLOWED_ATTR: ['href', 'target', 'rel', 'title', 'class', 'src', 'alt', 'data-kiln-src'],
};

// Repeat containers carry the site's own structural markup, so the allowlist is wider.
const CONTAINER_SANITIZE = {
  ALLOWED_TAGS: ['a', 'abbr', 'article', 'b', 'br', 'code', 'div', 'em', 'figcaption', 'figure',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'i', 'img', 'li', 'mark', 'ol', 'p', 's', 'section',
    'small', 'span', 'strong', 'sub', 'sup', 'u', 'ul'],
  ALLOWED_ATTR: ['href', 'target', 'rel', 'title', 'class', 'src', 'alt',
    'data-cms', 'data-cms-attr', 'data-cms-plain'],
};

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
};

init().catch(err => {
  console.error('[kiln]', err);
  setStatus('Kiln failed to start — see console', 'error');
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
  renderAdminBar();
  decorateFields();
  offerPendingRestore();
  if (journalAll().length) runJournal();
  checkForDraft();

  window.addEventListener('beforeunload', (e) => {
    if (state.pending.size) { e.preventDefault(); e.returnValue = ''; }
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
  state.page = await resolvePageFile(state.gh, cfg.repo, candidates, cfg.branch || 'main');
  state.fields = indexHtml(state.page.text);
  for (const w of state.fields.warnings) console.warn('[kiln]', w);
}

// ─── Field decoration + inline editing ───────────────────────────────────────

function decorateFields() {
  document.querySelectorAll('[data-cms]').forEach((el) => {
    const key = el.getAttribute('data-cms');
    const source = state.fields.fields.get(key);
    const inRepeat = !!el.closest('[data-cms-repeat]');
    if (!source && !inRepeat) {
      console.warn(`[kiln] "${key}" is on the page but not in ${state.page.path}`);
      return;
    }
    if (source && (source.kind === 'list' || source.kind === 'menu')) return; // structural, never inline-editable
    decorateField(el, key);
  });

  document.querySelectorAll('[data-cms-repeat]').forEach((container) => {
    const key = container.getAttribute('data-cms-repeat');
    if (!state.fields.fields.has(key)) {
      console.warn(`[kiln] repeat "${key}" not found in ${state.page.path}`);
      return;
    }
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
}

function decorateField(el, key) {
  el.classList.add('kiln-field');
  el.title = `Edit: ${key}`;
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
  [...container.children].forEach((item) => attachItemControls(container, key, item));

  // A visible "+ Add" so adding a card/document doesn't depend on discovering
  // the hover controls. It clones the last block, ready to edit.
  const add = document.createElement('button');
  add.className = 'kiln-repeat-add';
  add.textContent = '+ Add block';
  add.onclick = (e) => {
    e.stopPropagation();
    const last = [...container.children].filter(c => !c.classList.contains('kiln-repeat-add')).pop();
    if (!last) return;
    const clone = last.cloneNode(true);
    clone.querySelectorAll('.kiln-item-ctl, #kiln-toolbar').forEach(n => n.remove());
    clone.classList.remove('kiln-repeat-item');
    clone.querySelectorAll('[data-cms]').forEach(n => {
      n.classList.remove('kiln-field', 'kiln-editing', 'kiln-modified');
      n.removeAttribute('contenteditable');
    });
    container.insertBefore(clone, add);
    clone.querySelectorAll('[data-cms]').forEach(n => decorateField(n, n.getAttribute('data-cms')));
    attachItemControls(container, key, clone);
    stageContainer(container, key);
    clone.scrollIntoView({ behavior: 'smooth', block: 'center' });
    clone.classList.add('kiln-flash');
    setTimeout(() => clone.classList.remove('kiln-flash'), 1600);
    setStatus('Block added — click its text to edit, then Publish', 'saved');
  };
  container.appendChild(add);
}

function attachItemControls(container, key, item) {
  if (item.querySelector(':scope > .kiln-item-ctl')) return;
  item.classList.add('kiln-repeat-item');
  const ctl = document.createElement('div');
  ctl.className = 'kiln-item-ctl';
  ctl.innerHTML = `<button title="Move up">↑</button><button title="Move down">↓</button><button title="Duplicate this block">＋</button><button title="Remove this block">✕</button>`;
  const [up, down, dup, del] = ctl.querySelectorAll('button');
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
    clone.querySelectorAll('.kiln-item-ctl, #kiln-toolbar').forEach(n => n.remove());
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
    if (container.children.length <= 1) { setStatus('Keep at least one block (edit it instead)', 'error'); return; }
    if (!confirm('Remove this block? (You can still Cancel by leaving without publishing.)')) return;
    item.remove();
    stageContainer(container, key);
  };
  item.appendChild(ctl);

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

/** Stage a repeat container's full cleaned innerHTML as one pending edit. */
function stageContainer(container, key) {
  const clone = container.cloneNode(true);
  clone.querySelectorAll('.kiln-item-ctl, #kiln-toolbar, .kiln-repeat-add').forEach(n => n.remove());
  clone.querySelectorAll('[contenteditable]').forEach(n => n.removeAttribute('contenteditable'));
  clone.querySelectorAll('.kiln-field, .kiln-editing, .kiln-modified, .kiln-repeat-item').forEach(n => {
    n.classList.remove('kiln-field', 'kiln-editing', 'kiln-modified', 'kiln-repeat-item');
    if (n.getAttribute('class') === '') n.removeAttribute('class');
    if (n.hasAttribute('data-cms')) n.removeAttribute('title');
  });
  clone.querySelectorAll('img[data-kiln-src]').forEach(img => {
    img.setAttribute('src', img.getAttribute('data-kiln-src'));
    img.removeAttribute('data-kiln-src');
  });
  const html = DOMPurify.sanitize(clone.innerHTML, CONTAINER_SANITIZE);
  container.classList.add('kiln-modified');
  stagePending(key, { html });
}

function startEditing(el, key) {
  if (state.active) cancelEditing();
  state.active = el;
  if (!state.originals.has(key)) state.originals.set(key, el.innerHTML);
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
  const pendingEdit = state.pending.get(key);
  el.innerHTML = pendingEdit?.html ?? state.originals.get(key) ?? el.innerHTML;
  state.active = null;
  removeToolbar();
}

function stagePending(key, patch) {
  const cur = state.pending.get(key) || {};
  if (patch.html !== undefined) cur.html = patch.html;
  if (patch.attrs) cur.attrs = { ...(cur.attrs || {}), ...patch.attrs };
  state.pending.set(key, cur);
  refreshPublishButton();
}

function commitEdit(el, key) {
  const plain = el.hasAttribute('data-cms-plain');
  const value = plain
    ? escapeHtml(el.textContent)
    : DOMPurify.sanitize(el.innerHTML, SANITIZE);
  el.innerHTML = value;
  el.contentEditable = 'false';
  el.classList.remove('kiln-editing');
  el.classList.add('kiln-modified');

  // Link elements: apply the toolbar's href before staging (scheme-sanitized).
  const hrefInput = document.querySelector('#kiln-toolbar .kiln-href-input');
  const hrefValue = hrefInput ? safeUrl(hrefInput.value) : null;
  const hrefChanged = hrefInput && el.tagName === 'A' && hrefValue !== el.getAttribute('href');
  if (hrefChanged) el.setAttribute('href', hrefValue);

  const repeat = el.closest('[data-cms-repeat]');
  if (repeat) {
    // Fields inside repeatable blocks publish as the whole container,
    // so duplicated blocks (with duplicate keys) stay unambiguous.
    stageContainer(repeat, repeat.getAttribute('data-cms-repeat'));
  } else {
    stagePending(key, { html: committedHtml(el, plain, value) });
    if (hrefChanged) stagePending(key, { attrs: { href: hrefValue } });
  }
  state.active = null;
  removeToolbar();
}

/** The HTML to commit for a field: blob previews are swapped for their real repo paths. */
function committedHtml(el, plain, fallback) {
  if (plain) return fallback;
  const clone = el.cloneNode(true);
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
  const rect = img.getBoundingClientRect();
  tb.innerHTML = `
    <span class="kiln-tb-label">${escapeHtml(key)}</span>
    <button class="kiln-tb-fmt kiln-tb-attach" data-act="replace">Replace image…</button>
    <input class="kiln-href-input" data-act="alt" type="text" value="${escapeHtml(img.getAttribute('alt') || '')}"
      placeholder="Describe this image (alt text)" title="Alt text — read by screen readers and search engines">
    <button class="kiln-tb-save" data-act="done">Done</button>`;
  tb.style.top = `${Math.max(rect.top + window.scrollY - 46, window.scrollY + 8)}px`;
  tb.style.left = `${Math.max(rect.left + window.scrollX, 8)}px`;
  document.body.appendChild(tb);

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
  tb.querySelector('[data-act="done"]').onclick = (e) => { e.stopPropagation(); finish(); };
  const away = (e) => {
    if (!tb.contains(e.target) && e.target !== img) { finish(); document.removeEventListener('click', away); }
  };
  setTimeout(() => document.addEventListener('click', away), 0);
}

function pickImage(img, key) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      setStatus('Uploading image…', 'saving');
      const { blob, base64, ext } = await downscale(file);
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
      const slug = (file.name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'image');
      const name = `${slug}-${Date.now().toString(36)}.${ext}`;
      const repoPath = (cfg.root ? cfg.root.replace(/\/+$/, '') + '/' : '') + `assets/uploads/${name}`;
      const urlPath = `/assets/uploads/${name}`;
      await putBinaryFile(state.gh, cfg.repo, repoPath, {
        base64, branch: cfg.branch || 'main',
        message: `Upload ${name} (via Kiln)`,
      });
      // Show the LOCAL image immediately — the real URL only exists after the
      // next deploy, so pointing at it now would render a broken image.
      img.src = URL.createObjectURL(blob);
      img.setAttribute('data-kiln-src', urlPath);
      img.classList.add('kiln-modified');
      const repeat = img.closest('[data-cms-repeat]');
      if (repeat) stageContainer(repeat, repeat.getAttribute('data-cms-repeat'));
      else stagePending(key, { attrs: { src: safeUrl(urlPath) } });
      setStatus('Image staged — hit Publish to put it live', 'saved');
    } catch (err) {
      console.error('[kiln] image upload', err);
      setStatus('Image upload failed', 'error');
    }
  };
  input.click();
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
      setStatus('Uploading image…', 'saving');
      const { blob, base64, ext } = await downscale(file, 1200);
      const slug = (file.name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'image');
      const name = `${slug}-${Date.now().toString(36)}.${ext}`;
      const repoPath = (cfg.root ? cfg.root.replace(/\/+$/, '') + '/' : '') + `assets/uploads/${name}`;
      const urlPath = `/assets/uploads/${name}`;
      await putBinaryFile(state.gh, cfg.repo, repoPath, {
        base64, branch: cfg.branch || 'main', message: `Upload ${name} (via Kiln)`,
      });
      const blobUrl = URL.createObjectURL(blob);
      el.focus();
      document.execCommand('insertHTML', false,
        `<img src="${blobUrl}" data-kiln-src="${urlPath}" alt="" style="max-width:100%">`);
      setStatus('Image inserted — Save, then Publish', 'saved');
    } catch (err) {
      console.error('[kiln] inline image', err);
      setStatus('Image upload failed', 'error');
    }
  };
  input.click();
}

/** Upload any file (PDF, doc, …) and return its site path. Members pages upload into the gated folder. */
function uploadAnyFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return resolve(null);
      if (file.size > 15 * 1024 * 1024) { setStatus('Files over 15 MB don’t belong in a Git repo', 'error'); return resolve(null); }
      try {
        setStatus(`Uploading ${file.name}…`, 'saving');
        const buf = new Uint8Array(await file.arrayBuffer());
        let bin = '';
        for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        const safe = file.name.toLowerCase().replace(/[^a-z0-9.]+/g, '-');
        const gated = location.pathname.startsWith('/members');
        const dir = gated ? 'members/files' : 'assets/files';
        const repoPath = (cfg.root ? cfg.root.replace(/\/+$/, '') + '/' : '') + `${dir}/${safe}`;
        await putBinaryFile(state.gh, cfg.repo, repoPath, {
          base64: btoa(bin), branch: cfg.branch || 'main', message: `Upload ${safe} (via Kiln)`,
        });
        setStatus(`${file.name} uploaded ✓ ${gated ? '(members-only)' : ''} — goes live with your next Publish`, 'saved');
        resolve(`/${dir}/${safe}`);
      } catch (err) {
        console.error('[kiln] file upload', err);
        setStatus('File upload failed', 'error');
        resolve(null);
      }
    };
    input.click();
  });
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
  if (!state.pending.size) return;
  if (cfg.sandbox) return publishSandbox();
  const edits = flattenPending();
  const keys = [...state.pending.keys()].join(', ');
  setStatus('Publishing — committing to GitHub…', 'saving');
  disablePublish(true);
  try {
    const result = await editFile(
      state.gh, cfg.repo, state.page.path, cfg.branch || 'main',
      (text) => {
        const { html, skipped } = applyEdits(text, edits);
        for (const s of skipped) console.warn('[kiln] skipped:', s);
        return html;
      },
      `Edit ${state.page.path}: ${keys} (via Kiln)`
    );
    state.pending.clear();
    document.querySelectorAll('.kiln-modified').forEach(el => el.classList.remove('kiln-modified'));
    state.originals.clear();
    await loadPageSource();
    refreshPublishButton();
    if (result.unchanged) { setStatus('Nothing changed', 'idle'); return; }
    watchDeploy(result.commit?.sha, result.text);
  } catch (err) {
    console.error('[kiln] publish', err);
    setStatus('Publish failed — see console', 'error');
    disablePublish(false);
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
      .map(r => wrap(`<a href="${escapeHtml(r.href.trim() || '/')}">${escapeHtml(r.label.trim())}</a>`))
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

async function invitePanel() {
  const m = modal(`
    <h3>People &amp; access</h3>
    <p class="kiln-dim" id="kiln-gstatus">Checking Google sign-in…</p>
    <div id="kiln-people-form" style="display:none">
      <label>Google email <input type="email" id="kiln-p-email" placeholder="them@gmail.com"></label>
      <div class="kiln-2col">
        <label>Name <input type="text" id="kiln-p-name" placeholder="Claudia"></label>
        <label>Access (days) <input type="number" id="kiln-p-days" value="90" min="1" max="360"></label>
      </div>
      <div class="kiln-roles">
        <label class="kiln-role"><input type="radio" name="kiln-p-role" value="editor" checked>
          <span><strong>Editor</strong><br><small>Edits pages, images, posts. Signs in with their Google account.</small></span></label>
        <label class="kiln-role"><input type="radio" name="kiln-p-role" value="member">
          <span><strong>Member</strong><br><small>Views the members-only area and documents. Cannot edit.</small></span></label>
      </div>
      <label id="kiln-p-paths-wrap">Pages this editor can edit
        <input type="text" id="kiln-p-paths" placeholder="whole site — or e.g. blog, about.html"></label>
      <p class="kiln-dim" id="kiln-p-paths-hint" style="margin:-2px 0 6px;font-size:12px">Comma-separated folders or files they may edit. Leave blank for the whole site. Editors can never touch CNAME, _redirects, or .github.</p>
      <div class="kiln-modal-actions" style="justify-content:flex-start;margin-top:8px">
        <button class="kiln-btn-publish" id="kiln-p-add">Add person</button>
      </div>
      <div id="kiln-people-list" class="kiln-inv-list" style="margin-top:10px">Loading…</div>
    </div>
    <div class="kiln-modal-actions"><button class="kiln-btn-ghost" data-close>Close</button></div>`);

  const admin = () => JSON.parse(localStorage.getItem(ADMIN_KEY));

  // Show the path-scope field only when adding an editor.
  const pathsWrap = m.querySelector('#kiln-p-paths-wrap');
  const pathsHint = m.querySelector('#kiln-p-paths-hint');
  function syncRole() {
    const isEditor = m.querySelector('input[name="kiln-p-role"]:checked').value === 'editor';
    pathsWrap.style.display = isEditor ? '' : 'none';
    pathsHint.style.display = isEditor ? '' : 'none';
  }
  m.querySelectorAll('input[name="kiln-p-role"]').forEach(r => r.addEventListener('change', syncRole));
  syncRole();

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
        const scope = p.role === 'editor' ? (realPaths.length ? realPaths.join(', ') : 'whole site') : '';
        const row = document.createElement('div');
        row.className = 'kiln-inv-row';
        row.innerHTML = `<span><strong>${escapeHtml(p.name)}</strong>
          <small>${escapeHtml(p.email)} · ${p.role}${scope ? ' · ' + escapeHtml(scope) : ''} · ${p.days}d</small></span>
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
    const days = m.querySelector('#kiln-p-days').value;
    const role = m.querySelector('input[name="kiln-p-role"]:checked').value;
    const paths = m.querySelector('#kiln-p-paths').value.trim();
    if (!email) return;
    const res = await fetch(`${cfg.worker}/admin/people`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin().token}` },
      body: JSON.stringify({ repo: cfg.repo, email, name, role, days, paths }),
    });
    const data = await res.json();
    if (data.ok) {
      m.querySelector('#kiln-p-email').value = '';
      m.querySelector('#kiln-p-name').value = '';
      m.querySelector('#kiln-p-paths').value = '';
      refreshPeople();
    }
  };
}

// ─── History (per-page restore points) ───────────────────────────────────────

async function historyPanel() {
  const m = modal(`
    <h3>History — ${escapeHtml(state.page.path)}</h3>
    <p class="kiln-dim">Every publish is a snapshot. Restoring puts that version of THIS page
    back as a new change (nothing is ever lost).</p>
    <div id="kiln-hist" class="kiln-inv-list">Loading…</div>
    <div class="kiln-modal-actions"><button class="kiln-btn-ghost" data-close>Close</button></div>
    <p class="kiln-np-step" id="kiln-hist-status"></p>`);
  const list = m.querySelector('#kiln-hist');
  const status = m.querySelector('#kiln-hist-status');
  try {
    const commits = await state.gh.request('GET',
      `/repos/${cfg.repo}/commits?path=${encodeURIComponent(state.page.path)}&per_page=15`);
    list.innerHTML = commits.length ? '' : '<p class="kiln-dim">No history yet.</p>';
    commits.forEach((c, i) => {
      const div = document.createElement('div');
      div.className = 'kiln-inv-row';
      const when = new Date(c.commit.author.date).toLocaleString(undefined,
        { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      div.innerHTML = `<span><strong>${escapeHtml(c.commit.message.split('\n')[0].slice(0, 60))}</strong>
        <small>${when} · ${escapeHtml(c.commit.author.name)}</small></span>
        ${i === 0 ? '<small class="kiln-dim">current</small>' : '<button class="kiln-btn-ghost">Restore</button>'}`;
      const btn = div.querySelector('button');
      if (btn) btn.onclick = async () => {
        btn.disabled = true;
        status.textContent = 'Restoring…';
        try {
          const old = await getFile(state.gh, cfg.repo, state.page.path, c.sha);
          const result = await editFile(state.gh, cfg.repo, state.page.path, cfg.branch || 'main',
            () => old.text, `Restore ${state.page.path} to ${c.sha.slice(0, 7)} (via Kiln)`);
          if (result.unchanged) { status.textContent = 'That version is identical to the current one.'; btn.disabled = false; return; }
          status.textContent = 'Restored ✓ — Kiln is watching for it to go live (safe to close this).';
          watchDeploy(result.commit?.sha, result.text);
        } catch (err) {
          status.textContent = `Restore failed: ${err.message}`;
          btn.disabled = false;
        }
      };
      list.appendChild(div);
    });
  } catch (err) {
    list.innerHTML = `<p class="kiln-dim">Could not load history: ${escapeHtml(err.message)}</p>`;
  }
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
    <div class="kiln-modal-actions">
      <button class="kiln-btn-ghost" data-close>Cancel</button>
      <button class="kiln-btn-publish" id="kiln-ps-go">Publish</button>
    </div>
    <p class="kiln-np-step" id="kiln-ps-status"></p>`);
  m.querySelector('#kiln-ps-go').onclick = async () => {
    const title = m.querySelector('#kiln-ps-title').value;
    const description = m.querySelector('#kiln-ps-desc').value;
    const status = m.querySelector('#kiln-ps-status');
    status.textContent = 'Publishing…';
    try {
      const result = await editFile(state.gh, cfg.repo, state.page.path, cfg.branch || 'main',
        (text) => editHead(text, { title, description }),
        `Page settings: ${state.page.path} (via Kiln)`);
      if (result.unchanged) { status.textContent = 'Nothing changed.'; return; }
      await loadPageSource();
      journalAdd({ type: 'compare', target: location.pathname, expect: djb2(result.text), desc: 'Page settings' });
      status.textContent = 'Committed ✓ — safe to close; Kiln will confirm when live.';
    } catch (err) { status.textContent = `Failed: ${err.message}`; }
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
      status.textContent = 'Committed ✓ — Kiln will confirm when live. Reload to see it.';
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
      const edits = flattenPending();
      const futureText = applyEdits(state.page.text, edits).html;
      const b64 = (await import('../github.js')).encodeContent(futureText);
      const res = await fetch(`${cfg.worker}/schedule`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ repo: cfg.repo, path: state.page.path, branch: cfg.branch || 'main',
          content: b64, at: new Date(at).toISOString(),
          message: `Scheduled edit: ${state.page.path} (via Kiln)`,
          desc: `${state.page.path} (${[...state.pending.keys()].slice(0, 3).join(', ')})` }) });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'failed');
      state.pending.clear();
      clearSavedPending();
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
  const m = modal(`
    <h3>Settings</h3>
    <h4>Your editor (this browser)</h4>
    <div class="kiln-roles">
      <label class="kiln-role"><input type="radio" name="kiln-uimode" value="fab" ${ui === 'fab' ? 'checked' : ''}>
        <span><strong>Floating button</strong><br><small>Draggable circle; hover for the menu.</small></span></label>
      <label class="kiln-role"><input type="radio" name="kiln-uimode" value="bar" ${ui === 'bar' ? 'checked' : ''}>
        <span><strong>Top bar</strong><br><small>Fixed bar with all actions visible.</small></span></label>
    </div>
    <h4>This site (applies to everyone, committed to the repo)</h4>
    <label class="kiln-role"><input type="checkbox" id="kiln-set-google" ${auth.google !== false ? 'checked' : ''}>
      <span><strong>Google sign-in</strong><br><small>Invited editors and members sign in with their Google account at yoursite.com/kiln.</small></span></label>
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
    const google = m.querySelector('#kiln-set-google').checked;
    const siteChanged = google !== (cfg.auth?.google !== false);
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

// ─── Done / exit ─────────────────────────────────────────────────────────────

function doneEditing() {
  if (state.pending.size) {
    const m = modal(`
      <h3>You have ${state.pending.size} unpublished edit${state.pending.size > 1 ? 's' : ''}</h3>
      <p class="kiln-dim">Publish them first, or discard and exit?</p>
      <div class="kiln-modal-actions">
        <button class="kiln-btn-ghost" data-close>Keep editing</button>
        <button class="kiln-btn-ghost" id="kiln-discard">Discard &amp; exit</button>
        <button class="kiln-btn-publish" id="kiln-pub-exit">Publish first</button>
      </div>`);
    m.querySelector('#kiln-discard').onclick = () => { state.pending.clear(); exitEditMode(); };
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
      <button id="kiln-discard" class="kiln-fab-item" hidden>Discard edits</button>
      <button id="kiln-schedule" class="kiln-fab-item" hidden>Schedule for later…</button>
      <button id="kiln-draft" class="kiln-fab-item" hidden>Save as draft</button>
      <button id="kiln-newpost" class="kiln-fab-item">＋ New post or page</button>
      <button id="kiln-menu" class="kiln-fab-item">Site menu</button>
      <button id="kiln-pagesettings" class="kiln-fab-item">Page settings</button>
      <button id="kiln-findreplace" class="kiln-fab-item">Find &amp; replace</button>
      <button id="kiln-history" class="kiln-fab-item">History</button>
      ${mode === 'admin' ? '<button id="kiln-invite" class="kiln-fab-item">People &amp; access</button>' : ''}
      ${mode === 'admin' ? '<button id="kiln-settings" class="kiln-fab-item">Settings</button>' : ''}
      <div class="kiln-fab-foot">
        <button id="kiln-done" title="Hide Kiln and browse normally (stays signed in — return via the Resume button or yoursite.com/kiln)">Done editing</button>
        <button id="kiln-signout">Sign out</button>
      </div>
    </div>
    <button id="kiln-fab" title="Kiln — drag me anywhere" aria-label="Kiln editing menu">
      <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
      <span id="kiln-fab-badge" hidden></span>
    </button>
    <div class="kiln-status" id="kiln-status" hidden></div>`;
  document.body.appendChild(fab);

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
    <button id="kiln-newpost" class="kiln-btn-ghost">+ New</button>
    <button id="kiln-menu" class="kiln-btn-ghost">Menu</button>
    <button id="kiln-pagesettings" class="kiln-btn-ghost">Page</button>
    <button id="kiln-findreplace" class="kiln-btn-ghost">Replace</button>
    <button id="kiln-history" class="kiln-btn-ghost">History</button>
    ${mode === 'admin' ? '<button id="kiln-invite" class="kiln-btn-ghost">People</button><button id="kiln-settings" class="kiln-btn-ghost">Settings</button>' : ''}
    <button id="kiln-draft" class="kiln-btn-ghost" hidden>Draft</button>
    <button id="kiln-schedule" class="kiln-btn-ghost" hidden>Schedule</button>
    <button id="kiln-discard" class="kiln-btn-ghost" hidden>Discard</button>
    <button id="kiln-publish" class="kiln-btn-publish" disabled>Publish</button>
    <button id="kiln-done" class="kiln-btn-ghost">Done</button>
    <button id="kiln-signout" class="kiln-btn-link">sign out</button>`;
  document.body.prepend(bar);
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
  const settingsBtn = bar.querySelector('#kiln-settings');
  if (settingsBtn) settingsBtn.onclick = settingsPanel;
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
    clearSavedPending();
    location.reload();
  };
}

function renderToolbar(el, key) {
  removeToolbar();
  const tb = document.createElement('div');
  tb.id = 'kiln-toolbar';
  const rect = el.getBoundingClientRect();
  const isLink = el.tagName === 'A';
  const plain = el.hasAttribute('data-cms-plain');
  const styles = Array.isArray(cfg.styles) ? cfg.styles : [];
  const LINK_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>';
  const IMG_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>';
  tb.innerHTML = `
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
      <button class="kiln-tb-fmt kiln-tb-clear" data-cmd="removeFormat" title="Clear formatting">Clear</button>`}
    ${isLink ? `<input class="kiln-href-input" type="text" value="${escapeHtml(el.getAttribute('href') || '')}" title="Where this links to" placeholder="/page.html or https://…">
      <button class="kiln-tb-fmt kiln-tb-attach" data-cmd="attach" title="Upload a file (PDF, doc…) and point this link at it">Attach file…</button>` : ''}
    <span class="kiln-tb-gap"></span>
    <button class="kiln-tb-save" title="Keep this edit (you can still Esc-revert until you click away)">Done</button>
    <button class="kiln-tb-cancel" title="Throw away this edit (Esc)">Revert</button>`;
  tb.style.top = `${Math.max(rect.top + window.scrollY - 46, window.scrollY + 50)}px`;
  tb.style.left = `${Math.min(rect.left + window.scrollX, window.innerWidth - 380)}px`;
  document.body.appendChild(tb);

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
      } else if (cmd === 'attach') {
        const input = tb.querySelector('.kiln-href-input');
        const path = await uploadAnyFile();
        if (path && input) input.value = path;
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
  wrap.innerHTML = `<div class="kiln-modal-card"><div class="kiln-modal-body">${bodyHtml}</div></div>`;
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap || e.target.closest('[data-close]')) wrap.remove();
  });
  document.body.appendChild(wrap);
  wrap.querySelector('input')?.focus();
  return wrap;
}

function refreshPublishButton() {
  const n = state.pending.size;
  const btn = document.getElementById('kiln-publish');
  if (btn) {
    btn.disabled = !n;
    btn.textContent = n ? `Publish ${n} edit${n > 1 ? 's' : ''}` : 'Publish';
  }
  const badge = document.getElementById('kiln-fab-badge');
  if (badge) { badge.hidden = !n; badge.textContent = n; }
  const discard = document.getElementById('kiln-discard');
  if (discard) { discard.hidden = !n; discard.textContent = `Discard ${n} edit${n > 1 ? 's' : ''}`; }
  const sched = document.getElementById('kiln-schedule');
  if (sched) sched.hidden = !n;
  const draftBtn = document.getElementById('kiln-draft');
  if (draftBtn) draftBtn.hidden = !n;
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
  el.textContent = text;
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
      const el = document.querySelector(`[data-cms="${CSS.escape(key)}"], [data-cms-repeat="${CSS.escape(key)}"]`);
      state.pending.set(key, edit);
      if (el && edit.html !== undefined && !el.hasAttribute('data-cms-repeat')) {
        el.innerHTML = edit.html;
        el.classList.add('kiln-modified');
      } else if (el) {
        el.classList.add('kiln-modified');
      }
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
#kiln-fab{position:relative;width:48px;height:48px;border-radius:50%;border:none;cursor:grab;
  background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;display:flex;align-items:center;
  justify-content:center;box-shadow:0 6px 24px rgba(79,70,229,.45),0 2px 6px rgba(0,0,0,.2);
  transition:transform .15s,box-shadow .15s;touch-action:none}
#kiln-fab:hover{transform:scale(1.07);box-shadow:0 8px 30px rgba(79,70,229,.55)}
#kiln-fab:active{cursor:grabbing}
#kiln-fab-badge{position:absolute;top:-4px;right:-4px;min-width:18px;height:18px;border-radius:9px;
  background:var(--kiln-warn);color:#1c1300;font-size:11px;font-weight:700;display:flex;
  align-items:center;justify-content:center;padding:0 5px;box-shadow:0 1px 4px rgba(0,0,0,.3)}
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
.kiln-status--saving{color:var(--kiln-warn)}
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
.kiln-modal-card{background:#fff;color:#1c1c28;border-radius:18px;max-width:500px;width:92%;
  box-shadow:0 24px 80px rgba(0,0,0,.3);max-height:78vh;overflow:auto}
.kiln-modal-body{padding:24px}
.kiln-modal-body h3{margin:0 0 14px;font-size:17px;font-weight:700;letter-spacing:-.01em}
.kiln-modal-body h4{margin:16px 0 8px;font-size:11.5px;text-transform:uppercase;letter-spacing:.06em;color:#9ca3af}
.kiln-modal-body label{display:block;font-size:13px;color:#4b5563;margin-bottom:10px}
.kiln-modal-body input[type=text],.kiln-modal-body input[type=email],.kiln-modal-body input[type=number]{
  width:100%;padding:10px;border:1.5px solid #e5e7eb;border-radius:10px;font-size:14px;margin-top:4px;
  font-family:var(--kiln-font);transition:border-color .15s;outline:none}
.kiln-modal-body input:focus{border-color:var(--kiln-accent)}
.kiln-2col{display:grid;grid-template-columns:1.4fr 1fr;gap:10px}
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
.kiln-inv-list{display:flex;flex-direction:column;gap:6px}
.kiln-inv-row{display:flex;justify-content:space-between;align-items:center;border:1.5px solid #f3f4f6;
  border-radius:10px;padding:9px 12px;font-size:13px;gap:8px}
.kiln-inv-row small{color:#9ca3af;display:block;margin-top:1px}
.kiln-dim{color:#9ca3af;font-size:12px;margin-top:10px;line-height:1.5}
.kiln-np-step{font-size:13px;color:#4b5563;min-height:20px;line-height:1.5}
.kiln-repeat-item{position:relative}
.kiln-item-ctl{position:absolute;top:8px;right:8px;display:flex;gap:5px;z-index:9999;opacity:0;transition:opacity .15s}
.kiln-repeat-item:hover>.kiln-item-ctl{opacity:1}
.kiln-item-ctl button{background:var(--kiln-bg);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);
  color:#fff;border:1px solid rgba(255,255,255,.1);width:27px;height:27px;border-radius:8px;
  cursor:pointer;font-size:13px;box-shadow:0 4px 12px rgba(0,0,0,.25);transition:background .12s}
.kiln-item-ctl button:hover{background:var(--kiln-accent)}
.kiln-repeat-add{display:block;margin:10px auto 0;background:rgba(99,102,241,.08);color:var(--kiln-accent);
  border:1.5px dashed rgba(99,102,241,.5);border-radius:10px;padding:8px 18px;cursor:pointer;
  font-size:13px;font-weight:600;font-family:var(--kiln-font);transition:all .15s}
.kiln-repeat-add:hover{background:rgba(99,102,241,.16)}
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
#kiln-menu-add{margin-top:4px;color:#4b5563;border-color:#e5e7eb;background:#f9fafb}`;
  document.head.appendChild(style);
}
