// Layout of the built page (_site, from `npm run dev:build`) in real
// browsers. Checks geometry, not pixels: a screenshot diff breaks on every
// font or emoji update, but where things sit relative to each other only
// changes when the layout does.
//
// The row actions (correct, delete) are absolutely positioned. When the
// summary line moved the title into .link-main, the :nth-of-type offsets
// silently matched the wrong anchors and the edit icon fell to the far left
// of every row; nothing failed until someone looked.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { chromium, firefox } from 'playwright'

const SITE = '_site'

function serve (dir) {
  const root = path.resolve(dir)
  const server = http.createServer((req, res) => {
    let file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname))
    if (!file.startsWith(root)) { res.statusCode = 403; return res.end() }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html')
    if (!fs.existsSync(file)) { res.statusCode = 404; return res.end() }
    if (file.endsWith('.html')) res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end(fs.readFileSync(file))
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => { server.closeAllConnections(); server.close() } })))
}

// Every row: its action icons sit inside it, in the right half, in markup
// order (correct, then delete) and without overlapping each other.
function rowActionProblems () {
  const problems = []
  const rows = [...document.querySelectorAll('.link-container')]
  for (const row of rows) {
    if (!row.offsetParent) continue // filtered out or in a hidden section
    const r = row.getBoundingClientRect()
    const name = row.querySelector('.main-link')?.textContent.trim().slice(0, 50)
    const icons = [...row.querySelectorAll(':scope > .override-link')].map(a => ({ text: a.textContent.trim(), box: a.getBoundingClientRect() }))
    if (icons.length !== 2) { problems.push(`${name}: ${icons.length} action icons`); continue }
    for (const { text, box } of icons) {
      if (box.left < r.left || box.right > r.right || box.top < r.top || box.bottom > r.bottom) problems.push(`${name}: ${text} outside its row`)
      if (box.left < r.left + r.width / 2) problems.push(`${name}: ${text} in the left half (x=${Math.round(box.left)} of ${Math.round(r.left)}-${Math.round(r.right)})`)
    }
    const [edit, del] = icons.map(i => i.box)
    if (edit.right > del.left + 0.5) problems.push(`${name}: correct icon (${Math.round(edit.left)}-${Math.round(edit.right)}) overlaps or follows delete (${Math.round(del.left)}-${Math.round(del.right)})`)
  }
  return { checked: rows.filter(r => r.offsetParent).length, problems }
}

for (const [name, type] of [['chromium', chromium], ['firefox', firefox]]) {
  for (const [label, viewport] of [['desktop', { width: 1200, height: 800 }], ['phone', { width: 390, height: 844 }]]) {
    test(`${name} ${label}: row actions sit together at the right of every link`, async () => {
      assert.ok(fs.existsSync(path.join(SITE, 'index.html')), 'run `npm run dev:build` first')
      const site = await serve(SITE)
      const browser = await type.launch()
      try {
        const page = await browser.newPage({ viewport })
        await page.goto(site.url + '/')
        const { checked, problems } = await page.evaluate(rowActionProblems)
        assert.ok(checked > 10, `only ${checked} visible link rows`)
        assert.deepEqual(problems.slice(0, 10), [], `${problems.length} of ${checked} rows misplaced`)
      } finally {
        await browser.close()
        site.close()
      }
    })
  }
}
