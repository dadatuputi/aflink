// const fetch = require("node-fetch")
// const https = require("https")
import path from 'path';
import pug from 'pug'
import fs from 'fs'
import { glob } from 'glob'
import sugar_date from 'sugar-date'
import gitDateExtractor from 'git-date-extractor'
import imageType from 'image-type'
import process from 'process'
import sharp from 'sharp'

const environment = process.env.NODE_ENV;
console.log("Node environment is: " + environment)
let locals = null;
if (environment === 'production') {
    locals = {
        baseURL: "https://aflink.us",
        suggestedURL: "https://aflink-autocomplete.aswang.workers.dev/search/{searchTerms}",
        osddShortName: "aflink",
    }
} else {
    locals = {
        baseURL: "http://localhost:4000",
        suggestedURL: "http://localhost:8787/search/{searchTerms}",
        osddShortName: "aflink-dev",
    }
}

// Until there is a way to get the list of links from USAF without a CAC/logging in, this won't work
/* 
const url = "https://www.my.af.mil/gcss-af/USAF/api/quicklinks/cached?categorized=true&id=p7F11BC9F789430190178946F7E140005&siteId=sD22E5184744EFC540174558CFFA50008";
const sleep = (time) => new Promise((res, rej) => {
    try {
        setTimeout(() => {
            res()
        }, time)
    } catch (e) {
        rej(e)
    }
});
const getCurrentData = async () => {
    const ca = await fs.readFile(path.join(__dirname, "CA.cert"))
    let data
    let attempt = 1;
    let maxAttempts = 10;
    while (true) {
        try {
            data = await (await fetch(url, {
                agent: new https.Agent({
                    ca
                })
            })).json();
            console.log(`Successfully fetched current data.`)
            return Object.values(data.afpCategorizedLinksDto.links).reduce((aggregate, category) =>
                aggregate.concat(category.map(item => { return { name: item.title, href: item.link } }))
                , [])
        } catch (e) {
            if (attempt >= maxAttempts) {
                console.log(`Failed to get new data after ${maxAttempts} attempts. Aborting.`)
                throw (e)
            } else {
                console.log(`Failed to get new data on attempt number ${attempt} of ${maxAttempts}. Retrying in 30 sec...`)
                await sleep(30000)
                attempt++;
            }
        }
    } 
}*/

async function getNewestDate(files) {
    // Get links last modified date
    const dates = await gitDateExtractor.getStamps({ files: files })
    const newest = Math.max(...Object.values(dates).map(obj => obj.modified));
    const date = sugar_date.Date.format(new Date(newest * 1000), '{d} {Month} {yyyy}')
    return date;
}

