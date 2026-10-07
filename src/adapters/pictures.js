/**
 * Pictures named by a content file: where the file a field points at lives in
 * the repository, and what the field says for a new one.
 *
 * Astro reads a picture's address two ways. One that starts with `/` is a
 * file under `public/`, served as it is (`/img/hall.png` is
 * `public/img/hall.png`). Any other is a path from the content file itself
 * (`./images/hall.png` beside `src/content/posts/fair.md` is
 * `src/content/posts/images/hall.png`), which `image()` checks at build and
 * Markdown pictures resolve the same way. A new picture goes in the folder
 * the field's picture is in now, and the field is written in the same style.
 *
 * Pure functions over strings, shared by the editor and the worker.
 */

export const PICTURE_EXT = /\.(?:png|jpe?g|webp|avif|gif|svg)$/i;

/** Folders of a repository path, '.' and '..' resolved; null when it climbs out of the repository. */
function normal(segs) {
  const out = [];
  for (const s of segs) {
    if (s === '' || s === '.') continue;
    if (s === '..') { if (!out.length) return null; out.pop(); continue; }
    out.push(s);
  }
  return out;
}

const dirOf = (p) => p.split('/').slice(0, -1);

/**
 * Where the picture `value` names, for the content file `file`.
 * Returns { kind: 'public' | 'relative', path, folder, style } or { why }:
 *   'empty'        nothing is named yet, so there is no folder to follow
 *   'remote'       an address on another site
 *   'alias'        a shortcut the site's code defines (~/assets, @images)
 *   'outside'      a path that leaves the repository
 *   'not-picture'  a name that is not a picture file
 */
export function picturePlace(file, value, { publicDir = 'public' } = {}) {
  const v = String(value ?? '').trim();
  if (!v) return { why: 'empty' };
  if (/^[a-z][a-z0-9+.-]*:/i.test(v) || v.startsWith('//')) return { why: 'remote' };
  if (/^[~@#$]/.test(v)) return { why: 'alias' };
  if (/[?\\]/.test(v) || /%2f/i.test(v)) return { why: 'outside' };
  let decoded = v;
  try { decoded = decodeURI(v); } catch { return { why: 'outside' }; }
  const name = decoded.split('/').pop();
  if (!PICTURE_EXT.test(name.replace(/#.*$/, ''))) return { why: 'not-picture' };
  if (decoded.startsWith('/')) {
    const segs = normal([...String(publicDir).split('/'), ...decoded.slice(1).split('/')]);
    if (!segs || segs[0] !== String(publicDir).split('/')[0]) return { why: 'outside' };
    const path = segs.join('/');
    return { kind: 'public', path, folder: dirOf(path).join('/'), style: 'root' };
  }
  const segs = normal([...dirOf(String(file)), ...decoded.split('/')]);
  if (!segs || !segs.length) return { why: 'outside' };
  const path = segs.join('/');
  const style = decoded.startsWith('./') ? 'dot' : decoded.startsWith('../') ? 'up' : 'bare';
  return { kind: 'relative', path, folder: dirOf(path).join('/'), style };
}

/** What the field says for the picture at repository path `path`, in the style of `place`. */
export function pictureValue(file, place, path, { publicDir = 'public' } = {}) {
  if (place.kind === 'public') {
    const pre = String(publicDir).replace(/\/+$/, '') + '/';
    return '/' + encodeURI(path.startsWith(pre) ? path.slice(pre.length) : path);
  }
  const from = dirOf(String(file));
  const to = path.split('/');
  let same = 0;
  while (same < from.length && same < to.length - 1 && from[same] === to[same]) same++;
  const rel = [...from.slice(same).map(() => '..'), ...to.slice(same)].join('/');
  if (rel.startsWith('../') || place.style === 'bare') return encodeURI(rel);
  return './' + encodeURI(rel);
}

/**
 * A file name for an uploaded picture: the words of its own name, made safe
 * for an address, and a stamp so that no file is ever written over.
 */
export function pictureFileName(original, ext, stamp) {
  const base = String(original || '').replace(/\.[^.]*$/, '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return `${base || 'picture'}-${stamp}.${String(ext).toLowerCase()}`;
}
