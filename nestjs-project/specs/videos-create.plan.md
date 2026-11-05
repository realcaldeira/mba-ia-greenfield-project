---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.11
target_file: test/videos-create.e2e-spec.ts
---

# POST /videos Test Plan

## Application Overview

`POST /videos` pré-cadastra o vídeo como rascunho (`draft`) no canal do usuário autenticado e abre o multipart upload direto no storage. A API gera o uuid interno, chama `CreateMultipartUpload` em `videos/{id}/original` e só depois persiste a linha, com `public_id` de 11 caracteres base64url e `upload_expires_at` = agora + 24 h. A resposta (`UploadSessionResponseDto`) traz uma URL de `UploadPart` pré-assinada por parte de 64 MiB, e os bytes nunca passam pela API. O corpo é validado contra a allowlist de MIME, a extensão que casa com o MIME e o limite de 10 GiB. Sem `title`, o título é o nome do arquivo sem a extensão. O controller tem `@SkipThrottle()`, e storage fora do ar resulta em `503 STORAGE_UNAVAILABLE` sem nenhuma linha persistida.

## Test Scenarios

### 1. POST /videos — pré-cadastro do rascunho e início do multipart

**Setup:** `beforeAll`: `Test.createTestingModule({ imports: [AppModule] }).compile()` → `createNestApplication()` reproduzindo o `main.ts` (`ValidationPipe` com `whitelist`, `forbidNonWhitelisted` e `transform`; `DomainExceptionFilter` + `ValidationExceptionFilter`) → `app.init()`. Bucket `streamtube-test`, prefixo `streamtube-test` e `S3_PUBLIC_ENDPOINT = S3_ENDPOINT` vêm do `src/test/setup-test-env.ts`. `beforeEach`: `cleanAllTables(dataSource)`, `emptyTestBucket()` e `throttlerStorage.storage.clear()`. Depois, dois usuários, o dono A e o outro B, via `POST /auth/register` → `GET /auth/confirm-email` (token capturado pelo spy do `MailService`, como em `test/auth.e2e-spec.ts`) → `POST /auth/login`. O registro cria o canal de cada um. `afterEach`: `jest.restoreAllMocks()`. `afterAll`: `app.close()`.

#### 1.1. cria-rascunho-com-urls-de-partes

**Covers AC:** #1, #6
**Source:** auto
**Last sync:** 2026-11-05T02:54:25Z

**Steps:**
  1. POST /videos com o token de A e body `{ file_name: 'Minhas Férias.mp4', file_size: 134217728, content_type: 'video/mp4' }`
    - expect: status `201`
    - expect: body com `status: "draft"`, `title: "Minhas Férias"`, `part_size: 67108864`, `part_count: 2` e `uploaded_parts: []`
    - expect: `parts` com exatamente duas entradas, `part_number` `1` e `2`, cada uma com `url` cujo host é o de `S3_PUBLIC_ENDPOINT`
    - expect: `public_id` casa com `^[A-Za-z0-9_-]{11}$`
    - expect: `parts_expire_at` ≈ agora + 3600 s e `upload_expires_at` ≈ agora + 24 h (tolerância de 5 s), ambos em ISO-8601
    - expect: o body não tem `id`, `channel_id`, `upload_id` nem chave de storage
  2. Consulta `SELECT v.*, c.user_id FROM videos v JOIN channels c ON c.id = v.channel_id WHERE v.public_id = $1`
    - expect: uma linha com `channel_id` igual ao `Channel.id` cujo `user_id` é o `id` do usuário A
    - expect: `original_filename = 'Minhas Férias.mp4'`, `mime_type = 'video/mp4'`, `size_bytes = 134217728`, `status = 'draft'`, `processing_error = null` e `upload_id` preenchido
    - expect: `upload_expires_at - created_at` = 24 h (tolerância de 1 s)
  3. PUT direto na `url` da parte 1 (`fetch(url, { method: 'PUT', body: Buffer.alloc(1024) })`), sem header `x-amz-checksum-*`
    - expect: status `200` do storage, com `ETag`

#### 1.2. limite-de-tamanho-10-gib

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-05T02:54:25Z

