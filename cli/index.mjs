#!/usr/bin/env node
/**
 * kiln — setup wizard + doctor.
 *
 *   npx github:kilncms/kiln#release            interactive setup in your site directory
 *   npx github:kilncms/kiln#release doctor     verify an existing Kiln installation
 *   npx github:kilncms/kiln#release update     refresh the on-page editor to the latest
 *   npx github:kilncms/kiln#release add-site   add this site to Kiln Cloud (hosted tier)
 *   npx github:kilncms/kiln#release rescue <url>  copy your builder-hosted site to clean, Kiln-ready static HTML
 *   npx github:kilncms/kiln#release rescue <url> --render   the same for a site drawn by JavaScript (Lovable, v0, Bolt)
 *   npx github:kilncms/kiln#release new [dir]  start a fresh site from a template repo (default: the Kiln demo)
 *
 * The wizard automates everything that CAN be automated (repo, worker, KV,
 * origins, secrets, wiring) and for the three steps platforms require a human
 * click on (GitHub App create, App install, Cloudflare Connect-to-Git) it
 * opens the right page and WAITS, verifying each click before moving on.
 */
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Kiln relies on global fetch and crypto.getRandomValues (Node 18+) and is only
// tested on Node 20+. Fail fast with a clear message instead of a confusing
// ReferenceError halfway through setup.
const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
if (NODE_MAJOR < 20) {
  console.error(`\n  kiln needs Node 20 or newer — you're running Node ${process.version}.`);
  console.error('  Upgrade at https://nodejs.org (or: nvm install 20) and re-run.\n');
  process.exit(1);
}

// In the git checkout the assets (dist/, worker/, templates/, src/) live one
// level up; in the published create-kiln package they are vendored next to
// this file by prepack.mjs. Prefer the vendored copies when present.
const CLI_DIR = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = existsSync(path.join(CLI_DIR, 'dist', 'kiln.js')) ? CLI_DIR : path.resolve(CLI_DIR, '..');
const rl = createInterface({ input: process.stdin, output: process.stdout });
// If input ends while a question is waiting (no terminal, a pipe that ran
// dry), nothing more can be decided: say so and exit 1. Left alone, Node would
// exit 0 with the work half done, and a script would read that as success.
let waitingForAnswer = false;
let inputEnded = false;
const inputGone = () => {
  console.error('\n  ❌ Input ended while Kiln was waiting for an answer. Run it in a terminal, or see: npx github:kilncms/kiln#release --help');
  process.exit(1);
};
rl.on('close', () => { inputEnded = true; if (waitingForAnswer) inputGone(); });
const ask = async (q, dflt) => {
  if (inputEnded) inputGone();
  waitingForAnswer = true;
  const a = (await rl.question(`${q}${dflt !== undefined ? ` [${dflt}]` : ''}: `)).trim();
  waitingForAnswer = false;
  return a || dflt || '';
};
const yes = async (q, dflt = 'y') => /^y/i.test(await ask(`${q} (y/n)`, dflt));
const ok = (s) => console.log(`  ✅ ${s}`);
const info = (s) => console.log(`  ▸ ${s}`);
const warn = (s) => console.log(`  ⚠️  ${s}`);
const fail = (s) => console.log(`  ❌ ${s}`);
const hr = (s) => console.log(`\n━━ ${s} ${'━'.repeat(Math.max(2, 56 - s.length))}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function sh(cmd, opts = {}) {
  // execSync returns null with stdio:'inherit' — optional-chain so show:true doesn't throw on success
  return execSync(cmd, { encoding: 'utf8', stdio: opts.show ? 'inherit' : 'pipe', cwd: opts.cwd })?.toString?.() ?? '';
}
function shTry(cmd, opts = {}) {
  try { return { ok: true, out: sh(cmd, opts) }; } catch (e) { return { ok: false, out: String(e.stdout || e.message) }; }
}
function openUrl(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open';
  shTry(`${cmd} "${url}"`);
  info(`If your browser didn't open: ${url}`);
}
async function pollUntil(label, fn, intervalMs = 4000, timeoutMs = 30 * 60 * 1000) {
  process.stdout.write(`  ⏳ ${label} `);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn().catch(() => false)) { console.log('— done ✅'); return true; }
    process.stdout.write('.');
    await sleep(intervalMs);
  }
  console.log('— timed out');
  return false;
}
async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  return { status: res.status, headers: res.headers, json: await res.json().catch(() => ({})) };
}
/** Create the KILN KV namespace (or find it on a re-run) and return its id. Exits on failure. */
function kvNamespaceId(workerDir) {
  const kv = shTry('npx wrangler kv namespace create KILN', { cwd: workerDir });
  let kvId = kv.out.match(/id = "([a-f0-9]{32})"/)?.[1];
  if (!kvId && /already exists/i.test(kv.out)) {
    // Re-run: the namespace exists, so `create` printed no id. Look it up rather
    // than writing id = "null" into wrangler.toml (which breaks the next deploy).
    const list = shTry('npx wrangler kv namespace list', { cwd: workerDir });
    try {
      // wrangler may print a banner/update-notice before the JSON — parse from the first '['
      const entry = JSON.parse(list.out.slice(list.out.indexOf('['))).find(n => /(^|_)KILN$/.test(n.title) || n.title === 'KILN');
      kvId = entry?.id;
    } catch { /* fall through to the error below */ }
  }
  if (!kvId) { fail(`Couldn't determine the KILN KV namespace id:\n${kv.out}`); process.exit(1); }
  return kvId;
}

// ─── source mode: local-tree detection (SOURCE-MODE-SPEC §7) ─────────────────

const OUTPUT_DIRS = ['dist', '_site', 'build', 'out'];

/** Shallow local file listing for generator detection (§7.1): forward-slash
 *  relative paths, directories at most three levels deep, with dependency/VCS
 *  dirs skipped. Build-output dirs are skipped in the LISTING but noted
 *  separately: `builtHtml` is the first committed .html found under a
 *  root-level output dir — the raw material for the §7.3 guard. */
function listLocalTree(root = '.', maxDepth = 3) {
  const files = [];
  let builtHtml = null;
  const SKIP = new Set(['node_modules', '.git', '.astro', '.cache', ...OUTPUT_DIRS]);
  (function walk(dir, rel, depth) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP.has(e.name)) {
          if (!rel && OUTPUT_DIRS.includes(e.name) && !builtHtml) {
            try {
              const html = readdirSync(path.join(dir, e.name)).find(f => /\.html?$/i.test(f));
              if (html) builtHtml = `${e.name}/${html}`;
            } catch { /* unreadable output dir — no signal */ }
          }
          continue;
        }
        if (depth < maxDepth) walk(path.join(dir, e.name), r, depth + 1);
      } else files.push(r);
    }
  })(root, '', 0);
  return { files, builtHtml };
}

/** What the detection saw, in the customer's language: the config file that
 *  gave the generator away plus a content-file count ("Found astro.config.mjs
 *  and 63 content files"). */
function detectionEvidence(files) {
  const cfg = files.find(f => /^((astro|eleventy)\.config\.[cm]?[jt]s|\.eleventy\.js|(config|hugo)\.(toml|ya?ml|json)|_config\.ya?ml)$/i.test(f));
  const content = files.filter(f => /\.(md|mdx|markdown)$/i.test(f)).length;
  const bits = [];
  if (cfg) bits.push(cfg);
  if (content) bits.push(`${content} content file${content === 1 ? '' : 's'}`);
  return bits.join(' and ');
}

/** Print the §7.3 warning — the guard against editing regenerated output. */
function warnBuiltOutput(builtHtml, generatorName) {
  warn(`Kiln can see ${builtHtml}, but this site is built by ${generatorName} — that file is`);
  console.log(`     regenerated on every build, and any edit to it would be erased the next time`);
  console.log(`     the site publishes. To let editors change the content this site is built`);
  console.log(`     from, switch to source mode (re-run this wizard, or set mode: 'source' in`);
  console.log(`     assets/kiln-config.js).`);
}

/** Wizard detection step (§7.1–§7.2). Looks at the local tree; when it looks
 *  generator-built AND Kiln has an adapter for that generator, asks the mode
 *  question in the customer's language. Returns { mode: 'html' } or
 *  { mode: 'source', adapter, generator, hints }. */
async function detectSiteMode() {
  let detectGenerators;
  try {
    ({ detectGenerators } = await import(pathToFileURL(path.join(PKG_ROOT, 'src', 'adapters', 'detect.js')).href));
  } catch { return { mode: 'html' }; }   // detection is best-effort — never block setup
  const { files, builtHtml } = listLocalTree();
  const detected = detectGenerators(files);
  if (!detected.length) return { mode: 'html' };

  const gen = detected[0];
  const an = /^[aeiou]/i.test(gen.displayName) ? 'an' : 'a';
  const evidence = detectionEvidence(files) || `${gen.displayName} tooling`;
  let adapter = null;
  try {
    const reg = await import(pathToFileURL(path.join(PKG_ROOT, 'src', 'adapters', 'index.js')).href);
    adapter = reg.getAdapter(gen.id);
  } catch { /* registry needs the yaml package; detection alone works without it */ }

  hr('How is this site built?');
  info(`Found ${evidence} — this looks like ${an} ${gen.displayName} site.`);
  if (!adapter) {
    warn(`Kiln can't edit ${gen.displayName} sources yet (Astro ships first) — continuing in HTML mode.`);
    if (builtHtml) warnBuiltOutput(builtHtml, gen.displayName);
    return { mode: 'html' };
  }
  console.log(`
   1. The pages are files in the repository.
      You edit the page, Kiln saves the page.
   2. The pages are generated from content files. (we think this one — we found ${gen.displayName})
      You edit the page, Kiln saves the underlying content and the site rebuilds.
      Takes about a minute.
`);
  let choice = (await ask('Choose 1 or 2', '2')).trim();
  if (!['1', '2'].includes(choice)) choice = '2';   // unrecognized input → the shown default
  if (choice === '1') {
    if (builtHtml) warnBuiltOutput(builtHtml, gen.displayName);
    return { mode: 'html' };
  }

  const hints = adapter.buildHints?.() || {};
  ok(`source mode: edits go to your content files and ${gen.displayName} rebuilds the site`);
  info('Three source-mode steps the wizard can\'t do for you:');
  console.log(`
   1. Install the provenance helper so Kiln knows where each value on a page
      lives (one line per field — the same mental model as data-cms):
        npm install @kilncms/astro
        <h3 {...kilnSource(entry, 'title')}>{entry.data.title}</h3>
        <div {...kilnBody(entry)}><Content /></div>
   2. Verify your host builds + deploys this repo on every push (Cloudflare
      Pages / Netlify / Vercel, Git-connected). In source mode a host that
      doesn't auto-deploy means nothing you save ever publishes.
   3. Make sure the host builds with Node ${hints.minNodeVersion || 18}+ (${hints.framework || gen.displayName}'s minimum —
      set it in the host's build settings or an .nvmrc). A version mismatch
      fails the build only after your first edit.
`);
  warn('source mode is new: the editor bundle AND your worker must both be current —');
  console.log('     run `npx github:kilncms/kiln#release update` on the site and redeploy your worker');
  console.log('     from this kiln version, or source fields will be locked read-only.');
  return { mode: 'source', adapter: adapter.id, generator: gen.displayName, hints, publicDir: generatorPublicDir(hints, files) };
}

