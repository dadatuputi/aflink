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

        const links_af = JSON.parse(fs.readFileSync(linksAfPath));
        let links_other = JSON.parse(fs.readFileSync(linksOtherPath));
        const links_override = JSON.parse(fs.readFileSync(linksOverridePath));

        // Sort other links
        links_other = {
            OTHER: links_other.OTHER.sort((a, b) => {
                a = a.title.toLowerCase();
                b = b.title.toLowerCase();
                return a < b ? -1 : a > b ? 1 : 0;
            })
        }

        let links = links_af.afpCategorizedLinksDto.links;

        // Apply overrides to AF links - iterate through overrides looking for matches in links
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

                    links[match.category][match.linkIndex] = {
                        title: override.title || originalLink.title, // Use override title if provided, otherwise keep original
                        link: override.link || originalLink.link,    // Use override link if provided, otherwise keep original
                        isDeleted: !override.title && !override.link, // If neither title nor link is provided, mark as deleted
                        isOverridden: true,
                        overridden: [override.title ? originalLink.title : null, override.link ? originalLink.link : null].filter(Boolean).join(', '), // Preserve originals
                        overriddenTimestamp: sugar_date.Date.format(new Date(override.timestamp * 1000), '{d} {Month} {yyyy}'),
                        
                        // Preserve original AF link properties
                        originalTitle: originalLink.title,
                        originalLink: originalLink.link,
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


        // Add correction url to each link
        const githubIssueBase = "https://github.com/dadatuputi/aflink/issues/new"
        links.forEach(category => {
            category.links.forEach(link => {
                const correction = new URL(githubIssueBase);
                correction.searchParams.append('template', '02_link_override.yaml');
                correction.searchParams.append('title', `[MODIFY]: ${link.title}`);
                correction.searchParams.append('match', link.contentId);
                correction.searchParams.append('new_title', link.title);
                correction.searchParams.append('new_url', link.link);
                link.correction = correction.toString();

                const deletion = new URL(githubIssueBase);
                deletion.searchParams.append('template', '03_link_delete.yaml');
                deletion.searchParams.append('title', `[DELETE]: ${link.title}`);
                deletion.searchParams.append('match', link.contentId);
                link.deletion = deletion.toString();
            });
        });

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
        const pageHome = pug.renderFile(path.resolve(srcDir, "index.pug"), { 
            ...options, 
            links, 
            date,
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
            links,  // Pass the full links object
            override_date,
            isDev: environment !== 'production'
        })
        const overridesDir = path.resolve(outputDir, "overrides")
        fs.mkdirSync(overridesDir, { recursive: true });
        fs.writeFileSync(path.resolve(overridesDir, "index.html"), pageOverrides)
        console.log("Wrote overrides page")

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


        console.log("Done writing updated data.")
    } catch (e) {
        console.log(e.message)
        process.exit(1)
    }
})()

