# Search worker

Cloudflare Worker behind the address-bar autocomplete (OpenSearch suggestions)
for [aflink.us](https://aflink.us), and aflink's public, read-only
[MCP server](#mcp-server-post-mcp). Deployed as `aflink-autocomplete` and
served at `https://api.aflink.us`; the site points at it through `suggestedURL` in [`updater.js`](../updater.js), which the
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

## MCP server (`POST /mcp`)

The same worker is a [Model Context Protocol](https://modelcontextprotocol.io)
server, so an AI agent can look up an Air Force or DoD site the way a person
does on aflink.us. It is listed in the
[MCP Registry](https://registry.modelcontextprotocol.io) as
`us.aflink/search`. The Registry verifies that name against the aflink.us
domain itself (see below), and the endpoint is on the same domain, so the
listing, the site and the server are visibly one publisher.

- **Endpoint:** `https://api.aflink.us/mcp` (`api.aflink.us` is a Cloudflare
  custom domain on this worker, declared in [`wrangler.jsonc`](wrangler.jsonc),
  that also serves the suggestions and submissions),
  Streamable HTTP transport (MCP spec 2025-11-25; 2025-06-18 and 2025-03-26
  clients are also accepted).
- **One tool, `search_links`:** takes a `query` (and an optional `limit`, 1–50,
  default 10) and returns matching links with title, URL, category and
  summary, title matches first. Links in the `UNOFFICIAL` category come back
  with `official: false`.
- **Read-only:** the tool reads the published `links.json` and nothing else.
  It cannot add, change or request links; that still goes through the issue
  forms and their review.
- **No authentication:** it serves only what `https://aflink.us/links.json`
  already publishes. No login, no API key, no cookies, and the worker stores
  nothing about the caller.
- **Same answers as the site:** it uses the list and ranking the suggestions
  use (`to_entries()` and `search()` in [`src/index.js`](src/index.js)) and the
  page's own matching rules in
  [`search-match.js`](../src/includes/js/search-match.js), so the parity rules
  above cover it too.

It is stateless: each POST gets one JSON response, no session is kept, and
`GET /mcp` is `405` because the server never sends anything unprompted. Any
web origin may call it (CORS `*`), since there is nothing private to protect;
an `Origin` that is not an `http(s)` origin is refused, as the transport spec
asks. The code is [`src/mcp.js`](src/mcp.js) with no SDK dependency, and
[`test/mcp-server.test.js`](../test/mcp-server.test.js) covers the protocol,
the tool and `server.json`.

To try it:

```sh
claude mcp add --transport http aflink https://api.aflink.us/mcp
# or, with the MCP Inspector
npx @modelcontextprotocol/inspector   # transport "Streamable HTTP", the URL above
```

### Publishing to the MCP Registry

[`server.json`](../server.json) in the repository root is the Registry entry.
[`.github/workflows/mcp_publish.yml`](../.github/workflows/mcp_publish.yml)
publishes it, run by hand from the Actions tab:

1. Merge the change to `master`. Cloudflare Workers Builds deploys the worker
   on every push to `master` that touches `search_worker/`, and GitHub Pages
   rebuilds the site; wait for both.
2. Run **Publish MCP server**. It runs the MCP tests, checks that
   `https://api.aflink.us/mcp` answers `initialize` as `us.aflink/search` at
   the version in `server.json` and that aflink.us serves the public key, then
   logs in and publishes.

**How the Registry knows aflink.us is ours.** The `us.aflink/*` namespace is
proven over HTTP: [`src/.well-known/mcp-registry-auth`](../src/.well-known/)
holds an Ed25519 public key (`v=MCPv1; k=ed25519; p=…`), served at
`https://aflink.us/.well-known/mcp-registry-auth`, and the workflow signs its
login with the matching private key. Jekyll and the Pages upload skip
dot-folders, so [`src/_config.yml`](../src/_config.yml) includes it and
`build.yml` uploads hidden files; a test checks both. The private key is the
`MCP_REGISTRY_KEY` secret of the `mcp-registry-publish` environment, limited
to `master`, because it can publish anything under `us.aflink/*`. To rotate
it, generate a new pair, replace the file and the secret, and let Pages
rebuild before publishing.

**The custom domain.** `api.aflink.us` was attached once in the dashboard:
adding a domain needs zone permission the Workers Builds token does not have,
while a deploy that leaves an existing domain as it is needs none.
`wrangler.jsonc` lists it so deploys keep it, and sets `workers_dev: true`,
because a config with routes otherwise turns the workers.dev URL off. The site
and `getlinks.js` now use `api.aflink.us`; the workers.dev URL stays on only
for a month while traffic moves over, and is to be turned off
(`workers_dev: false`) after 2026-12-07.

For a new listing, bump `version` in `server.json` and `SERVER_VERSION` in
`src/mcp.js` together (a test checks they agree), merge, let the worker
build finish, and run the workflow again. The Registry refuses a version it already has.

## Development

```sh
npm install          # in this directory
npm run dev          # serves the worker on :8787
npm run deploy       # wrangler deploy (by hand; normally Workers Builds deploys on push to master)
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
