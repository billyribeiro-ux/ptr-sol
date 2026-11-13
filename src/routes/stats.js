const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db/database');
const { authenticateRequest, requireRoomAccess } = require('../middleware/auth');
const ser = require('../services/serializers');
const { userActivity } = require('../services/activity');
const { cloneRoom } = require('../services/rooms');
const router = express.Router();
const lastRequest = new Map();
const commands = new Set([
  'delUsers',
  'addUsers',
  'list',
  'userstats',
  'users',
  'chatlogs',
  'alertlogs',
  'deletedlogs',
  'archivedlogs',
  'recordings',
  'cloneSession',
]);
const fail = (res, status, message) => res.status(status).json({ success: false, message });
const email = (v) =>
  String(v || '')
    .trim()
    .toLowerCase();
const validEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
function equalSecret(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest(),
    y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
function dateMs(value) {
  if (!value) return null;
  const n = Date.parse(value);
  return Number.isFinite(n) ? n : NaN;
}
function dateRange(req, res) {
  const from = dateMs(req.query.fromDate),
    to = dateMs(req.query.toDate);
  if (Number.isNaN(from) || Number.isNaN(to) || (from !== null && to !== null && from > to)) {
    fail(res, 400, 'Invalid date range.');
    return null;
  }
  return { from, to };
}
function inRange(time, range) {
  const n = Date.parse(time);
  return (
    Number.isFinite(n) &&
    (range.from === null || n >= range.from) &&
    (range.to === null || n <= range.to)
  );
}
function stamp(value) {
  if (!value) return null;
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}
function rowSession(row) {
  const value = ser.session(row);
  return {
    _id: row.id || row.uuid,
    uuid: row.uuid,
    name: row.name,
    currentState: value.currentState,
    current_capacity: value.current_capacity,
    current_max: value.current_max ?? value.recordedMaxCapacity,
    modCount: db
      .prepare(
        "SELECT COUNT(*) AS n FROM memberships WHERE room_id=? AND role IN ('1','a','o','admin','presenter')",
      )
      .get(row.uuid).n,
    recordedMaxCapacity: value.recordedMaxCapacity,
    created: stamp(row.created_at),
    isMainRoom: !!row.is_main_room,
    media: [],
    recording: !!db
      .prepare("SELECT 1 FROM recordings WHERE room_id=? AND status='recording'")
      .get(row.uuid),
  };
}
router.use('/sessions/:command', (req, res, next) => {
  const cmd = req.params.command;
  if (!commands.has(cmd)) return fail(res, 404, 'Unknown API command.');
  const id = String(req.query.apiKey || ''),
    secret = String(req.query.apiSecret || '');
  if (!id || !secret || id.length > 256 || secret.length > 512)
    return fail(res, 403, 'Invalid API credentials.');
  const row = db.prepare('SELECT * FROM api_keys WHERE id=? AND revoked_at IS NULL').get(id);
  if (!row || !equalSecret(secret, row.api_key)) return fail(res, 403, 'Invalid API credentials.');
  // Reuse the common principal and endpoint restriction logic with a scoped synthetic request.
  const principal = authenticateRequest({
    headers: { authorization: `Bearer ${secret}` },
    body: { cmd },
    query: {},
    baseUrl: '/stats/v1',
    path: `/sessions/${cmd}`,
    method: req.method,
  });
  if (!principal || !principal.is_api_key) return fail(res, 403, 'API endpoint is not permitted.');
  req.statsUser = principal;
  if (cmd !== 'list') {
    const roomId = String(req.query.sessionID || '');
    if (!roomId || !db.prepare('SELECT 1 FROM sessions WHERE uuid=? OR id=?').get(roomId, roomId))
      return fail(res, 400, 'Invalid session.');
    const room = requireRoomAccess(principal, roomId, { manage: true });
    if (!room) return fail(res, 403, 'Session is not permitted.');
    req.statsRoom = room;
  }
  const key = `${row.id}:${cmd}`,
    now = Date.now(),
    previous = lastRequest.get(key) || 0;
  if (now - previous < 1000) {
    res.set('Retry-After', '1');
    return fail(res, 429, 'Rate limit exceeded.');
  }
  lastRequest.set(key, now);
  // Keep the rate limiter bounded even when keys are frequently rotated.
  if (lastRequest.size > 10000)
    for (const [k, t] of lastRequest) if (now - t > 60000) lastRequest.delete(k);
  next();
});
router.get('/sessions/list', (req, res) => {
  const rooms = db
    .prepare('SELECT * FROM sessions WHERE owner_id=? ORDER BY created_at DESC')
    .all(req.statsUser.id)
    .filter((r) => requireRoomAccess(req.statsUser, r.uuid, { manage: true }));
  return res.json({ success: true, sessions: rooms.map(rowSession) });
});
router.post('/sessions/addUsers', (req, res) => {
  const users = req.body?.users;
  if (!Array.isArray(users) || !users.length || users.some((u) => !validEmail(email(u?.email))))
    return fail(res, 400, 'Valid users are required.');
  let added = 0,
    freshen = 0;
  const now = new Date().toISOString(),
    room = req.statsRoom.uuid;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const u of users) {
      const e = email(u.email),
        member = db.prepare('SELECT * FROM memberships WHERE room_id=? AND email=?').get(room, e);
      if (member) {
        const flags = ser.json(member.flags);
        flags.activeDateAPI = now;
        db.prepare('UPDATE memberships SET flags=? WHERE id=?').run(
          JSON.stringify(flags),
          member.id,
        );
        freshen++;
      } else {
        const flags = JSON.stringify({ activeDateAPI: now });
        const hash = bcrypt.hashSync(crypto.randomBytes(24).toString('base64url'), 10);
        db.prepare(
          'INSERT INTO memberships (id,room_id,email,name,password_hash,role,status,flags) VALUES (?,?,?,?,?,?,?,?)',
        ).run(
          crypto.randomUUID(),
          room,
          e,
          String(u.name || e).slice(0, 120),
          hash,
          '2',
          'approved',
          flags,
        );
        added++;
      }
    }
    db.exec('COMMIT');
    return res.json({ success: true, added, freshen });
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
});
router.post('/sessions/delUsers', (req, res) => {
  const list = req.body?.delUsers;
  if (!Array.isArray(list) || !list.length || list.some((x) => !validEmail(email(x))))
    return fail(res, 400, 'Valid users are required for deletion.');
  const deletedUsers = [],
    pendingFCM = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const address of new Set(list.map(email))) {
      const member = db
        .prepare('SELECT * FROM memberships WHERE room_id=? AND email=?')
        .get(req.statsRoom.uuid, address);
      if (!member) continue;
      const flags = ser.json(member.flags);
      if ((flags.fcmTokens || []).length || (flags.alerterAppTokens || []).length)
        pendingFCM.push(address);
      db.prepare('DELETE FROM memberships WHERE id=?').run(member.id);
      deletedUsers.push(address);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return res.json({
    success: true,
    deletedUsers,
    ...(pendingFCM.length
      ? { fcmUnsubscription: 'unavailable', fcmUnsubscriptionPending: pendingFCM }
      : {}),
  });
});
router.get('/sessions/users', (req, res) => {
  const users = db
    .prepare('SELECT * FROM memberships WHERE room_id=? ORDER BY created_at DESC')
    .all(req.statsRoom.uuid)
    .map((m) => {
      const v = ser.membership(m),
        flags = ser.json(m.flags),
        apiActivity = flags.activeDateAPI || null;
      const login = db
        .prepare(
          "SELECT details FROM audit_events WHERE room_id=? AND actor_id=? AND action IN ('room_login','room_join') ORDER BY created_at DESC LIMIT 1",
        )
        .get(req.statsRoom.uuid, m.id);
      const eventLogin = login ? ser.json(login.details).inTime || null : null;
      const lastLogin =
        (Date.parse(flags.lastLogin) || 0) > (Date.parse(eventLogin) || 0)
          ? flags.lastLogin
          : eventLogin;
      const latest = Math.max(Date.parse(apiActivity) || 0, Date.parse(lastLogin) || 0);
      return {
        ...v,
        created: stamp(m.created_at),
        lastLogin,
        activeDateAPI: apiActivity,
        active: latest > 0 && Date.now() - latest < 86400000,
        alerterAppFCMUserOff: !!flags.alerterAppFCMUserOff,
        alerterAppTokens: flags.alerterAppTokens || [],
      };
    });
  return res.json({ success: true, users });
});
router.get('/sessions/userstats', (req, res) => {
  const range = dateRange(req, res);
  if (!range) return;
  const rows = userActivity(req.statsRoom.uuid)
    .filter(
      (r) => inRange(r.inTime, range) && (req.query.isMobile !== 'true' || r.isMobile === true),
    )
    .map((r) => ({ ...r, ...(r.duration != null ? { duration: r.duration * 1000 } : {}) }));
  return res.json({ success: true, userstats: rows });
});
router.get('/sessions/chatlogs', (req, res) => {
  const range = dateRange(req, res);
  if (!range) return;
  const channel = String(req.query.channel || 'main');
  const rows = db
    .prepare('SELECT * FROM messages WHERE room_id=? AND channel=? ORDER BY created_at')
    .all(req.statsRoom.uuid, channel)
    .filter((r) => inRange(stamp(r.created_at), range))
    .map((r) => ({
      sessionID: r.room_id,
      c: r.channel,
      t: stamp(r.created_at),
      u: r.email || r.name,
      m: r.text,
    }));
  return res.json({ success: true, chatlogs: rows });
});
router.get('/sessions/alertlogs', (req, res) => {
  const range = dateRange(req, res);
  if (!range) return;
  const rows = db
    .prepare('SELECT * FROM alerts WHERE room_id=? ORDER BY created_at')
    .all(req.statsRoom.uuid)
    .filter((r) => inRange(stamp(r.created_at), range))
    .map((r) => ({
      sessionID: r.room_id,
      t: stamp(r.created_at),
      alertType: ser.json(r.metadata).alertType || 'alert',
      message: r.text,
    }));
  return res.json({ success: true, chatlogs: rows });
});
function logs(req, res, type) {
  const range = dateRange(req, res);
  if (!range) return;
  const logType = String(req.query.logType || (type === 'archivedlogs' ? 'chat' : ''));
  if (logType && !['chat', 'alerts'].includes(logType)) return fail(res, 400, 'Invalid logType.');
  const eventType = String(req.query.eventType || '');
  if (eventType && !['E', 'D'].includes(eventType)) return fail(res, 400, 'Invalid eventType.');
  const action = type === 'deletedlogs' ? 'log_deleted' : 'log_archived';
  const rows = db
    .prepare('SELECT * FROM audit_events WHERE room_id=? AND action=? ORDER BY created_at')
    .all(req.statsRoom.uuid, action)
    .map((r) => {
      const d = ser.json(r.details);
      return {
        sessionID: r.room_id,
        logType: d.logType,
        eventType: d.eventType,
        time: stamp(r.created_at),
        updated: stamp(r.created_at),
        channel: d.channel || 'main',
        originalMessage:
          typeof d.originalMessage === 'object'
            ? d.originalMessage?.text
            : (d.originalMessage ?? d.content),
        content:
          d.content ??
          (typeof d.originalMessage === 'object' ? d.originalMessage?.text : d.originalMessage),
      };
    })
    .filter(
      (r) =>
        (!logType || r.logType === logType) &&
        (!eventType || r.eventType === eventType) &&
        (type !== 'archivedlogs' ||
          r.logType !== 'chat' ||
          r.channel === String(req.query.channel || 'main')) &&
        inRange(r.time, range),
    );
  return res.json({ success: true, [type]: rows });
}
router.get('/sessions/deletedlogs', (req, res) => logs(req, res, 'deletedlogs'));
router.get('/sessions/archivedlogs', (req, res) => logs(req, res, 'archivedlogs'));
router.get('/sessions/recordings', (req, res) => {
  const cutoff = Date.now() - 21 * 86400000;
  const rows = db
    .prepare('SELECT * FROM recordings WHERE room_id=? ORDER BY created_at DESC')
    .all(req.statsRoom.uuid)
    .filter((r) => Date.parse(stamp(r.created_at)) >= cutoff)
    .map((r) => {
      const v = ser.recording(r);
      return {
        ...v,
        sessionID: r.room_id,
        created: stamp(r.created_at),
        duration: (r.duration_sec || 0) / 60,
        length: (r.duration_sec || 0) * 1000,
        fpath: v.vidPath,
        contentType: (r.mime_type || 'video/webm').split('/').pop(),
        isUpload: !!ser.json(r.metadata).isUpload,
      };
    });
  return res.json({ success: true, recordings: rows });
});
router.get('/sessions/cloneSession', (req, res) => {
  const name = String(req.query.name || '').trim();
  if (!name || name.length > 120) return fail(res, 400, 'A session name is required.');
  const source = req.statsRoom;
  const plan = db
    .prepare(
      'SELECT p.max_rooms FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.user_id=?',
    )
    .get(source.owner_id);
  if (!plan) return fail(res, 503, 'Local room limit is unavailable.');
  const owner = db.prepare('SELECT is_admin FROM users WHERE id=?').get(source.owner_id);
  const count = db
    .prepare('SELECT COUNT(*) AS n FROM sessions WHERE owner_id=? AND is_archived_room=0')
    .get(source.owner_id).n;
  if (count >= plan.max_rooms && !owner?.is_admin) return fail(res, 403, 'Room limit reached.');
  const room = cloneRoom(source, name);
  return res.json({
    success: true,
    session: {
      ...rowSession(room),
      isClonedRoom: true,
      clonedFrom: source.id || source.uuid,
      ownerdID: source.owner_id,
    },
  });
});
module.exports = router;
