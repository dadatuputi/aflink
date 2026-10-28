// Paste into the browser console on any AF Portal page while logged in.
//
// The portal keeps its links on several pages, so this fetches each list
// itself (PAGES below), combines them into one submission in the shape
// src/links/links_af.json uses, and posts it to the search worker, which
// starts the Portal Sync workflow and a pull request for review. A list that
// cannot be fetched is skipped and named in the result; the sync only touches
// links from the lists that arrived. If the worker is unreachable or declines,
// the compressed-data box appears instead, for the Update AF Links issue form.

const PAGES = [
  { source: 'index:manageApplications', name: 'Applications A-Z', url: '/gcss-af/USAF/ep/manageApplications.do' },
  { source: 'quicklinks:p44C00E3C94DB4A210194DC84A9E10002', name: 'Home: Temporary Links Information', siteId: 's6925EC1356510FB5E044080020E329A9' },
  { source: 'quicklinks:pAF429CFD945FB19F0194605EE6410002', name: 'Career and Training links', siteId: 'sF1D9EE47BB312480E0400F9E4DDA2DD3' },
  { source: 'quicklinks:pAF429CFD945FB19F019460FC9A650026', name: 'Life and Fitness Quick Links', siteId: 's6925EC13564F0FB5E044080020E329A9' },
];

// The search worker's submit endpoint (search_worker/src/submit.js)
const SUBMIT_URL = 'https://aflink-autocomplete.aswang.workers.dev/submit';

const compressAndEncode = async (data) => {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(data);
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const compressedBytes = await new Response(cs.readable).arrayBuffer();
  return btoa(String.fromCharCode.apply(null, new Uint8Array(compressedBytes)));
};

// Return the JSON array passed to afp.indexModel.storeData( [...] ) in a page's HTML.
const findStoreData = (html) => {
  const call = html.indexOf('afp.indexModel.storeData(');
  if (call === -1) return null;
  const start = html.indexOf('[', call);
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') {
      depth--;
      if (depth === 0) return JSON.parse(html.slice(start, i + 1));
    }
  }
  return null;
};

const fetchText = async (url) => {
  const response = await fetch(url, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
};

// Index page (Applications A-Z): group entries by functional area, in the same
// link shape the quicklinks API returns, plus the portal's last-modified date.
const getIndexLinks = async (page) => {
  const items = findStoreData(await fetchText(page.url));
  if (!items) throw new Error('no embedded list found');
  const links = {};
  for (const item of items) {
    if (!item.link) continue;
    const category = (item.functionalArea || 'Other').toUpperCase();
    (links[category] ||= []).push({
      title: item.displayTitle,
      link: item.link,
      type: 'application',
      contentId: item.id,
      exitLinkReferrer: item.exitLinkReferrer,
      url: item.isUrl,
      renderedAsFile: false,
      lastModified: item.lastModTime?.time ? new Date(item.lastModTime.time).toISOString().slice(0, 10) : undefined,
    });
  }
  return links;
};

// Quick-link page: the portal's "cached" quicklinks feed answers for a category
// once its page has been rendered in this session, so load the page first.
const getQuickLinks = async (page) => {
  const categoryId = page.source.slice('quicklinks:'.length);
  await fetchText(`/gcss-af/USAF/ep/browse.do?categoryId=${categoryId}&channelPageId=${page.siteId}`);
  const url = `/gcss-af/USAF/api/quicklinks/cached?categorized=true&id=${categoryId}&siteId=${page.siteId}`;
  const response = await fetch(url, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`quick links feed answered ${response.status}`);
  const data = await response.json();
  const links = data?.afpCategorizedLinksDto?.links;
  if (!links) throw new Error('quick links feed returned no list');
  return links;
};

const countLinks = (links) => Object.values(links).reduce((n, list) => n + list.length, 0);

// Every list the portal has, fetched from wherever this runs
const collect = async () => {
  const pages = [], failures = [];
  for (const page of PAGES) {
    try {
      const links = page.url ? await getIndexLinks(page) : await getQuickLinks(page);
      pages.push({ source: page.source, name: page.name, count: countLinks(links), afpCategorizedLinksDto: { links } });
    } catch (error) {
      failures.push({ name: page.name, error: error.message });
    }
  }
  return { pages, failures };
};

const submitDirect = async (payload) => {
  const response = await fetch(SUBMIT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
};

const modal = (title, lines, extraHtml = '') => {
  const modalHtml = `
    <div id="compressedDataModal" style="display:none; position:fixed; z-index:1000; left:0; top:0; width:100%; height:100%; overflow:auto; background-color:rgba(0,0,0,0.4);">
      <div style="background-color:#fefefe; color:#222; margin:15% auto; padding:20px; border:1px solid #888; width:80%; max-width:600px;">
        <h2>${title}</h2>
        <ul id="submitLines"></ul>
        ${extraHtml}
        <button id="closeModal">Close</button>
      </div>
    </div>
  `;
  $('body').append(modalHtml);
  for (const line of lines) $('<li>').text(line).appendTo('#submitLines');
  $('#compressedDataModal').show();
  $('#closeModal').on('click', () => {
    $('#compressedDataModal').remove();
  });
};

const summaryLines = ({ pages, failures }) => [
  ...pages.map(p => `${p.name}: ${p.count} links`),
  ...failures.map(f => `${f.name}: not fetched (${f.error})`),
];

const showCompressedDataModal = (data, collected, reason) => {
  modal('Compressed Links Data', [...summaryLines(collected), reason, 'Paste the box below into an Update AF Links issue.'], `
    <textarea id="compressedDataText" style="width:100%; height:100px; margin-bottom:10px;" readonly>${data}</textarea>
    <button id="copyCompressedData" style="margin-right:10px;">Copy to Clipboard</button>`);
  $('#copyCompressedData').on('click', async () => {
    try {
      await navigator.clipboard.writeText(data);
    } catch {
      $('#compressedDataText').select();
      document.execCommand('copy');
    }
    $('#copyCompressedData').text('Copied');
  });
};

(async () => {
  try {
    const collected = await collect();
    if (collected.pages.length === 0) {
      modal('No lists fetched', [...summaryLines(collected), 'Are you logged in to the AF Portal?']);
      return;
    }
    const payload = { pages: collected.pages.map(({ source, afpCategorizedLinksDto }) => ({ source, afpCategorizedLinksDto })) };
    try {
      const result = await submitDirect(payload);
      modal('Links submitted', [...summaryLines(collected), result.message]);
    } catch (error) {
      console.warn('Direct submission failed, falling back to the issue form:', error.message);
      showCompressedDataModal(await compressAndEncode(JSON.stringify(payload)), collected, `Direct submission failed: ${error.message}`);
    }
  } catch (error) {
    console.error('Error:', error);
    alert(`Could not read links: ${error.message}`);
  }
})();
