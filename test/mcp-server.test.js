// The MCP endpoint (POST /mcp on the search worker) answers from the same link
// list and matching rules as the page and the address-bar suggestions, so an
// agent finds what a person searching aflink.us would find.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { createWorker } from '../search_worker/src/index.js'
import { SERVER_NAME, SERVER_VERSION, PROTOCOL_VERSIONS, SERVER_CARD } from '../search_worker/src/mcp.js'

const LINKS_JSON = {
  links: [
    { category: 'WEATHER & TIME', links: [
      { title: 'AFW-WEBS (Air Force Weather-Web Services)', link: 'https://weather.af.mil', summary: 'Forecasts and observations' },
      { title: 'Retired Weather Tool', link: 'https://gone.af.mil', isDeleted: true },
    ]},
    { category: 'OTHER', links: [
      { title: 'milSuite', link: 'https://www.milsuite.mil' },
    ]},
  ],
  unofficial: [
    { title: 'MilitaryCAC (CAC setup and troubleshooting)', link: 'https://militarycac.com/' },
  ],
}

function environment(linksJson = LINKS_JSON) {
  return { worker: createWorker(linksJson) }
}

function post(body, { env = environment(), headers = {} } = {}) {
  return env.worker.fetch(new Request('https://worker.dev/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }), env)
}

async function rpc(method, params, opts) {
  const res = await post({ jsonrpc: '2.0', id: 1, method, params }, opts)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /^application\/json/)
  const body = await res.json()
  assert.equal(body.jsonrpc, '2.0')
  assert.equal(body.id, 1)
  return body
}

async function searchLinks(args, opts) {
  const { result } = await rpc('tools/call', { name: 'search_links', arguments: args }, opts)
  return result
}

test('initialize names the server and agrees on a protocol version', async () => {
  const { result } = await rpc('initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' },
  })
  assert.equal(result.protocolVersion, '2025-06-18')
  assert.equal(result.serverInfo.name, SERVER_NAME)
  assert.equal(result.serverInfo.version, SERVER_VERSION)
  assert.deepEqual(Object.keys(result.capabilities), ['tools'])
  assert.ok(result.instructions)

  // A version this server does not know is answered with its newest
  const { result: other } = await rpc('initialize', { protocolVersion: '1999-01-01', capabilities: {} })
  assert.equal(other.protocolVersion, PROTOCOL_VERSIONS[0])
})

test('lists exactly one tool, marked read-only', async () => {
  const { result } = await rpc('tools/list', {})
  assert.equal(result.tools.length, 1)
  const [tool] = result.tools
  assert.equal(tool.name, 'search_links')
  assert.deepEqual(tool.inputSchema.required, ['query'])
  assert.equal(tool.annotations.readOnlyHint, true)
  assert.equal(tool.annotations.destructiveHint, false)
})

test('search_links finds what the page finds, with the same rules', async () => {
  const result = await searchLinks({ query: 'air force weather' })
  assert.equal(result.isError, false)
  assert.deepEqual(result.structuredContent.results, [{
    title: 'AFW-WEBS (Air Force Weather-Web Services)', url: 'https://weather.af.mil',
    category: 'WEATHER & TIME', official: true, summary: 'Forecasts and observations',
  }])
  assert.match(result.content[0].text, /https:\/\/weather\.af\.mil/)

  // Normalized and multi-word, URL and summary matching come from search-match.js
  const titles = async q => (await searchLinks({ query: q })).structuredContent.results.map(r => r.title)
  assert.deepEqual(await titles('afw webs'), ['AFW-WEBS (Air Force Weather-Web Services)'])
  assert.deepEqual(await titles('milsuite.mil'), ['milSuite'])
  assert.deepEqual(await titles('forecasts'), ['AFW-WEBS (Air Force Weather-Web Services)'])
})

test('search_links hides deleted links and labels unofficial ones', async () => {
  assert.deepEqual((await searchLinks({ query: 'retired' })).structuredContent.results, [])

  const [cac] = (await searchLinks({ query: 'militarycac' })).structuredContent.results
  assert.equal(cac.category, 'UNOFFICIAL')
  assert.equal(cac.official, false)
})

