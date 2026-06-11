/**
 * kiln-editor — loaded only for authenticated admins and invited editors.
 *
 * Admin mode:  GitHub App user token, browser → api.github.com directly.
 * Editor mode: magic-link session, browser → kiln-auth worker /gh/* proxy
 *              (the worker holds the installation token; no GitHub account needed).
 *
 * The page's HTML file in the repo is the source of truth. Edits are spliced
 * into the raw file at parse5 source offsets and committed; the host rebuilds.
 */

import DOMPurify from 'dompurify';
import { indexHtml, applyEdits, pageFileCandidates } from '../engine.js';
import {
  makeGh, getFile, resolvePageFile, editFile, putBinaryFile, commitFiles, deployState,
} from '../github.js';

const cfg = window.KILN || {};
const mode = window.__KILN_MODE || 'admin';
const ADMIN_KEY = 'kiln_admin';
const EDITOR_KEY = 'kiln_editor';

const SANITIZE = {
  ALLOWED_TAGS: ['a', 'abbr', 'b', 'br', 'code', 'em', 'i', 'li', 'mark', 'ol', 'p',
    's', 'small', 'span', 'strong', 'sub', 'sup', 'u', 'ul'],
  ALLOWED_ATTR: ['href', 'target', 'rel', 'title', 'class'],
};

const state = {
  gh: null,
  user: null,          // display name
  page: null,          // { path, text, sha }
  fields: null,        // indexHtml() of page.text
  pending: new Map(),  // key → {html} | {attr, value}
  active: null,        // element being edited
  originals: new Map() // key → innerHTML before this editing session touched it
};

init().catch(err => {
  console.error('[kiln]', err);
  toast('Kiln failed to start — see console', 'error');
});

async function init() {
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
    if (!state.fields.fields.has(key)) {
      console.warn(`[kiln] "${key}" is on the page but not in ${state.page.path} — is this page generated?`);
      return;
    }
    el.classList.add('kiln-field');
    el.title = `Edit: ${key}`;
    el.addEventListener('click', (e) => {
      if (el.getAttribute('data-cms-attr') === 'src' && el.tagName === 'IMG') {
        e.preventDefault(); e.stopPropagation();
        pickImage(el, key);
        return;
      }
      e.preventDefault(); e.stopPropagation();
      if (state.active !== el) startEditing(el, key);
    });
  });

  document.addEventListener('click', (e) => {
    if (state.active && !state.active.contains(e.target) && !e.target.closest('#kiln-toolbar')) {
      cancelEditing();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.active) cancelEditing();
  });
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

function commitEdit(el, key) {
  const plain = el.hasAttribute('data-cms-plain');
  const value = plain
    ? escapeHtml(el.textContent)
    : DOMPurify.sanitize(el.innerHTML, SANITIZE);
  el.innerHTML = value;
  el.contentEditable = 'false';
  el.classList.remove('kiln-editing');
  el.classList.add('kiln-modified');
  state.pending.set(key, { html: value });
  state.active = null;
  removeToolbar();
  refreshPublishButton();
}

// ─── Images ──────────────────────────────────────────────────────────────────

function pickImage(img, key) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      setStatus('Uploading image…', 'saving');
      const { base64, ext } = await downscale(file);
      const slug = (file.name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'image');
      const name = `${slug}-${Date.now().toString(36)}.${ext}`;
      const repoPath = (cfg.root ? cfg.root.replace(/\/+$/, '') + '/' : '') + `assets/uploads/${name}`;
      const urlPath = `/assets/uploads/${name}`;
      await putBinaryFile(state.gh, cfg.repo, repoPath, {
        base64, branch: cfg.branch || 'main',
        message: `Upload ${name} (via Kiln)`,
      });
      img.src = urlPath;
      img.classList.add('kiln-modified');
      state.pending.set(key, { attr: 'src', value: urlPath });
      refreshPublishButton();
      setStatus('Image staged — Publish to go live', 'saved');
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
  return { base64: btoa(bin), ext: blob.type === 'image/webp' ? 'webp' : (file.name.split('.').pop() || 'img') };
}

// ─── Publish ─────────────────────────────────────────────────────────────────

async function publish() {
  if (!state.pending.size) return;
  const edits = [...state.pending.entries()].map(([key, v]) => ({ key, ...v }));
  const keys = edits.map(e => e.key).join(', ');
  setStatus('Saving…', 'saving');
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
    await loadPageSource(); // fresh sha + text for the next round
    refreshPublishButton();
    if (result.unchanged) { setStatus('No changes to publish', 'idle'); return; }
    watchDeploy(result.commit?.sha);
  } catch (err) {
    console.error('[kiln] publish', err);
    setStatus('Publish failed — see console', 'error');
    disablePublish(false);
  }
}

