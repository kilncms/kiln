/**
 * Kiln site configuration — one file for the whole site.
 * Every page loads this before /assets/kiln.js.
 */
window.KILN = {
  repo:   'erikkurtu/kiln-demo',
  branch: 'main',
  worker: 'https://kiln-auth.erikkwilder.workers.dev',

  // The text styles editors may apply (classes defined in your site's CSS).
  // Typography stays designed; editors pick from your palette.
  styles: [
    { label: 'Accent',    class: 'accent' },
    { label: 'Highlight', class: 'hl' },
    { label: 'Quiet',     class: 'quiet' },
  ],
};
