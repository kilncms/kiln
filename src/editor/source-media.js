/**
 * Pictures and link addresses from the content files: what the editor says
 * about them, and the small decisions it makes before anything is staged.
 *
 * A picture in a content file is a path to a file in the repository. A new
 * picture goes in the folder the field's picture is in now (adapters/
 * pictures.js), is named from the uploaded file, and is committed before
 * the content file that names it. Where that cannot be done (no picture to
 * follow, a picture on another site, a folder the person was not given, a
 * schema that wants a full web address), the editor says why before anyone
 * picks a file.
 *
 * Pure; main.js draws the dialog.
 */

import { picturePlace } from '../adapters/pictures.js';
import { parseInline } from '../adapters/markdown.js';
import { inScope } from './image-picker.js';

/** Why a picture can't be replaced here, as a sentence. */
export function placeSentence(why, folder = '') {
  if (why === 'empty') return 'This picture has no file yet, so Kiln can’t tell which folder the site keeps these pictures in. Ask the site’s owner to add the first one.';
  if (why === 'remote') return 'This picture comes from another website, so a new one can’t be put in its place here. Ask the site’s owner to change it.';
  if (why === 'alias') return 'This picture’s address uses a shortcut set in the site’s code, so Kiln can’t tell which folder it is in. Ask the site’s owner to change it.';
  if (why === 'scope') return `Pictures for this are kept in ${folder}, a folder you were not given. Ask the site’s owner to change it.`;
  if (why === 'full-address') return 'The site needs a full web address for this picture, so a picture uploaded here can’t go in it. Ask the site’s owner to change it.';
  return 'Kiln can’t tell where this picture is kept, so it can’t be replaced here. Ask the site’s owner to change it.';
}

/**
 * Where a new picture for this field goes: { place } or { why, sentence }.
 * `field` is its schema (source-schema.js fieldSchema), when the site has one.
 */
export function pictureTarget({ file, value, paths = null, field = null }) {
  const place = picturePlace(file, value);
  if (place.why) return { why: place.why, sentence: placeSentence(place.why) };
  if (field?.node?.type === 'string' && field.node.format === 'uri') return { why: 'full-address', sentence: placeSentence('full-address') };
  if (!inScope(`${place.folder}/picture.png`, paths)) return { why: 'scope', sentence: placeSentence('scope', place.folder) };
  return { place };
}

/** A picture as Markdown writes it, `![words](address "title")`: { alt, url, title } or null. */
export function inlinePicture(raw, refs = {}) {
  const nodes = parseInline(String(raw || ''), { refs });
  const img = nodes.length === 1 && nodes[0].type === 'image' ? nodes[0] : null;
  if (!img || typeof img.url !== 'string') return null;
  return { alt: String(img.alt ?? ''), url: img.url.trim(), title: img.title ? String(img.title) : '' };
}

/** What the publish sheet says a picture field became: the new file's name. */
export function pictureName(value) {
  const v = String(value || '');
  let name = v.split('/').pop() || v;
  try { name = decodeURI(name); } catch { /* as written */ }
  return name;
}

/** The person's words for a link address as the file should hold them: trimmed, nothing else. */
export function addressValue(typed) {
  return String(typed ?? '').trim();
}
