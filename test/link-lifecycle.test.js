// The sync merge, deprecation and retirement, and the dead-domain bookkeeping.
// A link must never vanish because one page was submitted or one DNS lookup
// failed; these tests pin that down.
import test from 'node:test'
import assert from 'node:assert/strict'

import { applySource, LEGACY_SOURCE, QUICK_LINKS_CATEGORY } from '../scripts/af-merge.js'
import { linkStatus, RETIRE_DAYS, STRIKES } from '../scripts/link-status.js'
import { combine, nextHealth } from '../scripts/check-domains.js'

const file = links => ({ afpCategorizedLinksDto: { links } })
const all = data => Object.values(data.afpCategorizedLinksDto.links).flat()
const byId = (data, id) => all(data).find(l => l.contentId === id)
const L = (id, extra = {}) => ({ contentId: id, title: id, link: `https://${id}.af.mil`, ...extra })

const APPS = 'index:manageApplications'
const HOME = 'quicklinks:pHOME'

test('a page updates the links it lists and leaves other pages\' links alone', () => {
  let d = file({})
  d = applySource(d, APPS, { PERSONNEL: [L('a'), L('b')] }, '2026-01-01')
  d = applySource(d, HOME, { 'Top 10 Searches': [L('b'), L('c')] }, '2026-01-01')
  d = applySource(d, HOME, { 'Top 10 Searches': [L('c', { title: 'C renamed' })] }, '2026-02-01')
  assert.equal(all(d).length, 3)
  // b is still on Applications A-Z, so dropping off the home page is not a deprecation
  assert.equal(byId(d, 'b').deprecatedSince, undefined)
  assert.deepEqual(byId(d, 'b').sources, [APPS])
  assert.equal(byId(d, 'c').title, 'C renamed')
})

test('a link no page lists is deprecated, not removed, and comes back cleanly', () => {
  let d = applySource(file({}), APPS, { PERSONNEL: [L('a'), L('b')] }, '2026-01-01')
  d = applySource(d, APPS, { PERSONNEL: [L('a')] }, '2026-02-01')
  assert.equal(byId(d, 'b').deprecatedSince, '2026-02-01')
  // a later submission does not move the original date
  d = applySource(d, APPS, { PERSONNEL: [L('a')] }, '2026-03-01')
  assert.equal(byId(d, 'b').deprecatedSince, '2026-02-01')
  d = applySource(d, APPS, { PERSONNEL: [L('a'), L('b')] }, '2026-04-01')
  assert.equal(byId(d, 'b').deprecatedSince, undefined)
})

test('the merge never drops an unlisted link, however long ago the portal dropped it', () => {
  let d = applySource(file({}), APPS, { PERSONNEL: [L('a'), L('b')] }, '2026-01-01')
  d = applySource(d, APPS, { PERSONNEL: [L('a')] }, '2026-01-02')
  d = applySource(d, APPS, { PERSONNEL: [L('a')] }, '2027-12-31')
  assert.equal(byId(d, 'b').deprecatedSince, '2026-01-02')
})

test('links from before source tracking belong to the old Quick Links page', () => {
  let d = file({ 'AIR FORCE INFORMATION': [L('old'), L('app')] })
  d = applySource(d, APPS, { PERSONNEL: [L('app')] }, '2026-10-27')
  d = applySource(d, LEGACY_SOURCE, {}, '2026-10-27')
  assert.equal(byId(d, 'old').deprecatedSince, '2026-10-27')
  assert.equal(byId(d, 'app').deprecatedSince, undefined)
})

test('only an index page moves a link between categories', () => {
  let d = applySource(file({}), HOME, { 'Top 10 Searches': [L('a')] }, '2026-01-01')
  assert.deepEqual(Object.keys(d.afpCategorizedLinksDto.links), [QUICK_LINKS_CATEGORY])
  d = applySource(d, APPS, { Personnel: [L('a')] }, '2026-01-01')
  d = applySource(d, HOME, { 'Next 10 Searches': [L('a')] }, '2026-01-01')
  assert.deepEqual(Object.keys(d.afpCategorizedLinksDto.links), ['PERSONNEL'])
})

