// The link set as the site serves it, for the audit scripts: AF portal links
// with overrides applied newest-last (so the newest wins) and deletions
// dropped, then the community OTHER links, then optionally the unofficial
// list. Relative portal links are made absolute and each entry gets its
// parsed host ('(unparseable URL)' when the URL does not parse).
import fs from 'fs';
import path from 'path';

const AF_BASE = 'https://www.my.af.mil';

const read = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, name)));

export function servedLinks({ dir = 'src/links', unofficial = false } = {}) {
    const af = read(dir, 'links_af.json').afpCategorizedLinksDto.links;
    const other = read(dir, 'links_other.json').OTHER;
    const overrides = read(dir, 'links_override.json');

    const byId = new Map();
    for (const l of Object.values(af).flat()) byId.set(l.contentId, { title: l.title, link: l.link, deleted: false });
    for (const o of [...overrides].sort((a, b) => a.timestamp - b.timestamp)) {
        const t = byId.get(o.match);
        if (!t) continue;
        if (!o.title && !o.link) t.deleted = true;
        else {
            if (o.title) t.title = o.title;
            if (o.link) t.link = o.link;
        }
    }

    return [
        ...[...byId.values()].filter(l => !l.deleted),
        ...other,
        ...(unofficial ? read(dir, 'links_unofficial.json').UNOFFICIAL : []),
    ].map(l => withHost(l.title, l.link.startsWith('/') ? AF_BASE + l.link : l.link));
}

export function withHost(title, url) {
    let host;
    try {
        host = new URL(url).hostname;
    } catch {
        host = '(unparseable URL)';
    }
    return { title, url, host };
}