(async () => {
    try {
        const srcDir = path.resolve(process.cwd(), 'src');

        // create docs dir for output
        const outputDir = process.env.DOCS_DIR;
        fs.mkdirSync(outputDir, { recursive: true });

        // Build links
        // combine links from the USAF and our own links
        const linksDir = path.resolve(srcDir, 'links')
        const linksAfPath = path.resolve(linksDir, 'links_af.json')
        const linksOtherPath = path.resolve(linksDir, 'links_other.json')
        const linksOverridePath = path.resolve(linksDir, 'links_override.json')

        const linksUnofficialPath = path.resolve(linksDir, 'links_unofficial.json')

        const links_af = JSON.parse(fs.readFileSync(linksAfPath));
        let links_other = JSON.parse(fs.readFileSync(linksOtherPath));
        const links_override = JSON.parse(fs.readFileSync(linksOverridePath));
        // Unofficial third-party links stay out of the official links object so
        // the override/delete workflows and links.json never touch them.
        const links_unofficial_raw = JSON.parse(fs.readFileSync(linksUnofficialPath)).UNOFFICIAL
        const links_unofficial = [...links_unofficial_raw]
            .sort((a, b) => a.title.toLowerCase() < b.title.toLowerCase() ? -1 : 1);

        // The workflows append new links, so the raw (pre-sort) last element
        // names each file's most recent addition — used for the sync tooltip.
        // An in-place edit bumps the file date but keeps the last-added name;
        // close enough for a tooltip.
        const lastOtherAdd = links_other.OTHER.length ? links_other.OTHER[links_other.OTHER.length - 1].title : null;
        const lastUnofficialAdd = links_unofficial_raw.length ? links_unofficial_raw[links_unofficial_raw.length - 1].title : null;
        const newestOverride = links_override.reduce((a, b) => (!a || b.timestamp > a.timestamp) ? b : a, null);

        // Sort other links
        links_other = {
            OTHER: links_other.OTHER.sort((a, b) => {
                a = a.title.toLowerCase();
                b = b.title.toLowerCase();
                return a < b ? -1 : a > b ? 1 : 0;
            })
        }

        let links = links_af.afpCategorizedLinksDto.links;

        // Some AF portal links are relative paths (e.g. /gcss-af/...); make
        // them absolute before overrides record originals or URLs are built
        Object.values(links).forEach(items => items.forEach(link => {
            if (link.link && link.link.startsWith('/')) {
                link.link = 'https://www.my.af.mil' + link.link;
            }
        }));

        // Apply overrides to AF links - iterate through overrides looking for matches in links.
        // Apply in timestamp order so a link with multiple overrides ends in the newest state,
        // and record each application as a before/after event for the overrides page.
        links_override.sort((a, b) => a.timestamp - b.timestamp);
        const overrideEvents = [];
        let override_count = 0;
        for (const override of links_override) {
            // Search through all categories and links to find matches
            const matches = Object.entries(links).flatMap(([category, items]) => 
                 items
                    .map((link, index) => ({ category, linkIndex: index, link }))
                    .filter(result => result.link.contentId === override.match)
            );

            switch (true) {
                case matches.length == 0:
                    console.log(`Warning: No matches found for override: ${override.title || override.link || "Deletion"} (${override.match})`);
                    break;

                case matches.length == 1:
                    override_count += 1;
                    const match = matches[0];
                    const originalLink = match.link;

                    // When overrides chain, originalLink is the already-overridden
                    // state; the true AF originals ride along on it.
                    const trueOriginalTitle = originalLink.originalTitle ?? originalLink.title;
                    const trueOriginalLink = originalLink.originalLink ?? originalLink.link;
                    const newTitle = override.title || originalLink.title;
                    const newLink = override.link || originalLink.link;

                    overrideEvents.push({
                        timestamp: override.timestamp,
                        date: sugar_date.Date.format(new Date(override.timestamp * 1000), '{d} {Month} {yyyy}'),
                        beforeTitle: originalLink.title,
                        beforeLink: originalLink.link,
                        afterTitle: newTitle,
                        afterLink: newLink,
                        isDeleted: !override.title && !override.link,
                        contentId: originalLink.contentId,
                    });

                    links[match.category][match.linkIndex] = {
                        title: newTitle, // Use override title if provided, otherwise keep original
                        link: newLink,   // Use override link if provided, otherwise keep original
                        isDeleted: !override.title && !override.link, // If neither title nor link is provided, mark as deleted
                        isOverridden: true,
                        overridden: [newTitle !== trueOriginalTitle ? trueOriginalTitle : null, newLink !== trueOriginalLink ? trueOriginalLink : null].filter(Boolean).join(', '), // Preserve originals
                        overriddenTimestamp: sugar_date.Date.format(new Date(override.timestamp * 1000), '{d} {Month} {yyyy}'),

                        // Preserve original AF link properties
                        originalTitle: trueOriginalTitle,
                        originalLink: trueOriginalLink,
                        // type: originalLink.type,
                        contentId: originalLink.contentId,
                        // exitLinkReferrer: originalLink.exitLinkReferrer,
                        // renderedAsFile: originalLink.renderedAsFile,
                        // url: originalLink.url
                    };

                    console.log(`Applied override: ${override.title || override.link || "Deletion"} (${override.match}) to link "${originalLink.title}"`);
                    break;
                    
                case matches.length > 1:
                    console.log(`Error: Found ${matches.length} matches. There should only be one. Exiting.`);
                    process.exit(1); // Fail job to prevent undefined behavior
            }
        };


        // Add other links
        links.OTHER = links_other.OTHER;
        const links_length = Object.values(links).reduce((sum, category) => sum + category.length, 0);
        console.log(`Combined ${links_length} links with ${override_count}/${links_override.length} overrides applied`)


        // Sync display: the AF portal sync and the latest community link
        // change are different events — the newer one drives the visible
        // date, and the tooltip breaks out both with UTC timestamps.
        const fileStamp = async p => {
            const stamps = await gitDateExtractor.getStamps({ files: [p] });
            const s = Object.values(stamps)[0];
            return s ? Number(s.modified) : 0;
        };
        let overrideTargetName = newestOverride ? newestOverride.match : null;
        if (newestOverride) {
            for (const items of Object.values(links)) {
                const hit = items.find(l => l.contentId === newestOverride.match);
                if (hit) {
                    overrideTargetName = hit.isDeleted ? (hit.originalTitle || hit.title) : hit.title;
                    break;
                }
            }
        }
        const afSyncStamp = await fileStamp(linksAfPath);
        const lastUpdate = [
            { stamp: await fileStamp(linksOtherPath), name: lastOtherAdd },
            { stamp: await fileStamp(linksUnofficialPath), name: lastUnofficialAdd },
            { stamp: newestOverride ? Math.floor(newestOverride.timestamp) : 0, name: overrideTargetName },
        ].filter(c => c.stamp && c.name).sort((a, b) => b.stamp - a.stamp)[0];
        const utcStamp = s => new Date(s * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
        const sync_display = sugar_date.Date.format(new Date(Math.max(afSyncStamp, lastUpdate ? lastUpdate.stamp : 0) * 1000), '{d} {Month} {yyyy}');
        const sync_tooltip = `AF Portal sync: ${utcStamp(afSyncStamp)}`
            + (lastUpdate ? `\nLast link update: ${lastUpdate.name} — ${utcStamp(lastUpdate.stamp)}` : '');

        // Get links last modified date
        const dateFiles = [linksAfPath, linksOtherPath];
        if (override_count > 0) {
            dateFiles.push(linksOverridePath);
        }
        const date = await getNewestDate(dateFiles);
        console.log(`Latest update: ${date}`)


        // reformat links to an array, e.g.
        //[ { name: "ACQUISITION", links: [..]}, {...}, ...]
        links = Object.keys(links).map(category => {
            return {
                category: category,
                links: links[category]
            }
        });


        // Write links to JSON for publishing
        const links_published = {
            metadata: {
                generated: new Date().toISOString(),
                lastModified: date,
                numLinks: links_length,
                numCategories: links.length,
                overridesApplied: override_count,
                version: "1.0"
            },
            links: links
        }
        fs.writeFileSync(path.resolve(outputDir, "links.json"), JSON.stringify(links_published, null, 2));
        console.log(`Wrote links.json`);


        // Add correction url to each link (official and unofficial)
        const githubIssueBase = "https://github.com/dadatuputi/aflink/issues/new"
        const addIssueUrls = link => {
            // GitHub's issue form locks any field prefilled via query param to
            // that value — user edits revert on the form's next re-render.
            // new_title/new_url must start empty so edits stick; the current
            // values go in the reference-only current_* fields instead, where
            // the lock is harmless.
            const correction = new URL(githubIssueBase);
            correction.searchParams.append('template', '02_link_override.yaml');
            correction.searchParams.append('title', `[MODIFY]: ${link.title}`);
            correction.searchParams.append('match', link.contentId);
            correction.searchParams.append('current_title', link.title);
            correction.searchParams.append('current_url', link.link);
            link.correction = correction.toString();

            const deletion = new URL(githubIssueBase);
            deletion.searchParams.append('template', '03_link_delete.yaml');
            deletion.searchParams.append('title', `[DELETE]: ${link.title}`);
            deletion.searchParams.append('match', link.contentId);
            deletion.searchParams.append('current_title', link.title);
            deletion.searchParams.append('current_url', link.link);
            link.deletion = deletion.toString();
        };
        links.forEach(category => category.links.forEach(addIssueUrls));
        links_unofficial.forEach(addIssueUrls);

        console.log(`Combined ${links_length} links with ${override_count}/${links_override.length} overrides applied`)

        // pug filter for base64-encoding images
        let options = {}
        options.filters = {
            'base64me': function (text, options) {
                if (options.filename) {
                    // getting file from includes filter
                    text = options.filename
                }
                const contents = fs.readFileSync(text)
                const type = imageType(contents)
                const b64 = contents.toString('base64')
                const tag = `<img ${options.class ? `class="${options.class}` : ""}" src="data:${type.mime};base64,${b64}" />`
                return tag;
            }
        }

        // write homepage
        // Announcements active at build time. start/end are optional; no end
        // means permanent. The nightly analytics build doubles as the clock
        // that brings date-windowed announcements up and takes them down.
        const announcementsPath = path.resolve(srcDir, 'announcements.json')
        const buildNow = Date.now()
        const announcements = (fs.existsSync(announcementsPath)
            ? JSON.parse(fs.readFileSync(announcementsPath))
            : []).filter(a =>
                (!a.start || new Date(a.start).getTime() <= buildNow) &&
                (!a.end || buildNow <= new Date(a.end).getTime()));

        // Analytics data exists only after the nightly workflow's first commit;
        // until then the page and its footer link are simply omitted.
        const analyticsPath = path.resolve(srcDir, 'analytics.json')
        const analytics = fs.existsSync(analyticsPath)
            ? JSON.parse(fs.readFileSync(analyticsPath))
            : null;

        const pageHome = pug.renderFile(path.resolve(srcDir, "index.pug"), {
            ...options,
            links,
            unofficial: links_unofficial,
            date,
            sync_display,
            sync_tooltip,
            hasAnalytics: !!analytics,
            announcements,
            isDev: environment !== 'production'
        })
        fs.writeFileSync(path.resolve(outputDir, "index.html"), pageHome)
        console.log("Wrote homepage")

        // write browser tutorial homepage
        const pageTutorial = pug.renderFile(path.resolve(srcDir, "tutorial.pug"), { 
            ...options,
            isDev: environment !== 'production'
         })
        const tutorialDir = path.resolve(outputDir, "tutorial")
        fs.mkdirSync(tutorialDir, { recursive: true });
        fs.writeFileSync(path.resolve(tutorialDir, "index.html"), pageTutorial)
        console.log("Wrote tutorial")

        // write overrides page
        const override_date = await getNewestDate([linksOverridePath]);
        const pageOverrides = pug.renderFile(path.resolve(srcDir, "overrides.pug"), {
            ...options,
            overrideEvents: [...overrideEvents].sort((a, b) => b.timestamp - a.timestamp), // newest first
            override_date,
            isDev: environment !== 'production'
        })
        const overridesDir = path.resolve(outputDir, "overrides")
        fs.mkdirSync(overridesDir, { recursive: true });
        fs.writeFileSync(path.resolve(overridesDir, "index.html"), pageOverrides)
        console.log("Wrote overrides page")

        // write analytics page (only when the nightly pull has produced data)
        if (analytics) {
            const pageAnalytics = pug.renderFile(path.resolve(srcDir, "analytics.pug"), {
                ...options,
                analytics,
                analytics_date: sugar_date.Date.format(new Date(analytics.generated), '{d} {Month} {yyyy}'),
                analytics_utc: new Date(analytics.generated).toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
                isDev: environment !== 'production'
            })
            const analyticsDir = path.resolve(outputDir, "analytics")
            fs.mkdirSync(analyticsDir, { recursive: true });
            fs.writeFileSync(path.resolve(analyticsDir, "index.html"), pageAnalytics)
            console.log("Wrote analytics page")
        }

        // write osdd.xml
        const osdd = pug.renderFile(path.resolve(srcDir, "osdd.xml.pug"), { ...options, ...locals })
        fs.writeFileSync(path.resolve(outputDir, "osdd.xml"), osdd)
        console.log("Wrote osdd")

        // copy static dir recursively
        const staticDestDir = path.resolve(outputDir, "static");
        const staticSrcDir = path.resolve(srcDir, "static");
        fs.cpSync(staticSrcDir, staticDestDir, { recursive: true })
        console.log("Wrote static directory")

        // copy favicons
        const favicons = glob.sync(path.resolve(srcDir, "favicon*"));
        favicons.forEach(favicon => {
            const faviconFileName = path.basename(favicon)
            const faviconDestFile = path.resolve(outputDir, faviconFileName)
            fs.cpSync(favicon, faviconDestFile)
        })
        console.log("Wrote favicons")

        // PWA: rasterize favicon.svg into the manifest icon sizes, and copy
        // the manifest and service worker to the site root
        const faviconSvg = path.resolve(srcDir, "favicon.svg")
        await Promise.all([192, 512].map(size =>
            sharp(faviconSvg).resize(size, size).png()
                .toFile(path.resolve(outputDir, `icon-${size}.png`))
        ));
        fs.cpSync(path.resolve(srcDir, "manifest.json"), path.resolve(outputDir, "manifest.json"))
        fs.cpSync(path.resolve(srcDir, "sw.js"), path.resolve(outputDir, "sw.js"))
        console.log("Wrote PWA assets")


        console.log("Done writing updated data.")
    } catch (e) {
        console.log(e.message)
        process.exit(1)
    }
})()

