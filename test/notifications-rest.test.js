const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ptr-notify-rest-'));
const express = require('express'),
  db = require('../src/db/database'),
  provider = require('../src/services/notifications');
const app = express();
app.use(express.json());
app.use('/users/v1', require('../src/routes/users'));
test('test notifications are scoped, report unavailable providers, and respect provider results', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  async function post(path, body, token) {
    const r = await fetch(base + path, {
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
  db.prepare(
    'INSERT INTO memberships (id,room_id,email,name,role,status,flags) VALUES (?,?,?,?,?,?,?)',
  ).run(
    'member',
    room,
    'member@example.test',
    'Member',
    '2',
    'approved',
    JSON.stringify({ fcmTokens: ['dummy-token-value'] }),
  );
  const old = provider.sendPush;
  let calls = [];
  try {
    provider.sendPush = async (input) => {
      calls.push(input);
      return { accepted: 1, skipped: 0, failed: 0 };
    };
    const payload = {
      cmd: 'sendTestFCM',
      sessionID: internal,
      xrefID: 'member',
      msg: 'Test notification',
    };
    assert.equal((await post('/users/v1/sessions', payload, other.token)).status, 403);
    assert.equal(calls.length, 0);
    assert.equal(
      (await post('/users/v1/sessions', { ...payload, msg: '' }, owner.token)).status,
      400,
    );
    assert.equal(calls.length, 0);
    const sent = await post('/users/v1/sessions', payload, owner.token);
    assert.equal(sent.data.success, true);
    assert.equal(calls[0].roomID, room);
    assert.equal(calls[0].memberID, 'member');
    assert.equal(calls[0].text, 'Test notification');
    assert.equal(
      (await post('/users/v1/sessions', { ...payload, cmd: 'sendTestAlert' }, owner.token)).data
        .success,
      true,
    );
    provider.sendPush = async () => ({ accepted: 0, skipped: 0, recipients: 0 });
    const noTokens = await post('/users/v1/sessions', payload, owner.token);
    assert.equal(noTokens.status, 409);
    assert.match(noTokens.data.message, /No eligible/);
    provider.sendPush = async () => ({ accepted: 0, skipped: 0, disabled: true });
    assert.equal((await post('/users/v1/sessions', payload, owner.token)).status, 409);
    provider.sendPush = async () => {
      throw Error('Push delivery is not configured.');
    };
    assert.equal((await post('/users/v1/sessions', payload, owner.token)).status, 503);
    provider.sendPush = async () => {
      throw Object.assign(Error('Push provider accepted 0 messages; 1 failed.'), {
        delivery: { accepted: 0, failed: 1, unknown: 0, skipped: 0 },
      });
    };
    const failed = await post('/users/v1/sessions', payload, owner.token);
    assert.equal(failed.status, 502);
    assert.equal(failed.data.delivery.failed, 1);
  } finally {
    provider.sendPush = old;
  }
});
