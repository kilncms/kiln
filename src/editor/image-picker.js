/**
 * Replacing a picture: upload one, or choose one that is already on the site.
 *
 * "From this site" lists the image files in the site's repository, read once
 * through the same GitHub transport everything else uses (the owner's token,
 * or the worker's proxy for an invited editor) and kept for the session. The
 * pictures used on this page come first. Choosing one points the image at that
 * file's address: the same reference an upload ends in, with nothing queued to
 * commit. An editor limited to certain folders sees only pictures in them.
 *
 * Editor chrome only; main.js hands its seams in through `deps`. Names that
 * come from the repository are written with textContent, never innerHTML.
 *
 * inScope, siteImages, filterImages, formatSize and chooseSiteImage are pure
 * and exported for tests.
 */

const IMAGE_RE = /\.(png|jpe?g|webp|avif|gif|svg)$/i;
const ICON_RE = /^(favicon|apple-touch-icon|android-chrome|mstile|safari-pinned-tab)/i;
const PER_PAGE = 24;

// ─── pure helpers ────────────────────────────────────────────────────────────

/** Whether a repository path is inside an editor's granted folders. The worker's rule, word for word. */
export function inScope(filePath, paths) {
  const f = String(filePath).replace(/^\/+/, '');
  if (f.split('/').some(s => s === '..' || s === '.')) return false;
  if (!Array.isArray(paths) || paths.length === 0) return true;
  if (paths.some(p => p === '' || p === '**' || p === '*')) return true;
  return paths.some(p => {
    const pre = String(p).replace(/^\/+/, '').replace(/\/+$/, '');
    return !pre || f === pre || f.startsWith(pre + '/');
  });
}

/**
 * The pictures a person may choose from, out of a recursive git tree.
 *
 * tree:   [{ path, type, size }] as GitHub returns it
 * root:   the folder the site is published from ('' for the repository root)
 * paths:  the editor's granted folders (null or empty: the whole site)
 * onPage: addresses of pictures on the current page ('/img/a.png'), in order
 *
 * Returns [{ path, url, name, folder, size, onPage }]: pictures on this page
 * first, in page order, then the rest by folder and name. Left out: files
 * outside `root`, hidden folders, node_modules, site icons, and the full-size
 * masters Kiln keeps beside each upload.
 */
