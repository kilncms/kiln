# Changelog

All notable changes to Kiln are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **A hosted site's own domain can have one email address forwarded to an
  inbox its owner already reads.** The service now answers the dashboard for
  it, though no page asks yet. `GET /cloud/sites/mail?site=` says what stands
  and whether forwarding is offered: only at a domain that is live, that has no
  email of its own, on a site that may be edited. When it is not offered, the
  answer holds the sentence why. `POST /cloud/sites/mail` sets it up (mail is
  switched on for the domain, Cloudflare writes to the inbox, and Kiln waits),
  asks whether the inbox has confirmed, has the confirmation email sent again
  at most once every ten minutes, and stops it (the rule goes, the domain's
  mail records stay). The rule is made only once Cloudflare says the inbox has
  confirmed, by "check now" or by the five-minute job, and the owner is then
  written to: "hello@yourdomain.com now reaches you@inbox". An inbox that
  confirmed earlier gets no second email, and the address is on at once, but
  only when the Kiln account has shown that the inbox is its own: it is the
  address on the account, or another of the account's sites already forwards
  to it. Every customer's domain is in one Cloudflare account, where an inbox
  that confirmed for one customer counts as confirmed for all of them, so an
  inbox that confirmed at somebody else's asking is refused (`inbox_elsewhere`)
  with one sentence that says to use the address on the account or to write to
  info@kilncms.com, and nothing is made at Cloudflare. "Check now", "Send it
  again" and the five-minute job hold to the same rule before a rule is made
  or an email is sent. When
  an inbox has not confirmed after 7 days its owner gets one reminder, and
  after 30 days Kiln stops waiting and says so on the site's row. A domain
  with email of its own is never touched, and a parked domain that says "no
  mail here" is told first that those two records are replaced. A change to a
  new inbox waits beside the address that works: the row stays on with the
  address and inbox that work, and carries `changing_to` (the address, the
  inbox and when it was asked for) until the new inbox confirms. Then the rule
  is replaced, the row takes the new address and inbox, and the owner is
  written to. "Send it again" and the reminder after 7 days are about the
  waiting change, and after 30 days only the change is dropped: an address
  that works is never switched off by waiting. A change of the address alone,
  to the same inbox, happens at once, and stopping drops a waiting change with
  the address. When hosting
  ends or a site is removed, the forwarded address is left as it is, so mail
  keeps arriving for as long as the domain's name servers point at Kiln.
  `/cloud/me` carries `forwarding` and each site's `forward`. The setup tool
  now copies `worker/domain-mail.js` for a service somebody hosts themselves.
### Fixed

- **A person who suggests a change now learns what became of it, and an
  owner is told that one waits.** A tester sent two suggestions as an invited
  person who may only suggest. The owner approved one and declined the other
  with a note. Back as the suggester there was nothing about either, though
  the owner's dialog says "The person who suggested it sees that it was
  declined, with your note if you write one." Now the suggester's Kiln menu
  has "My suggestions" once they have sent one. It lists each one: the page,
  the day it was sent, and where it stands ("Waiting for the owner",
  "Approved and published on Thursday 12 November", "Declined on Thursday 12
  November" with the owner's note). When one was decided since they last
  looked, the Kiln button shows a small dot and the status line says it once,
  for example "Your suggestion for About was approved and is live." or "Your
  suggestion for About was declined: Not this month." Opening the list
  clears the dot. An owner with a suggestion waiting sees the same dot and
  reads once on each page load "1 suggestion is waiting for you: Kiln menu,
  then Suggestions." Kiln's service already gave an invited person their own
  suggestions only. It now also refuses to match two sign-ins that both lack
  an email address, so nobody reads a suggestion that is not theirs.
- **People who signed out no longer count as online.** A tester signed in as
  one person after another in one browser, and the Kiln menu read "2 online",
  then "3 online": each person who had signed out kept counting for up to six
  and a half minutes. Now Sign out tells Kiln's service that the person has
  left, and they stop counting at once. The sign-out never waits more than a
  second and a half for this and goes ahead whatever the service answers. A
  person counts once however many tabs they have open, and never counts
  themselves. A service older than this release ignores the new message, and
  the person stops counting when their entry runs out, as before.
- **Leaving the page while any save is being sent asks first.** Since 0.6.5
  the browser asks "Leave site?" while a Publish or a "Save to all pages"
  is on its way. A tester left during one of the editor's other saves and
  the change was lost without a word. Now every save that writes to the site
  is counted, from the press of its button until Kiln's service has answered
  or the attempt has failed: "Replace everywhere", Theme's Apply, Page
  settings' Publish, Settings' Save, making, duplicating, removing or
  deleting a post or a page, Save as draft and Delete draft, scheduling a
  change and cancelling one, sending a suggestion and approving or declining
  one, Undo after a publish, "Go back to this" and Undo on a site built from
  content files, naming a version in History, "Make this whole page
  editable" and adding the first reusable block. The demo sends nothing and
  asks nothing, as before.
- **No Publish button on a page you cannot change.** An invited editor who
  may change only some pages opened one that is not theirs. The status line
  said so, but the Kiln menu still showed a greyed Publish button that never
  woke, with no word of why. On a page they cannot change at all, the menu no
  longer shows Publish, Discard edits or Schedule for later. Everything that
  takes them to a page they can work on stays, with changes they already
  scheduled and Sign out. On a page where some parts are theirs, nothing
  changes.

## [0.6.5] - 2026-11-13

### Fixed

- **A domain can be set up again after its set-up was put away or the domain
  was moved away.** The emails for both say the owner can set the domain up
  again, and pressing the button was refused with "Kiln's hosting already has
  the domain set up". Cloudflare keeps the earlier zone for a while (about a
  week after the name servers move away), and Kiln asked it for a second one.
  Now the set-up takes up the site's own earlier zone where Cloudflare still
  holds it, and makes no new one. The website records at the bare name and
  `www` are deleted again, every other record is set to DNS only, the two
  names are attached to the site's Worker where they are not, and Cloudflare
  is asked to look at the name servers again. The owner gets the same two
  name servers as before, in the dashboard and in a new email. While the name
  servers still point elsewhere the set-up waits, and the five-minute job does
  not put it away as one that was changed away again. When they already point
  back, the job makes the domain live as usual, and the owner is written to
  that it is live. A zone that is not this site's own earlier one is refused
  as before, and a zone taken up again is never deleted, whatever fails.
- **A domain whose name servers changed and which never goes live is no longer
  left waiting unseen.** The five-minute job put a set-up away after 25 days
  only while its zone still waited at Cloudflare. A zone that took hold, and
  whose certificate never arrived or whose site never answered, stayed
  "waiting" with a give-up day in the past, and nobody heard of it. Now, once
  the name servers have pointed at Kiln's hosting for more than 24 hours and
  the domain is still not live, the job writes one log line (`domain_stuck`,
  with the repository, the domain, and whether it waits for the certificate
  or for the site to answer) and sends the operator one note that says where
  to look. Both go once for a domain. The set-up stays as it is and nothing
  is removed, because the zone answers for the domain. The service also stops
  promising a day on which such a set-up is put away. From the moment
  Cloudflare has seen the name servers change, what the dashboard is told has
  no `gives_up_at` and carries `taking_hold: true`, so the dashboard can say
  that the name servers have changed and Kiln is finishing the set-up.
### Changed

- **Theme names each setting in words a shop owner uses.** A setting was listed
  under its style sheet name with the dashes taken out, so the starter site
  showed "R sm", "Maxw" and "Cream 2". Each is now named for what it does:
  "Corner roundness, small", "Widest the page gets", "Space at the page's
  edges", "Shadow, small", "Cream, second shade", "Heading font", "Text font".
  A name Kiln does not know keeps its own words ("Brand ink"), and a name of
  two or three letters is given the word for what it is ("Ink color"). The
  owner still sees the style sheet's own name in small print under it.
- **A font is shown by its name, and the one the site had can always be put
  back.** The list of fonts showed raw CSS and offered "Inter, serif", a
  sans-serif face with a serif fallback. Once another font was applied, the
  line the site started with was gone from the list. A font is now listed by
  its first family's name ("Fraunces", "Inter"). The value a setting had when
  Theme was opened stays in its list, marked "(as it is now)", or "(as it was
  before)" once Apply has changed it, and choosing it writes the original line
  back byte for byte. Every other face comes with fallbacks of its own kind:
  the site's own list for that face where it has one. A face Kiln cannot place
  is offered by itself. This memory lasts until the page is loaded again.
- **A value Theme cannot change safely shows "Set in the style sheet".** A
  shadow's long value, a gradient or a curve was printed raw beside its name.
  It now shows those words and nothing to type in. A shadow that starts with
  a color is no longer taken for a color.
