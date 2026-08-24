# Search worker

Cloudflare Worker behind the address-bar autocomplete (OpenSearch suggestions)
for [aflink.us](https://aflink.us). Deployed as `aflink-autocomplete`; the site
points at it through `suggestedURL` in [`updater.js`](../updater.js), which the
browser discovers via [`osdd.xml`](../src/osdd.xml.pug).

## How a suggestion round trips

1. The browser calls `GET /search/{searchTerms}` while the user types.
2. The worker answers `["<term>", ["<title>​ {CATEGORY}", ...]]` — the
   title, a zero-width space, then the category.
3. Picking one loads `aflink.us/?q=<that whole string>`.
4. The page ([`src/includes/js/search.js`](../src/includes/js/search.js)) sees
   the zero-width space, searches on the title, finds the row whose title *and*
   category match the suggestion, and follows it.

So a suggestion is only useful if the page can find the same link. **Anything
the worker offers that the page hides, or matches differently, is a dead
suggestion** — the user picks it and lands somewhere else, or nowhere.

## Staying in sync with the site

Two things keep the two ends together, and both are load-bearing:

- **Matching rules** live in
  [`src/includes/js/search-match.js`](../src/includes/js/search-match.js).
  The page inlines that file; this worker imports it. There is one
  implementation, so normalization, multi-word matching and title/URL/category
  matching cannot drift. Change matching there and both ends move together.
- **The link list** comes from `links.json`, written by `updater.js` on every
  build. The worker rebuilds what the page displays from it: official
  categories in page order (skipping `isDeleted` links, which the page hides),
  then the `unofficial` list.

`npm test` in the repo root covers both — including a check that the
`links.json` the build actually produces still matches what the worker reads.

### Changes that need the worker updated

| Change on the site | What the worker needs |
| --- | --- |
| How search matches (normalizing, word splitting, what fields count) | Nothing, if the change is made in `search-match.js`; the worker imports it |
| A new field or source of links (another section, another JSON file) | `updater.js` must publish it in `links.json`, and `to_entries()` must include it |
| A link becoming hidden on the page (a new flag like `isDeleted`) | `to_entries()` must filter it out too |
| Renaming or restructuring `links.json` | `to_entries()` reads the new shape; bump `LINKS_KEY` so cached entries from the old shape are not reused |
| How the page resolves a chosen suggestion (`?q=` parsing) | The suggestion format here has to match it |

## Development

```sh
npm install          # in this directory
npm run dev          # serves the worker on :8787
npm run deploy       # wrangler deploy
```

A development build of the site (`npm run dev:build` in the repo root) points
its suggestions at `localhost:8787`, so the two can be exercised together. The
worker reads the live `https://aflink.us/links.json` unless `LINKS_URL` says
otherwise — to test against a local build, put this in `.dev.vars`:

```
LINKS_URL = "http://localhost:4000/links.json"
```

Fetched link data is cached in KV under `LINKS_KEY` for an hour, so a change to
`links.json` shows up in suggestions within an hour of the site rebuilding.
