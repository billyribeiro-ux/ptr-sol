const db = require('../db/database');
function json(value, fallback = {}) {
  try {
    return JSON.parse(value || '');
  } catch {
    return fallback;
  }
}
function session(row) {
  const settings = json(row.settings);
  const counts = require('../realtime/sockjs').getRoomCounts(row.uuid);
  // Settings never get to override ownership, identifiers, or the actual room state.
  delete settings.owner_id;
  delete settings.uuid;
  delete settings._id;
  return {
    ...settings,
    authMode: settings.authMode || 'open',
    current_capacity: counts.current,
    recordedMaxCapacity: counts.maximum,
    currentState: row.is_open ? 'open' : 'closed',
    _id: row.id || row.uuid,
    uuid: row.uuid,
    name: row.name,
    tagline: row.tagline || '',
    isMainRoom: !!row.is_main_room,
    isArchivedRoom: !!row.is_archived_room,
    isChatOnlyRoom: !!row.is_chat_only_room,
    isOpen: !!row.is_open,
    isLocked: !!row.is_locked,
    chatMode: row.chat_mode,
    alertsOnBottom: !!row.alerts_on_bottom,
    bkgImg: row.bkg_img || '',
    bkgImgHREF: row.bkg_img_href || '',
    presenterSettings: json(row.presenter_settings),
    enableBadges: settings.enableBadges ?? true,
    badges: require('./badges').accountBadges(row.owner_id).map(badge),
    chatServerURL: '/talk',
    createdAt: row.created_at,
  };
}
function badge(row) {
  const room = db.prepare('SELECT settings,owner_id FROM sessions WHERE uuid=?').get(row.room_id);
  const legacy = json(room?.settings).badgeMetadata || {};
  const meta = json(row.metadata);
  return {
    ...row,
    ...(Object.keys(meta).length ? meta : legacy[row.id] || {}),
    _id: row.id,
    uuid: row.id,
    roomID: row.room_id,
    userID: row.owner_id || room?.owner_id,
    imgURL: row.image_url || '',
    darkTheme: row.dark_theme || '',
    darkThemeID: row.dark_theme || '',
    uploadTime: row.created_at,
    type: row.image_url ? 'image' : 'text',
  };
}
function file(row) {
  const url = `/users/v1/serveFile?id=${encodeURIComponent(row.id)}`;
  return {
    _id: row.id,
    id: row.id,
    uuid: row.id,
    roomID: row.room_id,
    name: row.original_name,
    filename: row.original_name,
    contentType: row.mime_type,
    type: row.mime_type,
    size: row.size_bytes,
    createdAt: row.created_at,
    uploadTime: row.created_at,
    fpath: url,
    vidPath: url,
    url,
  };
}
function recording(row) {
  return {
    _id: row.id,
    uuid: row.id,
    roomID: row.room_id,
    vidPath: `/users/v1/recordingFile?id=${encodeURIComponent(row.id)}`,
    name: row.title,
    title: row.title,
    contentType: row.mime_type || 'video/webm',
    length: (row.duration_sec || 0) * 1000,
    created: row.created_at,
    createdAt: row.created_at,
    size: row.size_bytes || 0,
    status: row.status,
  };
}
function membership(row) {
  const flags = json(row.flags);
  const role = /^[0-4]$/.test(row.role)
    ? Number(row.role)
    : ['presenter', 'a', 'o'].includes(row.role)
      ? 1
      : row.role === 'admin'
        ? 1
        : 2;
  return {
    ...flags,
    nonPresenter: flags.nonPresenter || row.role === 'admin',
    restrictPMUser: !!flags.restrictPM,
    badges: flags.badges || [],
    _id: row.id,
    uuid: row.id,
    email: row.email,
    name: row.name,
    userName: row.name,
    role,
    inviteStatus: row.status,
    createdAt: row.created_at,
  };
}
module.exports = { json, session, badge, file, recording, membership };
