// Every link the page lists carries a one-line summary. The summaries live in
// src/links/links_descriptions.json; this is the rule that keeps the file
// complete as links are added. Only a link whose domain has died is exempt:
// it shows muted until it retires.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const SUMMARY_MAX = 90

const built = ['_site/links.json', 'docs/links.json']
  .map(p => path.resolve(process.cwd(), p)).find(p => fs.existsSync(p))

test('summaries are one line of at most 90 characters', () => {
  const { descriptions } = JSON.parse(fs.readFileSync('src/links/links_descriptions.json', 'utf8'))
  for (const [id, d] of Object.entries(descriptions)) {
    assert.ok(typeof d.summary === 'string' && d.summary.trim(), `${id}: no summary`)
    assert.ok(d.summary.length <= SUMMARY_MAX, `${id}: summary is ${d.summary.length} characters`)
    assert.ok(!/[\r\n]/.test(d.summary), `${id}: summary spans lines`)
    if (d.description !== undefined) {
      assert.ok(typeof d.description === 'string' && d.description.trim(), `${id}: empty description`)
      // the dialog falls back to the summary when there is no description, so
      // a description that repeats it is noise; the cap matches the worker's
      assert.notEqual(d.description.trim(), d.summary.trim(), `${id}: description repeats the summary`)
      assert.ok(d.description.length <= 2000, `${id}: description is ${d.description.length} characters`)
    }
  }
})

test('every listed link has a summary', { skip: built ? false : 'site not built' }, () => {
  const data = JSON.parse(fs.readFileSync(built, 'utf8'))
  const listed = data.links.flatMap(c => c.links.filter(l => !l.isDeleted && !l.isDead)).concat(data.unofficial)
  const missing = listed.filter(l => !l.summary).map(l => `${l.contentId} ${l.title}`)
  assert.deepEqual(missing, [], `links without a summary:\n${missing.join('\n')}`)
})
