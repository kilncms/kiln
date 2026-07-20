#!/usr/bin/env node
/**
 * kiln — setup wizard + doctor.
 *
 *   npx github:kilncms/kiln            interactive setup in your site directory
 *   npx github:kilncms/kiln doctor     verify an existing Kiln installation
 *   npx github:kilncms/kiln update     refresh the on-page editor to the latest
 *   npx github:kilncms/kiln add-site   add this site to Kiln Cloud (hosted tier)
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
import { fileURLToPath } from 'node:url';

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
const ask = async (q, dflt) => {
  const a = (await rl.question(`${q}${dflt !== undefined ? ` [${dflt}]` : ''}: `)).trim();
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

// ─── doctor ──────────────────────────────────────────────────────────────────

async function doctor(args) {
  hr('kiln doctor');
  // Pull defaults from the local kiln-config.js when run inside a site.
  let site = args.site, repo = args.repo, worker = args.worker;
  const cfgPath = 'assets/kiln-config.js';
  if (existsSync(cfgPath)) {
    const src = readFileSync(cfgPath, 'utf8');
    repo ||= src.match(/repo:\s*'([^']+)'/)?.[1];
    worker ||= src.match(/worker:\s*'([^']+)'/)?.[1];
    ok(`read ${cfgPath} (repo=${repo}, worker=${worker})`);
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
    check(`App installed on ${repo}`, !!inst.json.installed, inst.json.installed ? '' : `install: https://github.com/apps/${status.json.slug}/installations/new`);
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

    // Is the deployed editor the latest? Read the build stamp off the live bundle
    // and compare it to raw dist/VERSION on GitHub. Optional check (network /
    // pinned-fork friendly) — the point is to tell a self-hoster when to run
    // `kiln update`, not to fail the health check.
    if (bootText) {
      const mine = bootText.match(/KILN_VERSION\s*=\s*["']([\w.-]+)["']/)?.[1];
      const latest = await fetch('https://raw.githubusercontent.com/kilncms/kiln/main/dist/VERSION', { cache: 'no-store' })
        .then(r => r.ok ? r.text() : null).then(t => t && t.trim()).catch(() => null);
      if (mine && latest) {
        check('editor is up to date', mine === latest,
          mine === latest ? `version ${mine}` : `you have ${mine}, latest is ${latest} — run: npx github:kilncms/kiln update`, true);
      }
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

  const google = await fetch(`${worker}/google/login`, { redirect: 'manual' }).then(r => r.status).catch(() => 0);
  check('Google sign-in', google !== 503, google === 503 ? 'not configured — set GOOGLE_CLIENT_ID/SECRET' : 'configured', true);

  // OAuth callbacks can't be read back via any API, and they break silently when the worker
  // domain changes (custom domain added, app/repo transferred). Remind the user to verify them.
  info('verify these OAuth callbacks are registered (they drop silently on a domain/worker change):');
  console.log(`      GitHub App          → ${worker}/auth/callback`);
  console.log(`      Google OAuth client → ${worker}/google/callback`);

  console.log(`\n  ${pass}/${total} checks passed${pass === total ? ' — Kiln is healthy 🔥' : ''}\n`);
  process.exit(pass === total ? 0 : 1);
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
 *  Returns the list of files it created/updated (for the scoped commit). */
