// Lifecycle of a link that is on its way out. Two things can start the clock:
//   deprecatedSince — the sync found no portal page that lists it any more
//                     (stored on the link by scripts/af-merge.js)
//   dead since      — its domain stopped existing in public DNS for STRIKES
//                     weekly runs (link_health.json, scripts/check-domains.js)
// A deprecated link stays on the page, muted and sorted last, until
// RETIRE_DAYS after the earlier date, then the build drops it.
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

// { deprecated, retired, note } for a link as of `today` (YYYY-MM-DD)
export function linkStatus(link, today, health = {}) {
    const dead = deadSince(link, health);
    const since = [link.deprecatedSince, dead].filter(Boolean).sort()[0];
    if (!since) return { deprecated: false, retired: false, note: null };
    const note = dead === since
        ? `Domain has not existed since ${formatDate(dead)}`
        : `No longer listed on the AF Portal since ${formatDate(link.deprecatedSince)}`;
    return { deprecated: true, retired: daysBetween(since, today) > RETIRE_DAYS, note };
}
