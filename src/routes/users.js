const express = require('express');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/database');
const { UPLOAD_DIR, RECORDINGS_DIR, JWT_SECRET } = require('../config');
const {
  signToken,
  authenticateRequest,
  verifyTokenString,
  requireRoomAccess,
  authorizeRoom,
  signRoomToken,
  createPasswordReset,
  consumePasswordReset,
  extractToken,
  authorizeExternalRoomJWT,
} = require('../middleware/auth');
const crypto = require('crypto');
const ser = require('../services/serializers');
const mailService = require('../services/mail');
const { sendMail } = mailService;
const { createRoomIdentifiers } = require('../services/room-ids');
const { cloneRoom } = require('../services/rooms');
const {
  accountBadges,
  accountBadge,
  badgeAsset,
  canAccessBadgeAsset,
} = require('../services/badges');
const { removeRoomData } = require('../services/room-deletion');
const { validRoomURL, validateRoomField } = require('../services/room-validation');
const {
  canAccessFiles,
  canAccessArchives,
  canAccessRecordings,
  authenticateRoomRequest,
  preauthenticateUpload,
} = require('../services/room-access');

const router = express.Router();
for (const param of ['sessionID', 'sessId'])
  router.param(param, (req, res, next, value) => {
    const room = db.prepare('SELECT uuid FROM sessions WHERE uuid=? OR id=?').get(value, value);
    if (room) req.params[param] = room.uuid;
    next();
  });
router.use((req, res, next) => {
  if (req.body && typeof req.body === 'object')
    for (const key of ['sessionID', 'sessionId', 'roomID', 'uuid', 'sessID']) {
      const value = req.body[key];
      if (typeof value !== 'string' && typeof value !== 'number') continue;
      const text = String(value),
        room = db.prepare('SELECT uuid FROM sessions WHERE uuid=? OR id=?').get(text, text);
      if (room) {
        req.body[key] = room.uuid;
        req.authRoomId = room.uuid;
      }
    }
  next();
});

router.use('/images', require('./images'));

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 50 * 1024 * 1024 },
});

