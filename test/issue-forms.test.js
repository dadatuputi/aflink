// The edit and delete buttons open GitHub issue forms prefilled from query
// parameters. Each parameter must name a field in its form, and the locked
// current_* fields must show the link as the site lists it.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const built = ['_site', 'docs'].map(d => path.resolve(process.cwd(), d))
  .find(d => fs.existsSync(path.join(d, 'index.html')) && fs.existsSync(path.join(d, 'links.json')))

const formIds = file => new Set([...fs.readFileSync(`.github/ISSUE_TEMPLATE/${file}`, 'utf8')
  .matchAll(/^\s+id: (\S+)$/gm)].map(m => m[1]))

const formLinks = html => [...html.matchAll(/class="override-link override-(edit|delete)"[^>]*href="([^"]+)"/g)]
  .map(m => new URL(m[2].replaceAll('&amp;', '&')))

test('form links only prefill fields their form has', { skip: !built && 'site not built' }, () => {
  const urls = formLinks(fs.readFileSync(path.join(built, 'index.html'), 'utf8'))
  assert.ok(urls.length > 0, 'no edit or delete links found')
  for (const url of urls) {
    const template = url.searchParams.get('template')
    const ids = formIds(template)
    for (const key of url.searchParams.keys()) {
      if (key === 'template' || key === 'title') continue
      assert.ok(ids.has(key), `${template} has no field "${key}"`)
    }
  }
})

test('the edit form shows the current summary', { skip: !built && 'site not built' }, () => {
  const data = JSON.parse(fs.readFileSync(path.join(built, 'links.json'), 'utf8'))
  const summaries = new Map(data.links.flatMap(c => c.links).concat(data.unofficial)
    .map(l => [l.contentId, l.summary]))
  const edits = formLinks(fs.readFileSync(path.join(built, 'index.html'), 'utf8'))
    .filter(u => u.searchParams.get('template') === '02_link_override.yaml')
  assert.ok(edits.some(u => u.searchParams.has('current_summary')))
  for (const url of edits) {
    const summary = summaries.get(url.searchParams.get('match'))
    assert.equal(url.searchParams.get('current_summary'), summary ?? null)
  }
})

test('the edit form shows whether the link is marked .mil only', { skip: !built && 'site not built' }, () => {
  const data = JSON.parse(fs.readFileSync(path.join(built, 'links.json'), 'utf8'))
  const milOnly = new Map(data.links.flatMap(c => c.links).concat(data.unofficial).map(l => [l.contentId, !!l.milOnly]))
  const edits = formLinks(fs.readFileSync(path.join(built, 'index.html'), 'utf8'))
    .filter(u => u.searchParams.get('template') === '02_link_override.yaml')
  assert.ok(edits.some(u => u.searchParams.get('current_mil_only') === 'Yes'))
  for (const url of edits) {
    assert.equal(url.searchParams.get('current_mil_only'), milOnly.get(url.searchParams.get('match')) ? 'Yes' : 'No')
  }
})
