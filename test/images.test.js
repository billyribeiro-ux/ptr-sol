const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ptr-images-'));
delete process.env.GIPHY_API_KEY;
const express = require('express'),
  db = require('../src/db/database');
const app = express();
app.use(express.json());
app.use('/users/v1', require('../src/routes/users'));
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aE0AAAAASUVORK5CYII=',
  'base64',
);
test('image uploads are validated, room-scoped and served inline; GIF search is optional', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`,
    realFetch = global.fetch;
  async function post(route, body, token, cookie) {
    const r = await realFetch(base + route, {
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
  async function imageUpload(bytes, type, room, credential, filename = 'image.png') {
    const form = new FormData();
    if (room) form.append('roomID', room);
    form.append('file', new Blob([bytes], { type }), filename);
    const r = await realFetch(base + '/users/v1/images/upload', {
      method: 'POST',
      headers: credential || {},
      body: form,
    });
    return { status: r.status, data: await r.json() };
  }
  const uploadDir = require('../src/config').UPLOAD_DIR;
  const before = fs.readdirSync(uploadDir).sort();
  assert.equal((await imageUpload(png, 'image/png', '123456', null)).status, 401);
  const anonymousForm = new FormData();
  anonymousForm.append('roomID', '123456');
  anonymousForm.append('file', new Blob([png], { type: 'image/png' }), 'anonymous.png');
  assert.equal(
    (await realFetch(base + '/users/v1/upload', { method: 'POST', body: anonymousForm })).status,
    401,
  );
  const forged = await imageUpload(png, 'image/png', '123456', {
    cookie: 'prt_room_123456=forged',
  });
  assert.equal(forged.status, 401);
  assert.deepEqual(fs.readdirSync(uploadDir).sort(), before);
  const owner = await post('/users/v1/signup', {
    name: 'Owner',
    email: 'owner@example.test',
    pw: 'password123',
  });
  const other = await post('/users/v1/signup', {
    name: 'Other',
    email: 'other@example.test',
    pw: 'password123',
  });
  assert.ok(owner.cookie?.startsWith('prt_session='));
  const ownerCookie = owner.cookie.split(';')[0],
    room = owner.data.roomUUID;
  const roomId = db.prepare('SELECT id FROM sessions WHERE uuid=?').get(room).id;
  const badgeImage = await imageUpload(png, 'image/png', null, { cookie: ownerCookie });
  assert.equal(badgeImage.data.success, true);
  assert.match(badgeImage.data.data.link, /^\/users\/v1\/images\//);
  const image = await realFetch(base + badgeImage.data.data.link, {
    headers: { cookie: ownerCookie },
  });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.equal(image.headers.get('content-disposition'), 'inline');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
  assert.equal((await realFetch(base + badgeImage.data.data.link)).status, 403);
  assert.equal(
    (
      await realFetch(base + badgeImage.data.data.link, {
        headers: { authorization: `Bearer ${other.data.token}` },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await imageUpload(
        Buffer.from('<svg onload=alert(1)>'),
        'image/svg+xml',
        room,
        { cookie: ownerCookie },
        'x.svg',
      )
    ).status,
    400,
  );
  assert.equal(
    (await imageUpload(Buffer.from('not an image'), 'image/png', room, { cookie: ownerCookie }))
      .status,
    400,
  );
  assert.equal((await imageUpload(png, 'image/jpeg', room, { cookie: ownerCookie })).status, 400);
  assert.equal(
    (await imageUpload(png, 'image/png', other.data.roomUUID, { cookie: ownerCookie })).status,
    403,
  );
  const guest = await post('/users/v1/users.json', {
    cmd: 'loginChat',
    roomID: room,
    email: 'guest@example.test',
    name: 'Guest',
  });
  assert.equal(guest.data.success, true);
  const guestCookie = guest.cookie.split(';')[0];
  assert.equal((await imageUpload(png, 'image/png', roomId, { cookie: guestCookie })).status, 403);
  await post(
    '/users/v1/sessions',
    { cmd: 'saveSessField', sessionID: roomId, fieldName: 'userUploads', fieldVal: true },
    owner.data.token,
  );
  const uploaded = await imageUpload(png, 'image/png', roomId, { cookie: guestCookie });
  assert.equal(uploaded.data.success, true);
  assert.equal(
    (
      await imageUpload(png, 'image/png', roomId, {
        cookie: guestCookie,
        authorization: 'Bearer stale-token',
      })
    ).data.success,
    true,
  );
  assert.equal(
    (
      await imageUpload(png, 'image/png', roomId, {
        cookie: guestCookie,
        authorization: `Bearer ${other.data.token}`,
      })
    ).data.success,
    true,
  );
  assert.equal(
    (await realFetch(base + uploaded.data.data.link, { headers: { cookie: guestCookie } })).status,
    200,
  );
  assert.equal(
    (
      await realFetch(base + uploaded.data.data.link, {
        headers: { cookie: guestCookie, authorization: 'Bearer stale-token' },
      })
    ).status,
    200,
  );
  const noProvider = await realFetch(base + `/users/v1/images/giphy?roomID=${room}&q=test`, {
    headers: { cookie: guestCookie },
  });
  assert.equal(noProvider.status, 503);
  process.env.GIPHY_API_KEY = 'local-test-key';
  let queried = false;
  global.fetch = async (url, options) => {
    const u = new URL(url);
    if (u.hostname === 'api.giphy.com') {
      queried = true;
      assert.equal(u.searchParams.get('q'), 'hello world');
      return new Response(
        JSON.stringify({
          data: [
            {
              id: 'ok',
              images: {
                fixed_width: { url: 'https://media0.giphy.com/test.gif' },
                downsized_medium: { url: 'https://media.giphy.com/test.gif' },
              },
            },
            {
              id: 'bad',
              images: {
                fixed_width: { url: 'https://evil.example/test' },
                downsized_medium: { url: 'https://media.giphy.com/test.gif' },
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return realFetch(url, options);
  };
  try {
    const r = await realFetch(base + `/users/v1/images/giphy?roomID=${room}&q=hello%20world`, {
      headers: { cookie: guestCookie },
    });
    const result = await r.json();
    assert.equal(r.status, 200);
    assert.equal(queried, true);
    assert.equal(result.data.length, 1);
    assert.equal(result.data[0].images.fixed_width.url, 'https://media0.giphy.com/test.gif');
  } finally {
    global.fetch = realFetch;
    delete process.env.GIPHY_API_KEY;
  }
});