async function watchDeploy(sha) {
  setStatus('Committed ✓ — site is rebuilding…', 'saving');
  if (!sha) { setStatus('Committed ✓', 'saved'); return; }
  const started = Date.now();
  const poll = async () => {
    if (Date.now() - started > 4 * 60 * 1000) { setStatus('Committed ✓ (deploy still running)', 'saved'); return; }
    const s = await deployState(state.gh, cfg.repo, sha).catch(() => 'unknown');
    if (s === 'success') { setStatus('Live ✓', 'saved'); setTimeout(() => setStatus(`Signed in as ${state.user}`, 'idle'), 6000); return; }
    if (s === 'failure' || s === 'error') { setStatus('Deploy failed — check your host', 'error'); return; }
    setTimeout(poll, 5000);
  };
  setTimeout(poll, 5000);
}

// ─── New blog post ───────────────────────────────────────────────────────────

async function newPost() {
  const title = prompt('Post title:');
  if (!title) return;
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'post';
  const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const root = cfg.root ? cfg.root.replace(/\/+$/, '') + '/' : '';
  const branch = cfg.branch || 'main';
  setStatus('Creating post…', 'saving');
  try {
    const tpl = await getFile(state.gh, cfg.repo, root + '_templates/post.html', branch);
    const cardTpl = await getFile(state.gh, cfg.repo, root + '_templates/post-card.html', branch);
    const blogIndex = await getFile(state.gh, cfg.repo, root + 'blog/index.html', branch);

    const postHtml = applyEdits(tpl.text, [
      { key: 'post_title', html: escapeHtml(title) },
      { key: 'post_date', html: escapeHtml(date) },
    ]).html.replaceAll('{{title}}', escapeHtml(title));

    const card = cardTpl.text
      .replaceAll('{{title}}', escapeHtml(title))
      .replaceAll('{{href}}', `/blog/${slug}.html`)
      .replaceAll('{{date}}', escapeHtml(date));

    const newIndex = applyEdits(blogIndex.text, [{ key: 'post_list', prepend: '\n      ' + card.trim() }]);
    if (!newIndex.applied.length) throw new Error('blog/index.html has no data-cms="post_list" container');

    await commitFiles(state.gh, cfg.repo, branch, [
      { path: root + `blog/${slug}.html`, text: postHtml },
      { path: root + 'blog/index.html', text: newIndex.html },
    ], `New post: ${title} (via Kiln)`);

    setStatus('Post created ✓ — rebuilding…', 'saved');
    setTimeout(() => {
      if (confirm(`"${title}" is publishing.\n\nOpen it now to write the body? (give the rebuild ~a minute)`)) {
        location.href = `/blog/${slug}.html`;
      }
    }, 400);
  } catch (err) {
    console.error('[kiln] new post', err);
    setStatus(err.message.includes('post_list') || err.status === 404
      ? 'This site has no blog templates (_templates/) — see docs'
      : 'Post creation failed — see console', 'error');
  }
}

// ─── Invites (admin only) ────────────────────────────────────────────────────

async function invite() {
  const name = prompt('Who is this invite for? (their name)');
  if (!name) return;
  const role = confirm('OK = EDITOR invite (can edit the site)\nCancel = MEMBER invite (can view the members area)')
    ? 'editor' : 'member';
  try {
    let link;
    if (role === 'editor') {
      const admin = JSON.parse(localStorage.getItem(ADMIN_KEY));
      const res = await fetch(`${cfg.worker}/admin/invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin.token}` },
        body: JSON.stringify({ repo: cfg.repo, name, role: 'editor', days: 14 }),
      });
      const data = await res.json();
      if (!data.invite) throw new Error(data.error || 'invite failed');
      link = `${location.origin}/#kiln-invite=${data.invite}`;
    } else {
      const admin = JSON.parse(localStorage.getItem(ADMIN_KEY));
      const res = await fetch('/api/member-invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin.token}` },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (!data.invite) throw new Error(data.error || 'member invite failed (is the members area set up?)');
      link = `${location.origin}/members-login.html#kiln-member=${data.invite}`;
    }
    await navigator.clipboard.writeText(link).catch(() => {});
    prompt(`${role === 'editor' ? 'Editor' : 'Member'} link for ${name} — copied to clipboard.\nSend it however you like (text, email):`, link);
  } catch (err) {
    console.error('[kiln] invite', err);
    toast(`Invite failed: ${err.message}`, 'error');
  }
}

// ─── UI chrome ───────────────────────────────────────────────────────────────

