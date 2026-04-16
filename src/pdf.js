const axios = require('axios');
const FormData = require('form-data');

const GOTENBERG_URL = process.env.GOTENBERG_URL || 'http://gotenberg:3000';

// Page sizes in inches: [width, height]
const PAGE_SIZES = {
  A4:     [8.27,  11.69],
  A3:     [11.69, 16.54],
  A5:     [5.83,  8.27],
  Letter: [8.5,   11.0],
  Legal:  [8.5,   14.0],
  Tabloid:[11.0,  17.0],
};

async function generatePdf(html, opts = {}) {
  const {
    page_size   = 'A4',
    orientation = 'portrait',
    margin_top    = 1.0,
    margin_right  = 1.0,
    margin_bottom = 1.0,
    margin_left   = 1.0,
  } = opts;

  let [w, h] = PAGE_SIZES[page_size] || PAGE_SIZES.A4;
  if (orientation === 'landscape') [w, h] = [h, w];

  const form = new FormData();
  form.append('files', Buffer.from(html, 'utf-8'), {
    filename: 'index.html',
    contentType: 'text/html',
  });
  form.append('paperWidth',    String(w));
  form.append('paperHeight',   String(h));
  form.append('landscape',     orientation === 'landscape' ? 'true' : 'false');
  form.append('marginTop',     String(margin_top));
  form.append('marginRight',   String(margin_right));
  form.append('marginBottom',  String(margin_bottom));
  form.append('marginLeft',    String(margin_left));
  form.append('printBackground', 'true');

  const response = await axios.post(
    `${GOTENBERG_URL}/forms/chromium/convert/html`,
    form,
    {
      headers: form.getHeaders(),
      responseType: 'arraybuffer',
      timeout: 60000,
    }
  );

  return Buffer.from(response.data);
}

module.exports = { generatePdf };
