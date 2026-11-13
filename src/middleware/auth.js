const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { JWT_SECRET, JWT_EXPIRES_IN } = require('../config');
const db = require('../db/database');

const ISSUER = 'prt-backend';
const AUDIENCE = 'prt-client';
const safeJSON = (value, fallback = {}) => {
  try {
    return JSON.parse(value || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
};
const normalizeEmail = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '');
const validToken = (value) =>
  typeof value === 'string' && value !== 'null' && value !== 'undefined' && value.length > 0;
const presenterRole = (role) => ['0', '1', 'a', 'o', 'admin', 'presenter'].includes(String(role));
const allowedMember = (member) => {
  if (String(member.role) === '4') return false;
  if (['approved', 'active', 'accepted'].includes(member.status)) return true;
  const flags = safeJSON(member.flags);
  return (
    member.status === 'suspended' &&
    flags.stripeSuspended === true &&
    Number.isFinite(Date.parse(flags.temporaryAccess?.expiresAt)) &&
    Date.parse(flags.temporaryAccess.expiresAt) > Date.now()
  );
};

function signToken(user) {
  const delegate = Boolean(user.is_delegate || user.owner_id);
  return jwt.sign(
    {
      sub: user.actor_id || user.id,
      kind: delegate ? 'delegate' : 'account',
      email: user.email,
      name: user.name,
      version: user.token_version || 0,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN, issuer: ISSUER, audience: AUDIENCE, algorithm: 'HS256' },
  );
}

function verifyTokenString(token) {
  if (!validToken(token) || token.length > 8192) return null;
  try {
    return jwt.verify(token, JWT_SECRET, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
    });
  } catch {
    return null;
  }
}

function extractToken(
  req,
  roomId = req.authRoomId || req.body?.roomID || req.body?.sessionID || req.query?.roomID,
) {
  const header = req.headers?.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7).trim();
  const candidates = [
    req.headers?.['x-api-key'],
    req.body?.siteToken,
    req.body?.tokenSite,
    req.body?.token,
    req.query?.token,
    req.params?.token,
  ];
  for (const value of candidates) if (validToken(value)) return value;
  const cookies = String(req.headers?.cookie || '')
    .split(';')
    .map((part) => part.trim());
  const roomCookie = roomId && cookies.find((part) => part.startsWith(`prt_room_${roomId}=`));
  if (roomCookie) {
    try {
      return decodeURIComponent(roomCookie.slice(roomCookie.indexOf('=') + 1));
    } catch {}
  }
  const cookie = cookies.find((part) => part.startsWith('prt_session='));
  if (cookie) {
    try {
      return decodeURIComponent(cookie.trim().slice(12));
    } catch {}
  }
  return null;
}

function principalFromPayload(payload) {
  if (!payload) return null;
  if (payload.kind === 'delegate') {
    const delegate = db.prepare('SELECT * FROM admin_users WHERE id = ?').get(payload.sub);
    if (!delegate || Number(payload.version) !== delegate.token_version) return null;
    const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(delegate.owner_id);
    if (!owner) return null;
    return {
      id: owner.id,
      owner_id: owner.id,
      actor_id: delegate.id,
      name: delegate.name,
      email: delegate.email,
      role: 'delegate',
      is_admin: 0,
      is_delegate: true,
      delegate_perms: safeJSON(delegate.perms),
      token_version: delegate.token_version,
    };
  }
  if (payload.kind === 'room') {
    const room = db.prepare('SELECT * FROM sessions WHERE uuid = ?').get(payload.roomID);
    if (!room || room.access_version !== Number(payload.roomVersion)) return null;
    const identity = identityFromRoomPayload(payload, room);
    return identity
      ? {
          ...identity,
          id: identity.accountId || identity.id,
          room_id: room.uuid,
          is_room_token: true,
        }
      : null;
  }
  if (payload.kind !== 'account') return null;
  const user = db
    .prepare('SELECT id,name,email,role,is_admin,token_version FROM users WHERE id = ?')
    .get(payload.sub);
  if (!user || user.token_version !== Number(payload.version)) return null;
  return user;
}

