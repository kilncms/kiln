#!/usr/bin/env node
/**
 * prepack — vendor the repo-root assets the wizard copies into user sites
 * (dist bundles, worker source, engine, templates) into cli/ so the published
 * create-kiln tarball is self-contained. Runs automatically on `npm pack` /
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
  ['worker/index.js', 'worker/index.js'],
  ['worker/cloud.js', 'worker/cloud.js'],
  ['worker/runbook.js', 'worker/runbook.js'],
  ['worker/cloud-schema.sql', 'worker/cloud-schema.sql'],
];

for (const dir of ['dist', 'templates', 'src', 'worker']) {
  rmSync(path.join(HERE, dir), { recursive: true, force: true });
}
for (const [from, to] of items) {
  const src = path.join(ROOT, from);
  if (!existsSync(src)) {
    console.error(`prepack: missing ${src} — run \`npm run build\` at the repo root first`);
    process.exit(1);
  }
  cpSync(src, path.join(HERE, to), { recursive: true });
}
console.log('prepack: vendored dist/, worker/, src/engine.js, templates/ into cli/');
