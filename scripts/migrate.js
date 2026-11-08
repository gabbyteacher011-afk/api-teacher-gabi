/* Cria as tabelas (só se o banco ainda estiver vazio). */
const fs = require('fs'), path = require('path');
const cfg = require('../src/config'); cfg.databaseUrl = cfg.databaseUrl || ''; if (!cfg.databaseUrl) { console.error('Defina DATABASE_URL.'); process.exit(1); }
const { pool } = require('../src/db');
(async () => {
  const has = await pool.query(`SELECT to_regclass('public.users') AS t`);
  if (has.rows[0].t) { console.log('As tabelas já existem. Nada a fazer.'); await pool.end(); return; }
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  console.log('Tabelas criadas.'); await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
