/**
 * What an invited editor's session may write to the repo, by file type.
 *
 * An editor writes content, never code. HTML pages are covered by the markup
 * guard (worker/sanitize-guard.js), but a browser will also run script from an
 * SVG, an XML or XSL file, or an XHTML page parsed as XML, and none of those
 * are HTML. So instead of chasing a list of dangerous types, editor writes are
 * limited to a short list of types that are inert when a static host serves
 * them: pages and stylesheets as text, and a handful of binary uploads.
 *
 * SVG is refused outright. A safe SVG needs an XML-aware sanitizer; cleaning
 * it with an HTML parser leaves gaps (namespaced script elements, entities,
 * processing instructions), so until one exists only the site owner adds them.
 *
 * Pure and dependency-free: the worker enforces it on every editor write path.
 * The owner's own GitHub token never passes through here.
 */

// Family → extensions.
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

export const FILE_MESSAGES = {
  type: 'That file type can’t be added here. You can add images (JPG, PNG, GIF, WebP, AVIF), PDFs, Word, Excel and PowerPoint files, fonts, audio and video.',
  active: 'SVG and XML files can run scripts, so only the site owner can add them. Save the image as a PNG and try again.',
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

/** True for the binary upload kinds (everything but pages and stylesheets). */
export function isUploadKind(kind) {
  return Object.prototype.hasOwnProperty.call(FAMILIES, kind);
}

/**
 * Judge one editor write by its path. Returns null when editors may write that
 * type, or { status, code, error }: `error` is a plain sentence the editor
 * shows the person as it stands.
 *
 *   403 file_active    a type that can run script (SVG, XML, XSL, XHTML…)
 *   415 file_type      any other type that is not on the list
 */
export function uploadProblem(path) {
  if (editorFileKind(path)) return null;
  return ACTIVE_EXT.has(fileExt(path))
    ? { status: 403, code: 'file_active', error: FILE_MESSAGES.active }
    : { status: 415, code: 'file_type', error: FILE_MESSAGES.type };
}
