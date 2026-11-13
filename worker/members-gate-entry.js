/**
 * The members gate of a site Kiln hosts, as one Worker module.
 *
 * A site on Cloudflare Pages gets its members area from the four files under
 * templates/functions/, which Pages runs for the site. A site on Kiln's own
 * hosting is a Worker that Kiln uploads (worker/hosting.js), and Pages
 * functions do not run there. This file is the same gate for that Worker: it
 * imports those very files, so there is one copy of the logic, and only adds
 * what Pages does by its folder names: which file answers which address.
 * "Let it through" is the site's own files, `env.ASSETS.fetch(request)`.
 *
 * It is not uploaded as it stands. scripts/build-members-gate.mjs bundles it
 * into one text, worker/members-gate.js, and hosting.js sends that text. Change
 * this file or the files it imports, then run `npm run build`.
 *
 * Cloudflare runs it only for the addresses hosting.js names in
 * `run_worker_first` (GATE_PATHS). Every other page is served as a plain file
 * and never comes here. What the Worker is given:
 *   ASSETS               the site's files
 *   KILN_WORKER          the address of the Kiln service
 *   KILN_MEMBER_SECRET   this site's secret, which signs its members' cookies
 */
import { onRequest as percentDoor } from '../templates/functions/_middleware.js';
import { onRequest as membersGate } from '../templates/functions/members/_middleware.js';
import { onRequestPost as redeemGoogle } from '../templates/functions/api/member-redeem-google.js';

export default {
  async fetch(request, env) {
    const files = () => env.ASSETS.fetch(request);
    // The front door first, as on Pages: an address written with %-codes that
    // decodes into the members area is sent to its plain form, and one that
    // reaches here in another letter case is sent to the lowercase one.
    return percentDoor({
      request, env,
      next: () => {
        const path = new URL(request.url).pathname;
        if (/^\/members(\/|$)/.test(path)) return membersGate({ request, env, next: files });
        if (path === '/api/member-redeem-google' && request.method === 'POST') return redeemGoogle({ request, env });
        return files();
      },
    });
  },
};
