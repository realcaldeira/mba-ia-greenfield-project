---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-04T23:27:26-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-11-04T23:27:26-03:00"
  docs/project-plan.md: "2026-11-04T16:45:43-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-04T23:22:10-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-11-04T14:38:51-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-11-04T14:38:51-03:00"
  docs/phases/phase-02-auth/context.md: "2026-11-04T14:38:51-03:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-11-04T14:38:51-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-11-04T16:05:11-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Entregar no `nestjs-project` a fundação de vídeos da Fase 03. Ela cobre o serviço de armazenamento de arquivos (vídeos e thumbnails), o serviço de processamento em segundo plano (filas) e o upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance, com pré-cadastro automático do vídeo como rascunho ao iniciar o upload. Depois do upload vêm o processamento automático do vídeo (extração de duração e metadados) e a geração automática de thumbnail a partir de um frame do vídeo. Cada vídeo ganha uma URL única, sem conflito com outros vídeos, e pode ser reproduzido via streaming (sem necessidade de download completo) e baixado pelo usuário. Ao fim da fase, upload de até 10GB, processamento automático, streaming e URLs únicas estão funcionais.

---

## Step Implementations

### SI-03.1 — Infra: dependências e namespaces de config `storage` e `queue`

**Description:** Instala as quatro libs decididas e cria os namespaces `storage` e `queue` no padrão `registerAs` + Joi herdado da Fase 01, com defaults, para que API, worker e testes leiam a mesma configuração.

**Technical actions:**

1. Instalar no `nestjs-project`: `@nestjs/bullmq@^12.0.0`, `bullmq@^6.4.0` (per `phase-03-videos/TD-01`), `@aws-sdk/client-s3@^3.1154.0` e `@aws-sdk/s3-request-presigner@^3.1154.0` (per `phase-03-videos/TD-02`). No `npm install`, conferir os `peerDependencies` do `@nestjs/bullmq` contra o `@nestjs/core ^11.0.1` do projeto (`library-refs.md` § Versões).
2. Criar `src/config/storage.config.ts`: `registerAs('storage', ...)` com `endpoint` (`S3_ENDPOINT`, default `'http://minio:9000'`), `publicEndpoint` (`S3_PUBLIC_ENDPOINT`, default `'http://minio:9000'`), `region` (`S3_REGION`, default `'us-east-1'`), `bucket` (`S3_BUCKET`, default `'streamtube'`), `accessKeyId` (`S3_ACCESS_KEY_ID`) e `secretAccessKey` (`S3_SECRET_ACCESS_KEY`). Os dois endpoints vêm da Revision de `phase-03-videos/TD-02`; o padrão é o de `phase-01-configuracao-base/TD-03`.
3. Criar `src/config/queue.config.ts`: `registerAs('queue', ...)` com `host` (`REDIS_HOST`, default `'redis'`), `port` (`REDIS_PORT`, default `6379`), `prefix` (`QUEUE_PREFIX`, default `'streamtube'`, Revision de `phase-03-videos/TD-01`), `backoffDelayMs` (`QUEUE_BACKOFF_DELAY_MS`, default `1000`, Revision de `phase-03-videos/TD-04`) e `workerConcurrency` (`VIDEO_WORKER_CONCURRENCY`, default `1`, per `phase-03-videos/TD-05`).
4. Estender `src/config/env.validation.ts`. `S3_ENDPOINT` e `S3_PUBLIC_ENDPOINT` ganham `Joi.string().uri()` com os defaults acima. `S3_REGION` e `S3_BUCKET` ganham `Joi.string()` com default. `S3_ACCESS_KEY_ID` e `S3_SECRET_ACCESS_KEY` ficam `Joi.string().required()`, como `DB_PASSWORD`. Entram também `REDIS_HOST` (`Joi.string().default('redis')`), `REDIS_PORT` (`Joi.number().port().default(6379)`), `QUEUE_PREFIX` (`Joi.string().pattern(/^[^:]+$/).default('streamtube')`), `QUEUE_BACKOFF_DELAY_MS` (`Joi.number().integer().min(1).default(1000)`) e `VIDEO_WORKER_CONCURRENCY` (`Joi.number().integer().min(1).default(1)`) (per `phase-01-configuracao-base/TD-02`).
5. Acrescentar `storageConfig` e `queueConfig` ao `load` do `ConfigModule.forRoot` em `src/app.module.ts`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `envValidationSchema` (chaves novas) | Integration: defaults aplicados, credenciais S3 obrigatórias, URI inválida rejeitada, `QUEUE_PREFIX` com `:` rejeitado | `src/config/env.validation.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- A aplicação sobe só com `S3_ACCESS_KEY_ID` e `S3_SECRET_ACCESS_KEY` definidos, e `storage.endpoint`, `storage.bucket`, `queue.host`, `queue.prefix`, `queue.backoffDelayMs` e `queue.workerConcurrency` assumem `http://minio:9000`, `streamtube`, `redis`, `streamtube`, `1000` e `1`
- Iniciar sem `S3_ACCESS_KEY_ID` falha na validação Joi do bootstrap, e a aplicação não sobe
- `S3_ENDPOINT=minio:9000` (sem esquema) é rejeitado na validação
- `QUEUE_PREFIX=stream:tube` é rejeitado na validação

---

### SI-03.2 — Infra: FFmpeg no `Dockerfile.dev` e variáveis novas no `.env.example`

**Description:** Coloca `ffprobe`/`ffmpeg` na imagem de dev, que a API e o worker compartilham, e documenta no `.env.example` as variáveis de storage e fila. Na mesma SI, corrige o `MAIL_FROM` para um valor que o Compose v5 consiga ler, já que o Compose lê o `.env` para interpolação.

**Technical actions:**

1. Em `nestjs-project/Dockerfile.dev`, acrescentar `ffmpeg` ao `apt install -y procps curl` (per `phase-03-videos/TD-06`; testing guide § "Video Worker and FFmpeg": "installed in the shared dev image").
2. Acrescentar ao `.env.example` o bloco `# Object Storage (MinIO)`: `S3_ENDPOINT=http://minio:9000`, `S3_PUBLIC_ENDPOINT=http://minio:9000`, com um comentário de que um cliente no host usa `http://localhost:9000` (Revision de `phase-03-videos/TD-02`), `S3_REGION=us-east-1`, `S3_BUCKET=streamtube`, `S3_ACCESS_KEY_ID=streamtube` e `S3_SECRET_ACCESS_KEY=streamtube-secret` (o MinIO exige senha root de 8+ chars).
3. Acrescentar ao `.env.example` o bloco `# Queue (Redis + BullMQ)`: `REDIS_HOST=redis`, `REDIS_PORT=6379`, `QUEUE_PREFIX=streamtube`, `QUEUE_BACKOFF_DELAY_MS=1000` e `VIDEO_WORKER_CONCURRENCY=1` (Revisions de `phase-03-videos/TD-01` e `phase-03-videos/TD-04`; `phase-03-videos/TD-05`). Todos os hosts usam o nome do serviço Compose, nunca `localhost` (CLAUDE.md da raiz → Docker Networking).
4. Trocar `MAIL_FROM="StreamTube" <noreply@streamtube.com>` por `MAIL_FROM='"StreamTube" <noreply@streamtube.com>'`. Entre aspas simples, o parser de `.env` do Compose v5 e o `dotenv` leem o valor literal, com as aspas duplas do display name. Hoje o texto depois da aspa de fechamento quebra o `docker compose`. A mesma troca vale no `.env` local, que não é versionado.

**Tests:** _(empty — Infra)_

**Dependencies:** none

**Acceptance criteria:**

- `docker compose config` sai com código 0 usando um `.env` copiado do `.env.example`
- Depois de `docker compose build nestjs-api`, `docker compose exec nestjs-api ffprobe -version` e `docker compose exec nestjs-api ffmpeg -version` saem com código 0
- Com o `.env` copiado do `.env.example`, `mail.from` vale exatamente `"StreamTube" <noreply@streamtube.com>`, e a suíte de mail existente (`src/mail/mail.service.integration-spec.ts`) continua passando

---

### SI-03.3 — Infra: serviços `redis`, `minio` e `minio-init` no Compose

**Description:** Sobe no `nestjs-project/compose.yaml` o broker da fila e o object storage, com os buckets de dev e de teste criados no bootstrap. Com isso, API, worker e testes partem do mesmo estado conhecido.

**Technical actions:**

1. Adicionar o serviço `redis`. Imagem oficial `redis:8` (tag fixada por best practice, conforme a varredura do validate). `command: ["redis-server", "--maxmemory-policy", "noeviction", "--appendonly", "yes"]`: o BullMQ quebra se o Redis expulsar chaves, e o AOF persiste a fila (`library-refs.md` § `bullmq` → Redis; per `phase-03-videos/TD-01`). Healthcheck `["CMD", "redis-cli", "ping"]` (interval 5s, timeout 5s, retries 5) e volume `redis-data:/data`.
2. Adicionar o serviço `minio`. Imagem `pgsty/minio:RELEASE.2026-08-04T00-00-00Z` e `command: ["server", "/data", "--console-address", ":9001"]`. Environment: `MINIO_ROOT_USER=${S3_ACCESS_KEY_ID:-streamtube}`, `MINIO_ROOT_PASSWORD=${S3_SECRET_ACCESS_KEY:-streamtube-secret}` e `MINIO_API_STALE_UPLOADS_EXPIRY=24h`. Portas `9000:9000` (para o override `http://localhost:9000` de um cliente no host) e `9001:9001` (console). Healthcheck `["CMD", "curl", "-f", "http://localhost:9000/minio/health/live"]` e volume `minio-data:/data` (Revision "MinIO image and buckets" de `phase-03-videos/TD-02`; Revision de `phase-03-videos/TD-12`).
3. Adicionar o serviço one-shot `minio-init`. Mesma imagem, `depends_on: { minio: { condition: service_healthy } }`, `restart: "no"`, as mesmas credenciais e `entrypoint: ["/bin/sh", "-c", "mc alias set local http://minio:9000 \"$$MINIO_ROOT_USER\" \"$$MINIO_ROOT_PASSWORD\" && mc mb --ignore-existing local/streamtube local/streamtube-test"]` (Revision "MinIO image and buckets" de `phase-03-videos/TD-02`).
4. Acrescentar ao `depends_on` de `nestjs-api`: `redis: { condition: service_healthy }` e `minio-init: { condition: service_completed_successfully }`. `db` e `mailpit` ficam como estão (Revision de `phase-03-videos/TD-02`; `library-refs.md` § `bullmq` → Producer fail-fast).
5. Declarar os volumes nomeados `redis-data` e `minio-data` no `volumes:` de topo.

**Tests:** _(empty — Infra)_

**Dependencies:** SI-03.2 (o `.env` precisa ser legível pelo Compose antes de qualquer `docker compose up`)

**Acceptance criteria:**

- `docker compose up -d` deixa `redis` e `minio` com status `healthy` e `minio-init` com status `exited (0)`
- `docker compose exec redis redis-cli CONFIG GET maxmemory-policy` retorna `noeviction`, e `CONFIG GET appendonly` retorna `yes`
- `docker compose run --rm --entrypoint sh minio-init -c 'mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && mc ls local'` lista os buckets `streamtube` e `streamtube-test`
- Rodar `docker compose up -d` de novo não falha no `minio-init`, porque o `--ignore-existing` torna a criação dos buckets idempotente
- `curl -f http://localhost:9000/minio/health/live` no host retorna `200`

---

### SI-03.4 — Infra de teste: `setup-test-env.ts` nos dois configs do Jest e helpers de isolamento

**Description:** Isola as suítes do ambiente de dev. Um setup do Jest força o bucket e o prefixo de teste, e helpers guardados limpam bucket e fila entre os testes e geram as fixtures de mídia em tempo de teste (per `phase-03-videos/TD-11`). O worker de dev nunca consome job de teste, e nenhum teste toca o bucket `streamtube`.

**Technical actions:**

1. Criar `src/test/setup-test-env.ts`, carregado depois de `dotenv/config`. Ele força `process.env.S3_BUCKET = 'streamtube-test'`, `QUEUE_PREFIX = 'streamtube-test'`, `S3_PUBLIC_ENDPOINT = process.env.S3_ENDPOINT` e `QUEUE_BACKOFF_DELAY_MS = '10'`. O backoff pequeno nos testes vem da Revision "Retry and expiry parameters" de `phase-03-videos/TD-04`; o resto, da Revision de `phase-03-videos/TD-02` e do testing guide § "Object Storage" e § "Message Queue". Exportar `assertTestResource(name: string)`, que lança erro quando o nome não contém `test`.
2. Registrar o setup nos dois configs. Em `package.json` → `jest.setupFiles`: `["dotenv/config", "<rootDir>/test/setup-test-env.ts"]` (o `rootDir` é `src`). Em `test/jest-e2e.json` → `setupFiles`: `["dotenv/config", "<rootDir>/src/test/setup-test-env.ts"]` (o `rootDir` é `.`).
3. Criar `src/test/storage.ts` com `emptyTestBucket()`. Ele chama `assertTestResource(S3_BUCKET)`, lista e apaga os objetos (`ListObjectsV2` paginado + `DeleteObjects`) e aborta os multipart em andamento (`ListMultipartUploads` + `AbortMultipartUpload`), usando um `S3Client` com `forcePathStyle: true` e checksums `WHEN_REQUIRED` (`library-refs.md` § `@aws-sdk/client-s3`).
4. Criar `src/test/queue.ts` com `obliterateTestQueue(queue: Queue)`. Ele chama `assertTestResource` sobre o prefixo da fila e faz `queue.obliterate({ force: true })` (testing guide § "Message Queue").
5. Criar `src/test/media-fixtures.ts`, que gera as fixtures com `ffmpeg -f lavfi` em `os.tmpdir()`: MP4 faststart de 3 s (`testsrc` 1920x1080 + `sine`), MP4 com o moov atom no fim, `.mov`, `.webm`, arquivo só de áudio (`.m4a`) e um arquivo de bytes aleatórios. Nenhuma fixture binária é versionada (testing guide § "Video Worker and FFmpeg").

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `setup-test-env` + `assertTestResource` | Unit: valores forçados no `process.env`, recusa de nome sem `test` | `src/test/setup-test-env.spec.ts` |

**Dependencies:** SI-03.1 (libs e nomes das variáveis), SI-03.3 (bucket `streamtube-test` criado pelo `minio-init`)

**Acceptance criteria:**

- Dentro de qualquer suíte do `npm test` ou do `npm run test:e2e`, `process.env.S3_BUCKET` vale `streamtube-test`, `process.env.QUEUE_PREFIX` vale `streamtube-test`, e `process.env.S3_PUBLIC_ENDPOINT` é igual a `process.env.S3_ENDPOINT`
- `emptyTestBucket()` com `S3_BUCKET=streamtube` lança erro antes de qualquer chamada ao storage
- Depois de `emptyTestBucket()`, o bucket `streamtube-test` não tem objetos nem multipart em andamento
- As fixtures geradas pelo `media-fixtures.ts` ficam fora do repositório (`os.tmpdir()`), e o `git status` não mostra arquivo novo

---

### SI-03.5 — Refactor: `ALL_ENTITIES` compartilhado nas suítes