function apiEndpointAllowed(principal, req) {
  const allowed = principal.api_endpoints;
  if (!allowed.length) return true;
  const command = String(req.body?.cmd || '');
  const full = `${req.baseUrl || ''}${req.path || ''}`;
  return allowed.some((entry) => {
    const value =
      typeof entry === 'string' ? entry : entry.endpoint || entry.name || entry.cmd || entry._id;
    return (
      value === command || value === full || value === `${req.method} ${full}` || value === '*'
    );
  });
}

function authenticateRequest(req) {
  const token = extractToken(req);
  if (!validToken(token)) return null;
  if (token.startsWith('prt_')) {
    const key = db
      .prepare('SELECT * FROM api_keys WHERE api_key = ? AND revoked_at IS NULL')
      .get(token);
    if (!key) return null;
    const owner = db
      .prepare('SELECT id,name,email,role,is_admin,token_version FROM users WHERE id = ?')
      .get(key.owner_id);
    if (!owner) return null;
    const principal = {
      ...owner,
      actor_id: key.id,
      is_admin: 0,
      is_api_key: true,
      api_sessions: safeJSON(key.sessions, []),
      api_endpoints: safeJSON(key.endpoints, []),
    };
    if (!apiEndpointAllowed(principal, req)) return null;
    db.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?").run(key.id);
    return principal;
  }
  return principalFromPayload(verifyTokenString(token));
}

function isManager(user, room) {
  if (!user || (user.is_room_token && !['a', 'o'].includes(user.perms))) return false;
  if (user.is_admin) return true;
  if ((user.accountId || user.id) !== room.owner_id) return false;
  if (user.is_delegate) {
    const perms = user.delegate_perms || {};
    // Empty delegate permissions retain the original full-account delegation.
    if (perms.manageSessions === false || perms.manageRooms === false || perms.readOnly === true)
      return false;
  }
  return true;
}

function requireRoomAccess(user, roomId, { manage = false } = {}) {
  if (!user || typeof roomId !== 'string') return null;
  const room = db.prepare('SELECT * FROM sessions WHERE uuid = ? OR id = ?').get(roomId, roomId);
  if (!room) return null;
  roomId = room.uuid;
  if (
    user.is_api_key &&
    user.api_sessions.length &&
    !user.api_sessions.some((s) =>
      [room.uuid, room.id].includes(typeof s === 'string' ? s : s.uuid || s._id || s.id),
    )
  )
    return null;
  if (user.is_room_token && user.room_id !== roomId) return null;
  if (isManager(user, room)) return room;
  if (manage) return null;
  if (user.is_room_token && user.room_id === roomId) return room;
  const member = db
    .prepare('SELECT * FROM memberships WHERE room_id = ? AND email = ?')
    .get(roomId, normalizeEmail(user.email));
  if (
    !member ||
    !allowedMember(member) ||
    db
      .prepare('SELECT 1 FROM banned_users WHERE room_id = ? AND email = ?')
      .get(roomId, member.email)
  )
    return null;
  return room;
}

