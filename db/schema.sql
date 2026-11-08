-- =====================================================================
-- ENGLISH TEACHER HUB — esquema da API (PostgreSQL 14+)
-- Campos reais do front-end, normalizados. Ids são texto (o front gera os ids).
-- Campos do front sem coluna própria ficam na coluna `extra` (jsonb) de cada tabela.
-- Datas de calendário: DATE. Mês de referência: 'AAAA-MM'. Dinheiro: NUMERIC(10,2).
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()

-- ---------- acesso ----------
-- Quem entra no site. Papel: professora (dona), aluno ou responsavel.
CREATE TABLE users (
  id          text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  email       text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  name        text NOT NULL DEFAULT '',
  role        text NOT NULL CHECK (role IN ('professora','aluno','responsavel')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Arquivos enviados (contratos, PDFs de plano, gravações, anexos, banners).
-- O conteúdo fica num armazenamento de arquivos; aqui só o registro.
CREATE TABLE files (
  id            text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name          text NOT NULL,
  content_type  text NOT NULL DEFAULT 'application/octet-stream',
  size_bytes    bigint NOT NULL CHECK (size_bytes <= 20*1024*1024),
  storage_key   text,
  uploaded_by   text REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Configurações da professora (uma única linha).
CREATE TABLE app_settings (
  id                      boolean PRIMARY KEY DEFAULT true CHECK (id),
  teacher_name            text NOT NULL DEFAULT '',
  platform_name           text NOT NULL DEFAULT 'English Teacher Hub',
  business_name           text NOT NULL DEFAULT '',
  business_email          text NOT NULL DEFAULT '',
  business_phone          text NOT NULL DEFAULT '',
  locale                  text NOT NULL DEFAULT 'pt-BR',
  currency                text NOT NULL DEFAULT 'BRL',
  theme                   text NOT NULL DEFAULT 'sistema',
  density                 text NOT NULL DEFAULT 'confortavel',
  week_start              smallint NOT NULL DEFAULT 1 CHECK (week_start BETWEEN 0 AND 6),
  default_duration_min    integer NOT NULL DEFAULT 60 CHECK (default_duration_min BETWEEN 5 AND 480),
  default_monthly         numeric(10,2) NOT NULL DEFAULT 0,
  default_due_day         smallint NOT NULL DEFAULT 10 CHECK (default_due_day BETWEEN 1 AND 31),
  absence_counts_package  boolean NOT NULL DEFAULT false,
  report_interval_days    integer NOT NULL DEFAULT 60 CHECK (report_interval_days BETWEEN 7 AND 365),
  payment_methods         text[] NOT NULL DEFAULT ARRAY['Pix','Dinheiro'],
  guide                   jsonb NOT NULL DEFAULT '{}'::jsonb,   -- Student's Guide padrão
  banner                  jsonb NOT NULL DEFAULT '{}'::jsonb,   -- banner padrão
  models_seeded           boolean NOT NULL DEFAULT false,
  extra                   jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- ---------- turmas e alunos ----------
CREATE TABLE groups (
  id              text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name            text NOT NULL,
  zoom_url        text NOT NULL DEFAULT '',
  zoom_note       text NOT NULL DEFAULT '',
  calendar_url    text NOT NULL DEFAULT '',
  calendar_note   text NOT NULL DEFAULT '',
  banner_title    text NOT NULL DEFAULT '',
  guide           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE students (
  id              text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id         text UNIQUE REFERENCES users(id) ON DELETE SET NULL,   -- conta do aluno (accountId)
  group_id        text REFERENCES groups(id) ON DELETE SET NULL,         -- no máximo uma turma
  name            text NOT NULL,
  photo           text NOT NULL DEFAULT '',
  email           text NOT NULL DEFAULT '',
  phone           text NOT NULL DEFAULT '',
  birth           date,
  start_date      date,
  level           text NOT NULL DEFAULT 'Iniciante',
  goals           text NOT NULL DEFAULT '',
  course_type     text NOT NULL DEFAULT '',
  frequency       text NOT NULL DEFAULT '',
  duration_min    integer NOT NULL DEFAULT 60,
  monthly         numeric(10,2) NOT NULL DEFAULT 0,
  due_day         smallint NOT NULL DEFAULT 10 CHECK (due_day BETWEEN 1 AND 31),
  pay_method      text NOT NULL DEFAULT '',
  observations    text NOT NULL DEFAULT '',
  status          text NOT NULL DEFAULT 'ativo',
  archived        boolean NOT NULL DEFAULT false,
  zoom_url        text NOT NULL DEFAULT '',      -- link próprio (vale mais que o da turma)
  calendar_url    text NOT NULL DEFAULT '',
  calendar_note   text NOT NULL DEFAULT '',
  minor           boolean NOT NULL DEFAULT false,
  guardian_phone  text NOT NULL DEFAULT '',
  guardian_finance_visible boolean NOT NULL DEFAULT true,
  guide           jsonb NOT NULL DEFAULT '{}'::jsonb,
  banner_title    text NOT NULL DEFAULT '',
  banner_sub      text NOT NULL DEFAULT '',
  banner_theme    text NOT NULL DEFAULT '',
  banner_image_id text REFERENCES files(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX students_group_idx ON students(group_id);

-- Dias e horários fixos das aulas do aluno.
CREATE TABLE student_schedule (
  student_id  text NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  weekday     smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  at_time     time NOT NULL DEFAULT '18:00',
  PRIMARY KEY (student_id, weekday)
);

CREATE TABLE student_level_history (
  id          text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  student_id  text NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  changed_on  date NOT NULL,
  from_level  text,
  to_level    text NOT NULL
);

-- Responsáveis ligados a alunos menores (uma conta pode ter vários filhos).
CREATE TABLE guardians (
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  student_id  text NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, student_id)
);

CREATE TABLE student_notes (
  id          text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  student_id  text NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  text        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------- contratos e cronograma do ano ----------
CREATE TABLE contracts (
  id            text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  student_id    text NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  status        text NOT NULL DEFAULT 'ativo',
  type          text NOT NULL,
  type_name     text NOT NULL DEFAULT '',
  start_date    date NOT NULL,
  end_date      date CHECK (end_date IS NULL OR end_date >= start_date),
  total_lessons integer CHECK (total_lessons IS NULL OR total_lessons >= 0),
  signed_date   date,
  notes         text NOT NULL DEFAULT '',
  show_student  boolean NOT NULL DEFAULT true,   -- aluno vê o contrato no painel
  file_id       text REFERENCES files(id) ON DELETE SET NULL,   -- PDF do contrato
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE stages (
  id             text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  contract_id    text NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  student_id     text NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  position       integer NOT NULL DEFAULT 1,
  title          text NOT NULL,
  description    text NOT NULL DEFAULT '',
  skill          text NOT NULL DEFAULT '',
  start_date     date,
  end_date       date CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date),
  status         text NOT NULL DEFAULT 'planejada',
  completed_date date,
  note           text NOT NULL DEFAULT ''
);

CREATE TABLE packages (
  id           text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  student_id   text NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  total        integer NOT NULL CHECK (total >= 1),
  start_date   date,
  valid_until  date,
  notes        text NOT NULL DEFAULT ''
);

-- ---------- aulas ----------
CREATE TABLE lessons (
  id              text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  student_id      text NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  date            date NOT NULL,
  at_time         time NOT NULL,
  duration_min    integer NOT NULL DEFAULT 60 CHECK (duration_min BETWEEN 5 AND 480),
  type            text NOT NULL DEFAULT 'regular',
  status          text NOT NULL DEFAULT 'agendada'
                  CHECK (status IN ('agendada','realizada','ausente','cancelada','reagendada')),
  topic           text NOT NULL DEFAULT '',
  objectives      text NOT NULL DEFAULT '',
  content         text NOT NULL DEFAULT '',
  skills          text[] NOT NULL DEFAULT '{}',
  homework_text   text NOT NULL DEFAULT '',
  observations    text NOT NULL DEFAULT '',
  makeup_for      text REFERENCES lessons(id) ON DELETE SET NULL,   -- reposição de qual aula
  notes           jsonb NOT NULL DEFAULT '{}'::jsonb,               -- anotações por campo
  -- relatório da aula (o que o aluno pode ler)
  lr_summary      text NOT NULL DEFAULT '',
  lr_vocabulary   text NOT NULL DEFAULT '',
  lr_highlights   text NOT NULL DEFAULT '',
  lr_homework     text NOT NULL DEFAULT '',
  lr_next_steps   text NOT NULL DEFAULT '',
  lr_published    boolean NOT NULL DEFAULT false,
  lr_published_at text NOT NULL DEFAULT ''
);
CREATE INDEX lessons_student_date_idx ON lessons(student_id, date);

CREATE TABLE recordings (
  id          text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  student_id  text NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  lesson_id   text REFERENCES lessons(id) ON DELETE SET NULL,
  title       text NOT NULL DEFAULT '',
  date        date,
  url         text NOT NULL DEFAULT '',
  file_id     text REFERENCES files(id) ON DELETE SET NULL,
  note        text NOT NULL DEFAULT '',
  shared      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (url <> '' OR file_id IS NOT NULL)
);

-- ---------- biblioteca ----------
CREATE TABLE materials (
  id            text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  title         text NOT NULL,
  category      text NOT NULL DEFAULT '',
  skill         text NOT NULL DEFAULT '',
  level         text NOT NULL DEFAULT '',
  description   text NOT NULL DEFAULT '',
  link          text NOT NULL DEFAULT '',
  tags          text[] NOT NULL DEFAULT '{}',
  show_student  boolean NOT NULL DEFAULT false,
  file_id       text REFERENCES files(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
-- Para quais alunos o material foi indicado.
CREATE TABLE material_students (
  material_id text NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  student_id  text NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  PRIMARY KEY (material_id, student_id)
);

CREATE TABLE exercises (
  id            text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  title         text NOT NULL,
  type          text NOT NULL DEFAULT '',
  skills        text[] NOT NULL DEFAULT '{}',
  level         text NOT NULL DEFAULT '',
  est_minutes   integer NOT NULL DEFAULT 15,
  media_url     text NOT NULL DEFAULT '',
  instructions  text NOT NULL DEFAULT '',
  base_text     text NOT NULL DEFAULT '',
  notes         text NOT NULL DEFAULT '',
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE exercise_questions (
  id           text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  exercise_id  text NOT NULL REFERENCES exercises(id) ON DELETE CASCADE,
  position     integer NOT NULL,
  prompt       text NOT NULL,
  options      text[] NOT NULL DEFAULT '{}',
  answer       text NOT NULL DEFAULT '',
  explanation  text NOT NULL DEFAULT '',
  UNIQUE (exercise_id, position)
);

-- Aula x material / exercício usados.
CREATE TABLE lesson_materials (
  lesson_id   text NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  material_id text NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  PRIMARY KEY (lesson_id, material_id)
);
CREATE TABLE lesson_exercises (
  lesson_id   text NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  exercise_id text NOT NULL REFERENCES exercises(id) ON DELETE CASCADE,
  PRIMARY KEY (lesson_id, exercise_id)
);

-- ---------- homework (estilo Google Classroom) ----------
CREATE TABLE homework (
  id              text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  student_id      text NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  exercise_id     text REFERENCES exercises(id) ON DELETE SET NULL,
  title           text NOT NULL,
  description     text NOT NULL DEFAULT '',
  assigned_date   date NOT NULL DEFAULT current_date,
  due_date        date,
  est_minutes     integer,
  status          text NOT NULL DEFAULT 'atribuida',
  doc_html        text NOT NULL DEFAULT '' CHECK (length(doc_html) <= 20000),  -- documento editável
  attach_file_id  text REFERENCES files(id) ON DELETE SET NULL,
  attach_url      text NOT NULL DEFAULT '',
  score           numeric(5,2),
  max_score       numeric(5,2) NOT NULL DEFAULT 10 CHECK (max_score > 0),
  feedback        text NOT NULL DEFAULT '',
  delivered_date  date,
  corrected_date  date,
  student_notes   text NOT NULL DEFAULT '',
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (due_date IS NULL OR due_date >= assigned_date),
  CHECK (score IS NULL OR (score >= 0 AND score <= max_score))
);
CREATE INDEX homework_student_idx ON homework(student_id, status);

-- O que o aluno escreve/entrega (rascunho ou entregue).
CREATE TABLE homework_submissions (
  homework_id   text PRIMARY KEY REFERENCES homework(id) ON DELETE CASCADE,
  html          text NOT NULL DEFAULT '' CHECK (length(html) <= 40000),
  status        text NOT NULL CHECK (status IN ('rascunho','entregue')),
  submitted_at  timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE homework_submission_files (
  homework_id text NOT NULL REFERENCES homework_submissions(homework_id) ON DELETE CASCADE,
  file_id     text NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  PRIMARY KEY (homework_id, file_id)
);

-- Correção devolvida ao aluno (com marcações, nota e comentário).
CREATE TABLE homework_returns (
  homework_id  text PRIMARY KEY REFERENCES homework(id) ON DELETE CASCADE,
  html         text NOT NULL DEFAULT '' CHECK (length(html) <= 40000),
  feedback     text NOT NULL DEFAULT '',
  score        numeric(5,2),
  max_score    numeric(5,2) NOT NULL DEFAULT 10,
  mode         text NOT NULL CHECK (mode IN ('corrigida','refazer')),
  returned_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------- Weekly Study Plan ----------
CREATE TABLE plans (
  id            text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  student_id    text NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  week_start    date NOT NULL,
  week_end      date NOT NULL,
  pdf_file_id   text REFERENCES files(id) ON DELETE SET NULL,
  pdf_url       text NOT NULL DEFAULT '',
  extra jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX plans_student_week_idx ON plans(student_id, week_start);

-- Atividades do formato antigo do plano (dados antigos continuam existindo).
CREATE TABLE plan_activities (
  id           text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  plan_id      text NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  day          text NOT NULL,
  title        text NOT NULL,
  skill        text NOT NULL DEFAULT '',
  minutes      integer,
  status       text NOT NULL DEFAULT 'pendente',
  exercise_id  text REFERENCES exercises(id) ON DELETE SET NULL,
  material_id  text REFERENCES materials(id) ON DELETE SET NULL,
  homework_id  text REFERENCES homework(id) ON DELETE SET NULL,
  notes        text NOT NULL DEFAULT ''
);

-- ---------- relatórios de desempenho (boletim) ----------
CREATE TABLE reports (
  id            text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  student_id    text NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  period_start  date NOT NULL,
  period_end    date NOT NULL CHECK (period_end >= period_start),
  strengths     text NOT NULL DEFAULT '',
  improve       text NOT NULL DEFAULT '',
  next_steps    text NOT NULL DEFAULT '',
  teacher_notes text NOT NULL DEFAULT '',
  shared        boolean NOT NULL DEFAULT false,
  snapshot      jsonb NOT NULL DEFAULT '{}'::jsonb,   -- números do período no momento do relatório
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE report_scores (
  report_id  text NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  skill      text NOT NULL CHECK (skill IN ('grammar','vocabulary','reading','writing','listening','speaking','pronunciation')),
  score      numeric(3,1) CHECK (score IS NULL OR (score >= 1 AND score <= 10)),
  comment    text NOT NULL DEFAULT '',
  PRIMARY KEY (report_id, skill)
);

-- ---------- objetivos, tarefas ----------
CREATE TABLE goals (
  id          text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  student_id  text NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  name        text NOT NULL,
  skill       text NOT NULL DEFAULT '',
  status      text NOT NULL DEFAULT 'nao_iniciado',
  progress    smallint NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  deadline    date,
  notes       text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tasks (
  id          text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  student_id  text REFERENCES students(id) ON DELETE SET NULL,
  title       text NOT NULL,
  category    text NOT NULL DEFAULT '',
  priority    text NOT NULL DEFAULT 'media',
  due_date    date,
  notes       text NOT NULL DEFAULT '',
  done        boolean NOT NULL DEFAULT false,
  done_date   date,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------- financeiro ----------
-- Uma cobrança por aluno por mês. Pagamento pendente NUNCA conta como recebido:
-- só o que está em payments entra no "recebido".
CREATE TABLE charges (
  id          text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  student_id  text NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  ref_month   char(7) NOT NULL CHECK (ref_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  amount      numeric(10,2) NOT NULL CHECK (amount > 0),
  due_date    date,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (student_id, ref_month)
);

CREATE TABLE payments (
  id          text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  student_id  text NOT NULL,
  ref_month   char(7) NOT NULL,
  amount      numeric(10,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  discount    numeric(10,2) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  paid_on     date NOT NULL,
  method      text NOT NULL DEFAULT '',
  notes       text NOT NULL DEFAULT '',
  CHECK (amount > 0 OR discount > 0),
  FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
  -- NO ACTION: bloqueia apagar só a cobrança que tem pagamento, mas permite apagar o aluno inteiro
  FOREIGN KEY (student_id, ref_month) REFERENCES charges(student_id, ref_month)
);

-- Situação de cada cobrança (calculada, nunca digitada).
CREATE VIEW charge_status AS
SELECT c.id, c.student_id, c.ref_month, c.amount, c.due_date,
       COALESCE(SUM(p.amount),0)                    AS paid,
       COALESCE(SUM(p.discount),0)                  AS discount,
       c.amount - COALESCE(SUM(p.amount + p.discount),0) AS balance,
       CASE
         WHEN c.amount - COALESCE(SUM(p.amount + p.discount),0) <= 0 THEN 'pago'
         WHEN COALESCE(SUM(p.amount + p.discount),0) > 0 AND c.due_date >= current_date THEN 'parcial'
         WHEN c.due_date < current_date THEN 'atrasado'
         ELSE 'pendente'
       END AS status
FROM charges c
LEFT JOIN payments p ON p.student_id = c.student_id AND p.ref_month = c.ref_month
GROUP BY c.id;

-- =====================================================================
-- Acréscimos da API
-- =====================================================================

-- Campos do front-end sem coluna própria (datas de criação, nomes de arquivo etc.)
ALTER TABLE students     ADD COLUMN extra jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE groups       ADD COLUMN extra jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE lessons      ADD COLUMN extra jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE recordings   ADD COLUMN extra jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE materials    ADD COLUMN extra jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE exercises    ADD COLUMN extra jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE homework     ADD COLUMN extra jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE reports      ADD COLUMN extra jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE goals        ADD COLUMN extra jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE tasks        ADD COLUMN extra jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE charges      ADD COLUMN extra jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE payments     ADD COLUMN extra jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE contracts    ADD COLUMN extra jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE stages       ADD COLUMN extra jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE packages     ADD COLUMN extra jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE student_notes ADD COLUMN extra jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE student_level_history ADD COLUMN position integer NOT NULL DEFAULT 0;
ALTER TABLE student_level_history ADD COLUMN extra jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE student_schedule      ADD COLUMN extra jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE exercise_questions    ADD COLUMN extra jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE plan_activities       ADD COLUMN position integer NOT NULL DEFAULT 0;
ALTER TABLE plan_activities       ADD COLUMN extra jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Conteúdo dos arquivos enviados (fica no próprio banco, sem depender de disco).
CREATE TABLE file_blobs (
  file_id text PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  data    bytea NOT NULL
);

-- Anexos do aluno na entrega: guarda o nome original.
ALTER TABLE homework_submission_files ADD COLUMN name text NOT NULL DEFAULT '';
ALTER TABLE homework_submissions ADD COLUMN extra jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE homework_returns     ADD COLUMN extra jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Cópia publicada do painel de cada aluno/responsável (a professora monta e publica;
-- o aluno/responsável só lê o próprio). Evita expor tabelas internas.
CREATE TABLE portal_snapshots (
  user_id     text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  doc         jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Uma única professora no sistema.
CREATE UNIQUE INDEX users_one_teacher ON users ((role)) WHERE role = 'professora';
