/**
 * Generator detection heuristics (SOURCE-MODE-SPEC §7.1) — standalone so the
 * EDITOR bundle and the CLI can run detection without dragging in the YAML
 * machinery the full adapters need. The adapter modules delegate here; keep
 * every signal in this one table.
 */

const SIGNALS = [
  {
    id: 'astro', displayName: 'Astro',
    score(list) {
      let s = 0;
      if (list.some(f => /^astro\.config\.(mjs|js|cjs|ts|mts)$/i.test(f))) s += 0.6;
      if (list.some(f => /^src\/content(\/|$)/.test(f) || /^src\/content\.config\.(ts|mjs|js)$/.test(f))) s += 0.25;
      if (list.some(f => /^src\/pages(\/|$)/.test(f))) s += 0.15;
      return s;
    },
  },
  {
    id: 'eleventy', displayName: 'Eleventy',
    score(list) {
      return list.some(f => /^(\.eleventy\.js|eleventy\.config\.(js|mjs|cjs))$/i.test(f)) ? 0.8 : 0;
    },
  },
  {
    id: 'hugo', displayName: 'Hugo',
    score(list) {
      const cfg = list.some(f => /^(config|hugo)\.(toml|ya?ml|json)$/i.test(f));
      const dirs = list.some(f => /^content(\/|$)/.test(f)) && list.some(f => /^layouts(\/|$)/.test(f));
      return cfg && dirs ? 0.8 : 0;
    },
  },
  {
    id: 'jekyll', displayName: 'Jekyll',
    score(list) {
      return list.some(f => /^_config\.ya?ml$/i.test(f)) && list.some(f => /^_posts(\/|$)/.test(f)) ? 0.8 : 0;
    },
  },
];

/** [{ id, displayName, confidence }] best-first; zero scores dropped. */
export function detectGenerators(files) {
  const list = (files || []).map(String);
  return SIGNALS
    .map(s => ({ id: s.id, displayName: s.displayName, confidence: Math.min(1, s.score(list)) }))
    .filter(s => s.confidence > 0)
    .sort((a, b) => b.confidence - a.confidence);
}

export function detectScore(id, files) {
  const hit = detectGenerators(files).find(d => d.id === id);
  return hit ? hit.confidence : 0;
}

/**
 * Raw material for the §7.3 wrong-mode guard and the doctor check (§13):
 * generator tooling detected alongside committed build output.
 */
export function generatorSignals(files) {
  const list = (files || []).map(String);
  return {
    detected: detectGenerators(list),
    builtHtml: list.some(f => /^(dist|_site|build|out)\//i.test(f)),
    rootHtml: list.some(f => /^[^/]+\.html?$/i.test(f)),
  };
}
