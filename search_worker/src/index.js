// Address-bar autocomplete for aflink.us (OpenSearch suggestions).
//
// The browser asks this worker for suggestions while the user types in the
// address bar, then loads "aflink.us/?q=<suggestion>" when one is chosen. The
// suggestion is "<title>​ {CATEGORY}"; the page reads both halves back
// (src/includes/js/search.js) to pick the exact row and follow it.
//
// Because of that round trip this worker has to see the site the way the page
// does: same link list, same matching rules. Matching itself is imported from
// the page's own module so the two cannot drift; the list is assembled at
// build time by the same code as the site's (build-links.js) and bundled in.
// See search_worker/README.md before changing either.
import '../../src/includes/js/search-match.js'
import { handleSubmit, handleSubmission } from './submit.js'
import { handleMcp, handleServerCard } from './mcp.js'
// Written by build-links.js before every deploy (wrangler's build command)
import bundledLinks from './links.generated.js'

const { parseQuery, matchLink, UNOFFICIAL_CATEGORY } = globalThis.AflinkSearch

// Browsers show around ten suggestions; the rest is payload nobody reads.
const MAX_SUGGESTIONS = 20
// Zero-width space separating the title from the category in a suggestion
const HIDDEN_SPACE = '​'

// Flatten links.json into what the page effectively searches: every visible
// row, official categories first (page order), then the unofficial section.
function to_entries(linksData) {
  const official = (linksData.links || []).flatMap(category =>
    (category.links || [])
      // links.json keeps deleted links so the overrides page can show them;
      // the page hides them, so they must not be suggested either
      .filter(link => !link.isDeleted)
      .map(link => entry(link, category.category)))

  // Unofficial links are listed and searched on the page, so they belong in
  // suggestions too. Older builds of links.json predate the key.
  const unofficial = (linksData.unofficial || [])
    .map(link => entry(link, UNOFFICIAL_CATEGORY))

  return official.concat(unofficial)
}

// The page also searches each link's summary and description, so a
// suggestion can come from them too; both ride along from links.json
function entry(link, cat) {
  return { title: link.title, link: link.link, cat, summary: link.summary || '', description: link.description || '' }
}


// Same rules as the page: every word has to match the title, the URL or the
// category. Links that matched on their title come first — a suggestion list
// showing titles that do not contain what was typed reads as noise, even
// though the page would list those rows too.
function search(links, term, max = MAX_SUGGESTIONS) {
  const words = parseQuery(term)
  const titled = [], others = []

  for (const link of links) {
    const { matched, ranges } = matchLink({ title: link.title, url: link.link, category: link.cat, summary: link.summary, description: link.description }, words)
    if (!matched) continue
    const bucket = ranges.length ? titled : others
    bucket.push(link)
    if (titled.length >= max) break
  }

  return titled.concat(others).slice(0, max)
}

async function handleRequest(request, env, links) {
  try {
    const { pathname } = new URL(request.url);

    // Portal link submissions from getlinks.js; see submit.js
    if (pathname === "/submit") {
      return handleSubmit(request, env);
    }
    if (pathname.startsWith("/submission/")) {
      return handleSubmission(request, env, pathname.slice("/submission/".length));
    }

    // Public, read-only MCP server over the same links and matching; see mcp.js
    if (pathname === "/mcp") {
      return handleMcp(request, env, { search, links });
    }
    if (pathname === "/mcp/server-card") {
      return handleServerCard(request);
    }

    if (pathname.startsWith("/search")) {

      // Everything after "/search/" is the search term; it is kept whole so a
      // query containing a slash is not silently truncated
      const raw = pathname.startsWith("/search/") ? pathname.slice("/search/".length) : "";
      if (!raw) {
        return new Response("Missing search term", { status: 400 });
      }
      let term;
      try {
        term = decodeURIComponent(raw).toLowerCase();
      } catch (e) {
        return new Response("Malformed search term", { status: 400 });
      }

      const results = search(links, term)

      console.log('responding with results for ' + term)

      // Compose suggestions with a hidden space for the page javascript to parse
      let suggestions = results.map(result => `${result.title}${HIDDEN_SPACE} {${result.cat}}`)
      return new Response(JSON.stringify([term, suggestions]), {
        status: 200,
        headers: {
          "content-type": "application/json;charset=UTF-8",
        },
      });
    } else {
      return new Response("", {
        status: 404
      });
    }
  } catch(e) {
    console.log(e)
    return new Response(e.stack, { status: 500 })
  }
}

// A worker over a given links.json-shaped list; tests build their own
export function createWorker(linksData) {
  const links = to_entries(linksData)
  return {
    async fetch(request, env) {
      return handleRequest(request, env, links);
    },
  };
}

export default createWorker(bundledLinks);
