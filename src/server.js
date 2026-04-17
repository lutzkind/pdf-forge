const express  = require('express');
const session  = require('express-session');
const path     = require('path');
const fs       = require('fs');
const axios    = require('axios');
const { v4: uuidv4 } = require('uuid');
const Handlebars = require('handlebars');

const db = require('./db');
const { DATA_DIR } = require('./db');
const { generatePdf } = require('./pdf');

const app  = express();
const PDFS = path.join(DATA_DIR, 'pdfs');

// ── Config ────────────────────────────────────────────────────────
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'changeme';
const SESSION_SECRET = process.env.SESSION_SECRET || uuidv4();

// ── Middleware ────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }, // 7 days
}));

// ── Auth helpers ──────────────────────────────────────────────────
function isLoggedIn(req) {
  return req.session && req.session.authenticated;
}

function requireLogin(req, res, next) {
  if (isLoggedIn(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Login required' });
  res.redirect('/login.html');
}

function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (!key) return res.status(401).json({ error: 'x-api-key header required' });
  const row = db.prepare('SELECT id FROM api_keys WHERE key = ?').get(key);
  if (!row) return res.status(401).json({ error: 'Invalid API key' });
  next();
}

// ── Public routes (no auth) ───────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/login.html', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/login.html'));
});

app.post('/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    req.session.authenticated = true;
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

// Document generation endpoint — uses API key, no session required
app.post('/api/documents', requireApiKey, async (req, res) => {
  const { template_id, data = {} } = req.body;
  if (!template_id) return res.status(400).json({ error: 'template_id is required' });

  const t = db.prepare('SELECT * FROM templates WHERE id = ? OR slug = ?').get(template_id, template_id);
  if (!t) return res.status(404).json({ error: 'Template not found' });

  const docId = uuidv4();
  db.prepare('INSERT INTO documents (id, template_id, data, status) VALUES (?, ?, ?, ?)')
    .run(docId, t.id, JSON.stringify(data), 'processing');

  try {
    const rendered = Handlebars.compile(t.html)(data);
    const fullHtml = buildHtml(rendered, t.css);
    const pdfBuf  = await generatePdf(fullHtml, t);
    const filename = `${docId}.pdf`;

    fs.writeFileSync(path.join(PDFS, filename), pdfBuf);
    db.prepare('UPDATE documents SET status = ?, filename = ? WHERE id = ?').run('done', filename, docId);

    const base = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    const pdfUrl = `${base}/files/${filename}`;
    res.json({
      id: docId, status: 'done', url: pdfUrl,
      template_id: t.id, template_slug: t.slug,
      document_card: { download_url: pdfUrl }, // PDFMonkey-compatible
    });
  } catch (e) {
    db.prepare('UPDATE documents SET status = ?, error = ? WHERE id = ?').run('error', e.message, docId);
    res.status(500).json({ error: e.message });
  }
});

// ── Protected static files ────────────────────────────────────────
app.use('/files', express.static(PDFS));

// API routes accept either session login OR API key
function requireAuth(req, res, next) {
  if (isLoggedIn(req)) return next();
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (key) {
    const row = db.prepare('SELECT id FROM api_keys WHERE key = ?').get(key);
    if (row) return next();
  }
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Login or API key required' });
  res.redirect('/login.html');
}

// All other routes require login
app.use(requireAuth);

app.use(express.static(path.join(__dirname, '../public')));

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

  const id = uuidv4();
  const sl = slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

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
  const updates = [], vals = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) { updates.push(`${f} = ?`); vals.push(req.body[f]); }
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

