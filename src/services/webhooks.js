const crypto = require('crypto');
const dns = require('dns').promises;
const http = require('http');
const https = require('https');
const net = require('net');
const db = require('../db/database');

db.exec(`CREATE TABLE IF NOT EXISTS webhook_jobs (
 id TEXT PRIMARY KEY, room_id TEXT NOT NULL, visit_id TEXT NOT NULL, event_type TEXT NOT NULL,
 url TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')),
 delivered_at TEXT DEFAULT NULL, UNIQUE(room_id,visit_id,event_type)
)`);
const blocked4 = new net.BlockList(),
  blocked6 = new net.BlockList();
for (const [subnet, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['192.88.99.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
])
  blocked4.addSubnet(subnet, bits, 'ipv4');
for (const [subnet, bits] of [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
  ['2001:10::', 28],
  ['2001:20::', 28],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
])
  blocked6.addSubnet(subnet, bits, 'ipv6');
function publicAddress(address) {
  const family = net.isIP(address);
  if (!family) return false;
  if (family === 6 && !/^2[0-9a-f]{3}:/i.test(address) && !/^3[0-9a-f]{3}:/i.test(address))
    return false;
  return !(family === 4 ? blocked4 : blocked6).check(address, family === 4 ? 'ipv4' : 'ipv6');
}
function parsedURL(value) {
  if (typeof value !== 'string' || value.length > 2048) throw Error('Invalid webhook URL');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw Error('Invalid webhook URL');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.hash
  )
    throw Error('Invalid webhook URL');
  return url;
}
function allowlisted(url) {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, ''),
    port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return String(process.env.LOCAL_WEBHOOK_ALLOWLIST || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .includes(`${host}:${port}`);
}
async function vettedAddress(url) {
  const host = url.hostname.replace(/^\[|\]$/g, ''),
    allow = allowlisted(url);
  if (!allow && /^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host))
    throw Error('Webhook destination is not public');
  const family = net.isIP(host),
    resolve = family
      ? Promise.resolve([{ address: host, family }])
      : dns.lookup(host, { all: true, verbatim: true });
  let timer;
  const addresses = await Promise.race([
    resolve,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('Webhook DNS timeout')), 5000);
    }),
  ]).finally(() => clearTimeout(timer));
  if (
    !addresses.length ||
    addresses.length > 32 ||
    (!allow && addresses.some((entry) => !publicAddress(entry.address)))
  )
    throw Error('Webhook destination is not public');
  return addresses[0];
}
function enqueueVisitEvent({
  room,
  visitId,
  eventType,
  user,
  inTime,
  outTime = null,
  duration = 0,
  isMobile = false,
}) {
  const settings = (() => {
    try {
      return JSON.parse(room.settings || '{}');
    } catch {
      return {};
    }
  })();
  const url = eventType === 'join' ? settings.login_webhook_url : settings.logout_webhook_url;
  if (!url) return null;
  const id = crypto.randomUUID(),
    payload = {
      event: eventType === 'join' ? 'room.join' : 'room.leave',
      eventId: id,
      visitId,
      room: { id: room.id || room.uuid, uuid: room.uuid, name: room.name },
      user: { id: user.uid, name: user.nick, email: user.email || '' },
      occurredAt: outTime || inTime,
      inTime,
      outTime,
      durationSeconds: duration,
      isMobile: !!isMobile,
    };
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > 32768) throw Error('Webhook payload too large');
  const result = db
    .prepare(
      'INSERT OR IGNORE INTO webhook_jobs (id,room_id,visit_id,event_type,url,payload) VALUES (?,?,?,?,?,?)',
    )
    .run(id, room.uuid, visitId, eventType, String(url).slice(0, 2049), body);
  return result.changes ? id : null;
}
const pausedRooms = new Set(),
  activeRequests = new Map();
