// aflink as a Model Context Protocol (MCP) server: one read-only tool,
// `search_links`, that searches the same links the aflink.us page lists, with
// the same matching rules. Listed in the MCP Registry as
// us.aflink/search (see server.json in the repository root), served at
// https://mcp.aflink.us/mcp.
//
// Transport is Streamable HTTP (MCP spec 2025-11-25), served statelessly at
// POST /mcp: every request is answered with one JSON response, no session is
// kept, and the server never streams or calls back to the client. There is no
// authentication because there is nothing private here — the tool returns
// what https://aflink.us/links.json already publishes, and nothing it does can
// change the site.
//
// Implemented directly rather than with the MCP SDK: three methods and one
// tool do not justify a dependency in a worker that has none.
import '../../src/includes/js/search-match.js'

const { UNOFFICIAL_CATEGORY } = globalThis.AflinkSearch

export const SERVER_NAME = 'us.aflink/search'
// Keep in step with "version" in server.json (test/mcp-server.test.js checks)
export const SERVER_VERSION = '1.0.0'

// Newest first. A client asking for one of these gets it back; any other
// version is answered with the newest, and the client decides whether to go on.
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26']

const MAX_QUERY_LENGTH = 200
const DEFAULT_LIMIT = 10
const MAX_LIMIT = 50
const MAX_BODY_BYTES = 64 * 1024

const INSTRUCTIONS =
  'aflink (https://aflink.us) is an unofficial, public mirror of the U.S. Air Force portal quick links, ' +
  'plus community-submitted links and a clearly labeled unofficial section. Use search_links to find the ' +
  'URL for an Air Force or DoD website or tool by name, acronym or purpose. Results are links only: most ' +
  'official sites still require a CAC or other DoD login, which this server neither has nor needs.'

const SEARCH_TOOL = {
  name: 'search_links',
  title: 'Search AF links',
  description:
    'Search aflink.us for Air Force and DoD websites by name, acronym, URL, category or purpose ' +
    '(for example "mypay", "travel voucher", "leave"). Every word must match. Returns each link\'s ' +
    'title, URL and category, best matches (title matches) first. Links in the UNOFFICIAL category ' +
    'are third-party sites, not run by the Air Force.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Words to search for, as you would type them into the aflink.us search box.',
        minLength: 1,
        maxLength: MAX_QUERY_LENGTH,
      },
      limit: {
        type: 'integer',
        description: `Most results to return (default ${DEFAULT_LIMIT}, at most ${MAX_LIMIT}).`,
        minimum: 1,
        maximum: MAX_LIMIT,
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      results: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            url: { type: 'string' },
            category: { type: 'string' },
            official: { type: 'boolean', description: 'false for links in the UNOFFICIAL (third-party) section' },
            summary: { type: 'string' },
          },
          required: ['title', 'url', 'category', 'official'],
        },
      },
    },
    required: ['query', 'results'],
  },
  annotations: {
    title: 'Search AF links',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}

// JSON-RPC error codes
const PARSE_ERROR = -32700
const INVALID_REQUEST = -32600
const METHOD_NOT_FOUND = -32601
const INVALID_PARAMS = -32602

// Any web page may call this server: it is public, read-only and takes no
// credentials, so a cross-site request can learn nothing the page could not
// fetch from links.json itself. The Origin check the spec requires (against
// DNS rebinding, a risk to servers on localhost) therefore only turns away
// origins that are not real web origins, such as "null" from a sandboxed frame.
function originAllowed(origin) {
  if (origin == null) return true
  try {
    const { protocol } = new URL(origin)
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, GET, OPTIONS',
  'access-control-allow-headers': 'content-type, accept, mcp-protocol-version, mcp-session-id, last-event-id',
  'access-control-expose-headers': 'mcp-protocol-version',
  'access-control-max-age': '86400',
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...CORS },
  })
}

function rpcError(id, code, message, status = 200) {
  return json({ jsonrpc: '2.0', id, error: { code, message } }, status)
}

