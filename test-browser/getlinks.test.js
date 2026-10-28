// getlinks.js in real browsers, against a mock portal (mock-portal.js). The
// script is pasted into a console on the portal; here it is evaluated in the
// page the same way. Chromium and Firefox both: the portal primes a section's
// quick links only when its landing page is loaded as a document, and the
// browsers differ in what a hidden frame or a tab opened from a script may do.
//
// Not covered: the real portal. Nothing here can log in with a CAC.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { chromium, firefox } from 'playwright'

import { startMockPortal } from './mock-portal.js'

const SCRIPT = fs.readFileSync('getlinks.js', 'utf8')
const SUBMIT_URL = SCRIPT.match(/const SUBMIT_URL = '([^']+)'/)[1]

for (const [name, type] of [['chromium', chromium], ['firefox', firefox]]) {
  test(`${name}: collects every list and submits once`, async () => {
    const portal = await startMockPortal()
    const browser = await type.launch()
    try {
      const context = await browser.newContext()
      const page = await context.newPage()
      const submissions = []
      // The worker is not part of this test; answer as it would
      await context.route(SUBMIT_URL, async route => {
        submissions.push(route.request().postDataJSON())
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, count: 5, source: 'x', message: 'Received 5 links.' }) })
      })
      await page.goto(`${portal.url}/gcss-af/USAF/ep/manageApplications.do`)
      await page.evaluate(SCRIPT)
      await page.waitForSelector('#compressedDataModal h2', { timeout: 90000 })
      const title = await page.textContent('#compressedDataModal h2')
      const lines = await page.$$eval('#submitLines li', els => els.map(e => e.textContent))

      assert.equal(title, 'Links submitted', lines.join('\n'))
      assert.deepEqual(lines.slice(0, 4), [
        'Applications A-Z: 2 links',
        'Home: Temporary Links Information: 1 links',
        'Career and Training links: 1 links',
        'Life and Fitness Quick Links: 1 links',
      ])
      assert.equal(submissions.length, 1)
      assert.deepEqual(submissions[0].pages.map(p => p.source.split(':')[0]), ['index', 'quicklinks', 'quicklinks', 'quicklinks'])
      // the portal's description rides along as plain text, boilerplate dropped
      const mypay = submissions[0].pages[0].afpCategorizedLinksDto.links['FINANCIAL MANAGEMENT'][0]
      assert.equal(mypay.description, 'Pay statements.')
      assert.equal(mypay.lastModified, '2026-01-01')

      // How each section got primed, for the record: a frame or a real tab
      const landings = portal.log.filter(e => e.path.endsWith('globalTab.do') && e.query.command === 'landing').map(e => e.dest)
      console.log(`${name}: landing pages loaded as`, landings.join(', '))
      assert.ok(landings.length >= 3, 'every section was entered through its landing page')
    } finally {
      await browser.close()
      await portal.close()
    }
  })
}