function ensureUserSubscription(userId, defaultPlanId = 'trial') {
  let sub = db
    .prepare(
      `SELECT s.*, p.name AS plan_name, p.price_cents, p.currency, p.max_rooms, p.max_participants,
              p.recording_enabled, p.screen_share_enabled, p.custom_branding, p.api_access
       FROM subscriptions s
       JOIN plans p ON p.id = s.plan_id
       WHERE s.user_id = ?`,
    )
    .get(userId);

  if (!sub) {
    const id = uuidv4();
    const trialEnds = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(
      `INSERT INTO subscriptions (id, user_id, plan_id, status, trial_ends_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, userId, defaultPlanId, defaultPlanId === 'trial' ? 'trialing' : 'active', trialEnds);

    sub = db
      .prepare(
        `SELECT s.*, p.name AS plan_name, p.price_cents, p.currency, p.max_rooms, p.max_participants,
                p.recording_enabled, p.screen_share_enabled, p.custom_branding, p.api_access
         FROM subscriptions s
         JOIN plans p ON p.id = s.plan_id
         WHERE s.user_id = ?`,
      )
      .get(userId);
  }
  return sub;
}

function formatSessionRow(row) {
  return ser.session(row);
}

function createDefaultRoomForUser(user, name = 'Main Trading Room') {
  const room = createRoomIdentifiers();
  db.prepare(
    `INSERT INTO sessions (id, uuid, owner_id, name, tagline, is_main_room, is_open)
     VALUES (?, ?, ?, ?, ?, 1, 1)`,
  ).run(room.id, room.uuid, user.id, name, 'Live Trading Room');
  return room.uuid;
}

router.post('/p/contact', async (req, res) => {
  const { fname, email, msg } = req.body || {};
  if (!fname || !email || !msg || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email)))
    return res
      .status(400)
      .json({ success: false, msg: 'Name, valid email and message are required.' });
  const recipient = process.env.LOCAL_CONTACT_EMAIL;
  if (!recipient || !process.env.SMTP_HOST)
    return res.status(503).json({ success: false, msg: 'Contact delivery is unavailable.' });
  try {
    await sendMail({
      to: recipient,
      subject: 'Contact request',
      text: `From: ${fname} <${email}>\n\n${msg}`,
    });
    return res.json({ success: true, msg: 'Your message has been sent.' });
  } catch {
    return res.status(503).json({ success: false, msg: 'Contact delivery is unavailable.' });
  }
});

// POST /users/v1/login
router.post('/login', (req, res) => {
  const { email, pw } = req.body || {};
  if (!email || !pw) {
    return res.json({ success: false, message: 'Email and password are required.' });
  }
  const normalizedEmail = String(email).trim().toLowerCase();
  let user = db.prepare('SELECT * FROM users WHERE email = ?').get(normalizedEmail);
  const delegate = !user
    ? db.prepare('SELECT * FROM admin_users WHERE email = ?').get(normalizedEmail)
    : null;
  if (!user && delegate) user = { ...delegate, role: 'delegate', is_admin: 0, is_delegate: true };
  if (!user || !bcrypt.compareSync(String(pw), user.password_hash)) {
    const failedCount = (user?.failed_login_count || 0) + 1;
    if (user && !user.is_delegate) {
      db.prepare('UPDATE users SET failed_login_count = ? WHERE id = ?').run(failedCount, user.id);
    }
    return res.json({
      success: false,
      message: 'Invalid email or password.',
      failedLoginCount: failedCount,
    });
  }

  if (!user.is_delegate)
    db.prepare('UPDATE users SET failed_login_count = 0 WHERE id = ?').run(user.id);
  const sub = ensureUserSubscription(
    user.owner_id || user.id,
    user.is_admin ? 'enterprise' : 'trial',
  );
  const token = signToken(user);
  res.cookie('prt_session', token, { httpOnly: true, sameSite: 'lax', secure: req.secure });
  return res.json({
    success: true,
    token,
    name: user.name,
    email: user.email,
    id: user.actor_id || user.id,
    role: 2,
    isAdmin: Boolean(user.is_admin),
    planId: sub.plan_id,
    subscriptionStatus: sub.status,
  });
});

// POST /users/v1/login_tok
router.post('/login_tok', (req, res) => {
  const user = authenticateRequest(req);
  if (!user || user.is_room_token || user.is_api_key) {
    return res.json({ success: false, message: 'Failed to authenticate token.' });
  }
  const sub = ensureUserSubscription(user.id, user.is_admin ? 'enterprise' : 'trial');
  const token = signToken(user);
  res.cookie('prt_session', token, { httpOnly: true, sameSite: 'lax', secure: req.secure });
  return res.json({
    success: true,
    token,
    name: user.name,
    email: user.email,
    id: user.actor_id || user.id,
    role: 2,
    isAdmin: Boolean(user.is_admin),
    planId: sub.plan_id,
    subscriptionStatus: sub.status,
  });
});

// POST /users/v1/signup & /users/v1/demoSignup
function handleSignup(req, res) {
  const { name, email, pw, demo, roomName, clusterID } = req.body || {};
  if (
    typeof name !== 'string' ||
    !name.trim() ||
    typeof email !== 'string' ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ||
    typeof pw !== 'string' ||
    pw.length < 8 ||
    Buffer.byteLength(pw) > 72
  ) {
    return res.status(400).json({
      success: false,
      message: 'A name, valid email, and password of 8 to 72 bytes are required.',
    });
  }
  const normalizedEmail = String(email).trim().toLowerCase();
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normalizedEmail);
  if (existing || db.prepare('SELECT 1 FROM admin_users WHERE email = ?').get(normalizedEmail)) {
    return res.json({ success: false, message: 'An account with that email already exists.' });
  }

  const userId = uuidv4();
  const passwordHash = bcrypt.hashSync(String(pw), 10);
  const isAdmin = 0;
  const role = 'presenter';
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
      `INSERT INTO users (id, name, email, password_hash, role, is_admin)
     VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(userId, String(name).trim(), normalizedEmail, passwordHash, role, isAdmin);

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    const chosenPlan = isAdmin ? 'enterprise' : 'trial';
    ensureUserSubscription(user.id, chosenPlan);
    // The standard demo signup immediately calls newSession; demoSignup itself
    // creates the named room and navigates directly to its internal ID.
    const needsClientRoom = Boolean(demo) && req.path === '/signup';
    const roomUUID = needsClientRoom
      ? ''
      : createDefaultRoomForUser(user, roomName ? String(roomName).trim() : `${user.name}'s Room`);
    const createdRoom = roomUUID
      ? db.prepare('SELECT * FROM sessions WHERE uuid=?').get(roomUUID)
      : null;
    if (createdRoom && clusterID)
      db.prepare('UPDATE sessions SET settings=? WHERE uuid=?').run(
        JSON.stringify({ clusterID: String(clusterID) }),
        roomUUID,
      );
    const token = signToken(user);
    db.exec('COMMIT');
    res.cookie('prt_session', token, { httpOnly: true, sameSite: 'lax', secure: req.secure });

    return res.json({
      success: true,
      token,
      name: user.name,
      email: user.email,
      demo: Boolean(demo),
      planId: chosenPlan,
      roomUUID,
      roomID: createdRoom?.id || '',
    });
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

router.post('/signup', handleSignup);
router.post('/demoSignup', handleSignup);

// Subscription & Plans endpoints
router.get('/plans', (req, res) => {
  const plans = db.prepare('SELECT * FROM plans ORDER BY price_cents ASC').all();
  return res.json({ success: true, plans });
});

router.get('/subscription', (req, res) => {
  const user = authenticateRequest(req);
  if (!user || user.is_room_token || user.is_delegate || user.is_api_key)
    return res.status(401).json({ success: false, message: 'Unauthorized.' });
  const sub = ensureUserSubscription(user.id);
  const plans = db.prepare('SELECT * FROM plans ORDER BY price_cents ASC').all();
  return res.json({ success: true, subscription: sub, plans });
});

router.post('/subscription', (req, res) => {
  if (!authenticateRequest(req))
    return res.status(401).json({ success: false, message: 'Unauthorized.' });
  return res.status(503).json({
    success: false,
    message: 'Subscription changes require a configured billing provider.',
  });
});

// Reset links carry random, single-use credentials rather than account identifiers.
router.use(
  ['/forgot-password', '/user-forgot-password', '/change-password', '/user-change-password'],
  (req, res, next) => {
    const send = res.json.bind(res);
    res.json = (body) =>
      send(body && body.message && !body.msg ? { ...body, msg: body.message } : body);
    next();
  },
);
router.post(['/forgot-password', '/user-forgot-password'], async (req, res) => {
  const email = String(req.body?.email || '')
    .trim()
    .toLowerCase();
  if (!email) return res.status(400).json({ success: false, message: 'Email is required.' });
  if (
    !process.env.SMTP_HOST ||
    (!['localhost', '127.0.0.1', '::1', 'mailpit'].includes(process.env.SMTP_HOST) &&
      process.env.SMTP_EXTERNAL_ENABLED !== 'true')
  )
    return res.status(503).json({ success: false, message: 'Email delivery is unavailable.' });
  const participant = req.path === '/user-forgot-password';
  const rows = participant
    ? db.prepare('SELECT id,room_id FROM memberships WHERE email = ?').all(email)
    : db.prepare('SELECT id FROM users WHERE email = ?').all(email);
  try {
    for (const row of rows) {
      const token = createPasswordReset({
        userId: participant ? null : row.id,
        membershipId: participant ? row.id : null,
      });
      const base = process.env.PUBLIC_ORIGIN || 'http://localhost:3000';
      await sendMail({
        ...(participant ? { roomID: row.room_id } : {}),
        to: email,
        subject: 'Password reset',
        text: `Reset your password: ${base}/ptrApp#/page/${participant ? 'user-change-password' : 'change-password'}/${token}`,
      });
    }
    return res.json({
      success: true,
      message: 'If an account exists, reset instructions have been sent.',
      msg: 'If an account exists, reset instructions have been sent.',
    });
  } catch {
    return res.status(503).json({ success: false, message: 'Email delivery failed.' });
  }
});
router.post(['/change-password', '/user-change-password'], (req, res) => {
  const raw = req.body?.userUUID || req.body?.resetToken;
  const password = req.body?.passNew || req.body?.newPassword;
  if (!raw || !password || String(password).length < 4)
    return res
      .status(400)
      .json({ success: false, message: 'A reset token and new password are required.' });
  const row = db
    .prepare('SELECT user_id, membership_id FROM password_resets WHERE token_hash = ?')
    .get(crypto.createHash('sha256').update(String(raw)).digest('hex'));
  const participant = req.path === '/user-change-password';
  if (
    !row ||
    (participant ? !row.membership_id : !row.user_id) ||
    !consumePasswordReset(String(raw), String(password))
  )
    return res.status(400).json({
      success: false,
      message: 'Reset link is invalid, expired, or the password is too short.',
      msg: 'Reset link is invalid, expired, or the password is too short.',
    });
  return res.json({ success: true, message: 'Password updated.', msg: 'Password updated.' });
});

function setMembershipRole(member, role) {
  const requested = String(role),
    value = requested === '5' ? '1' : requested === '6' ? '2' : requested,
    flags = ser.json(member.flags);
  flags.muted = value === '3';
  flags.nonPresenter = requested === '5';
  flags.isFreeTrial = requested === '6';
  db.prepare('UPDATE memberships SET role=?,flags=?,token_version=token_version+1 WHERE id=?').run(
    value,
    JSON.stringify(flags),
    member.id,
  );
  if (value === '4')
    db.prepare('INSERT OR IGNORE INTO banned_users (room_id,email) VALUES (?,?)').run(
      member.room_id,
      member.email,
    );
  else
    db.prepare('DELETE FROM banned_users WHERE room_id=? AND email=?').run(
      member.room_id,
      member.email,
    );
}

function roomUsers(room) {
  let rows = db
    .prepare('SELECT * FROM memberships WHERE room_id=? ORDER BY created_at DESC')
    .all(room.uuid)
    .map(ser.membership);
  const owner = db
    .prepare('SELECT id,name,email,created_at FROM users WHERE id=?')
    .get(room.owner_id);
  if (owner) {
    rows = rows.filter((r) => r.email.toLowerCase() !== owner.email.toLowerCase());
    rows.unshift({
      _id: `owner:${owner.id}`,
      uuid: owner.id,
      name: owner.name,
      userName: owner.name,
      email: owner.email,
      role: 0,
      inviteStatus: 'approved',
      badges: [],
      createdAt: owner.created_at,
    });
  }
  return rows;
}

// The public room descriptor excludes credentials and private room settings.
router.post('/sessions', async (req, res) => {
  const b = req.body || {},
    cmd = b.cmd || 'list';
  let roomId = b.sessionID || b.sessionId || b.roomID || b.uuid;
  if (cmd === 'sessionPubData') {
    const room = db
      .prepare('SELECT * FROM sessions WHERE uuid = ? OR id = ?')
      .get(roomId || '', roomId || '');
    if (!room) return res.status(404).json({ success: false, message: 'Room not found.' });
    const r = formatSessionRow(room);
    const safe = [
      '_id',
      'uuid',
      'name',
      'tagline',
      'logoURL',
      'hideLogo',
      'hidePoweredBy',
      'customFaviconURL',
      'strictBrowserMode',
      'customEnterDisclosure',
      'description',
      'isOpen',
      'isLocked',
      'isChatOnlyRoom',
      'authMode',
      'hasRequiredPWInLogin',
      'hasRequiredPhoneInLogin',
      'allowPWLoginWithSSO',
    ];
    return res.json(
      Object.fromEntries(safe.filter((k) => r[k] !== undefined).map((k) => [k, r[k]])),
    );
  }
  const user = authenticateRequest(req);
  if (!user) return res.status(401).json({ success: false, message: 'Unauthorized.' });
  if (cmd === 'list') {
    const rows = db
      .prepare('SELECT * FROM sessions ORDER BY is_main_room DESC, created_at DESC')
      .all();
    return res.json(
      rows.filter((r) => requireRoomAccess(user, r.uuid, { manage: true })).map(formatSessionRow),
    );
  }
  if (cmd === 'create') {
    if (user.is_room_token || user.is_api_key || user.is_delegate)
      return res.status(403).json({ success: false, message: 'Account owner access required.' });
    const sub = ensureUserSubscription(user.id);
    const count = db
      .prepare('SELECT COUNT(*) AS n FROM sessions WHERE owner_id = ? AND is_archived_room = 0')
      .get(user.id).n;
    if (count >= sub.max_rooms && !user.is_admin)
      return res.json({ success: false, message: 'Room limit reached.' });
    const created = createRoomIdentifiers();
    db.prepare(
      'INSERT INTO sessions (id, uuid, owner_id, name, tagline, is_main_room, is_chat_only_room) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      created.id,
      created.uuid,
      user.id,
      b.name || 'New Trading Room',
      b.tagline || '',
      b.isMainRoom ? 1 : 0,
      b.isChatOnlyRoom ? 1 : 0,
    );
    return res.json({
      success: true,
      uuid: created.uuid,
      _id: created.id,
      session: formatSessionRow(
        db.prepare('SELECT * FROM sessions WHERE uuid = ?').get(created.uuid),
      ),
    });
  }
  if (cmd === 'getAppPin' && !roomId) {
    const matches = db
      .prepare(
        'SELECT m.* FROM memberships m JOIN sessions s ON s.uuid=m.room_id WHERE s.owner_id=? AND m.email=?',
      )
      .all(
        user.id,
        String(b.email || '')
          .trim()
          .toLowerCase(),
      )
      .filter((m) => requireRoomAccess(user, m.room_id, { manage: true }));
    const pin = matches
      .map((m) => {
        const f = ser.json(m.flags);
        return f.appPin || f.mobilePairCode;
      })
      .find(Boolean);
    return pin
      ? res.json({ success: true, pin })
      : res.status(404).json({ success: false, message: 'No mobile app PIN is registered.' });
  }
  // Badge administration without an explicit room is scoped to the account's main room.
  if (!roomId && ['listBadges', 'addBadge', 'deleteBadge', 'addBadgeDarkTheme'].includes(cmd))
    roomId = db
      .prepare('SELECT uuid FROM sessions WHERE owner_id = ? ORDER BY is_main_room DESC LIMIT 1')
      .get(user.id)?.uuid;
  if (!roomId && cmd === 'deleteFile')
    roomId = db.prepare('SELECT room_id FROM files WHERE id = ?').get(b.fileID)?.room_id;
  const badgeCommands = ['listBadges', 'addBadge', 'deleteBadge', 'addBadgeDarkTheme'];
  const delegatePermissions = user.delegate_perms || {};
  const accountBadgeScope =
    !roomId &&
    badgeCommands.includes(cmd) &&
    !user.is_room_token &&
    !user.is_api_key &&
    (!user.is_delegate ||
      (delegatePermissions.readOnly !== true &&
        delegatePermissions.manageSessions !== false &&
        delegatePermissions.manageRooms !== false));
  const room = roomId
    ? requireRoomAccess(user, roomId, {
        manage: ![
          'getSessionFiles',
          'sessionPubFiles',
          'setPresenterSetting',
          'clearPresenterSetting',
        ].includes(cmd),
      })
    : accountBadgeScope
      ? { uuid: '', owner_id: user.id, settings: '{}' }
      : null;
  if (!room) return res.status(403).json({ success: false, message: 'Room access denied.' });
  roomId = room.uuid;
  const settings = ser.json(room.settings);
  const badges = () => accountBadges(room.owner_id).map(ser.badge);
  switch (cmd) {
    case 'setPresenterSetting':
    case 'clearPresenterSetting': {
      const manager = !!requireRoomAccess(user, roomId, { manage: true });
      const presenter = user.is_room_token && ['a', 'o'].includes(user.perms);
      if (
        (!manager && !presenter) ||
        typeof b.key !== 'string' ||
        !b.key ||
        ['__proto__', 'constructor', 'prototype'].includes(b.key) ||
        (!manager && b.key.toLowerCase() !== String(user.email || '').toLowerCase())
      )
        return res
          .status(403)
          .json({ success: false, message: 'Presenter setting access denied.' });
      const values = ser.json(room.presenter_settings);
      if (cmd === 'setPresenterSetting') values[b.key] = b.val ?? b.value;
      else delete values[b.key];
      db.prepare('UPDATE sessions SET presenter_settings=? WHERE uuid=?').run(
        JSON.stringify(values),
        roomId,
      );
      return res.json({ success: true, presenterSettings: values });
    }
    case 'sessionDetails':
      return res.json({ success: true, session: formatSessionRow(room), xrefs: roomUsers(room) });
    case 'sessionDetailsShort': {
      const value = formatSessionRow(room);
      return res.json({ ...value, session: value });
    }
    case 'saveSessField': {
      const field = String(b.fieldName || '');
      if (
        !/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(field) ||
        ['uuid', '_id', 'owner_id', 'ownerId', 'createdAt', '__proto__', 'constructor'].includes(
          field,
        )
      )
        return res.status(400).json({ success: false, message: 'Invalid field.' });
      const fieldError = validateRoomField(field, b.fieldVal, settings);
      if (fieldError) return res.status(400).json({ success: false, message: fieldError });
      const columns = {
        name: 'name',
        tagline: 'tagline',
        isMainRoom: 'is_main_room',
        isArchivedRoom: 'is_archived_room',
        isChatOnlyRoom: 'is_chat_only_room',
        isOpen: 'is_open',
        isLocked: 'is_locked',
        chatMode: 'chat_mode',
        alertsOnBottom: 'alerts_on_bottom',
        bkgImg: 'bkg_img',
        bkgImgHREF: 'bkg_img_href',
      };
      if (columns[field])
        db.prepare(`UPDATE sessions SET ${columns[field]} = ? WHERE uuid = ?`).run(
          typeof b.fieldVal === 'boolean' ? Number(b.fieldVal) : b.fieldVal,
          roomId,
        );
      else {
        settings[field] = b.fieldVal;
        db.prepare('UPDATE sessions SET settings = ? WHERE uuid = ?').run(
          JSON.stringify(settings),
          roomId,
        );
      }
      return res.json({ success: true });
    }
    case 'update':
      db.prepare(
        'UPDATE sessions SET name = COALESCE(?,name), tagline = COALESCE(?,tagline), is_archived_room = COALESCE(?,is_archived_room) WHERE uuid = ?',
      ).run(
        b.name ?? null,
        b.tagline ?? null,
        b.isArchivedRoom == null ? null : Number(!!b.isArchivedRoom),
        roomId,
      );
      return res.json({ success: true });
    case 'delete':
    case 'deleteSession': {
      if (
        db
          .prepare(
            "SELECT 1 FROM recordings WHERE room_id=? AND status IN ('recording','processing') LIMIT 1",
          )
          .get(roomId)
      )
        return res.status(409).json({
          success: false,
          message:
            'Stop the active recording and wait for processing to finish before deleting this room.',
        });
      const realtime = require('../realtime/sockjs'),
        notifications = require('../services/notifications'),
        recordingExports = require('../services/recording-exports');
      if (!notifications.pauseRoom(roomId))
        return res.status(409).json({
          success: false,
          message:
            'Wait for the current notification or room deletion to finish before deleting this room.',
        });
      if (!recordingExports.pauseRoom(roomId)) {
        notifications.resumeRoom(roomId);
        return res.status(409).json({
          success: false,
          message:
            'Wait for the current recording export or room deletion to finish before deleting this room.',
        });
      }
      if (!mailService.pauseRoom(roomId)) {
        recordingExports.resumeRoom(roomId);
        notifications.resumeRoom(roomId);
        return res.status(409).json({
          success: false,
          message:
            'Wait for the current room email or room deletion to finish before deleting this room.',
        });
      }
      const stripe = require('../services/stripe');
      if (!stripe.pauseRoom(roomId)) {
        mailService.resumeRoom(roomId);
        recordingExports.resumeRoom(roomId);
        notifications.resumeRoom(roomId);
        return res.status(409).json({
          success: false,
          message: 'Wait for the current payment operation before deleting this room.',
        });
      }
      let ownsDeletionLock = false;
      try {
        if (
          db
            .prepare(
              "SELECT 1 FROM marketplace_orders WHERE room_id=? AND (status IN ('pending','unknown') OR (recurring=1 AND status NOT IN ('cancelled','incomplete_expired','expired'))) LIMIT 1",
            )
            .get(roomId)
        )
          return res.status(409).json({
            success: false,
            message:
              'Resolve pending checkouts and cancel active subscriptions before deleting this room.',
          });
        await realtime.deleteRoomResources(roomId);
        ownsDeletionLock = true;
        if (
          db
            .prepare(
              "SELECT 1 FROM recordings WHERE room_id=? AND status IN ('recording','processing') LIMIT 1",
            )
            .get(roomId)
        )
          return res.status(409).json({
            success: false,
            message:
              'Stop the active recording and wait for processing to finish before deleting this room.',
          });
        const result = removeRoomData(roomId);
        return res.json({
          success: true,
          ...(result.warnings.length ? { warnings: result.warnings } : {}),
        });
      } catch (error) {
        return res.status(500).json({
          success: false,
          message: error.roomDeleted
            ? error.message
            : error.recoveryRequired
              ? 'Room was not deleted; staged files require recovery.'
              : 'Room cleanup failed; the room was not deleted.',
          ...(error.roomDeleted ? { roomDeleted: true } : {}),
          ...(error.recoveryRequired
            ? { recoveryRequired: true, recoveryDirectory: error.recoveryDirectory }
            : {}),
        });
      } finally {
        if (ownsDeletionLock) realtime.cancelRoomDeletion(roomId);
        stripe.resumeRoom(roomId);
        mailService.resumeRoom(roomId);
        recordingExports.resumeRoom(roomId);
        notifications.resumeRoom(roomId);
      }
    }
    case 'listBadges':
      return res.json({ success: true, badges: badges() });
    case 'addBadge': {
      if (!validRoomURL(b.imgURL))
        return res.status(400).json({
          success: false,
          message: 'Enter an HTTP(S) image URL or a same-origin relative path.',
        });
      const id = b.isEdit ? b.badgeID : uuidv4();
      if (b.isEdit && !accountBadge(room.owner_id, id))
        return res.status(404).json({ success: false, message: 'Badge not found.' });
      let assetId;
      try {
        assetId = badgeAsset(room.owner_id, b.imgURL);
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, message: error.message });
      }
      const metadata = JSON.stringify({ roles: b.roles || [] });
      if (b.isEdit) {
        db.prepare(
          'UPDATE badges SET name=?,text=?,color=?,bkcolor=?,image_url=?,metadata=?,asset_file_id=? WHERE id=?',
        ).run(
          b.name || 'Badge',
          b.text || '',
          b.color || '#FFFFFF',
          b.bkcolor || '#ffcc00',
          b.imgURL || '',
          metadata,
          assetId,
          id,
        );
      } else {
        db.prepare(
          'INSERT INTO badges (id,room_id,owner_id,name,text,color,bkcolor,image_url,metadata,asset_file_id) VALUES (?,?,?,?,?,?,?,?,?,?)',
        ).run(
          id,
          roomId,
          room.owner_id,
          b.name || 'Badge',
          b.text || '',
          b.color || '#FFFFFF',
          b.bkcolor || '#ffcc00',
          b.imgURL || '',
          metadata,
          assetId,
        );
      }
      return res.json({ success: true, badges: badges() });
    }
    case 'addBadgeDarkTheme': {
      if (!accountBadge(room.owner_id, b.badgeID))
        return res.status(404).json({ success: false, message: 'Badge not found.' });
      db.prepare('UPDATE badges SET dark_theme=? WHERE id=?').run(
        b.darkTheme || b.darkThemeID || '',
        b.badgeID,
      );
      return res.json({ success: true, badges: badges() });
    }
    case 'deleteBadge': {
      if (!accountBadge(room.owner_id, b.badgeID))
        return res.status(404).json({ success: false, message: 'Badge not found.' });
      db.prepare('DELETE FROM badges WHERE id=?').run(b.badgeID);
      return res.json({ success: true, badges: badges() });
    }
    case 'userList':
    case 'userListBanned':
    case 'userListPresenters':
    case 'userListMuted':
    case 'userListMarketplace': {
      let rows =
        cmd === 'userList'
          ? roomUsers(room)
          : db
              .prepare('SELECT * FROM memberships WHERE room_id = ? ORDER BY created_at DESC')
              .all(roomId)
              .map(ser.membership);
      const term = String(b.searchTerm || '').toLowerCase();
      rows = rows.filter(
        (r) =>
          (!term || (r.email + ' ' + r.name).toLowerCase().includes(term)) &&
          (cmd !== 'userListPresenters' ||
            String(r.role) === 'presenter' ||
            Number(r.role) === 1) &&
          (cmd !== 'userListMuted' || r.muted || Number(r.role) === 3) &&
          (cmd !== 'userListMarketplace' || r.isMa) &&
          (cmd !== 'userListBanned' ||
            db
              .prepare('SELECT 1 FROM banned_users WHERE room_id=? AND email=?')
              .get(roomId, r.email)),
      );
      return res.json({ success: true, xrefs: rows });
    }
    case 'inviteUsers':
    case 'inviteBatchUsers': {
      const persons =
        cmd === 'inviteBatchUsers'
          ? String(b.batchEmailsList || '')
              .split(',')
              .map((email) => ({ email }))
          : b.persons;
      if (
        !Array.isArray(persons) ||
        !persons.length ||
        persons.some((p) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(p.email || '').trim()))
      )
        return res
          .status(400)
          .json({ success: false, message: 'Valid participants are required.' });
      if (
        persons.some(
          (p) =>
            p.pw && (typeof p.pw !== 'string' || p.pw.length < 8 || Buffer.byteLength(p.pw) > 72),
        )
      )
        return res
          .status(400)
          .json({ success: false, message: 'Passwords must be 8 to 72 bytes.' });
      if (persons.some((p) => p.sendEmail === false && !p.pw))
        return res
          .status(400)
          .json({ success: false, message: 'A password is required when email is disabled.' });
      if (persons.some((p) => p.sendEmail !== false) && !process.env.SMTP_HOST)
        return res.status(503).json({ success: false, message: 'Email delivery is unavailable.' });
      let invited = 0;
      for (const p of persons) {
        const email = String(p.email).trim().toLowerCase();
        if (db.prepare('SELECT id FROM memberships WHERE room_id=? AND email=?').get(roomId, email))
          return res
            .status(409)
            .json({ success: false, message: `${email} is already registered.`, invited });
        const password = p.pw || crypto.randomBytes(12).toString('hex'),
          id = uuidv4();
        db.prepare(
          'INSERT INTO memberships (id,room_id,email,name,password_hash,role,status,flags) VALUES (?,?,?,?,?,?,?,?)',
        ).run(
          id,
          roomId,
          email,
          p.name || email,
          bcrypt.hashSync(String(password), 10),
          String(p.role || 'r'),
          'approved',
          '{}',
        );
        if (p.sendEmail !== false) {
          try {
            await sendMail({
              roomID: roomId,
              to: email,
              subject: `Invitation to ${room.name}`,
              text: `Room: ${process.env.PUBLIC_ORIGIN || 'http://localhost:3000'}/u/${roomId}\nEmail: ${email}\nPassword: ${password}`,
            });
          } catch {
            db.prepare('DELETE FROM memberships WHERE id=?').run(id);
            return res
              .status(503)
              .json({ success: false, message: 'Email delivery failed.', invited });
          }
        }
        invited++;
      }
      return res.json({ success: true, invited });
    }
    case 'updateUserXref':
    case 'editUsername': {
      if (
        b.newRole != null &&
        !['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '13', '14'].includes(
          String(b.newRole),
        )
      )
        return res.status(400).json({ success: false, message: 'Invalid participant role.' });
      const member = db
        .prepare('SELECT * FROM memberships WHERE id=? AND room_id=?')
        .get(b.xrefID, roomId);
      if (!member)
        return res.status(404).json({ success: false, message: 'Participant not found.' });
      if (
        b.newPW != null &&
        (typeof b.newPW !== 'string' || b.newPW.length < 8 || Buffer.byteLength(b.newPW) > 72)
      )
        return res.status(400).json({ success: false, message: 'Password must be 8 to 72 bytes.' });
      const flags = ser.json(member.flags);
      const action = String(b.newRole || '');
      if (['7', '8'].includes(action)) flags.hideUserCount = action === '7';
      if (['10', '11'].includes(action)) flags.hidePersInfo = action === '10';
      if (['13', '14'].includes(action)) flags.denyArchivesAccess = action === '13';
      if (action === '9') flags.lastLogin = new Date().toISOString();
      if (b.newPW && b.emailOut) {
        if (!process.env.SMTP_HOST)
          return res
            .status(503)
            .json({ success: false, message: 'Email delivery is unavailable.' });
        try {
          await sendMail({
            roomID: roomId,
            to: member.email,
            subject: `Your ${room.name} password`,
            text: `Room: ${process.env.PUBLIC_ORIGIN || 'http://localhost:3000'}/u/${roomId}\nEmail: ${member.email}\nPassword: ${b.newPW}`,
          });
        } catch {
          return res.status(503).json({ success: false, message: 'Email delivery failed.' });
        }
      }
      for (const k of [
        'newBadges',
        'restrictPM',
        'hasMic',
        'hasScreen',
        'hasCam',
        'hasAdminChat',
        'canEditNotes',
        'note',
      ])
        if (b[k] !== undefined) flags[k === 'newBadges' ? 'badges' : k] = b[k];
      db.prepare(
        'UPDATE memberships SET name=?, role=?, status=?, flags=?, password_hash=? WHERE id=? AND room_id=?',
      ).run(
        b.newUsername || member.name,
        b.newRole == null || Number(b.newRole) >= 7 ? member.role : String(b.newRole),
        b.inviteStatus || member.status,
        JSON.stringify(flags),
        b.newPW ? bcrypt.hashSync(String(b.newPW), 10) : member.password_hash,
        member.id,
        roomId,
      );
      if (b.allRooms && Array.isArray(b.newBadges)) {
        const others = db
          .prepare(
            'SELECT m.* FROM memberships m JOIN sessions s ON s.uuid=m.room_id WHERE s.owner_id=? AND m.email=? AND m.id<>?',
          )
          .all(user.id, member.email, member.id);
        for (const other of others)
          if (requireRoomAccess(user, other.room_id, { manage: true })) {
            const f = ser.json(other.flags);
            f.badges = b.newBadges;
            db.prepare('UPDATE memberships SET flags=? WHERE id=?').run(
              JSON.stringify(f),
              other.id,
            );
          }
      }
      if (b.newRole != null && Number(b.newRole) <= 6)
        setMembershipRole(
          db.prepare('SELECT * FROM memberships WHERE id=?').get(member.id),
          b.newRole,
        );
      else if (b.newPW || b.inviteStatus)
        db.prepare('UPDATE memberships SET token_version=token_version+1 WHERE id=?').run(
          member.id,
        );
      return res.json({ success: true });
    }
    case 'removeUserXref': {
      const changed = db
        .prepare('DELETE FROM memberships WHERE id=? AND room_id=?')
        .run(b.xrefID, roomId);
      return changed.changes
        ? res.json({ success: true })
        : res.status(404).json({ success: false, message: 'Participant not found.' });
    }
    case 'uniqueLinkLogin': {
      const value = crypto.randomBytes(24).toString('base64url');
      settings.uniqueLinkLogin = value;
      db.prepare('UPDATE sessions SET settings=? WHERE uuid=?').run(
        JSON.stringify(settings),
        roomId,
      );
      return res.json({ success: true, uniqueLinkLogin: value });
    }
    case 'emailReminders': {
      if (!process.env.SMTP_HOST)
        return res.status(503).json({ success: false, message: 'Email delivery is unavailable.' });
      const members = db
        .prepare(
          "SELECT * FROM memberships WHERE room_id=? AND status IN ('approved','active','accepted')",
        )
        .all(roomId);
      let sent = 0;
      try {
        for (const m of members) {
          await sendMail({
            roomID: roomId,
            to: m.email,
            subject: `Reminder: ${room.name}`,
            text: `Hello ${m.name},\n\nA reminder to attend ${room.name}${b.webinarDate ? ` at ${b.webinarDate}` : ''}.\nRoom: ${process.env.PUBLIC_ORIGIN || 'http://localhost:3000'}/u/${roomId}`,
          });
          sent++;
        }
      } catch {
        return res.status(503).json({ success: false, message: 'Email delivery failed.', sent });
      }
      return res.json({ success: true, sent });
    }
    case 'getFCMTokens':
    case 'resetFCMTokens':
    case 'updateUserFCMTok':
    case 'manageMobileApp': {
      const member = db
        .prepare('SELECT * FROM memberships WHERE id=? AND room_id=?')
        .get(b.xrefID, roomId);
      if (!member)
        return res.status(404).json({ success: false, message: 'Participant not found.' });
      const flags = ser.json(member.flags);
      if (cmd === 'getFCMTokens')
        return res.json({ success: true, fcmTokens: flags.fcmTokens || [] });
      if (cmd === 'resetFCMTokens') {
        flags.fcmTokens = [];
        flags.alerterAppTokens = [];
      }
      if (cmd === 'updateUserFCMTok') {
        if (!['pause', 'resume', 'unsub'].includes(b.tokcmd))
          return res.status(400).json({ success: false, message: 'Invalid notification command.' });
        flags.alerterAppFCMUserOff = b.tokcmd !== 'resume';
        if (b.tokcmd === 'unsub') {
          flags.fcmTokens = [];
          flags.alerterAppTokens = [];
        }
      }
      if (cmd === 'manageMobileApp') {
        if (!['enable', 'disable'].includes(b.appcmd))
          return res
            .status(400)
            .json({ success: false, message: 'Invalid mobile access command.' });
        flags.hasMobileApp = b.appcmd === 'enable';
      }
      db.prepare('UPDATE memberships SET flags=? WHERE id=?').run(JSON.stringify(flags), member.id);
      return res.json({ success: true });
    }
    case 'showFreeTrials':
      return res.json({
        success: true,
        xrefs: db
          .prepare('SELECT * FROM memberships WHERE room_id=?')
          .all(roomId)
          .map(ser.membership)
          .filter((r) => r.ft || r.freeTrial || r.isFreeTrial),
      });
    case 'clearTokensForUsers': {
      for (const m of db.prepare('SELECT * FROM memberships WHERE room_id=?').all(roomId)) {
        const flags = ser.json(m.flags);
        flags.badges = [];
        db.prepare('UPDATE memberships SET flags=? WHERE id=?').run(JSON.stringify(flags), m.id);
      }
      return res.json({ success: true });
    }
    case 'clearUserList': {
      const members = db.prepare('SELECT * FROM memberships WHERE room_id=?').all(roomId);
      for (const m of members) {
        const presenter =
          ['0', '1', 'a', 'o', 'presenter'].includes(String(m.role)) &&
          !ser.json(m.flags).nonPresenter;
        if (!presenter) db.prepare('DELETE FROM memberships WHERE id=?').run(m.id);
      }
      const xrefs = roomUsers(room);
      return res.json({ success: true, xrefs });
    }
    case 'clearUserListFT': {
      for (const m of db.prepare('SELECT * FROM memberships WHERE room_id=?').all(roomId))
        if (ser.json(m.flags).ft || ser.json(m.flags).freeTrial || ser.json(m.flags).isFreeTrial)
          db.prepare('DELETE FROM memberships WHERE id=?').run(m.id);
      return res.json({ success: true, xrefs: roomUsers(room) });
    }
    case 'updateUserXrefMulty':
    case 'updateUserXrefMultyEmailList':
    case 'updateUserXrefMultyBadge': {
      if (
        cmd !== 'updateUserXrefMultyBadge' &&
        !['1', '2', '3', '4', '5', '6', '10'].includes(String(b.newRole))
      )
        return res.status(400).json({ success: false, message: 'Invalid participant role.' });
      const ids = Array.isArray(b.xrefIDs) ? b.xrefIDs : [],
        emails = Array.isArray(b.emailList) ? b.emailList.map((x) => String(x).toLowerCase()) : [];
      const candidates = db
        .prepare(
          'SELECT m.* FROM memberships m JOIN sessions s ON s.uuid=m.room_id WHERE s.owner_id=?',
        )
        .all(user.id);
      for (const m of candidates) {
        if (
          (!b.applyToAllRooms && m.room_id !== roomId) ||
          !requireRoomAccess(user, m.room_id, { manage: true }) ||
          (!ids.includes(m.id) && !emails.includes(m.email))
        )
          continue;
        if (cmd === 'updateUserXrefMultyBadge') {
          const f = ser.json(m.flags),
            badges = Array.isArray(f.badges) ? f.badges : [];
          f.badges =
            b.badgeCmd === 'remove'
              ? badges.filter((x) => x !== b.badge)
              : [...new Set([...badges, b.badge])];
          db.prepare('UPDATE memberships SET flags=? WHERE id=?').run(JSON.stringify(f), m.id);
        } else if (String(b.newRole) === '10')
          db.prepare('DELETE FROM memberships WHERE id=?').run(m.id);
        else if (b.newRole != null) setMembershipRole(m, b.newRole);
      }
      return res.json({ success: true });
    }
    case 'manageFileAccess': {
      if (!['enable', 'disable'].includes(b.appcmd))
        return res.status(400).json({ success: false, message: 'Invalid file access mode.' });
      const m = db
        .prepare('SELECT * FROM memberships WHERE id=? AND room_id=?')
        .get(b.xrefID, roomId);
      if (!m) return res.status(404).json({ success: false, message: 'Participant not found.' });
      const f = ser.json(m.flags);
      f.fileAccess = b.appcmd;
      f.hasFileAccess = b.appcmd === 'enable';
      db.prepare('UPDATE memberships SET flags=? WHERE id=?').run(JSON.stringify(f), m.id);
      return res.json({ success: true });
    }
    case 'loadTextList':
      return res.json(settings.textList || '');
    case 'saveTextList':
      settings.textList = String(b.textList || '');
      db.prepare('UPDATE sessions SET settings=? WHERE uuid=?').run(
        JSON.stringify(settings),
        roomId,
      );
      return res.json({ success: true });
    case 'changeLogo':
    case 'changeBkgImg':
    case 'changeBkgImgHREF':
    case 'resetBkgImgHREF':
    case 'changeCustomURL': {
      if (['changeLogo', 'changeBkgImg', 'changeBkgImgHREF'].includes(cmd)) {
        const input = cmd === 'changeBkgImgHREF' ? b.href : b.fpath;
        if (!validRoomURL(input))
          return res.status(400).json({
            success: false,
            message: 'Enter an HTTP(S) URL or a same-origin relative path.',
          });
      }
      if (cmd === 'changeLogo') settings.logoURL = b.fpath || '';
      else if (cmd === 'changeCustomURL') {
        const alias = String(b.cname || '')
          .trim()
          .toLowerCase();
        if (alias && !/^[a-z0-9][a-z0-9_-]{2,63}$/.test(alias))
          return res.status(400).json({ success: false, msg: 'Invalid room alias.' });
        const duplicate = db
          .prepare('SELECT uuid,settings FROM sessions WHERE uuid<>?')
          .all(roomId)
          .some((r) => {
            const v = ser.json(r.settings);
            return (
              alias &&
              (String(v.customCname || '').toLowerCase() === alias ||
                String(v.uniqueLinkLogin || '').toLowerCase() === alias)
            );
          });
        if (duplicate)
          return res.status(409).json({ success: false, msg: 'Room alias is already in use.' });
        settings.customCname = alias;
      } else if (cmd === 'changeBkgImg')
        db.prepare('UPDATE sessions SET bkg_img=? WHERE uuid=?').run(b.fpath || '', roomId);
      else {
        db.prepare('UPDATE sessions SET bkg_img_href=? WHERE uuid=?').run(
          cmd === 'resetBkgImgHREF' ? '' : b.href || '',
          roomId,
        );
        if (cmd === 'resetBkgImgHREF')
          db.prepare('UPDATE sessions SET bkg_img=? WHERE uuid=?').run('', roomId);
      }
      db.prepare('UPDATE sessions SET settings=? WHERE uuid=?').run(
        JSON.stringify(settings),
        roomId,
      );
      return res.json({ success: true });
    }
    case 'cloneSession': {
      const sub = ensureUserSubscription(user.id),
        count = db
          .prepare('SELECT COUNT(*) AS n FROM sessions WHERE owner_id=? AND is_archived_room=0')
          .get(user.id).n;
      if (count >= sub.max_rooms && !user.is_admin)
        return res.status(403).json({ success: false, message: 'Room limit reached.' });
      const created = cloneRoom(room, String(b.name || `${room.name} copy`).slice(0, 120));
      return res.json(created.id || created.uuid);
    }
    case 'getSessionFiles':
    case 'sessionPubFiles': {
      if (!canAccessFiles(user, roomId))
        return res.status(403).json({ success: false, message: 'File access denied.' });
      return res.json(
        db
          .prepare('SELECT * FROM files WHERE room_id=? AND visibility=1 ORDER BY created_at DESC')
          .all(roomId)
          .map(ser.file),
      );
    }
    case 'getUserFiles':
      return res.json(
        db
          .prepare('SELECT * FROM files WHERE room_id=? AND category=? ORDER BY created_at DESC')
          .all(roomId, 'logos')
          .map(ser.file),
      );
    case 'deleteFile': {
      const f = db.prepare('SELECT * FROM files WHERE id=? AND room_id=?').get(b.fileID, roomId);
      if (!f) return res.status(404).json({ success: false, message: 'File not found.' });
      db.prepare('DELETE FROM files WHERE id=?').run(f.id);
      try {
        fs.unlinkSync(path.join(UPLOAD_DIR, path.basename(f.stored_name)));
      } catch {}
      return res.json({ success: true });
    }
    case 'statsForSession':
    case 'statsForSessionMontly': {
      let rows = require('../services/activity').userActivity(roomId);
      if (b.d1) rows = rows.filter((r) => Date.parse(r.inTime) >= Date.parse(b.d1));
      if (b.d2) rows = rows.filter((r) => Date.parse(r.inTime) <= Date.parse(b.d2));
      if (b.userSearch)
        rows = rows.filter((r) =>
          (r.email + ' ' + r.userName).toLowerCase().includes(String(b.userSearch).toLowerCase()),
        );
      if (b.showMobileStat) rows = rows.filter((r) => r.isMobile === true);
      if (b.filterFT)
        rows = rows.filter((r) => {
          const m = db
            .prepare('SELECT flags FROM memberships WHERE room_id=? AND email=?')
            .get(roomId, String(r.email || '').toLowerCase());
          const f = ser.json(m?.flags);
          return !!(f.isFreeTrial || f.freeTrial || f.ft);
        });
      if (cmd === 'statsForSessionMontly') {
        const totals = {};
        const start =
          b.startYear && b.startMonth
            ? `${b.startYear}-${String(b.startMonth).padStart(2, '0')}`
            : '';
        const end =
          b.endYear && b.endMonth ? `${b.endYear}-${String(b.endMonth).padStart(2, '0')}` : '';
        for (const row of rows) {
          const month = row.inTime.slice(0, 7);
          if ((start && month < start) || (end && month > end)) continue;
          totals[month] = (totals[month] || 0) + 1;
        }
        return res.json(
          Object.entries(totals)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([month, totalLogins]) => ({ month, totalLogins })),
        );
      }
      return res.json(rows);
    }
    case 'resetMaxCounts': {
      const counts = require('../realtime/sockjs').resetRoomCapacity(roomId);
      return res.json({
        success: true,
        current_capacity: counts.current,
        recordedMaxCapacity: counts.maximum,
      });
    }
    case 'sendTestFCM':
    case 'sendTestAlert': {
      const member = db
        .prepare('SELECT * FROM memberships WHERE id=? AND room_id=?')
        .get(b.xrefID, roomId);
      if (!member)
        return res.status(404).json({
          success: false,
          message: 'Participant not found.',
          msg: 'Participant not found.',
        });
      if (typeof b.msg !== 'string' || !b.msg.trim() || b.msg.length > 4000)
        return res.status(400).json({
          success: false,
          message: 'Enter a message of at most 4000 characters.',
          msg: 'Enter a message of at most 4000 characters.',
        });
      try {
        const result = await require('../services/notifications').sendPush({
          roomID: roomId,
          memberID: member.id,
          text: b.msg,
          title: room.name,
        });
        if (result.disabled)
          return res.status(409).json({
            success: false,
            message: 'Mobile alerts are disabled for this room.',
            msg: 'Mobile alerts are disabled for this room.',
          });
        if (result.recipients === 0 || !(result.accepted || result.skipped))
          return res.status(409).json({
            success: false,
            message: 'No eligible push tokens are registered for this participant.',
            msg: 'No eligible push tokens are registered for this participant.',
          });
        return res.json({
          success: true,
          msg: `Accepted ${result.accepted || 0} notification(s).`,
          delivery: result,
        });
      } catch (error) {
        const message =
          typeof error.message === 'string' && /not configured|not enabled/i.test(error.message)
            ? 'Push delivery is not configured.'
            : error.delivery
              ? error.message
              : 'Push delivery failed.';
        return res.status(/not configured/i.test(message) ? 503 : 502).json({
          success: false,
          message,
          msg: message,
          ...(error.delivery ? { delivery: error.delivery } : {}),
        });
      }
    }
    case 'resetMediaServerSSH':
    case 'resetSingleMediaServerSSH': {
      try {
        const result = await require('../realtime/sockjs').restartRoomMedia(roomId);
        return res.json({ success: true, msg: 'Room media restarted.', ...result });
      } catch (error) {
        return res.status(409).json({
          success: false,
          message: error.message || 'Room media could not be restarted.',
          msg: error.message || 'Room media could not be restarted.',
        });
      }
    }
    case 'updateClusterID':
    case 'applyRepeaterToAccount':
      return res.status(503).json({
        success: false,
        message: 'External media server administration is unavailable.',
        msg: 'External media server administration is unavailable.',
      });
    default:
      return res
        .status(400)
        .json({ success: false, message: `Unsupported session command: ${cmd}` });
  }
});