test('search_links honors limit, and says so when nothing matches', async () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ title: `Travel Form ${i}`, link: 'https://dts.mil' }))
  const env = environment({ links: [{ category: 'OTHER', links: many }] })
  assert.equal((await searchLinks({ query: 'travel' }, { env })).structuredContent.results.length, 10)
  assert.equal((await searchLinks({ query: 'travel', limit: 3 }, { env })).structuredContent.results.length, 3)
  assert.equal((await searchLinks({ query: 'travel', limit: 50 }, { env })).structuredContent.results.length, 50)

  const none = await searchLinks({ query: 'nothing here' })
  assert.equal(none.isError, false)
  assert.deepEqual(none.structuredContent.results, [])
  assert.match(none.content[0].text, /No aflink\.us links match/)
})

test('bad tool arguments come back as tool errors the model can read', async () => {
  for (const args of [{}, { query: '   ' }, { query: 'x'.repeat(201) }, { query: 'a', limit: 0 }, { query: 'a', limit: 51 }, { query: 'a', limit: 2.5 }]) {
    const result = await searchLinks(args)
    assert.equal(result.isError, true, JSON.stringify(args))
    assert.ok(result.content[0].text)
  }
  const unknown = await rpc('tools/call', { name: 'delete_links', arguments: {} })
  assert.equal(unknown.error.code, -32602)
})

test('ping answers, and an unknown method is method-not-found', async () => {
  assert.deepEqual((await rpc('ping')).result, {})
  assert.equal((await rpc('resources/list', {})).error.code, -32601)
})

test('notifications are accepted with 202 and no body', async () => {
  const res = await post({ jsonrpc: '2.0', method: 'notifications/initialized' })
  assert.equal(res.status, 202)
  assert.equal(await res.text(), '')
})

test('rejects what the Streamable HTTP transport does not allow', async () => {
  assert.equal((await post('{not json')).status, 400)
  assert.equal((await post([{ jsonrpc: '2.0', id: 1, method: 'ping' }])).status, 400)
  assert.equal((await post({ id: 1, method: 'ping' })).status, 400)
  assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'ping' },
    { headers: { 'mcp-protocol-version': '1999-01-01' } })).status, 400)

  // No server-to-client stream is offered
  const env = environment()
  const get = await env.worker.fetch(new Request('https://worker.dev/mcp', { headers: { accept: 'text/event-stream' } }), env)
  assert.equal(get.status, 405)
})

test('any web origin may call it; a non-web origin is refused', async () => {
  const ok = await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { headers: { origin: 'https://example.com' } })
  assert.equal(ok.status, 200)
  assert.equal(ok.headers.get('access-control-allow-origin'), '*')

  const bad = await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { headers: { origin: 'null' } })
  assert.equal(bad.status, 403)

  const env = environment()
  const preflight = await env.worker.fetch(new Request('https://worker.dev/mcp', { method: 'OPTIONS' }), env)
  assert.equal(preflight.status, 204)
  assert.match(preflight.headers.get('access-control-allow-headers'), /mcp-protocol-version/)
})

