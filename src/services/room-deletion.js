const fs = require('fs');
const path = require('path');
const db = require('../db/database');
const { DATA_DIR, UPLOAD_DIR, RECORDINGS_DIR } = require('../config');

function isChild(root, entry) {
  const relative = path.relative(root, entry);
  return (
    !!relative &&
    relative !== '..' &&
    !relative.startsWith('..' + path.sep) &&
    !path.isAbsolute(relative)
  );
}
function isPathInside(root, entry) {
  const base = path.resolve(root),
    absolute = path.resolve(entry);
  if (isChild(base, absolute)) return true;
  try {
    return isChild(fs.realpathSync(base), absolute);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
function existingPathInside(root, entry) {
  const base = path.resolve(root),
    absolute = path.resolve(entry);
  if (!isPathInside(base, absolute)) return null;
  try {
    fs.lstatSync(absolute);
    const realBase = fs.realpathSync(base),
      parent = fs.realpathSync(path.dirname(absolute));
    if (parent !== realBase && !isChild(realBase, parent)) return null;
    return absolute;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
function removeRoomData(roomId) {
  const room = db.prepare('SELECT owner_id FROM sessions WHERE uuid=?').get(roomId);
  if (!room) throw new Error('Room not found.');
  const protectedAssets = new Set(
    db
      .prepare('SELECT asset_file_id FROM badges WHERE owner_id=? AND asset_file_id IS NOT NULL')
      .all(room.owner_id)
      .map((row) => row.asset_file_id),
  );
  const files = db.prepare('SELECT * FROM files WHERE room_id=?').all(roomId);
  const recordings = db.prepare('SELECT * FROM recordings WHERE room_id=?').all(roomId);
  const candidates = [],
    warnings = [];
  for (const file of files) {
    if (protectedAssets.has(file.id)) continue;
    if (
      db
        .prepare('SELECT 1 FROM files WHERE stored_name=? AND room_id<>? LIMIT 1')
        .get(file.stored_name, roomId)
    ) {
      warnings.push('A shared upload was retained.');
      continue;
    }
    const target = existingPathInside(
      UPLOAD_DIR,
      path.join(UPLOAD_DIR, path.basename(file.stored_name)),
    );
    if (target) candidates.push(target);
  }
  for (const rec of recordings) {
    if (/^[A-Za-z0-9_-]+$/.test(rec.id)) {
      const folder = existingPathInside(RECORDINGS_DIR, path.join(RECORDINGS_DIR, rec.id));
      if (folder) candidates.push(folder);
    }
    if (rec.file_path) {
      if (
        db
          .prepare('SELECT 1 FROM recordings WHERE file_path=? AND room_id<>? LIMIT 1')
          .get(rec.file_path, roomId)
      ) {
        warnings.push('A shared recording was retained.');
        continue;
      }
      const file = path.resolve(RECORDINGS_DIR, rec.file_path);
      if (!isPathInside(RECORDINGS_DIR, file)) {
        warnings.push('An external recording was retained.');
        continue;
      }
      const target = existingPathInside(RECORDINGS_DIR, file);
      if (target) {
        if (fs.lstatSync(target).isSymbolicLink())
          warnings.push('A linked external recording was retained.');
        candidates.push(target);
      } else if (fs.existsSync(file)) warnings.push('An external recording was retained.');
    }
  }
  const distinct = [...new Set(candidates)]
    .sort((a, b) => a.length - b.length)
    .filter(
      (candidate, index, all) =>
        !all.slice(0, index).some((parent) => candidate.startsWith(parent + path.sep)),
    );
  const staging = fs.mkdtempSync(path.join(DATA_DIR, '.room-delete-')),
    moved = [];
  let committed = false;
  try {
    for (const [index, source] of distinct.entries()) {
      const target = path.join(staging, String(index));
      fs.renameSync(source, target);
      moved.push({ source, target });
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      const destination = db
        .prepare(
          'SELECT uuid FROM sessions WHERE owner_id=? AND uuid<>? ORDER BY is_main_room DESC,created_at ASC LIMIT 1',
        )
        .get(room.owner_id, roomId);
      if (destination)
        for (const id of protectedAssets)
          db.prepare('UPDATE files SET room_id=? WHERE id=? AND room_id=?').run(
            destination.uuid,
            id,
            roomId,
          );
      if (
        db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='notification_deliveries'",
          )
          .get()
      )
        db.prepare('DELETE FROM notification_deliveries WHERE room_id=?').run(roomId);
      db.prepare('DELETE FROM outbox WHERE room_id=?').run(roomId);
      db.prepare('DELETE FROM audit_events WHERE room_id=?').run(roomId);
      const result = db.prepare('DELETE FROM sessions WHERE uuid=?').run(roomId);
      if (!result.changes) throw new Error('Room not found.');
      db.exec('COMMIT');
      committed = true;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } catch (error) {
    let restoreFailed = false;
    for (const item of moved.reverse())
      try {
        fs.renameSync(item.target, item.source);
      } catch {
        restoreFailed = true;
      }
    if (!restoreFailed) {
      try {
        fs.rmSync(staging, { recursive: true, force: true });
      } catch {}
    } else {
      error.recoveryRequired = true;
      error.recoveryDirectory = path.basename(staging);
    }
    throw error;
  }
  try {
    fs.rmSync(staging, { recursive: true, force: true });
  } catch (error) {
    const failure = new Error('Room deleted, but staged files could not be removed.');
    failure.roomDeleted = committed;
    throw failure;
  }
  return { warnings: [...new Set(warnings)] };
}
module.exports = { removeRoomData };
