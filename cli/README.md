# create-kiln

The setup tool for [Kiln](https://kilncms.com), a click-to-edit CMS for static
sites: your pages are plain HTML in your own GitHub repository, people you
invite edit them in the browser, and every edit is a git commit.

Run it in your site's folder:

```bash
npx create-kiln              # set Kiln up for the site in this folder
npx create-kiln --help       # every command, and the options each one takes
```

| Command | What it does |
|---|---|
| (none) | Asks how you want to run Kiln, copies the editor into the site, adds it to your pages, offers to commit |
| `doctor` | Checks a set-up site and says what is wrong |
| `update` | Copies the current editor into the site |
| `tag` | Marks headings, text and images editable, as a first pass (`--dry` to preview) |
| `add-site` | Adds the site to Kiln Cloud |
| `new [dir]` | Starts a new site from a template |
| `rescue <url>` | Copies a site out of a website builder into plain HTML |

Needs Node 20 or newer and git. Guides, self-hosting and the source:
<https://github.com/kilncms/kiln>.

Licence: AGPL-3.0-only.
