// Address-bar autocomplete for aflink.us (OpenSearch suggestions).
//
// The browser asks this worker for suggestions while the user types in the
// address bar, then loads "aflink.us/?q=<suggestion>" when one is chosen. The
// suggestion is "<title>​ {CATEGORY}"; the page reads both halves back
// (src/includes/js/search.js) to pick the exact row and follow it.
//
// Because of that round trip this worker has to see the site the way the page
// does: same link list, same matching rules. Matching itself is imported from
// the page's own module so the two cannot drift; the list is rebuilt from
// links.json here. See search_worker/README.md before changing either.
import '../../src/includes/js/search-match.js'

const { parseQuery, matchLink, UNOFFICIAL_CATEGORY } = globalThis.AflinkSearch

// Bump when the cached entry shape changes: a deploy would otherwise keep
// reading entries written by the previous version until the TTL expires.
const LINKS_KEY = 'links-v2'
const LINKS_URL = 'https://aflink.us/links.json'
const LINKS_TTL = 60 * 60     // 1 hour
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
      .map(link => ({ title: link.title, link: link.link, cat: category.category })))

  // Unofficial links are listed and searched on the page, so they belong in
  // suggestions too. Older builds of links.json predate the key.
  const unofficial = (linksData.unofficial || [])
    .map(link => ({ title: link.title, link: link.link, cat: UNOFFICIAL_CATEGORY }))

  return official.concat(unofficial)
}

async function update_links(env) {
  console.log('updating links')
  const links_cf = { cf: { cacheTtl: LINKS_TTL }}

  // Fetch the pre-processed links.json
  const response = await fetch(env.LINKS_URL || LINKS_URL, links_cf)
  try {
    const linksData = await response.json()
    const links = to_entries(linksData)

    console.log(`Loaded ${links.length} links from ${(linksData.links || []).length} categories`)

    await env.LINKS.put(LINKS_KEY, JSON.stringify(links), {expirationTtl: LINKS_TTL})
    return links

  } catch (e) {
    console.error('Failed to parse links.json:', e)
    throw new Error('Failed to fetch links.')
  }
}

// Same rules as the page: every word has to match the title, the URL or the
// category. Links that matched on their title come first — a suggestion list
// showing titles that do not contain what was typed reads as noise, even
// though the page would list those rows too.
function search(links, term) {
  const words = parseQuery(term)
  const titled = [], others = []

  for (const link of links) {
    const { matched, ranges } = matchLink({ title: link.title, url: link.link, category: link.cat }, words)
    if (!matched) continue
    const bucket = ranges.length ? titled : others
    bucket.push(link)
    if (titled.length >= MAX_SUGGESTIONS) break
  }

  return titled.concat(others).slice(0, MAX_SUGGESTIONS)
}

async function handleRequest(request, env) {
  try {
    const { pathname } = new URL(request.url);

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

      let links = await env.LINKS.get(LINKS_KEY, { type: "json" }) || await update_links(env);

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

export default {
  async fetch(
    request,
    env
  ) {
    return handleRequest(request, env);
  },
};
