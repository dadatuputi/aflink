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
- **The link list** is assembled from `src/links/` by
  [`scripts/assemble-links.js`](../scripts/assemble-links.js), which both
  builds run: `updater.js` for the site and its `links.json`, and
  [`build-links.js`](build-links.js) for this worker, which bundles the result
  in the `links.json` shape. The worker rebuilds what the page displays from
  it: official categories in page order (skipping `isDeleted` links, which the
  page hides), then the `unofficial` list.

`npm test` in the repo root covers both — including checks that the
`links.json` the site build actually produces is what the worker reads, and
that the worker's bundle holds the same links.

## Deploys

Cloudflare Workers Builds deploys the worker on every push to `master` that
touches one of its watch paths, running `cd search_worker && npx wrangler
deploy`. Wrangler first runs the build command in
[`wrangler.jsonc`](wrangler.jsonc), `node build-links.js`, which writes
`src/links.generated.js` (gitignored) from that commit's `src/links/`. So the
deployed worker carries exactly the links the commit lists: nothing is
fetched at request time and nothing is cached.

That only works if a link-only change triggers a build, so the watch paths
(Workers & Pages → aflink-autocomplete → Settings → Build) must cover
everything the worker is built from:

```
search_worker/*
src/links/*
src/includes/js/search-match.js
scripts/assemble-links.js
scripts/link-status.js
```

A new file the worker or `build-links.js` imports goes on that list too.
Retirement is by date (`scripts/link-status.js`), so a link that retires
without any commit leaves the worker at the next link change; the weekly link
health commit bounds that to a week.

### Changes that need the worker updated

| Change on the site | What the worker needs |
| --- | --- |
| How search matches (normalizing, word splitting, what fields count) | Nothing, if the change is made in `search-match.js`; the worker imports it |
| A new field or source of links (another section, another JSON file) | Add it in `assemble-links.js` (both builds pick it up); `publishedLinks()`, `build-links.js`'s `slim()` and `to_entries()` must carry it, and a new file needs a watch path |
| A link becoming hidden on the page (a new flag like `isDeleted`) | `to_entries()` must filter it out too |
| Renaming or restructuring `links.json` | `to_entries()` reads the new shape |
| How the page resolves a chosen suggestion (`?q=` parsing) | The suggestion format here has to match it |

## Development

```sh
npm install          # in this directory
npm run dev          # serves the worker on :8787
npm run deploy       # wrangler deploy
```

A development build of the site (`npm run dev:build` in the repo root) points
its suggestions at `localhost:8787`, so the two can be exercised together.
`npm run dev` bundles the links from your working copy of `src/links/`, so a
local edit shows up when the worker restarts. `npm test` in the repo root
bundles them too (its `pretest` step).

## Portal link submissions (`POST /submit`)

The same worker receives link lists from [`getlinks.js`](../getlinks.js), run
in the browser console on any AF Portal page: the script fetches every list
the portal has and sends them together as `{ pages: [{ source,
afpCategorizedLinksDto }] }`. The worker starts the Portal Sync workflow
([`.github/workflows/portal_sync.yml`](../.github/workflows/portal_sync.yml)),
which merges the lists on the `portal-sync` branch and opens or updates one
pull request. Nothing reaches the site until that PR is merged.

The endpoint is public, so [`src/submit.js`](src/submit.js) is strict:

- Browser origin must be the AF Portal.
- Every page's `source` must be one of `KNOWN_SOURCES`, each at most once; a
  new portal list is added there and to `PAGES` in `getlinks.js`.
- Only `title`, `link`, `contentId` and a few known fields are kept, each
  checked for shape and length; the whole payload is capped at 512 KB.
- Per-address and daily rate limits, counted in the `LINKS` KV namespace; an
  identical payload within a day is acknowledged but not re-sent.
- The packed payload is kept in KV for a day and served at
  `GET /submission/<id>`; the workflow receives only the id, because
  `workflow_dispatch` inputs are capped at 64 KB and the lists with their
  descriptions are larger.
- On the workflow side, `scripts/af-guard.js` fails the run (and opens an
  issue) if a submission would move an existing link to a non-official domain.

It needs one secret, set with `wrangler secret put GITHUB_DISPATCH_TOKEN`: a
fine-grained GitHub token for the aflink repository only, with **Actions:
read and write** and nothing else. That is enough to start a workflow run and
not enough to push code. Give it an expiry and rotate it. Without the secret
the endpoint answers 503 and `getlinks.js` falls back to the compressed-data
box for the Update AF Links issue form.
