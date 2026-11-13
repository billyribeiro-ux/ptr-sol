#!/usr/bin/env node
'use strict';

// Explicit, local-database provisioning of the account and room roles shown in
// the captured portal. No email, payment, or external provider calls are made.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { DATA_DIR, PUBLIC_ORIGIN } = require('../src/config');
const db = require('../src/db/database');
const { createRoomIdentifiers } = require('../src/services/room-ids');

const credentialPath = path.join(DATA_DIR, 'provisioned-accounts.json');
const definitions = {
  businessOwner: {
    name: 'Business Owner',
    email: 'business-owner@example.test',
    role: 'account-owner',
  },
  enterpriseOwner: {
    name: 'Enterprise Owner',
    email: 'enterprise-owner@example.test',
    role: 'account-owner',
  },
  delegatedAdmin: {
    name: 'Delegated Admin',
    email: 'delegated-admin@example.test',
    role: 'delegated-admin',
  },
  roomAdmin: { name: 'Room Admin', email: 'room-admin@example.test', role: 'room-admin' },
  presenter: { name: 'Presenter', email: 'presenter@example.test', role: 'presenter' },
  participant: { name: 'Participant', email: 'participant@example.test', role: 'participant' },
};

function configuredOrigin() {
  let origin;
  try {
    origin = new URL(PUBLIC_ORIGIN);
  } catch {
    throw new Error('PUBLIC_ORIGIN must be an HTTP(S) URL.');
  }
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password) {
    throw new Error('PUBLIC_ORIGIN must be an HTTP(S) URL without credentials.');
  }
  return origin.origin;
}

function newCredentialSet(origin) {
  const businessRoom = createRoomIdentifiers();
  let enterpriseRoom;
  do {
    enterpriseRoom = createRoomIdentifiers();
  } while (businessRoom.id === enterpriseRoom.id || businessRoom.uuid === enterpriseRoom.uuid);

  const accounts = {};
  for (const [key, definition] of Object.entries(definitions)) {
    accounts[key] = {
      ...definition,
      id: crypto.randomUUID(),
      password: crypto.randomBytes(24).toString('base64url'),
      loginURL: `${origin}/ptrApp#/page/welcome`,
    };
  }
  for (const key of ['roomAdmin', 'presenter', 'participant']) {
    accounts[key].loginURL = `${origin}/u/${enterpriseRoom.id}`;
  }
  return {
    version: 1,
    notice:
      'Local database accounts. Enterprise plan assignment is a local entitlement, not proof of payment or a provider subscription.',
    createdAt: new Date().toISOString(),
    origin,
    rooms: { business: businessRoom, enterprise: enterpriseRoom },
    accounts,
  };
}

const readOnlyEndpoints = [
  'list',
  'users',
  'userstats',
  'chatlogs',
  'alertlogs',
  'deletedlogs',
  'archivedlogs',
  'recordings',
];
function addIntegrationCredentials(credentials) {
  for (const [name, room] of Object.entries(credentials.rooms)) {
    const existing = db
      .prepare('SELECT settings FROM sessions WHERE uuid=? AND id=?')
      .get(room.uuid, room.id);
    let settings = {};
    try {
      settings = JSON.parse(existing?.settings || '{}');
    } catch {
      throw new Error(`The ${name} room settings are invalid; no secret was changed.`);
    }
    if (settings.ssoJWTSecret)
      throw new Error(`The ${name} room already has an SSO secret; it was not overwritten.`);
  }
  credentials.integrations = {};
  for (const [name, room] of Object.entries(credentials.rooms)) {
    credentials.integrations[name] = {
      roomID: room.id,
      roomUUID: room.uuid,
      apiKey: crypto.randomUUID(),
      apiSecret: `prt_${crypto.randomBytes(32).toString('hex')}`,
      apiEndpoints: readOnlyEndpoints,
      ssoJWTSecret: crypto.randomBytes(32).toString('base64url'),
    };
  }
}

