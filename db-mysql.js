/* ============================================================
   MySQL Database Adapter for WorkAlert
   Drop-in replacement for JSON file storage
   ============================================================ */
let mysql;
try { mysql = require('mysql2/promise'); } catch (_) { mysql = null; }

let pool = null;

function getPool() {
  if (!pool && mysql) {
    pool = mysql.createPool({
      host: process.env.MYSQL_HOST || 'localhost',
      user: process.env.MYSQL_USER || 'workalert',
      password: process.env.MYSQL_PASS || 'W0rkAl3rt2024!',
      database: process.env.MYSQL_DB || 'workalert',
      waitForConnections: true,
      connectionLimit: 5
    });
  }
  return pool;
}

const EMPTY_DB = { users: {}, groups: {}, alerts: [], sessions: {}, pushSubs: {}, otps: {}, invites: [] };

async function initTables() {
  const p = getPool();
  if (!p) return;
  await p.execute(`CREATE TABLE IF NOT EXISTS kv_store (
    k VARCHAR(64) PRIMARY KEY,
    v LONGTEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`);
  // Check if data exists
  const [rows] = await p.execute("SELECT v FROM kv_store WHERE k = 'db' LIMIT 1");
  if (!rows.length) {
    await p.execute("INSERT INTO kv_store (k, v) VALUES ('db', ?)", [JSON.stringify(EMPTY_DB)]);
  }
}

async function loadDB() {
  const p = getPool();
  if (!p) return structuredClone(EMPTY_DB);
  try {
    const [rows] = await p.execute("SELECT v FROM kv_store WHERE k = 'db' LIMIT 1");
    if (rows.length) {
      const data = JSON.parse(rows[0].v);
      return { ...structuredClone(EMPTY_DB), ...data };
    }
  } catch (e) {
    console.error('MySQL load error:', e.message);
  }
  return structuredClone(EMPTY_DB);
}

async function saveDB(db) {
  const p = getPool();
  if (!p) return;
  try {
    await p.execute("UPDATE kv_store SET v = ? WHERE k = 'db'", [JSON.stringify(db)]);
  } catch (e) {
    console.error('MySQL save error:', e.message);
  }
}

module.exports = { initTables, loadDB, saveDB, getPool, EMPTY_DB };
