// netlify/functions/_lib/phi-s3.js
//
// Store small PHI JSON blobs (assessment patient name, responses/scores, schedule
// patient email) in Amazon S3 under the AWS BAA, so this PHI rests in S3 (BAA-covered)
// instead of Supabase (no BAA). Reuses the SAME bucket + IAM credentials as the letter
// PDFs (tbp-letters, ses-send-pm), under an `assessments/` key prefix — no new AWS setup.
//
// putJson throws on failure so callers can refuse to proceed (never fall back to writing
// PHI into Supabase). getJson returns {} if the object is gone (already purged).

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

// Store an object as JSON; returns the S3 key. `prefix` namespaces it, e.g.
// 'assessments/patient' or 'assessments/result'. Key is random (non-guessable).
async function putJson(prefix, obj) {
  var day = new Date().toISOString().slice(0, 10);
  var key = String(prefix || 'assessments/misc') + '/' + day + '/' + crypto.randomUUID() + '.json';
  await s3().send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: Buffer.from(JSON.stringify(obj || {}), 'utf8'),
    ContentType: 'application/json',
    ServerSideEncryption: 'AES256'
  }));
  return key;
}

// Fetch and parse a stored JSON object by exact key. Returns {} if missing/purged.
async function getJson(key) {
  if (!key) return {};
  try {
    var out = await s3().send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    var chunks = [];
    for await (var chunk of out.Body) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (e) {
    return {};
  }
}

// Best-effort delete (purge). Never throws; the bucket lifecycle rule is the backstop.
async function deleteObject(key) {
  if (!key) return;
  try { await s3().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key })); } catch (e) { /* lifecycle backstops */ }
}

module.exports = { putJson: putJson, getJson: getJson, deleteObject: deleteObject, PHI_BUCKET: BUCKET };