function wireSite(repo, workerUrl) {
  const wrote = [];
  mkdirSync('assets', { recursive: true });
  for (const f of ['kiln.js', 'kiln-editor.js', 'kiln-features.js']) {
    cpSync(path.join(PKG_ROOT, 'dist', f), path.join('assets', f));
    wrote.push(path.join('assets', f));
  }
  ok('copied kiln.js + kiln-editor.js + kiln-features.js into assets/');
  if (!existsSync('assets/kiln-config.js')) {
    wrote.push('assets/kiln-config.js');
    writeFileSync('assets/kiln-config.js', `window.KILN = {
  repo:   '${repo}',
  branch: 'main',
  worker: '${workerUrl}',
  styles: [],
};
`);
    ok('wrote assets/kiln-config.js');
  } else ok('assets/kiln-config.js already present (left untouched)');
  if (!existsSync('kiln.html')) {
    wrote.push('kiln.html');
    writeFileSync('kiln.html', `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Sign in · Kiln</title>
</head><body>
<!-- Kiln entry point. Visiting /kiln shows the sign-in; there is no edit button on the site. -->
<script src="/assets/kiln-config.js"></script>
<script src="/assets/kiln.js" defer></script>
</body></html>
`);
    ok('wrote kiln.html (your /kiln sign-in page)');
  } else ok('kiln.html already present (left untouched)');
  // Exclude Kiln's own scaffold pages: kiln.html (just written) always references
  // kiln.js, so counting it would falsely report the site as wired when the real
  // content pages still aren't.
  const wired = readdirSync('.').filter(f => f.endsWith('.html') && !['kiln.html', 'members-login.html'].includes(f))
    .some(f => readFileSync(f, 'utf8').includes('kiln.js'));
  if (!wired) {
    warn('No page loads kiln.js yet. Add to every page before </body>:');
    console.log('     <script src="/assets/kiln-config.js"></script>\n     <script src="/assets/kiln.js" defer></script>');
    info('Tip: paste KILN_PROMPT.md into your AI tool and it does this + data-cms annotations for you.');
  } else ok('pages already load kiln.js');
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
    const { autotag } = await import(new URL('../src/autotag.js', import.meta.url));
    let tagged = 0;
    for (const f of readdirSync('.').filter(x => x.endsWith('.html') && !['kiln.html', 'members-login.html'].includes(x))) {
      const raw = readFileSync(f, 'utf8');
      const { html, counts } = autotag(raw);
      if (html !== raw) { writeFileSync(f, html); taggedFiles.push(f); tagged += counts.fields + counts.images + counts.repeats + counts.menu; }
    }
    ok(`auto-tagged ${tagged} things — review with: git diff   (undo: git checkout -- .)`);
    info('subfolders too? run: npx github:kilncms/kiln tag');
  }
  return taggedFiles;
}

/** Kiln Cloud / Managed prep: we run the worker + GitHub App, so this only
 *  points your repo at our infrastructure and wires the files. No Cloudflare
 *  login, no worker deploy, no app registration. */
async function cloudPrep(repo) {
  const WORKER = 'https://auth.kilncms.com';
  const APP = 'https://github.com/apps/kiln-cms/installations/new';
  const DASH = 'https://app.kilncms.com';
  hr('Kiln Cloud — prep your repo');
  info('We run the sign-in & commit worker and the GitHub App. This just points');
  info('your repo at them and wires the editor files. No Cloudflare login needed.\n');

  const kilnFiles = wireSite(repo, WORKER);
  kilnFiles.push(...await offerAutotag());

  hr('Done — 2 clicks left (in your browser)');
  console.log(`
  1. Install the Kiln GitHub App on THIS repo (choose "Only select repositories"):
     ${APP}
  2. Subscribe and add your site (repo + live URL) at:
     ${DASH}

  Commit & push the changes this made, connect your repo to a host that
  auto-deploys on push (Cloudflare Pages recommended), then edit at
  yoursite.com/kiln.  Health-check any time:  npx github:kilncms/kiln doctor
`);
  if (await yes('Commit and push the Kiln wiring now?', 'y')) {
    commitAndPush(kilnFiles, 'Add Kiln (Cloud)');
  }
  process.exit(0);
}

