/**
 * What an invited editor's session may write to the repo, by file type.
 *
 * An editor writes content, never code. HTML pages are covered by the markup
 * guard (worker/sanitize-guard.js), but a browser will also run script from an
 * SVG, an XML or XSL file, or an XHTML page parsed as XML, and none of those
 * are HTML. So instead of chasing a list of dangerous types, editor writes are
 * limited to a short list of types that are inert when a static host serves
 * them: pages and stylesheets as text, and a handful of binary uploads that
 * must also LOOK like what their name says (leading bytes) and stay under a
 * size ceiling.
 *
 * SVG is refused outright. A safe SVG needs an XML-aware sanitizer; cleaning
 * it with an HTML parser leaves gaps (namespaced script elements, entities,
 * processing instructions), so until one exists only the site owner adds them.
 *
 * Pure and dependency-free: the worker enforces it on every editor write path
 * and the editor reads the same table to tell the person before they publish.
 * The owner's own GitHub token never passes through here.
 */

/** Per-file ceiling for anything an editor session writes. */
export const UPLOAD_MAX_BYTES = 15 * 1024 * 1024;

// Family → extensions. A file must sniff as its FAMILY, not its exact
// extension: browsers that cannot encode WebP hand back PNG bytes under the
// name the editor already chose, and that is harmless.
const FAMILIES = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico'],
  pdf: ['pdf'],
  font: ['woff', 'woff2', 'ttf', 'otf'],
  media: ['mp3', 'm4a', 'mp4', 'm4v', 'mov', 'webm', 'ogg', 'oga', 'ogv', 'wav'],
  office: ['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp'],
};
const TEXT_KINDS = { html: 'html', htm: 'html', css: 'css' };

const KIND_BY_EXT = new Map(Object.entries(TEXT_KINDS));
for (const [family, exts] of Object.entries(FAMILIES)) for (const e of exts) KIND_BY_EXT.set(e, family);

// Types a browser treats as a document that can run script. Only used to pick
// the clearer refusal; the allow-list above is the gate.
const ACTIVE_EXT = new Set(['svg', 'svgz', 'xml', 'xsl', 'xslt', 'xhtml', 'xht', 'rss', 'atom',
  'mathml', 'mml', 'rdf', 'xsd', 'wsdl', 'shtml', 'hta', 'htc']);

const NOUN = { image: 'an image', pdf: 'a PDF', font: 'a font', media: 'an audio or video file', office: 'an Office document' };

export const FILE_MESSAGES = {
  type: 'That file type can’t be added here. You can add images (JPG, PNG, GIF, WebP, AVIF), PDFs, Word, Excel and PowerPoint files, fonts, audio and video.',
  active: 'SVG and XML files can run scripts, so only the site owner can add them. Save the image as a PNG and try again.',
  size: `That file is too big. The limit is ${UPLOAD_MAX_BYTES / (1024 * 1024)} MB.`,
  mismatch: (kind) => `That file is named like ${NOUN[kind] || 'something it is not'}, but it holds something else. Check the file and try again.`,
};

