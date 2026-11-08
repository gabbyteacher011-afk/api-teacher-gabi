# API do English Teacher Hub

API em **Node.js + PostgreSQL** que guarda os dados do site
([site-teacher-gabi](https://github.com/gabbyteacher011-afk/site-teacher-gabi)): alunos, turmas, aulas,
homework, planos, relatórios, financeiro, contratos, gravações, arquivos e os painéis de alunos e responsáveis.
Login próprio por e-mail e senha. Uma única dependência: `pg`.

## Colocar no ar (resumo)

1. Crie um banco PostgreSQL (Render, Railway, Supabase, Neon… qualquer um) e copie a **DATABASE_URL**.
2. Crie um serviço Node apontando para este repositório e configure as variáveis (veja `.env.example`):
   `DATABASE_URL`, `JWT_SECRET` (valor longo e aleatório), `CORS_ORIGIN` (o endereço do site, ex.
   `https://gabbyteacher011-afk.github.io`), `DATABASE_SSL=true` se o provedor exigir.
   Comando de início: `npm start`. O `Dockerfile` também funciona.
3. Uma vez, rode `npm run migrate` (cria as tabelas).
4. Crie a conta da professora: `npm run create-user -- seu@email.com "uma-senha-forte" professora "Seu Nome"`.
5. No site, edite `config.js` e coloque o endereço da API em `apiUrl`.

As contas de alunos e responsáveis são criadas pela própria professora, dentro do site (Área do Aluno → Criar acesso).

## Rotas

Todas respondem JSON. Exceto `/health` e `/auth/login`, exigem `Authorization: Bearer <token>`.

| Método | Rota | Quem | O que faz |
|---|---|---|---|
| GET | `/health` | todos | verifica API e banco |
| POST | `/auth/login` | todos | `{email, password}` → `{token, user}` (máx. 8 tentativas / 15 min) |
| GET | `/auth/me` | logado | dados da conta |
| POST | `/auth/password` | logado | troca a própria senha `{current, password}` |
| POST | `/users` | professora | cria conta `{email, name, role: aluno|responsavel, password}` |
| GET | `/users/search?q=` | professora | busca contas de alunos/responsáveis |
| POST | `/users/profiles` | professora | nomes por id `{ids}` |
| POST | `/users/:id/password` | professora | redefine a senha de uma conta |
| DELETE | `/users/:id` | professora | exclui a conta |
| GET, PUT | `/settings` | professora | configurações do sistema |
| GET | `/sync` | professora | tudo de uma vez (configurações, 17 coleções e entregas) |
| GET, PUT, DELETE | `/{coleção}` e `/{coleção}/:id` | professora | CRUD de: `students groups lessons exercises homework plans reports charges payments materials goals tasks notes packages contracts stages recordings` |
| PUT, DELETE | `/portal/:userId` | professora | publica/remove o painel de um aluno ou responsável |
| GET, PUT | `/returns/:userId` | professora | devoluções (correções) de homework |
| GET | `/me/bundle` | aluno/responsável | o próprio painel, entregas e devoluções |
| PUT | `/me/submissions` | aluno | salva rascunho ou entrega de homework |
| POST | `/files?name=` | logado | envia arquivo (corpo cru, até 20 MB) |
| GET | `/files/:id` | conforme permissão | baixa arquivo (aceita `?token=` para links) |
| DELETE | `/files/:id` | dono ou professora | apaga arquivo |

`PUT /{coleção}/:id` grava (cria ou atualiza) o registro no formato JSON do site e o distribui pelas tabelas de
`db/schema.sql` (ex.: um aluno vira linhas em `students`, `student_schedule`, `student_level_history` e `guardians`).
Campos que o site usa mas que não têm coluna própria ficam na coluna `extra` (jsonb), então nada se perde.

## Permissões

- **professora**: tudo.
- **aluno**: só o próprio painel, as próprias entregas/devoluções e arquivos enviados por ele ou citados no painel dele.
- **responsável**: só o painel dos filhos ligados à conta (somente leitura).

## Testes

```bash
npm test
```

Cria um banco de teste, aplica `db/schema.sql` e roda 117 verificações contra um PostgreSQL real
(variáveis `TEST_PGHOST`, `TEST_PGPORT`, `TEST_PGUSER`, `TEST_PGDB`). Sem o pacote `pg` instalado, usa um
adaptador de testes baseado no `psql` (`test/shim/pg`).

> Os testes foram escritos e rodados com esse adaptador. Depois de `npm install`, rode `npm test` de novo para
> conferir com o pacote `pg` oficial.

## Segurança

- Senhas com scrypt; login por JWT (HS256) assinado com `JWT_SECRET`.
- Todas as consultas usam parâmetros (sem concatenar dados do usuário em SQL).
- Arquivos são servidos com `Content-Security-Policy: sandbox` e `nosniff`.
- O link de arquivo carrega o token na URL (`?token=`) porque links `<a>` não enviam cabeçalho; ele expira
  conforme `TOKEN_HOURS`. Use HTTPS sempre.
- Dados de menores de idade: a API só entrega ao responsável o painel publicado para a conta dele.
