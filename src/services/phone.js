// A reconstructed Twilio Voice adapter. Calls are disabled unless explicitly
// configured. Only the internal Janus gateway is used as the RTP peer.
const crypto = require('node:crypto');
const dgram = require('node:dgram');
const dns = require('node:dns/promises');
const { WebSocketServer } = require('ws');
const db = require('../db/database');
const { json } = require('./serializers');

const calls = new Map();
let attached = 0;
const key = (room, id) => `${room}:${id}`;
function tx() {
  return crypto.randomBytes(12).toString('hex');
}
function enabled() {
  return process.env.TWILIO_VOICE_ENABLED === 'true';
}
function settings(roomID) {
  const row = db
    .prepare('SELECT settings FROM sessions WHERE uuid=? AND is_archived_room=0')
    .get(roomID);
  if (!row) throw Error('Room not found.');
  const s = json(row.settings),
    sid = s.twillioApiSID || process.env.TWILIO_ACCOUNT_SID,
    secret = s.twillioApiToken || process.env.TWILIO_AUTH_TOKEN;
  const from = phone(s.twilioPhone || process.env.TWILIO_PHONE || '');
  const base = process.env.PHONE_PUBLIC_WSS_BASE;
  if (
    !enabled() ||
    !attached ||
    !/^AC[a-f0-9]{32}$/i.test(sid || '') ||
    !secret ||
    !from ||
    !base ||
    !process.env.PHONE_RTP_HOST ||
    !process.env.JANUS_URL
  )
    throw Error('Telephone provider is not configured.');
  let parsed;
  try {
    parsed = new URL(base);
  } catch {
    throw Error('Phone WebSocket address is invalid.');
  }
  if (
    parsed.protocol !== 'wss:' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== '/'
  )
    throw Error('Phone WebSocket address is invalid.');
  return { sid, secret, from, base: parsed.origin };
}
function phone(value) {
  const raw = String(value).replace(/[\s().-]/g, '');
  return /^\+[1-9]\d{7,14}$/.test(raw) ? raw : /^\d{10}$/.test(raw) ? '+1' + raw : null;
}
async function provider(call, body) {
  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${call.sid}/Calls${call.callSid ? '/' + call.callSid : ''}.json`,
    {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
      headers: {
        authorization: 'Basic ' + Buffer.from(call.sid + ':' + call.secret).toString('base64'),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(body),
    },
  );
  let result = {};
  try {
    const raw = await response.text();
    if (raw.length > 65536) throw Error();
    result = JSON.parse(raw);
  } catch {}
  if (!response.ok || !/^CA[a-f0-9]{32}$/i.test(result.sid || ''))
    throw Error('Telephone provider did not confirm the request.');
  return result;
}
async function endCall(call) {
  try {
    return await provider(call, { Status: 'completed' });
  } catch (error) {
    // The provider may have already ended the call before the stream closes.
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${call.sid}/Calls/${call.callSid}.json`,
      {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
        headers: {
          authorization: 'Basic ' + Buffer.from(call.sid + ':' + call.secret).toString('base64'),
        },
      },
    );
    let state;
    try {
      state = await response.json();
    } catch {}
    if (
      response.ok &&
      state?.sid === call.callSid &&
      ['completed', 'failed', 'busy', 'no-answer', 'canceled'].includes(state.status)
    )
      return state;
    throw error;
  }
}
async function start({ roomID, origID, number }) {
  const config = settings(roomID);
  const id = String(origID);
  if (!/^\d{1,10}$/.test(id)) throw Error('Invalid call identifier.');
  const to = phone(number);
  if (!to) throw Error('Invalid telephone number.');
  const k = key(roomID, id);
  if (calls.has(k)) throw Error('Call identifier already in use.');
  if (calls.size >= 100 || [...calls.values()].filter((c) => c.roomID === roomID).length >= 10)
    throw Error('Telephone call limit reached.');
  const token = crypto.randomBytes(24).toString('hex'),
    call = { ...config, roomID, id, token, callSid: null, closed: false };
  calls.set(k, call);
  const url = config.base + '/phone/' + token;
  call.ready = provider(call, {
    To: to,
    From: config.from,
    Twiml: `<Response><Connect><Stream url="${url}" /></Connect></Response>`,
  }).then((result) => {
    call.callSid = result.sid;
    return result;
  });
  try {
    await call.ready;
    if (call.closed) throw Error('Call was cancelled.');
    call.timer = setTimeout(() => stop(roomID, id).catch(() => {}), 120000);
    call.timer.unref();
    return { orig_id: id, status: 'initiated' };
  } catch (error) {
    if (!call.stopping) calls.delete(k);
    closeMedia(call);
    throw error;
  }
}
function closeMedia(call) {
  clearTimeout(call.timer);
  clearInterval(call.keepalive);
  call.closed = true;
  if (call.ws)
    try {
      call.ws.close();
    } catch {}
  if (call.socket)
    try {
      call.socket.close();
    } catch {}
  if (call.janusSession) janus(call, '/' + call.janusSession, { janus: 'destroy' }).catch(() => {});
}
async function stop(roomID, id) {
  const k = key(roomID, String(id)),
    call = calls.get(k);
  if (!call) return false;
  if (call.stopping) return call.stopping;
  call.stopping = (async () => {
    closeMedia(call);
    try {
      await call.ready;
    } catch {
      throw Error(
        'Call initiation outcome is unknown; verify the provider before removing the room.',
      );
    }
    if (call.callSid) await endCall(call);
    calls.delete(k);
    return true;
  })();
  try {
    return await call.stopping;
  } catch (error) {
    call.stopping = null;
    throw error;
  }
}
async function stopRoom(roomID) {
  for (const call of [...calls.values()]) if (call.roomID === roomID) await stop(roomID, call.id);
}
async function janus(call, path, body) {
  const response = await fetch(process.env.JANUS_URL.replace(/\/$/, '') + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...body,
      transaction: tx(),
      ...(process.env.JANUS_API_SECRET ? { apisecret: process.env.JANUS_API_SECRET } : {}),
    }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw Error('Janus unavailable.');
  const result = await response.json();
  if (result.janus === 'error' || result.plugindata?.data?.error)
    throw Error('Janus rejected the phone bridge.');
  return result;
}
async function join(call) {
  const row = db
    .prepare('SELECT audio_id FROM realtime_media_rooms WHERE room_id=?')
    .get(call.roomID);
  if (!row) throw Error('Audio room is unavailable.');
  const appIP = (await dns.lookup(process.env.PHONE_RTP_HOST, { family: 4 })).address;
  call.janusIP = (await dns.lookup(new URL(process.env.JANUS_URL).hostname, { family: 4 })).address;
  const socket = dgram.createSocket('udp4');
  call.socket = socket;
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    socket.once('error', onError);
    socket.bind(0, '0.0.0.0', () => {
      socket.removeListener('error', onError);
      resolve();
    });
  });
  socket.on('error', () => stop(call.roomID, call.id).catch(() => {}));
  const session = await janus(call, '', { janus: 'create' });
  call.janusSession = session.data.id;
  if (call.closed) {
    await janus(call, '/' + call.janusSession, { janus: 'destroy' }).catch(() => {});
    throw Error('Call ended.');
  }
  call.keepalive = setInterval(
    () =>
      janus(call, '/' + call.janusSession, { janus: 'keepalive' }).catch(() =>
        stop(call.roomID, call.id).catch(() => {}),
      ),
    25000,
  );
  call.keepalive.unref();
  const handle = (
    await janus(call, '/' + call.janusSession, {
      janus: 'attach',
      plugin: 'janus.plugin.audiobridge',
    })
  ).data.id;
  const transaction = tx(),
    url = process.env.JANUS_URL.replace(/\/$/, '');
  const response = await fetch(url + '/' + call.janusSession + '/' + handle, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      janus: 'message',
      transaction,
      ...(process.env.JANUS_API_SECRET ? { apisecret: process.env.JANUS_API_SECRET } : {}),
      body: {
        request: 'join',
        room: row.audio_id,
        display: 'phone-' + call.id,
        codec: 'pcmu',
        rtp: { ip: appIP, port: socket.address().port },
      },
    }),
    signal: AbortSignal.timeout(5000),
  });
  const ack = await response.json();
  if (!response.ok || ack.janus !== 'ack') throw Error('Audio bridge did not accept the call.');
  let joined;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && !call.closed) {
    const p = new URL(url + '/' + call.janusSession);
    p.searchParams.set('rid', String(Date.now()));
    if (process.env.JANUS_API_SECRET) p.searchParams.set('apisecret', process.env.JANUS_API_SECRET);
    const event = await (await fetch(p, { signal: AbortSignal.timeout(11000) })).json();
    if (event.transaction === transaction) {
      joined = event.plugindata?.data;
      break;
    }
  }
  if (call.closed || !joined || joined.error || !joined.rtp?.port)
    throw Error('Audio bridge did not join the call.');
  call.remotePort = joined.rtp.port;
  call.seq = crypto.randomInt(65536);
  call.timestamp = crypto.randomBytes(4).readUInt32BE();
  call.ssrc = crypto.randomBytes(4).readUInt32BE();
  socket.on('message', (packet, remote) => {
    if (
      call.closed ||
      !call.streamSid ||
      remote.address !== call.janusIP ||
      packet.length < 12 ||
      packet[0] >> 6 !== 2 ||
      (packet[1] & 127) !== 0
    )
      return;
    let offset = 12 + 4 * (packet[0] & 15);
    if (packet[0] & 16) {
      if (packet.length < offset + 4) return;
      offset += 4 + packet.readUInt16BE(offset + 2) * 4;
    }
    if (offset >= packet.length) return;
    const padding = packet[0] & 32 ? packet[packet.length - 1] : 0;
    if (padding > packet.length - offset) return;
    const payload = packet.subarray(offset, packet.length - padding);
    if (payload.length && payload.length <= 1600 && call.ws?.readyState === 1)
      call.ws.send(
        JSON.stringify({
          event: 'media',
          streamSid: call.streamSid,
          media: { payload: payload.toString('base64') },
        }),
      );
  });
}
function media(call, value) {
  if (!call.remotePort || !call.socket) return;
  if (typeof value !== 'string' || value.length > 4096 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value))
    return;
  const data = Buffer.from(value, 'base64');
  if (!data.length || data.length > 1600) return;
  const header = Buffer.alloc(12);
  header[0] = 0x80;
  header[1] = 0;
  header.writeUInt16BE(call.seq, 2);
  header.writeUInt32BE(call.timestamp, 4);
  header.writeUInt32BE(call.ssrc, 8);
  call.seq = (call.seq + 1) & 65535;
  call.timestamp = (call.timestamp + data.length) >>> 0;
  call.socket.send(Buffer.concat([header, data]), call.remotePort, call.janusIP, () => {});
}
function validSignature(call, signature) {
  if (typeof signature !== 'string') return false;
  const expected = crypto
    .createHmac('sha1', call.secret)
    .update(call.base + '/phone/' + call.token)
    .digest('base64');
  const a = Buffer.from(signature),
    b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function attachTelephonyServer(server) {
  attached++;
  server.once('close', () => {
    attached = Math.max(0, attached - 1);
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8192, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    const match = /^\/phone\/([a-f0-9]{48})$/.exec(req.url || '');
    if (!match) return;
    const call = [...calls.values()].find((c) => c.token === match[1]);
    if (!call || call.ws || !validSignature(call, req.headers['x-twilio-signature'])) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      call.ws = ws;
      clearTimeout(call.timer);
      ws.on('message', async (raw) => {
        let event;
        try {
          event = JSON.parse(raw);
        } catch {
          return ws.close();
        }
        if (event.event === 'start') {
          if (call.starting || !/^MZ[a-f0-9]{32}$/i.test(event.start?.streamSid || ''))
            return ws.close();
          call.starting = true;
          for (let n = 0; !call.callSid && !call.closed && n < 100; n++)
            await new Promise((resolve) => setTimeout(resolve, 50));
          if (call.closed || event.start?.callSid !== call.callSid) return ws.close();
          call.streamSid = event.start.streamSid;
          join(call).catch(() => stop(call.roomID, call.id).catch(() => {}));
        } else if (event.event === 'media' && event.streamSid === call.streamSid)
          media(call, event.media?.payload);
        else if (event.event === 'stop') stop(call.roomID, call.id).catch(() => {});
      });
      ws.on('close', () => stop(call.roomID, call.id).catch(() => {}));
      ws.on('error', () => stop(call.roomID, call.id).catch(() => {}));
    });
  });
  return wss;
}
module.exports = { start, stop, stopRoom, attachTelephonyServer };