router.use('/users.json', (req, res, next) => {
  const send = res.json.bind(res);
  res.json = (body) =>
    send(body && body.message && !body.msg ? { ...body, msg: body.message } : body);
  next();
});
router.post('/users.json', async (req, res) => {
  const b = req.body || {},
    cmd = b.cmd;
  if (cmd === 'loginChat') {
    const resolved = db
      .prepare('SELECT uuid FROM sessions WHERE uuid=? OR id=?')
      .get(String(b.roomID || ''), String(b.roomID || ''));
    const canonical = resolved?.uuid || String(b.roomID || '');
    const useful = (value) =>
      typeof value === 'string' && value && value !== 'null' && value !== 'undefined';
    const extracted = extractToken(req, canonical);
    const cookieRequest = { headers: { cookie: req.headers.cookie || '' }, body: {}, query: {} };
    const cookies = [
      extractToken(cookieRequest, canonical),
      extractToken(cookieRequest, ''),
    ].filter(useful);
    const internal = (value) => {
      if (!useful(value) || !verifyTokenString(value)) return false;
      const principal = authenticateRequest({
        headers: { authorization: `Bearer ${value}` },
        body: {},
        query: {},
        method: 'POST',
        baseUrl: '/users/v1',
        path: '/users.json',
      });
      return !!(principal && requireRoomAccess(principal, canonical));
    };
    const explicit = [b.jwtTokenSite, b.siteToken, b.tokenSite, b.jwtToken, b.token].some(internal);
    // A signed but expired local token is still recognizable as local; a
    // foreign JWT must be validated explicitly rather than falling back.
    const signedLocally = (value) => {
      try {
        jwt.verify(value, JWT_SECRET, {
          algorithms: ['HS256'],
          issuer: 'prt-backend',
          audience: 'prt-client',
          ignoreExpiration: true,
          ignoreNotBefore: true,
        });
        return true;
      } catch {
        return false;
      }
    };
    const namedExternal = [b.externalJWT, b.jwt, b.ssoToken, b.__al, b.al].find(useful);
    const jwtExternal = [b.token, b.siteToken].find(
      (value) => useful(value) && /^[\w-]+\.[\w-]+\.[\w-]+$/.test(value) && !signedLocally(value),
    );
    const external = namedExternal || jwtExternal;
    const preferred = !explicit && !external ? cookies.find(internal) : null;
    const initial = preferred
      ? {
          ...b,
          siteToken: null,
          tokenSite: null,
          jwtTokenSite: null,
          jwtToken: null,
          token: preferred,
        }
      : useful(b.token) || useful(b.siteToken) || useful(b.tokenSite)
        ? b
        : { ...b, token: extracted };
    let result = external ? authorizeExternalRoomJWT(canonical, external) : authorizeRoom(initial);
    if (result.error && !external && req.headers.cookie) {
      for (const candidate of cookies) {
        if (!useful(candidate)) continue;
        const attempt = authorizeRoom({
          ...b,
          siteToken: null,
          tokenSite: null,
          jwtTokenSite: null,
          jwtToken: null,
          token: candidate,
        });
        if (!attempt.error) {
          result = attempt;
          break;
        }
      }
    }
    if (result.error) return res.json({ success: false, message: result.error, code: result.code });
    const roomToken = signRoomToken(result.identity, result.room);
    db.prepare(
      'INSERT INTO audit_events (id,actor_id,room_id,action,details) VALUES (?,?,?,?,?)',
    ).run(
      uuidv4(),
      result.identity.id,
      result.room.uuid,
      'room_login',
      JSON.stringify({
        email: result.identity.email,
        userName: result.identity.name,
        inTime: new Date().toISOString(),
      }),
    );
    res.cookie(`prt_room_${result.room.uuid}`, roomToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure,
    });
    const publicRoom = formatSessionRow(result.room);
    for (const key of Object.keys(publicRoom))
      if (
        /secret|password|pw|key|token|credential|private|smtp|stripe|pin|slack|webhook|clientalertposturl|^s3/i.test(
          key,
        )
      )
        delete publicRoom[key];
    return res.json({
      success: true,
      ...result.identity,
      ...publicRoom,
      userName: result.identity.name,
      userID: result.identity.id,
      isPresenter: ['a', 'o'].includes(result.identity.perms),
      isAdmin: !!result.identity.is_admin,
      token: roomToken,
    });
  }
  if (cmd === 'logout') {
    const user = authenticateRequest(req);
    if (!user) return res.status(401).json({ success: false, message: 'Unauthorized.' });
    if (user.is_room_token && user.memberId)
      db.prepare('UPDATE memberships SET token_version=token_version+1 WHERE id=?').run(
        user.memberId,
      );
    else if (user.is_delegate)
      db.prepare('UPDATE admin_users SET token_version=token_version+1 WHERE id=?').run(
        user.actor_id,
      );
    else if (!user.is_api_key && !user.is_room_token)
      db.prepare('UPDATE users SET token_version=token_version+1 WHERE id=?').run(user.id);
    else
      return res
        .status(403)
        .json({ success: false, message: 'Logout is unavailable for this credential.' });
    res.clearCookie('prt_session');
    if (user.room_id) res.clearCookie(`prt_room_${user.room_id}`);
    return res.json({ success: true });
  }
  if (cmd === 'registerByEmail') {
    const room = db
      .prepare('SELECT * FROM sessions WHERE (uuid=? OR id=?) AND is_archived_room=0')
      .get(b.roomID || '', b.roomID || '');
    const email = String(b.email || '')
        .trim()
        .toLowerCase(),
      name = String(b.name || '').trim();
    if (!room || !name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res
        .status(400)
        .json({ success: false, message: 'Room, name and valid email are required.' });
    if (db.prepare('SELECT id FROM memberships WHERE room_id=? AND email=?').get(room.uuid, email))
      return res.json({ success: false, message: 'This email is already registered.' });
    const settings = ser.json(room.settings);
    if (settings.inviteOnly || !['registrationA', 'registrationM'].includes(settings.authMode))
      return res
        .status(403)
        .json({ success: false, message: 'This room is not open for self-registration.' });
    if (!process.env.SMTP_HOST)
      return res.status(503).json({ success: false, message: 'Email delivery is unavailable.' });
    const password = crypto.randomBytes(12).toString('hex'),
      memberId = uuidv4();
    db.prepare(
      'INSERT INTO memberships (id,room_id,email,name,password_hash,role,status,flags) VALUES (?,?,?,?,?,?,?,?)',
    ).run(
      memberId,
      room.uuid,
      email,
      name,
      bcrypt.hashSync(password, 10),
      'r',
      settings.authMode === 'registrationM' ? 'pending' : 'approved',
      '{}',
    );
    const reset = createPasswordReset({ membershipId: memberId });
    try {
      await sendMail({
        roomID: room.uuid,
        to: email,
        subject: `Registration for ${room.name}`,
        text: `Set your password: ${process.env.PUBLIC_ORIGIN || 'http://localhost:3000'}/ptrApp#/page/user-change-password/${reset}\nRoom: ${process.env.PUBLIC_ORIGIN || 'http://localhost:3000'}/ptrApp#/page/login/${room.uuid}`,
      });
    } catch {
      db.prepare('DELETE FROM memberships WHERE id=?').run(memberId);
      return res.status(503).json({ success: false, message: 'Email delivery failed.' });
    }
    return res.json({ success: true, message: 'Registration details were sent.' });
  }
  const user = authenticateRequest(req);
  if (!user) return res.status(401).json({ success: false, message: 'Unauthorized.' });
  if (cmd === 'newSession') {
    if (user.is_room_token || user.is_api_key || user.is_delegate)
      return res.status(403).json({ success: false, message: 'Account owner access required.' });
    const sub = ensureUserSubscription(user.id),
      count = db
        .prepare('SELECT COUNT(*) AS n FROM sessions WHERE owner_id=? AND is_archived_room=0')
        .get(user.id).n;
    if (count >= sub.max_rooms && !user.is_admin)
      return res.json({ success: false, message: 'Room limit reached.' });
    const created = createRoomIdentifiers();
    db.prepare(
      'INSERT INTO sessions (id,uuid,owner_id,name,tagline,is_main_room,is_open) VALUES (?,?,?,?,?,?,1)',
    ).run(
      created.id,
      created.uuid,
      user.id,
      b.name || 'New Room',
      b.tagline || '',
      count === 0 ? 1 : 0,
    );
    return res.json({ success: true, uuid: created.uuid, _id: created.id });
  }
  let roomId = b.roomID || b.sessionID;
  const room =
    roomId &&
    requireRoomAccess(user, roomId, {
      manage: [
        'inviteParticipants',
        'addBadge',
        'setPresenterSetting',
        'clearPresenterSetting',
      ].includes(cmd),
    });
  if (!room) return res.status(403).json({ success: false, message: 'Room access denied.' });
  roomId = room.uuid;
  switch (cmd) {
    case 'getAttachments':
      if (!canAccessFiles(user, roomId))
        return res.status(403).json({ success: false, message: 'File access denied.' });
      return res.json(
        db
          .prepare('SELECT * FROM files WHERE room_id=? ORDER BY created_at DESC')
          .all(roomId)
          .map(ser.file),
      );
    case 'listBadges':
      return res.json({ success: true, badges: accountBadges(room.owner_id).map(ser.badge) });
    case 'addBadge': {
      const id = uuidv4();
      db.prepare(
        'INSERT INTO badges (id,room_id,owner_id,name,text,color,bkcolor) VALUES (?,?,?,?,?,?,?)',
      ).run(
        id,
        roomId,
        room.owner_id,
        b.name || 'Badge',
        b.text || '',
        b.color || '#FFFFFF',
        b.bkcolor || '#ffcc00',
      );
      return res.json({ success: true, id });
    }
    case 'setPresenterSetting':
    case 'clearPresenterSetting': {
      const settings = ser.json(room.presenter_settings);
      if (!b.key || ['__proto__', 'constructor'].includes(b.key))
        return res.status(400).json({ success: false, message: 'Invalid key.' });
      if (cmd === 'setPresenterSetting') settings[b.key] = b.value;
      else delete settings[b.key];
      db.prepare('UPDATE sessions SET presenter_settings=? WHERE uuid=?').run(
        JSON.stringify(settings),
        roomId,
      );
      return res.json({ success: true, presenterSettings: settings });
    }
    case 'inviteParticipants': {
      let persons;
      try {
        persons = typeof b.participants === 'string' ? JSON.parse(b.participants) : b.participants;
      } catch {
        persons = null;
      }
      if (
        !Array.isArray(persons) ||
        !persons.length ||
        persons.some((p) => !String(p.email || '').includes('@'))
      )
        return res
          .status(400)
          .json({ success: false, message: 'Valid participants are required.' });
      if (!process.env.SMTP_HOST)
        return res.status(503).json({ success: false, message: 'Email delivery is unavailable.' });
      for (const p of persons) {
        const email = String(p.email).trim().toLowerCase();
        if (db.prepare('SELECT id FROM memberships WHERE room_id=? AND email=?').get(roomId, email))
          return res
            .status(409)
            .json({ success: false, message: `${email} is already registered.` });
        const password = crypto.randomBytes(12).toString('hex');
        try {
          await sendMail({
            roomID: roomId,
            to: email,
            subject: `Invitation to ${room.name}`,
            text: `Room: ${process.env.PUBLIC_ORIGIN || 'http://localhost:3000'}/ptrApp#/page/login/${roomId}\nEmail: ${email}\nPassword: ${password}`,
          });
        } catch {
          return res.status(503).json({ success: false, message: 'Email delivery failed.' });
        }
        db.prepare(
          'INSERT INTO memberships (id,room_id,email,name,password_hash,role,status,flags) VALUES (?,?,?,?,?,?,?,?)',
        ).run(
          uuidv4(),
          roomId,
          email,
          p.name || email,
          bcrypt.hashSync(password, 10),
          'r',
          'approved',
          '{}',
        );
      }
      return res.json({ success: true });
    }
    default:
      return res.status(400).json({ success: false, message: `Unsupported command: ${cmd}` });
  }
});

