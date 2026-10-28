// Refuse a portal sync that moves an existing link off official ground.
// Usage: node scripts/af-guard.js <old links_af.json> <new links_af.json>
//
// The direct sync endpoint is public, so a submission could point a known
// link (myPay, say) at an outside domain. check-trust.js would only warn; a
// pull request with that change should never be opened at all. A link whose
// host changes to one that is not .mil/.gov/.edu or allowlisted fails the
// run. New links on such hosts are still allowed in, and still warned about,
// because the portal does list some (shipping carriers, APAN).
import fs from 'fs';
import { hostOf as hostOfLink } from './link-status.js';

const allow = new Set(JSON.parse(fs.readFileSync('src/links/links_trust_allow.json')).allowed.map(a => a.host));
const trusted = host => /\.(mil|gov|edu)$/.test(host) || allow.has(host);
const hostOf = link => hostOfLink({ link }) || '(unparseable URL)';

export function offendingChanges(oldData, newData) {
    const before = new Map();
    for (const items of Object.values(oldData.afpCategorizedLinksDto.links)) {
        for (const l of items) before.set(l.contentId, l);
    }
    const offending = [];
    for (const items of Object.values(newData.afpCategorizedLinksDto.links)) {
        for (const l of items) {
            const o = before.get(l.contentId);
            if (!o || o.link === l.link) continue;
            const host = hostOf(l.link);
            // A path change on the host the link already used is not a move
            if (host !== hostOf(o.link) && !trusted(host)) offending.push({ title: l.title, from: o.link, to: l.link, host });
        }
    }
    return offending;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
    const [oldFile, newFile] = process.argv.slice(2);
    const offending = offendingChanges(JSON.parse(fs.readFileSync(oldFile)), JSON.parse(fs.readFileSync(newFile)));
    if (offending.length === 0) {
        console.log('Guard: no existing link moved to a non-official domain');
        process.exit(0);
    }
    console.log(`## Rejected: ${offending.length} existing link(s) would move to a non-official domain\n`);
    console.log('| Link | From | To |\n|---|---|---|');
    for (const o of offending) console.log(`| ${o.title.replace(/\|/g, '\\|')} | ${o.from} | ${o.to} (\`${o.host}\`) |`);
    console.log('\nIf this change is right, allowlist the host in `src/links/links_trust_allow.json` first, or apply it as an override.');
    process.exit(1);
}
