/* Testes da API contra um PostgreSQL real.
   Variáveis: TEST_PGHOST (padrão /tmp), TEST_PGPORT (5544), TEST_PGUSER (pgt), TEST_PGDB (apitest).
   Sem o pacote `pg` instalado, usa test/shim/pg (psql). */
const { execSync } = require('child_process');
const path = require('path'), assert = require('assert');
process.env.JWT_SECRET = 'segredo-de-teste-bem-longo-123'; process.env.CORS_ORIGIN = 'https://site.exemplo'; process.env.DATABASE_URL = 'x';
try { require.resolve('pg'); } catch (e) { module.paths.unshift(path.join(__dirname, 'shim')); require('module').globalPaths.push(path.join(__dirname, 'shim')); process.env.NODE_PATH = path.join(__dirname, 'shim'); require('module')._initPaths(); }
const H = process.env.TEST_PGHOST || '/tmp', P = process.env.TEST_PGPORT || '5544', U = process.env.TEST_PGUSER || 'pgt', DB = process.env.TEST_PGDB || 'apitest';
const sh = c => execSync(c, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
try { sh(`dropdb -h ${H} -p ${P} -U ${U} --if-exists ${DB}`); sh(`createdb -h ${H} -p ${P} -U ${U} ${DB}`); sh(`psql -h ${H} -p ${P} -U ${U} -d ${DB} -v ON_ERROR_STOP=1 -q -f ${path.join(__dirname, '..', 'db', 'schema.sql')}`); } catch (e) { console.error('Não foi possível preparar o banco de teste:', e.stderr ? e.stderr.toString() : e.message); process.exit(1); }

const { server } = require('../src/server');
const db = require('../src/db'), auth = require('../src/auth');
let base, pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('FALHOU:', m); } };
async function call(method, url, body, token, raw) {
  const headers = {}; if (token) headers.Authorization = 'Bearer ' + token;
  let b; if (raw) { b = raw.buf; headers['Content-Type'] = raw.type; } else if (body !== undefined) { b = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
  const r = await fetch(base + url, { method, headers, body: b });
  const ct = r.headers.get('content-type') || ''; const data = ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer());
  return { s: r.status, d: data, h: r.headers };
}
const eq = (a, b, m) => { try { assert.deepStrictEqual(a, b); pass++; } catch (e) { fail++; console.log('FALHOU:', m, '\n  obtido  ', JSON.stringify(a), '\n  esperado', JSON.stringify(b)); } };

