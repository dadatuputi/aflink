// Links that open only from a government network. The portal and community
// titles say so in many spellings; the build turns any of them into one
// milOnly flag, strips the marker from the title, and lets a hand-set value
// in links_descriptions.json overrule it. The page and the worker both read
// the flag, so it has to reach links.json and the search rules.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { milOnlyMarker, assembleLinks, publishedLinks } from '../scripts/assemble-links.js'
import '../src/includes/js/search-match.js'
import { createWorker } from '../search_worker/src/index.js'

const { matchLink, parseQuery } = globalThis.AflinkSearch

test('every title spelling of .mil only is recognized and stripped', () => {
  const cases = {
    'LeaveWeb Direct Link (.mil only)': 'LeaveWeb Direct Link',
    'AFMC Tracker [.mil only]': 'AFMC Tracker',
    'Air Force White Pages [.mil]': 'Air Force White Pages',
    'MyETMS (My Education and Training Management System) (.mil)': 'MyETMS (My Education and Training Management System)',
    'EZ Source Electronic Source Selection Tool [.mil/CAC Required]': 'EZ Source Electronic Source Selection Tool',
    'PSDM (.mil only?)': 'PSDM',
    'UTAPS (Unit Training Assembly Participation System) - .mil only': 'UTAPS (Unit Training Assembly Participation System)',
    'STARS RAW (Air National Guard Manning Tool, .mil only)': 'STARS RAW (Air National Guard Manning Tool)',
    'Automatic Key Recovery Agent (mil only / CAC PKI Cert Recovery)': 'Automatic Key Recovery Agent (CAC PKI Cert Recovery)',
  }
  for (const [title, clean] of Object.entries(cases)) {
    assert.deepEqual(milOnlyMarker(title), { title: clean, milOnly: true }, title)
  }
})

test('titles without a .mil only marker are left alone', () => {
  for (const title of ['DHL [.mil/.com]', 'milConnect', 'Military OneSource', 'NIPRGPT', 'Tinker Cognos [.mil/.com]']) {
    assert.deepEqual(milOnlyMarker(title), { title, milOnly: false }, title)
  }
})

const files = descriptions => ({
  af: { afpCategorizedLinksDto: { links: { PERSONNEL: [
    { contentId: 'a', title: 'Marked (.mil only)', link: 'https://a.af.mil' },
    { contentId: 'b', title: 'Wrongly marked [.mil only]', link: 'https://b.af.mil' },
    { contentId: 'c', title: 'Unmarked', link: 'https://c.af.mil' },
  ] } } },
  other: { OTHER: [] },
  overrides: [],
  unofficial: { UNOFFICIAL: [{ contentId: 'u', title: 'Guide [.mil]', link: 'https://example.com' }] },
  descriptions: { descriptions },
  health: {},
})

test('a hand-set milOnly overrules the title, either way', () => {
  const assembled = assembleLinks(files({ b: { summary: 'x', milOnly: false }, c: { summary: 'x', milOnly: true } }), { today: '2026-11-10' })
  const byId = Object.fromEntries(assembled.links.PERSONNEL.map(l => [l.contentId, l]))
  assert.equal(byId.a.milOnly, true)
  assert.equal(byId.a.title, 'Marked')
  assert.equal(byId.b.milOnly, undefined)
  assert.equal(byId.b.title, 'Wrongly marked')
  assert.equal(byId.c.milOnly, true)
  const published = publishedLinks(assembled)
  assert.equal(published.unofficial[0].milOnly, true)
  assert.equal(published.unofficial[0].title, 'Guide')
})

test('"mil only" finds marked links, and only those, by the flag', () => {
  const words = parseQuery('mil only')
  assert.ok(matchLink({ title: 'LeaveWeb', url: 'https://leave.af.mil', category: 'FINANCE', milOnly: true }, words).matched)
  assert.ok(!matchLink({ title: 'myPay', url: 'https://mypay.dfas.mil', category: 'FINANCE' }, words).matched)
})

test('the worker carries milOnly into search results', async () => {
  const worker = createWorker({ links: [{ category: 'FINANCE', links: [
    { title: 'LeaveWeb Direct Link', link: 'https://leave.af.mil', milOnly: true },
    { title: 'myPay', link: 'https://mypay.dfas.mil' },
  ] }], unofficial: [] })
  const res = await worker.fetch(new Request('https://worker.dev/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_links', arguments: { query: 'mil only' } } }),
  }), {})
  const { result } = await res.json()
  assert.deepEqual(result.structuredContent.results.map(r => [r.title, r.milOnly]), [['LeaveWeb Direct Link', true]])
  assert.match(result.content[0].text, /\.mil network only/)
})

const built = ['_site', 'docs'].map(d => path.resolve(process.cwd(), d)).find(d => fs.existsSync(path.join(d, 'links.json')))

test('the built site shows no .mil only marker left in a title', { skip: !built && 'site not built' }, () => {
  const data = JSON.parse(fs.readFileSync(path.join(built, 'links.json'), 'utf8'))
  const listed = data.links.flatMap(c => c.links.filter(l => !l.isDeleted)).concat(data.unofficial)
  assert.deepEqual(listed.filter(l => milOnlyMarker(l.title).milOnly).map(l => l.title), [])
  assert.ok(listed.some(l => l.milOnly))
})
