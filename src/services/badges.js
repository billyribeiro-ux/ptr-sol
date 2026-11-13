'use strict';
const db = require('../db/database');

function accountBadges(ownerId) {
  return db
    .prepare(
      `SELECT * FROM badges WHERE owner_id=? OR
    (owner_id IS NULL AND room_id IN (SELECT uuid FROM sessions WHERE owner_id=?))
    ORDER BY created_at,id`,
    )
    .all(ownerId, ownerId);
}

function accountBadge(ownerId, badgeId) {
  return db
    .prepare(
      `SELECT * FROM badges WHERE id=? AND (owner_id=? OR
    (owner_id IS NULL AND room_id IN (SELECT uuid FROM sessions WHERE owner_id=?)))`,
    )
    .get(badgeId, ownerId, ownerId);
}

// A badge may reference a local file only if it is owned by the same account.
// External HTTP(S) badge images remain ordinary links without a local asset ID.
function badgeAsset(ownerId, imageURL) {
  if (!imageURL) return null;
  let parsed;
  try {
    parsed = new URL(imageURL, 'http://local.invalid');
  } catch {
    return null;
  }
  const image = parsed.pathname.match(/^\/users\/v1\/images\/([A-Za-z0-9_-]+)$/);
  const fileId = image
    ? image[1]
    : parsed.pathname === '/users/v1/serveFile'
      ? parsed.searchParams.get('id')
      : null;
  if (!fileId) return null;
  const file = db
    .prepare(
      `SELECT f.id,f.mime_type FROM files f WHERE f.id=? AND (
    EXISTS (SELECT 1 FROM sessions s WHERE s.uuid=f.room_id AND s.owner_id=?) OR
    EXISTS (SELECT 1 FROM badges b WHERE b.asset_file_id=f.id AND b.owner_id=?))`,
    )
    .get(fileId, ownerId, ownerId);
  if (!file || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.mime_type)) {
    const error = new Error('Badge image is not an image owned by this account.');
    error.status = 403;
    throw error;
  }
  return file.id;
}
// Badge images are account assets. A member of another room owned by the
// same account may view the image, but does not gain access to other files.
function canAccessBadgeAsset(req, file) {
  const owners = db
    .prepare('SELECT DISTINCT owner_id FROM badges WHERE asset_file_id=? AND owner_id IS NOT NULL')
    .all(file.id);
  if (!owners.length) return false;
  const { authenticateRequest, requireRoomAccess } = require('../middleware/auth');
  const { authenticateRoomRequest } = require('./room-access');
  const original = authenticateRequest(req);
  const cookieOnly = {
    headers: { cookie: req.headers?.cookie || '' },
    body: {},
    query: {},
    method: req.method,
    baseUrl: req.baseUrl,
    path: req.path,
  };
  const site = authenticateRequest(cookieOnly);
  for (const { owner_id: ownerId } of owners) {
    for (const user of [original, site])
      if (user && !user.is_room_token && !user.is_api_key && user.id === ownerId) return true;
    const rooms = db.prepare('SELECT uuid FROM sessions WHERE owner_id=?').all(ownerId);
    for (const room of rooms) {
      const user = authenticateRoomRequest(req, room.uuid);
      if (user && requireRoomAccess(user, room.uuid)) return true;
    }
  }
  return false;
}
module.exports = { accountBadges, accountBadge, badgeAsset, canAccessBadgeAsset };
