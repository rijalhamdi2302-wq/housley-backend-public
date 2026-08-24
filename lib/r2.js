/**
 * Housley — Cloudflare R2 storage client for APK uploads.
 * Uses @aws-sdk/client-s3 (S3-compatible API).
 */

const { S3Client, PutObjectCommand, DeleteObjectCommand, HeadBucketCommand } = require('@aws-sdk/client-s3');

const R2_BUCKET = (process.env.R2_BUCKET_NAME || 'housley-apks').trim();
const R2_ENDPOINT = (process.env.R2_ENDPOINT || '').trim();
const R2_ACCESS_KEY = (process.env.R2_ACCESS_KEY_ID || '').trim();
const R2_SECRET_KEY = (process.env.R2_SECRET_ACCESS_KEY || '').trim();
const R2_PUBLIC_URL = (process.env.R2_PUBLIC_URL || '').trim();

let _client = null;

function getClient() {
  if (_client) return _client;
  _client = new S3Client({
    region: 'auto',
    endpoint: R2_ENDPOINT,
    credentials: {
      accessKeyId: R2_ACCESS_KEY,
      secretAccessKey: R2_SECRET_KEY,
    },
  });
  return _client;
}

/** Check if R2 is configured. */
function configured() {
  return Boolean(R2_ACCESS_KEY && R2_SECRET_KEY && R2_ENDPOINT);
}

/** Upload a file to R2. Returns the public URL. */
async function uploadFile({ key, body, contentType = 'application/vnd.android.package-archive' }) {
  if (!configured()) throw new Error('R2 is not configured on the server.');

  const client = getClient();
  const command = new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType,
  });

  await client.send(command);
  return `${R2_PUBLIC_URL}/${key}`;
}

/** Delete a file from R2. */
async function deleteFile(key) {
  if (!configured()) return;
  const client = getClient();
  const command = new DeleteObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
  });
  await client.send(command).catch(() => {});
}

/** Generate a unique APK key. */
function apkKey(version) {
  const ts = Date.now().toString(36);
  const rand = require('crypto').randomBytes(4).toString('hex');
  return `releases/housley-v${version}-${ts}-${rand}.apk`;
}

module.exports = { configured, uploadFile, deleteFile, apkKey };
