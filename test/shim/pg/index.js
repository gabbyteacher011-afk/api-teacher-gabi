/* SOMENTE PARA TESTES: imita o pacote `pg` usando o psql, para poder testar a API
   contra um PostgreSQL real quando não há como instalar o pacote. Em produção usa-se o `pg` oficial. */
const { spawn } = require('child_process');
const OPT = () => ({ host: process.env.TEST_PGHOST || '/tmp', port: process.env.TEST_PGPORT || '5544', db: process.env.TEST_PGDB || 'apitest', user: process.env.TEST_PGUSER || 'pgt' });
const lit = v => {
  if (v === null || v === undefined) return 'NULL';
  if (Buffer.isBuffer(v)) return `'\\x${v.toString('hex')}'`;
  if (Array.isArray(v)) return `'{${v.map(x => '"' + String(x).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"').join(',')}}'`;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
};
class Conn {
  constructor() {
    const o = OPT(); this.n = 0; this.q = Promise.resolve();
    this.p = spawn('psql', ['-h', o.host, '-p', o.port, '-d', o.db, '-U', o.user, '-At', '-q', '-X', '-v', 'ON_ERROR_STOP=0', '-v', 'VERBOSITY=verbose'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.out = ''; this.err = ''; this.waiter = null;
    this.p.stdout.on('data', d => { this.out += d; this.check(); });
    this.p.stderr.on('data', d => { this.err += d; this.check(); });
  }
  check() { const w = this.waiter; if (w && this.out.includes(w.mark + 'O') && this.err.includes(w.mark + 'E')) { this.waiter = null; const out = this.out.split(w.mark + 'O')[0], err = this.err.split(w.mark + 'E')[0]; this.out = ''; this.err = ''; w.resolve({ out, err }); } }
  run(sql) {
    return (this.q = this.q.then(() => new Promise(resolve => { const mark = '@@' + (++this.n) + '@@'; this.waiter = { mark, resolve }; this.p.stdin.write(sql + '\n\\echo ' + mark + 'O\n\\warn ' + mark + 'E\n'); })));
  }
  async query(text, params) {
    let sql = text.replace(/\$(\d+)/g, (_, i) => lit(params[Number(i) - 1]));
    const t = sql.trim(), up = t.toUpperCase();
    let mode = 'raw';
    if (/^(SELECT|WITH)\b/.test(up) || /\bRETURNING\b/.test(up)) mode = 'rows';
    else if (/^(DELETE|UPDATE)\b/.test(up)) { sql = t + ' RETURNING 1'; mode = 'count'; }
    let wrapped = sql;
    if (mode === 'rows') wrapped = `WITH q AS (${t.replace(/;\s*$/, '')}) SELECT coalesce(json_agg(row_to_json(q)), '[]'::json) FROM q;`;
    if (mode === 'count') wrapped = `WITH q AS (${sql}) SELECT count(*) FROM q;`;
    if (mode === 'raw' && !/;\s*$/.test(wrapped)) wrapped += ';';
    const { out, err } = await this.run(wrapped);
    const m = /ERROR:\s+(\w{5}):\s*(.*)/.exec(err);
    if (m) { const e = new Error(m[2]); e.code = m[1]; const c = /constraint "([^"]+)"/.exec(err); if (c) e.constraint = c[1]; throw e; }
    if (mode === 'rows') {
      const rows = JSON.parse(out.trim() || '[]');
      for (const r of rows) for (const k of Object.keys(r)) if (k === 'data' && typeof r[k] === 'string' && /^\\x[0-9a-f]*$/i.test(r[k])) r[k] = Buffer.from(r[k].slice(2), 'hex');
      return { rows, rowCount: rows.length };
    }
    if (mode === 'count') return { rows: [], rowCount: Number(out.trim() || 0) };
    return { rows: [], rowCount: 0 };
  }
  release() { this.idle = true; }
  kill() { try { this.p.stdin.end(); this.p.kill(); } catch (e) { /* ok */ } }
}
class Pool {
  constructor() { this.conns = []; this.shared = null; }
  query(t, p) { this.shared = this.shared || this.track(new Conn()); return this.shared.query(t, p); }
  track(c) { this.conns.push(c); return c; }
  async connect() { const free = this.conns.find(c => c.idle && c !== this.shared); if (free) { free.idle = false; return free; } return this.track(new Conn()); }
  async end() { this.conns.forEach(c => c.kill()); }
}
module.exports = { Pool, types: { setTypeParser() { } } };