function identityFromRoomPayload(payload, room) {
  if (payload.accountId) {
    const accountPayload = {
      sub: payload.actorId || payload.accountId,
      kind: payload.accountKind || 'account',
      version: payload.version,
    };
    const user = principalFromPayload(accountPayload);
    if (!user) return null;
    const permitted = requireRoomAccess(user, room.uuid);
    if (!permitted) return null;
    const membership = db
      .prepare('SELECT * FROM memberships WHERE room_id=? AND email=?')
      .get(room.uuid, user.email);
    const managed = isManager(user, room);
    return {
      id: user.actor_id || user.id,
      uid: user.actor_id || user.id,
      accountId: user.id,
      actorId: user.actor_id,
      accountKind: payload.accountKind || 'account',
      version: user.token_version,
      email: user.email,
      name: user.name,
      nick: payload.nick || user.name,
      perms: managed ? 'a' : membership && presenterRole(membership.role) ? 'o' : 'r',
      is_admin: user.is_admin,
      role: user.role,
      flags: membership ? safeJSON(membership.flags) : {},
    };
  }
  const member = db
    .prepare('SELECT * FROM memberships WHERE id = ? AND room_id = ?')
    .get(payload.sub, room.uuid);
  if (!member || member.token_version !== Number(payload.version) || !allowedMember(member))
    return null;
  if (
    db
      .prepare('SELECT 1 FROM banned_users WHERE room_id = ? AND email = ?')
      .get(room.uuid, member.email)
  )
    return null;
  return {
    id: member.id,
    uid: member.id,
    memberId: member.id,
    email: member.email,
    name: member.name,
    nick: payload.nick || member.name,
    perms: presenterRole(member.role) ? 'o' : 'r',
    is_admin: 0,
    role: member.role,
    version: member.token_version,
    flags: safeJSON(member.flags),
  };
}

function signRoomToken(identity, room) {
  const settings = safeJSON(room.settings);
  const match = String(settings.tokenExpiresIn || '')
    .trim()
    .match(/^([1-9]\d*)(m|h|d)$/);
  const seconds = match ? Number(match[1]) * { m: 60, h: 3600, d: 86400 }[match[2]] : 43200;
  const expiresIn = Math.max(300, Math.min(30 * 86400, seconds));
  return jwt.sign(
    {
      sub: identity.memberId || identity.id || identity.uid,
      kind: 'room',
      roomID: room.uuid,
      roomVersion: room.access_version,
      version: identity.version || 0,
      accountId: identity.accountId,
      actorId: identity.actorId,
      accountKind: identity.accountKind,
      nick: identity.nick || identity.name,
    },
    JWT_SECRET,
    { expiresIn, issuer: ISSUER, audience: AUDIENCE, algorithm: 'HS256' },
  );
}

function externalJWT(data) {
  for (const candidate of [
    data.externalJWT,
    data.jwt,
    data.ssoToken,
    data.__al,
    data.al,
    data.token,
  ]) {
    if (!validToken(candidate) || candidate.length > 8192) continue;
    if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(candidate)) return candidate;
    try {
      const decoded = JSON.parse(Buffer.from(candidate, 'base64url').toString('utf8'));
      for (const token of [decoded.jwt, decoded.token, decoded.ssoToken])
        if (validToken(token) && /^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) return token;
    } catch {}
  }
  return null;
}

