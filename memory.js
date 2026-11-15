// Private memory across calls. Stored ONLY in Postgres (MEMORY_DATABASE_URL, a Render env var) —
// never in the repo and never sent to the browser (it is injected into the server-side instructions
// and shown only on the key-protected /parent page). Falls back to a local file for local dev.
const fs = require("fs");
const path = require("path");
let pool = null, mode = "none";
const FILE = path.join(__dirname, "data", "memory.json");

async function init() {
  const url = process.env.MEMORY_DATABASE_URL;
  if (!url) { mode = "file"; return mode; }
  const { Pool, Client } = require("pg");
  const ssl = /render\.com|sslmode=require/.test(url) && !/@dpg-[^/.]*\//.test(url) ? { rejectUnauthorized: false } : undefined;
  let target = url;
  const dbName = process.env.MEMORY_DB_NAME || "sheriff_memory";
  try {
    // keep our data in its own database on the instance (separate from the app that owns the instance)
    const c = new Client({ connectionString: url, ssl });
    await c.connect();
    const ex = await c.query("select 1 from pg_database where datname=$1", [dbName]);
    if (!ex.rowCount) await c.query(`create database ${dbName}`);
    await c.end();
    target = url.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);
  } catch (e) {
    console.error("memory: own database not available, using schema sheriff_memory:", e.message);
    target = url;
  }
  pool = new Pool({ connectionString: target, ssl, max: 2 });
  if (target === url) { await pool.query("create schema if not exists sheriff_memory"); pool.on("connect", (cl) => cl.query("set search_path to sheriff_memory")); await pool.query("set search_path to sheriff_memory"); }
  const pre = target === url ? "sheriff_memory." : "";
  await pool.query(`create table if not exists ${pre}calls (
    id serial primary key, started_at timestamptz not null, ended_at timestamptz not null,
    char text, seconds int, transcript jsonb, summary jsonb, looks int default 0)`);
  pool._pre = pre;
  mode = "postgres";
  return mode;
}
function readFile() { try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return []; } }
async function saveCall(rec) {
  if (mode === "postgres") {
    await pool.query(`insert into ${pool._pre}calls (started_at, ended_at, char, seconds, transcript, summary, looks) values ($1,$2,$3,$4,$5,$6,$7)`,
      [rec.started_at, rec.ended_at, rec.char, rec.seconds, JSON.stringify(rec.transcript), rec.summary ? JSON.stringify(rec.summary) : null, rec.looks || 0]);
  } else if (mode === "file") {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const all = readFile(); all.push({ id: all.length + 1, ...rec }); fs.writeFileSync(FILE, JSON.stringify(all));
  }
}
async function recent(n = 50) {
  if (mode === "postgres") {
    const r = await pool.query(`select * from ${pool._pre}calls order by started_at desc limit $1`, [n]);
    return r.rows;
  }
  if (mode === "file") return readFile().sort((a, b) => new Date(b.started_at) - new Date(a.started_at)).slice(0, n);
  return [];
}
module.exports = { init, saveCall, recent, mode: () => mode };
