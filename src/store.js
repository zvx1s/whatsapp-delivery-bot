// Session store — SQLite, zero infra. One row per customer phone number.
const Database = require('better-sqlite3');
const path = process.env.DB_PATH || './sessions.db';
const db = new Database(path);

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    phone TEXT PRIMARY KEY,
    language TEXT,
    step TEXT DEFAULT 'start',
    order_json TEXT DEFAULT '{}',
    paused_until INTEGER DEFAULT 0,
    updated_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS seen_messages (
    id TEXT PRIMARY KEY,
    at INTEGER
  );
  CREATE TABLE IF NOT EXISTS handoffs (
    phone TEXT PRIMARY KEY,
    name TEXT,
    context TEXT,
    at INTEGER
  );
`);

function getSession(phone) {
  let row = db.prepare('SELECT * FROM sessions WHERE phone=?').get(phone);
  if (!row) {
    db.prepare('INSERT INTO sessions (phone, updated_at) VALUES (?, ?)').run(phone, Date.now());
    row = db.prepare('SELECT * FROM sessions WHERE phone=?').get(phone);
  }
  row.order = JSON.parse(row.order_json || '{}');
  return row;
}

function saveSession(phone, patch) {
  const s = getSession(phone);
  const next = { ...s, ...patch };
  if (patch.order) next.order_json = JSON.stringify(patch.order);
  db.prepare(`UPDATE sessions SET language=?, step=?, order_json=?, paused_until=?, updated_at=? WHERE phone=?`)
    .run(next.language, next.step, next.order_json, next.paused_until, Date.now(), phone);
}

// Webhook dedupe — Meta retries on slow/failed responses
function seenBefore(messageId) {
  const hit = db.prepare('SELECT 1 FROM seen_messages WHERE id=?').get(messageId);
  if (hit) return true;
  db.prepare('INSERT INTO seen_messages (id, at) VALUES (?, ?)').run(messageId, Date.now());
  // prune old entries occasionally
  if (Math.random() < 0.01)
    db.prepare('DELETE FROM seen_messages WHERE at < ?').run(Date.now() - 7 * 86400e3);
  return false;
}

function flagHandoff(phone, name, context) {
  db.prepare('INSERT OR REPLACE INTO handoffs (phone,name,context,at) VALUES (?,?,?,?)')
    .run(phone, name || phone, context || '', Date.now());
}
function listHandoffs() {
  return db.prepare('SELECT * FROM handoffs ORDER BY at DESC').all();
}

module.exports = { getSession, saveSession, seenBefore, flagHandoff, listHandoffs, db };
