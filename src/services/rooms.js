'use strict';
const crypto = require('crypto');
const db = require('../db/database');
const { createRoomIdentifiers } = require('./room-ids');
const { json } = require('./serializers');

function cloneRoom(source, name) {
  const target = createRoomIdentifiers();
  const settings = json(source.settings);
  delete settings.uniqueLinkLogin;
  delete settings.customCname;
  settings.isClonedRoom = true;
  settings.clonedFrom = source.id || source.uuid;

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
      `INSERT INTO sessions
      (id,uuid,owner_id,name,tagline,is_chat_only_room,is_open,is_locked,chat_mode,
       alerts_on_bottom,bkg_img,bkg_img_href,presenter_settings,settings)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      target.id,
      target.uuid,
      source.owner_id,
      name,
      source.tagline,
      source.is_chat_only_room,
      0,
      source.is_locked,
      source.chat_mode,
      source.alerts_on_bottom,
      source.bkg_img,
      source.bkg_img_href,
      source.presenter_settings,
      JSON.stringify(settings),
    );
    const presenters = db
      .prepare(
        `SELECT * FROM memberships WHERE room_id=? AND
      role IN ('0','1','a','o','admin','presenter')`,
      )
      .all(source.uuid);
    for (const member of presenters) {
      db.prepare(
        `INSERT INTO memberships
        (id,room_id,email,name,password_hash,role,status,flags) VALUES (?,?,?,?,?,?,?,?)`,
      ).run(
        crypto.randomUUID(),
        target.uuid,
        member.email,
        member.name,
        member.password_hash,
        member.role,
        member.status,
        member.flags,
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return db.prepare('SELECT * FROM sessions WHERE uuid=?').get(target.uuid);
}
module.exports = { cloneRoom };
