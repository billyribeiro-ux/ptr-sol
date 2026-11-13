const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { DATA_DIR, UPLOAD_DIR, RECORDINGS_DIR } = require('../config');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

const dbPath = path.join(DATA_DIR, 'prt.sqlite');
const db = new DatabaseSync(dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    is_admin INTEGER NOT NULL DEFAULT 0,
    failed_login_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS plans (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    price_cents INTEGER NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'usd',
    max_rooms INTEGER NOT NULL DEFAULT 1,
    max_participants INTEGER NOT NULL DEFAULT 25,
    recording_enabled INTEGER NOT NULL DEFAULT 0,
    screen_share_enabled INTEGER NOT NULL DEFAULT 1,
    custom_branding INTEGER NOT NULL DEFAULT 0,
    api_access INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL UNIQUE,
    plan_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    trial_ends_at TEXT DEFAULT NULL,
    current_period_end TEXT DEFAULT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (plan_id) REFERENCES plans(id)
  );

  CREATE TABLE IF NOT EXISTS sessions (
    uuid TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    name TEXT NOT NULL,
    tagline TEXT DEFAULT '',
    is_main_room INTEGER NOT NULL DEFAULT 0,
    is_archived_room INTEGER NOT NULL DEFAULT 0,
    is_chat_only_room INTEGER NOT NULL DEFAULT 0,
    is_open INTEGER NOT NULL DEFAULT 1,
    is_locked INTEGER NOT NULL DEFAULT 0,
    chat_mode TEXT NOT NULL DEFAULT 'open',
    alerts_on_bottom INTEGER NOT NULL DEFAULT 0,
    bkg_img TEXT DEFAULT '',
    bkg_img_href TEXT DEFAULT '',
    presenter_settings TEXT DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS marketplaces (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    title TEXT NOT NULL,
    logo_url TEXT DEFAULT '',
    price_cents INTEGER NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'usd',
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS badges (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    name TEXT NOT NULL,
    text TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#FFFFFF',
    bkcolor TEXT NOT NULL DEFAULT '#ffcc00',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS admin_users (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    perms TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    name TEXT NOT NULL,
    api_key TEXT NOT NULL UNIQUE,
    sessions TEXT NOT NULL DEFAULT '[]',
    endpoints TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT 'main',
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    text TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'chat',
    color TEXT DEFAULT '',
    bkcolor TEXT DEFAULT '',
    img_url TEXT DEFAULT '',
    only_p INTEGER NOT NULL DEFAULT 0,
    upvotes INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS alerts (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    text TEXT NOT NULL,
    link TEXT DEFAULT '',
    scheduled_at TEXT DEFAULT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    uploader_id TEXT NOT NULL,
    uploader_name TEXT NOT NULL,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    mime_type TEXT DEFAULT 'application/octet-stream',
    size_bytes INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS recordings (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    title TEXT NOT NULL,
    file_path TEXT DEFAULT '',
    duration_sec INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'ready',
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at TEXT DEFAULT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS banned_users (
    room_id TEXT NOT NULL,
    email TEXT NOT NULL,
    banned_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (room_id, email)
  );
`);

// Additive migrations keep the captured installation's records intact. New
// fields stay in the relational model so a later stack migration is explicit.
function addColumns(table, definitions) {
  const existing = new Set(
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => row.name),
  );
  for (const [name, definition] of Object.entries(definitions)) {
    if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}
addColumns('users', {
  token_version: 'INTEGER NOT NULL DEFAULT 0',
  settings: "TEXT NOT NULL DEFAULT '{}'",
});
addColumns('admin_users', { token_version: 'INTEGER NOT NULL DEFAULT 0' });
addColumns('sessions', {
  id: 'TEXT DEFAULT NULL',
  settings: "TEXT NOT NULL DEFAULT '{}'",
  audio_room_id: 'INTEGER DEFAULT NULL',
  media_room_id: 'INTEGER DEFAULT NULL',
  access_version: 'INTEGER NOT NULL DEFAULT 0',
});
addColumns('messages', {
  email: "TEXT NOT NULL DEFAULT ''",
  metadata: "TEXT NOT NULL DEFAULT '{}'",
  time_ms: 'INTEGER DEFAULT NULL',
});
addColumns('alerts', {
  email: "TEXT NOT NULL DEFAULT ''",
  metadata: "TEXT NOT NULL DEFAULT '{}'",
  time_ms: 'INTEGER DEFAULT NULL',
});
addColumns('files', {
  visibility: 'INTEGER NOT NULL DEFAULT 1',
  category: "TEXT NOT NULL DEFAULT 'files'",
  description: "TEXT NOT NULL DEFAULT ''",
});
addColumns('badges', {
  image_url: "TEXT NOT NULL DEFAULT ''",
  dark_theme: 'INTEGER NOT NULL DEFAULT 0',
  owner_id: 'TEXT DEFAULT NULL',
  metadata: "TEXT NOT NULL DEFAULT '{}'",
  asset_file_id: 'TEXT DEFAULT NULL',
});
// Badges are managed from the account portal without a session ID. Keep the
// original room anchor for compatibility, but bind ownership to the account.
db.exec(`UPDATE badges SET owner_id=(SELECT owner_id FROM sessions WHERE uuid=badges.room_id)
  WHERE owner_id IS NULL AND EXISTS (SELECT 1 FROM sessions WHERE uuid=badges.room_id)`);
const legacyBadgeRows = db
  .prepare(
    `SELECT b.id,b.metadata,b.image_url,b.owner_id,s.settings FROM badges b
  JOIN sessions s ON s.uuid=b.room_id WHERE b.metadata='{}'`,
  )
  .all();
for (const badge of legacyBadgeRows) {
  try {
    const metadata = JSON.parse(badge.settings || '{}').badgeMetadata?.[badge.id];
    if (metadata && typeof metadata === 'object')
      db.prepare('UPDATE badges SET metadata=? WHERE id=?').run(JSON.stringify(metadata), badge.id);
  } catch {
    /* Preserve malformed legacy metadata without aborting migration. */
  }
  try {
    const url = new URL(badge.image_url || '', 'http://local.invalid');
    const match = url.pathname.match(/^\/users\/v1\/images\/([A-Za-z0-9_-]+)$/);
    const asset =
      match &&
      db
        .prepare(
          'SELECT f.id FROM files f JOIN sessions s ON s.uuid=f.room_id WHERE f.id=? AND s.owner_id=?',
        )
        .get(match[1], badge.owner_id);
    if (asset)
      db.prepare('UPDATE badges SET asset_file_id=? WHERE id=? AND asset_file_id IS NULL').run(
        asset.id,
        badge.id,
      );
  } catch {
    /* Leave unrecognized historical image links unchanged. */
  }
}
db.exec('CREATE INDEX IF NOT EXISTS badges_owner ON badges(owner_id)');
addColumns('recordings', {
  mime_type: "TEXT NOT NULL DEFAULT 'video/webm'",
  metadata: "TEXT NOT NULL DEFAULT '{}'",
  size_bytes: 'INTEGER NOT NULL DEFAULT 0',
});
addColumns('api_keys', { revoked_at: 'TEXT DEFAULT NULL', last_used_at: 'TEXT DEFAULT NULL' });
addColumns('marketplaces', { data: "TEXT NOT NULL DEFAULT '{}'" });

db.exec(`
  CREATE TABLE IF NOT EXISTS marketplace_plans (
    id TEXT PRIMARY KEY,
    marketplace_id TEXT NOT NULL REFERENCES marketplaces(id) ON DELETE CASCADE,
    data TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS marketplace_plans_listing ON marketplace_plans(marketplace_id);
  CREATE TABLE IF NOT EXISTS marketplace_assets (
    file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
    marketplace_id TEXT NOT NULL REFERENCES marketplaces(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS marketplace_courses (
    id TEXT PRIMARY KEY,
    marketplace_id TEXT NOT NULL REFERENCES marketplaces(id) ON DELETE CASCADE,
    room_id TEXT NOT NULL REFERENCES sessions(uuid) ON DELETE CASCADE,
    data TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS stripe_accounts (
    room_id TEXT PRIMARY KEY REFERENCES sessions(uuid) ON DELETE CASCADE,
    account_id TEXT NOT NULL UNIQUE
  );
  CREATE TABLE IF NOT EXISTS marketplace_orders (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES sessions(uuid) ON DELETE CASCADE,
    marketplace_id TEXT NOT NULL REFERENCES marketplaces(id) ON DELETE CASCADE,
    plan_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    session_id TEXT UNIQUE,
    email TEXT NOT NULL,
    name TEXT NOT NULL,
    amount INTEGER NOT NULL,
    currency TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS stripe_events (
    event_id TEXT PRIMARY KEY,
    received_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS marketplace_payments (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL REFERENCES marketplace_orders(id) ON DELETE CASCADE,
    room_id TEXT NOT NULL REFERENCES sessions(uuid) ON DELETE CASCADE,
    payment_intent_id TEXT DEFAULT NULL,
    amount INTEGER NOT NULL,
    currency TEXT NOT NULL,
    status TEXT NOT NULL,
    type TEXT NOT NULL,
    stripe_created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS marketplace_payments_room ON marketplace_payments(room_id,stripe_created_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS sessions_internal_id ON sessions(id) WHERE id IS NOT NULL;
  CREATE TABLE IF NOT EXISTS memberships (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES sessions(uuid) ON DELETE CASCADE,
    email TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    password_hash TEXT DEFAULT NULL,
    role TEXT NOT NULL DEFAULT 'r',
    status TEXT NOT NULL DEFAULT 'approved',
    flags TEXT NOT NULL DEFAULT '{}',
    token_version INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(room_id, email)
  );
  CREATE TABLE IF NOT EXISTS password_resets (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    membership_id TEXT REFERENCES memberships(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    used_at TEXT DEFAULT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK ((user_id IS NOT NULL) != (membership_id IS NOT NULL))
  );
  CREATE TABLE IF NOT EXISTS outbox (
    id TEXT PRIMARY KEY,
    recipient TEXT NOT NULL,
    subject TEXT NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    html TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'queued',
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    sent_at TEXT DEFAULT NULL
  );
  CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY,
    actor_id TEXT NOT NULL DEFAULT '',
    room_id TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS message_votes (
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (message_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS messages_room_time ON messages(room_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS alerts_room_time ON alerts(room_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS files_room_time ON files(room_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS recordings_room_time ON recordings(room_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS memberships_email ON memberships(email);
  CREATE INDEX IF NOT EXISTS outbox_status ON outbox(status, created_at);
  CREATE UNIQUE INDEX IF NOT EXISTS admin_users_owner_email ON admin_users(owner_id, email);

  BEGIN IMMEDIATE;
  DROP TRIGGER IF EXISTS cleanup_session_records;
  CREATE TRIGGER cleanup_session_records AFTER DELETE ON sessions BEGIN
    DELETE FROM marketplaces WHERE session_id = OLD.uuid;
    DELETE FROM badges WHERE room_id = OLD.uuid AND owner_id IS NULL;
    DELETE FROM messages WHERE room_id = OLD.uuid;
    DELETE FROM alerts WHERE room_id = OLD.uuid;
    DELETE FROM files WHERE room_id = OLD.uuid AND NOT EXISTS (SELECT 1 FROM badges WHERE badges.owner_id=OLD.owner_id AND badges.asset_file_id=files.id);
    DELETE FROM recordings WHERE room_id = OLD.uuid;
    DELETE FROM banned_users WHERE room_id = OLD.uuid;
  END;
  COMMIT;
`);

addColumns('marketplace_orders', {
  recurring: 'INTEGER NOT NULL DEFAULT 0',
  trial_days: 'INTEGER NOT NULL DEFAULT 0',
  subscription_id: 'TEXT DEFAULT NULL',
  payment_intent_id: 'TEXT DEFAULT NULL',
  member_id: 'TEXT DEFAULT NULL',
  last_event_at: 'INTEGER NOT NULL DEFAULT 0',
  plan_name: "TEXT NOT NULL DEFAULT ''",
});
db.exec(
  'CREATE INDEX IF NOT EXISTS marketplace_orders_subscription ON marketplace_orders(subscription_id)',
);
addColumns('marketplace_payments', {
  refunded_amount: 'INTEGER NOT NULL DEFAULT 0',
  refund_net: 'INTEGER DEFAULT NULL',
  net_amount: 'INTEGER DEFAULT NULL',
  fee_amount: 'INTEGER DEFAULT NULL',
  balance_transaction_id: 'TEXT DEFAULT NULL',
});

const upsertPlan = db.prepare(`
  INSERT INTO plans (id, name, price_cents, currency, max_rooms, max_participants, recording_enabled, screen_share_enabled, custom_branding, api_access)
  VALUES (?, ?, ?, 'usd', ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    price_cents = excluded.price_cents,
    max_rooms = excluded.max_rooms,
    max_participants = excluded.max_participants,
    recording_enabled = excluded.recording_enabled,
    screen_share_enabled = excluded.screen_share_enabled,
    custom_branding = excluded.custom_branding,
    api_access = excluded.api_access
`);

upsertPlan.run('trial', 'Trial', 0, 1, 15, 0, 1, 0, 0);
upsertPlan.run('starter', 'Starter', 4900, 2, 50, 1, 1, 0, 0);
upsertPlan.run('pro', 'Pro', 14900, 10, 250, 1, 1, 1, 1);
upsertPlan.run('enterprise', 'Enterprise', 49900, 100, 2000, 1, 1, 1, 1);

addColumns('outbox', { room_id: 'TEXT DEFAULT NULL' });
db.exec('CREATE INDEX IF NOT EXISTS outbox_room ON outbox(room_id)');
module.exports = db;
