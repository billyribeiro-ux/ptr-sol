const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ptr-stats-'));
const express = require('express');
const db = require('../src/db/database');
const app = express();
app.use(express.json());
app.use('/users/v1', require('../src/routes/users'));
app.use('/stats/v1', require('../src/routes/stats'));

test('documented stats commands enforce keys, scopes, rate limits and response contracts', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, body, token) {
    const response = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await response.json() };
  }
  const owner = (
    await request('/users/v1/signup', {
      name: 'Owner',
      email: 'owner@example.test',
      pw: 'password123',
    })
  ).data;
  const other = (
    await request('/users/v1/signup', {
      name: 'Other',
      email: 'other@example.test',
      pw: 'password123',
    })
  ).data;
  const key = (await request('/users/v1/apikeys', { cmd: 'create' }, owner.token)).data;
  assert.ok(key.apiKey && key.apiSecret && key.apiKey !== key.apiSecret);
  const params = (room = owner.roomUUID) =>
    new URLSearchParams({
      apiKey: key.apiKey,
      apiSecret: key.apiSecret,
      ...(room ? { sessionID: room } : {}),
    }).toString();
  const get = (cmd, room = owner.roomUUID, extra = '') =>
    request(`/stats/v1/sessions/${cmd}?${params(room)}${extra}`);
  const post = (cmd, body, room = owner.roomUUID) =>
    request(`/stats/v1/sessions/${cmd}?${params(room)}`, body);
  assert.equal(
    (await request(`/stats/v1/sessions/list?apiKey=${key.apiKey}&apiSecret=bad`)).status,
    403,
  );
  const list = await get('list', null);
  assert.equal(list.data.success, true);
  assert.equal(list.data.sessions[0].uuid, owner.roomUUID);
  assert.match(list.data.sessions[0]._id, /^[0-9a-f]{24}$/);
  assert.notEqual(list.data.sessions[0]._id, owner.roomUUID);
  assert.equal((await get('list', null)).status, 429);
  assert.equal((await get('users', other.roomUUID)).status, 403);
  assert.equal((await get('users', 'missing-room')).status, 400);
  const added = await post('addUsers', { users: [{ email: 'Guest@Example.Test', name: 'Guest' }] });
  assert.deepEqual(added.data, { success: true, added: 1, freshen: 0 });
  const refreshKey = (await request('/users/v1/apikeys', { cmd: 'create' }, owner.token)).data;
  const refreshParams = new URLSearchParams({
    apiKey: refreshKey.apiKey,
    apiSecret: refreshKey.apiSecret,
    sessionID: owner.roomUUID,
  });
  assert.deepEqual(
    (
      await request(`/stats/v1/sessions/addUsers?${refreshParams}`, {
        users: [{ email: 'guest@example.test', name: 'Guest' }],
      })
    ).data,
    { success: true, added: 0, freshen: 1 },
  );

  const users = await get('users');
  assert.equal(users.data.users[0].email, 'guest@example.test');
  assert.equal(users.data.users[0].role, 2);
  assert.equal(users.data.users[0].active, true);
  const room = owner.roomUUID;
  const internalId = db.prepare('SELECT id FROM sessions WHERE uuid=?').get(room).id;
  db.prepare(
    'INSERT INTO messages (id,room_id,channel,user_id,name,email,text) VALUES (?,?,?,?,?,?,?)',
  ).run('message', room, 'main', 'member', 'Guest', 'guest@example.test', 'hello');
  db.prepare('INSERT INTO alerts (id,room_id,user_id,name,text) VALUES (?,?,?,?,?)').run(
    'alert',
    room,
    'member',
    'Guest',
    'price',
  );
  const inTime = new Date(Date.now() - 2000).toISOString(),
    outTime = new Date().toISOString();
  db.prepare(
    'INSERT INTO audit_events (id,room_id,actor_id,action,details) VALUES (?,?,?,?,?)',
  ).run(
    'login',
    room,
    'member',
    'room_login',
    JSON.stringify({ email: 'guest@example.test', userName: 'Guest', inTime }),
  );
  db.prepare(
    'INSERT INTO audit_events (id,room_id,actor_id,action,details) VALUES (?,?,?,?,?)',
  ).run(
    'join',
    room,
    'member',
    'room_join',
    JSON.stringify({ email: 'guest@example.test', userName: 'Guest', inTime }),
  );
  db.prepare(
    'INSERT INTO audit_events (id,room_id,actor_id,action,details) VALUES (?,?,?,?,?)',
  ).run(
    'logout',
    room,
    'member',
    'room_logout',
    JSON.stringify({
      email: 'guest@example.test',
      userName: 'Guest',
      inTime,
      outTime,
      duration: 2,
      isMobile: false,
      ip: '127.0.0.1',
      browser: 'Test Browser',
    }),
  );
  db.prepare(
    'INSERT INTO audit_events (id,room_id,actor_id,action,details) VALUES (?,?,?,?,?)',
  ).run(
    'deleted',
    room,
    'moderator',
    'log_deleted',
    JSON.stringify({
      logType: 'chat',
      eventType: 'D',
      channel: 'main',
      originalMessage: { text: 'removed' },
      content: 'removed',
    }),
  );
  db.prepare(
    'INSERT INTO audit_events (id,room_id,actor_id,action,details) VALUES (?,?,?,?,?)',
  ).run(
    'archived',
    room,
    'moderator',
    'log_archived',
    JSON.stringify({ logType: 'alerts', eventType: 'D', content: 'archived' }),
  );
  db.prepare(
    'INSERT INTO recordings (id,room_id,title,file_path,duration_sec) VALUES (?,?,?,?,?)',
  ).run('recording', room, 'Recording', 'test.webm', 120);
  const stats = (await get('userstats')).data.userstats;
  assert.equal(stats.length, 1);
  assert.equal(stats[0].email, 'guest@example.test');
  assert.equal(stats[0].outTime, outTime);
  assert.equal(stats[0].duration, 2000);
  assert.equal(stats[0].ip, '127.0.0.1');
  assert.equal(stats[0].browser, 'Test Browser');
  assert.equal((await get('chatlogs', internalId)).data.chatlogs[0].m, 'hello');
  assert.equal((await get('alertlogs')).data.chatlogs[0].message, 'price');
  assert.equal((await get('deletedlogs')).data.deletedlogs[0].originalMessage, 'removed');
  assert.equal(
    (await get('archivedlogs', room, '&logType=alerts')).data.archivedlogs[0].content,
    'archived',
  );
  const recordings = (await get('recordings')).data.recordings;
  assert.equal(recordings[0].sessionID, room);
  assert.equal(recordings[0].length, 120000);
  db.prepare('UPDATE memberships SET role=? WHERE room_id=?').run('1', room);
  db.prepare('INSERT INTO badges (id,room_id,name,text,color,bkcolor) VALUES (?,?,?,?,?,?)').run(
    'badge-original',
    room,
    'Badge',
    'B',
    '#fff',
    '#000',
  );
  db.prepare('UPDATE sessions SET settings=? WHERE uuid=?').run(
    JSON.stringify({
      badgeMetadata: { 'badge-original': { roles: [1] } },
      customCname: 'source-room',
    }),
    room,
  );
  db.prepare('UPDATE memberships SET flags=? WHERE room_id=?').run(
    JSON.stringify({ badges: ['badge-original'] }),
    room,
  );

  assert.equal((await get('cloneSession', room, '&name=Blocked')).status, 403);
  db.prepare('UPDATE plans SET max_rooms=10 WHERE id=?').run('trial');
  const clone = await request(`/stats/v1/sessions/cloneSession?${refreshParams}&name=Clone`);
  assert.equal(clone.data.session.clonedFrom, internalId);
  assert.equal(clone.data.session.name, 'Clone');
  assert.match(clone.data.session._id, /^[0-9a-f]{24}$/);
  assert.match(clone.data.session.uuid, /^\d{6}$/);
  assert.notEqual(clone.data.session._id, clone.data.session.uuid);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM memberships WHERE room_id=?').get(clone.data.session.uuid)
      .n,
    1,
  );
  const copiedMember = db
    .prepare('SELECT flags FROM memberships WHERE room_id=?')
    .get(clone.data.session.uuid);
  assert.deepEqual(JSON.parse(copiedMember.flags).badges, ['badge-original']);
  const cloneDetails = (
    await request(
      '/users/v1/sessions',
      { cmd: 'sessionDetails', sessionID: clone.data.session._id },
      owner.token,
    )
  ).data.session;
  assert.ok(cloneDetails.badges.some((b) => b._id === 'badge-original'));
  const cloneSettings = JSON.parse(
    db.prepare('SELECT settings FROM sessions WHERE uuid=?').get(clone.data.session.uuid).settings,
  );
  assert.equal(cloneSettings.customCname, undefined);

  assert.deepEqual(
    (await post('delUsers', { delUsers: ['Guest@Example.Test'] })).data.deletedUsers,
    ['guest@example.test'],
  );
  const limited = (await request('/users/v1/apikeys', { cmd: 'create' }, owner.token)).data;
  await request(
    '/users/v1/apikeys',
    { cmd: 'restrictApiEndpoints', apiId: limited.apiKey, endpoints: ['/stats/v1/sessions/list'] },
    owner.token,
  );
  const limitedParams = new URLSearchParams({
    apiKey: limited.apiKey,
    apiSecret: limited.apiSecret,
    sessionID: room,
  });
  assert.equal((await request(`/stats/v1/sessions/users?${limitedParams}`)).status, 403);
  await request(
    '/users/v1/apikeys',
    { cmd: 'restrictApiSessions', apiId: limited.apiKey, sessions: [other.roomUUID] },
    owner.token,
  );
  assert.deepEqual((await request(`/stats/v1/sessions/list?${limitedParams}`)).data.sessions, []);
  const rotated = (
    await request('/users/v1/apikeys', { cmd: 'rotate', apiId: limited.apiKey }, owner.token)
  ).data;
  assert.ok(rotated.apiSecret && rotated.apiSecret !== limited.apiSecret);
  assert.equal((await request(`/stats/v1/sessions/users?${limitedParams}`)).status, 403);
});
