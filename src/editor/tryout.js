/**
 * Try-out mode (`sandbox: true` in kiln-config.js): the public demo, where
 * every visitor edits a private copy that is kept in their own browser.
 *
 * What the demo says where something cannot act without a real site. One
 * shape for all of them ("Nothing is … in the demo. On a real site, ….") so
 * that no menu item answers with an error, or with nothing.
 *
 * Pure, so it is tested in node.
 */

const REAL = {
  preview: ['Nothing is shared in the demo', 'your edits are saved as a draft and you get a link that shows the page with them, before anything is published'],
  schedule: ['Nothing is scheduled in the demo', 'you pick a time and Kiln publishes these edits for you then'],
  suggestions: ['Nothing here in the demo', 'changes from people who may only suggest wait here for the owner to approve'],
  newpage: ['Nothing is created in the demo', 'this makes a new page from the site’s own template and puts it live in about a minute'],
  pagesettings: ['Nothing is saved in the demo', 'this changes the title and description that search results and link previews show'],
  menu: ['Nothing is saved in the demo', 'this changes the menu on every page at once'],
  findreplace: ['Nothing is replaced in the demo', 'this finds the words on every page and replaces them in one go'],
  people: ['Nobody is added in the demo', 'the people you add here sign in with Google and edit only what you let them'],
  ai: ['Nothing here in the demo', 'this rewrites, shortens or translates the text you are editing, using the site owner’s own AI key'],
  alt: ['Nothing here in the demo', 'this writes the picture’s description for you, using the site owner’s own AI key'],
  theme: ['Nothing is saved in the demo', 'Apply puts these colours and sizes on every page'],
  blocks: ['Nothing to add in the demo', 'this lists the ready-made sections the site’s owner has approved'],
};

/** What the demo says in place of `what` (a key of the list above). */
export function demoSays(what) {
  const [here, there] = REAL[what];
  return `${here}. On a real site, ${there}.`;
}

/** Every item the demo has a sentence for (for the test that reads them all). */
export const DEMO_ITEMS = Object.keys(REAL);

// What the demo's own Save as draft says.
export const DEMO_DRAFT_SAVED = 'Draft saved in this browser. Nothing is published, and this page will offer it back when you open it again.';