/** The folder a generator copies into the built site as it is: Astro's
 *  public/, unless astro.config names another with a plain `publicDir: '…'`.
 *  Kiln's own files have to be there, or the build leaves them behind.
 *  '' when the generator has no such folder. */
function generatorPublicDir(hints, files) {
  const usual = hints.publicDir || '';
  if (!usual) return '';
  const cfg = files.find(f => /^astro\.config\.[cm]?[jt]s$/i.test(f));
  let src = '';
  try { if (cfg) src = readFileSync(cfg, 'utf8'); } catch { /* unreadable config: the usual folder */ }
  const named = src.match(/\bpublicDir\s*:\s*['"`](?:\.\/)?([^'"`]+?)\/?['"`]/)?.[1];
  // Only a plain folder inside the repository is taken from the config.
  return named && /^[\w.-]+(\/[\w.-]+)*$/.test(named) && !named.split('/').includes('..') ? named : usual;
}

// ─── doctor ──────────────────────────────────────────────────────────────────

async function doctor(args) {
  hr('kiln doctor');
  // Pull defaults from the local kiln-config.js when run inside a site.
  let site = args.site, repo = args.repo, worker = args.worker;
  let mode = 'html', adapterId = null;   // absent mode ⇒ html (SOURCE-MODE-SPEC §13)
  // A generated site keeps it in the folder its build publishes as it is (Astro: public/).
  const cfgPath = ['public/assets/kiln-config.js', 'assets/kiln-config.js'].find(f => existsSync(f)) || 'assets/kiln-config.js';
  const haveCfg = existsSync(cfgPath);
  if (haveCfg) {
    const src = readFileSync(cfgPath, 'utf8');
    repo ||= src.match(/repo:\s*'([^']+)'/)?.[1];
    worker ||= src.match(/worker:\s*'([^']+)'/)?.[1];
    mode = src.match(/\bmode\s*:\s*['"]([^'"]+)['"]/)?.[1] || 'html';
    adapterId = src.match(/\badapter\s*:\s*['"]([^'"]+)['"]/)?.[1] || null;
    ok(`read ${cfgPath} (repo=${repo || 'not set'}, worker=${worker || 'not set'}${mode === 'source' ? `, mode=source/${adapterId || '?'}` : ''})`);
    if (!worker) info('this site is not connected to a worker yet — run the setup wizard here first: npx github:kilncms/kiln#release');
  }
  site ||= await ask('Site URL (https://…)');
  repo ||= await ask('GitHub repo (owner/name)');
  worker ||= await ask('Worker URL (https://…workers.dev)');
  // Accept a scheme-less answer (example.com) without crashing on new URL().
  const withScheme = (u) => u && !/^https?:\/\//i.test(u) ? `https://${u}` : u;
  site = withScheme(site); worker = withScheme(worker);
  let pass = 0, total = 0;
  const check = (label, good, detail = '', optional = false) => {
    if (good) { total++; pass++; ok(`${label}${detail ? ` — ${detail}` : ''}`); }
    else if (optional) warn(`${label}${detail ? ` — ${detail}` : ''}`);
    else { total++; fail(`${label}${detail ? ` — ${detail}` : ''}`); }
  };

  const health = await fetch(`${worker}/healthz`).then(r => r.ok).catch(() => false);
  check('worker reachable (/healthz)', health);

  // The members gate is a file in the site's own repo. One from before
  // sign-ins were re-checked keeps a removed member signed in until their
  // cookie expires, which can be never.
  const gatePath = path.join('functions', 'members', '_middleware.js');
  if (existsSync(gatePath)) {
    const current = /members\/check/.test(readFileSync(gatePath, 'utf8'));
    check('members gate ends a removed member\'s sign-in', current, current
      ? 're-checks the list every 5 minutes'
      : 'this site has the old gate: a removed member stays signed in until their cookie expires. Run `npx github:kilncms/kiln#release update`, deploy, and have members sign in once more');
  }

  // Source mode (SOURCE-MODE-SPEC §13): does the local tree match the configured mode?
  if (haveCfg) {
    try {
      const { generatorSignals } = await import(pathToFileURL(path.join(PKG_ROOT, 'src', 'adapters', 'detect.js')).href);
      const { files, builtHtml } = listLocalTree();
      const sig = generatorSignals(builtHtml ? [...files, builtHtml] : files);
      const gen = sig.detected[0];
      if (mode !== 'source' && gen) {
        // §7.3 — the highest-value check in the spec: generator build + HTML mode.
        if (builtHtml) warn(`this repo looks like a generator build (${gen.displayName}), but the site is in HTML mode — Kiln can see ${builtHtml}, and that file is regenerated on every build: any edit to it is erased the next time the site publishes. Switch to source mode (mode: 'source' in kiln-config.js) to edit the content it is built from`);
        else warn(`this repo looks like a generator build (${gen.displayName}), but the site is in HTML mode — edits to generated pages don't survive a rebuild. Switch to source mode (mode: 'source' in kiln-config.js) to edit the content files it is built from`);
      }
      if (mode === 'source') {
        check('source mode configured', !!adapterId, adapterId ? `adapter: ${adapterId}` : "kiln-config.js sets mode: 'source' but no adapter — add adapter: 'astro'");
        if (!gen) warn("kiln-config.js says source mode, but this directory doesn't look generator-built — run doctor from the repo root of the generator project");
      }
    } catch { /* detection is best-effort — a missing module must never break doctor */ }
    if (mode === 'source') {
      // Capability handshake (§13): the worker must advertise source support.
      const hz = await fetch(`${worker}/healthz`).then(r => r.json()).catch(() => null);
      const modes = Array.isArray(hz?.modes) ? hz.modes : null;
      if (modes) {
        check('worker supports source mode (/healthz modes)', modes.includes('source'),
          modes.includes('source') ? `modes: ${modes.join(', ')}${Array.isArray(hz.adapters) ? '; adapters: ' + hz.adapters.join(', ') : ''}` : 'worker answers but reports no source support — redeploy it from the latest kiln');
      } else warn("worker doesn't advertise source mode — an older worker: the editor will lock content-file fields read-only until you redeploy it from the latest kiln");
    }
  }

  const status = await fetchJson(`${worker}/setup/status`).catch(() => ({ json: {} }));
  check('GitHub App registered', !!status.json.configured, status.json.slug || 'visit /setup');
  if (status.json.slug) {
    // A private app can only install on its owner account, so it can never serve a customer's repo.
    const pub = await fetch(`https://github.com/apps/${status.json.slug}`).then(r => r.ok).catch(() => false);
    check('app installable on any account (required for Kiln Cloud / inviting editors)', pub,
      pub ? '' : 'app is private — Settings → "Make this GitHub App public"', true);
  }

  if (repo) {
    const inst = await fetchJson(`${worker}/setup/install-check?repo=${repo}`).catch(() => ({ json: {} }));
    check(`App installed on ${repo}`, !!inst.json.installed, inst.json.installed ? '' : status.json.slug ? `install: https://github.com/apps/${status.json.slug}/installations/new` : 'the worker has no GitHub App yet — register it first (visit the worker\'s /setup)');
    // Rename/transfer tripwire. What a site stores in the worker is filed under
    // the repo name in its config, and GitHub keeps answering for an old name
    // only until someone else takes it. A FAILING check, not a warning:
    // everything else here can pass while the site rests on that redirect,
    // and doctor must not call that healthy.
    //
    // Two sources. GitHub itself, asked without a sign-in: it names the new
    // name, but cannot see a private repository. And the worker (one that
    // keeps repository ids says `renamed` and `reused`): it sees private
    // repositories through its App, and answers yes or no without the name.
    const follows = typeof inst.json.renamed === 'boolean';
    const carried = `Set repo to its current owner/name in ${cfgPath} and deploy. Your worker carries the people list (and a Kiln Cloud registration) over by the repository's id, so nobody has to be added again`;
    const gh = await fetchJson(`https://api.github.com/repos/${repo}`).catch(() => ({ json: {} }));
    if (gh.json.full_name) {
      const same = gh.json.full_name === repo;
      check('repo name matches GitHub', same, same ? repo
        : follows ? `GitHub answers as ${gh.json.full_name} but the config says ${repo}: the repository was renamed or moved, and the old name works only while GitHub redirects it. ${carried.replace('its current owner/name', `'${gh.json.full_name}'`)}`
        : `GitHub answers as ${gh.json.full_name} but the config says ${repo}. After a rename or transfer, editor access and Cloud registration stay tied to the OLD name: set repo to '${gh.json.full_name}' in ${cfgPath}, add your editors again in People & access, and register the site again`);
    } else if (inst.json.renamed === true) {
      check('repo name matches GitHub', false, `your worker reports that GitHub now knows this repository by another name: it was renamed or moved to another account, and the old name works only while GitHub redirects it. ${carried}`);
    }
    if (inst.json.reused === true) {
      check('repo is the repository Kiln was set up for', false, `${repo} now answers as a different repository than the one whose people are stored under this name, so your worker shows and changes that list for no one. If the first repository was renamed or moved, set repo to its current owner/name in ${cfgPath}. If it was deleted and made again, the stored list has to be cleared before a new one can start: self-hosted, run npx wrangler kv key delete "people:${repo}" --binding KILN in your worker's folder; on Kiln Cloud, write to us`);
    }
  }

  if (site) {
    const homeRes = await fetch(site).catch(() => null);
    const home = !!(homeRes && homeRes.ok);
    const homeHtml = home ? await homeRes.text().catch(() => '') : '';
    check('site is live', home);

    // kiln.js — read the real path off the page (sites vary: /assets/ vs /assets/js/).
    const kjMatch = homeHtml.match(/src="([^"]*kiln\.js)"/);
    const kjUrl = kjMatch ? new URL(kjMatch[1], site).href : `${site.replace(/\/$/, '')}/assets/kiln.js`;
    const bootText = await fetch(kjUrl).then(r => r.ok ? r.text() : null).catch(() => null);
    check('kiln.js loads', !!bootText, kjMatch ? kjMatch[1] : 'no kiln.js <script> found on the homepage');
    // The file being reachable is not the page loading it. Without the tag the
    // editor never starts: sign-in at /kiln returns to a page with no editor.
    // (An empty answer from the site says nothing either way.)
    if (homeHtml.trim()) {
      check('home page loads kiln.js', LOADS_KILN.test(homeHtml), LOADS_KILN.test(homeHtml) ? '' :
        `the home page has no <script> for kiln.js, so the editor never starts. Add before </body>: ${KILN_TAGS.join(' ')} — or run the setup wizard again and let it add them`);
    }

    // Is the deployed editor the latest? Read the build stamp off the live bundle
    // and compare it to raw dist/VERSION on GitHub. Optional check (network /
    // pinned-fork friendly) — the point is to tell a self-hoster when to run
    // `kiln update`, not to fail the health check.
    if (bootText) {
      const mine = bootText.match(/KILN_VERSION\s*=\s*["']([\w.-]+)["']/)?.[1];
      // "Latest" is what was released: the release branch points at the build
      // production runs. Until that branch exists, main stands in for it. If
      // neither answers, nothing is said: no false "update available".
      const stampOn = (branch) => fetch(`https://raw.githubusercontent.com/kilncms/kiln/${branch}/dist/VERSION`, { cache: 'no-store' })
        .then(r => r.ok ? r.text() : null).then(t => (t && /^[\w.-]{1,40}$/.test(t.trim()) ? t.trim() : null)).catch(() => null);
      const latest = await stampOn('release') || await stampOn('main');
      if (mine && latest) {
        check('editor is up to date', mine === latest,
          mine === latest ? `version ${mine}` : `you have ${mine}, latest is ${latest} — run: npx github:kilncms/kiln#release update`, true);
      }
      // The three versions that have to be told apart when something is off,
      // on one line: what this site serves, what its worker runs, what is current.
      const wh = await fetch(`${worker}/healthz`).then(r => r.json()).catch(() => null);
      const workerVer = wh ? `${wh.version || 'unknown'}${wh.build ? ` (build ${wh.build})` : ' (build not reported)'}` : 'no answer';
      info(`versions: site bundle ${mine || 'unknown'} · worker ${workerVer} · latest release ${latest || 'unknown'}`);
    }

    // Is the host actually deploying FROM the repo? A direct-upload / stale project commits
    // Kiln edits to GitHub that never appear on the live site — and it fails silently.
    if (repo && homeHtml) {
      const gh = shTry(`gh api /repos/${repo}/contents/index.html --jq .content`);
      if (gh.ok && gh.out.trim()) {
        const repoHtml = Buffer.from(gh.out.replace(/\s/g, ''), 'base64').toString('utf8').replace(/\s+/g, ' ').trim();
        const liveHtml = homeHtml.replace(/\s+/g, ' ').trim();
        check('host deploys from the repo (live homepage matches repo HEAD)', repoHtml === liveHtml,
          repoHtml === liveHtml ? '' : 'live site differs from the repo — not Git-connected / not auto-deploying? Kiln edits will not appear', true);
      }
    }

    const cors = await fetch(`${worker}/auth/refresh`, {
      method: 'OPTIONS', headers: { Origin: new URL(site).origin, 'Access-Control-Request-Method': 'POST' },
    }).then(r => r.headers.get('Access-Control-Allow-Origin')).catch(() => null);
    check('site origin allowed by worker (CORS)', cors === new URL(site).origin,
      cors ? '' : 'add it to ALLOWED_ORIGINS in wrangler.toml + redeploy');
    const gate = await fetch(`${site.replace(/\/$/, '')}/members/`, { redirect: 'manual' })
      .then(r => r.status).catch(() => 0);
    if (gate === 503) check('members area', false, 'functions present but secrets missing');
    else check('members area', gate === 302, gate === 302 ? 'gated ✓' : 'not set up', gate !== 302);
  }

  // 503 = the worker answered and has no Google client. A worker that did not
  // answer at all (status 0) says nothing either way — never report that as
  // "configured".
  const google = await fetch(`${worker}/google/login`, { redirect: 'manual' }).then(r => r.status).catch(() => 0);
  if (google === 0) warn('Google sign-in — could not check (the worker did not answer)');
  else check('Google sign-in', google !== 503, google === 503 ? 'not configured — set GOOGLE_CLIENT_ID/SECRET' : 'configured', true);

  // OAuth callbacks can't be read back via any API, and they break silently when the worker
  // domain changes (custom domain added, app/repo transferred). Remind the user to verify them.
  info('verify these OAuth callbacks are registered (they drop silently on a domain/worker change):');
  console.log(`      GitHub App          → ${worker}/auth/callback`);
  console.log(`      Google OAuth client → ${worker}/google/callback`);

  console.log(`\n  ${pass}/${total} checks passed${pass === total ? ' — Kiln is healthy 🔥' : ''}\n`);
  process.exit(pass === total ? 0 : 1);
}

// ─── the self-hosted worker's files ──────────────────────────────────────────

/** The worker's code as the self-host wizard lays it out in kiln-worker/. The
 *  worker is several modules: worker/index.js imports ./cloud.js (which imports
 *  ./runbook.js), ./sanitize-guard.js, ./source.js, ../src/engine.js,
 *  ../src/file-policy.js and ../src/adapters/. The folder mirrors this
 *  repository's layout so every relative import still resolves. One list, for
 *  the wizard that first writes them and for `update --worker` that replaces
 *  them (test/cli-update-worker.test.js follows the imports and fails if a
 *  file the worker needs is missing from it). */
const WORKER_FILES = [
  ...['index.js', 'cloud.js', 'runbook.js', 'sanitize-guard.js', 'source.js'].map(f => ['worker', f]),
  ['src', 'engine.js'],
  ['src', 'file-policy.js'],
  ...['astro.js', 'detect.js', 'index.js', 'pointer.js', 'yaml-splice.js'].map(f => ['src', 'adapters', f]),
];
/** What the worker's own package.json must list for wrangler to bundle it. */
const WORKER_DEPS = { parse5: '^8.0.0', yaml: '^2.0.0' };

/** Add any dependency the worker needs and its package.json lacks. Never removes or changes one. */
function mergeWorkerDeps(workerDir) {
  const pjPath = path.join(workerDir, 'package.json');
  if (!existsSync(pjPath)) {
    writeFileSync(pjPath, JSON.stringify({ name: 'kiln-worker', private: true, type: 'module', dependencies: WORKER_DEPS }, null, 2) + '\n');
    return Object.keys(WORKER_DEPS);
  }
  try {
    const pj = JSON.parse(readFileSync(pjPath, 'utf8'));
    const missing = Object.keys(WORKER_DEPS).filter(d => !pj.dependencies?.[d]);
    if (missing.length) {
      pj.dependencies = { ...pj.dependencies, ...Object.fromEntries(missing.map(d => [d, WORKER_DEPS[d]])) };
      writeFileSync(pjPath, JSON.stringify(pj, null, 2) + '\n');
    }
    return missing;
  } catch {
    warn(`${workerDir}/package.json is not valid JSON — add ${Object.entries(WORKER_DEPS).map(([d, v]) => `"${d}": "${v}"`).join(' and ')} to its dependencies yourself`);
    return [];
  }
}

/** Make sure the worker's dependencies are installed where wrangler looks for them. False if they could not be. */
function installWorkerDeps(workerDir) {
  if (Object.keys(WORKER_DEPS).every(d => existsSync(path.join(workerDir, 'node_modules', d)))) return true;
  info(`installing the worker's npm dependencies (${Object.keys(WORKER_DEPS).join(', ')})…`);
  const inst = shTry('npm install --no-audit --no-fund', { cwd: workerDir });
  if (inst.ok) return true;
  // Offline / npm-broken fallback: reuse the copies shipped with this kiln checkout.
  try {
    for (const m of ['parse5', 'entities', 'yaml']) {   // entities = parse5's only dependency
      cpSync(path.join(PKG_ROOT, 'node_modules', m), path.join(workerDir, 'node_modules', m), { recursive: true });
    }
    info('npm install failed — reused parse5 + yaml from the kiln package itself');
    return true;
  } catch {
    fail(`npm install failed in ${workerDir}/ — run it there yourself, then run this again:\n${inst.out}`);
    return false;
  }
}

// ─── wizard ──────────────────────────────────────────────────────────────────

/** Commit and push ONLY the files Kiln itself created/modified. Never `git add -A`:
 *  a stray .env or key file in the site dir must not end up in a (possibly public)
 *  repo just because the user said yes to "commit the Kiln wiring". */
function commitAndPush(files, message) {
  const paths = [...new Set(files)].filter(f => existsSync(f));
  if (!paths.length) { info('nothing to commit'); return; }
  const add = spawnSync('git', ['add', '--', ...paths], { encoding: 'utf8' });
  if (add.status !== 0) { warn(`git add failed — commit & push manually:\n${add.stderr || add.stdout}`); return; }
  // Copies may be byte-identical to what's already committed (re-run) — that's fine.
  const staged = spawnSync('git', ['diff', '--cached', '--quiet'], { encoding: 'utf8' });
  if (staged.status !== 0) {
    const c = spawnSync('git', ['commit', '-m', message], { encoding: 'utf8' });
    if (c.status !== 0) { warn(`couldn't commit automatically — commit & push manually:\n${c.stderr || c.stdout}`); return; }
  } else info('Kiln files already committed — pushing');
  const p = spawnSync('git', ['push'], { encoding: 'utf8' });
  if (p.status === 0) ok('pushed');
  else warn(`couldn't push automatically — push manually:\n${p.stderr || p.stdout}`);
}

/** Copy the bundle, write config + entry page, and check the scripts are wired.
 *  Shared by self-host and Cloud modes (they differ only in the worker URL).
 *  `siteMode` comes from detectSiteMode(); source mode adds mode/adapter lines
 *  to the generated config (absent mode ⇒ html, SOURCE-MODE-SPEC §13), and
 *  puts every file in the folder the generator publishes as it is (Astro:
 *  public/), because a build leaves the top of the repository behind.
 *  Returns the list of files it created/updated (for the scoped commit). */
function wireSite(repo, workerUrl, siteMode = null) {
  const isSource = siteMode?.mode === 'source';
  const base = (isSource && siteMode.publicDir) || '';
  const at = (...parts) => path.join(base, ...parts);
  const shown = (name) => (base ? `${base}/${name}` : name);   // as a person reads it, forward slashes
  const wrote = [];
  if (base) info(`${siteMode.generator} copies ${base}/ into the built site as it is, so Kiln's files go there: the editor is served from /assets/ and the sign-in page at /kiln.`);
  mkdirSync(at('assets'), { recursive: true });
  for (const f of ['kiln.js', 'kiln-editor.js', 'kiln-features.js']) {
    cpSync(path.join(PKG_ROOT, 'dist', f), at('assets', f));
    wrote.push(at('assets', f));
  }
  ok(`copied kiln.js + kiln-editor.js + kiln-features.js into ${shown('assets/')}`);
  const cfgFile = at('assets', 'kiln-config.js');
  // A run of the wizard from before it knew about the public folder left the
  // settings at the top of the repository. Carry them over; never lose them.
  const stray = base && existsSync(path.join('assets', 'kiln-config.js'));
  if (stray && !existsSync(cfgFile)) {
    cpSync(path.join('assets', 'kiln-config.js'), cfgFile);
    wrote.push(cfgFile);
    ok(`copied your settings from assets/kiln-config.js to ${shown('assets/kiln-config.js')}`);
  }
  if (!existsSync(cfgFile)) {
    wrote.push(cfgFile);
    writeFileSync(cfgFile, `window.KILN = {
  repo:   '${repo}',
  branch: 'main',
  worker: '${workerUrl}',
${isSource ? `  mode:   'source',\n  adapter: '${siteMode.adapter}',\n` : ''}  styles: [],
};
`);
    ok(`wrote ${shown('assets/kiln-config.js')}${isSource ? ` (mode: 'source', adapter: '${siteMode.adapter}')` : ''}`);
  } else {
    if (!wrote.includes(cfgFile)) ok(`${shown('assets/kiln-config.js')} already present (left untouched)`);
    if (isSource && !/\bmode\s*:/.test(readFileSync(cfgFile, 'utf8'))) {
      warn(`your existing ${shown('assets/kiln-config.js')} has no mode — add these two lines inside window.KILN for source mode:`);
      console.log(`      mode:   'source',\n      adapter: '${siteMode.adapter}',`);
    }
  }
  if (!existsSync(at('kiln.html'))) {
    wrote.push(at('kiln.html'));
    writeFileSync(at('kiln.html'), `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Sign in · Kiln</title>
</head><body>
<!-- Kiln entry point. Visiting /kiln shows the sign-in; there is no edit button on the site. -->
<script src="/assets/kiln-config.js"></script>
<script src="/assets/kiln.js" defer></script>
</body></html>
`);
    ok(`wrote ${shown('kiln.html')} (your /kiln sign-in page)`);
  } else ok(`${shown('kiln.html')} already present (left untouched)`);
  // Security headers: Cloudflare Pages and Netlify read a _headers file from
  // the root of what gets published. An existing file is the owner's — never
  // touched. A generator publishes only its public folder as it is, so there
  // the file goes into that folder; one with no such folder is told where.
  const HEADERS_DOC = 'https://github.com/kilncms/kiln/blob/main/docs/for-site-owners.md#security-headers';
  if (isSource && !base) {
    info(`security headers: copy Kiln's _headers file into the folder your build publishes as-is. See ${HEADERS_DOC}`);
  } else if (!existsSync(at('_headers'))) {
    cpSync(path.join(PKG_ROOT, 'templates', '_headers'), at('_headers'));
    wrote.push(at('_headers'));
    ok(`wrote ${shown('_headers')} (security headers: other sites cannot frame yours, HTTPS only)`);
  } else {
    ok(`${shown('_headers')} already present (left untouched). The lines Kiln suggests: ${HEADERS_DOC}`);
  }
  // What an earlier run left where the build never looks: name it, delete nothing.
  if (base) {
    const old = [...['kiln.js', 'kiln-editor.js', 'kiln-features.js', 'kiln-config.js'].map(f => `assets/${f}`), 'kiln.html'].filter(f => existsSync(f));
    if (old.length) {
      warn(`an earlier setup left Kiln's files at the top of the repository, where ${siteMode.generator} does not publish them. They are in ${base}/ now. Once you have checked, remove the old copies:`);
      console.log(`      git rm ${old.join(' ')}`);
    }
  }
  return wrote;
}

// The two lines every page needs, in the order they must load.
const KILN_TAGS = ['<script src="/assets/kiln-config.js"></script>', '<script src="/assets/kiln.js" defer></script>'];
// The same two in an Astro template. Astro bundles any script it can read;
// `is:inline` tells it these are files served as they are, and is left out of
// the built page.
const ASTRO_TAGS = KILN_TAGS.map(t => t.replace('<script ', '<script is:inline '));
const LOADS_KILN = /<script\b[^>]*\bsrc=["'][^"']*\bkiln\.js(?:\?[^"']*)?["']/i;

/** The pages of a plain-HTML site: every .html file outside build and tool folders, Kiln's own two pages excepted. */
function sitePages(root = '.') {
  const files = [];
  (function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') || ['node_modules', '_templates', 'functions', 'assets', 'dist', 'build', 'public', 'out', '_site', '.git'].includes(e.name)) continue;
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.name.endsWith('.html') && !['kiln.html', 'members-login.html'].includes(e.name)) files.push(f);
    }
  })(root);
  return files.sort();
}

