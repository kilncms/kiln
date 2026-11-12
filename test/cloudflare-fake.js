/**
 * An in-memory Cloudflare for one account's Workers that hold a site's files:
 * the three steps of "Direct Uploads" (the list, the files, the deploy), the
 * switch that gives a Worker its workers.dev address, and delete. It behaves
 * as the real service did when it was tried (2026-11-12): it keeps every file
 * it was ever sent by fingerprint, asks only for the ones it lacks, takes the
 * site's _headers and _redirects text as settings, and switches to a new set
 * of files only at the deploy. Not a test file.
 */
const jsonRes = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
const ok = (result, status = 200) => jsonRes({ success: true, errors: [], messages: [], result }, status);
const no = (status, code, message) => jsonRes({ success: false, errors: [{ code, message }], result: null }, status);

export function fakeCloudflare({ account = 'acct-hosting', token = 'cf-token', bucketSize = 2 } = {}) {
  const stored = new Map();      // fingerprint → { type, bytes }
  const sessions = new Map();    // session token → { script, manifest, need:Set }
  const complete = new Map();    // completion token → { script, manifest }
  const scripts = new Map();     // name → { manifest, config, message, address:boolean, deploys }
  const calls = [];
  let fail = null;
  let n = 0;
  const api = {
    account, token, stored, scripts, calls,
    failOn: (fn) => { fail = fn; },
    /** What a visitor gets at a path of a deployed site, or null. */
    serve: (name, path) => { const s = scripts.get(name); const f = s?.manifest[path]; return f ? stored.get(f.hash) : null; },
    handler: async (url, init = {}) => {
      const base = `https://api.cloudflare.com/client/v4/accounts/${account}`;
      if (!url.startsWith(base)) return undefined;
      const method = (init.method || 'GET').toUpperCase();
      const [path] = url.slice(base.length).split('?');
      const auth = (init.headers?.Authorization || '').replace(/^Bearer /, '');
      calls.push({ method, path, auth });
      if (fail && fail(method, path)) return no(500, 10000, 'Internal error');
      let m;
      if ((m = /^\/workers\/scripts\/([^/]+)\/assets-upload-session$/.exec(path)) && method === 'POST') {
        if (auth !== token) return no(403, 10000, 'Authentication error');
        const { manifest } = JSON.parse(init.body);
        for (const [p, f] of Object.entries(manifest)) if (!p.startsWith('/') || !/^[0-9a-f]{32}$/.test(f.hash) || typeof f.size !== 'number') return no(400, 10021, `bad manifest entry ${p}`);
        const need = [...new Set(Object.values(manifest).map(f => f.hash))].filter(h => !stored.has(h));
        const id = ++n;
        if (!need.length) { complete.set(`done-${id}`, { script: m[1], manifest }); return ok({ jwt: `done-${id}`, buckets: [] }); }
        sessions.set(`sess-${id}`, { script: m[1], manifest, need: new Set(need) });
        const buckets = [];
        for (let i = 0; i < need.length; i += bucketSize) buckets.push(need.slice(i, i + bucketSize));
        return ok({ jwt: `sess-${id}`, buckets });
      }
      if (path === '/workers/assets/upload' && method === 'POST') {
        const s = sessions.get(auth);
        if (!s) return no(401, 10000, 'the upload token is not a session');
        if (!/base64=true/.test(url)) return no(400, 10021, 'base64=true is required');
        for (const [hash, file] of init.body.entries()) {
          if (!s.need.has(hash)) return no(400, 10021, `not asked for ${hash}`);
          stored.set(hash, { type: file.type, bytes: Buffer.from(await file.text(), 'base64') });
          s.need.delete(hash);
        }
        if (s.need.size) return ok(null, 202);
        const done = auth.replace('sess-', 'done-');
        complete.set(done, { script: s.script, manifest: s.manifest });
        return ok({ jwt: done }, 201);
      }
      if ((m = /^\/workers\/scripts\/([^/]+)$/.exec(path)) && method === 'PUT') {
        if (auth !== token) return no(403, 10000, 'Authentication error');
        const meta = JSON.parse(init.body.get('metadata'));
        const set = complete.get(meta.assets?.jwt);
        if (!set || set.script !== m[1]) return no(400, 10021, 'assets.jwt is not a completion token for this script');
        const was = scripts.get(m[1]);
        scripts.set(m[1], { manifest: set.manifest, config: meta.assets.config || {}, message: meta.annotations?.['workers/message'] || '', address: was?.address || false, deploys: (was?.deploys || 0) + 1 });
        return ok({ id: m[1] });
      }
      if ((m = /^\/workers\/scripts\/([^/]+)\/subdomain$/.exec(path)) && method === 'POST') {
        if (!scripts.has(m[1])) return no(404, 10007, 'workers.api.error.script_not_found');
        scripts.get(m[1]).address = !!JSON.parse(init.body).enabled;
        return ok({ enabled: scripts.get(m[1]).address });
      }
      if ((m = /^\/workers\/scripts\/([^/]+)$/.exec(path)) && method === 'DELETE') {
        if (!scripts.has(m[1])) return no(404, 10007, 'workers.api.error.script_not_found');
        scripts.delete(m[1]);
        return ok(null);
      }
      return no(404, 7003, 'no route');
    },
  };
  return api;
}
