const fetch = require("node-fetch")
const path = require("path")
const pug = require("pug")
const https = require("https")
const fs = require("fs").promises
const sugar_date = require("sugar-date")
const gitDateExtractor = require('git-date-extractor');

const file_links_af = 'src/links/links_af.json';
const file_links_other = 'src/links/links_other.json';

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



(async () => {
    try {
        // Build links
        // combine links from the USAF and our own links
        const links_af = require(`./${file_links_af}`);
        const links_other = require(`./${file_links_other}`);
        let links = links_af.afpCategorizedLinksDto.links;
        links.OTHER = links_other.OTHER;
        // reformat links to an array, e.g.
        //[ { name: "ACQUISITION", links: [..]}, {...}, ...]
        links = Object.keys(links).map(category => {
            let cat = {}
            cat['name'] = category
            cat['links'] = links[category]
            return cat
        });

        // Get links last modified date
        const dates = await gitDateExtractor.getStamps({files: [file_links_af, file_links_other]})
        const date_af = dates[file_links_af].modified
        const date_other = dates[file_links_other].modified
        const date = sugar_date.Date.format(new Date(Math.max(date_af, date_other) * 1000), '{d} {Month} {yyyy}')

        const newData = pug.renderFile(path.join(__dirname, "src/index.pug"), { links, date })
		await fs.writeFile(path.join(__dirname, "docs/index.html"), newData)
		console.log("Done writing updated data.")
    } catch (e) {
        console.log(e.message)
        process.exit(1)
    }
})()

