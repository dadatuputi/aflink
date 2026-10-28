// The /submit endpoint is public: these pin down what it refuses, what it
// strips, and that it only ever starts a workflow, never anything else.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import worker from '../search_worker/src/index.js'
import { sanitize, LIMITS } from '../search_worker/src/submit.js'
import { offendingChanges } from '../scripts/af-guard.js'

const SOURCE = 'index:manageApplications'
const ORIGIN = 'https://www.my.af.mil'
const link = (id, extra = {}) => ({ contentId: `c${id.padEnd(32, '0')}`, title: 'myPay', link: 'https://mypay.dfas.mil', ...extra })
const payload = (links = { PERSONNEL: [link('1')] }, source = SOURCE) => ({ source, afpCategorizedLinksDto: { links } })

// Cloudflare runtime stand-ins: KV as a Map, fetch capturing the dispatch
function environment({ token = 'tok', github = 204 } = {}) {
  const store = new Map()
  const env = {
    GITHUB_DISPATCH_TOKEN: token,
    dispatches: [],
    LINKS: {
      get: async (key, opts) => store.has(key) ? (opts?.type === 'json' ? JSON.parse(store.get(key)) : store.get(key)) : null,
      put: async (key, value) => { store.set(key, value) },
    },
  }
  globalThis.fetch = async (url, init) => {
    env.dispatches.push({ url: String(url), init })
    return new Response(null, { status: github })
  }
  return env
}

const post = (body, { env = environment(), origin = ORIGIN, ip = '203.0.113.5', method = 'POST' } = {}) =>
  worker.fetch(new Request('https://worker.dev/submit', {
    method,
    headers: { origin, 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  }), env)

test('a good submission starts exactly one workflow run with the packed payload', async () => {
  const env = environment()
  const res = await post(payload(), { env })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.count, 1)
  assert.equal(env.dispatches.length, 1)
  const d = env.dispatches[0]
  assert.match(d.url, /\/repos\/dadatuputi\/aflink\/actions\/workflows\/portal_sync\.yml\/dispatches$/)
  assert.equal(d.init.headers.authorization, 'Bearer tok')
  const sent = JSON.parse(d.init.body)
  assert.equal(sent.ref, 'master')
  assert.equal(sent.inputs.source, SOURCE)
  // the payload is gzip+base64 of the sanitized JSON, as the issue form sends it
  const unpacked = JSON.parse(await new Response(new Blob([Uint8Array.from(atob(sent.inputs.payload), c => c.charCodeAt(0))]).stream().pipeThrough(new DecompressionStream('gzip'))).text())
  assert.deepEqual(unpacked, { pages: [payload()] })
})

test('getlinks.js sends every list at once; each goes to the workflow in order', async () => {
  const env = environment()
  const home = 'quicklinks:p44C00E3C94DB4A210194DC84A9E10002'
  const res = await post({ pages: [payload(), payload({ 'Top 10 Searches': [link('1'), link('2')] }, home)] }, { env })
  assert.equal(res.status, 200)
  assert.equal((await res.json()).count, 3)
  const sent = JSON.parse(env.dispatches[0].init.body)
  assert.equal(sent.inputs.source, `${SOURCE},${home}`)
  // the same page twice, or an unknown one among known ones, is refused whole
  assert.equal((await post({ pages: [payload(), payload()] }, { env })).status, 400)
  assert.equal((await post({ pages: [payload(), payload(undefined, 'index:bases')] }, { env })).status, 400)
  assert.equal(env.dispatches.length, 1)
})

test('only the AF Portal origin may submit, and only by POST', async () => {
  assert.equal((await post(payload(), { origin: 'https://evil.example' })).status, 403)
  assert.equal((await post(payload(), { origin: '' })).status, 403)
  assert.equal((await post(null, { method: 'GET' })).status, 405)
  const preflight = await post(null, { method: 'OPTIONS' })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-origin'), ORIGIN)
})

