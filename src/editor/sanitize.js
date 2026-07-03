/**
 * DOMPurify configurations for Kiln's two sanitize contexts.
 *
 * Kept in their own module so node unit tests can assert the allowlists
 * without booting the editor (which needs a browser DOM).
 *
 * HISTORY — why CONTAINER_SANITIZE must cover every structural tag: a customer
 * site had <tbody data-cms-repeat="schedule"> table rows. The old allowlist had
 * no table tags, so editing one cell sanitized the whole container down to bare
 * text, which was then published — permanently flattening the table (browsers
 * foster-parent raw text out of <tbody>, so it rendered as a jumbled paragraph
 * above the table). Tags missing from this list don't just lose styling; for
 * table/list structures the content is destroyed. stageContainer() also carries
 * a structure-loss guard as defense in depth.
 */

// URI schemes accepted on href/src after sanitizing. Mirrors DOMPurify's
// default, plus blob: (local image previews before the deploy finishes) and
// data:image/…;base64 raster images (sandbox mode stores uploads inline).
// data:image/svg+xml stays banned — SVG documents can carry script.
export const KILN_URI_REGEXP = new RegExp(
  '^(?:(?:https?|mailto|tel|blob):|data:image/(?:png|jpe?g|gif|webp|avif);base64,'
  + '|[^a-z]|[a-z+.\\-]+(?:[^a-z+.\\-:]|$))', 'i');

export const SANITIZE = {
  ALLOWED_TAGS: ['a', 'abbr', 'b', 'blockquote', 'br', 'code', 'em', 'figcaption', 'figure',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'i', 'img', 'li', 'mark', 'ol', 'p', 's', 'small',
    'span', 'strong', 'sub', 'sup', 'time', 'u', 'ul'],
  ALLOWED_ATTR: ['href', 'target', 'rel', 'title', 'class', 'style', 'src', 'alt', 'width', 'height',
    'datetime', 'download', 'loading', 'data-kiln-src', 'data-kiln-master'],
  ALLOWED_URI_REGEXP: KILN_URI_REGEXP,
};

// Repeat containers carry the site's own structural markup, so the allowlist is
// wider — critically including EVERY structural tag a block could be built from.
// When in doubt, allow the tag — script/style/iframe stay out, and event-handler
// attributes are never in ALLOWED_ATTR.
export const CONTAINER_SANITIZE = {
  ALLOWED_TAGS: ['a', 'abbr', 'address', 'article', 'aside', 'b', 'blockquote', 'br',
    'caption', 'code', 'col', 'colgroup', 'dd', 'div', 'dl', 'dt', 'em', 'figcaption',
    'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'i', 'img',
    'li', 'mark', 'ol', 'p', 'picture', 's', 'section', 'small', 'source', 'span',
    'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'time',
    'tr', 'u', 'ul'],
  ALLOWED_ATTR: ['href', 'target', 'rel', 'title', 'class', 'id', 'style', 'src', 'alt',
    'width', 'height', 'datetime', 'download', 'loading', 'decoding', 'colspan', 'rowspan',
    'scope', 'headers', 'srcset', 'sizes', 'media', 'type', 'data-kiln-src', 'data-kiln-master',
    'data-kiln-tags', 'data-cms', 'data-cms-attr', 'data-cms-plain'],
  ALLOWED_URI_REGEXP: KILN_URI_REGEXP,
};
