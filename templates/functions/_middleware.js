/**
 * The front door for addresses written with %-codes.
 *
 * Cloudflare Pages decides whether a function runs from the address as it was
 * written, but its file server decodes the address before finding the file.
 * So /%6Dembers/ (the "m" written as %6D) never reached the members gate and
 * was served the members page itself. _routes.json sends every address that
 * contains a % here (and only those, so ordinary page views cost nothing): one
 * that decodes into the members area is sent to its plain form, where the gate
 * in members/_middleware.js runs. Every other address goes on unchanged.
 */
export async function onRequest({ request, next }) {
  const url = new URL(request.url);
  let decoded;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch {
    return new Response('That address is not valid.', { status: 400, headers: { 'Cache-Control': 'no-store' } });
  }
  if (/^\/members(\/|$)/i.test(decoded)) {
    const plain = encodeURI('/members' + decoded.slice('/members'.length));
    if (plain !== url.pathname) {
      url.pathname = plain;
      return new Response(null, { status: 308, headers: { Location: url.toString(), 'Cache-Control': 'no-store' } });
    }
  }
  return next();
}