async function wizard() {
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

  // Cloud/Managed: everything past here (worker, app, Pages) is ours to run.
  if (isCloud) return cloudPrep(repo);

  // 2. Worker
  hr('Step 2 · Deploy your Kiln auth worker (free Cloudflare Worker)');
  const workerDir = 'kiln-worker';
  // The worker is multi-module: worker/index.js imports ./cloud.js (which imports
  // ./runbook.js) and ../src/engine.js (which imports the npm package parse5).
  // So the generated directory mirrors the kiln repo layout — kiln-worker/worker/*
  // + kiln-worker/src/engine.js — keeping every relative import intact, and gets
  // its own package.json so wrangler's bundler resolves parse5 from a local
  // node_modules. wrangler.toml points main at worker/index.js.
  mkdirSync(path.join(workerDir, 'worker'), { recursive: true });
  mkdirSync(path.join(workerDir, 'src'), { recursive: true });
  const putIfMissing = (from, to) => { if (existsSync(to)) return 0; cpSync(from, to); return 1; };
  let copied = 0;
  for (const f of ['index.js', 'cloud.js', 'runbook.js', 'cloud-schema.sql']) {
    copied += putIfMissing(path.join(PKG_ROOT, 'worker', f), path.join(workerDir, 'worker', f));
  }
  copied += putIfMissing(path.join(PKG_ROOT, 'src', 'engine.js'), path.join(workerDir, 'src', 'engine.js'));
  if (copied) ok(`copied worker source into ${workerDir}/ (yours to keep + redeploy)`);
  if (!existsSync(path.join(workerDir, 'package.json'))) {
    writeFileSync(path.join(workerDir, 'package.json'), JSON.stringify({
      name: 'kiln-worker', private: true, type: 'module',
      dependencies: { parse5: '^8.0.0' },
    }, null, 2) + '\n');
  }
  if (!existsSync(path.join(workerDir, 'node_modules', 'parse5'))) {
    info("installing the worker's one npm dependency (parse5)…");
    const inst = shTry('npm install --no-audit --no-fund', { cwd: workerDir });
    if (!inst.ok) {
      // Offline / npm-broken fallback: reuse the copies shipped with this kiln checkout.
      let fell = false;
      try {
        for (const m of ['parse5', 'entities']) {   // entities = parse5's only dependency
          cpSync(path.join(PKG_ROOT, 'node_modules', m), path.join(workerDir, 'node_modules', m), { recursive: true });
        }
        fell = true;
      } catch { /* handled below */ }
      if (fell) info('npm install failed — reused parse5 from the kiln package itself');
      else { fail(`npm install failed in ${workerDir}/ — run it there manually, then re-run this wizard:\n${inst.out}`); process.exit(1); }
    }
  }

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
      fail(`Timed out waiting for the GitHub App registration.\n  Finish it at ${workerUrl}/setup, then re-run: npx github:kilncms/kiln`);
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
      fail(`Timed out waiting for ${project}.pages.dev.\n  Finish Connect-to-Git in the Cloudflare dashboard, then re-run: npx github:kilncms/kiln`);
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
  const kilnFiles = wireSite(repo, workerUrl);

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
      else warn('secrets set but worker still reports unconfigured — rerun: npx kiln doctor');
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
  Check up  npx github:kilncms/kiln doctor
  Annotate  sign in → ✨ Make text/images editable (click sections to tag them),
            or paste KILN_PROMPT.md into your AI to bulk-tag every page
`);
  process.exit(0);
}

// ─── tag: heuristic first-pass auto-tagger ───────────────────────────────────

async function tagCmd(args) {
  const { autotag } = await import(new URL('../src/autotag.js', import.meta.url));
  hr(args.dry ? 'Auto-tag (dry run)' : 'Auto-tag');
  const files = [];
  (function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') || ['node_modules', '_templates', 'functions', 'assets', 'dist', 'build', 'public', 'out', '_site', '.git'].includes(e.name)) continue;
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.name.endsWith('.html') && !['kiln.html', 'members-login.html'].includes(e.name)) files.push(f);
    }
  })('.');
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
  const htmls = readdirSync('.').filter(f => f.endsWith('.html'));
  let prefix = null;
  for (const f of htmls) {
    const m = readFileSync(f, 'utf8').match(/src="([^"]*?)kiln\.js"/);
    if (m) { prefix = m[1]; break; }
  }
  if (prefix === null) { fail('No page here loads kiln.js — run the wizard first (npx github:kilncms/kiln).'); process.exit(1); }
  const dir = prefix.replace(/^\//, '').replace(/\/$/, '') || '.';
  mkdirSync(dir, { recursive: true });
  for (const f of ['kiln.js', 'kiln-editor.js', 'kiln-features.js']) cpSync(path.join(PKG_ROOT, 'dist', f), path.join(dir, f));
  ok(`copied the latest kiln.js + kiln-editor.js + kiln-features.js into ${dir}/`);
  if (await yes('Commit and push now?', 'y')) {
    // Add all three bundles: kiln-features.js is lazy-loaded by kiln.js, so leaving
    // it out ships a stale features runtime (e.g. event calendars) to visitors.
    const r = shTry(`git add ${dir}/kiln.js ${dir}/kiln-editor.js ${dir}/kiln-features.js && git commit -m "Update Kiln editor to latest" && git push`);
    if (r.ok) ok('pushed — your host will redeploy');
    else { fail(`commit/push didn't complete — resolve the git error above, then: git add ${dir}/kiln*.js && git commit && git push`); process.exit(1); }
  } else info('Commit + push when ready and your host will redeploy.');
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
const args = Object.fromEntries(rest.map(a => a.split('=')).map(([k, v]) => [k.replace(/^--/, ''), v ?? true]));
if (cmd === 'doctor') doctor(args);
else if (cmd === 'tag') tagCmd(args);
else if (cmd === 'update') update();
else if (cmd === 'add-site') addSiteCloud();
else wizard();
