/**
 * An in-memory Cloudflare for one account's Workers that hold a site's files:
 * the three steps of "Direct Uploads" (the list, the files, the deploy), the
 * switch that gives a Worker its workers.dev address, and delete. It behaves
 * as the real service did when it was tried (2026-11-12): it keeps every file
 * it was ever sent by fingerprint, asks only for the ones it lacks, takes the
 * site's _headers and _redirects text as settings, and switches to a new set
 * of files only at the deploy.
 *
 * It also holds the account's zones, for a site on its owner's own domain
 * (worker/domain.js): making a zone (it waits, with two name servers), the
 * scan that copies records in (a set each test chooses, every one that can be
 * proxied arriving proxied), reading, adding, changing and deleting records,
 * attaching a name to a Worker (refused with 100117 while an A, AAAA or CNAME
 * record is at the name, as the real service refused it), the one call that
 * makes many changes to records at once (all or nothing), the activation
 * check, the redirect rule, the "always use HTTPS" switch, and the export. A
 * zone that is gone is answered with HTTP 400 and error 1001, as the real
 * service answered. Two things here were not tried against the real
 * service and are a best guess: the codes a zone is refused with (a test sets
 * them), and whether deleting a zone detaches its names (here it does not, so
 * the code under test has to).
 *
 * And it forwards email for a zone (worker/domain-mail.js), as the real
 * service did when it was tried (2026-11-13): a zone's forwarding is off and
 * "unconfigured" until the one call that switches it on, which writes three
 * mail servers and a signing key marked `meta.email_routing`, and an SPF note
 * beside them; the account keeps one list of inboxes, each not verified
 * until a test says its owner pressed the button (`confirm`); and a rule that
 * forwards to an inbox that is not verified is refused with code 2054. Every
 * zone has the built-in catch-all rule, off. Not tried against the real
 * service, and a best guess here: asking for one inbox by its id, how an
 * inbox it already has is refused, replacing a rule, and what is answered
 * for a rule or an inbox that is gone (here a plain 404).
 *
 * `fakeLookups` at the end stands in for the registry (RDAP) and the public
 * DNS over HTTPS. Not a test file.
 */
const jsonRes = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
const ok = (result, status = 200) => jsonRes({ success: true, errors: [], messages: [], result }, status);
const no = (status, code, message) => jsonRes({ success: false, errors: [{ code, message }], result: null }, status);

