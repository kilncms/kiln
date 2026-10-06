/** Build kiln.js + kiln-editor.js into dist/. */
import { build, transform } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execSync } from 'node:child_process';

await mkdir('dist', { recursive: true });

// Version stamp: the short git sha at build time. Baked into every bundle as
// __KILN_VERSION__ and written to dist/VERSION. The editor and `kiln doctor`
// compare a site's stamped version against raw dist/VERSION on GitHub to tell a
// self-hoster when a newer editor exists. Stamp-vs-stamp (both come from the
// same build's HEAD), so a doc-only commit that doesn't rebuild won't false-fire.
//
// KILN_BUILD_VERSION, when set, IS the stamp. A release sets it once, so the
// bundles it deploys are byte for byte the ones it built; and rebuilding with
// the stamp already in dist/VERSION must reproduce the committed dist/ exactly
// (CI and scripts/release.mjs check that).
let VERSION = 'dev';
const forced = (process.env.KILN_BUILD_VERSION || '').trim();
if (forced && !/^[\w.-]{1,40}$/.test(forced)) {
  console.error(`KILN_BUILD_VERSION must be letters, digits, dot, dash or underscore (got ${JSON.stringify(forced)})`);
  process.exit(1);
}
if (forced) VERSION = forced;
else try { VERSION = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim() || 'dev'; } catch { /* no git → dev */ }
const define = { __KILN_VERSION__: JSON.stringify(VERSION) };

// Editor bundle (parse5 + dompurify + engine + UI)
const result = await build({
  entryPoints: ['src/editor/main.js'],
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2020',
  outfile: 'dist/kiln-editor.js',
  metafile: true,
  define,
  logLevel: 'silent',
});

// Boot shim (kept dependency-free; just minify)
const shim = await readFile('src/kiln.js', 'utf8');
const min = await transform(shim, { minify: true, target: 'es2017', define });
await writeFile('dist/kiln.js', min.code);

// Features runtime (dependency-free; lazy-loaded by the shim when a page uses
// tags/galleries/events/doc chips)
const feats = await readFile('src/features.js', 'utf8');
const featsMin = await transform(feats, { minify: true, target: 'es2018', define });
await writeFile('dist/kiln-features.js', featsMin.code);

await writeFile('dist/VERSION', VERSION + '\n');

const editorKB = (Object.values(result.metafile.outputs)[0].bytes / 1024).toFixed(1);
const shimKB = (min.code.length / 1024).toFixed(1);
const featsKB = (featsMin.code.length / 1024).toFixed(1);
console.log(`built: kiln.js ${shimKB} KB (every visitor) · kiln-features.js ${featsKB} KB (feature pages only) · kiln-editor.js ${editorKB} KB (admins/editors only)`);
