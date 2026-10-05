/**
 * KLN-03 — the one URL the worker fetches on a caller's say-so (the alt-text
 * image). The host screen must hold for every spelling of a private address,
 * for IPv6, and for every redirect hop, not only the URL that was sent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aiHostBlocked, validateAiAssist } from '../worker/index.js';
import { REPO, editorEnv, withFetch, call, jsonRes, SAMPLES } from './worker-harness.js';

const blocked = (hosts) => { for (const h of hosts) assert.equal(aiHostBlocked(h), true, `should block: ${h}`); };
const allowed = (hosts) => { for (const h of hosts) assert.equal(aiHostBlocked(h), false, `should allow: ${h}`); };

test('KLN-03 aiHostBlocked: private, loopback, link-local and reserved IPv4 ranges', () => {
  blocked(['127.0.0.1', '127.255.255.254', '10.0.0.5', '10.255.255.255', '172.16.0.9', '172.31.255.1', '192.168.1.1',
    '169.254.169.254', '0.0.0.0', '0.1.2.3', '100.64.0.1', '100.127.255.255', '192.0.0.8', '192.0.2.1', '192.88.99.1',
    '198.18.0.1', '198.19.255.255', '198.51.100.7', '203.0.113.9', '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255']);
  allowed(['8.8.8.8', '93.184.216.34', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '169.253.0.1',
    '192.167.255.255', '192.169.0.1', '198.17.255.255', '198.20.0.1', '223.255.255.255', '1.1.1.1']);
});

test('KLN-03 aiHostBlocked: decimal, hex, octal and short spellings of a private IPv4 address', () => {
  // All of these are 127.0.0.1, 192.168.1.1 or 169.254.169.254. Checked on the
  // raw host string, so the answer does not lean on the URL parser to tidy it.
  blocked(['2130706433', '0x7f000001', '0X7F000001', '017700000001', '0x7f.1', '127.1', '127.0.1', '0177.0.0.1', '0x7f.0.0.1',
    '0177.0x0.0.01', '3232235777', '0xc0a80101', '030052000401', '192.168.257', '0xA9FEA9FE', '2852039166', '0251.0376.0251.0376', '169.254.43518']);
  // The same spellings of a public address are fine (8.8.8.8).
  allowed(['134744072', '0x08080808', '010.010.010.010', '8.8.2056']);
  // Looks like an address but is not one: refused rather than guessed at.
  blocked(['256.1.1.1', '1.2.3.4.5', '1..2', '4294967296', '08.8.8.8', 'foo.123', '0x']);
});

test('KLN-03 aiHostBlocked: IPv6 — loopback, unique-local, link-local, multicast, and every wrapper around IPv4', () => {
  blocked(['[::1]', '[::]', '[0:0:0:0:0:0:0:1]', '[fc00::1]', '[fd12:3456:789a::1]', '[fdff:ffff::1]', '[fe80::1]', '[febf::1]',
    '[fec0::1]', '[ff02::1]', '[ff05::2]', '[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[::ffff:10.0.0.1]', '[::ffff:a00:1]',
    '[::ffff:8.8.8.8]', '[::127.0.0.1]', '[64:ff9b::a00:1]', '[64:ff9b::7f00:1]', '[2002:7f00:1::]', '[2002:a00:1::1]',
    '[2001::1]', '[2001:0:53aa:64c::1]', '[2001:db8::1]', '[2001:10::1]', '[100::1]']);
  // Bare (no brackets) reads the same.
  blocked(['::1', 'fc00::1', 'fe80::1', '::ffff:10.0.0.1']);
  // Malformed, or carrying a zone id: refused.
  blocked(['[fe80::1%eth0]', '[1:2:3]', '[1:2:3:4:5:6:7:8:9]', '[1::2::3]', '[gggg::1]', '[12345::1]', '[1:2:3:4:5:6:7:8::9]', '[:::]']);
  allowed(['[2606:4700:4700::1111]', '[2a00:1450:4001:81b::200e]', '[2001:4860:4860::8888]', '2606:4700:4700::1111', '[2620:fe::fe]']);
});

test('KLN-03 aiHostBlocked: names that are not public hosts', () => {
  blocked(['localhost', 'LOCALHOST', 'localhost.', 'sub.localhost', 'a.b.localhost.', 'intranet', 'router', 'printer.local',
    'metadata.google.internal', 'db.internal', 'nas.lan', 'pc.home', 'x.home.arpa', 'wiki.corp', 'box.localdomain', 'app.intranet', '', ' ', '.']);
  allowed(['site.com', 'site.com.', 'cdn.example.co.uk', 'images.unsplash.com', 'localhost.example.com', 'my-local.com', 'internal.example.org', 'xn--bcher-kva.example']);
  assert.equal(aiHostBlocked(undefined), true);
  assert.equal(aiHostBlocked(null), true);
});

test('KLN-03 validateAiAssist: the screen is applied to the URL as sent', () => {
  for (const host of ['2130706433', '0x7f000001', '017700000001', '0x7f.1', '127.1', '[fc00::1]', '[fe80::1]', '[::]',
    '[::ffff:10.0.0.1]', '[64:ff9b::a00:1]', 'localhost.', 'intranet', 'db.internal', '100.64.0.1']) {
    for (const scheme of ['http', 'https']) {
      assert.equal(validateAiAssist({ kind: 'alt', imageUrl: `${scheme}://${host}/a.png` }).error, 'imageUrl host not allowed', `${scheme}://${host}`);
    }
  }
  // Credentials and ports do not change which host it is.
  assert.equal(validateAiAssist({ kind: 'alt', imageUrl: 'https://user:pw@127.0.0.1:8443/a.png' }).error, 'imageUrl host not allowed');
  assert.equal(validateAiAssist({ kind: 'alt', imageUrl: 'https://site.com@169.254.169.254/a.png' }).error, 'imageUrl host not allowed');
  assert.equal(validateAiAssist({ kind: 'alt', imageUrl: 'https://[2606:4700:4700::1111]/a.png' }).error, undefined);
  assert.equal(validateAiAssist({ kind: 'alt', imageUrl: 'https://cdn.site.com:8443/a.png' }).error, undefined);
});

// ─── every redirect hop, through the real endpoint ──────────────────────────

const aiEnv = () => Object.assign(editorEnv({ features: ['ai'] }), { AI_API_KEY: 'test-key' });
const altText = (env, imageUrl) => call(env, 'POST', '/ai/assist', { body: { repo: REPO, kind: 'alt', imageUrl } });
const redirect = (to) => new Response(null, { status: 302, headers: { Location: to } });
const image = () => new Response(SAMPLES.png, { status: 200, headers: { 'Content-Type': 'image/png' } });
const ai = () => jsonRes({ content: [{ type: 'text', text: 'A cat on a wall' }] });
const fetched = (calls, needle) => calls.filter(c => c.url.includes(needle)).length;

test('KLN-03 /ai/assist: a public URL that redirects to the link-local metadata address is refused, and never fetched', async () => {
  await withFetch(async (url) => {
    if (url.startsWith('https://img.example/')) return redirect('https://169.254.169.254/latest/meta-data/');
    if (url.startsWith('https://169.254.169.254/')) return image();
    if (url.startsWith('https://api.anthropic.com/')) return ai();
  }, async (calls) => {
    const r = await altText(aiEnv(), 'https://img.example/cat.png');
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'imageUrl host not allowed');
    assert.equal(fetched(calls, '169.254.169.254'), 0, 'the private host was never contacted');
    assert.equal(fetched(calls, 'api.anthropic.com'), 0, 'and nothing was sent to the AI');
  });
});

test('KLN-03 /ai/assist: every hop is screened — loopback, RFC 1918, IPv6 unique-local, a decimal address, a private name', async () => {
  for (const target of ['https://127.0.0.1/x.png', 'https://10.0.0.8/x.png', 'https://192.168.1.1/x.png', 'https://[fc00::1]/x.png',
    'https://[::1]/x.png', 'https://[::ffff:10.0.0.1]/x.png', 'https://2130706433/x.png', 'https://0x7f.1/x.png',
    'https://localhost/x.png', 'https://localhost./x.png', 'https://db.internal/x.png', '//10.1.2.3/x.png']) {
    await withFetch(async (url) => {
      if (url.startsWith('https://img.example/')) return redirect(target);
      if (url.startsWith('https://api.anthropic.com/')) return ai();
      return image();   // anything else that gets fetched would "work" — it must not be reached
    }, async (calls) => {
      const r = await altText(aiEnv(), 'https://img.example/cat.png');
      assert.equal(r.status, 400, target);
      assert.equal(r.json.error, 'imageUrl host not allowed', target);
      assert.deepEqual(calls.map(c => c.url), ['https://img.example/cat.png'], `only the first hop was fetched (${target})`);
    });
  }
});

test('KLN-03 /ai/assist: a private host two redirects deep is still refused', async () => {
  await withFetch(async (url) => {
    if (url === 'https://img.example/cat.png') return redirect('https://cdn.example.net/a');
    if (url === 'https://cdn.example.net/a') return redirect('https://cdn.example.org/b');
    if (url === 'https://cdn.example.org/b') return redirect('https://172.16.0.9/admin');
    if (url.startsWith('https://api.anthropic.com/')) return ai();
    return image();
  }, async (calls) => {
    const r = await altText(aiEnv(), 'https://img.example/cat.png');
    assert.equal(r.status, 400);
    assert.equal(fetched(calls, '172.16.0.9'), 0);
    assert.equal(calls.length, 3);
  });
});

test('KLN-03 /ai/assist: a redirect between public hosts still works, and off-https redirects are still refused', async () => {
  await withFetch(async (url) => {
    if (url === 'https://img.example/cat.png') return redirect('https://cdn.example.net/cat.png');
    if (url === 'https://cdn.example.net/cat.png') return image();
    if (url.startsWith('https://api.anthropic.com/')) return ai();
  }, async (calls) => {
    const r = await altText(aiEnv(), 'https://img.example/cat.png');
    assert.equal(r.status, 200);
    assert.equal(r.json.alt, 'A cat on a wall');
    assert.equal(fetched(calls, 'api.anthropic.com'), 1);
  });
  await withFetch(async (url) => {
    if (url === 'https://img.example/cat.png') return redirect('http://cdn.example.net/cat.png');
    return image();
  }, async (calls) => {
    const r = await altText(aiEnv(), 'https://img.example/cat.png');
    assert.equal(r.status, 502);
    assert.equal(r.json.error, 'could not fetch the image');
    assert.equal(calls.length, 1);
  });
});

test('KLN-03 /ai/assist: a private URL sent directly never leaves the worker', async () => {
  await withFetch(async () => image(), async (calls) => {
    for (const u of ['http://2130706433/a.png', 'https://[fe80::1]/a.png', 'https://169.254.169.254/latest/meta-data/', 'http://localhost./a.png']) {
      const r = await altText(aiEnv(), u);
      assert.equal(r.status, 400, u);
      assert.equal(r.json.error, 'imageUrl host not allowed', u);
    }
    assert.equal(calls.length, 0);
  });
});
