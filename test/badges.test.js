const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ptr-badges-'));
const express = require('express');
const db = require('../src/db/database');
const app = express();
app.use(express.json());
app.use('/users/v1', require('../src/routes/users'));
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aE0AAAAASUVORK5CYII=',
  'base64',
);

test('account badges are shared within an owner account and survive room deletion', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  async function post(route, body, token) {
    const response = await fetch(base + route, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      data: await response.json(),
      cookie: response.headers.get('set-cookie'),
    };
  }
  async function upload(roomID, token) {
    const form = new FormData();
    form.append('roomID', roomID);
    form.append('file', new Blob([png], { type: 'image/png' }), 'badge.png');
    const response = await fetch(base + '/users/v1/images/upload', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: form,
    });
    return response.json();
  }
  const owner = (
    await post('/users/v1/signup', {
      name: 'Owner',
      email: 'owner@example.test',
      pw: 'password123',
    })
  ).data;
  const outsider = (
    await post('/users/v1/signup', {
      name: 'Outsider',
      email: 'outsider@example.test',
      pw: 'password123',
    })
  ).data;
  db.prepare('UPDATE plans SET max_rooms=10 WHERE id=?').run('trial');
  const second = (
    await post('/users/v1/users.json', { cmd: 'newSession', name: 'Second' }, owner.token)
  ).data;
  const asset = await upload(owner.roomUUID, owner.token);
  const unlinked = await upload(owner.roomUUID, owner.token);
  assert.equal(asset.success, true);
  const created = (
    await post(
      '/users/v1/sessions',
      { cmd: 'addBadge', name: 'Analyst', text: 'A', roles: 'analyst', imgURL: asset.data.link },
      owner.token,
    )
  ).data;
  const badgeId = created.badges[0]._id;
  assert.equal(created.badges[0].roles, 'analyst');
  const secondDetails = (
    await post('/users/v1/sessions', { cmd: 'sessionDetails', sessionID: second._id }, owner.token)
  ).data.session;
  assert.ok(secondDetails.badges.some((badge) => badge._id === badgeId));
  const outsiderList = (await post('/users/v1/sessions', { cmd: 'listBadges' }, outsider.token))
    .data.badges;
  assert.equal(
    outsiderList.some((badge) => badge._id === badgeId),
    false,
  );
  assert.equal(
    (
      await post(
        '/users/v1/sessions',
        { cmd: 'addBadge', isEdit: true, badgeID: badgeId, name: 'Hijack' },
        outsider.token,
      )
    ).status,
    404,
  );
  assert.equal(
    (await post('/users/v1/sessions', { cmd: 'deleteBadge', badgeID: badgeId }, outsider.token))
      .status,
    404,
  );
  assert.equal(
    (
      await post(
        '/users/v1/sessions',
        { cmd: 'addBadge', name: 'Cross-tenant image', imgURL: asset.data.link },
        outsider.token,
      )
    ).status,
    403,
  );
  await post(
    '/users/v1/sessions',
    {
      cmd: 'inviteUsers',
      sessionID: second._id,
      persons: [
        { name: 'Member', email: 'member@example.test', pw: 'password123', sendEmail: false },
      ],
    },
    owner.token,
  );
  const member = await post('/users/v1/users.json', {
    cmd: 'loginChat',
    roomID: second.uuid,
    email: 'member@example.test',
    pw: 'password123',
  });
  assert.equal(member.data.success, true);
  const roomCookie = member.cookie.split(';')[0];
  assert.equal(
    (await fetch(base + asset.data.link, { headers: { cookie: roomCookie } })).status,
    200,
  );
  assert.equal(
    (await fetch(base + unlinked.data.link, { headers: { cookie: roomCookie } })).status,
    403,
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
    db.prepare('SELECT room_id FROM files WHERE id=?').get(asset.data.id).room_id,
    second.uuid,
  );
  assert.ok(db.prepare('SELECT 1 FROM badges WHERE id=?').get(badgeId));
  assert.equal(
    (await fetch(base + asset.data.link, { headers: { cookie: roomCookie } })).status,
    200,
  );
  assert.equal(
    (await post('/users/v1/sessions', { cmd: 'deleteSession', sessionID: second._id }, owner.token))
      .data.success,
    true,
  );
  assert.ok(
    (await post('/users/v1/sessions', { cmd: 'listBadges' }, owner.token)).data.badges.some(
      (badge) => badge._id === badgeId,
    ),
  );
  assert.equal(
    (await fetch(base + asset.data.link, { headers: { authorization: `Bearer ${owner.token}` } }))
      .status,
    200,
  );
});

test('legacy room badges migrate to account ownership without losing roles or image references', () => {
  const { spawnSync } = require('node:child_process');
  const project = path.resolve(__dirname, '..');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ptr-legacy-badges-'));
  const env = { ...process.env, DATA_DIR: directory };
  const setup = `
    const db=require('./src/db/database');
    db.prepare('INSERT INTO users(id,name,email,password_hash) VALUES(?,?,?,?)').run('legacy-owner','Owner','legacy@example.test','hash');
    db.prepare('INSERT INTO sessions(uuid,owner_id,name,settings) VALUES(?,?,?,?)').run('legacy-room','legacy-owner','Legacy',JSON.stringify({badgeMetadata:{'legacy-badge':{roles:'members'}}}));
    db.prepare('INSERT INTO files(id,room_id,uploader_id,uploader_name,original_name,stored_name,mime_type) VALUES(?,?,?,?,?,?,?)').run('legacy-image','legacy-room','legacy-owner','Owner','image.png','image-file','image/png');
    db.prepare('INSERT INTO badges(id,room_id,name,text,color,bkcolor,image_url) VALUES(?,?,?,?,?,?,?)').run('legacy-badge','legacy-room','Badge','B','#fff','#000','/users/v1/images/legacy-image');
    db.exec('DROP TRIGGER cleanup_session_records; DROP INDEX badges_owner; ALTER TABLE badges DROP COLUMN asset_file_id; ALTER TABLE badges DROP COLUMN metadata; ALTER TABLE badges DROP COLUMN owner_id;');
  `;
  const created = spawnSync(process.execPath, ['-e', setup], {
    cwd: project,
    env,
    encoding: 'utf8',
  });
  assert.equal(created.status, 0, created.stderr);
  const migrated = spawnSync(
    process.execPath,
    [
      '-e',
      "const db=require('./src/db/database'); const r=db.prepare('SELECT owner_id,metadata,asset_file_id FROM badges WHERE id=?').get('legacy-badge'); process.stdout.write(JSON.stringify(r));",
    ],
    { cwd: project, env, encoding: 'utf8' },
  );
  assert.equal(migrated.status, 0, migrated.stderr);
  const row = JSON.parse(migrated.stdout);
  assert.equal(row.owner_id, 'legacy-owner');
  assert.equal(JSON.parse(row.metadata).roles, 'members');
  assert.equal(row.asset_file_id, 'legacy-image');
});
