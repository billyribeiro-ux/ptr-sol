const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ptr-relay-'));
process.env.YOUTUBE_RTMP_ENABLED = 'true';
process.env.MEDIA_PROCESSOR_URL = 'http://sidecar.test';
process.env.MEDIA_PROCESSOR_TOKEN = 'test';
process.env.JANUS_URL = 'http://janus.test/janus';
const db = require('../src/db/database');
require('../src/services/media');
const relay = require('../src/services/relay');
db.prepare(
  "INSERT INTO realtime_media_rooms(room_id,audio_id,video_id) VALUES ('room',101,102)",
).run();
test('RTMP relay manages real Janus forwarder lifecycle without storing stream key', async () => {
  const old = global.fetch,
    calls = [];
  global.fetch = async (url, options) => {
    const b = JSON.parse(options.body);
    calls.push({ url, body: b });
    let result = {};
    if (url.includes('/relay/reserve'))
      result = { success: true, videoPort: 30000, audioPort: 30002 };
    else if (url.includes('/relay/status')) result = { success: true, state: 'streaming' };
    else if (url.includes('/relay/')) result = { success: true, state: 'starting' };
    else if (b.janus === 'create') result = { janus: 'success', data: { id: 10 } };
    else if (b.janus === 'attach') result = { janus: 'success', data: { id: 20 } };
    else if (b.janus === 'message')
      result = {
        janus: 'success',
        plugindata: {
          data:
            b.body.request === 'rtp_forward'
              ? b.body.publisher_id
                ? { forwarders: [{ type: 'video', stream_id: 41 }] }
                : { stream_id: 42 }
              : {},
        },
      };
    else result = { janus: 'success' };
    return { ok: true, json: async () => result };
  };
  try {
    const started = await relay.start({
      roomID: 'room',
      provider: 'youtube',
      key: 'test-secret-key',
      publisherID: 1001,
      ownerUID: 'owner',
    });
    assert.equal(started.state, 'starting');
    let row = db.prepare("SELECT * FROM realtime_relays WHERE room_id='room'").get();
    assert.equal(JSON.stringify(row).includes('test-secret-key'), false);
    assert.equal(
      calls.find(
        (c) => c.body.body?.publisher_id === 1001 && c.body.body?.request === 'rtp_forward',
      ).body.body.video_port,
      30000,
    );
    assert.equal(await relay.status(row), 'streaming');
    row = db.prepare("SELECT * FROM realtime_relays WHERE room_id='room'").get();
    assert.equal(row.status, 'streaming');
    await relay.stop('room', 'youtube');
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM realtime_relays WHERE room_id='room'").get().n,
      0,
    );
    assert.equal(calls.filter((c) => c.body.body?.request === 'stop_rtp_forward').length, 2);
    assert.equal(calls.filter((c) => c.url.endsWith('/relay/stop')).length, 1);
  } finally {
    global.fetch = old;
  }
});
test('stream destinations reject arbitrary hosts, malformed keys and disabled providers', () => {
  assert.throws(() => relay.destination('youtube', 'x;touch /tmp/x'));
  assert.throws(() => relay.destination('facebook', 'valid-key'), /not configured/);
  process.env.STREAM_TEST_MODE = 'true';
  process.env.STREAM_LOCAL_TEST_BASE = 'rtmp://not-allowed.test/live/';
  assert.throws(() => relay.destination('youtube', 'valid-key'), /not allowed/);
  delete process.env.STREAM_TEST_MODE;
  delete process.env.STREAM_LOCAL_TEST_BASE;
});

test('status polling cannot misreport an in-progress normal stop as failure', async () => {
  const old = global.fetch;
  let release;
  db.prepare(
    "INSERT INTO realtime_relays(room_id,provider,id,publisher_id,status,owner_uid) VALUES ('room','youtube','8d75fb52-7916-4fb3-b7b5-96891ee658b6',1001,'streaming','owner')",
  ).run();
  const row = db.prepare("SELECT * FROM realtime_relays WHERE room_id='room'").get();
  global.fetch = async (url) => {
    if (url.endsWith('/relay/stop'))
      return await new Promise((resolve) => {
        release = () =>
          resolve({ ok: true, json: async () => ({ success: true, state: 'stopped' }) });
      });
    return { ok: true, json: async () => ({ success: true, state: 'missing' }) };
  };
  try {
    const stopping = relay.stop('room', 'youtube');
    await new Promise((r) => setImmediate(r));
    assert.equal(await relay.status(row), 'busy');
    release();
    await stopping;
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM realtime_relays WHERE room_id='room'").get().n,
      0,
    );
  } finally {
    global.fetch = old;
    db.prepare("DELETE FROM realtime_relays WHERE room_id='room'").run();
  }
});

test('stopping a relay succeeds when Janus already removed the publisher', async () => {
  const old = global.fetch;
  db.prepare(
    "INSERT INTO realtime_relays(room_id,provider,id,publisher_id,video_stream_id,audio_stream_id,status,owner_uid) VALUES ('room','youtube','8d75fb52-7916-4fb3-b7b5-96891ee658b6',1001,41,42,'streaming','owner')",
  ).run();
  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    let result;
    if (url.includes('/relay/stop')) result = { success: true, state: 'stopped' };
    else if (body.janus === 'create') result = { janus: 'success', data: { id: 10 } };
    else if (body.janus === 'attach') result = { janus: 'success', data: { id: 20 } };
    else if (body.janus === 'message')
      result = { janus: 'success', plugindata: { data: { error: 'No such publisher' } } };
    else result = { janus: 'success' };
    return { ok: true, json: async () => result };
  };
  try {
    await relay.stop('room', 'youtube');
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM realtime_relays WHERE room_id='room'").get().n,
      0,
    );
  } finally {
    global.fetch = old;
    db.prepare("DELETE FROM realtime_relays WHERE room_id='room'").run();
  }
});
