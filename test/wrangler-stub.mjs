/**
 * A stand-in for wrangler, run in its place through KILN_WRANGLER by the
 * backup and restore tests. It plays the four commands those scripts use
 * against a JSON file (KILN_STUB_STATE: { sql, kv, fail? }) and appends every
 * invocation to KILN_STUB_LOG, one JSON array of arguments per line. It prints
 * the same kind of banner real wrangler prints before its JSON. Not a test file.
 */
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
const stateFile = process.env.KILN_STUB_STATE;
const state = JSON.parse(readFileSync(stateFile, 'utf8'));
appendFileSync(process.env.KILN_STUB_LOG, JSON.stringify(args) + '\n');
const cmd = args.slice(0, 3).join(' ');
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const banner = '\n ⛅️ wrangler 4.99.0\n───────────────────\n▲ [WARNING] Processing wrangler.toml configuration:\n\n    - "unsafe" fields are experimental and may change or break at any time.\n\n';

if (state.fail && cmd.startsWith(state.fail)) {
  process.stderr.write(`\n✘ [ERROR] ${state.failWith || 'A request to the Cloudflare API failed. Authentication error [code: 10000]'}\n\n`);
  process.exit(1);
}
// Real wrangler refuses flags a command does not have. `d1 export` has no
// --persist-to: it only reads wrangler's own local state.
if (cmd.startsWith('d1 export') && args.includes('--persist-to')) {
  process.stderr.write('\n✘ [ERROR] Unknown arguments: persist-to, persistTo\n\n');
  process.exit(1);
}
if (cmd.startsWith('d1 export')) {
  writeFileSync(flag('--output'), state.sql);
  process.stdout.write(banner + '🌀 Exporting SQL to file\nDone!\n');
} else if (cmd === 'kv key list') {
  const prefix = flag('--prefix') || '';
  const keys = Object.keys(state.kv).filter(k => k.startsWith(prefix)).sort().map(name => {
    const v = state.kv[name];
    return typeof v === 'object' && v.expiration ? { name, expiration: v.expiration } : { name };
  });
  process.stdout.write(banner + JSON.stringify(keys, null, 2) + '\n');
} else if (cmd === 'kv bulk get') {
  const out = {};
  for (const k of JSON.parse(readFileSync(args[3], 'utf8'))) {
    const v = (state.vanish || []).includes(k) ? undefined : state.kv[k];
    out[k] = { value: v === undefined ? null : (typeof v === 'object' ? v.value : v) };
  }
  process.stdout.write(banner + JSON.stringify(out, null, 2) + '\n');
} else if (cmd === 'kv bulk put') {
  for (const e of JSON.parse(readFileSync(args[3], 'utf8'))) state.kv[e.key] = e.expiration ? { value: e.value, expiration: e.expiration } : e.value;
  writeFileSync(stateFile, JSON.stringify(state));
  process.stdout.write(banner + 'Success!\n');
} else {
  process.stderr.write(`✘ [ERROR] the stub does not play: wrangler ${args.join(' ')}\n`);
  process.exit(1);
}
