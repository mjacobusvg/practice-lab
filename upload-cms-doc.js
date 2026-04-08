#!/usr/bin/env node
// scripts/upload-cms-doc.js
// Reads a local PDF, base64-encodes it, and POSTs it to the ingest-cms-doc-upload function.
//
// Usage:
//   node upload-cms-doc.js <pdf-path> <doc-id> <doc-title> [function-url]
//
// Examples:
//   node upload-cms-doc.js ./mln006764.pdf cms_mln006764 "CMS MLN: Evaluation and Management Services Guide (2025)"
//   node upload-cms-doc.js ./pfs-em-fact-sheet.pdf cms_pfs_em_fact_sheet "CMS Fact Sheet: Physician Fee Schedule Payment for Office/Outpatient E/M Visits"
//   node upload-cms-doc.js ./r10505cp.pdf cms_r10505cp "CMS: Prolonged Office/Outpatient E/M Services — G2212 vs 99417"
//
// Reads BACKFILL_SECRET from env or prompts if missing.
// Defaults function URL to http://localhost:8888/.netlify/functions/ingest-cms-doc-upload
// Override with INGEST_URL env var or 4th argument.

const fs   = require('fs');
const path = require('path');

async function main() {
  const [,, pdfPath, docId, docTitle, urlArg] = process.argv;

  if (!pdfPath || !docId || !docTitle) {
    console.error('Usage: node upload-cms-doc.js <pdf-path> <doc-id> <doc-title> [function-url]');
    process.exit(1);
  }

  const resolvedPath = path.resolve(pdfPath);
  if (!fs.existsSync(resolvedPath)) {
    console.error(`File not found: ${resolvedPath}`);
    process.exit(1);
  }

  const secret = process.env.BACKFILL_SECRET;
  if (!secret) {
    console.error('BACKFILL_SECRET env var is required.');
    process.exit(1);
  }

  const functionUrl = urlArg
    || process.env.INGEST_URL
    || 'http://localhost:8888/.netlify/functions/ingest-cms-doc-upload';

  console.log(`Reading: ${resolvedPath}`);
  const pdfBytes = fs.readFileSync(resolvedPath);
  const pdfBase64 = pdfBytes.toString('base64');
  console.log(`Base64 length: ${pdfBase64.length} chars (~${Math.round(pdfBase64.length / 1024)} KB)`);

  const payload = {
    secret:     secret,
    id:         docId,
    title:      docTitle,
    pdf:        pdfBase64,
    space_name: 'CMS Reference',
    space_slug:  'cms-reference',
    author:     'Centers for Medicare & Medicaid Services',
    url:        ''
  };

  console.log(`POSTing to: ${functionUrl}`);

  const resp = await fetch(functionUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const text = await resp.text();
  console.log(`Response [${resp.status}]: ${text}`);

  if (resp.status === 202) {
    console.log('✓ Ingestion started. Check Netlify function logs for progress.');
  } else {
    console.error('✗ Unexpected response. Check function logs.');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
