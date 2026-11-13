'use strict';
// Export processed recordings only when the installation explicitly enables it.
// Original PTR provider internals were not captured; these are documented API adapters.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { RECORDINGS_DIR } = require('../config');
const activeRooms = new Map(),
  pausedRooms = new Set();
function pauseRoom(roomID) {
  const id = String(roomID || '');
  if (!id || pausedRooms.has(id) || (activeRooms.get(id) || 0) > 0) return false;
  pausedRooms.add(id);
  return true;
}
function resumeRoom(roomID) {
  pausedRooms.delete(String(roomID || ''));
}

const hmac = (key, text, encoding) =>
  crypto.createHmac('sha256', key).update(text).digest(encoding);
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const encode = (value) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
function safeFile(recording, directory) {
  if (
    !recording ||
    recording.status !== 'ready' ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(String(recording.id || ''))
  )
    throw new Error('Recording is not ready for export');
  const root = fs.realpathSync(directory);
  if (!recording.file_path) throw new Error('Invalid recording path');
  const candidate = path.resolve(directory, String(recording.file_path));
  let real;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    throw new Error('Invalid recording path');
  }
  if (!real.startsWith(root + path.sep) || !fs.statSync(real).isFile())
    throw new Error('Invalid recording path');
  const stat = fs.statSync(real);
  if (!stat.size) throw new Error('Recording file is empty');
  return { path: real, size: stat.size };
}
function timeout() {
  return AbortSignal.timeout(600000);
}
async function closeStream(stream) {
  if (stream.closed) return;
  const closed = new Promise((resolve) => stream.once('close', resolve));
  stream.on('error', () => {});
  stream.destroy();
  await closed;
}
async function digestFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
function objectKey(recording, prefix) {
  const segments = String(prefix || '')
    .split('/')
    .filter(Boolean);
  if (segments.some((part) => part === '.' || part === '..' || /[\u0000-\u001f\u007f]/.test(part)))
    throw new Error('Invalid S3 folder');
  const ext = path.extname(String(recording.file_path)).toLowerCase();
  if (!['.mp4', '.m4a', '.webm'].includes(ext)) throw new Error('Unsupported recording format');
  return [...segments, String(recording.id) + ext].join('/');
}
async function uploadS3(recording, file, settings, options) {
  const bucket = String(settings.s3Bucket || ''),
    region = String(options.s3Region || ''),
    access = String(settings.s3KeyID || ''),
    secret = String(settings.s3KeySecret || '');
  if (
    !/^(?=.{3,63}$)[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(bucket) ||
    bucket.includes('..') ||
    /^\d+\.\d+\.\d+\.\d+$/.test(bucket)
  )
    throw new Error('Invalid S3 bucket');
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(region))
    throw new Error('S3 export region is not configured');
  if (!access || !secret || /[\r\n]/.test(access + secret))
    throw new Error('S3 export credentials are not configured');
  if (file.size > 5 * 1024 * 1024 * 1024)
    throw new Error('Recording exceeds the S3 single-upload limit');
  const key = objectKey(recording, settings.s3BucketFolderPath),
    host = `s3.${region}.amazonaws.com`;
  const uri = '/' + encode(bucket) + '/' + key.split('/').map(encode).join('/');
  const stamp = (options.now ? options.now() : new Date())
      .toISOString()
      .replace(/[:-]|\.\d{3}/g, ''),
    day = stamp.slice(0, 8);
  const payloadHash = await digestFile(file.path);
  const headers = { host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': stamp };
  const canonicalHeaders = Object.keys(headers)
      .sort()
      .map((k) => `${k}:${headers[k]}\n`)
      .join(''),
    signed = Object.keys(headers).sort().join(';');
  const canonical = ['PUT', uri, '', canonicalHeaders, signed, payloadHash].join('\n');
  const scope = `${day}/${region}/s3/aws4_request`,
    toSign = `AWS4-HMAC-SHA256\n${stamp}\n${scope}\n${sha256(canonical)}`;
  const kDate = hmac('AWS4' + secret, day),
    kRegion = hmac(kDate, region),
    kService = hmac(kRegion, 's3'),
    kSigning = hmac(kService, 'aws4_request');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${access}/${scope}, SignedHeaders=${signed}, Signature=${hmac(kSigning, toSign, 'hex')}`;
  headers['content-type'] = recording.mime_type || 'application/octet-stream';
  headers['content-length'] = String(file.size);
  const stream = fs.createReadStream(file.path);
  let response;
  try {
    response = await options.fetch(`https://${host}${uri}`, {
      method: 'PUT',
      headers,
      body: stream,
      duplex: 'half',
      redirect: 'error',
      signal: timeout(),
    });
  } finally {
    await closeStream(stream);
  }
  if (!response.ok) throw new Error(`S3 upload failed (HTTP ${response.status})`);
  return { key, bucket };
}
function vimeoUploadURL(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('Invalid Vimeo upload URL');
  }
  if (
    u.protocol !== 'https:' ||
    u.username ||
    u.password ||
    u.port ||
    !(u.hostname === 'vimeo.com' || u.hostname.endsWith('.vimeo.com'))
  )
    throw new Error('Invalid Vimeo upload URL');
  return u.href;
}
async function uploadVimeo(recording, file, settings, options) {
  const token = String(settings.vimeoToken || '');
  if (!token || /[\r\n]/.test(token)) throw new Error('Vimeo access token is not configured');
  if (!String(recording.mime_type || '').startsWith('video/'))
    throw new Error('Vimeo export requires a video recording');
  const folder = String(settings.vimeoFolderPath || '').trim();
  if (folder && !/^\d+$/.test(folder)) throw new Error('Vimeo folder must be a numeric folder ID');
  const request = {
    upload: { approach: 'tus', size: String(file.size) },
    name: String(recording.title || 'Recording').slice(0, 128),
    privacy: { view: 'nobody' },
  };
  const res = await options.fetch('https://api.vimeo.com/me/videos', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + token,
      'content-type': 'application/json',
      accept: 'application/vnd.vimeo.*+json;version=3.4',
    },
    body: JSON.stringify(request),
    redirect: 'error',
    signal: timeout(),
  });
  if (!res.ok) throw new Error(`Vimeo creation failed (HTTP ${res.status})`);
  const meta = await res.json(),
    uri = String(meta?.uri || ''),
    match = uri.match(/^\/videos\/(\d+)$/),
    link = vimeoUploadURL(meta?.upload?.upload_link);
  if (!match || meta?.upload?.approach !== 'tus') throw new Error('Invalid Vimeo response');
  const stream = fs.createReadStream(file.path);
  let upload;
  try {
    upload = await options.fetch(link, {
      method: 'PATCH',
      headers: {
        'tus-resumable': '1.0.0',
        'upload-offset': '0',
        'content-type': 'application/offset+octet-stream',
        accept: 'application/vnd.vimeo.*+json;version=3.4',
        'content-length': String(file.size),
      },
      body: stream,
      duplex: 'half',
      redirect: 'error',
      signal: timeout(),
    });
  } finally {
    await closeStream(stream);
  }
  if (!upload.ok || Number(upload.headers.get('upload-offset')) !== file.size)
    throw new Error('Vimeo upload did not complete');
  const verification = await options.fetch(link, {
    method: 'HEAD',
    headers: { 'tus-resumable': '1.0.0', accept: 'application/vnd.vimeo.*+json;version=3.4' },
    redirect: 'error',
    signal: timeout(),
  });
  if (
    !verification.ok ||
    Number(verification.headers.get('upload-offset')) !== file.size ||
    Number(verification.headers.get('upload-length')) !== file.size
  )
    throw new Error('Vimeo upload verification failed');
  if (folder) {
    const move = await options.fetch(
      `https://api.vimeo.com/me/projects/${encode(folder)}/videos/${match[1]}`,
      {
        method: 'PUT',
        headers: {
          authorization: 'Bearer ' + token,
          accept: 'application/vnd.vimeo.*+json;version=3.4',
        },
        redirect: 'error',
        signal: timeout(),
      },
    );
    if (!move.ok) throw new Error(`Vimeo folder assignment failed (HTTP ${move.status})`);
  }
  return { uri };
}
async function exportRecording(recording, settings = {}, options = {}) {
  const enabled =
    options.enabled === true ||
    (options.enabled === undefined && process.env.RECORDING_EXPORTS_ENABLED === 'true');
  const requested = [
    ...(settings.saveRecsToS3 === true ? ['s3'] : []),
    ...(settings.saveRecsToVimeo === true ? ['vimeo'] : []),
  ];
  if (!enabled)
    return {
      enabled: false,
      results: requested.map((provider) => ({ provider, status: 'disabled' })),
    };
  if (!requested.length) return { enabled: true, results: [] };
  const roomID = String(recording?.room_id || '');
  if (!roomID || pausedRooms.has(roomID)) throw new Error('Room export is unavailable');
  activeRooms.set(roomID, (activeRooms.get(roomID) || 0) + 1);
  try {
    const file = safeFile(recording, options.recordingsDir || RECORDINGS_DIR),
      fetcher = options.fetch || globalThis.fetch;
    const opts = {
      fetch: fetcher,
      s3Region: options.s3Region || process.env.RECORDING_EXPORT_S3_REGION,
      now: options.now,
    };
    const results = [];
    for (const provider of requested) {
      try {
        const remote =
          provider === 's3'
            ? await uploadS3(recording, file, settings, opts)
            : await uploadVimeo(recording, file, settings, opts);
        results.push({ provider, status: 'complete', remote });
      } catch (error) {
        const message = String(error.message || '');
        const safe =
          /^(?:Invalid S3 bucket|S3 export region is not configured|S3 export credentials are not configured|Invalid S3 folder|Unsupported recording format|Recording exceeds the S3 single-upload limit|Vimeo access token is not configured|Vimeo export requires a video recording|Vimeo folder must be a numeric folder ID|Invalid Vimeo upload URL|Invalid Vimeo response|Vimeo upload did not complete|Vimeo upload verification failed|S3 upload failed \(HTTP [0-9]+\)|Vimeo creation failed \(HTTP [0-9]+\)|Vimeo folder assignment failed \(HTTP [0-9]+\))$/.test(
            message,
          )
            ? message
            : 'Provider request failed';
        results.push({ provider, status: 'failed', error: safe });
      }
    }
    return { enabled: true, results };
  } finally {
    const remaining = (activeRooms.get(roomID) || 1) - 1;
    if (remaining) activeRooms.set(roomID, remaining);
    else activeRooms.delete(roomID);
  }
}
module.exports = { exportRecording, pauseRoom, resumeRoom };
