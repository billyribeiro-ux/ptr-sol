const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ptr-media-proxy-'));
process.env.JANUS_URL = 'http://private-janus.test/janus';
process.env.JANUS_API_SECRET = 'private-gateway-secret';
const { createApp } = require('../src/server');
const db = require('../src/db/database');
const auth = require('../src/middleware/auth');

test('media proxy isolates sessions and rooms, blocks viewer publishing and hides gateway credentials', async () => {
  db.prepare(
    "INSERT INTO users(id,name,email,password_hash) VALUES('owner','Owner','owner@proxy.test','x'),('other','Other','other@proxy.test','x')",
  ).run();
  db.prepare(
    "INSERT INTO sessions(uuid,owner_id,name) VALUES('one','owner','One'),('two','other','Two')",
  ).run();
  db.prepare(
    "INSERT INTO memberships(id,room_id,email,name,role) VALUES('viewer','one','viewer@proxy.test','Viewer','2')",
  ).run();
  db.prepare("INSERT INTO realtime_media_rooms VALUES('one',101,102),('two',201,202)").run();
  const owner = auth.signToken(db.prepare("SELECT * FROM users WHERE id='owner'").get());
  const other = auth.signToken(db.prepare("SELECT * FROM users WHERE id='other'").get());
  const member = db.prepare("SELECT * FROM memberships WHERE id='viewer'").get();
  const viewer = auth.signRoomToken(
    { ...member, memberId: member.id, version: 0 },
    db.prepare("SELECT * FROM sessions WHERE uuid='one'").get(),
  );
  const nativeFetch = global.fetch,
    calls = [];
  let sequence = 1000;
  global.fetch = async (url, init) => {
    if (!String(url).startsWith(process.env.JANUS_URL)) return nativeFetch(url, init);
    const body = init.body ? JSON.parse(init.body) : {};
    calls.push({ url: String(url), body });
    const data = ['create', 'attach'].includes(body.janus) ? { id: ++sequence } : {};
    return new Response(JSON.stringify({ janus: 'success', data }), {
      headers: { 'content-type': 'application/json' },
    });
  };
  const server = http.createServer(createApp());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = async (suffix, token, body) => {
    const r = await nativeFetch(base + '/janus' + suffix, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: r.status, data: await r.json() };
  };
  try {
    const sid = (await post('', viewer, { janus: 'create' })).data.data.id;
    const scoped = await nativeFetch(base + '/janus', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'prt_session=' + other },
      body: JSON.stringify({ janus: 'create', token: viewer }),
    });
    assert.equal(scoped.status, 200);
    const scopedID = (await scoped.json()).data.id;
    assert.equal(
      calls.at(-1).body.token,
      undefined,
      'room credential must not be forwarded to gateway',
    );
    assert.equal(
      (await post('/' + scopedID, viewer, { janus: 'attach', plugin: 'janus.plugin.audiobridge' }))
        .status,
      200,
    );
    const hid = (
      await post('/' + sid, viewer, { janus: 'attach', plugin: 'janus.plugin.videoroom' })
    ).data.data.id;
    assert.equal((await post('/' + sid, other, { janus: 'destroy' })).status, 403);
    assert.equal(
      (await post('/' + sid, viewer, { janus: 'attach', plugin: 'janus.plugin.sip' })).status,
      403,
    );
    assert.equal(
      (
        await post(`/${sid}/${hid}`, viewer, {
          janus: 'message',
          body: { request: 'join', room: 202, ptype: 'publisher' },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await post(`/${sid}/${hid}`, viewer, {
          janus: 'message',
          body: { request: 'join', room: 102, ptype: 'publisher', display: 'screen-owner-p' },
        })
      ).status,
      200,
    );
    assert.equal(calls.at(-1).body.body.display, 'screen-viewer-p');
    const before = calls.length;
    assert.equal(
      (
        await post(`/${sid}/${hid}`, viewer, {
          janus: 'message',
          body: { request: 'configure', video: true },
          jsep: { type: 'offer', sdp: 'test' },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await post(`/${sid}/${hid}`, viewer, {
          janus: 'message',
          body: { request: 'rtp_forward', room: 102 },
        })
      ).status,
      403,
    );
    assert.equal(calls.length, before);
    const audio = (
      await post('/' + sid, viewer, { janus: 'attach', plugin: 'janus.plugin.audiobridge' })
    ).data.data.id;
    await post(`/${sid}/${audio}`, viewer, {
      janus: 'message',
      body: { request: 'join', room: 101, muted: false },
      apisecret: 'attacker-secret',
    });
    assert.equal(calls.at(-1).body.body.muted, true);
    assert.equal(calls.at(-1).body.apisecret, 'private-gateway-secret');
    db.prepare("UPDATE memberships SET role='1',flags=? WHERE id='viewer'").run(
      JSON.stringify({ hasScreen: false, hasMic: false }),
    );
    assert.equal(
      (
        await post(`/${sid}/${hid}`, viewer, {
          janus: 'message',
          body: { request: 'configure', video: true },
          jsep: { type: 'offer', sdp: 'test' },
        })
      ).status,
      403,
    );
    await post(`/${sid}/${audio}`, viewer, {
      janus: 'message',
      body: { request: 'configure', muted: false },
    });
    assert.equal(calls.at(-1).body.body.muted, true);
    db.prepare("UPDATE memberships SET flags='{}' WHERE id='viewer'").run();
    assert.equal(
      (
        await post(`/${sid}/${hid}`, viewer, {
          janus: 'message',
          body: { request: 'configure', video: true },
          jsep: { type: 'offer', sdp: 'test' },
        })
      ).status,
      200,
    );
    const ownerSession = (await post('', owner, { janus: 'create' })).data.data.id;
    const ownerHandle = (
      await post('/' + ownerSession, owner, { janus: 'attach', plugin: 'janus.plugin.videoroom' })
    ).data.data.id;
    assert.equal(
      (
        await post(`/${ownerSession}/${ownerHandle}`, owner, {
          janus: 'message',
          body: { request: 'join', room: 102, ptype: 'publisher' },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await post(`/${ownerSession}/${ownerHandle}`, owner, {
          janus: 'message',
          body: { request: 'configure', video: true },
          jsep: { type: 'offer', sdp: 'test' },
        })
      ).status,
      200,
    );
    db.prepare(
      "INSERT INTO realtime_obs_mounts(room_id,id,mount_id,video_port,audio_port,status,owner_uid) VALUES('one','obs-one',301,40000,40002,'waiting','owner'),('two','obs-two',302,40004,40006,'streaming','other')",
    ).run();
    const streaming = (
      await post('/' + sid, viewer, { janus: 'attach', plugin: 'janus.plugin.streaming' })
    ).data.data.id;
    assert.equal(
      (
        await post(`/${sid}/${streaming}`, viewer, {
          janus: 'message',
          body: { request: 'watch', id: 302 },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await post(`/${sid}/${streaming}`, viewer, {
          janus: 'message',
          body: { request: 'watch', id: 301 },
        })
      ).status,
      403,
    );
    db.prepare("UPDATE realtime_obs_mounts SET status='streaming' WHERE room_id='one'").run();
    assert.equal(
      (
        await post(`/${sid}/${streaming}`, viewer, {
          janus: 'message',
          body: { request: 'watch', id: 301 },
        })
      ).status,
      200,
    );
    assert.equal(
      (await post(`/${sid}/${streaming}`, viewer, { janus: 'message', body: { request: 'start' } }))
        .status,
      200,
    );
    db.prepare("DELETE FROM realtime_obs_mounts WHERE room_id IN ('one','two')").run();
    db.prepare("UPDATE memberships SET flags=? WHERE id='viewer'").run(
      JSON.stringify({ hasScreen: false }),
    );
    const deadline = Date.now() + 6500;
    while (
      !calls.some((c) => c.url.endsWith('/' + sid) && c.body.janus === 'destroy') &&
      Date.now() < deadline
    )
      await new Promise((r) => setTimeout(r, 50));
    assert.ok(
      calls.some((c) => c.url.endsWith('/' + sid) && c.body.janus === 'destroy'),
      'revoked live publisher must be disconnected upstream',
    );
  } finally {
    global.fetch = nativeFetch;
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
