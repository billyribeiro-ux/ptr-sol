const phoneService = require('../services/phone');
const sockjs = require('sockjs');
const { v4: uuid } = require('uuid');
const db = require('../db/database');
const auth = require('../middleware/auth');
const mediaService = require('../services/media');
const mailService = require('../services/mail');
const webhooks = require('../services/webhooks');
const relayService = require('../services/relay');
const { exportRecording } = require('../services/recording-exports');
const notifications = require('../services/notifications');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { RECORDINGS_DIR } = require('../config');

db.exec(`
 CREATE TABLE IF NOT EXISTS realtime_schedule_cursor (id INTEGER PRIMARY KEY CHECK(id=1), minute INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS realtime_schedule_actions (room_id TEXT NOT NULL, event_key TEXT NOT NULL, PRIMARY KEY(room_id,event_key));
 CREATE TABLE IF NOT EXISTS realtime_schedule_mail (id TEXT PRIMARY KEY,room_id TEXT NOT NULL,recipient TEXT NOT NULL,subject TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS realtime_moderation (room_id TEXT NOT NULL, user_id TEXT NOT NULL, chat_until INTEGER NOT NULL DEFAULT 0, temp_presenter INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(room_id,user_id));
 CREATE TABLE IF NOT EXISTS realtime_polls (room_id TEXT PRIMARY KEY, data TEXT NOT NULL, answers TEXT NOT NULL DEFAULT '{}', active INTEGER NOT NULL DEFAULT 1);
 CREATE TABLE IF NOT EXISTS realtime_scheduled (id TEXT PRIMARY KEY, room_id TEXT NOT NULL, user_id TEXT NOT NULL, name TEXT NOT NULL, text TEXT NOT NULL, send_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS realtime_capacity (room_id TEXT PRIMARY KEY, maximum INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS realtime_state (room_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(room_id,key));
 CREATE TABLE IF NOT EXISTS realtime_vote_rate (room_id TEXT NOT NULL,user_id TEXT NOT NULL,last_at INTEGER NOT NULL,PRIMARY KEY(room_id,user_id));
 CREATE TABLE IF NOT EXISTS realtime_votes (message_id TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY(message_id,user_id));
`);
const rooms = new Map();
const roomMedia = new Map();
const roomGateways = new Map();
const recordingLocks = new Set();
const deletingRooms = new Set();
const resettingRooms = new Set();
const processingRequests = new Map();
const debugRequests = new Map();
const rateBuckets = new Map();
function withinRate(key, limit, windowMs, now = Date.now()) {
  let bucket = rateBuckets.get(key);
  if (!bucket || bucket.until <= now) {
    if (!bucket && rateBuckets.size >= 10000) rateBuckets.delete(rateBuckets.keys().next().value);
    bucket = { count: 0, until: now + windowMs };
    rateBuckets.set(key, bucket);
  }
  bucket.count++;
  return bucket.count <= limit;
}

const presenters = (u) => u && !u.limitedPresenter && (u.perms === 'a' || u.perms === 'o');
const isRoomPresenter = (u) => !!u && (u.perms === 'a' || u.perms === 'o');
const send = (conn, type, data) => {
  try {
    conn.write(JSON.stringify({ type, data }));
  } catch (_) {}
};
const members = (room) => rooms.get(room) || new Map();
const each = (room, fn) => {
  for (const e of members(room).values()) fn(e);
};
const broadcast = (room, type, data, filter = () => true) =>
  each(room, (e) => {
    if (filter(e)) send(e.conn, type, data);
  });
const media = (room) => {
  if (!roomMedia.has(room)) roomMedia.set(room, { screens: new Map(), webcams: new Map() });
  return roomMedia.get(room);
};
function getRoomCounts(roomID) {
  const current = new Set([...members(roomID).values()].map((e) => e.user.uid)).size;
  const maximum =
    db.prepare('SELECT maximum FROM realtime_capacity WHERE room_id=?').get(roomID)?.maximum || 0;
  return { current, maximum: Math.max(maximum, current) };
}
function resetRoomCapacity(roomID) {
  const current = getRoomCounts(roomID).current;
  db.prepare(
    'INSERT INTO realtime_capacity VALUES (?,?) ON CONFLICT(room_id) DO UPDATE SET maximum=excluded.maximum',
  ).run(roomID, current);
  return { current, maximum: current };
}
const roomSettings = (room) => parseJSON(session(room)?.settings);
function livePresenter(target) {
  if (target.identity?.perms === 'a') return true;
  if (!target.roomID) return isRoomPresenter(target.user);
  const member = db
    .prepare('SELECT role FROM memberships WHERE room_id=? AND (id=? OR email=?)')
    .get(target.roomID, target.user.uid, String(target.user.email || '').toLowerCase());
  const mod = db
    .prepare('SELECT temp_presenter FROM realtime_moderation WHERE room_id=? AND user_id=?')
    .get(target.roomID, target.user.uid);
  return (
    !!mod?.temp_presenter ||
    (member
      ? ['0', '1', 'a', 'o', 'admin', 'presenter'].includes(String(member.role))
      : isRoomPresenter(target.user))
  );
}
function liveManager(entry) {
  if (entry.identity?.perms === 'a') return true;
  if (!entry.roomID) return presenters(entry.user);
  const mod = db
    .prepare('SELECT temp_presenter FROM realtime_moderation WHERE room_id=? AND user_id=?')
    .get(entry.roomID, entry.user.uid);
  if (mod?.temp_presenter) return mod.temp_presenter === 1;
  const m = db
    .prepare('SELECT role FROM memberships WHERE room_id=? AND (id=? OR email=?)')
    .get(entry.roomID, entry.user.uid, String(entry.user.email || '').toLowerCase());
  return m
    ? ['0', '1', 'a', 'o', 'presenter', 'admin'].includes(String(m.role))
    : presenters(entry.user);
}
function visibleUser(viewer, target, settings) {
  if (liveManager(viewer) || viewer.user.uid === target.user.uid) return true;
  if (settings.rosterVisibleToViewers === false) return false;
  if (settings.onlyPresentersVisibleToViewers === true && !livePresenter(target)) return false;
  return true;
}
function publicUser(target, viewer) {
  const { flags, ...view } = target.user;
  const liveFlags = target.roomID ? memberFlags(target.roomID, target.user) : flags;
  if (liveFlags?.hidePersInfo && viewer?.user.uid !== target.user.uid) delete view.email;
  return view;
}
const roster = (room, viewer) => {
  const settings = roomSettings(room);
  return Object.fromEntries(
    [...members(room).values()]
      .filter((target) => !viewer || visibleUser(viewer, target, settings))
      .map((e) => [e.user.uid, publicUser(e, viewer)]),
  );
};
function broadcastRoster(room) {
  each(room, (e) => send(e.conn, 'getRoster', roster(room, e)));
}
function broadcastPresence(room, type, target, excluded) {
  const settings = roomSettings(room);
  each(room, (e) => {
    if (e.clientId !== excluded && visibleUser(e, target, settings))
      send(e.conn, type, type === 'userJoin' ? publicUser(target, e) : target.user.uid);
  });
}
const text = (x) => (typeof x === 'string' ? x : x?.text || x?.txt || x?.msg || '');
const targetId = (x) =>
  typeof x === 'string' ? x : x?.uid || x?.userID || x?.ruid || x?.uuid_to_kick || '';
