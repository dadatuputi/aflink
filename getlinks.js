// Paste into the browser console on an AF Portal page that lists links.
// Supported pages:
//   - quick-link category pages (browse.do?categoryId=...&channelPageId=...),
//     read from the portal's quicklinks API
//   - index pages that embed their list, such as Applications A-Z
//     (manageApplications.do), read from the page's afp.indexModel.storeData call
// Either way the output is the {afpCategorizedLinksDto: {links: {CATEGORY: [...]}}}
// shape that src/links/links_af.json uses, plus a `source` naming the page, so
// the sync (scripts/af-merge.js) knows which links this page vouches for.

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

// Quick-link category page: the categoryId and channelPageId in the URL name
// the list the page renders.
const getQuickLinks = async () => {
  const params = new URLSearchParams(location.search);
  const categoryId = params.get('categoryId');
  const siteId = params.get('channelPageId');
  if (!categoryId || !siteId) return null;
  const url = `/gcss-af/USAF/api/quicklinks/cached?categorized=true&id=${categoryId}&siteId=${siteId}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Quick links API returned ${response.status} for this page`);
  const data = await response.json();
  return { source: `quicklinks:${categoryId}`, ...data };
};

// Return the JSON array passed to afp.indexModel.storeData( [...] ) in an inline script.
const findStoreData = () => {
  for (const script of document.scripts) {
    const text = script.textContent;
    const call = text.indexOf('afp.indexModel.storeData(');
    if (call === -1) continue;
    const start = text.indexOf('[', call);
    let depth = 0, inString = false, escaped = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') {
        depth--;
        if (depth === 0) return JSON.parse(text.slice(start, i + 1));
      }
    }
  }
  return null;
};

// Index page: group entries by functional area, in the same link shape the
// quicklinks API returns, plus the portal's last-modified date.
const getIndexLinks = () => {
  const items = findStoreData();
  if (!items) return null;
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
  const page = location.pathname.split('/').pop().replace(/\.do$/, '');
  return { source: `index:${page}`, afpCategorizedLinksDto: { links } };
};

const countLinks = (data) =>
  Object.values(data.afpCategorizedLinksDto.links).reduce((n, list) => n + list.length, 0);

const showCompressedDataModal = (data, summary) => {
  // Create modal HTML
  const modalHtml = `
    <div id="compressedDataModal" style="display:none; position:fixed; z-index:1000; left:0; top:0; width:100%; height:100%; overflow:auto; background-color:rgba(0,0,0,0.4);">
      <div style="background-color:#fefefe; margin:15% auto; padding:20px; border:1px solid #888; width:80%; max-width:600px;">
        <h2>Compressed Links Data</h2>
        <p>${summary}</p>
        <textarea id="compressedDataText" style="width:100%; height:100px; margin-bottom:10px;" readonly>${data}</textarea>
        <button id="copyCompressedData">Copy to Clipboard</button>
        <button id="closeModal" style="margin-left:10px;">Close</button>
      </div>
    </div>
  `;

  // Append modal to body
  $('body').append(modalHtml);

  // Show modal
  $('#compressedDataModal').show();

  // Copy button functionality
  $('#copyCompressedData').on('click', async () => {
    try {
      await navigator.clipboard.writeText(data);
    } catch {
      $('#compressedDataText').select();
      document.execCommand('copy');
    }
    $('#copyCompressedData').text('Copied');
  });

  // Close button functionality
  $('#closeModal').on('click', () => {
    $('#compressedDataModal').remove();
  });
};

(async () => {
  try {
    const data = getIndexLinks() || await getQuickLinks();
    if (!data) {
      alert('No link list found on this page. Open a quick-link category page or Applications A-Z and try again.');
      return;
    }
    const summary = `${countLinks(data)} links in ${Object.keys(data.afpCategorizedLinksDto.links).length} categories`;
    showCompressedDataModal(await compressAndEncode(JSON.stringify(data)), summary);
  } catch (error) {
    console.error('Error:', error);
    alert(`Could not read links: ${error.message}`);
  }
})();
