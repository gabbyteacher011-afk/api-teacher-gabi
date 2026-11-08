/* ============================================================
   mapper.js — traduz os registros (JSON) do front-end para as tabelas
   relacionais de db/schema.sql e de volta. Campos sem coluna própria
   vão para a coluna `extra` (jsonb), então nada se perde.
   ============================================================ */
const { query, tx } = require('./db');

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

/* c(campoDoFront, coluna, tipo, opções)
   tipos: t texto · d data · tm hora · i inteiro · n número · b booleano · a texto[] · j jsonb · fk referência
   opções: null (aceita NULL), req (obrigatório), ref (tabela), empty (valor devolvido ao front quando NULL) */
const c = (f, col, t, o) => ({ f, col, t, ...(o || {}) });
const CAST = { d: '::date', tm: '::time', i: '::integer', n: '::numeric', b: '::boolean', a: '::text[]', j: '::jsonb' };
const blank = v => v === undefined || v === null || v === '';

const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
function setPath(o, p, v) { const ks = p.split('.'); let a = o; ks.slice(0, -1).forEach(k => { a = a[k] = a[k] || {}; }); a[ks[ks.length - 1]] = v; }

/* ---- valor do front -> parâmetro SQL (ou DEFAULT) ---- */
async function toDb(spec, v, ctx) {
  const { t } = spec;
  if (t === 'fk') {
    if (blank(v)) { if (spec.req) throw new HttpError(400, 'Campo obrigatório: ' + spec.f); return { v: null }; }
    const key = spec.ref + ':' + v;
    if (!ctx.cache.has(key)) { const r = await ctx.q(`SELECT 1 FROM ${spec.ref} WHERE id = $1`, [String(v)]); ctx.cache.set(key, r.rows.length > 0); }
    if (!ctx.cache.get(key)) { if (spec.req) throw new HttpError(400, 'Registro não encontrado para ' + spec.f); return { v: null }; }
    return { v: String(v) };
  }
  if (t === 't') return v === undefined || v === null ? { def: true } : { v: String(v) };
  if (t === 'b') return v === undefined || v === null ? { def: true } : { v: v === true || v === 1 || v === '1' || v === 'true' };
  if (t === 'a') return Array.isArray(v) ? { v: v.map(String) } : { def: true };
  if (t === 'j') return v && typeof v === 'object' ? { v: JSON.stringify(v) } : { def: true };
  if (t === 'i' || t === 'n') {
    if (blank(v)) return spec.null ? { v: null } : { def: true };
    const n = Number(v); if (!Number.isFinite(n)) throw new HttpError(400, 'Número inválido em ' + spec.f);
    return { v: t === 'i' ? Math.trunc(n) : n };
  }
  if (t === 'd' || t === 'tm') {
    if (blank(v)) return spec.null ? { v: null } : { def: true };
    return { v: t === 'd' ? String(v).slice(0, 10) : String(v).slice(0, 8) };
  }
  throw new Error('tipo desconhecido ' + t);
}

/* ---- linha do banco -> valor do front ---- */
function fromDbVal(spec, v) {
  const { t } = spec;
  if (t === 'b') return !!v;
  if (t === 'a') return v || [];
  if (t === 'j') return v || {};
  if (t === 'i' || t === 'n') return v === null || v === undefined ? ('empty' in spec ? spec.empty : null) : v;
  if (t === 'tm') return v ? String(v).slice(0, 5) : '';
  return v === null || v === undefined ? '' : v;
}
function rowToRec(specs, row, hasExtra) {
  const rec = hasExtra ? { ...(row.extra || {}) } : {};
  for (const s of specs) setPath(rec, s.f, fromDbVal(s, row[s.col]));
  if (row.id !== undefined && row.id !== null) rec.id = row.id;
  return rec;
}
const topKeys = specs => new Set(specs.map(s => s.f.split('.')[0]));