export function fakeCloudflare({ account = 'acct-hosting', token = 'cf-token', bucketSize = 2 } = {}) {
  const stored = new Map();      // fingerprint → { type, bytes }
  const sessions = new Map();    // session token → { script, manifest, need:Set }
  const complete = new Map();    // completion token → { script, manifest }
  const scripts = new Map();     // name → { manifest, config, message, address:boolean, deploys }
  const zones = new Map();       // zone id → { id, name, status, name_servers, records: Map(record id → record), checks }
  const workerDomains = new Map();   // id → { id, hostname, service, zone_id, environment, cert_id }
  const scans = new Map();       // domain → the records a scan finds there
  const refusals = new Map();    // domain → { status, code, message }: Cloudflare will not make this zone
  const addresses = new Map();   // email → { id, tag, email, verified, created, modified }: the inboxes the account may forward to
  const confirmations = [];      // every inbox Cloudflare "sent" its email with the button to, in order
  const calls = [];
  let fail = null;
  let n = 0;
  const api = {
    account, token, stored, scripts, calls, zones, workerDomains, addresses, confirmations,
    /** The owner of an inbox pressed the button in Cloudflare's email. */
    confirm: (email) => { const a = addresses.get(email); a.verified = new Date().toISOString(); a.modified = a.verified; },
    /** The forwarding rules of a zone, without the built-in catch-all. */
    rulesOf: (name) => [...(api.zoneOf(name)?.mail?.rules.values() || [])].filter(r => r.matchers?.[0]?.type !== 'all'),
    failOn: (fn) => { fail = fn; },
    /** A Worker that is up, for a test that needs one and does not copy any files. */
    addScript: (name) => { scripts.set(name, { manifest: {}, config: {}, message: '', address: true, deploys: 1 }); },
    /** What a scan finds at a domain: [{ type, name, content, priority? }]. */
    scanFinds: (name, records) => { scans.set(name, records); },
    refuseZone: (name, code, message, status = 400) => { refusals.set(name, { status, code, message }); },
    zoneOf: (name) => [...zones.values()].find(z => z.name === name) || null,
    /** A zone's records as they stand, the ones a Worker's name brought with it included. */
    recordsOf: (name) => [...(api.zoneOf(name)?.records.values() || [])],
    /** What Cloudflare has seen of the name servers: 'pending', 'active', 'moved', 'deleted'. */
    setStatus: (name, status) => { const z = api.zoneOf(name); z.status = status; z.activated_on = status === 'active' ? new Date().toISOString() : z.activated_on; },
    /** What a visitor gets at a path of a deployed site, or null. */
    serve: (name, path) => { const s = scripts.get(name); const f = s?.manifest[path]; return f ? stored.get(f.hash) : null; },
    /**
     * What a visitor gets for a request to a deployed site, with the site's
     * program run where Cloudflare would run it: first, for an address one of
     * its `run_worker_first` rules matches (the address as it was written),
     * and otherwise not at all, the file being served as it is. The file
     * server decodes the address before it looks for the file, as the real
     * one does. `ran` counts how often the program ran.
     */
    visit: async (name, request) => {
      const s = scripts.get(name);
      if (!s) return new Response('There is nothing here yet!', { status: 404 });
      const assets = {
        fetch: async (req) => {
          let path; try { path = decodeURIComponent(new URL(req.url).pathname); } catch { return new Response('Bad Request', { status: 400 }); }
          const f = s.manifest[path] || s.manifest[`${path}.html`] || (path.endsWith('/') ? s.manifest[`${path}index.html`] : null);
          if (!f) return new Response('Not Found', { status: 404 });
          const kept = stored.get(f.hash);
          return new Response(kept && kept.bytes !== undefined ? kept.bytes : kept, { status: 200, headers: { 'Cache-Control': 'public, max-age=0, must-revalidate' } });
        },
      };
      const rules = s.config.run_worker_first;
      const path = new URL(request.url).pathname;
      const hit = (rule) => new RegExp(`^${rule.split('*').map(x => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(path);
      const first = s.module && (rules === true || (Array.isArray(rules) && !rules.some(r => r.startsWith('!') && hit(r.slice(1))) && rules.some(r => !r.startsWith('!') && hit(r))));
      if (!first) return assets.fetch(request);
      s.ran = (s.ran || 0) + 1;
      const program = await import(`data:text/javascript;base64,${Buffer.from(s.module).toString('base64')}`);
      const env = {};
      for (const b of s.bindings) env[b.name] = b.type === 'assets' ? assets : b.text;
      return program.default.fetch(request, env);
    },
    handler: async (url, init = {}) => {
      const root = 'https://api.cloudflare.com/client/v4';
      const base = `${root}/accounts/${account}`;
      const inAccount = url.startsWith(base);
      if (!inAccount && !url.startsWith(`${root}/zones`)) return undefined;
      const method = (init.method || 'GET').toUpperCase();
      const [path, query = ''] = url.slice(inAccount ? base.length : root.length).split('?');
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
        // A Worker with a program: the metadata names its main module, and the
        // module comes as a file part of that name, typed as an ES module.
        let module = null;
        if (meta.main_module !== undefined) {
          const part = init.body.get(meta.main_module);
          if (!part || typeof part === 'string') return no(400, 10021, `no such module: ${meta.main_module}`);
          if (!/^(application|text)\/javascript\+module$/.test(part.type)) return no(400, 10021, `the main module is not typed as an ES module: ${part.type}`);
          module = await part.text();
        }
        const first = meta.assets.config?.run_worker_first;
        if (first !== undefined && typeof first !== 'boolean') {
          const rules = Array.isArray(first) ? first : null;
          if (!rules || rules.length > 100 || !rules.every(r => typeof r === 'string' && /^!?\//.test(r)) || !rules.some(r => !r.startsWith('!'))) {
            return no(400, 10021, 'run_worker_first: rules must start with / or !/, and at least one must not be negative');
          }
        }
        if (first && !module) return no(400, 10021, 'run_worker_first needs a Worker script');
        const bindings = meta.bindings || [];
        if (bindings.some(b => !b.name || !b.type || ((b.type === 'plain_text' || b.type === 'secret_text') && typeof b.text !== 'string'))) return no(400, 10021, 'a binding is not complete');
        const was = scripts.get(m[1]);
        scripts.set(m[1], {
          manifest: set.manifest, config: meta.assets.config || {}, message: meta.annotations?.['workers/message'] || '', address: was?.address || false, deploys: (was?.deploys || 0) + 1,
          meta, parts: [...init.body.keys()], module, bindings,
        });
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
      // ─── Zones, their records, and the names attached to Workers ───────────
      const asked = new URLSearchParams(query);
      const zoneView = (z) => ({ id: z.id, name: z.name, status: z.status, type: 'full', name_servers: z.name_servers, original_name_servers: z.original_name_servers, original_registrar: z.original_registrar, activated_on: z.activated_on, plan: { name: 'Free Website' } });
      const proxiable = (type) => ['A', 'AAAA', 'CNAME'].includes(type);
      const addRecord = (z, r, extra = {}) => {
        const rec = { id: `rec-${++n}`, type: r.type, name: r.name, content: r.content, ttl: r.ttl || 1, proxiable: proxiable(r.type), proxied: proxiable(r.type) ? !!r.proxied : false, ...(r.priority !== undefined ? { priority: r.priority } : {}), ...extra };
        z.records.set(rec.id, rec);
        return rec;
      };
      if (!inAccount || path.startsWith('/workers/domains')) { if (auth !== token) return no(403, 10000, 'Authentication error'); }
      if (!inAccount && path === '/zones' && method === 'POST') {
        const b = JSON.parse(init.body);
        if (b.account?.id !== account || b.type !== 'full') return no(400, 1003, 'a zone needs this account and type "full"');
        const refused = refusals.get(b.name);
        if (refused) return no(refused.status, refused.code, refused.message);
        if (api.zoneOf(b.name)) return no(400, 1061, `${b.name} already exists`);
        const id = `zone${String(++n).padStart(4, '0')}`;
        const z = { id, name: b.name, status: 'pending', name_servers: [`ada${n}.ns.cloudflare.com`, `bob${n}.ns.cloudflare.com`], original_name_servers: ['ns1.old-host.example', 'ns2.old-host.example'], original_registrar: 'godaddy.com, llc (id: 146)', activated_on: null, records: new Map(), checks: 0, batches: 0, settings: {}, redirects: [] };
        zones.set(id, z);
        return ok(zoneView(z));
      }
      if (!inAccount && (m = /^\/zones\/([^/]+)(\/.*)?$/.exec(path))) {
        const z = zones.get(m[1]);
        if (!z) return no(400, 1001, 'Invalid zone identifier');   // not a 404: what the real service answered for a zone that was deleted
        const rest = m[2] || '';
        let r;
        if (rest === '' && method === 'GET') return ok(zoneView(z));
        if (rest === '' && method === 'DELETE') { zones.delete(z.id); return ok({ id: z.id }); }
        if (rest === '/activation_check' && method === 'PUT') { z.checks++; return ok({ id: z.id }); }
        if (rest === '/dnssec' && method === 'GET') return ok({ status: 'disabled' });
        // ─── Email forwarding for the zone ───────────────────────────────────
        if (rest.startsWith('/email/routing')) {
          const catchAll = { id: `rule-all-${z.id}`, tag: `rule-all-${z.id}`, name: '', enabled: false, priority: 2147483647, matchers: [{ type: 'all' }], actions: [{ type: 'drop' }] };
          const mail = (z.mail ||= { enabled: false, status: 'unconfigured', rules: new Map([[catchAll.id, catchAll]]) });
          const mailView = () => ({ id: `mail-${z.id}`, tag: `mail-${z.id}`, name: z.name, enabled: mail.enabled, status: mail.status, skip_wizard: true });
          // Cloudflare will not forward to an inbox whose owner has not pressed the button.
          const unverified = (b) => (b.actions || []).filter(a => a.type === 'forward').flatMap(a => a.value || []).some(e => !addresses.get(e)?.verified);
          const ruleOf = (id, b) => ({ id, tag: id, name: b.name || '', enabled: b.enabled !== false, priority: b.priority || 0, matchers: b.matchers || [], actions: b.actions || [] });
          if (rest === '/email/routing' && method === 'GET') return ok(mailView());
          if (rest === '/email/routing/dns' && method === 'POST') {
            const write = (rec, extra) => { if (![...z.records.values()].some(x => x.type === rec.type && x.name === rec.name && x.content === rec.content)) addRecord(z, rec, extra); };
            const own = { meta: { email_routing: true, read_only: true } };
            [[1, 15], [2, 21], [3, 38]].forEach(([i, priority]) => write({ type: 'MX', name: z.name, content: `route${i}.mx.cloudflare.net`, priority }, own));
            write({ type: 'TXT', name: `cf2024-1._domainkey.${z.name}`, content: '"v=DKIM1; h=sha256; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A"' }, own);
            write({ type: 'TXT', name: z.name, content: '"v=spf1 include:_spf.mx.cloudflare.net ~all"' });
            mail.enabled = true; mail.status = 'ready';
            return ok(mailView());
          }
          if (rest === '/email/routing/rules' && method === 'GET') {
            const all = [...mail.rules.values()];
            return jsonRes({ success: true, errors: [], messages: [], result: all, result_info: { page: 1, per_page: Number(asked.get('per_page')) || 20, count: all.length, total_count: all.length } });
          }
          if (rest === '/email/routing/rules' && method === 'POST') {
            const b = JSON.parse(init.body);
            if (unverified(b)) return no(400, 2054, 'Destination address is not verified');
            const rule = ruleOf(`rule-${++n}`, b);
            mail.rules.set(rule.id, rule);
            return ok(rule);
          }
          if ((r = /^\/email\/routing\/rules\/([^/]+)$/.exec(rest))) {
            if (!mail.rules.has(r[1])) return no(404, 2020, 'Rule not found');
            if (method === 'PUT') {
              const b = JSON.parse(init.body);
              if (unverified(b)) return no(400, 2054, 'Destination address is not verified');
              mail.rules.set(r[1], ruleOf(r[1], b));
              return ok(mail.rules.get(r[1]));
            }
            if (method === 'DELETE') { const gone = mail.rules.get(r[1]); mail.rules.delete(r[1]); return ok(gone); }
          }
        }
        if (rest === '/dns_records/scan' && method === 'POST') {
          const found = scans.get(z.name) || [];
          const by = {};
          // The old host's catch-all came back not proxied; everything else that can be, proxied.
          for (const f of found) { addRecord(z, { ...f, proxied: !String(f.name).startsWith('*.') }); by[f.type] = (by[f.type] || 0) + 1; }
          return ok({ recs_added: found.length, recs_added_by_type: by, total_records_parsed: found.length });
        }
        if (rest === '/dns_records/export' && method === 'GET') {
          const lines = [...z.records.values()].map(x => `${x.name}.\t1\tIN\t${x.type}\t${x.type === 'MX' ? `${x.priority} ` : ''}${x.content}`);
          return new Response(`;; Domain:     ${z.name}.\n;; Exported by the stand-in\n\n${lines.join('\n')}\n`, { status: 200, headers: { 'Content-Type': 'text/plain' } });
        }
        if (rest === '/dns_records' && method === 'GET') {
          const per = Number(asked.get('per_page')) || 100, page = Number(asked.get('page')) || 1;
          const all = [...z.records.values()];
          return jsonRes({ success: true, errors: [], messages: [], result: all.slice((page - 1) * per, page * per), result_info: { page, per_page: per, count: Math.min(per, all.length), total_count: all.length, total_pages: Math.max(1, Math.ceil(all.length / per)) } });
        }
        // Why a record cannot be added to these records, or null.
        const refusePost = (records, b) => {
          if (!(b.name === z.name || String(b.name).endsWith(`.${z.name}`))) return no(400, 1004, 'the record is not in this zone');
          const at = [...records.values()].filter(x => x.name === b.name);
          if (at.some(x => x.type === b.type && x.content === b.content)) return no(400, 81058, 'An identical record already exists.');
          if (at.some(x => x.type === 'CNAME' || b.type === 'CNAME')) return no(400, 81053, 'An A, AAAA, or CNAME record with that host already exists.');
          return null;
        };
        if (rest === '/dns_records' && method === 'POST') {
          const b = JSON.parse(init.body);
          return refusePost(z.records, b) || ok(addRecord(z, b));
        }
        // Many changes in one call: deletes, then changes, then adds. All or
        // nothing, as the real service is: they are tried on a copy of the
        // records, and the copy is kept only when every one of them worked.
        if (rest === '/dns_records/batch' && method === 'POST') {
          const b = JSON.parse(init.body);
          const trial = { records: new Map([...z.records].map(([id, x]) => [id, { ...x }])) };
          const out = { deletes: [], patches: [], posts: [] };
          for (const d of b.deletes || []) {
            const rec = trial.records.get(d.id);
            if (!rec) return no(400, 81044, 'Record does not exist.');
            if (rec.meta?.origin_worker_id) return no(400, 1047, 'This record is managed by a Worker and cannot be changed here.');
            trial.records.delete(d.id);
            out.deletes.push({ id: d.id });
          }
          for (const { id, ...change } of b.patches || []) {
            const rec = trial.records.get(id);
            if (!rec) return no(400, 81044, 'Record does not exist.');
            out.patches.push(Object.assign(rec, change));
          }
          for (const p of b.posts || []) {
            const bad = refusePost(trial.records, p);
            if (bad) return bad;
            out.posts.push(addRecord(trial, p));
          }
          z.records = trial.records;
          z.batches++;
          return ok(out);
        }
        if (rest.startsWith('/ssl/certificate_packs') && method === 'GET') {
          // What the real one answers: the pack that serves, and the spare it keeps (never 'active').
          return ok([
            { type: 'universal', status: z.certificate || 'active', hosts: [z.name, `*.${z.name}`], certificate_authority: 'lets_encrypt' },
            { type: 'universal', status: 'backup_issued', hosts: [z.name, `*.${z.name}`], certificate_authority: 'google' },
          ]);
        }
        if (rest === '/settings/always_use_https' && method === 'PATCH') {
          z.settings.always_use_https = JSON.parse(init.body).value;
          return ok({ id: 'always_use_https', value: z.settings.always_use_https });
        }
        if (rest === '/rulesets/phases/http_request_dynamic_redirect/entrypoint' && method === 'PUT') {
          z.redirects = JSON.parse(init.body).rules || [];
          return ok({ id: `rules-${z.id}`, phase: 'http_request_dynamic_redirect', rules: z.redirects });
        }
        if ((r = /^\/dns_records\/([^/]+)$/.exec(rest))) {
          const rec = z.records.get(r[1]);
          if (!rec) return no(404, 81044, 'Record does not exist.');
          if (rec.meta?.origin_worker_id) return no(400, 1047, 'This record is managed by a Worker and cannot be changed here.');
          if (method === 'PATCH') { Object.assign(rec, JSON.parse(init.body)); return ok(rec); }
          if (method === 'DELETE') { z.records.delete(rec.id); return ok({ id: rec.id }); }
        }
      }
      // ─── The inboxes the account may forward to ────────────────────────────
      if (inAccount && (m = /^\/email\/routing\/addresses(?:\/([^/]+))?$/.exec(path))) {
        if (auth !== token) return no(403, 10000, 'Authentication error');
        if (!m[1] && method === 'GET') {
          const per = Number(asked.get('per_page')) || 20, page = Number(asked.get('page')) || 1;
          const all = [...addresses.values()];
          const shown = all.slice((page - 1) * per, page * per);
          return jsonRes({ success: true, errors: [], messages: [], result: shown, result_info: { page, per_page: per, count: shown.length, total_count: all.length } });
        }
        if (!m[1] && method === 'POST') {
          const { email } = JSON.parse(init.body);
          if (addresses.has(email)) return no(409, 2000, 'Destination address already exists');
          const at = new Date().toISOString();
          // `remembers`: a Cloudflare that takes an inbox it once confirmed as confirmed again, and writes it no email.
          const known = api.remembers && api.remembers.has(email);
          const a = { id: `addr-${++n}`, email, verified: known ? at : null, created: at, modified: at };
          a.tag = a.id;
          addresses.set(email, a);
          if (!known) confirmations.push(email);
          return ok(a);
        }
        const a = [...addresses.values()].find(x => x.id === m[1]);
        if (!a) return no(404, 2032, 'Destination address not found');
        if (method === 'GET') return ok(a);
        if (method === 'DELETE') { addresses.delete(a.email); return ok(a); }
      }
      if (inAccount && path === '/workers/domains' && method === 'PUT') {
        const b = JSON.parse(init.body);
        const z = zones.get(b.zone_id);
        if (!z || !(b.hostname === z.name || String(b.hostname).endsWith(`.${z.name}`))) return no(400, 100114, 'the hostname is not in that zone');
        if (!scripts.has(b.service)) return no(404, 10007, 'workers.api.error.script_not_found');
        if ([...z.records.values()].some(x => x.name === b.hostname && proxiable(x.type) && !x.meta?.origin_worker_id)) {
          return no(409, 100117, 'Hostname already has externally managed DNS records (A, CNAME, etc). Either delete them, try a different hostname, or use the option "override_existing_dns_record" to override.');
        }
        let d = [...workerDomains.values()].find(x => x.hostname === b.hostname);
        if (!d) {
          d = { id: `wd-${++n}`, hostname: b.hostname, service: b.service, zone_id: z.id, zone_name: z.name, environment: b.environment, cert_id: `cert-${n}` };
          workerDomains.set(d.id, d);
          addRecord(z, { type: 'AAAA', name: b.hostname, content: '100::', proxied: true }, { meta: { origin_worker_id: d.id }, read_only: true });
        }
        d.service = b.service;
        return ok(d);
      }
      if (inAccount && path === '/workers/domains' && method === 'GET') {
        return ok([...workerDomains.values()].filter(d => !asked.get('zone_id') || d.zone_id === asked.get('zone_id')));
      }
      if (inAccount && (m = /^\/workers\/domains\/([^/]+)$/.exec(path)) && method === 'DELETE') {
        const d = workerDomains.get(m[1]);
        if (!d) return no(404, 100116, 'the domain is not attached');
        workerDomains.delete(d.id);
        const z = zones.get(d.zone_id);
        if (z) for (const x of [...z.records.values()]) if (x.meta?.origin_worker_id === d.id) z.records.delete(x.id);
        return new Response(null, { status: 204 });
      }
      return no(404, 7003, 'no route');
    },
  };
  return api;
}

/**
 * The registry (RDAP) and the public DNS over HTTPS, for worker/domain.js's
 * lookUp. `domains` is what the world knows of each domain:
 *
 *   { 'oakbakery.test': { seller: { name, id }, nameServers: [...], dnssec: false,
 *                         dns: [{ name, type, data, then? }] } }
 *
 * `dns` holds records as the public DNS words them (`data`: an MX record's
 * "10 mail.host.", a TXT record's quoted pieces). A CNAME record's `then` is
 * what is at the name it points to, which the public DNS adds to its answer
 * under that other name. `rdap: false` is a domain the registry cannot be
 * asked about, and `registered: false` one it answers "not found" for (as it
 * does for a domain that is not listed here at all, which is a name nobody
 * has bought). `down` switches a whole service off: { rdap: true, dns: true }.
 */
export function fakeLookups(domains = {}, down = {}) {
  const NUMBER = { A: 1, NS: 2, CNAME: 5, MX: 15, TXT: 16, AAAA: 28, DS: 43 };
  const calls = [];
  const agents = [];   // the user-agent each question came with
  const handler = async (url, init = {}) => {
    if (url.startsWith('https://rdap.org/domain/')) {
      calls.push({ url, accept: init.headers?.accept || '', redirect: init.redirect || '' });
      agents.push(init.headers?.['user-agent'] || '');
      if (down.rdap) throw new TypeError('fetch failed');
      // The real rdap.org answers 403 to a question that names no user agent, and a Worker names none by itself.
      if (!init.headers?.['user-agent']) return new Response('Forbidden', { status: 403 });
      const name = url.slice('https://rdap.org/domain/'.length).toLowerCase();
      const d = domains[name];
      if (d && d.rdap === false) return jsonRes({ errorCode: 503, title: 'Service Unavailable' }, 503);
      if (!d || d.registered === false) return jsonRes({ errorCode: 404, title: 'Not Found' }, 404);
      // rdap.org answers with a redirect to the registry's own server. A fetch
      // that follows redirects hands back that server's answer, which is this.
      return jsonRes({
        objectClassName: 'domain', ldhName: name.toUpperCase(),
        nameservers: (d.nameServers || []).map(ns => ({ objectClassName: 'nameserver', ldhName: ns.toUpperCase() })),
        ...(d.dnssec === undefined ? {} : { secureDNS: { delegationSigned: d.dnssec } }),
        entities: d.seller ? [{ objectClassName: 'entity', roles: ['registrar'], publicIds: d.seller.id ? [{ type: 'IANA Registrar ID', identifier: String(d.seller.id) }] : [], vcardArray: ['vcard', [['version', {}, 'text', '4.0'], ['fn', {}, 'text', d.seller.name]]] }] : [],
      });
    }
    if (url.startsWith('https://cloudflare-dns.com/dns-query?')) {
      calls.push({ url, accept: init.headers?.accept || '', redirect: init.redirect || '' });
      agents.push(init.headers?.['user-agent'] || '');
      if (down.dns) return new Response('bad gateway', { status: 502 });
      const q = new URL(url).searchParams;
      const name = String(q.get('name')).toLowerCase(), type = q.get('type');
      const zone = Object.keys(domains).find(z => name === z || name.endsWith(`.${z}`));
      const at = zone ? (domains[zone].dns || []).filter(r => r.name === name) : [];
      if (!at.length) return jsonRes({ Status: zone && name === zone ? 0 : 3 });
      const answer = (r) => ({ name: `${r.name}.`, type: NUMBER[r.type], TTL: 300, data: r.data });
      const cname = at.find(r => r.type === 'CNAME');
      if (cname && type !== 'CNAME') return jsonRes({ Status: 0, Answer: [answer(cname), ...(cname.then || []).filter(r => r.type === type).map(answer)] });
      return jsonRes({ Status: 0, Answer: at.filter(r => r.type === type).map(answer) });
    }
    return undefined;
  };
  return { calls, agents, handler, fetchImpl: async (url, init) => (await handler(url, init)) || new Response('not found', { status: 404 }) };
}