/**
 * A page with the two script tags before its last </body>. A page that
 * already loads kiln.js is returned as it is ('already'); one with no </body>
 * cannot be done ('no-body'). The config tag is not repeated if it is there.
 */
function withKilnTags(html, lines = KILN_TAGS) {
  if (LOADS_KILN.test(html)) return { html, state: 'already' };
  const at = html.toLowerCase().lastIndexOf('</body>');
  if (at === -1) return { html, state: 'no-body' };
  const nl = html.includes('\r\n') ? '\r\n' : '\n';
  const tags = lines.filter(t => !(t.includes('kiln-config.js') && /kiln-config\.js/.test(html)));
  const lineStart = html.lastIndexOf('\n', at - 1) + 1;
  const before = html.slice(lineStart, at);
  // </body> on a line of its own: the tags take that line's indentation.
  if (/^[ \t]*$/.test(before)) {
    return { html: html.slice(0, lineStart) + tags.map(t => before + t + nl).join('') + html.slice(lineStart), state: 'added' };
  }
  return { html: html.slice(0, at) + nl + tags.join(nl) + nl + html.slice(at), state: 'added' };
}

/**
 * The editor only starts on a page that loads it. Offer to add the two script
 * tags to every page that lacks them, name the files, and return the ones
 * written (for the scoped commit). Running it again changes nothing.
 */
