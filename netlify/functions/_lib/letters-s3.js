// netlify/functions/_lib/letters-s3.js
//
// Letter-PDF storage in Amazon S3 under the AWS BAA — so letter content (PHI) rests
// in S3 (BAA-covered) instead of Supabase (no BAA). Reuses the SAME IAM credentials
// the SES sender already uses (SES_AWS_ACCESS_KEY_ID / SES_AWS_SECRET_ACCESS_KEY); the
// ses-send-pm user was granted s3:PutObject/GetObject/DeleteObject on this bucket.
//
// Bucket: LETTERS_S3_BUCKET (default 'tbp-letters', us-east-1). A 90-day bucket
// lifecycle rule is the backstop; app-level expiry (expires_at) gates access sooner.
//
// Callers decide fallback: putLetterPdf throws on failure so the caller can refuse to
// proceed (paid letters) or log without a PDF (send log) — never fall back to storing
// the bytes in Supabase, which would defeat the whole point.

var { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
var crypto = require('crypto');

var BUCKET = process.env.LETTERS_S3_BUCKET || 'tbp-letters';

function s3() {
  var region = process.env.SES_AWS_REGION || process.env.AWS_REGION || 'us-east-1';
  var accessKeyId = process.env.SES_AWS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID;
  var secretAccessKey = process.env.SES_AWS_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY;
  var cfg = { region: region };
  if (accessKeyId && secretAccessKey) cfg.credentials = { accessKeyId: accessKeyId, secretAccessKey: secretAccessKey };
  return new S3Client(cfg);
}

// Store a base64 PDF; returns the S3 object key to persist on the row. Throws on failure.
// `prefix` namespaces the object (e.g. 'charges' or 'sendlog'); the key is random so it
// is never guessable and retrieval always uses the exact stored key (no path injection).
async function putLetterPdf(prefix, base64) {
  var day = new Date().toISOString().slice(0, 10);
  var key = String(prefix || 'letters') + '/' + day + '/' + crypto.randomUUID() + '.pdf';
  var body = Buffer.from(String(base64), 'base64');
  await s3().send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: body,
    ContentType: 'application/pdf',
    ServerSideEncryption: 'AES256'
  }));
  return key;
}

// Fetch a stored PDF by its exact key; returns base64 (for inline serving). Throws if missing.
async function getLetterPdfBase64(key) {
  var out = await s3().send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  var chunks = [];
  for await (var chunk of out.Body) chunks.push(chunk);
  return Buffer.concat(chunks).toString('base64');
}

// Best-effort delete (early purge). Never throws — the 90-day lifecycle rule is the backstop.
async function deleteLetterPdf(key) {
  if (!key) return;
  try {
    await s3().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  } catch (e) { /* lifecycle rule will still expire it */ }
}

module.exports = {
  putLetterPdf: putLetterPdf,
  getLetterPdfBase64: getLetterPdfBase64,
  deleteLetterPdf: deleteLetterPdf,
  LETTERS_BUCKET: BUCKET
};