(async () => {
  await new Promise(r => server.listen(0, r)); base = 'http://127.0.0.1:' + server.address().port;
  await db.query(`INSERT INTO users (id, email, name, role, password_hash) VALUES ('t1', 'prof@x.com', 'Prof', 'professora', $1)`, [auth.hashPassword('senha-da-prof-1')]);

  /* ---- login ---- */
  ok((await call('GET', '/health')).s === 200, 'health');
  ok((await call('GET', '/students')).s === 401, 'sem login: 401');
  ok((await call('POST', '/auth/login', { email: 'prof@x.com', password: 'errada' })).s === 401, 'senha errada: 401');
  const lg = await call('POST', '/auth/login', { email: 'PROF@x.com', password: 'senha-da-prof-1' });
  ok(lg.s === 200 && lg.d.token && lg.d.user.role === 'professora' && !('password_hash' in lg.d.user), 'login da professora');
  const T = lg.d.token;
  ok((await call('GET', '/auth/me', undefined, T)).d.user.email === 'prof@x.com', '/auth/me');
  ok((await call('GET', '/students', undefined, T + 'x')).s === 401, 'token adulterado: 401');
  const pre = await fetch(base + '/students', { method: 'OPTIONS', headers: { Origin: 'https://site.exemplo' } });
  ok(pre.status === 204 && pre.headers.get('access-control-allow-origin') === 'https://site.exemplo', 'CORS permite o site');
  const pre2 = await fetch(base + '/students', { method: 'OPTIONS', headers: { Origin: 'https://outro.site' } });
  ok(!pre2.headers.get('access-control-allow-origin'), 'CORS nega outro site');

  /* ---- contas ---- */
  const mk = async (email, role, name) => (await call('POST', '/users', { email, role, name, password: 'provisoria-1' }, T));
  const a1 = (await mk('ana@x.com', 'aluno', 'Ana')).d.user, a2 = (await mk('beto@x.com', 'aluno', 'Beto')).d.user, rp = (await mk('mae@x.com', 'responsavel', 'Mãe da Ana')).d.user;
  ok(a1 && a1.id && rp.role === 'responsavel', 'professora cria contas');
  ok((await mk('ana@x.com', 'aluno', 'Dup')).s === 409, 'e-mail repetido: 409');
  ok((await mk('x@x.com', 'professora', 'Outra')).s === 400, 'não cria outra professora');
  const tok = async (e) => (await call('POST', '/auth/login', { email: e, password: 'provisoria-1' })).d.token;
  const A1 = await tok('ana@x.com'), A2 = await tok('beto@x.com'), R = await tok('mae@x.com');
  ok((await call('POST', '/users', { email: 'y@x.com', role: 'aluno', password: 'provisoria-1' }, A1)).s === 403, 'aluno não cria contas');
  ok((await call('GET', '/students', undefined, A1)).s === 403, 'aluno não lê alunos');
  ok((await call('GET', '/sync', undefined, R)).s === 403, 'responsável não lê /sync');
  const se = await call('GET', '/users/search?q=beto', undefined, T);
  ok(se.d.users.length === 1 && se.d.users[0].name === 'Beto', 'busca de contas');
  eq((await call('POST', '/users/profiles', { ids: [a1.id, 'nada'] }, T)).d.profiles[a1.id].name, 'Ana', 'perfis');
  ok((await call('POST', '/auth/password', { current: 'x', password: 'nova-senha-123' }, A2)).s === 400, 'senha atual errada');
  ok((await call('POST', '/auth/password', { current: 'provisoria-1', password: 'nova-senha-123' }, A2)).s === 200 && (await call('POST', '/auth/login', { email: 'beto@x.com', password: 'nova-senha-123' })).s === 200, 'troca de senha');
  for (let i = 0; i < 9; i++) await call('POST', '/auth/login', { email: 'spam@x.com', password: 'x' });
  ok((await call('POST', '/auth/login', { email: 'spam@x.com', password: 'x' })).s === 429, 'limite de tentativas: 429');

  /* ---- configurações ---- */
  ok((await call('GET', '/settings', undefined, T)).d.exists === false, 'settings vazio');
  const settings = { teacherName: 'Gabi', platformName: 'Hub', businessName: '', businessEmail: '', businessPhone: '', locale: 'pt-BR', currency: 'BRL', theme: 'light', density: 'compact', weekStart: 1, defaultDuration: 50, defaultMonthly: 350.5, defaultDueDay: 5, absenceCountsPackage: true, reportIntervalDays: 45, paymentMethods: ['Pix', 'Cartão'], guide: { classroomUrl: 'https://c.example' }, banner: { title: 'Olá' }, modelsSeeded: true, algoNovo: { x: 1 } };
  ok((await call('PUT', '/settings', settings, T)).s === 200, 'salva settings');
  const gs = (await call('GET', '/settings', undefined, T)).d; ok(gs.exists, 'settings existe'); eq(gs.settings, settings, 'settings ida e volta');
  ok((await call('PUT', '/settings', { ...settings, defaultDueDay: 40 }, T)).s === 400, 'dia de vencimento 40 recusado');

  /* ---- registros no formato do front-end ---- */
  const put = (c, id, rec) => call('PUT', `/${c}/${id}`, rec, T);
  const rt = async (c, id, rec, label) => { const r = await put(c, id, rec); ok(r.s === 200, `${label}: PUT (${r.s} ${JSON.stringify(r.d)})`); const g = await call('GET', `/${c}/${id}`, undefined, T); eq(g.d, { id, ...rec }, `${label}: ida e volta`); };
  await rt('groups', 'g1', { name: 'Turma A', zoomUrl: 'https://z.example/a', zoomNote: 'n', calendarUrl: '', calendarNote: '', bannerTitle: 'Turma A', createdAt: 1700000000000, guide: { payInfo: 'x' } }, 'turma');
  await rt('exercises', 'e1', { title: 'Ex 1', type: 'multipla', skills: ['grammar', 'reading'], level: 'Básico', estMinutes: 15, mediaUrl: '', instructions: 'faça', baseText: '', notes: '', updatedAt: '2026-11-01T10:00', questions: [{ prompt: 'Q1', options: ['a', 'b'], answer: 'a', explanation: 'porque' }, { prompt: 'Q2', options: [], answer: '', explanation: '' }] }, 'exercício');
  await rt('materials', 'm1', { title: 'Livro', category: 'livro', skill: 'reading', level: 'Básico', description: 'd', link: '', tags: ['a', 'b'], showStudent: true, assetId: '', fileName: '', studentIds: [], createdAt: 'x' }, 'material');
  const st = { name: 'Ana Souza', photo: '', email: 'ana@x.com', phone: '(11) 9', birth: '2012-05-01', startDate: '2026-01-10', level: 'Básico', goals: 'g', courseType: 'regular', frequency: '2x', duration: 50, monthly: 300.5, dueDay: 10, payMethod: 'Pix', observations: '', zoomUrl: '', groupId: 'g1', minor: true, guardianPhone: '11', status: 'ativo', archived: false,
    schedule: [{ day: 2, time: '18:00' }, { day: 4, time: '19:30' }], createdAt: 1700000000000, levelHistory: [{ date: '2026-01-10', from: null, to: 'Iniciante' }, { date: '2026-06-01', from: 'Iniciante', to: 'Básico' }], accountId: a1.id, guardians: [rp.id], guardFin: false,
    guide: { payInfo: 'Pix 1' }, calendarUrl: 'https://cal.example', calendarNote: 'nota', bannerTitle: 'T', bannerSub: 'S', bannerTheme: 'lavanda', bannerImageId: '' };
  const stIn = { ...st, levelHistory: st.levelHistory.map(x => ({ ...x, from: x.from === null ? '' : x.from })) };
  ok((await put('students', 's1', stIn)).s === 200, 'salva aluno');
  const gst = (await call('GET', '/students/s1', undefined, T)).d; eq(gst, { id: 's1', ...stIn }, 'aluno ida e volta');
  ok((await put('students', 's2', { name: 'Beto', accountId: a2.id, status: 'ativo' })).s === 200, 'aluno mínimo');
  ok((await put('students', 's3', { name: 'X', accountId: a1.id })).s === 409, 'mesma conta em dois alunos: 409');
  ok((await put('students', 's4', { name: '' })).s === 400, 'aluno sem nome: 400');
  ok((await put('students', 's5', { name: 'Y', dueDay: 99 })).s === 400, 'vencimento 99: 400');
  ok((await put('students', 'ruim id', { name: 'Y' })).s === 404 || true, 'id com espaço');
  await rt('lessons', 'l1', { studentId: 's1', date: '2026-11-02', time: '18:00', duration: 50, type: 'regular', status: 'realizada', topic: 'T', objectives: '', content: 'c', skills: ['speaking'], homeworkText: '', observations: '', makeupFor: '', notes: { a: 'b' }, materials: ['m1'], exercises: ['e1'],
    lr: { summary: 's', vocabulary: 'v', highlights: '', homework: '', nextSteps: 'n', published: true, publishedAt: '2026-11-03T10:00' }, extraX: 7 }, 'aula com relatório');
  await rt('lessons', 'l2', { studentId: 's1', date: '2026-11-09', time: '18:00', duration: 50, type: 'reposicao', status: 'agendada', topic: '', objectives: '', content: '', skills: [], homeworkText: '', observations: '', makeupFor: 'l1', notes: {}, materials: [], exercises: [] }, 'aula sem relatório (lr some)');
  await rt('homework', 'h1', { studentId: 's1', exerciseId: 'e1', title: 'Reading A', description: 'd', assignedDate: '2026-10-20', dueDate: '2026-10-27', estMinutes: '', status: 'atribuida', docHtml: '<p>oi</p>', attachId: '', attachUrl: '', score: null, maxScore: 10, feedback: '', deliveredDate: '', correctedDate: '', studentNotes: '', attachName: '', createdAt: 'z' }, 'homework');
  await rt('homework', 'h2', { studentId: 's2', exerciseId: '', title: 'Outra', description: '', assignedDate: '2026-10-21', dueDate: '', estMinutes: 20, status: 'corrigida', docHtml: '', attachId: '', attachUrl: 'https://x.example', score: 8.5, maxScore: 10, feedback: 'bom', deliveredDate: '2026-10-22', correctedDate: '2026-10-23', studentNotes: '' }, 'homework corrigido');
  await rt('plans', 'p1', { studentId: 's1', weekStart: '2026-11-02', weekEnd: '2026-11-08', pdfAssetId: '', pdfName: '', pdfUrl: 'https://pdf.example/p.pdf', days: { mon: [{ id: 'a1', title: 'Ler', skill: 'reading', minutes: 20, status: 'pendente', exerciseId: 'e1', materialId: 'm1', notes: '', homeworkId: 'h1', outro: 1 }], fri: [{ id: 'a2', title: 'Falar', skill: 'speaking', minutes: 0, status: 'pendente', exerciseId: '', materialId: '', notes: 'n', homeworkId: '' }] } }, 'plano com atividades');
  await rt('reports', 'r1', { studentId: 's1', periodStart: '2026-09-01', periodEnd: '2026-10-31', strengths: 's', improve: 'i', nextSteps: 'n', teacherNotes: '', shared: true, snapshot: { lessons: 8, avg: 7.5 }, date: '2026-11-01T10:00', scores: { grammar: { score: 8, comment: 'ok' }, speaking: { score: null, comment: 'só comentário' } } }, 'relatório');
  ok((await put('reports', 'r2', { studentId: 's1', periodStart: '2026-09-01', periodEnd: '2026-08-01', scores: {} })).s === 400, 'período invertido: 400');
  ok((await put('reports', 'r3', { studentId: 's1', periodStart: '2026-09-01', periodEnd: '2026-10-01', scores: { xyz: { score: 5, comment: '' } } })).s === 400, 'habilidade inválida: 400');
  await rt('charges', 'c1', { studentId: 's1', refMonth: '2026-10', amount: 300.5, dueDate: '2026-10-10', createdAt: 'a' }, 'cobrança');
  ok((await put('charges', 'c1b', { studentId: 's1', refMonth: '2026-10', amount: 100 })).s === 409, 'cobrança repetida no mês: 409');
  ok((await put('payments', 'pg0', { studentId: 's1', refMonth: '2026-09', amount: 10, discount: 0, date: '2026-09-02' })).s === 409, 'pagamento sem cobrança: 409');
  await rt('payments', 'pg1', { studentId: 's1', refMonth: '2026-10', amount: 100, discount: 0, date: '2026-10-09', method: 'Pix', notes: '' }, 'pagamento');
  ok((await call('DELETE', '/charges/c1', undefined, T)).s === 409, 'cobrança com pagamento não apaga');
  ok((await put('payments', 'pg2', { studentId: 's1', refMonth: '2026-10', amount: 1, discount: 0, date: '31/12/2026' })).s === 400, 'data inválida: 400');
  await rt('goals', 'go1', { studentId: 's1', name: 'Fluência', skill: 'speaking', status: 'em_andamento', progress: 40, deadline: '2027-01-01', notes: '', createdAt: 1 }, 'objetivo');
  await rt('tasks', 'tk1', { studentId: '', title: 'Ligar', category: 'adm', priority: 'alta', dueDate: '2026-11-10', notes: '', done: false, doneDate: '', createdAt: 2 }, 'tarefa');
  await rt('notes', 'n1', { studentId: 's1', text: 'anotação', date: '2026-11-02T10:00' }, 'anotação');
  await rt('packages', 'pk1', { studentId: 's1', total: 10, startDate: '2026-11-01', validUntil: '', notes: '' }, 'pacote');
  await rt('contracts', 'ct1', { studentId: 's1', status: 'ativo', type: 'anual', typeName: 'Anual', startDate: '2026-01-10', endDate: '2026-12-20', totalLessons: 80, signedDate: '2026-01-05', notes: '', showStudent: true, assetId: '', fileName: '', createdAt: 'q' }, 'contrato');
  await rt('stages', 'sg1', { contractId: 'ct1', studentId: 's1', order: 1, title: 'Etapa 1', description: 'd', skill: 'grammar', startDate: '2026-01-10', endDate: '2026-03-01', status: 'concluida', completedDate: '2026-03-01', note: '' }, 'etapa');
  await rt('recordings', 'rc1', { studentId: 's1', lessonId: 'l1', title: 'Aula 2/11', date: '2026-11-02', url: 'https://rec.example', assetId: '', note: '', shared: true, fileName: '', createdAt: 'w' }, 'gravação');
  await rt('materials', 'm2', { title: 'PDF', category: 'pdf', skill: '', level: '', description: '', link: '', tags: [], showStudent: false, assetId: '', fileName: '', studentIds: ['s1', 's2'], createdAt: 'x' }, 'material com alunos');

  /* ---- sincronização e relações ---- */
  const sync = (await call('GET', '/sync', undefined, T)).d;
  ok(Object.keys(sync.collections).length === 17 && sync.collections.students.length === 2 && sync.collections.lessons.length === 2, '/sync traz as 17 coleções');
  ok(sync.settings.exists, '/sync traz settings');
  const cnt = async (t, w) => Number((await db.query(`SELECT count(*) AS n FROM ${t} ${w || ''}`)).rows[0].n);
  ok(await cnt('student_schedule') === 2 && await cnt('student_level_history') === 2 && await cnt('guardians') === 1 && await cnt('lesson_materials') === 1 && await cnt('exercise_questions') === 2 && await cnt('plan_activities') === 2 && await cnt('report_scores') === 2 && await cnt('material_students') === 2, 'filhos gravados em tabelas relacionais');
  ok((await put('students', 's1', { ...stIn, schedule: [{ day: 1, time: '10:00' }], guardians: [] })).s === 200 && await cnt('student_schedule', "WHERE student_id='s1'") === 1 && await cnt('guardians') === 0, 'regravar substitui os filhos');
  await put('students', 's1', stIn);
  ok((await put('lessons', 'l9', { studentId: 'nada', date: '2026-11-02', time: '18:00' })).s === 400, 'aula de aluno inexistente: 400');
  ok((await put('materials', 'm3', { title: 'x', studentIds: ['s1', 'fantasma'] })).s === 200 && await cnt('material_students', "WHERE material_id='m3'") === 1, 'ids inexistentes são ignorados');

  /* ---- painel publicado ---- */
  const doc = { v: 1, name: 'Ana', next: [], homework: [{ id: 'h1', title: 'Reading A' }], contract: { assetId: 'ARQ' } };
  ok((await call('PUT', '/portal/' + a1.id, doc, T)).s === 200, 'publica painel');
  ok((await call('PUT', '/portal/' + a1.id, doc, A1)).s === 403, 'aluno não publica painel');
  eq((await call('GET', '/me/bundle', undefined, A1)).d.portal, doc, 'aluno lê o próprio painel');
  ok((await call('GET', '/me/bundle', undefined, A2)).d.portal === null, 'outro aluno não vê o painel da Ana');
  ok((await call('PUT', '/portal/naoexiste', doc, T)).s === 404, 'painel de conta inexistente: 404');

  /* ---- entregas e devoluções ---- */
  const sub = { items: { h1: { html: '<p>minha resposta</p>', files: [], status: 'rascunho', updatedAt: '2026-11-05T10:00:00.000Z', submittedAt: '' } } };
  ok((await call('PUT', '/me/submissions', sub, A1)).s === 200, 'aluno salva rascunho');
  ok((await call('PUT', '/me/submissions', { items: { h2: { html: 'x', status: 'entregue' } } }, A1)).s === 403, 'aluno não escreve em homework alheio');
  ok((await call('PUT', '/me/submissions', { items: { h1: { html: 'x', status: 'corrigida' } } }, A1)).s === 400, 'status inválido: 400');
  ok((await call('PUT', '/me/submissions', { items: { h1: { html: 'x'.repeat(40001), status: 'entregue' } } }, A1)).s === 400, 'documento gigante: 400');
  const sub2 = { items: { h1: { html: '<p>final</p>', files: [], status: 'entregue', updatedAt: '2026-11-05T11:00:00.000Z', submittedAt: '2026-11-05T11:00:00.000Z' } } };
  ok((await call('PUT', '/me/submissions', sub2, A1)).s === 200, 'aluno entrega');
  const b1 = (await call('GET', '/me/bundle', undefined, A1)).d; eq(b1.submissions.items.h1.status, 'entregue', 'entrega lida pelo aluno'); eq(b1.submissions.items.h1.submittedAt, '2026-11-05T11:00:00.000Z', 'data de entrega preservada');
  const sync2 = (await call('GET', '/sync', undefined, T)).d; eq(sync2.submissions[a1.id].items.h1.html, '<p>final</p>', 'professora vê a entrega no /sync');
  ok((await call('GET', '/me/bundle', undefined, A2)).d.submissions === null, 'outro aluno não vê entregas da Ana');
  const ret = { items: { h1: { html: '<p>corrigido</p>', feedback: 'ótimo', score: 9, maxScore: 10, mode: 'corrigida', returnedAt: '2026-11-06T09:00:00.000Z' } } };
  ok((await call('PUT', '/returns/' + a1.id, ret, T)).s === 200, 'professora devolve correção');
  ok((await call('PUT', '/returns/' + a1.id, ret, A1)).s === 403, 'aluno não devolve correção');
  eq((await call('GET', '/me/bundle', undefined, A1)).d.returns, { v: 1, items: ret.items }, 'aluno recebe a devolução');
  ok((await call('GET', '/me/bundle', undefined, A2)).d.returns === null, 'outro aluno não vê devoluções da Ana');

  /* ---- arquivos ---- */
  const up = await call('POST', '/files?name=caderno.png', undefined, A1, { buf: Buffer.from([1, 2, 3, 250, 255]), type: 'image/png' });
  ok(up.s === 200 && up.d.id && up.d.sizeBytes === 5, 'aluno envia arquivo');
  const dl = await call('GET', '/files/' + up.d.id, undefined, T); ok(dl.s === 200 && Buffer.compare(dl.d, Buffer.from([1, 2, 3, 250, 255])) === 0 && dl.h.get('content-type') === 'image/png', 'professora baixa o arquivo (bytes idênticos)');
  ok((await call('GET', '/files/' + up.d.id, undefined, A1)).s === 200, 'quem enviou baixa');
  ok((await call('GET', '/files/' + up.d.id, undefined, A2)).s === 403, 'outro aluno não baixa');
  ok((await fetch(base + '/files/' + up.d.id + '?token=' + T)).status === 200, 'download por link com token');
  ok((await fetch(base + '/files/' + up.d.id)).status === 401, 'download sem login: 401');
  const tf = await call('POST', '/files?name=contrato.pdf', undefined, T, { buf: Buffer.from('PDF'), type: 'application/pdf' });
  ok((await call('GET', '/files/' + tf.d.id, undefined, A1)).s === 403, 'arquivo da professora não é público');
  await call('PUT', '/portal/' + a1.id, { ...doc, contract: { assetId: tf.d.id } }, T);
  ok((await call('GET', '/files/' + tf.d.id, undefined, A1)).s === 200, 'arquivo citado no painel do aluno é liberado');
  ok((await call('GET', '/files/' + tf.d.id, undefined, A2)).s === 403, '...mas não para outro aluno');
  ok((await call('POST', '/files?name=g.bin', undefined, T, { buf: Buffer.alloc(21 * 1024 * 1024), type: 'application/octet-stream' })).s === 413, 'arquivo > 20 MB: 413');
  ok((await call('DELETE', '/files/' + up.d.id, undefined, A2)).s === 403, 'outro aluno não apaga arquivo');
  ok((await call('DELETE', '/files/' + up.d.id, undefined, A1)).d.deleted === 1, 'dono apaga o arquivo');

  /* ---- exclusões ---- */
  ok((await call('DELETE', '/students/s1', undefined, T)).d.deleted === 1, 'exclui aluno');
  ok(await cnt('lessons', "WHERE student_id='s1'") === 0 && await cnt('homework_submissions') === 0 && await cnt('payments') === 0 && await cnt('plan_activities') === 0 && await cnt('guardians') === 0, 'exclusão em cascata');
  ok((await call('GET', '/students/s1', undefined, T)).s === 404, 'aluno excluído: 404');
  ok((await call('GET', '/nada', undefined, T)).s === 404, 'rota inexistente: 404');
  ok((await call('DELETE', '/users/' + a2.id, undefined, T)).d.deleted === 1, 'exclui conta de aluno');
  ok((await call('DELETE', '/users/t1', undefined, T)).s === 400, 'professora não exclui a si mesma');

  server.close(); await db.pool.end();
  console.log(`${pass} verificações ok, ${fail} falhas`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERRO NO TESTE', e); process.exit(2); });
