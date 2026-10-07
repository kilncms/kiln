#!/usr/bin/env node
/**
 * check-links — every link in the repository's markdown points at something.
 *
 *   node scripts/check-links.mjs              files and #headings (offline; CI runs this on every push)
 *   node scripts/check-links.mjs --external   also request every http(s) link (the weekly job)
 *
 * Checked: [text](target), ![alt](target), <a href>, <img src>, and reference
 * definitions, in every tracked *.md file. A relative target must be a file or
 * directory in the repository (in a sample site, one with its own public/
 * folder, /img/x.png is a file in that folder, as the site serves it); a
 * #fragment must be a heading in the file it
 * points at, by GitHub's own slug rule. Code blocks and inline code are
 * skipped. Exits 1 and lists file:line for each broken link.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** GitHub's heading anchor: lower-case, drop everything but letters, digits, spaces, - and _, spaces → -. */
export function slug(heading) {
  return heading.trim().toLowerCase()
    .replace(/<[^>]+>/g, '')                       // inline HTML
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')     // links keep their text
    .replace(/[`*~]/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/** Blank out fenced and inline code, keeping line numbers. */
export function withoutCode(text) {
  let fence = null;
  return text.split('\n').map(line => {
    const m = /^\s{0,3}(```+|~~~+)/.exec(line);
    if (m) { if (!fence) fence = m[1][0]; else if (m[1][0] === fence) fence = null; return ''; }
    if (fence) return '';
    return line.replace(/`[^`\n]*`/g, m2 => ' '.repeat(m2.length));
  }).join('\n');
}

export function headingSlugs(text) {
  const seen = new Map();
  const out = new Set();
  for (const line of withoutCode(text).split('\n')) {
    const m = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const base = slug(m[1]);
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    out.add(n ? `${base}-${n}` : base);
  }
  // Explicit anchors work as link targets too.
  for (const m of text.matchAll(/<a\s+(?:name|id)=["']([^"']+)["']/g)) out.add(m[1]);
  return out;
}

/** Every link in a markdown text: [{ target, line }]. */
export function linksIn(text) {
  const clean = withoutCode(text);
  const found = [];
  const lineOf = (index) => clean.slice(0, index).split('\n').length;
  const add = (target, index) => { const t = target.trim().replace(/^<|>$/g, ''); if (t) found.push({ target: t, line: lineOf(index) }); };
  for (const m of clean.matchAll(/!?\[[^\]]*\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+"[^"]*")?\s*\)/g)) add(m[1], m.index);
  for (const m of clean.matchAll(/<(?:a|img)\b[^>]*?\s(?:href|src)=["']([^"']+)["']/g)) add(m[1], m.index);
  for (const m of clean.matchAll(/^\s{0,3}\[[^\]]+\]:\s*(\S+)/gm)) add(m[1], m.index);
  return found;
}

export async function check({ root = ROOT, files, external = false, fetchFn = fetch } = {}) {
  const list = files || execFileSync('git', ['-C', root, 'ls-files', '*.md'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  const broken = [];
  const slugCache = new Map();
  const slugsOf = (abs) => { if (!slugCache.has(abs)) slugCache.set(abs, headingSlugs(readFileSync(abs, 'utf8'))); return slugCache.get(abs); };
  const web = new Map();   // url → where it was first seen
  // Where a /root/address points: a sample site serves its public/ folder at /.
  const served = (abs) => {
    for (let d = path.dirname(abs); d.length > root.length && d.startsWith(root); d = path.dirname(d)) {
      if (existsSync(path.join(d, 'public'))) return path.join(d, 'public');
    }
    return root;
  };
  for (const rel of list) {
    const abs = path.join(root, rel);
    const text = readFileSync(abs, 'utf8');
    for (const { target, line } of linksIn(text)) {
      const at = `${rel}:${line}`;
      if (/^(mailto:|tel:|data:)/i.test(target)) continue;
      if (/^https?:\/\//i.test(target)) { if (!web.has(target)) web.set(target, at); continue; }
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;   // some other scheme
      const [filePart, fragment] = target.split('#');
      let dest = abs;
      if (filePart) {
        let decoded = filePart.split('?')[0];
        try { decoded = decodeURIComponent(decoded); } catch { /* keep */ }
        dest = decoded.startsWith('/') ? path.join(served(abs), decoded) : path.resolve(path.dirname(abs), decoded);
        if (!existsSync(dest)) { broken.push(`${at}  ${target}  (no such file)`); continue; }
      }
      if (fragment && statSync(dest).isFile() && dest.toLowerCase().endsWith('.md')) {
        let want = fragment;
        try { want = decodeURIComponent(fragment); } catch { /* keep */ }
        if (!slugsOf(dest).has(want.toLowerCase())) broken.push(`${at}  ${target}  (no heading "#${fragment}" in ${path.relative(root, dest)})`);
      }
    }
  }
  if (external) {
    for (const [url, at] of web) {
      // Addresses that are examples, or only exist on the reader's machine.
      if (/\/\/(localhost|127\.0\.0\.1|[^/]*\.example(\.com)?|example\.com|YOUR-|your-)/i.test(url) || /[<>{}]|…|\.\.\./.test(url)) continue;
      let status = 0;
      try {
        const res = await fetchFn(url, { method: 'GET', redirect: 'follow', headers: { 'User-Agent': 'kiln-link-check' }, signal: AbortSignal.timeout(20000) });
        status = res.status;
      } catch { status = 0; }
      // 401/403/429 mean "there, but not for a script".
      if (!(status >= 200 && status < 400) && ![401, 403, 429].includes(status)) broken.push(`${at}  ${url}  (${status ? `answered ${status}` : 'did not answer'})`);
    }
  }
  return { files: list.length, links: broken.length, broken, web: web.size };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const external = process.argv.includes('--external');
  const r = await check({ external });
  for (const b of r.broken) console.error(`✗ ${b}`);
  console.log(`${r.files} markdown files, ${r.web} distinct web links${external ? ' (requested)' : ' (not requested: pass --external)'}: ${r.broken.length ? `${r.broken.length} broken` : 'every link resolves'}`);
  process.exit(r.broken.length ? 1 : 0);
}
