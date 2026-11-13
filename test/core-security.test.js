const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ptr-security-'));
const { createApp, scriptJSON } = require('../src/server');
const db = require('../src/db/database');
const auth = require('../src/middleware/auth');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

test('script values cannot escape inline scripts and the installation rejects known JWT secrets', () => {
  const value = '</script><script>window.bad=true</script>\u2028';
  assert.ok(!scriptJSON(value).includes('<'));
  assert.equal(JSON.parse(scriptJSON(value)), value);
  assert.equal(
    auth.verifyTokenString(jwt.sign({ sub: 'owner' }, 'dev-change-me-in-production')),
    null,
  );
});

test('numeric participant roles, authentication modes, reset rotation and room scope are authoritative', () => {
  db.prepare(
    "INSERT INTO users(id,name,email,password_hash) VALUES('owner','Owner','owner@core.test','x')",
  ).run();
  db.prepare(
    "INSERT INTO sessions(uuid,owner_id,name) VALUES('one','owner','One'),('two','owner','Two')",
  ).run();
  db.prepare(
    'INSERT INTO memberships(id,room_id,email,name,password_hash,role) VALUES(?,?,?,?,?,?)',
  ).run(
    'presenter',
    'one',
    'presenter@core.test',
    'Presenter',
    bcrypt.hashSync('presenter-password', 10),
    '1',
  );
  const identity = auth.authorizeRoom({
    roomID: 'one',
    email: 'presenter@core.test',
    pw: 'presenter-password',
  }).identity;
  assert.equal(identity.perms, 'o');
  const room = db.prepare("SELECT * FROM sessions WHERE uuid='one'").get();
  const token = auth.signRoomToken(identity, room);
  const member = auth.authenticateRequest({ headers: { authorization: 'Bearer ' + token } });
  assert.ok(auth.requireRoomAccess(member, 'one'));
  assert.equal(auth.requireRoomAccess(member, 'two'), null);
  assert.equal(
    auth.authorizeRoom({ roomID: 'one', email: 'presenter@core.test' }).identity,
    undefined,
  );
  const reset = auth.createPasswordReset({ membershipId: 'presenter' });
  assert.ok(auth.consumePasswordReset(reset, 'changed-password'));
  assert.equal(auth.consumePasswordReset(reset, 'another-password'), false);
  assert.equal(auth.authenticateRequest({ headers: { authorization: 'Bearer ' + token } }), null);
  db.prepare('UPDATE sessions SET settings=? WHERE uuid=?').run(
    JSON.stringify({ authMode: 'registrationM' }),
    'one',
  );
  assert.equal(
    auth.authorizeRoom({ roomID: 'one', email: 'uninvited@core.test' }).code,
    'UNAUTHORIZED',
  );
  db.prepare('UPDATE sessions SET settings=? WHERE uuid=?').run(
    JSON.stringify({ authMode: 'webinarRoom', webinarPW: 'room-secret' }),
    'two',
  );
  assert.equal(
    auth.authorizeRoom({ roomID: 'two', email: 'guest@core.test', pw: 'wrong' }).code,
    'UNAUTHORIZED',
  );
  assert.equal(
    auth.authorizeRoom({ roomID: 'two', email: 'guest@core.test', pw: 'room-secret' }).identity
      .perms,
    'r',
  );
  db.prepare("UPDATE sessions SET is_locked=1 WHERE uuid='two'").run();
  assert.equal(
    auth.authorizeRoom({ roomID: 'two', email: 'other@core.test', pw: 'room-secret' }).code,
    'ROOM_LOCKED',
  );
});

test('HTML rendering escapes query input and state-changing requests reject foreign origins', async () => {
  const server = http.createServer(createApp());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const html = await (
      await fetch(
        base + '/session?id=' + encodeURIComponent('</script><script>injected()</script>'),
      )
    ).text();
    assert.ok(!html.includes('<script>injected()</script>'));
    assert.ok(html.includes('\\u003c/script\\u003e'));
    const denied = await fetch(base + '/users/v1/signup', {
      method: 'POST',
      headers: { Origin: 'https://foreign.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Intruder',
        email: 'intruder@core.test',
        pw: 'long-enough-password',
      }),
    });
    assert.equal(denied.status, 403);
    assert.equal(
      db.prepare("SELECT id FROM users WHERE email='intruder@core.test'").get(),
      undefined,
    );
    assert.equal(
      (
        await fetch(base + '/janus', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{"janus":"create"}',
        })
      ).status,
      401,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

test('room login attempts are bounded and legacy logout clears room cookies only', async () => {
  const server = http.createServer(createApp());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    for (let i = 0; i < 30; i++)
      assert.notEqual(
        (
          await fetch(base + '/users/v1/users.json', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cmd: 'loginChat', roomID: 'missing' }),
          })
        ).status,
        429,
      );
    const limited = await fetch(base + '/users/v1/users.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: 'loginChat', roomID: 'missing' }),
    });
    assert.equal(limited.status, 429);
    assert.ok(limited.headers.get('retry-after'));
    const logout = await fetch(base + '/logout', {
      headers: { cookie: 'prt_session=account; prt_room_one=room; unrelated=value' },
    });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get('set-cookie'), /prt_room_one=;/);
    assert.ok(!logout.headers.get('set-cookie').includes('prt_session'));
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
