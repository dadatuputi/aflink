// The link list the site shows, assembled from the files in src/links/:
// portal links with overrides applied, community OTHER links, the unofficial
// section, retirement by link health, and the hand-written descriptions.
//
// Two builds run this, and both must get the same answer:
//   * updater.js, which renders the site and writes links.json
//   * search_worker/build-links.js, which bundles the list into the
//     autocomplete / MCP worker when Cloudflare Workers Builds deploys it
// so a change to how the list is assembled is made here and nowhere else.
//
// No dependencies beyond scripts/link-status.js: the worker build runs it
// without the site's node_modules. Dates the page displays are formatted by
// the caller's formatDay, since only the site needs them pretty.
import fs from 'node:fs'
import path from 'node:path'
import { linkStatus } from './link-status.js'

// The raw link files, parsed. Missing optional files read as empty.
export function readLinkFiles(linksDir) {
    const read = name => JSON.parse(fs.readFileSync(path.resolve(linksDir, name)))
    const healthPath = path.resolve(linksDir, 'link_health.json')
    return {
        af: read('links_af.json'),
        other: read('links_other.json'),
        overrides: read('links_override.json'),
        unofficial: read('links_unofficial.json'),
        descriptions: read('links_descriptions.json'),
        health: fs.existsSync(healthPath) ? read('link_health.json') : {},
    }
}

const byTitle = (a, b) => {
    a = a.title.toLowerCase()
    b = b.title.toLowerCase()
    return a < b ? -1 : a > b ? 1 : 0
}

// files: as readLinkFiles returns them (not modified).
// today: YYYY-MM-DD, for retirement.
// formatDay: (Date) => display string.
// log: progress messages (console.log in the site build).
//
// Returns { links, unofficial, overrideEvents, overrideCount, retiredCount }:
// links is { CATEGORY: [link, ...] } in page order with OTHER last.
export function assembleLinks(files, { today, formatDay = d => d.toISOString().slice(0, 10), log = () => {} }) {
    const files_ = structuredClone(files)

    const unofficialRaw = files_.unofficial.UNOFFICIAL
    let unofficial = [...unofficialRaw].sort(byTitle)
    const other = files_.other.OTHER.sort(byTitle)
    const links = files_.af.afpCategorizedLinksDto.links

    // Some AF portal links are relative paths (e.g. /gcss-af/...); make
    // them absolute before overrides record originals or URLs are built
    Object.values(links).forEach(items => items.forEach(link => {
        if (link.link && link.link.startsWith('/')) {
            link.link = 'https://www.my.af.mil' + link.link
        }
    }))

    // Apply overrides to AF links, matched by contentId, in timestamp order so
    // a link with multiple overrides ends in the newest state; each application
    // is recorded as a before/after event for the overrides page.
    const overrides = [...files_.overrides].sort((a, b) => a.timestamp - b.timestamp)
    const overrideEvents = []
    let overrideCount = 0
    for (const override of overrides) {
        const matches = Object.entries(links).flatMap(([category, items]) =>
            items
                .map((link, index) => ({ category, linkIndex: index, link }))
                .filter(result => result.link.contentId === override.match))

        if (matches.length === 0) {
            log(`Warning: No matches found for override: ${override.title || override.link || "Deletion"} (${override.match})`)
            continue
        }
        if (matches.length > 1) {
            // Fail the build rather than guess which link was meant
            throw new Error(`Found ${matches.length} links with contentId ${override.match}; there should only be one`)
        }

        overrideCount += 1
        const match = matches[0]
        const originalLink = match.link

        // When overrides chain, originalLink is the already-overridden
        // state; the true AF originals ride along on it.
        const trueOriginalTitle = originalLink.originalTitle ?? originalLink.title
        const trueOriginalLink = originalLink.originalLink ?? originalLink.link
        const newTitle = override.title || originalLink.title
        const newLink = override.link || originalLink.link
        const isDeleted = !override.title && !override.link
        const when = formatDay(new Date(override.timestamp * 1000))

        overrideEvents.push({
            timestamp: override.timestamp,
            date: when,
            beforeTitle: originalLink.title,
            beforeLink: originalLink.link,
            afterTitle: newTitle,
            afterLink: newLink,
            isDeleted,
            contentId: originalLink.contentId,
        })

        links[match.category][match.linkIndex] = {
            title: newTitle,
            link: newLink,
            isDeleted, // neither title nor link given: a deletion
            isOverridden: true,
            overridden: [newTitle !== trueOriginalTitle ? trueOriginalTitle : null, newLink !== trueOriginalLink ? trueOriginalLink : null].filter(Boolean).join(', '),
            overriddenTimestamp: when,

            // Preserve original AF link properties
            originalTitle: trueOriginalTitle,
            originalLink: trueOriginalLink,
            contentId: originalLink.contentId,
            // An override fixes the link; it does not stop its retirement clock
            deprecatedSince: originalLink.deprecatedSince,
            // The portal's description and date still describe the fixed link
            description: originalLink.description,
            lastModified: originalLink.lastModified,
        }

        log(`Applied override: ${override.title || override.link || "Deletion"} (${override.match}) to link "${originalLink.title}"`)
    }

    links.OTHER = other

    // Links the portal no longer lists stay, looking like any other, with
    // an (i) note saying since when. A link whose domain has died is
    // muted, and retired RETIRE_DAYS later; see scripts/link-status.js.
    const withStatus = list => list
        .map(link => ({ link, status: linkStatus(link, today, files_.health) }))
        .filter(({ status }) => !status.retired)
        .map(({ link, status }) => ({
            ...link,
            ...(status.unlisted && { isUnlisted: true }),
            ...(status.dead && { isDead: true }),
            ...(status.note && { statusNote: status.note }),
        }))
    let retiredCount = 0
    for (const category of Object.keys(links)) {
        const before = links[category].length
        links[category] = withStatus(links[category])
        retiredCount += before - links[category].length
        if (links[category].length === 0) delete links[category]
    }
    unofficial = withStatus(unofficial)

    // Summaries are written by hand in links_descriptions.json, keyed by
    // contentId, so a portal sync never overwrites them. The full
    // description comes from the portal when it has one, else from the
    // same file. detailMeta is the line under the title in the details
    // dialog, with the status note when the link has one.
    const descriptions = files_.descriptions.descriptions
    const describe = (link, label) => {
        const written = descriptions[link.contentId] || {}
        const marked = milOnlyMarker(link.title)
        const described = { ...link, title: marked.title }
        // A hand-set milOnly (true or false) wins over the title's marker
        const milOnly = typeof written.milOnly === 'boolean' ? written.milOnly : marked.milOnly
        if (milOnly) described.milOnly = true
        if (written.summary) described.summary = written.summary
        const description = link.description || written.description
        if (description) described.description = description
        else delete described.description
        described.detailMeta = label + (link.lastModified
            ? ' · Updated ' + formatDay(new Date(link.lastModified + 'T00:00:00Z'))
            : '') + (link.statusNote ? ' · ' + link.statusNote : '')
        return described
    }
    for (const category of Object.keys(links)) {
        links[category] = links[category].map(link => describe(link, category === 'OTHER' ? 'Community link' : category))
    }
    unofficial = unofficial.map(link => describe(link, 'Unofficial'))

    return { links, unofficial, overrideEvents, overrideCount, retiredCount }
}

