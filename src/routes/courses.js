const express = require('express');
const crypto = require('crypto');
const db = require('../db/database');
const { authenticateRequest, requireRoomAccess } = require('../middleware/auth');
const { authenticateRoomRequest } = require('../services/room-access');
const { validRoomURL } = require('../services/room-validation');

const router = express.Router();
const parse = (value) => {
  try {
    return JSON.parse(value || '{}');
  } catch {
    return {};
  }
};
const getCourse = (id) => db.prepare('SELECT * FROM marketplace_courses WHERE id=?').get(id);
const getListing = (id) => db.prepare('SELECT * FROM marketplaces WHERE id=?').get(id);

function manager(req, roomID) {
  const user = authenticateRequest(req);
  return user && requireRoomAccess(user, roomID, { manage: true }) ? user : null;
}
function canView(req, row, course) {
  if (manager(req, row.room_id)) return true;
  if (!course.isPublished) return false;
  const hasNoMemberships =
    course.membershipIds == null ||
    (Array.isArray(course.membershipIds) && course.membershipIds.length === 0);
  if (hasNoMemberships && Number(course.price || 0) === 0) return true;
  req.authRoomId = row.room_id;
  const user = authenticateRoomRequest(req, row.room_id);
  if (!user || !requireRoomAccess(user, row.room_id)) return false;
  if (course.allowRoomAccess) return true;
  const memberID =
    user.memberId ||
    user.member_id ||
    (user.is_room_token ? user.id : null) ||
    db
      .prepare('SELECT id FROM memberships WHERE room_id=? AND email=?')
      .get(row.room_id, String(user.email || '').toLowerCase())?.id;
  if (!memberID || !Array.isArray(course.membershipIds) || !course.membershipIds.length)
    return false;
  return !!db
    .prepare(
      `SELECT 1 FROM marketplace_orders WHERE room_id=? AND member_id=? AND plan_id IN (${course.membershipIds.map(() => '?').join(',')}) AND status IN ('paid','active','trialing','past_due','free') LIMIT 1`,
    )
    .get(row.room_id, memberID, ...course.membershipIds);
}
function output(req, row) {
  const data = parse(row.data),
    room = db.prepare('SELECT id,uuid FROM sessions WHERE uuid=?').get(row.room_id);
  const result = {
    ...data,
    _id: row.id,
    marketplaceID: row.marketplace_id,
    sessionID: room?.id || row.room_id,
  };
  if (canView(req, row, data)) return result;
  return {
    ...result,
    sections: (Array.isArray(data.sections) ? data.sections : []).map((section) => ({
      sectionId: section.sectionId,
      title: section.title,
      description: section.description,
      orderIndex: section.orderIndex,
      units: (section.units || []).map((unit) => ({
        unitId: unit.unitId,
        title: unit.title,
        orderIndex: unit.orderIndex,
      })),
    })),
  };
}
function normalize(input, listingID, previous = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Invalid course.');
  const allowed = [
    'name',
    'description',
    'imageURL',
    'sections',
    'membershipIds',
    'allowRoomAccess',
    'currency',
    'price',
    'isPublished',
    'orderIndex',
  ];
  const data = { ...previous };
  for (const key of allowed) if (Object.hasOwn(input, key)) data[key] = input[key];
  if (typeof data.name !== 'string' || !data.name.trim() || data.name.length > 200)
    throw Error('Enter a course name.');
  if (data.imageURL && !validRoomURL(data.imageURL)) throw Error('Invalid course image URL.');
  if (!Number.isSafeInteger(Number(data.price || 0)) || Number(data.price || 0) < 0)
    throw Error('Invalid course price.');
  if (data.isPublished !== undefined && typeof data.isPublished !== 'boolean')
    throw Error('Invalid course publication setting.');
  if (data.allowRoomAccess !== undefined && typeof data.allowRoomAccess !== 'boolean')
    throw Error('Invalid room access setting.');
  if (!Array.isArray(data.membershipIds || [])) throw Error('Invalid course memberships.');
  for (const id of data.membershipIds || [])
    if (
      typeof id !== 'string' ||
      !db
        .prepare('SELECT 1 FROM marketplace_plans WHERE id=? AND marketplace_id=?')
        .get(id, listingID)
    )
      throw Error('Course membership must belong to this marketplace.');
  if (!Array.isArray(data.sections || []) || (data.sections || []).length > 200)
    throw Error('Invalid course sections.');
  data.sections = (data.sections || []).map((section, index) => {
    if (
      !section ||
      typeof section !== 'object' ||
      !Array.isArray(section.units || []) ||
      (section.units || []).length > 200
    )
      throw Error('Invalid course section.');
    return {
      ...section,
      sectionId: section.sectionId || crypto.randomUUID(),
      orderIndex: section.orderIndex ?? index,
      units: (section.units || []).map((unit, unitIndex) => {
        if (!unit || typeof unit !== 'object' || (unit.videoURL && !validRoomURL(unit.videoURL)))
          throw Error('Invalid lesson.');
        return {
          ...unit,
          unitId: unit.unitId || crypto.randomUUID(),
          orderIndex: unit.orderIndex ?? unitIndex,
        };
      }),
    };
  });
  return data;
}
function save(row, input) {
  const data = normalize(input, row.marketplace_id, parse(row.data));
  db.prepare('UPDATE marketplace_courses SET data=? WHERE id=?').run(JSON.stringify(data), row.id);
  return getCourse(row.id);
}
function send(req, res, row) {
  if (!row) return res.status(404).json({ message: 'Course not found.' });
  const course = parse(row.data);
  if (!course.isPublished && !manager(req, row.room_id))
    return res.status(404).json({ message: 'Course not found.' });
  return res.json(output(req, row));
}
router.get('/publishedCourses', (req, res) =>
  res.json(
    db
      .prepare('SELECT * FROM marketplace_courses ORDER BY created_at DESC')
      .all()
      .filter((row) => parse(row.data).isPublished)
      .map((row) => output(req, row)),
  ),
);
router.get('/session/:id', (req, res) => {
  const room = db
    .prepare('SELECT * FROM sessions WHERE uuid=? OR id=?')
    .get(req.params.id, req.params.id);
  if (!room) return res.status(404).json({ message: 'Room not found.' });
  const manage = manager(req, room.uuid);
  return res.json(
    db
      .prepare('SELECT * FROM marketplace_courses WHERE room_id=? ORDER BY created_at')
      .all(room.uuid)
      .filter((row) => manage || parse(row.data).isPublished)
      .map((row) => output(req, row)),
  );
});
router.get('/marketplace/:id', (req, res) => {
  const listing = getListing(req.params.id);
  if (!listing) return res.status(404).json({ message: 'Marketplace not found.' });
  const manage = manager(req, listing.session_id);
  return res.json(
    db
      .prepare('SELECT * FROM marketplace_courses WHERE marketplace_id=? ORDER BY created_at')
      .all(listing.id)
      .filter((row) => manage || parse(row.data).isPublished)
      .map((row) => output(req, row)),
  );
});
function create(req, res, marketplaceID) {
  const listing = getListing(marketplaceID);
  if (!listing || !manager(req, listing.session_id))
    return res.status(403).json({ message: 'Marketplace access denied.' });
  try {
    const data = normalize({ ...req.body, isPublished: false }, listing.id),
      id = crypto.randomUUID();
    db.prepare(
      'INSERT INTO marketplace_courses(id,marketplace_id,room_id,data) VALUES(?,?,?,?)',
    ).run(id, listing.id, listing.session_id, JSON.stringify(data));
    return res.json(output(req, getCourse(id)));
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
}
router.post('/marketplace/:id', (req, res) => create(req, res, req.params.id));
router.post('/', (req, res) => {
  const roomID = req.body?.sessionID,
    user = authenticateRequest(req),
    room = user && roomID && requireRoomAccess(user, roomID, { manage: true });
  const listing =
    room &&
    db
      .prepare('SELECT id FROM marketplaces WHERE session_id=? ORDER BY created_at LIMIT 1')
      .get(room.uuid);
  return listing
    ? create(req, res, listing.id)
    : res.status(403).json({ message: 'Marketplace access denied.' });
});
router.get('/:id/public', (req, res) => send(req, res, getCourse(req.params.id)));
router.get('/:id/access', (req, res) => {
  const row = getCourse(req.params.id);
  if (!row) return res.status(404).json({ hasAccess: false });
  return res.json({ hasAccess: canView(req, row, parse(row.data)) });
});
router.get('/:id', (req, res) => send(req, res, getCourse(req.params.id)));
router.put('/:id', (req, res) => {
  const row = getCourse(req.params.id);
  if (!row || !manager(req, row.room_id))
    return res.status(403).json({ message: 'Course access denied.' });
  try {
    return res.json(output(req, save(row, req.body)));
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
});
router.delete('/:id', (req, res) => {
  const row = getCourse(req.params.id);
  if (!row || !manager(req, row.room_id))
    return res.status(403).json({ message: 'Course access denied.' });
  db.prepare('DELETE FROM marketplace_courses WHERE id=?').run(row.id);
  return res.json({ success: true });
});
router.put('/:id/publish', (req, res) => {
  const row = getCourse(req.params.id);
  if (!row || !manager(req, row.room_id))
    return res.status(403).json({ message: 'Course access denied.' });
  try {
    return res.json(output(req, save(row, { isPublished: req.body?.isPublished })));
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
});
function sectionChange(req, res, operation) {
  const row = getCourse(req.params.id);
  if (!row || !manager(req, row.room_id))
    return res.status(403).json({ message: 'Course access denied.' });
  const data = parse(row.data),
    sections = data.sections || [];
  const section = sections.find((item) => String(item.sectionId) === req.params.sectionID);
  if (operation !== 'addSection' && !section)
    return res.status(404).json({ message: 'Section not found.' });
  if (operation === 'addSection') sections.push({ ...req.body, sectionId: crypto.randomUUID() });
  if (operation === 'updateSection') {
    const id = section.sectionId;
    Object.assign(section, req.body, { sectionId: id });
  }
  if (operation === 'addUnit') section.units.push({ ...req.body, unitId: crypto.randomUUID() });
  if (operation === 'updateUnit') {
    const unit = section.units.find((item) => String(item.unitId) === req.params.unitID);
    if (!unit) return res.status(404).json({ message: 'Lesson not found.' });
    const id = unit.unitId;
    Object.assign(unit, req.body, { unitId: id });
  }
  try {
    return res.json(output(req, save(row, { sections })));
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
}
router.post('/:id/sections', (req, res) => sectionChange(req, res, 'addSection'));
router.put('/:id/sections/:sectionID', (req, res) => sectionChange(req, res, 'updateSection'));
router.post('/:id/sections/:sectionID/units', (req, res) => sectionChange(req, res, 'addUnit'));
router.put('/:id/sections/:sectionID/units/:unitID', (req, res) =>
  sectionChange(req, res, 'updateUnit'),
);
router.canView = canView;
module.exports = router;
