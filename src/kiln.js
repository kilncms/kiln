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

  // Typing #kiln in the address bar while already on the page also summons Kiln.
  window.addEventListener('hashchange', function () {
    if (/^#(kiln|edit)$/.test(location.hash)) location.reload();
  });

  function boot() {
    captureAdminToken();
    captureGoogleSession();
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
      // The edit flow is summoned by visiting yoursite.com/#edit (or #kiln) —
      // no always-visible button cluttering the site. Set KILN.loginButton = true
      // to show a discreet pencil button anyway.
      var summoned = /^#(kiln|edit)$/.test(location.hash);
      if (summoned) {
        history.replaceState(null, '', location.pathname + location.search);
        sessionStorage.removeItem('kiln_pause');
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
      } else if (summoned) {
        renderLoginChooser();
      } else if (cfg.loginButton) {
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

  /** After Google sign-in the worker redirects editors back with a ready session. */
  function captureGoogleSession() {
    var m = matchFragment(/kiln-esession=([a-f0-9]{64})/);
    if (!m) return;
    var name = matchFragment(/kiln-name=([^&]+)/);
    var repo = matchFragment(/kiln-repo=([^&]+)/);
    var exp = matchFragment(/kiln-exp=(\d+)/);
    write(EDITOR_KEY, {
      session: m[1],
      name: name ? decodeURIComponent(name[1].replace(/\+/g, ' ')) : 'Editor',
      repo: repo ? decodeURIComponent(repo[1]) : (cfg.repo || ''),
      role: 'editor',
      exp: exp ? Number(exp[1]) : null,
    });
    cleanFragment(['kiln-esession', 'kiln-name', 'kiln-repo', 'kiln-exp']);
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
    btn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>';
    btn.title = 'Sign in to edit this site';
    btn.setAttribute('aria-label', 'Sign in to edit this site');
    btn.style.cssText = 'position:fixed;bottom:16px;right:16px;width:42px;height:42px;border-radius:50%;' +
      'display:flex;align-items:center;justify-content:center;' +
      'background:#101019;color:#fff;border:0;cursor:pointer;opacity:.5;z-index:99999;' +
      'box-shadow:0 4px 14px rgba(0,0,0,.28);transition:opacity .15s,transform .15s';
    btn.onmouseenter = function () { btn.style.opacity = '1'; btn.style.transform = 'scale(1.06)'; };
    btn.onmouseleave = function () { btn.style.opacity = '.5'; btn.style.transform = 'scale(1)'; };
    btn.onclick = function () { renderLoginChooser(); };
    document.body.appendChild(btn);
  }

  function renderLoginChooser() {
    var old = document.getElementById('kiln-login-pop');
    if (old) { old.remove(); return; }
    if (!cfg.worker) return;
    var returnTo = location.pathname + location.search;
    var q = 'origin=' + encodeURIComponent(location.origin) + '&return_to=' + encodeURIComponent(returnTo);
    var pop = document.createElement('div');
    pop.id = 'kiln-login-pop';
    pop.style.cssText = 'position:fixed;bottom:66px;right:16px;background:#fff;color:#1c1c28;z-index:99999;' +
      'border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.22);padding:10px;width:240px;' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:13px';
    var showGoogle = !(cfg.auth && cfg.auth.google === false);
    pop.innerHTML =
      (showGoogle ? '<button data-kind="google" style="' + chooserBtnCss() + '">' +
        '<svg width="16" height="16" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z"/><path fill="#FBBC05" d="M5.84 14.1A6.6 6.6 0 0 1 5.5 12c0-.73.13-1.43.34-2.1V7.06H2.18A11 11 0 0 0 1 12c0 1.77.43 3.45 1.18 4.94l3.66-2.84z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.16-3.16A10.97 10.97 0 0 0 12 1 11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.3 9.14 5.38 12 5.38z"/></svg>' +
        '<span><strong>Continue with Google</strong><br><small style="color:#777">Invited editors &amp; members</small></span></button>' : '') +
      '<button data-kind="github" style="' + chooserBtnCss() + '">' +
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="#1c1c28"><path d="M12 .5A11.5 11.5 0 0 0 .5 12.26c0 5.2 3.3 9.6 7.86 11.16.58.11.79-.26.79-.57v-2c-3.2.71-3.87-1.58-3.87-1.58-.53-1.37-1.28-1.73-1.28-1.73-1.05-.74.08-.72.08-.72 1.15.08 1.76 1.22 1.76 1.22 1.03 1.81 2.7 1.29 3.36.98.1-.77.4-1.29.73-1.58-2.55-.3-5.23-1.31-5.23-5.82 0-1.29.45-2.34 1.18-3.16-.12-.3-.51-1.5.11-3.12 0 0 .97-.32 3.17 1.21a10.7 10.7 0 0 1 5.78 0c2.2-1.53 3.16-1.21 3.16-1.21.63 1.62.24 2.82.12 3.12.74.82 1.18 1.87 1.18 3.16 0 4.52-2.69 5.51-5.25 5.8.41.37.78 1.08.78 2.18v3.23c0 .31.2.69.8.57a11.77 11.77 0 0 0 7.85-11.16A11.5 11.5 0 0 0 12 .5z"/></svg>' +
        '<span><strong>Continue with GitHub</strong><br><small style="color:#777">Site owner / developer</small></span></button>';
    var gBtn = pop.querySelector('[data-kind="google"]');
    if (gBtn) gBtn.onclick = function () {
      location.href = cfg.worker + '/google/login?' + q + '&repo=' + encodeURIComponent(cfg.repo || '');
    };
    pop.querySelector('[data-kind="github"]').onclick = function () {
      location.href = cfg.worker + '/auth/login?' + q;
    };
    document.addEventListener('click', function close(e) {
      if (!pop.contains(e.target) && e.target.id !== 'kiln-login') {
        pop.remove();
        document.removeEventListener('click', close);
      }
    });
    document.body.appendChild(pop);
  }

  function chooserBtnCss() {
    return 'display:flex;align-items:center;gap:10px;width:100%;text-align:left;background:none;' +
      'border:0;border-radius:10px;padding:10px;cursor:pointer;font:inherit;line-height:1.25;';
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
