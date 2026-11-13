// Janus' HTTP API is used to create stable, numeric rooms before clients join.
const crypto = require('crypto');
const db = require('../db/database');
db.exec(
  `CREATE TABLE IF NOT EXISTS realtime_media_rooms (room_id TEXT PRIMARY KEY, audio_id INTEGER NOT NULL, video_id INTEGER NOT NULL)`,
);
const pending = new Map();
function ids(roomID) {
  let row = db
    .prepare('SELECT audio_id, video_id FROM realtime_media_rooms WHERE room_id=?')
    .get(roomID);
  if (!row) {
    // 31-bit identifiers work with all supported Janus builds.
    const num = () => crypto.randomInt(100000, 2147483647);
    db.prepare('INSERT OR IGNORE INTO realtime_media_rooms VALUES (?, ?, ?)').run(
      roomID,
      num(),
      num(),
    );
    row = db
      .prepare('SELECT audio_id, video_id FROM realtime_media_rooms WHERE room_id=?')
      .get(roomID);
  }
  return row;
}
async function provision(roomID, { audioEnabled = true } = {}) {
  if (pending.has(roomID)) return pending.get(roomID);
  const work = (async () => {
    const room = ids(roomID);
    const url = (process.env.JANUS_URL || '').replace(/\/$/, '');
    if (!url) return { ...room, ready: false, streamServer: '' };
    const tx = () => crypto.randomBytes(12).toString('hex');
    const post = async (path, body) => {
      const response = await fetch(url + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...body,
          ...(process.env.JANUS_API_SECRET ? { apisecret: process.env.JANUS_API_SECRET } : {}),
          transaction: tx(),
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error(`Janus HTTP ${response.status}`);
      const result = await response.json();
      if (result.janus === 'error') throw new Error(result.error?.reason || 'Janus error');
      return result;
    };
    let session;
    try {
      session = (await post('', { janus: 'create' })).data.id;
      for (const [plugin, id] of [
        ...(audioEnabled ? [['audiobridge', room.audio_id]] : []),
        ['videoroom', room.video_id],
      ]) {
        const handle = (
          await post('/' + session, { janus: 'attach', plugin: 'janus.plugin.' + plugin })
        ).data.id;
        const res = await post('/' + session + '/' + handle, {
          janus: 'message',
          body: {
            request: 'create',
            room: id,
            description: roomID,
            permanent: false,
            ...(plugin === 'videoroom'
              ? { fir_freq: 2 }
              : {
                  ...(process.env.TWILIO_VOICE_ENABLED === 'true'
                    ? { allow_rtp_participants: true }
                    : {}),
                }),
          },
        });
        const err = res.plugindata?.data?.error;
        if (err && !/already exists/i.test(err)) throw new Error(err);
        if (err && plugin === 'videoroom') {
          const edited = await post('/' + session + '/' + handle, {
            janus: 'message',
            body: { request: 'edit', room: id, new_fir_freq: 2 },
          });
          if (edited.plugindata?.data?.error) throw Error(edited.plugindata.data.error);
        }
      }
      return {
        ...room,
        ready: audioEnabled,
        videoReady: true,
        streamServer: process.env.JANUS_PUBLIC_URL || process.env.JANUS_URL || '',
      };
    } finally {
      if (session) await post('/' + session, { janus: 'destroy' }).catch(() => {});
    }
  })()
    .catch(() => ({ ...ids(roomID), ready: false, streamServer: '' }))
    .finally(() => pending.delete(roomID));
  pending.set(roomID, work);
  return work;
}
module.exports = { provision };

// AudioBridge writes a real mixed WAV to a volume shared with the application.
// It is only published after Janus closes the file and a nonempty WAV exists.
async function audioRecording(roomID, id, enabled) {
  const url = (process.env.JANUS_URL || '').replace(/\/$/, '');
  if (!url) throw new Error('Janus is not configured');
  const tx = () => crypto.randomBytes(12).toString('hex');
  const post = async (path, body) => {
    const response = await fetch(url + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...body,
        ...(process.env.JANUS_API_SECRET ? { apisecret: process.env.JANUS_API_SECRET } : {}),
        transaction: tx(),
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error('Janus is unavailable');
    const result = await response.json();
    if (result.janus === 'error' || result.plugindata?.data?.error)
      throw new Error(result.error?.reason || result.plugindata.data.error);
    if (result.janus !== 'success') throw new Error('Janus did not confirm the recording request');
    return result;
  };
  let session;
  try {
    session = (await post('', { janus: 'create' })).data.id;
    const handle = (
      await post('/' + session, { janus: 'attach', plugin: 'janus.plugin.audiobridge' })
    ).data.id;
    const file = require('path').join(
      process.env.JANUS_RECORDINGS_DIR || process.env.RECORDINGS_DIR || '/app/data/recordings',
      id + '/audio.wav',
    );
    await post('/' + session + '/' + handle, {
      janus: 'message',
      body: {
        request: 'enable_recording',
        room: ids(roomID).audio_id,
        record: enabled,
        ...(enabled ? { record_file: file } : {}),
      },
    });
    return file;
  } finally {
    if (session) await post('/' + session, { janus: 'destroy' }).catch(() => {});
  }
}
module.exports.audioRecording = audioRecording;

async function videoRecording(roomID, directory, enabled) {
  const url = (process.env.JANUS_URL || '').replace(/\/$/, '');
  if (!url) throw new Error('Janus is not configured');
  const post = async (path, body) => {
    const response = await fetch(url + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...body,
        ...(process.env.JANUS_API_SECRET ? { apisecret: process.env.JANUS_API_SECRET } : {}),
        transaction: crypto.randomBytes(12).toString('hex'),
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error('Janus is unavailable');
    const result = await response.json();
    if (result.janus !== 'success' || result.plugindata?.data?.error)
      throw new Error(
        result.error?.reason || result.plugindata?.data?.error || 'Janus did not confirm request',
      );
    return result;
  };
  let session;
  try {
    session = (await post('', { janus: 'create' })).data.id;
    const handle = (
      await post('/' + session, { janus: 'attach', plugin: 'janus.plugin.videoroom' })
    ).data.id;
    const plugin = (body) => post('/' + session + '/' + handle, { janus: 'message', body });
    if (enabled)
      await plugin({ request: 'edit', room: ids(roomID).video_id, new_rec_dir: directory });
    await plugin({ request: 'enable_recording', room: ids(roomID).video_id, record: enabled });
  } finally {
    if (session) await post('/' + session, { janus: 'destroy' }).catch(() => {});
  }
}
module.exports.videoRecording = videoRecording;
async function publisherOwned(roomID, publisherId, display) {
  const url = (process.env.JANUS_URL || '').replace(/\/$/, '');
  if (!url) return false;
  const post = async (path, body) => {
    const response = await fetch(url + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...body,
        ...(process.env.JANUS_API_SECRET ? { apisecret: process.env.JANUS_API_SECRET } : {}),
        transaction: crypto.randomBytes(12).toString('hex'),
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error('Janus unavailable');
    const data = await response.json();
    if (data.janus !== 'success' || data.plugindata?.data?.error)
      throw new Error('Janus request failed');
    return data;
  };
  let session;
  try {
    session = (await post('', { janus: 'create' })).data.id;
    const handle = (
      await post('/' + session, { janus: 'attach', plugin: 'janus.plugin.videoroom' })
    ).data.id;
    const result = await post('/' + session + '/' + handle, {
      janus: 'message',
      body: { request: 'listparticipants', room: ids(roomID).video_id },
    });
    return (result.plugindata?.data?.participants || []).some(
      (p) => Number(p.id) === Number(publisherId) && p.display === display && p.publisher === true,
    );
  } catch (_) {
    return false;
  } finally {
    if (session) await post('/' + session, { janus: 'destroy' }).catch(() => {});
  }
}
module.exports.publisherOwned = publisherOwned;
// Revoke active Janus publishers when a participant is banned or demoted.
async function evictUser(roomID, uid) {
  const url = (process.env.JANUS_URL || '').replace(/\/$/, '');
  if (!url) return;
  const post = async (path, body) => {
    const response = await fetch(url + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...body,
        ...(process.env.JANUS_API_SECRET ? { apisecret: process.env.JANUS_API_SECRET } : {}),
        transaction: crypto.randomBytes(12).toString('hex'),
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw Error('Janus unavailable');
    const result = await response.json();
    if (result.janus !== 'success' || result.plugindata?.data?.error)
      throw Error(result.error?.reason || result.plugindata?.data?.error || 'Janus request failed');
    return result;
  };
  const room = ids(roomID);
  let session;
  try {
    session = (await post('', { janus: 'create' })).data.id;
    for (const [plugin, id, names] of [
      ['videoroom', room.video_id, [`screen-${uid}-p`, `webcam-${uid}`]],
      ['audiobridge', room.audio_id, [uid]],
    ]) {
      const handle = (
        await post('/' + session, { janus: 'attach', plugin: 'janus.plugin.' + plugin })
      ).data.id;
      const request = (body) => post('/' + session + '/' + handle, { janus: 'message', body });
      const participants =
        (await request({ request: 'listparticipants', room: id })).plugindata?.data?.participants ||
        [];
      for (const p of participants)
        if (names.includes(p.display)) await request({ request: 'kick', room: id, id: p.id });
    }
  } finally {
    if (session) await post('/' + session, { janus: 'destroy' }).catch(() => {});
  }
}
module.exports.evictUser = evictUser;
async function resetAudio(roomID, stop = false) {
  const url = (process.env.JANUS_URL || '').replace(/\/$/, '');
  if (!url) throw Error('Janus is not configured');
  const post = async (path, body) => {
    const r = await fetch(url + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...body,
        ...(process.env.JANUS_API_SECRET ? { apisecret: process.env.JANUS_API_SECRET } : {}),
        transaction: crypto.randomBytes(12).toString('hex'),
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) throw Error('Janus unavailable');
    const result = await r.json();
    if (result.janus !== 'success' || result.plugindata?.data?.error)
      throw Error(result.error?.reason || result.plugindata?.data?.error || 'Janus request failed');
    return result;
  };
  const old = ids(roomID),
    next = crypto.randomInt(100000, 2147483647);
  let sid;
  try {
    sid = (await post('', { janus: 'create' })).data.id;
    const h = (await post('/' + sid, { janus: 'attach', plugin: 'janus.plugin.audiobridge' })).data
      .id;
    const call = (body) => post('/' + sid + '/' + h, { janus: 'message', body });
    if (!stop)
      await call({
        request: 'create',
        room: next,
        description: roomID,
        permanent: false,
        ...(process.env.TWILIO_VOICE_ENABLED === 'true' ? { allow_rtp_participants: true } : {}),
      });
    try {
      await call({ request: 'destroy', room: old.audio_id });
    } catch (error) {
      if (!/no such room|not found/i.test(error.message)) {
        if (!stop) await call({ request: 'destroy', room: next }).catch(() => {});
        throw error;
      }
    }
    if (!stop)
      db.prepare('UPDATE realtime_media_rooms SET audio_id=? WHERE room_id=?').run(next, roomID);
    return {
      audio_id: stop ? old.audio_id : next,
      video_id: old.video_id,
      ready: !stop,
      videoReady: true,
      streamServer: process.env.JANUS_PUBLIC_URL || process.env.JANUS_URL || '',
    };
  } finally {
    if (sid) await post('/' + sid, { janus: 'destroy' }).catch(() => {});
  }
}
module.exports.resetAudio = resetAudio;
// Remove the two Janus rooms associated with a deleted session. Existing
// mappings from offline provisioning are harmless when no gateway is configured.
async function destroyRoom(roomID) {
  if (pending.has(roomID)) await pending.get(roomID);
  const row = db.prepare('SELECT * FROM realtime_media_rooms WHERE room_id=?').get(roomID);
  if (!row) return;
  const url = (process.env.JANUS_URL || '').replace(/\/$/, '');
  if (!url) return;
  const post = async (path, body) => {
    const response = await fetch(url + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...body,
        ...(process.env.JANUS_API_SECRET ? { apisecret: process.env.JANUS_API_SECRET } : {}),
        transaction: crypto.randomBytes(12).toString('hex'),
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw Error('Janus is unavailable');
    const result = await response.json();
    if (result.janus !== 'success' || result.plugindata?.data?.error)
      throw Error(
        result.error?.reason ||
          result.plugindata?.data?.error ||
          'Janus did not confirm room deletion',
      );
    return result;
  };
  let sid;
  try {
    sid = (await post('', { janus: 'create' })).data.id;
    for (const [plugin, id] of [
      ['audiobridge', row.audio_id],
      ['videoroom', row.video_id],
    ]) {
      const handle = (await post('/' + sid, { janus: 'attach', plugin: 'janus.plugin.' + plugin }))
        .data.id;
      try {
        await post('/' + sid + '/' + handle, {
          janus: 'message',
          body: { request: 'destroy', room: id },
        });
      } catch (error) {
        if (
          !/no such room|no such audio bridge|no such video room|not found|does not exist/i.test(
            error.message,
          )
        )
          throw error;
      }
    }
  } finally {
    if (sid) await post('/' + sid, { janus: 'destroy' }).catch(() => {});
  }
}
module.exports.destroyRoom = destroyRoom;
