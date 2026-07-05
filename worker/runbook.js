// Operator's playbook, served only to the CLOUD_ADMIN session (see /admin/cloud/runbook).
export const RUNBOOK_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Kiln Operator's Playbook</title>
<style>
  :root{
    --ground:#f4f6f8; --panel:#ffffff; --ink:#1a2430; --muted:#5a6b7a; --faint:#8494a2;
    --line:#dbe2e8; --line-soft:#e8edf1;
    --accent:#0f766e; --accent-soft:#e2f1ef; --accent-ink:#0a5952;
    --good:#15803d; --good-soft:#e4f2e8; --warn:#b45309; --warn-soft:#fbeede; --crit:#b91c1c; --crit-soft:#fbe9e9;
    --mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;
    --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    --maxread:68ch;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--ground);color:var(--ink);font-family:var(--sans);
    font-size:16px;line-height:1.62;-webkit-font-smoothing:antialiased}
  .wrap{max-width:1180px;margin:0 auto;padding:0 28px}

  /* ---- masthead ---- */
  header.top{padding:52px 0 30px;border-bottom:1px solid var(--line)}
  .eyebrow{font-family:var(--mono);font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:var(--accent-ink)}
  h1{font-size:clamp(2rem,4.4vw,3rem);line-height:1.03;letter-spacing:-.025em;font-weight:800;margin:.35em 0 .2em;text-wrap:balance}
  .lede{color:var(--muted);max-width:60ch;font-size:1.06rem;margin:0}
  .meta{font-family:var(--mono);font-size:12px;color:var(--faint);margin-top:18px;letter-spacing:.02em}

  /* ---- headline fact cards ---- */
  .facts{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:28px 0 6px}
  @media(max-width:760px){.facts{grid-template-columns:1fr}}
  .fact{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:22px 24px;position:relative;overflow:hidden}
  .fact::before{content:"";position:absolute;left:0;top:0;bottom:0;width:4px;background:var(--accent)}
  .fact h3{margin:0 0 6px;font-size:.78rem;font-family:var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--accent-ink)}
  .fact p{margin:0;font-size:1.02rem;line-height:1.5}
  .fact strong{font-weight:700}

  /* ---- layout: index rail + column ---- */
  .grid{display:grid;grid-template-columns:210px minmax(0,1fr);gap:44px;align-items:start;padding:38px 0 80px}
  @media(max-width:900px){.grid{grid-template-columns:1fr;gap:0}}
  nav.index{position:sticky;top:20px;font-family:var(--mono);font-size:12.5px;line-height:1.5}
  @media(max-width:900px){nav.index{position:static;border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin:22px 0;background:var(--panel)}}
  nav.index .lbl{font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);margin:0 0 10px}
  nav.index a{display:flex;gap:9px;color:var(--muted);text-decoration:none;padding:3px 0;border-radius:6px}
  nav.index a .n{color:var(--faint);font-variant-numeric:tabular-nums}
  nav.index a:hover{color:var(--accent-ink)}

  main{min-width:0;max-width:var(--maxread)}
  section{padding-top:14px;scroll-margin-top:16px}
  section+section{margin-top:40px;padding-top:34px;border-top:1px solid var(--line-soft)}
  h2{font-size:1.5rem;letter-spacing:-.02em;font-weight:750;margin:0 0 4px;text-wrap:balance;display:flex;align-items:baseline;gap:12px}
  h2 .sn{font-family:var(--mono);font-size:.95rem;font-weight:600;color:var(--accent);letter-spacing:0}
  h3.sub{font-size:1.06rem;font-weight:700;margin:26px 0 6px;letter-spacing:-.01em}
  p{margin:.7em 0;max-width:var(--maxread)}
  a{color:var(--accent-ink);text-underline-offset:2px}
  strong{font-weight:650}
  code{font-family:var(--mono);font-size:.86em;background:#eef2f4;border:1px solid var(--line-soft);
    padding:.06em .38em;border-radius:5px;color:#12333a}
  em{font-style:italic;color:#38414d}

  /* ---- tables ---- */
  .tw{overflow-x:auto;margin:18px 0;border:1px solid var(--line);border-radius:12px}
  table{border-collapse:collapse;width:100%;min-width:520px;font-size:14.5px}
  th,td{text-align:left;padding:11px 15px;border-bottom:1px solid var(--line-soft);vertical-align:top;line-height:1.45}
  thead th{font-family:var(--mono);font-size:11.5px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);
    background:#eff3f5;border-bottom:1px solid var(--line)}
  tbody tr:last-child td{border-bottom:none}
  td code{white-space:nowrap}

  /* ---- callouts ---- */
  .call{border-radius:12px;padding:16px 20px;margin:20px 0;border:1px solid;font-size:15px;line-height:1.55}
  .call p{margin:.3em 0;max-width:none}
  .call .tag{font-family:var(--mono);font-size:11px;letter-spacing:.09em;text-transform:uppercase;font-weight:600;display:block;margin-bottom:5px}
  .rule{background:var(--accent-soft);border-color:#bfe0db;color:#123c37}
  .rule .tag{color:var(--accent-ink)}
  .caution{background:var(--warn-soft);border-color:#f0d3ba;color:#5c3a12}
  .caution .tag{color:var(--warn)}

  /* ---- step lists ---- */
  ol.steps{list-style:none;counter-reset:s;padding:0;margin:16px 0;max-width:var(--maxread)}
  ol.steps>li{counter-increment:s;position:relative;padding:2px 0 12px 40px;line-height:1.55}
  ol.steps>li::before{content:counter(s);position:absolute;left:0;top:0;width:26px;height:26px;border-radius:7px;
    background:var(--ink);color:#fff;font-family:var(--mono);font-size:12.5px;font-weight:600;
    display:flex;align-items:center;justify-content:center}
  ul.plain{margin:14px 0;padding-left:0;list-style:none;max-width:var(--maxread)}
  ul.plain>li{position:relative;padding-left:22px;margin:8px 0;line-height:1.55}
  ul.plain>li::before{content:"";position:absolute;left:4px;top:.72em;width:6px;height:6px;border-radius:50%;background:var(--accent)}

  /* ---- severity chips ---- */
  .chip{display:inline-block;font-family:var(--mono);font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;
    font-weight:600;padding:2px 8px;border-radius:999px;vertical-align:1px;margin-right:8px}
  .c-good{background:var(--good-soft);color:var(--good)}
  .c-warn{background:var(--warn-soft);color:var(--warn)}
  .c-crit{background:var(--crit-soft);color:var(--crit)}

  .kbd{font-family:var(--mono);font-size:12px;background:#fff;border:1px solid var(--line);border-bottom-width:2px;border-radius:5px;padding:1px 6px}
  footer{border-top:1px solid var(--line);padding:26px 0 60px;color:var(--faint);font-family:var(--mono);font-size:12px}
  a.focusable:focus-visible,nav.index a:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
</style>
</head><body>


<header class="top">
  <div class="wrap">
    <div class="eyebrow">Internal · Operator reference</div>
    <h1>Kiln Operator's Playbook</h1>
    <p class="lede">How the business actually runs — the systems, the money, the upgrades, and exactly what to do when something breaks. Plain language, because this is your first business like this.</p>
    <div class="meta">Owner: Erik · Living document · Last updated 2026-07-04</div>

    <div class="facts">
      <div class="fact">
        <h3>The mental model</h3>
        <p>Kiln is a little of <strong>your own code</strong> plus <strong>one</strong> Cloudflare Worker and <strong>one</strong> database you run. Every customer's content lives in <strong>their</strong> GitHub repo — never yours. You run the sign-in-and-save plumbing and a tiny registry of who's paying.</p>
      </div>
      <div class="fact">
        <h3>The infrastructure answer</h3>
        <p><strong>No per-customer instances.</strong> Everyone shares one Worker and one database; a customer is one row in a table. This is multi-tenant SaaS — the cheap, secure, standard shape. Hundreds of customers cost you a few dollars a month.</p>
      </div>
    </div>
  </div>
</header>

<div class="wrap grid">
  <nav class="index" aria-label="Sections">
    <p class="lbl">Contents</p>
    <a class="focusable" href="#s1"><span class="n">01</span> The map</a>
    <a class="focusable" href="#s2"><span class="n">02</span> Infrastructure</a>
    <a class="focusable" href="#s3"><span class="n">03</span> Environments &amp; testing</a>
    <a class="focusable" href="#s4"><span class="n">04</span> Upgrades</a>
    <a class="focusable" href="#s5"><span class="n">05</span> Rollback</a>
    <a class="focusable" href="#s6"><span class="n">06</span> GitHub &amp; PRs</a>
    <a class="focusable" href="#s7"><span class="n">07</span> Support</a>
    <a class="focusable" href="#s8"><span class="n">08</span> Billing</a>
    <a class="focusable" href="#s9"><span class="n">09</span> When it breaks</a>
    <a class="focusable" href="#s10"><span class="n">10</span> Known gaps</a>
    <a class="focusable" href="#s11"><span class="n">11</span> Your job</a>
  </nav>

  <main>
    <section id="s1">
      <h2><span class="sn">01</span> The map: what exists and where</h2>
      <p>Four separate websites, but only <strong>one</strong> Worker and <strong>one</strong> database do the real work. That's the whole backend — no server you keep patched, no per-customer machine.</p>
      <div class="tw"><table>
        <thead><tr><th>Thing</th><th>What it is</th><th>Where it lives</th><th>Who sees it</th></tr></thead>
        <tbody>
          <tr><td><strong>kilncms.com</strong></td><td>Marketing site</td><td>GitHub <code>kilncms/kilncms.com</code> → Pages <code>kilncms</code></td><td>Public</td></tr>
          <tr><td><strong>demo.kilncms.com</strong></td><td>The try-it sandbox</td><td>GitHub <code>kilncms/kiln-demo</code> → Pages <code>kiln-demo</code></td><td>Public</td></tr>
          <tr><td><strong>app.kilncms.com</strong></td><td>Customer + admin dashboard</td><td>GitHub <code>kilncms/cloud-app</code> → Pages <code>kiln-cloud-app</code></td><td>Public page, gated data</td></tr>
          <tr><td><strong>auth.kilncms.com</strong></td><td>The Worker — sign-in, every save, billing</td><td>GitHub <code>kilncms/kiln</code> <code>worker/</code> → Worker <code>kiln-auth</code></td><td>Server-side only</td></tr>
          <tr><td><strong>The registry</strong></td><td>Who's a customer, which sites, trial/active</td><td>Cloudflare <strong>D1</strong> database <code>kiln-cloud</code></td><td>You (admin)</td></tr>
          <tr><td><strong>Sessions / presence</strong></td><td>Short-lived keys</td><td>Cloudflare <strong>KV</strong> <code>KILN</code></td><td>Server-side only</td></tr>
          <tr><td><strong>The product</strong></td><td>Engine, editor, worker, CLI source</td><td>GitHub <code>kilncms/kiln</code></td><td>Public (open source)</td></tr>
          <tr><td><strong>A customer's site</strong></td><td>Their HTML &amp; content</td><td>Their GitHub repo + their host (or ours, on Managed)</td><td>Them</td></tr>
        </tbody>
      </table></div>
    </section>

    <section id="s2">
      <h2><span class="sn">02</span> Are we spinning up separate Cloudflare instances per customer?</h2>
      <p><strong>No — and that's the correct, sustainable, cheap design.</strong> Every Cloud and Managed customer is served by the <em>same single Worker</em> and recorded as <em>one row</em> in the <em>same single database</em>. Signing up just adds a row (<code>repo, origin, plan, status</code>) whose origin joins a dynamic allowlist the Worker checks on each request. That's it. This is <strong>multi-tenant</strong> — many customers, one shared system — how almost every SaaS works.</p>
      <h3 class="sub">Why it's the right call</h3>
      <ul class="plain">
        <li><strong>Cost.</strong> Workers' free tier is 100k requests/day; paid is $5/mo for 10M. You'd have hundreds of active customers before the backend costs more than $5/month. Per-customer workers would multiply cost and management for zero benefit.</li>
        <li><strong>Security.</strong> Isolation is enforced in <em>code</em>, not by separate machines. The Worker derives which repo it may touch from the signed-in session — a customer literally can't form a request that reaches another customer's repo. (The security audit verified exactly this.)</li>
        <li><strong>Upgrades.</strong> One Worker means every customer gets a fix at the same instant. Per-customer workers would mean deploying N times and tracking N versions — a nightmare that grows with success.</li>
      </ul>
      <h3 class="sub">Where "separate" does happen — and it's not your infrastructure</h3>
      <p>The genuinely per-customer thing is <strong>their GitHub repo</strong> (and, on self-host/Cloud, their host). Content and full history live there, owned by them; the GitHub App is installed on their repo, by them. The isolation that matters — "my content is mine" — is real and lives in <em>their</em> accounts.</p>
      <h3 class="sub">Fully Managed specifically</h3>
      <p>For Managed we also run the hosting — still on <strong>your</strong> Cloudflare account, as <strong>separate Pages projects</strong> (one per customer site, free) plus a <strong>Cloudflare Email Routing</strong> rule on their domain. So a Managed customer costs you: one free Pages project + one database row + fractions of a cent in Worker requests. <code>scripts/managed-onboard.mjs</code> sets it all up in one command.</p>
      <div class="call rule"><span class="tag">Bottom line</span><p>One small worker and one small database for everyone, plus free Pages projects for Managed. This scales to hundreds of customers on a few dollars a month. Don't let anyone talk you into "a separate instance per customer" — that would be a mistake.</p></div>
    </section>

    <section id="s3">
      <h2><span class="sn">03</span> The three environments, and how testing works</h2>
      <p>Three places code can run. Think <strong>draft → rehearsal → live</strong>.</p>
      <div class="tw"><table>
        <thead><tr><th>Environment</th><th>What it is</th><th>URL</th><th>When</th></tr></thead>
        <tbody>
          <tr><td><strong>Local</strong></td><td>This Mac Mini only</td><td><code>localhost</code></td><td>While building a change</td></tr>
          <tr><td><strong>Staging</strong></td><td>A real deployed copy, no customers</td><td><code>kiln-auth-staging…workers.dev</code></td><td>Rehearse a risky Worker change</td></tr>
          <tr><td><strong>Production</strong></td><td>What real customers use</td><td><code>auth.kilncms.com</code> + the live sites</td><td>The real thing</td></tr>
        </tbody>
      </table></div>
      <div class="call caution"><span class="tag">The golden rule (learned the hard way)</span><p>The staging Worker <strong>must</strong> keep <code>routes = []</code> in its config. Without it, a staging deploy inherits production's domain and takes over production — this caused a real outage once. It's already there; never remove it.</p></div>
      <h3 class="sub">How a change gets tested before customers see it</h3>
      <ol class="steps">
        <li><strong>Unit tests</strong> — <code>npm test</code> runs the engine/transport/tagger suite (56 tests). Seconds; catches most logic bugs.</li>
        <li><strong>Build check</strong> — <code>npm run build</code> re-bundles the editor; if it fails, nothing ships.</li>
        <li><strong>Staging deploy</strong> — for Worker changes, deploy to staging first, then confirm sign-in, save, and billing still work.</li>
        <li><strong>Live dogfooding</strong> — the NPU site and the demo are real Kiln sites we click through after a change, catching what tests can't.</li>
        <li><strong>Production deploy</strong> — only after all of the above.</li>
      </ol>
      <p>You don't run this day-to-day — I do, when we change something. Your job is to <strong>decide</strong> what changes and <strong>verify the result</strong>. The one command worth knowing, run inside a site's folder:</p>
      <p><code>npx github:kilncms/kiln doctor</code> — checks the whole chain (worker reachable, app installed, site live, CORS, members area, Google sign-in) and prints pass/fail.</p>
    </section>

    <section id="s4">
      <h2><span class="sn">04</span> Upgrades: how new versions reach everyone</h2>
      <p>Two separate tracks, because there are two kinds of code.</p>
      <h3 class="sub">Track A — the backend (Worker + database). You control it; customers do nothing.</h3>
      <p>Improve <code>kiln/worker/</code> → <code>npm test</code> → deploy to staging, smoke-test → deploy to production. Every customer is on the new version instantly; they do nothing. <strong>This is where ~90% of upgrades happen, and it's the low-risk kind:</strong> one deploy, reversible, no customer action. The risks are narrow — breaking sign-in, the save proxy, or the allowlist — and staging catches all three if you test sign-in + one save + the dashboard there first.</p>
      <h3 class="sub">Track B — the editor files inside each customer's repo</h3>
      <p>The <code>kiln.js</code> / <code>kiln-editor.js</code> files live in each customer's repo, so an update has to reach them:</p>
      <div class="tw"><table>
        <thead><tr><th>Customer</th><th>How they get editor updates</th></tr></thead>
        <tbody>
          <tr><td><strong>Fully Managed</strong></td><td>We update it for them — <code>npx github:kilncms/kiln update</code> in their repo, commit, push.</td></tr>
          <tr><td><strong>Kiln Cloud</strong></td><td>They run <code>npx github:kilncms/kiln update</code> themselves; we tell them when it matters.</td></tr>
          <tr><td><strong>Self-hosted</strong></td><td>They run <code>update</code> on their own schedule.</td></tr>
        </tbody>
      </table></div>
      <div class="call rule"><span class="tag">Why Track B is low-stakes</span><p>The visitor boot script (~3 KB) rarely changes and the big editor bundle only loads for signed-in editors. An out-of-date editor still works — it's just missing the newest features — and never breaks a customer's live site for visitors. Batch-notify "there's a new version, run <code>update</code> when convenient" rather than firefighting.</p></div>
      <h3 class="sub">Applying a Track-B upgrade safely (Managed)</h3>
      <ol class="steps">
        <li>In a clone of their repo: <code>npx github:kilncms/kiln update</code>.</li>
        <li><code>git diff</code> — should show only <code>assets/kiln*.js</code> changing.</li>
        <li>Commit, push. Their host redeploys; visitors see no change; editors get the new features.</li>
        <li>If anything looks wrong: <code>git revert</code> the commit, push. Instantly back to the old bundle.</li>
      </ol>
      <div class="call rule"><span class="tag">Automatic for sites you keep checked out</span><p>Consumer repos cloned on the Mac Mini (the demo, npu-i, any managed site you add to <code>CONSUMERS</code> in <code>scripts/propagate-bundles.mjs</code>) are refreshed <em>automatically</em> at the end of every <code>npm run deploy:prod</code> — copied, committed, pushed. If one can't be updated the deploy reports failure, so "deploy succeeded" always means those sites are current. The manual steps above are only for customer repos you don't keep locally.</p></div>
    </section>

    <section id="s5">
      <h2><span class="sn">05</span> Rolling back when something breaks</h2>
      <p>Everything is reversible. Match the fix to what broke.</p>
      <div class="tw"><table>
        <thead><tr><th>What broke</th><th>How to roll it back</th></tr></thead>
        <tbody>
          <tr><td><strong>The Worker</strong> (sign-in/save/billing down)</td><td><code>cd kiln/worker &amp;&amp; npx wrangler rollback</code> — reverts to the previous version in seconds.</td></tr>
          <tr><td><strong>A customer's editor bundle</strong></td><td>In their repo: <code>git revert &lt;the update commit&gt;</code>, push.</td></tr>
          <tr><td><strong>A customer's page content</strong></td><td>They fix it in Kiln: <strong>History → Go back to this / Undo this change</strong>. Every publish is a git commit — nothing is lost.</td></tr>
          <tr><td><strong>Marketing site / dashboard</strong></td><td><code>git revert</code> in that repo, push. Pages redeploys in ~10s.</td></tr>
          <tr><td><strong>The database</strong></td><td>Tiny and rarely changes; realistic recovery is re-adding a row from the admin dashboard.</td></tr>
        </tbody>
      </table></div>
      <div class="call rule"><span class="tag">Golden rule of rollback</span><p>If you're not sure what broke, <strong>roll back the Worker first</strong> — it's the one shared thing, the rollback is instant and safe, and it's the most likely culprit after a deploy. Then diagnose calmly. But first sanity-check the signal: one customer reporting "broken" is often <em>their</em> repo/host — run <code>doctor</code> on their site before touching production.</p></div>
    </section>

    <section id="s6">
      <h2><span class="sn">06</span> The GitHub side: issues, PRs, stars</h2>
      <p>Kiln is open source, which is good for credibility and free marketing but comes with light gardening. None of it is urgent, and none of it can hurt your customers.</p>
      <h3 class="sub">Issues — someone reports a bug or asks a question</h3>
      <p>Read it, reply plainly. Real bug → thank them, tell me. Question → answer or link the docs. Spam → close it. <strong>Triage in one line:</strong> <em>is a paying customer affected?</em> Yes → we prioritize. No → it can wait.</p>
      <h3 class="sub">Pull Requests — someone proposes a code change</h3>
      <p>A PR does <strong>nothing</strong> until <em>you</em> merge it. Forward any PR to me; I review it for correctness and security and tell you if it's safe and why.</p>
      <div class="call caution"><span class="tag">Never merge code you don't understand</span><p>Most drive-by PRs are typos or well-meaning-but-wrong; a few are useful; a rare one is malicious. Never merge just to be polite — the license means you owe no one a merge. Safe reply: <em>"Thanks! I'll review this when I get a chance."</em> Then send it to me.</p></div>
      <h3 class="sub">The AGPL license, plainly</h3>
      <p>Anyone can use, self-host, and modify Kiln for free — including commercially — but running a <em>modified</em> version as a public service means publishing their changes. This discourages a competitor from taking your code, improving it secretly, and reselling it. It does <strong>not</strong> stop you charging for Cloud/Managed (you're hosting the same open code, which is allowed). No day-to-day enforcement needed.</p>
    </section>

    <section id="s7">
      <h2><span class="sn">07</span> Support: emails, and what a customer can break</h2>
      <p>Contact: <code>info@kilncms.com</code> — keep this inbox monitored; it's on the site, the legal pages, and the Lemon Squeezy listing. Support tiers: self-hosted = community (GitHub issues); Cloud = email, best-effort; Managed = priority.</p>
      <h3 class="sub">The five questions you'll actually get</h3>
      <ol class="steps">
        <li><strong>"How do I add an editor?"</strong> — Their Kiln menu → People &amp; access → add by Google email. No GitHub account needed.</li>
        <li><strong>"My change isn't showing up."</strong> — Their host is rebuilding (~a minute). Longer? Run <code>doctor</code> — usually the host isn't Git-connected, so Kiln's commit never deploys.</li>
        <li><strong>"I can't sign in."</strong> — Session expired or access changed. Re-sign-in at <code>theirsite.com/kiln</code>.</li>
        <li><strong>"I want to cancel."</strong> — In trial: Remove the site in the dashboard (no charge). Subscribed: dashboard → Manage billing → Lemon Squeezy portal.</li>
        <li><strong>"Can you set up my site?"</strong> — That's Managed, or the $399 Concierge add-on. Point them there.</li>
      </ol>
      <div class="call rule"><span class="tag">What a customer genuinely cannot break</span><p>A customer touches only <strong>their own repo</strong>, only <strong>content</strong> fields, and every change is a reversible git commit. They can't reach another customer, your Worker's internals, or your infrastructure, and can't lose data. The worst a confused customer does is make their own page look wrong — fixable with History → Undo in ten seconds. By design. It's why this is a safe first business.</p></div>
    </section>

    <section id="s8">
      <h2><span class="sn">08</span> Billing (Lemon Squeezy), in operator terms</h2>
      <ul class="plain">
        <li><strong>Lemon Squeezy is the "merchant of record."</strong> They charge the card, handle taxes, and appear on statements — not you. You never touch card numbers. A big liability you don't carry.</li>
        <li><strong>Only a signed webhook from Lemon Squeezy makes a site "active."</strong> A customer can't fake being paid; forged payment events are rejected (audited, replay-guarded).</li>
        <li><strong>Trials</strong> are editable for 7 days, then auto-expire if no subscription arrives — automatic, no action from you.</li>
        <li><strong>Your admin dashboard</strong> (app.kilncms.com/admin) shows accounts, sites, active count, MRR, and expiring trials. Check it for a pulse.</li>
        <li><strong>Prices live in three places that must agree:</strong> the Lemon Squeezy product, the Worker's MRR math, and the marketing site. Today: Cloud <strong>$4.99</strong>/mo, Managed <strong>$14.99</strong>/mo, Concierge <strong>$399</strong> one-time. Change one → change all three (I do the code/site half; you do Lemon Squeezy).</li>
      </ul>
    </section>

    <section id="s9">
      <h2><span class="sn">09</span> When something breaks: the calm checklist</h2>
      <p>Work top to bottom. Stop when you find it.</p>
      <ol class="steps">
        <li><strong>One customer or everyone?</strong> One → probably <em>their</em> repo/host; run <code>doctor</code> on their site. Everyone → it's the Worker or a deploy; continue.</li>
        <li><strong>Did we just deploy?</strong> Yes → <strong>roll back the Worker</strong> (<code>wrangler rollback</code>) and see if it fixes it. Most likely cause, fastest fix.</li>
        <li><strong>Is the Worker up?</strong> <code>curl https://auth.kilncms.com/healthz</code> should say <code>ok</code>. If not, redeploy the last known-good version.</li>
        <li><strong>Is billing the problem?</strong> Check the admin and Lemon Squeezy dashboards. A site stuck "trialing" after payment is usually a delayed webhook — it self-corrects, or re-send it from Lemon Squeezy.</li>
        <li><strong>Still stuck?</strong> Write down exactly what you see (URL, error, screenshot), send it to me, and stop changing things — one change at a time.</li>
      </ol>
      <p>The two things that have actually caused outages: a staging deploy without <code>routes = []</code> hijacking production (fixed and guarded), and a code constant declared in the wrong place reading as empty at startup (a class of bug I now specifically check for). Neither is something you'd cause; both are in my head when I touch the code.</p>
    </section>

    <section id="s10">
      <h2><span class="sn">10</span> Known gaps / hardening backlog</h2>
      <p>Nothing here is a security hole or a customer-facing breakage — polish items ranked by value, so you know what I know. If any starts generating tickets, that's the signal to prioritize it.</p>
      <ul class="plain">
        <li><span class="chip c-warn">UX</span><strong>Trial cancel in the dashboard.</strong> A trialing customer can't self-cancel from the billing portal yet — they Remove the site instead. Should add a clear "cancel trial" affordance.</li>
        <li><span class="chip c-warn">UX</span><strong>No trial countdown shown</strong> to the customer ("3 days left"). Cheap to add.</li>
        <li><span class="chip c-warn">Edge</span><strong>Crash-restore drops uploaded images / added sections</strong> — only text edits survive a crash-restore. Low frequency; fix planned.</li>
        <li><span class="chip c-good">Nice</span><strong>No media library</strong> — every upload is a new file; nothing lists or reuses them.</li>
        <li><span class="chip c-good">Nice</span><strong>Page rename</strong> creates a new page rather than renaming with a redirect.</li>
        <li><span class="chip c-good">Nice</span><strong>Post-checkout confirmation</strong> — no "finalizing…" state if the webhook is a few seconds late.</li>
      </ul>
    </section>

    <section id="s11">
      <h2><span class="sn">11</span> Your job, distilled</h2>
      <p>You don't run servers or write code. Day to day, operating Kiln is:</p>
      <ol class="steps">
        <li><strong>Watch the inbox</strong> (info@kilncms.com) and the admin dashboard.</li>
        <li><strong>Answer support</strong> using §07 — most answers are one line.</li>
        <li><strong>Decide</strong> what we build/change next; I do the building and the risky deploys.</li>
        <li><strong>On a Managed signup:</strong> run the onboarding script (or have me do it) — hosting, tagging, email forwarding.</li>
        <li><strong>When I ship a change,</strong> glance at the demo/NPU site to confirm it still works — your "verify the result" step.</li>
        <li><strong>Keep the three prices in sync</strong> across Lemon Squeezy, the code, and the site (tell me for the code/site half).</li>
      </ol>
      <p>Everything else — the worker, the database, the security, the deploys, the audits — is machinery I maintain with you. This document is the map, so you always know where the pieces are and what to do when. Ask me to expand any section into a step-by-step with screenshots whenever you want.</p>
    </section>
  </main>
</div>

<footer><div class="wrap">Kiln Operator's Playbook · private reference · kept in sync at ~/Documents/mini-share/</div></footer>

</body></html>`;
