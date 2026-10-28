// Trust check over the official link lists: every host must end in
// .mil/.gov/.edu or appear in links_trust_allow.json. Reachability is
// deliberately NOT checked — many links are NIPRNet-only, so clearnet
// probing proves nothing in either direction.
//
// Audits the set as served: overrides applied newest-first, deleted links
// skipped. Unofficial links are exempt by definition.
//
// Output: markdown report on stdout; writes a warning comment body to
// /tmp/trust_warning.md and appends findings=<n> to $GITHUB_OUTPUT when set.
import fs from 'fs';
import { servedLinks } from './served-links.js';

const allowEntries = JSON.parse(fs.readFileSync('src/links/links_trust_allow.json')).allowed;
const allow = new Set(allowEntries.map(a => a.host));

const links = servedLinks();

const trusted = host => /\.(mil|gov|edu)$/.test(host) || allow.has(host);

const untrusted = links.filter(l => !trusted(l.host));

const table = items =>
    `| Link | Host |\n|---|---|\n${items.map(l => `| ${l.title.replace(/\|/g, '\\|')} | \`${l.host}\` |`).join('\n')}`;

console.log(`## Trust check — ${links.length} official links, ${allow.size} allowlisted hosts\n`);
if (untrusted.length) {
    console.log(`### ⚠️ Non-official domains (${untrusted.length})\n\n${table(untrusted)}\n`);
} else {
    console.log('No untrusted domains. ✅\n');
}

if (untrusted.length) {
    fs.writeFileSync('/tmp/trust_warning.md', [
        '⚠️ **Non-official domain warning**',
        '',
        'The following official-list link(s) point outside `.mil`/`.gov`/`.edu` and are not on the trust allowlist:',
        '',
        table(untrusted),
        '',
        'If this is a legitimate official service (contracted platform, software factory, MWR program, etc.),',
        'acknowledge it by adding the host to [`src/links/links_trust_allow.json`](https://github.com/dadatuputi/aflink/blob/master/src/links/links_trust_allow.json) with a short reason:',
        '',
        '```json',
        '{ "host": "example.com", "reason": "why this service is official" }',
        '```',
        '',
        'Otherwise, consider correcting (📝) or removing (🗑️) the link.',
    ].join('\n'));
}

if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `findings=${untrusted.length}\n`);
}
console.error(`findings: ${untrusted.length}`);
