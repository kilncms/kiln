/**
 * KLR-07 — the editor's "a newer Kiln editor is available" notice reads what
 * was released, not whatever is on main, and names the command that fetches
 * the released tool. The guides and the CLI's own messages name it too.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { latestStamp, isStale, STAMP_URLS, UPDATE_COMMAND } from '../src/editor/update-check.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RELEASE = 'https://raw.githubusercontent.com/kilncms/kiln/release/dist/VERSION';
const MAIN = 'https://raw.githubusercontent.com/kilncms/kiln/main/dist/VERSION';

/** GitHub's raw file host, played by a table of url → text | status | 'down'. */
function raw(table) {
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(url);
    const hit = table[url];
    if (hit === 'down') throw new TypeError('fetch failed');
    if (typeof hit === 'number') return new Response('nope', { status: hit });
    return new Response(`${hit}\n`, { status: 200 });
  };
  return { fetchImpl, asked };
}

test('KLR-07 editor: "latest" is the stamp on the release branch, and main is not even asked', async () => {
  const { fetchImpl, asked } = raw({ [RELEASE]: 'rel1111', [MAIN]: 'main999' });
  assert.equal(await latestStamp(fetchImpl), 'rel1111');
  assert.deepEqual(asked, [RELEASE]);
  assert.deepEqual(STAMP_URLS, [RELEASE, MAIN]);
});

test('KLR-07 editor: work on main that has not been released is not offered as an update', async () => {
  const { fetchImpl } = raw({ [RELEASE]: 'rel1111', [MAIN]: 'main999' });
  const latest = await latestStamp(fetchImpl);
  assert.equal(isStale('rel1111', latest), false, 'a site on the released editor is current');
  assert.equal(isStale('old0000', latest), true);
});

test('KLR-07 editor: only a repository with no release branch falls back to main', async () => {
  const fork = raw({ [RELEASE]: 404, [MAIN]: 'main999' });
  assert.equal(await latestStamp(fork.fetchImpl), 'main999');
  assert.deepEqual(fork.asked, [RELEASE, MAIN]);
});

test('KLR-07 editor: a release branch that fails to answer is not replaced by main, so no false notice', async () => {
  for (const release of ['down', 429, 500, 503]) {
    const { fetchImpl, asked } = raw({ [RELEASE]: release, [MAIN]: 'main999' });
    assert.equal(await latestStamp(fetchImpl), null, String(release));
    assert.deepEqual(asked, [RELEASE], String(release));
  }
  // …and something that is not a stamp (a sign-in page, an error page) is nothing.
  assert.equal(await latestStamp(raw({ [RELEASE]: '<html>Sign in</html>' }).fetchImpl), null);
  assert.equal(await latestStamp(raw({ [RELEASE]: 404, [MAIN]: 404 }).fetchImpl), null);
});

test('KLR-07 editor: a development build, or no answer, is never called stale', () => {
  assert.equal(isStale('dev', 'rel1111'), false);
  assert.equal(isStale('', 'rel1111'), false);
  assert.equal(isStale('abc1234', null), false);
  assert.equal(isStale('abc1234', ''), false);
  assert.equal(isStale('abc1234', 'not a stamp'), false);
  assert.equal(isStale('abc1234', 'abc1234'), false);
});

test('KLR-07 editor: the notice uses the helper and names the released tool', () => {
  assert.equal(UPDATE_COMMAND, 'npx github:kilncms/kiln#release update');
  const main = readFileSync(path.join(ROOT, 'src', 'editor', 'main.js'), 'utf8');
  assert.match(main, /import \{ latestStamp, isStale, UPDATE_COMMAND \} from '\.\/update-check\.js';/);
  assert.match(main, /const latest = await latestStamp\(\);/);
  assert.doesNotMatch(main, /raw\.githubusercontent\.com/, 'main.js reads no stamp address of its own');
  assert.doesNotMatch(main, /npx github:kilncms\/kiln(?!#release)/);
});

test('KLR-07 guides: every install and update command names the release branch', () => {
  // Everything a site owner reads or is shown: the guides, the CLI's messages,
  // the worker's own pages, the editor, the templates.
  const SKIP = new Set(['node_modules', '.git', 'dist', 'test', '_gen', 'audits']);
  const files = [];
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      if (SKIP.has(name)) continue;
      const f = path.join(dir, name);
      if (statSync(f).isDirectory()) walk(f);
      else if (/\.(md|mjs|js|toml|html|plist|yml)$/.test(name) && name !== 'CHANGELOG.md') files.push(f);
    }
  })(ROOT);
  const stray = [];
  for (const f of files) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (/github:kilncms\/kiln(?!#release)/.test(line)) stray.push(`${path.relative(ROOT, f)}:${i + 1}: ${line.trim().slice(0, 100)}`);
    });
  }
  assert.deepEqual(stray, [], 'these still fetch the tool from main');
  assert.ok(files.length > 40, 'the walk found the repository');
});
