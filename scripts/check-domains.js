// Weekly dead-domain check over every link list.
// Usage: node scripts/check-domains.js [YYYY-MM-DD]
//
// Reachability says nothing here: many links are NIPRNet-only, and sites go
// down for a day. A domain that no longer exists in public DNS is the one
// failure a GitHub runner can observe with certainty, so that is all this
// counts, and only when
//   - both resolvers (Cloudflare and Google) answer "no such domain",
//   - the domain resolved on some earlier run (internal-only names, which
//     never resolve publicly, are never counted), and
//   - it happens on STRIKES runs in a row; any success resets the count.
// Then every link on that domain is dead since the first failed run, which
// starts the same retirement clock as a portal deprecation; see
// scripts/link-status.js. Timeouts and other DNS errors change nothing.
//
// The only state is src/links/link_health.json, which the build reads; the
// link files are never touched, so their dates still mean "last sync". Writes a
// markdown summary to stdout, and to /tmp/dead_domains.md when a domain newly
// reaches STRIKES.
import fs from 'fs';
import dns from 'dns';
import { fileURLToPath } from 'url';
import { STRIKES, hostOf, deadSince } from './link-status.js';

const RESOLVERS = [['1.1.1.1', '1.0.0.1'], ['8.8.8.8', '8.8.4.4']];

const FILES = {
    af: 'src/links/links_af.json',
    other: 'src/links/links_other.json',
    unofficial: 'src/links/links_unofficial.json',
};
const HEALTH = 'src/links/link_health.json';

// Every link object in a link file, whatever its shape
const linksOf = data => data.afpCategorizedLinksDto
    ? Object.values(data.afpCategorizedLinksDto.links).flat()
    : Object.values(data).flat();

// 'ok' | 'nxdomain' | 'error' from one resolver
async function lookup(resolver, host) {
    for (const type of ['A', 'AAAA', 'CNAME']) {
        try {
            await resolver.resolve(host, type);
            return 'ok';
        } catch (e) {
            // The name exists but has no record of this type
            if (e.code === 'ENODATA') continue;
            if (e.code === 'ENOTFOUND') return 'nxdomain';
            return 'error';
        }
    }
    // Exists, with no address records of the types asked for
    return 'ok';
}

// 'ok' if any resolver finds it, 'nxdomain' only if all say so, else 'unknown'
export const combine = results =>
    results.includes('ok') ? 'ok' : results.every(r => r === 'nxdomain') ? 'nxdomain' : 'unknown';

// Fold one run's result for a host into its health record
export function nextHealth(prev = { seen: false, strikes: 0 }, result, today) {
    const h = { ...prev };
    if (result === 'ok') {
        h.seen = true;
        h.strikes = 0;
        delete h.failingSince;
    } else if (result === 'nxdomain' && h.seen) {
        h.strikes += 1;
        h.failingSince ||= today;
    }
    h.lastResult = result;
    h.lastChecked = today;
    return h;
}

async function main(today) {
    const data = Object.fromEntries(Object.entries(FILES).map(([k, f]) => [k, JSON.parse(fs.readFileSync(f))]));
    const health = fs.existsSync(HEALTH) ? JSON.parse(fs.readFileSync(HEALTH)) : {};

    const hosts = new Set();
    // Overrides can point a link at a new domain; check those as well
    const overrides = JSON.parse(fs.readFileSync('src/links/links_override.json')).filter(o => o.link);
    for (const l of [...Object.values(data).flatMap(linksOf), ...overrides]) { const h = hostOf(l); if (h) hosts.add(h); }

    const resolvers = RESOLVERS.map(servers => {
        const r = new dns.promises.Resolver({ timeout: 5000, tries: 2 });
        r.setServers(servers);
        return r;
    });

    const counts = { ok: 0, nxdomain: 0, unknown: 0 };
    const newlyDead = [];
    for (const host of [...hosts].sort()) {
        const result = combine(await Promise.all(resolvers.map(r => lookup(r, host))));
        counts[result]++;
        const before = health[host]?.strikes ?? 0;
        health[host] = nextHealth(health[host], result, today);
        if (before < STRIKES && health[host].strikes >= STRIKES) newlyDead.push(host);
    }
    // Forget hosts no link uses any more
    for (const host of Object.keys(health)) if (!hosts.has(host)) delete health[host];

    const dead = [];
    for (const d of Object.values(data)) {
        for (const link of linksOf(d)) {
            const since = deadSince(link, health);
            if (since) dead.push({ title: link.title, host: hostOf(link), since });
        }
    }
    const sorted = Object.fromEntries(Object.keys(health).sort().map(h => [h, health[h]]));
    fs.writeFileSync(HEALTH, JSON.stringify(sorted, null, 2) + '\n');

    const neverSeen = Object.entries(health).filter(([, h]) => !h.seen).map(([host]) => host);
    const striking = Object.entries(health).filter(([, h]) => h.strikes > 0 && h.strikes < STRIKES);
    const row = cells => `| ${cells.map(c => String(c).replace(/\|/g, '\\|')).join(' | ')} |`;
    let md = `## Dead-domain check — ${hosts.size} domains\n\n`
        + `${counts.ok} resolve, ${counts.nxdomain} do not exist, ${counts.unknown} inconclusive (timeouts and other DNS errors are ignored).\n\n`;
    if (striking.length) md += `### On a strike (${striking.length})\n\n| Domain | Strikes | Failing since |\n|---|---|---|\n${striking.map(([h, s]) => row([h, `${s.strikes}/${STRIKES}`, s.failingSince])).join('\n')}\n\n`;
    if (dead.length) md += `### Retiring: domain gone ${STRIKES}+ runs (${dead.length} links)\n\n| Link | Domain | Since |\n|---|---|---|\n${dead.map(l => row([l.title, l.host, l.since])).join('\n')}\n\n`;
    if (neverSeen.length) md += `### Never resolved publicly (${neverSeen.length}, not counted)\n\nInternal-only names, or dead before the first check; review by hand.\n\n${neverSeen.map(h => `- \`${h}\``).join('\n')}\n`;
    console.log(md);

    if (newlyDead.length) {
        fs.writeFileSync('/tmp/dead_domains.md',
            `These domains have not existed in public DNS for ${STRIKES} weekly runs in a row. Their links are now muted on the site and will retire 180 days after they first failed, unless the domain comes back.\n\n`
            + newlyDead.map(h => `- \`${h}\` (failing since ${health[h].failingSince})`).join('\n')
            + `\n\nTo keep a link, fix its URL with an override.`);
    }
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `newly_dead=${newlyDead.length}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main(process.argv[2] || new Date().toISOString().slice(0, 10)).catch(e => { console.error(e); process.exit(1); });
}
