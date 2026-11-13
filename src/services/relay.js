// Managed outbound RTP -> RTMP relay. Stream keys live only in the sidecar
// request/process; they are not written to the database or returned to clients.
const crypto = require('crypto');
const db = require('../db/database');
const { URL } = require('url');
db.exec(
  `CREATE TABLE IF NOT EXISTS realtime_relays (room_id TEXT NOT NULL,provider TEXT NOT NULL,id TEXT NOT NULL UNIQUE,publisher_id INTEGER NOT NULL,video_stream_id INTEGER,audio_stream_id INTEGER,status TEXT NOT NULL,owner_uid TEXT NOT NULL,PRIMARY KEY(room_id,provider))`,
);
const locks = new Set();
function baseURL(provider, requestedURL) {
  const enabled =
    provider === 'youtube' ? process.env.YOUTUBE_RTMP_ENABLED : process.env.FACEBOOK_RTMP_ENABLED;
  if (enabled !== 'true')
    throw Error(`${provider === 'youtube' ? 'YouTube' : 'Facebook'} streaming is not configured`);
  const fallback =
    provider === 'youtube'
      ? 'rtmp://a.rtmp.youtube.com/live2/'
      : 'rtmps://live-api-s.facebook.com:443/rtmp/';
  const override =
    process.env.STREAM_TEST_MODE === 'true' ? process.env.STREAM_LOCAL_TEST_BASE : '';
  const url = new URL(requestedURL || override || fallback),
    port = url.port || (url.protocol === 'rtmps:' ? '443' : '1935');
  const official =
    provider === 'youtube'
      ? url.protocol === 'rtmp:' &&
        ['a.rtmp.youtube.com', 'b.rtmp.youtube.com'].includes(url.hostname) &&
        port === '1935'
      : url.protocol === 'rtmps:' && url.hostname === 'live-api-s.facebook.com' && port === '443';
  const local =
    process.env.STREAM_TEST_MODE === 'true' &&
    String(process.env.STREAM_LOCAL_ALLOWLIST || '')
      .split(',')
      .map((x) => x.trim())
      .includes(`${url.hostname}:${port}`);
  if (
    (!official && !local) ||
    !['rtmp:', 'rtmps:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw Error('Streaming destination is not allowed');
  return url.toString().replace(/\/+$/, '') + '/';
}
function destination(provider, key, requestedURL) {
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{4,256}$/.test(key))
    throw Error('Invalid stream key');
  return baseURL(provider, requestedURL) + key;
}
async function sidecar(action, body) {
  const base = (process.env.MEDIA_PROCESSOR_URL || '').replace(/\/$/, ''),
    token = process.env.MEDIA_PROCESSOR_TOKEN;
  if (!base || !token) throw Error('Media relay is not configured');
  const response = await fetch(base + '/relay/' + action, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(7000),
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw Error('Media relay failed');
  }
  if (!response.ok || (!data.success && !(action === 'status' && data.state === 'missing')))
    throw Error('Media relay failed');
  return data;
}
async function janus(plugin, body) {
  const url = (process.env.JANUS_URL || '').replace(/\/$/, '');
  if (!url) throw Error('Janus is not configured');
  const post = async (path, payload) => {
    const response = await fetch(url + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...payload,
        ...(process.env.JANUS_API_SECRET ? { apisecret: process.env.JANUS_API_SECRET } : {}),
        transaction: crypto.randomUUID(),
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw Error('Janus relay request failed');
    const result = await response.json(),
      data = result.plugindata?.data;
    if (result.janus !== 'success' || data?.error) {
      const error = Error('Janus relay request failed');
      error.notFound =
        /no such (?:room|feed|publisher|stream|forwarder)|not found|does not exist/i.test(
          String(data?.error || result.error?.reason || ''),
        );
      throw error;
    }
    return result;
  };
  let session;
  try {
    session = (await post('', { janus: 'create' })).data.id;
    const handle = (
      await post('/' + session, { janus: 'attach', plugin: 'janus.plugin.' + plugin })
    ).data.id;
    return (
      (await post('/' + session + '/' + handle, { janus: 'message', body })).plugindata?.data || {}
    );
  } finally {
    if (session) await post('/' + session, { janus: 'destroy' }).catch(() => {});
  }
}
async function start({ roomID, provider, key, publisherID, ownerUID }) {
  if (!['youtube', 'facebook'].includes(provider)) throw Error('Unsupported stream provider');
  const target = destination(provider, key),
    lock = roomID + ':' + provider;
  if (locks.has(lock)) throw Error('Streaming operation in progress');
  locks.add(lock);
  let id, videoStream, audioStream;
  const room = db.prepare('SELECT * FROM realtime_media_rooms WHERE room_id=?').get(roomID);
  try {
    if (!room || !Number.isSafeInteger(publisherID) || publisherID <= 0)
      throw Error('Active screen share is required');
    if (
      db
        .prepare('SELECT 1 FROM realtime_relays WHERE room_id=? AND provider=?')
        .get(roomID, provider)
    )
      throw Error('A stream is already active');
    id = crypto.randomUUID();
    const reservation = await sidecar('reserve', { id });
    db.prepare('INSERT INTO realtime_relays VALUES (?,?,?,?,?,?,?,?)').run(
      roomID,
      provider,
      id,
      publisherID,
      null,
      null,
      'provisioning',
      ownerUID,
    );
    await sidecar('start', { id, destination: target });
    const host = process.env.RELAY_RTP_HOST || 'media-processor';
    const video = await janus('videoroom', {
      request: 'rtp_forward',
      room: room.video_id,
      publisher_id: publisherID,
      host,
      video_port: reservation.videoPort,
      video_pt: 96,
    });
    videoStream =
      video.forwarders?.find((x) => x.type === 'video')?.stream_id ||
      video.rtp_stream?.video_stream_id;
    if (!videoStream) throw Error('Janus did not create a video forwarder');
    db.prepare('UPDATE realtime_relays SET video_stream_id=? WHERE id=?').run(videoStream, id);
    const audio = await janus('audiobridge', {
      request: 'rtp_forward',
      room: room.audio_id,
      host,
      port: reservation.audioPort,
      codec: 'opus',
      ptype: 111,
      always_on: true,
    });
    audioStream = audio.stream_id;
    if (!audioStream) throw Error('Janus did not create an audio forwarder');
    db.prepare("UPDATE realtime_relays SET audio_stream_id=?,status='starting' WHERE id=?").run(
      audioStream,
      id,
    );
    return { id, state: 'starting' };
  } catch (error) {
    let cleanupFailed = false;
    if (videoStream)
      await janus('videoroom', {
        request: 'stop_rtp_forward',
        room: room?.video_id,
        publisher_id: publisherID,
        stream_id: videoStream,
      }).catch(() => {
        cleanupFailed = true;
      });
    if (audioStream)
      await janus('audiobridge', {
        request: 'stop_rtp_forward',
        room: room?.audio_id,
        stream_id: audioStream,
      }).catch(() => {
        cleanupFailed = true;
      });
    if (id)
      await sidecar('stop', { id }).catch(() => {
        cleanupFailed = true;
      });
    if (id) {
      if (cleanupFailed)
        db.prepare("UPDATE realtime_relays SET status='cleanup_failed' WHERE id=?").run(id);
      else db.prepare('DELETE FROM realtime_relays WHERE id=?').run(id);
    }
    throw error;
  } finally {
    locks.delete(lock);
  }
}
async function stop(roomID, provider) {
  const lock = roomID + ':' + provider;
  if (locks.has(lock)) throw Error('Streaming operation in progress');
  locks.add(lock);
  try {
    const relay = db
      .prepare('SELECT * FROM realtime_relays WHERE room_id=? AND provider=?')
      .get(roomID, provider);
    if (!relay) return;
    const room = db.prepare('SELECT * FROM realtime_media_rooms WHERE room_id=?').get(roomID);
    const failures = [];
    if (room && relay.video_stream_id)
      try {
        await janus('videoroom', {
          request: 'stop_rtp_forward',
          room: room.video_id,
          publisher_id: relay.publisher_id,
          stream_id: relay.video_stream_id,
        });
      } catch (error) {
        if (!error.notFound) failures.push('video');
      }
    if (room && relay.audio_stream_id)
      try {
        await janus('audiobridge', {
          request: 'stop_rtp_forward',
          room: room.audio_id,
          stream_id: relay.audio_stream_id,
        });
      } catch (error) {
        if (!error.notFound) failures.push('audio');
      }
    try {
      await sidecar('stop', { id: relay.id });
    } catch (_) {
      failures.push('relay');
    }
    if (failures.length) throw Error('Could not stop streaming resources');
    db.prepare('DELETE FROM realtime_relays WHERE id=?').run(relay.id);
  } finally {
    locks.delete(lock);
  }
}
async function status(relay) {
  if (locks.has(relay.room_id + ':' + relay.provider)) return 'busy';
  if (
    (relay.status === 'provisioning' || relay.status === 'cleanup_failed') &&
    !locks.has(relay.room_id + ':' + relay.provider)
  )
    return 'failed';
  const result = await sidecar('status', { id: relay.id });
  if (result.state === 'streaming' && relay.status !== 'streaming')
    db.prepare("UPDATE realtime_relays SET status='streaming' WHERE id=?").run(relay.id);
  return result.state;
}
module.exports = { start, stop, status, destination };

db.exec(
  `CREATE TABLE IF NOT EXISTS realtime_obs_mounts (room_id TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, mount_id INTEGER NOT NULL UNIQUE, video_port INTEGER NOT NULL UNIQUE, audio_port INTEGER NOT NULL UNIQUE, status TEXT NOT NULL, owner_uid TEXT NOT NULL)`,
);
async function obsRequest(action, body) {
  const base = (process.env.MEDIA_PROCESSOR_URL || '').replace(/\/$/, ''),
    token = process.env.MEDIA_PROCESSOR_TOKEN;
  if (!base || !token) throw Error('OBS ingest is not configured');
  const response = await fetch(base + '/obs/' + action, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(7000),
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw Error('OBS ingest failed');
  }
  if (!response.ok || (!data.success && !(action === 'status' && data.state === 'missing')))
    throw Error('OBS ingest failed');
  return data;
}
db.exec(
  'CREATE TABLE IF NOT EXISTS realtime_obs_egress (room_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0)',
);
async function startOBS(roomID, ownerUID, options = {}) {
  if (process.env.OBS_INGEST_ENABLED !== 'true' || !process.env.OBS_PUBLIC_BASE)
    throw Error('OBS ingest is not configured');
  let publicBase;
  try {
    publicBase = new URL(process.env.OBS_PUBLIC_BASE);
  } catch {
    throw Error('OBS ingest URL is invalid');
  }
  if (
    publicBase.protocol !== 'rtmp:' ||
    publicBase.username ||
    publicBase.password ||
    publicBase.search ||
    publicBase.hash
  )
    throw Error('OBS ingest URL is invalid');
  const lock = roomID + ':obs';
  if (locks.has(lock)) throw Error('Streaming operation in progress');
  locks.add(lock);
  const id = crypto.randomUUID();
  let mountID, videoPort, audioPort;
  try {
    if (db.prepare('SELECT 1 FROM realtime_obs_mounts WHERE room_id=?').get(roomID))
      throw Error('OBS ingest is already active');
    for (let attempt = 0; attempt < 20; attempt++) {
      const base = crypto.randomInt(20000, 24500) * 2;
      videoPort = base;
      audioPort = base + 2;
      mountID = crypto.randomInt(100000, 2147483647);
      if (
        db
          .prepare(
            'SELECT 1 FROM realtime_obs_mounts WHERE video_port IN (?,?) OR audio_port IN (?,?)',
          )
          .get(videoPort, audioPort, videoPort, audioPort)
      )
        continue;
      try {
        const result = await janus('streaming', {
          request: 'create',
          type: 'rtp',
          id: mountID,
          description: 'OBS ingest',
          is_private: true,
          permanent: false,
          audio: true,
          audioport: audioPort,
          audiopt: 111,
          audiocodec: 'opus',
          video: true,
          videoport: videoPort,
          videopt: 96,
          videocodec: 'vp8',
        });
        if (result.streaming !== 'created') throw Error('OBS mount was not created');
        break;
      } catch (error) {
        if (attempt === 19) throw Error('Could not provision OBS mount');
        mountID = null;
      }
    }
    if (!mountID) throw Error('Could not allocate OBS mount');
    const target = options.youtubeKey
      ? destination('youtube', options.youtubeKey, options.youtubeURL || undefined)
      : undefined;
    const result = await obsRequest('start', {
      id,
      videoPort,
      audioPort,
      ...(target ? { destination: target } : {}),
    });
    db.prepare(
      'INSERT INTO realtime_obs_mounts (room_id,id,mount_id,video_port,audio_port,status,owner_uid) VALUES (?,?,?,?,?,?,?)',
    ).run(roomID, id, mountID, videoPort, audioPort, 'waiting', ownerUID);
    db.prepare('INSERT OR REPLACE INTO realtime_obs_egress VALUES (?,?)').run(
      roomID,
      target ? 1 : 0,
    );
    return {
      id,
      mountID,
      state: 'waiting',
      publishURL: publicBase.toString().replace(/\/+$/, '') + '/' + result.publishPath,
    };
  } catch (error) {
    if (mountID) await janus('streaming', { request: 'destroy', id: mountID }).catch(() => {});
    await obsRequest('stop', { id }).catch(() => {});
    throw error;
  } finally {
    locks.delete(lock);
  }
}
async function stopOBS(roomID) {
  const lock = roomID + ':obs';
  if (locks.has(lock)) throw Error('Streaming operation in progress');
  locks.add(lock);
  try {
    const row = db.prepare('SELECT * FROM realtime_obs_mounts WHERE room_id=?').get(roomID);
    if (!row) return;
    const failures = [];
    try {
      await obsRequest('stop', { id: row.id });
    } catch (_) {
      failures.push('ingest');
    }
    try {
      await janus('streaming', { request: 'destroy', id: row.mount_id });
    } catch (error) {
      if (!error.notFound) failures.push('mount');
    }
    if (failures.length) throw Error('Could not stop OBS ingest');
    db.prepare('DELETE FROM realtime_obs_mounts WHERE room_id=?').run(roomID);
    db.prepare('DELETE FROM realtime_obs_egress WHERE room_id=?').run(roomID);
  } finally {
    locks.delete(lock);
  }
}
async function obsStatus(row) {
  if (locks.has(row.room_id + ':obs')) return 'busy';
  const result = await obsRequest('status', { id: row.id });
  if (result.state !== row.status)
    db.prepare('UPDATE realtime_obs_mounts SET status=? WHERE id=?').run(result.state, row.id);
  return result.state;
}
module.exports.startOBS = startOBS;
module.exports.stopOBS = stopOBS;
module.exports.obsStatus = obsStatus;