**Description:** Centraliza num helper a lista de entidades que cada suíte passa ao `createTestDataSource`. Isso precisa acontecer **antes** de `Channel` ganhar a relação `videos` (SI-03.7), que é a entidade do ciclo de vida de `phase-03-videos/TD-04`, testada contra o banco real pela estratégia de `phase-03-videos/TD-11`. Toda DataSource que carrega `Channel` passa a exigir `Video` nos metadados, e com a lista num lugar só basta acrescentar a entidade uma vez. É um refactor sem comportamento novo, separado da SI funcional (CLAUDE.md da raiz → Scope Limits).

**Technical actions:**

1. Criar `src/test/test-entities.ts` exportando `ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken]`.
2. Trocar as listas locais por `ALL_ENTITIES` em `src/auth/auth.module.spec.ts`, `src/auth/auth.service.integration-spec.ts`, `src/auth/entities/refresh-token.entity.integration-spec.ts` e `src/auth/entities/verification-token.entity.integration-spec.ts`.
3. Fazer o mesmo em `src/users/users.module.spec.ts`, `src/users/users.service.integration-spec.ts` e `src/users/entities/user.entity.integration-spec.ts`.
4. Fazer o mesmo em `src/channels/channels.module.spec.ts`, `src/channels/channels.service.integration-spec.ts` e `src/channels/entities/channel.entity.integration-spec.ts`.
5. Trocar a lista literal `[User, Channel, RefreshToken, VerificationToken]` de `src/database/migrations.integration-spec.ts` por `ALL_ENTITIES`, sem mexer nas migrations registradas nem nas asserções.

**Tests:** _(empty — refactor sem comportamento novo; as 11 suítes alteradas são o próprio gate, ver AC)_

**Dependencies:** none

**Acceptance criteria:**

- `grep -rn "const ALL_ENTITIES" nestjs-project/src` encontra uma única definição, em `src/test/test-entities.ts`
- Nenhum `*.spec.ts` ou `*.integration-spec.ts` chama `createTestDataSource` com uma lista literal de entidades
- `docker compose exec nestjs-api npm test` passa com a mesma contagem de testes de antes do refactor

---

### SI-03.6 — `ChannelsService.findByUserId`

**Description:** Expõe no `ChannelsModule` a busca do canal pelo dono. O `VideosService` resolve o `channel_id` do usuário autenticado (Revision "Upload input contract and object key" de `phase-03-videos/TD-03`) sem acessar o repositório de outro domínio (CLAUDE.md da raiz → Single Responsibility).

**Technical actions:**

1. Implementar `findByUserId(userId: string): Promise<Channel | null>` em `src/channels/channels.service.ts` com `this.dataSource.getRepository(Channel).findOne({ where: { user_id: userId } })`. Não usar savepoint nem transação, porque é só leitura. O `ChannelsService` já é exportado pelo `ChannelsModule`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `ChannelsService.findByUserId` | Integration: canal do usuário retornado; `null` para usuário sem canal ou inexistente | `src/channels/channels.service.integration-spec.ts` |

**Dependencies:** SI-03.5 (mesmo arquivo de spec, já usando `ALL_ENTITIES`)

**Acceptance criteria:**

- Com um usuário registrado, `findByUserId(user.id)` retorna o `Channel` com `user_id` igual a `user.id`
- `findByUserId` com um uuid sem usuário retorna `null`, sem lançar erro

---

### SI-03.7 — Entidade `Video`, relação `Channel.videos` e migration `CreateVideos`

**Description:** Cria a tabela `videos`, com o ciclo de vida, o identificador público e os campos de mídia de `### Data Model`. Liga `Video` ao `Channel` e adapta os helpers e o teste de migrations à terceira migration.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts`, `@Entity('videos')`, com as colunas exatas de `### Data Model → Video`. São elas: `@PrimaryColumn('uuid') id`, `public_id` `varchar(11)` unique, `channel_id`, `title` `varchar(100)`, `original_filename` `varchar(255)`, `mime_type` `varchar(50)` e `size_bytes` `bigint` com `ValueTransformer` para `number`. Depois, `status` e `processing_error` como enums do PostgreSQL (`VideoStatus` / `VideoProcessingError`), `upload_id`, `upload_expires_at`, `duration_seconds` `double precision`, `metadata` `jsonb` tipado como `VideoMetadata`, `thumbnail_key`, `created_at` e `updated_at`. Completam a entidade `@ManyToOne(() => Channel, (channel) => channel.videos)` com `@JoinColumn({ name: 'channel_id' })` e `@Index()` em `channel_id` (per `phase-03-videos/TD-04`, `phase-03-videos/TD-06`, `phase-03-videos/TD-07`, Revisions de `phase-03-videos/TD-03`).
2. Acrescentar a `Channel` (`src/channels/entities/channel.entity.ts`) o lado inverso `@OneToMany(() => Video, (video) => video.channel) videos: Video[]`.
3. Gerar a migration com `npm run migration:generate -- src/database/migrations/CreateVideos` e revisar o SQL: `CREATE TYPE "videos_status_enum"` e `"videos_processing_error_enum"`, `UNIQUE` em `public_id`, `FK channel_id → channels(id)`, índice em `channel_id` e o `down()` simétrico (inclusive `DROP TYPE`).
4. Acrescentar `Video` a `ALL_ENTITIES` (`src/test/test-entities.ts`) e fazer `cleanAllTables` (`src/test/create-test-data-source.ts`) apagar `"videos"` **antes** de `"refresh_tokens"`, `"verification_tokens"`, `"channels"` e `"users"`, por causa da FK.
5. Atualizar `src/database/migrations.integration-spec.ts`. Registrar `CreateVideos<timestamp>` em `migrations` e trocar `toHaveLength(2)` por `toHaveLength(3)`. Acrescentar `'videos'` a `MANAGED_TABLES` e à lista esperada de tabelas, na ordem alfabética do `ORDER BY`. O teste de revert passa a ser "should revert the last migration and remove the videos table", consultando `['videos']`. O `DROP TYPE` dinâmico dos enums já cobre os dois enums novos.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: `public_id` único, `status` default `draft`, enum rejeita valor fora da lista, `processing_error` nullable, FK para `channels`, `size_bytes` de 10 GiB volta como `number`, `metadata` persiste as 7 chaves | `src/videos/entities/video.entity.integration-spec.ts` |
| `Channel.videos` | Integration: `relations: ['videos']` carrega os vídeos do canal | `src/channels/entities/channel.entity.integration-spec.ts` |
| Migrations | Integration: 3 migrations aplicadas, 5 tabelas criadas, revert remove `videos` | `src/database/migrations.integration-spec.ts` |

**Dependencies:** SI-03.5 (lista única de entidades antes da relação nova)

**Acceptance criteria:**

- `npm run migration:run` cria a tabela `videos` com as 16 colunas de `### Data Model → Video`, os enums `videos_status_enum` e `videos_processing_error_enum`, o `UNIQUE` em `public_id` e a FK para `channels`
- Inserir dois vídeos com o mesmo `public_id` falha com violação de unicidade (`23505`)
- Um vídeo inserido sem `status` fica com `status = 'draft'` e `processing_error = null`
- Inserir `status = 'published'` falha na restrição do enum
- Um vídeo com `size_bytes = 10737418240` é lido de volta como o `number` `10737418240`
- `migration:revert` remove a tabela `videos` e os dois enums, e as outras quatro tabelas ficam intactas

---

### SI-03.8 — `StorageModule` e `StorageService` (dois `S3Client`, multipart e URLs pré-assinadas)

**Description:** Encapsula o acesso S3-compatível num módulo próprio, reutilizado pela API e pelo worker. São dois clients: um interno, para as operações de servidor, e um de assinatura, para as URLs do cliente. Os erros de rede viram `STORAGE_UNAVAILABLE` (per `phase-03-videos/TD-02`, com a Revision dos dois endpoints).

**Technical actions:**

