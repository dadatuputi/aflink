// Contact info is stripped from portal descriptions and never served.
// All names, numbers and addresses here are made up (555, example.mil).
import test from 'node:test'
import assert from 'node:assert/strict'

import { stripContactInfo, hasContactInfo } from '../search_worker/src/contact-info.js'
import { sanitize } from '../search_worker/src/submit.js'
import { applySource } from '../scripts/af-merge.js'
import { readLinkFiles, assembleLinks } from '../scripts/assemble-links.js'

const BODY = 'Widget lists formal courses run by MAJCOMs. It is open to anyone with a CAC on a .mil or .gov network.'
const WIDGET = `${BODY} If you require the ability to edit courses, please contact: HQ XYZ/A1, Widget Inbox, widget.inbox@example.mil.`

test('a lower-case "please contact" and its inbox are cut', () => {
  assert.equal(stripContactInfo(WIDGET), BODY)
})

test('numbers and addresses go wherever they sit in the description', () => {
  const cases = [
    // labelled POC block, no lead phrase
    ['Widget tracks tests. Point of Contact: Jane Doe, XYZ/A5, DSN 555-0100, jane.doe@example.mil', 'Widget tracks tests.'],
    // run-on with no period before the lead
    ['Widget tracks ideas For questions regarding the program, contact Jane or (555) 555-0100.', 'Widget tracks ideas'],
    // the whole lead sentence goes, not just from "please contact"
    ['Learn SharePoint here. For account actions, please contact us at (555) 555-0100 or DSN 555-0100.', 'Learn SharePoint here.'],
    // a dotted address is not a sentence break
    ['Borrow eBooks at a library. Contact XYZ.ABC.library@example.mil for questions', 'Borrow eBooks at a library.'],
    // a number with no lead phrase
    ['Widget supports HR. To reach the office, call DSN 555-0100 or Comm (555) 555-0100.', 'Widget supports HR.'],
    ['Call 1-800-555-HELP for help', ''],
  ]
  for (const [input, expected] of cases) {
    const out = stripContactInfo(input)
    assert.equal(out, expected, input)
    assert.ok(!hasContactInfo(out), input)
  }
})

test('descriptions without contact info are left alone', () => {
  for (const text of [
    'The Hazard Communication Standard (29 CFR 1910.1200) requires the data be readily accessible.',
    'Update contact information in DEERS, view ID cards and manage TRICARE enrollments.',
    'Shows data feeds D002A, D035T and Q310 for FY 2024-2025.',
    'Effective 01 July 2011, the new website replaced the old one.',
  ]) assert.equal(stripContactInfo(text), text)
})

const SOURCE = 'index:manageApplications'
const link = extra => ({ contentId: `c${'1'.padEnd(32, '0')}`, title: 'Widget', link: 'https://widget.example.mil', ...extra })

test('the worker strips contact info from a submission', () => {
  const clean = sanitize({ source: SOURCE, afpCategorizedLinksDto: { links: { TRAINING: [link({ description: WIDGET })] } } })
  assert.equal(clean.pages[0].links.TRAINING[0].description, BODY)
  const only = sanitize({ source: SOURCE, afpCategorizedLinksDto: { links: { TRAINING: [link({ description: 'Help desk: DSN 555-0100' })] } } })
  assert.equal(only.pages[0].links.TRAINING[0].description, undefined)
})

test('the sync stores no contact info, and drops a contact-only description', () => {
  const file = links => ({ afpCategorizedLinksDto: { links } })
  const description = d => Object.values(d.afpCategorizedLinksDto.links).flat()[0].description
  let d = applySource(file({}), SOURCE, { TRAINING: [link({ description: WIDGET })] }, '2026-11-16')
  assert.equal(description(d), BODY)
  d = applySource(d, SOURCE, { TRAINING: [link({ description: 'Email widget@example.mil for access' })] }, '2026-11-17')
  assert.equal(description(d), undefined)
})

test('no served description or summary holds an email address or phone number', () => {
  const { links, unofficial } = assembleLinks(readLinkFiles('src/links'), { today: new Date().toISOString().slice(0, 10) })
  const leaks = [...Object.values(links).flat(), ...unofficial]
    .flatMap(l => ['description', 'summary']
      .filter(f => typeof l[f] === 'string' && hasContactInfo(l[f]))
      .map(f => `${l.contentId} ${f}`))
  assert.deepEqual(leaks, [])
})