async function offerScriptTags(siteMode = null) {
  hr('Loading the editor on your pages');
  if (siteMode?.mode === 'source') return siteMode.adapter === 'astro' ? offerAstroTags(siteMode) : tellWhereTagsGo(siteMode, KILN_TAGS);
  const pages = sitePages();
  const todo = [], noBody = [];
  let already = 0;
  for (const f of pages) {
    const r = withKilnTags(readFileSync(f, 'utf8'));
    if (r.state === 'already') already++;
    else if (r.state === 'no-body') noBody.push(f);
    else todo.push([f, r.html]);
  }
  if (!pages.length) {
    warn('no .html pages found here yet. When you add one, it needs these two lines before </body>:');
    console.log(`     ${KILN_TAGS.join('\n     ')}`);
    return [];
  }
  if (!todo.length && !noBody.length) { ok(`${already === 1 ? 'your page already loads' : `all ${already} pages already load`} kiln.js — nothing to add`); return []; }
  console.log(`  The editor starts only on pages that load it. Each page needs these two\n  lines before </body>:\n     ${KILN_TAGS.join('\n     ')}\n`);
  const wrote = [];
  if (todo.length) {
    console.log(`  ${todo.length === 1 ? 'This page does' : `These ${todo.length} pages do`} not have them yet:`);
    for (const [f] of todo.slice(0, 20)) console.log(`     ${f}`);
    if (todo.length > 20) console.log(`     … and ${todo.length - 20} more`);
    if (await yes(`Add the two script tags to ${todo.length === 1 ? 'it' : `these ${todo.length} pages`} now?`, 'y')) {
      for (const [f, html] of todo) { writeFileSync(f, html); wrote.push(f); }
      ok(`added the two script tags to ${wrote.length} page${wrote.length === 1 ? '' : 's'} (review with: git diff)`);
    } else {
      warn('not added. Until a page has those two lines, signing in at /kiln brings you back to it with no editor.');
      info('Tip: paste KILN_PROMPT.md into your AI tool and it adds them along with the data-cms annotations.');
    }
  }
  if (noBody.length) warn(`${noBody.length} page${noBody.length === 1 ? ' has' : 's have'} no </body> to put them before — add the two lines by hand: ${noBody.join(', ')}`);
  if (already) info(`${already} page${already === 1 ? '' : 's'} already load${already === 1 ? 's' : ''} kiln.js — left untouched`);
  return wrote;
}

