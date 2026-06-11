#!/usr/bin/env node
/**
 * kiln — setup wizard + doctor.
 *
 *   npx github:erikkurtu/kiln            interactive setup in your site directory
 *   npx github:erikkurtu/kiln doctor     verify an existing Kiln installation
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

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
  return execSync(cmd, { encoding: 'utf8', stdio: opts.show ? 'inherit' : 'pipe', cwd: opts.cwd }).toString?.() ?? '';
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

  if (repo) {
    const inst = await fetchJson(`${worker}/setup/install-check?repo=${repo}`).catch(() => ({ json: {} }));
    check(`App installed on ${repo}`, !!inst.json.installed, inst.json.installed ? '' : `install: https://github.com/apps/${status.json.slug}/installations/new`);
  }

  if (site) {
    const home = await fetch(site).then(r => r.ok).catch(() => false);
    check('site is live', home);
    const boot = await fetch(`${site.replace(/\/$/, '')}/assets/kiln.js`).then(r => r.ok).catch(() => false);
    check('kiln.js served at /assets/kiln.js', boot);
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

  console.log(`\n  ${pass}/${total} checks passed${pass === total ? ' — Kiln is healthy 🔥' : ''}\n`);
  process.exit(pass === total ? 0 : 1);
}

// ─── wizard ──────────────────────────────────────────────────────────────────

async function wizard() {
  hr('Kiln setup');
  console.log(`  This wires up GitHub + Cloudflare (and optionally Google) for the site
  in the CURRENT directory. Everything scriptable happens automatically;
  you'll be asked to click exactly three green buttons along the way.\n`);

  // 0. prerequisites
  hr('Checking tools');
  if (!shTry('git --version').ok) { fail('git is required'); process.exit(1); }
  ok('git');
  const hasGh = shTry('gh --version').ok;
  info(hasGh ? 'gh CLI found' : 'gh CLI not found (fine if your site is already on GitHub)');
  info('wrangler runs via npx (no install needed)');

  // 1. GitHub repo
  hr('Step 1 · Your site on GitHub');
  let repo;
  const remote = shTry('git remote get-url origin');
  if (remote.ok && /github\.com/.test(remote.out)) {
    repo = remote.out.trim().match(/github\.com[:/]([^/]+\/[^/.]+)/)?.[1];
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
    sh(`gh repo create ${name} ${priv ? '--private' : '--public'} --source . --push`, { show: true });
    repo = sh('gh repo view --json nameWithOwner -q .nameWithOwner').trim();
    ok(`created + pushed: ${repo}`);
  }

  // 2. Worker
  hr('Step 2 · Deploy your Kiln auth worker (free Cloudflare Worker)');
  const workerDir = 'kiln-worker';
  if (!existsSync(workerDir)) {
    mkdirSync(workerDir, { recursive: true });
    cpSync(path.join(PKG_ROOT, 'worker', 'index.js'), path.join(workerDir, 'index.js'));
    ok(`copied worker source into ${workerDir}/ (yours to keep + redeploy)`);
  }
  const workerName = await ask('Worker name', 'kiln-auth');
  info('Creating the KV namespace (your browser may open for Cloudflare login)…');
  const kv = shTry(`npx wrangler kv namespace create KILN`, { cwd: workerDir });
  const kvId = kv.out.match(/id = "([a-f0-9]{32})"/)?.[1];
  if (!kvId && !/already exists/i.test(kv.out)) { fail(`KV creation failed:\n${kv.out}`); process.exit(1); }
  writeFileSync(path.join(workerDir, 'wrangler.toml'), `name = "${workerName}"
main = "index.js"
compatibility_date = "2026-06-01"

[vars]
ALLOWED_ORIGINS = "http://localhost:8788"

[[kv_namespaces]]
binding = "KILN"
id = "${kvId}"
`);
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
    await pollUntil('waiting for you to press "Create the Kiln GitHub App"',
      async () => (await fetchJson(`${workerUrl}/setup/status`)).json.configured);
  } else ok(`App already registered: ${status.json.slug}`);
  const slug = (await fetchJson(`${workerUrl}/setup/status`)).json.slug;

  hr('Step 4 · Install the App on your repo (click 2 of 3)');
  const installed = (await fetchJson(`${workerUrl}/setup/install-check?repo=${repo}`)).json.installed;
  if (!installed) {
    info(`Opening the install page — choose "Only select repositories" → ${repo}`);
    openUrl(`https://github.com/apps/${slug}/installations/new`);
    await pollUntil('waiting for the install',
      async () => (await fetchJson(`${workerUrl}/setup/install-check?repo=${repo}`)).json.installed);
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
    await pollUntil(`waiting for ${project}.pages.dev to answer`,
      () => fetch(`https://${project}.pages.dev/`).then(r => r.ok), 6000);
  }
  const siteUrl = `https://${project}.pages.dev`;

  // 5. Allow origin + (optional) custom domain
  hr('Step 6 · Allow your site to talk to the worker');
  const custom = await ask('Custom domain (Enter to skip)', '');
  const origins = [siteUrl, custom && `https://${custom.replace(/^https?:\/\//, '')}`, 'http://localhost:8788']
    .filter(Boolean).join(',');
  const toml = readFileSync(path.join(workerDir, 'wrangler.toml'), 'utf8')
    .replace(/ALLOWED_ORIGINS = ".*"/, `ALLOWED_ORIGINS = "${origins}"`);
  writeFileSync(path.join(workerDir, 'wrangler.toml'), toml);
  shTry('npx wrangler deploy', { cwd: workerDir });
  ok(`worker now accepts: ${origins}`);

  // 6. Site wiring
  hr('Step 7 · Wire the site');
  mkdirSync('assets', { recursive: true });
  for (const f of ['kiln.js', 'kiln-editor.js']) {
    cpSync(path.join(PKG_ROOT, 'dist', f), path.join('assets', f));
  }
  if (!existsSync('assets/kiln-config.js')) {
    writeFileSync('assets/kiln-config.js', `window.KILN = {
  repo:   '${repo}',
  branch: 'main',
  worker: '${workerUrl}',
  styles: [],
};
`);
    ok('wrote assets/kiln-config.js');
  } else ok('assets/kiln-config.js already present (left untouched)');
  const wired = readdirSync('.').filter(f => f.endsWith('.html'))
    .some(f => readFileSync(f, 'utf8').includes('kiln.js'));
  if (!wired) {
    warn('No page loads kiln.js yet. Add to every page before </body>:');
    console.log('     <script src="/assets/kiln-config.js"></script>\n     <script src="/assets/kiln.js" defer></script>');
    info('Tip: paste KILN_PROMPT.md into your AI tool and it does this + data-cms annotations for you.');
  } else ok('pages already load kiln.js');

  // 7. Members (optional)
  if (await yes('\nSet up a members-only area (gated pages + documents)?', 'n')) {
    cpSync(path.join(PKG_ROOT, 'demo', 'functions'), 'functions', { recursive: true });
    if (!existsSync('members-login.html')) cpSync(path.join(PKG_ROOT, 'demo', 'members-login.html'), 'members-login.html');
    mkdirSync('members', { recursive: true });
    const secret = [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('');
    for (const [k, v] of [['KILN_MEMBER_SECRET', secret], ['KILN_REPO', repo], ['KILN_WORKER', workerUrl]]) {
      spawnSync('npx', ['wrangler', 'pages', 'secret', 'put', k, '--project-name', project],
        { input: v, encoding: 'utf8' });
    }
    ok('members functions copied + 3 Pages secrets set (active after your next deploy)');
  }

  // 8. Google (optional, manual client creation — Google has no API for it)
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

  // 9. Commit + summary
  if (await yes('\nCommit and push the Kiln wiring now?', 'y')) {
    shTry('git add -A && git commit -m "Add Kiln (kilncms.pages.dev)" && git push');
    ok('pushed — Cloudflare is deploying');
  }
  hr('Done 🔥');
  console.log(`
  Site      ${siteUrl}${custom ? ` (+ https://${custom})` : ''}
  Edit it   ${siteUrl}/#edit   ← the secret knock (sign in with GitHub)
  Worker    ${workerUrl}
  People    sign in → Kiln button → People & access (Google) or link invites
  Check up  npx github:erikkurtu/kiln doctor
  Annotate  paste KILN_PROMPT.md into your AI to make pages editable
`);
  process.exit(0);
}

// ─── main ────────────────────────────────────────────────────────────────────

const [, , cmd, ...rest] = process.argv;
const args = Object.fromEntries(rest.map(a => a.split('=')).map(([k, v]) => [k.replace(/^--/, ''), v ?? true]));
if (cmd === 'doctor') doctor(args);
else wizard();
