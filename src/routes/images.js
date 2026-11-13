const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db/database');
const { UPLOAD_DIR } = require('../config');
const { authenticateRequest, requireRoomAccess } = require('../middleware/auth');
const {
  canAccessFiles,
  authenticateRoomRequest,
  preauthenticateUpload,
} = require('../services/room-access');
const { json } = require('../services/serializers');
const { canAccessBadgeAsset } = require('../services/badges');
const router = express.Router();
const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 41246720, files: 1, fields: 8 },
}).single('file');
const dispose = (file) => {
  if (file?.path)
    try {
      fs.unlinkSync(file.path);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
};
function mimeFor(buffer) {
  if (
    buffer.length >= 45 &&
    buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    buffer.readUInt32BE(8) === 13 &&
    buffer.toString('ascii', 12, 16) === 'IHDR' &&
    buffer.readUInt32BE(16) > 0 &&
    buffer.readUInt32BE(16) <= 10000 &&
    buffer.readUInt32BE(20) > 0 &&
    buffer.readUInt32BE(20) <= 10000 &&
    buffer.subarray(-12).equals(Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]))
  )
    return 'image/png';
  if (
    buffer.length >= 14 &&
    ['GIF87a', 'GIF89a'].includes(buffer.toString('ascii', 0, 6)) &&
    buffer.readUInt16LE(6) > 0 &&
    buffer.readUInt16LE(8) > 0 &&
    buffer.at(-1) === 0x3b
  )
    return 'image/gif';
  if (
    buffer.length >= 10 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff &&
    buffer.at(-2) === 0xff &&
    buffer.at(-1) === 0xd9
  )
    return 'image/jpeg';
  if (
    buffer.length >= 20 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.readUInt32LE(4) + 8 === buffer.length &&
    buffer.toString('ascii', 8, 12) === 'WEBP' &&
    ['VP8 ', 'VP8L', 'VP8X'].includes(buffer.toString('ascii', 12, 16))
  )
    return 'image/webp';
  return null;
}
function resolveRoom(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const id = String(value);
  return db.prepare('SELECT * FROM sessions WHERE uuid=? OR id=?').get(id, id);
}
function roomAndUser(req, requested, allowOwnerDefault = false) {
  let room = resolveRoom(requested);
  if (room) req.authRoomId = room.uuid;
  const user = room ? authenticateRoomRequest(req, room.uuid) : authenticateRequest(req);
  if (!user) return {};
  if (!room && allowOwnerDefault && !requested && !user.is_room_token && !user.is_api_key)
    room = db
      .prepare(
        'SELECT * FROM sessions WHERE owner_id=? ORDER BY is_main_room DESC,created_at ASC LIMIT 1',
      )
      .get(user.id);
  if (!room || !requireRoomAccess(user, room.uuid)) return { user };
  return { user, room };
}
router.post('/upload', preauthenticateUpload, (req, res) =>
  upload(req, res, (error) => {
    if (error)
      return res.status(400).json({
        success: false,
        message:
          error.code === 'LIMIT_FILE_SIZE'
            ? 'Image exceeds the upload size limit.'
            : 'Invalid image upload.',
      });
    try {
      const { user, room } = roomAndUser(req, req.body?.roomID || req.body?.sessionID, true);
      if (!user || !room) {
        dispose(req.file);
        return res.status(403).json({ success: false, message: 'Room access denied.' });
      }
      const manager = !!requireRoomAccess(user, room.uuid, { manage: true });
      if (!manager && (!json(room.settings).userUploads || !canAccessFiles(user, room.uuid))) {
        dispose(req.file);
        return res
          .status(403)
          .json({ success: false, message: 'Image upload is not allowed for this participant.' });
      }
      if (!req.file)
        return res.status(400).json({ success: false, message: 'An image is required.' });
      const detected = mimeFor(fs.readFileSync(req.file.path));
      const declared = req.file.mimetype === 'image/jpg' ? 'image/jpeg' : req.file.mimetype;
      if (!detected || detected !== declared) {
        dispose(req.file);
        return res
          .status(400)
          .json({ success: false, message: 'Unsupported, invalid, or mismatched image format.' });
      }
      const id = crypto.randomUUID(),
        name =
          path
            .basename(req.file.originalname)
            .replace(/[\u0000-\u001f\u007f]/g, '')
            .slice(0, 200) || 'image';
      db.prepare(
        'INSERT INTO files (id,room_id,uploader_id,uploader_name,original_name,stored_name,mime_type,size_bytes,visibility,category) VALUES (?,?,?,?,?,?,?,?,1,?)',
      ).run(
        id,
        room.uuid,
        user.actor_id || user.id,
        user.name,
        name,
        req.file.filename,
        detected,
        req.file.size,
        'images',
      );
      return res.json({
        success: true,
        data: { id, name, link: `/users/v1/images/${encodeURIComponent(id)}` },
      });
    } catch (error) {
      try {
        dispose(req.file);
      } catch {}
      return res.status(500).json({ success: false, message: 'Image upload failed.' });
    }
  }),
);
router.get('/giphy', async (req, res) => {
  const { user, room } = roomAndUser(req, req.query.roomID || req.query.sessionID);
  if (!user || !room)
    return res.status(403).json({ success: false, message: 'Room access denied.' });
  const key = process.env.GIPHY_API_KEY;
  if (!key)
    return res.status(503).json({ success: false, message: 'GIF search is not configured.' });
  const query = String(req.query.q || '').trim();
  if (!query || query.length > 100 || /[\u0000-\u001f\u007f]/.test(query))
    return res.status(400).json({ success: false, message: 'Enter a valid search term.' });
  const url = new URL('https://api.giphy.com/v1/gifs/search');
  for (const [name, value] of Object.entries({
    api_key: key,
    q: query,
    limit: '25',
    offset: '0',
    rating: 'pg-13',
  }))
    url.searchParams.set(name, value);
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error('Provider unavailable');
    const reader = response.body.getReader();
    let size = 0,
      chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2 * 1024 * 1024) {
        await reader.cancel();
        throw new Error('Provider response too large');
      }
      chunks.push(Buffer.from(value));
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const safe = (value) => {
      try {
        const u = new URL(value);
        return u.protocol === 'https:' &&
          !u.username &&
          !u.password &&
          (u.hostname === 'giphy.com' || u.hostname.endsWith('.giphy.com'))
          ? u.href
          : null;
      } catch {
        return null;
      }
    };
    const data = (Array.isArray(payload.data) ? payload.data : [])
      .slice(0, 25)
      .map((g) => {
        const fixed = safe(g?.images?.fixed_width?.url),
          original = safe(g?.images?.downsized_medium?.url);
        return fixed && original
          ? {
              id: String(g.id || ''),
              images: { fixed_width: { url: fixed }, downsized_medium: { url: original } },
            }
          : null;
      })
      .filter(Boolean);
    return res.json({ data, pagination: { count: data.length } });
  } catch {
    return res.status(502).json({ success: false, message: 'GIF search provider is unavailable.' });
  }
});
router.get('/:id', (req, res) => {
  const file = db
    .prepare("SELECT * FROM files WHERE id=? AND category='images'")
    .get(req.params.id);
  if (!file) return res.status(404).send('Image not found');
  req.authRoomId = file.room_id;
  const user = authenticateRoomRequest(req, file.room_id);
  if ((!user || !canAccessFiles(user, file.room_id)) && !canAccessBadgeAsset(req, file))
    return res.status(403).send('Room access denied');
  const full = path.join(UPLOAD_DIR, path.basename(file.stored_name));
  if (!fs.existsSync(full)) return res.status(404).send('Image not found');
  res.set({
    'Content-Type': file.mime_type,
    'Content-Disposition': 'inline',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cache-Control': 'private, no-store',
  });
  return res.sendFile(full);
});
router.mimeFor = mimeFor;
module.exports = router;
