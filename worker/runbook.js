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
  /* a whole command, on a line of its own */
  pre{font-family:var(--mono);font-size:13px;line-height:1.5;background:#eef2f4;border:1px solid var(--line-soft);border-radius:8px;
    padding:10px 14px;margin:10px 0;color:#12333a;white-space:pre-wrap;overflow-wrap:anywhere;max-width:var(--maxread)}

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
    <p class="lede">How the service runs today, what it sends you, and what to do by hand when something needs doing or has gone wrong. Every task is written as steps: what to look at, what to type or press, what a good answer looks like, and what to do when it is not.</p>
    <div class="meta">For the owner · Kept in the repository as worker/runbook.js · Last updated 2026-11-13</div>

    <div class="facts">
      <div class="fact">
        <h3>The short version</h3>
        <p>Kiln is <strong>one service for everybody</strong> (one Worker, one database, one store) in the main Cloudflare account, plus a <strong>second Cloudflare account</strong> that holds one small Worker for every site Kiln hosts. A customer's pages live in a GitHub repository: their own, or one Kiln keeps for them.</p>
      </div>
      <div class="fact">
        <h3>When something is wrong</h3>
        <p>Start with <a href="#s16">the daily look</a>. It takes five minutes and points you to the section to read next. If a customer wrote to you, go to <a href="#s5">section 05</a>. If Kiln wrote to you, go to <a href="#s4">section 04</a>.</p>
      </div>
    </div>
  </div>
</header>

<div class="wrap grid">
  <nav class="index" aria-label="Sections">
    <p class="lbl">Contents</p>
    <a class="focusable" href="#s1"><span class="n">01</span> The map</a>
    <a class="focusable" href="#s2"><span class="n">02</span> Switches &amp; secrets</a>
    <a class="focusable" href="#s3"><span class="n">03</span> The timers</a>
    <a class="focusable" href="#s4"><span class="n">04</span> Notes Kiln sends you</a>
    <a class="focusable" href="#s5"><span class="n">05</span> When a customer writes</a>
    <a class="focusable" href="#s6"><span class="n">06</span> Free days</a>
    <a class="focusable" href="#s7"><span class="n">07</span> Hosting</a>
    <a class="focusable" href="#s8"><span class="n">08</span> Previews</a>
    <a class="focusable" href="#s9"><span class="n">09</span> Domains &amp; email</a>
    <a class="focusable" href="#s10"><span class="n">10</span> Leaving</a>
    <a class="focusable" href="#s11"><span class="n">11</span> Accounts</a>
    <a class="focusable" href="#s12"><span class="n">12</span> Releasing</a>
    <a class="focusable" href="#s13"><span class="n">13</span> Rolling back</a>
    <a class="focusable" href="#s14"><span class="n">14</span> What happened</a>
    <a class="focusable" href="#s15"><span class="n">15</span> Billing</a>
    <a class="focusable" href="#s16"><span class="n">16</span> Daily &amp; weekly look</a>
    <a class="focusable" href="#s17"><span class="n">17</span> GitHub &amp; pull requests</a>
    <a class="focusable" href="#s18"><span class="n">18</span> Known gaps</a>
  </nav>

  <main>
    <section id="s1">
      <h2><span class="sn">01</span> The map: what exists and where</h2>
      <p>Kiln lives in two Cloudflare accounts and three places on GitHub. A Worker is a small program that Cloudflare runs for you. There is no server of your own to keep patched.</p>

      <h3 class="sub">The main Cloudflare account: the service</h3>
      <div class="tw"><table>
        <thead><tr><th>Thing</th><th>What it does</th><th>Where it lives</th></tr></thead>
        <tbody>
          <tr><td><strong>auth.kilncms.com</strong></td><td>The service itself: sign-in, every save, the dashboard's data, billing, and the orders that put sites on the hosting</td><td>Worker <code>kiln-auth</code>, built from the <code>worker/</code> folder of <code>kilncms/kiln</code></td></tr>
          <tr><td><strong>The test service</strong></td><td>A full copy with its own database and store and no customers. It is called staging.</td><td>Worker <code>kiln-auth-staging</code>, on a workers.dev address</td></tr>
          <tr><td><strong>The database</strong></td><td>Accounts, sites, hosting records, domains, forwarded addresses, previews, copies of sites</td><td>Cloudflare D1 database <code>kiln-cloud</code> (staging has <code>kiln-cloud-staging</code>)</td></tr>
          <tr><td><strong>The store</strong></td><td>Sign-ins, each site's list of people, comments, suggestions, scheduled posts, the free-day marks, and the GitHub App's own credentials</td><td>Cloudflare KV store, known to the code as <code>KILN</code></td></tr>
          <tr><td><strong>kilncms.com</strong></td><td>The website</td><td>GitHub <code>kilncms/kilncms.com</code>, published by the Pages project <code>kilncms</code></td></tr>
          <tr><td><strong>app.kilncms.com</strong></td><td>The customers' dashboard, and your admin page at <code>/admin</code></td><td>GitHub <code>kilncms/cloud-app</code>, published by the Pages project <code>kiln-cloud-app</code></td></tr>
          <tr><td><strong>demo.kilncms.com</strong></td><td>The demo people try</td><td>Pages project <code>kiln-demo-mr</code></td></tr>
          <tr><td><strong>kiln-demo.pages.dev</strong></td><td>The first site that gets a new editor, before any customer's</td><td>GitHub <code>kilncms/kiln-demo</code></td></tr>
        </tbody>
      </table></div>

      <h3 class="sub">The second Cloudflare account: Kiln Hosting</h3>
      <p>This account holds customers' sites and nothing else. Its id is the value of <code>HOSTING_ACCOUNT_ID</code> in <code>worker/wrangler.toml</code>.</p>
      <ul class="plain">
        <li><strong>One Worker for every hosted site.</strong> Its name is the repository's name, made safe for a web address, followed by a dash and the first eight characters of the site's id. The site's temporary address is <code>https://NAME.kiln-sites.workers.dev</code>.</li>
        <li><strong>One Worker for every preview.</strong> Its name begins with <code>pv-</code>, then the same eight characters, then the branch's name. No site's name ever begins with <code>pv-</code>.</li>
        <li><strong>One zone for every customer's own domain.</strong> A zone is Cloudflare's word for a domain it answers for: the domain's records live in it.</li>
        <li>Anything whose name begins with <code>stg-</code> was put there by the test service. It is not a customer's.</li>
      </ul>

      <h3 class="sub">GitHub</h3>
      <ul class="plain">
        <li><strong>The GitHub App, <code>kiln-cms</code>.</strong> Customers install it on their own repositories. It is how Kiln reads and writes their pages, and it tells the service when a repository changes.</li>
        <li><strong>A second App and the organization <code>kiln-sites</code>.</strong> The second App is installed only in that organization. It makes a private repository there for each customer who has no GitHub account. Such a site is called a kept site, because Kiln keeps its files. The same organization holds the repository <code>kiln-converter</code>, whose job (a GitHub Actions job named <code>convert.yml</code>) copies an existing site in when a customer presses "Bring my site in". The service never opens the address the customer typed. Only that job does.</li>
        <li><strong>The public repository, <code>kilncms/kiln</code>.</strong> All of Kiln's code. Its branch <code>release</code> always points at what production runs.</li>
      </ul>

      <h3 class="sub">Where a customer's site lives</h3>
      <div class="tw"><table>
        <thead><tr><th>Plan</th><th>The pages</th><th>The site's host</th></tr></thead>
        <tbody>
          <tr><td><strong>Kiln Cloud</strong></td><td>Their own GitHub repository</td><td>Their own host</td></tr>
          <tr><td><strong>Kiln Cloud + hosting</strong>, own repository</td><td>Their own GitHub repository</td><td>A Worker in the hosting account</td></tr>
          <tr><td><strong>Kiln Cloud + hosting</strong>, kept site</td><td>A private repository in <code>kiln-sites</code></td><td>A Worker in the hosting account</td></tr>
        </tbody>
      </table></div>
      <p>The database calls the plan with hosting <code>managed</code>. You will see that word on the admin page and in commands.</p>

      <h3 class="sub">The three places the service runs</h3>
      <div class="tw"><table>
        <thead><tr><th>Name</th><th>What it is</th><th>Used for</th></tr></thead>
        <tbody>
          <tr><td><strong>Local</strong></td><td>On the computer where the code is being changed</td><td>Building a change</td></tr>
          <tr><td><strong>Staging</strong></td><td><code>kiln-auth-staging</code>, with its own database and store</td><td>Trying every change before customers get it</td></tr>
          <tr><td><strong>Production</strong></td><td><code>kiln-auth</code> at auth.kilncms.com</td><td>What customers use</td></tr>
        </tbody>
      </table></div>
      <div class="call caution"><span class="tag">Never remove this line</span><p>In <code>worker/wrangler.toml</code> the staging part says <code>routes = []</code>. Without it a release to staging would take over auth.kilncms.com. That happened once and took the service down.</p></div>
    </section>

    <section id="s2">
      <h2><span class="sn">02</span> The switches and the secrets</h2>
      <p>Each piece of Kiln is switched on by a setting. A variable is a setting written in <code>worker/wrangler.toml</code>, which is public. A secret is a setting kept by Cloudflare that nobody can read back, you included. This section names them. It never shows a value.</p>
      <div class="call caution"><span class="tag">Name the environment, every time</span><p>Every command that changes the service ends with <code>--env staging</code> or <code>--env production</code>. This goes for <code>wrangler secret put</code>, <code>kv</code>, <code>d1</code> and <code>deploy</code>. Without it the command makes a stray Worker or touches the wrong store. Run these commands from the <code>worker</code> folder of the repository.</p></div>

      <h3 class="sub">Is it on? Three looks</h3>
      <ol class="steps">
        <li><strong>The health answer.</strong> Type <code>curl https://auth.kilncms.com/healthz</code>. A good answer begins <code>{"ok":true</code> and carries <code>version</code> and <code>build</code>, the commit that is running.</li>
        <li><strong>The deeper health answer.</strong> Type <code>curl "https://auth.kilncms.com/healthz?deep=1"</code>. It also tries the store, the database and the GitHub App. A good answer has <code>"kv":"ok"</code>, <code>"d1":"ok"</code> and <code>"app":"ok"</code>. If one failed, the answer says <code>"ok":false</code> and lists it under <code>failed</code>.</li>
        <li><strong>What the dashboard is told.</strong> When a person opens the dashboard it asks the service at <code>/cloud/me</code>, and the answer says true or false for <code>billing</code>, <code>mail</code>, <code>hosting</code>, <code>domains</code>, <code>forwarding</code>, <code>keeps</code> and <code>brings</code>. The simple way to read it is the dashboard itself: a piece that is off is not offered there.</li>
      </ol>
      <p>To see which secrets are set (names only, never values):</p>
      <pre>cd worker
npx wrangler secret list --env production</pre>
      <p>To set one, type the line below with the secret's name. It asks for the value. Never put a value in a file.</p>
      <pre>npx wrangler secret put NAME --env production</pre>

      <h3 class="sub">What switches each piece on</h3>
      <div class="tw"><table>
        <thead><tr><th>Piece</th><th>Needs</th><th>How you see it is on</th></tr></thead>
        <tbody>
          <tr><td><strong>Hosting</strong></td><td>Variables <code>HOSTING_ACCOUNT_ID</code> and <code>HOSTING_SUBDOMAIN</code>, secret <code>HOSTING_API_TOKEN</code></td><td><code>hosting</code> is true. The dashboard offers "Put it on Kiln's hosting".</td></tr>
          <tr><td><strong>Publishing again on a push</strong></td><td>Secret <code>GH_WEBHOOK_SECRET</code>, with the same value entered in the GitHub App's settings</td><td>A push shows on the hosted site within seconds, not minutes.</td></tr>
          <tr><td><strong>Members area on hosted sites</strong></td><td>Secret <code>HOSTING_MEMBER_KEY</code>, variable <code>HOSTING_SERVICE_URL</code></td><td>No line <code>hosting_members_left_out</code> in the logs (section 14).</td></tr>
          <tr><td><strong>Own domains</strong></td><td>Hosting, and the database has its <code>domains</code> table</td><td><code>domains</code> is true. The dashboard offers "Use your own domain".</td></tr>
          <tr><td><strong>Email forwarding</strong></td><td>Own domains, and the database has its <code>forwards</code> table. The hosting token must be allowed to write Email Routing addresses for the account and Email Routing rules for its zones.</td><td><code>forwarding</code> is true. The dashboard offers "Forward an address".</td></tr>
          <tr><td><strong>Kept sites</strong> ("Start a site")</td><td>Hosting, and <code>KEEP_ORG</code>, <code>KEEP_APP_ID</code>, <code>KEEP_APP_KEY</code></td><td><code>keeps</code> is true.</td></tr>
          <tr><td><strong>"Bring my site in"</strong></td><td>Kept sites, and secret <code>CONVERT_SECRET</code></td><td><code>brings</code> is true.</td></tr>
          <tr><td><strong>Emails to customers</strong></td><td>The mail sender named <code>NOTIFY</code> in wrangler.toml, variable <code>CUSTOMER_MAIL_FROM</code></td><td><code>mail</code> is true.</td></tr>
          <tr><td><strong>Notes to you</strong></td><td>The same mail sender, secret <code>NOTIFY_TO</code></td><td>You get the notes of section 04.</td></tr>
          <tr><td><strong>Billing</strong></td><td>Secrets <code>LS_API_KEY</code> and <code>LS_STORE_ID</code>, with the three below</td><td><code>billing</code> is true. The admin page says "Store live" or "Store in test mode", not "Billing not configured".</td></tr>
          <tr><td><strong>Your admin page</strong></td><td>Variable <code>CLOUD_ADMIN_ID</code>, GitHub's permanent number of your account. When it is set, it alone decides who the operator is.</td><td>app.kilncms.com/admin opens for you and for nobody else.</td></tr>
        </tbody>
      </table></div>

      <h3 class="sub">Every secret production needs, and what stops without it</h3>
      <div class="tw"><table>
        <thead><tr><th>Secret</th><th>Without it</th></tr></thead>
        <tbody>
          <tr><td><code>GOOGLE_CLIENT_ID</code>, <code>GOOGLE_CLIENT_SECRET</code></td><td>Nobody can sign in with Google: invited editors, members, and customers with no GitHub account.</td></tr>
          <tr><td><code>HOSTING_API_TOKEN</code></td><td>Nothing is hosted, and own domains and email forwarding are off with it.</td></tr>
          <tr><td><code>GH_WEBHOOK_SECRET</code></td><td>GitHub's notices of a push are answered "not found". Hosted sites are still published again, but only when the five-minute timer notices the change. No preview goes up.</td></tr>
          <tr><td><code>HOSTING_MEMBER_KEY</code></td><td>Pages under <code>members/</code> are left out of a hosted site, so they answer "not found". They are never shown to everybody.</td></tr>
          <tr><td><code>KEEP_APP_ID</code>, <code>KEEP_APP_KEY</code> (and <code>KEEP_ORG</code>, which is not in wrangler.toml)</td><td>Nobody can start a kept site, and "Bring my site in" is off with it.</td></tr>
          <tr><td><code>CONVERT_SECRET</code></td><td>"Bring my site in" is off.</td></tr>
          <tr><td><code>NOTIFY_TO</code></td><td>Kiln sends you no notes. It must be an address that Cloudflare's Email Routing has confirmed in the main account.</td></tr>
          <tr><td><code>LS_API_KEY</code>, <code>LS_STORE_ID</code>, <code>LS_VARIANT_CLOUD</code>, <code>LS_VARIANT_MANAGED</code>, <code>LS_WEBHOOK_SECRET</code></td><td>Nobody can pay (section 15).</td></tr>
          <tr><td><code>AI_API_KEY</code> (optional)</td><td>The editor's writing help answers that it is not set up. Nothing else changes.</td></tr>
        </tbody>
      </table></div>
      <p>The full table of every name the service reads, with where each value comes from, is in <code>ENVIRONMENTS.md</code> under "Every name the worker reads".</p>
    </section>

    <section id="s3">
      <h2><span class="sn">03</span> The timers</h2>
      <p>Two timers run the service's own chores. Nobody starts them. Each job writes one line to the logs when it ends, with <code>"evt":"cron"</code>, the job's name, and <code>"ok":true</code> or <code>"ok":false</code> (section 14). One job failing never stops the others.</p>
      <h3 class="sub">Every five minutes</h3>
      <div class="tw"><table>
        <thead><tr><th>Job</th><th>What it does for customers</th><th>What it mails</th></tr></thead>
        <tbody>
          <tr><td><code>schedules</code></td><td>Publishes the posts and changes that were scheduled for now.</td><td>Nothing.</td></tr>
          <tr><td><code>trials</code></td><td>Ends a free trial that is seven days old and has no subscription. Editing stops for that site.</td><td>The customer: once two days before the end, once when it ends. You: "trials expired unpaid".</td></tr>
          <tr><td><code>moves</code></td><td>Finishes bringing a site's stored things along after its repository was renamed.</td><td>Nothing.</td></tr>
          <tr><td><code>hosting</code>, part 1: plans that ended</td><td>Works out the day a paid hosted site comes down after its plan ended.</td><td>The customer: when editing stops, and again seven days before the site comes down. You: only when a site has no end date on record.</td></tr>
          <tr><td>part 2: domains</td><td>Makes a domain live once its name servers have changed. Puts a set-up away after 25 days of waiting. Notices a live domain that moved away.</td><td>The customer: when it goes live, one reminder after 14 days, and when it is put away. You: when a domain is still not live 24 hours after its name servers changed.</td></tr>
          <tr><td>part 3: forwarded addresses</td><td>Switches a forwarded address on once its inbox has confirmed. Stops waiting after 30 days.</td><td>The customer: when it is on, one reminder after 7 days, and when Kiln stops waiting.</td></tr>
          <tr><td>part 4: copies</td><td>Gives up on a copying job that has said nothing for 30 minutes.</td><td>The customer and you.</td></tr>
          <tr><td>part 5: hosted sites</td><td>Tries again a copy to the hosting that failed, five a run at most. Looks at up to twenty repositories for a change nobody announced. Takes down a site whose time on the hosting is over. Takes down old previews. Brings a hosted site's editor up to the released one.</td><td>You: "Kiln took REPOSITORY down from its hosting".</td></tr>
        </tbody>
      </table></div>
      <h3 class="sub">Every minute</h3>
      <p>One job, <code>forwards</code>: it looks whether an inbox that a forwarded address waits for has confirmed, and switches the address on if so. It skips the minutes when the five-minute timer runs, because that one looks too.</p>
    </section>

    <section id="s4">
      <h2><span class="sn">04</span> The notes Kiln sends you</h2>
      <p>Kiln writes to the address in <code>NOTIFY_TO</code>. Most notes only tell you something happened. The ones marked <span class="chip c-warn">Hand</span> ask you to do something. In the subjects below, REPOSITORY, DOMAIN and ADDRESS stand for the real name.</p>
      <div class="tw"><table>
        <thead><tr><th>Subject</th><th>What happened</th><th>What you do</th></tr></thead>
        <tbody>
          <tr><td>New Kiln site: REPOSITORY</td><td>Somebody added a site. Its free days began.</td><td>Nothing.</td></tr>
          <tr><td>Kiln started a site and keeps its files: REPOSITORY</td><td>A customer with no GitHub account started a kept site.</td><td>Nothing.</td></tr>
          <tr><td>Kiln added to REPOSITORY</td><td>The dashboard put Kiln's two script lines on the site's pages.</td><td>Nothing.</td></tr>
          <tr><td>Character set named on the pages of REPOSITORY</td><td>The dashboard mended pages that did not say how their letters are stored.</td><td>Nothing.</td></tr>
          <tr><td>Kiln editor updated in REPOSITORY</td><td>The customer pressed the button that updates the editor in their repository.</td><td>Nothing.</td></tr>
          <tr><td>Kiln hosts REPOSITORY</td><td>A site went up on the hosting for the first time. The note has its address.</td><td>Nothing. Open the address if you are curious.</td></tr>
          <tr><td>Kiln is setting up DOMAIN for REPOSITORY</td><td>A customer began to use their own domain. The note has the two name servers they must enter.</td><td>Nothing. You need the name servers if they write to you.</td></tr>
          <tr><td>Kiln billing: EVENT → STATUS</td><td>Lemon Squeezy told Kiln about a subscription.</td><td>Nothing, unless a line says the plan on record could not be changed. Then set it on the admin page.</td></tr>
          <tr><td>Kiln: N trials expired unpaid</td><td>Free days ran out with no subscription. Editing stopped for those sites.</td><td>Nothing.</td></tr>
          <tr><td>Kiln took REPOSITORY down from its hosting</td><td>The free days ran out and three more days passed, or the plan ended and 30 days passed.</td><td>Nothing, if you expected it. If the customer is paying, see section 07, "Putting a site back".</td></tr>
          <tr><td>Kiln: the files of REPOSITORY were downloaded</td><td>A customer downloaded the files of their kept site from the dashboard. You get this at most once an hour for one site, however often they press.</td><td>Nothing. It may mean they are about to move away: section 10 has what they may ask you for.</td></tr>
          <tr><td><span class="chip c-warn">Hand</span>Kiln no longer uses REPOSITORY</td><td>A customer removed a kept site. Kiln did not touch the repository in <code>kiln-sites</code>.</td><td>Delete the repository by hand on the day the note names, 30 days later, never sooner. Steps in section 16, the weekly look.</td></tr>
          <tr><td><span class="chip c-warn">Hand</span>Kiln may have made REPOSITORY and no site uses it</td><td>Starting a kept site failed at a point where Kiln cannot tell whether the repository was made.</td><td>Look for it in <code>kiln-sites</code> on GitHub. If it is there, delete it.</td></tr>
          <tr><td><span class="chip c-warn">Hand</span>Kiln made REPOSITORY and could not finish starting the site</td><td>The repository was made and the site was not. The customer was asked to try again.</td><td>Delete the leftover repository in <code>kiln-sites</code>.</td></tr>
          <tr><td><span class="chip c-warn">Hand</span>Kiln: DOMAIN is still not live N hours after its name servers changed</td><td>Cloudflare has the domain, and either its certificate is not ready or the site does not answer there.</td><td>The note says which and where to look in the hosting account. Kiln keeps trying every five minutes and makes the domain live by itself once it is mended. You are told once.</td></tr>
          <tr><td><span class="chip c-warn">Hand</span>Kiln: N hosted sites with a plan that ended and no end date</td><td>A paid hosted site stopped being paid for, and the record has no day on which editing stopped. Kiln leaves such a site up and writes nothing to its owner.</td><td>Look at each subscription in Lemon Squeezy. If it is paid, set the site to <code>active</code> on the admin page. If it is over, write to the customer yourself and remove the site when the time you gave them has passed.</td></tr>
          <tr><td><span class="chip c-warn">Hand</span>Kiln could not start copying ADDRESS into REPOSITORY</td><td>The copying job in <code>kiln-converter</code> could not be started.</td><td>The customer can press Try again. If it happens twice, open the Actions page of <code>kiln-converter</code> on GitHub and check the job is there and enabled.</td></tr>
          <tr><td><span class="chip c-warn">Hand</span>Kiln's copy of ADDRESS stopped</td><td>The job ran and said it could not finish. The note has what it said and which try it was, of three.</td><td>Nothing at first: the customer was told and can try again. After the third try they are told to write to you (section 05).</td></tr>
          <tr><td><span class="chip c-warn">Hand</span>Kiln's copy of ADDRESS gave no answer in 30 minutes</td><td>The job never reported back.</td><td>Find the job's run on the Actions page of <code>kiln-converter</code> and read where it stopped.</td></tr>
          <tr><td><span class="chip c-warn">Hand</span>Kiln could not put REPOSITORY on its hosting after its copy</td><td>The copy is done. Putting it up failed.</td><td>The customer was told to press "Put it on Kiln's hosting". If that fails too, see section 07.</td></tr>
          <tr><td><span class="chip c-warn">Hand</span>Kiln could not write the settings of REPOSITORY after its copy</td><td>The copy's last step failed. The job may send its answer again.</td><td>Wait half an hour. If the copy is still shown as being made, treat it as a copy that gave no answer.</td></tr>
        </tbody>
      </table></div>
      <p>Kiln does not write to you when a domain is put away. The customer gets an email, and the logs get a line <code>domain_put_away</code> with the reason (section 09).</p>
    </section>

    <section id="s5">
      <h2><span class="sn">05</span> When Kiln tells a customer to write to you</h2>
      <p>In these cases Kiln cannot help by itself, and its sentence ends "write to info@kilncms.com". Find the sentence the customer read, then follow the steps. Before you change anything for a person, make sure they are who they say: ask them to write from the address they signed up with.</p>
      <div class="tw"><table>
        <thead><tr><th>What they read</th><th>What they were doing</th><th>Your steps</th></tr></thead>
        <tbody>
          <tr><td>"Kiln cannot confirm that inbox by itself."</td><td>Forwarding an email address at their domain</td><td>Below: "An inbox Kiln cannot confirm".</td></tr>
          <tr><td>"This site has been copied to Kiln several times in the last 30 days."</td><td>Bring my site in</td><td>Below: "A site copied in too often".</td></tr>
          <tr><td>"Kiln has tried to copy this site 3 times."</td><td>Bring my site in, third failure</td><td>Read your three notes about that copy (section 04) and the job's runs in <code>kiln-converter</code>. There is no button that gives more tries.</td></tr>
          <tr><td>"Kiln copies 200 pages of a site at most ... we will bring in the rest."</td><td>Bring my site in, a large site</td><td>The rest is brought in by hand with Kiln's own copying tool. Plan it as a working session, and tell the customer when.</td></tr>
          <tr><td>"Kiln keeps its files for 30 days in case you change your mind."</td><td>They removed a kept site and want it back</td><td>Below: "Getting a removed kept site back".</td></tr>
          <tr><td>"To take them to a GitHub account of your own, write to ..."</td><td>They want their kept site's repository</td><td>Below: "Handing a kept site's repository over".</td></tr>
          <tr><td>"For a file of the domain's records, write to ..."</td><td>They removed a site that had its own domain</td><td>Below: "A file of a domain's records".</td></tr>
          <tr><td>"... is not switched on for this service yet." (starting a site, bringing one in, the members area)</td><td>Using a piece that is off</td><td>Section 02: find the piece's switch and see why it is off. For the members area, set <code>HOSTING_MEMBER_KEY</code>, then ask the customer to press "Publish again".</td></tr>
          <tr><td>"Your own domain: write to info@kilncms.com and Kiln connects it."</td><td>The dashboard shows this while own domains are off</td><td>Section 02: see why <code>domains</code> is false.</td></tr>
          <tr><td>"Kiln's hosting already has DOMAIN set up." or "Another site on Kiln already has DOMAIN."</td><td>Setting up a domain that is already known</td><td>Below: "A domain somebody else holds".</td></tr>
          <tr><td>"Cloudflare ... will not take DOMAIN."</td><td>Setting up a domain</td><td>Cloudflare refuses some domains and Kiln cannot change that. Tell the customer so. Their site stays at its Kiln address.</td></tr>
          <tr><td>"Kiln has too many domains waiting for their name servers to change."</td><td>Setting up a domain</td><td>Run the list of waiting domains (section 09). Old ones are put away after 25 days by themselves. Ask the customer to try again the next day.</td></tr>
          <tr><td>"Because DOMAIN was bought at Cloudflare, its name servers cannot be changed."</td><td>Setting up a domain</td><td>No steps are written for this yet. Tell the customer it needs to be done by hand and plan a working session.</td></tr>
          <tr><td>"If one is missing here, write first."</td><td>Comparing their old records with the ones Kiln kept, before changing name servers</td><td>Ask which record is missing. Add it in the hosting account: the domain, DNS, Records, Add record. Then tell them to go on.</td></tr>
          <tr><td>"This site has more files than Kiln's hosting takes on by itself."</td><td>Putting a site on the hosting</td><td>There is no switch for this. Ask how many files the site has and plan a working session.</td></tr>
          <tr><td>"You have started 3 sites in the last 7 days."</td><td>Starting kept sites</td><td>The sentence tells them how long to wait. An account that pays for a site may start ten. No hand job raises the count.</td></tr>
          <tr><td>"That site address is already on Kiln Cloud."</td><td>Adding a site</td><td>Find the address on the admin page and see whose account has it. If the writer shows the site is theirs, press Remove on the old row so they can add it.</td></tr>
          <tr><td>"The payment page could not be opened just now." or "Your payment is taking longer than usual."</td><td>Paying</td><td>Section 15.</td></tr>
          <tr><td>"Something went wrong on the Kiln service." or "Kiln could not reach your site's files just now." or a sign-in that keeps failing</td><td>Anything</td><td>Ask for the time and what they pressed. Then section 14.</td></tr>
        </tbody>
      </table></div>

      <h3 class="sub">An inbox Kiln cannot confirm</h3>
      <p>All hosted domains share the one hosting account at Cloudflare. An inbox that confirmed there once is confirmed for every customer. So Kiln makes a forwarding rule only for an inbox the customer's own Kiln account has shown to be theirs, and stops otherwise. You finish it by hand.</p>
      <ol class="steps">
        <li>Ask the customer to write to you from the inbox itself. That shows it is theirs.</li>
        <li>In the hosting account at Cloudflare, open the domain, then Email, then Email Routing. Under the destination addresses, the inbox must say it is verified.</li>
        <li>Under the routing rules, create a rule: the address at their domain, sent to that inbox.</li>
        <li>Send a test email to the new address and look for it in the Activity log on the same page.</li>
        <li>Tell the customer it works, and that their dashboard will go on showing Kiln's old sentence, because Kiln did not make this rule.</li>
      </ol>

      <h3 class="sub">A site copied in too often</h3>
      <p>The same old site address can be copied three times in 30 days by accounts that pay for nothing. This stops one site being used to start free days again and again.</p>
      <ol class="steps">
        <li>Make sure the old site is theirs. Ask them to write from an address at that domain, or to tell you something only its owner would know.</li>
        <li>Clear the mark. The key is <code>copied:</code> followed by the address without <code>www.</code></li>
      </ol>
      <pre>npx wrangler kv key delete --binding KILN --env production --remote "copied:oakbakery.example"</pre>
      <p>A good answer says the key was deleted. Then ask the customer to press the button again.</p>

      <h3 class="sub">Getting a removed kept site back</h3>
      <p>When a customer removes a kept site, Kiln takes the site down and forgets it, and leaves its repository in <code>kiln-sites</code> untouched for 30 days. There is no button that puts the site back.</p>
      <ol class="steps">
        <li>Find your note "Kiln no longer uses REPOSITORY". It names the repository and the day from which it may be deleted.</li>
        <li>Open the repository in <code>kiln-sites</code> on GitHub and check the files are there.</li>
        <li>Do not delete the repository. Answer the customer that their files are safe.</li>
        <li>Putting the site back on the customer's account means writing its row back into the database by hand. Those steps have not been written or tried. Do it in a working session, on staging first.</li>
      </ol>

      <h3 class="sub">Handing a kept site's repository over</h3>
      <p>No button moves a repository to a customer's own GitHub account. What works today, without you, is the download:</p>
      <ol class="steps">
        <li>The customer presses "Download the site's files" on the site's row, or in "Moving away" there. It is open once the site has been paid for, and gives them one zip of the whole site, with Kiln in it.</li>
        <li>If they want the site in a GitHub account of their own, they make a repository there and upload those files. It can then be added to Kiln like any site that is on GitHub, from "Set up your site" in the dashboard, after they sign in with GitHub.</li>
        <li>When the new site works, they press Remove on the old one. You then get the note about its repository (section 04).</li>
      </ol>
      <p>Moving the repository itself with GitHub's "Transfer ownership" has not been tried. Kiln's record of the site would still say that Kiln keeps its files, and the download and the editor's sign-in would then ask the wrong place. If a customer asks for exactly that, plan a working session and try it on the test service first.</p>

      <h3 class="sub">A file of a domain's records</h3>
      <p>While a site is in the customer's dashboard, they download this file themselves with "Download the domain's records". After they remove the site, that button is gone and the zone is still in the hosting account.</p>
      <ol class="steps">
        <li>In the hosting account at Cloudflare, open the domain, then DNS, then Records.</li>
        <li>Press "Import and Export", then Export. Cloudflare gives you a text file of every record.</li>
        <li>Send it to the address the customer signed up with.</li>
      </ol>

      <h3 class="sub">A domain somebody else holds</h3>
      <ol class="steps">
        <li>See what Kiln has on record for the domain:</li>
      </ol>
      <pre>npx wrangler d1 execute kiln-cloud --env production --remote --command "SELECT site_id, name, state, reason FROM domains WHERE name = 'DOMAIN_NAME';"</pre>
      <ol class="steps">
        <li>A row that is <code>waiting</code> or <code>live</code> belongs to the site with that id. The same command with <code>SELECT repo, origin FROM sites WHERE id = 'SITE_ID';</code> between the quotes names the site. Find it on the admin page and see whose it is.</li>
        <li>No row, and the domain is still listed in the hosting account: the zone was left from an earlier set-up. Read section 09 before you delete any zone.</li>
        <li>If two people claim one domain, the one who can change its name servers owns it. Ask each to show that.</li>
      </ol>
    </section>

    <section id="s6">
      <h2><span class="sn">06</span> Free days</h2>
      <p>Every site gets seven free days. These rules stop the same person from starting them again and again.</p>
      <ul class="plain">
        <li>A first site in a repository gets seven free days.</li>
        <li>A repository is remembered by GitHub's permanent number. Removing the site and adding the same repository again, at another address or from another account, keeps the old clock.</li>
        <li>An account that pays for nothing and adds a second repository has that site's days counted from its first site.</li>
        <li>An account that pays for at least one site gets seven fresh days for each new repository.</li>
        <li>When a site that is not paid for goes live on a domain, Kiln remembers the day its free days began. A later unpaid site on that domain is counted from that day.</li>
        <li>A site added when its days are already over is closed for editing at once, and the customer reads why and how to subscribe.</li>
      </ul>
      <p>"Bring my site in" has its own count: three copies of one old address in 30 days, between all accounts that pay for nothing.</p>

      <h3 class="sub">The marks</h3>
      <p>Kiln remembers these in the store. The first four never run out, and each holds a time in milliseconds.</p>
      <div class="tw"><table>
        <thead><tr><th>Key</th><th>What it remembers</th></tr></thead>
        <tbody>
          <tr><td><code>firstseen:ADDRESS</code></td><td>The site address as typed, for example <code>firstseen:https://club.example</code></td></tr>
          <tr><td><code>firstseen:repo:NUMBER</code></td><td>The repository, by GitHub's permanent number</td></tr>
          <tr><td><code>firstseen:gh:NUMBER</code></td><td>The GitHub account, by GitHub's permanent number</td></tr>
          <tr><td><code>firstseen:domain:NAME</code></td><td>A domain that a site which was not paid for went live on, in lower case</td></tr>
          <tr><td><code>copied:ADDRESS</code></td><td>The times an old site address was copied in, without <code>www.</code> It goes by itself 30 days after the last copy.</td></tr>
        </tbody>
      </table></div>

      <h3 class="sub">Hand job 1: find a mark</h3>
      <pre>npx wrangler kv key list --binding KILN --env production --remote --prefix firstseen:</pre>
      <p>A good answer is a list of keys. Look for the address, the repository's number or the account's number.</p>

      <h3 class="sub">Hand job 2: clear a mark, to give somebody fresh days</h3>
      <pre>npx wrangler kv key delete --binding KILN --env production --remote "firstseen:repo:123456"</pre>
      <p>A site's days are counted from the <strong>earliest</strong> of its marks. To give fresh days you usually clear all that apply: the address, the repository and the account. To set a chosen day in place of a fresh start, write the mark with a time of your own:</p>
      <pre>npx wrangler kv key put --binding KILN --env production --remote "firstseen:gh:101" "TIME_IN_MILLISECONDS"</pre>

      <h3 class="sub">Hand job 3: reopen a site that was closed</h3>
      <p>Clearing a mark does not reopen a site that is already closed. Either the customer removes the site and adds it again, or you reopen it. First find the site's id by its repository, then reopen it. The second command only touches a site that has no subscription.</p>
      <pre>npx wrangler d1 execute kiln-cloud --env production --remote --command "SELECT id, repo, origin, status FROM sites WHERE lower(repo) = lower('OWNER/REPOSITORY');"</pre>
      <pre>npx wrangler d1 execute kiln-cloud --env production --remote --command "UPDATE sites SET status = 'trialing', created_at = TIME_IN_MILLISECONDS WHERE id = 'SITE_ID' AND ls_subscription_id IS NULL;"</pre>
      <p>A good answer says one row was written. Use the time of this moment for seven full days. Zero rows means the id is wrong or the site has a subscription.</p>
    </section>

    <section id="s7">
      <h2><span class="sn">07</span> Hosting</h2>
      <h3 class="sub">How a site goes up, and is published again</h3>
      <ol class="steps">
        <li>The customer presses "Put it on Kiln's hosting" on the site's row. Kiln reads the repository's files and uploads them as a Worker in the hosting account. You get "Kiln hosts REPOSITORY" the first time.</li>
        <li>After that, each push to the repository's main branch publishes the site again within seconds. GitHub tells the service about the push through the App. That notice is called a webhook, and it arrives at <code>/gh/webhook</code>, signed with <code>GH_WEBHOOK_SECRET</code>.</li>
        <li>If a notice is lost, the five-minute timer notices the change and publishes. The customer can also press "Publish again".</li>
        <li>A site that may not be edited (free days over, plan ended) is not published again until it may.</li>
      </ol>

      <h3 class="sub">When it fails: what the customer sees, and where you look</h3>
      <div class="tw"><table>
        <thead><tr><th>The customer reads</th><th>What it means</th></tr></thead>
        <tbody>
          <tr><td>"Kiln found no home page (a file named index.html) ..."</td><td>The repository has no <code>index.html</code> at its top. They add one and Kiln puts the site up by itself.</td></tr>
          <tr><td>"REPOSITORY has no files yet."</td><td>An empty repository.</td></tr>
          <tr><td>"The Kiln app is not installed on that repository yet, or it was removed ..."</td><td>They must install the GitHub App on the repository again.</td></tr>
          <tr><td>"GitHub did not answer just now." or "Kiln could not put the new files up just now."</td><td>A passing fault. The site is as it was, and Kiln tries again in a few minutes.</td></tr>
          <tr><td>"This site has more files than Kiln's hosting takes on by itself."</td><td>Section 05.</td></tr>
        </tbody>
      </table></div>
      <ol class="steps">
        <li>On the admin page, press Diagnose on the site's row. It checks that the App is installed, that the site answers, and that the site may be edited.</li>
        <li>In the logs (section 14), search for <code>hosting_failed</code> and the repository's name. The line carries what Cloudflare or GitHub said.</li>
        <li>If the same site fails for more than an hour with a passing fault, look for its Worker in the hosting account, under Workers and Pages. Note what you see and plan a working session.</li>
      </ol>

      <h3 class="sub">Taking a site down by hand</h3>
      <p>The only way that takes a site down at once is to remove it.</p>
      <ol class="steps">
        <li>On the admin page, press Remove on the site's row and confirm.</li>
        <li>Kiln cancels the subscription at Lemon Squeezy, takes the site's Worker away, and deletes the site's row. The repository is not touched. A domain's zone stays (section 09).</li>
        <li>If Remove fails and the page shows an error with the number 502, the subscription could not be cancelled. Cancel it in Lemon Squeezy yourself, then press Remove again.</li>
        <li>If it was a kept site, write down today's date and the repository's name. Removing from the admin page sends you no "Kiln no longer uses" note, and the 30 days of section 16 still apply.</li>
      </ol>
      <p>There is no button that takes a site down and keeps it on the customer's account. Setting a site to <code>canceled</code> on the admin page stops editing at once, and the site then comes down by the timer's rules below.</p>

      <h3 class="sub">Putting a site back</h3>
      <ul class="plain">
        <li><strong>Taken down by the timer.</strong> The customer subscribes, then presses the button on the site's row to put it up. To open it yourself, set the site to <code>active</code> on the admin page and ask them to press the button.</li>
        <li><strong>Removed.</strong> The site is added again from the dashboard, like a new one. For a kept site see section 05.</li>
      </ul>

      <h3 class="sub">When the free days or the plan end</h3>
      <ul class="plain">
        <li><strong>Free days over, nobody subscribed.</strong> Editing stops. The site stays up for three more days, then comes down.</li>
        <li><strong>A payment failed.</strong> Editing stays on for seven days while Lemon Squeezy tries the card again.</li>
        <li><strong>A paid plan ended.</strong> Editing stops. The site stays up for 30 days after the day payment stopped. The customer gets two emails: one when editing stops, which names the day the site comes down, and one seven days before that day.</li>
        <li>In each case you get "Kiln took REPOSITORY down from its hosting" when it happens. Nothing is deleted from the repository.</li>
      </ul>

      <h3 class="sub">The members area on hosting</h3>
      <p>A site can keep pages under <code>members/</code> for signed-in members only. On the hosting, a small gate in the site's Worker asks the service whether a member is still on the list. The gate needs the secret <code>HOSTING_MEMBER_KEY</code>. Without it Kiln leaves the pages under <code>members/</code> out of the site, so they answer "not found". They are never open. The customer reads about it under "Check this site", and the logs get <code>hosting_members_left_out</code>.</p>
    </section>

    <section id="s8">
      <h2><span class="sn">08</span> Previews</h2>
      <p>When somebody writes a suggestion or a shared draft in Kiln, it is saved on a branch of the repository, and a hosted site gets a preview address for it: a Worker of its own in the hosting account, named <code>pv-</code> and so on (section 01).</p>
      <ul class="plain">
        <li>A site has at most <strong>five</strong> previews. When a sixth is wanted, the oldest makes room.</li>
        <li>A site gets at most <strong>sixty</strong> copies of previews in an hour.</li>
        <li>A preview comes down when its branch is deleted, when the suggestion is decided, when nobody changed it for 30 days, and when its site comes down.</li>
        <li>A preview never carries the pages under <code>members/</code>.</li>
        <li>A preview is never listed by search engines: every page of it says <code>noindex</code>.</li>
        <li>Only a branch written in Kiln as a suggestion or a shared draft gets a preview. Other branches get none.</li>
      </ul>
      <p>In the logs, search for <code>preview_too_many</code>, <code>preview_not_up</code> and <code>preview_removed</code>. Each line names the repository and says why.</p>
      <div class="call rule"><span class="tag">One known limit</span><p>A person the owner has invited as an editor of the whole site can save old or unfinished content of the repository on a suggestion branch through Kiln, and it then shows at the preview address, which is not listed anywhere. That person can already publish to the site itself, so this was accepted.</p></div>
    </section>

    <section id="s9">
      <h2><span class="sn">09</span> Own domains and email forwarding</h2>
      <h3 class="sub">How a domain is set up</h3>
      <ol class="steps">
        <li>The customer types the domain on the site's row. Kiln makes a zone for it in the hosting account and copies the domain's records into it. You get "Kiln is setting up DOMAIN".</li>
        <li>The customer replaces the name servers at the company that sold them the domain with the two Kiln shows.</li>
        <li>The five-minute timer sees the change, attaches the domain to the site's Worker, and writes to the customer that the site is live there.</li>
      </ol>

      <h3 class="sub">The states of a domain</h3>
      <div class="tw"><table>
        <thead><tr><th>State</th><th>Reason</th><th>What it means</th></tr></thead>
        <tbody>
          <tr><td><code>waiting</code></td><td></td><td>The zone is made and the name servers have not changed yet. One reminder after 14 days.</td></tr>
          <tr><td><code>waiting</code></td><td><code>taking_hold</code></td><td>Cloudflare has seen the name servers. The certificate and the address are being attached. If this lasts 24 hours you get a note.</td></tr>
          <tr><td><code>live</code></td><td></td><td>The site answers at the domain.</td></tr>
          <tr><td><code>failed</code></td><td>a code</td><td>The set-up could not be made. The customer read why and can start again.</td></tr>
          <tr><td><code>put_away</code></td><td><code>not_changed</code></td><td>The name servers were not changed within 25 days. Kiln removed the waiting zone. The customer can start again.</td></tr>
          <tr><td><code>put_away</code></td><td><code>moved</code></td><td>The name servers no longer point at Kiln. The site is still up at its Kiln address. The zone was left alone.</td></tr>
          <tr><td><code>put_away</code></td><td><code>gone</code></td><td>Cloudflare no longer holds the zone.</td></tr>
          <tr><td><code>put_away</code></td><td><code>hosting_ended</code></td><td>Kiln took the site down from its hosting. The domain's other records, such as its email, keep working.</td></tr>
          <tr><td><code>put_away</code></td><td><code>site_removed</code></td><td>The site was removed from the dashboard. The other records keep working.</td></tr>
        </tbody>
      </table></div>
      <p>To list every domain and where it stands:</p>
      <pre>npx wrangler d1 execute kiln-cloud --env production --remote --command "SELECT name, state, reason FROM domains ORDER BY state;"</pre>

      <div class="call caution"><span class="tag">A zone outlives the site</span><p>When a customer leaves, or a site comes down, the zone stays in the hosting account, so the domain's email records keep answering. Delete a zone only when its owner asks you to, or when the domain has plainly moved away. To check, type <code>dig NS DOMAIN_NAME +short</code>. If the two names it prints are no longer the ones Kiln gave (they are in your note "Kiln is setting up DOMAIN"), the domain has moved.</p></div>

      <h3 class="sub">Email forwarding</h3>
      <p>A site that is live at its own domain can have one address there, such as hello@ their domain, whose mail is passed on to an inbox the owner already reads. It only receives. Cloudflare does the forwarding, with its Email Routing. A domain that has email of its own is never touched.</p>
      <ul class="plain">
        <li><strong>"Waiting for the inbox"</strong> means Cloudflare has emailed the inbox and its owner has not pressed the button in that email yet. Until they do, Cloudflare refuses the rule, and Kiln never says forwarding works. The customer can press "Send it again", at most every ten minutes. Kiln reminds them once after 7 days and stops waiting after 30.</li>
        <li><strong>A test email may bounce in the first minute.</strong> People press the button and write to the new address straight away. The rule is made by the timer that looks every minute, and mail that arrives before the rule exists is sent back. Ask them to send it again.</li>
        <li><strong>Cloudflare's own log of forwarded mail</strong> is in the dashboard of the hosting account: the domain, Email, Email Routing, Activity log. It shows each message and whether it was forwarded or dropped.</li>
        <li>In Kiln's logs, search for <code>forward_on</code>, <code>forward_failed</code> and <code>forward_stopped</code>.</li>
      </ul>
    </section>

    <section id="s10">
      <h2><span class="sn">10</span> Leaving</h2>
      <p>A customer who leaves Kiln's hosting is given three steps, in this order, so that nothing stops working on the way. They are on the website under "Leaving Kiln's hosting", and on the site's row under "Moving away".</p>
      <ol class="steps">
        <li><strong>The site's files.</strong> In their own repository they already have them. For a kept site they press "Download the site's files", which works once the site has been paid for. You get a note each time.</li>
        <li><strong>The domain's records.</strong> They press "Download the domain's records" and give the file to the company that looks after the domain next. They must do this before they press Remove.</li>
        <li><strong>The name servers.</strong> At the company that sold them the domain, they replace Kiln's two name servers with the new company's. Kiln notices by itself and writes to them. A forwarded address stops working at that moment, so they set it up at the new company first.</li>
      </ol>
      <p>A customer who only stops paying loses nothing at once: see section 07 for the 30 days and the two emails.</p>
      <h3 class="sub">What you may be asked for by email</h3>
      <div class="tw"><table>
        <thead><tr><th>They ask for</th><th>What you do</th></tr></thead>
        <tbody>
          <tr><td>The domain's records, after they pressed Remove</td><td>Section 05, "A file of a domain's records".</td></tr>
          <tr><td>The files of a kept site, when the button refuses</td><td>The button refuses a kept site that was never paid for. Whether to send the files anyway is yours to decide. If yes: open the repository in <code>kiln-sites</code> on GitHub, press Code, then Download ZIP, and send it to the address they signed up with.</td></tr>
          <tr><td>The repository itself, for a kept site</td><td>Section 05, "Handing a kept site's repository over".</td></tr>
          <tr><td>Their zone deleted</td><td>Check the request comes from the address they signed up with, and that the name servers have moved (section 09). Then, in the hosting account, open the domain and remove it from Cloudflare.</td></tr>
          <tr><td>Everything Kiln knows about them deleted</td><td>Follow <code>docs/deleting-data.md</code> (section 11).</td></tr>
        </tbody>
      </table></div>
    </section>

    <section id="s11">
      <h2><span class="sn">11</span> Accounts</h2>
      <ul class="plain">
        <li><strong>A person who signs in with GitHub is found by GitHub's permanent number,</strong> not by their login name. A person who renames their GitHub login keeps their dashboard, and the new login is written down at their next sign-in.</li>
        <li><strong>An account made before Kiln kept that number</strong> gets it the next time its person signs in. To fill the numbers in at once, run <code>node scripts/fill-github-ids.mjs LOGIN</code>. It only prints the database statements, and <code>ENVIRONMENTS.md</code> says how to check and run them.</li>
        <li><strong>A person who signed in with Google only</strong> has an account by email address, and no login. The admin page shows the address in place of a login.</li>
        <li><strong>You are the operator</strong> because your GitHub number is in <code>CLOUD_ADMIN_ID</code>. A stranger who registers your old login gets nothing.</li>
      </ul>
      <p>To find a person's account by their address:</p>
      <pre>npx wrangler d1 execute kiln-cloud --env production --remote --command "SELECT id, github_login, email FROM accounts WHERE email = 'ADDRESS';"</pre>
      <h3 class="sub">Removing a person's data on request</h3>
      <p>Follow <code>docs/deleting-data.md</code> in the repository. It lists everything Kiln keeps about a person or a site, where each part is, and the steps for three cases: an invited person, a customer's whole account, and an owner who leaves and keeps their site. Add <code>--env production</code> to each command you take from it.</p>
    </section>

    <section id="s12">
      <h2><span class="sn">12</span> Releasing a new version</h2>
      <p>A release goes to the test service first and to production only after it has been seen working there. The commands are run from the top folder of the repository.</p>
      <ol class="steps">
        <li><strong>The checks on your side.</strong> <code>npm test</code> must end with no failures. <code>npm run build</code> rebuilds the editor. If it changes files in <code>dist/</code>, commit them.</li>
        <li><strong>The test service.</strong> <code>npm run deploy:test</code> applies new database changes to staging, puts the code there, checks that staging says it runs this commit, and then drives a real test site through it (<code>scripts/e2e.mjs</code> and <code>scripts/e2e-source.mjs</code>). A good run ends "staging now runs" and the commit.</li>
        <li><strong>Push.</strong> Push the commit to <code>main</code> on GitHub.</li>
        <li><strong>The repository's own checks.</strong> GitHub runs the tests again on its side. Wait for the green mark beside the commit.</li>
        <li><strong>Production.</strong> <code>npm run deploy:prod</code>. It refuses, with one sentence that says what to do, unless all of these hold: you are on <code>main</code>; nothing is uncommitted; the commit is the one GitHub has; GitHub's checks passed for it; <code>dist/</code> is what the code builds; staging runs this same commit. Then it runs the test site on staging once more, applies database changes to production, tags the commit <code>prod-</code> and the date, puts the code up, checks that production says it runs this commit, and moves the <code>release</code> branch.</li>
        <li><strong>A new editor version, demo first.</strong> A release changes no site. <code>npm run propagate</code> copies the new editor to the demo at <code>kiln-demo.pages.dev</code> only. Wait for it to publish, and try it. Then <code>npm run propagate -- --customers</code> does the customers' sites you keep checked out, and refuses unless the demo already runs the new editor. It stops at the first site that fails and prints, for every change it pushed, the command that takes it back. Add <code>--dry-run</code> to see what would happen. Sites on Kiln's hosting get the new editor from the five-minute timer.</li>
      </ol>

      <h3 class="sub">Database changes</h3>
      <p>Each change to the database's tables is a numbered file in <code>worker/migrations/</code>. Such a file is called a migration. Both release commands apply the new ones before the code goes up, and applying one twice does nothing. A migration is never undone by rolling the code back (section 13).</p>

      <h3 class="sub">Four things that have gone wrong before</h3>
      <ul class="plain">
        <li><span class="chip c-crit">1</span><strong>A command without <code>--env</code>.</strong> It made a stray Worker. See the box in section 02.</li>
        <li><span class="chip c-warn">2</span><strong>The production step stops once with "GitHub 500".</strong> It asks GitHub whether the checks passed, and GitHub sometimes fails to answer. Nothing was changed. Run <code>npm run deploy:prod</code> again.</li>
        <li><span class="chip c-warn">3</span><strong><code>worker/index.js</code> may export functions only.</strong> Cloudflare refuses a Worker whose main file exports anything else, such as a plain value. Keep such a value inside the file without exporting it, or move it into another file.</li>
        <li><span class="chip c-warn">4</span><strong>Cloudflare Pages missed a push.</strong> During an outage of theirs, the website or the dashboard was not rebuilt after a push. Open the Pages project's page in the Cloudflare dashboard, find the newest deployment, and press "Retry deployment".</li>
      </ul>
      <p>Two older ones are guarded now: the staging line of section 01, and a value in the editor's code that was used before the line that sets it.</p>

      <h3 class="sub">One command worth knowing</h3>
      <p>Inside a site's folder, <code>npx github:kilncms/kiln#release doctor</code> checks the whole chain for that site and prints what passes and what fails.</p>
    </section>

    <section id="s13">
      <h2><span class="sn">13</span> Rolling back</h2>
      <p>Match the fix to what broke. If you are not sure what broke right after a release, roll the service back first: it is the one thing everybody shares, and it takes seconds.</p>
      <div class="tw"><table>
        <thead><tr><th>What broke</th><th>How to go back</th></tr></thead>
        <tbody>
          <tr><td><strong>The service</strong> (sign-in, saving, the dashboard)</td><td>Steps below the table. <strong>Always name the version.</strong></td></tr>
          <tr><td><strong>A hosted site's pages</strong></td><td>The customer uses History in Kiln. Every publish is a change in the repository, so nothing is lost, and the push publishes the site again.</td></tr>
          <tr><td><strong>A customer's editor files</strong></td><td>In their repository, undo the update with <code>git revert</code> and push.</td></tr>
          <tr><td><strong>The website or the dashboard</strong></td><td><code>git revert</code> in that repository, push. Pages publishes it again.</td></tr>
          <tr><td><strong>The database</strong></td><td>Within 30 days Cloudflare can put it back to an earlier moment: steps below. Older than that, load <code>d1.sql</code> from the nightly backup.</td></tr>
          <tr><td><strong>The store</strong></td><td>Unpack the newest nightly backup, then <code>node scripts/restore-kv.mjs kv.json --env staging</code> to look, and <code>--env production --i-mean-production</code> to restore.</td></tr>
        </tbody>
      </table></div>
      <h3 class="sub">Rolling the service back</h3>
      <pre>cd worker
npx wrangler deployments list --env production
npx wrangler rollback VERSION_ID --env production</pre>
      <p>The first command lists the versions with their times. Take the id of the one before the release that broke things. A good answer to the second says the rollback is done. Then check <code>curl https://auth.kilncms.com/healthz</code>.</p>
      <div class="call caution"><span class="tag">The database does not roll back with the code</span><p>A migration that ran stays. Older code usually works with a newer database, because migrations add things. If the older code fails on the database, do not try to undo the migration by hand: put the newer code back and mend the fault there.</p></div>
      <h3 class="sub">Putting the database back to an earlier moment</h3>
      <pre>npx wrangler d1 time-travel info kiln-cloud --env production --timestamp TIME
npx wrangler d1 time-travel restore kiln-cloud --env production --bookmark BOOKMARK_ID</pre>
      <p>The first prints a bookmark for that time. The second restores to it. Everything written since is lost, for every customer, so use it only when the database itself is damaged. The nightly backup and its restore steps are in <code>ENVIRONMENTS.md</code> under "Backups and restore".</p>
    </section>

    <section id="s14">
      <h2><span class="sn">14</span> Looking at what happened</h2>
      <h3 class="sub">What is happening now</h3>
      <pre>cd worker
npx wrangler tail --env production</pre>
      <p>Lines appear as requests arrive. Press <span class="kbd">Ctrl</span> <span class="kbd">C</span> to stop. It shows nothing from before you started it.</p>
      <h3 class="sub">What happened earlier</h3>
      <ol class="steps">
        <li>In the main account's Cloudflare dashboard, open Workers and Pages, then <code>kiln-auth</code>, then Logs.</li>
        <li>Set the time range to cover the moment the customer named.</li>
        <li>Search for an event name from the table, or for the repository's name. Most lines carry both.</li>
      </ol>
      <div class="tw"><table>
        <thead><tr><th>Search for</th><th>It means</th></tr></thead>
        <tbody>
          <tr><td><code>cron</code></td><td>A timer job ended. With <code>"ok":false</code> it failed, and the line says how.</td></tr>
          <tr><td><code>hosting_failed</code></td><td>A site could not be copied to the hosting. Kiln tries again.</td></tr>
          <tr><td><code>hosting_ended</code></td><td>A site was taken down because its time was over.</td></tr>
          <tr><td><code>hosting_members_left_out</code></td><td>A site's members pages were left out because the members key is not set.</td></tr>
          <tr><td><code>push_notice_failed</code>, <code>github_webhook_rejected</code></td><td>A notice of a push could not be acted on, or was not signed by GitHub.</td></tr>
          <tr><td><code>preview_too_many</code>, <code>preview_not_up</code></td><td>A preview was refused or failed.</td></tr>
          <tr><td><code>domain_stuck</code>, <code>domain_put_away</code>, <code>domain_live</code>, <code>domain_moved_away</code></td><td>The steps of a domain's life (section 09).</td></tr>
          <tr><td><code>forward_failed</code>, <code>forward_on</code></td><td>A forwarded address failed, or was switched on.</td></tr>
          <tr><td><code>bring_job_not_started</code>, <code>bring_not_hosted</code></td><td>A copy of a site could not start, or could not be put up afterwards.</td></tr>
          <tr><td><code>keep_start_failed</code>, <code>kept_not_reached</code></td><td>A kept site could not be started, or its repository could not be read.</td></tr>
          <tr><td><code>kept_files_failed</code></td><td>A customer pressed "Download the site's files" and GitHub gave no link. The line holds what GitHub answered. They were told to try again in a few minutes.</td></tr>
          <tr><td><code>domain_free_days_over</code></td><td>A site that was not paid for went live on a domain that has had its free days (section 06), and was closed for editing.</td></tr>
          <tr><td><code>signin_trouble</code></td><td>A sign-in failed, with the reason.</td></tr>
          <tr><td><code>webhook_rejected</code></td><td>A notice about billing arrived that was not signed properly.</td></tr>
          <tr><td><code>notify_failed</code>, <code>customer_mail_failed</code></td><td>A note to you, or an email to a customer, could not be sent.</td></tr>
        </tbody>
      </table></div>
      <div class="call caution"><span class="tag">One thing to watch</span><p>The test service once logged "Worker exceeded memory limit" during the release checks, on a request that saved pictures. Its cause has not been found. If you ever see that line on production, write down the time and the request, and treat it as a fault to report, not a blip.</p></div>
    </section>

    <section id="s15">
      <h2><span class="sn">15</span> Billing</h2>
      <ul class="plain">
        <li><strong>Payment is by Lemon Squeezy, and it is not open to the public yet.</strong> Lemon Squeezy charges the card, handles the taxes and appears on statements. You never touch a card number.</li>
        <li><strong>Only a signed notice from Lemon Squeezy makes a site "active".</strong> A customer cannot fake having paid.</li>
        <li><strong>Free days</strong> last seven days and end by themselves (section 06).</li>
        <li><strong>The admin page</strong> at app.kilncms.com/admin shows accounts, sites, how many are active, the monthly income, and a line that says "Store live", "Store in test mode" or "Billing not configured".</li>
        <li><strong>Prices are in three places that must agree:</strong> the Lemon Squeezy product, the service's income sum, and the website. Today: Kiln Cloud <strong>$4.99</strong> a month, Kiln Cloud + hosting <strong>$14.99</strong> a month.</li>
        <li><strong>Setting a site up for a customer is not sold.</strong> The payment company does not allow it. Point people to the plan with hosting and to the guides.</li>
      </ul>
      <h3 class="sub">While billing is not set up</h3>
      <ul class="plain">
        <li>Sites are added as before and get their free days.</li>
        <li>A customer who presses Subscribe reads "The payment page could not be opened just now. Nothing was charged."</li>
        <li>The free days still end after seven days. To keep a site open, set it to <code>active</code> on the admin page: choose the status in the list on the site's row and press the button beside it. Your word is final there, and no date closes the site afterwards.</li>
        <li>A kept site's files can be downloaded whether or not the site was paid for.</li>
      </ul>
      <h3 class="sub">A customer paid and the site still says Trial</h3>
      <ol class="steps">
        <li>In Lemon Squeezy, open the subscription and look at its webhooks, the notices it sent to Kiln.</li>
        <li>If one failed, send it again from there. A good result: you get "Kiln billing" with the status active, and the dashboard says so.</li>
        <li>Meanwhile, set the site to <code>active</code> on the admin page so the customer is not held up.</li>
      </ol>
      <p>To cancel, a customer presses "Manage billing" on the site's row, which opens Lemon Squeezy's own page. During the free days they press Remove, and nothing is charged.</p>
    </section>

    <section id="s16">
      <h2><span class="sn">16</span> A daily look, and a weekly one</h2>
      <h3 class="sub">Every day, in five minutes</h3>
      <ol class="steps">
        <li><strong>The health answer.</strong> <code>curl "https://auth.kilncms.com/healthz?deep=1"</code> says <code>"ok":true</code>. If not, section 13.</li>
        <li><strong>Your notes.</strong> Read what Kiln sent since yesterday. Act on the ones marked Hand in section 04.</li>
        <li><strong>The support inbox,</strong> info@kilncms.com. Section 05 has the cases.</li>
        <li><strong>Failed copies.</strong> Any note that begins "Kiln's copy of" or "Kiln could not start copying": see whether the customer got through on a later try.</li>
        <li><strong>Sites that are down.</strong> For each "Kiln took REPOSITORY down" note, ask whether you expected it. A paying customer's site should never be in one.</li>
        <li><strong>The admin page.</strong> New sites, free days about to end, and the store line.</li>
      </ol>
      <h3 class="sub">Every week</h3>
      <ol class="steps">
        <li><strong>The hosting account's Workers against the list of sites.</strong> In the hosting account, open Workers and Pages. Then list what Kiln has on record:</li>
      </ol>
      <pre>npx wrangler d1 execute kiln-cloud --env production --remote --command "SELECT h.name, h.state, s.repo FROM hosting h LEFT JOIN sites s ON s.id = h.site_id;"
npx wrangler d1 execute kiln-cloud --env production --remote --command "SELECT name, site_id, branch FROM previews;"</pre>
      <p>Every Worker that does not begin with <code>stg-</code> should be in one of the two lists. A Worker in neither list is a leftover: note its name and plan a working session before you delete anything.</p>
      <ol class="steps">
        <li><strong>The zones against the list of domains.</strong> Run the list of domains (section 09) and compare it with the domains in the hosting account. A zone whose domain is put away, or has no row, stays unless its owner asked or it has plainly moved (the box in section 09).</li>
        <li><strong>Kept repositories due for deletion.</strong> Search your mail for "Kiln no longer uses". For each one whose day has come, first make sure no site uses the repository:</li>
      </ol>
      <pre>npx wrangler d1 execute kiln-cloud --env production --remote --command "SELECT id, status FROM sites WHERE lower(repo) = lower('kiln-sites/REPOSITORY');"</pre>
      <p>A good answer has no rows. Then, on GitHub, open the repository in <code>kiln-sites</code>, go to Settings, and at the bottom press "Delete this repository". If the answer has a row, the customer came back: leave the repository alone.</p>
      <ol class="steps">
        <li><strong>The timers.</strong> In the logs, search for <code>cron</code> together with <code>false</code> over the last week. One failure now and then is a passing fault. The same job failing every run is not.</li>
        <li><strong>The backup.</strong> Check that the newest nightly backup is from last night (<code>ENVIRONMENTS.md</code>, "Backups and restore").</li>
      </ol>
    </section>

    <section id="s17">
      <h2><span class="sn">17</span> GitHub: issues and pull requests</h2>
      <p>Kiln's code is public. That brings a little gardening. None of it is urgent, and none of it can hurt a customer.</p>
      <ul class="plain">
        <li><strong>An issue</strong> is somebody reporting a fault or asking a question. Read it and answer plainly. Ask one thing first: is a paying customer affected? If yes, it comes first. If no, it can wait.</li>
        <li><strong>A pull request</strong> is somebody proposing a change to the code. It does nothing until you merge it. Never merge code you have not had reviewed, and never merge to be polite. A safe answer: "Thank you. I will review this when I get a chance."</li>
        <li><strong>The license</strong> is the AGPL. Anyone may use and change Kiln for free. Whoever runs a changed version as a public service must publish their changes. It does not stop you charging for Kiln Cloud.</li>
      </ul>
    </section>

    <section id="s18">
      <h2><span class="sn">18</span> Known gaps</h2>
      <p>What is still done by hand, or not done at all, as of the date at the top. None of these loses a customer's pages.</p>
      <ul class="plain">
        <li><span class="chip c-warn">Hand</span><strong>A removed kept site's repository is deleted by hand,</strong> 30 days later. Nothing reminds you but the note.</li>
        <li><span class="chip c-warn">Hand</span><strong>No button puts a removed kept site back,</strong> and the steps for doing it in the database are not written.</li>
        <li><span class="chip c-warn">Hand</span><strong>Handing a kept site's repository to a customer</strong> is done on GitHub, and what Kiln's record needs afterwards has not been tried.</li>
        <li><span class="chip c-warn">Hand</span><strong>A file of a domain's records after Remove</strong> comes from you.</li>
        <li><span class="chip c-warn">Hand</span><strong>A domain bought at Cloudflare</strong> cannot be set up by Kiln, and no steps are written for doing it by hand.</li>
        <li><span class="chip c-warn">Missing</span><strong>No way to take one hosted site down and keep it on the account.</strong> Remove is the only way that works at once.</li>
        <li><span class="chip c-warn">Missing</span><strong>Removing a kept site from the admin page sends no note</strong> about its repository.</li>
        <li><span class="chip c-warn">Missing</span><strong>No note to you when a domain is put away.</strong> Only the log line and the customer's email.</li>
        <li><span class="chip c-warn">Missing</span><strong>No way to give a copy more than three tries,</strong> or to raise how many kept sites an account may start.</li>
        <li><span class="chip c-warn">Edge</span><strong>Free days for sites added before the free-day marks existed.</strong> Such a repository or account has no mark until it next adds a site, so each can have one more round of free days. Kept sites are counted apart from sites in a customer's own repository.</li>
        <li><span class="chip c-warn">Edge</span><strong>The files of a kept site can be asked for without limit,</strong> and each time sends you a note.</li>
        <li><span class="chip c-warn">Edge</span><strong>The preview limit of section 08:</strong> an editor of the whole site can show old content at a preview address.</li>
        <li><span class="chip c-warn">Open</span><strong>"Worker exceeded memory limit" on the test service:</strong> seen once, cause not found (section 14).</li>
        <li><span class="chip c-good">Later</span><strong>Billing is not open to the public yet</strong> (section 15).</li>
      </ul>
    </section>
  </main>
</div>

<footer><div class="wrap">Kiln Operator's Playbook · private reference · served to the operator alone at /admin/cloud/runbook</div></footer>

</body></html>`;