1. Criar `src/storage/storage.module.ts` com dois providers, `S3_INTERNAL_CLIENT` (`storage.endpoint`) e `S3_SIGNING_CLIENT` (`storage.publicEndpoint`). Os dois são `new S3Client({ endpoint, region, forcePathStyle: true, credentials, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' })`, injetados por `storageConfig.KEY`. O módulo exporta o `StorageService`, e um `onModuleDestroy` chama `client.destroy()` nos dois (`library-refs.md` § `@aws-sdk/client-s3` → Cliente S3-compatível; § `@aws-sdk/s3-request-presigner` → Host assinado).
2. Criar `src/storage/storage.service.ts` com os métodos de multipart sobre o bucket `storage.bucket`. `createMultipartUpload(key, contentType): Promise<string>` devolve o `UploadId`. `listParts(key, uploadId): Promise<UploadedPart[] | null>` usa `paginateListParts` e devolve `null` quando o upload não existe mais (404 / `NoSuchUpload`, a confirmar contra o MinIO real). Completam o grupo `completeMultipartUpload(key, uploadId, parts)` e `abortMultipartUpload(key, uploadId)`, best-effort, que ignora 404 (per `phase-03-videos/TD-03`; `library-refs.md` § Multipart de baixo nível).
3. Acrescentar os métodos de objeto: `headObject(key): Promise<{ contentLength: number } | null>` (`NotFound` → `null`), `deleteObject(key)` (idempotente) e `putObject(key, body: Buffer, contentType)` (`library-refs.md` § `HeadObject`, `PutObject`, `GetObject`).
4. Acrescentar os métodos de assinatura. `presignUploadPart(key, uploadId, partNumber, expiresIn)` usa o client de assinatura. `presignGetObject(key, { expiresIn, audience: 'client' | 'internal', responseContentDisposition? })` usa o client de assinatura para `'client'` (stream, download, thumbnail) e o interno para `'internal'` (URL do ffprobe/ffmpeg, per `phase-03-videos/TD-06`). As URLs saem com `getSignedUrl` (`library-refs.md` § `getSignedUrl`).
5. Criar `src/storage/storage.exceptions.ts` com `StorageUnavailableException` (`DomainException`, `503`, `STORAGE_UNAVAILABLE`). Os erros sem resposta HTTP (`ECONNREFUSED`, timeout) ou com `$metadata.httpStatusCode >= 500` são convertidos nela. Um 404 vira `null` nos métodos de leitura, e os outros 4xx são relançados como estão (`library-refs.md` § Erros de serviço; Revision "Upload error contract" de `phase-03-videos/TD-03`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration (MinIO real, bucket `streamtube-test`): multipart criado → PUT pela URL pré-assinada → `listParts` com tamanhos → complete → `headObject` com `contentLength`; `listParts` depois do complete → `null`; `headObject` de chave inexistente → `null`; GET pré-assinado com `Range: bytes=0-99` → `206`; host da URL igual a `S3_PUBLIC_ENDPOINT` | `src/storage/storage.service.integration-spec.ts` |
| `StorageService` (mapeamento de erros) | Unit: `ECONNREFUSED` e 5xx → `StorageUnavailableException`; 404 → `null`; 403 relançado | `src/storage/storage.service.spec.ts` |
| `StorageModule` | Unit: compilação com `storageConfig` e os dois clients | `src/storage/storage.module.spec.ts` |

**Dependencies:** SI-03.1 (SDK e `storageConfig`), SI-03.4 (`emptyTestBucket` e bucket de teste forçado)

**Acceptance criteria:**

- Uma parte enviada por `PUT` na URL de `presignUploadPart` é aceita pelo storage sem nenhum header `x-amz-checksum-*`, e aparece no `listParts` com o `Size` enviado
- Depois de `completeMultipartUpload`, `headObject('videos/<id>/original')` retorna o `contentLength` igual à soma das partes, e `listParts` do mesmo `UploadId` retorna `null`
- Um GET com `Range: bytes=0-99` na URL de `presignGetObject(..., { audience: 'client' })` retorna `206` com 100 bytes
- Com `responseContentDisposition` informado, a resposta do GET pré-assinado traz exatamente esse `Content-Disposition`
- Com o `minio` parado, `createMultipartUpload` lança `StorageUnavailableException` (`503`, `STORAGE_UNAVAILABLE`)

---

### SI-03.9 — `QueueModule` e `VideoProcessingProducer`

**Description:** Configura o BullMQ com conexão, prefixo e retries vindos do namespace `queue`, e cria o producer do job `process-video`, usado só pela API e com fail-fast quando o Redis está fora (per `phase-03-videos/TD-01`, `phase-03-videos/TD-04`). A API usa o producer e o worker usa o consumer (SI-03.20), cada um com sua própria conexão.

**Technical actions:**

1. Criar `src/queue/video-processing.constants.ts` com `VIDEO_PROCESSING_QUEUE = 'video-processing'`, `PROCESS_VIDEO_JOB = 'process-video'`, `VIDEO_PROCESSING_ATTEMPTS = 3` e o tipo `ProcessVideoJobData = { videoId: string }` (Revisions de `phase-03-videos/TD-01` e `phase-03-videos/TD-04`).
2. Criar `src/queue/queue.module.ts` com `BullModule.forRootAsync({ inject: [queueConfig.KEY], useFactory })`. A factory devolve `connection: { host, port }`, `prefix: cfg.prefix` e `defaultJobOptions: { attempts: VIDEO_PROCESSING_ATTEMPTS, backoff: { type: 'exponential', delay: cfg.backoffDelayMs }, removeOnComplete: true, removeOnFail: 1000 }` (`library-refs.md` § `@nestjs/bullmq` → Root module; § `bullmq` → Retries e `removeOnComplete`).
3. Criar `src/queue/video-processing-producer.module.ts`. Ele importa `QueueModule` e `BullModule.registerQueueAsync({ name: VIDEO_PROCESSING_QUEUE, inject: [queueConfig.KEY], useFactory: (cfg) => ({ connection: { host: cfg.host, port: cfg.port, enableOfflineQueue: false } }) })`, e provê e exporta o `VideoProcessingProducer`. O `enableOfflineQueue: false` fica só aqui; o worker usa a conexão padrão (`library-refs.md` § `bullmq` → Producer fail-fast).
4. Criar `src/queue/video-processing.producer.ts`, com `@InjectQueue(VIDEO_PROCESSING_QUEUE)`. `enqueue(videoId: string): Promise<void>` faz `queue.add(PROCESS_VIDEO_JOB, { videoId }, { jobId: videoId })`. Uma rejeição do `add()` vira `QueueUnavailableException`.
5. Criar `src/queue/queue.exceptions.ts` com `QueueUnavailableException` (`DomainException`, `503`, `QUEUE_UNAVAILABLE`, Revision "Upload error contract" de `phase-03-videos/TD-03`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingProducer` | Integration (Redis real, prefixo `streamtube-test`): job `process-video` com `data` `{ videoId }`, `jobId` igual ao uuid, `opts.attempts` 3 e backoff exponencial; dois `enqueue` do mesmo id deixam um único job | `src/queue/video-processing.producer.integration-spec.ts` |
| `VideoProcessingProducer` | Unit: `add()` rejeitado → `QueueUnavailableException` | `src/queue/video-processing.producer.spec.ts` |
| `VideoProcessingProducerModule` | Unit: compilação com `getQueueToken('video-processing')` resolvido | `src/queue/video-processing-producer.module.spec.ts` |

**Dependencies:** SI-03.1 (libs e `queueConfig`), SI-03.3 (serviço `redis`), SI-03.4 (prefixo de teste e `obliterateTestQueue`)

**Acceptance criteria:**

- `enqueue(videoId)` deixa na fila `video-processing` do prefixo de teste um job `waiting` com `name = 'process-video'`, `data = { videoId }` e `id = videoId`
- Chamar `enqueue` duas vezes com o mesmo `videoId` enquanto o primeiro job está na fila resulta em um único job
- Com o Redis inacessível, `enqueue` rejeita na hora com `QueueUnavailableException` (`503`, `QUEUE_UNAVAILABLE`), sem esperar reconexão
- Nenhuma chave da suíte é gravada sob o prefixo `streamtube` de dev

---

### SI-03.10 — Contratos de vídeo: constantes, `public_id`, exceções e DTOs

**Description:** Reúne os contratos que as rotas de vídeo compartilham: constantes do protocolo, gerador de `public_id`, exceções de domínio e DTOs de entrada e saída com Swagger. Cada SI de rota fica só com a lógica dela.

**Technical actions:**

1. Criar `src/videos/videos.constants.ts` com `VIDEO_MAX_SIZE_BYTES = 10737418240`, `UPLOAD_PART_SIZE_BYTES = 67108864`, `PART_URL_TTL_SECONDS = 3600`, `UPLOAD_WINDOW_HOURS = 24` (per `phase-03-videos/TD-03`) e `CONTENT_TYPE_EXTENSIONS = { 'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm', 'video/x-matroska': '.mkv' }` (Revision de `phase-03-videos/TD-03`). Depois, `STREAM_TTL_MIN_SECONDS = 3600`, `STREAM_TTL_MAX_SECONDS = 43200` e `DOWNLOAD_TTL_SECONDS = 3600` (Revision de `phase-03-videos/TD-08`), `THUMBNAIL_URL_TTL_SECONDS = 3600` (Revision de `phase-03-videos/TD-06`) e `PUBLIC_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/`.
2. Criar `src/videos/public-id.util.ts` com `generatePublicId(): string` = `crypto.randomBytes(8).toString('base64url')` (11 chars, Revision de `phase-03-videos/TD-07`).
3. Criar `src/videos/videos.exceptions.ts` com as subclasses de `DomainException`: `VideoNotFoundException` (`404 VIDEO_NOT_FOUND`), `InvalidVideoStateException` (`409 INVALID_VIDEO_STATE`), `UploadIncompleteException` (`409 UPLOAD_INCOMPLETE`), `UploadSizeMismatchException` (`409 UPLOAD_SIZE_MISMATCH`), `UploadExpiredException` (`410 UPLOAD_EXPIRED`) e `VideoNotReadyException` (`409 VIDEO_NOT_READY`). As mensagens são as de `### Error Catalog` (`phase-02-auth/TD-07`).
4. Criar os DTOs de entrada. `src/videos/dto/initiate-upload.dto.ts` (`InitiateUploadDto`) aplica as regras de `#### Validation Rules — Vídeos` e o decorator de classe `@MatchesContentTypeExtension()`, em `src/videos/validators/matches-content-type-extension.validator.ts`, que compara a extensão de `file_name`, sem diferenciar maiúsculas, com `CONTENT_TYPE_EXTENSIONS[content_type]`. `src/videos/dto/public-id-param.dto.ts` (`PublicIdParamDto`) faz `@Matches(PUBLIC_ID_PATTERN)` em `publicId` (`phase-02-auth/TD-06`).
5. Criar os DTOs de resposta com `@ApiProperty`, nos nomes de `### API Contracts`: `VideoResponseDto` + `VideoMetadataDto`, `UploadSessionResponseDto` + `UploadPartUrlDto`, `UploadCompleteResponseDto` e `MediaUrlResponseDto`, todos em `src/videos/dto/` (Revision 2026-05-12 de `openapi-docs-nestjs/TD-01`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `generatePublicId` | Unit: 11 chars, casa com `PUBLIC_ID_PATTERN` em 1000 gerações, valores distintos | `src/videos/public-id.util.spec.ts` |
| `MatchesContentTypeExtension` | Unit: `.mp4`/`video/mp4` aceito, `.MKV`/`video/x-matroska` aceito, `.mov`/`video/mp4` rejeitado, nome sem extensão rejeitado | `src/videos/validators/matches-content-type-extension.validator.spec.ts` |

A fiação dos DTOs no `ValidationPipe` fica nos e2e de cada rota (testing guide: "DTO — E2E: one validation wiring test per endpoint").

**Dependencies:** SI-03.7 (enums `VideoStatus`/`VideoProcessingError` e `VideoMetadata` usados nos DTOs de resposta)

**Acceptance criteria:**

- `generatePublicId()` sempre retorna uma string de 11 caracteres de `[A-Za-z0-9_-]`
- `InitiateUploadDto` com `file_name = 'clip.mov'` e `content_type = 'video/mp4'` falha na validação com uma mensagem sobre a extensão
- `InitiateUploadDto` com `title = '   '` falha na validação, porque depois do trim o tamanho é 0
- `PublicIdParamDto` com `publicId = 'abc'` falha na validação, e com `publicId = 'AbCdEf_-123'` passa

---

### SI-03.11 — Endpoint POST /videos (pré-cadastro do rascunho e início do multipart)

**Route:** POST /videos
**Test Specs:** see `nestjs-project/specs/videos-create.plan.md`
**Authorization:** Authenticated (cria no canal do próprio usuário)

**Description:** Ao iniciar o upload, o vídeo é pré-cadastrado como rascunho e o multipart é aberto direto no storage. A resposta traz as URLs pré-assinadas de todas as partes, e os bytes nunca passam pela API (per `phase-03-videos/TD-03`, `phase-03-videos/TD-04`, `phase-03-videos/TD-07`). Esta SI cria o `VideosController` e o `VideosModule`.

**Technical actions:**

1. Criar `src/videos/videos.service.ts` com `initiateUpload(userId, dto): Promise<UploadSessionResponseDto>`. O fluxo é: (1) `channelsService.findByUserId(userId)`; (2) `id = crypto.randomUUID()` e `key = videos/${id}/original`; (3) `storage.createMultipartUpload(key, dto.content_type)`, e se falhar sai `503 STORAGE_UNAVAILABLE` sem nada persistido; (4) insert do `Video` como em `#### POST /videos`, com `title = dto.title ?? basename sem extensão, truncado em 100`, `original_filename = file_name`, `mime_type = content_type`, `size_bytes = file_size`, `upload_id` e `upload_expires_at = now + UPLOAD_WINDOW_HOURS`. Na violação `23505` em `public_id`, gerar outro `public_id` e repetir até 5 vezes, no padrão de `ChannelsService.createChannel`. Se o insert falhar de vez, `abortMultipartUpload` best-effort e relançar (per `phase-03-videos/TD-07`; Revision de `phase-03-videos/TD-03`).
2. Implementar `buildUploadSession(video, uploadedParts)`, que monta o `UploadSessionResponseDto` com `part_count = ceil(size_bytes / UPLOAD_PART_SIZE_BYTES)`, `uploaded_parts`, `parts` (`presignUploadPart` com `PART_URL_TTL_SECONDS` para cada número ainda não enviado), `parts_expire_at` e `upload_expires_at`. A SI-03.13 reusa o mesmo método.
3. Criar `src/videos/videos.controller.ts`: `@Controller('videos')`, `@ApiTags('videos')`, `@ApiBearerAuth('access-token')` e `@SkipThrottle()` no controller (per `phase-03-videos/TD-10`). O `@Post()` com `@HttpCode(201)` recebe `@CurrentUser() user: JwtPayload` e `@Body() dto: InitiateUploadDto` e chama `initiateUpload(user.sub, dto)`. Swagger: `@ApiOperation`, `@ApiBody({ type: InitiateUploadDto })`, `@ApiResponse` 201 (`UploadSessionResponseDto`) e 400/401/503 (`ApiErrorEnvelope`).
4. Criar `src/videos/videos.module.ts`. Ele importa `TypeOrmModule.forFeature([Video])`, `ChannelsModule`, `StorageModule` e `VideoProcessingProducerModule`, e declara `VideosController` e `VideosService`. Registrar `VideosModule` em `AppModule`. O `VideoProcessingConsumer` nunca entra neste grafo (`library-refs.md` § `@nestjs/bullmq` → Consumer).
5. Regenerar o `nestjs-project/openapi.json` com `docker compose exec nestjs-api npm run openapi:export` e versionar o diff (per `openapi-docs-nestjs/TD-02`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.initiateUpload` | Unit (mocks de repo, storage e channels): `title` derivado e truncado; retry em colisão de `public_id`; falha do storage → nenhum insert; insert falho → `abortMultipartUpload` chamado; `part_count` = 160 para 10 GiB | `src/videos/videos.service.spec.ts` |
| `VideosService.initiateUpload` | Integration (DB + MinIO real): rascunho persistido com os campos do Data Model; `listParts` do `upload_id` vazio; `PUT` na URL da parte 1 aceito pelo storage | `src/videos/videos.service.integration-spec.ts` |
| `VideosModule` | Unit: compilação sem `VideoProcessingConsumer` entre os providers | `src/videos/videos.module.spec.ts` |

**Dependencies:** SI-03.6 (`findByUserId`), SI-03.8 (storage), SI-03.9 (`VideoProcessingProducerModule` importado pelo módulo), SI-03.10 (DTOs, constantes e exceções)

**Acceptance criteria:**

- `POST /videos` com `{ file_name: 'Minhas Férias.mp4', file_size: 134217728, content_type: 'video/mp4' }` retorna `201` com `status: "draft"`, `title: "Minhas Férias"`, `part_size: 67108864`, `part_count: 2`, `uploaded_parts: []` e duas URLs em `parts`
- `POST /videos` com `file_size: 10737418241` retorna `400` com `error: "VALIDATION_ERROR"`
- `POST /videos` com `file_name: 'clip.mov'` e `content_type: 'video/mp4'` retorna `400` com `error: "VALIDATION_ERROR"`
- `POST /videos` sem `Authorization` retorna `401`
- `POST /videos` com o `minio` parado retorna `503` com `error: "STORAGE_UNAVAILABLE"`, e nenhuma linha é criada em `videos`
- O vídeo criado pertence ao canal do usuário autenticado (`channel_id` igual ao `Channel.id` cujo `user_id` é o `sub` do token) e tem `upload_expires_at` = `created_at` + 24 h
- Onze `POST /videos` seguidos com o mesmo token respondem `201`, sem `429`
- O `openapi.json` versionado tem `POST /videos` com os status 201, 400, 401 e 503

---

### SI-03.12 — Endpoint GET /videos/{publicId} (status do vídeo, owner-only e lazy expiry)

**Route:** GET /videos/{publicId}
**Test Specs:** see `nestjs-project/specs/videos-get.plan.md`
**Authorization:** Owner

**Description:** Expõe ao dono o ciclo de vida do vídeo, que é como o cliente descobre que o processamento terminou. Esta SI também concentra três peças que as outras rotas reaproveitam: a busca owner-only, a lazy expiry do rascunho e o mapeamento para a resposta (Revisions de `phase-03-videos/TD-04`; `phase-03-videos/TD-09`; `phase-03-videos/TD-12`).

**Technical actions:**

1. Implementar `findOwnedOrFail(userId, publicId): Promise<Video>` no `VideosService`, numa consulta só: `videos` com `INNER JOIN channels ON channels.id = videos.channel_id`, filtrando `videos.public_id = :publicId AND channels.user_id = :userId`. Sem linha, lança `VideoNotFoundException`, e o resultado é o mesmo para ID inexistente e para vídeo de outro dono (per `phase-03-videos/TD-09`).
2. Implementar `expireIfDue(video): Promise<Video>`. Com `status = 'draft'` e `upload_expires_at <= now()`, faz `UPDATE videos SET status = 'failed', processing_error = 'UPLOAD_EXPIRED' WHERE id = :id AND status = 'draft'`, chama `abortMultipartUpload` best-effort e devolve o vídeo atualizado. Nos outros casos devolve o vídeo intacto. Toda leitura do dono chama esse método: esta rota, `GET .../upload`, `POST .../upload/complete`, `GET .../stream` e `GET .../download` (Revision "Retry and expiry parameters" de `phase-03-videos/TD-04`).
3. Implementar `toVideoResponse(video): Promise<VideoResponseDto>` com os 11 campos de `#### GET /videos/{publicId}`. `thumbnail_url` vem de `presignGetObject(thumbnail_key, { expiresIn: THUMBNAIL_URL_TTL_SECONDS, audience: 'client' })` só com `status = 'ready'` e `thumbnail_key` preenchida; nos outros casos é `null` (Revision "Thumbnail delivery" de `phase-03-videos/TD-06`). Datas saem em ISO-8601.
4. Adicionar `@Get(':publicId')` ao `VideosController`, com `@Param() params: PublicIdParamDto` e o fluxo `findOwnedOrFail` → `expireIfDue` → `toVideoResponse`. Swagger: `@ApiOperation`, `@ApiParam('publicId')`, `@ApiResponse` 200 (`VideoResponseDto`) e 400/401/404 (`ApiErrorEnvelope`).
5. Regenerar o `openapi.json` (`npm run openapi:export`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.expireIfDue` / `toVideoResponse` | Unit: `draft` vencido → `failed`/`UPLOAD_EXPIRED` e abort chamado; `draft` no prazo intacto; `ready` sem `thumbnail_key` → `thumbnail_url: null`; `processing` → `thumbnail_url: null`; resposta sem `id`, `upload_id` e chaves | `src/videos/videos.service.spec.ts` |
| `VideosService.findOwnedOrFail` / `expireIfDue` | Integration (DB real): vídeo de outro canal → `VideoNotFoundException`; `UPDATE` condicional não sobrescreve um vídeo que já saiu de `draft` | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.11 (`VideosController`, `VideosModule` e `VideosService`)

**Acceptance criteria:**

- `GET /videos/{publicId}` do dono, com o vídeo em `draft`, retorna `200` com os 11 campos de `VideoResponseDto`, `status: "draft"`, `metadata: null`, `processing_error: null` e `thumbnail_url: null`
- `GET /videos/{publicId}` de um vídeo `ready` com thumbnail retorna `thumbnail_url` pré-assinado, cujo GET retorna `200` com `Content-Type: image/jpeg`
- `GET /videos/{publicId}` feito por outro usuário autenticado retorna `404` com `error: "VIDEO_NOT_FOUND"`, igual à resposta para um `publicId` inexistente
- `GET /videos/abc` retorna `400` com `error: "VALIDATION_ERROR"`
- `GET /videos/{publicId}` de um `draft` com `upload_expires_at` no passado retorna `200` com `status: "failed"` e `processing_error: "UPLOAD_EXPIRED"`, e a linha fica gravada assim
- A resposta nunca contém `id`, `channel_id`, `original_filename`, `upload_id` nem `thumbnail_key`

---

### SI-03.13 — Endpoint GET /videos/{publicId}/upload (retomada do upload)

**Route:** GET /videos/{publicId}/upload
**Test Specs:** see `nestjs-project/specs/videos-upload-resume.plan.md`
**Authorization:** Owner

**Description:** Permite retomar um upload interrompido ou renovar URLs de parte que venceram. As partes já recebidas são descobertas no storage, e só as que faltam são reassinadas (per `phase-03-videos/TD-03`). Com o multipart já montado depois de um `503 QUEUE_UNAVAILABLE`, a rota responde `409`, porque não há partes a reenviar (Revision "Completion retry after an enqueue failure" de `phase-03-videos/TD-03`).

**Technical actions:**

1. Implementar `getUploadSession(userId, publicId): Promise<UploadSessionResponseDto>` no `VideosService`. Ele chama `findOwnedOrFail` e depois `expireIfDue`. Se o vídeo acabou de expirar, lança `UploadExpiredException` (410). Fora de `draft`, lança `InvalidVideoStateException` (409) (Revision "Upload error contract" de `phase-03-videos/TD-03`).
2. Chamar `storage.listParts(original_key, upload_id)`. Com uma lista, devolve `buildUploadSession(video, uploadedPartNumbers)`, só com as partes de `1..part_count` ausentes e o `parts_expire_at` renovado.
3. Quando `listParts` retorna `null` (upload inexistente), chamar `storage.headObject(original_key)`. Se o objeto existe, lança `InvalidVideoStateException` (409), e o vídeo continua `draft`. Sem objeto, faz `UPDATE ... SET status = 'failed', processing_error = 'UPLOAD_EXPIRED' WHERE status = 'draft'` e lança `UploadExpiredException` (410) (Revision "Completion retry after an enqueue failure" de `phase-03-videos/TD-03`; `library-refs.md` § Multipart de baixo nível → retomada).
4. Adicionar `@Get(':publicId/upload')` ao `VideosController`, com `PublicIdParamDto`. Swagger: `@ApiResponse` 200 (`UploadSessionResponseDto`) e 400/401/404/409/410/503 (`ApiErrorEnvelope`). A `StorageUnavailableException` de `listParts`/`headObject` sobe como `503 STORAGE_UNAVAILABLE`.
5. Regenerar o `openapi.json` (`npm run openapi:export`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getUploadSession` | Unit: partes faltantes calculadas; `listParts` `null` + objeto presente → `InvalidVideoStateException`; `null` + sem objeto → `failed`/`UPLOAD_EXPIRED` e `UploadExpiredException`; `processing` → `InvalidVideoStateException`; `draft` vencido → `UploadExpiredException` | `src/videos/videos.service.spec.ts` |
| `VideosService.getUploadSession` | Integration (DB + MinIO real): com 1 de 2 partes enviada, a resposta tem `uploaded_parts: [1]` e só a URL da parte 2; depois de `AbortMultipartUpload` direto no storage, o vídeo vira `failed`/`UPLOAD_EXPIRED` | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.12 (`findOwnedOrFail`, `expireIfDue`)

**Acceptance criteria:**

- Com a parte 1 de 2 já enviada, `GET /videos/{publicId}/upload` retorna `200` com `uploaded_parts: [1]`, `parts` com uma única entrada (`part_number: 2`) e `parts_expire_at` posterior ao da iniciação
- `GET /videos/{publicId}/upload` de um vídeo em `processing` retorna `409` com `error: "INVALID_VIDEO_STATE"`
- `GET /videos/{publicId}/upload` de um `draft` cujo multipart já foi montado (objeto `videos/{videoId}/original` presente) retorna `409` com `error: "INVALID_VIDEO_STATE"`, e o vídeo continua `draft`
- `GET /videos/{publicId}/upload` de um `draft` cujo multipart foi abortado no storage, sem objeto, retorna `410` com `error: "UPLOAD_EXPIRED"`, e o vídeo passa a `failed` com `processing_error: "UPLOAD_EXPIRED"`
- `GET /videos/{publicId}/upload` de um `draft` com `upload_expires_at` no passado retorna `410` com `error: "UPLOAD_EXPIRED"`
- `GET /videos/{publicId}/upload` feito por outro usuário retorna `404` com `error: "VIDEO_NOT_FOUND"`

---

### SI-03.14 — Endpoint POST /videos/{publicId}/upload/complete (conclusão e enfileiramento)

**Route:** POST /videos/{publicId}/upload/complete
**Test Specs:** see `nestjs-project/specs/videos-upload-complete.plan.md`
**Authorization:** Owner

**Description:** Confere o upload no servidor, monta o original e publica o job de processamento. A conclusão é idempotente e pode ser repetida com segurança depois de `503 QUEUE_UNAVAILABLE` sem reenviar bytes (per `phase-03-videos/TD-03`, `phase-03-videos/TD-04`, `phase-03-videos/TD-01`; DG-1; Revisions "Size mismatch outcome" e "Completion retry after an enqueue failure" de TD-03).

**Technical actions:**

1. Implementar `completeUpload(userId, publicId): Promise<UploadCompleteResponseDto>` no `VideosService`. O fluxo começa com `findOwnedOrFail` → `expireIfDue`. Se o vídeo acabou de expirar, lança `UploadExpiredException`. Com o vídeo em `ready` ou `failed`, lança `InvalidVideoStateException`. Com o vídeo em `processing`, chama `startProcessing` sem a transição, re-enfileirando com o mesmo `jobId`, e responde `202` (Revision "Upload error contract" de `phase-03-videos/TD-03`).
2. Implementar `assembleUpload(video)` para o `draft` com multipart, nos passos 1 a 4 de `#### POST /videos/{publicId}/upload/complete`. São eles: `listParts`; pré-checagem de partes `1..part_count` contíguas (senão `UploadIncompleteException`, e o vídeo continua `draft`); soma dos `Size` = `size_bytes` (senão `UploadSizeMismatchException`, e continua `draft`); `completeMultipartUpload` com as partes listadas; e `headObject`, com `contentLength` ≠ `size_bytes` → `deleteObject`, `failed`/`PROCESSING_FAILED` e `UploadSizeMismatchException` (Revision "Size mismatch outcome").
3. Implementar `resolveAssembledObject(video)` para o `draft` em que `listParts` retornou `null`, no passo 6 do contrato. O fluxo chama `headObject`. Com o tamanho declarado, segue direto para `startProcessing` sem remontar. Com outro tamanho, tem o mesmo desfecho do passo 4. Sem objeto, faz `failed`/`UPLOAD_EXPIRED` e lança `UploadExpiredException` (Revision "Completion retry after an enqueue failure").
4. Implementar `startProcessing(video)`. Ele faz `UPDATE ... SET status = 'processing' WHERE id = :id AND status = 'draft'` e depois `videoProcessingProducer.enqueue(video.id)`. Na `QueueUnavailableException`, faz `UPDATE ... SET status = 'draft' WHERE id = :id AND status = 'processing'` e relança (`503 QUEUE_UNAVAILABLE`, per `phase-03-videos/TD-01`).
5. Adicionar `@Post(':publicId/upload/complete')` com `@HttpCode(202)` e `PublicIdParamDto` ao `VideosController`. Swagger: `@ApiResponse` 202 (`UploadCompleteResponseDto`) e 400/401/404/409/410/503 (`ApiErrorEnvelope`), listando no `description` os três códigos `409`. Regenerar o `openapi.json` (`npm run openapi:export`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` | Unit (mocks de storage, producer e repo): parte faltante → `UPLOAD_INCOMPLETE` em `draft`; soma divergente → `UPLOAD_SIZE_MISMATCH` em `draft`; `HeadObject` pós-montagem divergente → `deleteObject` + `failed`/`PROCESSING_FAILED`; enqueue falho → volta a `draft` + `QUEUE_UNAVAILABLE`; `listParts` `null` + objeto íntegro → sem `completeMultipartUpload`, `processing`; `listParts` `null` + sem objeto → `failed`/`UPLOAD_EXPIRED`; `processing` → re-enqueue; `ready` → `INVALID_VIDEO_STATE` | `src/videos/videos.service.spec.ts` |
| `VideosService.completeUpload` | Integration (DB + MinIO + Redis reais): duas partes enviadas pelas URLs → `processing`, job `process-video` com `jobId` = `video.id` no prefixo de teste, objeto `videos/{id}/original` com `size_bytes`; producer que falha uma vez → `draft`, e a segunda chamada conclui pelo `HeadObject` sem `ListParts` válido | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.13 (lógica de `draft` e o desempate por `HeadObject`), SI-03.9 (`VideoProcessingProducer`)

**Acceptance criteria:**

- Com as duas partes enviadas, `POST /videos/{publicId}/upload/complete` retorna `202` com `{ public_id, status: "processing" }`, e a fila `video-processing` tem um job `process-video` com `data.videoId` igual ao uuid do vídeo
- Com só a parte 1 de 2 enviada, a conclusão retorna `409` com `error: "UPLOAD_INCOMPLETE"`, e `GET /videos/{publicId}` continua mostrando `status: "draft"`
- Com uma parte enviada com tamanho diferente do esperado, a conclusão retorna `409` com `error: "UPLOAD_SIZE_MISMATCH"`, e o vídeo continua `draft`
- Com o Redis parado, a conclusão retorna `503` com `error: "QUEUE_UNAVAILABLE"`, e o vídeo volta a `draft`. Com o Redis de volta, repetir a mesma chamada retorna `202`, sem reenviar nenhuma parte
- Repetir a conclusão com o vídeo já em `processing` retorna `202`, e a fila continua com um único job para o vídeo
- A conclusão de um vídeo `ready` ou `failed` retorna `409` com `error: "INVALID_VIDEO_STATE"`
- A conclusão de um `draft` com `upload_expires_at` no passado retorna `410` com `error: "UPLOAD_EXPIRED"`
- A conclusão feita por outro usuário retorna `404` com `error: "VIDEO_NOT_FOUND"`

---

### SI-03.15 — Endpoint GET /videos/{publicId}/stream (URL pré-assinada para streaming)

**Route:** GET /videos/{publicId}/stream
**Test Specs:** see `nestjs-project/specs/videos-stream.plan.md`
**Authorization:** Owner

**Description:** Entrega ao dono uma URL de streaming que o player usa com requisições `Range`, sem download completo e sem a API no caminho dos bytes (per `phase-03-videos/TD-08`). O TTL acompanha a duração do vídeo (Revisions "Separate TTLs" e "Video state gate" de `phase-03-videos/TD-08`).

**Technical actions:**

1. Criar `src/videos/media-url.util.ts` com `streamTtlSeconds(durationSeconds: number | null): number`. Com `null`, retorna `STREAM_TTL_MIN_SECONDS`. Senão, retorna `Math.min(Math.max(Math.ceil(2 * durationSeconds), STREAM_TTL_MIN_SECONDS), STREAM_TTL_MAX_SECONDS)` (`library-refs.md` § `@aws-sdk/s3-request-presigner` → URLs de streaming e download).
2. Implementar `assertReady(video)` no `VideosService`: fora de `ready`, lança `VideoNotReadyException` (409). Implementar também `getStreamUrl(userId, publicId): Promise<MediaUrlResponseDto>`, que segue `findOwnedOrFail` → `expireIfDue` → `assertReady` e depois chama `presignGetObject(original_key, { expiresIn: streamTtlSeconds(duration_seconds), audience: 'client' })` sem disposition. Devolve `{ url, expires_at: now + ttl }`. A checagem de dono vem antes da de estado (Revision "Video state gate" de `phase-03-videos/TD-08`).
3. Adicionar `@Get(':publicId/stream')` ao `VideosController`, com `PublicIdParamDto`. Swagger: `@ApiResponse` 200 (`MediaUrlResponseDto`) e 400/401/404/409 (`ApiErrorEnvelope`).
4. Regenerar o `openapi.json` (`npm run openapi:export`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `streamTtlSeconds` | Unit: `null` → 3600; 60 s → 3600 (piso); 3600 s → 7200; 30000 s → 43200 (teto); duração fracionária arredondada para cima | `src/videos/media-url.util.spec.ts` |
| `VideosService.getStreamUrl` | Integration (DB + MinIO real): vídeo `ready` com original gravado → GET na URL com `Range: bytes=0-1023` retorna `206`; `draft`/`processing`/`failed` → `VideoNotReadyException` | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.12 (`findOwnedOrFail`, `expireIfDue`)

**Acceptance criteria:**

- `GET /videos/{publicId}/stream` de um vídeo `ready` com `duration_seconds = 600` retorna `200` com `url` e `expires_at` aproximadamente 3600 s à frente
- `GET /videos/{publicId}/stream` de um vídeo `ready` com `duration_seconds = 7200` retorna `expires_at` aproximadamente 14400 s à frente; com `duration_seconds = null`, 3600 s
- Um GET na `url` devolvida com `Range: bytes=0-1023` retorna `206` com 1024 bytes, e a resposta não traz `Content-Disposition: attachment`
- `GET /videos/{publicId}/stream` de um vídeo em `draft`, `processing` ou `failed` retorna `409` com `error: "VIDEO_NOT_READY"`
- `GET /videos/{publicId}/stream` feito por outro usuário retorna `404` com `error: "VIDEO_NOT_FOUND"` em qualquer estado

---

### SI-03.16 — Endpoint GET /videos/{publicId}/download (URL pré-assinada com nome original)

**Route:** GET /videos/{publicId}/download
**Test Specs:** see `nestjs-project/specs/videos-download.plan.md`
**Authorization:** Owner

**Description:** Entrega ao dono uma URL de download que salva o arquivo com o nome original declarado na iniciação, inclusive com caracteres não-ASCII (per `phase-03-videos/TD-08`; Revision "Download filename").

**Technical actions:**

1. Criar `src/videos/content-disposition.util.ts` com `buildAttachmentDisposition(originalFilename: string): string`, que retorna `attachment; filename="<fallback>"; filename*=UTF-8''<encoded>`. O `<fallback>` troca por `_` todo caractere fora do ASCII imprimível (0x20–0x7E) e remove `"` e `\`. O `<encoded>` é `encodeURIComponent(originalFilename)`, com `'`, `(`, `)` e `*` também percent-encoded, para ficar no `attr-char` da RFC 5987 (RFC 6266 / RFC 5987; `library-refs.md` § `@aws-sdk/s3-request-presigner`).
2. Implementar `getDownloadUrl(userId, publicId): Promise<MediaUrlResponseDto>` no `VideosService`, com o fluxo `findOwnedOrFail` → `expireIfDue` → `assertReady` (SI-03.15) → `presignGetObject(original_key, { expiresIn: DOWNLOAD_TTL_SECONDS, audience: 'client', responseContentDisposition: buildAttachmentDisposition(original_filename) })`. Devolve `{ url, expires_at: now + 3600 s }` (Revision "Separate TTLs" de `phase-03-videos/TD-08`).
3. Adicionar `@Get(':publicId/download')` ao `VideosController`, com `PublicIdParamDto`. Swagger: `@ApiResponse` 200 (`MediaUrlResponseDto`) e 400/401/404/409 (`ApiErrorEnvelope`).
4. Regenerar o `openapi.json` (`npm run openapi:export`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `buildAttachmentDisposition` | Unit: nome ASCII preservado; `Férias 2026.mp4` → fallback `F_rias 2026.mp4` + `filename*=UTF-8''F%C3%A9rias%202026.mp4`; `"` e `\` removidos do fallback; `'()*` codificados | `src/videos/content-disposition.util.spec.ts` |
| `VideosService.getDownloadUrl` | Integration (DB + MinIO real): GET na URL devolvida responde com `Content-Disposition` igual ao valor construído; `processing` → `VideoNotReadyException` | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.15 (`assertReady`)

**Acceptance criteria:**

- `GET /videos/{publicId}/download` de um vídeo `ready` retorna `200` com `url` e `expires_at` aproximadamente 3600 s à frente, independente de `duration_seconds`
- Um GET na `url` de um vídeo cujo `original_filename` é `Férias 2026.mp4` responde com `Content-Disposition: attachment; filename="F_rias 2026.mp4"; filename*=UTF-8''F%C3%A9rias%202026.mp4`
- `GET /videos/{publicId}/download` de um vídeo em `draft`, `processing` ou `failed` retorna `409` com `error: "VIDEO_NOT_READY"`
- `GET /videos/{publicId}/download` feito por outro usuário retorna `404` com `error: "VIDEO_NOT_FOUND"`
- O `openapi.json` versionado tem as 6 operações sob a tag `videos`, cada uma com o security `access-token`

---

### SI-03.17 — Runtime do worker: `src/worker/main.ts`, `WorkerModule` e build em `dist-worker`

**Description:** Cria o segundo entrypoint do mesmo codebase NestJS, sem HTTP, com saída de build própria. O worker de vídeo roda em processo e container separados da API (per `phase-03-videos/TD-05`), e os dois podem compilar em watch no mesmo volume sem conflito.

**Technical actions:**

1. Extrair a factory do `TypeOrmModule.forRootAsync` de `src/app.module.ts` para `src/database/typeorm-options.ts`, como `typeOrmOptionsFactory(dbConfig)`, e usá-la no `AppModule` e no `WorkerModule`. Os parâmetros de conexão continuam vindo só do `databaseConfig` (Inherited Conventions da Fase 01: nunca duplicar entre módulos).
2. Criar `src/worker/worker.module.ts`. Ele importa `ConfigModule.forRoot` com o mesmo `load` e o mesmo `envValidationSchema` da API, `TypeOrmModule.forRootAsync` com a factory compartilhada, `TypeOrmModule.forFeature([Video])`, `StorageModule`, `QueueModule` e `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })`, este com a conexão padrão, sem `enableOfflineQueue: false`. Não importa `VideosModule`, `AuthModule` nem controller algum (`library-refs.md` § `@nestjs/bullmq` → Consumer).
3. Criar `src/worker/main.ts`: `const app = await NestFactory.createApplicationContext(WorkerModule)`, `app.enableShutdownHooks()` para o `SIGTERM` do Compose fechar workers e filas, e um log de inicialização com a fila e o prefixo. Confirmar no código do `@nestjs/bullmq` que o shutdown chama `close()`. Se não chamar, fechar num `onApplicationShutdown` (`library-refs.md` § `bullmq` → Encerramento).
4. Criar `nestjs-project/tsconfig.worker.json`, que estende `./tsconfig.build.json` com `compilerOptions.outDir: "./dist-worker"`, `compilerOptions.tsBuildInfoFile: "./dist-worker/tsconfig.worker.tsbuildinfo"` e `exclude: ["node_modules", "test", "dist", "dist-worker", "**/*spec.ts"]`. Acrescentar `"exclude": ["node_modules", "dist", "dist-worker"]` ao `tsconfig.json` e `"dist-worker"` ao `exclude` do `tsconfig.build.json`, para que os `.d.ts` emitidos não entrem no `tsc --noEmit` nem no `nest build`. Acrescentar `/dist-worker` ao `.gitignore`.
5. Acrescentar ao `package.json` os scripts `"start:worker:dev": "nest start --watch --path tsconfig.worker.json --entryFile worker/main"`, `"build:worker": "nest build --path tsconfig.worker.json"` e `"start:worker:prod": "node dist-worker/worker/main"`. Confirmar no primeiro build que a saída fica em `dist-worker/worker/main.js` (`rootDir` inferido como `src`, como já acontece com `dist/main.js`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `WorkerModule` | Unit: compilação com `ConfigModule`, TypeORM, `StorageService` e `getQueueToken('video-processing')` resolvidos; nenhum controller registrado | `src/worker/worker.module.spec.ts` |

**Dependencies:** SI-03.7 (`Video`), SI-03.8 (`StorageModule`), SI-03.9 (`QueueModule` e constantes)

**Acceptance criteria:**

- `docker compose exec nestjs-api npm run build:worker` gera `dist-worker/worker/main.js` e deixa `dist/` intacto
- `docker compose exec nestjs-api npm run build` gera `dist/main.js` sem nenhum arquivo de `dist-worker/` misturado
- `docker compose exec nestjs-api npx tsc --noEmit` sai com código 0 com `dist-worker/` presente
- `node dist-worker/worker/main` sobe o contexto sem abrir porta HTTP e encerra com código 0 ao receber `SIGTERM`
- `git status` não lista `dist-worker/`

---

### SI-03.18 — `MediaProbeService`: extração de duração e metadados com `ffprobe`

**Description:** Lê duração e metadados do original direto do storage, por URL pré-assinada interna, sem copiar o arquivo. A mídia sem stream de vídeo ou fora da allowlist é rejeitada como não suportada (per `phase-03-videos/TD-06`; Revision "Metadata shape").

**Technical actions:**

1. Criar `src/worker/media/process-runner.ts` com `runProcess(command, args, { timeoutMs }): Promise<{ stdout: Buffer; stderr: string; exitCode: number }>`, sobre `child_process.spawn`. Os argumentos vão em array, sem shell. O stdout é acumulado em `Buffer`, e o processo leva `SIGKILL` no timeout. É reutilizado por ffprobe e ffmpeg (per `phase-03-videos/TD-06` Decision A: "Spawn ffprobe/ffmpeg").
2. Criar `src/worker/media/probe-parser.ts` com `parseProbeOutput(json): ProbeResult`, que devolve `duration_seconds` (`format.duration` como número, ou `null`) e `metadata: VideoMetadata` com as 7 chaves de `### Data Model → Tipo VideoMetadata` (`frame_rate` a partir de `avg_frame_rate` `n/d`; `audio_codec` `null` sem stream de áudio). O parser lança `UnsupportedMediaError` sem stream `codec_type = 'video'` ou com `format_name` que não contenha `mp4`/`mov` nem `matroska`/`webm`.
3. Criar `src/worker/media/media-probe.service.ts` com `probe(url): Promise<ProbeResult>`, que roda `runProcess('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', url], { timeoutMs: 120000 })`. Com saída de código ≠ 0 e stderr de dados inválidos (`Invalid data found`), lança `UnsupportedMediaError`. Os outros códigos ≠ 0, timeout e JSON vazio são erros transitórios e são relançados.
4. Registrar `MediaProbeService` como provider do `WorkerModule`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `parseProbeOutput` | Unit: JSON de MP4 com áudio → 7 chaves e `duration_seconds`; sem áudio → `audio_codec: null`; `avg_frame_rate: '30000/1001'` → `29.97`; `'0/0'` → `null`; só áudio → `UnsupportedMediaError`; `format_name: 'avi'` → `UnsupportedMediaError` | `src/worker/media/probe-parser.spec.ts` |
| `MediaProbeService` | Integration (ffprobe real + MinIO): fixtures de `media-fixtures.ts` enviadas ao bucket de teste e lidas por URL pré-assinada interna; MP4 faststart, MP4 com moov no fim, `.mov`, `.webm` → metadados; só áudio e bytes aleatórios → `UnsupportedMediaError` | `src/worker/media/media-probe.service.integration-spec.ts` |

**Dependencies:** SI-03.2 (ffprobe na imagem), SI-03.4 (fixtures), SI-03.8 (`presignGetObject` interno), SI-03.17 (`WorkerModule`)

**Acceptance criteria:**

- Para a fixture MP4 de 3 s em 1920x1080 com áudio, `probe(url)` retorna `duration_seconds` ≈ 3 e `metadata` com `width: 1920`, `height: 1080`, `video_codec`, `audio_codec`, `bit_rate`, `frame_rate` e `format_name`, sem nenhuma chave a mais
- A fixture MP4 com o moov atom no fim é lida pela URL pré-assinada com o mesmo resultado, sem baixar o arquivo para disco
- A fixture só de áudio e a de bytes aleatórios resultam em `UnsupportedMediaError`
- Uma URL que aponta para uma chave inexistente resulta em erro transitório, não em `UnsupportedMediaError`

---

### SI-03.19 — `ThumbnailService`: geração da thumbnail com `ffmpeg`

**Description:** Gera a thumbnail automaticamente a partir de um frame do vídeo e a grava no prefixo do vídeo, no mesmo bucket privado (per `phase-03-videos/TD-06`).

**Technical actions:**

1. Criar `src/worker/media/thumbnail-time.util.ts` com `thumbnailTimeSeconds(durationSeconds: number | null): number`. Com `null` ou `0`, retorna `0`; senão, `Math.min(0.1 * durationSeconds, 5)` (per `phase-03-videos/TD-06`).
2. Criar `src/worker/media/thumbnail.service.ts` com `generate(url, durationSeconds): Promise<Buffer>`, que roda `runProcess('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', url, '-frames:v', '1', '-vf', "scale='min(1280,iw)':-2", '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'], { timeoutMs: 120000 })`. Se o resultado sair vazio ou com código ≠ 0 com `t > 0`, repete com `t = 0` (fallback de TD-06). Se falhar também em `t = 0`, lança erro transitório.
3. Implementar `store(videoId, jpeg: Buffer): Promise<string>`, que faz `storage.putObject('videos/${videoId}/thumbnail.jpg', jpeg, 'image/jpeg')` e devolve a chave gravada.
4. Registrar `ThumbnailService` como provider do `WorkerModule`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `thumbnailTimeSeconds` | Unit: `null` → 0; 3 s → 0.3; 120 s → 5 | `src/worker/media/thumbnail-time.util.spec.ts` |
| `ThumbnailService` | Integration (ffmpeg real + MinIO): fixture 1920x1080 → JPEG (bytes iniciais `FF D8`) com largura 1280, conferida com ffprobe; gravado em `videos/{id}/thumbnail.jpg` com `Content-Type: image/jpeg`; `t` além do fim do vídeo cai no fallback `t = 0` | `src/worker/media/thumbnail.service.integration-spec.ts` |

**Dependencies:** SI-03.18 (`runProcess` e fixtures lidas por URL)

**Acceptance criteria:**

- Para a fixture de 3 s em 1920x1080, `generate` retorna um JPEG de 1280 px de largura, com a proporção preservada (720 px de altura)
- Para uma fixture com largura menor que 1280 px, a thumbnail mantém a largura original
- Depois de `store`, `HeadObject('videos/{id}/thumbnail.jpg')` no bucket de teste retorna `ContentType: image/jpeg`
- Com `durationSeconds` maior que a duração real do arquivo, a thumbnail sai do frame em `t = 0`

---

### SI-03.20 — `VideoProcessingConsumer`: job `process-video`, `UnrecoverableError` e `@OnWorkerEvent('failed')`

**Description:** Implementa o processamento automático depois do upload. O consumer faz o probing e a thumbnail, grava o resultado no vídeo e aplica a política de falha, com retries limitadas para erros transitórios e falha definitiva sem retry para mídia não suportada (per `phase-03-videos/TD-04`, `phase-03-videos/TD-05`, `phase-03-videos/TD-06`; `### Events/Messages`).

**Technical actions:**

1. Criar `src/worker/video-processing.consumer.ts` com `@Processor(VIDEO_PROCESSING_QUEUE)` e `extends WorkerHost`. `process(job: Job<ProcessVideoJobData>)` carrega o vídeo por `job.data.videoId`. Se não existir, ou se não estiver em `processing`, retorna sem efeito. Com o vídeo em `processing`, assina a URL interna (`presignGetObject(original_key, { expiresIn: 3600, audience: 'internal' })`) e chama `mediaProbe.probe(url)`. Uma `UnsupportedMediaError` vira `throw new UnrecoverableError('UNSUPPORTED_MEDIA')`, e os demais erros são relançados para o BullMQ tentar de novo (`library-refs.md` § `bullmq` → Falha definitiva).
2. Em seguida, `thumbnail.generate(url, duration_seconds)` → `thumbnail.store(video.id, jpeg)` e `UPDATE videos SET status = 'ready', duration_seconds, metadata, thumbnail_key, processing_error = NULL WHERE id = :id AND status = 'processing'`. Se o `UPDATE` não afetar linha nenhuma, o job termina sem erro, porque outro caminho já mudou o estado.
3. Implementar `@OnWorkerEvent('failed') onFailed(job: Job | undefined, error: Error)`. Sem `job`, retorna. A falha é definitiva quando `error instanceof UnrecoverableError || job.attemptsMade >= (job.opts.attempts ?? 1)`. Nesse caso, grava `status = 'failed'` com `processing_error` igual a `error.message` quando for `UNSUPPORTED_MEDIA`, e `PROCESSING_FAILED` nos outros casos, inclusive job travado, sempre com `WHERE status = 'processing'`. Todo o handler fica em `try/catch` com log, sem rethrow, que é a única exceção ao "always rethrows" de TD-04 (`library-refs.md` § `@nestjs/bullmq` → Eventos do worker).
4. Aplicar a concorrência num `onApplicationBootstrap`: `this.worker.concurrency = queueConfig.workerConcurrency` (padrão 1, per `phase-03-videos/TD-05`).
5. Registrar `VideoProcessingConsumer` como provider **só** no `WorkerModule`. O `videos.module.spec.ts` (SI-03.11) continua garantindo que ele não está no grafo da API.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingConsumer` | Unit (mocks de repo, storage, probe e thumbnail): vídeo fora de `processing` → no-op; `UnsupportedMediaError` → `UnrecoverableError('UNSUPPORTED_MEDIA')`; erro transitório relançado; `onFailed` com tentativas restantes → sem `UPDATE`; `onFailed` esgotado → `PROCESSING_FAILED`; `onFailed` com `UnrecoverableError` → `UNSUPPORTED_MEDIA`; erro dentro do `onFailed` só logado | `src/worker/video-processing.consumer.spec.ts` |
| `VideoProcessingConsumer` | Integration (worker in-process; Redis, MinIO, DB e ffmpeg reais; prefixo de teste; backoff de 10 ms): MP4 válido → `ready` com `duration_seconds`, 7 chaves em `metadata` e thumbnail no storage; só áudio → `failed`/`UNSUPPORTED_MEDIA` com `attemptsMade = 1`; original ausente → 3 tentativas e `failed`/`PROCESSING_FAILED` | `src/worker/video-processing.consumer.integration-spec.ts` |
| `WorkerModule` | Unit: compilação com o consumer registrado | `src/worker/worker.module.spec.ts` |

**Dependencies:** SI-03.17 (`WorkerModule` e entrypoint), SI-03.19 (`ThumbnailService` e `MediaProbeService`)

**Acceptance criteria:**

- Um job `process-video` para um vídeo `processing` cujo original é um MP4 válido deixa o vídeo `ready`, com `duration_seconds` preenchido, `metadata` com exatamente `width`, `height`, `video_codec`, `audio_codec`, `bit_rate`, `frame_rate` e `format_name`, e `thumbnail_key = 'videos/{id}/thumbnail.jpg'` existente no storage
- Depois disso, `GET /videos/{publicId}` retorna `status: "ready"` e um `thumbnail_url` não nulo
- Um original só de áudio deixa o vídeo `failed` com `processing_error: "UNSUPPORTED_MEDIA"` após uma única tentativa
- Um original inacessível deixa o vídeo `failed` com `processing_error: "PROCESSING_FAILED"` só depois da terceira tentativa
- Um job para um vídeo que já está `ready` termina sem alterar a linha
- Com `VIDEO_WORKER_CONCURRENCY=2`, o worker processa dois jobs ao mesmo tempo

---

### SI-03.21 — Infra: serviço `video-worker` no Compose

**Description:** Coloca o worker no seu próprio container, com a mesma imagem e o mesmo código da API. Ao contrário do `nestjs-api`, que fica parado em `tail -f /dev/null` até o dev pedir o servidor, o `video-worker` sobe sozinho e se reinicia sozinho (per `phase-03-videos/TD-05`).

**Technical actions:**

1. Adicionar o serviço `video-worker` ao `nestjs-project/compose.yaml`, com `build: { context: ., dockerfile: Dockerfile.dev }`, `volumes: [".:/home/node/app"]` e `command: ["npm", "run", "start:worker:dev"]`. Não publica porta (per `phase-03-videos/TD-05`).
2. Configurar `restart: unless-stopped` e `stop_grace_period: 2m`, para que o `SIGTERM` espere o job ativo, com probing e thumbnail lidos por URL (per `phase-03-videos/TD-05`; `library-refs.md` § `bullmq` → Encerramento).
3. Configurar `depends_on`: `db: { condition: service_healthy }`, `redis: { condition: service_healthy }` e `minio-init: { condition: service_completed_successfully }` (Revision "MinIO image and buckets" de `phase-03-videos/TD-02`; `library-refs.md` § `bullmq` → Producer fail-fast).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Container `video-worker` | E2E de liveness: uma `Queue('video-processing')` com prefixo `streamtube` (dev, montada explicitamente no teste) tem `getWorkers()` com pelo menos 1 worker registrado | `test/video-worker.e2e-spec.ts` |

**Dependencies:** SI-03.3 (`redis`, `minio-init`), SI-03.20 (consumer registrado, necessário para o worker aparecer na fila)

**Acceptance criteria:**

- Depois de `docker compose up -d`, `docker compose ps video-worker` mostra o serviço `running`, sem nenhum `docker compose exec` manual
- `docker compose logs video-worker` mostra o log de inicialização com a fila `video-processing` e o prefixo `streamtube`
- `docker compose restart video-worker` encerra o processo de forma limpa (`SIGTERM` tratado) e o container volta a `running`
- Um vídeo concluído pela API em dev (`POST .../upload/complete`) chega a `ready` sem nenhum processo iniciado à mão

---

### SI-03.22 — Documentação: CLAUDE.md, README e diagrama de arquitetura

**Description:** Alinha a documentação versionada ao que a fase entrega: serviços novos, checagens de prontidão, o fluxo de vídeos e a fila decidida (CLAUDE.md da raiz → Working Principles → Documentation). Sem isso, a próxima sessão de desenvolvimento partiria de instruções desatualizadas.

**Technical actions:**

1. `nestjs-project/CLAUDE.md`:
   - Em "Services", entram `redis` (Redis 8, `noeviction` + AOF), `minio` (portas 9000/9001, buckets `streamtube`/`streamtube-test`), `minio-init` (one-shot) e `video-worker`.
   - Em "Environment Startup Verification", entram as checagens de prontidão: `docker compose exec redis redis-cli ping` → `PONG`; `curl -f http://localhost:9000/minio/health/live` → `200`; `docker compose ps minio-init` → `exited (0)`; `docker compose logs video-worker`.
   - Também ali, a exceção de que o `video-worker` sobe sozinho (`restart: unless-stopped`), ao contrário do `nestjs-api`.
   - Nova seção "Videos": controle × dados, rotas `/videos/{publicId}`, worker separado com `npm run start:worker:dev`/`build:worker`, isolamento dos testes por bucket e prefixo `streamtube-test` e FFmpeg na imagem.
   - Em "Environment File Conventions", o exemplo de `MAIL_FROM` passa a usar aspas simples.
2. `CLAUDE.md` da raiz: o container Message Queue deixa de ser `(TBD)` e passa a `(Redis + BullMQ)`. A linha "`next-frontend/` (Next.js) — not yet initialized" sai, e a estrutura descreve o `next-frontend/` existente. O Video Worker passa a "mesmo codebase NestJS, entrypoint `src/worker/main.ts`" (per `phase-03-videos/TD-01`, `phase-03-videos/TD-05`).
3. `README.md` da raiz: em "🏗️ Arquitetura", Video Worker, Object Storage (MinIO `pgsty/minio`) e Message Queue (Redis + BullMQ) deixam de ser "planejado — Fase 03". Em "🚀 Como rodar → Backend", entram os serviços novos e a nota de que o worker sobe com o `docker compose up -d`.
4. `docs/diagrams/software-arch.mermaid`:
   - `ContainerQueue(queue, ...)` passa de `"TBD"` a `"Redis + BullMQ"`.
   - O `Container(worker, ...)` passa a `"Nest.js + FFmpeg"`.
   - `Rel(api, storage, ...)` passa a `"Signs URLs, multipart control"`, porque a API não carrega bytes.
   - Entra `Rel(frontend, storage, "Uploads parts / Streams", "HTTPS")`, que substitui o "Streams" atual (Revision "Control plane and data plane split" de `phase-03-videos/TD-03`).

**Tests:** _(empty — documentação; a verificação é a revisão do diff)_

**Dependencies:** SI-03.14, SI-03.16, SI-03.21 (documenta o comportamento já implementado)

**Acceptance criteria:**

- `grep -n "TBD" CLAUDE.md docs/diagrams/software-arch.mermaid` não encontra mais o container de fila
- `grep -n "not yet initialized" CLAUDE.md` não retorna nada
- `nestjs-project/CLAUDE.md` lista os serviços `redis`, `minio`, `minio-init` e `video-worker`, e traz um comando de prontidão para cada serviço de infraestrutura novo
- O diagrama `software-arch.mermaid` renderiza sem erro de sintaxe C4 e mostra a fila como "Redis + BullMQ"
- O `README.md` não chama mais de "planejado" nenhum container entregue na Fase 03

---

## Technical Specifications

### Data Model

#### Video

Tabela `videos`. As colunas seguem o padrão snake_case das entidades da Fase 02, com timestamps `@CreateDateColumn`/`@UpdateDateColumn`.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK (`@PrimaryColumn('uuid')`) | Identificador interno, gerado no serviço com `crypto.randomUUID()` antes do `CreateMultipartUpload`, porque a chave do objeto depende dele. É o `{videoId}` das chaves de storage e o `jobId` do job (Revision de `phase-03-videos/TD-01`). Nunca sai na API (per `phase-03-videos/TD-07`: "the uuid stays internal (foreign keys and storage keys)") |
| public_id | varchar(11) | unique, not null | Exatamente 11 caracteres do alfabeto base64url (`[A-Za-z0-9_-]{11}`), gerados de 8 bytes de `crypto.randomBytes`. Na colisão do índice único, o insert é repetido com um ID novo (Revision de `phase-03-videos/TD-07`) |
| channel_id | uuid | FK → channels.id, not null | O vídeo pertence ao canal do usuário autenticado (Revision "Upload input contract and object key" de `phase-03-videos/TD-03`). Base do acesso owner-only (per `phase-03-videos/TD-09`) |
| title | varchar(100) | not null | `title` do `POST /videos` já com trim (1–100 chars). Sem ele, o nome do arquivo sem a extensão, truncado em 100 chars (Revision de `phase-03-videos/TD-03`). A edição fica para a Fase 04 |
| original_filename | varchar(255) | not null | `file_name` declarado na iniciação (1–255 chars). Alimenta o `ResponseContentDisposition` do download (Revision "Download filename" de `phase-03-videos/TD-08`). Não sai em `GET /videos/{publicId}`, que tem lista fechada de campos (Revision de `phase-03-videos/TD-04`) |
| mime_type | varchar(50) | not null | `content_type` declarado, um de `video/mp4`, `video/quicktime`, `video/webm`, `video/x-matroska` (per `phase-03-videos/TD-03`). A validação final é do probing (per `phase-03-videos/TD-06`) |
| size_bytes | bigint | not null | `file_size` declarado, de 1 a 10,737,418,240 bytes (10 GiB), reconferido na conclusão (per `phase-03-videos/TD-03`). O driver `pg` lê `bigint` como `string`. Um `ValueTransformer` converte para `number`, e 10 GiB cabe em `Number.MAX_SAFE_INTEGER` |
| status | enum `videos_status_enum` | not null, default `'draft'`, values: `'draft'`, `'processing'`, `'ready'`, `'failed'` | Ciclo de vida único de processamento (per `phase-03-videos/TD-04`). Toda transição é um `UPDATE ... WHERE status = <origem>` condicional (ver "Ciclo de vida" abaixo) |
| processing_error | enum `videos_processing_error_enum` | nullable, values: `'UNSUPPORTED_MEDIA'`, `'PROCESSING_FAILED'`, `'UPLOAD_EXPIRED'` | Preenchido só com `status = 'failed'` (Revision "Status exposure and failure reasons" de `phase-03-videos/TD-04`) |
| upload_id | varchar(1024) | not null | `UploadId` do multipart, criado no `POST /videos` (per `phase-03-videos/TD-03`). Nunca sai na API: "storage keys and the multipart upload ID are never exposed" (Revision de `phase-03-videos/TD-04`). O nome da coluna é derivação do plano |
| upload_expires_at | timestamp | not null | `created_at` + 24 h, a janela de upload, igual a `MINIO_API_STALE_UPLOADS_EXPIRY=24h` (per `phase-03-videos/TD-03`; Revision de `phase-03-videos/TD-12`) |
| duration_seconds | double precision | nullable | Duração lida pelo ffprobe (per `phase-03-videos/TD-06`). Com `null`, o TTL de stream usa o piso de 3600 s (Revision "Video state gate" de `phase-03-videos/TD-08`) |
| metadata | jsonb | nullable | Objeto com exatamente as chaves `width`, `height`, `video_codec`, `audio_codec` (`null` sem stream de áudio), `bit_rate`, `frame_rate` e `format_name`, todas lidas do ffprobe (Revision "Metadata shape" de `phase-03-videos/TD-06`). Tipo TS: `VideoMetadata` |
| thumbnail_key | varchar(255) | nullable | `videos/{videoId}/thumbnail.jpg`, gravada pelo worker ao concluir o processamento (per `phase-03-videos/TD-06`). Com `null`, a resposta traz `thumbnail_url: null` (Revision "Thumbnail delivery" de `phase-03-videos/TD-06`). O nome da coluna é derivação do plano |
| created_at | timestamp | not null, auto-generated | `@CreateDateColumn` |
| updated_at | timestamp | not null, auto-generated | `@UpdateDateColumn` |

**Relations:** Video → Channel (many-to-one, lado dono via `channel_id`, `@JoinColumn({ name: 'channel_id' })`). Nenhum TD decide `onDelete`, e excluir canal está fora do escopo da fase. Vale o padrão do banco (`NO ACTION`).
**Indexes:** `(public_id)` unique; `(channel_id)` para a busca owner-only.

**Tipo `VideoMetadata`** (`src/videos/entities/video.entity.ts`):

| Key | TS type | Origem no ffprobe |
|-----|---------|-------------------|
| width | `number` | `streams[video].width` |
| height | `number` | `streams[video].height` |
| video_codec | `string` | `streams[video].codec_name` |
| audio_codec | `string \| null` | `streams[audio].codec_name` do primeiro stream de áudio; `null` sem áudio |
| bit_rate | `number \| null` | `format.bit_rate` (inteiro) |
| frame_rate | `number \| null` | `streams[video].avg_frame_rate` (fração `n/d` convertida; `0/0` → `null`) |
| format_name | `string` | `format.format_name` |

**Ciclo de vida (`status`)** (per `phase-03-videos/TD-04`, com as Revisions de `phase-03-videos/TD-03` e `phase-03-videos/TD-12`):

| De | Para | Gatilho | `processing_error` |
|----|------|---------|--------------------|
| — | `draft` | `POST /videos` | `null` |
| `draft` | `processing` | `POST /videos/{publicId}/upload/complete` aceito (objeto conferido) | `null` |
| `processing` | `draft` | `add()` do job falhou (`503 QUEUE_UNAVAILABLE`) | `null` |
| `draft` | `failed` | lazy expiry: leitura do dono com `upload_expires_at` vencido; ou storage sem upload e sem objeto | `UPLOAD_EXPIRED` |
| `draft` | `failed` | `HeadObject` pós-montagem diverge do `size_bytes` (objeto apagado) | `PROCESSING_FAILED` |
| `processing` | `ready` | worker concluiu probing + thumbnail | `null` |
| `processing` | `failed` | probing rejeitou a mídia (`UnrecoverableError`) | `UNSUPPORTED_MEDIA` |
| `processing` | `failed` | retries esgotadas ou job travado (evento `failed`) | `PROCESSING_FAILED` |

**Layout no storage** (per `phase-03-videos/TD-02`; Revision "MinIO image and buckets"): um bucket privado por ambiente, `streamtube` (dev) e `streamtube-test` (testes), com o prefixo `videos/{videoId}/` por vídeo. O original fica em `videos/{videoId}/original` (Revision "Upload input contract and object key" de `phase-03-videos/TD-03`), e a thumbnail em `videos/{videoId}/thumbnail.jpg` (per `phase-03-videos/TD-06`).

#### Channel (modificada)

Sem coluna nova e sem migration própria. A entidade `Channel` (`src/channels/entities/channel.entity.ts`) ganha só o lado inverso: `@OneToMany(() => Video, (video) => video.channel) videos: Video[]`.

**Relations:** Channel → Video (one-to-many, lado inverso). Continua Channel → User (one-to-one, lado dono via `user_id`).
**Indexes:** sem mudança.

### API Contracts

Regras comuns a todas as rotas do `VideosController`:

- **Autenticação:** `Authorization: Bearer <access_token>`, validado pelo `JwtAuthGuard` global herdado (`phase-02-auth/TD-02`, `phase-02-auth/TD-09`). Nenhuma rota de vídeo é `@Public()`.
- **Rate limiting:** `@SkipThrottle()` no controller (per `phase-03-videos/TD-10`). O `ThrottlerGuard` registrado como `APP_GUARD` no `AuthModule` vale para a aplicação inteira, e o `VideosController` é o primeiro opt-out (Revision de `phase-02-auth/TD-08`, ICC-1).
- **Ordem das checagens em `/videos/{publicId}…`:** (1) formato do `publicId`; malformado → `400 VALIDATION_ERROR` antes de qualquer consulta (Revision de `phase-03-videos/TD-07`); (2) dono; ID desconhecido ou de outro dono → `404 VIDEO_NOT_FOUND` em qualquer estado (per `phase-03-videos/TD-09`); (3) lazy expiry de um `draft` vencido (Revision "Retry and expiry parameters" de `phase-03-videos/TD-04`); (4) estado do vídeo.
- **Envelope de erro:** `{ statusCode, error, message }`, com o código de domínio em `error` (herdado de `phase-02-auth/TD-07`; ver `### Error Catalog`).
- **Plano de controle × plano de dados:** estas rotas só emitem URLs pré-assinadas. O PUT das partes e o GET da mídia vão direto entre cliente e storage e nunca passam pela API (Revision "Control plane and data plane split" de `phase-03-videos/TD-03`; `phase-03-videos/TD-08`).
- **Assinatura:** toda URL entregue ao cliente (partes, stream, download, thumbnail) é assinada pelo `S3Client` de assinatura, com `S3_PUBLIC_ENDPOINT`. As operações de servidor usam o `S3Client` interno, com `S3_ENDPOINT` (Revision de `phase-03-videos/TD-02`).
- **Swagger:** `@ApiTags('videos')` e `@ApiBearerAuth('access-token')` no controller. Cada operação declara `@ApiOperation`, `@ApiParam` (`publicId`, com o padrão `[A-Za-z0-9_-]{11}`), `@ApiBody` quando há corpo e um `@ApiResponse` por status, inclusive os de erro, com o schema `ApiErrorEnvelope` (Revision 2026-05-12 de `openapi-docs-nestjs/TD-01`). O `openapi.json` versionado é regenerado com `npm run openapi:export` (per `openapi-docs-nestjs/TD-02`).
- **Forma JSON das respostas de upload:** os nomes dos campos de `UploadSessionResponseDto` e de `UploadCompleteResponseDto` são derivação do plano. Os TDs fixam a semântica (partes de 64 MiB, URL por número de parte com TTL de 1 h, retomada que reassina só as partes que faltam, janela de 24 h), e o validate registrou o critério (d)+(a).

---

#### POST /videos (SI-03.11)

Faz o pré-cadastro do rascunho e inicia o multipart upload (per `phase-03-videos/TD-03`, `phase-03-videos/TD-04`). Primeiro a API gera o `id` e chama `CreateMultipartUpload` em `videos/{id}/original` com o `ContentType` declarado. Só depois persiste o vídeo como `draft`, no canal do usuário autenticado, com `public_id` novo (per `phase-03-videos/TD-07`) e `upload_expires_at` = agora + 24 h. Se o storage falhar, nenhum rascunho é persistido.

**Request headers:**
- Authorization: Bearer <access_token>
- Content-Type: application/json

**Request body** (`InitiateUploadDto`, Revision "Upload input contract and object key" de `phase-03-videos/TD-03`):
- file_name: string, required — 1–255 chars; a extensão precisa casar com `content_type` (`.mp4`→`video/mp4`, `.mov`→`video/quicktime`, `.webm`→`video/webm`, `.mkv`→`video/x-matroska`)
- file_size: integer, required — de 1 a 10737418240
- content_type: string, required — um de `video/mp4`, `video/quicktime`, `video/webm`, `video/x-matroska`
- title: string, optional — trim, depois 1–100 chars; sem ele, `file_name` sem a extensão, truncado em 100 chars

**Response 201** (`UploadSessionResponseDto`):
- public_id: string — 11 chars base64url
- title: string
- status: string — `"draft"`
- part_size: integer — `67108864` (64 MiB)
- part_count: integer — `ceil(file_size / part_size)`; 160 no limite de 10 GiB
- uploaded_parts: integer[] — `[]` na iniciação
- parts: array of `{ part_number: integer, url: string }` — uma entrada por parte, de `1` a `part_count`; `url` é um PUT de `UploadPart` pré-assinado com TTL de 3600 s
- parts_expire_at: string (ISO-8601) — agora + 3600 s
- upload_expires_at: string (ISO-8601) — fim da janela de upload de 24 h

**Error responses:**
- 400 VALIDATION_ERROR: `file_size` fora de 1..10737418240, `content_type` fora da allowlist, extensão de `file_name` que não casa com `content_type`, `title` inválido, campo obrigatório ausente ou campo desconhecido
- 401: access token ausente ou inválido (`JwtAuthGuard` herdado)
- 503 STORAGE_UNAVAILABLE: storage inacessível no `CreateMultipartUpload`

---

#### GET /videos/{publicId} (SI-03.12)

Devolve o estado do vídeo ao dono. É por aqui que o cliente descobre que o processamento terminou (Revision "Status exposure and failure reasons" de `phase-03-videos/TD-04`). Com o vídeo em `draft` e `upload_expires_at` vencido, a lazy expiry leva o vídeo a `failed`/`UPLOAD_EXPIRED` antes de responder (Revision "Retry and expiry parameters" de `phase-03-videos/TD-04`).

**Request headers:**
- Authorization: Bearer <access_token>

**Request path parameters:**
- publicId: string, required — `[A-Za-z0-9_-]{11}`

**Response 200** (`VideoResponseDto`):
- public_id: string
- title: string
- status: string — `"draft"` | `"processing"` | `"ready"` | `"failed"`
- size_bytes: integer
- mime_type: string
- duration_seconds: number | null
- metadata: object | null — `{ width, height, video_codec, audio_codec, bit_rate, frame_rate, format_name }`
- processing_error: string | null — `"UNSUPPORTED_MEDIA"` | `"PROCESSING_FAILED"` | `"UPLOAD_EXPIRED"`
- thumbnail_url: string | null — com o vídeo `ready` e `thumbnail_key` preenchida, GET pré-assinado de `videos/{videoId}/thumbnail.jpg` com TTL de 3600 s; `null` nos outros casos (Revision "Thumbnail delivery" de `phase-03-videos/TD-06`)
- created_at: string (ISO-8601)
- updated_at: string (ISO-8601)

Nunca saem `id`, `channel_id`, `original_filename`, `upload_id`, `thumbnail_key` nem chave de storage.

**Error responses:**
- 400 VALIDATION_ERROR: `publicId` malformado
- 401: access token ausente ou inválido
- 404 VIDEO_NOT_FOUND: ID desconhecido ou de outro dono

---

#### GET /videos/{publicId}/upload (SI-03.13)

Retoma o upload: devolve URLs novas só para as partes que ainda faltam, descobertas por `ListParts` no servidor (per `phase-03-videos/TD-03`). Quando o storage informa que o multipart não existe mais, o `HeadObject` de `videos/{videoId}/original` decide (Revision "Completion retry after an enqueue failure" de `phase-03-videos/TD-03`). Com o objeto já montado (`draft` deixado por um `503 QUEUE_UNAVAILABLE`), a resposta é `409 INVALID_VIDEO_STATE`. Sem objeto, `410 UPLOAD_EXPIRED`, e o vídeo vira `failed`/`UPLOAD_EXPIRED`.

**Request headers:**
- Authorization: Bearer <access_token>

**Request path parameters:**
- publicId: string, required — `[A-Za-z0-9_-]{11}`

**Response 200** (`UploadSessionResponseDto`):
- mesma forma do `201` de `POST /videos`, com `uploaded_parts` = números das partes já no storage, `parts` limitado às partes que faltam (pode ser `[]`), e `parts_expire_at` renovado (agora + 3600 s)

**Error responses:**
- 400 VALIDATION_ERROR: `publicId` malformado
- 401: access token ausente ou inválido
- 404 VIDEO_NOT_FOUND: ID desconhecido ou de outro dono
- 409 INVALID_VIDEO_STATE: o vídeo não está em `draft`, ou está em `draft` com o objeto original já montado (não há partes a reenviar)
- 410 UPLOAD_EXPIRED: `upload_expires_at` vencido (lazy expiry), ou storage sem o multipart e sem o objeto; o vídeo passa a `failed`/`UPLOAD_EXPIRED`
- 503 STORAGE_UNAVAILABLE: `ListParts` ou `HeadObject` não alcançam o storage

---

#### POST /videos/{publicId}/upload/complete (SI-03.14)

Conclui o upload, conferindo no servidor sem confiar em `ETag` vindo do cliente, e enfileira o processamento (per `phase-03-videos/TD-03`, `phase-03-videos/TD-04`, `phase-03-videos/TD-01`; DG-1). Com o vídeo em `draft`, a ordem é a das Revisions de TD-03 ("Upload input contract and object key", "Size mismatch outcome", "Completion retry after an enqueue failure"):

1. `ListParts` paginado. Se o storage não tiver mais o multipart, vai para o passo 6.
2. Pré-checagem. Partes ausentes ou não contíguas de `1` a `part_count` → `409 UPLOAD_INCOMPLETE`. Soma dos `Size` ≠ `size_bytes` → `409 UPLOAD_SIZE_MISMATCH`. Nos dois casos o vídeo continua `draft`.
3. `CompleteMultipartUpload` com as partes listadas.
4. `HeadObject`. Se `ContentLength` ≠ `size_bytes`, o objeto é apagado (`DeleteObject`), o vídeo vira `failed`/`PROCESSING_FAILED` e a resposta é `409 UPLOAD_SIZE_MISMATCH`.
5. Transição `draft → processing` e `add()` do job `process-video` com `jobId` = uuid do vídeo. Se o `add()` falhar, transição `processing → draft` e `503 QUEUE_UNAVAILABLE`.
6. Retry depois de um enqueue que falhou: com o vídeo em `draft` e sem multipart no storage, a API faz `HeadObject`. Objeto com `ContentLength` = `size_bytes` → pula a montagem e segue para o passo 5 (`202`). Objeto com outro tamanho → mesmo desfecho do passo 4. Sem objeto → `410 UPLOAD_EXPIRED`, e o vídeo vira `failed`/`UPLOAD_EXPIRED`.

Com o vídeo já em `processing`, o job é re-enfileirado com o mesmo `jobId` e a resposta é `202`. Assim a conclusão fica idempotente (Revision "Upload error contract" de `phase-03-videos/TD-03`).

**Request headers:**
- Authorization: Bearer <access_token>

**Request path parameters:**
- publicId: string, required — `[A-Za-z0-9_-]{11}`

**Request body:** nenhum.

**Response 202** (`UploadCompleteResponseDto`):
- public_id: string
- status: string — `"processing"`

**Error responses:**
- 400 VALIDATION_ERROR: `publicId` malformado
- 401: access token ausente ou inválido
- 404 VIDEO_NOT_FOUND: ID desconhecido ou de outro dono
- 409 UPLOAD_INCOMPLETE: partes ausentes ou não contíguas; o vídeo continua `draft`
- 409 UPLOAD_SIZE_MISMATCH: pré-checagem diverge (continua `draft`) ou `HeadObject` pós-montagem diverge (objeto apagado, `failed`/`PROCESSING_FAILED`)
- 409 INVALID_VIDEO_STATE: vídeo em `ready` ou `failed`
- 410 UPLOAD_EXPIRED: `upload_expires_at` vencido, ou storage sem o multipart e sem o objeto
- 503 QUEUE_UNAVAILABLE: `add()` falhou (Redis fora; `enableOfflineQueue: false`); o vídeo volta a `draft`, e o cliente repete a mesma chamada
- 503 STORAGE_UNAVAILABLE: storage inacessível

---

#### GET /videos/{publicId}/stream (SI-03.15)

Devolve uma URL de GET pré-assinada do original para reprodução inline. O storage atende `Range` com `206` (per `phase-03-videos/TD-08`). A URL não leva disposition.

**Request headers:**
- Authorization: Bearer <access_token>

**Request path parameters:**
- publicId: string, required — `[A-Za-z0-9_-]{11}`

**Response 200** (`MediaUrlResponseDto`):
- url: string — GET pré-assinado de `videos/{videoId}/original` com TTL = `clamp(2 × duration_seconds, 3600, 43200)` s; com `duration_seconds = null`, 3600 s (Revisions "Separate TTLs" e "Video state gate" de `phase-03-videos/TD-08`)
- expires_at: string (ISO-8601) — agora + TTL

**Error responses:**
- 400 VALIDATION_ERROR: `publicId` malformado
- 401: access token ausente ou inválido
- 404 VIDEO_NOT_FOUND: ID desconhecido ou de outro dono, em qualquer estado
- 409 VIDEO_NOT_READY: vídeo em `draft`, `processing` ou `failed`

---

#### GET /videos/{publicId}/download (SI-03.16)

Devolve uma URL de GET pré-assinada do original para download (per `phase-03-videos/TD-08`). A URL é assinada com `ResponseContentDisposition` = `attachment; filename="<ASCII fallback>"; filename*=UTF-8''<original_filename percent-encoded>` (Revision "Download filename" de `phase-03-videos/TD-08`). O fallback ASCII troca por `_` todo caractere fora do ASCII imprimível e remove `"` e `\` (`library-refs.md` § `@aws-sdk/s3-request-presigner`).

**Request headers:**
- Authorization: Bearer <access_token>

**Request path parameters:**
- publicId: string, required — `[A-Za-z0-9_-]{11}`

**Response 200** (`MediaUrlResponseDto`):
- url: string — GET pré-assinado de `videos/{videoId}/original` com TTL de 3600 s e `response-content-disposition`
- expires_at: string (ISO-8601) — agora + 3600 s

**Error responses:**
- 400 VALIDATION_ERROR: `publicId` malformado
- 401: access token ausente ou inválido
- 404 VIDEO_NOT_FOUND: ID desconhecido ou de outro dono, em qualquer estado
- 409 VIDEO_NOT_READY: vídeo em `draft`, `processing` ou `failed`

---

#### Validation Rules — Vídeos

| Field | Rule | Origem |
|-------|------|--------|
| file_name | `@IsString()`, `@Length(1, 255)`, extensão (sem diferenciar maiúsculas) mapeada para `content_type` pelo validador `@MatchesContentTypeExtension()` | Revision "Upload input contract and object key" de `phase-03-videos/TD-03` |
| file_size | `@IsInt()`, `@Min(1)`, `@Max(10737418240)` | `phase-03-videos/TD-03` (Recommendation + Revision) |
| content_type | `@IsIn(['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska'])` | `phase-03-videos/TD-03` |
| title | `@IsOptional()`, `@Transform` trim, `@IsString()`, `@Length(1, 100)` | Revision de `phase-03-videos/TD-03` |
| publicId (path) | `@Matches(/^[A-Za-z0-9_-]{11}$/)` em `PublicIdParamDto` | Revision de `phase-03-videos/TD-07` |

O `ValidationPipe` global (`whitelist`, `forbidNonWhitelisted`, `transform`) e o `ValidationExceptionFilter` herdados convertem as violações em `400 VALIDATION_ERROR` (`phase-02-auth/TD-06`, `phase-02-auth/TD-07`).

### Authorization Matrix

Owner-only em todas as rotas de vídeo (per `phase-03-videos/TD-09`). O dono é o usuário cujo `Channel.user_id` é igual ao `sub` do JWT. A busca é uma só, com `public_id` + `channel.user_id`: não-dono e ID inexistente caem no mesmo `404 VIDEO_NOT_FOUND`, sem revelar que o vídeo existe nem seu estado (Revision "Video state gate" de `phase-03-videos/TD-08`).

| Endpoint | Anonymous | Authenticated (não dono) | Owner | Notes |
|----------|-----------|--------------------------|-------|-------|
| POST /videos | ✗ (401) | ✓ | — | Cria no canal do próprio usuário (`channel_id` do `sub`) |
| GET /videos/{publicId} | ✗ (401) | ✗ (404 VIDEO_NOT_FOUND) | ✓ | Aplica a lazy expiry ao `draft` vencido |
| GET /videos/{publicId}/upload | ✗ (401) | ✗ (404 VIDEO_NOT_FOUND) | ✓ | Só com o vídeo em `draft` |
| POST /videos/{publicId}/upload/complete | ✗ (401) | ✗ (404 VIDEO_NOT_FOUND) | ✓ | Idempotente em `processing` |
| GET /videos/{publicId}/stream | ✗ (401) | ✗ (404 VIDEO_NOT_FOUND) | ✓ | Só com o vídeo em `ready` |
| GET /videos/{publicId}/download | ✗ (401) | ✗ (404 VIDEO_NOT_FOUND) | ✓ | Só com o vídeo em `ready` |

Nenhuma rota de vídeo passa pelo throttling (`@SkipThrottle()`, per `phase-03-videos/TD-10`). As URLs pré-assinadas não carregam o JWT: valem para quem as tiver até `expires_at`. O teto de 12 h do stream limita por quanto tempo um link copiado de um vídeo owner-only continua funcionando (Revision "Separate TTLs" de `phase-03-videos/TD-08`).

### Error Catalog

**Error response format** (herdado de `phase-02-auth/TD-07`): `{ statusCode: number, error: string, message: string }`. O campo `error` traz o código de domínio. As exceções novas estendem `DomainException` (`src/common/exceptions/domain.exception.ts`) e saem pelo `DomainExceptionFilter` global. O `401` continua vindo do `UnauthorizedException` do `JwtAuthGuard` herdado.

**Regra de retry do cliente** (Revision "Upload error contract" de `phase-03-videos/TD-03`): `409` e `410` exigem uma ação nova (reenviar partes, aguardar o processamento ou iniciar outro upload), e `503` pode ser repetido como está.

| Code | HTTP | Message | Trigger |
|------|------|---------|---------|
| VALIDATION_ERROR | 400 | _(array de mensagens de campo)_ | Corpo de `POST /videos` inválido (tamanho acima de 10 GiB, MIME ou extensão fora da allowlist, extensão que não casa com o MIME, `title` inválido), ou `publicId` fora de `[A-Za-z0-9_-]{11}` em qualquer rota (Revisions de `phase-03-videos/TD-03` e `phase-03-videos/TD-07`) |
| VIDEO_NOT_FOUND | 404 | Video not found | Qualquer rota `/videos/{publicId}…` com ID desconhecido ou de outro dono, em qualquer estado (per `phase-03-videos/TD-09`) |
| INVALID_VIDEO_STATE | 409 | Video is not in a valid state for this operation | `GET /videos/{publicId}/upload` fora de `draft`, ou em `draft` com o objeto original já montado; `POST .../upload/complete` com o vídeo em `ready` ou `failed` (Revisions de `phase-03-videos/TD-03`) |
| UPLOAD_INCOMPLETE | 409 | Upload has missing or non-contiguous parts | `POST .../upload/complete` com partes ausentes ou não contíguas de `1` a `part_count`; o vídeo continua `draft` |
| UPLOAD_SIZE_MISMATCH | 409 | Uploaded size does not match the declared size | `POST .../upload/complete` quando a soma das partes do `ListParts` diverge de `size_bytes` (continua `draft`), ou quando o `HeadObject` pós-montagem diverge (objeto apagado, `failed`/`PROCESSING_FAILED`) (Revision "Size mismatch outcome" de `phase-03-videos/TD-03`) |
| UPLOAD_EXPIRED | 410 | Upload window has expired | `GET .../upload` ou `POST .../upload/complete` com `upload_expires_at` vencido, ou com o storage sem multipart e sem objeto; o vídeo passa a `failed`/`UPLOAD_EXPIRED` |
| VIDEO_NOT_READY | 409 | Video is not ready | `GET .../stream` ou `GET .../download` com o vídeo em `draft`, `processing` ou `failed` (Revision "Video state gate" de `phase-03-videos/TD-08`) |
| QUEUE_UNAVAILABLE | 503 | Processing queue is unavailable | `POST .../upload/complete` quando o `add()` do job falha (producer com `enableOfflineQueue: false`); o vídeo volta a `draft` (Revisions de `phase-03-videos/TD-01` e `phase-03-videos/TD-03`) |
| STORAGE_UNAVAILABLE | 503 | Storage is unavailable | `POST /videos` (`CreateMultipartUpload`), `GET .../upload` (`ListParts`/`HeadObject`) ou `POST .../upload/complete` quando o storage não responde (Revisions de `phase-03-videos/TD-03`) |

**Códigos de `processing_error`** (persistidos no vídeo, não são respostas HTTP; Revision "Status exposure and failure reasons" de `phase-03-videos/TD-04`):

| Code | Gravado por | Trigger |
|------|-------------|---------|
| UNSUPPORTED_MEDIA | worker (`@OnWorkerEvent('failed')`) | Probing rejeitou o arquivo: sem stream de vídeo, container fora da allowlist ou dados que o ffprobe não reconhece. O job falha com `UnrecoverableError`, sem retry (per `phase-03-videos/TD-06`) |
| PROCESSING_FAILED | worker (`@OnWorkerEvent('failed')`) ou API | Três gatilhos: (1) as 3 tentativas do job se esgotaram; (2) o job travou (stalled), o que também dispara o evento `failed`; (3) o `HeadObject` pós-montagem divergiu na conclusão (API) |
| UPLOAD_EXPIRED | API (lazy expiry) | `draft` lido pelo dono depois de `upload_expires_at`, ou storage sem multipart e sem objeto na retomada/conclusão (per `phase-03-videos/TD-12`) |

### Events/Messages

#### process-video (fila `video-processing`)

**Payload:**

```json
{ "videoId": "<uuid>" }
```

**Queue / job:** fila `video-processing` (`VIDEO_PROCESSING_QUEUE`), job `process-video` (`PROCESS_VIDEO_JOB`), `jobId` igual ao uuid do vídeo, prefixo Redis vindo de `QUEUE_PREFIX`: `streamtube` em dev e `streamtube-test` nos testes (Revision "Queue contract names" de `phase-03-videos/TD-01`; `phase-03-videos/TD-11`).
**Producer:** `VideoProcessingProducer`, só no processo da API, registrado com `connection.enableOfflineQueue: false` para que um Redis fora do ar faça o `add()` falhar na hora (Revision de `phase-03-videos/TD-01`).
**Consumer:** `VideoProcessingConsumer` (`@Processor('video-processing')`, `extends WorkerHost`), registrado só no `WorkerModule`, que sobe pelo `src/worker/main.ts` com `NestFactory.createApplicationContext` no container `video-worker` (per `phase-03-videos/TD-05`). A concorrência padrão é 1, configurável por `VIDEO_WORKER_CONCURRENCY`.
**Trigger:** `POST /videos/{publicId}/upload/complete` aceito, depois da transição `draft → processing`. Também na repetição da conclusão com o vídeo já em `processing` (mesmo `jobId`) (per `phase-03-videos/TD-03`, `phase-03-videos/TD-04`; DG-1).
**Job options** (`defaultJobOptions` do `BullModule.forRootAsync`): `attempts: 3`, `backoff: { type: 'exponential', delay: QUEUE_BACKOFF_DELAY_MS }` (padrão 1000 ms), `removeOnComplete: true`, `removeOnFail: 1000` (Revision "Retry and expiry parameters" de `phase-03-videos/TD-04`; `library-refs.md` § `bullmq`).
**Delivery semantics:** at-least-once (per `phase-03-videos/TD-01`, `phase-03-videos/TD-04`). O `jobId` evita um job duplicado enquanto o anterior ainda está no Redis. Contra reprocessar, a garantia é a transição condicional no banco: o consumer só age com o vídeo em `processing` e grava `ready` com `WHERE status = 'processing'`.

**Processamento** (per `phase-03-videos/TD-06`):

1. Carrega o vídeo pelo `videoId`. Se ele não existir ou não estiver em `processing`, o job termina sem efeito (idempotência).
2. Assina pelo client interno (`S3_ENDPOINT`) um GET de `videos/{videoId}/original`, com TTL de 3600 s, para o ffprobe/ffmpeg lerem direto do storage, sem copiar o arquivo.
3. Faz `spawn('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', url])`. Sem stream de vídeo, com container fora da allowlist (`format_name` sem `mp4`/`mov` nem `matroska`/`webm`) ou com saída não reconhecida, o job lança `UnrecoverableError('UNSUPPORTED_MEDIA')`. Os outros erros (storage, timeout, processo morto) são relançados para o BullMQ tentar de novo.
4. Gera a thumbnail com `spawn('ffmpeg', ...)`, um frame em T = `min(10% × duration_seconds, 5 s)`, com fallback T = 0. Sai em JPEG com largura ≤ 1280 px (`scale='min(1280,iw)':-2`) e é gravada com `PutObject` em `videos/{videoId}/thumbnail.jpg`, `ContentType: image/jpeg`.
5. `UPDATE ... SET status = 'ready', duration_seconds, metadata, thumbnail_key, processing_error = NULL WHERE id = :videoId AND status = 'processing'`.

**Falha definitiva** (`@OnWorkerEvent('failed')`, per `phase-03-videos/TD-04`): o processor sempre relança. O listener do evento `failed` é o único ponto com catch-and-log sem rethrow. Quando `error instanceof UnrecoverableError` ou `job.attemptsMade >= job.opts.attempts`, ele grava `failed` com `UNSUPPORTED_MEDIA` (a mensagem do `UnrecoverableError`) ou `PROCESSING_FAILED` (os demais casos, inclusive job travado), sempre com `WHERE status = 'processing'`. Se ainda restam tentativas, não faz nada.

**Encerramento:** `app.enableShutdownHooks()` no `src/worker/main.ts`, `restart: unless-stopped` e `stop_grace_period` no serviço `video-worker`, para que o `SIGTERM` feche o worker depois do job ativo (per `phase-03-videos/TD-05`; `library-refs.md` § `bullmq` → Encerramento).

---

## Dependency Map

```
SI-03.1 (root — libs e configs)
SI-03.2 (root — FFmpeg na imagem + .env.example)
└── SI-03.3 — depends on SI-03.2 (.env legível pelo Compose)

SI-03.1 + SI-03.3
└── SI-03.4 — infra de teste (bucket e prefixo de teste)

SI-03.5 (root — refactor ALL_ENTITIES)
├── SI-03.6 — ChannelsService.findByUserId
└── SI-03.7 — entidade Video + migration
    └── SI-03.10 — contratos de vídeo (DTOs, exceções, public_id)

SI-03.1 + SI-03.4
├── SI-03.8 — StorageModule/StorageService
└── SI-03.9 — QueueModule + VideoProcessingProducer (também depends on SI-03.3)

SI-03.6 + SI-03.8 + SI-03.9 + SI-03.10
└── SI-03.11 — POST /videos (cria VideosController e VideosModule)
    └── SI-03.12 — GET /videos/{publicId}
        ├── SI-03.13 — GET /videos/{publicId}/upload
        │   └── SI-03.14 — POST /videos/{publicId}/upload/complete (também depends on SI-03.9)
        └── SI-03.15 — GET /videos/{publicId}/stream
            └── SI-03.16 — GET /videos/{publicId}/download

SI-03.7 + SI-03.8 + SI-03.9
└── SI-03.17 — runtime do worker (main.ts, WorkerModule, dist-worker)
    └── SI-03.18 — MediaProbeService (também depends on SI-03.2, SI-03.4, SI-03.8)
        └── SI-03.19 — ThumbnailService
            └── SI-03.20 — VideoProcessingConsumer
                └── SI-03.21 — serviço video-worker no Compose (também depends on SI-03.3)

SI-03.14 + SI-03.16 + SI-03.21
└── SI-03.22 — documentação
```

Linearized implementation order: SI-03.1 → SI-03.2 → SI-03.3 → SI-03.4 → SI-03.5 → SI-03.6 → SI-03.7 → SI-03.8 → SI-03.9 → SI-03.10 → SI-03.11 → SI-03.12 → SI-03.13 → SI-03.14 → SI-03.15 → SI-03.16 → SI-03.17 → SI-03.18 → SI-03.19 → SI-03.20 → SI-03.21 → SI-03.22

Paralelizáveis: SI-03.1, SI-03.2 e SI-03.5 (raízes independentes); SI-03.6 ∥ SI-03.7; SI-03.8 ∥ SI-03.9; SI-03.13 ∥ SI-03.15. Com SI-03.7, SI-03.8 e SI-03.9 prontas, o ramo do worker (SI-03.17–SI-03.21) anda em paralelo ao ramo da API (SI-03.10–SI-03.16).

---

## Deliverables

- [ ] SI-03.1 — Infra: dependências e namespaces de config `storage` e `queue`
- [ ] SI-03.2 — Infra: FFmpeg no `Dockerfile.dev` e variáveis novas no `.env.example`
- [ ] SI-03.3 — Infra: serviços `redis`, `minio` e `minio-init` no Compose
- [ ] SI-03.4 — Infra de teste: `setup-test-env.ts` nos dois configs do Jest e helpers de isolamento
- [ ] SI-03.5 — Refactor: `ALL_ENTITIES` compartilhado nas suítes
- [ ] SI-03.6 — `ChannelsService.findByUserId`
- [ ] SI-03.7 — Entidade `Video`, relação `Channel.videos` e migration `CreateVideos`
- [ ] SI-03.8 — `StorageModule` e `StorageService` (dois `S3Client`, multipart e URLs pré-assinadas)
- [ ] SI-03.9 — `QueueModule` e `VideoProcessingProducer`
- [ ] SI-03.10 — Contratos de vídeo: constantes, `public_id`, exceções e DTOs
- [ ] SI-03.11 — Endpoint POST /videos (pré-cadastro do rascunho e início do multipart)
- [ ] SI-03.12 — Endpoint GET /videos/{publicId} (status do vídeo, owner-only e lazy expiry)
- [ ] SI-03.13 — Endpoint GET /videos/{publicId}/upload (retomada do upload)
- [ ] SI-03.14 — Endpoint POST /videos/{publicId}/upload/complete (conclusão e enfileiramento)
- [ ] SI-03.15 — Endpoint GET /videos/{publicId}/stream (URL pré-assinada para streaming)
- [ ] SI-03.16 — Endpoint GET /videos/{publicId}/download (URL pré-assinada com nome original)
- [ ] SI-03.17 — Runtime do worker: `src/worker/main.ts`, `WorkerModule` e build em `dist-worker`
- [ ] SI-03.18 — `MediaProbeService`: extração de duração e metadados com `ffprobe`
- [ ] SI-03.19 — `ThumbnailService`: geração da thumbnail com `ffmpeg`
- [ ] SI-03.20 — `VideoProcessingConsumer`: job `process-video`, `UnrecoverableError` e `@OnWorkerEvent('failed')`
- [ ] SI-03.21 — Infra: serviço `video-worker` no Compose
- [ ] SI-03.22 — Documentação: CLAUDE.md, README e diagrama de arquitetura

**Phase deliverables** (de `docs/project-plan.md` → Fase 03):

- [ ] Upload de até 10GB funcional: multipart direto ao storage com partes de 64 MiB (até 160), os bytes nunca passam pela API e o limite é validado na iniciação e reconferido na conclusão
- [ ] Processamento automático do vídeo: a conclusão enfileira `process-video`, e o `video-worker` grava `duration_seconds`, `metadata` e a thumbnail e leva o vídeo a `ready`
- [ ] Streaming funcionando: URL pré-assinada que responde `Range` com `206`
- [ ] URLs únicas geradas: `public_id` de 11 caracteres base64url, único, em todas as rotas `/videos/{publicId}`

**Full test suites:**

- [ ] Unit + integration tests pass (`docker compose exec nestjs-api npm test`)
- [ ] E2E tests pass (`docker compose exec nestjs-api npm run test:e2e`), com o `video-worker` em execução para o teste de liveness
- [ ] Type/compilation check passes (`docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`docker compose exec nestjs-api npm run lint`)
- [ ] Project builds successfully (`docker compose exec nestjs-api npm run build`)
- [ ] Worker builds successfully (`docker compose exec nestjs-api npm run build:worker`)
- [ ] `openapi.json` regenerated and committed (`docker compose exec nestjs-api npm run openapi:export` yields no diff)
