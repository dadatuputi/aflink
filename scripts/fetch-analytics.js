// Pull anonymized usage stats from the GA4 Data API and write src/analytics.json.
//
// Auth is a service-account JWT signed locally with Node's crypto — no npm
// dependencies. Requires env vars:
//   GA4_CREDENTIALS  - service account JSON key (client_email, private_key)
//   GA4_PROPERTY_ID  - numeric GA4 property id
import fs from 'fs';
import { createSign } from 'crypto';

const creds = JSON.parse(process.env.GA4_CREDENTIALS);
const property = process.env.GA4_PROPERTY_ID;
if (!creds.client_email || !creds.private_key || !property) {
    console.error('GA4_CREDENTIALS and GA4_PROPERTY_ID must be set');
    process.exit(1);
}

const b64url = s => Buffer.from(s).toString('base64url');

async function getAccessToken() {
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64url(JSON.stringify({
        iss: creds.client_email,
        scope: 'https://www.googleapis.com/auth/analytics.readonly',
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600,
    }));
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${claims}`);
    const jwt = `${header}.${claims}.${signer.sign(creds.private_key).toString('base64url')}`;

    const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: jwt,
        }),
    });
    if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
    return (await res.json()).access_token;
}

async function runReport(token, body) {
    const res = await fetch(
        `https://analyticsdata.googleapis.com/v1beta/properties/${property}:runReport`,
        {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }
    );
    if (!res.ok) throw new Error(`runReport failed: ${res.status} ${await res.text()}`);
    return res.json();
}

const token = await getAccessToken();
console.log('✅ token exchange OK');

// Daily visitors and pageviews, last 30 days
const daily = await runReport(token, {
    dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }],
    dimensions: [{ name: 'date' }],
    metrics: [{ name: 'activeUsers' }, { name: 'screenPageViews' }],
    orderBys: [{ dimension: { dimensionName: 'date' } }],
});
console.log(`✅ daily report: ${daily.rows?.length ?? 0} rows`);

// Most-clicked links, last 30 days. Requires the link_title/link_category
// custom dimensions; tolerate absence so the pull works before they exist.
let clicks = { rows: [] };
try {
    clicks = await runReport(token, {
        dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }],
        dimensions: [{ name: 'customEvent:link_title' }, { name: 'customEvent:link_category' }],
        metrics: [{ name: 'eventCount' }],
        dimensionFilter: {
            filter: { fieldName: 'eventName', stringFilter: { value: 'link_click' } },
        },
        orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
        limit: 50,
    });
    console.log(`✅ link_click report: ${clicks.rows?.length ?? 0} rows`);
} catch (e) {
    console.log(`⚠️  link_click report unavailable (custom dimensions not registered yet?): ${e.message}`);
}

const analytics = {
    generated: new Date().toISOString(),
    rangeDays: 30,
    daily: (daily.rows ?? []).map(r => ({
        date: r.dimensionValues[0].value,
        users: Number(r.metricValues[0].value),
        pageviews: Number(r.metricValues[1].value),
    })),
    topLinks: (clicks.rows ?? []).map(r => ({
        title: r.dimensionValues[0].value,
        category: r.dimensionValues[1].value,
        clicks: Number(r.metricValues[0].value),
    })),
};
analytics.totals = {
    users: analytics.daily.reduce((s, d) => s + d.users, 0),
    pageviews: analytics.daily.reduce((s, d) => s + d.pageviews, 0),
    linkClicks: analytics.topLinks.reduce((s, l) => s + l.clicks, 0),
};

fs.writeFileSync('src/analytics.json', JSON.stringify(analytics, null, 2) + '\n');
console.log(`✅ wrote src/analytics.json — ${analytics.totals.users} users, ` +
    `${analytics.totals.pageviews} pageviews, ${analytics.topLinks.length} ranked links`);