function writeCredentials(credentials) {
  const temporary = `${credentialPath}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(credentials, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    fs.renameSync(temporary, credentialPath);
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function ensureIntegration(name, integration, room, owner, newlyCreated) {
  if (
    !integration ||
    integration.roomID !== room.id ||
    integration.roomUUID !== room.uuid ||
    typeof integration.apiKey !== 'string' ||
    !/^prt_[a-f0-9]{64}$/.test(integration.apiSecret || '') ||
    typeof integration.ssoJWTSecret !== 'string' ||
    integration.ssoJWTSecret.length < 32 ||
    JSON.stringify(integration.apiEndpoints) !== JSON.stringify(readOnlyEndpoints)
  ) {
    throw new Error(`The ${name} integration credentials are invalid; nothing was overwritten.`);
  }
  const existing = db.prepare('SELECT * FROM api_keys WHERE id=?').get(integration.apiKey);
  if (existing) {
    if (
      existing.owner_id !== owner.id ||
      existing.api_key !== integration.apiSecret ||
      existing.revoked_at ||
      JSON.stringify(JSON.parse(existing.sessions || '[]')) !== JSON.stringify([room.uuid]) ||
      JSON.stringify(JSON.parse(existing.endpoints || '[]')) !== JSON.stringify(readOnlyEndpoints)
    ) {
      throw new Error(`The ${name} API key was changed or revoked; it was not restored.`);
    }
  } else if (newlyCreated) {
    db.prepare(
      'INSERT INTO api_keys(id,owner_id,name,api_key,sessions,endpoints) VALUES(?,?,?,?,?,?)',
    ).run(
      integration.apiKey,
      owner.id,
      `Provisioned ${name} read-only API`,
      integration.apiSecret,
      JSON.stringify([room.uuid]),
      JSON.stringify(readOnlyEndpoints),
    );
  } else throw new Error(`The ${name} API key was removed; it was not restored.`);
  const current = db.prepare('SELECT settings FROM sessions WHERE uuid=?').get(room.uuid);
  let settings;
  try {
    settings = JSON.parse(current.settings || '{}');
  } catch {
    throw new Error(`The ${name} room settings are invalid.`);
  }
  if (newlyCreated && !settings.ssoJWTSecret) {
    settings.ssoJWTSecret = integration.ssoJWTSecret;
    db.prepare('UPDATE sessions SET settings=? WHERE uuid=?').run(
      JSON.stringify(settings),
      room.uuid,
    );
  } else if (settings.ssoJWTSecret !== integration.ssoJWTSecret) {
    throw new Error(`The ${name} SSO secret was changed or removed; it was not restored.`);
  }
}

function loadExisting() {
  let stat;
  try {
    stat = fs.lstatSync(credentialPath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) {
    throw new Error('The credential path must be a regular private file.');
  }
  if (
    process.platform !== 'win32' &&
    ((stat.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid()))
  ) {
    throw new Error(
      'The credential file must be owned by the current user and accessible only by that user.',
    );
  }
  let credentials;
  try {
    credentials = JSON.parse(fs.readFileSync(credentialPath, 'utf8'));
  } catch {
    throw new Error('The existing credential file is invalid; it was not overwritten.');
  }
  if (
    credentials?.version !== 1 ||
    !credentials.rooms?.business ||
    !credentials.rooms?.enterprise ||
    !credentials.accounts
  ) {
    throw new Error(
      'The existing credential file has an unrecognized format; it was not overwritten.',
    );
  }
  for (const [key, definition] of Object.entries(definitions)) {
    const item = credentials.accounts[key];
    if (
      !item ||
      item.email !== definition.email ||
      item.role !== definition.role ||
      typeof item.id !== 'string' ||
      typeof item.password !== 'string' ||
      item.password.length < 16
    ) {
      throw new Error(
        `The existing credential file has an invalid ${key} entry; it was not overwritten.`,
      );
    }
  }
  for (const room of Object.values(credentials.rooms)) {
    if (!/^[a-f0-9]{24}$/.test(room?.id || '') || !/^\d{6}$/.test(room?.uuid || '')) {
      throw new Error('The existing credential file contains invalid room identifiers.');
    }
  }
  return credentials;
}

function assertAccountAvailable(account, table) {
  const user = db
    .prepare('SELECT id FROM users WHERE email=? OR id=?')
    .get(account.email, account.id);
  const admin = db
    .prepare('SELECT id FROM admin_users WHERE email=? OR id=?')
    .get(account.email, account.id);
  if (
    (user && (table !== 'users' || user.id !== account.id)) ||
    (admin && (table !== 'admin_users' || admin.id !== account.id))
  ) {
    throw new Error(
      `The ${account.role} email or identifier is already in use; existing accounts were not changed.`,
    );
  }
}

function ensureOwner(account, planId) {
  assertAccountAvailable(account, 'users');
  let existing = db.prepare('SELECT * FROM users WHERE id=?').get(account.id);
  if (existing) {
    if (
      existing.email !== account.email ||
      existing.is_admin ||
      !bcrypt.compareSync(account.password, existing.password_hash)
    ) {
      throw new Error(
        `The ${account.role} account has changed; existing credentials were not overwritten.`,
      );
    }
  } else {
    db.prepare(
      'INSERT INTO users (id,name,email,password_hash,role,is_admin) VALUES (?,?,?,?,?,0)',
    ).run(
      account.id,
      account.name,
      account.email,
      bcrypt.hashSync(account.password, 12),
      'presenter',
    );
    existing = db.prepare('SELECT * FROM users WHERE id=?').get(account.id);
  }
  if (!db.prepare('SELECT 1 FROM subscriptions WHERE user_id=?').get(existing.id)) {
    db.prepare('INSERT INTO subscriptions (id,user_id,plan_id,status) VALUES (?,?,?,?)').run(
      crypto.randomUUID(),
      existing.id,
      planId,
      'active',
    );
  }
}

function ensureRoom(room, owner, name) {
  const existing = db
    .prepare('SELECT * FROM sessions WHERE uuid=? OR id=?')
    .get(room.uuid, room.id);
  if (existing) {
    if (existing.id !== room.id || existing.uuid !== room.uuid || existing.owner_id !== owner.id) {
      throw new Error(
        'A provisioned room identifier is already in use; existing rooms were not changed.',
      );
    }
    return;
  }
  db.prepare(
    'INSERT INTO sessions (id,uuid,owner_id,name,tagline,is_main_room,is_open,settings) VALUES (?,?,?,?,?,1,1,?)',
  ).run(
    room.id,
    room.uuid,
    owner.id,
    name,
    'Live Trading Room',
    JSON.stringify({ authMode: 'unamePW' }),
  );
}

function ensureDelegate(account, owner) {
  assertAccountAvailable(account, 'admin_users');
  const existing = db.prepare('SELECT * FROM admin_users WHERE id=?').get(account.id);
  if (existing) {
    let permissions;
    try {
      permissions = JSON.parse(existing.perms || '{}');
    } catch {
      permissions = { readOnly: true };
    }
    if (
      existing.email !== account.email ||
      existing.owner_id !== owner.id ||
      permissions.readOnly === true ||
      permissions.manageSessions === false ||
      permissions.manageRooms === false ||
      !bcrypt.compareSync(account.password, existing.password_hash)
    ) {
      throw new Error(
        'The delegated admin has changed; existing credentials were not overwritten.',
      );
    }
    return;
  }
  db.prepare(
    'INSERT INTO admin_users (id,owner_id,name,email,password_hash,perms) VALUES (?,?,?,?,?,?)',
  ).run(
    account.id,
    owner.id,
    account.name,
    account.email,
    bcrypt.hashSync(account.password, 12),
    '{}',
  );
}

function ensureMember(account, room, role, nonPresenter) {
  const existing = db
    .prepare('SELECT * FROM memberships WHERE id=? OR (room_id=? AND email=?)')
    .get(account.id, room.uuid, account.email);
  if (existing) {
    let flags;
    try {
      flags = JSON.parse(existing.flags || '{}');
    } catch {
      flags = {};
    }
    if (
      existing.id !== account.id ||
      existing.room_id !== room.uuid ||
      existing.email !== account.email ||
      String(existing.role) !== role ||
      Boolean(flags.nonPresenter) !== nonPresenter ||
      (nonPresenter &&
        (flags.hasMic !== false || flags.hasCam !== false || flags.hasScreen !== false)) ||
      !['approved', 'active', 'accepted'].includes(existing.status) ||
      !existing.password_hash ||
      !bcrypt.compareSync(account.password, existing.password_hash)
    ) {
      throw new Error(
        `The ${account.role} membership has changed; existing credentials were not overwritten.`,
      );
    }
    return;
  }
  db.prepare(
    'INSERT INTO memberships (id,room_id,email,name,password_hash,role,status,flags) VALUES (?,?,?,?,?,?,?,?)',
  ).run(
    account.id,
    room.uuid,
    account.email,
    account.name,
    bcrypt.hashSync(account.password, 12),
    role,
    'approved',
    JSON.stringify(
      nonPresenter
        ? { nonPresenter: true, hasMic: false, hasCam: false, hasScreen: false }
        : { nonPresenter: false },
    ),
  );
}

function provision() {
  const origin = configuredOrigin();
  let credentials = loadExisting();
  if (!credentials) {
    for (const definition of Object.values(definitions)) {
      if (
        db.prepare('SELECT 1 FROM users WHERE email=?').get(definition.email) ||
        db.prepare('SELECT 1 FROM admin_users WHERE email=?').get(definition.email) ||
        db.prepare('SELECT 1 FROM memberships WHERE email=?').get(definition.email)
      ) {
        throw new Error(
          'A provisioned email is already in use; existing accounts and files were not changed.',
        );
      }
    }
    credentials = newCredentialSet(origin);
    // The file is created first so a crash can be recovered by rerunning the
    // transaction. Exclusive creation prevents symlink and overwrite races.
    fs.writeFileSync(credentialPath, JSON.stringify(credentials, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
  }
  const newIntegrations = !credentials.integrations;
  if (newIntegrations) addIntegrationCredentials(credentials);
  const { accounts, rooms } = credentials;
  db.exec('BEGIN IMMEDIATE');
  try {
    ensureOwner(accounts.businessOwner, 'starter');
    ensureOwner(accounts.enterpriseOwner, 'enterprise');
    ensureRoom(rooms.business, accounts.businessOwner, 'Business Owner Room');
    ensureRoom(rooms.enterprise, accounts.enterpriseOwner, 'Enterprise Room');
    ensureDelegate(accounts.delegatedAdmin, accounts.enterpriseOwner);
    ensureMember(accounts.roomAdmin, rooms.enterprise, '1', true);
    ensureMember(accounts.presenter, rooms.enterprise, '1', false);
    ensureMember(accounts.participant, rooms.enterprise, '2', false);
    ensureIntegration(
      'business',
      credentials.integrations.business,
      rooms.business,
      accounts.businessOwner,
      newIntegrations,
    );
    ensureIntegration(
      'enterprise',
      credentials.integrations.enterprise,
      rooms.enterprise,
      accounts.enterpriseOwner,
      newIntegrations,
    );
    if (newIntegrations) writeCredentials(credentials);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  console.log(`Provisioned or verified local accounts. Private credentials: ${credentialPath}`);
}

try {
  provision();
} catch (error) {
  console.error(`Provisioning failed: ${error.message}`);
  process.exitCode = 1;
}
