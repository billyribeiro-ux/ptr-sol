const crypto = require('crypto');
const db = require('../db/database');

function createRoomIdentifiers() {
  // Retry collisions against persistent rooms; database UNIQUE constraints are
  // still the final authority if concurrent creators choose the same value.
  for (let attempt = 0; attempt < 100; attempt++) {
    const id = crypto.randomBytes(12).toString('hex');
    const uuid = String(crypto.randomInt(100000, 1000000));
    if (!db.prepare('SELECT 1 FROM sessions WHERE id=? OR uuid=?').get(id, uuid))
      return { id, uuid };
  }
  throw new Error('Unable to allocate a room identifier.');
}
module.exports = { createRoomIdentifiers };