**Steps:**
  1. POST /videos com o token de A e `{ file_name: 'grande.mp4', file_size: 10737418240, content_type: 'video/mp4' }`
    - expect: status `201`, com `part_count: 160` e 160 entradas em `parts`
  2. POST /videos com o mesmo body e `file_size: 10737418241`
    - expect: status `400` com `error: "VALIDATION_ERROR"` e `statusCode: 400`
  3. POST /videos com `file_size: 0`
    - expect: status `400` com `error: "VALIDATION_ERROR"`
  4. Consulta `SELECT count(*) FROM videos`
    - expect: `1`, só o vídeo do passo 1

#### 1.3. validacao-de-mime-e-extensao

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-05T02:54:25Z

**Steps:**
  1. POST /videos com `{ file_name: 'clip.mov', file_size: 1024, content_type: 'video/mp4' }`, com a extensão que não casa com o MIME
    - expect: status `400` com `error: "VALIDATION_ERROR"`
  2. POST /videos com `{ file_name: 'clip.avi', file_size: 1024, content_type: 'video/x-msvideo' }`, com o MIME fora da allowlist
    - expect: status `400` com `error: "VALIDATION_ERROR"`
  3. POST /videos sem `file_name`, e depois com um campo desconhecido `foo: 'bar'`
    - expect: status `400` com `error: "VALIDATION_ERROR"` nos dois casos (`forbidNonWhitelisted`)
  4. POST /videos com `title: '   '`
    - expect: status `400` com `error: "VALIDATION_ERROR"`, porque depois do trim o tamanho é 0
  5. POST /videos com `{ file_name: 'CLIP.MKV', file_size: 1024, content_type: 'video/x-matroska' }`
    - expect: status `201`, porque a extensão é comparada sem diferenciar maiúsculas
  6. Consulta `SELECT count(*) FROM videos`
    - expect: `1`, e nenhuma requisição rejeitada persistiu rascunho

#### 1.4. titulo-derivado-do-nome-do-arquivo

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-05T02:54:25Z

**Steps:**
  1. POST /videos sem `title`, com `file_name: 'aula.final.webm'` e `content_type: 'video/webm'`
    - expect: status `201` com `title: "aula.final"`, o nome do arquivo sem a última extensão
  2. POST /videos sem `title`, com `file_name` = 120 caracteres `'a'` + `'.mp4'`
    - expect: status `201` com `title` igual aos 100 primeiros caracteres
  3. POST /videos com `title: '  Meu vídeo  '` e `file_name: 'x.mp4'`
    - expect: status `201` com `title: "Meu vídeo"`, sem os espaços

#### 1.5. public-id-unico-sem-throttling

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-11-05T02:54:25Z

**Steps:**
  1. Onze POST /videos seguidos com o token de A, cada um com `{ file_name: 'v<n>.mp4', file_size: 1024, content_type: 'video/mp4' }`
    - expect: os onze respondem `201`, e nenhum responde `429`
    - expect: os onze `public_id` são distintos e todos casam com `^[A-Za-z0-9_-]{11}$`
  2. Consulta `SELECT count(DISTINCT public_id), count(*) FROM videos`
    - expect: `11` e `11`

#### 1.6. sem-token-401

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-05T02:54:25Z

**Steps:**
  1. POST /videos sem header `Authorization`, com um body válido
    - expect: status `401`
  2. POST /videos com `Authorization: Bearer token-invalido`
    - expect: status `401`
  3. Consulta `SELECT count(*) FROM videos`
    - expect: `0`

#### 1.7. storage-indisponivel-503

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-05T02:54:25Z

**Steps:**
  1. Simula o `minio` parado: `jest.spyOn(app.get(S3_INTERNAL_CLIENT), 'send').mockRejectedValueOnce(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))`, para que o mapeamento de erro do `StorageService` rode
  2. POST /videos com o token de A e body válido
    - expect: status `503` com body `{ statusCode: 503, error: "STORAGE_UNAVAILABLE", message: "Storage is unavailable" }`
  3. Consulta `SELECT count(*) FROM videos`
    - expect: `0`, nenhum rascunho persistido

#### 1.8. openapi-documenta-post-videos

**Covers AC:** #8
**Source:** auto
**Last sync:** 2026-11-05T02:54:25Z

**Steps:**
  1. Lê o `openapi.json` versionado (`path.join(__dirname, '..', 'openapi.json')`)
    - expect: `paths['/videos'].post.responses` tem as chaves `201`, `400`, `401` e `503`
    - expect: `paths['/videos'].post.tags` contém `videos`, e `security` contém `{ 'access-token': [] }`
