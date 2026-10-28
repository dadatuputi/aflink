// Merge one portal page's link list into links_af.json.
// Usage: node scripts/af-merge.js <links_af.json> <incoming.json> [YYYY-MM-DD]
//        node scripts/af-merge.js <links_af.json> --retire <source> [YYYY-MM-DD]
// Prints the merged file on stdout.
//
// The portal no longer has one list of every link: each page (Applications
// A-Z, the quick-link category pages) lists its own subset, and getlinks.js
// submits one page at a time. So a submission only speaks for its own page.
// Every link records the pages that list it in `sources`; a link no page lists
// any more is kept, stamped `deprecatedSince`, and shown muted until
// RETIRE_DAYS later (see scripts/link-status.js). `--retire` is for a page the
// portal has removed: its links lose that source as if it were submitted empty.
import fs from 'fs';
import { fileURLToPath } from 'url';
import { RETIRE_DAYS, daysBetween } from './link-status.js';

// The old Quick Links category everything before the 2026 portal redesign came
// from. Links with no `sources` predate source tracking and belong to it.
export const LEGACY_SOURCE = 'quicklinks:p7F11BC9F789430190178946F7E140005';

// Quick-link pages group by things like "Top 10 Searches", which say nothing
// about the link; a link only they list goes here instead.
export const QUICK_LINKS_CATEGORY = 'AF PORTAL QUICK LINKS';

// The build puts community links in OTHER (updater.js), so a portal category
// of that name, such as the "Other" functional area, is renamed.
const categoryName = name => {
    const upper = name.toUpperCase();
    return upper === 'OTHER' ? 'GENERAL' : upper;
};

// Fields a submission may update on a link it lists
const PORTAL_FIELDS = ['title', 'link', 'type', 'exitLinkReferrer', 'url', 'renderedAsFile', 'lastModified'];

const sortByTitle = list => list.sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()));

export function applySource(current, source, incomingLinks, today) {
    if (!source) throw new Error('Submission has no source; regenerate it with the current getlinks.js');
    // An index page (Applications A-Z) groups by functional area, so its
    // category wins; a quick-link page never moves an existing link.
    const isIndex = source.startsWith('index:');

    const byId = new Map();
    for (const [category, items] of Object.entries(current.afpCategorizedLinksDto.links)) {
        for (const link of items) {
            byId.set(link.contentId, { category, link: { ...link, sources: link.sources ? [...link.sources] : [LEGACY_SOURCE] } });
        }
    }

    const seen = new Set();
    for (const [group, items] of Object.entries(incomingLinks)) {
        const category = isIndex ? categoryName(group) : QUICK_LINKS_CATEGORY;
        for (const incoming of items) {
            seen.add(incoming.contentId);
            const entry = byId.get(incoming.contentId);
            if (!entry) {
                const link = { contentId: incoming.contentId, sources: [source] };
                for (const f of PORTAL_FIELDS) if (incoming[f] !== undefined) link[f] = incoming[f];
                byId.set(incoming.contentId, { category, link });
                continue;
            }
            for (const f of PORTAL_FIELDS) if (incoming[f] !== undefined) entry.link[f] = incoming[f];
            if (!entry.link.sources.includes(source)) entry.link.sources.push(source);
            delete entry.link.deprecatedSince;
            if (isIndex) entry.category = category;
        }
    }

    for (const [id, entry] of byId) {
        const { link } = entry;
        if (seen.has(id) || !link.sources.includes(source)) continue;
        link.sources = link.sources.filter(s => s !== source);
        if (link.sources.length === 0 && !link.deprecatedSince) link.deprecatedSince = today;
    }

    // Drop links past retirement here too, so the file does not grow forever;
    // the build applies the same cutoff between syncs.
    const links = {};
    for (const { category, link } of byId.values()) {
        if (link.deprecatedSince && daysBetween(link.deprecatedSince, today) > RETIRE_DAYS) continue;
        (links[category] ||= []).push(link);
    }
    const sorted = {};
    for (const category of Object.keys(links).sort()) sorted[category] = sortByTitle(links[category]);
    return { afpCategorizedLinksDto: { links: sorted } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const [currentFile, second, third, fourth] = process.argv.slice(2);
    const current = JSON.parse(fs.readFileSync(currentFile));
    let merged;
    if (second === '--retire') {
        merged = applySource(current, third, {}, fourth || new Date().toISOString().slice(0, 10));
    } else {
        const incoming = JSON.parse(fs.readFileSync(second));
        const today = third || new Date().toISOString().slice(0, 10);
        // getlinks.js submits every list at once as { pages: [...] }; one
        // page alone is the older { source, afpCategorizedLinksDto } shape
        const pages = Array.isArray(incoming.pages) ? incoming.pages : [incoming];
        merged = current;
        for (const page of pages) {
            merged = applySource(merged, page.source, page.afpCategorizedLinksDto.links, today);
        }
    }
    process.stdout.write(JSON.stringify(merged, null, 2) + '\n');
}
