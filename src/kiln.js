/**
 * kiln.js — the boot shim. This is the only script a Kiln site loads for
 * every visitor, so it stays tiny and dependency-free. The real editor
 * (kiln-editor.js, ~10× larger) is injected only after we know the visitor
 * is an admin or an invited editor.
 *
 * Wire it up:
 *   <script>
 *     window.KILN = {
 *       repo:   'owner/site-repo',
 *       branch: 'main',                       // optional
 *       root:   '',                           // repo subdir the site is served from, optional
 *       worker: 'https://kiln-auth.you.workers.dev',
 *     };
 *   </script>
 *   <script src="/assets/kiln.js" defer></script>
 */
(function () {
  'use strict';

  var cfg = window.KILN || {};
  var ADMIN_KEY = 'kiln_admin';
  var EDITOR_KEY = 'kiln_editor';
  var scriptSrc = (document.currentScript && document.currentScript.src) || '/assets/kiln.js';

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  function boot() {
    captureAdminToken();
    captureEditorInvite().then(function () {
      var admin = read(ADMIN_KEY);
      var editor = read(EDITOR_KEY);
      if (admin && admin.exp && admin.exp < Date.now() && !admin.sid) {
        localStorage.removeItem(ADMIN_KEY);
        admin = null;
      }
      if (editor && editor.exp && editor.exp < Date.now()) {
        localStorage.removeItem(EDITOR_KEY);
        editor = null;
      }
      if (admin || editor) {
        if (sessionStorage.getItem('kiln_pause') === '1') {
          renderResumeButton();
          return;
        }
        window.__KILN_MODE = admin ? 'admin' : 'editor';
        var s = document.createElement('script');
        s.src = scriptSrc.replace(/kiln(\.min)?\.js([?#].*)?$/, 'kiln-editor.js');
        document.head.appendChild(s);
      } else {
        renderLoginButton();
      }
    });
  }

  /** After OAuth the worker redirects back with #kiln-token=...&kiln-sid=...&kiln-exp=... */
  function captureAdminToken() {
    var m = matchFragment(/kiln-token=([^&]+)/);
    if (!m) return;
    var exp = matchFragment(/kiln-exp=(\d+)/);
    var sid = matchFragment(/kiln-sid=([^&]+)/);
    write(ADMIN_KEY, {
      token: decodeURIComponent(m[1]),
      exp: exp ? Number(exp[1]) : null,
      sid: sid ? decodeURIComponent(sid[1]) : null,
    });
    cleanFragment(['kiln-token', 'kiln-exp', 'kiln-sid']);
  }

  /** Invite links look like https://site.com/#kiln-invite=<64 hex chars> */
  function captureEditorInvite() {
    var m = matchFragment(/kiln-invite=([a-f0-9]{64})/);
    if (!m || !cfg.worker) return Promise.resolve();
    cleanFragment(['kiln-invite']);
    return fetch(cfg.worker + '/editor/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invite: m[1] }),
    }).then(function (r) { return r.json(); }).then(function (data) {
      if (data.session) write(EDITOR_KEY, data);
      else alert('Kiln: this invite link has expired or was already used. Ask for a new one.');
    }).catch(function () { /* network hiccup — just boot anonymously */ });
  }

  function renderLoginButton() {
    if (!cfg.worker) return;
    var btn = document.createElement('button');
    btn.id = 'kiln-login';
    btn.textContent = '✎';
    btn.title = 'Site owner? Sign in to edit.';
    btn.setAttribute('aria-label', 'Sign in to edit this site');
    btn.style.cssText = 'position:fixed;bottom:16px;right:16px;width:40px;height:40px;border-radius:50%;' +
      'background:#1a1a2e;color:#fff;border:0;font-size:16px;cursor:pointer;opacity:.45;z-index:99999;' +
      'box-shadow:0 2px 8px rgba(0,0,0,.25);transition:opacity .15s';
    btn.onmouseenter = function () { btn.style.opacity = '1'; };
    btn.onmouseleave = function () { btn.style.opacity = '.45'; };
    btn.onclick = function () {
      var returnTo = location.pathname + location.search;
      location.href = cfg.worker + '/auth/login?origin=' + encodeURIComponent(location.origin) +
        '&return_to=' + encodeURIComponent(returnTo);
    };
    document.body.appendChild(btn);
  }

  function renderResumeButton() {
    var btn = document.createElement('button');
    btn.id = 'kiln-login';
    btn.textContent = '✎ Resume editing';
    btn.style.cssText = 'position:fixed;bottom:16px;right:16px;border-radius:20px;' +
      'background:#1a1a2e;color:#fff;border:0;font-size:13px;padding:10px 16px;cursor:pointer;' +
      'z-index:99999;box-shadow:0 2px 8px rgba(0,0,0,.25)';
    btn.onclick = function () {
      sessionStorage.removeItem('kiln_pause');
      location.reload();
    };
    document.body.appendChild(btn);
  }

  function matchFragment(re) { return location.hash.match(re); }

  function cleanFragment(keys) {
    var hash = location.hash.replace(/^#/, '').split('&').filter(function (part) {
      return keys.every(function (k) { return part.indexOf(k + '=') !== 0; });
    }).join('&');
    history.replaceState(null, '', location.pathname + location.search + (hash ? '#' + hash : ''));
  }

  function read(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; }
  }
  function write(key, value) { localStorage.setItem(key, JSON.stringify(value)); }

  window.Kiln = {
    logout: function () {
      var admin = read(ADMIN_KEY);
      if (admin && admin.sid && cfg.worker) {
        fetch(cfg.worker + '/auth/logout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sid: admin.sid }),
        }).catch(function () {});
      }
      localStorage.removeItem(ADMIN_KEY);
      localStorage.removeItem(EDITOR_KEY);
      location.reload();
    },
  };
})();