function ssoIdentity(room, settings, token) {
  if (typeof settings.ssoJWTSecret !== 'string' || settings.ssoJWTSecret.length < 32)
    return { error: 'The room SSO signing secret is not configured.', code: 'SSO_UNAVAILABLE' };
  let claims;
  try {
    claims = jwt.verify(token, settings.ssoJWTSecret, {
      algorithms: ['HS256'],
      ...(settings.ssoJWTAudience ? { audience: settings.ssoJWTAudience } : {}),
    });
    if (
      !claims ||
      typeof claims !== 'object' ||
      !Number.isFinite(claims.exp) ||
      claims.exp <= Date.now() / 1000
    )
      throw new Error('Expiry required');
  } catch {
    return {
      error: settings.customJWTErrorMessage || 'The sign-in link is invalid or expired.',
      code: 'SSO_INVALID',
    };
  }
  const target = claims.roomID || claims.sessID || claims.sessionID;
  if (target && ![room.uuid, room.id].includes(String(target)))
    return { error: 'The sign-in link is for a different room.', code: 'SSO_INVALID' };
  const email = normalizeEmail(claims.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)
    return { error: 'A verified email is required in the sign-in link.', code: 'SSO_INVALID' };
  const list = (value) =>
    Array.isArray(value)
      ? value.map((x) => String(typeof x === 'object' && x ? x.id || x.slug || x.name || '' : x))
      : typeof value === 'string'
        ? value
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean)
        : [];
  const restrictions = [
    ['allowedMemberships', claims.memberships],
    ['allowedProducts', claims.products],
    ['allowedPerms', claims.permissions || claims.perms],
  ].filter(([key]) => list(settings[key]).length);
  // The captured UI specifies that matching a product or membership is sufficient.
  if (
    restrictions.length &&
    !restrictions.some(([key, value]) =>
      list(settings[key]).some((required) => list(value).includes(required)),
    )
  )
    return { error: 'Your membership does not grant access to this room.', code: 'SSO_FORBIDDEN' };
  if (settings.secTok) {
    const actual = Buffer.from(String(claims.secTok || claims.secretToken || '')),
      expected = Buffer.from(String(settings.secTok));
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected))
      return { error: 'The sign-in link is missing the room credential.', code: 'SSO_INVALID' };
  }
  if (db.prepare('SELECT 1 FROM banned_users WHERE room_id=? AND email=?').get(room.uuid, email))
    return { error: 'You are banned from this room.', code: 'BANNED' };
  let member = db
    .prepare('SELECT * FROM memberships WHERE room_id=? AND email=?')
    .get(room.uuid, email);
  if (member && !allowedMember(member))
    return { error: 'Your room access has not been approved.', code: 'SSO_FORBIDDEN' };
  if (!member) {
    const id = crypto.randomUUID(),
      name = String(
        claims.name || claims.display_name || claims.userid || email.split('@')[0],
      ).slice(0, 120);
    db.prepare(
      'INSERT INTO memberships(id,room_id,email,name,role,status,flags) VALUES(?,?,?,?,?,?,?)',
    ).run(id, room.uuid, email, name, '2', 'approved', JSON.stringify({ authProvider: 'jwt' }));
    member = db.prepare('SELECT * FROM memberships WHERE id=?').get(id);
  }
  return {
    identity: {
      id: member.id,
      uid: member.id,
      memberId: member.id,
      email: member.email,
      name: member.name,
      nick: member.name,
      perms: presenterRole(member.role) ? 'o' : 'r',
      is_admin: 0,
      role: member.role,
      version: member.token_version,
      flags: safeJSON(member.flags),
    },
  };
}

