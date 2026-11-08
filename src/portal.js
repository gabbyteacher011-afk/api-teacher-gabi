/* Painéis publicados, entregas do aluno e devoluções da professora. */
const { query, tx } = require('./db');
const { HttpError } = require('./mapper');
const iso = v => (v ? new Date(v).toISOString() : '');
const SUB_STATUS = new Set(['rascunho', 'entregue']);
const RET_MODE = new Set(['corrigida', 'refazer']);
const MAX_HTML = 40000;

/* ---- painel (cópia publicada) ---- */
async function getPortal(userId) { const r = await query('SELECT doc FROM portal_snapshots WHERE user_id = $1', [userId]); return r.rows[0] ? r.rows[0].doc : null; }
async function setPortal(userId, doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new HttpError(400, 'Painel inválido.');
  const u = await query('SELECT 1 FROM users WHERE id = $1', [userId]);
  if (!u.rows.length) throw new HttpError(404, 'Conta não encontrada.');
  await query(`INSERT INTO portal_snapshots (user_id, doc, updated_at) VALUES ($1, $2::jsonb, now()) ON CONFLICT (user_id) DO UPDATE SET doc = EXCLUDED.doc, updated_at = now()`, [userId, JSON.stringify(doc)]);
}
const delPortal = userId => query('DELETE FROM portal_snapshots WHERE user_id = $1', [userId]);

/* ---- entregas do aluno ---- */
async function subsFor(userIds) {
  const where = userIds ? 'WHERE s.user_id = ANY($1)' : 'WHERE s.user_id IS NOT NULL';
  const r = await query(`SELECT s.user_id, hs.homework_id, hs.html, hs.status, hs.submitted_at, hs.updated_at, hs.extra FROM homework_submissions hs JOIN homework h ON h.id = hs.homework_id JOIN students s ON s.id = h.student_id ${where}`, userIds ? [userIds] : []);
  const out = {};
  if (!r.rows.length) return out;
  const f = await query('SELECT homework_id, file_id, name FROM homework_submission_files WHERE homework_id = ANY($1) ORDER BY file_id', [r.rows.map(x => x.homework_id)]);
  const files = {}; f.rows.forEach(x => { (files[x.homework_id] = files[x.homework_id] || []).push({ id: x.file_id, name: x.name }); });
  for (const x of r.rows) {
    const d = out[x.user_id] = out[x.user_id] || { v: 1, items: {} };
    d.items[x.homework_id] = { ...(x.extra || {}), html: x.html, status: x.status, files: files[x.homework_id] || [], submittedAt: iso(x.submitted_at), updatedAt: iso(x.updated_at) };
  }
  return out;
}
async function writeSubs(userId, items) {
  if (!items || typeof items !== 'object' || Array.isArray(items)) throw new HttpError(400, 'Entregas inválidas.');
  const ids = Object.keys(items);
  if (!ids.length) return;
  const own = await query('SELECT h.id FROM homework h JOIN students s ON s.id = h.student_id WHERE s.user_id = $1 AND h.id = ANY($2)', [userId, ids]);
  const ok = new Set(own.rows.map(x => x.id));
  for (const id of ids) if (!ok.has(id)) throw new HttpError(403, 'Este homework não pertence à sua conta.');
  await tx(async c => {
    for (const id of ids) {
      const it = items[id] || {};
      if (!SUB_STATUS.has(it.status)) throw new HttpError(400, 'Situação da entrega inválida.');
      const html = String(it.html || ''); if (html.length > MAX_HTML) throw new HttpError(400, 'O documento ficou grande demais.');
      const { html: _h, status: _s, files: _f, submittedAt, updatedAt, ...extra } = it;
      await c.query(`INSERT INTO homework_submissions (homework_id, html, status, submitted_at, updated_at, extra) VALUES ($1, $2, $3, $4::timestamptz, COALESCE($5::timestamptz, now()), $6::jsonb)
        ON CONFLICT (homework_id) DO UPDATE SET html = EXCLUDED.html, status = EXCLUDED.status, submitted_at = EXCLUDED.submitted_at, updated_at = EXCLUDED.updated_at, extra = EXCLUDED.extra`,
      [id, html, it.status, submittedAt || null, updatedAt || null, JSON.stringify(extra)]);
      await c.query('DELETE FROM homework_submission_files WHERE homework_id = $1', [id]);
      for (const f of (Array.isArray(it.files) ? it.files : []).slice(0, 10)) {
        await c.query(`INSERT INTO homework_submission_files (homework_id, file_id, name) SELECT $1::text, id, $3::text FROM files WHERE id = $2::text AND uploaded_by = $4::text ON CONFLICT DO NOTHING`, [id, String(f.id), String(f.name || '').slice(0, 200), userId]);
      }
    }
  });
}

/* ---- devoluções da professora ---- */
async function retsFor(userId) {
  const r = await query('SELECT hr.* FROM homework_returns hr JOIN homework h ON h.id = hr.homework_id JOIN students s ON s.id = h.student_id WHERE s.user_id = $1', [userId]);
  if (!r.rows.length) return null;
  const items = {};
  for (const x of r.rows) items[x.homework_id] = { ...(x.extra || {}), html: x.html, feedback: x.feedback, score: x.score, maxScore: x.max_score, mode: x.mode, returnedAt: iso(x.returned_at) };
  return { v: 1, items };
}
async function writeRets(userId, items) {
  if (!items || typeof items !== 'object' || Array.isArray(items)) throw new HttpError(400, 'Devoluções inválidas.');
  const ids = Object.keys(items); if (!ids.length) return;
  const own = await query('SELECT h.id FROM homework h JOIN students s ON s.id = h.student_id WHERE s.user_id = $1 AND h.id = ANY($2)', [userId, ids]);
  const ok = new Set(own.rows.map(x => x.id));
  await tx(async c => {
    for (const id of ids) {
      if (!ok.has(id)) continue;
      const it = items[id] || {};
      if (!RET_MODE.has(it.mode)) throw new HttpError(400, 'Tipo de devolução inválido.');
      const { html, feedback, score, maxScore, mode, returnedAt, ...extra } = it;
      if (String(html || '').length > MAX_HTML) throw new HttpError(400, 'O documento ficou grande demais.');
      await c.query(`INSERT INTO homework_returns (homework_id, html, feedback, score, max_score, mode, returned_at, extra) VALUES ($1, $2, $3, $4::numeric, COALESCE($5::numeric, 10), $6, COALESCE($7::timestamptz, now()), $8::jsonb)
        ON CONFLICT (homework_id) DO UPDATE SET html = EXCLUDED.html, feedback = EXCLUDED.feedback, score = EXCLUDED.score, max_score = EXCLUDED.max_score, mode = EXCLUDED.mode, returned_at = EXCLUDED.returned_at, extra = EXCLUDED.extra`,
      [id, String(html || ''), String(feedback || ''), score === null || score === undefined || score === '' ? null : Number(score), maxScore === undefined || maxScore === '' ? null : Number(maxScore), mode, returnedAt || null, JSON.stringify(extra)]);
    }
  });
}

module.exports = { getPortal, setPortal, delPortal, subsFor, writeSubs, retsFor, writeRets };
