// Reputation scan over every served link whose host is outside .mil/.gov:
// contractor, .edu and unofficial hosts alike, allowlisted or not, since an
// allowlisted domain can still lapse or be compromised. Complements
// check-trust.js, which asks whether a host belongs on the list at all; this
// asks whether it is known-bad right now.
//
// Two passes, chosen with --source (default: both, in this order):
//   google      Google Safe Browsing v4 Lookup (SAFE_BROWSING_KEY). One
//               request covers every URL, so it reports in seconds.
//   virustotal  VirusTotal domain report per host (VT_API_KEY; skipped when
//               unset). Free tier is 4/min and 500/day, so lookups are spaced
//               out and a 429 waits a minute and retries.
// The weekly workflow runs them as separate jobs so a Safe Browsing hit is
// raised without waiting on VirusTotal. SCAN_URL limits the scan to one URL,
// for the submission workflows; it also writes a safe/unsafe verdict for that
// URL to /tmp/reputation_verdict.md, whatever the outcome.
//
// Output: markdown report on stdout; writes a warning comment body to
// /tmp/reputation_warning.md and appends findings=<n> to $GITHUB_OUTPUT when
// set. Exits non-zero when a source errors, so a broken key is not silent.
import fs from 'fs';
import { fileURLToPath } from 'url';
import { servedLinks, withHost } from './served-links.js';

const SB_THREATS = ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE', 'POTENTIALLY_HARMFUL_APPLICATION'];
const VT_INTERVAL_MS = 15_500;
const VT_RETRY_MS = 61_000;
// A lone engine flagging a domain is routine noise; two agreeing is a signal
export const VT_THRESHOLD = 2;

export const inScope = host => host !== '(unparseable URL)' && !/\.(mil|gov)$/.test(host);

// Each link's own URL plus its host root, so a host-wide listing is caught too
export function lookupUrls(links) {
    return [...new Set(links.flatMap(l => [l.url, `https://${l.host}/`]))];
}

export async function safeBrowsing(urls, key) {
    const res = await fetch(`https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            client: { clientId: 'aflink', clientVersion: '1.0' },
            threatInfo: {
                threatTypes: SB_THREATS,
                platformTypes: ['ANY_PLATFORM'],
                threatEntryTypes: ['URL'],
                threatEntries: urls.map(url => ({ url })),
            },
        }),
    });
    if (!res.ok) throw new Error(`Safe Browsing: HTTP ${res.status} ${await res.text()}`);
    return (await res.json()).matches ?? [];
}

export async function virusTotal(host, key, { retryMs = VT_RETRY_MS } = {}) {
    let res = await vtFetch(host, key);
    if (res.status === 429) {
        console.error(`VirusTotal rate limit on ${host}; retrying in ${retryMs / 1000}s`);
        await sleep(retryMs);
        res = await vtFetch(host, key);
    }
    if (res.status === 404) return null; // never seen by VirusTotal
    if (!res.ok) throw new Error(`VirusTotal ${host}: HTTP ${res.status}`);
    const { malicious = 0, suspicious = 0 } = (await res.json()).data.attributes.last_analysis_stats;
    return { malicious, suspicious };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function vtFetch(host, key) {
    return fetch(`https://www.virustotal.com/api/v3/domains/${encodeURIComponent(host)}`, {
        headers: { 'x-apikey': key },
    });
}

// Safe Browsing matches → one finding per affected link (a host-root match
// marks every link on that host)
export function sbFindings(links, matches) {
    const findings = [];
    for (const l of links) {
        const hit = matches.find(m => m.threat.url === l.url || m.threat.url === `https://${l.host}/`);
        if (hit) findings.push({ ...l, source: 'Safe Browsing', verdict: hit.threatType });
    }
    return findings;
}

export function vtFlagged(stats) {
    return !!stats && stats.malicious + stats.suspicious >= VT_THRESHOLD;
}

// Public report pages, so a reader can see the evidence behind a verdict
export const googleReport = url => `https://transparencyreport.google.com/safe-browsing/search?url=${encodeURIComponent(url)}`;
export const vtReport = host => `https://www.virustotal.com/gui/domain/${encodeURIComponent(host)}`;
const reports = (url, host) => `Reports: [Google Safe Browsing](${googleReport(url)}) · [VirusTotal](${vtReport(host)})`;