- **Theme says what Apply will change before it publishes.** A sentence above
  the buttons names what is about to change: "This changes the mustard color
  and the heading font on every page." Two settings are named and the rest are
  counted. The history entry says the same ("Theme: mustard color, heading
  font (via Kiln)") where it said "Theme: 2 tokens". The dialog says "Saved 2
  changes", and the status line ends on "The new theme is live ✓". It no
  longer offers "View site" for a theme change, which opened the style sheet.
- **What is scheduled can be seen and cancelled at any time.** "Schedule for
  later…" was in the Kiln menu only while the page held an unpublished edit,
  and the list of what is already scheduled lived inside that dialog.
  Scheduling an edit clears it from the page, so the item left the menu, and
  the only way to see or cancel a scheduled change was to make a throwaway
  edit. The item now stays while anything is scheduled for the site: with
  nothing left to schedule it reads "Scheduled changes (2)" and opens the list
  alone. Each row says the page, the time in words to the minute ("Thursday 12
  November at 8:45 PM") and who scheduled it ("by you", "by Rosa", "by the
  site owner"). Cancel asks one question first, and says afterwards that the
  change was cancelled and that nothing was published. The list is drawn again
  as soon as a schedule is made or cancelled. It used to read "Nothing
  scheduled." until the dialog was reopened, because the service's list can
  run a minute behind. After scheduling, the dialog and the status line say
  when the change will be published, and that the page here shows the
  scheduled words until then while visitors still see the old ones.
  The count is read when the page loads, for the site's owner as for an
  invited editor, and what this browser scheduled or cancelled in the last
  two minutes is remembered across a reload, because the service's own list
  can be a minute behind (a tester found the owner's menu without the item
  after a reload, before this was released).

- **Leaving the page while a save is being sent asks first.** "Site menu >
  Save to all pages" writes many pages and takes ten seconds or more. Someone
  who closed the tab or followed a link in that time lost the save, and
  nothing warned them. From the press of the button until the service has
  answered, the browser now asks its own "Leave site?" question, and the same
  holds for a publish that is on its way. It asks at no other time, apart from
  the question it has always asked while there are unpublished edits.

## [0.6.4] - 2026-11-12

### Added

- **The service can set a hosted site up on its owner's own domain.** This is
  the service's side only: the dashboard's panel comes next. For a site that is up on
  Kiln's hosting, the service looks at a domain and changes nothing: who it
  was bought from, whether it has email, which records Kiln can see, and
  anything that must be done first (DNSSEC switched off where the domain was
  bought, a domain bought at Cloudflare, a name nobody owns). Setting it up
  makes everything ready on Kiln's side and leaves the domain's email records
  working. The records the old host left for every name are dropped, and
  every other record is kept. The owner gets an email with the two name
  servers to enter where the domain was bought, a link to that company's own
  instructions when Kiln knows them, how many records Kiln kept, and the day
  the set-up is put away if nothing happens. Until the name servers are
  changed, the site and its email stay where they are. The owner can ask Kiln
  to look again, stop a set-up that is not live yet, and download the
  domain's records as a file. A site whose editing is switched off can still
  do those three, so nobody is trapped. The list of sites says whether the
  service can do this at all and where each site's domain stands.
- **A site goes live at its own domain by itself.** Every five minutes the
  service looks at up to ten domains, the one it looked at longest ago first.
  Once a domain's name servers have changed and the site answers there, the
  domain is live: that is the site's address from then on, `www` is sent on
  to the bare name (or the other way round for a site whose address was the
  `www` one), every visitor gets HTTPS, and the owner gets an email with the
  address, saying that the temporary address keeps working and that email
  and the other records are untouched. A site that does not answer yet (a
  certificate takes a few minutes) is looked at again on the next run. A
  set-up still waiting after 14 days gets one reminder with the two name
  servers. After 25 days the set-up is put away and the owner is told how to
  start again. When the owner points a live domain's name servers elsewhere,
  the site goes back to its temporary address, nothing is deleted, and the
  owner gets an email saying how to bring the domain back.
  A domain is called live only once Cloudflare has issued its certificate,
  for the bare name and for `www`. The first trial on the staging service
  showed why: the service reaches the site inside Cloudflare's own network,
  where no certificate is needed, so the site "answered" minutes before a
  visitor's browser could open it (`certificateReady` in `worker/domain.js`).

- **Kiln can tell where a domain was bought when it asks from the live
  service.** The registry refused the question because it did not say who
  was asking. It says so now.
- **A site on its own domain can be edited at both of its addresses.** Once
  a domain is live, the owner and the people they invited can sign in and
  edit at the domain and still at the temporary address. While a domain
  still waits for its name servers, only the temporary address counts, even
  when the owner had already given the domain as the site's address: until
  the name servers change, what answers at the domain is not the site Kiln
  publishes (`worker/cloud.js`).
- **A site's own domain is dealt with when the site comes down or is
  removed.** A domain that still waits for its name servers is removed with
  the site. A domain that is live is taken off the site and put away, and
  everything else about it stays: its other records, such as its email, keep
  working. A site that stays on Kiln has its temporary address again, and its
  row says how to move the domain away (download its records, then change
  the name servers where the domain was bought). The note the operator gets
  when a site is taken down says the same in one more sentence, and so does
  the answer to removing a site. When Cloudflare does not answer, that is
  logged and the site comes down or is removed all the same
  (`worker/hosted.js`, `worker/cloud.js`, `worker/domain.js`).
- **"Check this site" knows about a site's own domain.** Once the domain is
  live, the check looks at the site there, and its lines still say that Kiln
  publishes a change. When the domain does not answer, the line says what
  the owner can have changed (its name servers) and what to press. While a
  domain still waits for its name servers, the check looks at the address
  the hosting gave the site and adds one line: the domain is ready on Kiln's
  side, it waits for its name servers to be changed where it was bought, and
  the site's row in the dashboard shows the two names to enter
  (`worker/sitecheck.js`, `worker/cloud.js`).

### Fixed

- **A sign-in that fails at its last step says so in plain words.** When
  GitHub or Google did not hand the sign-in over, the person was left on a
  page that read "GitHub OAuth error" above whatever the company had answered,
  such as the raw text of a "429, wait a few minutes" reply (seen for real on
  12 November). Each way that step can fail now has its own page: the company
  is asking everyone to wait; the sign-in was already used or took too long;
  the company did not answer; the service's own details were not accepted
  (which is for whoever runs the service); and Google could not confirm the
  address. Every page says whether anything is wrong with the person's account
  (it almost never is), what to do next, and links back to the sign-in page of
  the site they came from. What the company really answered goes to the
  service's log for whoever runs it, never with a token in it
  (`worker/signin-trouble.js`).

- **"Check this site" looks at a hosted site where it really is.** For a site
  on Kiln's hosting the check asked the address on record, which is the
  owner's own domain, and that domain is not pointed at Kiln. So the list said
  the address did not answer, or that Kiln was not on the page, and told the
  owner to look "at your host". The check now looks at the address the hosting
  gave the site, and says so. Where a line used to say "wait for your host to
  publish it", it says that Kiln publishes a change in a few seconds, and what
  to press when it has not (**Publish again** on the site's row). A hosted
  site that is not online, because it was taken down or has not gone up yet,
  gets the sentence that says why, and no address is asked for anything. A
  site on the hosting plan that its owner never put on Kiln's hosting is
  checked at its own address, as before. The answer carries `looked_at`, the
  address that was asked (`worker/sitecheck.js`, `worker/cloud.js`).
- **What the editor says is said plainly.** Adding an events list read "Added
  a events — click “+ Add event”, then Publish"; it reads "Added an events
  list. Click “+ Add event”, then Publish.", and a gallery "Added a gallery.
  Click “+ Add photos”, then Publish." In the publish sheet the button beside
  each change said "Drop" and nothing more. It takes that one edit off the
  page and puts that part back as it was, so it is named "Discard this edit"
  and says so when pointed at. A commit message names each part once: "Edit
  index.html: story_img, story_img, story_img, story_img" is "Edit
  index.html: story_img". Every "Committed ✓" is "Saved ✓" with a plain
  sentence after it, such as "Saved ✓ You can close this. Kiln will say when
  it is live." The suggestions dialog says that approving a suggestion
  publishes the suggested change on top of the page as it is now, saved in
  the name of the person who suggested it, and that declining publishes
  nothing. A schedule dialog says "Kiln publishes it at the time you pick,
  give or take five minutes." A scheduled time is said to the minute:
  "Scheduled for 11/12/2026, 8:38 PM ✓ You can close this." And no line in
  the editor's own files touched here has a dash in it any more: each is two
  sentences, or has a comma or a colon. The line by the Kiln button once a
  change is on the site reads "Your page edit: live ✓".

- **Sign out says that you are signed out, and where to sign in again.** After
  Kiln menu > Sign out the page came back with no Kiln button and not a word.
  The person now lands on the site's own sign-in page, whose card reads "You
  are signed out" above the site's name and the same two buttons. A site that
  has turned its sign-in page off (`entry: false`) goes to its home page as
  before, and so does the demo, which signs every visitor in again. It is
  said on the sign-in page, and not by a notice on the site's own pages,
  because that notice would have had to live in the small script every
  visitor of every site loads.

- **An editor on a page they may not change is told so, and told which pages
  they can change.** An invited editor can be given only some pages (say,
  those under `blog/`) or only some parts of pages. On a page outside their
  pages nothing was outlined and Publish did nothing, and the status line
  still read "Signed in as Rosa. Click any outlined text to edit." It now
  reads "Signed in as Rosa. This page is not one you can change. You can
  change: the pages under /blog/." Up to three pages and folders are named,
  then "and 2 more". On a page where only some parts are theirs it reads
  "Signed in as Rosa. You can change the outlined parts of this page.", and
  where no part is, "No part of this page is one you can change." Someone
  whose changes are suggestions reads "suggest changes to" in place of
  "change". The same sentence is there each time the line comes back, after
  a publish and after "live", and the note that stays on a page that is not
  theirs says it too, where it said "Read-only here. Your editing access
  covers: blog/".

- **Saving the site menu changes only what was changed.** "Site menu > Save to
  all pages" wrote every page's menu afresh from each link's words and address
  alone, so a link lost everything else it carried:
  `<a class="is-cta" href="/members-login.html">Members</a>` came back without
  its class on every page and both templates, and a styled button became a
  plain link. The indentation of the first link and of the closing tag changed
  too. Now each page's menu is worked out from that page's own text. A link
  that was already in the menu keeps every attribute it has on that page (its
  class, id, target, rel, aria and data attributes, anything), and only its
  words or its address are written, and only when the person changed them. A
  link that is moved moves whole, with its list item when it has one. A link
  that is removed goes whole. A link that is added is written like its
  neighbours: with the same whitespace before it, inside a list item when the
  others are, and with the class every link of that page shares when they
  share one. The whitespace before the first link, between the links and
  before the closing tag stays as the page had it. A page whose menu comes out
  the same is not written at all, and a save that changes nothing makes no
  change in the history and says so. An address is still made safe before it
  is written, and what is typed as a link's words can never become markup
  (`src/editor/menu-links.js`, `src/editor/menu-save.js`).

- **The Discard button, its question and the line after edits come back give
  the same number.** The menu said "Discard 2 edits", the dialog that followed
  asked "Discard 1 unpublished edit?", and just before that the line had said
  "1 edit restored". The button counted what the publish sheet lists, where a
  new picture and its description are two things, and the other two counted
  the parts of the page that hold an edit. All of them now say the number on
  the Publish button, and so does the question "Done editing" asks. The copy
  of the edits kept in the browser remembers that number, so "Pick up where
  you left off?" says it as well. The Discard button also asks its question
  when the only thing waiting is an uploaded file, where it used to do
  nothing (`src/editor/edit-count.js`).

- **On a phone, a tall block's buttons open where they can be seen.** A tap
  on a block's "more" button opens its buttons in a row at the foot of the
  block. On a tall block, such as a product card with a picture, that row is
  a long way from the button. With the card halfway down the screen the row
  opened below the screen, and the tap seemed to do nothing. Higher up, it
  opened under the editor's own buttons along the bottom of the screen: Undo,
  Redo and Publish, the demo's banner, and the guide's "Now publish it." tip.
  Now the page moves just far enough to show the whole row, clear of all of
  those and of a bar the site keeps at the top, and it stays where it is when
  the row already shows (`src/editor/in-view.js`).
- **"Go back to this" returns the whole page, and says that it did.** In
  History & restore, "Go back to this" promised the whole page as it was then
  and brought back only the parts marked as editable, written into today's
  file as ordinary edits. The page's title, its description and everything
  else in the file stayed as they are now, the change was saved as
  "Edit about.html: -events_mwe9ooml" with the status "Published.", and a
  version that differed only in its title got "The page already matches that
  version." Now the page's whole file goes back to that version, head
  included, as one new change on top of the history that throws nothing away.
  The bar with Cancel and Keep says what goes back that the page cannot show
  (the title, the description, the rest of the file), and still asks when no
  editable part differs. After Keep the Publish button is ready even when no
  part has a row, the publish sheet says the page is being restored and to
  what, the change is saved as "Restore about.html to how it was on Nov 12,
  7:50 PM (via Kiln)" (a named version by its name), and the status line
  afterwards says "Restored this page to how it was on Nov 12, 7:50 PM."
  Edits made after Keep go on top of the old version. Undo after Keep takes
  the waiting restore away, Undo after the publish leaves it waiting again,
  and a reload keeps it with the saved edits. Taking one of its parts out
  again turns it back into ordinary edits, and says so. The dialog now says
  what going back does not bring back: things kept in other files (the site
  menu on other pages, the theme, pictures that were removed from the site's
  files). The demo's history still brings back the editable parts only, and
  its words now say that. A person who may only suggest still sends the
  editable parts, and is told that the rest stays
  (`src/editor/restore-page.js`).
- **The first pass marks buttons, lists in the main text and the logo, and
  leaves forms alone.** On a WordPress shop copied into plain HTML, buttons
  such as "Shop Now" could not be clicked and changed, a list in a post could
  not be edited, the site's logo was not marked as a picture, and a product
  page's review form had "Name", "Email" and "Your email address will not be
  published" marked as if they were the page's own words. The first pass now
  marks a link or button that is plainly a button, by its class (`button`,
  `btn`, `wp-block-button__link`, `elementor-button` and the like) or
  `role="button"`. Its words can be changed, and its address is changed beside
  them, as with any marked link. A list in the main text of a page or post is
  marked as one part, so a line can be changed, added or taken out. The
  pictures in the site's header, the logo among them, are marked like other
  pictures. Nothing inside a form a visitor fills in is marked: no label, no
  note, no submit button. What keeps the handling it had: menus, lists of
  links, sidebars, the footer's lists, the header's words, and every part
  that is already marked. Three kinds of button are left unmarked: one with
  an icon drawn inside it (changing its words could lose the icon), one that
  opens a menu or panel, and one inside a group of repeating blocks.
- **The editor names the parts of a page in words anyone knows.** On a site
  made with a page builder the editor showed names such as "Elementor widg
  featured products" and "Astra shop picture 2", because a part's name was
  made from its class names and held to 14 letters, which cut "widget" in
  half. The first pass now makes no name from a page builder's, a theme's or
  a shop plugin's own classes (Elementor, WordPress blocks, Astra,
  WooCommerce, Divi, Beaver Builder, Squarespace, Wix and others like them).
  On such a page a part is named from its own words ("Featured products
  heading"), a picture from its description ("Yellow shoes picture"), and a
  picture without one from where it is ("Shop picture 2", "Footer picture").
  No name is cut in the middle of a word any more, on any site. Parts that
  were already named keep the name they have, and for those the editor leaves
  the builder's words out of what it shows, so a page marked before this
  reads "Featured products" and "Shop picture 2" as well.

- **A rescued site keeps its fonts and its icons.** A site that asked Google
  Fonts, Bunny Fonts or Font Awesome for its typefaces kept asking them after
  it was copied, and a copy made for a browser the service did not know got
  the oldest kind of font file or none. Rescue now copies the service's style
  sheet and the font files it names into the site like any other file, and it
  asks for them the way a current desktop browser does, so the copy holds the
  small woff2 files. That covers a style sheet linked from the page, one
  asked for early with `rel="preload"`, and one named by `@import` inside
  another style sheet. Fonts that are lent to a paying account (Adobe Fonts,
  Monotype, Font Awesome Pro) may not be copied, so their links stay, and the
  report lists them, and any font file that could not be fetched, under
  "Fonts that still come from a font service" with what to do about each.
  Icons drawn as SVG come back too: themes such as WordPress's Twenty
  Seventeen print `no-svg` on the page and swap it for `svg` with a script,
  and without the script every social icon turned into its name in words.
  Rescue now makes that swap itself.

- **A rescued WooCommerce shop keeps its layout.** The store page and the
  category pages of a copied shop came out squeezed: the products in a narrow
  strip with the result count on top of them, and the small pictures in the
  side column blown up to its full width. The cause was one class. WooCommerce
  writes `woocommerce-no-js` on every page and its script adds
  `woocommerce-js` the moment it runs, and themes write the shop's whole
  layout against the second one (Astra alone has 600 such rules). The copy has
  no scripts, so rescue now adds that class itself, and the pages lay out as
  they did on the old site. Three things on a shop's pages cannot look as they
  did without the shop's scripts, and the report now says so under "This site
  is a shop", with the pages they are on: a product's tabs all show one under
  the other, the price slider shows as two boxes with a number in each, and a
  product's pictures do not swap or zoom when clicked.
- **A rescued copy shows the parts the old site showed with a script.** Many
  sites keep a heading, a picture or a whole section hidden until a script
  fades it in. The copy has no scripts, so those parts stayed invisible: a
  home page lost its main heading, and a shop's product pages lost their
  pictures. Rescue now leaves each of these the way its script would have:
  Elementor's fade-in parts, "animate on scroll" parts (AOS, sal.js), a
  WooCommerce product's pictures (the first one large, the others in a row
  under it), and pictures that load late, whose real address waited in
  `data-lazy-src`, `data-original` or `data-src` behind a stand-in. Parts that
  a site's own style sheet hides (WOW.js, animate.css, "reveal" classes,
  WPBakery, Beaver Builder, Divi) are shown by one small style sheet added to
  the copy, `assets/rescued/shown-without-scripts.css`, whose first lines say
  what it is for. The report has a new line, "Parts made visible", with how
  many there were and on which pages, and asks you to check those pages.
- **Rescue copies a WordPress site that uses plain addresses.** Many WordPress
  sites never turned on "pretty" addresses, so their pages are `?p=14`,
  `?page_id=2`, `?cat=5`, `?author=1`, `?tag=x`, `?m=202401` and `?paged=2`.
  Rescue dropped everything after the question mark, so it copied the home
  page and nothing else, and said nothing about it. Each of these addresses is
  now a page of its own: it is followed, saved as its own file (`/?p=14`
  becomes `p-14/index.html`), and every link to it in every copied page points
  at that file. Any other ending after a question mark (a sort order, a
  filter) is still not followed, and the report now counts those links and
  shows up to five of them. Sign-in and admin addresses (`wp-login.php`,
  `wp-admin`) and feeds are never opened, and the report says they were left
  out.
- **A site that lives in a folder of its host is copied as a site of its
  own.** A copy of `https://host/shop-demo/` used to put every page inside a
  folder named `shop-demo` with the styles outside it, so the folder had no
  home page at its top, and the sitemap of the whole host was read: a shop of
  31 products was told about 8,779 more pages. Now the folder is the top of
  the copy: the home page is `index.html`, links and files agree with that,
  only pages under the folder are tried or counted, and links to the rest of
  the host keep going to the old site. The report says so, and names the
  command that copies the whole host. The link-preview picture of such a site
  is named by its place in the copy, with a line in the report about putting
  the new address in front once the copy is live. An address that is one page
  of a bigger site (`https://host/about/`) is still copied whole, as before.
- **`--menu-shim` works without `--render`.** On a plain copy the button that
  opens the menu on a phone did nothing, because the script that ran it is
  taken out. `--menu-shim` now marks the button and what it opens for
  WordPress block themes, Astra's slide-in menu, Bootstrap and the classic
  WordPress themes, and adds the same small script `--render` uses. Without
  it, the report says the menu does not open and gives the command to run.
- **The rescue report's numbers and words.** The count of forms is the number
  of forms listed. A file the old site had already lost (it answered "not
  found") is listed as already missing, not as one that "will disappear when
  you switch the old site off". The picture named by `msapplication-TileImage`
  is copied like the other head pictures. When the site is a shop, one
  paragraph near the top says that the cart, checkout, filters and stock do
  not come across, and what to do. The log no longer prints two different
  counts of files, and the dry run and the real run describe the next steps
  in the same words.

### Changed

- **The browser check passes on the test demo with nothing left failing.**
  `scripts/ui-check.mjs` had 26 checks that failed on every run against the
  test demo, which made a new failure easy to miss. Its count of requests
  outside the local server no longer includes a stylesheet that the site's own
  page asks for in its own file (the demo's fonts). Everything Kiln's code asks
  for still counts, and the list is no longer emptied when Help or "Put Kiln
  on my site" opens a tab. The guide's first tip may sit on the heading's own
  line, after its words, as the editor has put it since October where there
  are words to read both over and under the heading. A block is brought clear
  of a header the site keeps at the top of the screen before its buttons are
  reached for, because they are hidden under one on purpose.

## [0.6.3] - 2026-11-12

### Fixed

- **Find & replace changes only the words a visitor reads or hears.** The tool
  replaced in the whole text of each file, so replacing "brine" also rewrote
  `href="/blog/the-monday-brine.html"`, and the link pointed at a page that
  does not exist. The same would have happened to a picture's address, a
  class, an id, the names Kiln marks parts with, and anything in a script or a
  style. Now a replacement is written only in the text between tags in the
  body, in the page's title, in the `alt`, `title`, `aria-label` and
  `placeholder` attributes, and in the description and the link-preview words
  in the head (`description`, `og:title`, `og:description`, `twitter:title`,
  `twitter:description`). Every other byte of the file stays as it was. Text
  the file writes with entities is found as it reads (type `Salt & vinegar` to
  find `Salt &amp; vinegar`), and what is typed as the replacement is written
  so that it shows as typed and can never become markup. Capitals count, as
  before: "Tea" does not find "tea". A word split between two elements
  (`<b>br</b>ine`) is not found, and the tool says so when it finds nothing.
  The preview now says for each page how many places would change, and shows
  the first three with the words around them, as they are and as they would
  be. It also says how many other places on the site hold the word in an
  address, a style name or a script and will not be changed, so someone who
  meant to rename a page knows this tool did not do that. The count said
  afterwards is the count of places really changed. As before each page is
  read once, every changed page is saved in one commit or none is, and nothing
  is replaced when a page was published while the preview was open
  (`src/editor/find-replace.js`).

- **The AI tools no longer show for the first seconds after sign-in on a site
  with no AI.** The editor offered them until the service had said it has no
  AI, so the "let AI draft the content" brief in the New page dialog and the ✨
  button were there for a few seconds and then went. They are now offered only
  once the service has said it has AI (`aiConfigured` in its health answer,
  which is asked while the editor starts). Nothing waits for that answer: a
  dialog opened before it has come is drawn without the AI tools. An older
  service, whose health answer does not say, keeps what it had: the tools are
  offered once that answer has come, and are put away the first time a request
  is answered "not set up" (`src/editor/ai-offered.js`).

- **After an ordinary publish the line by the Kiln button moves on from "live
  ✓".** That line is meant to stay half a minute (ten seconds on a phone) and
  then give way to "Signed in as NAME. Your last publish went live at 5:33
  PM." After "New post or page" and after Find & replace it did. After an
  ordinary publish it could stop at "live ✓": when the site showed the change
  while "Published. Undo" still had the line, "live ✓" waited its turn, and
  the timer that brings the resting line had been set before "live ✓" was on
  screen. When it went off it found a newer line and did nothing, so "live ✓"
  was put away and nothing followed it. Now "live ✓" moves on to the resting
  line by itself, thirty seconds after it is really shown, on every path
  (`lineLeaves` in `src/editor/went-live.js`).

## [0.6.2] - 2026-11-12

### Fixed

- **A draft that was resumed and saved again is not thrown away by a later
  publish of something else.** The editor noted only that a draft had been
  resumed in the tab, and any later publish there then counted as the
  publish of that draft. Resume a draft, save it as a draft again, come back,
  press "Later", publish some other change: the draft was marked as
  published, its words never went live, and it was not offered again. A
  publish now uses a draft up only when the draft is still the one that was
  resumed and every part it brought back was among the parts that publish
  wrote. Saving a draft again throws the note away. Otherwise the draft
  stays, and is offered again as the older of the two
  (`src/editor/resumed-draft.js`).

- **An invited editor can make a new page on a site whose starting page has
  a script of its own.** "New post or page" copies the site's starting page
  (`_templates/page.html`, or `_templates/post.html` for a post). Kiln's
  starter site keeps a few lines of script in that file for its phone menu,
  and the service refused any new file from an editor that had a script
  written into it. So on such a site an editor who had been given the New
  page tool could never make a page, and was told only that editors cannot
  add scripts. The owner was never affected. Now a new page from an editor
  may hold what one of the site's own starting pages holds, word for word and
  as many times as that file has it, and nothing more. The starting pages are
  read from the branch the page is being written to, as it stands before the
  write, so a starting page changed in the same save does not count, and a
  change to a starting page is itself held to the rule that an editor cannot
  add a script to a file. A script the starting page does not have, the same
  script twice, or the script with one letter changed is refused as before,
  and so is a script on a new page of a site with no starting pages. A site
  kept in a folder of its repository has its `_templates` folder there, and
  it counts for pages under that folder. The service asks GitHub for the
  starting pages only when a new page would otherwise be refused. The staging
  end-to-end run now makes a page from the test repository's starting page as
  an editor, both ways a page can be written, and checks that the same page
  with one script more is refused. For that the test repository needs a
  `_templates/page.html` with one script written into the page itself
  (`ENVIRONMENTS.md`); the run stops before writing anything when it has none.
- **The dashboard offers "Update Kiln" within ten minutes of a release.**
  The service remembered which editor was released for an hour, so for up to
  an hour after a release the dashboard said a site was up to date while the
  update itself, which reads the release each time, would have brought it up
  at once. It now remembers for ten minutes. The release is still read at
  most once in that time however often a dashboard is opened, and a release
  that cannot be read is still asked again after five minutes. A site on
  Kiln's hosting is brought up to date by itself a day after the service
  first knew of a release, exactly as before: that day is counted from the
  first sight of the release, which reading it more often does not move.
- **A site already on Kiln's hosting can be given the character-set line
  for its page templates.** A site is given `<meta charset="utf-8">` on every
  page that names no character set when it first goes on Kiln's hosting, and
  since 0.6.1 on its page templates too. A site that went up before that was
  never looked at again, so its templates went on making new pages that name
  none. Now the dashboard's button "Add Kiln to this site" (on a site that
  has Kiln, "Check for pages without Kiln") also looks for pages and page
  templates without the line, for a site Kiln hosts. Its preview says how
  many of each would get it, and its one press adds it. The line is a commit
  of its own in the owner's name, as it is when a site first goes up: the
  commit says the one thing it does, and if it cannot be made, Kiln is added
  all the same and the button offers the line again. A page that names a
  character set already and a file with no head are left as they are. A site
  Kiln does not host is asked and told exactly what it was before. `GET` and
  `POST /cloud/sites/prepare` answer with `charset` for a hosted site
  (`state`, `pages`, `page_names`, `templates`, `template_names`, `no_head`,
  and a `sentence` to show as it is), and `state` is `ready` while the line
  is still to add.
- **A page is said to have a saved draft only when somebody saved one.**
  Opening a page could bring up "There's a saved draft of this page" for a
  draft nobody had saved, and the "draft" held the page's OLD words, with
  "Publish it now" beside them. A tester saw it on three pages in one sitting.
  Drafts are kept on a branch of their own, which is made, the first time
  anyone saves a draft, as a copy of the whole site that day. The editor
  offered a draft whenever a page's file on that branch differed from the
  page, so every page published since was offered its own old copy. The
  editor now asks GitHub what last changed the page's file on the drafts
  branch, and offers a draft only when that was somebody saving a draft of
  that page. A copy left over from the day the branch was made is never
  offered, and neither is a draft that was deleted or has been published. It
  is one more request, and only on a page whose copy differs.
- **A draft that is older than the page says so.** When one person saves a
  draft and another then publishes the page, the draft holds older words than
  the page does. It was offered exactly like a new one. Each saved draft now
  records which version of the page it was made from, and the question reads
  "This page has a draft that is older than the page", says who saved it and
  on which day, and says that resuming it puts the older words back for you
  to look over before anything goes live. A draft that is newer than the page
  also says who saved it and when. Drafts saved before this version are still
  offered: for those the editor asks one thing more, when the page was last
  published, and compares the two days.
- **An invited editor can delete a draft.** Only the owner's question had
  "Delete draft", so an editor with the Drafts tool could save a draft and
  never be rid of it. Everyone who can save a draft now has the button. The
  service does not let an editor's sign-in remove a file, so the editor's
  delete writes the page as it is over the draft, in a change that says the
  draft was deleted; the draft is not offered again. Someone without the
  Drafts tool is told who can delete it.
- **Find & replace gets through a large site without being told to wait.**
  The Kiln service counts what each signed-in person asks of it, 120 requests
  to the minute. Find & replace read every page once for its preview and then
  sent every page with a match in a request of its own, so a site of more than
  about 57 pages was told "too much was asked" part-way. The pages now go in
  the one request that makes the change, as the Site menu tool's do: a site of
  N pages takes N + 7 requests where it took up to 2N + 6, so the hundred pages
  it searches at most fit in a minute. It is still one commit, every page or
  none, and what it finds, shows and replaces is what it did before.
- **Find & replace does not put older words back on a page.** The words are
  replaced in the text the preview read. A page that somebody published while
  the preview was on the screen was written back as it had been, with the
  replacement made. Before it replaces, the tool now asks once whether any
  page with a match has changed since. If one has, nothing is replaced, the
  page is named, and you are asked to press "Preview matches" again. A second
  preview also takes the first one's "Replace all" button away with it.
- **The AI tools are not offered where the site has no AI.** AI assist works
  only where the Kiln service holds an AI key. On a site without one, the ✨
  button on the toolbar, "Describe" on a picture and "let AI draft the
  content" on a new page were all still there, and pressing any of them could
  only fail. The editor now listens to what the service says about AI. When
  the owner opens People & access and the service says it has none, the
  owner's own AI buttons go too. The first time any AI tool is answered "AI
  is not set up", the tools are put away for the rest of the visit, and the
  line says so and says who can turn them on. The service now also says
  whether it has AI in its public status answer (`aiConfigured` on
  `/healthz`), so an editor does not see the tools at all on a site without
  it, once the service is updated.

## [0.6.1] - 2026-11-12

### Added

- **A site put on Kiln's hosting is made ready by itself.** On the Kiln
  Cloud + hosting plan, putting a site up for the first time used to copy the
  repository as it stood, and its owner still had three buttons to press. Now
  the service does three things first, each only where it is needed, and each
  as one commit in the owner's name: it adds Kiln to the site (the editor's
  files, the settings file, the sign-in page and the two lines on every
  page), it gives every page that names no character set the line
  `<meta charset="utf-8">` at the top of its head, and it marks a first pass
  of what can be edited. The first copy of the site already holds all three.
  The character set matters because Kiln's hosting serves a page without
  naming one, and a browser may then show accented letters and curly quotes
  as other letters. A page that already names one is left exactly as it is
  (a `<meta charset>`, the older `http-equiv` line, or a byte order mark at
  the top of the file all count), and a page with no head is left alone and
  named. None of this can stop a site from going up. A step that cannot be
  done, because a generator builds the site, the branch is protected, or
  GitHub did not answer, is skipped, and the answer says so in a sentence.
  `POST /cloud/sites/hosting` now answers with `looked_after`, one line for
  each of `kiln`, `charset` and `marks`, saying `done`, `nothing` or
  `not_done`, with the commit where one was made. The same lines are kept
  for thirty days and come back from `GET /cloud/sites/hosting` and
  `/cloud/me`. A step that was not done stays owed for fourteen days. When
  the reason can pass by itself (GitHub or the release did not answer, or the
  repository changed meanwhile), the five-minute job tries again for the
  owner: ten minutes later, then after twice as long each time, six hours at
  the most, eight times in all. A reason only the owner can change, such as
  a protected branch, waits for the owner, and publishing the site again
  then makes the steps. Once nothing is owed, publishing a site that is up
  is only publishing (`worker/lookafter.js`).
- **A hosted site's editor is kept current, with nothing to press.** Every
  five minutes the service looks at up to two hosted sites, and at any one
  site once a day. Where the editor in the repository is older than the
  released one, it replaces Kiln's own files with the released ones, as
  "Update Kiln" does. A newly released editor is taken up only once the
  service has known of it for a full day, so Kiln's own sites always run a
  new editor first. Nobody pressed anything for this change, so the commit
  names no person and GitHub shows it as made by the Kiln app. A site whose
  branch is protected, or that GitHub would not answer for, is logged and
  tried again the next day, and the other sites are still looked at. A site
  that may not be edited any more is left alone.
- **A hosted site that was paid for comes down thirty days after its plan
  ends, and its owner is told twice first.** Until now a site on Kiln Cloud +
  hosting that had been paid for stayed up for good once the payment
  stopped. Now it stays up for thirty days from the day editing stopped
  (the end of the paid time after a cancellation, or the end of the seven
  days of grace after a failed payment), and then the five-minute job takes
  it down. Nothing in the repository is touched. The site's record stays
  and says `plan_ended`, so the dashboard can say why, and subscribing again
  and putting the site up puts it back. The address on the account gets two
  emails for each ending, each once: one when editing has stopped, naming
  the day the site comes down, what keeps it up, and that everything is
  still in the owner's own GitHub repository in case they would rather move
  to another host; and one seven days before that day. A site first seen in
  its last week gets the second one alone. Where there is an address to
  write to, a site never comes down sooner than seven days after that second
  email went: a site found late (the job was off, or the day on its row is
  far in the past) is written to first, with a day a week on, and stays up
  until then. The dashboard is given that same day. The operator is told
  when a hosted site is taken down. A plan that is taken up again in
  time stops all of it: the site stays up and nothing more is sent. A plan
  that ends again later is a new ending, with its own two emails.
  `GET /cloud/sites/hosting` and `/cloud/me` now give `ends_at`
  (milliseconds) for a hosted site that may not be edited any more and is
  still up, whether a plan ended or a free trial ran out. A paid site whose
  record has no day on which editing stopped is never taken down by this:
  it is left up, nothing is sent to its owner, and the operator is told
  once so a person can look. So that there is such a day, a subscription
  that is over for good (Lemon Squeezy's `subscription_expired`) now leaves
  the day editing stopped on the site's row, where it used to clear it.
  Editing is off from that moment exactly as before, and a site whose
  subscription expired before this release has no day and is one the
  operator is told about. A free trial nobody subscribed for still comes
  down three days after it ran out, as before (`worker/cloud.js`
  `hostingEndsAt`, `hostingDownAt` and `noticeEndingHosting`,
  `worker/mail.js`, `worker/hosted.js`).

### Fixed

- **A file that is not a picture is told so, with what to do.** A tester
  renamed a text file to end in `.png` and chose it as a picture. The editor
  said only "Image upload failed", and it said the same for every reason a
  picture could not be added. Now it says "The picture was not added." and
  then the reason. For a file that holds something other than its name
  says: "That file is named like an image, but it holds something else.
  Check the file and try again." For a file over the size limit: the limit.
  For a kind of picture the browser cannot read, such as a HEIC photo or a
  damaged file: "This browser could not open that file as a picture. Save
  it as a JPG or PNG and try again." Trouble that is not about the file,
  such as a sign-in that has ended, is said as that. The same holds for a
  picture put inside a paragraph (`src/editor/picture-not-added.js`).
- **Changing one block of a list no longer removes anything else from the
  list.** A tester changed the title of one card on a home page, and the
  small drawing in each of the three cards (an inline `<svg>`) was deleted
  from the site. The Publish button said "Publish 3 edits" for the one
  change, and the owner's own screen went on showing the drawings. The cause:
  when anything in a list of blocks changed, the editor wrote the whole list
  over what the file held, as its cleaner had left it, and the cleaner keeps
  only the markup it knows. Now the file's own text is what is written. Each
  block on the page is traced to the block of the file it came from, and that
  text is kept exactly, with only what the person changed put into it: the
  inside of the part they typed in, or an attribute a tool set, such as a
  picture's address, a link, or a block's tags. A block that was moved is
  moved as text, a copied block is the file's text of the one it was copied
  from, and a removed block goes. So a drawing, an embed the owner put there,
  an attribute a script reads, and the file's own spacing all come back byte
  for byte, and the commit shows the one change that was made. What a person
  types or pastes is cleaned as before. Where a block cannot be traced to the
  file and the cleaner would take something out of it, nothing is published:
  the editor says "Nothing was published", names the list, and keeps the
  edits. A list brought back whole from a draft or from History is still
  written as that file had it. The number on the Publish button is again the
  number of things the publish sheet lists: one change is one.
- **Text pasted into a paragraph or a heading can no longer break the page.**
  Text copied from a web page went into a paragraph with its heading, its
  own paragraphs, its colors, its classes and its pictures. A browser ends a
  paragraph at the first heading inside it, so on the site the paragraph came
  out empty and too small to click, and the pasted pieces sat outside
  anything the editor could reach. Now a paste into a part that is one
  paragraph, one heading or one line comes in as words, with bold, italic,
  underline and links (the formatting the toolbar itself offers) and nothing
  else. Where a block began or ended there is a line break, the cells of a
  table have a space between them, and a link keeps its address only. What a
  word processor writes as a style is read as the bold or italic it stands
  for. Pressing Enter in such a part is kept as a line break too, where the
  browser used to leave a block inside the paragraph. A richer part, one that
  holds paragraphs, lists and pictures, takes them as before.
- **"Delete draft" works, and a draft that was published is not offered
  again.** Deleting a saved draft answered "the site could not be reached…
  check your connection" every time, on a good connection. The service did
  not tell browsers that they may send it a DELETE request, so the browser
  never sent one. It does now. Deleting a page from the editor was stopped by
  the same thing. An invited editor still cannot delete a file: the service
  refuses that itself, as before. And a draft that is resumed and then
  published is taken off the drafts branch by that publish, so the page does
  not offer its old words again later. If you run the service yourself,
  deploy it again to get this.
- **After Publish, "live ✓" is said when it is true, and it stays where it
  can be read.** The line said a change was live after one good answer from
  the site, and twice a fresh request a few seconds later still got the old
  page, because the copies of a site around the network do not all change at
  the same moment. Now the page has to come back holding the change three
  times in a row, two seconds apart. The line then stays for thirty seconds
  (ten on a phone, where it covers the page) where it used to go after six,
  and the line the editor rests on afterwards goes on saying it: "Signed in
  as … . Your last publish went live at 3:52 PM." Once the line said "Not
  published" about a change that was published: the commit had been made,
  and reading the file back afterwards was turned away by a busy service.
  Nothing that happens after the commit is told as a failed publish any
  more. When the editor cannot watch a change reach the site, it says that it
  cannot tell, and to reload the page or open History to check.
- **A title that is a link stays a link when its words are changed.** On a
  list of posts, each card's title is a heading with one link around all of
  its words, and the heading is the part that can be edited. Selecting the
  title and typing a new one made the browser throw the link away with the
  old words, so the new title was plain words, for visitors too. Now, when a
  heading or paragraph was exactly one link around all of its words and has
  words and no link after editing, the new words go inside the link it had,
  with every attribute the link had, and the status line says so. The link
  stays off when the person took it off (the same words with no link), made
  another link, or turned the part into paragraphs or a list. A part marked
  "Plain text only" is not covered. The first pass still marks the heading,
  not the link: pages that are marked already are never marked again, so only
  the editor can keep their links (`src/editor/keep-link.js`).
- **A page made with "New post or page" can always be edited, and shows its
  accents.** A new page is a copy of the site's starting page. Where that
  starting page had neither Kiln's two script lines nor a line naming its
  character set, the new page had no Kiln button, so its owner could not
  change a word of it, and it showed "Ã©" for "é". Now the page that is
  written always names its character set (`<meta charset="utf-8">`, first in
  its head, when it names none) and always loads Kiln (the settings file and
  the editor before `</body>`, from where this site's pages load them). Each
  is added only where it is missing, and nothing else on the page is touched.
  A site with no starting page, no pattern for a post's card, no blog page or
  no list for posts is now told what is missing and what its owner can do
  today. It used to read "see the docs", or "blog/index.html needs a
  data-cms-list container" (`src/editor/new-page.js`).
- **A new page's address keeps its accented letters, as plain letters.** A
  page called "L'été d'Émile à Noël" got the address `/l-t-d-mile-no-l.html`:
  every accented letter was dropped. It is now `/l-ete-d-emile-a-noel.html`.
  Letters that are not a plain letter with a mark on it are spelled out (ß as
  ss, æ as ae, œ as oe, ø as o, ł as l, þ as th). A title with no letter that
  can be written plainly, such as one in Japanese or Greek, used to get the
  bare address `/page.html` or `/blog/post.html`, which only the first such
  title could have. It now gets one of its own, such as `/page-mwe0s3hw.html`.
  The title on the page is as it was typed (`src/editor/page-address.js`).
- **A picture inside a paragraph can be described.** A stand-alone picture has
  a box for its description on its toolbar and is asked about when it is
  replaced. A picture put inside a paragraph had a small bar with widths and a
  remove button and nothing else, so it went live with no description, and
  the publish sheet could only warn about it. The small bar now has a
  "Describe" button. It opens the same dialog a replaced picture gets, with
  this picture's own words in the box, and pointing at the button says what
  the picture is described as now. The answer is kept with the paragraph,
  like the picture's size. The publish sheet still warns only about a picture
  that is new in that publish (`src/editor/describe-picture.js`).
- **A picture resized by dragging no longer names an original that was never
  saved.** Dragging a picture's corner makes a copy at the new size and names
  the largest version Kiln holds on the picture (`data-kiln-master`), so a
  later drag to a bigger size starts from it. A drag also drops the upload an
  earlier drag queued, so that in-between sizes are not published. For a
  picture put inside a paragraph, or made smaller with a size button, the
  first file queued is the original itself: the first drag named it as the
  original and then dropped it from what Publish saves. The page went live
  pointing at a file that answered 404, and a later drag to a bigger size had
  only the small copy to stretch. The upload a picture names as its original
  is now never dropped, so it is saved by the same publish.
- **A page made with "New post or page" can be edited, and its accents
  read as written, on a site Kiln was added to from the dashboard.** A site
  keeps the templates new pages are made from in `_templates/` (`page.html`,
  `post.html`, `post-card.html`). "Add Kiln to this site" and the
  character-set step on Kiln's hosting passed that folder over, so a new
  page had neither the two lines that load the editor (the Kiln button never
  came up on it, and its owner could not change or delete it from the
  site) nor `<meta charset="utf-8">` (its accented letters, and the dash in
  the template's title, came out as other letters). Now a template that is a
  whole page (it has `<html>`, a `<head>` or a `<body>`) gets the same lines
  as a page, in the same commits. A template that is a piece of a page, such
  as a post card, is left exactly as it is. The preview of what will change
  counts and names templates apart from pages (`templates` beside `pages`
  in the answer of `GET /cloud/sites/prepare`), the commit messages and the
  site checklist say "page templates", and the first pass at what can be
  edited still marks no template. A site that had Kiln added before this is
  offered the two lines for its templates alone, with the same "Add Kiln to
  this site" button on its checklist. The character-set line is given when
  a site is made ready for Kiln's hosting; a site that was made ready before
  this does not get it for its templates until those steps run again. The
  setup tool does the same for the two lines: `npx github:kilncms/kiln#release`
  now lists whole-page templates with the pages that lack the two lines, and
  says which are templates. Pages already made from an old template are not
  changed by this: the two lines can be added to them with the same button.
- **Two people editing one site from one network address are no longer
  refused.** The service counted every request it got from one address on a
  single count of 20 a minute, whoever made it: reading a page to edit it, the
  "who else is here" call every 30 seconds, watching a publish go live, and
  the sign-in routes the count was meant for. One person publishing and
  opening a few pages could use it up alone, and two people on one site, or
  an office behind one address, were told "Too much was asked of the site
  just now" again and again, and "Editing could not start just now" when
  they opened a page. Now a signed-in person's requests are counted for
  their own session, on a roomier count (120 a minute, the new `RL_ROOMY`
  limiter in `worker/wrangler.toml`), and the public `/standing` read is
  counted for the address apart from the sign-in routes. The count for one
  address (100 a minute, as the entry below tells) still holds for signing in, for the dashboard's reading of
  a repository, and for any request that comes with no session, with a
  session that has ended, or with a session id nobody holds: a made-up id is
  looked up, found to be nobody's, and counted for the address. A worker
  with only the first limiter bound counts each session by itself on that
  one, and a worker with neither limits nothing, as before. **Operators:**
  deploy the worker with the new `[[unsafe.bindings]]` block for `RL_ROOMY`
  (it is in all three environments of `worker/wrangler.toml`).
- **Saving the site menu asks half as much of the service, and still
  changes every page or none.** The Site menu tool read every page and then
  sent each changed page by itself before one commit tied them together:
  2N + 6 requests for a site of N pages, which went over the old count of 20
  on any site of more than seven pages and stopped part-way with "too much
  was asked". (Nothing was half-saved: the counter on screen was of pages
  being read.) The pages' new text now goes in the request that builds the
  commit, about a megabyte at a time, so a save is N + 6 requests and three
  of them write, however many pages there are. GitHub's own refusal of a
  burst of writes is no longer in reach either. The dialog now says
  "Reading the site's pages… 4/14" while it reads, in place of "Updating
  menus…".
- **When the service says it was asked too often, it says when to ask
  again.** Its answer is a 429 with `Retry-After: 60`, the same in the body
  (`code: "too_often"`, `retry_after: 60`), and a sentence in place of
  "rate limited, slow down". A page where the editor could not start for
  that reason now says "please wait a minute and then reload the page"
  (it said to reload, which only asked again). And when the editor fails to
  start before any of it is on the page, the page now says so with a Reload
  button: it used to stay as it was, with no word at all.
- **Several people at one address are no longer refused by the service.** The
  service counted 20 requests a minute for one network address, across
  everyone there. One person who has just published makes about 12 of the
  counted requests a minute by themselves (the editor asks where the site
  stands on every page, says who is on the page twice a minute, and follows
  the publish), so a second person at the same address, or a second page
  opened in that minute, was told "Too much was asked of the site just now"
  or found the editor not starting. The address limit is now 100 a minute
  (`worker/wrangler.toml`). This is a stopgap: counting a signed-in person's
  requests against their own sign-in follows.
- **A site drawn by JavaScript is no longer copied as blank pages and called
  done.** `rescue` without `--render` on such a site used to write one empty
  page for every address, print "crawled 50 pages" with a green tick, and tell
  the person to push and deploy. Now a page the server sends with no words on
  it (an empty root element and a script) is noticed as it is read, marked
  "blank" on its progress line, and left out of the copy. The pages that do
  have words on them are still copied. The run ends by saying how many pages
  were blank, that the site draws its pages with JavaScript, and the exact
  command to run instead (`rescue <address> --render`, with the options
  already given), with what `--render` needs installed. When the first page or
  half the pages are blank the run counts as not having worked: it ends with
  exit code 1, the report is headed "This copy is not finished", and the steps
  for pushing and deploying are not offered. When every page is blank nothing
  is written at all. A single blank page on a site of real pages is left out
  and named in the report, and the copy still counts. A short page with a
  heading, a paragraph, a link or a picture is never called blank.
- **`rescue --render` no longer spends most of an hour on addresses that lead
  to another site.** On a site whose sitemap listed 352 addresses that all
  move to another host, it opened a browser for each one, waited about eight
  seconds, showed `[4/50]` the whole time, ignored `--max-pages`, and ended
  with "crawled 3 pages, 352 failed" under a green tick. Four things changed.
  An address that forwards to another site is found out with one plain
  request, before a browser is opened for it. An address that is sent to
  another site by script once the page is open is caught in the browser the
  moment it asks to leave, and the visit ends there without the other site
  being read (in the test, under a second where it took eight). `--max-pages`
  now limits how many addresses are tried, not only how many become pages, for
  the plain copy as well. The progress line counts every address, and a
  skipped one says why on the line below it: it has moved to another site
  (named), the site answered with an error, it is not a page, or it is the
  same page as one already read. When more than half of the addresses tried
  have moved to one other site, the end says so in one sentence that names
  that site and gives the command to copy it. The terminal shows the first ten
  skipped addresses when there are more than twelve, and `RESCUE-REPORT.md`
  lists them all. "Pages that failed" and "redirected off-origin" are gone
  from the wording.
- **The first pass no longer names fields after styling classes.** On a page
  styled with a utility framework such as Tailwind, the first pass at marking
  what can be edited took the start of a field name from the nearest class,
  and produced names like `mx_auto_thursday_november_12` and `gap_10_img`.
  Names now come only from ids and classes that say what a part of the page
  is. A class is passed over when it has a character a hand-written name never
  has (`md:grid-cols-3`, `w-1/2`), is one of the single words frameworks lay
  out with (`flex`, `hidden`, `container`), starts with a property or its
  short form (`mx-auto`, `gap-10`, `text-lg`, `bg-white`), ends in a side or a
  size (`border-t`, `btn-sm`), or starts with a word that is also an ordinary
  word and ends in a number or a setting (`top-0`, `order-2`). The root
  element of an app (`root`, `app`) is passed over too. Ordinary names such as
  `hero`, `card`, `footer`, `intro-block`, `card-1`, `top-bar` and
  `order-form` are used as before, and when nothing around a field has a name
  the field is called `page_…`. Fields that are already marked keep their
  names. The editor uses the same rule for "Make editable", so its built files
  in `dist/` need rebuilding at the next release.
- **`rescue --help` explains rescue.** It used to print the same general help
  as `--help`, which gives rescue six lines and explains none of its options.
  It now prints help of its own: what the command does, where the copy goes
  when `--out` is not given (a new folder `rescued-<site name>` inside the
  folder you are in, with `RESCUE-REPORT.md` in it), one line for each option,
  and what `--render` needs (Chrome, Edge, Brave or Chromium on the computer,
  and `npm install playwright-core` in the folder the command is run in). The
  general help points to it, and so does the usage line printed when no
  address is given. As with every command, asking for help runs nothing and
  writes nothing.
- **`tag` no longer passes over pages in a folder called `public`.** `tag` and
  the setup wizard leave build and tool folders alone, and did so wherever the
  name turned up, so on a copied site the page at `/lists/public` (the file
  `lists/public/index.html`) was never looked at and never mentioned.
  `public`, `assets`, `build`, `out` and `functions` are ordinary words that
  sites use in their addresses, so they are now left out only at the top of
  the site, where a build or a host puts them. `node_modules`, `dist`,
  `_site`, `_templates` and folders whose name starts with a dot are still
  left out at every depth.
- **The rescue report says what the scripts it took out were, and two
  leftovers in the copied pages are gone.** "Scripts stripped: 97" is now
  followed by what they were: how many were the old site's own, how many were
  written into the pages, how many counted visitors and how many came from
  other sites, with the names of those sites, and a sentence saying that a
  visitor counter, chat box, cookie notice or booking widget has to be added
  again on the new site. The picture for link previews (`og:image`,
  `twitter:image`) used to be rewritten to a path with no site name, which the
  services that draw previews cannot use. It now keeps the site's full address
  in front of the copied file, and the report says to change it if the copy
  goes live at another address. The canonical address is left as the full
  address it was, like `og:url`, where it used to be cut down to a path. A
  `<link rel="manifest">` is taken out, because the file it names is not
  copied and every page asked for it and got a 404.
- **The service follows the same folder rule as the setup tool.** When Kiln
  Cloud adds Kiln to a repository or makes a first pass at what can be edited,
  it left out any page with a folder called `public`, `assets`, `build`, `out`
  or `functions` anywhere in its path, as the setup tool did. Those names now
  count only as the first folder of a path, so a page at
  `lists/public/index.html` is looked after like any other
  (`worker/prepare.js`, `isSitePage`).

## [0.6.0] - 2026-11-12

### Added

- **A whole page can be made editable with one press, in the editor.**
  "Make text/images editable" marked a page one click at a time. Its bar now
  also has **Make this whole page editable**, for the site's owner and for an
  invited editor who has that tool. It makes the same cautious first pass as
  `kiln tag` and the dashboard, on the page that is open. The editor's own
  dialog first says how much would be marked (pieces of text, pictures, lists
  of blocks, the menu), that tables, buttons, forms and anything already
  marked are left alone, and that a visitor sees no difference. On a yes it is
  saved at once as one change to that page, in the person's name, by the same
  write Publish makes, and the page reloads when the site has the change. The
  file is read again at the moment of writing, and nothing is written unless
  the pass adds marks and nothing else. After the reload the editor waits, a
  few seconds at most, until the file it reads holds the marks that were
  saved (GitHub can answer with the file as it was for a moment after a
  write). Any part can be made plain again by clicking it in the same mode. With changes waiting for Publish it says to
  publish or discard them first. The button is not offered in the demo, on a
  page built from content files, or to an editor limited to parts of a page
  (`src/editor/whole-page.js`).
- **Kiln can host a site (the Kiln Cloud + hosting plan), by itself.** The
  service copies a repository's files to a Cloudflare account that holds only
  customers' sites, and the site answers at a temporary address at once. The
  first copy sends every file; a later one sends only what changed, so a
  published edit is live in seconds. It publishes again when GitHub says the
  repository changed (the App's push webhook, signed, default branch only),
  and a five-minute job publishes what no notice announced and retries a copy
  that failed. A copy that fails part-way leaves visitors with the site as it
  was. The site's own `_headers`, `_redirects` and `404.html` are honoured;
  hidden files, `node_modules` and `functions/` are not published. The editor
  works at the temporary address. Removing a site takes it down. Hosting is
  off until the service has a token for the hosting account. A hosted site
  whose free days ran out unpaid stays up three more days and then comes
  down (the two trial emails say so); subscribing puts it back
  (`worker/hosting.js`, `worker/hosted.js`, `GET` and `POST
  /cloud/sites/hosting`, `POST /gh/webhook`, migration `0005`).
- **Kiln Cloud can make a first pass at what can be edited, from the
  dashboard.** After Kiln is added, **Mark what can be edited** shows how much
  it would mark (pieces of text, pictures, lists of blocks, the menu, and on
  which pages), and on a yes marks them in one commit in the owner's name. It
  is the same cautious pass `kiln tag` makes: headings, paragraphs, quotes,
  captions, pictures, repeating blocks such as cards, and the site menu.
  Tables, buttons and forms are left alone, and so is anything already
  marked. Each page is checked before it is written: the pass may only add
  marks, and a page where it did anything else is left as it was and named. A
  visitor sees no difference, and any mark can be taken off again in the
  editor (`worker/firstpass.js`, `GET` and `POST /cloud/sites/firstpass`,
  migration `0004`).
- **Kiln Cloud can add Kiln to a site's repository from the dashboard.** A site
  whose pages are plain files no longer needs a terminal: on the site's row,
  **Add Kiln to this site** first shows what would change (which pages get the
  two script tags, which files are added), and on a yes makes that change as
  one commit in the owner's name. Only what is missing is added: a file that
  is already in the repository is never replaced, a page that already loads
  the editor is not touched, and pressing it again after adding a page adds
  the two lines to that page alone. A site built by a generator (Astro and
  the others) is told to use the setup tool, as before. A repository that
  changed meanwhile, or whose branch takes no direct change, is left as it
  was, with the reason (`worker/prepare.js`, `GET` and `POST
  /cloud/sites/prepare`, migration `0003`).
- **Kiln Cloud can update the Kiln editor in a site's repository from the
  dashboard.** When a newer editor is out than the one a site has, its row
  says so and offers **Update Kiln**. Pressing it first shows what would
  change (which of Kiln's files are replaced, and from which version to
  which), and on a yes replaces them with the released ones as one commit in
  the owner's name. This is what `npx github:kilncms/kiln#release update` does
  in a terminal. Only Kiln's own files are written: the pages, the settings
  file and everything else stay as they are. A site with a members area gets
  the current files that guard it as well, unless its settings name another
  sign-in service, and a `_routes.json` that is already there is left alone.
  A repository that changed meanwhile, or whose branch takes no direct change,
  is left as it was, with the reason. The dashboard learns which editor a site
  has from its signed-in editors, and which one is released from the release
  itself, looked up at most once an hour (`worker/update.js`, `GET` and `POST
  /cloud/sites/update`, `editor_build` and `editor_latest` in `/cloud/me`).
- **Kiln Cloud's dashboard can check a site and say what is wrong with it.**
  On each site's row, **Check this site** shows a short list with a yes or a
  no on every line: Kiln can reach the repository, Kiln's files and the two
  script tags are in it, the settings file names this service and this
  repository, the site's address answers, the live site loads Kiln, and the
  sign-in page at `/kiln` answers. Each line is a plain sentence about what
  was found, and a no comes with what to press or do: the install link, the
  row's own **Add Kiln to this site** button, or the settings file opened on
  GitHub. A repository that has Kiln while the live site does not is told
  that the host has not published the change yet, or publishes from another
  repository or branch. A line that cannot be looked at because an earlier
  one failed says "not checked" and why, and is not counted as a no. A site
  built by a generator is reported as it is and pointed to the setup tool.
  The check still answers when the Kiln app is not installed and when editing
  is switched off after a trial, which then is the first line. It changes
  nothing, in the repository or anywhere else. The site's own address is
  asked with care: `https` only, never a numbered or private address, eight
  seconds for each request, at most three redirects and only within the site
  or its `www` form, at most 512 KB read, and no cookies or sign-in details
  sent (`worker/sitecheck.js`, `GET /cloud/sites/check`).

### Fixed

- **The first pass no longer refuses a page with a short heading.** Before a
  page is written, the pass is checked to have added marks and nothing else.
  That check misread two marks a few characters apart, as in
  `<h3>Ana</h3><p>Baker</p>`, and such a page was left alone and named as
  unsafe although only marks had been added. The check now reads each added
  run exactly where it starts. It is also stricter in one place: a bare mark
  run together with the attribute after it is refused. The check moved to
  `src/autotag.js`, beside the pass, so the dashboard and the editor hold to
  the same rule.
- **After a change, the editor reads a page's file as it is now, not a copy
  the browser kept.** For an owner signed in through the service, GitHub's
  answers were passed on with the day the file last changed and no rule about
  keeping them. A browser keeps such an answer for a tenth of the file's age:
  a page nobody had changed for a month was read from that copy for three
  days. After a publish and a reload the editor then worked from the file as
  it was before: parts marked since were not editable, and the check that
  warns when someone else has changed the same part compared against that
  same old copy, so it could stay silent. The service now tells
  the browser to keep nothing that came from GitHub (`Cache-Control:
  no-store` on every `/gh/*` answer, for owners and invited editors), and the
  editor asks past the browser's kept copies in any case, so a copy kept
  before this release is no longer read and a service that has not been
  updated is covered too.
- **The first pass leaves the inside and the outside of anything already
  marked alone.** On a page that was partly marked, it marked paragraphs
  inside a block of text that was already editable, and a heading or a
  paragraph around a link that was already marked, so one editable part sat
  inside another. It turned a group of blocks into a list although someone
  had marked parts inside those blocks by hand. And it made a list of a row
  of short labels with nothing in them it could mark, whose blocks could then
  be copied and moved but never reworded. Now nothing inside a marked part is
  marked, nothing that holds a marked part is marked, a group is made a list
  only when no part of it is marked and each of its blocks holds something
  the pass marks, and a footer that lies inside `<main>` is passed over once.
  This is the pass `kiln tag`, the dashboard and the editor all use
  (`src/autotag.js`).

### Changed

- **The free trial is seven days in all.** The seven days are Kiln's own,
  counted from the day a site is added, with no card. The checkout now tells
  Lemon Squeezy to skip any trial set on the product there, which used to add
  its own days on top once a card was entered.
- **The plan with hosting is called "Kiln Cloud + hosting".** It was called
  "Fully managed". It is Kiln Cloud with the site served from Kiln's
  Cloudflare account on the customer's own domain. The one-time setup service
  is no longer offered.

## [0.5.0] - 2026-11-11

### Added

- **Kiln Cloud writes to the owner when a free trial is about to end.** Three
  short emails, each sent once to the address on the dashboard account: when a
  site is added (what to do next, and the day the trial ends), two days before
  the trial ends, and when it has ended. A trial needs no card, so nobody else
  could remind the owner, and it used to end in silence. The dashboard asks
  for the address and it can be changed or taken away there. Nothing else is
  ever sent. They go through Cloudflare's own sending service
  (`CUSTOMER_MAIL_FROM`); a worker somebody runs themselves sends none.

### Fixed

- **People & access says where the Google sign-in steps are.** On a sign-in
  service somebody runs themselves, with Google sign-in not yet set up, the
  dialog named two settings and pointed at "the README". It now says in plain
  words to add Google sign-in to the sign-in service and names the guide,
  `docs/google-sign-in.md`.
- **An editable part keeps the shape the site gave it.** The editor put square
  4px corners on every editable part, which squared a site's round buttons and
  pills, and added padding while a part was typed in, which made a button
  shrink and a heading jump. It now draws its outline and changes nothing
  else. On a phone, a block's small controls button lets the words under it
  show through until it is pressed.
- **Signing in with GitHub no longer fails on the first try.** GitHub can take
  a second or two before a token it has just issued is accepted, and the
  dashboard asked "who is this?" at once: three sign-ins in four ended on a
  line of JSON. A site owner could be told their own site was not theirs for
  the same reason. Both now ask again for a moment, and a dashboard sign-in
  that still does not finish goes back to the dashboard, which says so.

### Security

- **A site owner’s GitHub sign-in stays on Kiln’s sign-in service.** Until now
  the owner’s browser was handed a GitHub key when they signed in, and any
  script on their site (a widget, or code someone slipped in) could read it and
  use it on every repository that person can change. Now the service keeps the
  key and the browser holds only a sign-in that works through the service, from
  that one site, on that one repository. The service renews the key itself, and
  a sign-in GitHub no longer accepts ends with the usual “sign in again”. Owners
  who are signed in the old way are moved over on their next page load, without
  signing in again. Sites still on older editor files keep working the old way
  until they update them.
- **The site owner’s browser no longer holds a GitHub sign-in.** After signing
  in with GitHub, the browser keeps only a session for this one site
  (`kiln_admin = { session, login, repo, exp }`), and every change, History,
  People & access and every other tool asks through Kiln’s sign-in service,
  as an invited editor’s browser always has. A script on the site can no
  longer read a key that works on the owner’s other repositories. An owner
  signed in the old way is moved over on the next page, without signing in
  again, and Sign out now ends the session on the service too. With a sign-in
  service that has not been updated, the editor carries on the old way.
- **A limit to parts of a page is kept by Kiln’s sign-in service, not only by
  the editing screen.** An editor limited to some parts of a page could change
  any part of it by sending a save straight to the service. Now every save is
  compared with the page as it is: a change outside the editor’s parts is
  refused, and the refusal names the part. This holds for a single save,
  pictures saved with a page, scheduled changes (when made and again when they
  go out) and putting a page back to an older version. Such an editor cannot add
  pages, copy them, or change page settings, the menu or the theme. Editors
  without a limit to parts work as before.
- The content filter library (DOMPurify) is 3.4.17. Versions up to 3.4.16
  carry published advisories, one about cleaning a part of the page in place,
  which is how the editor uses it. The weekly advisory check on GitHub had
  been failing on it since 2026-10-26. The build tools are current too.

### Fixed

- **Paying leaves nobody stranded.** After the payment page a customer is sent
  back to the dashboard, which says thank you and waits for the confirmation.
  Before, they were left on Lemon Squeezy's own page.
- **A checkout offers one plan**: the one the site was added with. The plan on
  record follows the plan that is paid for, and the operator is told when the
  two differed.
- **A site whose free trial or plan has ended says so.** The sign-in page used
  to read "Origin not allowed … ALLOWED_ORIGINS", and the editor "Editing could
  not start just now". Both now say the trial or plan has ended, that the site
  is untouched, and that the owner subscribes in the dashboard. An address
  nobody has added says to add it, with exactly that address. Only someone
  who runs the worker themselves is told about `ALLOWED_ORIGINS`.
- **Undo, Redo and "Drop" bring back a list that holds a link opening in a
  new tab.** The check made before a part is put back on the page (added
  2026-10-22) asked whether DOMPurify's default profile would take anything
  out of it, and the default takes out `target`. So on any list with such a
  link, the public demo's products among them, a removed block never came
  back and Undo said "Undone". The harmless attributes are let through for
  that check, scripts and handlers are judged as before, and Undo and Redo
  now say so if a part could not be put back.
- **Lists and headings only go where they fit.** In a single paragraph or a
  heading, the list buttons and the Style menu say why they cannot be used
  there, where they used to save markup that broke the page. In a rich area a
  new list no longer lands inside the paragraph it came from.
- A new list keeps the cursor where it was.
- A link typed as `example.com` goes to `https://example.com`, and an email
  address becomes a `mailto:` link. A file name such as `about.html` is left
  as typed.
- **A replaced picture asks for its own description**, starting from the old
  one's words. Before, the old description stayed on the new picture.
- **A photo in a gallery made with Kiln can be replaced and described.** It
  had no marker of its own, so a press on it did nothing useful.
- **A press on a picture that cannot be changed here stays on the page** and
  says why. The link around it, often a whole card that opens another site in
  a new tab, is held back. Ctrl or ⌘ and a click still follows it.
- Words typed in a box that is still open survive a reload or a closed tab,
  and are offered back. That holds for a box inside a list too.
- **History reaches every version.** It listed the newest 20 publishes of a
  page and stopped. "Show older versions" loads 20 more each time, down to
  the first, and an older version is brought back like a newer one. A
  section's own history does the same.
- The Kiln button can no longer end up over the site's header. It was measured
  while hidden, which saved a position in the top-left corner.
- On a phone, a block's open control bar stays inside its block. In a card
  laid out top to bottom it grew to the card's full height and caught taps
  meant for the next card.
- `rescue`: a file that was not copied keeps working from its old address, the
  report lists what was left behind and warns that it disappears when the old
  site is switched off, and `http`, `https` and `www.` forms of one host are
  one site. The limits are 20 MB a file and 250 MB a run.
- `doctor` with no terminal and no `--site` stops at once and says which
  option to pass, where it used to wait forever.
- `tag` names only the pages it changed in its advice on undoing.
- The end-to-end test looks again before calling its clean-up a failure:
  GitHub can answer a read with the old state for a moment after a write.

### Changed

- **Pages built from content files (Astro sites) work with a keyboard alone
  too.** Their texts, formatted texts and pictures are in the Tab order with
  the same ring and names as on an HTML site, Enter or Space opens one, Tab
  goes on to its toolbar and then to the next part, and Esc leaves it with
  the keyboard still on it. A part that can't be changed here is reached as
  well and says why, in the words a click shows. Each entry's button and "Add
  an entry" are named buttons. Nothing added for the keyboard is written to a
  content file.
- **The first-visit guide is read out and works from the keyboard.** A screen
  reader hears each tip and the last card as they appear, without the
  keyboard being moved from where the person is typing; the page behind
  stays in reach. "Skip the guide" is a named button in the Tab order, and
  Esc on the guide skips it. Someone who has pressed Tab is told "Press Enter
  on this and type." instead of "Click this and type."; a click or tap brings
  the pointer wording back.
- **The editor can be used with a keyboard alone**, and a screen reader can
  name what it reaches. Every editable part is in the Tab order, Enter opens
  it, Esc leaves it, the toolbars and their buttons have names, and every
  dialog is named by its heading and holds the keyboard while it is open.
  None of what the editor adds for this is published.
- The dashboard says where each site stands in a sentence: the days left in
  the free trial, when editing ends after a cancellation or a failed payment,
  and what turns it back on. Its refusals are full sentences.
- No screen says "alt text": a picture has a description.
- People & access says two things an owner should know where the choice is
  made: a limit to parts of a page is kept only by the editing screen, and
  members-only pages can be read by every invited editor.
- The setup tool's closing steps say to add the site, when the 7 free days
  start, and that no card is needed.
- `new` writes a README into the new site: what the example is, how to look
  at it, how to put it online, and what to change first.
- `--help` lists every `rescue` option.

### Security

- **A sign-in is handed only to an address that belongs to the site it is
  for.** Any Kiln Cloud trial puts its address on the trusted list, and the
  owner's GitHub sign-in and an invited editor's Google sign-in were sent to
  whatever trusted address the link named. A link through auth.kilncms.com
  could therefore carry a site owner's GitHub access, or an editor's session
  for another site, to a stranger's trial address. Now an address registered
  in Kiln Cloud (or mapped by hand) serves its own repository only: a Google
  sign-in for another repository is refused, and a GitHub sign-in is handed
  over only if the person can change that address's repository. Found in the
  2026-10-22 security review; proven by tests that fail on the old code.
- A scheduled publish no longer goes out once its author is made suggest-only
  or comment-only, or loses the scheduling grant.
- An editor session used from outside a browser can no longer publish once
  the site's Cloud plan has ended.
- A scheduled page publish checks its branch name, as a content file's did.
- An unexpected server error no longer returns its internal message.
- **Members pages cannot be reached through an encoded address.** Cloudflare
  Pages decides whether a function runs from the address as written, then
  decodes it to find the file, so `/%6Dembers/` skipped the members gate and
  was served the page (confirmed on kiln-demo.pages.dev, fixed and re-checked
  there). Sites get `functions/_middleware.js`, which sends an encoded address
  into the members area to its plain form, and `_routes.json`, which routes
  only members addresses and addresses with a `%` to functions. `kiln update`
  installs both where it refreshes a members gate.
- **A draft or an earlier version can no longer run code in the owner's
  browser.** The content guard read the inside of `noscript`, `textarea`,
  `xmp`, `noembed`, `noframes`, `title` and `plaintext` as text, so an
  invited editor's draft could hide markup there, which the editor then put
  into the page as markup on "Resume draft". The guard now checks what those
  elements hold as markup, and the editor brings a part back from a draft or
  History only when DOMPurify would remove nothing from it (a refused part is
  named in the status line).
- **"Publish it now" on a draft no longer writes the saved copy of the whole
  page over the live one**, which lost anything published since the draft was
  saved. It stages the draft's parts and opens the publish sheet.
- The server's content guard treats SVG animation elements (`set`, `animate`,
  `animateMotion`, `animateTransform`) as risky: an invited editor cannot add
  one, since it can rewrite a link's address after the page loads; an owner's
  existing ones survive edits elsewhere on the page.

### Fixed

- **After Remove, a site's API tokens and scheduled publishes stay stopped.**
  A removed site left no row, which read as "never on Kiln Cloud", so both
  started working again. Remove now leaves a `cloudgone:` marker (backed up;
  cleared if the site is added again).
- **A former subscriber can subscribe again.** A site whose cancelled
  subscription has run out gets a new checkout; one still paid up is told to
  resume it under Manage billing, which the dashboard now shows for it.
- **When a Cloud plan ends, members already signed in lose access** within
  about five minutes, as editing, tokens and schedules already stopped.
- **Fully managed setup no longer cuts off a domain's existing email.**
  `scripts/managed-onboard.mjs` refuses to turn on forwarding when the domain
  already has mail servers, unless `--replace-mail` is given, and turns off
  Cloudflare's Email Obfuscation, which rewrote pages so Live ✓ never matched.

### Changed

- **When a Kiln Cloud plan ends, a site's API tokens and scheduled publishes
  stop with its editing.** A token is answered `403` with `code: "plan_ended"`
  and a sentence saying why; it is kept, and works again once the plan is
  renewed. A scheduled publish that falls due is held, not published and not
  deleted: renewed within its 14-day expiry, it goes out on the next run. A
  repository with no Cloud site (a self-hosted worker, or a site listed by
  hand) is never affected, and neither is any site while the database cannot
  be read.
- The production worker no longer accepts `localhost` origins.

### Added

- **`kiln rescue` reads WordPress sitemap indexes** (`sitemap.xml`,
  `sitemap_index.xml`, `wp-sitemap.xml`), takes `--max-asset-mb` and
  `--max-total-mb`, strips WordPress head links (pingback, RSD, wlwmanifest,
  shortlink, REST, oEmbed and feed discovery), and ends every report with
  **What freezing cost**: the forms, search boxes, comment threads and
  sign-in links that stopped working, page by page. (Released as
  prod-2026-10-22.)
- **The worker mails the operator** on a new site, an applied billing change
  and trials that expire unpaid (production `NOTIFY` send_email binding,
  `NOTIFY_TO` secret). (Released as prod-2026-10-22.)

- **Formatted text on a site Astro builds.** An entry's body, formatted or
  not, is edited on the page with the same toolbar as a plain HTML site: bold,
  italic, links, lists (nested too), headings, quotes, line breaks. The editor
  reads the entry's Markdown (`POST /source/read`), matches each block on the
  page to its block in the file by what it says, and writes back only what
  changed, in the file's own style: a block nobody touched keeps every byte, a
  changed word rewrites that word, and a reference link, a hard break or a
  wrapped line stays as the file wrote it. Pictures in the text go back as the
  file wrote them (Astro shows its optimised copies at other addresses). A
  table, a code block, raw HTML, and in MDX a component or an expression, stay
  as they render, take no typing and say why when clicked. MDX prose is
  editable; the worker takes an MDX edit only when every import, export,
  component and expression is as it was, with none added. A field stamped
  `{ type: 'markdown' }` is edited the same way, and a YAML block (`|`) stays a
  block. A text that no longer says what the file says (someone changed it
  since the page was built) is not offered until the site has rebuilt. Needs a
  worker whose `/healthz` says `sourceMarkdown`; with an older one a formatted
  text stays read-only, as before.
- **TOML front matter** (`+++`) is read and written like YAML: comments, quoting
  and key order stay. JSON front matter and data files are read and written the
  same way (`src/adapters/json-splice.js`), for the generators to come.
- **Markdown keeps its markup and adds none.** A change to a Markdown body or
  field may keep the scripts, frames and embeds the field already holds (an
  owner's video embed survives an edit to another paragraph) and may add none,
  including a link or a picture whose address would run code (`javascript:`
  and the like), which the old check could not see in Markdown.
- **Pictures and link addresses on a site Astro builds.** A picture stamped
  `kilnSource(entry, 'cover', { type: 'image', alt: 'coverAlt' })` is replaced
  from the device and described from its toolbar. The picture is made
  web-sized (WebP, or JPEG where the browser cannot write WebP), checked
  against the upload limits, put in the folder the field's picture is already
  in (beside the entry for a path `image()` checks, under `public/` for an
  address), committed before the entry, and named in the field in the file's
  own style. A picture inside an entry's text is replaced the same way and only
  its line changes. A link's address (`opts.href`, or `{ type: 'url' }` on an
  `<a>`) is typed in the toolbar beside its words. The worker writes a picture
  path only when the picture is in the repository, and refuses a new picture in
  Markdown that is not there (`/healthz` says `sourceMedia`; with an older
  worker these stay read-only).
- **Entries on a site Astro builds.** `kilnEntry(entry)` marks a card or an
  entry's article, and the editor gives it an Entry button: make it a draft or
  put it on the site, put a draft on the site later with the worker's
  scheduler, move it up or down by the collection's order field, copy it, see
  its History, remove it (asked first in the editor's own box; a commit that
  History undoes). **New post or page** adds an entry from the collection's
  schema: the box asks for the title and each required field, the file is named
  from the title and never written over. **Entries & drafts** lists a
  collection with its drafts first. Drafts follow `draft: true`, or the field
  `kiln-config.js` names (`draftField`, `draftValue`). New worker routes:
  `/source/create`, `/source/remove`, `/source/fields`, `/source/history`, and
  `/schedule` with `source` edits; `/healthz` says `sourceEntries`.
- **History and Page settings on a generated page.** History lists the
  versions of the page's entry file with a preview and **Go back to this**, and
  the entries removed from the page's collections with **Bring it back**. Page
  settings changes the entry's title, description and social picture in its
  front matter. **Schedule for later…** takes staged content-file edits.
- **A field an entry does not have yet** can be added by an edit that asks for
  it (`add: true`), in YAML, TOML or JSON front matter: a draft mark, an
  order, a description.
- **The site's own schema, before the build.** `kiln()` in `astro.config.mjs`
  publishes the collections' schemas at `/kiln-schema.json` at the end of each
  build, from what Astro writes in `.astro/collections/`. The editor reads it
  and refuses, with a sentence, a value the next build would reject (too long,
  not a full web address where the schema wants one, empty where it is
  required, not one of an enum's words). References made by the helpers carry
  the entry's collection (`?c=posts`).


- **The release runs the end-to-end tests itself.** With the two test
  repositories named (`KILN_E2E_REPO`, `KILN_E2E_SOURCE_REPO`),
  `npm run deploy:test` runs both tests on staging after the deploy, and
  `npm run deploy:prod` runs them on staging again before production is
  touched. Without them the output says the tests did not run. The migrations
  step is asked once more when Cloudflare refuses it the first time.
- **`kiln update --worker`** — for self-hosters. Brings the worker the setup
  wizard made (`kiln-worker/`) up to the current version: it lists the files
  that differ, asks, replaces them, adds any dependency the worker now needs,
  and asks again before running `npx wrangler deploy`. After a deploy it reads
  the version back from the worker. `wrangler.toml`, secrets and stored data
  are never touched. Until now the only way was to copy the files by hand.

- **`kiln rescue --render`** — freezes a site that is drawn by JavaScript (what
  Lovable, v0 and Bolt usually build) into HTML that Kiln can edit. Each page is
  opened in a browser already on the machine (Chrome, Edge, Brave, Chromium; or
  `--browser <path>`), left to finish, scrolled to the end so lazy pictures
  load, and saved as it looks. Pages are found from the links on screen,
  `sitemap.xml` and the routes the app moves to. The app's scripts are removed,
  styles that existed only in memory are written into the page, and
  `RESCUE-REPORT.md` lists what stopped working: every form, every control
  that needed script, every page that came out differently on a second visit.
  `--menu-shim` adds one small script so the phone menu still opens, and
  `--try` writes a try-out config so the copy can be served and edited at
  once. `playwright-core` is an optional peer, looked up only for `--render`;
  nothing is downloaded. Rescued pages now also carry Kiln's two script tags.
- **Publish sheet** — every Publish control first shows what will change: each
  edit as before and after in the page's own words (text word by word, pictures
  as two thumbnails, added and removed blocks named), a control to drop one
  edit, a one-line note that becomes the commit message, and warnings that do
  not block (a picture with no description, a link that goes nowhere, an empty
  heading). A bottom sheet on phones; Ctrl/Cmd+Enter publishes. Suggest-only
  editors get the same sheet ending in **Send for review**. **Settings →
  Publish without the preview** turns it off in one browser.
- **Undo after publishing** — the confirmation reads "Published. Undo" for ten
  seconds. Undo is one more ordinary commit that puts the page file back
  exactly as it was, written against the file as it stands, and the edits come
  back as unpublished. If someone else has published to the file since, nothing
  is written and History is offered instead.
- **"From this site"** — replacing a picture now offers the pictures the site's
  repository already holds, beside Upload: names, folders and sizes, a search
  box, the pictures on the current page first. Choosing one commits no new
  file. An editor limited to certain folders sees only pictures in them.
- **Help** in the Kiln menu, the top bar and Search, opening the guide for
  whoever is signed in.
- **First-session guide for invited editors** — the demo's three steps (edit a
  heading, publish it, what happened), shown once to an editor who can publish.

- **Source-mode worker endpoints** — the worker can now edit the content files
  a generator-built site is rendered from, not just finished HTML.
  `POST /source/commit` applies typed, per-field edits to a content file
  through a source adapter (Astro first): frontmatter values are spliced
  surgically (comments, quoting, and key order survive byte-identical), each
  edit is validated for its declared type (date, time, url, boolean, number)
  plus a markup guard on every text value, bad edits are skipped individually
  instead of failing the batch, and a concurrent save re-applies your edits
  once on top — the same merge model HTML publishes use. `POST /source/revert`
  restores a file to its content at any commit, the one-click release valve
  when a bad edit breaks the site's build. `POST /source/duplicate` copies an
  entry to the first free `-copy` sibling ("add another event" in v1).
- **`GET /healthz` capability handshake** — now answers
  `{ ok, modes, adapters, version }` so editors can feature-detect source
  support; an old worker (or old editor) degrades gracefully instead of
  erroring.
- **Wizard: "How is this site built?"** — setup now detects generator-built
  repos (Astro, Eleventy, Hugo, Jekyll signals) from the local tree, shows
  what it found ("Found astro.config.mjs and 63 content files"), and asks the
  mode question in plain language. Choosing source mode writes
  `mode: 'source', adapter: 'astro'` into the generated kiln-config.js and
  prints the remaining source-mode steps (install `@kilncms/astro`, verify the
  host auto-deploys, check the build's Node version). Choosing HTML mode over
  committed build output gets the guard warning: edits to `dist/` are erased
  on the next build. Self-hosted workers generated by the wizard now carry
  `src/adapters/` and the `yaml` dependency (added to existing installs on
  re-run) so they can serve source commits.
- **`kiln doctor` source-mode checks** — warns when a repo looks like a
  generator build but the site is in HTML mode (the silent-data-loss trap),
  and in source mode verifies the worker's `/healthz` advertises source
  support — an older worker warns instead of failing.
- **Source-mode editing in the editor** — pages carrying `data-kiln-source`
  provenance are editable in place, exactly like `data-cms` fields: click the
  text, type, Publish. Edits are grouped by content file and committed one
  file at a time ("Saving 3 changes across 2 content files."), with the honest
  §11 publish states — **Saved → Building… → Published ✓ / Build failed ✕** —
  driven by the commit's real status and deployment polls; a failed build gets
  a banner with one-click **Undo this change** per committed file (reverts to
  the commit's parent). Fields show "Where does this come from?"
  (`events/e.md → title`), a worker without source support renders them
  read-only with a lock and tooltip, malformed provenance warns once and locks
  the field, and an element carrying both `data-cms` and `data-kiln-source`
  edits its source (with a console warning). Undo/redo, the modified markers,
  the Publish count, sandbox previewing, and suggest/review gating all treat
  source edits as first-class. HTML-mode sites that resolve a page inside
  committed build output now get the §7.3 blocking explanation instead of
  silently-erased edits.
- **`@kilncms/astro`** (`integrations/astro/`) — provenance helpers for Astro
  sites: `{...kilnSource(entry, 'title')}` / `{...kilnBody(entry)}` stamp
  `data-kiln-source` on rendered fields, one line per field. Helpers never
  throw, and `KILN_DISABLE=1` strips provenance from a build. The `kiln()`
  integration is a documented no-op in v1; automatic stamping and schema
  export land under the same entry point later.
- **A Publish button beside the pencil** — as soon as there is an unpublished
  edit, a labelled button ("Publish 1 edit", "Publish 3 edits") appears with
  Undo and Redo above the pencil, at every screen size. It runs the same
  publish as the menu item, which stays. Publishing while still typing in a
  field now includes that field.
- **Editable fields show themselves** — when editing starts, every editable
  field shows its outline for a moment and fades back. On touch screens a faint
  outline stays, since there is no hover to find fields with.
  `prefers-reduced-motion` gets the outlines without the fade.
- **A first-run guide in the demo** (sandbox mode only, once per browser,
  skippable) — points at the first heading ("Click this and type."), then at
  Publish ("Now publish it."), then shows a card titled "That was a Git commit"
  with the text before and after and the commit message a real site would get.
- **Keyboard support for the pencil menu** — Enter or Space opens and closes
  it, the arrow keys move through its items, Escape closes it and returns
  focus to the pencil.
- **`templates/_headers`** — new sites get a small `_headers` file from the
  wizard: `X-Content-Type-Options: nosniff`, a referrer policy,
  `frame-ancestors 'self'` (so another site cannot frame the editor) and HSTS.
  An existing `_headers` is never touched. No script-restricting
  Content-Security-Policy is shipped; `docs/for-site-owners.md` explains how to
  add one and what Kiln needs allowed.
- **`scripts/ui-check.mjs`** — a browser check of the first minute of editing
  against a locally served sandbox site, at three screen sizes: Publish is
  visible after one edit, nothing of the editor covers another part of it, the
  page never scrolls sideways. Needs Playwright (`PLAYWRIGHT_DIR`); not part of
  `npm test`.
- **Member sign-ins can be ended** — removing a member, or changing their
  entry, now ends a sign-in they already hold. The members gate asks the
  worker (`POST /members/check`) at most every five minutes whether each
  signed-in member is still on the list; if the worker cannot be reached the
  last answer stands for up to an hour, then the gate closes. Sites set up
  earlier get the new gate with `kiln update` (their worker must be current
  first: `/healthz` reports `memberSessions`), and their members sign in once
  more. `kiln doctor` fails on a site that still has the old gate.
- **A release path** — `npm run deploy:prod` is now `scripts/release.mjs`, the
  only way to production. It refuses, with one sentence saying what to do,
  unless the commit is on `main`, pushed, green in CI, matches `dist/`, and is
  already running on staging; then it applies database migrations, tags
  `prod-YYYY-MM-DD`, deploys, and checks. `--dry-run` changes nothing.
- **Version reporting** — `/healthz` adds `build` (the commit the worker was
  deployed from). `kiln doctor` prints site bundle, worker and latest release
  on one line. `KILN_BUILD_VERSION` fixes the build stamp, so a release
  deploys the bytes it built.
- **Database migrations** — the Kiln Cloud schema lives in
  `worker/migrations/` and is applied with `wrangler d1 migrations apply`.
- **The setup wizard adds the two script tags** — it lists the pages that do
  not load the editor and offers to add the tags before `</body>`. A page that
  already loads `kiln.js` is never touched and a second run changes nothing.
  `kiln doctor` fails when the home page does not load `kiln.js`.
- **`kiln --help`** — one line per command, the options each takes, and the
  five words a newcomer meets. `--help` with a command runs nothing; an unknown
  command prints the help and exits 2; an option a command does not have is
  refused by name; `--version` prints one line.
- **`/healthz?deep=1`** — asks KV, the database and GitHub, and answers 503
  naming the part that failed. A plain `/healthz` is unchanged.
- **Backups** — `scripts/backup-cloud.mjs` copies the Kiln Cloud database and
  the KV keys that cannot be recreated into one owner-only archive outside the
  repository (14 kept); `scripts/restore-kv.mjs` puts KV back and refuses
  production without `--i-mean-production`. A launchd template runs it nightly.
- **`worker/wrangler.example.toml`** — a complete configuration for a
  self-hosted worker, with the three values to change marked.
- **CI on every push** — tests on Node 20 and 22, a rebuild that fails when
  `dist/` does not match the sources, the worker bundled in every
  configuration, `npm audit`, and a markdown link check. A monitor workflow
  checks the production worker and the demo sites every 30 minutes.
- **`docs/PUBLISHING.md`** — the three npm packages are one command from
  publishable; nothing is published yet.

### Changed

- **A repository is its GitHub id, not its name.** The worker now records the
  id of every repository it meets. When a repository is renamed or moved to
  another account and the site's config is corrected, the people list and a
  Kiln Cloud registration move to the new name the first time anyone uses it;
  until then a site that still has the old name keeps working. If the old name
  later answers as a different repository, that repository gets none of the
  people stored for the first one: owner requests under the name are refused
  with the reason. Member sign-in compares repositories by id, so an origin
  registered under the new name accepts a site whose config has the old one.
  `kiln doctor` asks the worker and fails on a rename (private repositories
  included) and on a name that changed hands. Backups include the new records.
- **Everything a site stores follows a renamed repository.** Not the people
  list alone: comment threads, suggestions, scheduled posts, API tokens and
  members' sign-ins move to the new name too, the first time anyone uses it.
  A large site is moved in steps (about a dozen threads a request, about a
  hundred every five minutes by the cron) and nothing is hidden or counted
  twice meanwhile. Editors sign in once more; members stay signed in. A site
  that still has the old name keeps reading and writing the same things. A
  post scheduled before the rename is published once, to the repository it
  was made for. If the old name later answers as a different repository, that
  repository gets none of it: comments, suggestions, schedules and tokens are
  held under the name exactly as the people list was. `kiln doctor` says that
  changing `repo` is safe and what follows. A repository followed by the
  release before this one has the rest follow on its next request.
- **"Latest" means released, everywhere.** The editor's "a newer Kiln editor is
  available" notice now reads the build stamp on the `release` branch, which
  each production release moves, as `kiln doctor` already did. Work on `main`
  that has not been released is no longer offered as an update. The guides and
  every message the tool prints now say `npx github:kilncms/kiln#release`, so
  the tool that is fetched is the released one too.

- **The "Make things editable" grant now does something** — its two tools were
  drawn for the owner only. An editor granted it in People & access sees them
  (not a suggest-only editor or a reviewer, and not on a page outside their
  folders).
- **"+ Add section" dividers on phones** — only the two around the section
  last touched are shown, and at every size a divider hides while it is under
  the Undo, Redo and Publish row, the pencil or the demo banner.
- **`kiln rescue`** follows the first page to the site's real address (a
  builder's subdomain that forwards to the owner's domain), names an error
  page that was answered as a normal one, and `--max-pages 6` (with a space)
  is now read as 6.
- A picture's description is part of what Undo restores.

- **Invited editors can upload a fixed list of file types** — pictures (JPG,
  PNG, GIF, WebP, AVIF, ICO), PDF, Word / Excel / PowerPoint and OpenDocument
  files, fonts, audio and video, up to 15 MB each, and the file's first bytes
  must match its name. Everything else is refused with a plain message, in the
  editor when the file is picked and by the worker on every write path. SVG is
  refused outright. The owner, who commits with a GitHub sign-in, is not
  affected.
- **`.xhtml` pages are no longer editable by invited editors or API tokens** —
  they are parsed as XML, where the HTML content guard cannot vouch for them.
- **Scheduled edits and suggestions from editors are for HTML pages only.**
- **Comments follow an editor's page scope** — an editor limited to some pages
  reads, counts, posts and resolves comment threads on those pages only.
- **`kiln doctor` fails on a renamed or transferred repo** — it used to warn
  and still report "healthy". It also no longer reports Google sign-in as
  configured when the worker does not answer.
- **On phones a block's controls open from one "more" button** per block,
  instead of five buttons on every card.
- **The status line wraps** instead of cutting a long message off, and on a
  phone it leaves after four seconds or on a tap.
- Editor bundle grows to ~484 KB raw / ~146 KB gzip (still loaded only after
  sign-in; the visitor shim is unchanged at ~3 KB gzip).
- **`worker/wrangler.toml`** — production moved under `[env.production]`. The
  top level is a local-development configuration with placeholder ids, so
  `npx wrangler deploy` with no `--env` cannot reach production.
  **Self-hosters who edit this file by hand:** set `name`, the KV id and
  `ALLOWED_ORIGINS` at the top and delete the D1 block; there is no route
  block to delete any more. Sites set up with the wizard are not affected.
- **Bundle propagation is two steps** — `npm run propagate` updates the
  canary (the demo) only. Customer sites are a second, explicit
  `npm run propagate -- --customers`, refused unless the canary's live
  `kiln.js` carries the new build. The run stops at the first failure, sends
  only a released build, never publishes a checkout's own unpushed commits,
  and prints the revert command for every commit it pushes. It is no longer
  part of `deploy:prod`; `deploy:worker` is removed.
- **Kiln Cloud: cancelling keeps editing until the paid period ends** — a
  cancelled subscription used to switch editing off at once. The site now
  edits until the end of the period already paid for. After a failed charge
  (or paused billing) editing continues for 7 days while the card is retried.
  Only an expired subscription ends access outright.
- **Kiln Cloud: removing a site cancels its subscription** — in the same
  request, before the site is removed. If the cancellation cannot be
  confirmed, the site is kept and the answer says to cancel in Manage billing.
- **Tool grants are enforced by the worker** — an editor without the Theme
  grant cannot write a stylesheet, without New post cannot add a page to a
  published branch, without Drafts cannot write to `kiln-drafts`, without
  Schedule cannot schedule, and without Comments cannot comment (a review
  seat still can). These were hidden buttons before; a refused write answers
  403 with `code: "grant_required"`.
- **Presence writes** — an open editor wrote to KV every 30 seconds, enough to
  use up a free Cloudflare account's 1,000 daily writes in one working day and
  stop sign-in. It now writes on arrival, on a page change and every five
  minutes. Someone who leaves is listed for up to six and a half minutes.
- **`scripts/e2e.mjs`** — runs against the staging worker and a marked test
  repository, as invited editors, and puts the repository back as it found
  it. It no longer touches the public demo or the production worker.
- **dompurify 3.4.16** (from 3.4.9, inside the range of published
  advisories), now listed under `dependencies`. wrangler 4.147.

### Fixed

- **On an iPhone a tap elsewhere now folds a block's open control bar away.**
  Safari makes no click for a tap on plain words or empty space, so the bar
  stayed open until a button or a field was tapped. A finger put down and
  lifted in the same place now counts wherever it lands; a swipe does not.
- **On a phone the editor's controls are one row.** Undo and Redo (as icons,
  named for screen readers), Publish and the Kiln button sit side by side at the
  bottom, where they used to be two floating rows over the bottom of the page.
- **Which editor each site runs.** The editor says its build with its presence
  ping; the worker keeps it per repository (`ebuild:<repo>`, written when it
  changes or once a day) and the operator's overview (`/admin/cloud/overview`)
  carries `editor_build` and `editor_seen` for each site.
- **Security headers for sites set up before Kiln wrote them.** `kiln update`
  on a site with no `_headers` file offers Kiln's (asked first); a site's own
  file is never touched.
- **A written procedure for deleting what Kiln keeps**
  ([docs/deleting-data.md](docs/deleting-data.md)): what the worker stores about
  people and sites, what deletes each part, and the steps for an invited person
  and for a whole account.
- **On an Eleventy, Hugo or Jekyll site nothing suggests a source mode that
  does not exist for it.** The editor's "This page is build output" box, the
  setup wizard and `kiln doctor` say that Kiln can't edit that generator's
  content files yet (Astro is the one it edits) and what HTML mode does there,
  instead of telling the owner to switch to source mode.
- `kiln update` on an Astro site whose `src/lib/kiln-astro.mjs` is an older
  copy of Kiln's helper says so and offers the newer one (asked first; a file
  that is not Kiln's is left alone).
- A formatted text from a content file, saved in the browser and brought back
  after a reload, is published as Markdown again (it was sent as plain words),
  and a picture put in it or in a picture field comes back with its file.
- **Undo could leave what it restored invisible, and a publish wrote one
  visit's state into the page file.** The editor copied each field's markup as
  it started, while the site was still animating in. On a site whose headline
  slides in, Undo put back the start of the slide, which cannot be seen, and so
  did "Drop" in the publish sheet and History's "Undo this change" in try-out
  mode, which then published it. A field's HTML was also read off the live
  page, so a publish wrote whatever the site's scripts had put there: an
  animation library's `opacity` and `transform` on a headline's lines, the
  class a fade-in adds to a paragraph.
  - What Undo goes back to is taken when the person begins to change a part (a
    press on it, its toolbar opening, a press on one of a list's buttons), for
    as long as no change to it is waiting. A link's address and a picture's
    address, description and size have a baseline the same way, so a picture
    a lazy loader has put in place is the one Undo returns to.
  - A field is published as the page's file would hold it. An element the file
    has inside the field keeps the file's `class` and `style`, plus what the
    person changed while editing; what a script added is not written, and a
    class or style the file has is not lost when a script takes it off. The
    same holds inside the fields of a list's blocks, and for the size a
    picture is dragged to.
  - Undo, Redo, Esc, "Drop", History's two ways back, a draft and "Pick up
    where you left off?" no longer write a field with `innerHTML`. The
    elements that are there stay, with whatever the site's scripts are doing
    to them; one that was typed away comes back as itself; a new one is given
    what the scripts gave another of its kind. A part that fades in on scroll
    still does after a draft is put back on it.
  - A field counts as unchanged when it reads as its baseline does, so an
    animation that moved on while the field was open is not an edit.
  - Undo of a link's new address, or of a picture's new size, puts the old one
    back on the page; it used to leave the new one there with nothing staged.
  - Try-out mode: a demo stored by the editor that had the fault is mended once
    per page as it opens, so a headline that was stored invisible shows again.
  Not covered: words a script splits into pieces of its own inside a field, a
  class or style a script first sets on an element while it is being edited,
  and the address of an editable picture that a lazy loader also changes.
  Those are published as they are on the page, as before.
- **The publish sheet hid a change, and the number on Publish did not follow
  what was done.** A price changed in a list, then an item added to the same
  list: the sheet said only "Added", and the button stayed at "Publish 2
  edits" through an add, a move and a removal. Every change to a list is named
  now: each item added and removed, a change of order, and each item that was
  changed, by its name, with its words (or its picture) before and after. The
  number on every Publish control, the sheet's title and the menu's badge is
  the number of things the sheet lists.
- **A tap on a copy of an editable part did nothing a person could read.** A
  page often shows one thing twice and only one of the two was marked as
  editable. Where the editor can tell (the same words inside a link to the
  same address as one editable part, or words only one editable part has), a
  click on the unmarked copy says "This copy can't be changed here. The same
  words can, in Products." with **Show me**, and its link is not followed
  (Ctrl or ⌘ and a click still follows it). A picture or a line nobody marked,
  inside a block whose other parts are editable, says so. Nothing is made
  editable that was not, and a link in a `nav`, `header` or `footer` is never
  taken over.
- **The menu, the search panel and the toolbars were see-through** where a
  browser does not draw the blur behind them: the page's own words showed
  sharply through. Their background is solid enough to read on its own.
- **A photograph was stored as PNG by a browser that cannot write WebP**
  (Safari), ten times the size it should be, under a `.webp` name. Such a
  browser writes JPEG now, or PNG for a picture with see-through parts, and the
  file is named for what it is. In try-out mode this is why a normal photo
  would not publish on a phone ("This browser has no room left for the demo").
  The demo also no longer keeps a second, full-size copy of each picture in the
  browser, refuses a picture larger than 1 MB after it is made web-sized with
  its size and the limit, before anything is kept, and "no room" points at
  dropping a picture before "Start over". Undo or Drop of a new picture frees
  the full-size original it brought with it.
- **Undo after removing a list item ran the page to the middle of the list**,
  screens away from the item that had come back. Undo and Redo show the block
  that came back and move the page only as far as it takes to see it.
- **"Removed. Undo" could vanish after a second or two.** In try-out mode the
  first status line's timer was lost while the editor started and went off on
  whatever line was showing four seconds into the visit; and after a publish
  the return of "Signed in as…" replaced a newer line. The line has its ten
  seconds, the same as "Published. Undo".
- **"Start over" and "Delete draft" acted at once.** Each asks first, in the
  editor's own dialog, and says what would be lost.
- **Small things.** "Add event" and "Add person" pressed with an empty form
  say what is missing. Advice about keys ("Esc cancels", the hints under
  Search & jump, "hover for the menu") is shown only where there is a
  keyboard, and choosing a place for a new section has a Cancel button. Search
  & jump searches all of a part's words, not its first 42 characters, shows
  the words around what it found and goes to the item that holds them; lists
  the pages this page links to where there is no repository to list (try-out
  mode); finds words on the page that are in no editable part and says they
  are not editable; and no longer lists a part because its name happens to
  contain the typed letters in order. "Schedule these 1 edit" reads "Schedule
  this edit". A note typed under "What changed?" survives a try-out publish
  that did not fit. The demo calls its visitor "You", not "You · editor". On a
  phone the line of words sits below the site's own header, and at the top of
  the page below its banner, not on the logo. An events list or gallery added
  from the menu has its heading in the site's own heading type and each event
  set apart (on a site with no styles of its own for `.kiln-event`; the
  section is marked `kiln-plain`). People & access says what it means in an
  owner's words, its help text is larger, and the AI assist box is not offered
  when the worker says the site has no AI key (`aiConfigured: false` from
  `/admin/people`; a worker that says nothing leaves the box as it was).
- **The worker says whether it has an AI key.** `GET /admin/people` now
  answers `aiConfigured` beside `googleConfigured`, so People & access does not
  offer "AI assist" on a worker with no `AI_API_KEY`. The key itself is never
  sent. Self-hosters get it with `kiln update --worker`.
- **On a site a generator builds, nothing is written over unasked and nothing
  is offered that cannot be done** (source mode):
  - A field someone else changed since the page was built was written over
    without a question: the owner renames an event, an editor whose page still
    shows the old name publishes another, and the owner's is gone. An edit now
    says what its field showed when the page was read, the worker leaves that
    one edit out when the content file no longer says that, and the editor asks
    **Someone else changed this**, showing Theirs and Yours, with **Keep
    theirs** and **Use mine**. The other edits of the same publish are saved.
    An editor from before this sends nothing about what it read and is saved
    as before; this editor against a worker from before this is saved without
    the question, as before. `/healthz` says `sourceWas: true`.
  - A `url` field took any words ("Get tickets" was saved as an address). It
    takes a web address (`http:`, `https:`), `mailto:`, `tel:`, or a place on
    the site (`/about`, `./about`, `#top`), and the editor says so when the
    field is left.
  - An edited value lost the quotes its line had: `start: '18:00'` became
    `start: 18:30`, which a YAML 1.1 reader takes for the number 1110. A quoted
    line stays quoted, in its own quotes, and on an unquoted line a time and
    any text a reader could take for something else (yes, no, on, off, a
    number with a leading zero, a date) is quoted. Text beginning with `#` was
    written unquoted, which made it a comment and the field empty; it is
    quoted. Inside a bracketed list a value with a comma is quoted.
  - Saving an entry's text removed the blank line after the frontmatter. The
    file stays as it was around the text.
  - Search & jump listed `/public/kiln.html`, the sign-in page under an address
    that does not exist, as the site's only page. It lists the site's real
    pages: from the adapter's routes, the links on the pages and the sitemap,
    each checked against the built site before it is listed. "Search site
    text" searches those pages, and "On this page" lists the fields that can
    be edited.
  - A suggest-only editor could type into a field, was offered "Suggest
    changes", and was then told no. Those fields are read-only for them from
    the start and say why. A comment-only editor was told "Click any outlined
    text to edit." with nothing outlined, and Comments on a generated page
    opened, and every comment written there was then refused (a comment is
    filed under the page's file, and such a page has none): Comments is not
    offered there.
    The first line each person reads says what they can do on that page.
- **A comment-only editor saw a greyed Publish** at the top of the menu, on any
  site, and a "This page" heading over nothing. Neither is shown.
- **On a phone, three bars lay on the status line**: the failed-build banner,
  the box that lists what was not saved, and the bar a History preview shows,
  which was a narrow box over the site's own header. They share one column,
  above the pencil and its buttons, as wide as the screen. The History bar
  read "Keep — then Publish"; it says "Nothing is live yet. Keep it, then
  press Publish.", with Cancel and Keep.
- **The first tip of a first session lay on the paragraph under the heading.**
  It goes beside the heading's words when there is a paragraph under it and no
  room over it. (On a phone, with a heading as wide as the screen at the very
  top of the page, it is under the heading still.)
- **The last two questions asked in the browser's own box** are the editor's:
  a preview link that could not be copied is shown selected in its dialog, and
  making text editable whose words in the page's file differ from those on
  screen is asked in one dialog that shows both.
- **Editing a page a generator built** (source mode), watched in a browser for
  the first time, as an invited editor on pages Astro built:
  - An entry's text was saved as the plain words on the page, so changing one
    word of a description wrote it back without its bold, its links, its list
    and its paragraphs. A text with formatting is now read-only on the page
    and says why; a text that is one plain paragraph is edited in place, and
    what is typed is saved as words.
  - A number or a yes/no could never be saved (the editor sent words, the
    worker takes a number and true or false). A date, a time, a number or a
    web address of the wrong kind was staged without a word and refused at
    Publish with the reason in a tooltip. The line now says how to write it
    when the field is left, and before that when the page shows the value in
    the site's own way.
  - A link stamped with its address was edited by its label, and the label was
    saved as the address. It is read-only, like a picture. Anything the worker
    would turn away for what it is (the site's own files, a folder this person
    was not given) is read-only before anyone types. A click on a read-only
    part says why in the status line, where a phone can see it.
  - The publish sheet, "Pick up where you left off?" and Copy my text named
    fields by pointer ("/Frontmatter/Title"). They say "Title · Spring fair".
  - What a publish left out is listed with its reason in a box of its own; the
    worker's answers are told as sentences ("file type not editable by this
    adapter" was shown as it came).
  - While the host builds, the line reads "Saved. The site is rebuilding with
    your change…". The first-session guide went back to "Click this and type."
    after a publish; it now ends with a card that says saved, not published. A
    reload during the build showed the old page and said nothing; it shows what
    was saved and goes on watching. After a failed build, "Undo this change"
    left words on the page that were neither saved nor unpublished; they come
    back as an unpublished edit.
  - History listed every commit in the repository as the page's versions, and
    each way back ended in "That version could not be read"; Page settings
    showed an empty form that could not be saved. Both now say that they
    cannot show a generated page yet.
- **A published list carried what the site's own scripts had done to it.** A
  block that had faded in was written to the page file with the class the
  fade-in adds, and a list staged while a filter was on carried the filter's
  `display:none`. A list is now published as the file has each block, plus
  what the editor changed: outside the editable fields every attribute is the
  file's (except a block's tags), and on a field only its link, its picture
  and the picture's description and size are taken from the page. Left as they
  are on the page: elements a script added or removed, and words a script
  changed outside a field.
- **History showed a restore side by side in two frames with the scripts
  off**, where a site that fades its sections in showed them blank. "Undo this
  change" and "Go back to this" now show the result on the page itself, with
  Cancel and Keep, as the demo already did.
- **Four more questions were asked in the browser's own box**: deleting a
  comment thread, deleting a page (two boxes), signing out with edits waiting,
  and the note for declining a suggestion. Each is one dialog of the editor's
  own, whose buttons say what they do. Signing out now also asks when the only
  thing waiting is an edit to a content file, an upload or a section.
- **A block's buttons showed on top of a site's sticky header** while the block
  scrolled under it. They are hidden for as long as any part of them is under
  a bar the site keeps at the top of the screen.
- **Undo in a list could make the whole list invisible.** On a site whose
  blocks fade in as they scroll into view, Undo after removing, adding, moving
  or duplicating a block, or after changing a word in one, left the list on
  the page and out of sight, and so did "Drop" in the publish sheet and
  History's preview. The editor wrote the list's earlier HTML back as new
  elements, which the site's own script had never seen and so never showed.
  A list is now written block by block: a block that is on the page stays the
  element it is, a block that was taken off is the one put back, and a block
  that is new takes the classes the site gave the block it stands in for.
- **A block's buttons followed the link when the block was one.** On a card
  that is a link, pressing Move, Duplicate, Tags or Remove also opened the
  card's address in a new tab.
- **Failures were shown as the text of an exception.** "Draft failed: Cannot
  read properties of null (reading 'request')", "Failed: GitHub 422: Reference
  already exists", "Publish failed — see console". Every such place now says
  what was not done and why, in a sentence. The exception goes to the console.
- **The demo's safety net.** In try-out mode (`sandbox: true`): Save as draft
  failed, and now keeps the draft in the visitor's browser and offers it back;
  an edit that was not published was gone after a reload, and is now offered
  back with "Pick up where you left off?"; "Schedule for later" printed the
  worker's "forbidden", and now says what a real site does; and there was no
  History, where there is now one of this browser's publishes, with "Undo this
  change" and "Go back to this" working. New post or page, Page settings, Site
  menu, Find & replace and People & access are shown in the demo's menu, each
  opening its own dialog and saying what a real site does where it would act.
  The ✨ button says what it is beside the button instead of doing nothing
  visible.
- **A saved draft could take the place of "Pick up where you left off?"**, on a
  real site, when a page had both: the question about the draft opened over the
  other one, and the unpublished edits were lost with the next change. The
  draft is now asked about afterwards. Edits thrown away with "Discard & exit"
  are no longer offered back.
- **Removing a block asked in the browser's own box**, which told people the
  way back was to leave the page. It is immediate, with "Removed. Undo".
- **The link button asked in the browser's own box too.** It opens the
  editor's dialog: one box for the address, "Add link" or, with the cursor in a
  link, "Change link" and "Remove link". Enter submits, Escape cancels, and the
  cursor and the selection come back to the field either way. What an address
  may be is unchanged.
- **The demo lost its one link to Kiln when the card after a first publish
  closed.** Once a visitor has published, the demo's pill carries "Put Kiln on
  my site" whenever that card is not on screen, for as long as the demo's
  state lasts.
- **On a phone the saved draft's four choices** were in one row, with "Resume
  draft" on two lines and, on a small phone, "Later" off the edge. They are two
  to a row, each on one line.
- **Developer names shown to the person editing.** The toolbar, the hover
  hint, Search & jump, the publish sheet and "Pick up where you left off?"
  show a readable name made from the field's name ("Hero headline", "Hero
  picture"; the stored name is the label's title). Search & jump no longer
  matches a scatter of letters ("history" found "hero img"). Theme says "The
  site's colors and type sizes" and names its settings in words, with the
  stylesheet's names as small print for the owner.
- **On a phone** the first tip lay on the page's own buttons, the pencil on
  the last items of the menu, and a block's opened buttons on the next block's
  words; none does now. Choosing "Top bar" in Settings no longer leaves the
  first lines of the page under the bar (laptop too), and a full menu no longer
  runs off a small laptop's screen. The first-session guide's last card puts
  itself away after twenty seconds.

- **An editor whose sign-in the worker had ended was left with an editor that
  did not start, and no way back to the sign-in.** A 401 for the stored
  sign-in (someone taken off People and added back, a repository renamed, a
  session the worker no longer has) went to the console; the sign-in stayed in
  the browser, so `/kiln` sent the person back to the same silent page. The
  editor now drops that sign-in and the page says "Your sign-in to edit this
  site has ended, so please sign in again with Google.", with a button to the
  sign-in that returns to the same page. When the worker says the owner has
  something to correct (`code: "repo_changed"`), the sentence says to ask them
  and shows the worker's message. The owner is told the same way, with GitHub,
  when the token cannot be renewed. It reads only what every worker's answer
  carries, so an older self-hosted worker needs no change.
- **Publish with an ended sign-in said "Publish failed — see console".** A
  dialog now says that nothing was published and that the edits are saved in
  this browser. After **Sign in again** they are back on the page without a
  question, and Publish sends them. What the saved copy cannot hold (parts
  made editable, sections added or removed, or everything when the browser
  cannot save) is said before the person leaves, with **Copy my text**. A 403
  keeps the edits too: it says the sign-in does not allow the change, shows
  the answer's reason and offers the copy. The owner's page is no longer
  reloaded under their edits.
- **No answer, a 5xx or a 429 is not a sign-out.** None of them drops a
  sign-in or an edit. On page load, where the editor used to fail without a
  word, the page says editing could not start and that the person is still
  signed in; at Publish the status line says nothing was lost and to try
  again. GitHub's rate limit, and a token that ran out while the worker could
  not be reached, no longer sign the owner out.
- **Source mode: an unpublished edit to a content file was lost on any
  reload.** The copy of unpublished edits the browser keeps now holds them
  beside page edits, and "Pick up where you left off?" offers them back. An
  ended sign-in at Publish (the worker's `/source/commit` answering 401) gets
  the same dialog as a page edit, where it used to say "unauthorized".
- **An ended sign-in was said only on page load and at Publish.** History and
  going back to a version, naming a version, Save as draft, Schedule and its
  cancel, comments, suggestions, the list of the site's pictures, AI assist,
  page settings, the site menu, a new page, find and replace, Theme, People
  and the undo after a publish each showed a line of their own ("Failed:
  GitHub 401", "Comment failed: unauthorized", "Failed: forbidden") or
  nothing. Each now opens the dialog Publish shows, naming what was not done
  ("Nothing was scheduled."); a 403 says the sign-in does not allow it, with
  the answer's reason; no answer, a 5xx and a 429 say nothing was lost and to
  try again. When the editor finds out by itself (asking who else is editing),
  one line in the status bar says so and offers **Sign in again**. Schedules,
  presence and People answer 403 to someone the worker does not know, so a
  403 from those is checked once against the route that answers 401 on every
  worker: an older self-hosted worker needs no change.
- **What was being typed when a sign-in ended went with the panel it was typed
  in.** The dialog now opens over the panel and gives it back as it was. A
  comment, a reply, the note under "What changed?", the time for a schedule
  and the name for a version are also kept in the browser beside the
  unpublished edits, and are back in their boxes after **Sign in again**: the
  comment where it was pinned, the schedule panel open with the time. For
  boxes that cannot be kept (page settings, the site menu, a new page, find
  and replace) the dialog says they will need typing again and puts **Copy my
  text** first. A new page that did not go through keeps its form.
- **A sign-in that ran out by the browser's own clock left the plain site,
  with no word of why the editor was gone.** The next page now says "Your
  sign-in to edit this site has ended, so please sign in again with Google."
  once, in the same card. The sentence is in the editor's bundle; the script
  every visitor loads grows by 82 bytes (36 gzipped) for the marker.
- **For the owner, People said Google sign-in was not set up once the GitHub
  token was eight hours old**, and schedules, comments and suggestions failed
  until a reload. The editor renewed the token for GitHub but not for the
  worker's own routes. It now renews it for those too and sends the request
  again.
- **The setup wizard told Astro owners to `npm install @kilncms/astro`**, a
  package that is not on npm. It now adds the helper to the project as one
  file, `src/lib/kiln-astro.mjs`, and shows the import to use.
- **On an Astro site the setup wizard put Kiln's files where the build never
  looked.** It wrote `assets/` and `kiln.html` at the top of the repository and
  printed a hint. It now writes the editor, the config (`mode: 'source',
  adapter: 'astro'`), the sign-in page and `_headers` under `public/` (or the
  `publicDir` named in `astro.config`), says so, and offers to add the two
  script tags to each template that closes `<body>`, written with `is:inline`
  so Astro does not try to bundle them. Settings from an earlier run are
  copied across and the old copies are named, not deleted. `kiln doctor` reads
  the config from `public/`, and `kiln update` refreshes the editor there
  (it used to stop with "No page here loads kiln.js").
- **The status line went from "Published." back to "Publishing…"** while the
  host was building. The wait now reads "“Your page edit” is going live…
  usually under a minute".
- **After Undo, the guide's last card still said the change was committed.**
  Pressing Undo while "That was a Git commit" (or, for an invited editor,
  "That is published") was on screen left it up. The card now says the edit is
  back, not published, and closes once that edit is published again or
  dropped.
- **On a phone the demo banner covered the pencil and the editing toolbar** —
  the menu could not be opened and the tap that tried hit "Start over". The
  banner is now a one-line pill beside the pencil, and steps aside while the
  toolbar or the menu sheet is open.
- **Clicking the pencil after hovering it closed the menu** that the hover had
  just opened. The click now keeps it open.
- **The status pill never went away** on sites whose own CSS does not reset the
  `hidden` attribute.
- **A block's control bar ran off the left edge of the screen** on a two-column
  phone grid and overlapped its neighbour's. It now stays inside its block.
  Table rows' controls, invisible on touch screens, are visible again.
- **The image resize handle made the page scroll sideways** on a full-width
  image, and could be left behind on the page after its toolbar closed.
- **`kiln update` wrote wherever the page's script tag pointed**, a folder
  above the site included, and made a folder named `https:` for a page that
  loads `kiln.js` from another address. It now writes only inside the site
  and says why when it will not.
- **`kiln update` ran its git commands through a shell** with a folder name
  read from the site's own HTML; a name with a space broke the commit. git now
  gets its arguments directly.
- When input ends while the CLI is waiting for an answer it exits 1 instead of
  a quiet 0.
- `kiln rescue --max-pages 5` (with a space) crawled one page.
- `kiln new` started a site on the editor its template last shipped; it now
  uses the current one.
- One CLI message told users to run `npx kiln doctor`, which is someone else's
  package on npm.
- The two scheduled jobs shared one unguarded call: a failure in the first
  silently skipped the second.

### Security

- **An address a site has left is trusted nowhere.** The hosted worker still
  answered the address one site moved away from, and its built-in map tied
  that old address, not the new one, to the site's repository. A Pages
  address that is given up can be registered by anyone. The old address is
  out of the production origin list and the map names where the site is now.
- **Invited editors could commit SVG, XML and XSL files**, which skip the HTML
  content guard and run script in the site's origin, where the owner's GitHub
  token is stored. Editor writes are now limited to an explicit list of inert
  file types on every write path: the commit proxy, multi-file commits (regular
  files only, no symlinks), scheduled edits, suggestions, API tokens and source
  reverts. A source revert by an editor can no longer bring back a version that
  adds scripts.
- **Editor uploads had no server-side size or content check.** There is now a
  15 MB ceiling, enforced before an oversized body is buffered, and uploads are
  checked by their leading bytes.
- **The AI-assist image fetch followed redirects to private addresses.** Every
  redirect hop is now screened, and the screen covers IPv6, carrier-grade NAT,
  reserved ranges and every spelling of an IPv4 address.
- **Comment threads were readable and writable outside an editor's page
  scope.**
- **Gated members pages and files are now served `private, no-store`** with
  `Vary: Cookie`, so no cache keeps a copy.
- **A branch can only move to a commit the worker checked** — an editor
  session could fast-forward a branch to any commit: another branch's head, or
  one never created through the worker. A branch now moves only to a single
  commit made on top of its current head through that session, and the commit
  is checked again (paths, file types, page content) at that moment. A new
  branch or tag must point at a commit the site already has.
- **Editor sessions cannot delete files** — the "no deletes" rule held for
  single files but not for multi-file commits, where a tree could drop any
  file in the editor's paths. Refused at the tree, the commit and the branch
  update.
- **The Kiln Cloud operator is identified by numeric GitHub id** — set
  `CLOUD_ADMIN_ID`; the login is compared only when no id is configured.
- **A session or a token works only for the repository it was made for** — a
  site that never corrected its config after a rename kept reaching GitHub by
  the old name. If another repository then took that name, with Kiln's App
  installed, the site's editors and API tokens committed into it. Editor
  sessions, members' sign-ins and API tokens now carry the repository's id,
  and every use checks that the name still answers as that repository: one
  more KV read, from the answer the worker already remembers for ten minutes.
  If it answers as another, an editor session gets 401 `session expired`, a
  token gets 403 with `code: "repo_changed"` and a sentence, a member is
  signed out, and a new sign-in is refused with a page that says why. Nothing
  is sent to the other repository. They work again once `repo` is corrected.
  Sessions and tokens from before keep working: tokens and members' sign-ins
  take the id the first time they are used, editor sessions at the next
  sign-in.

## [0.4.0] - 2026-08-19

The review-loop release: the comforts of the walled-garden site builders —
sections, brand controls, comments, suggestions, previews, AI — on a site you
own in git.

### Added

- **Comment pins** (`💬 Comments`) — Figma-style review on the live page: pin a
  comment to any element, threads with @who-said-what, resolve/reopen, a
  sidebar per page, and open-count badges. A **Reviewer preset** in People &
  access creates a true comment-only seat (`mode: review`) — the worker refuses
  every write for those sessions.
- **Suggest mode** — tick *Suggest-only publishing* on an editor and their
  Publish becomes **Suggest changes**: field-level suggestions land in an admin
  review queue with per-field before/after, Approve (conflict-safe re-apply onto
  the current page, suggester keeps authorship) or Decline. Enforced server-side:
  suggest-mode sessions cannot write to the live branch, schedule, or bypass via
  the proxy.
- **Preview links** — one `preview: 'https://{branch}.<project>.pages.dev'`
  config line turns drafts and suggestions into real, shareable branch-preview
  URLs built by your host.
- **Named versions & visual restore** — name any publish (git tags under
  `kiln/`), and every restore now shows a sandboxed side-by-side "Now vs. this
  version" preview before anything is staged.
- **Deploy-aware publish status** — "Live ✓ — view site" driven by your host's
  real deployment status (with content-probe confirmation), and "Build failed —
  open commit" when it isn't.
- **⌘K palette** — jump to any page, field, or tool; site-wide text search with
  in-context snippets, scope-aware for invited editors.
- **Block library + section chrome** — "+ Add section" between sections, fed by
  dev/AI-authored `_blocks/*.html` snippets; editors compose pages only from
  approved, brand-safe sections. Sections with a repeat key get a ✕ remove.
- **Theme panel** — the site's `:root` CSS custom properties become a brand kit:
  color pickers, font menus, size inputs, live preview, byte-exact stylesheet
  commits. No schema; the CSS is the source of truth.
- **AI assist** (BYO key) — Improve / Shorten / Tone / Translate / Custom on any
  field with a before/after preview, one-tap **alt text** for images, and
  "draft the content" on new posts — via a new `/ai/assist` worker endpoint
  (`wrangler secret put AI_API_KEY`). Same sanitizer and commit pipeline as
  human edits; grant-gated per editor.
- **REST API + scoped tokens** — `GET /api/v1/pages`, `GET /api/v1/fields`,
  `PATCH /api/v1/edits` behind owner-minted tokens scoped by path, section
  keys, read-only, and expiry. Every write is sanitized and committed with
  attribution.
- **kiln-mcp** (`mcp/`) — an MCP server over that API: give Claude or any MCP
  client safe, scoped write access to your site; every edit returns its commit.
- **`kiln rescue <url>`** — the escape hatch: crawl your Squarespace / Wix /
  WordPress site into a clean, self-contained static copy (assets localized,
  builder runtime stripped, lazy images fixed) and auto-tag it for Kiln.
- **`kiln new [dir]`** — scaffold a fresh site from a template repo
  (`--from owner/repo`), de-personalized, git-initialized, wizard-ready.
- **Phone-first editing** — the editor reshapes into bottom sheets with
  thumb-sized targets and a keyboard-aware toolbar on phones; desktop unchanged.

### Changed

- Editor bundle grows to ~426 KB raw / ~128 KB gzip (still loaded only after
  sign-in; the visitor shim is unchanged at ~3 KB gzip).
- Suggestion and API commits are authored with the person's or token's name and
  the `kiln-editor`/`kiln-api` noreply address — real emails never enter git
  history.

## [0.3.0] - 2026-07-12

### Added

- **Tag filters** — editors tag any repeat block (🏷 on its hover controls); tagged
  lists show visitors filter pills ("All" plus one per tag).
- **Photo galleries** (`data-kiln-gallery`) — multi-photo upload for editors,
  per-gallery thumbnail size; visitors get a grid and a lightbox with paging,
  captions, keyboard, and swipe.
- **Events with calendar views** (`data-kiln-events`) — structured add/edit form
  (date, time, location, link); visitors switch between List, Month, Week, and Day.
- **`kiln-features.js`** — a small dependency-free visitor runtime powering the three
  features above plus document chips and cards; the boot shim lazy-loads it only on
  pages that use them.
- **Make things editable** (admin) — pick any element on the page and Kiln splices the
  `data-cms` annotations into the repo file itself (text, plain text, image, repeat,
  gallery, events), or removes them again. No hand-editing HTML.
- **Image display size and resampling** — the image toolbar sets display width
  (25–100%) and can re-encode the file at a smaller max dimension; images inside
  rich-text fields get per-image size and remove controls.
- **Inline document upload** — upload a PDF or doc from the text toolbar and insert it
  as a text link, a chip, or a card; files land in the repo (`assets/files/`, or the
  gated `members/files/` on members pages).
- **Multi-editor presence** — people editing the same page see each other; publishing
  warns before overwriting a field someone else changed since you loaded the page
  (different fields still merge cleanly).
- **Per-page and per-section access** — "People & access" gains a page picker and
  optional section scoping per editor; the editor UI greys out everything outside an
  editor's scope and marks out-of-scope pages read-only.
- Editor toolbar is draggable and repositions itself so it never covers the text being
  edited on small screens; Settings (floating button vs top bar) is now visible to
  invited editors, not just admins.

### Fixed

- **Repeat blocks built from tables were destroyed on edit.** Sanitizing a
  `<tbody data-cms-repeat>` flattened rows to bare text (table tags missing from the
  allowlist, and DOMPurify's string mode re-parsing the fragment outside table
  context). Container sanitizing now runs in place on the real node with a wider
  structural allowlist, and a structure-loss guard refuses to stage any edit that
  would flatten a block. Repeat controls are table-aware (the add button parks after
  the table, item controls anchor in the row's last cell).
- **Images inserted inline vanished on "Done".** DOMPurify's default URI allowlist
  stripped `blob:` preview URLs (and sandbox `data:image/…` URLs). Both are now
  explicitly allowed; committed HTML still swaps in the real repo path.

### Changed

- Relicensed from MIT to **GNU AGPL-3.0**: free for any use, including commercial and
  client work; running a modified version as a public network service requires
  sharing your changes.
- Documentation corrections across the README and setup docs.

### Security

- Tightened the commit-proxy allowlist in the `kiln-auth` worker.
- Fixed an attribute-edit XSS in the splice engine.
- Removed magic-link invites entirely. Access is authenticated-only: editors and
  members are added by email and sign in with Google. Added per-editor path scoping
  and default-on rate limiting for the sign-in routes.

## [0.2.0]

Initial public release.

### Added

- **HTML-as-database splice engine** — edits are spliced back into the page's
  own source at exact parse5 source offsets and committed to Git; hand-written
  formatting survives untouched.
- **GitHub App authentication** — per-repo install, 8-hour expiring tokens,
  refresh tokens held server-side in Workers KV.
- **Invited editors & members** — added by email and signed in with Google (no
  GitHub account); editor commits are proxied through the App installation token
  behind a strict, path-scoped allowlist.
- **Members area** — `/members/` pages and files gated at the edge by an
  HMAC-signed cookie, with a Google-verified people allowlist.
