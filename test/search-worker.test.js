// What the autocomplete worker offers has to match what the page shows: a
// suggestion is resolved by loading the page with it as the query, so anything
// the worker suggests that the page hides or cannot find is a dead suggestion.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { createWorker } from '../search_worker/src/index.js'
import { buildLinks } from '../search_worker/build-links.js'

const LINKS_JSON = {
  metadata: { version: '1.1' },
  links: [
    { category: 'WEATHER & TIME', links: [
      { title: 'AFW-WEBS (Air Force Weather-Web Services)', link: 'https://weather.af.mil', summary: 'Forecasts and observations', description: 'Operational weather products for flying units.' },
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

// A worker over the given links.json, as build-links.js would bundle it, plus
// a stand-in for the Cloudflare runtime that counts any network fetch
function environment(linksJson = LINKS_JSON) {
  const env = { fetches: 0, worker: createWorker(linksJson) }
  globalThis.fetch = async () => { env.fetches++; throw new Error('the worker should not fetch') }
  return env
}

async function suggest(term, env = environment()) {
  const res = await env.worker.fetch(new Request('https://worker.dev/search/' + encodeURIComponent(term)), env)
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

test('suggests unofficial links, labeled UNOFFICIAL', async () => {
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

test('suggests on the summary and description, as the page matches them', async () => {
  assert.deepEqual((await suggest('forecasts')).map(s => s.title), ['AFW-WEBS (Air Force Weather-Web Services)'])
  assert.deepEqual((await suggest('flying units')).map(s => s.title), ['AFW-WEBS (Air Force Weather-Web Services)'])
})

test('title matches come before url-only and category-only matches', async () => {
  const env = environment({ links: [{ category: 'OTHER', links: [
    { title: 'Somewhere Else', link: 'https://travel.mil' },
    { title: 'Travel Voucher', link: 'https://dts.mil' },
  ]}]})
  assert.deepEqual((await suggest('travel', env)).map(s => s.title), ['Travel Voucher', 'Somewhere Else'])
})

test('ranks like the page: title start before a later word before elsewhere', async () => {
  const env = environment({ links: [
    { category: 'FINANCE', links: [
      { title: 'Travel Pay Help', link: 'https://a.mil', description: 'Pay questions' },
      { title: 'BAH Calculator', link: 'https://b.mil', description: 'Pay rates by zip code' },
      { title: 'myPay', link: 'https://mypay.dfas.mil' },
    ]},
    { category: 'OTHER', links: [
      { title: 'Pay Tables', link: 'https://c.mil' },
    ]},
  ] })
  // "Pay Tables" starts with it (90), "Travel Pay Help" has it at a later
  // word (70), "myPay" inside a word (40), BAH only in its description (15),
  // whatever the page order
  assert.deepEqual((await suggest('pay', env)).map(s => s.title),
    ['Pay Tables', 'Travel Pay Help', 'myPay', 'BAH Calculator'])
})

test('caps the list a browser will never show all of', async () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ title: `Travel Form ${i}`, link: 'https://dts.mil' }))
  const env = environment({ links: [{ category: 'OTHER', links: many }] })
  assert.equal((await suggest('travel', env)).length, 20)
})

test('answers from the bundled links without fetching anything', async () => {
  const env = environment()
  await suggest('weather', env)
  await suggest('milsuite', env)
  assert.equal(env.fetches, 0)
})

test('tolerates a links.json from a build that predates unofficial links', async () => {
  const env = environment({ links: LINKS_JSON.links })
  assert.deepEqual((await suggest('militarycac', env)).map(s => s.title), [])
  assert.deepEqual((await suggest('weather', env)).map(s => s.title), ['AFW-WEBS (Air Force Weather-Web Services)'])
})

test('a request without a search term is a 400, anything else a 404', async () => {
  const env = environment()
  assert.equal((await env.worker.fetch(new Request('https://worker.dev/search'), env)).status, 400)
  assert.equal((await env.worker.fetch(new Request('https://worker.dev/search/'), env)).status, 400)
  assert.equal((await env.worker.fetch(new Request('https://worker.dev/'), env)).status, 404)
})

test('a term containing a slash is kept whole', async () => {
  const env = environment()
  const res = await env.worker.fetch(new Request('https://worker.dev/search/' + encodeURIComponent('owa / e-mail')), env)
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

// What Workers Builds bundles has to be what the site shows: build-links.js
// and updater.js assemble from src/links/ with the same module, and this holds
// them to it against the site the build really produced.
test('the bundled links are the links the site publishes', { skip: built ? false : 'site not built' }, async () => {
  const site = JSON.parse(fs.readFileSync(built, 'utf8'))
  const bundled = buildLinks({ today: site.metadata.generated.slice(0, 10) })
  const shape = data => ({
    links: data.links.map(c => ({ category: c.category, links: c.links.map(l =>
      ({ title: l.title, link: l.link, summary: l.summary, description: l.description, isDeleted: !!l.isDeleted })) })),
    unofficial: data.unofficial.map(l => ({ title: l.title, link: l.link, summary: l.summary, description: l.description })),
  })
  assert.deepEqual(shape(bundled), shape(site))
  assert.equal(bundled.metadata.numLinks, site.metadata.numLinks)
})