/** A generated site whose templates the wizard does not edit: say what goes where. */
function tellWhereTagsGo(siteMode, lines) {
  console.log(`  Every page needs these two lines before </body>:\n     ${lines.join('\n     ')}`);
  info(`${siteMode.generator || 'Generator'} site: put them in your base layout so every generated page loads them.`);
  return [];
}

/** An Astro site's page shells: every .astro file under src/ that closes a <body>. Usually one layout. */
function astroShells(root = 'src') {
  const files = [];
  (function walk(dir) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.name.endsWith('.astro') && /<\/body>/i.test(readFileSync(f, 'utf8'))) files.push(f);
    }
  })(root);
  return files.sort();
}

/**
 * Astro builds its pages from templates, so the two script tags go into the
 * template that closes <body> (the layout, as a rule), and every page built
 * from it loads the editor. The files are named and nothing is written
 * without a yes. Running it again changes nothing.
 */
async function offerAstroTags(siteMode) {
  const shells = astroShells();
  if (!shells.length) return tellWhereTagsGo(siteMode, ASTRO_TAGS);
  const todo = [];
  let already = 0;
  for (const f of shells) {
    const r = withKilnTags(readFileSync(f, 'utf8'), ASTRO_TAGS);
    if (r.state === 'already') already++; else todo.push([f, r.html]);
  }
  if (!todo.length) { ok(`${already === 1 ? 'your layout already loads' : `all ${already} layouts already load`} kiln.js — nothing to add`); return []; }
  console.log(`  The editor starts only on pages that load it. In an Astro template the two\n  lines are written like this, before </body>:\n     ${ASTRO_TAGS.join('\n     ')}\n`);
  console.log(`  ${todo.length === 1 ? 'This template closes' : `These ${todo.length} templates close`} <body> and ${todo.length === 1 ? 'does' : 'do'} not have them yet:`);
  for (const [f] of todo.slice(0, 20)) console.log(`     ${f.split(path.sep).join('/')}`);
  if (todo.length > 20) console.log(`     … and ${todo.length - 20} more`);
  const wrote = [];
  if (await yes(`Add the two script tags to ${todo.length === 1 ? 'it' : `these ${todo.length} templates`} now?`, 'y')) {
    for (const [f, html] of todo) { writeFileSync(f, html); wrote.push(f); }
    ok(`added the two script tags to ${wrote.length} template${wrote.length === 1 ? '' : 's'} (review with: git diff). Every page built from ${wrote.length === 1 ? 'it' : 'them'} loads the editor after the next build.`);
  } else {
    warn('not added. Until the built pages have those two lines, signing in at /kiln brings you back to a page with no editor.');
  }
  if (already) info(`${already} template${already === 1 ? '' : 's'} already load${already === 1 ? 's' : ''} kiln.js — left untouched`);
  return wrote;
}

/** Offer the first-pass auto-tagger. Shared by both modes.
 *  Returns the list of files it actually rewrote (for the scoped commit). */
async function offerAutotag() {
  hr('Making pages editable');
  console.log(`
  Kiln edits only what you mark editable. Pick how you want to do that:

   1. In the browser (recommended to start) — sign in at your site's /kiln,
      open ✨ Make text/images editable, and click sections to tag them one
      by one. Full control over exactly what editors can touch.
   2. AI bulk-tag — paste KILN_PROMPT.md into Claude/Cursor/v0 with your repo
      and it annotates every page at once. Fastest for big sites.
   3. Auto-tag a first pass right now — a conservative, reviewable guess
      (headings, paragraphs, images, card lists, the menu; tables are never
      made repeatable).

  Either way you can add or remove editable sections any time — nothing here
  is a one-time decision.`);
  const taggedFiles = [];
  if (await yes('Run the first-pass auto-tagger now? (review with git diff after)', 'n')) {
    const { autotag } = await import(pathToFileURL(path.join(PKG_ROOT, 'src', 'autotag.js')).href);
    let tagged = 0;
    for (const f of readdirSync('.').filter(x => x.endsWith('.html') && !['kiln.html', 'members-login.html'].includes(x))) {
      const raw = readFileSync(f, 'utf8');
      const { html, counts } = autotag(raw);
      if (html !== raw) { writeFileSync(f, html); taggedFiles.push(f); tagged += counts.fields + counts.images + counts.repeats + counts.menu; }
    }
    ok(`auto-tagged ${tagged} things — review with: git diff   (undo: git checkout -- .)`);
    info('subfolders too? run: npx github:kilncms/kiln#release tag');
  }
  return taggedFiles;
}

/** Kiln Cloud / Managed prep: we run the worker + GitHub App, so this only
 *  points your repo at our infrastructure and wires the files. No Cloudflare
 *  login, no worker deploy, no app registration. */
async function cloudPrep(repo, siteMode = null) {
  const WORKER = 'https://auth.kilncms.com';
  const APP = 'https://github.com/apps/kiln-cms/installations/new';
  const DASH = 'https://app.kilncms.com';
  hr('Kiln Cloud — prep your repo');
  info('We run the sign-in & commit worker and the GitHub App. This just points');
  info('your repo at them and wires the editor files. No Cloudflare login needed.\n');

  const kilnFiles = wireSite(repo, WORKER, siteMode);
  kilnFiles.push(...await offerScriptTags(siteMode));
  kilnFiles.push(...await offerAutotag());

  hr('Done — 2 clicks left (in your browser)');
  console.log(`
  1. Install the Kiln GitHub App on THIS repo (choose "Only select repositories"):
     ${APP}
  2. Subscribe and add your site (repo + live URL) at:
     ${DASH}

  Commit & push the changes this made, connect your repo to a host that
  auto-deploys on push (Cloudflare Pages recommended), then edit at
  yoursite.com/kiln.  Health-check any time:  npx github:kilncms/kiln#release doctor
`);
  if (await yes('Commit and push the Kiln wiring now?', 'y')) {
    commitAndPush(kilnFiles, 'Add Kiln (Cloud)');
  }
  process.exit(0);
}

// ─── help ────────────────────────────────────────────────────────────────────

function versionLine() {
  const read = (f) => { try { return readFileSync(path.join(PKG_ROOT, f), 'utf8'); } catch { return ''; } };
  let version = 'unknown';
  try { version = JSON.parse(read('package.json')).version || version; } catch { /* keep */ }
  return `kiln ${version} (editor build ${read(path.join('dist', 'VERSION')).trim() || 'unknown'})`;
}

/** One line per command that exists. test/cli-help.test.js holds this to the dispatch at the bottom of the file. */
function helpText() {
  return `${versionLine()} — click-to-edit for static sites

  Usage: npx github:kilncms/kiln#release [command] [options]      Run it in your site's folder.

  (no command)     Set Kiln up for the site in this folder. Asks a few questions,
                   copies the editor in, adds it to your pages, offers to commit.
  doctor           Check a set-up site and say what is wrong.
                     --site <url>  --repo <owner/name>  --worker <url>
  update           Copy the current editor into this site (and the members gate,
                   if the site has one).
                     --worker  self-hosted only: bring the worker in kiln-worker/
                               up to date instead, and offer to deploy it
  tag              Mark headings, text and images editable, as a first pass.
                     --dry  show what would change, write nothing
  add-site         Add this site to Kiln Cloud.
  new [dir]        Start a new site from a template.
                     --from <owner/repo>  --name <title>  --dry
  rescue <url>     Copy a site out of a website builder into plain HTML.
                     --out <dir>  --max-pages <n>  --delay <ms>  --dry  --no-tag  --keep-scripts

  --help, -h       This text. With a command too: nothing is run, nothing is changed.
  --version        The version of this tool.

  Words you will see:
    repo       your site's files on GitHub, written owner/name
    worker     the small sign-in service the editor talks to. Kiln Cloud runs one
               for you; a self-hosted setup deploys its own on Cloudflare
    origin     your site's address without a path, like https://example.com. A
               worker only answers the origins on its list (ALLOWED_ORIGINS)
    KV         the worker's storage (a Cloudflare "KV namespace"): sign-ins and
               each site's list of people
    wrangler   Cloudflare's command-line tool; wrangler.toml is its settings file

  Guides: https://github.com/kilncms/kiln#readme`;
}