function authorizeRoom(data = {}) {
  if (!data || typeof data !== 'object' || typeof data.roomID !== 'string')
    return { error: 'A room is required.', code: 'ROOM_NOT_FOUND' };
  const room = db
    .prepare('SELECT * FROM sessions WHERE (uuid = ? OR id = ?) AND is_archived_room = 0')
    .get(data.roomID, data.roomID);
  if (!room) return { error: 'Room not found.', code: 'ROOM_NOT_FOUND' };
  const settings = safeJSON(room.settings);
  const mode = settings.authMode || 'open';
  let identity;
  for (const token of [
    data.jwtTokenSite,
    data.siteToken,
    data.tokenSite,
    data.jwtToken,
    data.token,
  ]) {
    const payload = verifyTokenString(token);
    if (!payload) continue;
    if (payload.kind === 'room') {
      if (payload.roomID !== room.uuid || Number(payload.roomVersion) !== room.access_version)
        continue;
      identity = identityFromRoomPayload(payload, room);
    } else {
      const user = principalFromPayload(payload);
      if (user && requireRoomAccess(user, room.uuid))
        identity = {
          id: user.actor_id || user.id,
          uid: user.actor_id || user.id,
          accountId: user.id,
          actorId: user.actor_id,
          accountKind: user.is_delegate ? 'delegate' : 'account',
          version: user.token_version,
          email: user.email,
          name: user.name,
          nick: String(data.nick || data.name || user.name).slice(0, 120),
          perms: isManager(user, room) ? 'a' : 'r',
          is_admin: user.is_admin,
          role: user.role,
        };
    }
    if (identity) break;
  }
  if (!identity && ['jwt', 'sso'].includes(mode)) {
    const token = externalJWT(data);
    if (token) {
      const external = ssoIdentity(room, settings, token);
      if (external.error) return external;
      identity = external.identity;
    }
  }
  const email = normalizeEmail(identity?.email || data.email);
  if (
    email &&
    db.prepare('SELECT 1 FROM banned_users WHERE room_id = ? AND email = ?').get(room.uuid, email)
  )
    return { error: 'You are banned from this room.', code: 'BANNED' };
  if (!identity && typeof data.pw === 'string') {
    const account = db.prepare('SELECT * FROM users WHERE email=?').get(email);
    if (
      account &&
      requireRoomAccess(account, room.uuid) &&
      bcrypt.compareSync(data.pw, account.password_hash)
    ) {
      const membership = db
        .prepare('SELECT * FROM memberships WHERE room_id=? AND email=?')
        .get(room.uuid, email);
      identity = {
        id: account.id,
        uid: account.id,
        accountId: account.id,
        accountKind: 'account',
        version: account.token_version,
        email: account.email,
        name: account.name,
        nick: account.name,
        perms: isManager(account, room)
          ? 'a'
          : membership && presenterRole(membership.role)
            ? 'o'
            : 'r',
        is_admin: account.is_admin,
        role: account.role,
        flags: membership ? safeJSON(membership.flags) : {},
      };
    }
  }
  if (!identity) {
    const validIdentifier =
      mode === 'unamePW'
        ? /^[^\s<>]{1,120}$/.test(email)
        : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    if (!email || !validIdentifier || email.length > 254)
      return {
        error: mode === 'unamePW' ? 'Enter your username.' : 'Enter a valid email address.',
        code: 'UNAUTHORIZED',
      };
    if (['sso', 'jwt'].includes(mode) && !settings.allowPWLoginWithSSO)
      return { error: 'Use your organization sign-in link.', code: 'SSO_REQUIRED' };
    let member = db
      .prepare('SELECT * FROM memberships WHERE room_id = ? AND email = ?')
      .get(room.uuid, email);
    const sharedPasswords = ['webinarPW', 'webinarPW2', 'webinarPW3', 'webinarPWFreeTrial']
      .map((key) => settings[key])
      .filter((value) => typeof value === 'string' && value.length);
    const sharedMode =
      mode === 'webinarRoom' || (['sso', 'jwt'].includes(mode) && settings.allowPWLoginWithSSO);
    const sharedMatch =
      sharedMode &&
      typeof data.pw === 'string' &&
      sharedPasswords.some((value) => {
        const actual = Buffer.from(data.pw),
          expected = Buffer.from(value);
        return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
      });
    const protectedRoom =
      ['unamePW', 'registrationA', 'registrationM'].includes(mode) ||
      settings.requireRegistration ||
      settings.inviteOnly;
    if (!member && protectedRoom)
      return { error: 'You must be invited to this room.', code: 'UNAUTHORIZED' };
    if (sharedMode && !sharedMatch && !member?.password_hash)
      return { error: 'Invalid room password.', code: 'UNAUTHORIZED' };
    if (member && !allowedMember(member))
      return { error: 'Your room access has not been approved.', code: 'UNAUTHORIZED' };
    if (member?.password_hash) {
      if (typeof data.pw !== 'string' || !bcrypt.compareSync(data.pw, member.password_hash))
        return { error: 'Invalid email or password.', code: 'UNAUTHORIZED' };
    } else if (member && presenterRole(member.role))
      return { error: 'Presenter authentication is required.', code: 'UNAUTHORIZED' };
    else if (member && !sharedMatch)
      return {
        error: 'Use your room sign-in link or reset your password to sign in.',
        code: 'AUTHENTICATION_REQUIRED',
      };
    if (
      (settings.requirePassword || settings.hasRequiredPWInLogin) &&
      !sharedMatch &&
      !member?.password_hash
    )
      return { error: 'A room password is required.', code: 'UNAUTHORIZED' };
    if (settings.pin && String(data.pin || '') !== String(settings.pin))
      return { error: 'Invalid room PIN.', code: 'UNAUTHORIZED' };
    if (!member) {
      const id = crypto.randomUUID();
      db.prepare('INSERT INTO memberships(id,room_id,email,name) VALUES(?,?,?,?)').run(
        id,
        room.uuid,
        email,
        String(data.nick || data.name || email.split('@')[0]).slice(0, 120),
      );
      member = db.prepare('SELECT * FROM memberships WHERE id = ?').get(id);
    }
    identity = {
      id: member.id,
      uid: member.id,
      memberId: member.id,
      email,
      name: member.name,
      nick: String(data.nick || data.name || member.name).slice(0, 120),
      perms: presenterRole(member.role) ? 'o' : 'r',
      is_admin: 0,
      role: member.role,
      version: member.token_version,
      flags: safeJSON(member.flags),
    };
  }
  identity.nonPresenter = Boolean(identity.flags?.nonPresenter);
  if (typeof data.nick === 'string' && data.nick.trim())
    identity.nick = data.nick.trim().slice(0, 120);
  if (!['a', 'o'].includes(identity.perms)) {
    if (!room.is_open) return { error: 'This room is closed.', code: 'ROOM_CLOSED' };
    if (room.is_locked) return { error: 'This room is locked.', code: 'ROOM_LOCKED' };
  }
  return { identity, room };
}

