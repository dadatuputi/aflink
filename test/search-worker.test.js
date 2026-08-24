// What the autocomplete worker offers has to match what the page shows: a
// suggestion is resolved by loading the page with it as the query, so anything
// the worker suggests that the page hides or cannot find is a dead suggestion.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import worker from '../search_worker/src/index.js'

const LINKS_JSON = {
  metadata: { version: '1.1' },
  links: [
    { category: 'WEATHER & TIME', links: [
      { title: 'AFW-WEBS (Air Force Weather-Web Services)', link: 'https://weather.af.mil' },
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

// Minimal stand-ins for the Cloudflare runtime the worker is given
function environment(linksJson = LINKS_JSON) {
  const store = new Map()
  const env = {
    fetches: 0,
    LINKS: {
      get: async (key) => (store.has(key) ? JSON.parse(store.get(key)) : null),
      put: async (key, value) => { store.set(key, value) },
    },
  }
  globalThis.fetch = async () => { env.fetches++; return new Response(JSON.stringify(linksJson)) }
  return env
}

async function suggest(term, env = environment()) {
  const res = await worker.fetch(new Request('https://worker.dev/search/' + encodeURIComponent(term)), env)
  assert.equal(res.status, 200)
  const [echoed, suggestions] = await res.json()
  assert.equal(echoed, term.toLowerCase())
  // "<title>​ {CATEGORY}" — the page parses both halves back out
  return suggestions.map(s => {
    const m = s.match(/^(.*)​ \{(.*)\}$/)
    assert.ok(m, `unexpected suggestion format: ${JSON.stringify(s)}`)
    return { title: m[1], category: m[2] }
  })
}

test('suggests matching links with their category', async () => {
  assert.deepEqual(await suggest('weather'), [
    { title: 'AFW-WEBS (Air Force Weather-Web Services)', category: 'WEATHER & TIME' },
  ])
})

test('never suggests a deleted link', async () => {
  // links.json still carries it; the page hides it, so suggestions must too
  const titles = (await suggest('retired')).map(s => s.title)
  assert.deepEqual(titles, [])
})

test('suggests unofficial links, labelled UNOFFICIAL', async () => {
  assert.deepEqual(await suggest('militarycac'), [
    { title: 'MilitaryCAC (CAC setup and troubleshooting)', category: 'UNOFFICIAL' },
  ])
  assert.deepEqual((await suggest('unofficial')).map(s => s.title),
    ['MilitaryCAC (CAC setup and troubleshooting)'])
})

test('matches the way the page does: normalized, multi-word, url and category', async () => {
  assert.deepEqual((await suggest('air force weather')).map(s => s.title), ['AFW-WEBS (Air Force Weather-Web Services)'])
  assert.deepEqual((await suggest('afw webs')).map(s => s.title), ['AFW-WEBS (Air Force Weather-Web Services)'])
  assert.deepEqual((await suggest('milsuite.mil')).map(s => s.title), ['milSuite'])
  assert.deepEqual((await suggest('weather & time')).map(s => s.title), ['AFW-WEBS (Air Force Weather-Web Services)'])
  assert.deepEqual((await suggest('nothing here')).map(s => s.title), [])
})

test('title matches come before url-only and category-only matches', async () => {
  const env = environment({ links: [{ category: 'OTHER', links: [
    { title: 'Somewhere Else', link: 'https://travel.mil' },
    { title: 'Travel Voucher', link: 'https://dts.mil' },
  ]}]})
  assert.deepEqual((await suggest('travel', env)).map(s => s.title), ['Travel Voucher', 'Somewhere Else'])
})

test('caps the list a browser will never show all of', async () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ title: `Travel Form ${i}`, link: 'https://dts.mil' }))
  const env = environment({ links: [{ category: 'OTHER', links: many }] })
  assert.equal((await suggest('travel', env)).length, 20)
})

test('links.json is fetched once and then served from KV', async () => {
  const env = environment()
  await suggest('weather', env)
  await suggest('milsuite', env)
  assert.equal(env.fetches, 1)
})

test('tolerates a links.json from a build that predates unofficial links', async () => {
  const env = environment({ links: LINKS_JSON.links })
  assert.deepEqual((await suggest('militarycac', env)).map(s => s.title), [])
  assert.deepEqual((await suggest('weather', env)).map(s => s.title), ['AFW-WEBS (Air Force Weather-Web Services)'])
})

test('a request without a search term is a 400, anything else a 404', async () => {
  const env = environment()
  assert.equal((await worker.fetch(new Request('https://worker.dev/search'), env)).status, 400)
  assert.equal((await worker.fetch(new Request('https://worker.dev/search/'), env)).status, 400)
  assert.equal((await worker.fetch(new Request('https://worker.dev/'), env)).status, 404)
})

test('a term containing a slash is kept whole', async () => {
  const env = environment()
  const res = await worker.fetch(new Request('https://worker.dev/search/' + encodeURIComponent('owa / e-mail')), env)
  const [term] = await res.json()
  assert.equal(term, 'owa / e-mail')
})

// The build's own output, when it is there: this is the contract between
// updater.js and the worker, and it is what CI actually exercises.
const built = ['_site/links.json', 'docs/links.json']
  .map(p => path.resolve(process.cwd(), p)).find(p => fs.existsSync(p))

test('the published links.json is shaped the way the worker reads it', { skip: built ? false : 'site not built' }, async () => {
  const data = JSON.parse(fs.readFileSync(built, 'utf8'))
  const env = environment(data)

  const visible = data.links.flatMap(c => c.links.filter(l => !l.isDeleted))
  const deleted = data.links.flatMap(c => c.links.filter(l => l.isDeleted))
  assert.ok(visible.length > 0, 'expected some links')
  assert.equal(data.unofficial.length, data.metadata.numUnofficial)

  // every visible link is suggestible by its own exact title...
  for (const link of visible.slice(0, 25).concat(data.unofficial)) {
    const titles = (await suggest(link.title, env)).map(s => s.title)
    assert.ok(titles.includes(link.title), `no suggestion for ${link.title}`)
  }
  // ...and no deleted one is, under any of its own words
  for (const link of deleted) {
    const titles = (await suggest(link.title, env)).map(s => s.title)
    assert.ok(!titles.includes(link.title), `deleted link suggested: ${link.title}`)
  }
})