async function wizard() {
  // Reached when no command was given. Anything else that falls through to
  // here is a word Kiln does not know: say so, and never start setting up a
  // site because of a typo.
  if (cmd !== undefined) {
    console.error(`\n  ❌ Unknown command "${cmd}".\n`);
    console.log(helpText());
    process.exit(2);
  }
  hr('Kiln setup');

  // 0. prerequisites
  hr('Checking tools');
  if (!shTry('git --version').ok) { fail('git is required'); process.exit(1); }
  ok('git');
  const hasGh = shTry('gh --version').ok;
  info(hasGh ? 'gh CLI found' : 'gh CLI not found (fine if your site is already on GitHub)');
  info('wrangler runs via npx (no install needed)');

  // How will Kiln run? Cloud/Managed = we run the plumbing; self-host = you do.
  hr('How will you run Kiln?');
  console.log(`   1. Kiln Cloud / Managed — we run the worker + GitHub App (paid; simplest)
   2. Self-hosted — you run your own worker + GitHub App (free, open source)\n`);
  let mode = (await ask('Choose 1 or 2', '1')).trim();
  if (!['1', '2'].includes(mode)) mode = '1';   // unrecognized input → the shown default (Cloud)
  const isCloud = mode === '1';
  if (isCloud) {
    // still need the repo (Step 1) before prepping, so fall through to detect it,
    // then hand off to cloudPrep. Self-host continues with the full flow below.
  } else {
    console.log(`\n  Self-host wires GitHub + Cloudflare (and optionally Google) for the site
  in the CURRENT directory. Everything scriptable happens automatically;
  you'll be asked to click exactly three green buttons along the way.`);
  }

  // 1. GitHub repo
  hr('Step 1 · Your site on GitHub');
  let repo;
  const remote = shTry('git remote get-url origin');
  if (remote.ok && /github\.com/.test(remote.out)) {
    repo = remote.out.trim().match(/github\.com[:/]([^/]+\/.+?)(?:\.git)?\/?$/)?.[1];
    ok(`already on GitHub: ${repo}`);
  } else {
    if (!hasGh) { fail('No GitHub remote and no gh CLI. Install gh (brew install gh) or push your site to GitHub first.'); process.exit(1); }
    if (!shTry('gh auth status').ok) {
      info('Signing you into GitHub (device code)…');
      sh('gh auth login --hostname github.com --git-protocol https --web', { show: true });
    }
    const name = await ask('New repo name', path.basename(process.cwd()));
    const priv = await yes('Private repo?', 'y');
    if (!existsSync('.git')) sh('git init -b main');
    // argv form (no shell) so unusual repo names can't break or inject into the command line
    const create = spawnSync('gh', ['repo', 'create', name, priv ? '--private' : '--public', '--source', '.', '--push'], { stdio: 'inherit' });
    if (create.status !== 0) { fail('gh repo create failed — see the error above, then re-run.'); process.exit(1); }
    repo = sh('gh repo view --json nameWithOwner -q .nameWithOwner').trim();
    ok(`created + pushed: ${repo}`);
  }

  // How is this site built? (SOURCE-MODE-SPEC §7 — detection + mode dialogue)
  const siteMode = await detectSiteMode();

  // Cloud/Managed: everything past here (worker, app, Pages) is ours to run.
  if (isCloud) return cloudPrep(repo, siteMode);

  // 2. Worker
  hr('Step 2 · Deploy your Kiln auth worker (free Cloudflare Worker)');
  const workerDir = 'kiln-worker';
  // The worker is multi-module: worker/index.js imports ./cloud.js (which imports
  // ./runbook.js), ../src/engine.js (which imports the npm package parse5) and
  // ../src/file-policy.js. So the generated directory mirrors the kiln repo layout —
  // kiln-worker/worker/* + kiln-worker/src/* — keeping every relative import intact, and gets
  // its own package.json so wrangler's bundler resolves parse5 from a local
  // node_modules. wrangler.toml points main at worker/index.js.
  // A file already there is the owner's and is left alone: bringing an
  // existing worker up to date is `update --worker`, which asks first.
  let copied = 0;
  for (const parts of WORKER_FILES) {
    const to = path.join(workerDir, ...parts);
    if (existsSync(to)) continue;
    mkdirSync(path.dirname(to), { recursive: true });
    cpSync(path.join(PKG_ROOT, ...parts), to);
    copied++;
  }
  if (copied) ok(`copied worker source into ${workerDir}/ (yours to keep + redeploy)`);
  // RE-RUN: workers generated before source mode predate the yaml dependency.
  // Add it (merge, never clobber) so the next deploy's bundle resolves.
  const hadPackage = existsSync(path.join(workerDir, 'package.json'));
  const addedDeps = mergeWorkerDeps(workerDir);
  if (hadPackage && addedDeps.length) info(`added ${addedDeps.join(' and ')} to the worker package.json (the worker's code needs ${addedDeps.length === 1 ? 'it' : 'them'})`);
  if (!installWorkerDeps(workerDir)) process.exit(1);

  // Cloudflare auth preflight: a piped `wrangler kv/deploy` on a logged-out
  // (especially headless) machine hangs silently waiting on a browser. Check
  // first and run the login with visible stdio so the URL/prompts show up.
  const who = shTry('npx wrangler whoami', { cwd: workerDir });
  if (!who.ok || /not authenticated|not logged in/i.test(who.out)) {
    info('Not logged in to Cloudflare — running wrangler login (finish it in your browser)…');
    if (!shTry('npx wrangler login', { show: true, cwd: workerDir }).ok) {
      fail('wrangler login failed — run `npx wrangler login` yourself, then re-run this wizard.');
      process.exit(1);
    }
  } else ok('Cloudflare: logged in');

  const tomlPath = path.join(workerDir, 'wrangler.toml');
  let workerName;
  if (existsSync(tomlPath)) {
    // RE-RUN: merge, never clobber. Rewriting this file used to reset
    // ALLOWED_ORIGINS to localhost and redeploy — instantly breaking sign-in on
    // a working production site. Keep the user's origins/secret/route blocks;
    // only add what's missing.
    let toml = readFileSync(tomlPath, 'utf8');
    workerName = toml.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1] || 'kiln-auth';
    ok(`found existing ${tomlPath} — keeping your config (worker "${workerName}")`);
    if (/^\s*main\s*=\s*"index\.js"/m.test(toml)) {
      // migrate the old flat layout (a bare index.js could never deploy — its imports were missing)
      toml = toml.replace(/^(\s*main\s*=\s*)"index\.js"/m, '$1"worker/index.js"');
      info('updated main → worker/index.js (worker source now lives in worker/)');
    }
    if (!/\[triggers\]/.test(toml)) {
      toml += `\n# Scheduled publishing: commit due posts every 5 minutes.\n[triggers]\ncrons = ["*/5 * * * *"]\n`;
      info('added [triggers] crons — scheduled publishing will now fire');
    }
    if (!/binding\s*=\s*"KILN"/.test(toml)) {
      const kvId = kvNamespaceId(workerDir);
      toml += `\n[[kv_namespaces]]\nbinding = "KILN"\nid = "${kvId}"\n`;
      info('added the KILN KV binding');
    }
    writeFileSync(tomlPath, toml);
  } else {
    workerName = await ask('Worker name', 'kiln-auth');
    info('Creating the KV namespace…');
    const kvId = kvNamespaceId(workerDir);
    writeFileSync(tomlPath, `name = "${workerName}"
main = "worker/index.js"
compatibility_date = "2026-06-01"

# Site origins allowed to authenticate through this worker (comma-separated).
# The wizard replaces this with your real site origin(s) in Step 6.
[vars]
ALLOWED_ORIGINS = "http://localhost:8788"

[[kv_namespaces]]
binding = "KILN"
id = "${kvId}"

# Scheduled publishing: commit due posts every 5 minutes.
[triggers]
crons = ["*/5 * * * *"]

# Per-IP rate limiting on the abuse-prone sign-in routes — uncomment to enable.
# (The worker degrades safely to no throttling while this stays commented out.)
# [[unsafe.bindings]]
# name = "RL"
# type = "ratelimit"
# namespace_id = "1001"          # any unique number across this worker's limiters
# simple = { limit = 20, period = 60 }   # 20 requests per 60s per IP
`);
  }
  // Deploying here is required (Steps 3-5 need the worker URL live) and safe on
  // re-runs: the merge above means we deploy the EXISTING origins, not a reset.
  const dep = shTry('npx wrangler deploy', { cwd: workerDir });
  const workerUrl = dep.out.match(/https:\/\/[^\s]+workers\.dev/)?.[0];
  if (!workerUrl) { fail(`worker deploy failed:\n${dep.out}`); process.exit(1); }
  ok(`worker live: ${workerUrl}`);

  // 3. GitHub App — click 1 + click 2
  hr('Step 3 · Register the GitHub App (click 1 of 3)');
  const status = await fetchJson(`${workerUrl}/setup/status`);
  if (!status.json.configured) {
    info('Opening the one-button registration page…');
    openUrl(`${workerUrl}/setup`);
    if (!(await pollUntil('waiting for you to press "Create the Kiln GitHub App"',
      async () => (await fetchJson(`${workerUrl}/setup/status`)).json.configured))) {
      fail(`Timed out waiting for the GitHub App registration.\n  Finish it at ${workerUrl}/setup, then re-run: npx github:kilncms/kiln#release`);
      process.exit(1);
    }
  } else ok(`App already registered: ${status.json.slug}`);
  const slug = (await fetchJson(`${workerUrl}/setup/status`)).json.slug;
  if (!slug) { fail(`The worker reports no App slug yet — finish registration at ${workerUrl}/setup and re-run.`); process.exit(1); }

  hr('Step 4 · Install the App on your repo (click 2 of 3)');
  const installed = (await fetchJson(`${workerUrl}/setup/install-check?repo=${repo}`)).json.installed;
  if (!installed) {
    info(`Opening the install page — choose "Only select repositories" → ${repo}`);
    openUrl(`https://github.com/apps/${slug}/installations/new`);
    if (!(await pollUntil('waiting for the install',
      async () => (await fetchJson(`${workerUrl}/setup/install-check?repo=${repo}`)).json.installed))) {
      fail(`Timed out waiting for the app install.\n  Install it at https://github.com/apps/${slug}/installations/new, then re-run.`);
      process.exit(1);
    }
  } else ok('App already installed on this repo');

  // 4. Cloudflare Pages — click 3
  hr('Step 5 · Host the site on Cloudflare Pages (click 3 of 3)');
  const project = await ask('Pages project name', repo.split('/')[1]);
  const exists = shTry(`npx wrangler pages project list`, { cwd: workerDir });
  if (exists.out.includes(project)) {
    ok(`Pages project "${project}" already exists`);
  } else {
    info(`Opening the dashboard — Workers & Pages → Create → Pages → Connect to Git → ${repo}.`);
    info('Leave build command EMPTY, output directory "/". Then come back here.');
    openUrl('https://dash.cloudflare.com/?to=/:account/workers-and-pages/create/pages');
    if (!(await pollUntil(`waiting for ${project}.pages.dev to answer`,
      () => fetch(`https://${project}.pages.dev/`).then(r => r.ok), 6000))) {
      fail(`Timed out waiting for ${project}.pages.dev.\n  Finish Connect-to-Git in the Cloudflare dashboard, then re-run: npx github:kilncms/kiln#release`);
      process.exit(1);
    }
  }
  const siteUrl = `https://${project}.pages.dev`;

  // 5. Allow origin + (optional) custom domain (apex AND www — visitors reach both)
  hr('Step 6 · Allow your site to talk to the worker');
  const custom = await ask('Custom domain (Enter to skip)', '');
  // strip scheme, leading www., and any trailing slash/path — "example.com/" must
  // not become an origin like "https://example.com/" that never matches
  const bare = custom.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '').trim();
  const wanted = [siteUrl,
    bare && `https://${bare}`,
    bare && `https://www.${bare}`,
    'http://localhost:8788'].filter(Boolean);
  // UNION with whatever the file already allows (a re-run must never drop the
  // origins a working site depends on), dedupe, and touch only this one line.
  let toml = readFileSync(path.join(workerDir, 'wrangler.toml'), 'utf8');
  const current = (toml.match(/ALLOWED_ORIGINS\s*=\s*"([^"]*)"/)?.[1] || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const origins = [...new Set([...current, ...wanted])].join(',');
  if (/ALLOWED_ORIGINS\s*=\s*"[^"]*"/.test(toml)) {
    toml = toml.replace(/ALLOWED_ORIGINS\s*=\s*"[^"]*"/, `ALLOWED_ORIGINS = "${origins}"`);
  } else if (/^\[vars\]/m.test(toml)) {
    toml = toml.replace(/^\[vars\]/m, `[vars]\nALLOWED_ORIGINS = "${origins}"`);
  } else {
    toml += `\n[vars]\nALLOWED_ORIGINS = "${origins}"\n`;
  }
  writeFileSync(path.join(workerDir, 'wrangler.toml'), toml);
  const redep = shTry('npx wrangler deploy', { cwd: workerDir });
  if (redep.ok) ok(`worker now accepts: ${origins}`);
  else { warn(`worker redeploy failed — your site can't talk to the worker until you run 'npx wrangler deploy' in ${workerDir}/:\n${redep.out}`); }

  // 6. Site wiring
  hr('Step 7 · Wire the site');
  const kilnFiles = wireSite(repo, workerUrl, siteMode);
  kilnFiles.push(...await offerScriptTags(siteMode));

  // 7. Making pages editable.
  kilnFiles.push(...await offerAutotag());

  // 8. Members (optional)
  if (await yes('\nSet up a members-only area (gated pages + documents)?', 'n')) {
    cpSync(path.join(PKG_ROOT, 'templates', 'functions'), 'functions', { recursive: true });
    kilnFiles.push('functions');
    if (!existsSync('members-login.html')) {
      cpSync(path.join(PKG_ROOT, 'templates', 'members-login.html'), 'members-login.html');
      kilnFiles.push('members-login.html');
    }
    mkdirSync('members', { recursive: true });
    const secret = [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('');
    const missed = [];
    for (const [k, v] of [['KILN_MEMBER_SECRET', secret], ['KILN_REPO', repo], ['KILN_WORKER', workerUrl]]) {
      const r = spawnSync('npx', ['wrangler', 'pages', 'secret', 'put', k, '--project-name', project],
        { input: v, encoding: 'utf8' });
      if (r.status !== 0) missed.push(k);
    }
    if (missed.length) {
      fail(`couldn't set Pages secret(s): ${missed.join(', ')} — the members area will 503 until you set them:`);
      for (const k of missed) console.log(`      npx wrangler pages secret put ${k} --project-name ${project}`);
    } else ok('members functions copied + 3 Pages secrets set (active after your next deploy)');
  }

  // 9. Google (optional, manual client creation — Google has no API for it)
  if (await yes('Set up Google sign-in for editors/members?', 'n')) {
    console.log(`
  Google doesn't allow creating OAuth clients by API, so this part is manual (once):
   1. Opening console.cloud.google.com/apis/credentials …
   2. Configure the OAuth consent screen (External, publish), then
      Create credentials → OAuth client ID → Web application
   3. Authorized redirect URI (exactly):  ${workerUrl}/google/callback`);
    openUrl('https://console.cloud.google.com/apis/credentials');
    const cid = await ask('Paste the Client ID (Enter to skip)');
    if (cid) {
      const csec = await ask('Paste the Client Secret');
      spawnSync('npx', ['wrangler', 'secret', 'put', 'GOOGLE_CLIENT_ID'], { input: cid, cwd: workerDir, encoding: 'utf8' });
      spawnSync('npx', ['wrangler', 'secret', 'put', 'GOOGLE_CLIENT_SECRET'], { input: csec, cwd: workerDir, encoding: 'utf8' });
      const g = await fetch(`${workerUrl}/google/login`, { redirect: 'manual' }).then(r => r.status);
      if (g !== 503) ok('Google sign-in is live');
      else warn('secrets set but worker still reports unconfigured — rerun: npx github:kilncms/kiln#release doctor');
    }
  }

  // 10. Commit + summary
  if (await yes('\nCommit and push the Kiln wiring now?', 'y')) {
    commitAndPush(kilnFiles, `Add Kiln (${siteUrl})`);
  }
  hr('Done 🔥');
  console.log(`
  Site      ${siteUrl}${custom ? ` (+ https://${custom})` : ''}
  Edit it   ${siteUrl}/kiln   ← sign in here to start editing (no edit button on the site)
  Worker    ${workerUrl}
  People    sign in → People & access → add editors/members by email (Google sign-in)
  Check up  npx github:kilncms/kiln#release doctor
  Annotate  sign in → ✨ Make text/images editable (click sections to tag them),
            or paste KILN_PROMPT.md into your AI to bulk-tag every page
`);
  process.exit(0);
}

// ─── tag: heuristic first-pass auto-tagger ───────────────────────────────────

async function tagCmd(args) {
  const { autotag } = await import(pathToFileURL(path.join(PKG_ROOT, 'src', 'autotag.js')).href);
  hr(args.dry ? 'Auto-tag (dry run)' : 'Auto-tag');
  const files = sitePages();
  if (!files.length) { warn('no .html pages found here'); process.exit(1); }
  const tot = { fields: 0, images: 0, repeats: 0, menu: 0 };
  for (const f of files) {
    const raw = readFileSync(f, 'utf8');
    const { html, counts } = autotag(raw);
    const changed = html !== raw;
    if (changed && !args.dry) writeFileSync(f, html);
    const bits = Object.entries(counts).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`).join(', ');
    console.log(`  ${changed ? (args.dry ? '~' : '✓') : '·'} ${f}${bits ? '  (' + bits + ')' : '  (nothing new to tag)'}`);
    for (const k of Object.keys(tot)) tot[k] += counts[k];
  }
  hr('Summary');
  console.log(`  ${tot.fields} text fields · ${tot.images} images · ${tot.repeats} block lists · ${tot.menu} menus${args.dry ? '   (dry run — nothing written)' : ''}`);
  if (!args.dry) console.log(`
  This is a FIRST PASS — review it before committing:
    git diff              see exactly what was tagged
    git checkout -- .     throw it all away
  Refine any time in the browser: sign in at /kiln → ✨ Make text/images editable
  (tables are never made repeatable on purpose — tag those by hand or in the browser).`);
  process.exit(0);
}