// POST /users/v1/adminusers
router.post('/adminusers', (req, res) => {
  const user = authenticateRequest(req);
  if (!user) return res.status(401).json({ success: false, message: 'Unauthorized.' });

  if (user.is_delegate || user.is_api_key || user.is_room_token)
    return res.status(403).json({ success: false, message: 'Account owner access required.' });
  const { cmd = 'list', id, adminUserId, name, email, password, perms } = req.body || {};
  switch (cmd) {
    case 'list': {
      const rows = db
        .prepare('SELECT id, name, email, perms, created_at FROM admin_users WHERE owner_id = ?')
        .all(user.id);
      return res.json({
        success: true,
        adminUsers: rows.map((r) => ({
          ...r,
          _id: r.id,
          created: r.created_at,
          perms: JSON.parse(r.perms || '{}'),
        })),
      });
    }
    case 'add': {
      if (!name || !email || !password) {
        return res.json({ success: false, message: 'Name, email, and password are required.' });
      }
      const normalized = String(email).trim().toLowerCase();
      if (
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ||
        String(password).length < 8 ||
        Buffer.byteLength(String(password)) > 72
      )
        return res.status(400).json({
          success: false,
          message: 'A valid email and password of 8 to 72 bytes are required.',
        });
      if (
        db.prepare('SELECT 1 FROM users WHERE email=?').get(normalized) ||
        db.prepare('SELECT 1 FROM admin_users WHERE email=?').get(normalized)
      )
        return res
          .status(409)
          .json({ success: false, message: 'An account with that email already exists.' });
      const newId = uuidv4();
      db.prepare(
        'INSERT INTO admin_users (id, owner_id, name, email, password_hash, perms) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(
        newId,
        user.id,
        name,
        normalized,
        bcrypt.hashSync(String(password), 10),
        JSON.stringify(perms || {}),
      );
      return res.json({ success: true, id: newId });
    }
    case 'remove':
    case 'delete': {
      if (!id && !adminUserId) return res.json({ success: false, message: 'Missing id.' });
      const changed = db
        .prepare('DELETE FROM admin_users WHERE id = ? AND owner_id = ?')
        .run(id || adminUserId, user.id);
      return changed.changes
        ? res.json({ success: true })
        : res.status(404).json({ success: false, message: 'Admin user not found.' });
    }
    default:
      return res.status(400).json({ success: false, message: 'Unsupported admin command.' });
  }
});

