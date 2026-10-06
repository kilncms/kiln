#!/usr/bin/env node
/**
 * pack-license — put the repository's LICENSE into a package's folder while
 * npm packs it, and take it out again afterwards. A package's `prepack` runs
 * this from its own folder; `postpack` runs it with --clean. npm includes a
 * LICENSE file in every tarball, so each published package carries the licence
 * without three copies of it living in the repository.
 */
import { copyFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(process.cwd(), 'LICENSE');
if (path.resolve(process.cwd()) === ROOT) { console.error('pack-license runs from a package folder, not the repository root.'); process.exit(1); }
if (process.argv.includes('--clean')) rmSync(target, { force: true });
else copyFileSync(path.join(ROOT, 'LICENSE'), target);