export function siteImages(tree, { root = '', paths = null, onPage = [] } = {}) {
  const pre = String(root || '').replace(/^\/+|\/+$/g, '');
  const order = new Map(onPage.map((u, i) => [u, i]));
  const out = [];
  for (const e of tree || []) {
    if (!e || e.type !== 'blob' || typeof e.path !== 'string' || !IMAGE_RE.test(e.path)) continue;
    if (pre && !e.path.startsWith(pre + '/')) continue;
    const rel = pre ? e.path.slice(pre.length + 1) : e.path;
    const segs = rel.split('/');
    const name = segs[segs.length - 1];
    if (segs.some(s => s.startsWith('.') || s === 'node_modules')) continue;
    if (ICON_RE.test(name) || /^master-[a-z0-9]+\.webp$/i.test(name)) continue;
    if (!inScope(e.path, paths)) continue;
    const url = '/' + segs.map(encodeURIComponent).join('/');
    out.push({ path: e.path, url, name, folder: segs.slice(0, -1).join('/'), size: Number(e.size) || 0, onPage: order.has(url) || order.has('/' + rel) });
  }
  const rank = (i) => (order.get(i.url) ?? order.get('/' + i.path.slice(pre ? pre.length + 1 : 0)) ?? Infinity);
  return out.sort((a, b) => (rank(a) - rank(b)) || a.folder.localeCompare(b.folder) || a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/** Pictures whose name or folder contains every word typed. */
export function filterImages(list, query) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return list;
  return list.filter(i => { const hay = (i.folder + '/' + i.name).toLowerCase(); return words.every(w => hay.includes(w)); });
}

export function formatSize(bytes) {
  const n = Number(bytes) || 0;
  if (!n) return '';
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/**
 * Point an image at a picture that is already on the site and stage that.
 * deps: { stagePending(key, patch), stageContainer(container, key), safeUrl(url) }.
 * Nothing here can queue a file: this module is not given the means to.
 */
export function chooseSiteImage(img, key, url, deps) {
  const ref = deps.safeUrl(url);
  if (!ref) return false;
  img.removeAttribute('data-kiln-src');          // an upload waiting to be published is no longer the picture
  img.setAttribute('src', ref);
  img.setAttribute('data-kiln-master', ref);     // the file itself is the largest version there is
  img.classList.add('kiln-modified');
  const repeat = img.closest('[data-cms-repeat]');
  if (repeat) deps.stageContainer(repeat, repeat.getAttribute('data-cms-repeat'));
  else deps.stagePending(key, { attrs: { src: ref, 'data-kiln-master': ref } });
  return true;
}

// ─── the dialog ──────────────────────────────────────────────────────────────

const cache = new Map();   // repo@branch → Promise<{ tree, truncated }>, for this page load

/** Forget the listing (after a publish that added files). */
export function clearImageCache() { cache.clear(); }

function loadTree(deps) {
  const id = `${deps.repo}@${deps.branch}`;
  if (!cache.has(id)) {
    const p = deps.request('GET', `/repos/${deps.repo}/git/trees/${encodeURIComponent(deps.branch)}?recursive=1`)
      .then(r => ({ tree: Array.isArray(r.tree) ? r.tree : [], truncated: !!r.truncated }));
    p.catch(() => cache.delete(id));   // a failed read is asked again next time
    cache.set(id, p);
  }
  return cache.get(id);
}

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

/**
 * Open the dialog.
 *
 * deps: {
 *   modal(html)
 *   upload()                the existing file-picker upload for this image
 *   choose(image)           the person picked { url, name, ... }
 *   request(method, path)   the GitHub transport, or null when there is no repository (the demo)
 *   stopped(err)            what a failed read means for the sign-in, as a line to show ('' when nothing)
 *   repo, branch, root, paths
 *   pageImages()            → [{ url, name, size }] pictures on this page
 * }
 */
export function openImagePicker(deps) {
  const m = deps.modal(`<h3>Replace this picture</h3>
    <div class="kiln-tabs" role="tablist">
      <button class="kiln-tab kiln-tab-on" type="button" role="tab" id="kiln-pick-tab-upload" aria-selected="true">Upload</button>
      <button class="kiln-tab" type="button" role="tab" id="kiln-pick-tab-site" aria-selected="false">From this site</button>
    </div>
    <div id="kiln-pick-pane-upload">
      <button type="button" class="kiln-pick-drop" id="kiln-pick-upload"><strong>Choose a picture from this device</strong><span>It is made web-sized for you and added to the site when you publish.</span></button>
    </div>
    <div id="kiln-pick-pane-site" hidden>
      <input type="text" id="kiln-pick-search" placeholder="Search by name" autocomplete="off" aria-label="Search pictures by name">
      <p class="kiln-pick-note" id="kiln-pick-note" role="status"></p>
      <div class="kiln-pick-grid" id="kiln-pick-grid"></div>
      <button type="button" class="kiln-btn-ghost kiln-pick-more" id="kiln-pick-more" hidden>Show more</button>
    </div>`);
  m.classList.add('kiln-imgpick');
  const close = () => m.querySelector('[data-close]').click();
  const panes = { upload: m.querySelector('#kiln-pick-pane-upload'), site: m.querySelector('#kiln-pick-pane-site') };
  const tabs = { upload: m.querySelector('#kiln-pick-tab-upload'), site: m.querySelector('#kiln-pick-tab-site') };
  const grid = m.querySelector('#kiln-pick-grid'), note = m.querySelector('#kiln-pick-note');
  const more = m.querySelector('#kiln-pick-more'), search = m.querySelector('#kiln-pick-search');
  let all = null, shown = PER_PAGE;

  const draw = () => {
    if (!all) return;
    const list = filterImages(all, search.value);
    grid.textContent = '';
    // two groups, each under its own label: what is on this page, then the rest
    const some = list.some(i => i.onPage), rest = list.some(i => !i.onPage);
    let group = null;
    for (const image of list.slice(0, shown)) {
      if (some && rest && group !== image.onPage) {
        group = image.onPage;
        grid.append(el('div', 'kiln-pick-group', group ? 'On this page' : 'The rest of the site'));
      }
      const tile = el('button', 'kiln-pick-tile');
      tile.type = 'button';
      tile.title = image.folder ? `${image.folder}/${image.name}` : image.name;
      const pic = el('span', 'kiln-pick-pic');
      const img = el('img');
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.src = image.url;
      img.addEventListener('error', () => { pic.textContent = 'Not on the live site yet'; pic.classList.add('kiln-pick-missing'); });
      pic.append(img);
      // the folder nearest the file tells two "photo-1.jpg" apart; the whole path is in the tooltip
      const meta = [image.folder.split('/').pop(), formatSize(image.size)].filter(Boolean).join(' · ');
      tile.append(pic, el('span', 'kiln-pick-name', image.name), el('span', 'kiln-pick-meta', meta));
      tile.addEventListener('click', () => { close(); deps.choose(image); });
      grid.append(tile);
    }
    more.hidden = list.length <= shown;
    if (!more.hidden) more.textContent = `Show more (${list.length - shown} left)`;
    if (!list.length) note.textContent = all.length ? 'No picture has that in its name.' : (all.empty || 'There are no pictures in this site yet.');
    else note.textContent = all.note || '';
    note.hidden = !note.textContent;
  };

  const load = async () => {
    if (all) return;
    if (!deps.request) {
      // the demo has no repository to read
      all = deps.pageImages().map(i => ({ ...i, folder: '', onPage: true }));
      all.note = 'In the demo this shows the pictures on this page. On your own site it lists every picture in the site.';
      draw();
      return;
    }
    note.hidden = false;
    note.textContent = 'Reading the site’s pictures…';
    try {
      const { tree, truncated } = await loadTree(deps);
      const list = siteImages(tree, { root: deps.root, paths: deps.paths, onPage: deps.pageImages().map(i => i.url) });
      list.note = truncated ? 'This site has a great many files. Only the first part is listed here.' : '';
      list.empty = deps.paths && deps.paths.length && !deps.paths.some(p => p === '' || p === '*' || p === '**')
        ? 'There are no pictures in the folders you can edit.' : '';
      all = list;
      draw();
    } catch (err) {
      note.textContent = (deps.stopped && deps.stopped(err)) || 'The list of pictures could not be read. Upload one instead, or try again in a moment.';
    }
  };

  const show = (which) => {
    for (const k of Object.keys(panes)) {
      panes[k].hidden = k !== which;
      tabs[k].classList.toggle('kiln-tab-on', k === which);
      tabs[k].setAttribute('aria-selected', String(k === which));
    }
    if (which === 'site') { load(); if (!window.matchMedia('(hover: none)').matches) search.focus({ preventScroll: true }); }
  };
  tabs.upload.addEventListener('click', () => show('upload'));
  tabs.site.addEventListener('click', () => show('site'));
  m.querySelector('#kiln-pick-upload').addEventListener('click', () => { close(); deps.upload(); });
  search.addEventListener('input', () => { shown = PER_PAGE; draw(); });
  more.addEventListener('click', () => { shown += PER_PAGE; draw(); });
  m.querySelector('#kiln-pick-upload').focus({ preventScroll: true });
  return m;
}

export function imagePickerCss(mobileMq) {
  return `
.kiln-imgpick .kiln-modal-card{max-width:620px}
.kiln-pick-drop{display:flex;flex-direction:column;align-items:center;gap:6px;width:100%;padding:34px 18px;border-radius:14px;
  border:2px dashed #c7cbd4;background:#f9fafb;color:#1c1c28;cursor:pointer;font-family:var(--kiln-font);text-align:center}
.kiln-pick-drop strong{font-size:15px;font-weight:700}
.kiln-pick-drop span{font-size:13px;color:#6b7280;max-width:340px;line-height:1.45}
.kiln-pick-drop:hover,.kiln-pick-drop:focus-visible{border-color:var(--kiln-accent);background:#eef2ff;outline:none}
#kiln-pick-search{margin:0 0 10px}
.kiln-pick-note{margin:0 0 10px;font:13px/1.45 var(--kiln-font);color:#6b7280}
.kiln-pick-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
.kiln-pick-tile{display:flex;flex-direction:column;gap:3px;min-width:0;padding:6px;border-radius:12px;border:1.5px solid #e9ebef;background:#fff;
  cursor:pointer;text-align:left;font-family:var(--kiln-font)}
.kiln-pick-tile:hover,.kiln-pick-tile:focus-visible{border-color:var(--kiln-accent);box-shadow:0 0 0 3px rgba(99,102,241,.18);outline:none}
.kiln-pick-pic{position:relative;display:flex;align-items:center;justify-content:center;aspect-ratio:4/3;border-radius:8px;overflow:hidden;
  background:repeating-conic-gradient(#f3f4f6 0% 25%,#fff 0% 50%) 50%/16px 16px;font:11px/1.3 var(--kiln-font);color:#9ca3af;text-align:center}
.kiln-pick-pic img{width:100%;height:100%;object-fit:cover;display:block}
.kiln-pick-missing img{display:none}
.kiln-pick-group{grid-column:1/-1;font:600 10.5px var(--kiln-font);letter-spacing:.08em;text-transform:uppercase;color:#6b7280;margin:6px 0 -2px}
.kiln-pick-group:first-child{margin-top:0}
.kiln-pick-name{font-size:12px;font-weight:600;color:#1c1c28;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.kiln-pick-meta{font-size:11px;color:#6b7280;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-height:14px}
.kiln-pick-more{display:block;margin:12px auto 0}
.kiln-imgpick .kiln-pick-more{color:#4b5563;border-color:#e5e7eb;background:#f9fafb}
@media ${mobileMq}{
.kiln-pick-grid{grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.kiln-imgpick .kiln-tab{min-height:44px;font-size:14.5px;padding:8px 14px}
.kiln-pick-drop{padding:28px 14px;min-height:120px}
#kiln-pick-search{font-size:16px}
.kiln-pick-more{min-height:44px;width:100%}
}`;
}