/* ---- monta INSERT ... ON CONFLICT ---- */
async function buildInsert(ctx, table, specs, rec, fixed, o) {
  o = o || {};
  const cols = [], vals = [], params = [], upd = [];
  const add = (col, ph) => { cols.push(col); vals.push(ph); };
  for (const [col, val, cast] of fixed) { params.push(val); add(col, `$${params.length}${cast || ''}`); }
  for (const s of specs) {
    const r = await toDb(s, getPath(rec, s.f), ctx);
    if (r.def) add(s.col, 'DEFAULT'); else { params.push(r.v); add(s.col, `$${params.length}${CAST[s.t] || ''}`); }
    if (o.conflict) upd.push(`${s.col} = EXCLUDED.${s.col}`);
  }
  if (o.extra) {
    const keep = topKeys(specs), ex = {};
    for (const k of Object.keys(rec)) if (k !== 'id' && !keep.has(k) && !(o.skip && o.skip.has(k))) ex[k] = rec[k];
    params.push(JSON.stringify(ex)); add('extra', `$${params.length}::jsonb`); if (o.conflict) upd.push('extra = EXCLUDED.extra');
  }
  let sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${vals.join(', ')})`;
  if (o.conflict) sql += ` ON CONFLICT (${o.conflict}) DO UPDATE SET ${upd.join(', ')}`;
  else if (o.ignore) sql += ' ON CONFLICT DO NOTHING';
  return { sql, params };
}

/* ============================================================
   Configuração das coleções
   ============================================================ */
const SK = ['grammar', 'vocabulary', 'reading', 'writing', 'listening', 'speaking', 'pronunciation'];
const COLLECTIONS = {
  students: {
    table: 'students',
    cols: [c('accountId', 'user_id', 'fk', { ref: 'users' }), c('groupId', 'group_id', 'fk', { ref: 'groups' }), c('name', 'name', 't'), c('photo', 'photo', 't'), c('email', 'email', 't'), c('phone', 'phone', 't'),
      c('birth', 'birth', 'd', { null: true }), c('startDate', 'start_date', 'd', { null: true }), c('level', 'level', 't'), c('goals', 'goals', 't'), c('courseType', 'course_type', 't'), c('frequency', 'frequency', 't'),
      c('duration', 'duration_min', 'i'), c('monthly', 'monthly', 'n'), c('dueDay', 'due_day', 'i'), c('payMethod', 'pay_method', 't'), c('observations', 'observations', 't'), c('status', 'status', 't'), c('archived', 'archived', 'b'),
      c('zoomUrl', 'zoom_url', 't'), c('calendarUrl', 'calendar_url', 't'), c('calendarNote', 'calendar_note', 't'), c('minor', 'minor', 'b'), c('guardianPhone', 'guardian_phone', 't'), c('guardFin', 'guardian_finance_visible', 'b'),
      c('guide', 'guide', 'j'), c('bannerTitle', 'banner_title', 't'), c('bannerSub', 'banner_sub', 't'), c('bannerTheme', 'banner_theme', 't'), c('bannerImageId', 'banner_image_id', 'fk', { ref: 'files' })],
    required: ['name'],
    kids: [
      { kind: 'objs', field: 'schedule', table: 'student_schedule', parent: 'student_id', cols: [c('day', 'weekday', 'i'), c('time', 'at_time', 'tm')], order: 'weekday', extra: true, ignore: true },
      { kind: 'objs', field: 'levelHistory', table: 'student_level_history', parent: 'student_id', cols: [c('date', 'changed_on', 'd', { null: true }), c('from', 'from_level', 't'), c('to', 'to_level', 't')], pos: 'position', extra: true },
      { kind: 'ids', field: 'guardians', table: 'guardians', parent: 'student_id', child: 'user_id', ref: 'users' }
    ]
  },
  groups: { table: 'groups', cols: [c('name', 'name', 't'), c('zoomUrl', 'zoom_url', 't'), c('zoomNote', 'zoom_note', 't'), c('calendarUrl', 'calendar_url', 't'), c('calendarNote', 'calendar_note', 't'), c('bannerTitle', 'banner_title', 't'), c('guide', 'guide', 'j')], required: ['name'] },
  lessons: {
    table: 'lessons',
    cols: [c('studentId', 'student_id', 'fk', { ref: 'students', req: true }), c('date', 'date', 'd'), c('time', 'at_time', 'tm'), c('duration', 'duration_min', 'i'), c('type', 'type', 't'), c('status', 'status', 't'), c('topic', 'topic', 't'),
      c('objectives', 'objectives', 't'), c('content', 'content', 't'), c('skills', 'skills', 'a'), c('homeworkText', 'homework_text', 't'), c('observations', 'observations', 't'), c('makeupFor', 'makeup_for', 'fk', { ref: 'lessons' }), c('notes', 'notes', 'j'),
      c('lr.summary', 'lr_summary', 't'), c('lr.vocabulary', 'lr_vocabulary', 't'), c('lr.highlights', 'lr_highlights', 't'), c('lr.homework', 'lr_homework', 't'), c('lr.nextSteps', 'lr_next_steps', 't'),
      c('lr.published', 'lr_published', 'b'), c('lr.publishedAt', 'lr_published_at', 't')],
    required: ['date', 'time'],
    after(rec) { const l = rec.lr; if (l && !l.published && !l.summary && !l.vocabulary && !l.highlights && !l.homework && !l.nextSteps) delete rec.lr; },
    kids: [{ kind: 'ids', field: 'materials', table: 'lesson_materials', parent: 'lesson_id', child: 'material_id', ref: 'materials' }, { kind: 'ids', field: 'exercises', table: 'lesson_exercises', parent: 'lesson_id', child: 'exercise_id', ref: 'exercises' }]
  },
  exercises: {
    table: 'exercises',
    cols: [c('title', 'title', 't'), c('type', 'type', 't'), c('skills', 'skills', 'a'), c('level', 'level', 't'), c('estMinutes', 'est_minutes', 'i'), c('mediaUrl', 'media_url', 't'), c('instructions', 'instructions', 't'), c('baseText', 'base_text', 't'), c('notes', 'notes', 't')],
    required: ['title'],
    kids: [{ kind: 'objs', field: 'questions', table: 'exercise_questions', parent: 'exercise_id', cols: [c('prompt', 'prompt', 't'), c('options', 'options', 'a'), c('answer', 'answer', 't'), c('explanation', 'explanation', 't')], pos: 'position', extra: true }]
  },
  homework: {
    table: 'homework',
    cols: [c('studentId', 'student_id', 'fk', { ref: 'students', req: true }), c('exerciseId', 'exercise_id', 'fk', { ref: 'exercises' }), c('title', 'title', 't'), c('description', 'description', 't'), c('assignedDate', 'assigned_date', 'd'),
      c('dueDate', 'due_date', 'd', { null: true }), c('estMinutes', 'est_minutes', 'i', { null: true, empty: '' }), c('status', 'status', 't'), c('docHtml', 'doc_html', 't'), c('attachId', 'attach_file_id', 'fk', { ref: 'files' }), c('attachUrl', 'attach_url', 't'),
      c('score', 'score', 'n', { null: true }), c('maxScore', 'max_score', 'n'), c('feedback', 'feedback', 't'), c('deliveredDate', 'delivered_date', 'd', { null: true }), c('correctedDate', 'corrected_date', 'd', { null: true }), c('studentNotes', 'student_notes', 't')],
    required: ['title']
  },
  plans: {
    table: 'plans',
    cols: [c('studentId', 'student_id', 'fk', { ref: 'students', req: true }), c('weekStart', 'week_start', 'd'), c('weekEnd', 'week_end', 'd'), c('pdfAssetId', 'pdf_file_id', 'fk', { ref: 'files' }), c('pdfUrl', 'pdf_url', 't')],
    required: ['weekStart', 'weekEnd'],
    kids: [{ kind: 'groups', field: 'days', table: 'plan_activities', parent: 'plan_id', key: 'day', pos: 'position', cols: [c('id', 'id', 't'), c('title', 'title', 't'), c('skill', 'skill', 't'), c('minutes', 'minutes', 'i', { null: true, empty: 0 }), c('status', 'status', 't'),
      c('exerciseId', 'exercise_id', 'fk', { ref: 'exercises' }), c('materialId', 'material_id', 'fk', { ref: 'materials' }), c('homeworkId', 'homework_id', 'fk', { ref: 'homework' }), c('notes', 'notes', 't')], extra: true }]
  },
  reports: {
    table: 'reports',
    cols: [c('studentId', 'student_id', 'fk', { ref: 'students', req: true }), c('periodStart', 'period_start', 'd'), c('periodEnd', 'period_end', 'd'), c('strengths', 'strengths', 't'), c('improve', 'improve', 't'), c('nextSteps', 'next_steps', 't'),
      c('teacherNotes', 'teacher_notes', 't'), c('shared', 'shared', 'b'), c('snapshot', 'snapshot', 'j')],
    required: ['periodStart', 'periodEnd'],
    kids: [{ kind: 'map', field: 'scores', table: 'report_scores', parent: 'report_id', key: 'skill', cols: [c('score', 'score', 'n', { null: true }), c('comment', 'comment', 't')] }]
  },
  charges: { table: 'charges', cols: [c('studentId', 'student_id', 'fk', { ref: 'students', req: true }), c('refMonth', 'ref_month', 't'), c('amount', 'amount', 'n'), c('dueDate', 'due_date', 'd', { null: true })], required: ['refMonth', 'amount'] },
  payments: { table: 'payments', cols: [c('studentId', 'student_id', 'fk', { ref: 'students', req: true }), c('refMonth', 'ref_month', 't'), c('amount', 'amount', 'n'), c('discount', 'discount', 'n'), c('date', 'paid_on', 'd'), c('method', 'method', 't'), c('notes', 'notes', 't')], required: ['refMonth', 'date'] },
  materials: {
    table: 'materials',
    cols: [c('title', 'title', 't'), c('category', 'category', 't'), c('skill', 'skill', 't'), c('level', 'level', 't'), c('description', 'description', 't'), c('link', 'link', 't'), c('tags', 'tags', 'a'), c('showStudent', 'show_student', 'b'), c('assetId', 'file_id', 'fk', { ref: 'files' })],
    required: ['title'],
    kids: [{ kind: 'ids', field: 'studentIds', table: 'material_students', parent: 'material_id', child: 'student_id', ref: 'students' }]
  },
  goals: { table: 'goals', cols: [c('studentId', 'student_id', 'fk', { ref: 'students', req: true }), c('name', 'name', 't'), c('skill', 'skill', 't'), c('status', 'status', 't'), c('progress', 'progress', 'i'), c('deadline', 'deadline', 'd', { null: true }), c('notes', 'notes', 't')], required: ['name'] },
  tasks: { table: 'tasks', cols: [c('studentId', 'student_id', 'fk', { ref: 'students' }), c('title', 'title', 't'), c('category', 'category', 't'), c('priority', 'priority', 't'), c('dueDate', 'due_date', 'd', { null: true }), c('notes', 'notes', 't'), c('done', 'done', 'b'), c('doneDate', 'done_date', 'd', { null: true })], required: ['title'] },
  notes: { table: 'student_notes', cols: [c('studentId', 'student_id', 'fk', { ref: 'students', req: true }), c('text', 'text', 't')], required: ['text'] },
  packages: { table: 'packages', cols: [c('studentId', 'student_id', 'fk', { ref: 'students', req: true }), c('total', 'total', 'i'), c('startDate', 'start_date', 'd', { null: true }), c('validUntil', 'valid_until', 'd', { null: true }), c('notes', 'notes', 't')] },
  contracts: {
    table: 'contracts',
    cols: [c('studentId', 'student_id', 'fk', { ref: 'students', req: true }), c('status', 'status', 't'), c('type', 'type', 't'), c('typeName', 'type_name', 't'), c('startDate', 'start_date', 'd'), c('endDate', 'end_date', 'd', { null: true }),
      c('totalLessons', 'total_lessons', 'i', { null: true, empty: '' }), c('signedDate', 'signed_date', 'd', { null: true }), c('notes', 'notes', 't'), c('showStudent', 'show_student', 'b'), c('assetId', 'file_id', 'fk', { ref: 'files' })],
    required: ['type', 'startDate']
  },
  stages: {
    table: 'stages',
    cols: [c('contractId', 'contract_id', 'fk', { ref: 'contracts', req: true }), c('studentId', 'student_id', 'fk', { ref: 'students', req: true }), c('order', 'position', 'i'), c('title', 'title', 't'), c('description', 'description', 't'), c('skill', 'skill', 't'),
      c('startDate', 'start_date', 'd', { null: true }), c('endDate', 'end_date', 'd', { null: true }), c('status', 'status', 't'), c('completedDate', 'completed_date', 'd', { null: true }), c('note', 'note', 't')],
    required: ['title']
  },
  recordings: {
    table: 'recordings',
    cols: [c('studentId', 'student_id', 'fk', { ref: 'students', req: true }), c('lessonId', 'lesson_id', 'fk', { ref: 'lessons' }), c('title', 'title', 't'), c('date', 'date', 'd', { null: true }), c('url', 'url', 't'), c('assetId', 'file_id', 'fk', { ref: 'files' }), c('note', 'note', 't'), c('shared', 'shared', 'b')]
  }
};
const SETTINGS = {
  table: 'app_settings', idCast: '::boolean',
  cols: [c('teacherName', 'teacher_name', 't'), c('platformName', 'platform_name', 't'), c('businessName', 'business_name', 't'), c('businessEmail', 'business_email', 't'), c('businessPhone', 'business_phone', 't'), c('locale', 'locale', 't'), c('currency', 'currency', 't'),
    c('theme', 'theme', 't'), c('density', 'density', 't'), c('weekStart', 'week_start', 'i'), c('defaultDuration', 'default_duration_min', 'i'), c('defaultMonthly', 'default_monthly', 'n'), c('defaultDueDay', 'default_due_day', 'i'),
    c('absenceCountsPackage', 'absence_counts_package', 'b'), c('reportIntervalDays', 'report_interval_days', 'i'), c('paymentMethods', 'payment_methods', 'a'), c('guide', 'guide', 'j'), c('banner', 'banner', 'j'), c('modelsSeeded', 'models_seeded', 'b')]
};

/* ============================================================
   Leitura
   ============================================================ */
async function loadKids(cfg, ids, q) {
  const out = new Map(ids.map(i => [i, {}]));
  for (const k of cfg.kids || []) {
    if (k.kind === 'ids') {
      const r = await q(`SELECT ${k.parent} AS p, ${k.child} AS c FROM ${k.table} WHERE ${k.parent} = ANY($1) ORDER BY ${k.child}`, [ids]);
      ids.forEach(i => { out.get(i)[k.field] = []; }); r.rows.forEach(x => out.get(x.p)[k.field].push(x.c));
    } else if (k.kind === 'objs') {
      const r = await q(`SELECT * FROM ${k.table} WHERE ${k.parent} = ANY($1) ORDER BY ${k.pos || k.order}`, [ids]);
      ids.forEach(i => { out.get(i)[k.field] = []; });
      r.rows.forEach(x => out.get(x[k.parent])[k.field].push(rowToRec(k.cols, x, k.extra)));
      for (const i of ids) for (const o of out.get(i)[k.field]) delete o.id;
    } else if (k.kind === 'groups') {
      const r = await q(`SELECT * FROM ${k.table} WHERE ${k.parent} = ANY($1) ORDER BY ${k.pos}, id`, [ids]);
      ids.forEach(i => { out.get(i)[k.field] = {}; });
      r.rows.forEach(x => { const d = out.get(x[k.parent])[k.field]; (d[x[k.key]] = d[x[k.key]] || []).push(rowToRec(k.cols, x, k.extra)); });
    } else if (k.kind === 'map') {
      const r = await q(`SELECT * FROM ${k.table} WHERE ${k.parent} = ANY($1)`, [ids]);
      ids.forEach(i => { out.get(i)[k.field] = {}; });
      r.rows.forEach(x => { const o = rowToRec(k.cols, x, false); delete o.id; out.get(x[k.parent])[k.field][x[k.key]] = o; });
    }
  }
  return out;
}
async function list(name, ids) {
  const cfg = COLLECTIONS[name];
  const r = ids ? await query(`SELECT * FROM ${cfg.table} WHERE id = ANY($1) ORDER BY id`, [ids]) : await query(`SELECT * FROM ${cfg.table} ORDER BY id`);
  if (!r.rows.length) return [];
  const kids = await loadKids(cfg, r.rows.map(x => x.id), query);
  return r.rows.map(row => { const rec = { ...rowToRec(cfg.cols, row, true) }; Object.assign(rec, kids.get(row.id)); if (cfg.after) cfg.after(rec); return rec; });
}
const get = async (name, id) => (await list(name, [id]))[0] || null;
async function getSettings() {
  const r = await query('SELECT * FROM app_settings WHERE id = true');
  if (!r.rows.length) return { exists: false, settings: {} };
  const rec = rowToRec(SETTINGS.cols, r.rows[0], true); delete rec.id;
  return { exists: true, settings: rec };
}

/* ============================================================
   Escrita
   ============================================================ */
function validate(cfg, rec) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) throw new HttpError(400, 'Corpo inválido: envie um objeto JSON.');
  for (const k of cfg.required || []) if (blank(rec[k])) throw new HttpError(400, 'Campo obrigatório: ' + k);
}
async function saveKids(client, cfg, id, rec, ctx) {
  for (const k of cfg.kids || []) {
    const v = rec[k.field];
    await client.query(`DELETE FROM ${k.table} WHERE ${k.parent} = $1`, [id]);
    if (v === undefined || v === null) continue;
    if (k.kind === 'ids') {
      const want = [...new Set((Array.isArray(v) ? v : []).map(String).filter(Boolean))];
      if (want.length) await client.query(`INSERT INTO ${k.table} (${k.parent}, ${k.child}) SELECT $1::text, x FROM unnest($2::text[]) x WHERE x IN (SELECT id FROM ${k.ref}) ON CONFLICT DO NOTHING`, [id, want]);
    } else if (k.kind === 'objs') {
      const list = Array.isArray(v) ? v : [];
      for (let i = 0; i < list.length; i++) {
        const fixed = [[k.parent, id]]; if (k.pos) fixed.push([k.pos, i]);
        const { sql, params } = await buildInsert(ctx, k.table, k.cols, list[i] || {}, fixed, { extra: k.extra, ignore: k.ignore });
        await client.query(sql, params);
      }
    } else if (k.kind === 'groups') {
      for (const [key, arr] of Object.entries(v && typeof v === 'object' ? v : {})) {
        const list = Array.isArray(arr) ? arr : [];
        for (let i = 0; i < list.length; i++) {
          const { sql, params } = await buildInsert(ctx, k.table, k.cols, list[i] || {}, [[k.parent, id], [k.key, key], [k.pos, i]], { extra: k.extra, ignore: true });
          await client.query(sql, params);
        }
      }
    } else if (k.kind === 'map') {
      for (const [key, o] of Object.entries(v && typeof v === 'object' ? v : {})) {
        const { sql, params } = await buildInsert(ctx, k.table, k.cols, o || {}, [[k.parent, id], [k.key, key]], {});
        await client.query(sql, params);
      }
    }
  }
}
async function upsert(name, id, rec) {
  const cfg = COLLECTIONS[name]; validate(cfg, rec);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(id))) throw new HttpError(400, 'Identificador inválido.');
  const skip = new Set((cfg.kids || []).map(k => k.field));
  await tx(async client => {
    const ctx = { q: (s, p) => client.query(s, p), cache: new Map() };
    const { sql, params } = await buildInsert(ctx, cfg.table, cfg.cols, rec, [['id', String(id)]], { extra: true, conflict: 'id', skip });
    await client.query(sql, params);
    await saveKids(client, cfg, String(id), rec, ctx);
  });
}
async function saveSettings(rec) {
  validate(SETTINGS, rec);
  await tx(async client => {
    const ctx = { q: (s, p) => client.query(s, p), cache: new Map() };
    const { sql, params } = await buildInsert(ctx, SETTINGS.table, SETTINGS.cols, rec, [['id', true, '::boolean']], { extra: true, conflict: 'id' });
    await client.query(sql, params);
  });
}
async function remove(name, id) { const r = await query(`DELETE FROM ${COLLECTIONS[name].table} WHERE id = $1`, [String(id)]); return r.rowCount || 0; }

/* erros do PostgreSQL -> mensagens para o front */
function friendly(e) {
  if (e instanceof HttpError) return e;
  const m = { 23505: [409, 'Já existe um registro com esses dados.'], 23503: [409, 'Referência inválida ou registro em uso por outros dados.'], 23502: [400, 'Campo obrigatório ausente: ' + (e.column || '')], 23514: [400, 'Valor fora do permitido: ' + (e.constraint || '')],
    '22P02': [400, 'Valor em formato inválido.'], 22007: [400, 'Data inválida.'], 22008: [400, 'Data inválida.'], 22001: [400, 'Texto grande demais.'] }[e.code];
  return m ? new HttpError(m[0], m[1]) : e;
}

module.exports = { HttpError, COLLECTIONS, list, get, upsert, remove, getSettings, saveSettings, friendly };
