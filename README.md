# PDF Forge

Self-hosted PDF template generation service — a PDFMonkey alternative.

## Features

- Monaco-based template editor (HTML + CSS + Handlebars)
- Live HTML preview + on-demand PDF preview
- Variables helper panel
- REST API for n8n and other automation tools
- API key authentication
- Gotenberg (Chromium) for pixel-perfect PDF rendering
- SQLite storage, Docker deployment

## n8n Integration

Use an **HTTP Request** node:

```
POST https://pdf.luxeillum.com/api/documents
Header: x-api-key: pfk_your_key
Body:
{
  "template_id": "invoice",
  "data": { "name": "John", "total": "€1,200" }
}
```

Response:
```json
{
  "id": "uuid",
  "status": "done",
  "url": "https://pdf.luxeillum.com/files/uuid.pdf"
}
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BASE_URL` | `http://localhost:3000` | Public URL (used in PDF download links) |
| `PORT` | `3000` | HTTP port |
| `GOTENBERG_URL` | `http://gotenberg:3000` | Internal Gotenberg URL |
| `DATA_DIR` | `/data` | Path for SQLite DB + PDFs |

## Template Syntax

Templates use [Handlebars](https://handlebarsjs.com/) syntax:

```html
<h1>{{ title }}</h1>

{{#each items}}
  <p>{{ name }} — €{{ price }}</p>
{{/each}}

{{#if isPaid}}
  <span class="badge">PAID</span>
{{/if}}
```

## Deployment (Coolify)

Set environment variable: `BASE_URL=https://pdf.luxeillum.com`
