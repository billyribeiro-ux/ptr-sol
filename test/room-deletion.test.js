const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ptr-delete-'));
const express = require('express'),
  db = require('../src/db/database'),
  { UPLOAD_DIR, RECORDINGS_DIR } = require('../src/config');
const app = express();
app.use(express.json());
app.use('/users/v1', require('../src/routes/users'));
require('../src/realtime/sockjs');
test('room deletion rejects active recordings and removes scoped runtime, records and files', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  async function post(route, body, token) {
    const r = await fetch(base + route, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    return { status: r.status, data: await r.json() };
  }
  const owner = (
    await post('/users/v1/signup', {
      name: 'Owner',
      email: 'owner@example.test',
      pw: 'password123',
    })
  ).data;
  const other = (
    await post('/users/v1/signup', {
      name: 'Other',
      email: 'other@example.test',
      pw: 'password123',
    })
  ).data;
  const room = owner.roomUUID,
    internal = db.prepare('SELECT id FROM sessions WHERE uuid=?').get(room).id;
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  const dir = path.join(RECORDINGS_DIR, 'rec-one');
  fs.mkdirSync(dir);
  const recFile = path.join(dir, 'output.mp4');
  fs.writeFileSync(recFile, 'video');
  fs.writeFileSync(path.join(UPLOAD_DIR, 'owned-file'), 'own');
  fs.writeFileSync(path.join(UPLOAD_DIR, 'shared-file'), 'shared');
  const file = db.prepare(
    'INSERT INTO files (id,room_id,uploader_id,uploader_name,original_name,stored_name,mime_type,size_bytes) VALUES (?,?,?,?,?,?,?,?)',
  );
  file.run('file-one', room, 'owner', 'Owner', 'one.txt', 'owned-file', 'text/plain', 3);
  file.run('file-two', room, 'owner', 'Owner', 'two.txt', 'shared-file', 'text/plain', 6);
  file.run(
    'file-shared',
    other.roomUUID,
    'other',
    'Other',
    'shared.txt',
    'shared-file',
    'text/plain',
    6,
  );
  db.prepare('INSERT INTO recordings (id,room_id,title,file_path,status) VALUES (?,?,?,?,?)').run(
    'rec-one',
    room,
    'recording',
    recFile,
    'processing',
  );
  const external = path.join(os.tmpdir(), `ptr-external-${process.pid}-${Date.now()}`);
  fs.writeFileSync(external, 'external');
  t.after(() => fs.rmSync(external, { force: true }));
  db.prepare('INSERT INTO recordings (id,room_id,title,file_path,status) VALUES (?,?,?,?,?)').run(
    'rec-external',
    room,
    'external',
    external,
    'ready',
  );
  fs.symlinkSync(os.tmpdir(), path.join(RECORDINGS_DIR, 'escape-link'));
  db.prepare('INSERT INTO recordings (id,room_id,title,file_path,status) VALUES (?,?,?,?,?)').run(
    'rec-symlink',
    room,
    'linked',
    path.join(RECORDINGS_DIR, 'escape-link', path.basename(external)),
    'ready',
  );

  db.prepare('INSERT INTO messages (id,room_id,user_id,name,text) VALUES (?,?,?,?,?)').run(
    'msg',
    room,
    'u',
    'Guest',
    'message',
  );
  db.prepare('INSERT INTO alerts (id,room_id,user_id,name,text) VALUES (?,?,?,?,?)').run(
    'alert',
    room,
    'u',
    'Guest',
    'alert',
  );
  db.prepare('INSERT INTO audit_events (id,room_id,actor_id,action) VALUES (?,?,?,?)').run(
    'event',
    room,
    'u',
    'room_login',
  );
  db.prepare('INSERT INTO realtime_state (room_id,key,value) VALUES (?,?,?)').run(
    room,
    'note',
    '"value"',
  );
  require('../src/services/notifications');
  db.prepare(
    'INSERT INTO notification_deliveries (id,room_id,alert_id,channel,recipient_hash,status) VALUES (?,?,?,?,?,?)',
  ).run('delivery', room, 'alert', 'push', 'hash', 'accepted');

  assert.equal(
    (await post('/users/v1/sessions', { cmd: 'deleteSession', sessionID: internal }, other.token))
      .status,
    403,
  );
  const busy = await post(
    '/users/v1/sessions',
    { cmd: 'deleteSession', sessionID: internal },
    owner.token,
  );
  assert.equal(busy.status, 409);
  assert.ok(fs.existsSync(recFile));
  assert.ok(db.prepare('SELECT 1 FROM sessions WHERE uuid=?').get(room));
  db.prepare('UPDATE recordings SET status=? WHERE id=?').run('recording', 'rec-one');
  assert.equal(
    (await post('/users/v1/sessions', { cmd: 'deleteSession', sessionID: internal }, owner.token))
      .status,
    409,
  );
  db.prepare('UPDATE recordings SET status=? WHERE id=?').run('ready', 'rec-one');
  const deleted = await post(
    '/users/v1/sessions',
    { cmd: 'deleteSession', sessionID: internal },
    owner.token,
  );
  assert.equal(deleted.data.success, true);
  assert.ok(deleted.data.warnings.includes('A shared upload was retained.'));
  assert.ok(deleted.data.warnings.includes('An external recording was retained.'));
  assert.ok(fs.existsSync(external));
  for (const [table, column] of [
    ['sessions', 'uuid'],
    ['files', 'room_id'],
    ['recordings', 'room_id'],
    ['messages', 'room_id'],
    ['alerts', 'room_id'],
    ['audit_events', 'room_id'],
    ['realtime_state', 'room_id'],
    ['notification_deliveries', 'room_id'],
  ])
    assert.equal(
      db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column}=?`).get(room).n,
      0,
      table,
    );
  assert.equal(fs.existsSync(path.join(UPLOAD_DIR, 'owned-file')), false);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(fs.existsSync(path.join(UPLOAD_DIR, 'shared-file')), true);
  assert.ok(db.prepare('SELECT 1 FROM files WHERE id=?').get('file-shared'));
});

test('a second deletion cannot release the first deletion lock', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  async function post(route, body, token) {
    const r = await fetch(base + route, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    return { status: r.status, data: await r.json() };
  }
  const owner = (
    await post('/users/v1/signup', {
      name: 'Concurrent',
      email: 'concurrent@example.test',
      pw: 'password123',
    })
  ).data;
  const realtime = require('../src/realtime/sockjs'),
    oldDelete = realtime.deleteRoomResources,
    oldCancel = realtime.cancelRoomDeletion;
  let entered, release;
  const started = new Promise((resolve) => (entered = resolve)),
    gate = new Promise((resolve) => (release = resolve));
  let locked = false,
    cancels = 0;
  realtime.deleteRoomResources = async () => {
    if (locked) throw new Error('Already deleting');
    locked = true;
    entered();
    await gate;
  };
  realtime.cancelRoomDeletion = () => {
    locked = false;
    cancels++;
  };
  try {
    const first = post(
      '/users/v1/sessions',
      { cmd: 'deleteSession', sessionID: owner.roomUUID },
      owner.token,
    );
    await started;
    assert.equal(
      (
        await post(
          '/users/v1/sessions',
          { cmd: 'deleteSession', sessionID: owner.roomUUID },
          owner.token,
        )
      ).status,
      409,
    );
    assert.equal(cancels, 0);
    assert.equal(locked, true);
    release();
    assert.equal((await first).data.success, true);
    assert.equal(cancels, 1);
  } finally {
    release();
    realtime.deleteRoomResources = oldDelete;
    realtime.cancelRoomDeletion = oldCancel;
  }
});

test('room deletion waits for an in-flight provider operation', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`,
    realFetch = global.fetch;
  async function post(route, body, token) {
    const r = await realFetch(base + route, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    return { status: r.status, data: await r.json() };
  }
  const owner = (
    await post('/users/v1/signup', {
      name: 'Notifier',
      email: 'notify@example.test',
      pw: 'password123',
    })
  ).data;
  const settings = {
    twillioApiSID: 'AC' + '0'.repeat(32),
    twillioApiToken: 'test-secret',
    twilioPhone: '+15555550100',
    textList: '+15555550101',
  };
  db.prepare('UPDATE sessions SET settings=? WHERE uuid=?').run(
    JSON.stringify(settings),
    owner.roomUUID,
  );
  const notifications = require('../src/services/notifications'),
    oldEnabled = process.env.TWILIO_SMS_ENABLED;
  process.env.TWILIO_SMS_ENABLED = 'true';
  let started, release;
  const entered = new Promise((resolve) => (started = resolve)),
    gate = new Promise((resolve) => (release = resolve));
  global.fetch = async (url, opts) => {
    if (new URL(url).hostname === 'api.twilio.com') {
      started();
      await gate;
      return new Response(JSON.stringify({ sid: 'SM-test', status: 'accepted' }), { status: 200 });
    }
    return realFetch(url, opts);
  };
  try {
    const pending = notifications.sendSMS({
      roomID: owner.roomUUID,
      text: 'Mock notification',
      alertID: 'mock',
    });
    await entered;
    const blocked = await post(
      '/users/v1/sessions',
      { cmd: 'deleteSession', sessionID: owner.roomUUID },
      owner.token,
    );
    assert.equal(blocked.status, 409);
    assert.ok(db.prepare('SELECT 1 FROM sessions WHERE uuid=?').get(owner.roomUUID));
    release();
    assert.equal((await pending).accepted, 1);
    assert.equal(
      (
        await post(
          '/users/v1/sessions',
          { cmd: 'deleteSession', sessionID: owner.roomUUID },
          owner.token,
        )
      ).data.success,
      true,
    );
  } finally {
    release();
    global.fetch = realFetch;
    if (oldEnabled === undefined) delete process.env.TWILIO_SMS_ENABLED;
    else process.env.TWILIO_SMS_ENABLED = oldEnabled;
  }
});

test('room deletion waits for an in-flight mocked recording export', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  async function post(route, body, token) {
    const r = await fetch(base + route, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    return { status: r.status, data: await r.json() };
  }
  const owner = (
    await post('/users/v1/signup', {
      name: 'Exporter',
      email: 'export@example.test',
      pw: 'password123',
    })
  ).data;
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  const file = path.join(RECORDINGS_DIR, 'export-fixture.mp4');
  fs.writeFileSync(file, 'sample recording');
  db.prepare(
    'INSERT INTO recordings (id,room_id,title,file_path,status,mime_type) VALUES (?,?,?,?,?,?)',
  ).run('export-fixture', owner.roomUUID, 'Demo', fs.realpathSync(file), 'ready', 'video/mp4');
  const recording = db.prepare('SELECT * FROM recordings WHERE id=?').get('export-fixture');
  const recordingExports = require('../src/services/recording-exports'),
    notifications = require('../src/services/notifications');
  let started, release;
  const entered = new Promise((resolve) => (started = resolve)),
    gate = new Promise((resolve) => (release = resolve));
  const pending = recordingExports.exportRecording(
    recording,
    {
      saveRecsToS3: true,
      s3KeyID: 'test-key',
      s3KeySecret: 'test-secret',
      s3Bucket: 'example-bucket',
    },
    {
      enabled: true,
      recordingsDir: RECORDINGS_DIR,
      s3Region: 'us-east-1',
      fetch: async () => {
        started();
        await gate;
        return { ok: true, status: 200 };
      },
    },
  );
  try {
    await entered;
    const blocked = await post(
      '/users/v1/sessions',
      { cmd: 'deleteSession', sessionID: owner.roomUUID },
      owner.token,
    );
    assert.equal(blocked.status, 409);
    assert.ok(fs.existsSync(file));
    assert.equal(notifications.pauseRoom(owner.roomUUID), true);
    notifications.resumeRoom(owner.roomUUID);
    release();
    assert.equal((await pending).results[0].status, 'complete');
    assert.equal(
      (
        await post(
          '/users/v1/sessions',
          { cmd: 'deleteSession', sessionID: owner.roomUUID },
          owner.token,
        )
      ).data.success,
      true,
    );
    assert.equal(fs.existsSync(file), false);
  } finally {
    release();
    await pending.catch(() => {});
  }
});

test('room deletion waits for an in-flight mocked room email', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  async function post(route, body, token) {
    const r = await fetch(base + route, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    return { status: r.status, data: await r.json() };
  }
  const owner = (
    await post('/users/v1/signup', {
      name: 'Mailer',
      email: 'mailer@example.test',
      pw: 'password123',
    })
  ).data;
  const mail = require('../src/services/mail'),
    notifications = require('../src/services/notifications'),
    recordingExports = require('../src/services/recording-exports'),
    nodemailer = require('nodemailer');
  const oldHost = process.env.SMTP_HOST,
    oldTransport = nodemailer.createTransport;
  process.env.SMTP_HOST = '127.0.0.1';
  let started, release;
  const entered = new Promise((resolve) => (started = resolve)),
    gate = new Promise((resolve) => (release = resolve));
  nodemailer.createTransport = () => ({
    sendMail: async () => {
      started();
      await gate;
      return { accepted: ['dummy@example.test'] };
    },
  });
  try {
    const pending = mail.sendMail({
      roomID: owner.roomUUID,
      to: 'dummy@example.test',
      subject: 'Mock room email',
      text: 'Test',
    });
    await entered;
    const blocked = await post(
      '/users/v1/sessions',
      { cmd: 'deleteSession', sessionID: owner.roomUUID },
      owner.token,
    );
    assert.equal(blocked.status, 409);
    assert.ok(db.prepare('SELECT 1 FROM sessions WHERE uuid=?').get(owner.roomUUID));
    assert.equal(notifications.pauseRoom(owner.roomUUID), true);
    notifications.resumeRoom(owner.roomUUID);
    assert.equal(recordingExports.pauseRoom(owner.roomUUID), true);
    recordingExports.resumeRoom(owner.roomUUID);
    release();
    await pending;
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE room_id=?').get(owner.roomUUID).n,
      1,
    );
    assert.equal(
      (
        await post(
          '/users/v1/sessions',
          { cmd: 'deleteSession', sessionID: owner.roomUUID },
          owner.token,
        )
      ).data.success,
      true,
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE room_id=?').get(owner.roomUUID).n,
      0,
    );
  } finally {
    release();
    nodemailer.createTransport = oldTransport;
    if (oldHost === undefined) delete process.env.SMTP_HOST;
    else process.env.SMTP_HOST = oldHost;
  }
});