const find = (room, uid) => [...members(room).values()].filter((e) => e.user.uid === uid);
const session = (room) => db.prepare('SELECT * FROM sessions WHERE uuid=?').get(room);
const parseJSON = (s, fallback = {}) => {
  if (!s) return fallback;
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
};
const memberFlags = (room, user) => {
  const m = db
    .prepare('SELECT flags FROM memberships WHERE room_id=? AND (id=? OR email=?)')
    .get(room, user.uid, String(user.email || '').toLowerCase());
  return m ? parseJSON(m.flags) : user.flags || {};
};
const chatMuted = (room, user) => {
  const m = db
    .prepare('SELECT role,flags FROM memberships WHERE room_id=? AND (id=? OR email=?)')
    .get(room, user.uid, String(user.email || '').toLowerCase());
  return (
    !!(m && (String(m.role) === '3' || parseJSON(m.flags).muted)) ||
    (db
      .prepare('SELECT chat_until FROM realtime_moderation WHERE room_id=? AND user_id=?')
      .get(room, user.uid)?.chat_until || 0) > Date.now()
  );
};
function auditDelete(room, actor, type, record, archive = false) {
  const originalMessage = {
    id: record.id,
    uid: record.user_id || record.uid,
    user: record.name || record.nick,
    text: record.text,
    time: record.created_at || record.time,
    link: record.link || '',
  };
  const channel = record.channel || 'main';
  db.prepare('INSERT INTO audit_events(id,actor_id,room_id,action,details) VALUES (?,?,?,?,?)').run(
    uuid(),
    actor,
    room,
    archive ? 'log_archived' : 'log_deleted',
    JSON.stringify({
      logType: type,
      eventType: 'D',
      channel,
      originalMessage,
      content: record.text,
    }),
  );
}
function transactionalDelete(room, actor, type, records, archive) {
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const record of records) {
      auditDelete(room, actor, type, record, archive);
      db.prepare(
        `DELETE FROM ${type === 'chat' ? 'messages' : 'alerts'} WHERE id=? AND room_id=?`,
      ).run(record.id, room);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
function linkedRooms(room) {
  const source = session(room),
    opts = roomSettings(room);
  const configured =
    Array.isArray(opts.linkedRoomAlertsObj) && opts.linkedRoomAlertsObj.length
      ? opts.linkedRoomAlertsObj
      : typeof opts.linkedRoomAlerts === 'string'
        ? opts.linkedRoomAlerts.split(',')
        : [];
  const found = [];
  for (const value of configured) {
    const id = String(
      typeof value === 'string' ? value : value?.uuid || value?._id || value?.id || '',
    ).trim();
    if (!id) continue;
    const target = db
      .prepare(
        'SELECT uuid FROM sessions WHERE (uuid=? OR id=?) AND owner_id=? AND is_archived_room=0',
      )
      .get(id, id, source.owner_id);
    if (!target) throw Error('A linked room is unavailable or belongs to another account');
    if (target.uuid !== room && !found.includes(target.uuid)) found.push(target.uuid);
  }
  return found;
}
function relayLinkedAlert(rooms, actor, nick, body, link = '', type = 'alert') {
  for (const room of rooms) {
    const id = uuid();
    db.prepare(
      'INSERT INTO alerts(id,room_id,user_id,name,text,link,alert_type) VALUES (?,?,?,?,?,?,?)',
    ).run(id, room, actor, nick, body, link, type);
    broadcast(room, 'getAlertlog', alerts(room));
  }
}
function recordDeliveryFailure(room, alertID, actor, channel, message) {
  db.prepare('INSERT INTO audit_events(id,actor_id,room_id,action,details) VALUES (?,?,?,?,?)').run(
    uuid(),
    actor || '',
    room,
    'alert_delivery_unavailable',
    JSON.stringify({ alertId: alertID, channel, reason: message }),
  );
}
async function notifyAlert(room, alertID, actor, body, delivery, report) {
  const tasks = [];
  if (!delivery.dontPush)
    tasks.push(['push', () => notifications.sendPush({ roomID: room, text: body, alertID })]);
  if (delivery.sendTxt)
    tasks.push(['sms', () => notifications.sendSMS({ roomID: room, text: body, alertID })]);
  if (delivery.sendEmail) tasks.push(['email', () => emailAlert(room, body)]);
  if (delivery.sendTweet)
    tasks.push(['social', () => notifications.sendSocial({ roomID: room, text: body, alertID })]);
  for (const [channel, task] of tasks) {
    try {
      await task();
    } catch (error) {
      const detail = String(error.message || 'Delivery failed').slice(0, 200);
      recordDeliveryFailure(room, alertID, actor, channel, detail);
      report(`Alert posted, but ${channel} delivery failed: ${detail}`);
    }
  }
}
async function emailAlert(room, body) {
  const rows = db
    .prepare(
      "SELECT email,flags FROM memberships WHERE room_id=? AND status IN ('approved','active','accepted')",
    )
    .all(room);
  let failures = 0;
  for (const member of rows) {
    if (deletingRooms.has(room)) throw Error('Room is being deleted');
    const flags = parseJSON(member.flags);
    if (flags.alertEmail !== true && flags.emailAlerts !== true) continue;
    try {
      await mailService.sendMail({
        roomID: room,
        to: member.email,
        subject: 'Room alert',
        text: body,
      });
    } catch (_) {
      failures++;
    }
  }
  if (failures) throw Error(`${failures} alert email(s) could not be delivered`);
}

const rowMessage = (r) => ({
  _id: r.id,
  id: r.id,
  roomID: r.room_id,
  channel: r.channel || 'main',
  uid: r.user_id,
  user: r.name,
  nick: r.name,
  text: r.text,
  type: r.type,
  color: r.color,
  bkcolor: r.bkcolor,
  imgURL: r.img_url,
  onlyP: !!r.only_p,
  isAdm: !!r.is_adm,
  upV: r.upvotes,
  upvotes: r.upvotes,
  time: Date.parse(r.created_at.replace(' ', 'T') + 'Z'),
  avatar: 'app/img/user/user.png',
});
// Presenter status is retained alongside messages so a room's private chat mode can be enforced on history.
try {
  db.exec('ALTER TABLE messages ADD COLUMN is_adm INTEGER NOT NULL DEFAULT 0');
} catch (_) {}
try {
  db.exec("ALTER TABLE alerts ADD COLUMN alert_type TEXT NOT NULL DEFAULT 'alert'");
} catch (_) {}
try {
  db.exec("ALTER TABLE realtime_scheduled ADD COLUMN delivery TEXT NOT NULL DEFAULT '{}'");
} catch (_) {}
function canSee(e, msg, s) {
  if (msg.channel === 'adminChat' && !liveManager(e)) return false;
  if (msg.onlyP && !liveManager(e) && e.user.uid !== msg.uid) return false;
  if (s?.chat_mode === 'p' && !liveManager(e) && msg.uid !== e.user.uid) {
    if (!msg.isAdm) return false;
    const lower = String(msg.text || '').toLowerCase();
    if (
      lower.includes('@') &&
      !lower.includes('@all ') &&
      !lower.includes('@' + e.user.nick.toLowerCase() + ' ')
    )
      return false;
  }
  return true;
}
function history(room, e) {
  const s = session(room);
  return db
    .prepare(
      'SELECT * FROM (SELECT *, rowid AS _order FROM messages WHERE room_id=? ORDER BY rowid DESC LIMIT 200) ORDER BY _order ASC',
    )
    .all(room)
    .map(rowMessage)
    .filter((m) => canSee(e, m, s));
}
function sendHistory(room, e) {
  const all = history(room, e),
    channels = {};
  for (const m of all) if (m.channel && m.channel !== 'main') (channels[m.channel] ||= []).push(m);
  send(
    e.conn,
    'getChatlog',
    all.filter((m) => !m.channel || m.channel === 'main'),
  );
  send(e.conn, 'getChatlogChannels', channels);
}
function alerts(room) {
  return db
    .prepare(
      'SELECT * FROM (SELECT *, rowid AS _order FROM alerts WHERE room_id=? AND scheduled_at IS NULL ORDER BY rowid DESC LIMIT 100) ORDER BY _order ASC',
    )
    .all(room)
    .map((r) => ({
      _id: r.id,
      id: r.id,
      uid: r.user_id,
      user: r.name,
      nick: r.name,
      text: r.text,
      link: r.link,
      img: r.alert_type === 'imageLink' ? r.link : undefined,
      type: r.alert_type,
      time: Date.parse(r.created_at.replace(' ', 'T') + 'Z'),
    }));
}
function scheduled(room) {
  return db
    .prepare(
      'SELECT id AS _id,id,name AS nick,text,send_at AS sendAt FROM realtime_scheduled WHERE room_id=? ORDER BY send_at',
    )
    .all(room)
    .map((a) => ({ ...a, alert: { text: a.text } }));
}
function deliverScheduled() {
  for (const a of db.prepare('SELECT * FROM realtime_scheduled WHERE send_at<=?').all(Date.now())) {
    if (deletingRooms.has(a.room_id)) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT INTO alerts (id,room_id,user_id,name,text) VALUES (?,?,?,?,?)').run(
        a.id,
        a.room_id,
        a.user_id,
        a.name,
        a.text,
      );
      db.prepare('DELETE FROM realtime_scheduled WHERE id=?').run(a.id);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    if (parseJSON(a.delivery).sendLinked)
      try {
        relayLinkedAlert(linkedRooms(a.room_id), a.user_id, a.name, a.text);
      } catch (error) {
        console.error('Linked alert failed:', error.message);
        broadcast(a.room_id, 'error', { cmd: 'alertLater', message: error.message }, (e) =>
          liveManager(e),
        );
      }
    notifyAlert(a.room_id, a.id, a.user_id, a.text, parseJSON(a.delivery), (message) =>
      broadcast(a.room_id, 'error', { cmd: 'alertLater', message }, (e) => liveManager(e)),
    ).catch((error) => console.error('Scheduled notification failed:', error.message));
    broadcast(a.room_id, 'alert', {
      _id: a.id,
      id: a.id,
      uid: a.user_id,
      user: a.name,
      nick: a.name,
      text: a.text,
      time: Date.now(),
    });
    broadcast(a.room_id, 'getScheduledAlerts', scheduled(a.room_id), (e) => liveManager(e));
  }
}
const timer = setInterval(() => {
  for (const [key, expiry] of debugRequests) if (expiry < Date.now()) debugRequests.delete(key);
  for (const [key, bucket] of rateBuckets) if (bucket.until <= Date.now()) rateBuckets.delete(key);
  try {
    deliverScheduled();
  } catch (e) {
    console.error('Scheduled alert delivery failed:', e.message);
  }
}, 1000);
timer.unref();
function roomState(room, gateway) {
  const s = session(room),
    recording = db
      .prepare(
        "SELECT * FROM recordings WHERE room_id=? AND status='recording' ORDER BY rowid DESC LIMIT 1",
      )
      .get(room),
    uid = recording && parseJSON(recording.metadata).initiatorUID,
    recUser = uid ? find(room, uid)[0]?.user : null;
  return {
    status: s?.is_open ? 'open' : 'closed',
    isOpen: !!s?.is_open,
    chatMode: !s?.chat_mode || s.chat_mode === 'open' ? 'g' : s.chat_mode,
    audioRoomID: gateway.audio_id,
    videoRoomID: gateway.video_id,
    audioRoomReady: gateway.ready,
    isRecording: !!recording,
    isYTStreaming: !!(
      db
        .prepare(
          "SELECT 1 FROM realtime_relays WHERE room_id=? AND provider='youtube' AND status='streaming'",
        )
        .get(room) ||
      db
        .prepare(
          "SELECT 1 FROM realtime_obs_mounts AS m JOIN realtime_obs_egress AS e ON e.room_id=m.room_id WHERE m.room_id=? AND e.enabled=1 AND m.status='streaming'",
        )
        .get(room)
    ),
    isFBStreaming: !!db
      .prepare(
        "SELECT 1 FROM realtime_relays WHERE room_id=? AND provider='facebook' AND status='streaming'",
      )
      .get(room),
    isOBSStreaming: !!db
      .prepare("SELECT 1 FROM realtime_obs_mounts WHERE room_id=? AND status='streaming'")
      .get(room),
    recUser: { uid: uid || '', nick: recUser?.nick || '' },
    recStartTime: recording ? Date.parse(recording.started_at.replace(' ', 'T') + 'Z') : null,
    bkgImg: s?.bkg_img || '',
    bkgImgHREF: s?.bkg_img_href || '',
  };
}
async function processRecording(id) {
  try {
    const url = process.env.MEDIA_PROCESSOR_URL,
      token = process.env.MEDIA_PROCESSOR_TOKEN;
    if (!url || !token) throw new Error('Recording processor is not configured');
    const controller = new AbortController();
    processingRequests.set(id, controller);
    const response = await fetch(url.replace(/\/$/, '') + '/process', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify({ id }),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(600000)]),
    });
    if (!response.ok) throw new Error('Recording processing failed');
    const result = await response.json();
    const dir = path.resolve(RECORDINGS_DIR, id),
      file = path.resolve(String(result.file || ''));
    if (
      !result.success ||
      path.dirname(file) !== dir ||
      !['recording.mp4', 'recording.m4a'].includes(path.basename(file))
    )
      throw new Error('Invalid recording output');
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size < 100) throw new Error('Recording output is empty');
    db.prepare(
      "UPDATE recordings SET status='ready',file_path=?,duration_sec=?,mime_type=?,size_bytes=? WHERE id=? AND status='processing'",
    ).run(
      file,
      Math.max(0, Math.floor(Number(result.durationSec) || 0)),
      file.endsWith('.m4a') ? 'audio/mp4' : 'video/mp4',
      stat.size,
      id,
    );
    if (process.env.RECORDING_EXPORTS_ENABLED === 'true') {
      const recording = db
        .prepare("SELECT * FROM recordings WHERE id=? AND status='ready'")
        .get(id);
      const settings = recording ? roomSettings(recording.room_id) : {};
      if (recording && (settings.saveRecsToS3 === true || settings.saveRecsToVimeo === true))
        exportRecording(recording, settings)
          .then((outcome) => {
            const current = db
              .prepare("SELECT metadata FROM recordings WHERE id=? AND status='ready'")
              .get(id);
            if (current)
              db.prepare('UPDATE recordings SET metadata=? WHERE id=?').run(
                JSON.stringify({ ...parseJSON(current.metadata), exports: outcome.results }),
                id,
              );
          })
          .catch(() => {
            const current = db
              .prepare("SELECT metadata FROM recordings WHERE id=? AND status='ready'")
              .get(id);
            if (current)
              db.prepare('UPDATE recordings SET metadata=? WHERE id=?').run(
                JSON.stringify({
                  ...parseJSON(current.metadata),
                  exports: [{ status: 'failed', error: 'Recording export failed' }],
                }),
                id,
              );
          });
    }
  } catch (error) {
    db.prepare("UPDATE recordings SET status='failed' WHERE id=? AND status='processing'").run(id);
    throw error;
  } finally {
    processingRequests.delete(id);
  }
}
const scheduleFormatters = new Map();
function easternMinute(now, timezone = process.env.ROOM_TIMEZONE || 'America/New_York') {
  if (!scheduleFormatters.has(timezone))
    scheduleFormatters.set(
      timezone,
      new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        weekday: 'short',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }),
    );
  const parts = Object.fromEntries(
    scheduleFormatters
      .get(timezone)
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minute: `${parts.hour}:${parts.minute}`,
    weekend: parts.weekday === 'Sat' || parts.weekday === 'Sun',
  };
}
function normalizedSchedule(value) {
  if (value === null || value === undefined || value === '') return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value).trim());
  if (!match || +match[1] > 23 || +match[2] > 59) return null;
  return String(+match[1]).padStart(2, '0') + ':' + match[2];
}
async function stopOwnedRelays(room, uid) {
  for (const row of db
    .prepare('SELECT * FROM realtime_relays WHERE room_id=? AND owner_uid=?')
    .all(room, uid))
    await relayService.stop(room, row.provider);
  const obs = db
    .prepare('SELECT * FROM realtime_obs_mounts WHERE room_id=? AND owner_uid=?')
    .get(room, uid);
  if (obs) {
    await relayService.stopOBS(room);
    media(room).screens.delete(uid);
    broadcast(room, 'obsStreamStopped', { uid });
    broadcast(room, 'removeScreenStream', uid);
  }
  broadcast(room, 'getRoomState', roomState(room, roomGateways.get(room) || {}));
}
async function applyRoomState(room, open) {
  const gateway = roomGateways.get(room) || { audio_id: 0, video_id: 0, ready: false };
  broadcast(room, open ? 'reopenRoom' : 'getRoomState', open ? null : roomState(room, gateway));
  if (!open) {
    let relayFailure = null;
    try {
      await relayService.stopOBS(room);
    } catch (error) {
      relayFailure = error;
    }
    for (const relay of db
      .prepare('SELECT provider FROM realtime_relays WHERE room_id=?')
      .all(room))
      try {
        await relayService.stop(room, relay.provider);
      } catch (error) {
        relayFailure = error;
      }
    const targets = [...members(room).values()].filter((e) => !livePresenter(e));
    for (const e of targets) {
      await mediaService
        .evictUser(room, e.user.uid)
        .catch((error) => console.error('Scheduled media eviction failed:', error.message));
      send(e.conn, 'kickUser', e.user.uid);
      try {
        e.conn.close();
      } catch (_) {}
    }
    if (relayFailure) throw relayFailure;
  }
}
let schedulerBusy = false;
async function runRoomSchedule(now = new Date()) {
  if (schedulerBusy) return;
  schedulerBusy = true;
  try {
    const current = Math.floor(now.getTime() / 60000),
      cursor = db.prepare('SELECT minute FROM realtime_schedule_cursor WHERE id=1').get()?.minute;
    const start =
      cursor === undefined
        ? current - 10080
        : cursor >= current
          ? current
          : Math.max(cursor + 1, current - 10080);
    const candidates = db
      .prepare('SELECT * FROM sessions WHERE is_archived_room=0')
      .all()
      .map((room) => {
        const settings = parseJSON(room.settings);
        return {
          room,
          settings,
          open: normalizedSchedule(settings.autoOpenTime),
          close: normalizedSchedule(settings.autoCloseTime),
          created: Date.parse(
            String(room.created_at).replace(' ', 'T') +
              (/(?:Z|[+-]\d{2}:\d{2})$/.test(String(room.created_at)) ? '' : 'Z'),
          ),
        };
      })
      .filter(
        (x) =>
          !deletingRooms.has(x.room.uuid) &&
          (x.open || x.close) &&
          (!Number.isFinite(x.created) || x.created <= now.getTime()),
      );
    const latest = new Map();
    for (let tick = current; tick >= start && latest.size < candidates.length; tick--) {
      const clock = easternMinute(new Date(tick * 60000));
      for (const item of candidates) {
        if (
          latest.has(item.room.uuid) ||
          (item.settings.ignoreAutoOpenCloseOnWeekend && clock.weekend) ||
          (Number.isFinite(item.created) && tick * 60000 < item.created)
        )
          continue;
        const action =
          clock.minute === item.close ? 'close' : clock.minute === item.open ? 'open' : null;
        if (action) latest.set(item.room.uuid, { ...item, action, clock, tick });
      }
    }
    for (const { room, settings, action, clock, tick } of [...latest.values()].sort(
      (a, b) => a.tick - b.tick,
    )) {
      if (deletingRooms.has(room.uuid)) continue;
      const minute =
          action === 'open'
            ? normalizedSchedule(settings.autoOpenTime)
            : normalizedSchedule(settings.autoCloseTime),
        eventKey = `${clock.date}:${action}:${minute}`;
      let changed = false;
      db.exec('BEGIN IMMEDIATE');
      try {
        const inserted = db
          .prepare('INSERT OR IGNORE INTO realtime_schedule_actions VALUES (?,?)')
          .run(room.uuid, eventKey);
        if (inserted.changes) {
          const open = action === 'open';
          db.prepare('UPDATE sessions SET is_open=? WHERE uuid=?').run(open ? 1 : 0, room.uuid);
          const emails = [
            ...new Set(
              String(settings.sendOpenCloseEmail || '')
                .split(',')
                .map((x) => x.trim().toLowerCase())
                .filter((x) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x)),
            ),
          ];
          for (const email of emails)
            db.prepare(
              'INSERT INTO realtime_schedule_mail(id,room_id,recipient,subject,body) VALUES (?,?,?,?,?)',
            ).run(
              uuid(),
              room.uuid,
              email,
              `Room ${open ? 'opened' : 'closed'}`,
              `${room.name} is now ${open ? 'open' : 'closed'}.`,
            );
          changed = true;
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      if (changed) await applyRoomState(room.uuid, action === 'open');
    }
    db.prepare(
      'INSERT INTO realtime_schedule_cursor(id,minute) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET minute=excluded.minute',
    ).run(current);
    for (const item of db
      .prepare(
        "SELECT * FROM realtime_schedule_mail WHERE status='pending' AND next_attempt<=? ORDER BY rowid LIMIT 50",
      )
      .all(Date.now())) {
      if (deletingRooms.has(item.room_id)) continue;
      try {
        await mailService.sendMail({
          roomID: item.room_id,
          to: item.recipient,
          subject: item.subject,
          text: item.body,
        });
        db.prepare(
          "UPDATE realtime_schedule_mail SET status='sent',attempts=attempts+1 WHERE id=?",
        ).run(item.id);
      } catch (error) {
        db.prepare(
          'UPDATE realtime_schedule_mail SET attempts=attempts+1,next_attempt=? WHERE id=?',
        ).run(Date.now() + 60000, item.id);
        console.error('Room schedule notification failed:', error.message);
      }
    }
  } finally {
    schedulerBusy = false;
  }
}
let relayMonitorBusy = false;
async function monitorRelays() {
  if (relayMonitorBusy) return;
  relayMonitorBusy = true;
  try {
    for (const record of db.prepare('SELECT * FROM realtime_relays').all()) {
      if (deletingRooms.has(record.room_id) || resettingRooms.has(record.room_id)) continue;
      try {
        const current = await relayService.status(record);
        if (
          current === 'busy' ||
          !db.prepare('SELECT 1 FROM realtime_relays WHERE id=?').get(record.id)
        )
          continue;
        if (current === 'failed' || current === 'stopped' || current === 'missing') {
          await relayService.stop(record.room_id, record.provider).catch(() => {});
          broadcast(
            record.room_id,
            'error',
            {
              cmd: record.provider === 'youtube' ? 'startYTStream' : 'startFBStream',
              message: 'The streaming relay stopped before delivering media.',
            },
            (e) => e.user.uid === record.owner_uid,
          );
          broadcast(
            record.room_id,
            'getRoomState',
            roomState(record.room_id, roomGateways.get(record.room_id) || {}),
          );
        } else if (current === 'streaming' && record.status !== 'streaming')
          broadcast(
            record.room_id,
            'getRoomState',
            roomState(record.room_id, roomGateways.get(record.room_id) || {}),
          );
      } catch (error) {
        if (!/operation in progress/i.test(error.message))
          console.error('Relay status check failed:', error.message);
      }
    }
    for (const obs of db.prepare('SELECT * FROM realtime_obs_mounts').all()) {
      if (deletingRooms.has(obs.room_id) || resettingRooms.has(obs.room_id)) continue;
      try {
        const state = await relayService.obsStatus(obs);
        if (
          state === 'busy' ||
          !db.prepare('SELECT 1 FROM realtime_obs_mounts WHERE id=?').get(obs.id)
        )
          continue;
        const stream = media(obs.room_id).screens.get(obs.owner_uid),
          owner = find(obs.room_id, obs.owner_uid)[0];
        if (state === 'streaming' && obs.status !== 'streaming') {
          const data = {
            uid: obs.owner_uid,
            nick: owner?.user.nick || '',
            userName: owner?.user.nick || '',
            streamID: obs.mount_id,
            mode: 'obs',
          };
          media(obs.room_id).screens.set(obs.owner_uid, data);
          broadcast(obs.room_id, 'obsStreamStarted', data);
          broadcast(
            obs.room_id,
            'getscreenSharingUsers',
            Object.fromEntries(media(obs.room_id).screens),
          );
          broadcast(
            obs.room_id,
            'getRoomState',
            roomState(obs.room_id, roomGateways.get(obs.room_id) || {}),
          );
        } else if (state === 'waiting' && obs.status === 'streaming') {
          media(obs.room_id).screens.delete(obs.owner_uid);
          broadcast(obs.room_id, 'obsStreamStopped', { uid: obs.owner_uid });
          broadcast(obs.room_id, 'removeScreenStream', obs.owner_uid);
          broadcast(
            obs.room_id,
            'getRoomState',
            roomState(obs.room_id, roomGateways.get(obs.room_id) || {}),
          );
        } else if (state === 'missing' || state === 'failed') {
          await relayService.stopOBS(obs.room_id).catch(() => {});
          if (stream) media(obs.room_id).screens.delete(obs.owner_uid);
          broadcast(obs.room_id, 'obsStreamStopped', { uid: obs.owner_uid });
          broadcast(
            obs.room_id,
            'error',
            { cmd: 'startOBSStream', message: 'OBS ingest stopped.' },
            (e) => e.user.uid === obs.owner_uid,
          );
        }
      } catch (error) {
        if (!/operation in progress/i.test(error.message))
          console.error('OBS status check failed:', error.message);
      }
    }
  } finally {
    relayMonitorBusy = false;
  }
}
const relayTimer = setInterval(
  () => monitorRelays().catch((error) => console.error('Relay monitor failed:', error.message)),
  2000,
);
relayTimer.unref();
const scheduleTimer = setInterval(
  () => runRoomSchedule().catch((error) => console.error('Room schedule failed:', error.message)),
  15000,
);
scheduleTimer.unref();
async function deleteRoomResources(roomID) {
  const canonical = session(roomID)?.uuid || roomID;
  if (deletingRooms.has(canonical) || resettingRooms.has(canonical))
    throw Error('Room maintenance is already in progress');
  if (recordingLocks.has(canonical)) throw Error('A recording operation is in progress');
  deletingRooms.add(canonical);
  webhooks.pauseRoom(canonical);
  try {
    await phoneService.stopRoom(canonical);
    await relayService.stopOBS(canonical);
    for (const relay of db
      .prepare('SELECT provider FROM realtime_relays WHERE room_id=?')
      .all(canonical))
      await relayService.stop(canonical, relay.provider);
    await mediaService.destroyRoom(canonical);
    for (const rec of db
      .prepare("SELECT id FROM recordings WHERE room_id=? AND status IN ('recording','processing')")
      .all(canonical))
      processingRequests.get(rec.id)?.abort();
    for (const entry of [...members(canonical).values()]) {
      send(entry.conn, 'kickUser', entry.user.uid);
      try {
        entry.conn.close();
      } catch (_) {}
      entry.leave();
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(
        'DELETE FROM realtime_votes WHERE message_id IN (SELECT id FROM messages WHERE room_id=?)',
      ).run(canonical);
      for (const table of [
        'realtime_moderation',
        'realtime_polls',
        'realtime_scheduled',
        'realtime_capacity',
        'realtime_state',
        'realtime_vote_rate',
        'realtime_schedule_actions',
        'realtime_schedule_mail',
        'realtime_media_rooms',
        'realtime_relays',
        'realtime_obs_mounts',
        'realtime_obs_egress',
        'webhook_jobs',
      ])
        db.prepare(`DELETE FROM ${table} WHERE room_id=?`).run(canonical);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    rooms.delete(canonical);
    roomMedia.delete(canonical);
    roomGateways.delete(canonical);
    for (const key of debugRequests.keys())
      if (key.startsWith(canonical + ':')) debugRequests.delete(key);
  } catch (error) {
    deletingRooms.delete(canonical);
    webhooks.resumeRoom(canonical);
    throw error;
  }
}
// Reset only this room's Janus resources; the shared gateway and other rooms
// continue running. The lock excludes joins, commands and concurrent deletion.
async function restartRoomMedia(roomID) {
  const room = db.prepare('SELECT uuid FROM sessions WHERE uuid=? OR id=?').get(roomID, roomID);
  if (!room) throw Error('Room not found');
  const id = room.uuid;
  if (deletingRooms.has(id) || resettingRooms.has(id))
    throw Error('Room maintenance is already in progress');
  if (!process.env.JANUS_URL) throw Error('Media server is not configured');
  if (
    recordingLocks.has(id) ||
    db.prepare("SELECT 1 FROM recordings WHERE room_id=? AND status='recording'").get(id)
  )
    throw Error('Stop the active recording before restarting media');
  resettingRooms.add(id);
  let destroyed = false,
    completed = false;
  try {
    await phoneService.stopRoom(id);
    await relayService.stopOBS(id);
    for (const relay of db.prepare('SELECT provider FROM realtime_relays WHERE room_id=?').all(id))
      await relayService.stop(id, relay.provider);
    // From this point some clients may have been disconnected even on failure.
    destroyed = true;
    await mediaService.destroyRoom(id);
    const gateway = await mediaService.provision(id, { audioEnabled: true });
    if (!gateway.ready || !gateway.videoReady) throw Error('Janus could not provision the room');
    roomGateways.set(id, gateway);
    roomMedia.delete(id);
    for (const entry of members(id).values()) {
      entry.user.isScreenSharing = false;
      entry.user.isWebcamSharing = false;
      entry.user.isTalking = false;
      entry.watchingScreen = null;
    }
    db.prepare(
      "INSERT INTO realtime_state VALUES (?,'audioStopped','false') ON CONFLICT(room_id,key) DO UPDATE SET value=excluded.value",
    ).run(id);
    completed = true;
    return {
      roomID: id,
      audioRoomID: gateway.audio_id,
      videoRoomID: gateway.video_id,
      restarted: true,
    };
  } finally {
    resettingRooms.delete(id);
    if (destroyed && !completed) {
      roomGateways.delete(id);
      roomMedia.delete(id);
    }
    if (destroyed) broadcast(id, 'restartRoomReload', {});
  }
}
function cancelRoomDeletion(roomID) {
  deletingRooms.delete(roomID);
  webhooks.resumeRoom(roomID);
}
function attachSockJSServer(server, prefix = '/talk') {
  const sockServer = sockjs.createServer({
    log: () => {},
    faye_server_options: { maxLength: 65536 },
  });
  sockServer.on('connection', (conn) => {
    const clientId = uuid(),
      address = String(conn.remoteAddress || `connection:${clientId}`).slice(0, 128);
    let room = null,
      user = null,
      identity = null,
      loginToken = null,
      accessVersion = 0,
      gateway = { audio_id: 0, ready: false },
      closed = false,
      queued = 0;
    let queue = Promise.resolve();
    function leave() {
      if (!room || !user) return;
      const old = room,
        uid = user.uid,
        entry = members(old).get(clientId);
      if (entry?.joined) {
        const outTime = new Date().toISOString();
        const duration = Math.max(
          0,
          Math.floor((Date.parse(outTime) - Date.parse(entry.inTime)) / 1000),
        );
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare(
            'INSERT INTO audit_events(id,actor_id,room_id,action,details) VALUES (?,?,?,?,?)',
          ).run(
            uuid(),
            uid,
            old,
            'room_logout',
            JSON.stringify({
              inTime: entry.inTime,
              outTime,
              duration,
              isMobile: entry.isMobile,
              email: user.email,
              userName: user.nick,
              visitId: entry.visitId,
              ip: entry.ip,
              browser: entry.browser,
            }),
          );
          const current = session(old);
          if (current)
            webhooks.enqueueVisitEvent({
              room: current,
              visitId: entry.visitId,
              eventType: 'leave',
              user,
              inTime: entry.inTime,
              outTime,
              duration,
              isMobile: entry.isMobile,
            });
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          console.error('Room leave audit failed:', error.message);
        }
        entry.joined = false;
      }
      members(old).delete(clientId);
      if (!find(old, uid).length) {
        const m = media(old);
        if (m.screens.delete(uid)) broadcast(old, 'removeScreenStream', uid);
        if (
          db
            .prepare('SELECT 1 FROM realtime_relays WHERE room_id=? AND owner_uid=?')
            .get(old, uid) ||
          db
            .prepare('SELECT 1 FROM realtime_obs_mounts WHERE room_id=? AND owner_uid=?')
            .get(old, uid)
        )
          stopOwnedRelays(old, uid).catch((error) =>
            console.error('Relay cleanup failed:', error.message),
          );
        if (m.webcams.delete(uid)) broadcast(old, 'removeWebcamStream', uid);
        broadcastPresence(old, 'userLeft', entry || { user }, clientId);
      }
      if (!members(old).size) {
        rooms.delete(old);
        roomMedia.delete(old);
      }
      room = null;
      user = null;
      identity = null;
      loginToken = null;
    }
    async function handle(raw) {
      if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 65536) {
        send(conn, 'error', { message: 'Message exceeds size limit' });
        try {
          conn.close();
        } catch (_) {}
        return;
      }
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch (_) {
        return;
      }
      const cmd = msg?.type || msg?.cmd,
        d = msg?.data;
      if (['join', 'login', 'loginP', 'loginChat'].includes(cmd)) {
        if (!d || typeof d !== 'object' || !d.roomID) return;
        if (
          !withinRate(`join:ip:${address}`, 20, 60000) ||
          !withinRate(`join:conn:${clientId}`, 6, 60000)
        ) {
          send(conn, 'loginFailed', 'Too many login attempts; try again later.');
          return;
        }
        const existingRoom = db
          .prepare('SELECT uuid FROM sessions WHERE uuid=? OR id=?')
          .get(d.roomID, d.roomID);
        if (
          existingRoom &&
          (deletingRooms.has(existingRoom.uuid) || resettingRooms.has(existingRoom.uuid))
        ) {
          send(
            conn,
            'loginFailed',
            resettingRooms.has(existingRoom.uuid)
              ? 'Room media is restarting'
              : 'Room is being deleted',
          );
          return;
        }
        if (typeof auth.authorizeRoom !== 'function') {
          send(conn, 'loginFailed', 'Room authentication unavailable');
          return;
        }
        const result = await auth.authorizeRoom(d);
        if (!result || result.error || !result.identity || !result.room) {
          send(conn, 'loginFailed', result?.error || 'Access denied');
          return;
        }
        const authenticated = result.identity,
          s = result.room;
        if (deletingRooms.has(s.uuid) || resettingRooms.has(s.uuid)) {
          send(
            conn,
            'loginFailed',
            resettingRooms.has(s.uuid) ? 'Room media is restarting' : 'Room is being deleted',
          );
          return;
        }
        const uid = String(authenticated.uid || authenticated.id || authenticated.memberId || '');
        if (!uid) {
          send(conn, 'loginFailed', 'Access denied');
          return;
        }
        leave();
        room = String(s.uuid);
        identity = authenticated;
        accessVersion = s.access_version;
        loginToken =
          [d.jwtTokenSite, d.siteToken, d.tokenSite, d.jwtToken, d.token].find((t) =>
            auth.verifyTokenString(t),
          ) || null;
        const moderation = db
          .prepare('SELECT * FROM realtime_moderation WHERE room_id=? AND user_id=?')
          .get(room, uid);
        const memberRow = db
          .prepare('SELECT flags FROM memberships WHERE room_id=? AND (id=? OR email=?)')
          .get(room, uid, String(identity.email || '').toLowerCase());
        identity.flags = memberRow ? parseJSON(memberRow.flags) : identity.flags || {};
        user = {
          uid,
          nick: identity.nick || identity.name || 'Guest',
          email: identity.email || '',
          perms: moderation?.temp_presenter ? 'a' : identity.perms || 'r',
          limitedPresenter: moderation?.temp_presenter === 2,
          flags: identity.flags || {},
          tagline: String(d.tagline || '').slice(0, 200),
          avatar: String(d.avatar || '').slice(0, 500),
          isScreenSharing: false,
          isVideoSharing: false,
          isMuted: false,
          isChatMuted: chatMuted(room, { uid }),
        };
        if (!rooms.has(room)) rooms.set(room, new Map());
        const entry = {
          conn,
          user,
          identity,
          clientId,
          leave,
          visitId: uuid(),
          roomID: room,
          inTime: new Date().toISOString(),
          isMobile: !!d.isM,
          ip: String(conn.remoteAddress || '').slice(0, 128),
          browser: String(conn.headers?.['user-agent'] || '').slice(0, 512),
          joined: false,
        };
        rooms.get(room).set(clientId, entry);
        const count = getRoomCounts(room).current;
        db.prepare(
          'INSERT INTO realtime_capacity VALUES (?,?) ON CONFLICT(room_id) DO UPDATE SET maximum=MAX(maximum,excluded.maximum)',
        ).run(room, count);
        const stopped = db
          .prepare("SELECT value FROM realtime_state WHERE room_id=? AND key='audioStopped'")
          .get(room);
        gateway = await mediaService.provision(room, {
          audioEnabled: !parseJSON(stopped?.value, false),
        });
        roomGateways.set(room, gateway);
        if (!room || !members(room).has(clientId)) return;
        if (deletingRooms.has(room) || resettingRooms.has(room)) {
          send(
            conn,
            'loginFailed',
            resettingRooms.has(room) ? 'Room media is restarting' : 'Room is being deleted',
          );
          leave();
          try {
            conn.close();
          } catch (_) {}
          return;
        }
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare(
            'INSERT INTO audit_events(id,actor_id,room_id,action,details) VALUES (?,?,?,?,?)',
          ).run(
            uuid(),
            uid,
            room,
            'room_join',
            JSON.stringify({
              inTime: entry.inTime,
              outTime: null,
              duration: 0,
              isMobile: entry.isMobile,
              email: user.email,
              userName: user.nick,
              visitId: entry.visitId,
              ip: entry.ip,
              browser: entry.browser,
            }),
          );
          webhooks.enqueueVisitEvent({
            room: s,
            visitId: entry.visitId,
            eventType: 'join',
            user,
            inTime: entry.inTime,
            isMobile: entry.isMobile,
          });
          db.exec('COMMIT');
          entry.joined = true;
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
        const settings = roomSettings(room);
        send(conn, 'setToken', auth.signRoomToken(identity, s));
        const portID = () => crypto.randomInt(100000, 2147483647);
        send(conn, 'setPorts', {
          pub_id: portID(),
          pub_idScreen: portID(),
          pub_idWebcam: portID(),
          audioPin: '',
          audioRoomCreationLock: true,
        });
        send(conn, 'loggedIn', {
          uid: user.uid,
          nick: user.nick,
          p: user.limitedPresenter ? 'r' : user.perms,
          roomID: room,
          streamServer: gateway.streamServer,
          videoRoomID: gateway.video_id,
          canPM: !!(
            presenters(user) ||
            (!identity.flags?.restrictPM && (settings.userPM || settings.userToPresenterPM))
          ),
          hideCount:
            !presenters(user) &&
            (settings.rosterCountVisibleToViewers === false || !!identity.flags?.hideUserCount),
          hidePers: !!(settings.hidePersDetails || identity.flags?.hidePersInfo),
          hasFolder: !!(
            identity.perms === 'a' ||
            (identity.flags?.fileAccess !== 'disable' &&
              (!settings.fileAccessCaseByCase ||
                identity.flags?.fileAccess === 'enable' ||
                identity.flags?.hasFileAccess === true))
          ),
          ft: !!(identity.flags?.ft || identity.flags?.freeTrial || identity.flags?.isFreeTrial),
          nonP: !!(identity.nonPresenter || identity.flags?.nonPresenter),
        });
        if (user.limitedPresenter) send(conn, 'makeTempPresenter', 'p');
        send(conn, 'getRoster', roster(room, entry));
        send(
          conn,
          'getStateObj',
          Object.fromEntries(
            db
              .prepare('SELECT key,value FROM realtime_state WHERE room_id=?')
              .all(room)
              .map((row) => [row.key, JSON.parse(row.value)]),
          ),
        );
        send(conn, 'getscreenSharingUsers', Object.fromEntries(media(room).screens));
        send(conn, 'getwebcamSharingUsers', Object.fromEntries(media(room).webcams));
        sendHistory(room, entry);
        send(conn, 'getAlertlog', alerts(room));
        send(conn, 'getRoomState', roomState(room, gateway));
        if (user.isChatMuted) send(conn, 'muteChat', '');
        if (presenters(user)) send(conn, 'getScheduledAlerts', scheduled(room));
        broadcastPresence(room, 'userJoin', entry, clientId);
        return;
      }
      if (!room || !user || !members(room).has(clientId)) return;
      // Ignore any room ID in command payloads: the authenticated connection determines scope.
      const r = room,
        me = members(r).get(clientId),
        s = session(r);
      if (deletingRooms.has(r) || resettingRooms.has(r)) {
        send(conn, 'error', {
          cmd,
          message: resettingRooms.has(r) ? 'Room media is restarting' : 'Room is being deleted',
        });
        return;
      }
      gateway = roomGateways.get(r) || gateway;
      if (!s) {
        leave();
        return;
      }
      const banned =
        user.email &&
        db
          .prepare('SELECT 1 FROM banned_users WHERE room_id=? AND email=?')
          .get(r, user.email.toLowerCase());
      const member = identity.memberId
        ? db.prepare('SELECT * FROM memberships WHERE id=? AND room_id=?').get(identity.memberId, r)
        : db
            .prepare('SELECT * FROM memberships WHERE email=? AND room_id=?')
            .get(String(identity.email || '').toLowerCase(), r);
      const account =
        identity.accountId &&
        db.prepare('SELECT token_version FROM users WHERE id=?').get(identity.accountId);
      const revoked =
        (loginToken && !auth.verifyTokenString(loginToken)) ||
        (accessVersion !== undefined && s.access_version !== accessVersion) ||
        (identity.memberId &&
          (!member || !auth.allowedMember(member) || member.token_version !== identity.version)) ||
        (identity.accountId &&
          (!account ||
            (identity.accountKind !== 'delegate' && account.token_version !== identity.version)));
      if (member) user.flags = parseJSON(member.flags);
      const mod = db
        .prepare('SELECT temp_presenter FROM realtime_moderation WHERE room_id=? AND user_id=?')
        .get(r, user.uid);
      const basePerms =
        identity.perms === 'a'
          ? 'a'
          : member
            ? ['0', '1', 'a', 'o', 'presenter', 'admin'].includes(String(member.role))
              ? 'o'
              : 'r'
            : identity.perms || 'r';
      user.perms = mod?.temp_presenter ? 'a' : basePerms;
      user.limitedPresenter = mod?.temp_presenter === 2;
      const admin = presenters(user);
      if (banned || revoked || (!s.is_open && !admin)) {
        send(conn, 'loginFailed', 'Room access has been revoked');
        leave();
        try {
          conn.close();
        } catch (_) {}
        return;
      }
      if (
        ['chat', 'chatChannel', 'privateChat'].includes(cmd) &&
        (!withinRate(`chat:conn:${clientId}`, 40, 10000) ||
          !withinRate(`chat:ip:${address}`, 240, 10000))
      ) {
        send(conn, 'error', { cmd, message: 'Too many messages; try again later.' });
        return;
      }
      const requireAdmin = () => {
        if (!admin) send(conn, 'error', { cmd, message: 'Presenter permission required' });
        return admin;
      };
      const fail = (message) => send(conn, 'error', { cmd, message });
      switch (cmd) {
        case 'refreshMyState':
          send(conn, 'getRoster', roster(r, me));
          send(conn, 'getRoomState', roomState(r, gateway));
          sendHistory(r, me);
          break;
        case 'chat':
        case 'chatChannel': {
          if (chatMuted(r, user) || (!admin && ['d', 'disabled', 'closed'].includes(s.chat_mode)))
            return fail('Chat is muted');
          const channel =
            cmd === 'chatChannel' ? String(d?.channel || 'main').slice(0, 80) : 'main';
          if (channel === 'adminChat' && !admin) return fail('Presenter permission required');
          const body = String(text(d)).slice(0, 10000);
          if (!body.trim()) return;
          const id = uuid(),
            onlyP = !!d?.onlyP;
          db.prepare(
            'INSERT INTO messages (id,room_id,channel,user_id,name,text,type,color,bkcolor,img_url,only_p,is_adm) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
          ).run(
            id,
            r,
            channel,
            user.uid,
            user.nick,
            body,
            cmd,
            String(d?.color || '').slice(0, 40),
            String(d?.bkcolor || '').slice(0, 40),
            String(d?.imgURL || '').slice(0, 2000),
            onlyP ? 1 : 0,
            admin ? 1 : 0,
          );
          const m = rowMessage(db.prepare('SELECT * FROM messages WHERE id=?').get(id));
          const payload =
            cmd === 'chat'
              ? Object.fromEntries(Object.entries(m).filter(([key]) => key !== 'channel'))
              : m;
          broadcast(r, cmd, payload, (e) => canSee(e, m, s));
          break;
        }
        case 'privateChat': {
          if (chatMuted(r, user)) return fail('Chat is muted');
          const uid = targetId(d);
          const recipients = find(r, uid);
          if (!uid || !recipients.length) return fail('Recipient is unavailable');
          const settings = roomSettings(r);
          if (
            !admin &&
            (user.flags?.restrictPM ||
              recipients.some((e) => memberFlags(r, e.user).restrictPM) ||
              (!settings.userPM &&
                !(settings.userToPresenterPM && recipients.some((e) => livePresenter(e)))))
          )
            return fail('Private messaging is disabled');
          const payload = {
            uid: user.uid,
            nick: user.nick,
            ruid: uid,
            txt: String(text(d)).slice(0, 10000),
            time: Date.now(),
          };
          recipients.forEach((e) => send(e.conn, 'privateChat', payload));
          if (uid !== user.uid) send(conn, 'privateChat', payload);
          break;
        }
        case 'getChatLog':
          sendHistory(r, me);
          break;
        case 'deleteMessage': {
          if (!requireAdmin()) break;
          const all = history(r, me);
          const m = all.find(
            (x) =>
              (d?.id && x.id === d.id) ||
              (x.text === d?.text &&
                x.nick === d?.nick &&
                x.time === Number(d?.date) &&
                (x.channel || 'main') === (d?.channel || 'main')),
          );
          if (!m) break;
          const updates = [];
          each(r, (e) => {
            const h = history(r, e).filter((x) => (x.channel || 'main') === (m.channel || 'main'));
            const idx = h.findIndex((x) => x.id === m.id);
            if (idx >= 0) updates.push({ e, idx });
          });
          transactionalDelete(r, user.uid, 'chat', [m], false);
          for (const { e, idx } of updates)
            send(
              e.conn,
              m.channel === 'main' ? 'deleteMessage' : 'deleteMessageChannel',
              m.channel === 'main' ? idx : { channel: m.channel, i: idx },
            );
          break;
        }
        case 'clearChatLog': {
          if (!requireAdmin()) break;
          const channel = typeof d === 'string' && d ? d : 'main';
          transactionalDelete(
            r,
            user.uid,
            'chat',
            db.prepare('SELECT * FROM messages WHERE room_id=? AND channel=?').all(r, channel),
            true,
          );
          broadcast(
            r,
            channel === 'main' ? 'clearChatLog' : 'clearChannelLog',
            channel,
            (e) => channel !== 'adminChat' || liveManager(e),
          );
          each(r, (e) => sendHistory(r, e));
          break;
        }
        case 'doUpV': {
          const h = history(r, me).filter((x) => x.channel === 'main');
          const m = h.find((x) => x.uid === d?.uid && x.time === Number(d?.time));
          if (!m || m.uid === user.uid) break;
          const last = db
            .prepare('SELECT last_at FROM realtime_vote_rate WHERE room_id=? AND user_id=?')
            .get(r, user.uid);
          if (last && Date.now() - last.last_at < 30000)
            return fail('Only one upvote is allowed every 30 seconds');
          const vote = db
            .prepare('INSERT OR IGNORE INTO realtime_votes VALUES (?,?)')
            .run(m.id, user.uid);
          if (!vote.changes) break;
          db.prepare(
            'INSERT INTO realtime_vote_rate VALUES (?,?,?) ON CONFLICT(room_id,user_id) DO UPDATE SET last_at=excluded.last_at',
          ).run(r, user.uid, Date.now());
          db.prepare('UPDATE messages SET upvotes=upvotes+1 WHERE id=? AND room_id=?').run(m.id, r);
          const upV = db.prepare('SELECT upvotes FROM messages WHERE id=?').get(m.id).upvotes;
          each(r, (e) => {
            const i = history(r, e)
              .filter((x) => x.channel === 'main')
              .findIndex((x) => x.id === m.id);
            if (i >= 0) send(e.conn, 'updateMsgUpV', { idx: i, upV });
          });
          break;
        }
        case 'alert':
        case 'alertLink':
        case 'imageLink': {
          if (!requireAdmin()) break;
          const body = String(text(d)).slice(0, 10000);
          if (!body.trim()) break;
          const options = roomSettings(r),
            sendEmail = !!(d?.sendEmail && options.hasAlertEmails),
            sendTxt = !!(d?.sendTxt && options.hasAlertTxt),
            sendTweet = !!(d?.sendTweet && options.hasAlertTwitter);
          let linked = [];
          if (d?.sendLinked)
            try {
              linked = linkedRooms(r);
            } catch (error) {
              return fail(error.message);
            }
          const id = uuid(),
            link = String(d?.link || d?.img || '').slice(0, 2000);
          db.prepare(
            'INSERT INTO alerts (id,room_id,user_id,name,text,link,alert_type) VALUES (?,?,?,?,?,?,?)',
          ).run(id, r, user.uid, user.nick, body, link, cmd);
          broadcast(r, cmd, {
            _id: id,
            id,
            uid: user.uid,
            user: user.nick,
            nick: user.nick,
            text: body,
            link,
            img: cmd === 'imageLink' ? link : undefined,
            time: Date.now(),
          });
          if (linked.length) relayLinkedAlert(linked, user.uid, user.nick, body, link, cmd);
          await notifyAlert(
            r,
            id,
            user.uid,
            body,
            { sendEmail, sendTxt, sendTweet, dontPush: !!d?.dontPush },
            fail,
          );
          break;
        }
        case 'getAlertLog':
          send(conn, 'getAlertlog', alerts(r));
          break;
        case 'clearAlertLog':
          if (requireAdmin()) {
            transactionalDelete(
              r,
              user.uid,
              'alerts',
              db.prepare('SELECT * FROM alerts WHERE room_id=?').all(r),
              true,
            );
            broadcast(r, 'clearAlertLog', null);
            broadcast(r, 'getAlertlog', []);
          }
          break;
        case 'deleteAlert': {
          if (!requireAdmin()) break;
          const list = alerts(r),
            idx = list.findIndex(
              (x) => (d?.id && x.id === d.id) || (x.nick === d?.nick && x.time === Number(d?.date)),
            );
          if (idx >= 0) {
            transactionalDelete(r, user.uid, 'alerts', [list[idx]], false);
            broadcast(r, 'deleteAlert', idx);
          }
          break;
        }
        case 'alertLater': {
          if (!requireAdmin()) break;
          const at = Date.parse(d?.sendAt || d?.sendLaterDate);
          if (!Number.isFinite(at) || at <= Date.now() || !text(d))
            return fail('Invalid scheduled alert');
          const options = roomSettings(r),
            sendEmail = !!(d.sendEmail && options.hasAlertEmails),
            sendTxt = !!(d.sendTxt && options.hasAlertTxt),
            sendTweet = !!(d.sendTweet && options.hasAlertTwitter);
          if (d.sendLinked)
            try {
              linkedRooms(r);
            } catch (error) {
              return fail(error.message);
            }
          db.prepare(
            'INSERT INTO realtime_scheduled (id,room_id,user_id,name,text,send_at,delivery) VALUES (?,?,?,?,?,?,?)',
          ).run(
            uuid(),
            r,
            user.uid,
            user.nick,
            String(text(d)).slice(0, 10000),
            at,
            JSON.stringify({
              sendEmail,
              sendTxt,
              sendTweet,
              dontPush: !!d.dontPush,
              sendLinked: !!d.sendLinked,
            }),
          );
          send(conn, 'getScheduledAlerts', scheduled(r));
          break;
        }
        case 'getScheduledAlerts':
          if (requireAdmin()) send(conn, 'getScheduledAlerts', scheduled(r));
          break;
        case 'deleteScheduledAlert':
          if (requireAdmin()) {
            db.prepare('DELETE FROM realtime_scheduled WHERE room_id=? AND id=?').run(
              r,
              String(d?.id || d?._id || d || ''),
            );
            send(conn, 'getScheduledAlerts', scheduled(r));
          }
          break;
        case 'typing':
        case 'notyping': {
          if (!roomSettings(r).hasTypingIndicator || chatMuted(r, user)) break;
          const payload = { uid: user.uid, nick: user.nick, c: d?.c || d?.channel || 'main' };
          if (d?.pm) {
            const targets = find(r, String(d.pu || '')),
              settings = roomSettings(r);
            if (
              !admin &&
              (user.flags?.restrictPM ||
                targets.some((t) => memberFlags(r, t.user).restrictPM) ||
                (!settings.userPM &&
                  !(settings.userToPresenterPM && targets.some((t) => livePresenter(t)))))
            )
              break;
            for (const t of targets)
              send(t.conn, cmd === 'typing' ? 'typingPM' : 'nottypingPM', payload);
          } else if (payload.c !== 'adminChat' || admin)
            broadcast(
              r,
              cmd === 'typing' ? 'typing' : 'nottyping',
              payload,
              (e) => e.clientId !== clientId && (payload.c !== 'adminChat' || liveManager(e)),
            );
          break;
        }
        case 'resetTypingIndicator':
          if (requireAdmin()) broadcast(r, 'typingreset', null);
          break;
        case 'getUserInfo': {
          const uid = targetId(d);
          if (uid !== user.uid && !requireAdmin()) break;
          const target = find(r, uid)[0];
          if (!target) return fail('User is unavailable');
          if (uid !== user.uid && memberFlags(r, target.user).hidePersInfo)
            return fail('Personal information is hidden');
          send(conn, 'getUserInfoResp', {
            uid,
            email: target.user.email,
            inTime: target.inTime,
            browser: target.browser,
            ip: target.ip,
            mobilePin: '',
          });
          break;
        }
        case 'ups': {
          if (!requireAdmin()) break;
          const key = String(d?.key || '');
          if (!/^[a-zA-Z0-9_]{1,80}$/.test(key)) return fail('Invalid state key');
          const value = JSON.stringify(d?.val ?? null);
          if (value.length > 10000) return fail('State value too large');
          db.prepare(
            'INSERT INTO realtime_state VALUES (?,?,?) ON CONFLICT(room_id,key) DO UPDATE SET value=excluded.value',
          ).run(r, key, value);
          broadcast(r, 'stateObjValChange', { key, val: JSON.parse(value) });
          break;
        }
        case 'getRLog': {
          if (!requireAdmin()) break;
          const uid = targetId(d),
            targets = find(r, uid);
          if (!targets.length) return fail('User is unavailable');
          debugRequests.set(`${r}:${uid}:${user.uid}`, Date.now() + 30000);
          for (const t of targets) send(t.conn, 'getRLog', user.uid);
          break;
        }
        case 'getRLogResp': {
          const requester = targetId(d),
            key = `${r}:${user.uid}:${requester}`,
            deadline = debugRequests.get(key);
          debugRequests.delete(key);
          if (!deadline || deadline < Date.now()) return fail('No diagnostic request is pending');
          const output = JSON.stringify(d?.log || [])
            .slice(0, 200000)
            .replace(/[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[redacted]')
            .replace(
              /(password|passwd|jwt|token|authorization|secret|\bpw\b)[^\n]*/gi,
              '[sensitive log entry removed]',
            );
          for (const t of find(r, requester))
            if (liveManager(t)) send(t.conn, 'getRLogResp', output);
          break;
        }
        case 'restartScreen':
        case 'restartUserAudio': {
          if (!requireAdmin()) break;
          for (const target of find(r, targetId(d))) send(target.conn, cmd, null);
          break;
        }
        case 'getMyRepeater':
          send(conn, 'getMyRepeater', gateway.streamServer || '');
          break;
        case 'setScreenShareRes': {
          const screen = media(r).screens.get(user.uid);
          if (screen) {
            screen.width = Math.max(0, Math.min(10000, Number(d?.width) || 0));
            screen.height = Math.max(0, Math.min(10000, Number(d?.height) || 0));
          }
          break;
        }
        case 'userStartTalking':
        case 'userStopTalking': {
          if (!isRoomPresenter(user)) break;
          user.isTalking = cmd === 'userStartTalking';
          broadcast(r, user.isTalking ? 'talkingStart' : 'talkingEnd', user.uid);
          const talking = Object.fromEntries(
            [...members(r).values()]
              .filter((e) => e.user.isTalking)
              .map((e) => [e.user.uid, { uid: e.user.uid, nick: e.user.nick }]),
          );
          broadcast(r, 'talkingChanged', JSON.stringify(talking));
          break;
        }
        case 'userStartCam':
        case 'userStopCam':
        case 'userStartWebcam':
        case 'userStopWebcam': {
          if (!isRoomPresenter(user)) break;
          user.isWebcamSharing = cmd === 'userStartCam' || cmd === 'userStartWebcam';
          broadcastRoster(r);
          break;
        }
        case 'cmd': {
          if (d?.cmd !== 'fileShared') return fail('Unsupported room command');
          const name = String(d.data?.name || '').slice(0, 255);
          const file = db
            .prepare(
              'SELECT id FROM files WHERE room_id=? AND uploader_id=? AND original_name=? ORDER BY rowid DESC LIMIT 1',
            )
            .get(r, user.uid, name);
          if (!file) return fail('Shared file was not found');
          broadcast(r, 'fileShared', JSON.stringify({ name, sender: user.uid }));
          break;
        }
        case 'continueLoginAfterOpen':
          send(conn, 'getRoomState', roomState(r, gateway));
          break;
        case 'sendPoll':
          if (requireAdmin()) {
            const p = {
              q: { q: d?.q, choices: d?.choices, recipients: d?.recipients },
              senderUID: user.uid,
            };
            db.prepare(
              'INSERT INTO realtime_polls VALUES (?,?,?,1) ON CONFLICT(room_id) DO UPDATE SET data=excluded.data,answers=excluded.answers,active=1',
            ).run(r, JSON.stringify(p), '{}');
            broadcast(r, 'gotPoll', p, (e) => {
              const flags = memberFlags(r, e.user),
                trial = !!(flags.ft || flags.freeTrial || flags.isFreeTrial);
              return d?.recipients === 'members'
                ? !trial
                : d?.recipients === 'trials'
                  ? trial
                  : true;
            });
          }
          break;
        case 'sendPollAnswer': {
          const p = db.prepare('SELECT * FROM realtime_polls WHERE room_id=? AND active=1').get(r);
          if (!p) break;
          const poll = JSON.parse(p.data),
            trial = !!(user.flags?.ft || user.flags?.freeTrial || user.flags?.isFreeTrial);
          if (
            (poll.q.recipients === 'members' && trial) ||
            (poll.q.recipients === 'trials' && !trial)
          )
            return fail('Poll is not available to this user');
          if (
            !Number.isInteger(d?.a) ||
            d.a < 0 ||
            !Array.isArray(poll.q.choices) ||
            d.a >= poll.q.choices.length
          )
            return fail('Invalid poll answer');
          const answers = JSON.parse(p.answers);
          if (Object.hasOwn(answers, user.uid)) break;
          answers[user.uid] = d.a;
          db.prepare('UPDATE realtime_polls SET answers=? WHERE room_id=?').run(
            JSON.stringify(answers),
            r,
          );
          broadcast(
            r,
            'gotPollAnswer',
            { a: { a: d?.a }, senderUID: user.uid, senderNick: user.nick },
            (e) => liveManager(e),
          );
          break;
        }
        case 'pollDone':
          if (requireAdmin()) {
            db.prepare('UPDATE realtime_polls SET active=0 WHERE room_id=?').run(r);
            broadcast(r, 'pollDone', null);
          }
          break;
        case 'changeNick': {
          const nick = String(d?.newNick || d || '')
              .trim()
              .slice(0, 80),
            uid = d?.uid || user.uid;
          if (!nick) break;
          if (!admin && (uid !== user.uid || !roomSettings(r).allowUsersToChangeUsername))
            return fail('Username changes are disabled');
          const named = find(r, uid);
          if (!named.length) return fail('User is unavailable');
          db.prepare('UPDATE memberships SET name=? WHERE room_id=? AND (id=? OR email=?)').run(
            nick,
            r,
            uid,
            String(named[0].user.email || '').toLowerCase(),
          );
          for (const target of named) target.user.nick = nick;
          const target = named[0];
          if (target) {
            const settings = roomSettings(r);
            broadcast(r, 'userChange', { uid, newNick: nick, isP: presenters(target.user) }, (e) =>
              visibleUser(e, target, settings),
            );
          }
          break;
        }
        case 'kickUser':
        case 'kickUserReload':
        case 'kickAndBanUser': {
          if (!requireAdmin()) break;
          const uid = targetId(d),
            targets = find(r, uid);
          if (uid === user.uid) break;
          if (cmd === 'kickAndBanUser') {
            const email = targets[0]?.user.email;
            if (!email) return fail('Cannot ban user without an account');
            db.prepare('INSERT OR IGNORE INTO banned_users (room_id,email) VALUES (?,?)').run(
              r,
              email.toLowerCase(),
            );
          }
          await mediaService
            .evictUser(r, uid)
            .catch((err) => console.error('Media eviction failed:', err.message));
          for (const t of targets) {
            send(t.conn, cmd === 'kickUserReload' ? 'kickUserReload' : 'kickUser', uid);
            try {
              t.conn.close();
            } catch (_) {}
          }
          break;
        }
        case 'removeFreeTrials': {
          if (!requireAdmin()) break;
          const trials = db
            .prepare('SELECT * FROM memberships WHERE room_id=?')
            .all(r)
            .filter((m) => {
              const f = parseJSON(m.flags);
              return f.ft === true || f.freeTrial === true || f.isFreeTrial === true;
            });
          db.exec('BEGIN IMMEDIATE');
          try {
            for (const m of trials)
              db.prepare('DELETE FROM memberships WHERE id=? AND room_id=?').run(m.id, r);
            db.exec('COMMIT');
          } catch (error) {
            db.exec('ROLLBACK');
            throw error;
          }
          for (const m of trials) {
            await mediaService
              .evictUser(r, m.id)
              .catch((error) => console.error('Media eviction failed:', error.message));
            const connected = find(r, m.id);
            for (const t of connected) {
              send(t.conn, 'kickUser', m.id);
              try {
                t.conn.close();
              } catch (_) {}
            }
          }
          break;
        }
        case 'unbanUser':
          if (requireAdmin())
            db.prepare('DELETE FROM banned_users WHERE room_id=? AND email=?').run(
              r,
              String(d?.email || d || '').toLowerCase(),
            );
          break;
        case 'muteChatUser':
        case 'muteChatUser24':
        case 'unmuteChatUser': {
          if (!requireAdmin()) break;
          const uid = targetId(d);
          if (!uid) break;
          const until =
            cmd === 'unmuteChatUser'
              ? 0
              : cmd === 'muteChatUser24'
                ? Date.now() + Math.max(1, Math.min(720, Number(d?.hrs) || 24)) * 3600000
                : 8640000000000000;
          db.prepare(
            'INSERT INTO realtime_moderation (room_id,user_id,chat_until) VALUES (?,?,?) ON CONFLICT(room_id,user_id) DO UPDATE SET chat_until=excluded.chat_until',
          ).run(r, uid, until);
          for (const t of find(r, uid)) {
            t.user.isChatMuted = !!until;
            send(
              t.conn,
              cmd === 'unmuteChatUser'
                ? 'unmuteChat'
                : cmd === 'muteChatUser24'
                  ? 'muteChat24'
                  : 'muteChat',
              d?.customMsg || d?.msg || '',
            );
          }
          break;
        }
        case 'updateUser': {
          if (!requireAdmin()) break;
          if (d?.type !== 'changePerm' || !['a', 'p', 'r', 'v', 'l'].includes(d?.val))
            return fail('Unsupported permission change');
          const uid = targetId(d),
            targets = find(r, uid);
          if (!targets.length || uid === user.uid) return fail('User is unavailable');
          const target = targets[0],
            member = db
              .prepare('SELECT * FROM memberships WHERE room_id=? AND (id=? OR email=?)')
              .get(r, uid, String(target.user.email || '').toLowerCase());
          if (!member) return fail('Room membership not found');
          const enabled = d.val === 'a' || d.val === 'p';
          db.exec('BEGIN IMMEDIATE');
          try {
            db.prepare('UPDATE memberships SET role=? WHERE id=? AND room_id=?').run(
              d.val === 'a' ? '1' : '2',
              member.id,
              r,
            );
            db.prepare(
              'INSERT INTO realtime_moderation (room_id,user_id,temp_presenter) VALUES (?,?,?) ON CONFLICT(room_id,user_id) DO UPDATE SET temp_presenter=excluded.temp_presenter',
            ).run(r, uid, d.val === 'p' ? 2 : 0);
            db.exec('COMMIT');
          } catch (error) {
            db.exec('ROLLBACK');
            throw error;
          }
          if (!enabled) {
            await mediaService
              .evictUser(r, uid)
              .catch((error) => console.error('Media eviction failed:', error.message));
            const streams = media(r);
            if (streams.screens.delete(uid)) broadcast(r, 'removeScreenStream', uid);
            if (streams.webcams.delete(uid)) broadcast(r, 'removeWebcamStream', uid);
          }
          for (const t of targets) {
            t.user.perms = enabled ? 'a' : 'r';
            t.user.limitedPresenter = d.val === 'p';
            send(t.conn, 'makeTempPresenter', d.val === 'a' ? 'a' : d.val === 'p' ? 'p' : 'r');
          }
          broadcastRoster(r);
          break;
        }
        case 'makeTempPresenter': {
          if (!requireAdmin()) break;
          const uid = targetId(d),
            targets = find(r, uid),
            enabled = d?.perms !== 'r';
          if (!targets.length || uid === user.uid) break;
          db.prepare(
            'INSERT INTO realtime_moderation (room_id,user_id,temp_presenter) VALUES (?,?,?) ON CONFLICT(room_id,user_id) DO UPDATE SET temp_presenter=excluded.temp_presenter',
          ).run(r, uid, enabled ? (d?.perms === 'p' ? 2 : 1) : 0);
          if (!enabled) {
            await mediaService
              .evictUser(r, uid)
              .catch((err) => console.error('Media eviction failed:', err.message));
            const state = media(r);
            if (state.screens.delete(uid)) broadcast(r, 'removeScreenStream', uid);
            if (state.webcams.delete(uid)) broadcast(r, 'removeWebcamStream', uid);
          }
          for (const t of targets) {
            t.user.perms = enabled ? 'a' : 'r';
            t.user.limitedPresenter = enabled && d?.perms === 'p';
            send(t.conn, 'makeTempPresenter', enabled ? (d?.perms === 'p' ? 'p' : 'a') : 'r');
          }
          broadcastRoster(r);
          break;
        }
        case 'muteUser':
        case 'muteCamUser':
        case 'muteScreenUser': {
          if (!requireAdmin()) break;
          const uid = targetId(d);
          for (const t of find(r, uid))
            send(t.conn, cmd, cmd === 'muteCamUser' ? uid : { uid, muter: user.nick });
          break;
        }
        case 'openRoom':
        case 'closeRoom':
        case 'closeRoomAndRevoke': {
          if (!requireAdmin()) break;
          const open = cmd === 'openRoom';
          if (cmd === 'closeRoomAndRevoke')
            db.prepare(
              'UPDATE sessions SET is_open=0,access_version=access_version+1 WHERE uuid=?',
            ).run(r);
          else db.prepare('UPDATE sessions SET is_open=? WHERE uuid=?').run(open ? 1 : 0, r);
          await applyRoomState(r, open);
          break;
        }
        case 'changeSessionLock':
          if (requireAdmin())
            db.prepare('UPDATE sessions SET is_locked=? WHERE uuid=?').run(d ? 1 : 0, r);
          break;
        case 'setChatMode': {
          if (!requireAdmin()) break;
          const mode = String(typeof d === 'string' ? d : d?.mode || d?.chatMode || '');
          if (!['open', 'g', 'a', 'p', 'd', 'disabled'].includes(mode))
            return fail('Invalid chat mode');
          db.prepare('UPDATE sessions SET chat_mode=? WHERE uuid=?').run(mode, r);
          broadcast(r, 'getRoomState', roomState(r, gateway));
          break;
        }
        case 'setBKGImg':
        case 'setBKGImgHREF': {
          if (!requireAdmin()) break;
          const value = String(typeof d === 'string' ? d : d?.url || '').slice(0, 2000);
          db.prepare(
            `UPDATE sessions SET ${cmd === 'setBKGImg' ? 'bkg_img' : 'bkg_img_href'}=? WHERE uuid=?`,
          ).run(value, r);
          broadcast(r, cmd, value);
          break;
        }
        case 'restartRoom':
        case 'restartRoomSoft':
          if (requireAdmin()) broadcast(r, cmd, d);
          break;
        case 'loadPresenterSettings':
          if (requireAdmin()) {
            let settings = {};
            try {
              settings = JSON.parse(s.presenter_settings || '{}');
            } catch (_) {}
            send(conn, 'loadPresenterSettings', settings);
          }
          break;
        case 'getAudioRoomState':
          send(conn, 'getAudioRoomState', gateway.ready);
          break;
        case 'regenAudioRoomId':
        case 'stopAudioBridge':
        case 'resetAudioForServer': {
          if (!requireAdmin()) break;
          if (db.prepare("SELECT id FROM recordings WHERE room_id=? AND status='recording'").get(r))
            return fail('Stop recording before resetting audio');
          try {
            await phoneService.stopRoom(r);
            broadcast(r, 'newAudioRoomIDForAllStop', null);
            gateway = await mediaService.resetAudio(r, cmd === 'stopAudioBridge');
            roomGateways.set(r, gateway);
            db.prepare(
              "INSERT INTO realtime_state VALUES (?,'audioStopped',?) ON CONFLICT(room_id,key) DO UPDATE SET value=excluded.value",
            ).run(r, JSON.stringify(!gateway.ready));
            if (gateway.ready)
              broadcast(r, 'newAudioRoomIDForAll', { audioRoomID: gateway.audio_id, audioPort: 0 });
            broadcast(r, 'getRoomState', roomState(r, gateway));
          } catch (error) {
            if (gateway.ready)
              broadcast(r, 'newAudioRoomIDForAll', { audioRoomID: gateway.audio_id, audioPort: 0 });
            return fail('Could not reset audio: ' + error.message);
          }
          break;
        }
        case 'addScreenStream':
        case 'addWebcamStream': {
          if (!admin && !user.limitedPresenter) {
            fail('Presenter permission required');
            break;
          }
          const isScreen = cmd === 'addScreenStream';
          if (
            identity.perms !== 'a' &&
            ((isScreen && user.flags?.hasScreen === false) ||
              (!isScreen && user.flags?.hasCam === false))
          )
            return fail('Media permission is disabled');
          if (isScreen && d?.mode === 'videos') {
            const stream = {
              uid: user.uid,
              userName: user.nick,
              nick: user.nick,
              mode: 'videos',
              pub_id: 0,
              sessID: user.uid,
              roomID: 0,
            };
            media(r).screens.set(user.uid, stream);
            user.isVideoSharing = true;
            broadcast(r, cmd, stream);
            broadcast(r, 'getscreenSharingUsers', Object.fromEntries(media(r).screens));
            break;
          }
          if (!gateway.ready && !gateway.videoReady) return fail('Media server unavailable');
          const pub = Number(d?.pub_id);
          if (!Number.isSafeInteger(pub) || pub <= 0 || Number(d?.roomID) !== gateway.video_id)
            return fail('Invalid media publisher');
          const display = (isScreen ? 'screen-' : 'webcam-') + user.uid + (isScreen ? '-p' : '');
          let owns = false;
          for (let attempt = 0; attempt < 6 && !owns; attempt++) {
            owns = await mediaService.publisherOwned(r, pub, display);
            if (!owns && attempt < 5) await new Promise((resolve) => setTimeout(resolve, 300));
          }
          if (!members(r).has(clientId)) return;
          if (!owns) return fail('Media publisher is not registered for this user');
          const stream = {
            uid: user.uid,
            userName: user.nick,
            nick: user.nick,
            mode: isScreen ? 'screen' : 'webcam',
            pub_id: pub,
            sessID: display,
            roomID: gateway.video_id,
          };
          (isScreen ? media(r).screens : media(r).webcams).set(user.uid, stream);
          user[isScreen ? 'isScreenSharing' : 'isWebcamSharing'] = true;
          broadcast(r, cmd, stream);
          broadcast(
            r,
            isScreen ? 'getscreenSharingUsers' : 'getwebcamSharingUsers',
            Object.fromEntries(isScreen ? media(r).screens : media(r).webcams),
          );
          break;
        }
        case 'removeScreenStream':
        case 'removeWebcamStream': {
          const map = cmd === 'removeScreenStream' ? media(r).screens : media(r).webcams;
          const uid = targetId(d) || user.uid;
          if (uid !== user.uid && !requireAdmin()) break;
          if (map.delete(uid)) {
            if (cmd === 'removeScreenStream')
              await stopOwnedRelays(r, uid).catch((error) => fail(error.message));
            for (const t of find(r, uid))
              t.user[cmd === 'removeScreenStream' ? 'isScreenSharing' : 'isWebcamSharing'] = false;
            broadcast(r, cmd, uid);
          }
          break;
        }
        case 'incSSStats': {
          const uid = targetId(d);
          if (!media(r).screens.has(uid)) return fail('Screen stream is unavailable');
          me.watchingScreen = uid;
          break;
        }
        case 'decSSStats':
          if (!d || me.watchingScreen === targetId(d)) me.watchingScreen = null;
          break;
        case 'getScreenSharingStats': {
          if (!requireAdmin()) break;
          const stats = {};
          for (const uid of media(r).screens.keys()) stats[uid] = { screenWatchers: 0 };
          for (const t of members(r).values())
            if (stats[t.watchingScreen]) stats[t.watchingScreen].screenWatchers++;
          send(conn, 'getScreenSharingStats', stats);
          break;
        }
        case 'getScreenPresenters':
          send(conn, 'getscreenSharingUsers', Object.fromEntries(media(r).screens));
          break;
        case 'getWebcamPresenters':
          send(conn, 'getwebcamSharingUsers', Object.fromEntries(media(r).webcams));
          break;
        case 'playYTForAll':
        case 'stopYTForAll':
        case 'playSoundFile':
        case 'stopSoundFile':
        case 'doSoundCloudEmbed':
        case 'stopSoundCloudEmbed':
          if (requireAdmin()) broadcast(r, cmd, d);
          break;
        case 'sharedVideoPlayerCmd':
          if (requireAdmin() && d && typeof d === 'object')
            broadcast(r, cmd, { ...d, uid: user.uid });
          break;
        case 'remoteStartRec':
        case 'startRec':
        case 'stopOtherAndStartRec': {
          if (!requireAdmin()) break;
          if (
            cmd === 'remoteStartRec' &&
            !find(r, targetId(d)).some((t) => presenters(t.user) || t.user.limitedPresenter)
          )
            return fail('Presenter is unavailable');
          if (!gateway.ready) return fail('Media server unavailable');
          const existing = db
            .prepare(
              "SELECT * FROM recordings WHERE room_id=? AND status='recording' ORDER BY rowid DESC LIMIT 1",
            )
            .get(r);
          if (existing && cmd !== 'stopOtherAndStartRec')
            return fail('A recording is already active');
          const id = uuid(),
            dir = path.join(RECORDINGS_DIR, id);
          fs.mkdirSync(dir, { recursive: true });
          if (recordingLocks.has(r)) return fail('Recording operation in progress');
          recordingLocks.add(r);
          try {
            if (existing) {
              await mediaService.audioRecording(r, existing.id, false);
              await mediaService.videoRecording(r, path.join(RECORDINGS_DIR, existing.id), false);
              db.prepare(
                "UPDATE recordings SET status='processing',ended_at=datetime('now') WHERE id=?",
              ).run(existing.id);
              broadcast(r, 'recStopped', {
                uid: parseJSON(existing.metadata).initiatorUID || user.uid,
                recordingId: existing.id,
              });
              processRecording(existing.id).catch((error) =>
                console.error('Recording processing failed:', error.message),
              );
            }
            await mediaService.videoRecording(r, dir, true);
            try {
              await mediaService.audioRecording(r, id, true);
            } catch (err) {
              await mediaService.videoRecording(r, dir, false).catch(() => {});
              throw err;
            }
            db.prepare(
              "INSERT INTO recordings (id,room_id,title,status,started_at,metadata) VALUES (?,?,?,'recording',datetime('now'),?)",
            ).run(
              id,
              r,
              String(d?.title || 'Recording').slice(0, 200),
              JSON.stringify({ initiatorUID: cmd === 'remoteStartRec' ? targetId(d) : user.uid }),
            );
          } catch (err) {
            return fail('Could not start recording: ' + err.message);
          } finally {
            recordingLocks.delete(r);
          }
          broadcast(r, 'getRoomState', roomState(r, gateway));
          break;
        }
        case 'remoteStopRec':
        case 'stopRec': {
          if (!requireAdmin()) break;
          if (
            cmd === 'remoteStopRec' &&
            !find(r, targetId(d)).some((t) => presenters(t.user) || t.user.limitedPresenter)
          )
            return fail('Presenter is unavailable');
          const rec = db
            .prepare(
              "SELECT * FROM recordings WHERE room_id=? AND status='recording' ORDER BY rowid DESC LIMIT 1",
            )
            .get(r);
          if (!rec) return fail('No active recording');
          if (recordingLocks.has(r)) return fail('Recording operation in progress');
          recordingLocks.add(r);
          try {
            await mediaService.audioRecording(r, rec.id, false);
            await mediaService.videoRecording(r, path.join(RECORDINGS_DIR, rec.id), false);
            db.prepare(
              "UPDATE recordings SET status='processing',ended_at=datetime('now') WHERE id=?",
            ).run(rec.id);
          } catch (err) {
            return fail('Could not stop recording: ' + err.message);
          } finally {
            recordingLocks.delete(r);
          }
          broadcast(r, 'recStopped', {
            uid: parseJSON(rec.metadata).initiatorUID || user.uid,
            recordingId: rec.id,
          });
          broadcast(r, 'getRoomState', roomState(r, gateway));
          processRecording(rec.id).catch((err) =>
            console.error('Recording processing failed:', err.message),
          );
          break;
        }
        case 'startYTStream':
        case 'startFBStream': {
          if (!requireAdmin()) break;
          if (!roomSettings(r).hasYTStreaming)
            return fail('External streaming is disabled for this room');
          const stream = media(r).screens.get(user.uid);
          if (!stream || stream.mode !== 'screen')
            return fail('An active screen share is required');
          try {
            await relayService.start({
              roomID: r,
              provider: cmd === 'startYTStream' ? 'youtube' : 'facebook',
              key: typeof d === 'string' ? d : '',
              publisherID: stream.pub_id,
              ownerUID: user.uid,
            });
            if (!members(r).has(clientId) || !media(r).screens.has(user.uid)) {
              await relayService.stop(r, cmd === 'startYTStream' ? 'youtube' : 'facebook');
              return;
            }
            send(conn, 'showAlert', {
              msg: 'Stream is connecting; it will start once media reaches the destination.',
            });
          } catch (error) {
            return fail(error.message);
          }
          break;
        }
        case 'stopYTStream':
        case 'stopFBStream': {
          if (!requireAdmin()) break;
          try {
            await relayService.stop(r, cmd === 'stopYTStream' ? 'youtube' : 'facebook');
            broadcast(r, 'getRoomState', roomState(r, gateway));
          } catch (error) {
            return fail(error.message);
          }
          break;
        }
        case 'startOBSStream': {
          if (!requireAdmin()) break;
          try {
            const ingest = await relayService.startOBS(r, user.uid, {
              youtubeKey: d?.ytKey || '',
              youtubeURL: d?.ytURL || '',
            });
            if (!members(r).has(clientId)) {
              await relayService.stopOBS(r);
              return;
            }
            send(conn, 'obsIngestReady', { url: ingest.publishURL, mountID: ingest.mountID });
          } catch (error) {
            return fail(error.message);
          }
          break;
        }
        case 'stopOBSStream': {
          if (!requireAdmin()) break;
          const obs = db.prepare('SELECT * FROM realtime_obs_mounts WHERE room_id=?').get(r);
          try {
            await relayService.stopOBS(r);
            if (obs) {
              media(r).screens.delete(obs.owner_uid);
              broadcast(r, 'obsStreamStopped', { uid: obs.owner_uid });
              broadcast(r, 'removeScreenStream', obs.owner_uid);
            }
            broadcast(r, 'getRoomState', roomState(r, gateway));
          } catch (error) {
            return fail(error.message);
          }
          break;
        }
        case 'dialOutPhone': {
          if (!requireAdmin()) break;
          try {
            await phoneService.start({ roomID: r, origID: d?.orig_id, number: d?.phone });
          } catch (error) {
            fail(error.message);
          }
          break;
        }
        case 'hangUpDialOutPhone': {
          if (!requireAdmin()) break;
          try {
            if (!(await phoneService.stop(r, d?.orig_id))) fail('Call not found.');
          } catch (error) {
            fail(error.message);
          }
          break;
        }
        case 'getOpenPort':
          if (requireAdmin()) fail('External RTP repeater is not configured');
          break;
        default:
          fail('Unsupported realtime command');
          break; // Never relay unrecognized commands.
      }
    }
    conn.on('data', (raw) => {
      if (closed) return;
      if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 65536 || queued >= 100) {
        closed = true;
        send(conn, 'error', { message: 'Message limit exceeded' });
        try {
          conn.close();
        } catch (_) {}
        return;
      }
      queued++;
      queue = queue
        .then(() => (closed ? undefined : handle(raw)))
        .catch((err) => {
          console.error('Realtime command failed:', err.message);
          send(conn, 'error', { message: 'Unable to process command' });
        })
        .finally(() => queued--);
    });
    conn.on('close', () => {
      closed = true;
      leave();
    });
  });
  sockServer.installHandlers(server, { prefix });
  return sockServer;
}
module.exports = {
  restartRoomMedia,
  attachSockJSServer,
  getRoomCounts,
  resetRoomCapacity,
  runRoomSchedule,
  easternMinute,
  normalizedSchedule,
  deleteRoomResources,
  cancelRoomDeletion,
};
