-- Rode DEPOIS de db/schema.sql no SQL Editor do Supabase.
-- O Supabase expõe as tabelas do schema "public" por uma API pública (Data API / PostgREST).
-- Ligar o RLS sem criar nenhuma política bloqueia esse acesso: só a nossa API (que conecta como dono do banco) lê e grava.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.tablename);
  END LOOP;
END $$;
