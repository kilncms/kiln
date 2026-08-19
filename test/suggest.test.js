import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previewUrl } from '../src/editor/suggest.js';

test('previewUrl: CF-Pages branch-alias sanitization into the template', () => {
  const t = 'https://{branch}.site.pages.dev';
  assert.equal(previewUrl('kiln-drafts', t), 'https://kiln-drafts.site.pages.dev');
  // Slashes (and any non-alphanumeric run) collapse to a single dash.
  assert.equal(previewUrl('kiln/suggest-erik', t), 'https://kiln-suggest-erik.site.pages.dev');
  assert.equal(previewUrl('Kiln/Suggest--Ana!', t), 'https://kiln-suggest-ana.site.pages.dev');
  // Leading/trailing junk trims; 28-char cap can't leave a dangling dash.
  assert.equal(previewUrl('--kiln--', t), 'https://kiln.site.pages.dev');
  const alias = previewUrl('kiln/suggest-' + 'x'.repeat(40), '{branch}');
  assert.equal(alias.length <= 28, true);
  assert.equal(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(alias), true);
  // Every {branch} occurrence substitutes (Netlify-style templates use one too).
  assert.equal(previewUrl('kiln-drafts', 'https://{branch}--site.netlify.app'), 'https://kiln-drafts--site.netlify.app');
});