// server.json is what the MCP Registry publishes; it has to describe this worker
test('server.json matches the server it registers', () => {
  const server = JSON.parse(fs.readFileSync(new URL('../server.json', import.meta.url)))
  assert.equal(server.name, SERVER_NAME)
  assert.equal(server.version, SERVER_VERSION)
  assert.ok(server.description.length <= 100, 'the Registry caps description at 100 characters')

  // The remote is the custom domain the worker's wrangler.jsonc attaches
  const wrangler = fs.readFileSync(new URL('../search_worker/wrangler.jsonc', import.meta.url), 'utf8')
  const domain = wrangler.match(/"pattern":\s*"([^"]+)",\s*"custom_domain":\s*true/)[1]
  assert.deepEqual(server.remotes, [{ type: 'streamable-http', url: `https://${domain}/mcp` }])
  // ...on the domain the name claims, which is what the Registry verifies
  const [namespace] = server.name.split('/')
  const apex = namespace.split('.').reverse().join('.')
  assert.ok(domain === apex || domain.endsWith('.' + apex), `${domain} is not under ${apex}`)
  assert.equal(server.websiteUrl, `https://${apex}`)

  // One host for everything the worker serves: suggestions, submissions, MCP
  const updater = fs.readFileSync(new URL('../updater.js', import.meta.url), 'utf8')
  assert.equal(new URL(updater.match(/suggestedURL: "(https:[^"]+)"/)[1].replace('{searchTerms}', 'x')).host, domain)
  const getlinks = fs.readFileSync(new URL('../getlinks.js', import.meta.url), 'utf8')
  assert.equal(new URL(getlinks.match(/const SUBMIT_URL = '([^']+)'/)[1]).host, domain)
  const sync = fs.readFileSync(new URL('../.github/workflows/portal_sync.yml', import.meta.url), 'utf8')
  assert.equal(new URL(sync.match(/WORKER: (\S+)/)[1]).host, domain)
})

// The Registry checks https://aflink.us/.well-known/mcp-registry-auth for the
// public key that signs the publish; Jekyll and the Pages upload skip
// dot-folders unless told, so the build has to carry it through.
const proof = new URL('../src/.well-known/mcp-registry-auth', import.meta.url)

test('the registry proof file is a well-formed MCP key record', { skip: fs.existsSync(proof) ? false : 'no key yet' }, () => {
  const record = fs.readFileSync(proof, 'utf8').trim()
  const m = record.match(/^v=MCPv1; k=ed25519; p=([A-Za-z0-9+/]+=*)$/)
  assert.ok(m, `unexpected record: ${record}`)
  assert.equal(Buffer.from(m[1], 'base64').length, 32, 'an Ed25519 public key is 32 bytes')
})

test('the site build serves /.well-known/', () => {
  const config = fs.readFileSync(new URL('../src/_config.yml', import.meta.url), 'utf8')
  assert.match(config, /include:\s*\n\s*-\s*\.well-known/)
  const build = fs.readFileSync(new URL('../.github/workflows/build.yml', import.meta.url), 'utf8')
  assert.equal((build.match(/include-hidden-files: true/g) || []).length, 2,
    'both the docs artifact and the Pages artifact must keep hidden files')
  const site = ['_site', 'docs'].map(d => new URL(`../${d}/`, import.meta.url)).find(u => fs.existsSync(u))
  if (site && fs.existsSync(proof)) {
    assert.equal(fs.readFileSync(new URL('.well-known/mcp-registry-auth', site), 'utf8'), fs.readFileSync(proof, 'utf8'))
  }
})

// Discovery (MCP Server Cards, SEP-2127): aflink.us/.well-known/ai-catalog.json
// points at the card the worker serves at /mcp/server-card
function getCard({ method = 'GET', headers = {} } = {}) {
  const env = environment()
  return env.worker.fetch(new Request('https://worker.dev/mcp/server-card', { method, headers }), env)
}

test('the server card says what server.json says', () => {
  const server = JSON.parse(fs.readFileSync(new URL('../server.json', import.meta.url)))
  for (const key of ['name', 'version', 'title', 'description', 'websiteUrl', 'repository']) {
    assert.deepEqual(SERVER_CARD[key], server[key], key)
  }
  assert.equal(SERVER_CARD.$schema, 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json')
  assert.ok(SERVER_CARD.description.length <= 100)
  assert.deepEqual(SERVER_CARD.remotes, server.remotes.map(r => ({ ...r, supportedProtocolVersions: PROTOCOL_VERSIONS })))
})

test('the server card is served with its media type, CORS and caching', async () => {
  const res = await getCard({ headers: { accept: 'application/mcp-server-card+json' } })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'application/mcp-server-card+json')
  assert.equal(res.headers.get('access-control-allow-origin'), '*')
  assert.match(res.headers.get('access-control-expose-headers'), /ETag/)
  assert.equal(res.headers.get('cache-control'), 'public, max-age=3600')
  assert.deepEqual(await res.json(), SERVER_CARD)

  const etag = res.headers.get('etag')
  assert.match(etag, /^"[0-9a-f]+"$/)
  const again = await getCard({ headers: { 'if-none-match': etag } })
  assert.equal(again.status, 304)
  assert.equal(await again.text(), '')
  assert.equal((await getCard({ headers: { 'if-none-match': '"other"' } })).status, 200)

  assert.equal((await getCard({ method: 'OPTIONS' })).status, 204)
  assert.equal((await getCard({ method: 'POST' })).status, 405)
})

test('the AI catalog lists the server card', () => {
  const catalog = JSON.parse(fs.readFileSync(new URL('../src/.well-known/ai-catalog.json', import.meta.url)))
  const [namespace, name] = SERVER_NAME.split('/')
  const apex = namespace.split('.').reverse().join('.')
  assert.deepEqual(catalog.entries, [{
    identifier: `urn:air:${apex}:mcp:${name}`,
    type: 'application/mcp-server-card+json',
    url: SERVER_CARD.remotes[0].url + '/server-card',
  }])
  const site = ['_site', 'docs'].map(d => new URL(`../${d}/`, import.meta.url)).find(u => fs.existsSync(u))
  if (site) {
    assert.deepEqual(JSON.parse(fs.readFileSync(new URL('.well-known/ai-catalog.json', site))), catalog)
  }
})
