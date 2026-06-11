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
const PAUSE_KEY = 'kiln_pause';

const SANITIZE = {
  ALLOWED_TAGS: ['a', 'abbr', 'b', 'br', 'code', 'em', 'i', 'img', 'li', 'mark', 'ol', 'p',
    's', 'small', 'span', 'strong', 'sub', 'sup', 'u', 'ul'],
  ALLOWED_ATTR: ['href', 'target', 'rel', 'title', 'class', 'src', 'alt'],
};

const state = {
  gh: null,
  user: null,
  page: null,            // { path, text, sha }
  fields: null,          // indexHtml() of page.text
  pending: new Map(),    // key → { html?, attrs?: {name: value} }
  active: null,
  originals: new Map(),
  previewSwaps: [],      // [{el, realSrc, blobUrl}] — applied once the deploy is live
};

init().catch(err => {
  console.error('[kiln]', err);
  setStatus('Kiln failed to start — see console', 'error');
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
    if (!source) {
      console.warn(`[kiln] "${key}" is on the page but not in ${state.page.path}`);
      return;
    }
    if (source.kind === 'list') return; // structural anchor, never inline-editable

    el.classList.add('kiln-field');
    el.title = `Edit: ${key}`;
    el.addEventListener('click', (e) => {
      // Cmd/Ctrl+click on a link follows it even in edit mode.
      if ((e.metaKey || e.ctrlKey) && e.target.closest('a')) return;
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
  stagePending(key, { html: value });

  // Link elements: stage the href too if it was changed in the toolbar.
  const hrefInput = document.querySelector('#kiln-toolbar .kiln-href-input');
  if (hrefInput && el.tagName === 'A' && hrefInput.value !== el.getAttribute('href')) {
    el.setAttribute('href', hrefInput.value);
    stagePending(key, { attrs: { href: hrefInput.value } });
  }
  state.active = null;
  removeToolbar();
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
      const { blob, base64, ext } = await downscale(file);
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
      const blobUrl = URL.createObjectURL(blob);
      img.src = blobUrl;
      state.previewSwaps.push({ el: img, realSrc: urlPath, blobUrl });
      img.classList.add('kiln-modified');
      stagePending(key, { attrs: { src: urlPath } });
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
    watchDeploy(result.commit?.sha);
  } catch (err) {
    console.error('[kiln] publish', err);
    setStatus('Publish failed — see console', 'error');
    disablePublish(false);
  }
}

async function watchDeploy(sha, onLive) {
  const started = Date.now();
  const short = sha ? sha.slice(0, 7) : '';
  if (!sha) { setStatus('Saved to GitHub ✓', 'saved'); return; }
  const tick = async () => {
    const secs = Math.round((Date.now() - started) / 1000);
    if (Date.now() - started > 5 * 60 * 1000) {
      setStatus(`Saved to GitHub ✓ (${short}) — deploy is taking longer than usual; it WILL go live`, 'saved');
      return;
    }
    const s = await deployState(state.gh, cfg.repo, sha).catch(() => 'unknown');
    if (s === 'success') {
      for (const swap of state.previewSwaps.splice(0)) {
        swap.el.src = swap.realSrc;
        URL.revokeObjectURL(swap.blobUrl);
      }
      setStatus('Live ✓ — your edit is on the site', 'saved');
      if (onLive) onLive();
      setTimeout(() => setStatus(`Signed in as ${state.user}`, 'idle'), 8000);
      return;
    }
    if (s === 'failure' || s === 'error') { setStatus('Deploy failed — check your host dashboard', 'error'); return; }
    setStatus(`Saved to GitHub ✓ (${short}) — host is rebuilding… ${secs}s`, 'saving');
    setTimeout(tick, 5000);
  };
  setStatus(`Saved to GitHub ✓ (${short}) — host is rebuilding…`, 'saving');
  setTimeout(tick, 4000);
}

// ─── New blog post ───────────────────────────────────────────────────────────

function newPost() {
  const m = modal(`
    <h3>New post</h3>
    <label>Title <input type="text" id="kiln-np-title" placeholder="What's it about?" autofocus></label>
    <div class="kiln-modal-actions">
      <button class="kiln-btn-ghost" data-close>Cancel</button>
      <button class="kiln-btn-publish" id="kiln-np-go">Create post</button>
    </div>`);
  m.querySelector('#kiln-np-go').onclick = async () => {
    const title = m.querySelector('#kiln-np-title').value.trim();
    if (!title) return;
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'post';
    const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const root = cfg.root ? cfg.root.replace(/\/+$/, '') + '/' : '';
    const branch = cfg.branch || 'main';
    const body = m.querySelector('.kiln-modal-body');
    body.innerHTML = `<h3>Publishing “${escapeHtml(title)}”</h3>
      <p class="kiln-np-step" id="kiln-np-status">Committing to GitHub…</p>
      <div class="kiln-modal-actions">
        <button class="kiln-btn-ghost" data-close>Close</button>
        <button class="kiln-btn-publish" id="kiln-np-open" disabled>Open post →</button>
      </div>`;
    const status = body.querySelector('#kiln-np-status');
    const openBtn = body.querySelector('#kiln-np-open');
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
      if (!newIndex.applied.length) throw new Error('blog/index.html needs a data-cms-list="post_list" container');

      const commit = await commitFiles(state.gh, cfg.repo, branch, [
        { path: root + `blog/${slug}.html`, text: postHtml },
        { path: root + 'blog/index.html', text: newIndex.html },
      ], `New post: ${title} (via Kiln)`);

      status.textContent = `Committed ✓ (${commit.sha.slice(0, 7)}) — your host is rebuilding. The button lights up the moment the post is live.`;
      const started = Date.now();
      const poll = async () => {
        if (!document.body.contains(m)) return; // modal closed
        const s = await deployState(state.gh, cfg.repo, commit.sha).catch(() => 'unknown');
        if (s === 'success') {
          status.textContent = 'Live ✓ — open it and click into the text to write.';
          openBtn.disabled = false;
          openBtn.onclick = () => { location.href = `/blog/${slug}.html`; };
          return;
        }
        if (s === 'failure' || s === 'error') { status.textContent = 'Deploy failed — check your host dashboard.'; return; }
        const secs = Math.round((Date.now() - started) / 1000);
        status.textContent = `Committed ✓ — host is rebuilding… ${secs}s (usually under a minute)`;
        setTimeout(poll, 5000);
      };
      setTimeout(poll, 4000);
    } catch (err) {
      console.error('[kiln] new post', err);
      status.textContent = err.message.includes('post_list') || err.status === 404
        ? 'This site has no blog templates (_templates/) — see the docs.'
        : `Failed: ${err.message}`;
    }
  };
}

// ─── Invites (admin only) ────────────────────────────────────────────────────

async function invitePanel() {
  const m = modal(`
    <h3>Invite someone</h3>
    <label>Their name <input type="text" id="kiln-inv-name" placeholder="e.g. Claudia"></label>
    <div class="kiln-roles">
      <label class="kiln-role"><input type="radio" name="kiln-role" value="editor" checked>
        <span><strong>Editor</strong><br><small>Can click-to-edit pages, swap images, and publish. No GitHub account needed.</small></span></label>
      <label class="kiln-role"><input type="radio" name="kiln-role" value="member">
        <span><strong>Member</strong><br><small>Can view the members-only area and its documents. Cannot edit anything.</small></span></label>
    </div>
    <div class="kiln-modal-actions">
      <button class="kiln-btn-ghost" data-close>Cancel</button>
      <button class="kiln-btn-publish" id="kiln-inv-go">Create link</button>
    </div>
    <div id="kiln-inv-result"></div>
    <hr class="kiln-hr">
    <h4>Active editor invites &amp; sessions</h4>
    <div id="kiln-inv-list" class="kiln-inv-list">Loading…</div>
    <p class="kiln-dim">Member links are stateless and can't be listed here; rotating the
    <code>KILN_MEMBER_SECRET</code> signs everyone out of the members area at once.</p>`);

  const admin = () => JSON.parse(localStorage.getItem(ADMIN_KEY));

  async function refreshList() {
    const list = m.querySelector('#kiln-inv-list');
    try {
      const res = await fetch(`${cfg.worker}/admin/invites?repo=${encodeURIComponent(cfg.repo)}`, {
        headers: { Authorization: `Bearer ${admin().token}` },
      });
      const data = await res.json();
      const rows = [
        ...(data.invites || []).map(i => ({ ...i, kind: 'invite', label: 'unused link' })),
        ...(data.sessions || []).map(s => ({ ...s, kind: 'session', label: 'active editor' })),
      ];
      list.innerHTML = rows.length ? '' : '<p class="kiln-dim">None yet.</p>';
      for (const row of rows) {
        const div = document.createElement('div');
        div.className = 'kiln-inv-row';
        const exp = row.exp ? new Date(row.exp).toLocaleDateString() : '—';
        div.innerHTML = `<span><strong>${escapeHtml(row.name || '?')}</strong>
          <small>${row.label} · expires ${exp}</small></span>
          <button class="kiln-btn-ghost">Revoke</button>`;
        div.querySelector('button').onclick = async () => {
          await fetch(`${cfg.worker}/admin/revoke`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin().token}` },
            body: JSON.stringify({ repo: cfg.repo, kind: row.kind, id: row.id }),
          });
          refreshList();
        };
        list.appendChild(div);
      }
    } catch (err) {
      list.innerHTML = '<p class="kiln-dim">Could not load invites.</p>';
    }
  }
  refreshList();

  m.querySelector('#kiln-inv-go').onclick = async () => {
    const name = m.querySelector('#kiln-inv-name').value.trim();
    const role = m.querySelector('input[name="kiln-role"]:checked').value;
    const out = m.querySelector('#kiln-inv-result');
    if (!name) { out.innerHTML = '<p class="kiln-dim">Give them a name first.</p>'; return; }
    out.innerHTML = '<p class="kiln-dim">Creating…</p>';
    try {
      let link;
      if (role === 'editor') {
        const res = await fetch(`${cfg.worker}/admin/invite`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin().token}` },
          body: JSON.stringify({ repo: cfg.repo, name, role: 'editor', days: 14 }),
        });
        const data = await res.json();
        if (!data.invite) throw new Error(data.error || 'failed');
        link = `${location.origin}/#kiln-invite=${data.invite}`;
      } else {
        const res = await fetch('/api/member-invite', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin().token}` },
          body: JSON.stringify({ name }),
        });
        const data = await res.json();
        if (!data.invite) throw new Error(data.error || 'is the members area configured?');
        link = `${location.origin}/members-login.html#kiln-member=${encodeURIComponent(data.invite)}`;
      }
      out.innerHTML = `
        <p class="kiln-inv-ok">Link for <strong>${escapeHtml(name)}</strong> — send it by text or email.
        ${role === 'editor' ? 'It works ONCE and signs them in for 30 days.' : 'It signs them into the members area for 30 days.'}</p>
        <div class="kiln-linkrow"><input type="text" readonly value="${escapeHtml(link)}"><button class="kiln-btn-publish">Copy</button></div>`;
      const row = out.querySelector('.kiln-linkrow');
      row.querySelector('button').onclick = async () => {
        await navigator.clipboard.writeText(link).catch(() => row.querySelector('input').select());
        row.querySelector('button').textContent = 'Copied ✓';
      };
      refreshList();
    } catch (err) {
      out.innerHTML = `<p class="kiln-dim">Failed: ${escapeHtml(err.message)}</p>`;
    }
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
      <button id="kiln-done" class="kiln-btn-ghost" title="Stop editing and browse the site (stays signed in)">Done editing</button>
      <button id="kiln-signout" class="kiln-btn-link" title="Sign out of Kiln completely">sign out</button>
    </div>`;
  document.body.prepend(bar);
  document.getElementById('kiln-publish').onclick = publish;
  document.getElementById('kiln-newpost').onclick = newPost;
  document.getElementById('kiln-done').onclick = doneEditing;
  document.getElementById('kiln-signout').onclick = () => {
    if (state.pending.size && !confirm('Discard your unpublished edits and sign out?')) return;
    window.Kiln.logout();
  };
  const inviteBtn = document.getElementById('kiln-invite');
  if (inviteBtn) inviteBtn.onclick = invitePanel;
  setStatus(`Signed in as ${state.user} — click any outlined text to edit`, 'idle');
}

function renderToolbar(el, key) {
  removeToolbar();
  const tb = document.createElement('div');
  tb.id = 'kiln-toolbar';
  const rect = el.getBoundingClientRect();
  const isLink = el.tagName === 'A';
  const plain = el.hasAttribute('data-cms-plain');
  tb.innerHTML = `
    <span class="kiln-tb-label">${escapeHtml(key)}</span>
    ${plain ? '' : `
      <button class="kiln-tb-fmt" data-cmd="bold" title="Bold"><b>B</b></button>
      <button class="kiln-tb-fmt" data-cmd="italic" title="Italic"><i>I</i></button>
      <button class="kiln-tb-fmt" data-cmd="underline" title="Underline"><u>U</u></button>
      <button class="kiln-tb-fmt" data-cmd="link" title="Turn selection into a link">🔗</button>
      <button class="kiln-tb-fmt" data-cmd="removeFormat" title="Clear formatting">⌫</button>`}
    ${isLink ? `<input class="kiln-href-input" type="text" value="${escapeHtml(el.getAttribute('href') || '')}" title="Where this links to">` : ''}
    <button class="kiln-tb-save">Save</button>
    <button class="kiln-tb-cancel">Cancel</button>`;
  tb.style.top = `${Math.max(rect.top + window.scrollY - 46, window.scrollY + 50)}px`;
  tb.style.left = `${Math.min(rect.left + window.scrollX, window.innerWidth - 380)}px`;
  document.body.appendChild(tb);

  tb.querySelectorAll('.kiln-tb-fmt').forEach(btn => {
    btn.addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const cmd = btn.dataset.cmd;
      if (cmd === 'link') {
        const url = window.prompt('Link to (URL or /page):', 'https://');
        if (url) document.execCommand('createLink', false, url);
      } else {
        document.execCommand(cmd, false, null);
      }
      el.focus();
    });
  });
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

function escapeHtml(s) {
  return String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function injectStyles() {
  const style = document.createElement('style');
  style.textContent = `
#kiln-bar{position:fixed;top:0;left:0;right:0;height:44px;background:#1a1a2e;color:#e0e0e0;display:flex;
  align-items:center;justify-content:space-between;padding:0 14px;z-index:99999;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;box-shadow:0 2px 8px rgba(0,0,0,.4)}