function pauseRoom(roomID) {
  pausedRooms.add(roomID);
  for (const request of activeRequests.get(roomID) || []) request.abort();
}
function resumeRoom(roomID) {
  pausedRooms.delete(roomID);
}
async function deliver(job, signal) {
  const deadline = Date.now() + 5000,
    url = parsedURL(job.url),
    chosen = await vettedAddress(url),
    body = job.payload,
    room = db.prepare('SELECT settings FROM sessions WHERE uuid=?').get(job.room_id);
  let settings = {};
  try {
    settings = JSON.parse(room?.settings || '{}');
  } catch {}
  if (signal?.aborted) throw Error('Webhook cancelled');
  const secret = settings.webhookSecret || process.env.WEBHOOK_SECRET || '';
  const headers = {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'user-agent': 'PTR-Webhook/1.0',
    'x-ptr-event-id': job.id,
  };
  if (secret)
    headers['x-ptr-signature'] =
      'sha256=' + crypto.createHmac('sha256', String(secret)).update(body).digest('hex');
  await new Promise((resolve, reject) => {
    let settled = false,
      timer;
    const done = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve();
    };
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(
      url,
      {
        method: 'POST',
        headers,
        timeout: 5000,
        signal,
        lookup: (_host, options, callback) => {
          if (options?.all) callback(null, [chosen]);
          else callback(null, chosen.address, chosen.family);
        },
      },
      (res) => {
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > 16384) {
            res.destroy();
            done(Error('Webhook response too large'));
          }
        });
        res.on('end', () =>
          res.statusCode >= 200 && res.statusCode < 300
            ? done()
            : done(Error('Webhook response was not successful')),
        );
        res.on('error', done);
      },
    );
    timer = setTimeout(
      () => req.destroy(Error('Webhook timeout')),
      Math.max(1, deadline - Date.now()),
    );
    req.on('timeout', () => req.destroy(Error('Webhook timeout')));
    req.on('error', done);
    req.end(body);
  });
}
let running = false;
async function dispatchPending(now = Date.now()) {
  if (running) return;
  running = true;
  try {
    const jobs = db
      .prepare(
        "SELECT * FROM webhook_jobs WHERE status='pending' AND next_attempt<=? ORDER BY rowid LIMIT 20",
      )
      .all(now);
    for (const job of jobs) {
      if (pausedRooms.has(job.room_id)) continue;
      const controller = new AbortController();
      if (!activeRequests.has(job.room_id)) activeRequests.set(job.room_id, new Set());
      activeRequests.get(job.room_id).add(controller);
      try {
        await deliver(job, controller.signal);
        if (!pausedRooms.has(job.room_id))
          db.prepare(
            "UPDATE webhook_jobs SET status='delivered',attempts=attempts+1,last_error='',delivered_at=datetime('now') WHERE id=? AND status='pending'",
          ).run(job.id);
      } catch (error) {
        if (!pausedRooms.has(job.room_id)) {
          const attempts = job.attempts + 1,
            permanent = /Invalid webhook URL|destination is not public/.test(error.message);
          db.prepare(
            "UPDATE webhook_jobs SET status=?,attempts=?,next_attempt=?,last_error=? WHERE id=? AND status='pending'",
          ).run(
            permanent || attempts >= 8 ? 'failed' : 'pending',
            attempts,
            now + Math.min(3600000, 1000 * 2 ** Math.min(attempts, 12)),
            String(error.message || 'Webhook delivery failed').slice(0, 200),
            job.id,
          );
        }
      } finally {
        activeRequests.get(job.room_id)?.delete(controller);
        if (!activeRequests.get(job.room_id)?.size) activeRequests.delete(job.room_id);
      }
    }
  } finally {
    running = false;
  }
}
const worker = setInterval(
  () => dispatchPending().catch((error) => console.error('Webhook worker error:', error.message)),
  2000,
);
worker.unref();
module.exports = {
  enqueueVisitEvent,
  dispatchPending,
  publicAddress,
  parsedURL,
  pauseRoom,
  resumeRoom,
};
