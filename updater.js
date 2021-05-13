const fetch = require("node-fetch")
const https = require("https")
const fs = require('fs').promises

const url = "https://www.my.af.mil/gcss-af/USAF/api/quicklinks/cached?categorized=true&id=p7F11BC9F789430190178946F7E140005&siteId=sD22E5184744EFC540174558CFFA50008";
(async () => {
    try {
        const ca = await fs.readFile("./CA.cert")
        const data = await (await fetch(url, {
            agent: new https.Agent({
                ca
            })
        })).json();
        const newData = `links = ${JSON.stringify(Object.values(data.afpCategorizedLinksDto.links).reduce((aggregate, category) =>
            aggregate.concat(category.map(item => { return { name: item.title, href: item.link } }))
            , []), null, 4)}`;
        const oldData = (await fs.readFile("links.js")).toString('utf-8')
        if (oldData !== newData) {
            console.log("writing new data")
            await fs.writeFile("./links.js", newData)
        } else {
            console.log("no new data")
        }
    } catch (e) {
        console.error(e)
        process.exit(1)
    }
})()