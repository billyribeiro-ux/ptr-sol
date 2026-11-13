const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  jwt = require('jsonwebtoken');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ptr-sso-'));
const express = require('express'),
  db = require('../src/db/database');
const app = express();
app.use(express.json());
app.use('/users/v1', require('../src/routes/users'));
test('verified external room JWT handoff and scoped cookie authentication', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  async function post(route, body, token, cookie) {
    const r = await fetch(base + route, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    });
    return { status: r.status, data: await r.json(), cookie: r.headers.get('set-cookie') };
  }
  const owner = (
    await post('/users/v1/signup', {
      name: 'Owner',
      email: 'owner@example.test',
      pw: 'password123',
    })
  ).data;
  const room = db.prepare('SELECT * FROM sessions WHERE uuid=?').get(owner.roomUUID);
  const secret = 'test-only-room-secret-with-at-least-32-characters';
  for (const [fieldName, fieldVal] of [
    ['authMode', 'jwt'],
    ['ssoJWTSecret', secret],
    ['tokenExpiresIn', '5m'],
  ])
    assert.equal(
      (
        await post(
          '/users/v1/sessions',
          { cmd: 'saveSessField', sessionID: room.id, fieldName, fieldVal },
          owner.token,
        )
      ).data.success,
      true,
    );
  for (const fieldVal of ['1m', '31d', '12x', '0h'])
    assert.equal(
      (
        await post(
          '/users/v1/sessions',
          { cmd: 'saveSessField', sessionID: room.id, fieldName: 'tokenExpiresIn', fieldVal },
          owner.token,
        )
      ).status,
      400,
    );
  const external = jwt.sign(
    { email: 'attendee@example.test', name: 'Attendee', roomID: room.uuid, role: 'admin' },
    secret,
    { algorithm: 'HS256', expiresIn: '1h' },
  );
  async function handoff(value, auth) {
    const qs = new URLSearchParams({ sessID: room.id, jwt: value, sl: '1' });
    return fetch(base + '/users/v1/ssoJWT?' + qs, {
      headers: auth ? { authorization: `Bearer ${auth}` } : {},
      redirect: 'manual',
    });
  }
  const good = await handoff(external);
  assert.equal(good.status, 302);
  assert.equal(good.headers.get('location'), `/session?id=${room.uuid}`);
  const cookie = good.headers.get('set-cookie').split(';')[0];
  assert.ok(cookie.startsWith(`prt_room_${room.uuid}=`));
  const accepted = await post(
    '/users/v1/users.json',
    { cmd: 'loginChat', roomID: room.id, token: 'stale-token' },
    null,
    cookie,
  );
  assert.equal(accepted.data.success, true);
  assert.equal(accepted.data.email, 'attendee@example.test');
  assert.equal(accepted.data.isPresenter, false);
  assert.equal(
    (
      await post(
        '/users/v1/sessions',
        { cmd: 'saveSessField', sessionID: room.id, fieldName: 'name', fieldVal: 'Bad' },
        null,
        cookie,
      )
    ).status,
    403,
  );
  const tokenPayload = jwt.decode(accepted.data.token);
  assert.equal(tokenPayload.exp - tokenPayload.iat, 300);
  const siteLogin = await post('/users/v1/login', {
    email: 'owner@example.test',
    pw: 'password123',
  });
  const siteCookie = siteLogin.cookie.split(';')[0];
  const ownerRoom = await post(
    '/users/v1/users.json',
    { cmd: 'loginChat', roomID: room.id },
    null,
    siteCookie,
  );
  assert.equal(ownerRoom.data.success, true);
  assert.equal(ownerRoom.data.email, 'owner@example.test');
  const tampered = jwt.sign(
    { email: 'attendee@example.test', roomID: room.uuid },
    'wrong-secret-with-at-least-32-characters',
    { expiresIn: '1h' },
  );
  const expired = jwt.sign({ email: 'attendee@example.test', roomID: room.uuid }, secret, {
    expiresIn: '-1s',
  });
  const otherRoom = jwt.sign({ email: 'attendee@example.test', roomID: 'wrong-room' }, secret, {
    expiresIn: '1h',
  });
  const unsigned = Buffer.from(
    JSON.stringify({ email: 'attendee@example.test', role: 'admin' }),
  ).toString('base64url');
  for (const invalid of [tampered, expired, otherRoom, unsigned]) {
    const denied = await handoff(invalid, owner.token);
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get('set-cookie'), null);
  }
  for (const badBody of [
    { externalJWT: tampered },
    { jwt: tampered },
    { token: tampered, siteToken: owner.token },
    { __al: unsigned },
  ]) {
    const denied = await post(
      '/users/v1/users.json',
      { cmd: 'loginChat', roomID: room.id, email: 'attendee@example.test', ...badBody },
      null,
      siteCookie,
    );
    assert.equal(denied.data.success, false);
  }

  assert.equal(
    (
      await post(
        '/users/v1/sessions',
        { cmd: 'saveSessField', sessionID: room.id, fieldName: 'authMode', fieldVal: 'sso' },
        owner.token,
      )
    ).data.success,
    true,
  );
  const legacyHandoff = await handoff(external);
  assert.equal(legacyHandoff.status, 302);
  const legacyCookie = legacyHandoff.headers.get('set-cookie').split(';')[0];
  const legacyJoin = await post(
    '/users/v1/users.json',
    { cmd: 'loginChat', roomID: room.id },
    null,
    legacyCookie,
  );
  assert.equal(legacyJoin.data.success, true);
  assert.equal(legacyJoin.data.email, 'attendee@example.test');
  const directJoin = await post('/users/v1/users.json', {
    cmd: 'loginChat',
    roomID: room.id,
    externalJWT: external,
  });
  assert.equal(directJoin.data.success, true);
  for (const invalid of [tampered, expired, otherRoom, unsigned]) {
    assert.equal((await handoff(invalid, owner.token)).status, 403);
    assert.equal(
      (
        await post('/users/v1/users.json', {
          cmd: 'loginChat',
          roomID: room.id,
          externalJWT: invalid,
        })
      ).data.success,
      false,
    );
  }

  const noTrust = await post('/users/v1/users.json', {
    cmd: 'loginChat',
    roomID: room.id,
    email: 'attendee@example.test',
    __al: unsigned,
  });
  assert.equal(noTrust.data.success, false);

  const other = (
    await post('/users/v1/signup', {
      name: 'Second Owner',
      email: 'other@example.test',
      pw: 'password123',
    })
  ).data;
  const otherLogin = await post('/users/v1/login', {
    email: 'other@example.test',
    pw: 'password123',
  });
  const otherCookie = otherLogin.cookie.split(';')[0];
  const ownerWithStaleToken = await post(
    '/users/v1/users.json',
    {
      cmd: 'loginChat',
      roomID: other.roomUUID,
      email: 'unrelated@example.test',
      token: 'stale-token',
    },
    null,
    otherCookie,
  );
  assert.equal(ownerWithStaleToken.data.success, true);
  assert.equal(ownerWithStaleToken.data.email, 'other@example.test');
  assert.equal(ownerWithStaleToken.data.isPresenter, true);
  const localUser = db
    .prepare('SELECT id,token_version FROM users WHERE email=?')
    .get('other@example.test');
  const staleLocal = jwt.sign(
    { sub: localUser.id, kind: 'account', version: localUser.token_version },
    require('../src/config').JWT_SECRET,
    { issuer: 'prt-backend', audience: 'prt-client', algorithm: 'HS256', expiresIn: '-1s' },
  );
  const expiredWithCookie = await post(
    '/users/v1/users.json',
    { cmd: 'loginChat', roomID: other.roomUUID, siteToken: staleLocal },
    null,
    otherCookie,
  );
  assert.equal(expiredWithCookie.data.success, true);
  assert.equal(expiredWithCookie.data.email, 'other@example.test');

  const raw = await fetch(base + `/users/v1/ssoJWT?sessID=${room.id}`, {
    headers: { authorization: `Bearer ${owner.token}` },
  });
  const rawBody = await raw.json();
  assert.equal(rawBody.success, true);
  assert.equal(rawBody.sessID, room.uuid);
  assert.ok(rawBody.jwt);
});