function renderAdminBar() {
  const bar = document.createElement('div');
  bar.id = 'kiln-bar';
  bar.innerHTML = `
    <div class="kiln-left">
      <span class="kiln-flame">🔥</span>
      <span class="kiln-user">${escapeHtml(state.user)}${mode === 'editor' ? ' (editor)' : ''}</span>
      <span class="kiln-status" id="kiln-status">Signed in</span>
    </div>
    <div class="kiln-right">
      <button id="kiln-newpost" class="kiln-btn-ghost">+ New post</button>
      ${mode === 'admin' ? '<button id="kiln-invite" class="kiln-btn-ghost">Invite…</button>' : ''}
      <button id="kiln-publish" class="kiln-btn-publish" disabled>Publish</button>
      <button id="kiln-logout" class="kiln-btn-ghost">Sign out</button>
    </div>`;
  document.body.prepend(bar);
  document.getElementById('kiln-publish').onclick = publish;
  document.getElementById('kiln-newpost').onclick = newPost;
  document.getElementById('kiln-logout').onclick = () => window.Kiln.logout();
  const inviteBtn = document.getElementById('kiln-invite');
  if (inviteBtn) inviteBtn.onclick = invite;
  setStatus(`Signed in as ${state.user}`, 'idle');
}

function renderToolbar(el, key) {
  removeToolbar();
  const tb = document.createElement('div');
  tb.id = 'kiln-toolbar';
  const rect = el.getBoundingClientRect();
  tb.innerHTML = `
    <span class="kiln-tb-label">${escapeHtml(key)}</span>
    <button class="kiln-tb-save">Save</button>
    <button class="kiln-tb-cancel">Cancel</button>`;
  tb.style.top = `${Math.max(rect.top + window.scrollY - 44, window.scrollY + 50)}px`;
  tb.style.left = `${rect.left + window.scrollX}px`;
  document.body.appendChild(tb);
  tb.querySelector('.kiln-tb-save').onclick = (e) => { e.stopPropagation(); commitEdit(el, key); };
  tb.querySelector('.kiln-tb-cancel').onclick = (e) => { e.stopPropagation(); cancelEditing(); };
}

function removeToolbar() { document.getElementById('kiln-toolbar')?.remove(); }

function refreshPublishButton() {
  const btn = document.getElementById('kiln-publish');
  if (!btn) return;
  btn.disabled = !state.pending.size;
  btn.textContent = state.pending.size ? `Publish (${state.pending.size})` : 'Publish';
}

function disablePublish(yes) {
  const btn = document.getElementById('kiln-publish');
  if (btn) btn.disabled = yes || !state.pending.size;
}

function setStatus(text, kind) {
  const el = document.getElementById('kiln-status');
  if (el) { el.textContent = text; el.className = `kiln-status kiln-status--${kind}`; }
}

function toast(text, kind) {
  setStatus(text, kind || 'idle');
}

function escapeHtml(s) {
  return String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function injectStyles() {
  const style = document.createElement('style');
  style.textContent = `
#kiln-bar{position:fixed;top:0;left:0;right:0;height:44px;background:#1a1a2e;color:#e0e0e0;display:flex;
  align-items:center;justify-content:space-between;padding:0 14px;z-index:99999;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;box-shadow:0 2px 8px rgba(0,0,0,.4)}
.kiln-left,.kiln-right{display:flex;align-items:center;gap:10px}
.kiln-flame{font-size:15px}
.kiln-status{opacity:.6;font-size:12px}
.kiln-status--saving{opacity:1;color:#f0c040}
.kiln-status--saved{opacity:1;color:#4caf50}
.kiln-status--error{opacity:1;color:#f44336}
.kiln-btn-publish{background:#4f6ef7;color:#fff;border:none;padding:6px 14px;border-radius:6px;cursor:pointer;
  font-size:13px;font-weight:500}
.kiln-btn-publish:hover:not(:disabled){background:#3a59e8}
.kiln-btn-publish:disabled{opacity:.4;cursor:default}
.kiln-btn-ghost{background:transparent;color:#aaa;border:1px solid #444;padding:5px 11px;border-radius:6px;
  cursor:pointer;font-size:12px}
.kiln-btn-ghost:hover{color:#fff;border-color:#888}
body:has(#kiln-bar){padding-top:44px!important}
.kiln-field{cursor:pointer;outline:2px dashed transparent;outline-offset:4px;border-radius:3px;transition:outline-color .15s}
.kiln-field:hover{outline-color:#4f6ef7}
.kiln-field.kiln-editing{outline:2px solid #4f6ef7;cursor:text;padding:2px 4px;min-width:40px}
.kiln-field.kiln-modified{outline:2px solid #f0c040}
img.kiln-field:hover{outline-style:solid;filter:brightness(.92)}
#kiln-toolbar{position:absolute;background:#1a1a2e;color:#fff;padding:6px 10px;border-radius:6px;display:flex;
  align-items:center;gap:8px;font-family:-apple-system,sans-serif;font-size:12px;z-index:999999;
  box-shadow:0 4px 16px rgba(0,0,0,.4)}
.kiln-tb-label{opacity:.6}
.kiln-tb-save{background:#4f6ef7;color:#fff;border:none;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:12px}
.kiln-tb-cancel{background:transparent;color:#aaa;border:none;padding:4px 8px;cursor:pointer;font-size:12px}
.kiln-tb-cancel:hover{color:#fff}`;
  document.head.appendChild(style);
}
