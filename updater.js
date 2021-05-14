const fetch = require("node-fetch")
const path = require("path")
const pug = require("pug")
const https = require("https")
const fs = require('fs').promises

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
            if (attempt > maxAttempts) {
                console.log(`Failed to get new data after ${maxAttempts} attempts. Aborting.`)
                throw (e)
            } else {
                console.log(`Failed to get new data on attempt number ${attempt} of ${maxAttempts}. Retrying in 30 sec...`)
                await sleep(30000)
                attempt++;
            }
        }
    }
}



(async () => {
    try {
        const links = await getCurrentData();
        const newData = pug.renderFile(path.join(__dirname, "index.pug"), { links })
        const oldData = (await fs.readFile(path.join(__dirname, "docs/index.html"))).toString('utf-8')
        if (oldData !== newData) {
            console.log("Writing updated data...")
            await fs.writeFile(path.join(__dirname, "docs/index.html"), newData)
            console.log("Done writing updated data.")
        } else {
            console.log("No new data to update.")
        }
    } catch (e) {
        console.log(e.message)
        process.exit(1)
    }
})()

