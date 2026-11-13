const db = require('../db/database');
const { json } = require('./serializers');

// Socket events supply actual visits and their duration. Keep older REST-only
// logins as a fallback, but do not double-count a login followed by a join.
function userActivity(roomId) {
  const events = db
    .prepare(
      "SELECT * FROM audit_events WHERE room_id=? AND action IN ('room_login','room_join','room_logout') ORDER BY created_at ASC",
    )
    .all(roomId);
  const joins = [],
    logins = [],
    exits = new Map();
  for (const event of events) {
    const data = { ...json(event.details), _id: event.id, uuid: event.actor_id };
    const key = `${event.actor_id}:${data.inTime || ''}`;
    if (event.action === 'room_logout') exits.set(key, data);
    else if (event.action === 'room_join') joins.push({ ...data, actorId: event.actor_id, key });
    else logins.push({ ...data, actorId: event.actor_id });
  }
  const visits = joins.map((join) => {
    const exit = exits.get(join.key),
      result = { ...join, ...(exit || {}), isOnline: !exit };
    delete result.actorId;
    delete result.key;
    if (exit && Number.isFinite(Number(exit.duration))) result.duration = Number(exit.duration);
    else if (!exit && Number.isFinite(Date.parse(join.inTime)))
      result.duration = Math.max(0, Math.floor((Date.now() - Date.parse(join.inTime)) / 1000));
    return result;
  });
  for (const login of logins) {
    const duplicated = joins.some(
      (join) =>
        join.actorId === login.actorId &&
        Math.abs(Date.parse(join.inTime) - Date.parse(login.inTime)) < 60000,
    );
    if (!duplicated) {
      delete login.actorId;
      visits.push(login);
    }
  }
  return visits.sort((a, b) => Date.parse(b.inTime) - Date.parse(a.inTime));
}
module.exports = { userActivity };
