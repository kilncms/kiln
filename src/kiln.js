/**
 * kiln.js — the boot shim. The only script every visitor loads, so it stays
 * tiny and dependency-free. The real editor (kiln-editor.js, ~10× larger) is
 * injected only after we know the visitor is the site owner or an invited editor.
 *
 * THE ENTRY POINT IS /kiln. Owners and invited editors start editing by visiting
 *   https://yoursite.com/kiln
 * which presents the Kiln sign-in. There is deliberately NO edit button on the
 * site itself — visitors never see a Kiln affordance. Once signed in, every page
 * loads in edit mode automatically until you sign out.
 *
 * Wire it up — on every page, at the end of <body>:
 *   <script src="/assets/kiln-config.js"></script>   // sets window.KILN = { repo, worker, ... }
 *   <script src="/assets/kiln.js" defer></script>
 * and add a /kiln entry page (kiln.html at the site root) that loads the same two
 * scripts. `npx github:kilncms/kiln` creates kiln.html for you.
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
    loadFeaturesIfUsed();
    captureAdminToken();
    captureGoogleSession();

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

    // Sandbox demo: auto-grant a private, local editor session so every visitor
    // can try editing immediately. Their edits never leave their own browser.
    if (cfg.sandbox && !admin && !editor) {
      editor = { session: 'sandbox', name: 'You', repo: cfg.repo, role: 'editor', sandbox: true };
      write(EDITOR_KEY, editor);
    }

    var onEntry = isEntryPage();

    if (admin || editor) {
      // Signed in. The /kiln entry page just bounces to the live site, which
      // then loads in edit mode automatically (below).
      if (onEntry) {
        location.replace(cfg.home || '/');
        return;
      }
      if (sessionStorage.getItem('kiln_pause') === '1') {
        renderResumeButton();
        return;
      }
      window.__KILN_MODE = admin ? 'admin' : 'editor';
      var s = document.createElement('script');
      s.src = scriptSrc.replace(/kiln(\.min)?\.js([?#].*)?$/, 'kiln-editor.js');
      document.head.appendChild(s);
    } else if (onEntry) {
      // Not signed in, on /kiln → present the sign-in interface.
      renderLoginInterface();
    }
    // Normal page, no session: do nothing. No button, no clutter. To edit,
    // a visitor would have to know to go to /kiln and sign in.
  }

  /**
   * Content features (tag filters, galleries, event calendars, document chips)
   * live in a separate runtime so this shim stays tiny. Load it only when the
   * page actually uses one of them.
   */
  function loadFeaturesIfUsed() {
    if (!document.querySelector('[data-kiln-tags],[data-kiln-filters],[data-kiln-gallery],[data-kiln-events],.kiln-doc')) return;
    var s = document.createElement('script');
    s.src = scriptSrc.replace(/kiln(\.min)?\.js([?#].*)?$/, 'kiln-features.js');
    s.defer = true;
    document.head.appendChild(s);
  }

  /** The dedicated Kiln entry page, served at /kiln (kiln.html at the site root). */
  function isEntryPage() {
    if (cfg.entry === false) return false;
    return /(^|\/)kiln(\.html)?$/.test(location.pathname);
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

  /** Full-page sign-in shown ONLY on the /kiln entry page. */
  function renderLoginInterface() {
    if (!cfg.worker) {
      document.body.innerHTML =
        '<p style="font:15px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;padding:2rem;color:#444">' +
        'Kiln isn’t configured for this site yet (missing <code>worker</code> URL in kiln-config.js).</p>';
      return;
    }
    var returnTo = cfg.home || '/';
    var q = 'origin=' + encodeURIComponent(location.origin) + '&return_to=' + encodeURIComponent(returnTo);
    var showGoogle = !(cfg.auth && cfg.auth.google === false);

    var wrap = document.createElement('div');
    wrap.id = 'kiln-entry';
    wrap.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;' +
      'justify-content:center;padding:20px;background:#f4f3ef;' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif';

    var card = document.createElement('div');
    card.style.cssText = 'background:#fff;border-radius:18px;box-shadow:0 18px 56px rgba(0,0,0,.16);' +
      'padding:32px 28px;width:340px;max-width:100%;text-align:center;box-sizing:border-box';
    card.innerHTML =
      '<div style="font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:#a3a3ad;margin-bottom:8px">Kiln</div>' +
      '<h1 style="font-size:21px;line-height:1.2;margin:0 0 4px;color:#1c1c28">Sign in to edit</h1>' +
      '<p style="font-size:13px;color:#888;margin:0 0 22px">' + esc(cfg.siteName || 'this site') + '</p>' +
      '<div id="kiln-entry-btns"></div>' +
      '<p style="font-size:11px;line-height:1.5;color:#b0b0b8;margin:20px 0 0">Editors and members sign in with Google. ' +
      'The site owner signs in with GitHub.</p>';

    var btns = card.querySelector('#kiln-entry-btns');
    if (showGoogle) btns.appendChild(loginButton('google', 'Continue with Google', 'Invited editors & members',
      cfg.worker + '/google/login?' + q + '&repo=' + encodeURIComponent(cfg.repo || '')));
    btns.appendChild(loginButton('github', 'Continue with GitHub', 'Site owner / developer',
      cfg.worker + '/auth/login?' + q));

    wrap.appendChild(card);
    document.body.appendChild(wrap);
  }

  function loginButton(kind, title, sub, href) {
    var icon = kind === 'google'
      ? '<svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z"/><path fill="#FBBC05" d="M5.84 14.1A6.6 6.6 0 0 1 5.5 12c0-.73.13-1.43.34-2.1V7.06H2.18A11 11 0 0 0 1 12c0 1.77.43 3.45 1.18 4.94l3.66-2.84z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.16-3.16A10.97 10.97 0 0 0 12 1 11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.3 9.14 5.38 12 5.38z"/></svg>'
      : '<svg width="17" height="17" viewBox="0 0 24 24" fill="#1c1c28" aria-hidden="true"><path d="M12 .5A11.5 11.5 0 0 0 .5 12.26c0 5.2 3.3 9.6 7.86 11.16.58.11.79-.26.79-.57v-2c-3.2.71-3.87-1.58-3.87-1.58-.53-1.37-1.28-1.73-1.28-1.73-1.05-.74.08-.72.08-.72 1.15.08 1.76 1.22 1.76 1.22 1.03 1.81 2.7 1.29 3.36.98.1-.77.4-1.29.73-1.58-2.55-.3-5.23-1.31-5.23-5.82 0-1.29.45-2.34 1.18-3.16-.12-.3-.51-1.5.11-3.12 0 0 .97-.32 3.17 1.21a10.7 10.7 0 0 1 5.78 0c2.2-1.53 3.16-1.21 3.16-1.21.63 1.62.24 2.82.12 3.12.74.82 1.18 1.87 1.18 3.16 0 4.52-2.69 5.51-5.25 5.8.41.37.78 1.08.78 2.18v3.23c0 .31.2.69.8.57a11.77 11.77 0 0 0 7.85-11.16A11.5 11.5 0 0 0 12 .5z"/></svg>';
    var a = document.createElement('button');
    a.type = 'button';
    a.style.cssText = 'display:flex;align-items:center;gap:11px;width:100%;text-align:left;margin:0 0 9px;' +
      'background:#fff;border:1px solid #e3e3e8;border-radius:11px;padding:12px 13px;cursor:pointer;' +
      'font:inherit;line-height:1.25;transition:border-color .12s,box-shadow .12s';
    a.onmouseenter = function () { a.style.borderColor = '#c7c7d0'; a.style.boxShadow = '0 2px 8px rgba(0,0,0,.06)'; };
    a.onmouseleave = function () { a.style.borderColor = '#e3e3e8'; a.style.boxShadow = 'none'; };
    a.innerHTML = icon + '<span style="flex:1"><strong style="display:block;font-size:14px;color:#1c1c28">' +
      title + '</strong><small style="color:#999;font-size:11.5px">' + sub + '</small></span>';
    a.onclick = function () { location.href = href; };
    return a;
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

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
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
      location.replace(cfg.home || '/');
    },
  };
})();