// POST /users/v1/apikeys
router.post('/apikeys', (req, res) => {
  const user = authenticateRequest(req);
  if (!user) return res.status(401).json({ success: false, message: 'Unauthorized.' });

  if (user.is_delegate || user.is_api_key || user.is_room_token)
    return res.status(403).json({ success: false, message: 'Account owner access required.' });
  const { cmd = 'list', apiId, name, sessions, endpoints } = req.body || {};
  switch (cmd) {
    case 'list': {
      const rows = db
        .prepare(
          'SELECT id, name, api_key, sessions, endpoints, created_at FROM api_keys WHERE owner_id = ?',
        )
        .all(user.id);
      return res.json({
        success: true,
        keys: rows.map((r) => ({
          ...r,
          _id: r.id,
          key: r.id,
          secret: r.api_key,
          apiKey: r.id,
          apiSecret: r.api_key,
          restrictToSessions: JSON.parse(r.sessions || '[]'),
          restrictToEndpoints: JSON.parse(r.endpoints || '[]'),
          sessions: JSON.parse(r.sessions || '[]'),
          endpoints: JSON.parse(r.endpoints || '[]'),
        })),
      });
    }
    case 'create':
    case 'add': {
      const newId = uuidv4();
      const apiKey = `prt_${crypto.randomBytes(32).toString('hex')}`;
      db.prepare('INSERT INTO api_keys (id, owner_id, name, api_key) VALUES (?, ?, ?, ?)').run(
        newId,
        user.id,
        name || 'API Key',
        apiKey,
      );
      return res.json({
        success: true,
        id: newId,
        apiKey: newId,
        apiSecret: apiKey,
        key: { _id: newId, apiSecret: apiKey },
      });
    }
    case 'rotate': {
      const key = `prt_${crypto.randomBytes(32).toString('hex')}`;
      const r = db
        .prepare('UPDATE api_keys SET api_key=? WHERE id=? AND owner_id=?')
        .run(key, apiId, user.id);
      return res.json(
        r.changes
          ? { success: true, apiKey: apiId, apiSecret: key, newSecret: key }
          : { success: false, message: 'Key not found.' },
      );
    }
    case 'listAllApiEndpoints':
      return res.json({
        success: true,
        endpoints: [
          '/stats/v1/sessions/delUsers',
          '/stats/v1/sessions/addUsers',
          '/stats/v1/sessions/list',
          '/stats/v1/sessions/userstats',
          '/stats/v1/sessions/users',
          '/stats/v1/sessions/chatlogs',
          '/stats/v1/sessions/alertlogs',
          '/stats/v1/sessions/deletedlogs',
          '/stats/v1/sessions/archivedlogs',
          '/stats/v1/sessions/recordings',
          '/stats/v1/sessions/cloneSession',
        ],
      });
    case 'restrictApiSessions':
    case 'restrictApiEndpoints': {
      const values = cmd === 'restrictApiSessions' ? sessions : endpoints;
      if (!Array.isArray(values))
        return res.status(400).json({ success: false, message: 'Restrictions must be an array.' });
      const column = cmd === 'restrictApiSessions' ? 'sessions' : 'endpoints';
      const changed = db
        .prepare(`UPDATE api_keys SET ${column}=? WHERE id=? AND owner_id=?`)
        .run(JSON.stringify(values), apiId, user.id);
      return changed.changes
        ? res.json({ success: true })
        : res.status(404).json({ success: false, message: 'Key not found.' });
    }
    case 'delete': {
      const changed = db
        .prepare('DELETE FROM api_keys WHERE id=? AND owner_id=?')
        .run(apiId, user.id);
      return changed.changes
        ? res.json({ success: true })
        : res.status(404).json({ success: false, message: 'Key not found.' });
    }
    default:
      return res.status(400).json({ success: false, message: 'Unsupported API key command.' });
  }
});