test('a referrer with the site is kept over one without', () => {
  const full = 'https://www.my.af.mil/gcss-af/USAF/ep/contentView.do?contentType=URL&contentId=ca&channelPageId=sHOME'
  const bare = 'https://www.my.af.mil/gcss-af/USAF/ep/contentView.do?contentType=URL&contentId=ca&channelPageId'
  let d = applySource(file({}), HOME, { 'Top 10 Searches': [L('a', { exitLinkReferrer: full })] }, '2026-01-01')
  d = applySource(d, APPS, { PERSONNEL: [L('a', { exitLinkReferrer: bare })] }, '2026-01-02')
  assert.equal(byId(d, 'a').exitLinkReferrer, full)
  // a new link takes whatever it comes with
  d = applySource(d, APPS, { PERSONNEL: [L('a', { exitLinkReferrer: bare }), L('b', { exitLinkReferrer: bare })] }, '2026-01-03')
  assert.equal(byId(d, 'b').exitLinkReferrer, bare)
})

test('a portal category named Other does not collide with the community OTHER list', () => {
  const d = applySource(file({}), APPS, { Other: [L('a')] }, '2026-01-01')
  assert.deepEqual(Object.keys(d.afpCategorizedLinksDto.links), ['GENERAL'])
})

test('a submission without a source is refused', () => {
  assert.throws(() => applySource(file({}), undefined, {}, '2026-01-01'), /no source/)
})

test('link status: an unlisted link is noted, never retired', () => {
  assert.deepEqual(linkStatus(L('a'), '2026-01-01'), { unlisted: false, dead: false, retired: false, note: null })
  const dep = L('a', { deprecatedSince: '2026-01-01' })
  assert.ok(linkStatus(dep, '2026-01-02').unlisted)
  assert.match(linkStatus(dep, '2026-01-02').note, /Removed from the AF Portal since January 1, 2026/)
  assert.ok(!linkStatus(dep, '2027-12-31').retired)
  assert.equal(RETIRE_DAYS, 180)
})

test('link status: a dead domain mutes the link, then retires it after the window', () => {
  const link = L('gone')
  const health = { 'gone.af.mil': { seen: true, strikes: STRIKES, failingSince: '2026-01-01' } }
  const s = linkStatus(link, '2026-02-01', health)
  assert.ok(s.dead && !s.retired)
  assert.ok(linkStatus(link, '2026-12-31', health).retired)
})

test('link status: a dead domain counts only at the strike limit', () => {
  const link = L('gone')
  const health = n => ({ 'gone.af.mil': { seen: true, strikes: n, failingSince: '2026-01-01' } })
  assert.ok(!linkStatus(link, '2026-02-01', health(STRIKES - 1)).dead)
  const s = linkStatus(link, '2026-02-01', health(STRIKES))
  assert.ok(s.dead)
  assert.match(s.note, /Domain has not existed since January 1, 2026/)
})

test('both resolvers must say the domain does not exist', () => {
  assert.equal(combine(['nxdomain', 'nxdomain']), 'nxdomain')
  assert.equal(combine(['nxdomain', 'error']), 'unknown')
  assert.equal(combine(['nxdomain', 'ok']), 'ok')
})

test('strikes need a domain that once resolved, and any success resets them', () => {
  let h = nextHealth(undefined, 'nxdomain', '2026-01-01')
  assert.equal(h.strikes, 0, 'never seen: an internal-only name is not counted')
  h = nextHealth(h, 'ok', '2026-01-08')
  h = nextHealth(h, 'nxdomain', '2026-01-15')
  h = nextHealth(h, 'unknown', '2026-01-22')
  assert.equal(h.strikes, 1, 'timeouts neither add nor reset')
  h = nextHealth(h, 'nxdomain', '2026-01-29')
  assert.equal(h.failingSince, '2026-01-15')
  h = nextHealth(h, 'ok', '2026-02-05')
  assert.equal(h.strikes, 0)
  assert.equal(h.failingSince, undefined)
})
