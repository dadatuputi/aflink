// Compare two links_af.json files and print what an import changes.
// Usage: node scripts/af-import-stats.js <old.json> <new.json>
import fs from 'fs';

// Output is interpolated into a JS template literal in the workflow's issue
// comment; backticks or ${ in link titles would break out of it
const say = s => console.log(s.replace(/[`$]/g, "'"));

const flatten = file => {
    const links = JSON.parse(fs.readFileSync(file)).afpCategorizedLinksDto.links;
    const map = new Map();
    for (const [cat, items] of Object.entries(links)) {
        for (const l of items) map.set(l.contentId, { title: l.title, link: l.link, cat });
    }
    return map;
};

const [oldFile, newFile] = process.argv.slice(2);
const oldMap = flatten(oldFile);
const newMap = flatten(newFile);

const added = [], removed = [], changed = [];
for (const [id, l] of newMap) if (!oldMap.has(id)) added.push(l);
for (const [id, l] of oldMap) if (!newMap.has(id)) removed.push(l);
for (const [id, l] of newMap) {
    const o = oldMap.get(id);
    if (o && (o.title !== l.title || o.link !== l.link)) changed.push({ o, n: l });
}

say(`${newMap.size} links total: ${added.length} added, ${removed.length} removed, ${changed.length} changed`);
for (const l of added) say(`+ ${l.title} (${l.cat})`);
for (const l of removed) say(`- ${l.title} (${l.cat})`);
for (const { o, n } of changed) {
    if (o.title !== n.title) say(`~ title: "${o.title}" → "${n.title}"`);
    if (o.link !== n.link) say(`~ url (${n.title}): ${o.link} → ${n.link}`);
}
