# StreamTube — Plataforma de Compartilhamento de Vídeos

Projeto da disciplina **Desenvolvimento de Aplicações de IA** do MBA de Engenharia de Software com IA da [Full Cycle](https://fullcycle.com.br).

Este é um projeto greenfield desenvolvido para demonstrar como construir uma aplicação do zero utilizando IA de forma adequada no processo de desenvolvimento.

## Professor

<a href="https://github.com/argentinaluiz">
    <img src="https://avatars.githubusercontent.com/u/4926329?v=4?s=100" width="100px;" alt=""/>
    <br />
    <sub>
        <b>Luiz Carlos</b>
    </sub>
</a>

---

## Quadro Branco

- [Quadro Branco](./whiteboard.png)

---

## 🎨 Design System (Figma)

- [FC Tube.fig](./FC%20Tube.fig) — arquivo-fonte do **design system** do projeto no Figma.
- [FC Tube sem padrão.fig](./FC%20Tube%20sem%20padrao.fig) — arquivo-fonte puro, sem tokens, cores, tipografia e espaçamento.

Contém os fundamentos visuais do StreamTube — tokens (cores, tipografia, espaçamento, raios), componentes e as telas da plataforma. É a referência de design para a implementação do frontend: os componentes em `next-frontend/components/ui` (shadcn) e os tokens em `next-frontend/app/globals.css` derivam deste arquivo. Abra-o no Figma (`Arquivo → Importar`) para consultar especificações e estados visuais.

---

## 📋 Pré-requisitos

- Docker e Docker Compose
- Node.js v25+ (para rodar os testes E2E do Playwright no host)
- npm

## 🏗️ Arquitetura

O projeto é um monorepo baseado em containers Docker. Cada subprojeto sobe sua própria stack via `docker compose`.

- **Frontend** (Next.js 16, App Router + React Server Components) — interface da plataforma. Segue o **modelo BFF**: o navegador nunca chama a API NestJS diretamente; todo tráfego passa por Route Handlers same-origin em `app/api/**`, que fazem proxy server-side para a API.
- **API** (NestJS 11) — regras de negócio, autenticação (JWT + refresh token rotation), envio de e-mails, acesso ao banco, assinatura de URLs do storage e publicação de jobs na fila.
- **Database** (PostgreSQL 17) — usuários, canais, tokens de autenticação e vídeos.
- **Email Service** (Mailpit) — captura os e-mails transacionais (confirmação de conta e recuperação de senha) em uma UI local.
- **Video Worker** (NestJS + FFmpeg) — mesmo codebase da API, com entrypoint próprio (`src/worker/main.ts`) e container próprio (`video-worker`). Consome a fila, extrai duração e metadados com `ffprobe`, gera a thumbnail com `ffmpeg` e marca o vídeo como `ready`.
- **Object Storage** (MinIO `pgsty/minio`, API S3) — originais dos vídeos e thumbnails, em um bucket privado por ambiente.
- **Message Queue** (Redis 8 + BullMQ) — fila `video-processing` de processamento de vídeos.

Os bytes dos vídeos nunca passam pela API: o upload é multipart S3 com URLs pré-assinadas por parte (o cliente envia cada parte direto ao storage), e o streaming e o download usam URLs `GET` pré-assinadas devolvidas em JSON.

O diagrama de arquitetura completo (C4) está em `docs/diagrams/software-arch.mermaid`.

## 🚀 Como rodar

Os dois subprojetos têm stacks Docker **separadas**. Suba primeiro o backend, rode as migrations e depois o frontend.

### 1. Backend (NestJS + PostgreSQL + Mailpit + Redis + MinIO + worker)

```bash
cd nestjs-project

# Sobe API, banco, Mailpit, Redis, MinIO (com os buckets) e o video-worker
docker compose up -d

# Instala dependências (apenas na primeira vez)
docker compose exec nestjs-api npm install

# Cria o schema do banco (obrigatório — synchronize está desabilitado)
docker compose exec nestjs-api npm run migration:run

# Sobe o servidor de desenvolvimento em watch mode
docker compose exec -d nestjs-api npm run start:dev
```

> O `video-worker` sobe sozinho com o `docker compose up -d` (`npm run start:worker:dev`, `restart: unless-stopped`), ao contrário da API, que só roda depois do `start:dev`. Depois de um `npm install`, reinicie-o com `docker compose restart video-worker`. Depois de mudar o `Dockerfile.dev`, use `docker compose up -d --build`.

Serviços disponíveis:

| Serviço | URL / Porta |
|---------|-------------|
| API NestJS | http://localhost:3000 |
| PostgreSQL | `localhost:5432` (db/user/senha: `streamtube`) |
| Mailpit (UI de e-mails) | http://localhost:8025 (SMTP em `localhost:1025`) |
| MinIO — API S3 | `localhost:9000` (na rede Docker: `http://minio:9000`) |
| MinIO — console | http://localhost:9001 (usuário/senha: `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` do `.env`) |
| Redis | `redis:6379`, só dentro da rede Docker (porta não publicada no host) |
| Video worker | container `video-worker`, sem porta (`docker compose logs video-worker`) |
| Swagger (opcional) | http://localhost:3000/api/docs — habilite com `SWAGGER_ENABLED=true` |

> Em máquinas com proxy corporativo, `localhost:9000` no host pode ser interceptado. Para checar o MinIO, use a rede Docker: `docker compose exec nestjs-api curl -f http://minio:9000/minio/health/live`.

### 2. Frontend (Next.js)

```bash
cd next-frontend

# Garanta que o .env.local existe (veja .env.example)
# API_URL aponta para o backend; SESSION_PASSWORD protege a sessão (iron-session)

docker compose up -d
docker compose exec next-frontend npm install        # apenas na primeira vez
docker compose exec -d next-frontend npm run dev
```

A aplicação ficará disponível em **http://localhost:3001**.

> As stacks são separadas, então o frontend acessa o backend via `host.docker.internal:3000` (configurado em `next-frontend/.env.local` e no `extra_hosts` do compose).

## 🧪 Testes

### Backend (Jest)

```bash
cd nestjs-project
docker compose exec nestjs-api npm test               # unitários + integração
docker compose exec nestjs-api npm run test:e2e       # end-to-end (HTTP via supertest; requer o video-worker rodando)
docker compose exec nestjs-api npm run test:cov       # cobertura
```

Sufixos: `*.spec.ts` (unitário), `*.integration-spec.ts` (integração com banco, MinIO, Redis e FFmpeg reais), `*.e2e-spec.ts` (end-to-end). Testes de integração/e2e rodam com `--runInBand`. Os testes usam o bucket `streamtube-test` e o prefixo de fila `streamtube-test` (forçados em `src/test/setup-test-env.ts`), isolados dos recursos de desenvolvimento.

### Frontend (Vitest + Playwright)

```bash
cd next-frontend
docker compose exec next-frontend npm test            # unitários + integração (Vitest + MSW)
npx playwright test                                   # end-to-end (no host, com dev server em MSW_ENABLED=true)
```

Sufixos: `*.test.ts(x)` (unitário), `*.integration.test.ts(x)` (Route Handlers com MSW), `*.e2e-spec.ts` (Playwright). MSW intercepta as chamadas à API NestJS — os testes nunca batem no backend real.

## ✅ Funcionalidades implementadas

**Fase 01 — Configuração base** e **Fase 02 — Autenticação** estão concluídas (backend + frontend). **Fase 03 — Upload e processamento de vídeos** está concluída no backend; a interface de vídeo no frontend fica para as próximas fases.

### Autenticação (Fase 02)

Fluxo completo de **cadastro → confirmação por e-mail → login → recuperação de senha**, com canal criado automaticamente para cada usuário (a partir do prefixo do e-mail).

Endpoints da API (`nestjs-project`):

| Método & Rota | Descrição |
|---------------|-----------|
| `POST /auth/register` | Cadastro de usuário (cria usuário + canal) |
| `GET /auth/confirm-email?token=` | Confirmação de conta via link do e-mail |
| `POST /auth/resend-confirmation` | Reenvio do e-mail de confirmação |
| `POST /auth/login` | Login (retorna access + refresh token) |
| `POST /auth/refresh` | Rotação de refresh token (com family + grace period) |
| `POST /auth/logout` | Revoga os refresh tokens da sessão |
| `POST /auth/forgot-password` | Solicita e-mail de recuperação de senha |
| `POST /auth/reset-password` | Redefine a senha via token |
| `GET /auth/me` | Dados do usuário autenticado (protegido por JWT) |

Telas e Route Handlers BFF (`next-frontend`):

- `/(auth)/signup`, `/(auth)/login`, `/(auth)/forgot-password` — formulários com React Hook Form + Zod e validação inline.
- `app/api/auth/{signup,login,logout,forgot-password}` — proxy same-origin para a API.

Segurança: senhas com **Argon2**, **JWT** com `JwtAuthGuard` global (opt-out via `@Public()`), **rotação de refresh token** com detecção de reuso, **rate limiting** (`ThrottlerGuard`) nos endpoints de auth, e sessão no navegador via **iron-session** (cookies HTTP-only).

### Vídeos (Fase 03)

Upload de até **10 GB** direto ao storage (multipart S3 com partes de 64 MiB e URLs pré-assinadas, com retomada), processamento em background pelo `video-worker` (duração, metadados e thumbnail) e URLs pré-assinadas para streaming (`Range` → `206`) e download. Cada vídeo tem um `public_id` único de 11 caracteres base64url, usado em todas as rotas.

Endpoints da API (`nestjs-project`) — todos exigem JWT e só respondem ao dono do vídeo:

| Método & Rota | Descrição |
|---------------|-----------|
| `POST /videos` | Cria o vídeo em `draft` e inicia o upload multipart; devolve uma URL `PUT` pré-assinada por parte (`201`) |
| `GET /videos/{publicId}` | Status, metadados e thumbnail do vídeo (`200`) |
| `GET /videos/{publicId}/upload` | Retoma o upload: lista as partes recebidas e assina de novo só as que faltam (`200`) |
| `POST /videos/{publicId}/upload/complete` | Confere as partes, monta o original e enfileira o processamento (`202`, idempotente) |
| `GET /videos/{publicId}/stream` | URL pré-assinada para reprodução inline, só para vídeos `ready` (`200`) |
| `GET /videos/{publicId}/download` | URL pré-assinada de download com o nome original do arquivo, só para vídeos `ready` (`200`) |

Ciclo de status: `draft` → `processing` → `ready` ou `failed` (`UNSUPPORTED_MEDIA`, `PROCESSING_FAILED` ou `UPLOAD_EXPIRED`). Decisões técnicas em `docs/decisions/technical-decisions-phase-03-videos.md`.

## 🛠️ Estrutura do Projeto

```
green-field-ia-project/
├── docs/
│   ├── project-plan.md                  # Planejamento geral do projeto
│   ├── phases/                          # Planos e implementação por fase
│   │   ├── phase-01-configuracao-base/
│   │   ├── phase-02-auth/               # Auth (backend)
│   │   ├── phase-02-auth-frontend/      # Auth (frontend)
│   │   └── phase-03-videos/             # Upload e processamento de vídeos
│   ├── decisions/                       # Decisões técnicas por fase
│   └── diagrams/
│       └── software-arch.mermaid        # Diagrama de arquitetura (C4)
├── nestjs-project/                      # Backend API (NestJS 11)
│   ├── src/
│   │   ├── auth/                        # Cadastro, login, JWT, refresh, reset de senha
│   │   ├── users/                       # Entidade e serviço de usuários
│   │   ├── channels/                    # Canal 1:1 por usuário (nickname do e-mail)
│   │   ├── videos/                      # Rotas /videos, entidade Video, upload e URLs de mídia
│   │   ├── storage/                     # Acesso ao MinIO (multipart e URLs pré-assinadas)
│   │   ├── queue/                       # BullMQ: configuração da fila e producer
│   │   ├── worker/                      # Video worker: entrypoint, consumer, ffprobe/ffmpeg
│   │   ├── mail/                        # Envio de e-mails (templates Handlebars)
│   │   ├── common/                      # Filtros, pipes e exceptions de domínio
│   │   ├── config/                      # Configs namespaced (Joi)
│   │   └── database/                    # data-source, migrations e seeds
│   ├── test/                            # Testes e2e (+ utils/ compartilhados)
│   ├── compose.yaml                     # Docker Compose (API, PostgreSQL, Mailpit, Redis, MinIO, worker)
│   ├── tsconfig.worker.json             # Build do worker em dist-worker/
│   └── Dockerfile.dev
├── next-frontend/                       # Frontend (Next.js 16, App Router)
│   ├── app/                             # Rotas, layouts, páginas e Route Handlers BFF
│   ├── components/                      # Componentes de auth, UI (shadcn) e ícones
│   ├── lib/                             # env, api (openapi-fetch), auth/session
│   ├── mocks/                           # MSW (handlers + server)
│   ├── tests/                           # E2E (Playwright)
│   ├── compose.yaml                     # Docker Compose (dev server)
│   └── Dockerfile.dev
├── CLAUDE.md                            # Instruções para IA
├── FC Tube.fig                          # Design system do projeto (Figma)
├── whiteboard.png                       # Quadro branco do projeto
└── README.md
```

## 📚 Fases do Projeto

| Fase | Descrição | Status |
|------|-----------|--------|
| **01** | Configuração Base do Projeto | ✅ Concluída |
| **02** | Cadastro, Login e Gerenciamento de Conta | ✅ Concluída |
| **03** | Upload e Processamento de Vídeos | ✅ Concluída (backend) |
| **04** | Gerenciamento de Vídeos e Canal | ⏳ Planejada |
| **05** | Página de Visualização do Vídeo | ⏳ Planejada |
| **06** | Interações Sociais (Likes, Comentários, Inscrições) | ⏳ Planejada |
| **07** | Página Inicial, Busca e Finalização | ⏳ Planejada |

Detalhes completos em `docs/project-plan.md`.

## 📖 Stack Tecnológica

| Camada | Tecnologia |
|--------|------------|
| Frontend | Next.js 16, React 19, TypeScript, Tailwind CSS 4, shadcn/ui, React Hook Form + Zod, iron-session, openapi-fetch |
| Backend | NestJS 11, TypeScript, TypeORM, JWT, Argon2, Mailer (Handlebars), BullMQ, AWS SDK v3 (S3) |
| Banco de Dados | PostgreSQL 17 |
| Fila | Redis 8 + BullMQ |
| Object Storage | MinIO (API S3) |
| Processamento de mídia | FFmpeg (`ffprobe` + `ffmpeg`) |
| E-mail (dev) | Mailpit |
| Containerização | Docker, Docker Compose |
| Testes | Jest, Supertest (backend); Vitest, MSW, Playwright (frontend) |
| Qualidade | ESLint, Prettier |
</content>
