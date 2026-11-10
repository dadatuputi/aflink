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
import { RETIRE_DAYS } from './scripts/link-status.js'
import { readLinkFiles, assembleLinks, publishedLinks } from './scripts/assemble-links.js'

const environment = process.env.NODE_ENV;
console.log("Node environment is: " + environment)
let locals = null;
if (environment === 'production') {
    locals = {
        baseURL: "https://aflink.us",
        suggestedURL: "https://api.aflink.us/search/{searchTerms}",
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

// A git timestamp (seconds) as the page shows dates
const formatDay = seconds => sugar_date.Date.format(new Date(seconds * 1000), '{d} {Month} {yyyy}');

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

        const files = readLinkFiles(linksDir);
        // The workflows append new links, so the raw (pre-sort) last element
        // names each file's most recent addition — used for the sync tooltip.
        // An in-place edit bumps the file date but keeps the last-added name;
        // close enough for a tooltip.
        const lastOtherAdd = files.other.OTHER.length ? files.other.OTHER[files.other.OTHER.length - 1].title : null;
        const lastUnofficialAdd = files.unofficial.UNOFFICIAL.length ? files.unofficial.UNOFFICIAL[files.unofficial.UNOFFICIAL.length - 1].title : null;
        const newestOverride = files.overrides.reduce((a, b) => (!a || b.timestamp > a.timestamp) ? b : a, null);

        // Overrides, OTHER links, the unofficial section, retirement and
        // descriptions: scripts/assemble-links.js, shared with the search
        // worker's build so the two lists cannot drift. Unofficial links stay
        // out of the official links object so the override/delete workflows
        // never walk them.
        const today = new Date().toISOString().slice(0, 10);
        const assembled = assembleLinks(files, {
            today,
            formatDay: d => sugar_date.Date.format(d, '{d} {Month} {yyyy}'),
            log: console.log,
        });
        let links = assembled.links;
        const links_unofficial = assembled.unofficial;
        const overrideEvents = assembled.overrideEvents;
        const override_count = assembled.overrideCount;
        console.log(`Retired ${assembled.retiredCount} links past ${RETIRE_DAYS} days`)

        const links_length = Object.values(links).reduce((sum, category) => sum + category.length, 0);
        console.log(`Combined ${links_length} links with ${override_count}/${files.overrides.length} overrides applied`)


        // Sync display: the AF portal sync and the latest community link
        // change are different events — the newer one drives the visible
        // date, and the tooltip breaks out both with UTC timestamps.
        // One git pass covers every link file; git-date-extractor walks the
        // whole history per call
        const stamps = await gitDateExtractor.getStamps({ files: [linksAfPath, linksOtherPath, linksUnofficialPath, linksOverridePath] });
        const fileStamp = p => {
            const s = stamps[p] || Object.entries(stamps).find(([k]) => p.endsWith(k))?.[1];
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
        const afSyncStamp = fileStamp(linksAfPath);
        const lastUpdate = [
            { stamp: fileStamp(linksOtherPath), name: lastOtherAdd },
            { stamp: fileStamp(linksUnofficialPath), name: lastUnofficialAdd },
            { stamp: newestOverride ? Math.floor(newestOverride.timestamp) : 0, name: overrideTargetName },
        ].filter(c => c.stamp && c.name).sort((a, b) => b.stamp - a.stamp)[0];
        const utcStamp = s => new Date(s * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
        // The visible date is the AF portal sync (transparency about source
        // freshness); community link changes, possibly newer, live in the tooltip
        const sync_display = sugar_date.Date.format(new Date(afSyncStamp * 1000), '{d} {Month} {yyyy}');
        const sync_tooltip = `AF Portal sync: ${utcStamp(afSyncStamp)}`
            + (lastUpdate ? `\nLast link update: ${lastUpdate.name} — ${utcStamp(lastUpdate.stamp)}` : '');

        // Get links last modified date
        const dateFiles = [linksAfPath, linksOtherPath];
        if (override_count > 0) {
            dateFiles.push(linksOverridePath);
        }
        const date = formatDay(Math.max(...dateFiles.map(fileStamp)));
        console.log(`Latest update: ${date}`)


        // Write links to JSON for publishing: the search worker's view of the
        // site (its build assembles the same list; see search_worker/README.md)
        const links_published = publishedLinks({ links, unofficial: links_unofficial }, {
            generated: new Date().toISOString(),
            lastModified: date,
            overridesApplied: override_count,
        });

        // reformat links to an array, e.g.
        //[ { name: "ACQUISITION", links: [..]}, {...}, ...]
        links = links_published.links;

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


        // pug filter for base64-encoding images
        let options = {}
        // The site's one description, shown by search engines and link
        // previews (head.pug); package.json is its single source
        options.siteDescription = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'))).description
        options.filters = {
            'base64me': function (text, options) {
                if (options.filename) {
                    // getting file from includes filter
                    text = options.filename
                }
                const img = (file, extraClass) => {
                    const contents = fs.readFileSync(file)
                    const type = imageType(contents)
                    const cls = [options.class, extraClass].filter(Boolean).join(' ')
                    return `<img${cls ? ` class="${cls}"` : ''} src="data:${type.mime};base64,${contents.toString('base64')}" />`
                }
                // `themed`: also inline the -dark variant (foo.png → foo-dark.png)
                // if there is one; site.css shows whichever matches the theme
                const dark = text.replace(/(\.[^.]+)$/, '-dark$1')
                if (options.themed && fs.existsSync(dark)) {
                    return img(text, 'theme-img-light') + img(dark, 'theme-img-dark')
                }
                return img(text);
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
        const override_date = formatDay(fileStamp(linksOverridePath));
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
        // Served as-is: /.well-known/ (the MCP Registry's proof that aflink.us
        // publishes us.aflink/*), and the Jekyll config that keeps it
        fs.cpSync(path.resolve(srcDir, "_config.yml"), path.resolve(outputDir, "_config.yml"))
        const wellKnown = path.resolve(srcDir, ".well-known")
        if (fs.existsSync(wellKnown)) {
            fs.cpSync(wellKnown, path.resolve(outputDir, ".well-known"), { recursive: true })
            console.log("Wrote .well-known")
        }
        console.log("Wrote PWA assets")


        console.log("Done writing updated data.")
    } catch (e) {
        console.error(e)
        process.exit(1)
    }
})()

