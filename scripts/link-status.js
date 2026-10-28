// Lifecycle of a link the portal no longer lists, or whose domain is gone.
//   deprecatedSince — the sync found no portal page that lists it any more
//                     (stored on the link by scripts/af-merge.js). The link
//                     stays, looking like any other, with an (i) saying when
//                     the portal dropped it: many such links still work and
//                     are still wanted. It leaves only when its domain dies
//                     or someone asks for its removal.
//   dead since      — its domain stopped existing in public DNS for STRIKES
//                     weekly runs (link_health.json, scripts/check-domains.js).
//                     The link is muted from then on and retired RETIRE_DAYS
//                     later, unless the domain comes back.
export const RETIRE_DAYS = 180;
export const STRIKES = 3;

const AF_BASE = 'https://www.my.af.mil';
const DAY_MS = 24 * 60 * 60 * 1000;

// Whole days from date a to date b, both YYYY-MM-DD
export const daysBetween = (a, b) => Math.floor((new Date(b) - new Date(a)) / DAY_MS);

export const hostOf = link => {
    try {
        return new URL(link.link.startsWith('/') ? AF_BASE + link.link : link.link).hostname.toLowerCase();
    } catch {
        return null;
    }
};

// The date a link's domain was first seen gone, once it has STRIKES strikes
export const deadSince = (link, health) => {
    const h = health?.[hostOf(link)];
    return h && h.strikes >= STRIKES ? h.failingSince : null;
};

const formatDate = d => new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

// { unlisted, dead, retired, note } for a link as of `today` (YYYY-MM-DD):
// unlisted carries the (i) note, dead mutes the link, retired drops it
export function linkStatus(link, today, health = {}) {
    const dead = deadSince(link, health);
    const unlisted = !!link.deprecatedSince;
    return {
        unlisted,
        dead: !!dead,
        retired: !!dead && daysBetween(dead, today) > RETIRE_DAYS,
        note: dead
            ? `Domain has not existed since ${formatDate(dead)}`
            : unlisted ? `Removed from the AF Portal since ${formatDate(link.deprecatedSince)}` : null,
    };
}
