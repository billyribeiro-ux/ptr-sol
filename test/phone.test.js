const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const dgram = require('node:dgram');
const WebSocket = require('ws');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ptr-phone-'));
const db = require('../src/db/database');
require('../src/services/media');
const phone = require('../src/services/phone');

test('phone calls bridge PCMU in both directions with signed WebSocket and hang up', async () => {
  db.prepare(
    "INSERT INTO users(id,name,email,password_hash) VALUES('owner','Owner','phone@test.invalid','x')",
  ).run();
  db.prepare(
    "INSERT INTO sessions(uuid,owner_id,name,settings) VALUES('room','owner','Room',?)",
  ).run(
    JSON.stringify({
      twillioApiSID: 'AC' + 'a'.repeat(32),
      twillioApiToken: 'secret',
      twilioPhone: '+12025550100',
    }),
  );
  db.prepare(
    "INSERT INTO realtime_media_rooms(room_id,audio_id,video_id) VALUES('room',101,102)",
  ).run();
  const server = http.createServer(),
    rtp = dgram.createSocket('udp4');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve) => rtp.bind(0, '127.0.0.1', resolve));
  phone.attachTelephonyServer(server);
  Object.assign(process.env, {
    TWILIO_VOICE_ENABLED: 'true',
    PHONE_PUBLIC_WSS_BASE: 'wss://phone.example.test',
    PHONE_RTP_HOST: '127.0.0.1',
    JANUS_URL: 'http://127.0.0.1/janus',
  });
  const original = global.fetch;
  let streamURL,
    transaction,
    appPort,
    terminated = 0,
    joinRequest;
  global.fetch = async (url, options = {}) => {
    url = String(url);
    if (url.startsWith('https://api.twilio.com/')) {
      const body = new URLSearchParams(options.body);
      if (body.get('Status') === 'completed') terminated++;
      else streamURL = body.get('Twiml').match(/url="([^"]+)"/)[1];
      return new Response(JSON.stringify({ sid: 'CA' + 'b'.repeat(32), status: 'queued' }));
    }
    if (!url.startsWith('http://127.0.0.1/janus')) throw Error('unexpected fetch');
    if (!options.method) {
      return new Response(
        JSON.stringify({
          transaction,
          plugindata: {
            data: { audiobridge: 'joined', rtp: { ip: '127.0.0.1', port: rtp.address().port } },
          },
        }),
      );
    }
    const b = JSON.parse(options.body);
    let result = { janus: 'success' };
    if (b.janus === 'create') result.data = { id: 1 };
    if (b.janus === 'attach') result.data = { id: 2 };
    if (b.janus === 'message') {
      joinRequest = b.body;
      transaction = b.transaction;
      appPort = b.body.rtp.port;
      result = { janus: 'ack' };
    }
    return new Response(JSON.stringify(result));
  };
  try {
    const result = await phone.start({ roomID: 'room', origID: 12, number: '2025550101' });
    assert.equal(result.status, 'initiated');
    const target = new URL(streamURL);
    const bad = new WebSocket(`ws://127.0.0.1:${server.address().port}${target.pathname}`, {
      headers: { 'X-Twilio-Signature': 'wrong' },
    });
    await new Promise((resolve) => {
      bad.once('error', resolve);
      bad.once('open', () => {
        bad.close();
        assert.fail('invalid signature was accepted');
      });
    });
    const signature = crypto.createHmac('sha1', 'secret').update(streamURL).digest('base64');
    const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}${target.pathname}`, {
      headers: { 'X-Twilio-Signature': signature },
    });
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    ws.send(
      JSON.stringify({
        event: 'start',
        start: { streamSid: 'MZ' + 'c'.repeat(32), callSid: 'CA' + 'b'.repeat(32) },
      }),
    );
    for (let i = 0; !appPort && i < 100; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(joinRequest.codec, 'pcmu');
    assert.equal(joinRequest.room, 101);
    // Give Janus join completion time before sending caller audio.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const incoming = new Promise((resolve) => rtp.once('message', resolve));
    ws.send(
      JSON.stringify({
        event: 'media',
        streamSid: 'MZ' + 'c'.repeat(32),
        media: { payload: Buffer.alloc(160, 42).toString('base64') },
      }),
    );
    const received = await Promise.race([
      incoming,
      new Promise((_, reject) => setTimeout(() => reject(Error('RTP timeout')), 1000)),
    ]);
    assert.equal(received[1], 0);
    assert.deepEqual(received.subarray(12), Buffer.alloc(160, 42));
    const response = new Promise((resolve) =>
      ws.once('message', (raw) => resolve(JSON.parse(raw))),
    );
    const packet = Buffer.concat([
      Buffer.from([0x80, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
      Buffer.alloc(160, 77),
    ]);
    rtp.send(packet, appPort, '127.0.0.1');
    assert.deepEqual(Buffer.from((await response).media.payload, 'base64'), Buffer.alloc(160, 77));
    await phone.stop('room', 12);
    assert.equal(terminated, 1);
    let resolveCall;
    global.fetch = async (url, options) => {
      const body = new URLSearchParams(options.body);
      if (body.get('Status') === 'completed') {
        terminated++;
        return new Response(JSON.stringify({ sid: 'CA' + 'd'.repeat(32) }));
      }
      return new Promise((resolve) => {
        resolveCall = resolve;
      });
    };
    const starting = phone.start({ roomID: 'room', origID: 13, number: '2025550101' });
    const startingResult = starting.then(
      () => null,
      (error) => error,
    );
    const stopping = phone.stopRoom('room');
    let finished = false;
    stopping.then(() => {
      finished = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(finished, false);
    resolveCall(new Response(JSON.stringify({ sid: 'CA' + 'd'.repeat(32), status: 'queued' })));
    await stopping;
    assert.match((await startingResult).message, /cancelled/);
    assert.equal(terminated, 2);
    global.fetch = async (url, options) => {
      if (options.method === 'GET')
        return new Response(JSON.stringify({ sid: 'CA' + 'e'.repeat(32), status: 'completed' }));
      if (new URLSearchParams(options.body).has('Status'))
        return new Response('{}', { status: 400 });
      return new Response(JSON.stringify({ sid: 'CA' + 'e'.repeat(32), status: 'queued' }));
    };
    await phone.start({ roomID: 'room', origID: 14, number: '2025550101' });
    assert.equal(await phone.stop('room', 14), true);
  } finally {
    global.fetch = original;
    await phone.stopRoom('room');
    rtp.close();
    server.close();
    for (const name of [
      'TWILIO_VOICE_ENABLED',
      'PHONE_PUBLIC_WSS_BASE',
      'PHONE_RTP_HOST',
      'JANUS_URL',
    ])
      delete process.env[name];
  }
});
