/**
 * cms.js — The Editor Overlay
 *
 * Drop this script on any static site. When an admin is logged in,
 * it overlays click-to-edit affordances on elements annotated with
 * data-cms attributes.
 *
 * Configuration — add this before loading cms.js:
 *
 *   <script>
 *   window.CMS_CONFIG = {
 *     repo:        'owner/repo-name',      // GitHub repo
 *     branch:      'main',                 // branch to commit to
 *     contentFile: 'content.json',         // path to content file in repo
 *     authWorker:  'https://your-worker.workers.dev',  // Cloudflare Worker URL
 *   };
 *   </script>
 *
 * Annotate editable elements with data-cms="key" where "key" matches
 * a key in your content.json:
 *
 *   <h1 data-cms="headline">Welcome</h1>
 *   <p  data-cms="body">We make great things.</p>
 *
 * The content.json file looks like:
 *   { "headline": "Welcome", "body": "We make great things." }
 */

(function () {
  'use strict';

  const TOKEN_KEY = 'cms_github_token';
  const cfg = window.CMS_CONFIG || {};

  // ─── State ────────────────────────────────────────────────────────────────

  let token = null;
  let contentCache = null;     // in-memory copy of content.json
  let contentSha = null;       // SHA needed for GitHub API updates
  let activeField = null;      // currently-editing element
  let hasUnsavedChanges = false;
  let pendingContent = {};     // accumulated edits, saved together on publish

  // ─── Init ─────────────────────────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    // Pick up token from OAuth redirect (#cms-token=...)
    captureTokenFromUrl();

    token = localStorage.getItem(TOKEN_KEY);

    if (token) {
      await activateAdminMode();
    } else {
      renderLoginButton();
    }
  }

  /**
   * After GitHub OAuth, the Worker redirects back to:
   *   https://yoursite.com/page#cms-token=gho_...
   * We grab it, store it, clean the URL.
   */
  function captureTokenFromUrl() {
    const hash = window.location.hash;
    const match = hash.match(/cms-token=([^&]+)/);
    if (match) {
      const captured = match[1];
      localStorage.setItem(TOKEN_KEY, captured);
      // Clean the token out of the URL (don't want it in browser history)
      const cleanHash = hash.replace(/[#&]?cms-token=[^&]+/, '').replace(/^#$/, '');
      history.replaceState(null, '', window.location.pathname + window.location.search + cleanHash);
    }
  }

  // ─── Admin Mode ───────────────────────────────────────────────────────────

  async function activateAdminMode() {
    // Verify token is valid before showing admin UI
    try {
      const user = await githubRequest('GET', 'https://api.github.com/user');
      renderAdminBar(user.login, user.avatar_url);
      await loadContent();
      decorateEditableFields();
    } catch (err) {
      // Token invalid or expired — clear it and show login
      console.warn('[CMS] Token invalid, clearing.', err);
      localStorage.removeItem(TOKEN_KEY);
      token = null;
      renderLoginButton();
    }
  }

  // ─── Content Loading ──────────────────────────────────────────────────────

  async function loadContent() {
    if (!cfg.repo || !cfg.contentFile) {
      console.error('[CMS] Missing CMS_CONFIG.repo or CMS_CONFIG.contentFile');
      return;
    }

    try {
      const url = `https://api.github.com/repos/${cfg.repo}/contents/${cfg.contentFile}?ref=${cfg.branch || 'main'}`;
      const data = await githubRequest('GET', url);
      contentSha = data.sha;
      contentCache = JSON.parse(atob(data.content.replace(/\s/g, '')));
    } catch (err) {
      console.error('[CMS] Failed to load content file:', err);
      contentCache = {};
    }
  }

  // ─── Field Decoration ─────────────────────────────────────────────────────

  /**
   * Find all [data-cms] elements and make them click-to-edit.
   */
  function decorateEditableFields() {
    const fields = document.querySelectorAll('[data-cms]');
    fields.forEach((el) => {
      const key = el.getAttribute('data-cms');

      // Add visual hint styles
      el.classList.add('cms-field');

      // Show a small "edit" badge on hover
      el.setAttribute('title', `Edit: ${key}`);

      el.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (activeField === el) return; // already editing
        startEditing(el, key);
      });
    });

    // Click anywhere else = cancel editing
    document.addEventListener('click', (e) => {
      if (activeField && !activeField.contains(e.target) && !e.target.closest('#cms-edit-toolbar')) {
        cancelEditing();
      }
    });
  }

  // ─── Inline Editing ───────────────────────────────────────────────────────

  function startEditing(el, key) {
    if (activeField) cancelEditing();

    activeField = el;
    el.classList.add('cms-editing');
    el.contentEditable = 'true';
    el.focus();

    // Move cursor to end
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    renderEditToolbar(el, key);
  }

  function cancelEditing() {
    if (!activeField) return;
    const key = activeField.getAttribute('data-cms');

    activeField.contentEditable = 'false';
    activeField.classList.remove('cms-editing');

    // Restore original content if not saved
    if (contentCache && contentCache[key] !== undefined) {
      activeField.innerHTML = contentCache[key];
    }

    activeField = null;
    removeEditToolbar();
  }

  function commitEdit(el, key) {
    const newValue = el.innerHTML;
    pendingContent[key] = newValue;
    hasUnsavedChanges = true;

    el.contentEditable = 'false';
    el.classList.remove('cms-editing');
    el.classList.add('cms-modified');
    activeField = null;

    removeEditToolbar();
    updatePublishButton();
  }

  // ─── GitHub API ───────────────────────────────────────────────────────────

  /**
   * Save all pending changes to GitHub as a single commit.
   */
  async function publishChanges() {
    if (!hasUnsavedChanges || !Object.keys(pendingContent).length) return;

    setAdminStatus('Saving…', 'saving');

    try {
      // Merge pending changes into the cached content
      const updatedContent = { ...contentCache, ...pendingContent };

      // Encode as base64 for GitHub API
      const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(updatedContent, null, 2))));

      const url = `https://api.github.com/repos/${cfg.repo}/contents/${cfg.contentFile}`;
      await githubRequest('PUT', url, {
        message: 'Content update via CMS',
        content: encoded,
        sha: contentSha,
        branch: cfg.branch || 'main',
      });

      // Update local cache
      contentCache = updatedContent;
      pendingContent = {};
      hasUnsavedChanges = false;

      // Remove modified highlights
      document.querySelectorAll('.cms-modified').forEach((el) => el.classList.remove('cms-modified'));

      setAdminStatus('Saved! Rebuilding…', 'saved');

      // Show rebuild hint after a moment
      setTimeout(() => setAdminStatus('Logged in', 'idle'), 8000);

    } catch (err) {
      console.error('[CMS] Failed to save:', err);
      setAdminStatus('Save failed — check console', 'error');
    }
  }

  async function githubRequest(method, url, body) {
    const opts = {
      method,
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
    };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(url, opts);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`GitHub API ${res.status}: ${err.message || res.statusText}`);
    }

    return res.json();
  }

  // ─── UI Components ────────────────────────────────────────────────────────

  function renderLoginButton() {
    const btn = document.createElement('button');
    btn.id = 'cms-login-btn';
    btn.textContent = '✎ Admin Login';
    btn.addEventListener('click', () => {
      const returnTo = window.location.pathname + window.location.search;
      window.location.href = `${cfg.authWorker}/auth/login?return_to=${encodeURIComponent(returnTo)}`;
    });
    document.body.appendChild(btn);
  }

  function renderAdminBar(username, avatarUrl) {
    const bar = document.createElement('div');
    bar.id = 'cms-admin-bar';
    bar.innerHTML = `
      <div class="cms-bar-left">
        <img class="cms-avatar" src="${avatarUrl}" alt="${username}" />
        <span class="cms-username">Admin: ${username}</span>
        <span class="cms-status" id="cms-status">Logged in</span>
      </div>
      <div class="cms-bar-right">
        <button id="cms-publish-btn" class="cms-btn-publish" disabled>Publish Changes</button>
        <button id="cms-logout-btn" class="cms-btn-logout">Logout</button>
      </div>
    `;
    document.body.prepend(bar);

    document.getElementById('cms-publish-btn').addEventListener('click', publishChanges);
    document.getElementById('cms-logout-btn').addEventListener('click', logout);
  }

  function renderEditToolbar(el, key) {
    removeEditToolbar();
    const toolbar = document.createElement('div');
    toolbar.id = 'cms-edit-toolbar';

    const rect = el.getBoundingClientRect();

    toolbar.innerHTML = `
      <span class="cms-editing-label">Editing: ${key}</span>
      <button class="cms-btn-save">Save</button>
      <button class="cms-btn-cancel">Cancel</button>
    `;

    toolbar.style.top = `${rect.top + window.scrollY - 44}px`;
    toolbar.style.left = `${rect.left + window.scrollX}px`;

    document.body.appendChild(toolbar);

    toolbar.querySelector('.cms-btn-save').addEventListener('click', (e) => {
      e.stopPropagation();
      commitEdit(el, key);
    });
    toolbar.querySelector('.cms-btn-cancel').addEventListener('click', (e) => {
      e.stopPropagation();
      cancelEditing();
    });
  }

  function removeEditToolbar() {
    const t = document.getElementById('cms-edit-toolbar');
    if (t) t.remove();
  }

  function setAdminStatus(text, state) {
    const el = document.getElementById('cms-status');
    if (el) {
      el.textContent = text;
      el.className = `cms-status cms-status--${state}`;
    }
  }

  function updatePublishButton() {
    const btn = document.getElementById('cms-publish-btn');
    if (btn) btn.disabled = !hasUnsavedChanges;
  }

  function logout() {
    localStorage.removeItem(TOKEN_KEY);
    window.location.reload();
  }

  // ─── Styles ───────────────────────────────────────────────────────────────

  const style = document.createElement('style');
  style.textContent = `
    /* Admin bar */
    #cms-admin-bar {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      height: 44px;
      background: #1a1a2e;
      color: #e0e0e0;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 16px;
      z-index: 99999;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 13px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.4);
    }

    .cms-bar-left, .cms-bar-right {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .cms-avatar {
      width: 24px;
      height: 24px;
      border-radius: 50%;
    }

    .cms-status {
      opacity: 0.6;
      font-size: 12px;
    }
    .cms-status--saving { opacity: 1; color: #f0c040; }
    .cms-status--saved  { opacity: 1; color: #4caf50; }
    .cms-status--error  { opacity: 1; color: #f44336; }

    .cms-btn-publish {
      background: #4f6ef7;
      color: white;
      border: none;
      padding: 6px 14px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      transition: background 0.2s;
    }
    .cms-btn-publish:hover:not(:disabled) { background: #3a59e8; }
    .cms-btn-publish:disabled { opacity: 0.4; cursor: default; }

    .cms-btn-logout {
      background: transparent;
      color: #aaa;
      border: 1px solid #444;
      padding: 5px 12px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 12px;
    }
    .cms-btn-logout:hover { color: white; border-color: #888; }

    /* Body offset when admin bar is visible */
    body:has(#cms-admin-bar) {
      padding-top: 44px !important;
    }

    /* Login button (shown when logged out) */
    #cms-login-btn {
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: #1a1a2e;
      color: white;
      border: none;
      padding: 10px 18px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 14px;
      z-index: 99999;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      transition: transform 0.15s, box-shadow 0.15s;
    }
    #cms-login-btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 16px rgba(0,0,0,0.4);
    }

    /* Editable field affordances */
    .cms-field {
      cursor: pointer;
      outline: 2px dashed transparent;
      outline-offset: 4px;
      border-radius: 3px;
      transition: outline-color 0.15s;
    }
    .cms-field:hover {
      outline-color: #4f6ef7;
    }
    .cms-field.cms-editing {
      outline: 2px solid #4f6ef7;
      cursor: text;
      border-radius: 3px;
      padding: 2px 4px;
      min-width: 40px;
    }
    .cms-field.cms-modified {
      outline: 2px solid #f0c040;
    }

    /* Floating edit toolbar */
    #cms-edit-toolbar {
      position: absolute;
      background: #1a1a2e;
      color: white;
      padding: 6px 10px;
      border-radius: 6px;
      display: flex;
      align-items: center;
      gap: 8px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 12px;
      z-index: 999999;
      box-shadow: 0 4px 16px rgba(0,0,0,0.4);
    }
    .cms-editing-label { opacity: 0.6; }
    .cms-btn-save {
      background: #4f6ef7;
      color: white;
      border: none;
      padding: 4px 10px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
    }
    .cms-btn-cancel {
      background: transparent;
      color: #aaa;
      border: none;
      padding: 4px 8px;
      cursor: pointer;
      font-size: 12px;
    }
    .cms-btn-cancel:hover { color: white; }
  `;
  document.head.appendChild(style);
})();
