# Playbook text for "a new domain through Kiln": renewal, ending and leaving

This branch still has the old playbook in `worker/runbook.js`. The fragments
below are for the new playbook on the main branch, to be pasted in when the
two are joined. They are plain HTML in the new playbook's own shapes. When
they are in, add a few of their words to `test/cloud-admin.test.js`, for
example "Handing a domain over to a customer who leaves", "Free this row" and
"Switch renewal off by hand".

## for section 10

<!-- Section 10, "Leaving": three new parts, after what is there today. -->

      <h3 class="sub">Handing a domain over to a customer who leaves</h3>
      <p>This is for a name Kiln registered for a customer on the yearly plan. That piece is switched off today (section 02), so no such name exists yet. When a customer presses "Take this name with me", Kiln writes to you with the subject "The owner of NAME wants to take it away". The rules for domain names let a name leave from 60 days after it was registered. A customer who asks earlier is told the day, and on that day Kiln writes to you again with the subject "NAME may leave from today". Then do this.</p>
      <ol>
        <li>Check that the request came from the account's own email address, and that the name was registered more than 60 days ago. The admin page shows the date.</li>
        <li>Open the site's records file from the admin page and email it to the customer, so that they can set the same records at the new place.</li>
        <li>In Cloudflare's dashboard, Kiln Hosting account: Domains, Manage domains, the name, Configuration. Confirm that auto-renew is off.</li>
        <li>Press Unlock and copy the authorization code. Never send it anywhere but the account's email address.</li>
        <li>Email the customer the code, and tell them two things: "start the move at your new company within five days" and "it completes by itself five days after you start it".</li>
        <li>When Cloudflare shows that the move was asked for, approve it there to save the customer the five days.</li>
        <li>Once it has completed and the customer says the site and email work, press "Handed over" on the admin page. The row becomes <code>handed_over</code> and Kiln forgets the site's domain. Then delete the zone in Cloudflare.</li>
        <li>If the customer wants the name in their own Cloudflare account instead: they add the name to their account first. You start "Move to another account" from the same Configuration page, and they accept within five days. Records are not carried over, so step 2 matters. The name is then locked for 30 days. The name is registered to Kiln's company, so they should change the holder to themselves, which starts a new 60-day wait before it can go to another company.</li>
      </ol>

      <h3 class="sub">A registration that needs you: the three buttons</h3>
      <p>When Kiln asked Cloudflare to register a name and never heard how it went, the row is <code>stuck</code>, and Kiln writes to you with the subject "A person must look: registering NAME stopped part way". Kiln never asks for that name a second time by itself, because a second call could be paid for twice. Look for the name in Cloudflare's dashboard, Kiln Hosting account, under Domains. Then press one of the buttons on the admin page.</p>
      <ul class="plain">
        <li><strong>Free this row.</strong> Press it only when you have seen that no name was registered. You must type the name out. The row becomes <code>failed</code>, the customer gets an email that nothing was charged, and they may choose a name again. It works for a row that is <code>stuck</code>, or still <code>asking</code> after 15 minutes. It is refused for a registered name.</li>
        <li><strong>Mark registered.</strong> Press it when you have seen the name in Cloudflare. The row becomes <code>registered</code>, the customer gets the email that the name is theirs, and Kiln puts the site on the name. The answer says whether Cloudflare showed the name when Kiln looked.</li>
        <li><strong>Handed over.</strong> Press it at step 7 above, when a name has left with its customer.</li>
      </ul>
      <p>None of the three can register a name. To see every registration and how it stands:</p>
      <pre>npx wrangler d1 execute kiln-cloud --env production --remote --command "SELECT name, state, reason, renews, expires_at, leave_asked_at FROM registrations ORDER BY created_at DESC;"</pre>

      <h3 class="sub">Switching renewal off by hand</h3>
      <p>When a yearly plan is canceled, runs past its grace or is removed, Kiln asks Cloudflare within five minutes to stop renewing the name, and then reads the registration back. It writes down that the name will not renew only when Cloudflare shows that. If the change is refused or does not show, Kiln writes to you with the subject "Switch renewal off by hand for NAME", once a day until it reads off. In Cloudflare's dashboard, Kiln Hosting account: Domains, Manage domains, the name, Configuration. Switch auto-renew off there. Kiln sees it on its next try, within a day, and stops writing. Until it is off, Cloudflare charges the hosting account for another year when the name's year ends. The same note with "on" in its subject means the customer paid again and the name should renew: switch auto-renew on in the same place.</p>
      <p>The owner of a name that will not renew gets an email 30 days and 7 days before it runs out. Past that day the row becomes <code>ran_out</code>, Kiln puts the site's domain away, and it writes to you with the subject "NAME ran out". Nothing is deleted at Cloudflare. Delete the zone there when you are sure nobody needs its records.</p>
      <p>To follow one name, watch the logs (section 14) for the lines <code>renewal_off</code>, <code>renewal_off_failed</code>, <code>renewal_on</code>, <code>name_leave_asked</code>, <code>name_handed_over</code> and <code>name_ran_out</code>:</p>
      <pre>npx wrangler tail --env production</pre>

## for section 02

<!-- One row for the table under "What switches each piece on". -->

          <tr><td><strong>A new domain through Kiln</strong> (switched off)</td><td>Own domains, the variable <code>REGISTER_DOMAINS</code> set to exactly <code>on</code>, and the database has its <code>registrations</code> table. The variable is not set on the test service or on production, so this piece is off.</td><td><code>registers</code> is true, and the dashboard offers a site on the yearly plan a new name. While it is off, none of its pages answer, the three buttons of section 10 do nothing, and its part of the five-minute timer does nothing.</td></tr>

<!-- The map's line (section 01), for the list under "The second Cloudflare account: Kiln Hosting". -->

        <li><strong>One registered name for each yearly plan that chose one.</strong> Kiln registers it in this account, where it shows under Domains, and the name's zone is here too. This piece is switched off today (section 02), so there are none yet.</li>
