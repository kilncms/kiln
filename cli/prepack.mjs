#!/usr/bin/env node
/**
 * prepack — vendor the repo-root assets the wizard copies into user sites
 * (dist bundles, worker source, engine, templates) into cli/ so the published
 * @kilncms/create tarball is self-contained. Runs automatically on `npm pack` /
 * `npm publish` from cli/. The vendored copies are gitignored; the repo root
 * stays the source of truth.
 */
import { cpSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const items = [
  ['dist', 'dist'],
  ['templates', 'templates'],
  ['src/engine.js', 'src/engine.js'],
  ['src/autotag.js', 'src/autotag.js'],   // rescue.mjs auto-tags via PKG_ROOT/src/autotag.js
  ['src/builder-words.js', 'src/builder-words.js'],   // autotag.js imports it
  ['src/adapters', 'src/adapters'],       // source mode: wizard detection + doctor + worker copy step
  ['src/file-policy.js', 'src/file-policy.js'],   // imported by worker/index.js — wizard deploy fails without it
  ['worker/index.js', 'worker/index.js'],
  ['worker/cloud.js', 'worker/cloud.js'],
  ['worker/runbook.js', 'worker/runbook.js'],
  ['worker/sanitize-guard.js', 'worker/sanitize-guard.js'], // imported by worker/index.js — wizard deploy fails without it
  ['worker/mail.js', 'worker/mail.js'],                     // imported by worker/cloud.js
  ['worker/hosting.js', 'worker/hosting.js'],               // ditto — copying a hosted site's files to Cloudflare
  ['worker/hosted.js', 'worker/hosted.js'],                 // ditto — the record of hosted sites, the push webhook, the sweep
  ['worker/domain-mail.js', 'worker/domain-mail.js'],       // imported by worker/cloud.js: one forwarded email address on a hosted site's own domain
  ['worker/domain.js', 'worker/domain.js'],                 // imported by worker/cloud.js: a hosted site on its owner's own domain
  ['worker/bring.js', 'worker/bring.js'],                   // imported by worker/cloud.js and worker/index.js: bringing a site in from somewhere else, copied by a job outside the service
  ['worker/keeps.js', 'worker/keeps.js'],                   // imported by worker/cloud.js and worker/index.js: a site whose files Kiln keeps, for someone with no GitHub account
  ['worker/prepare.js', 'worker/prepare.js'],               // ditto — adding Kiln to a repository from the dashboard
  ['worker/firstpass.js', 'worker/firstpass.js'],           // ditto — the first pass at what can be edited (uses src/autotag.js)
  ['worker/sitecheck.js', 'worker/sitecheck.js'],           // ditto — the "Check this site" checklist
  ['worker/section-scope.js', 'worker/section-scope.js'],   // ditto — section limits on page writes
  ['worker/source.js', 'worker/source.js'],                 // ditto — source-mode endpoints
  ['worker/lookafter.js', 'worker/lookafter.js'],           // imported by worker/cloud.js and worker/hosted.js: a hosted site gets Kiln, a character set, a first pass and a current editor by itself
  ['worker/signin-trouble.js', 'worker/signin-trouble.js'],     // imported by worker/index.js: the page a person sees when the last step of a sign-in fails
  ['worker/update.js', 'worker/update.js'],                 // imported by worker/cloud.js: updating the editor in a repository from the dashboard
  ['LICENSE', 'LICENSE'],
];

// What this script puts into cli/. All of it is generated and gitignored.
const VENDORED = ['dist', 'templates', 'src', 'worker', 'LICENSE'];
for (const dir of VENDORED) {
  rmSync(path.join(HERE, dir), { recursive: true, force: true });
}
// `node prepack.mjs --clean` (npm runs it as postpack) only removes them.
// Left in place they would shadow the repository's own dist/, worker/ and
// templates/ for anyone running cli/index.mjs from this checkout afterwards.
if (process.argv.includes('--clean')) process.exit(0);

for (const [from, to] of items) {
  const src = path.join(ROOT, from);
  if (!existsSync(src)) {
    console.error(`prepack: missing ${src} — run \`npm run build\` at the repo root first`);
    process.exit(1);
  }
  cpSync(src, path.join(HERE, to), { recursive: true });
}
console.log('prepack: vendored dist/, worker/, src/engine.js, templates/ into cli/');