// `search(links, term, max)` and `loadLinks(env)` come from index.js, so the
// tool answers from exactly the list and ranking the address-bar suggestions use.
export async function handleMcp(request, env, { search, loadLinks }) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS })
  }
  if (!originAllowed(request.headers.get('origin'))) {
    return rpcError(null, INVALID_REQUEST, 'Origin not allowed', 403)
  }
  if (request.method !== 'POST') {
    // GET would open a server-to-client stream; this server never sends one
    return new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST, OPTIONS', ...CORS } })
  }

  const version = request.headers.get('mcp-protocol-version')
  if (version && !PROTOCOL_VERSIONS.includes(version)) {
    return rpcError(null, INVALID_REQUEST, `Unsupported MCP-Protocol-Version: ${version}`, 400)
  }

  let message
  try {
    const text = await request.text()
    if (text.length > MAX_BODY_BYTES) return rpcError(null, INVALID_REQUEST, 'Request too large', 413)
    message = JSON.parse(text)
  } catch {
    return rpcError(null, PARSE_ERROR, 'Parse error', 400)
  }
  // One message per POST (JSON-RPC batches were removed in 2025-06-18)
  if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0') {
    return rpcError(null, INVALID_REQUEST, 'Expected a single JSON-RPC 2.0 message', 400)
  }

  // Notifications (no id) and responses need no answer
  if (!('id' in message) || !('method' in message)) {
    return new Response(null, { status: 202, headers: CORS })
  }

  const { id, method, params = {} } = message
  switch (method) {
    case 'initialize': {
      const asked = params.protocolVersion
      return json({
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: {
            name: SERVER_NAME,
            title: 'aflink',
            version: SERVER_VERSION,
            websiteUrl: 'https://aflink.us',
          },
          instructions: INSTRUCTIONS,
        },
      })
    }
    case 'ping':
      return json({ jsonrpc: '2.0', id, result: {} })
    case 'tools/list':
      return json({ jsonrpc: '2.0', id, result: { tools: [SEARCH_TOOL] } })
    case 'tools/call':
      return callTool(id, params, env, { search, loadLinks })
    default:
      return rpcError(id, METHOD_NOT_FOUND, `Method not found: ${method}`)
  }
}

async function callTool(id, params, env, { search, loadLinks }) {
  if (params.name !== SEARCH_TOOL.name) {
    return rpcError(id, INVALID_PARAMS, `Unknown tool: ${params.name}`)
  }
  const args = params.arguments || {}

  // Bad arguments are a tool error, not a protocol error, so the model sees
  // the message and can correct itself
  const query = typeof args.query === 'string' ? args.query.trim() : ''
  if (!query || query.length > MAX_QUERY_LENGTH) {
    return toolError(id, `query must be 1 to ${MAX_QUERY_LENGTH} characters of text`)
  }
  let limit = DEFAULT_LIMIT
  if (args.limit !== undefined) {
    if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > MAX_LIMIT) {
      return toolError(id, `limit must be a whole number from 1 to ${MAX_LIMIT}`)
    }
    limit = args.limit
  }

  const links = await loadLinks(env)
  const results = search(links, query.toLowerCase(), limit).map(link => ({
    title: link.title,
    url: link.link,
    category: link.cat,
    official: link.cat !== UNOFFICIAL_CATEGORY,
    ...(link.summary ? { summary: link.summary } : {}),
  }))

  const text = results.length
    ? results.map(r => `${r.title} [${r.category}]\n${r.url}${r.summary ? '\n' + r.summary : ''}`).join('\n\n')
    : `No aflink.us links match "${query}". Try fewer or different words, or an acronym.`

  return json({
    jsonrpc: '2.0', id,
    result: {
      content: [{ type: 'text', text }],
      structuredContent: { query, results },
      isError: false,
    },
  })
}

function toolError(id, text) {
  return json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: true } })
}
