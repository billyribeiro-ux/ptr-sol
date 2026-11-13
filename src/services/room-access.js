const db = require('../db/database');
const { authenticateRequest, requireRoomAccess } = require('../middleware/auth');
const { json } = require('./serializers');
function canAccessFiles(user, roomId) {
  const room = requireRoomAccess(user, roomId);
  if (!room) return false;
  if (requireRoomAccess(user, room.uuid, { manage: true })) return true;
  const member = db
    .prepare('SELECT flags FROM memberships WHERE room_id=? AND email=?')
    .get(room.uuid, String(user.email || '').toLowerCase());
  const flags = json(member?.flags);
  if (flags.fileAccess === 'disable') return false;
  if (
    json(room.settings).fileAccessCaseByCase &&
    flags.fileAccess !== 'enable' &&
    !flags.hasFileAccess
  )
    return false;
  return true;
}

function canAccessArchives(user, roomId, { type } = {}) {
  const room = requireRoomAccess(user, roomId);
  if (!room) return false;
  if (requireRoomAccess(user, room.uuid, { manage: true })) return true;
  const member = db.prepare('SELECT * FROM memberships WHERE room_id=? AND email=?').get(
    room.uuid,
    String(user.email || '')
      .trim()
      .toLowerCase(),
  );
  const flags = json(member?.flags),
    settings = json(room.settings);
  if (flags.denyArchivesAccess) return false;
  if (settings.hideChatLog && ['chat', 'messages'].includes(type)) return false;
  const presenter =
    ['a', 'o'].includes(user.perms) ||
    ['0', '1', 'a', 'o', 'admin', 'presenter'].includes(String(member?.role));
  if (presenter) {
    const list = String(settings.showArchivesToSpecificPresenters || '')
      .split(',')
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean);
    return (
      !list.length ||
      list.includes(
        String(user.email || '')
          .trim()
          .toLowerCase(),
      )
    );
  }
  return settings.showArchivesToUsers === true;
}

function canAccessRecordings(user, roomId) {
  const room = requireRoomAccess(user, roomId);
  if (!room) return false;
  if (requireRoomAccess(user, room.uuid, { manage: true })) return true;
  const member = db.prepare('SELECT flags FROM memberships WHERE room_id=? AND email=?').get(
    room.uuid,
    String(user.email || '')
      .trim()
      .toLowerCase(),
  );
  const settings = json(room.settings);
  if (json(member?.flags).denyArchivesAccess || settings.hideRecs) return false;
  return settings.recsInRoom === true || canAccessArchives(user, room.uuid);
}

function authenticateRoomRequest(req, roomId) {
  req.authRoomId = roomId;
  let user = authenticateRequest(req);
  if (user && requireRoomAccess(user, roomId)) return user;
  if (!req.headers?.cookie) return null;
  const cookieOnly = {
    headers: { cookie: req.headers.cookie },
    body: {},
    query: {},
    authRoomId: roomId,
    method: req.method,
    baseUrl: req.baseUrl,
    path: req.path,
  };
  user = authenticateRequest(cookieOnly);
  return user && requireRoomAccess(user, roomId) ? user : null;
}

// Multipart form fields are not trusted or even available until after multer
// runs. Authenticate a header, path token, account cookie, or an individually
// verified room cookie before permitting any file to be written.
function preauthenticateUpload(req, res, next) {
  if (authenticateRequest(req)) return next();
  const raw = String(req.headers.cookie || '');
  if (raw.length <= 16384) {
    const cookieOnly = {
      headers: { cookie: raw },
      body: {},
      query: {},
      method: req.method,
      baseUrl: req.baseUrl,
      path: req.path,
    };
    if (authenticateRequest(cookieOnly)) return next();
    const candidates = raw
      .split(';')
      .map((x) => x.trim().split('=')[0])
      .filter((name) => /^prt_room_[A-Za-z0-9_-]{1,80}$/.test(name))
      .slice(0, 64);
    for (const name of candidates) {
      const roomId = name.slice('prt_room_'.length);
      cookieOnly.authRoomId = roomId;
      const user = authenticateRequest(cookieOnly);
      if (user?.is_room_token && user.room_id === roomId && requireRoomAccess(user, roomId))
        return next();
    }
  }
  return res.status(401).json({ success: false, message: 'Authentication required.' });
}
module.exports = {
  canAccessFiles,
  canAccessArchives,
  canAccessRecordings,
  authenticateRoomRequest,
  preauthenticateUpload,
};
