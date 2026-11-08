const cfg = require('./config');
const { Pool, types } = require('pg');
// date/time/numeric chegam como o front espera: texto 'AAAA-MM-DD', 'HH:MM:SS' e número.
types.setTypeParser(1082, v => v);
types.setTypeParser(1083, v => v);
types.setTypeParser(1700, v => (v === null ? null : parseFloat(v)));
types.setTypeParser(20, v => (v === null ? null : Number(v)));
const pool = new Pool({ connectionString: cfg.databaseUrl, ssl: cfg.databaseSsl ? { rejectUnauthorized: false } : undefined, max: 10 });
const query = (text, params) => pool.query(text, params);
async function tx(fn) {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
  catch (e) { try { await c.query('ROLLBACK'); } catch (x) { /* ignora */ } throw e; }
  finally { c.release(); }
}
module.exports = { pool, query, tx };