/** Lowercased extension of the last path segment, without the dot ('' if none). */
export function fileExt(path) {
  const name = String(path || '').split('/').pop();
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

/**
 * The kind of file an editor session may write at `path`:
 * 'html' | 'css' | 'image' | 'pdf' | 'font' | 'media' | 'office', or null when
 * editors may not write that type at all.
 */
export function editorFileKind(path) {
  return KIND_BY_EXT.get(fileExt(path)) || null;
}

/** True for the binary kinds, whose leading bytes are checked. */
export function isUploadKind(kind) {
  return Object.prototype.hasOwnProperty.call(FAMILIES, kind);
}

const ascii = (bytes, from, text) => {
  if (bytes.length < from + text.length) return false;
  for (let i = 0; i < text.length; i++) if (bytes[from + i] !== text.charCodeAt(i)) return false;
  return true;
};
const starts = (bytes, ...sig) => bytes.length >= sig.length && sig.every((b, i) => bytes[i] === b);

/**
 * Which family a file's leading bytes belong to, or null. Needs the first 16
 * bytes (more is fine). Signatures only, so this says "starts like a PNG", not
 * "is a valid PNG": the host still serves the file by its extension.
 */
export function sniffFamily(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (starts(b, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image';   // PNG
  if (starts(b, 0xff, 0xd8, 0xff)) return 'image';                                 // JPEG
  if (ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a')) return 'image';
  if (ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) return 'image';
  if (ascii(b, 0, 'RIFF') && ascii(b, 8, 'WAVE')) return 'media';
  if (starts(b, 0x00, 0x00, 0x01, 0x00)) return 'image';                           // ICO
  if (ascii(b, 4, 'ftyp')) {                                                       // ISO media: brand decides
    return ['avif', 'avis', 'mif1', 'msf1'].some(brand => ascii(b, 8, brand)) ? 'image' : 'media';
  }
  if (['moov', 'mdat', 'free', 'wide', 'skip'].some(atom => ascii(b, 4, atom))) return 'media';   // QuickTime without ftyp
  // The header may follow a byte-order mark or a stray newline.
  for (let i = 0; i <= 8; i++) if (ascii(b, i, '%PDF-')) return 'pdf';
  if (ascii(b, 0, 'wOFF') || ascii(b, 0, 'wOF2') || ascii(b, 0, 'OTTO') || ascii(b, 0, 'true') || ascii(b, 0, 'ttcf')
    || starts(b, 0x00, 0x01, 0x00, 0x00)) return 'font';
  if (ascii(b, 0, 'ID3') || (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'media';   // MP3
  if (starts(b, 0x1a, 0x45, 0xdf, 0xa3)) return 'media';                           // WebM / Matroska
  if (ascii(b, 0, 'OggS')) return 'media';
  if (starts(b, 0x50, 0x4b, 0x03, 0x04)) return 'office';                          // zip container
  return null;
}

/**
 * Judge one editor write. `size` is the file's byte length (when known) and
 * `head` its leading bytes (needed only for the binary kinds). Returns null
 * when the write is acceptable, or { status, code, error }: `error` is a plain
 * sentence the editor shows the person as it stands.
 *
 *   403 file_active    a type that can run script (SVG, XML, XSL, XHTML…)
 *   415 file_type      any other type that is not on the list
 *   413 file_size      over UPLOAD_MAX_BYTES
 *   415 file_mismatch  an upload whose bytes are not what its name says
 */
export function uploadProblem(path, { size, head } = {}) {
  const kind = editorFileKind(path);
  if (!kind) {
    return ACTIVE_EXT.has(fileExt(path))
      ? { status: 403, code: 'file_active', error: FILE_MESSAGES.active }
      : { status: 415, code: 'file_type', error: FILE_MESSAGES.type };
  }
  if (typeof size === 'number' && size > UPLOAD_MAX_BYTES) {
    return { status: 413, code: 'file_size', error: FILE_MESSAGES.size };
  }
  if (isUploadKind(kind) && head !== undefined && sniffFamily(head) !== kind) {
    return { status: 415, code: 'file_mismatch', error: FILE_MESSAGES.mismatch(kind) };
  }
  return null;
}

/** Decoded byte length of a base64 string, without decoding it. Whitespace
 *  counts as data, so a wrapped string reads slightly high (the safe side). */
export function base64Bytes(b64) {
  const s = String(b64 || '');
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(s.length * 3 / 4) - pad);
}

/** The first bytes of a base64 string (enough for sniffFamily). */
export function base64Head(b64, want = 48) {
  const chars = String(b64 || '').slice(0, Math.ceil(want / 3) * 4 + 16).replace(/[^A-Za-z0-9+/]/g, '');
  const usable = chars.slice(0, Math.floor(Math.min(chars.length, Math.ceil(want / 3) * 4) / 4) * 4);
  let bin = '';
  try { bin = atob(usable); } catch { return new Uint8Array(0); }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * The sentence to show the person when a write was refused for its FILE (one
 * of the `file_*` codes above), read from the worker's JSON answer. Null for
 * every other kind of failure, which keeps its own wording.
 */
export function fileRefusalText(data) {
  if (!data || typeof data.code !== 'string' || !data.code.startsWith('file_')) return null;
  return typeof data.error === 'string' && data.error ? data.error : null;
}
