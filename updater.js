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
        baseurl: "https://aflink.us",
        suggesturl: "https://aflink-autocomplete.aswang.workers.dev/search/{searchTerms}"
    }
} else {
    locals = {
        baseurl: "http://127.0.0.1:4000",
        suggesturl: "http://aflink-autocomplete.aswang.workers.dev/search/{searchTerms}"
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
    const dates = await gitDateExtractor.getStamps({files: files})
    const newest = Math.max(...Object.values(dates).map(obj => obj.modified));
    const date = sugar_date.Date.format(new Date(newest * 1000), '{d} {Month} {yyyy}')
    return date;
}

(async () => {
    try {
        const srcDir = path.resolve(process.cwd(), 'src');

        // Build links
        // combine links from the USAF and our own links
        const linksDir = path.resolve(srcDir, 'links')
        const linksAfPath = path.resolve(linksDir, 'links_af.json')
        const linksOtherPath = path.resolve(linksDir, 'links_other.json')
        const linksOverridePath = path.resolve(linksDir, 'links_override.json')

        const links_af = JSON.parse(fs.readFileSync(linksAfPath));
        const links_other = JSON.parse(fs.readFileSync(linksOtherPath));
        const links_override = JSON.parse(fs.readFileSync(linksOverridePath));
        
        // Sort other links
        const links_other_sorted = {
            OTHER: links_other.OTHER.sort((a,b) => {
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
            console.log(`Applying override: ${override.title || override.link} (${override.match})`);
            for (const category of Object.keys(links)) {
                const linkIndex = links[category].findIndex(link => {
                    switch (override.match_method) {
                        case 'Title':
                            return override.match === link.title;
                        case 'URL':
                            return override.match === link.link;
                        case 'Content ID':
                            return override.match === link.contentId;
                        case 'Fuzzy Title':
                            return link.title.toLowerCase().includes(override.match.toLowerCase());
                        default:
                            return false; // No match method specified
                    }
                });

                // If we found a match, replace it with the overridden version
                if (linkIndex !== -1) {
                    console.log(`Found override for link: ${links[category][linkIndex].title} (${links[category][linkIndex].link}) in category: ${category}`);
                    const originalLink = links[category][linkIndex];

                    // If no title or url provided in override, completely remove the link
                    if (!override.title && !override.link) {
                        console.log(`Removing link: ${originalLink.title} (${originalLink.link}) from category: ${category}`);
                        links[category].splice(linkIndex, 1); // Remove the link
                    } else {
                        
                        links[category][linkIndex] = {
                            title: override.title || originalLink.title, // Use override title if provided, otherwise keep original
                            link: override.link || originalLink.link,    // Use override link if provided, otherwise keep original
                            isOverridden: true,
                            overridden: [override.title? originalLink.title: null, override.link? originalLink.link: null].filter(Boolean).join(', ') , // Preserve originals
                            overriddenTimestamp: sugar_date.Date.format(new Date(override.timestamp * 1000), '{d} {Month} {yyyy}'),
                            // Preserve other AF link properties
                            originalTitle: originalLink.title,
                            originalLink: originalLink.link,
                            type: originalLink.type,
                            contentId: originalLink.contentId,
                            exitLinkReferrer: originalLink.exitLinkReferrer,
                            renderedAsFile: originalLink.renderedAsFile,
                            url: originalLink.url
                        };
                    }

                    override_count++;
                    break; // Exit the loop once we found a match
                }
            };
        };

        // Add other links
        links.OTHER = links_other.OTHER;
        const links_length = Object.values(links).reduce((sum, category) => sum + category.length, 0);

        // reformat links to an array, e.g.
        //[ { name: "ACQUISITION", links: [..]}, {...}, ...]
        links = Object.keys(links).map(category => {
            let cat = {}
            cat['name'] = category
            cat['links'] = links[category]
            return cat
        });

        // Add correction url to each link
        const correctionTemplateURL = "https://github.com/dadatuputi/aflink/issues/new?template=override_link.yaml"
        links.forEach(category => {
            category.links.forEach(link => {
                const url = new URL(correctionTemplateURL);
                url.searchParams.append('title', `[Override Request]: ${link.title}`);
                url.searchParams.append('match_method', 'ContentID');   // Can't actually use parameters to populate dropdown
                url.searchParams.append('match', link.contentId);
                // url.searchParams.append('new_title', link.title); // Don't use this, require user to supply new title or url
                // url.searchParams.append('new_url', link.link);
                link.correction = url.toString();
            });
        });
            
        console.log(`Combined ${links_length} links with ${override_count}/${links_override.length} overrides applied`)

        // Get links last modified date
        const dateFiles = [linksAfPath, linksOtherPath];
        if (override_count > 0) {
            dateFiles.push(linksOverridePath);
        }
        const date = await getNewestDate(dateFiles);
        console.log(`Latest update: ${date}`)


        // pug filter for base64-encoding images
        let options = {}
        options.filters = {
            'base64me': function(text, options) {
                if (options.filename) {
                    // getting file from includes filter
                    text = options.filename
                } 
                const contents = fs.readFileSync(text)
                const type = imageType(contents)
                const b64 = contents.toString('base64')
                const tag = `<img ${options.class? `class="${options.class}` : ""}" src="data:${type.mime};base64,${b64}" />`
                return tag; 
            }
        }

        // write homepage
        // make docs dir to place them in
        const outputDir = process.env.DOCS_DIR; 
        fs.mkdirSync(outputDir, { recursive: true });
	    
        const pageHome = pug.renderFile(path.resolve(srcDir, "index.pug"), { ...options, links, date })
        fs.writeFileSync(path.resolve(outputDir, "index.html"), pageHome)
        console.log("Wrote homepage")

        // write browser tutorial homepage
        const pageTutorial = pug.renderFile(path.resolve(srcDir, "tutorial.pug"), { ...options })
        const tutorialDir = path.resolve(outputDir, "tutorial")
        fs.mkdirSync(tutorialDir, { recursive: true });
        fs.writeFileSync(path.resolve(tutorialDir, "index.html"), pageTutorial)
        console.log("Wrote tutorial")

        // write overrides page
        const override_date = await getNewestDate([linksOverridePath]);
        const pageOverrides = pug.renderFile(path.resolve(srcDir, "overrides.pug"), { 
            ...options, 
            links,  // Pass the full links object
            override_date 
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

