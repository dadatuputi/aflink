// The matching rules the page and the autocomplete worker share.
// If a case here has to change, the page's behaviour is changing with it —
// which means the worker's suggestions change too. That is the point.
import test from 'node:test'
import assert from 'node:assert/strict'

import '../src/includes/js/search-match.js'
const { normalize, parseQuery, matchLink, matchRanges } = globalThis.AflinkSearch

const match = (link, query) => matchLink(link, parseQuery(query))
const LINK = { title: 'Office 365 Webmail / OWA / E-mail', url: 'https://portal.office.com', category: 'AIR FORCE INFORMATION' }

test('normalize folds case, accents and punctuation', () => {
  assert.equal(normalize('Café / E-Mail!').norm, 'cafeemail')
  assert.equal(normalize('').norm, '')
  // the map points every normalized character back at the original string
  const n = normalize('E-Mail')
  assert.equal(n.map[n.norm.indexOf('m')], 2)
})

test('a query word matches across punctuation', () => {
  assert.ok(match(LINK, 'email').matched)
  assert.ok(match(LINK, 'e-mail').matched)
  assert.ok(match(LINK, 'E-MAIL').matched)
})

test('every word must match', () => {
  assert.ok(match(LINK, 'webmail owa').matched)
  assert.ok(!match(LINK, 'webmail travel').matched)
})

test('single-character parts never match on their own', () => {
  // "e-mail" splits into "e" and "mail"; "e" is dropped, so a title with
  // "mail" still matches, but a title with only a stray "e" does not
  assert.ok(match({ title: 'Mail', url: '', category: '' }, 'e-mail').matched)
  assert.ok(!match({ title: 'Everest', url: '', category: '' }, 'e-mail').matched)
})

test('URL and category match too, without producing title highlights', () => {
  const byUrl = match(LINK, 'office.com')
  assert.ok(byUrl.matched)
  const byCategory = match(LINK, 'air force information')
  assert.ok(byCategory.matched)
  assert.deepEqual(match({ title: 'Weather', url: 'https://a.mil', category: 'OTHER' }, 'a.mil').ranges, [])
})

test('unofficial rows match on the word "unofficial"', () => {
  const link = { title: 'MilitaryCAC', url: 'https://militarycac.com/', category: 'UNOFFICIAL' }
  assert.ok(match(link, 'unofficial').matched)
  assert.ok(match(link, 'militarycac').matched)
})

test('ranges cover the matched text in the original title', () => {
  const { ranges } = match(LINK, 'owa')
  const [start, end] = ranges[0]
  assert.equal(LINK.title.slice(start, end + 1), 'OWA')
})

test('an empty query matches everything, as the unfiltered page does', () => {
  assert.ok(match(LINK, '').matched)
  assert.ok(match(LINK, '   ').matched)
})

test('matchRanges highlights whichever words appear', () => {
  assert.equal(matchRanges('WEATHER & TIME', parseQuery('weather')).length, 1)
  assert.equal(matchRanges('SAFETY', parseQuery('weather')).length, 0)
})