// The comment posted on a link request: always says what was concluded
export function verdict({ url, host, findings, sources }) {
    const code = `\`${url.replace(/`/g, '')}\``;
    if (host === '(unparseable URL)')
        return `⚠️ **Link check: not a valid URL.** ${code} could not be parsed, so it was not scanned.`;
    if (!inScope(host))
        return `✅ **Link check: official domain.** \`${host}\` is a .mil/.gov host, so no reputation scan is needed.`;
    if (findings.length)
        return `⚠️ **Link check: UNSAFE.** ${code} was flagged (checked with ${sources}):\n\n${table(findings)}\n\n` +
            'Check the site before approving: a flag can be a false positive, or the domain may have changed hands.\n\n' +
            reports(url, host);
    return `✅ **Link check: safe.** ${code} has no known malware or phishing listings (${sources}).\n\n${reports(url, host)}`;
}

const table = items =>
    `| Link | Host | Source | Verdict |\n|---|---|---|---|\n${items.map(f =>
        `| ${f.title.replace(/\|/g, '\\|')} | \`${f.host}\` | [${f.source}](${f.source === 'VirusTotal' ? vtReport(f.host) : googleReport(f.url)}) | ${f.verdict} |`).join('\n')}`;

async function googlePass(links) {
    const key = process.env.SAFE_BROWSING_KEY;
    if (!key) throw new Error('SAFE_BROWSING_KEY is not set');
    return links.length ? sbFindings(links, await safeBrowsing(lookupUrls(links), key)) : [];
}

async function virusTotalPass(links) {
    const key = process.env.VT_API_KEY;
    if (!key) return null;
    const findings = [];
    const hosts = [...new Set(links.map(l => l.host))];
    for (const [i, host] of hosts.entries()) {
        if (i) await sleep(VT_INTERVAL_MS);
        const stats = await virusTotal(host, key);
        if (vtFlagged(stats)) {
            for (const l of links.filter(x => x.host === host))
                findings.push({ ...l, source: 'VirusTotal', verdict: `${stats.malicious} malicious, ${stats.suspicious} suspicious` });
        }
    }
    return findings;
}

const PASSES = { google: ['Safe Browsing', googlePass], virustotal: ['VirusTotal', virusTotalPass] };

async function main() {
    const arg = process.argv.find(a => a.startsWith('--source='))?.split('=')[1];
    if (arg && !PASSES[arg]) throw new Error(`--source must be one of: ${Object.keys(PASSES).join(', ')}`);
    const only = process.env.SCAN_URL?.trim();

    const served = servedLinks({ unofficial: true });
    // A request issue's URL is not on the site yet; a merged one is, with a title
    const target = only && (served.find(l => l.url === only) ?? withHost(only, only));
    const links = (only ? [target] : served).filter(l => inScope(l.host));
    const hosts = new Set(links.map(l => l.host));

    const findings = [];
    const ran = [];
    for (const [name, pass] of arg ? [PASSES[arg]] : Object.values(PASSES)) {
        const found = await pass(links);
        if (found === null) {
            console.error(`${name}: skipped (no API key)`);
            continue;
        }
        ran.push(name);
        findings.push(...found);
    }

    const sources = ran.join(' + ') || 'no sources';
    console.log(`## Reputation scan: ${links.length} links on ${hosts.size} non-.mil/.gov hosts (${sources})\n`);
    if (findings.length) {
        console.log(`### ⚠️ Flagged (${findings.length})\n\n${table(findings)}\n`);
        fs.writeFileSync('/tmp/reputation_warning.md', [
            '⚠️ **Link reputation warning**',
            '',
            `These link(s) were flagged by ${sources}:`,
            '',
            table(findings),
            '',
            'Check the site before acting: a flag can be a false positive, or the domain may have changed hands.',
            'If the link is bad, correct (📝) or remove (🗑️) it from the site.',
        ].join('\n'));
    } else {
        console.log('Nothing flagged. ✅\n');
    }

    if (target) {
        fs.writeFileSync('/tmp/reputation_verdict.md', verdict({ url: only, host: target.host, findings, sources }));
    }

    if (process.env.GITHUB_OUTPUT) {
        fs.appendFileSync(process.env.GITHUB_OUTPUT, `findings=${findings.length}\n`);
    }
    console.error(`findings: ${findings.length}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main().catch(err => {
        console.error(err.message);
        process.exit(1);
    });
}