test('without the token it declines rather than failing later', async () => {
  const env = environment({ token: '' })
  assert.equal((await post(payload(), { env })).status, 503)
  assert.equal(env.dispatches.length, 0)
})

test('rejects shapes the sync could not trust', async () => {
  const bad = [
    ['not json', 'nope'],
    ['unknown page', payload(undefined, 'index:somethingElse')],
    ['missing links', { source: SOURCE }],
    ['bad contentId', payload({ A: [link('1', { contentId: 'c123' })] })],
    ['duplicate contentId', payload({ A: [link('1'), link('1')] })],
    ['javascript url', payload({ A: [link('1', { link: 'javascript:alert(1)' })] })],
    ['empty title', payload({ A: [link('1', { title: '  ' })] })],
    ['no links', payload({ A: [] })],
  ]
  for (const [why, body] of bad) {
    const env = environment()
    const res = await post(body, { env })
    assert.equal(res.status, 400, why)
    assert.equal(env.dispatches.length, 0, why)
  }
})

test('sanitize keeps only the fields the sync reads', () => {
  const dirty = payload({ ' Personnel ': [link('1', { type: 'application', url: true, lastModified: '2026-01-02', description: ' Plans moves. ', abstract: '<b>x</b>', contactInfo: { phone: '555' }, isDeleted: true, sources: ['x'] })] })
  const { links } = sanitize(dirty).pages[0]
  assert.deepEqual(Object.keys(links[' Personnel '][0]).sort(), ['contentId', 'description', 'lastModified', 'link', 'title', 'type', 'url'])
  assert.equal(links[' Personnel '][0].description, 'Plans moves.')
  // markup in a description is dropped rather than published
  const html = payload({ A: [link('1', { description: 'see <a href=x>here</a>' })] })
  assert.equal(sanitize(html).pages[0].links.A[0].description, undefined)
})

test('rate limits per address and per day, and ignores an exact repeat', async () => {
  const env = environment()
  for (let i = 0; i < LIMITS.perIpPerHour; i++) {
    assert.equal((await post(payload({ A: [link(String(i))] }), { env })).status, 200)
  }
  assert.equal((await post(payload({ A: [link('99')] }), { env })).status, 429)
  // another address is still fine, but the same payload again does not re-dispatch
  const before = env.dispatches.length
  const repeat = await post(payload({ A: [link('0')] }), { env, ip: '198.51.100.9' })
  assert.equal(repeat.status, 200)
  assert.equal((await repeat.json()).repeated, true)
  assert.equal(env.dispatches.length, before)
})

test('a GitHub failure is reported, not swallowed', async () => {
  const env = environment({ github: 401 })
  const res = await post(payload(), { env })
  assert.equal(res.status, 502)
  assert.match((await res.json()).error, /issue form/)
})

test('the payload cap applies before parsing', async () => {
  const huge = JSON.stringify(payload({ A: [link('1', { title: 'x'.repeat(LIMITS.bodyBytes) })] }))
  assert.equal((await post(huge)).status, 413)
})

test('guard: an existing link may not move to a non-official domain', () => {
  const before = { afpCategorizedLinksDto: { links: { A: [link('1'), link('2', { link: 'https://www.ups.com/track' })] } } }
  const moved = { afpCategorizedLinksDto: { links: { A: [link('1', { link: 'https://mypay-login.example.com' }), link('2', { link: 'https://www.ups.com/other' }), link('3', { link: 'https://new.example.com' })] } } }
  const offending = offendingChanges(before, moved)
  assert.deepEqual(offending.map(o => o.host), ['mypay-login.example.com'])
  // a move between official hosts, or to an allowlisted one, is fine
  const allowed = JSON.parse(fs.readFileSync('src/links/links_trust_allow.json')).allowed[0].host
  const fine = { afpCategorizedLinksDto: { links: { A: [link('1', { link: 'https://mypay2.dfas.mil' }), link('2', { link: `https://${allowed}/x` })] } } }
  assert.deepEqual(offendingChanges(before, fine), [])
})