// ─── update ──────────────────────────────────────────────────────────────────

async function update() {
  hr('kiln update — refresh the on-page editor to this version');
  // Find where the site references kiln.js and drop the latest engine next to it.
  // A generated site has no pages at the top of its repository: its sign-in
  // page sits in the folder the build publishes as it is (Astro: public/), and
  // the address that page names is inside that folder.
  let prefix = null, root = '.';
  for (const r of ['.', 'public']) {
    let htmls = [];
    try { htmls = readdirSync(r).filter(f => f.endsWith('.html')); } catch { /* no such folder */ }
    for (const f of htmls) {
      const m = readFileSync(path.join(r, f), 'utf8').match(/src="([^"]*?)kiln\.js"/);
      if (m) { prefix = m[1]; root = r; break; }
    }
    if (prefix !== null) break;
  }
  if (prefix === null) { fail('No page here loads kiln.js — run the wizard first (npx github:kilncms/kiln#release).'); process.exit(1); }
  const dir = path.join(root, prefix.replace(/^\//, '').replace(/\/$/, '')).split(path.sep).join('/') || '.';
  mkdirSync(dir, { recursive: true });
  for (const f of ['kiln.js', 'kiln-editor.js', 'kiln-features.js']) cpSync(path.join(PKG_ROOT, 'dist', f), path.join(dir, f));
  ok(`copied the latest kiln.js + kiln-editor.js + kiln-features.js into ${dir}/`);
  // The members gate is Kiln's code in the site's repo as well. A site that has
  // one gets the current gate, but only when its worker can answer the gate's
  // question: the new gate against an older worker would lock members out.
  const gate = path.join('functions', 'members', '_middleware.js');
  const gateFiles = [];
  if (existsSync(gate)) {
    const cfgFile = path.join(dir, 'kiln-config.js');
    const workerUrl = existsSync(cfgFile) ? readFileSync(cfgFile, 'utf8').match(/worker:\s*'([^']+)'/)?.[1] : null;
    const health = workerUrl ? await fetch(`${workerUrl}/healthz`).then(r => r.json()).catch(() => null) : null;
    if (health && health.memberSessions) {
      cpSync(path.join(PKG_ROOT, 'templates', 'functions'), 'functions', { recursive: true });
      gateFiles.push(path.join('functions', '_kiln.js'), gate, path.join('functions', 'api', 'member-redeem-google.js'));
      ok('refreshed the members gate in functions/ — removing a member now ends their sign-in within 5 minutes');
      info('after the next deploy every member signs in once more (their old sign-in cannot be re-checked)');
    } else if (health) {
      warn('left the members gate as it is: your worker is older than the current gate. Update the worker (self-hosted: npx github:kilncms/kiln#release update --worker), then run this again');
    } else {
      warn('left the members gate as it is: the worker did not answer, so it is not known whether it supports the current gate');
    }
  }
  if (await yes('Commit and push now?', 'y')) {
    // Add all three bundles: kiln-features.js is lazy-loaded by kiln.js, so leaving
    // it out ships a stale features runtime (e.g. event calendars) to visitors.
    // argv form, no shell: `dir` is read out of the site's own HTML, and a folder
    // name with a space, a quote or a `$(…)` in it must reach git as a path.
    const files = [...['kiln.js', 'kiln-editor.js', 'kiln-features.js'].map(f => path.join(dir, f)), ...gateFiles];
    let gitError = null;
    for (const argv of [['add', '--', ...files], ['commit', '-m', 'Update Kiln editor to latest'], ['push']]) {
      const r = spawnSync('git', argv, { encoding: 'utf8' });
      if (r.status !== 0) { gitError = (r.stderr || r.stdout || `git ${argv[0]} failed`).trim(); break; }
    }
    if (gitError === null) ok('pushed — your host will redeploy');
    else { fail(`commit/push didn't complete:\n${gitError}\n  Resolve that, then: git add, git commit and git push the three kiln*.js files in ${dir}/`); process.exit(1); }
  } else info('Commit + push when ready and your host will redeploy.');
  process.exit(0);
}

