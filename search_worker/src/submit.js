// POST /submit: getlinks.js sends a portal page's link list here, straight
// from the AF Portal, and this starts the Portal Sync workflow, which merges
// it and opens (or updates) a pull request for review.
//
// The endpoint is public, so it trusts nothing it is sent. It accepts only a
// list in the links_af.json shape from a known portal page, re-serializes just
// the fields the sync reads, caps size and rate, and ignores repeats. The one
// secret, GITHUB_DISPATCH_TOKEN, is a fine-grained token with Actions: write
// on the aflink repo alone: enough to start a workflow, not to push code.
// Nothing here changes the site; the workflow's pull request still needs a
// human to merge it.

export const ORIGINS = ['https://www.my.af.mil', 'https://my.af.mil']
// Portal pages the sync accepts. A new page is added here (and in the Update
// AF Links issue form) once someone has looked at it.
export const KNOWN_SOURCES = [
  'index:manageApplications',                       // Applications A-Z
  'quicklinks:p44C00E3C94DB4A210194DC84A9E10002',   // Home: Temporary Links Information
  'quicklinks:pAF429CFD945FB19F0194605EE6410002',   // Career and Training links
  'quicklinks:pAF429CFD945FB19F019460FC9A650026',   // Life and Fitness Quick Links
]
export const LIMITS = {
  bodyBytes: 512 * 1024,
  categories: 60,
  links: 2000,
  title: 300,
  url: 2000,
  perIpPerHour: 6,
  perDay: 40,
}
const CONTENT_ID = /^c[0-9A-F]{32}$/
const DEFAULT_REPO = 'dadatuputi/aflink'
const WORKFLOW = 'portal_sync.yml'
const HOUR = 60 * 60
const DAY = 24 * HOUR

const json = (status, body, origin) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json;charset=UTF-8', ...cors(origin) },
})

const cors = origin => ORIGINS.includes(origin) ? {
  'access-control-allow-origin': origin,
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'vary': 'origin',
} : {}

// The payload as the sync will see it: known fields only, every value checked.
// Returns { source, links } or throws with a message safe to send back.
export function sanitize(body) {
  if (!body || typeof body !== 'object') throw new Error('Expected a JSON object')
  const { source } = body
  if (!KNOWN_SOURCES.includes(source)) throw new Error('Unknown portal page; run getlinks.js on one of the pages listed in the Update AF Links issue form')
  const groups = body.afpCategorizedLinksDto?.links
  if (!groups || typeof groups !== 'object' || Array.isArray(groups)) throw new Error('Missing afpCategorizedLinksDto.links')
  const names = Object.keys(groups)
  if (names.length === 0 || names.length > LIMITS.categories) throw new Error(`Expected 1 to ${LIMITS.categories} categories`)

  const links = {}
  const seen = new Set()
  let count = 0
  for (const name of names) {
    if (typeof name !== 'string' || !name.trim() || name.length > LIMITS.title) throw new Error('Bad category name')
    const items = groups[name]
    if (!Array.isArray(items)) throw new Error(`Category ${JSON.stringify(name)} is not a list`)
    links[name] = items.map(item => {
      if (++count > LIMITS.links) throw new Error(`More than ${LIMITS.links} links`)
      if (!item || typeof item !== 'object') throw new Error('Bad link entry')
      const { contentId, title, link } = item
      if (typeof contentId !== 'string' || !CONTENT_ID.test(contentId)) throw new Error('Bad contentId')
      if (seen.has(contentId)) throw new Error(`Duplicate contentId ${contentId}`)
      seen.add(contentId)
      if (typeof title !== 'string' || !title.trim() || title.length > LIMITS.title) throw new Error(`Bad title for ${contentId}`)
      if (typeof link !== 'string' || link.length > LIMITS.url || !(link.startsWith('/') || /^https?:\/\/[^\s]+$/.test(link))) throw new Error(`Bad URL for ${contentId}`)
      const clean = { title: title.trim(), link: link.trim(), contentId }
      if (item.type === 'application' || item.type === 'portalFavorite') clean.type = item.type
      if (typeof item.exitLinkReferrer === 'string' && item.exitLinkReferrer.length <= LIMITS.url) clean.exitLinkReferrer = item.exitLinkReferrer
      if (typeof item.url === 'boolean') clean.url = item.url
      if (typeof item.renderedAsFile === 'boolean') clean.renderedAsFile = item.renderedAsFile
      if (typeof item.lastModified === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.lastModified)) clean.lastModified = item.lastModified
      return clean
    })
  }
  if (count === 0) throw new Error('No links')
  return { source, links }
}

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

