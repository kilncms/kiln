/**
 * Boot proof: spawn the real `node index.mjs` process, speak raw MCP over
 * stdio (newline-delimited JSON-RPC: initialize → initialized → tools/list),
 * and assert the four tools come back. No client SDK — this exercises exactly
 * what `claude mcp add … -- npx kiln-mcp` exercises. No network: listing tools
 * makes no worker calls, so a dead worker URL is fine.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const entry = join(dirname(fileURLToPath(import.meta.url)), '..', 'index.mjs');

function rpc(child, msg) {
  child.stdin.write(JSON.stringify(msg) + '\n');
}

test('stdio boot: initialize + tools/list yields the four tools', async () => {
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, KILN_WORKER_URL: 'http://127.0.0.1:9', KILN_API_TOKEN: 'a'.repeat(64) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const responses = [];
  let buf = '';
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out; got ${responses.length} responses`)), 15_000);
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) responses.push(JSON.parse(line));
      }
      if (responses.some(r => r.id === 2)) { clearTimeout(timer); resolve(); }
    });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
  });

  rpc(child, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'boot-proof', version: '0.0.0' } },
  });
  rpc(child, { jsonrpc: '2.0', method: 'notifications/initialized' });
  rpc(child, { jsonrpc: '2.0', id: 2, method: 'tools/list' });

  try {
    await done;
  } finally {
    child.kill();
  }

  const init = responses.find(r => r.id === 1);
  assert.equal(init.result.serverInfo.name, 'kiln-mcp');
  const list = responses.find(r => r.id === 2);
  const names = list.result.tools.map(t => t.name).sort();
  assert.deepEqual(names, ['edit_fields', 'get_fields', 'list_pages', 'site_info']);
});

test('missing config fails fast on stderr with a helpful message', async () => {
  const env = { ...process.env };
  delete env.KILN_WORKER_URL;
  delete env.KILN_API_TOKEN;
  const child = spawn(process.execPath, [entry], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, 1);
  assert.match(stderr, /KILN_WORKER_URL/);
  assert.match(stderr, /KILN_API_TOKEN/);
  assert.match(stderr, /admin\/api-tokens/);
});
