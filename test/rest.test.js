const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ptr-rest-'));
const express = require('express');
const db = require('../src/db/database');
const { createPasswordReset } = require('../src/middleware/auth');
const app = express();
app.use(express.json());
app.use('/users/v1', require('../src/routes/users'));
app.use(require('../src/routes/marketplace'));

test('account and room access, reset tokens and API restrictions', async (t) => {
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

  const disposableAccount = (
    await post('/users/v1/signup', {
      name: 'Logout',
      email: 'logout@example.test',
      pw: 'password1',
    })
  ).data;
  assert.equal(
    (
      await post('/users/v1/users.json', {
        cmd: 'logout',
        email: 'logout@example.test',
        token: disposableAccount.token,
      })
    ).data.success,
    true,
  );
  assert.equal(
    (
      await post('/users/v1/login_tok', {
        email: 'logout@example.test',
        token: disposableAccount.token,
      })
    ).data.success,
    false,
  );
  const a = (
    await post('/users/v1/signup', { name: 'Alice', email: 'alice@example.test', pw: 'password1' })
  ).data;
  const b = (
    await post('/users/v1/signup', { name: 'Bob', email: 'bob@example.test', pw: 'password2' })
  ).data;
  assert.ok(a.token && b.token && a.roomUUID && b.roomUUID);
  assert.match(a.roomUUID, /^\d{6}$/);
  const internalRoom = db.prepare('SELECT id FROM sessions WHERE uuid=?').get(a.roomUUID).id;
  assert.match(internalRoom, /^[0-9a-f]{24}$/);
  assert.notEqual(internalRoom, a.roomUUID);
  const byInternal = (
    await post('/users/v1/sessions', { cmd: 'sessionDetails', sessionID: internalRoom }, a.token)
  ).data.session;
  assert.equal(byInternal._id, internalRoom);
  assert.equal(byInternal.uuid, a.roomUUID);
  assert.equal(
    (
      await post(
        '/users/v1/sessions',
        {
          cmd: 'saveSessField',
          sessionID: internalRoom,
          fieldName: 'tagline',
          fieldVal: 'Updated by internal ID',
        },
        a.token,
      )
    ).data.success,
    true,
  );
  const urls = [
    'customFaviconURL',
    'overwriteCashRegisterSound',
    'login_webhook_url',
    'logout_webhook_url',
    'customRoomURL',
    'custRoomDriveURL',
    'custLogoutURL',
    'openLoginLink',
    'loginErrorURL',
    'altBenzingaLogoURL',
    'altBenzingaLinkURL',
    'slackPostURL',
    'positionsIframeUrl',
    'tipMeBtnUrl',
    'customClientAlertPostURL',
    'runawayRecPostURL',
    'obsStreamSatusWebHookURL',
    'restreamToURL',
    'customPlayerURL',
    'customUserInfoURL',
    'chatServerURL',
    'customMobileAppIOSUrl',
    'customMobileAppAndroidUrl',
    'nqNewsFeedURL',
    'pairOKRedirect',
    'pairErrorRedirect',
    'logoURL',
    'bkgImg',
    'bkgImgHREF',
    'bkgImageURLHREF',
  ];
  for (const fieldName of urls) {
    const blocked = await post(
      '/users/v1/sessions',
      { cmd: 'saveSessField', sessionID: internalRoom, fieldName, fieldVal: 'javascript:alert(1)' },
      a.token,
    );
    assert.equal(blocked.status, 400, fieldName);
  }
  for (const value of ['data:text/html,hi', 'vbscript:run', '//evil.example/path', '/safe\npath'])
    assert.equal(
      (
        await post(
          '/users/v1/sessions',
          {
            cmd: 'saveSessField',
            sessionID: internalRoom,
            fieldName: 'customFaviconURL',
            fieldVal: value,
          },
          a.token,
        )
      ).status,
      400,
    );
  for (const value of [
    'https://example.test/image.png',
    'http://example.test/image.png',
    '/public/images/a.png',
    '../images/a.png',
    '',
  ])
    assert.equal(
      (
        await post(
          '/users/v1/sessions',
          {
            cmd: 'saveSessField',
            sessionID: internalRoom,
            fieldName: 'customFaviconURL',
            fieldVal: value,
          },
          a.token,
        )
      ).data.success,
      true,
    );
  for (const [fieldName, fieldVal] of [
    ['media_server_audio', 'media-host:8088'],
    ['clusterID', 'cluster:primary'],
    ['restreamToURLKey', 'not-a-url'],
  ])
    assert.equal(
      (
        await post(
          '/users/v1/sessions',
          { cmd: 'saveSessField', sessionID: internalRoom, fieldName, fieldVal },
          a.token,
        )
      ).data.success,
      true,
    );
  assert.equal(
    (
      await post(
        '/users/v1/sessions',
        { cmd: 'changeLogo', sessionID: internalRoom, fpath: 'javascript:alert(1)' },
        a.token,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await post(
        '/users/v1/sessions',
        { cmd: 'changeBkgImgHREF', sessionID: internalRoom, href: 'data:text/html,hi' },
        a.token,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await post(
        '/users/v1/sessions',
        {
          cmd: 'saveSessField',
          sessionID: internalRoom,
          fieldName: 'autoOpenTime',
          fieldVal: '9:30',
        },
        a.token,
      )
    ).data.success,
    true,
  );
  assert.equal(
    (
      await post(
        '/users/v1/sessions',
        {
          cmd: 'saveSessField',
          sessionID: internalRoom,
          fieldName: 'autoCloseTime',
          fieldVal: '09:30',
        },
        a.token,
      )
    ).status,
    400,
  );
  for (const fieldVal of ['24:00', '9:5', '-1:30', '23:60', '12:00 AM'])
    assert.equal(
      (
        await post(
          '/users/v1/sessions',
          { cmd: 'saveSessField', sessionID: internalRoom, fieldName: 'autoCloseTime', fieldVal },
          a.token,
        )
      ).status,
      400,
    );
  assert.equal(
    (
      await post(
        '/users/v1/sessions',
        {
          cmd: 'saveSessField',
          sessionID: internalRoom,
          fieldName: 'autoCloseTime',
          fieldVal: '17:00',
        },
        a.token,
      )
    ).data.success,
    true,
  );
  assert.equal(
    (
      await post(
        '/users/v1/sessions',
        {
          cmd: 'saveSessField',
          sessionID: internalRoom,
          fieldName: 'autoCloseTime',
          fieldVal: null,
        },
        a.token,
      )
    ).data.success,
    true,
  );

  assert.equal(
    db.prepare('SELECT tagline FROM sessions WHERE uuid=?').get(a.roomUUID).tagline,
    'Updated by internal ID',
  );
  assert.equal(
    (await post('/users/v1/sessions', { cmd: 'sessionPubData', sessionID: internalRoom })).data
      .uuid,
    a.roomUUID,
  );
  const loginByInternal = (
    await post('/users/v1/users.json', {
      cmd: 'loginChat',
      roomID: internalRoom,
      siteToken: a.token,
    })
  ).data;
  assert.equal(loginByInternal.success, true);
  assert.equal(loginByInternal.uuid, a.roomUUID);
  assert.equal(loginByInternal._id, internalRoom);

  const handoff = await fetch(base + `/users/v1/ssoJWT?sessID=${internalRoom}&sl=1`, {
    headers: { authorization: `Bearer ${a.token}` },
    redirect: 'manual',
  });
  assert.equal(handoff.status, 302);
  assert.equal(handoff.headers.get('location'), `/session?id=${a.roomUUID}`);
  assert.match(handoff.headers.get('set-cookie'), new RegExp(`prt_room_${a.roomUUID}=`));

  const form = new FormData();
  form.append('file', new Blob(['test file'], { type: 'text/plain' }), 'demo.txt');
  const uploaded = await (
    await fetch(base + `/users/v1/session/upload/${internalRoom}/${a.token}/1/files`, {
      method: 'POST',
      body: form,
    })
  ).json();
  assert.equal(uploaded.success, true);
  assert.equal(
    db.prepare('SELECT room_id FROM files WHERE id=?').get(uploaded.id).room_id,
    a.roomUUID,
  );
  assert.ok(
    (
      await post('/users/v1/users.json', { cmd: 'getAttachments', roomID: internalRoom }, a.token)
    ).data.some((f) => f.id === uploaded.id),
  );
  assert.equal(
    (await post('/users/v1/sessions', { cmd: 'deleteFile', fileID: uploaded.id }, a.token)).data
      .success,
    true,
  );
  assert.ok(
    !(
      await post('/users/v1/users.json', { cmd: 'getAttachments', roomID: internalRoom }, a.token)
    ).data.some((f) => f.id === uploaded.id),
  );
  const uploadDir = require('../src/config').UPLOAD_DIR;
  fs.writeFileSync(path.join(uploadDir, 'logo-fixture'), 'logo');
  db.prepare(
    'INSERT INTO files (id,room_id,uploader_id,uploader_name,original_name,stored_name,mime_type,size_bytes,visibility,category) VALUES (?,?,?,?,?,?,?,?,?,?)',
  ).run(
    'logo-file',
    a.roomUUID,
    'owner',
    'Alice',
    'logo.png',
    'logo-fixture',
    'image/png',
    4,
    2,
    'logos',
  );
  assert.equal(
    (
      await post(
        '/users/v1/sessions',
        { cmd: 'getUserFiles', sessionID: internalRoom, uploadType: 'logo' },
        a.token,
      )
    ).data[0]._id,
    'logo-file',
  );
  assert.equal(
    (
      await post(
        '/users/v1/sessions',
        { cmd: 'changeLogo', sessionID: internalRoom, fpath: '/users/v1/serveFile?id=logo-file' },
        a.token,
      )
    ).data.success,
    true,
  );
  assert.equal(
    (
      await post(
        '/users/v1/sessions',
        { cmd: 'changeBkgImg', sessionID: internalRoom, fpath: '/public/background.png' },
        a.token,
      )
    ).data.success,
    true,
  );
  assert.equal(
    (
      await post(
        '/users/v1/sessions',
        { cmd: 'changeBkgImgHREF', sessionID: internalRoom, href: 'https://example.test/' },
        a.token,
      )
    ).data.success,
    true,
  );
  assert.equal(
    (await post('/users/v1/sessions', { cmd: 'resetBkgImgHREF', sessionID: internalRoom }, a.token))
      .data.success,
    true,
  );
  const attendance = (
    await post('/users/v1/sessions', { cmd: 'statsForSession', sessionID: internalRoom }, a.token)
  ).data;
  assert.ok(attendance.some((v) => v.email === 'alice@example.test'));
  const now = new Date(),
    month = now.getUTCMonth() + 1,
    year = now.getUTCFullYear();
  assert.ok(
    (
      await post(
        '/users/v1/sessions',
        {
          cmd: 'statsForSessionMontly',
          sessionID: internalRoom,
          startMonth: month,
          startYear: year,
          endMonth: month,
          endYear: year,
        },
        a.token,
      )
    ).data.some((v) => v.totalLogins >= 1),
  );

  db.prepare('UPDATE plans SET max_rooms=10 WHERE id=?').run('trial');
  const created = (
    await post('/users/v1/users.json', { cmd: 'newSession', name: 'Second' }, a.token)
  ).data;
  assert.match(created.uuid, /^\d{6}$/);
  assert.match(created._id, /^[0-9a-f]{24}$/);
  assert.notEqual(created.uuid, created._id);
  const createdDetails = (
    await post('/users/v1/sessions', { cmd: 'sessionDetails', sessionID: created._id }, a.token)
  ).data.session;
  assert.equal(createdDetails.uuid, created.uuid);
  assert.equal(createdDetails._id, created._id);
  const viaSessions = (await post('/users/v1/sessions', { cmd: 'create', name: 'Third' }, a.token))
    .data;
  assert.notEqual(viaSessions._id, viaSessions.uuid);
  assert.equal(viaSessions.session._id, viaSessions._id);
  const cloned = (
    await post(
      '/users/v1/sessions',
      { cmd: 'cloneSession', sessionID: internalRoom, name: 'Copy' },
      a.token,
    )
  ).data;
  const cloneRow = db.prepare('SELECT * FROM sessions WHERE id=?').get(cloned);
  assert.ok(cloneRow);
  assert.notEqual(cloneRow.id, cloneRow.uuid);
  db.prepare('INSERT INTO sessions (uuid,owner_id,name) VALUES (?,?,?)').run(
    'legacy-room',
    db.prepare('SELECT id FROM users WHERE email=?').get('alice@example.test').id,
    'Legacy',
  );
  assert.equal(
    (await post('/users/v1/sessions', { cmd: 'sessionDetails', sessionID: 'legacy-room' }, a.token))
      .data.session._id,
    'legacy-room',
  );
  assert.equal(
    (
      await post(
        '/ptr_app/mp/v2/',
        { sessionID: internalRoom, title: 'Market', logoURL: 'javascript:alert(1)' },
        a.token,
      )
    ).status,
    400,
  );
  const marketplace = await post(
    '/ptr_app/mp/v2/',
    { sessionID: internalRoom, title: 'Market' },
    a.token,
  );
  assert.equal(marketplace.data.sessionID, internalRoom);
  assert.equal(
    (
      await (
        await fetch(base + `/ptr_app/mp/v2/marketplaces/${internalRoom}`, {
          headers: { authorization: `Bearer ${a.token}` },
        })
      ).json()
    )[0].sessionID,
    internalRoom,
  );

  assert.equal(
    (
      await post(
        '/users/v1/sessions',
        { cmd: 'saveSessField', sessionID: a.roomUUID, fieldName: 'name', fieldVal: 'Hijacked' },
        b.token,
      )
    ).status,
    403,
  );
  assert.equal(
    (await post('/users/v1/sessions', { cmd: 'sessionDetails', sessionID: a.roomUUID }, a.token))
      .data.session.name,
    "Alice's Room",
  );
  const initial = (
    await post('/users/v1/sessions', { cmd: 'sessionDetails', sessionID: a.roomUUID }, a.token)
  ).data.session;
  assert.equal(initial.authMode, 'open');
  assert.equal(initial.current_capacity, 0);
  assert.equal(initial.recordedMaxCapacity, 0);
  db.prepare('INSERT INTO realtime_capacity(room_id,maximum) VALUES (?,?)').run(a.roomUUID, 3);
  const listed = (await post('/users/v1/sessions', { cmd: 'list' }, a.token)).data.find(
    (r) => r.uuid === a.roomUUID,
  );
  assert.equal(listed.recordedMaxCapacity, 3);
  assert.equal(listed.current_capacity, 0);
  assert.equal(
    (await post('/users/v1/sessions', { cmd: 'resetMaxCounts', sessionID: a.roomUUID }, a.token))
      .data.recordedMaxCapacity,
    0,
  );
  const ownerRows = (
    await post('/users/v1/sessions', { cmd: 'userList', sessionID: a.roomUUID }, a.token)
  ).data.xrefs;
  assert.equal(ownerRows.length, 1);
  assert.equal(ownerRows[0].role, 0);
  assert.equal(ownerRows[0].userName, 'Alice');
  assert.equal(ownerRows[0].email, 'alice@example.test');
  assert.equal(
    (
      await post(
        '/users/v1/sessions',
        { cmd: 'removeUserXref', sessionID: a.roomUUID, xrefID: ownerRows[0]._id },
        a.token,
      )
    ).status,
    404,
  );

  assert.equal(
    (
      await post(
        '/users/v1/sessions',
        { cmd: 'saveSessField', sessionID: a.roomUUID, fieldName: 'theme', fieldVal: 'dark' },
        a.token,
      )
    ).data.success,
    true,
  );
  assert.equal(
    (await post('/users/v1/sessions', { cmd: 'sessionDetails', sessionID: a.roomUUID }, a.token))
      .data.session.theme,
    'dark',
  );
  assert.equal(
    (await post('/users/v1/user-change-password', { email: 'alice@example.test', pw: 'evil' })).data
      .success,
    false,
  );
  const alice = db.prepare('SELECT id FROM users WHERE email=?').get('alice@example.test');
  const reset = createPasswordReset({ userId: alice.id });
  assert.equal(
    (await post('/users/v1/change-password', { userUUID: reset, passNew: 'newpassword1' })).data
      .success,
    true,
  );
  assert.equal(
    (await post('/users/v1/change-password', { userUUID: reset, passNew: 'newpassword2' })).data
      .success,
    false,
  );
  const fresh = (await post('/users/v1/login', { email: 'alice@example.test', pw: 'newpassword1' }))
    .data;
  assert.equal(fresh.success, true);
  const delegate = (
    await post(
      '/users/v1/adminusers',
      { cmd: 'add', name: 'Delegate', email: 'delegate@example.test', password: 'password3' },
      fresh.token,
    )
  ).data;
  assert.equal(delegate.success, true);
  const d = (await post('/users/v1/login', { email: 'delegate@example.test', pw: 'password3' }))
    .data;
  assert.equal(d.success, true);
  assert.equal(
    (await post('/users/v1/sessions', { cmd: 'sessionDetails', sessionID: a.roomUUID }, d.token))
      .data.success,
    true,
  );
  assert.equal((await post('/users/v1/adminusers', { cmd: 'list' }, d.token)).status, 403);
  const adminList = (await post('/users/v1/adminusers', { cmd: 'list' }, fresh.token)).data
    .adminUsers;
  assert.ok(adminList[0].created);
  assert.equal(
    (await post('/users/v1/adminusers', { cmd: 'remove', adminUserId: delegate.id }, fresh.token))
      .data.success,
    true,
  );
  assert.equal((await post('/users/v1/login_tok', { token: d.token })).data.success, false);

  const endpointList = (
    await post('/users/v1/apikeys', { cmd: 'listAllApiEndpoints' }, fresh.token)
  ).data;
  assert.ok(endpointList.endpoints.includes('/stats/v1/sessions/list'));
  const disposable = (await post('/users/v1/apikeys', { cmd: 'create' }, fresh.token)).data;
  const rotation = (
    await post('/users/v1/apikeys', { cmd: 'rotate', apiId: disposable.id }, fresh.token)
  ).data;
  assert.ok(rotation.newSecret && rotation.newSecret !== disposable.apiSecret);
  assert.equal(
    (await post('/users/v1/apikeys', { cmd: 'delete', apiId: disposable.id }, fresh.token)).data
      .success,
    true,
  );
  const key = (await post('/users/v1/apikeys', { cmd: 'create' }, fresh.token)).data;
  assert.equal(key.success, true);
  await post(
    '/users/v1/apikeys',
    { cmd: 'restrictApiSessions', apiId: key.id, sessions: [internalRoom] },
    fresh.token,
  );
  assert.equal(
    (
      await post(
        '/users/v1/sessions',
        { cmd: 'sessionDetails', sessionID: a.roomUUID },
        key.apiSecret,
      )
    ).data.success,
    true,
  );
  assert.equal(
    (
      await post(
        '/users/v1/sessions',
        { cmd: 'sessionDetails', sessionID: b.roomUUID },
        key.apiSecret,
      )
    ).status,
    403,
  );
  await post(
    '/users/v1/apikeys',
    { cmd: 'restrictApiEndpoints', apiId: key.id, endpoints: ['sessionDetails'] },
    fresh.token,
  );
  assert.equal(
    (
      await post(
        '/users/v1/sessions',
        { cmd: 'saveSessField', sessionID: a.roomUUID, fieldName: 'theme', fieldVal: 'light' },
        key.apiSecret,
      )
    ).status,
    401,
  );
  const guest = (
    await post('/users/v1/users.json', {
      cmd: 'loginChat',
      roomID: b.roomUUID,
      email: 'guest@example.test',
      name: 'Guest',
    })
  ).data;
  assert.equal(guest.success, true);
  assert.equal(guest.name, "Bob's Room");
  assert.equal((await post('/users/v1/login_tok', { token: guest.token })).data.success, false);
  assert.equal(
    (
      await post(
        '/users/v1/sessions',
        { cmd: 'saveSessField', sessionID: b.roomUUID, fieldName: 'name', fieldVal: 'Hijacked' },
        guest.token,
      )
    ).status,
    403,
  );
  const unauthorizedForm = new FormData();
  unauthorizedForm.append('roomID', b.roomUUID);
  unauthorizedForm.append('file', new Blob(['x'], { type: 'text/plain' }), 'x.txt');
  assert.equal(
    (
      await fetch(base + '/users/v1/upload', {
        method: 'POST',
        headers: { authorization: `Bearer ${guest.token}` },
        body: unauthorizedForm,
      })
    ).status,
    403,
  );
  await post(
    '/users/v1/sessions',
    { cmd: 'saveSessField', sessionID: b.roomUUID, fieldName: 'userUploads', fieldVal: true },
    b.token,
  );
  const allowedForm = new FormData();
  allowedForm.append('roomID', b.roomUUID);
  allowedForm.append('file', new Blob(['x'], { type: 'text/plain' }), 'x.txt');
  assert.equal(
    (
      await (
        await fetch(base + '/users/v1/upload', {
          method: 'POST',
          headers: { authorization: `Bearer ${guest.token}` },
          body: allowedForm,
        })
      ).json()
    ).success,
    true,
  );

  db.prepare(
    'INSERT INTO files (id,room_id,uploader_id,uploader_name,original_name,stored_name,mime_type,size_bytes,visibility) VALUES (?,?,?,?,?,?,?,?,?)',
  ).run('shared', b.roomUUID, 'bob', 'Bob', 'shared.txt', 'shared.txt', 'text/plain', 3, 1);
  let shared = (
    await post('/users/v1/sessions', { cmd: 'sessionPubFiles', sessionID: b.roomUUID }, guest.token)
  ).data;
  assert.ok(shared.some((f) => f.vidPath === '/users/v1/serveFile?id=shared'));

  await post(
    '/users/v1/sessions',
    { cmd: 'saveSessField', sessionID: b.roomUUID, fieldName: 'authMode', fieldVal: 'webinarRoom' },
    b.token,
  );
  await post(
    '/users/v1/sessions',
    {
      cmd: 'saveSessField',
      sessionID: b.roomUUID,
      fieldName: 'webinarPW',
      fieldVal: 'private-secret',
    },
    b.token,
  );
  const publicData = (
    await post('/users/v1/sessions', { cmd: 'sessionPubData', sessionID: b.roomUUID })
  ).data;
  assert.equal(publicData.uuid, b.roomUUID);
  assert.equal(publicData.authMode, 'webinarRoom');
  assert.equal(publicData.webinarPW, undefined);
  assert.equal(
    (
      await post('/users/v1/users.json', {
        cmd: 'registerByEmail',
        roomID: b.roomUUID,
        name: 'Intruder',
        email: 'intruder@example.test',
      })
    ).status,
    403,
  );
  const short = (
    await post('/users/v1/sessions', { cmd: 'sessionDetailsShort', uuid: b.roomUUID }, b.token)
  ).data;
  assert.equal(short.session.uuid, short.uuid);
  const unique = (
    await post('/users/v1/sessions', { cmd: 'uniqueLinkLogin', sessionID: b.roomUUID }, b.token)
  ).data;
  assert.ok(unique.success && unique.uniqueLinkLogin);
  assert.equal(
    (
      await post(
        '/users/v1/sessions',
        { cmd: 'changeCustomURL', sessionID: b.roomUUID, cname: 'trading-room' },
        b.token,
      )
    ).data.success,
    true,
  );
  assert.equal(
    (
      await post(
        '/users/v1/sessions',
        { cmd: 'saveTextList', sessionID: b.roomUUID, textList: 'alpha' },
        b.token,
      )
    ).data.success,
    true,
  );
  assert.equal(
    (await post('/users/v1/sessions', { cmd: 'loadTextList', sessionID: b.roomUUID }, b.token))
      .data,
    'alpha',
  );
  assert.equal(
    (
      await post(
        '/users/v1/sessions',
        { cmd: 'addBadge', sessionID: b.roomUUID, name: 'Bad', imgURL: 'javascript:alert(1)' },
        b.token,
      )
    ).status,
    400,
  );
  const badge = (
    await post(
      '/users/v1/sessions',
      { cmd: 'addBadge', sessionID: b.roomUUID, name: 'Analyst', text: 'A', roles: [1] },
      b.token,
    )
  ).data;
  assert.equal(badge.success, true);
  assert.deepEqual(badge.badges[0].roles, [1]);
  const badgeId = badge.badges[0]._id;
  const editedBadge = await post(
    '/users/v1/sessions',
    {
      cmd: 'addBadge',
      sessionID: b.roomUUID,
      isEdit: true,
      badgeID: badgeId,
      name: 'Senior Analyst',
      text: 'SA',
      roles: 'members',
    },
    b.token,
  );
  assert.equal(editedBadge.data.badges[0].name, 'Senior Analyst');
  assert.equal(editedBadge.data.badges[0].roles, 'members');
  assert.equal(
    (
      await post(
        '/users/v1/sessions',
        {
          cmd: 'addBadgeDarkTheme',
          sessionID: b.roomUUID,
          badgeID: badgeId,
          darkTheme: 'dark-badge',
        },
        b.token,
      )
    ).data.badges[0].darkTheme,
    'dark-badge',
  );
  assert.equal(
    (await post('/users/v1/sessions', { cmd: 'listBadges', sessionID: b.roomUUID }, b.token)).data
      .badges[0]._id,
    badgeId,
  );
  assert.equal(
    (
      await post(
        '/users/v1/sessions',
        { cmd: 'deleteBadge', sessionID: b.roomUUID, badgeID: badgeId },
        b.token,
      )
    ).data.badges.length,
    0,
  );
  const invite = (
    await post(
      '/users/v1/sessions',
      {
        cmd: 'inviteUsers',
        sessionID: b.roomUUID,
        persons: [
          { name: 'Invited', email: 'invite@example.test', pw: 'password4', sendEmail: false },
        ],
      },
      b.token,
    )
  ).data;
  assert.equal(invite.success, true);
  assert.equal(invite.invited, 1);
  let xrefs = (
    await post('/users/v1/sessions', { cmd: 'userList', sessionID: b.roomUUID }, b.token)
  ).data.xrefs;
  const guestRow = xrefs.find((x) => x.email === 'guest@example.test');
  assert.equal(guestRow.role, 2);
  const guestId = guestRow._id;
  db.prepare(
    'INSERT INTO memberships (id,room_id,email,name,role,status,flags) VALUES (?,?,?,?,?,?,?)',
  ).run(
    'trial-fixture',
    b.roomUUID,
    'trial@example.test',
    'Trial',
    '2',
    'approved',
    JSON.stringify({ isFreeTrial: true }),
  );
  assert.ok(
    (
      await post('/users/v1/sessions', { cmd: 'showFreeTrials', sessionID: b.roomUUID }, b.token)
    ).data.xrefs.some((x) => x._id === 'trial-fixture'),
  );
  const afterTrialClear = (
    await post('/users/v1/sessions', { cmd: 'clearUserListFT', sessionID: b.roomUUID }, b.token)
  ).data.xrefs;
  assert.ok(!afterTrialClear.some((x) => x._id === 'trial-fixture'));
  assert.ok(afterTrialClear.some((x) => x.role === 0));
  db.prepare(
    'INSERT INTO memberships (id,room_id,email,name,role,status,flags) VALUES (?,?,?,?,?,?,?)',
  ).run(
    'remove-fixture',
    b.roomUUID,
    'remove@example.test',
    'Remove',
    '2',
    'approved',
    JSON.stringify({ isMa: true }),
  );
  assert.equal(
    (
      await post(
        '/users/v1/sessions',
        { cmd: 'userListMarketplace', sessionID: b.roomUUID },
        b.token,
      )
    ).data.xrefs[0]._id,
    'remove-fixture',
  );
  assert.equal(
    (
      await post(
        '/users/v1/sessions',
        { cmd: 'removeUserXref', sessionID: b.roomUUID, xrefID: 'remove-fixture' },
        b.token,
      )
    ).data.success,
    true,
  );

  const guestArchive = `/users/v1/archives/chat/${b.roomUUID}/${guest.token}`;
  assert.equal((await fetch(base + guestArchive)).status, 403);
  await post(
    '/users/v1/sessions',
    {
      cmd: 'saveSessField',
      sessionID: b.roomUUID,
      fieldName: 'showArchivesToUsers',
      fieldVal: true,
    },
    b.token,
  );
  assert.equal((await fetch(base + guestArchive)).status, 200);
  await post(
    '/users/v1/sessions',
    { cmd: 'saveSessField', sessionID: b.roomUUID, fieldName: 'hideChatLog', fieldVal: true },
    b.token,
  );
  assert.equal((await fetch(base + guestArchive)).status, 403);
  assert.equal(
    (await fetch(base + `/users/v1/archives/alerts/${b.roomUUID}/${guest.token}`)).status,
    200,
  );
  assert.equal(
    (await fetch(base + `/users/v1/archives/chat/${b.roomUUID}/${b.token}`)).status,
    200,
  );
  await post(
    '/users/v1/sessions',
    { cmd: 'saveSessField', sessionID: b.roomUUID, fieldName: 'hideChatLog', fieldVal: false },
    b.token,
  );

  for (const [code, field, value] of [
    [7, 'hideUserCount', true],
    [8, 'hideUserCount', false],
    [10, 'hidePersInfo', true],
    [11, 'hidePersInfo', false],
    [13, 'denyArchivesAccess', true],
    [14, 'denyArchivesAccess', false],
  ]) {
    assert.equal(
      (
        await post(
          '/users/v1/sessions',
          { cmd: 'updateUserXref', sessionID: b.roomUUID, xrefID: guestId, newRole: code },
          b.token,
        )
      ).data.success,
      true,
    );
    const updated = (
      await post('/users/v1/sessions', { cmd: 'userList', sessionID: b.roomUUID }, b.token)
    ).data.xrefs.find((x) => x._id === guestId);
    assert.equal(updated.role, 2);
    assert.equal(updated[field], value);
    if (code === 13)
      assert.equal(
        (await fetch(base + `/users/v1/archives/alerts/${b.roomUUID}/${guest.token}`)).status,
        403,
      );
  }
  await post(
    '/users/v1/sessions',
    { cmd: 'updateUserXref', sessionID: b.roomUUID, xrefID: guestId, newRole: 9 },
    b.token,
  );
  assert.ok(
    (
      await post('/users/v1/sessions', { cmd: 'userList', sessionID: b.roomUUID }, b.token)
    ).data.xrefs.find((x) => x._id === guestId).lastLogin,
  );
  const presEmail = 'presenter@example.test';
  assert.equal(
    (
      await post(
        '/users/v1/sessions',
        {
          cmd: 'inviteUsers',
          sessionID: b.roomUUID,
          persons: [
            { name: 'Presenter', email: presEmail, pw: 'presenterpass', role: 1, sendEmail: false },
          ],
        },
        b.token,
      )
    ).data.success,
    true,
  );
  const pres = (
    await post('/users/v1/users.json', {
      cmd: 'loginChat',
      roomID: b.roomUUID,
      email: presEmail,
      pw: 'presenterpass',
    })
  ).data;
  assert.equal(pres.success, true);
  await post(
    '/users/v1/sessions',
    {
      cmd: 'saveSessField',
      sessionID: b.roomUUID,
      fieldName: 'showArchivesToSpecificPresenters',
      fieldVal: 'someone@example.test',
    },
    b.token,
  );
  assert.equal(
    (await fetch(base + `/users/v1/archives/alerts/${b.roomUUID}/${pres.token}`)).status,
    403,
  );
  await post(
    '/users/v1/sessions',
    {
      cmd: 'saveSessField',
      sessionID: b.roomUUID,
      fieldName: 'showArchivesToSpecificPresenters',
      fieldVal: presEmail,
    },
    b.token,
  );
  assert.equal(
    (await fetch(base + `/users/v1/archives/alerts/${b.roomUUID}/${pres.token}`)).status,
    200,
  );

  assert.equal(
    (
      await post(
        '/users/v1/sessions',
        {
          cmd: 'setPresenterSetting',
          sessionID: b.roomUUID,
          key: presEmail,
          val: { fontColor: '#fff' },
        },
        pres.token,
      )
    ).data.success,
    true,
  );
  assert.equal(
    (
      await post(
        '/users/v1/sessions',
        { cmd: 'setPresenterSetting', sessionID: b.roomUUID, key: 'other@example.test', val: {} },
        pres.token,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await post(
        '/users/v1/sessions',
        { cmd: 'clearPresenterSetting', sessionID: b.roomUUID, key: presEmail },
        pres.token,
      )
    ).data.success,
    true,
  );

  const inviteId = xrefs.find((x) => x.email === 'invite@example.test')._id;
  assert.equal(
    (
      await post(
        '/users/v1/sessions',
        {
          cmd: 'updateUserXrefMultyBadge',
          sessionID: b.roomUUID,
          xrefIDs: [guestId],
          badge: 'badge-for-batch',
          badgeCmd: 'add',
        },
        b.token,
      )
    ).data.success,
    true,
  );
  assert.deepEqual(
    (
      await post('/users/v1/sessions', { cmd: 'userList', sessionID: b.roomUUID }, b.token)
    ).data.xrefs.find((x) => x._id === guestId).badges,
    ['badge-for-batch'],
  );
  assert.equal(
    (
      await post(
        '/users/v1/sessions',
        {
          cmd: 'updateUserXrefMultyBadge',
          sessionID: b.roomUUID,
          xrefIDs: [guestId],
          badge: 'badge-for-batch',
          badgeCmd: 'remove',
        },
        b.token,
      )
    ).data.success,
    true,
  );

  const memberFlags = JSON.parse(
    db.prepare('SELECT flags FROM memberships WHERE id=?').get(guestId).flags,
  );
  memberFlags.mobilePairCode = '123456';
  db.prepare('UPDATE memberships SET flags=? WHERE id=?').run(JSON.stringify(memberFlags), guestId);
  assert.equal(
    (await post('/users/v1/sessions', { cmd: 'getAppPin', email: 'guest@example.test' }, b.token))
      .data.pin,
    '123456',
  );

  assert.equal(
    (
      await post(
        '/users/v1/sessions',
        {
          cmd: 'editUsername',
          sessionID: b.roomUUID,
          xrefID: inviteId,
          newUsername: 'Invited Renamed',
        },
        b.token,
      )
    ).data.success,
    true,
  );
  assert.equal(
    (
      await post(
        '/users/v1/sessions',
        { cmd: 'userList', sessionID: b.roomUUID, searchTerm: 'Renamed' },
        b.token,
      )
    ).data.xrefs[0].userName,
    'Invited Renamed',
  );

  await post(
    '/users/v1/sessions',
    { cmd: 'updateUserXref', sessionID: b.roomUUID, xrefID: inviteId, newRole: 5 },
    b.token,
  );
  let invitedRow = (
    await post('/users/v1/sessions', { cmd: 'userList', sessionID: b.roomUUID }, b.token)
  ).data.xrefs.find((x) => x._id === inviteId);
  assert.equal(invitedRow.role, 1);
  assert.equal(invitedRow.nonPresenter, true);
  assert.equal(
    (
      await post(
        '/users/v1/sessions',
        {
          cmd: 'updateUserXrefMultyEmailList',
          sessionID: b.roomUUID,
          emailList: ['invite@example.test'],
          newRole: 2,
        },
        b.token,
      )
    ).data.success,
    true,
  );
  assert.equal(
    (
      await post('/users/v1/sessions', { cmd: 'userList', sessionID: b.roomUUID }, b.token)
    ).data.xrefs.find((x) => x._id === inviteId).role,
    2,
  );

  await post(
    '/users/v1/sessions',
    { cmd: 'updateUserXrefMulty', sessionID: b.roomUUID, xrefIDs: [inviteId], newRole: 6 },
    b.token,
  );
  invitedRow = (
    await post('/users/v1/sessions', { cmd: 'userList', sessionID: b.roomUUID }, b.token)
  ).data.xrefs.find((x) => x._id === inviteId);
  assert.equal(invitedRow.role, 2);
  assert.equal(invitedRow.isFreeTrial, true);
  assert.ok(
    (
      await post('/users/v1/sessions', { cmd: 'showFreeTrials', sessionID: b.roomUUID }, b.token)
    ).data.xrefs.some((x) => x._id === inviteId),
  );
  assert.ok(
    (
      await post(
        '/users/v1/sessions',
        { cmd: 'userListPresenters', sessionID: b.roomUUID },
        b.token,
      )
    ).data.xrefs.some((x) => x.email === presEmail),
  );
  await post(
    '/users/v1/sessions',
    { cmd: 'updateUserXrefMulty', sessionID: b.roomUUID, xrefIDs: [inviteId], newRole: 10 },
    b.token,
  );
  assert.equal(
    (
      await post('/users/v1/sessions', { cmd: 'userList', sessionID: b.roomUUID }, b.token)
    ).data.xrefs.some((x) => x._id === inviteId),
    false,
  );

  await post(
    '/users/v1/sessions',
    { cmd: 'updateUserXref', sessionID: b.roomUUID, xrefID: guestId, newBadges: ['badge-id'] },
    b.token,
  );
  assert.equal(
    (
      await post(
        '/users/v1/sessions',
        { cmd: 'clearTokensForUsers', sessionID: b.roomUUID },
        b.token,
      )
    ).data.success,
    true,
  );
  const cleared = (
    await post('/users/v1/sessions', { cmd: 'userList', sessionID: b.roomUUID }, b.token)
  ).data.xrefs.find((x) => x._id === guestId);
  assert.deepEqual(cleared.badges, []);
  await post(
    '/users/v1/sessions',
    {
      cmd: 'saveSessField',
      sessionID: b.roomUUID,
      fieldName: 'fileAccessCaseByCase',
      fieldVal: true,
    },
    b.token,
  );
  assert.equal(
    (
      await post(
        '/users/v1/sessions',
        { cmd: 'sessionPubFiles', sessionID: b.roomUUID },
        guest.token,
      )
    ).status,
    403,
  );
  await post(
    '/users/v1/sessions',
    { cmd: 'manageFileAccess', sessionID: b.roomUUID, xrefID: guestId, appcmd: 'enable' },
    b.token,
  );
  assert.equal(
    (
      await post(
        '/users/v1/sessions',
        { cmd: 'sessionPubFiles', sessionID: b.roomUUID },
        guest.token,
      )
    ).status,
    200,
  );
  await post(
    '/users/v1/sessions',
    { cmd: 'manageFileAccess', sessionID: b.roomUUID, xrefID: guestId, appcmd: 'disable' },
    b.token,
  );
  assert.equal(
    (
      await post(
        '/users/v1/sessions',
        { cmd: 'sessionPubFiles', sessionID: b.roomUUID },
        guest.token,
      )
    ).status,
    403,
  );
  await post(
    '/users/v1/sessions',
    { cmd: 'manageFileAccess', sessionID: b.roomUUID, xrefID: guestId, appcmd: 'enable' },
    b.token,
  );

  const initialFlags = JSON.parse(
    db.prepare('SELECT flags FROM memberships WHERE id=?').get(guestId).flags,
  );
  initialFlags.fcmTokens = ['dummy-token'];
  initialFlags.alerterAppTokens = ['dummy-token'];
  db.prepare('UPDATE memberships SET flags=? WHERE id=?').run(
    JSON.stringify(initialFlags),
    guestId,
  );
  for (const [tokcmd, paused] of [
    ['pause', true],
    ['resume', false],
  ]) {
    assert.equal(
      (
        await post(
          '/users/v1/sessions',
          { cmd: 'updateUserFCMTok', sessionID: b.roomUUID, xrefID: guestId, tokcmd },
          b.token,
        )
      ).data.success,
      true,
    );
    assert.equal(
      JSON.parse(db.prepare('SELECT flags FROM memberships WHERE id=?').get(guestId).flags)
        .alerterAppFCMUserOff,
      paused,
    );
  }
  assert.equal(
    (
      await post(
        '/users/v1/sessions',
        { cmd: 'updateUserFCMTok', sessionID: b.roomUUID, xrefID: guestId, tokcmd: 'unsub' },
        b.token,
      )
    ).data.success,
    true,
  );
  const unsubscribed = JSON.parse(
    db.prepare('SELECT flags FROM memberships WHERE id=?').get(guestId).flags,
  );
  assert.deepEqual(unsubscribed.fcmTokens, []);
  assert.deepEqual(unsubscribed.alerterAppTokens, []);
  for (const [appcmd, enabled] of [
    ['enable', true],
    ['disable', false],
  ]) {
    assert.equal(
      (
        await post(
          '/users/v1/sessions',
          { cmd: 'manageMobileApp', sessionID: b.roomUUID, xrefID: guestId, appcmd },
          b.token,
        )
      ).data.success,
      true,
    );
    assert.equal(
      JSON.parse(db.prepare('SELECT flags FROM memberships WHERE id=?').get(guestId).flags)
        .hasMobileApp,
      enabled,
    );
  }
  assert.deepEqual(
    (
      await post(
        '/users/v1/sessions',
        { cmd: 'getFCMTokens', sessionID: b.roomUUID, xrefID: guestId },
        b.token,
      )
    ).data.fcmTokens,
    [],
  );
  assert.equal(
    (
      await post(
        '/users/v1/sessions',
        { cmd: 'resetFCMTokens', sessionID: b.roomUUID, xrefID: guestId },
        b.token,
      )
    ).data.success,
    true,
  );
  await post(
    '/users/v1/sessions',
    { cmd: 'updateUserXref', sessionID: b.roomUUID, xrefID: guestId, newRole: 3 },
    b.token,
  );
  assert.equal(
    (await post('/users/v1/sessions', { cmd: 'userListMuted', sessionID: b.roomUUID }, b.token))
      .data.xrefs[0].role,
    3,
  );
  await post(
    '/users/v1/sessions',
    { cmd: 'updateUserXref', sessionID: b.roomUUID, xrefID: guestId, newRole: 4 },
    b.token,
  );
  assert.equal(
    (await post('/users/v1/sessions', { cmd: 'userListBanned', sessionID: b.roomUUID }, b.token))
      .data.xrefs[0].role,
    4,
  );
  await post(
    '/users/v1/sessions',
    { cmd: 'updateUserXref', sessionID: b.roomUUID, xrefID: guestId, newRole: 2 },
    b.token,
  );
  assert.equal(
    (await post('/users/v1/sessions', { cmd: 'userListBanned', sessionID: b.roomUUID }, b.token))
      .data.xrefs.length,
    0,
  );
  const remaining = (
    await post('/users/v1/sessions', { cmd: 'clearUserList', sessionID: b.roomUUID }, b.token)
  ).data.xrefs;
  assert.ok(remaining.some((x) => x.email === presEmail));
  assert.ok(!remaining.some((x) => x.email === 'guest@example.test'));

  assert.equal(
    (await post('/users/v1/users.json', { cmd: 'unknown' }, b.token)).data.success,
    false,
  );
  assert.equal((await fetch(base + `/users/v1/archives/alerts/${a.roomUUID}/bad`)).status, 403);
  assert.equal(
    (await (await fetch(base + `/users/v1/archives/alerts/${internalRoom}/${fresh.token}`)).json())
      .roomID,
    a.roomUUID,
  );
  fs.writeFileSync(path.join(uploadDir, 'secret.txt'), 'private file');
  db.prepare(
    'INSERT INTO files (id,room_id,uploader_id,uploader_name,original_name,stored_name,mime_type,size_bytes) VALUES (?,?,?,?,?,?,?,?)',
  ).run('file1', a.roomUUID, alice.id, 'Alice', 'secret.txt', 'secret.txt', 'text/plain', 12);
  assert.equal((await fetch(base + '/users/v1/serveFile?id=file1')).status, 403);
  assert.equal(
    (
      await fetch(base + '/users/v1/serveFile?id=file1', {
        headers: { authorization: `Bearer ${b.token}` },
      })
    ).status,
    403,
  );
  assert.equal(
    await (
      await fetch(base + '/users/v1/serveFile?id=file1', {
        headers: { authorization: `Bearer ${fresh.token}` },
      })
    ).text(),
    'private file',
  );
  const recordDir = require('../src/config').RECORDINGS_DIR;
  fs.mkdirSync(recordDir, { recursive: true });
  fs.writeFileSync(path.join(recordDir, 'test.webm'), 'media');
  db.prepare('INSERT INTO recordings (id,room_id,title,file_path) VALUES (?,?,?,?)').run(
    'rec1',
    a.roomUUID,
    'Recording',
    'test.webm',
  );
  const recs = (await post('/users/v1/recordings', { roomID: a.roomUUID }, fresh.token)).data;
  assert.equal(recs[0].vidPath, '/users/v1/recordingFile?id=rec1');
  assert.equal((await fetch(base + recs[0].vidPath)).status, 403);
  assert.equal(
    await (
      await fetch(base + recs[0].vidPath, { headers: { authorization: `Bearer ${fresh.token}` } })
    ).text(),
    'media',
  );
});

test('failed local SMTP delivery is recorded and reported', async () => {
  const oldHost = process.env.SMTP_HOST,
    oldPort = process.env.SMTP_PORT;
  process.env.SMTP_HOST = '127.0.0.1';
  process.env.SMTP_PORT = '1';
  try {
    await assert.rejects(
      require('../src/services/mail').sendMail({
        to: 'dummy@example.test',
        subject: 'Expected failure',
        text: 'Local test',
      }),
    );
    const entry = db
      .prepare(
        'SELECT status,attempts,last_error FROM outbox WHERE subject=? ORDER BY created_at DESC LIMIT 1',
      )
      .get('Expected failure');
    assert.equal(entry.status, 'failed');
    assert.equal(entry.attempts, 1);
    assert.equal(entry.last_error, 'SMTP delivery failed');
  } finally {
    if (oldHost === undefined) delete process.env.SMTP_HOST;
    else process.env.SMTP_HOST = oldHost;
    if (oldPort === undefined) delete process.env.SMTP_PORT;
    else process.env.SMTP_PORT = oldPort;
  }
});

test('captured demo signup creates its first room through newSession', async (t) => {
  db.prepare('UPDATE plans SET max_rooms=1 WHERE id=?').run('trial');
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
    return r.json();
  }
  const signup = await post('/users/v1/signup', {
    name: 'Demo Signup',
    email: 'signup-demo@example.test',
    pw: 'password123',
    demo: true,
  });
  assert.equal(signup.success, true);
  assert.equal(signup.demo, true);
  assert.equal(signup.roomUUID, '');
  const created = await post('/users/v1/users.json', {
    cmd: 'newSession',
    demoRoom: true,
    email: 'signup-demo@example.test',
    token: signup.token,
  });
  assert.equal(created.success, true);
  assert.match(created._id, /^[0-9a-f]{24}$/);
  assert.match(created.uuid, /^\d{6}$/);
  const details = await post('/users/v1/sessions', {
    cmd: 'sessionDetails',
    sessionID: created._id,
    token: signup.token,
  });
  assert.equal(details.session.uuid, created.uuid);
  assert.equal(details.session._id, created._id);
  assert.equal(details.session.isMainRoom, true);
  const named = await post('/users/v1/demoSignup', {
    name: 'Demo Named',
    email: 'named-demo@example.test',
    pw: 'password123',
    demo: true,
    roomName: 'Named Demo Room',
    clusterID: 'test-cluster',
  });
  assert.equal(named.success, true);
  assert.match(named.roomID, /^[0-9a-f]{24}$/);
  assert.match(named.roomUUID, /^\d{6}$/);
  const namedDetails = await post('/users/v1/sessions', {
    cmd: 'sessionDetails',
    sessionID: named.roomID,
    token: named.token,
  });
  assert.equal(namedDetails.session.uuid, named.roomUUID);
  assert.equal(namedDetails.session.name, 'Named Demo Room');
  assert.equal(namedDetails.session.clusterID, 'test-cluster');
});