// Titles say ".mil only" in many spellings: "(.mil only)", "[.mil]",
// "- .mil only", "(Tool, .mil only)", "(mil only / note)". Returns the
// title without the marker, and whether there was one. "[.mil/.com]" (works
// off .mil too) is what an unmarked link means already, so it is just dropped.
const MIL_BOTH = /\s*[[(]\s*\.mil\s*\/\s*\.com\s*[\])]\s*$/i
const MIL_SUFFIX = /\s*(?:[-–]\s*\.?mil only|[[(]\s*\.?mil(?:\s+only\??)?(?:\s*\/\s*CAC Required)?\s*[\])])\s*$/i
const MIL_INNER = /(?:,\s*\.?mil only\??(?=\s*\))|(?<=\()\s*\.?mil only\s*\/\s*)/i
export function milOnlyMarker(title) {
    title = String(title ?? '').replace(MIL_BOTH, '').trim()
    for (const re of [MIL_SUFFIX, MIL_INNER]) {
        if (re.test(title)) return { title: title.replace(re, '').trim(), milOnly: true }
    }
    return { title, milOnly: false }
}

// The links.json shape: the search worker's only view of the site, so
// whatever the page shows has to be derivable from here, including the
// unofficial section and the isDeleted flag the page filters on.
export function publishedLinks({ links, unofficial }, metadata = {}) {
    return {
        metadata: {
            ...metadata,
            numLinks: Object.values(links).reduce((sum, category) => sum + category.length, 0),
            numCategories: Object.keys(links).length,
            numUnofficial: unofficial.length,
            version: "1.1",
        },
        links: Object.keys(links).map(category => ({ category, links: links[category] })),
        // Copied field by field so links.json stays the plain data the worker expects
        unofficial: unofficial.map(link => ({
            title: link.title,
            link: link.link,
            contentId: link.contentId,
            summary: link.summary,
            description: link.description,
            ...(link.milOnly && { milOnly: true }),
        })),
    }
}
