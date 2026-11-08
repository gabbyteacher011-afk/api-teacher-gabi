/* Uso: node scripts/create-user.js email senha professora|aluno|responsavel "Nome" */
const cfg = require('../src/config'); if (!cfg.databaseUrl) { console.error('Defina DATABASE_URL.'); process.exit(1); }
const { pool } = require('../src/db'); const auth = require('../src/auth');
const [email, password, role, ...nm] = process.argv.slice(2);
(async () => {
  if (!email || !password || !['professora', 'aluno', 'responsavel'].includes(role)) throw new Error('Uso: node scripts/create-user.js email senha professora|aluno|responsavel "Nome"');
  if (password.length < 8) throw new Error('A senha precisa ter pelo menos 8 caracteres.');
  if (role === 'professora') { const n = await pool.query(`SELECT count(*)::int AS n FROM users WHERE role = 'professora'`); if (n.rows[0].n > 0) throw new Error('Já existe uma conta de professora. O sistema tem uma única professora.'); }
  const r = await pool.query('INSERT INTO users (email, name, role, password_hash) VALUES ($1, $2, $3, $4) RETURNING id', [email.trim().toLowerCase(), nm.join(' '), role, auth.hashPassword(password)]);
  console.log('Conta criada:', r.rows[0].id); await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
