// The audit scripts (check-trust.js, scan-reputation.js) must see the link set
// the site actually serves: overrides applied, deletions gone, unofficial links
// only where asked for. A drift here means auditing links nobody can click, or
// missing ones they can.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { servedLinks } from '../scripts/served-links.js'
import { inScope, lookupUrls, sbFindings, vtFlagged, safeBrowsing, virusTotal, verdict } from '../scripts/scan-reputation.js'

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aflink-links-'))
  const write = (name, data) => fs.writeFileSync(path.join(dir, name), JSON.stringify(data))
  write('links_af.json', { afpCategorizedLinksDto: { links: { 'WEATHER & TIME': [
    { title: 'AFW-WEBS', link: 'https://weather.af.mil', contentId: 'a1' },
    { title: 'Portal Page', link: '/portal/page', contentId: 'a2' },
    { title: 'Retired Tool', link: 'https://gone.af.mil', contentId: 'a3' },
  ]}}})
  write('links_other.json', { OTHER: [{ title: 'milSuite', link: 'https://www.milsuite.mil', contentId: 'o1' }] })
  write('links_unofficial.json', { UNOFFICIAL: [{ title: 'MilitaryCAC', link: 'https://militarycac.com/', contentId: 'u1' }] })
  write('links_override.json', [
    // Newer override written first: application order must follow timestamps
    { match: 'a1', link: 'https://weather.example.com/', timestamp: 200 },
    { match: 'a1', title: 'Old Name', link: 'https://stale.example.com/', timestamp: 100 },
    { match: 'a3', timestamp: 150 },
  ])
  return dir
}

test('served links apply overrides newest-last and drop deletions', () => {
  const links = servedLinks({ dir: fixture() })
  assert.deepEqual(links.map(l => l.title), ['Old Name', 'Portal Page', 'milSuite'])
  assert.equal(links[0].url, 'https://weather.example.com/')
  assert.equal(links[0].host, 'weather.example.com')
  assert.equal(links[1].url, 'https://www.my.af.mil/portal/page')
})

test('unofficial links are included only when asked for', () => {
  const dir = fixture()
  assert.ok(!servedLinks({ dir }).some(l => l.host === 'militarycac.com'))
  assert.ok(servedLinks({ dir, unofficial: true }).some(l => l.host === 'militarycac.com'))
})

test('reputation scan covers everything outside .mil/.gov, .edu included', () => {
  assert.ok(!inScope('weather.af.mil'))
  assert.ok(!inScope('www.usa.gov'))
  assert.ok(inScope('www.afit.edu'))
  assert.ok(inScope('militarycac.com'))
  assert.ok(!inScope('(unparseable URL)'))
})

test('lookups include each host root once', () => {
  const urls = lookupUrls([
    { url: 'https://a.com/x', host: 'a.com' },
    { url: 'https://a.com/y', host: 'a.com' },
  ])
  assert.deepEqual(urls, ['https://a.com/x', 'https://a.com/', 'https://a.com/y'])
})

test('a host-root Safe Browsing match flags every link on that host', () => {
  const links = [
    { title: 'X', url: 'https://a.com/x', host: 'a.com' },
    { title: 'Y', url: 'https://a.com/y', host: 'a.com' },
    { title: 'Z', url: 'https://b.com/', host: 'b.com' },
  ]
  const found = sbFindings(links, [{ threatType: 'MALWARE', threat: { url: 'https://a.com/' } }])
  assert.deepEqual(found.map(f => f.title), ['X', 'Y'])
  assert.equal(found[0].verdict, 'MALWARE')
})

test('VirusTotal needs two engines to agree', () => {
  assert.ok(!vtFlagged(null))
  assert.ok(!vtFlagged({ malicious: 1, suspicious: 0 }))
  assert.ok(vtFlagged({ malicious: 1, suspicious: 1 }))
  assert.ok(vtFlagged({ malicious: 3, suspicious: 0 }))
})

test('API clients send the documented request shapes', async () => {
  const calls = []
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url, opts })
    if (url.includes('safebrowsing')) return new Response('{}')
    return new Response(JSON.stringify({ data: { attributes: { last_analysis_stats: { malicious: 2, suspicious: 0 } } } }))
  }
  assert.deepEqual(await safeBrowsing(['https://a.com/'], 'K'), [])
  const sb = JSON.parse(calls[0].opts.body)
  assert.match(calls[0].url, /\/v4\/threatMatches:find\?key=K$/)
  assert.deepEqual(sb.threatInfo.threatEntries, [{ url: 'https://a.com/' }])

  assert.deepEqual(await virusTotal('a.com', 'V'), { malicious: 2, suspicious: 0 })
  assert.equal(calls[1].url, 'https://www.virustotal.com/api/v3/domains/a.com')
  assert.equal(calls[1].opts.headers['x-apikey'], 'V')
})

test('VirusTotal rate limiting waits and retries once', async () => {
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    if (calls === 1) return new Response('', { status: 429 })
    return new Response(JSON.stringify({ data: { attributes: { last_analysis_stats: { malicious: 0, suspicious: 0 } } } }))
  }
  assert.deepEqual(await virusTotal('a.com', 'V', { retryMs: 0 }), { malicious: 0, suspicious: 0 })
  assert.equal(calls, 2)
})

test('a link request always gets a verdict', () => {
  const sources = 'Safe Browsing'
  const finding = { title: 'X', host: 'a.com', source: 'Safe Browsing', verdict: 'MALWARE' }
  assert.match(verdict({ url: 'https://a.com/', host: 'a.com', findings: [], sources }), /safe\./)
  assert.match(verdict({ url: 'https://a.com/', host: 'a.com', findings: [finding], sources }), /UNSAFE[\s\S]*MALWARE/)
  const safe = verdict({ url: 'https://a.com/p?q=1', host: 'a.com', findings: [], sources })
  assert.ok(safe.includes('https://transparencyreport.google.com/safe-browsing/search?url=https%3A%2F%2Fa.com%2Fp%3Fq%3D1'))
  assert.ok(safe.includes('https://www.virustotal.com/gui/domain/a.com'))
  assert.match(verdict({ url: 'https://x.af.mil/', host: 'x.af.mil', findings: [], sources }), /official domain/)
  assert.match(verdict({ url: 'nope', host: '(unparseable URL)', findings: [], sources }), /not a valid URL/)
})
