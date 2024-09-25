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

const fetchCompressAndShow = async (url) => {
  try {
    const response = await fetch(url);
    const text = await response.text();
    const compressed = await compressAndEncode(text);
    showCompressedDataModal(compressed);
    return compressed;
  } catch (error) {
    console.error('Error:', error);
  }
};

const showCompressedDataModal = (data) => {
  // Create modal HTML
  const modalHtml = `
    <div id="compressedDataModal" style="display:none; position:fixed; z-index:1000; left:0; top:0; width:100%; height:100%; overflow:auto; background-color:rgba(0,0,0,0.4);">
      <div style="background-color:#fefefe; margin:15% auto; padding:20px; border:1px solid #888; width:80%; max-width:600px;">
        <h2>Compressed Links Data</h2>
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
  $('#copyCompressedData').on('click', () => {
    $('#compressedDataText').select();
    document.execCommand('copy');
    alert('Copied to clipboard!');
  });

  // Close button functionality
  $('#closeModal').on('click', () => {
    $('#compressedDataModal').remove();
  });
};

fetchCompressAndShow('https://www.my.af.mil/gcss-af/USAF/api/quicklinks/cached?categorized=true&id=p7F11BC9F789430190178946F7E140005&siteId=sD22E5184744EFC540174558CFFA50008')