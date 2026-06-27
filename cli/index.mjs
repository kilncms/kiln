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
    const boot = await fetch(kjUrl).then(r => r.ok).catch(() => false);
    check('kiln.js loads', boot, kjMatch ? kjMatch[1] : 'no kiln.js <script> found on the homepage');

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
  if (!existsSync('kiln.html')) {
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
  const wired = readdirSync('.').filter(f => f.endsWith('.html'))
    .some(f => readFileSync(f, 'utf8').includes('kiln.js'));
  if (!wired) {
    warn('No page loads kiln.js yet. Add to every page before </body>:');
    console.log('     <script src="/assets/kiln-config.js"></script>\n     <script src="/assets/kiln.js" defer></script>');
    info('Tip: paste KILN_PROMPT.md into your AI tool and it does this + data-cms annotations for you.');
  } else ok('pages already load kiln.js');

  // 7. Members (optional)
  if (await yes('\nSet up a members-only area (gated pages + documents)?', 'n')) {
    cpSync(path.join(PKG_ROOT, 'templates', 'functions'), 'functions', { recursive: true });
    if (!existsSync('members-login.html')) cpSync(path.join(PKG_ROOT, 'templates', 'members-login.html'), 'members-login.html');
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
    shTry(`git add -A && git commit -m "Add Kiln (${siteUrl})" && git push`);
    ok('pushed — Cloudflare is deploying');
  }
  hr('Done 🔥');
  console.log(`
  Site      ${siteUrl}${custom ? ` (+ https://${custom})` : ''}
  Edit it   ${siteUrl}/kiln   ← sign in here to start editing (no edit button on the site)
  Worker    ${workerUrl}
  People    sign in → People & access → add editors/members by email (Google sign-in)
  Check up  npx github:kilncms/kiln doctor
  Annotate  paste KILN_PROMPT.md into your AI to make pages editable
`);
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
  for (const f of ['kiln.js', 'kiln-editor.js']) cpSync(path.join(PKG_ROOT, 'dist', f), path.join(dir, f));
  ok(`copied the latest kiln.js + kiln-editor.js into ${dir}/`);
  if (await yes('Commit and push now?', 'y')) {
    shTry(`git add ${dir}/kiln.js ${dir}/kiln-editor.js && git commit -m "Update Kiln editor to latest" && git push`);
    ok('pushed — your host will redeploy');
  } else info('Commit + push when ready and your host will redeploy.');
  process.exit(0);
}

// ─── add-site (Kiln Cloud) ───────────────────────────────────────────────────

async function addSiteCloud() {
  hr('Add this site to Kiln Cloud');
  const dash = 'https://app.kilncms.com';
  const remote = shTry('git remote get-url origin');
  const repo = remote.ok ? (remote.out.trim().match(/github\.com[:/]([^/]+\/[^/.]+)/)?.[1] || '') : '';
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
else if (cmd === 'update') update();
else if (cmd === 'add-site') addSiteCloud();
else wizard();
