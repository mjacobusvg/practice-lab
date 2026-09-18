// netlify/functions/_lib/phi-s3.js
//
// Store small PHI JSON blobs (assessment patient name, responses/scores, schedule
// patient email) in Amazon S3 under the AWS BAA, so this PHI rests in S3 (BAA-covered)
// instead of Supabase (no BAA). Reuses the SAME bucket + IAM credentials as the letter
// PDFs (tbp-letters, ses-send-pm), under an `assessments/` key prefix — no new AWS setup.
//
// putJson throws on failure so callers can refuse to proceed (never fall back to writing
// PHI into Supabase). getJson returns {} if the object is gone (already purged).

var { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
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

// List every key under a prefix, following continuation tokens to the end.
//
// THROWS on failure, unlike deleteObject. Its only caller reconciles this listing against
// the keys recorded in Postgres and deletes what is not referenced — so a SHORT list is
// not a harmless degradation, it is a list of live PHI that looks abandoned. A partial
// answer must be an error, never a result.
//
// Returns [{ key, lastModified }]. `cap` bounds the walk; hitting it is reported via
// `truncated` so the caller can refuse to act on an incomplete picture.
async function listKeys(prefix, cap) {
  var limit = cap || 5000;
  var out = [];
  var token = undefined;
  var client = s3();
  do {
    var page = await client.send(new ListObjectsV2Command({
      Bucket: BUCKET, Prefix: prefix, ContinuationToken: token, MaxKeys: 1000
    }));
    (page.Contents || []).forEach(function (o) {
      out.push({ key: o.Key, lastModified: o.LastModified ? new Date(o.LastModified).getTime() : 0 });
    });
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
    if (out.length >= limit) return { keys: out, truncated: true };
  } while (token);
  return { keys: out, truncated: false };
}

module.exports = { putJson: putJson, getJson: getJson, deleteObject: deleteObject, listKeys: listKeys, PHI_BUCKET: BUCKET };
