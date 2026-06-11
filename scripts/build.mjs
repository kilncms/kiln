/** Build kiln.js + kiln-editor.js into dist/ and sync into demo/assets/. */
import { build, transform } from 'esbuild';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
await mkdir('demo/assets', { recursive: true });

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

await copyFile('dist/kiln.js', 'demo/assets/kiln.js');
await copyFile('dist/kiln-editor.js', 'demo/assets/kiln-editor.js');

const editorKB = (Object.values(result.metafile.outputs)[0].bytes / 1024).toFixed(1);
const shimKB = (min.code.length / 1024).toFixed(1);
console.log(`built: kiln.js ${shimKB} KB (every visitor) · kiln-editor.js ${editorKB} KB (admins/editors only)`);