router.get('/recordingFile', (req, res) => {
  const recording = db
    .prepare('SELECT * FROM recordings WHERE id=?')
    .get(String(req.query.id || ''));
  if (!recording) return res.status(404).send('Recording not found');
  req.authRoomId = recording.room_id;
  const user = authenticateRoomRequest(req, recording.room_id);
  if (!user || !canAccessRecordings(user, recording.room_id))
    return res.status(403).send('Room access denied');
  const file = path.resolve(RECORDINGS_DIR, recording.file_path || '');
  if (!file.startsWith(RECORDINGS_DIR + path.sep) || !fs.existsSync(file))
    return res.status(404).send('Recording file not found');
  res.type(recording.mime_type || 'video/webm');
  return res.sendFile(file);
});
router.post('/recordings', (req, res) => {
  const user = authenticateRequest(req);
  if (!user) return res.status(401).json({ success: false, message: 'Unauthorized.' });
  let roomId = req.body?.roomID || req.body?.sessionID;
  if (roomId && !canAccessRecordings(user, roomId))
    return res.status(403).json({ success: false, message: 'Room access denied.' });
  if (roomId) roomId = requireRoomAccess(user, roomId).uuid;
  const rows = roomId
    ? db.prepare('SELECT * FROM recordings WHERE room_id=? ORDER BY created_at DESC').all(roomId)
    : db
        .prepare('SELECT * FROM recordings ORDER BY created_at DESC')
        .all()
        .filter((r) => canAccessRecordings(user, r.room_id));
  return res.json(rows.map(ser.recording));
});
router.get('/archives/:type/:sessId/:token', (req, res) => {
  const { type, sessId, token } = req.params;
  req.body = { ...(req.body || {}), token };
  const user = authenticateRequest(req);
  if (!user || !canAccessArchives(user, sessId, { type }))
    return res.status(403).json({ success: false, message: 'Room access denied.' });
  if (type === 'recordings')
    return res.json({
      roomID: sessId,
      recordings: db
        .prepare('SELECT * FROM recordings WHERE room_id=? ORDER BY created_at DESC')
        .all(sessId)
        .map(ser.recording),
    });
  if (type === 'alerts')
    return res.json({
      roomID: sessId,
      type,
      alerts: db
        .prepare('SELECT * FROM alerts WHERE room_id=? ORDER BY created_at ASC')
        .all(sessId),
    });
  if (type === 'chat' || type === 'messages')
    return res.json({
      roomID: sessId,
      type,
      messages: db
        .prepare('SELECT * FROM messages WHERE room_id=? ORDER BY created_at ASC')
        .all(sessId),
    });
  return res.status(400).json({ success: false, message: 'Unsupported archive type.' });
});
function uploadFile(req, res) {
  const roomId = req.params.sessionID || req.body?.roomID || req.body?.sessionID;
  const resolved =
    roomId && db.prepare('SELECT uuid FROM sessions WHERE uuid=? OR id=?').get(roomId, roomId);
  if (resolved) req.authRoomId = resolved.uuid;
  const user = resolved ? authenticateRoomRequest(req, resolved.uuid) : null;
  const room = user && roomId && requireRoomAccess(user, roomId);
  const manage = room && requireRoomAccess(user, room.uuid, { manage: true });
  const participantUpload =
    room &&
    !req.params.sessionID &&
    ser.json(room.settings).userUploads &&
    canAccessFiles(user, room.uuid);
  if (!room || (!manage && !participantUpload)) {
    if (req.file) fs.unlinkSync(req.file.path);
    return res.status(403).json({ success: false, message: 'Room access denied.' });
  }
  if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded.' });
  const id = uuidv4();
  db.prepare(
    'INSERT INTO files (id,room_id,uploader_id,uploader_name,original_name,stored_name,mime_type,size_bytes,visibility,category) VALUES (?,?,?,?,?,?,?,?,?,?)',
  ).run(
    id,
    room.uuid,
    user.actor_id || user.id,
    user.name,
    req.file.originalname,
    req.file.filename,
    req.file.mimetype,
    req.file.size,
    Number(req.params.visibility || 1),
    req.params.type || 'files',
  );
  return res.json({
    success: true,
    ...ser.file(db.prepare('SELECT * FROM files WHERE id=?').get(id)),
  });
}
router.post('/upload', preauthenticateUpload, upload.single('file'), uploadFile);
router.post(
  '/session/upload/:sessionID/:token/:visibility/:type',
  (req, res, next) => {
    req.headers.authorization = `Bearer ${req.params.token}`;
    next();
  },
  preauthenticateUpload,
  upload.single('file'),
  uploadFile,
);
router.get('/serveFile', (req, res) => {
  const file = db.prepare('SELECT * FROM files WHERE id=?').get(String(req.query.id || ''));
  if (!file) return res.status(404).send('File not found');
  req.authRoomId = file.room_id;
  const user = authenticateRoomRequest(req, file.room_id);
  if ((!user || !canAccessFiles(user, file.room_id)) && !canAccessBadgeAsset(req, file))
    return res.status(403).send('Room access denied');
  const fullPath = path.join(UPLOAD_DIR, path.basename(file.stored_name));
  if (!fs.existsSync(fullPath)) return res.status(404).send('File missing on disk');
  return res.download(fullPath, file.original_name);
});
router.get('/ssoJWT', (req, res) => {
  const requested = String(req.query.sessID || ''),
    external = req.query.jwt;
  const hasExternal =
    typeof external === 'string' &&
    external !== '' &&
    external !== 'null' &&
    external !== 'undefined';
  let result;
  if (hasExternal) {
    // An explicitly supplied external token must itself validate even if an
    // unrelated site cookie is present.
    result = authorizeExternalRoomJWT(requested, external);
  } else {
    const user = authenticateRequest(req);
    const room = user && requested && requireRoomAccess(user, requested);
    if (!user || user.is_room_token || user.is_api_key || !room)
      return res.status(403).json({ success: false, message: 'Room access denied.' });
    result = authorizeRoom({ roomID: room.uuid, token: extractToken(req) });
  }
  if (result.error)
    return res.status(403).json({ success: false, message: result.error, code: result.code });
  const roomId = result.room.uuid,
    roomToken = signRoomToken(result.identity, result.room);
  if (String(req.query.sl || '') === '1') {
    res.cookie(`prt_room_${roomId}`, roomToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure,
    });
    return res.redirect(`/session?id=${encodeURIComponent(roomId)}`);
  }
  return res.json({ success: true, jwt: roomToken, sessID: roomId });
});

module.exports = router;
