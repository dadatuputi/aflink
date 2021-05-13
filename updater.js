const fetch = require("node-fetch")
const path = require("path")
const pug = require("pug")
const https = require("https")
const fs = require('fs').promises

const url = "https://www.my.af.mil/gcss-af/USAF/api/quicklinks/cached?categorized=true&id=p7F11BC9F789430190178946F7E140005&siteId=sD22E5184744EFC540174558CFFA50008";
(async () => {
    try {
        const ca = await fs.readFile(path.join(__dirname, "CA.cert"))
        const data = await (await fetch(url, {
            agent: new https.Agent({
                ca
            })
        })).json();
        const links = Object.values(data.afpCategorizedLinksDto.links).reduce((aggregate, category) =>
            aggregate.concat(category.map(item => { return { name: item.title, href: item.link } }))
            , [])
        console.log(links)
        const newData = pug.renderFile(path.join(__dirname, "index.pug"), { links })
        const oldData = (await fs.readFile(path.join(__dirname, "target/index.html"))).toString('utf-8')
        if (oldData !== newData) {
            console.log("Writing new data...")
            await fs.writeFile(path.join(__dirname, "target/index.html"), newData)
            console.log("Done writing new data")
        } else {
            console.log("No new data to write")
        }
    } catch (e) {
        console.log(e.message)
        if (e.type === "invalid-json") {
            console.error("Could not parse JSON, likely an error with authentication")
        } else {
            console.error(`Other error: ${e.type}`)
        }
        process.exit(1)
    }
})()