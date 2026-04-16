const express = require('express');
const path    = require('path');
const fs      = require('fs');
const { v4: uuidv4 } = require('uuid');
const Handlebars = require('handlebars');

const db = require('./db');
const { DATA_DIR } = require('./db');
const { generatePdf } = require('./pdf');

const app  = express();
const PDFS = path.join(DATA_DIR, 'pdfs');

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../public')));
app.use('/files', express.static(PDFS));

// ── Auth ──────────────────────────────────────────────────────────
function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (!key) return res.status(401).json({ error: 'x-api-key header required' });
  const row = db.prepare('SELECT id FROM api_keys WHERE key = ?').get(key);
  if (!row) return res.status(401).json({ error: 'Invalid API key' });
  next();
}

// ── Health ────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true }));

// ── Templates ─────────────────────────────────────────────────────
app.get('/api/templates', (_req, res) => {
  res.json(db.prepare(
    'SELECT id, name, slug, page_size, orientation, created_at, updated_at FROM templates ORDER BY created_at DESC'
  ).all());
});

app.post('/api/templates', (req, res) => {
  const { name, slug, html = '', css = '', sample_data = '{}',
          page_size = 'A4', orientation = 'portrait',
          margin_top = 1, margin_right = 1, margin_bottom = 1, margin_left = 1 } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  const id  = uuidv4();
  const sl  = slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  try {
    db.prepare(`INSERT INTO templates
      (id, name, slug, html, css, sample_data, page_size, orientation, margin_top, margin_right, margin_bottom, margin_left)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, sl, html, css, sample_data, page_size, orientation,
           margin_top, margin_right, margin_bottom, margin_left);
    res.status(201).json(db.prepare('SELECT * FROM templates WHERE id = ?').get(id));
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Slug already exists' });
    throw e;
  }
});

app.get('/api/templates/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM templates WHERE id = ? OR slug = ?').get(req.params.id, req.params.id);
  if (!t) return res.status(404).json({ error: 'Template not found' });
  res.json(t);
});

app.put('/api/templates/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM templates WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Template not found' });

  const fields = ['name','slug','html','css','sample_data','page_size','orientation',
                  'margin_top','margin_right','margin_bottom','margin_left'];
  const updates = [];
  const vals    = [];

  for (const f of fields) {
    if (req.body[f] !== undefined) {
      updates.push(`${f} = ?`);
      vals.push(req.body[f]);
    }
  }
  if (!updates.length) return res.json(t);

  updates.push('updated_at = CURRENT_TIMESTAMP');
  vals.push(req.params.id);
  db.prepare(`UPDATE templates SET ${updates.join(', ')} WHERE id = ?`).run(...vals);
  res.json(db.prepare('SELECT * FROM templates WHERE id = ?').get(req.params.id));
});

app.delete('/api/templates/:id', (req, res) => {
  db.prepare('DELETE FROM templates WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── Preview (HTML render — no auth, used by editor) ───────────────
app.post('/api/templates/:id/preview', async (req, res) => {
  const t = db.prepare('SELECT * FROM templates WHERE id = ? OR slug = ?').get(req.params.id, req.params.id);
  if (!t) return res.status(404).json({ error: 'Template not found' });

  let data = {};
  try { data = req.body.data || JSON.parse(t.sample_data || '{}'); } catch (_) {}

  try {
    const rendered = Handlebars.compile(t.html)(data);
    const fullHtml = buildHtml(rendered, t.css);

    if (req.query.format === 'pdf') {
      const buf = await generatePdf(fullHtml, t);
      res.set('Content-Type', 'application/pdf');
      return res.send(buf);
    }

    res.set('Content-Type', 'text/html');
    res.send(fullHtml);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Quick HTML-only preview from raw body (editor live preview — no DB save needed)
app.post('/api/preview-raw', async (req, res) => {
  const { html = '', css = '', data = {}, format } = req.body;
  try {
    const rendered = Handlebars.compile(html)(data);
    const fullHtml = buildHtml(rendered, css);
    if (format === 'pdf') {
      const buf = await generatePdf(fullHtml, req.body);
      res.set('Content-Type', 'application/pdf');
      return res.send(buf);
    }
    res.set('Content-Type', 'text/html');
    res.send(fullHtml);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── Documents ─────────────────────────────────────────────────────
app.post('/api/documents', requireApiKey, async (req, res) => {
  const { template_id, data = {} } = req.body;
  if (!template_id) return res.status(400).json({ error: 'template_id is required' });

  const t = db.prepare('SELECT * FROM templates WHERE id = ? OR slug = ?').get(template_id, template_id);
  if (!t) return res.status(404).json({ error: 'Template not found' });

  const docId = uuidv4();
  db.prepare('INSERT INTO documents (id, template_id, data, status) VALUES (?, ?, ?, ?)')
    .run(docId, t.id, JSON.stringify(data), 'processing');

  try {
    const rendered  = Handlebars.compile(t.html)(data);
    const fullHtml  = buildHtml(rendered, t.css);
    const pdfBuf    = await generatePdf(fullHtml, t);
    const filename  = `${docId}.pdf`;

    fs.writeFileSync(path.join(PDFS, filename), pdfBuf);
    db.prepare('UPDATE documents SET status = ?, filename = ? WHERE id = ?').run('done', filename, docId);

    const base = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    res.json({
      id:            docId,
      status:        'done',
      url:           `${base}/files/${filename}`,
      template_id:   t.id,
      template_slug: t.slug,
    });
  } catch (e) {
    db.prepare('UPDATE documents SET status = ?, error = ? WHERE id = ?').run('error', e.message, docId);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/documents', (_req, res) => {
  const docs = db.prepare(`
    SELECT d.*, t.name AS template_name, t.slug AS template_slug
    FROM documents d
    LEFT JOIN templates t ON d.template_id = t.id
    ORDER BY d.created_at DESC LIMIT 200
  `).all();
  const base = process.env.BASE_URL || 'http://localhost:3000';
  res.json(docs.map(d => ({ ...d, url: d.filename ? `${base}/files/${d.filename}` : null })));
});

app.get('/api/documents/:id', (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  const base = process.env.BASE_URL || 'http://localhost:3000';
  res.json({ ...doc, url: doc.filename ? `${base}/files/${doc.filename}` : null });
});

// ── API Keys ──────────────────────────────────────────────────────
app.get('/api/keys', (_req, res) => {
  res.json(db.prepare('SELECT id, name, key, created_at FROM api_keys ORDER BY created_at DESC').all());
});

app.post('/api/keys', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const id  = uuidv4();
  const key = 'pfk_' + uuidv4().replace(/-/g, '');
  db.prepare('INSERT INTO api_keys (id, name, key) VALUES (?, ?, ?)').run(id, name, key);
  res.status(201).json({ id, name, key });
});

app.delete('/api/keys/:id', (req, res) => {
  db.prepare('DELETE FROM api_keys WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── Helpers ───────────────────────────────────────────────────────
function buildHtml(body, css = '') {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:14px}
${css}
</style>
</head>
<body>${body}</body>
</html>`;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PDF Forge listening on :${PORT}`));
