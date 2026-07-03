/** Build kiln.js + kiln-editor.js into dist/. */
import { build, transform } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

await mkdir('dist', { recursive: true });

// Editor bundle (parse5 + dompurify + engine + UI)
const result = await build({
  entryPoints: ['src/editor/main.js'],
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2020',
  outfile: 'dist/kiln-editor.js',
  metafile: true,
  logLevel: 'silent',
});

// Boot shim (kept dependency-free; just minify)
const shim = await readFile('src/kiln.js', 'utf8');
const min = await transform(shim, { minify: true, target: 'es2017' });
await writeFile('dist/kiln.js', min.code);

// Features runtime (dependency-free; lazy-loaded by the shim when a page uses
// tags/galleries/events/doc chips)
const feats = await readFile('src/features.js', 'utf8');
const featsMin = await transform(feats, { minify: true, target: 'es2018' });
await writeFile('dist/kiln-features.js', featsMin.code);

const editorKB = (Object.values(result.metafile.outputs)[0].bytes / 1024).toFixed(1);
const shimKB = (min.code.length / 1024).toFixed(1);
const featsKB = (featsMin.code.length / 1024).toFixed(1);
console.log(`built: kiln.js ${shimKB} KB (every visitor) · kiln-features.js ${featsKB} KB (feature pages only) · kiln-editor.js ${editorKB} KB (admins/editors only)`);
