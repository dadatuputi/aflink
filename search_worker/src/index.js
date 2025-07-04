const LINKS_KEY = 'linkydink'

async function update_links(env) {
  console.log('updating links')
  const links_ttl = 60*60     // 1 hour
  const links_cf = { cf: { cacheTtl: links_ttl }}

  // Fetch the pre-processed links.json
  const response = await fetch('https://aflink.us/links.json', links_cf)
  try {
    const linksData = await response.json()

    // Convert to the format expected by the search logic
    const links = linksData.links.flatMap(category => 
      category.links.map(link => ({
        title: link.title,
        link: link.link,
        cat: category.category
      }))
    )

    console.log(`Loaded ${links.length} links from ${linksData.links.length} categories`)

    await env.LINKS.put(LINKS_KEY, JSON.stringify(links), {expirationTtl: links_ttl})
    return links

  } catch (e) {
    console.error('Failed to parse links.json:', e)
    throw new Error('Failed to fetch links.')
  }
}

async function handleRequest(request, env) {
  try {
    const { pathname } = new URL(request.url);

    if (pathname.startsWith("/search")) {

      const pathParts = pathname.split("/");
      // Check search term is provided - /search/{searchTerms}"
      if (pathParts.length < 3 || !pathParts[2]) {
        return new Response("Missing search term", { status: 400 });
      }
      const term = decodeURIComponent(pathParts[2]).toLowerCase();

      let links = await env.LINKS.get(LINKS_KEY, { type: "json" }) || await update_links(env);

      let results = links.filter(link => link.title.toLowerCase().includes(term))

      console.log('responding with results for ' + term)

      // Compose suggestions with a hidden space for the page javascript to parse
      let suggestions = results.map(result => `${result.title}​ {${result.cat}}`)
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