.kiln-left,.kiln-right{display:flex;align-items:center;gap:10px;min-width:0}
.kiln-flame{font-size:15px}
.kiln-status{opacity:.6;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:46vw}
.kiln-status--saving{opacity:1;color:#f0c040}
.kiln-status--saved{opacity:1;color:#4caf50}
.kiln-status--error{opacity:1;color:#f44336}
.kiln-btn-publish{background:#4f6ef7;color:#fff;border:none;padding:6px 14px;border-radius:6px;cursor:pointer;
  font-size:13px;font-weight:500}
.kiln-btn-publish:hover:not(:disabled){background:#3a59e8}
.kiln-btn-publish:disabled{opacity:.4;cursor:default}
.kiln-btn-ghost{background:transparent;color:#aaa;border:1px solid #444;padding:5px 11px;border-radius:6px;
  cursor:pointer;font-size:12px;white-space:nowrap}
.kiln-btn-ghost:hover{color:#fff;border-color:#888}
.kiln-btn-link{background:none;border:none;color:#666;font-size:11px;cursor:pointer;text-decoration:underline}
.kiln-btn-link:hover{color:#aaa}
body:has(#kiln-bar){padding-top:44px!important}
.kiln-field{cursor:pointer;outline:2px dashed transparent;outline-offset:4px;border-radius:3px;transition:outline-color .15s}
.kiln-field:hover{outline-color:#4f6ef7}
.kiln-field.kiln-editing{outline:2px solid #4f6ef7;cursor:text;padding:2px 4px;min-width:40px}
.kiln-field.kiln-modified{outline:2px solid #f0c040}
img.kiln-field:hover{outline-style:solid;filter:brightness(.92)}
#kiln-toolbar{position:absolute;background:#1a1a2e;color:#fff;padding:6px 8px;border-radius:6px;display:flex;
  align-items:center;gap:6px;font-family:-apple-system,sans-serif;font-size:12px;z-index:999999;
  box-shadow:0 4px 16px rgba(0,0,0,.4);flex-wrap:wrap;max-width:90vw}
.kiln-tb-label{opacity:.6;margin-right:2px}
.kiln-tb-fmt{background:#2e2e4e;color:#fff;border:none;width:26px;height:24px;border-radius:4px;cursor:pointer;font-size:12px}
.kiln-tb-fmt:hover{background:#3d3d63}
.kiln-href-input{background:#2e2e4e;border:1px solid #444;color:#fff;border-radius:4px;padding:4px 6px;
  font-size:12px;width:200px}
.kiln-tb-save{background:#4f6ef7;color:#fff;border:none;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:12px}
.kiln-tb-cancel{background:transparent;color:#aaa;border:none;padding:4px 8px;cursor:pointer;font-size:12px}
.kiln-tb-cancel:hover{color:#fff}
#kiln-modal{position:fixed;inset:0;background:rgba(10,10,20,.55);z-index:9999999;display:flex;
  align-items:flex-start;justify-content:center;padding-top:10vh;font-family:-apple-system,sans-serif}
.kiln-modal-card{background:#fff;color:#222;border-radius:10px;max-width:480px;width:92%;
  box-shadow:0 12px 48px rgba(0,0,0,.35);max-height:75vh;overflow:auto}
.kiln-modal-body{padding:22px}
.kiln-modal-body h3{margin:0 0 14px;font-size:17px}
.kiln-modal-body h4{margin:14px 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:#888}
.kiln-modal-body label{display:block;font-size:13px;color:#555;margin-bottom:10px}
.kiln-modal-body input[type=text]{width:100%;padding:9px;border:1px solid #ccc;border-radius:6px;font-size:14px;margin-top:4px}
.kiln-modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
.kiln-modal-actions .kiln-btn-ghost{color:#666;border-color:#ccc}
.kiln-modal-actions .kiln-btn-ghost:hover{color:#222;border-color:#888}
.kiln-roles{display:flex;flex-direction:column;gap:8px;margin:10px 0}
.kiln-role{display:flex;gap:10px;align-items:flex-start;border:1px solid #ddd;border-radius:8px;padding:10px;cursor:pointer}
.kiln-role:has(input:checked){border-color:#4f6ef7;background:#f5f7ff}
.kiln-role small{color:#777}
.kiln-linkrow{display:flex;gap:8px;margin-top:8px}
.kiln-linkrow input{flex:1;font-size:12px;color:#444}
.kiln-inv-ok{font-size:13px;color:#2e7d32;margin-top:12px}
.kiln-hr{border:none;border-top:1px solid #eee;margin:18px 0 6px}
.kiln-inv-list{display:flex;flex-direction:column;gap:6px}
.kiln-inv-row{display:flex;justify-content:space-between;align-items:center;border:1px solid #eee;
  border-radius:6px;padding:8px 10px;font-size:13px}
.kiln-inv-row small{color:#999;display:block}
.kiln-dim{color:#999;font-size:12px;margin-top:10px}
.kiln-np-step{font-size:13px;color:#555;min-height:20px}`;
  document.head.appendChild(style);
}