// ─── update --worker (self-hosted) ───────────────────────────────────────────

const workerVersionIn = (file) => { try { return readFileSync(file, 'utf8').match(/const WORKER_VERSION = '([^']+)'/)?.[1] || null; } catch { return null; } };

/**
 * Bring a worker the setup wizard made up to this version: replace its code
 * with the current worker's, keep everything that is the owner's (wrangler.toml,
 * secrets, stored data), and offer to deploy. Nothing is written before a yes,
 * and nothing is deployed before a second one.
 */
async function updateWorker(args) {
  hr('kiln update --worker — bring a self-hosted worker up to this version');
  const workerDir = (typeof args.worker === 'string' && args.worker ? args.worker : 'kiln-worker').replace(/[\\/]+$/, '');
  const tomlPath = path.join(workerDir, 'wrangler.toml');
  if (!existsSync(tomlPath)) {
    fail(`There is no self-hosted worker here: ${tomlPath} does not exist.`);
    console.log(`     This command updates a worker the setup wizard made, which it keeps in
     kiln-worker/ at the top of the site's repository. Run it there, or name the
     folder: --worker=<folder>.
     On Kiln Cloud there is nothing to update: we run the worker.
     A worker deployed from a clone of the Kiln repository is updated in that
     clone: git pull, then npx wrangler deploy.`);
    process.exit(1);
  }
  if (/^\s*main\s*=\s*"index\.js"/m.test(readFileSync(tomlPath, 'utf8'))) {
    fail(`${workerDir}/ has the layout of an early setup (main = "index.js"). Run the setup wizard here once: it moves the worker to the current layout and keeps your settings. After that this command keeps it current.`);
    process.exit(1);
  }

  const plan = WORKER_FILES.map(parts => {
    const from = path.join(PKG_ROOT, ...parts), to = path.join(workerDir, ...parts);
    const state = !existsSync(to) ? 'new' : readFileSync(to).equals(readFileSync(from)) ? 'same' : 'changed';
    return { from, to, state, shown: [workerDir, ...parts].join('/') };
  });
  const todo = plan.filter(f => f.state !== 'same');
  const carried = workerVersionIn(path.join(PKG_ROOT, 'worker', 'index.js')) || 'unknown';
  const here = workerVersionIn(path.join(workerDir, 'worker', 'index.js'));
  info(`${workerDir}/ holds worker ${here || 'code of an unknown version'}; this tool carries worker ${carried}.`);

  if (!todo.length) {
    ok(`the worker code in ${workerDir}/ is already the current one — nothing to replace`);
  } else {
    console.log(`\n  ${todo.length === 1 ? 'This file differs' : `These ${todo.length} files differ`} from the current worker:`);
    for (const f of todo) console.log(`     ${f.state === 'new' ? 'add    ' : 'replace'}  ${f.shown}`);
    console.log(`
  Not touched: ${workerDir}/wrangler.toml (your settings), your secrets, and
  everything the worker has stored (sign-ins, people lists, the GitHub App).
  If you changed any of these files yourself, that change is replaced. In a git
  repository, git diff shows it afterwards and git checkout brings it back.
`);
    if (!(await yes(`${todo.length === 1 ? 'Replace it' : `Replace these ${todo.length} files`} with the current worker code?`, 'y'))) {
      info('nothing was changed.');
      process.exit(0);
    }
    for (const f of todo) { mkdirSync(path.dirname(f.to), { recursive: true }); cpSync(f.from, f.to); }
    ok(`${workerDir}/ now holds worker ${carried} (${todo.length} file${todo.length === 1 ? '' : 's'} written)`);
  }
  const addedDeps = mergeWorkerDeps(workerDir);
  if (addedDeps.length) info(`added ${addedDeps.join(' and ')} to ${workerDir}/package.json (the worker's code needs ${addedDeps.length === 1 ? 'it' : 'them'})`);
  if (!installWorkerDeps(workerDir)) process.exit(1);

  // The code on disk is not the code that is running until it is deployed.
  console.log('');
  if (!(await yes(`Deploy it now? (runs: npx wrangler deploy, in ${workerDir}/)`, 'y'))) {
    info(`not deployed: your running worker is unchanged. When you are ready: cd ${workerDir} && npx wrangler deploy`);
    process.exit(0);
  }
  const dep = shTry('npx wrangler deploy', { cwd: workerDir });
  if (!dep.ok) {
    fail(`the deploy did not go through, so your running worker is unchanged:\n${dep.out}\n  Fix that, then: cd ${workerDir} && npx wrangler deploy`);
    process.exit(1);
  }
  ok('deployed');
  // Read it back from the worker itself: a deploy that printed success is not proof.
  const cfgFile = ['public/assets/kiln-config.js', 'assets/kiln-config.js'].find(f => existsSync(f));
  const workerUrl = (cfgFile ? readFileSync(cfgFile, 'utf8').match(/worker:\s*'([^']+)'/)?.[1] : null) || dep.out.match(/https:\/\/[^\s]+\.workers\.dev/)?.[0] || null;
  if (workerUrl) {
    const hz = await fetch(`${workerUrl}/healthz`).then(r => r.json()).catch(() => null);
    if (hz?.version === carried) ok(`${workerUrl}/healthz answers as worker ${carried}`);
    else if (hz) warn(`${workerUrl}/healthz answers as worker ${hz.version || 'of an unknown version'}, not ${carried} yet. Give it a minute, then check: npx github:kilncms/kiln#release doctor`);
    else warn(`${workerUrl} did not answer /healthz. Check it: npx github:kilncms/kiln#release doctor`);
  } else info('to check it: npx github:kilncms/kiln#release doctor');
  info('Next, the editor on your pages: npx github:kilncms/kiln#release update');
  info('Worker first, then the editor, is the safe order: a current worker still serves an older editor.');
  process.exit(0);
}

// ─── add-site (Kiln Cloud) ───────────────────────────────────────────────────

async function addSiteCloud() {
  hr('Add this site to Kiln Cloud');
  const dash = 'https://app.kilncms.com';
  const remote = shTry('git remote get-url origin');
  const repo = remote.ok ? (remote.out.trim().match(/github\.com[:/]([^/]+\/.+?)(?:\.git)?\/?$/)?.[1] || '') : '';
  if (repo) info(`detected repo: ${repo}`);
  info('Kiln Cloud onboarding lives in your dashboard — sign in with GitHub, pick the repo,');
  info('your site URL, and a plan. We run the worker + the app; you keep the repo + host.');
  openUrl(dash + (repo ? `?repo=${encodeURIComponent(repo)}` : ''));
  process.exit(0);
}

// ─── main ────────────────────────────────────────────────────────────────────

const [, , cmd, ...rest] = process.argv;
// Flags accept --flag=value AND --flag value; bare flags become true.
const VALUE_FLAGS = new Set(['site', 'repo', 'worker', 'from', 'name', 'out', 'delay', 'max-pages', 'browser']);
const args = {};
const positional = [];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (!a.startsWith('--')) { positional.push(a); continue; }
  const eq = a.indexOf('=');
  if (eq !== -1) { args[a.slice(2, eq)] = a.slice(eq + 1); continue; }
  const k = a.slice(2);
  if (VALUE_FLAGS.has(k) && i + 1 < rest.length && !rest[i + 1].startsWith('--')) args[k] = rest[++i];
  else args[k] = true;
}
// Help and version never run a command: `kiln tag --help` must not tag anything.
const wantsHelp = cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help === true || rest.includes('-h');
if (wantsHelp || cmd === '--version' || args.version === true) {
  console.log(wantsHelp ? helpText() : versionLine());
  process.exit(0);
}
// An option a command does not have is refused by name, not silently ignored:
// `kiln tag --dry-run` would otherwise rewrite the pages it was asked to preview.
// (Commands that are not in this table check their own options.)
const KNOWN_FLAGS = { '': [], doctor: ['site', 'repo', 'worker'], tag: ['dry'], update: ['worker'], 'add-site': [], new: ['from', 'name', 'dry'] };
const takes = KNOWN_FLAGS[cmd === undefined ? '' : cmd];
const unknownFlag = takes && Object.keys(args).find(k => !takes.includes(k));
if (unknownFlag) {
  console.error(`\n  ❌ ${cmd ? `kiln ${cmd}` : 'The setup wizard'} has no option --${unknownFlag}. ${takes.length ? `It takes: ${takes.map(f => `--${f}`).join(', ')}.` : 'It takes no options.'} See: npx github:kilncms/kiln#release --help\n`);
  process.exit(2);
}
if (cmd === 'doctor') doctor(args);
else if (cmd === 'tag') tagCmd(args);
else if (cmd === 'update') (args.worker ? updateWorker(args) : update());
else if (cmd === 'add-site') addSiteCloud();
else if (cmd === 'rescue') import('./rescue.mjs').then(m => m.rescueCmd(positional[0], args));
else if (cmd === 'new') import('./new.mjs').then(m => m.newCmd(positional[0], args));
else wizard();
