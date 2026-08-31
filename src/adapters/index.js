/**
 * Source-mode adapter registry (SOURCE-MODE-SPEC §4.2).
 *
 * An adapter teaches Kiln one source format. Adapters are pure modules over
 * text — no network, no filesystem, no credentials. Ship order per §16:
 * astro first; data-file, eleventy, hugo, jekyll follow.
 */

import astro from './astro.js';
import { generatorSignals as _generatorSignals } from './detect.js';

const ADAPTERS = new Map([[astro.id, astro]]);

export function getAdapter(id) {
  return ADAPTERS.get(String(id || '')) || null;
}

export function adapterIds() {
  return [...ADAPTERS.keys()];
}

/**
 * Run every adapter's detect() over a shallow file listing (§7.1).
 * Returns [{ id, displayName, confidence }] sorted best-first, zeros dropped.
 */
export function detectAll(files) {
  const out = [];
  for (const a of ADAPTERS.values()) {
    let confidence = 0;
    try { confidence = Number(a.detect(files)) || 0; } catch { confidence = 0; }
    if (confidence > 0) out.push({ id: a.id, displayName: a.displayName, confidence });
  }
  return out.sort((x, y) => y.confidence - x.confidence);
}

/**
 * Generator tripwire for the §7.3 guard and the doctor check (§13). Delegates
 * to the standalone detect module (which knows generators the full adapter set
 * does not implement yet — a Hugo repo should trip the guard even before a
 * Hugo adapter exists).
 */
export const generatorSignals = _generatorSignals;