// ── Preview ───────────────────────────────────────────────────────
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
      res.set('Content-Type', 'application/pdf'); return res.send(buf);
    }
    res.set('Content-Type', 'text/html'); res.send(fullHtml);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/preview-raw', async (req, res) => {
  const { html = '', css = '', data = {}, format } = req.body;
  try {
    const rendered = Handlebars.compile(html)(data);
    const fullHtml = buildHtml(rendered, css);
    if (format === 'pdf') {
      const buf = await generatePdf(fullHtml, req.body);
      res.set('Content-Type', 'application/pdf'); return res.send(buf);
    }
    res.set('Content-Type', 'text/html'); res.send(fullHtml);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Manual generate (session auth — for UI) ───────────────────────
app.post('/api/generate', async (req, res) => {
  const { template_id, data = {} } = req.body;
  if (!template_id) return res.status(400).json({ error: 'template_id is required' });

  const t = db.prepare('SELECT * FROM templates WHERE id = ? OR slug = ?').get(template_id, template_id);
  if (!t) return res.status(404).json({ error: 'Template not found' });

  const docId = uuidv4();
  db.prepare('INSERT INTO documents (id, template_id, data, status) VALUES (?, ?, ?, ?)')
    .run(docId, t.id, JSON.stringify(data), 'processing');

  try {
    const rendered = Handlebars.compile(t.html)(data);
    const fullHtml = buildHtml(rendered, t.css);
    const pdfBuf  = await generatePdf(fullHtml, t);
    const filename = `${docId}.pdf`;

    fs.writeFileSync(path.join(PDFS, filename), pdfBuf);
    db.prepare('UPDATE documents SET status = ?, filename = ? WHERE id = ?').run('done', filename, docId);

    const base = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    res.json({ id: docId, status: 'done', url: `${base}/files/${filename}` });
  } catch (e) {
    db.prepare('UPDATE documents SET status = ?, error = ? WHERE id = ?').run('error', e.message, docId);
    res.status(500).json({ error: e.message });
  }
});

// ── Documents ─────────────────────────────────────────────────────
app.get('/api/documents', (_req, res) => {
  const docs = db.prepare(`
    SELECT d.*, t.name AS template_name, t.slug AS template_slug
    FROM documents d LEFT JOIN templates t ON d.template_id = t.id
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

// ── PDFMonkey Import ──────────────────────────────────────────────
app.post('/api/import/pdfmonkey', async (req, res) => {
  const { api_key } = req.body;
  if (!api_key) return res.status(400).json({ error: 'api_key required' });

  let templates;
  try {
    const r = await axios.get('https://api.pdfmonkey.io/api/v1/document_templates', {
      headers: { Authorization: `Bearer ${api_key}` },
      timeout: 15000,
    });
    templates = r.data.document_templates || [];
  } catch (e) {
    return res.status(400).json({ error: 'PDFMonkey API error: ' + (e.response?.data?.error || e.message) });
  }

  const FORMAT_MAP = { a4:'A4', a3:'A3', a5:'A5', letter:'Letter', legal:'Legal', tabloid:'Tabloid' };
  const MM_TO_IN = 0.0393701;

  const results = [];
  for (const t of templates) {
    const settings = t.settings || {};
    const margins  = settings.margin || {};
    const slug = (t.identifier || t.id)
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

    // Make slug unique if collision
    let finalSlug = slug;
    let attempt   = 0;
    while (db.prepare('SELECT id FROM templates WHERE slug = ?').get(finalSlug)) {
      attempt++;
      finalSlug = `${slug}-${attempt}`;
    }

    const sampleData = (() => {
      try { return JSON.stringify(JSON.parse(t.sample_payload || t.sample_data || '{}'), null, 2); }
      catch { return '{}'; }
    })();

    const id = uuidv4();
    try {
      db.prepare(`INSERT INTO templates
        (id, name, slug, html, css, sample_data, page_size, orientation, margin_top, margin_right, margin_bottom, margin_left)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        t.identifier || t.id,
        finalSlug,
        t.body || '',
        t.stylesheet || t.scss_style || '',
        sampleData,
        FORMAT_MAP[settings.paper_format] || 'A4',
        settings.orientation || 'portrait',
        (margins.top  || 0) * MM_TO_IN,
        (margins.right || 0) * MM_TO_IN,
        (margins.bottom || 0) * MM_TO_IN,
        (margins.left || 0) * MM_TO_IN,
      );
      results.push({ id, name: t.identifier || t.id, slug: finalSlug, status: 'imported' });
    } catch (e) {
      results.push({ name: t.identifier || t.id, status: 'error', error: e.message });
    }
  }

  res.json({ imported: results.filter(r => r.status === 'imported').length, total: templates.length, results });
});

// ── Helpers ───────────────────────────────────────────────────────
function buildHtml(body, css = '') {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
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
