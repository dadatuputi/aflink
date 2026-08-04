// Weekly trust + rot check over the official link lists.
//
// Trust: every host must end in .mil/.gov or appear in links_trust_allow.json.
// Rot: conservative classification, because this runs without a CAC —
//   broken:       DNS failure, connection refused, HTTP 404/410
//   ok:           2xx/3xx, and 401/403 (reachable but gated)
//   unverifiable: timeouts, TLS/cert errors (DoD roots), 5xx, anything else —
//                 listed for information, never alerted on
//
// Output: markdown report on stdout; appends findings=<n> to $GITHUB_OUTPUT
// when set (n = untrusted + broken).
import fs from 'fs';

const AF_BASE = 'https://www.my.af.mil';
const TIMEOUT_MS = 10000;
const POOL = 10;

const af = JSON.parse(fs.readFileSync('src/links/links_af.json')).afpCategorizedLinksDto.links;
const other = JSON.parse(fs.readFileSync('src/links/links_other.json')).OTHER;
const overrides = JSON.parse(fs.readFileSync('src/links/links_override.json'));
const allow = new Set(JSON.parse(fs.readFileSync('src/links/links_trust_allow.json')).allowed_hosts);

// Check what the site actually serves: apply overrides (newest wins) and
// skip deleted links, mirroring updater.js
const byId = new Map();
for (const l of Object.values(af).flat()) byId.set(l.contentId, { title: l.title, link: l.link, deleted: false });
for (const o of [...overrides].sort((a, b) => a.timestamp - b.timestamp)) {
    const t = byId.get(o.match);
    if (!t) continue;
    if (!o.title && !o.link) t.deleted = true;
    else {
        if (o.title) t.title = o.title;
        if (o.link) t.link = o.link;
    }
}

const links = [
    ...[...byId.values()].filter(l => !l.deleted),
    ...other,
].map(l => ({
    title: l.title,
    url: l.link.startsWith('/') ? AF_BASE + l.link : l.link,
}));

const trusted = host => /\.(mil|gov)$/.test(host) || allow.has(host);

async function probe(url) {
    const attempt = async method => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
        try {
            return await fetch(url, {
                method,
                redirect: 'follow',
                signal: ctrl.signal,
                headers: { 'User-Agent': 'aflink-link-checker (+https://github.com/dadatuputi/aflink)' },
            });
        } finally {
            clearTimeout(timer);
        }
    };
    try {
        let res = await attempt('HEAD');
        if (res.status === 405 || res.status === 501) res = await attempt('GET');
        if (res.status === 404 || res.status === 410) return { verdict: 'broken', detail: `HTTP ${res.status}` };
        if (res.ok || res.status === 401 || res.status === 403) return { verdict: 'ok', detail: `HTTP ${res.status}` };
        return { verdict: 'unverifiable', detail: `HTTP ${res.status}` };
    } catch (e) {
        const code = e.cause?.code || e.name;
        if (code === 'ENOTFOUND' || code === 'ECONNREFUSED') return { verdict: 'broken', detail: code };
        return { verdict: 'unverifiable', detail: code || String(e) };
    }
}

const untrusted = [];
for (const l of links) {
    let host;
    try {
        host = new URL(l.url).hostname;
    } catch {
        untrusted.push({ ...l, host: '(unparseable URL)' });
        continue;
    }
    if (!trusted(host)) untrusted.push({ ...l, host });
}

const broken = [], unverifiable = [];
let idx = 0;
await Promise.all(Array.from({ length: POOL }, async () => {
    while (idx < links.length) {
        const l = links[idx++];
        const r = await probe(l.url);
        if (r.verdict === 'broken') broken.push({ ...l, detail: r.detail });
        else if (r.verdict === 'unverifiable') unverifiable.push({ ...l, detail: r.detail });
    }
}));

const row = l => `| ${l.title.replace(/\|/g, '\\|')} | ${l.url} | ${l.detail || l.host} |`;
const section = (title, items, header) => items.length
    ? `### ${title} (${items.length})\n\n| Link | URL | ${header} |\n|---|---|---|\n${items.map(row).join('\n')}\n`
    : `### ${title} (0)\n\nNone. ✅\n`;

console.log(`## Link check — ${links.length} official links\n`);
console.log(section('Untrusted domains', untrusted, 'Host'));
console.log(section('Broken links', broken, 'Error'));
console.log(section('Unverifiable (informational — CAC/geo-gated or transient)', unverifiable, 'Detail'));

const findings = untrusted.length + broken.length;
if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `findings=${findings}\n`);
}
console.error(`findings: ${findings} (${untrusted.length} untrusted, ${broken.length} broken, ${unverifiable.length} unverifiable)`);
