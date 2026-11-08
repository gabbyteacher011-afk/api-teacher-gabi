const http = require('http');
const cfg = require('./config');
const { query } = require('./db');
const auth = require('./auth');
const M = require('./mapper');
const P = require('./portal');
const { HttpError } = M;

/* ---------------- infraestrutura mínima de rotas ---------------- */
const routes = [];
function route(method, pattern, level, fn) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  routes.push({ method, re, keys, level, fn });
}
function send(res, status, body, headers) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body === undefined ? {} : body));
  res.writeHead(status, { 'Content-Type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json; charset=utf-8', 'Content-Length': buf.length, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', ...(headers || {}) });
  res.end(buf);
}
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0, over = false;
    req.on('data', d => {
      n += d.length;
      if (n > max * 3) { reject(new HttpError(413, 'Conteúdo grande demais.')); req.destroy(); return; }
      if (n > max) { over = true; return; }   // descarta o excesso e responde 413 no fim
      chunks.push(d);
    });
    req.on('end', () => (over ? reject(new HttpError(413, 'Conteúdo grande demais.')) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const b = await readBody(req, cfg.maxJson);
  if (!b.length) return {};
  try { return JSON.parse(b.toString('utf8')); } catch (e) { throw new HttpError(400, 'JSON inválido.'); }
}
function cors(req, res) {
  const o = req.headers.origin;
  if (o && (cfg.corsOrigins.includes('*') || cfg.corsOrigins.includes(o))) {
    res.setHeader('Access-Control-Allow-Origin', o); res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type'); res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS'); res.setHeader('Access-Control-Max-Age', '600');
  }
}
async function authenticate(req, url) {
  const h = req.headers.authorization || '', t = h.startsWith('Bearer ') ? h.slice(7) : (req.method === 'GET' && url.pathname.startsWith('/files/') ? url.searchParams.get('token') : '');
  const d = auth.verify(t); if (!d) return null;
  const r = await query('SELECT id, email, name, role FROM users WHERE id = $1', [d.sub]);
  return r.rows[0] || null;
}

const publicUser = u => ({ id: u.id, email: u.email, name: u.name, role: u.role });
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* ---------------- saúde e login ---------------- */
route('GET', '/health', 'none', async () => { await query('SELECT 1'); return { ok: true }; });

route('POST', '/auth/login', 'none', async ({ req, body }) => {
  const email = String(body.email || '').trim().toLowerCase(), key = email + '|' + (req.socket.remoteAddress || '');
  if (!auth.loginAllowed(key)) throw new HttpError(429, 'Muitas tentativas. Aguarde alguns minutos.');
  const r = await query('SELECT * FROM users WHERE email = $1', [email]);
  const u = r.rows[0];
  if (!u || !auth.verifyPassword(String(body.password || ''), u.password_hash)) { auth.loginFailed(key); throw new HttpError(401, 'E-mail ou senha incorretos.'); }
  auth.loginOk(key);
  return { token: auth.sign({ sub: u.id }), user: publicUser(u) };
});
route('GET', '/auth/me', 'any', async ({ user }) => ({ user: publicUser(user) }));
route('POST', '/auth/password', 'any', async ({ user, body }) => {
  const r = await query('SELECT password_hash FROM users WHERE id = $1', [user.id]);
  if (!auth.verifyPassword(String(body.current || ''), r.rows[0].password_hash)) throw new HttpError(400, 'A senha atual está incorreta.');
  if (String(body.password || '').length < 8) throw new HttpError(400, 'A nova senha precisa ter pelo menos 8 caracteres.');
  await query('UPDATE users SET password_hash = $1 WHERE id = $2', [auth.hashPassword(body.password), user.id]);
  return { ok: true };
});

/* ---------------- contas (só a professora) ---------------- */
route('POST', '/users', 'teacher', async ({ body }) => {
  const email = String(body.email || '').trim().toLowerCase(), name = String(body.name || '').trim(), role = body.role;
  if (!EMAIL.test(email)) throw new HttpError(400, 'E-mail inválido.');
  if (!['aluno', 'responsavel'].includes(role)) throw new HttpError(400, 'Tipo de conta inválido.');
  if (String(body.password || '').length < 8) throw new HttpError(400, 'A senha provisória precisa ter pelo menos 8 caracteres.');
  const r = await query('INSERT INTO users (email, name, role, password_hash) VALUES ($1, $2, $3, $4) RETURNING id, email, name, role', [email, name, role, auth.hashPassword(body.password)]);
  return { user: r.rows[0] };
});
route('GET', '/users/search', 'teacher', async ({ url }) => {
  const q = '%' + String(url.searchParams.get('q') || '').trim().toLowerCase().replace(/[%_\\]/g, '') + '%';
  const r = await query(`SELECT id, email, name, role FROM users WHERE role <> 'professora' AND (lower(name) LIKE $1 OR lower(email) LIKE $1) ORDER BY name, email LIMIT 30`, [q]);
  return { users: r.rows };
});
route('POST', '/users/profiles', 'teacher', async ({ body }) => {
  const ids = (Array.isArray(body.ids) ? body.ids : []).map(String).slice(0, 200);
  const r = ids.length ? await query('SELECT id, email, name FROM users WHERE id = ANY($1)', [ids]) : { rows: [] };
  return { profiles: Object.fromEntries(r.rows.map(x => [x.id, { name: x.name || x.email, email: x.email }])) };
});
route('POST', '/users/:id/password', 'teacher', async ({ params, body }) => {
  if (String(body.password || '').length < 8) throw new HttpError(400, 'A senha precisa ter pelo menos 8 caracteres.');
  const r = await query(`UPDATE users SET password_hash = $1 WHERE id = $2 AND role <> 'professora'`, [auth.hashPassword(body.password), params.id]);
  if (!r.rowCount) throw new HttpError(404, 'Conta não encontrada.');
  return { ok: true };
});
route('DELETE', '/users/:id', 'teacher', async ({ params, user }) => {
  if (params.id === user.id) throw new HttpError(400, 'Você não pode excluir a própria conta.');
  const r = await query(`DELETE FROM users WHERE id = $1 AND role <> 'professora'`, [params.id]);
  return { deleted: r.rowCount || 0 };
});

/* ---------------- configurações e sincronização ---------------- */
route('GET', '/settings', 'teacher', async () => M.getSettings());
route('PUT', '/settings', 'teacher', async ({ body }) => { await M.saveSettings(body); return { ok: true }; });

route('GET', '/sync', 'teacher', async () => {
  const names = Object.keys(M.COLLECTIONS), lists = await Promise.all(names.map(n => M.list(n)));
  const collections = {}; names.forEach((n, i) => { collections[n] = lists[i]; });
  return { settings: await M.getSettings(), collections, submissions: await P.subsFor(null) };
});
route('GET', '/me/bundle', 'any', async ({ user }) => ({ portal: await P.getPortal(user.id), submissions: (await P.subsFor([user.id]))[user.id] || null, returns: await P.retsFor(user.id) }));
route('PUT', '/me/submissions', 'any', async ({ user, body }) => {
  if (user.role === 'professora') throw new HttpError(403, 'Apenas contas de aluno entregam homework.');
  await P.writeSubs(user.id, body.items); return { ok: true };
});
route('PUT', '/portal/:uid', 'teacher', async ({ params, body }) => { await P.setPortal(params.uid, body); return { ok: true }; });
route('DELETE', '/portal/:uid', 'teacher', async ({ params }) => { await P.delPortal(params.uid); return { ok: true }; });
route('GET', '/returns/:uid', 'teacher', async ({ params }) => ({ doc: await P.retsFor(params.uid) }));
route('PUT', '/returns/:uid', 'teacher', async ({ params, body }) => { await P.writeRets(params.uid, body.items); return { ok: true }; });

/* ---------------- arquivos ---------------- */
route('POST', '/files', 'any', async ({ req, url, user }) => {
  const buf = await readBody(req, cfg.maxFile);
  if (!buf.length) throw new HttpError(400, 'Arquivo vazio.');
  const name = String(url.searchParams.get('name') || 'arquivo').slice(0, 200), type = String(req.headers['content-type'] || 'application/octet-stream').slice(0, 100);
  const r = await query('INSERT INTO files (name, content_type, size_bytes, uploaded_by) VALUES ($1, $2, $3, $4) RETURNING id', [name, type, buf.length, user.id]);
  await query('INSERT INTO file_blobs (file_id, data) VALUES ($1, $2)', [r.rows[0].id, buf]);
  return { id: r.rows[0].id, name, contentType: type, sizeBytes: buf.length };
});
route('GET', '/files/:id', 'any', async ({ params, user, res }) => {
  const f = await query('SELECT f.name, f.content_type, f.uploaded_by, b.data FROM files f JOIN file_blobs b ON b.file_id = f.id WHERE f.id = $1', [params.id]);
  const row = f.rows[0]; if (!row) throw new HttpError(404, 'Arquivo não encontrado.');
  if (user.role !== 'professora' && row.uploaded_by !== user.id) {
    const p = await query(`SELECT 1 FROM portal_snapshots WHERE user_id = $1 AND doc::text LIKE '%' || $2::text || '%'`, [user.id, params.id]);
    if (!p.rows.length) throw new HttpError(403, 'Sem permissão para este arquivo.');
  }
  const data = Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data);
  res.writeHead(200, { 'Content-Type': row.content_type, 'Content-Length': data.length, 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(row.name)}`, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'; img-src data:; media-src data:; style-src 'unsafe-inline'", 'Cache-Control': 'private, max-age=300' });
  res.end(data); return null;
});
route('DELETE', '/files/:id', 'any', async ({ params, user }) => {
  const f = await query('SELECT uploaded_by FROM files WHERE id = $1', [params.id]);
  if (!f.rows[0]) return { deleted: 0 };
  if (user.role !== 'professora' && f.rows[0].uploaded_by !== user.id) throw new HttpError(403, 'Sem permissão.');
  await query('DELETE FROM files WHERE id = $1', [params.id]); return { deleted: 1 };
});

/* ---------------- coleções (alunos, aulas, homework, financeiro…) ---------------- */
for (const name of Object.keys(M.COLLECTIONS)) {
  route('GET', '/' + name, 'teacher', async () => ({ items: await M.list(name) }));
  route('GET', `/${name}/:id`, 'teacher', async ({ params }) => { const r = await M.get(name, params.id); if (!r) throw new HttpError(404, 'Registro não encontrado.'); return r; });
  route('PUT', `/${name}/:id`, 'teacher', async ({ params, body }) => { await M.upsert(name, params.id, body); return { ok: true }; });
  route('DELETE', `/${name}/:id`, 'teacher', async ({ params }) => ({ deleted: await M.remove(name, params.id) }));
}

/* ---------------- servidor ---------------- */
async function handle(req, res) {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const url = new URL(req.url, 'http://x');
  try {
    let hit = null, params = {};
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(url.pathname); if (!m) continue;
      hit = r; r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); }); break;
    }
    if (!hit) {
      const other = routes.some(r => r.re.test(url.pathname));
      throw new HttpError(other ? 405 : 404, other ? 'Método não permitido.' : 'Rota não encontrada.');
    }
    let user = null;
    if (hit.level !== 'none') {
      user = await authenticate(req, url);
      if (!user) throw new HttpError(401, 'Faça login novamente.');
      if (hit.level === 'teacher' && user.role !== 'professora') throw new HttpError(403, 'Apenas a professora acessa este recurso.');
    }
    const isRaw = req.method === 'POST' && url.pathname === '/files';
    const body = ['POST', 'PUT'].includes(req.method) && !isRaw ? await readJson(req) : {};
    const out = await hit.fn({ req, res, url, params, body, user });
    if (out !== null) send(res, 200, out);
  } catch (e0) {
    const e = M.friendly(e0);
    if (!(e instanceof HttpError)) { console.error(e0); send(res, 500, { error: 'Erro interno do servidor.' }); return; }
    send(res, e.status, { error: e.message });
  }
}
const server = http.createServer((req, res) => { handle(req, res).catch(e => { console.error(e); try { send(res, 500, { error: 'Erro interno do servidor.' }); } catch (x) { /* resposta já enviada */ } }); });
module.exports = { server };
if (require.main === module) {
  cfg.check();
  server.listen(cfg.port, () => console.log('API ouvindo na porta ' + cfg.port));
}
