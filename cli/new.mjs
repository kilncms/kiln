/**
 * kiln new — start a fresh site from a template repo.
 *
 * Copies a template (default: the live Kiln demo site) into a new folder,
 * strips the template's identity — git history, repo/worker config, demo
 * sandbox flag, site name — stamps yours on it, and prints the hand-off to
 * the setup wizard for the parts that need accounts (worker, GitHub App,
 * allowlist, Pages).
 *
 *   npx github:kilncms/kiln new [dir] [--from=owner/repo] [--name="Site title"] [--dry]
 *
 * The pure helpers (depersonalizeConfig, setConfigSiteName, titleOf,
 * siteNameOf, personalizeHtml, checkTargetDir) are exported for tests —
 * no network or prompts there.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const DEFAULT_TEMPLATE = 'kilncms/kiln-demo';
export const REPO_PLACEHOLDER = 'YOUR-GITHUB-USER/YOUR-REPO';
const UA = 'kiln-new/0.1 (+https://kilncms.com)';

const ok = (s) => console.log(`  ✅ ${s}`);
const info = (s) => console.log(`  ▸ ${s}`);
const warn = (s) => console.log(`  ⚠️  ${s}`);
const fail = (s) => console.log(`  ❌ ${s}`);
const hr = (s) => console.log(`\n━━ ${s} ${'━'.repeat(Math.max(2, 56 - s.length))}`);
// lazy readline: only opened when we actually prompt, so importing this module
// (tests) never touches stdin
let rl;
const ask = async (q, dflt) => {
  rl ||= createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`${q}${dflt !== undefined ? ` [${dflt}]` : ''}: `)).trim();
  return a || dflt || '';
};
/** run a command with argv-array args (no shell — dir names can't break quoting) */
const run = (cmd, argv, cwd) => {
  const r = spawnSync(cmd, argv, { cwd, encoding: 'utf8', stdio: 'pipe' });
  return { ok: r.status === 0 && !r.error, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
};

// ─── pure: target-dir validation ─────────────────────────────────────────────

/** A usable target: doesn't exist yet, or exists as an empty directory. */
export function checkTargetDir(dir) {
  if (!dir || !String(dir).trim()) return { ok: false, reason: 'no directory given' };
  if (!existsSync(dir)) return { ok: true };
  let st; try { st = statSync(dir); } catch { return { ok: false, reason: 'exists but is not readable' }; }
  if (!st.isDirectory()) return { ok: false, reason: 'already exists and is a file' };
  if (readdirSync(dir).length) return { ok: false, reason: 'already exists and is not empty' };
  return { ok: true };
}

// ─── pure: kiln-config.js de-personalization ─────────────────────────────────

/**
 * Reset the template's wiring in assets/kiln-config.js so the scaffold never
 * talks to the template's backend: repo → placeholder, worker → '', any
 * `sandbox: true` line removed (demo-only flag). Everything else — spacing,
 * quote style, unknown keys — is preserved byte-for-byte.
 * Returns { src, changes } where changes are human-readable diff lines.
 */
export function depersonalizeConfig(src) {
  const changes = [];
  let out = src.replace(/(\brepo\s*:\s*)(['"])([^'"]*)\2/, (m, pre, q, val) => {
    if (val === REPO_PLACEHOLDER) return m;
    changes.push(`repo: '${val}' → '${REPO_PLACEHOLDER}'`);
    return pre + q + REPO_PLACEHOLDER + q;
  });
  out = out.replace(/(\bworker\s*:\s*)(['"])([^'"]*)\2/, (m, pre, q, val) => {
    if (val === '') return m;
    changes.push(`worker: '${val}' → '' (the wizard fills this in)`);
    return pre + q + q;
  });
  // own-line form first (takes the demo comment with it); a line that carries
  // other keys too falls through to the inline form, which removes just the pair
  out = out.replace(/^[^\S\n]*sandbox\s*:\s*true\s*,?\s*(?:\/\/[^\n]*)?(?:\n|$)/gm, () => {
    changes.push('sandbox: true — line removed (demo-only flag)');
    return '';
  });
  out = out.replace(/\bsandbox\s*:\s*true\s*,?\s*/g, () => {
    changes.push('sandbox: true — removed (demo-only flag)');
    return '';
  });
  return { src: out, changes };
}

/** Point the config's siteName at the chosen title (quote style preserved). */
export function setConfigSiteName(src, name) {
  const m = src.match(/(\bsiteName\s*:\s*)(['"])([^'"]*)\2/);
  if (!m || m[3] === name) return { src, changed: false };
  const lit = String(name).replace(/\\/g, '\\\\').replaceAll(m[2], '\\' + m[2]);
  return { src: src.replace(m[0], () => m[1] + m[2] + lit + m[2]), changed: true };
}

// ─── pure: title personalization ─────────────────────────────────────────────

/** Text of the first <title> tag, trimmed. null = page has none. */
export function titleOf(html) {
  const m = String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].trim() : null;
}

/** "Big Dill — Small-batch pickles" → "Big Dill". Splits on the first
 *  space-padded separator (— – | · - ::); no separator → the whole title. */
export function siteNameOf(title) {
  return String(title).split(/\s+(?:[—–|·-]|::)\s+/)[0].trim() || String(title).trim();
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Conservatively stamp the new site title onto one page. Only exact,
 * case-sensitive occurrences of the template's own strings are touched:
 *   - a <title> whose whole text is the template's full title → newName;
 *     otherwise the site name inside the <title> ("Our story — Big Dill")
 *   - brand marks: elements whose ENTIRE text is the site name (>Big Dill<)
 *   - the site name inside aria-label values ("Big Dill home")
 * Prose that merely mentions the name, lowercase variants, and longer words
 * containing it (Big Dillon) are left alone. Returns { html, count }.
 */
export function personalizeHtml(html, { title, name, newName }) {
  const safe = escHtml(newName);
  const bounded = new RegExp(`(?<![A-Za-z0-9])${escRe(name)}(?![A-Za-z0-9])`, 'g');
  let count = 0;
  const sub = (text) => text.replace(bounded, () => (count++, safe));
  let out = String(html).replace(/(<title[^>]*>)([\s\S]*?)(<\/title>)/gi, (m, open, text, close) => {
    if (text.trim() === title) { count++; return open + safe + close; }
    return open + sub(text) + close;
  });
  out = out.replace(new RegExp(`(>\\s*)${escRe(name)}(\\s*<)`, 'g'), (m, a, b) => (count++, a + safe + b));
  out = out.replace(/(aria-label=")([^"]*)(")/g, (m, a, v, b) => a + sub(v) + b);
  return { html: out, count };
}

// ─── download ────────────────────────────────────────────────────────────────

const filesIn = (dir) => readdirSync(dir).filter((f) => f !== '.git');

function cloneTemplate(from, dir) {
  const r = run('git', ['clone', '--depth', '1', `https://github.com/${from}.git`, dir]);
  if (!r.ok) { fail(`git clone failed — ${r.out.split('\n').pop()}`); process.exit(1); }
}

async function fetchTarball(from, dir) {
  let res;
  try {
    res = await fetch(`https://api.github.com/repos/${from}/tarball`, {
      headers: { 'user-agent': UA, accept: 'application/vnd.github+json' },
      redirect: 'follow', signal: AbortSignal.timeout(60000),
    });
  } catch (e) { fail(`download failed — ${e.name === 'TimeoutError' ? 'timeout' : e.message}`); process.exit(1); }
  if (!res.ok) { fail(`download failed — HTTP ${res.status} for ${from} (is the repo public?)`); process.exit(1); }
  const tmp = path.join(tmpdir(), `kiln-new-${Date.now()}.tar.gz`);
  writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  mkdirSync(dir, { recursive: true });
  const r = run('tar', ['-xzf', tmp, '-C', dir, '--strip-components=1']);
  rmSync(tmp, { force: true });
  if (!r.ok) { fail(`could not extract the template tarball — ${r.out.split('\n').pop()}`); process.exit(1); }
}

// ─── walk + count ────────────────────────────────────────────────────────────

function* htmlFiles(root) {
  for (const e of readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) { if (!['.git', 'node_modules'].includes(e.name)) yield* htmlFiles(p); }
    else if (/\.html?$/i.test(e.name)) yield p;
  }
}

function countFiles(root) {
  let n = 0;
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (e.isDirectory()) { if (e.name !== '.git') n += countFiles(path.join(root, e.name)); }
    else n++;
  }
  return n;
}

// ─── command ─────────────────────────────────────────────────────────────────

export async function newCmd(dirArg, args = {}) {
  hr('kiln new');
  const from = typeof args.from === 'string' ? args.from : DEFAULT_TEMPLATE;
  if (!/^[\w.-]+\/[\w.-]+$/.test(from)) {
    fail(`--from must be a GitHub owner/repo (got '${from}')`);
    fail('Usage: kiln new [dir] [--from=owner/repo] [--name="Site title"] [--dry]');
    process.exit(1);
  }
  const haveGit = run('git', ['--version']).ok;

  if (args.dry) {
    hr('Plan (dry run — nothing written)');
    info(`template   ${from} (https://github.com/${from})`);
    info(`target     ${dirArg || '<dir> (will prompt)'}`);
    if (dirArg) {
      const chk = checkTargetDir(dirArg);
      chk.ok ? ok('target is free') : fail(`target ${chk.reason}`);
    }
    info(`site title ${typeof args.name === 'string' ? `'${args.name}'` : '(will prompt)'}`);
    info(`download   ${haveGit ? 'git clone --depth 1' : 'GitHub tarball (git not found)'} → strip the template's .git`);
    info(`reset      assets/kiln-config.js: repo → '${REPO_PLACEHOLDER}', worker → '', drop sandbox: true`);
    info('rename     <title> + header/menu brand strings → your site title');
    info(`git        ${haveGit ? 'init + one initial commit' : 'skipped (git not found)'}`);
    info('then       create a GitHub repo, push, and run the setup wizard (printed at the end)');
    process.exit(0);
  }

  const dir = dirArg || await ask('Directory for your new site', 'my-site');
  const chk = checkTargetDir(dir);
  if (!chk.ok) { fail(`${dir}: ${chk.reason}`); process.exit(1); }
  const suggested = path.basename(path.resolve(dir)).replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const name = (typeof args.name === 'string' && args.name.trim())
    ? args.name.trim()
    : await ask('Site title (browser tab + site header)', suggested);

  // ── download the template ──
  hr(`Downloading ${from}`);
  if (haveGit) cloneTemplate(from, dir); else await fetchTarball(from, dir);
  if (!existsSync(dir) || !filesIn(dir).length) {
    fail('the download produced an empty folder — check the template repo and try again');
    rmSync(dir, { recursive: true, force: true });
    process.exit(1);
  }
  rmSync(path.join(dir, '.git'), { recursive: true, force: true });   // template history is not yours
  ok(`scaffolded ${countFiles(dir)} files into ${dir}/`);

  // ── de-personalize the template's wiring ──
  hr('Making it yours');
  const cfgPath = path.join(dir, 'assets', 'kiln-config.js');
  let cfg = existsSync(cfgPath) ? readFileSync(cfgPath, 'utf8') : null;
  if (cfg !== null) {
    const dep = depersonalizeConfig(cfg);
    cfg = dep.src;
    dep.changes.forEach((c) => ok(`kiln-config.js: ${c}`));
    if (!dep.changes.length) info('kiln-config.js: already un-personalized — nothing to reset');
  } else warn('assets/kiln-config.js not found in this template — the setup wizard will create it');

  // ── stamp the new site title ──
  const indexPath = path.join(dir, 'index.html');
  const tplTitle = existsSync(indexPath) ? titleOf(readFileSync(indexPath, 'utf8')) : null;
  if (!existsSync(indexPath)) warn('no index.html in this template — skipped the title rename');
  else if (!tplTitle) warn('index.html has no <title> — skipped the title rename');
  else if (tplTitle === name) info(`site title already '${name}' — nothing to rename`);
  else {
    const tplName = siteNameOf(tplTitle);
    let replaced = 0, pages = 0;
    for (const file of htmlFiles(dir)) {
      const src = readFileSync(file, 'utf8');
      const { html, count } = personalizeHtml(src, { title: tplTitle, name: tplName, newName: name });
      if (count) { writeFileSync(file, html); replaced += count; pages++; }
    }
    ok(`renamed '${tplName}' → '${name}' — ${replaced} replacement${replaced === 1 ? '' : 's'} across ${pages} page${pages === 1 ? '' : 's'}`);
    info('(only exact title/brand strings — the template\'s placeholder content is yours to edit)');
  }
  if (cfg !== null) {
    const sn = setConfigSiteName(cfg, name);
    if (sn.changed) { cfg = sn.src; ok(`kiln-config.js: siteName → '${name}'`); }
    writeFileSync(cfgPath, cfg);
  }

  // ── fresh git history ──
  if (haveGit) {
    if (!run('git', ['init', '-b', 'main'], dir).ok) run('git', ['init'], dir);   // old git: no -b
    run('git', ['add', '-A'], dir);
    const c = run('git', ['commit', '-m', `New site from ${from} (kiln new)`], dir);
    if (c.ok) ok('git initialized — one initial commit');
    else warn(`git init done but the first commit failed (${c.out.split('\n').pop()}) — commit manually: git add -A && git commit -m "New site"`);
  } else warn('git not found — after installing git: git init -b main && git add -A && git commit -m "New site"');

  // ── hand-off ──
  const repoName = path.basename(path.resolve(dir));
  hr('Next steps');
  console.log(`  Your site lives in ${dir}/. To put it online:

  1. Create a GitHub repo and push:
       cd ${dir}
       gh repo create ${repoName} --private --source=. --push
     …or without the gh CLI: create an empty repo at https://github.com/new, then
       git remote add origin https://github.com/YOUR-GITHUB-USER/${repoName}.git
       git push -u origin main

  2. Run the setup wizard — it deploys your worker, registers the GitHub App,
     sets the editor allowlist, and connects free hosting (Cloudflare Pages):
       cd ${dir} && npx github:kilncms/kiln
`);
  process.exit(0);
}
