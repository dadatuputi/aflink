// A stand-in for the AF Portal, just enough for getlinks.js: Applications A-Z
// with its embedded list, the quick-link pages, and the quicklinks feed, which
// answers 404 for a section until the session has loaded that section's
// landing page as a document (the way the nav bar tabs do). A plain fetch of
// the landing page does not count, as on the real portal.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const JQUERY = fs.readFileSync(path.resolve('src/includes/js/jquery-3.5.1.slim.min.js'))

export const SITES = {
  home: 's6925EC1356510FB5E044080020E329A9',
  career: 'sF1D9EE47BB312480E0400F9E4DDA2DD3',
  life: 's6925EC13564F0FB5E044080020E329A9',
}
const CATEGORY_SITE = {
  p44C00E3C94DB4A210194DC84A9E10002: SITES.home,
  pAF429CFD945FB19F0194605EE6410002: SITES.career,
  pAF429CFD945FB19F019460FC9A650026: SITES.life,
}

const link = (id, title, url) => ({ title, link: url, type: 'application', contentId: id, url: true, renderedAsFile: false })
const APPS = [
  { displayTitle: 'myPay', link: 'https://mypay.dfas.mil', id: 'c' + '1'.repeat(32), functionalArea: 'Financial Management', isUrl: true, abstract: '<p>Pay statements.</p><p>To gain access to this application, call someone.</p>', lastModTime: { time: 1767225600000 } },
  { displayTitle: 'LOGMOD - Logistics Module', link: 'https://logmod.cce.af.mil', id: 'c' + '2'.repeat(32), functionalArea: 'Logistics Readiness', isUrl: true, abstract: 'Moves cargo.' },
]
const FEEDS = {
  [SITES.home]: { 'Top 10 Searches': [link('c' + '3'.repeat(32), 'DTS', 'https://dts.mil')] },
  [SITES.career]: { 'EDUCATION AND TRAINING': [link('c' + '4'.repeat(32), 'AFVEC', 'https://afvec.us.af.mil')] },
  [SITES.life]: { 'Finance and Travel': [link('c' + '5'.repeat(32), 'LeaveWeb', 'https://leave.af.mil')] },
}

const page = body => `<!doctype html><html><head><meta charset="utf-8"><title>AFP</title><script src="/jquery.js"></script></head><body>${body}</body></html>`

export function startMockPortal() {
  const sessions = new Map()
  const log = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    let sid = (req.headers.cookie || '').match(/sid=([a-f0-9]+)/)?.[1]
    if (!sid || !sessions.has(sid)) {
      sid = crypto.randomBytes(8).toString('hex')
      sessions.set(sid, { primed: new Set() })
      res.setHeader('set-cookie', `sid=${sid}; Path=/`)
    }
    const session = sessions.get(sid)
    const dest = req.headers['sec-fetch-dest'] || ''
    log.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), dest })

    if (url.pathname === '/jquery.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(JQUERY)
    }
    if (url.pathname === '/gcss-af/USAF/ep/manageApplications.do') {
      res.writeHead(200, { 'content-type': 'text/html' })
      return res.end(page(`<h1>Applications A-Z</h1><script>var afp={indexModel:{storeData:function(){}}};afp.indexModel.storeData(${JSON.stringify(APPS)});</script>`))
    }
    if (url.pathname === '/gcss-af/USAF/ep/globalTab.do') {
      // Entering a section: only a document or frame load counts
      const site = url.searchParams.get('channelPageId')
      if (url.searchParams.get('command') === 'landing' && site && (dest === 'document' || dest === 'iframe')) session.primed.add(site)
      res.writeHead(200, { 'content-type': 'text/html' }); return res.end(page('<h1>Section landing</h1>'))
    }
    if (url.pathname === '/gcss-af/USAF/ep/browse.do') {
      res.writeHead(200, { 'content-type': 'text/html' }); return res.end(page('<h1>Links</h1><div id="main-content"></div>'))
    }
    if (url.pathname === '/gcss-af/USAF/api/quicklinks/cached') {
      const id = url.searchParams.get('id'), site = url.searchParams.get('siteId')
      if (CATEGORY_SITE[id] !== site || !session.primed.has(site)) { res.writeHead(404); return res.end() }
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ afpCategorizedLinksDto: { links: FEEDS[site] } }))
    }
    res.writeHead(404); res.end()
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ url: `http://127.0.0.1:${port}`, log, sessions, close: () => new Promise(r => server.close(r)) })
    })
  })
}