function createPasswordReset({ userId = null, membershipId = null }) {
  if (Boolean(userId) === Boolean(membershipId))
    throw new Error('A reset must target exactly one identity.');
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare(
    'INSERT INTO password_resets(id,token_hash,user_id,membership_id,expires_at) VALUES(?,?,?,?,?)',
  ).run(
    crypto.randomUUID(),
    crypto.createHash('sha256').update(token).digest('hex'),
    userId,
    membershipId,
    new Date(Date.now() + 3600000).toISOString(),
  );
  return token;
}

function consumePasswordReset(token, nextPassword) {
  if (
    !validToken(token) ||
    typeof nextPassword !== 'string' ||
    nextPassword.length < 8 ||
    Buffer.byteLength(nextPassword) > 72
  )
    return false;
  const row = db
    .prepare('SELECT * FROM password_resets WHERE token_hash = ? AND used_at IS NULL')
    .get(crypto.createHash('sha256').update(token).digest('hex'));
  if (!row || Date.parse(row.expires_at) <= Date.now()) return false;
  const hash = bcrypt.hashSync(nextPassword, 10);
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = db
      .prepare(
        "UPDATE password_resets SET used_at = datetime('now') WHERE id = ? AND used_at IS NULL",
      )
      .run(row.id);
    if (!result.changes) {
      db.exec('ROLLBACK');
      return false;
    }
    const table = row.user_id ? 'users' : 'memberships';
    db.prepare(
      `UPDATE ${table} SET password_hash = ?, token_version = token_version + 1 WHERE id = ?`,
    ).run(hash, row.user_id || row.membership_id);
    db.exec('COMMIT');
    return true;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

module.exports = {
  signToken,
  verifyTokenString,
  extractToken,
  authenticateRequest,
  requireRoomAccess,
  authorizeRoom,
  signRoomToken,
  createPasswordReset,
  consumePasswordReset,
  normalizeEmail,
  isManager,
  allowedMember,
  authorizeExternalRoomJWT: (roomID, token) =>
    authorizeRoom({ roomID: String(roomID || ''), externalJWT: token }),
};
