// Captured room fields identify Twilio and FCM. Provider protocols are documented
// in contracts/provider-evidence.json; mobile custom data remains reconstructed.
const fs = require('node:fs');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const db = require('../db/database');
const { json } = require('./serializers');
db.exec(`CREATE TABLE IF NOT EXISTS notification_deliveries (
 id TEXT PRIMARY KEY, room_id TEXT NOT NULL, alert_id TEXT NOT NULL, channel TEXT NOT NULL,
 recipient_hash TEXT NOT NULL, status TEXT NOT NULL, provider_id TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
 UNIQUE(room_id,alert_id,channel,recipient_hash))`);
let oauthCache;
const activeRooms = new Map(),
  pausedRooms = new Set();
function pauseRoom(roomID) {
  if (activeRooms.get(roomID) || pausedRooms.has(roomID)) return false;
  pausedRooms.add(roomID);
  return true;
}
function resumeRoom(roomID) {
  pausedRooms.delete(roomID);
}
async function operation(args, work) {
  if (pausedRooms.has(args.roomID)) throw Error('Room deletion is in progress.');
  activeRooms.set(args.roomID, (activeRooms.get(args.roomID) || 0) + 1);
  try {
    return await work(args);
  } finally {
    const remaining = (activeRooms.get(args.roomID) || 1) - 1;
    if (remaining) activeRooms.set(args.roomID, remaining);
    else activeRooms.delete(args.roomID);
  }
}
function roomSettings(roomID) {
  const row = db
    .prepare('SELECT settings,name FROM sessions WHERE uuid=? AND is_archived_room=0')
    .get(roomID);
  if (!row) throw Error('Room not found');
  return { ...json(row.settings), roomName: row.name };
}
function providerStatus() {
  return {
    sms: process.env.TWILIO_SMS_ENABLED === 'true',
    push: process.env.FCM_ENABLED === 'true',
  };
}
function identity(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}
async function request(url, options) {
  const response = await fetch(url, {
    ...options,
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  });
  const reader = response.body?.getReader();
  let size = 0,
    chunks = [];
  if (reader)
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65536) {
        await reader.cancel();
        throw Error('Provider response too large');
      }
      chunks.push(Buffer.from(value));
    }
  let body = {};
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {}
  return { ok: response.ok, status: response.status, body };
}
function claim(roomID, alertID, channel, target) {
  const hash = identity(target),
    id = crypto.randomUUID();
  const inserted = db
    .prepare(
      "INSERT OR IGNORE INTO notification_deliveries(id,room_id,alert_id,channel,recipient_hash,status) VALUES(?,?,?,?,?,'pending')",
    )
    .run(id, roomID, alertID, channel, hash);
  return inserted.changes
    ? { id }
    : db
        .prepare(
          'SELECT id,status,provider_id FROM notification_deliveries WHERE room_id=? AND alert_id=? AND channel=? AND recipient_hash=?',
        )
        .get(roomID, alertID, channel, hash);
}
function finish(id, status, providerID = '') {
  db.prepare(
    "UPDATE notification_deliveries SET status=?,provider_id=?,updated_at=datetime('now') WHERE id=?",
  ).run(status, String(providerID).slice(0, 300), id);
}
async function deliver(targets, { roomID, alertID, channel, send }) {
  const unique = [...new Set(targets)];
  if (!unique.length)
    throw Error(`No eligible ${channel === 'sms' ? 'SMS' : 'push'} recipients are registered.`);
  if (unique.length > 1000) throw Error('Notification recipient limit exceeded.');
  const result = { accepted: 0, failed: 0, skipped: 0, unknown: 0 };
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, unique.length) }, async () => {
      while (cursor < unique.length) {
        const target = unique[cursor++],
          item = claim(roomID, alertID, channel, target);
        if (item.status) {
          if (item.status === 'accepted') result.skipped++;
          else if (item.status === 'pending' || item.status === 'unknown') result.unknown++;
          else result.failed++;
          continue;
        }
        try {
          const outcome = await send(target);
          if (outcome.ok) {
            finish(item.id, 'accepted', outcome.id);
            result.accepted++;
          } else {
            finish(item.id, 'failed');
            result.failed++;
          }
        } catch {
          finish(item.id, 'unknown');
          result.unknown++;
        }
      }
    }),
  );
  if (result.failed || result.unknown)
    throw Object.assign(
      Error(
        `${channel === 'sms' ? 'SMS' : 'Push'} provider accepted ${result.accepted + result.skipped} message(s); ${result.failed} failed and ${result.unknown} have an unknown outcome.`,
      ),
      { delivery: result },
    );
  return result;
}
function checkedText(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4000)
    throw Error('Notification text must be between 1 and 4000 characters.');
  return value.trim();
}
function phone(value) {
  const raw = String(value)
    .trim()
    .replace(/[\s().-]/g, '');
  return /^\+[1-9]\d{7,14}$/.test(raw) ? raw : /^\d{10}$/.test(raw) ? '+1' + raw : null;
}
async function sendSMS({ roomID, text, alertID = crypto.randomUUID() }) {
  text = checkedText(text);
  const s = roomSettings(roomID);
  if (!providerStatus().sms) throw Error('SMS delivery is not configured.');
  const sid = s.twillioApiSID || process.env.TWILIO_ACCOUNT_SID,
    secret = s.twillioApiToken || process.env.TWILIO_AUTH_TOKEN,
    from = phone(s.twilioPhone || process.env.TWILIO_PHONE || '');
  if (!/^AC[a-fA-F0-9]{32}$/.test(sid || '') || typeof secret !== 'string' || !secret || !from)
    throw Error('Twilio SMS credentials are not configured.');
  const raw = String(s.textList || '')
      .split(/[\n,;]+/)
      .map((x) => x.trim())
      .filter(Boolean),
    targets = raw.map(phone);
  if (targets.some((x) => !x)) throw Error('The SMS text list contains an invalid phone number.');
  return deliver(targets, {
    roomID,
    alertID,
    channel: 'sms',
    send: async (target) => {
      const r = await request(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST',
        headers: {
          authorization: 'Basic ' + Buffer.from(sid + ':' + secret).toString('base64'),
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: target, From: from, Body: text }),
      });
      return {
        ok:
          r.ok &&
          typeof r.body.sid === 'string' &&
          ['queued', 'accepted', 'sending', 'sent', 'delivered'].includes(r.body.status),
        id: r.body.sid,
      };
    },
  });
}
function oauth1Authorization(token, secret, consumerKey, consumerSecret) {
  const encode = (value) =>
    encodeURIComponent(value).replace(
      /[!'()*]/g,
      (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
    );
  const fields = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: crypto.randomBytes(18).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: token,
    oauth_version: '1.0',
  };
  const params = Object.entries(fields)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => encode(key) + '=' + encode(value))
    .join('&');
  const base = 'POST&' + encode('https://api.x.com/2/tweets') + '&' + encode(params);
  fields.oauth_signature = crypto
    .createHmac('sha1', encode(consumerSecret) + '&' + encode(secret))
    .update(base)
    .digest('base64');
  return (
    'OAuth ' +
    Object.entries(fields)
      .map(([key, value]) => encode(key) + '="' + encode(value) + '"')
      .join(', ')
  );
}
// X credentials are deliberately operator-provided: captured settings identify the
// feature, but do not expose the original provider authentication mechanism.
async function sendSocial({ roomID, text, alertID = crypto.randomUUID() }) {
  text = checkedText(text);
  const settings = roomSettings(roomID);
  const oauthToken = settings.xuserAccessToken,
    oauthSecret = settings.xuserAccessTokenSecret;
  const consumer = process.env.X_CONSUMER_KEY,
    consumerSecret = process.env.X_CONSUMER_SECRET;
  const bearer = process.env.X_USER_ACCESS_TOKEN;
  let authorization;
  if (oauthToken && oauthSecret && consumer && consumerSecret)
    authorization = oauth1Authorization(oauthToken, oauthSecret, consumer, consumerSecret);
  else if (bearer && process.env.X_POSTING_ROOM_ID === roomID) authorization = 'Bearer ' + bearer;
  if (process.env.X_POSTING_ENABLED !== 'true' || !authorization)
    throw Error('Social delivery is not configured.');
  if ([...text].length > 280) throw Error('Social post exceeds 280 characters.');
  const item = claim(roomID, alertID, 'social', 'x-account');
  if (item.status === 'accepted') return { accepted: 0, skipped: 1 };
  if (item.status)
    throw Error('Social post was already attempted; its outcome is ' + item.status + '.');
  let response;
  try {
    response = await request('https://api.x.com/2/tweets', {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  } catch {
    finish(item.id, 'unknown');
    throw Error('Social post outcome is unknown.');
  }
  if (response.ok && typeof response.body.data?.id === 'string' && response.body.data.id) {
    finish(item.id, 'accepted', response.body.data.id);
    return { accepted: 1, skipped: 0 };
  }
  // A 5xx or malformed success can follow a completed write, so do not retry it.
  const uncertain = response.status >= 500 || response.ok;
  finish(item.id, uncertain ? 'unknown' : 'failed');
  throw Error(uncertain ? 'Social post outcome is unknown.' : 'Social provider rejected the post.');
}
function serviceAccount() {
  let source = process.env.FCM_SERVICE_ACCOUNT_JSON;
  if (!source && process.env.FCM_SERVICE_ACCOUNT_FILE)
    try {
      source = fs.readFileSync(process.env.FCM_SERVICE_ACCOUNT_FILE, 'utf8');
    } catch {
      throw Error('FCM service account file is unavailable.');
    }
  let account;
  try {
    account = JSON.parse(source || '{}');
  } catch {
    throw Error('FCM service account is invalid.');
  }
  if (
    !/^[a-z][a-z0-9-]{4,62}$/.test(account.project_id || '') ||
    typeof account.client_email !== 'string' ||
    !account.client_email.endsWith('.gserviceaccount.com') ||
    typeof account.private_key !== 'string'
  )
    throw Error('FCM service account is not configured.');
  return account;
}
async function accessToken(account) {
  const cacheKey = identity(account.client_email + account.private_key);
  if (oauthCache?.key === cacheKey && oauthCache.expires > Date.now() + 60000)
    return oauthCache.token;
  let assertion;
  try {
    assertion = jwt.sign(
      { scope: 'https://www.googleapis.com/auth/firebase.messaging' },
      account.private_key,
      {
        algorithm: 'RS256',
        issuer: account.client_email,
        audience: 'https://oauth2.googleapis.com/token',
        expiresIn: 3600,
      },
    );
  } catch {
    throw Error('FCM signing credential is invalid.');
  }
  const r = await request('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!r.ok || typeof r.body.access_token !== 'string' || !r.body.access_token)
    throw Error('FCM authentication failed.');
  oauthCache = {
    key: cacheKey,
    token: r.body.access_token,
    expires: Date.now() + Math.min(3600, Number(r.body.expires_in) || 3600) * 1000,
  };
  return oauthCache.token;
}
function memberTokens(member, settings) {
  const f = json(member.flags);
  if (
    f.alerterAppFCMUserOff ||
    f.notificationsPaused ||
    (settings.ptrMobileAppCaseByCaseEnabled && f.hasMobileApp !== true)
  )
    return [];
  return [
    ...(Array.isArray(f.fcmTokens) ? f.fcmTokens : []),
    ...(Array.isArray(f.alerterAppTokens) ? f.alerterAppTokens : []),
  ]
    .map((t) => (typeof t === 'string' ? t : t?.token || t?.fcmToken || t?.tok))
    .filter((t) => typeof t === 'string' && t.length >= 10 && t.length <= 4096);
}
async function sendPush({ roomID, memberID, text, title, alertID = crypto.randomUUID() }) {
  text = checkedText(text);
  const s = roomSettings(roomID);
  if (s.diasableFCMAlerts) return { accepted: 0, skipped: 0, disabled: true };
  const rows = memberID
    ? db
        .prepare(
          "SELECT * FROM memberships WHERE room_id=? AND id=? AND status IN ('approved','active','accepted') AND role!='4'",
        )
        .all(roomID, memberID)
    : db
        .prepare(
          "SELECT * FROM memberships WHERE room_id=? AND status IN ('approved','active','accepted') AND role!='4'",
        )
        .all(roomID);
  const targets = rows.flatMap((member) => memberTokens(member, s));
  if (!targets.length) return { accepted: 0, skipped: 0, recipients: 0 };
  if (!providerStatus().push) throw Error('Push delivery is not configured.');
  const account = serviceAccount(),
    token = await accessToken(account);
  return deliver(targets, {
    roomID,
    alertID,
    channel: 'push',
    send: async (target) => {
      const r = await request(
        `https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`,
        {
          method: 'POST',
          headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
          body: JSON.stringify({
            message: {
              token: target,
              notification: { title: String(title || s.roomName).slice(0, 200), body: text },
              data: { roomID: String(roomID), alertID: String(alertID) },
            },
          }),
        },
      );
      return { ok: r.ok && typeof r.body.name === 'string', id: r.body.name };
    },
  });
}
module.exports = {
  sendSMS: (args) => operation(args, sendSMS),
  sendPush: (args) => operation(args, sendPush),
  sendSocial: (args) => operation(args, sendSocial),
  providerStatus,
  memberTokens,
  pauseRoom,
  resumeRoom,
};
