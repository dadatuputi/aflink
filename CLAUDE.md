# aflink

Static mirror of the USAF portal quick links, built with pug + node
(`updater.js`) and published to GitHub Pages by `.github/workflows/build.yml`.
Link data lives in `src/links/*.json` and is edited by the issue-driven
workflows in `.github/workflows/`, not by hand.

## Layout

- `updater.js` — the build: applies overrides, renders every page, writes
  `links.json`
- `src/index.pug`, `src/includes/` — the site; JS and CSS under
  `src/includes/js|css` are inlined into the page by `src/includes/foot.pug`
  and `head.pug` (minified in production), so they are plain scripts, not
  modules
- `src/links/` — link data: `links_af.json` (portal sync), `links_other.json`
  (community `OTHER` links), `links_unofficial.json` (third-party),
  `links_override.json` (corrections and deletions, matched by `contentId`)
- `search_worker/` — the Cloudflare Worker behind address-bar autocomplete
- `test/` — `npm test` (node's test runner, no dependencies)

## Search is two implementations of one behaviour

The page filters links client-side; the search worker answers the browser's
address-bar suggestion requests. A suggestion is resolved by loading the page
with it as the query, so **the worker must see the site the way the page
does** — same visible links, same matching rules. When they drift, suggestions
appear for links the page cannot find, or point at the wrong row.

Two seams hold them together:

- `src/includes/js/search-match.js` — the matching rules, shared: the page
  inlines it, the worker imports it. Change matching **here**, never in one
  copy.
- `links.json`, written by `updater.js` — the worker's only view of the site.
  Anything the page shows has to be derivable from it, including the
  `unofficial` list and the `isDeleted` flag the page filters on.

So: **a change to what the page lists or how it searches is not finished until
the worker matches it.** `search_worker/README.md` has the specifics and a
table of which changes need what; `npm test` checks both ends, including the
`links.json` the build really produces.

## Working here

- `npm run dev:build` builds into `_site/`; `npm run dev:serve` also serves it
  on :4000. `npm test` runs the search tests (build first — one test reads
  `_site/links.json`).
- Don't hand-edit `docs/` or `_site/`; both are build output and gitignored.
- `src/analytics.json` is written by the nightly analytics workflow.