// gzip + base64, the encoding the issue form already uses, so the workflow
// decodes both routes the same way; it also keeps the dispatch input well
// under GitHub's 64 KB cap
async function pack(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer())
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

// KV counters: eventually consistent, which is fine for a nuisance limit
async function overLimit(env, key, limit, ttl) {
  const n = Number(await env.LINKS.get(key)) || 0
  if (n >= limit) return true
  await env.LINKS.put(key, String(n + 1), { expirationTtl: ttl })
  return false
}

export async function handleSubmit(request, env) {
  const origin = request.headers.get('origin') || ''
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) })
  if (request.method !== 'POST') return json(405, { ok: false, error: 'POST only' }, origin)
  if (!ORIGINS.includes(origin)) return json(403, { ok: false, error: 'Submissions are accepted from the AF Portal only' }, origin)
  if (!env.GITHUB_DISPATCH_TOKEN) return json(503, { ok: false, error: 'Direct sync is not configured; use the Update AF Links issue form' }, origin)

  const length = Number(request.headers.get('content-length')) || 0
  if (length > LIMITS.bodyBytes) return json(413, { ok: false, error: 'Payload too large' }, origin)
  const text = await request.text()
  if (text.length > LIMITS.bodyBytes) return json(413, { ok: false, error: 'Payload too large' }, origin)

  let payload
  try {
    payload = sanitize(JSON.parse(text))
  } catch (e) {
    return json(400, { ok: false, error: e.message }, origin)
  }

  const ip = request.headers.get('cf-connecting-ip') || 'unknown'
  if (await overLimit(env, `submit:ip:${await sha256(ip)}`, LIMITS.perIpPerHour, HOUR)) {
    return json(429, { ok: false, error: 'Too many submissions from this address; try again in an hour' }, origin)
  }
  if (await overLimit(env, 'submit:day', LIMITS.perDay, DAY)) {
    return json(429, { ok: false, error: 'Daily submission limit reached; try again tomorrow' }, origin)
  }

  const serialized = JSON.stringify({ source: payload.source, afpCategorizedLinksDto: { links: payload.links } })
  const count = Object.values(payload.links).reduce((n, l) => n + l.length, 0)
  const hash = await sha256(serialized)
  const repo = env.GITHUB_REPO || DEFAULT_REPO
  const pulls = `https://github.com/${repo}/pulls`
  if (await env.LINKS.get(`submit:hash:${hash}`)) {
    return json(200, { ok: true, repeated: true, count, source: payload.source, message: `Already received this exact list today. Pull requests: ${pulls}` }, origin)
  }

  const dispatch = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
      'accept': 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'aflink-sync-worker',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ ref: env.GITHUB_REF || 'master', inputs: { payload: await pack(serialized), source: payload.source, digest: hash.slice(0, 12) } }),
  })
  if (dispatch.status !== 204) {
    console.error('dispatch failed', dispatch.status, await dispatch.text())
    return json(502, { ok: false, error: `Could not start the sync (GitHub answered ${dispatch.status}); use the Update AF Links issue form` }, origin)
  }
  await env.LINKS.put(`submit:hash:${hash}`, '1', { expirationTtl: DAY })
  return json(200, { ok: true, count, source: payload.source, message: `Received ${count} links. A pull request will appear within a few minutes: ${pulls}` }, origin)
}
