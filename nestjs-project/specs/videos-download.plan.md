---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.16
target_file: test/videos-download.e2e-spec.ts
---

# GET /videos/{publicId}/download Test Plan

## Application Overview

`GET /videos/{publicId}/download` entrega ao dono uma URL de GET pré-assinada do original, assinada com `ResponseContentDisposition` = `attachment; filename="<fallback ASCII>"; filename*=UTF-8''<nome percent-encoded>`. Assim, o arquivo é salvo com o nome original declarado na iniciação, inclusive com caracteres não-ASCII. O TTL é fixo, 3600 s, qualquer que seja `duration_seconds`. A checagem de dono vem antes da de estado. Não-dono e ID inexistente dão `404 VIDEO_NOT_FOUND`, e um vídeo fora de `ready` dá `409 VIDEO_NOT_READY`. Esta suíte produz o vídeo `ready` pelo fluxo HTTP real (upload multipart por URL pré-assinada, conclusão, job na fila, worker com ffprobe/ffmpeg), conforme `phase-03-videos/TD-11`, e confere o contrato OpenAPI das 6 operações de vídeo.

## Test Scenarios

### 1. Vídeo `ready` produzido pelo fluxo real

**Setup:** `beforeAll` do arquivo, com timeout de 120 s:
- Fail-fast se `ffprobe -version` não estiver disponível (a imagem precisa ser reconstruída com FFmpeg).
- API: `Test.createTestingModule({ imports: [AppModule] }).compile()` → `createNestApplication()` reproduzindo o `main.ts` (`ValidationPipe` com `whitelist`, `forbidNonWhitelisted` e `transform`; `DomainExceptionFilter` + `ValidationExceptionFilter`) → `app.init()`.
- Worker in-process: `workerContext = await Test.createTestingModule({ imports: [WorkerModule] }).compile()` + `await workerContext.init()`. É um contexto sem HTTP no mesmo processo Jest, com o mesmo `QUEUE_PREFIX=streamtube-test`, o mesmo bucket `streamtube-test` e o mesmo banco forçados pelo `src/test/setup-test-env.ts` (`QUEUE_BACKOFF_DELAY_MS=10`). Assim, o processamento roda o código atual e o `video-worker` de dev não consome os jobs.
- Limpeza única: `cleanAllTables(dataSource)`, `emptyTestBucket()`, `obliterateTestQueue(app.get(getQueueToken('video-processing')))` e `throttlerStorage.storage.clear()`.
- Fixtures geradas por `src/test/media-fixtures.ts` com `ffmpeg -f lavfi` em `os.tmpdir()`: o MP4 faststart de 3 s (`testsrc` 1920x1080 + `sine`) e o arquivo de bytes aleatórios.
- Usuários: o dono A e o outro B, via `POST /auth/register` → `GET /auth/confirm-email` (spy do `MailService`, como em `test/auth.e2e-spec.ts`) → `POST /auth/login`.
- Helper `uploadAndProcess(token, { fileName, contentType, buffer })`:
  1. `POST /videos` com `file_size = buffer.length` → `201`.
  2. Fatia o buffer em `part_size` e faz `fetch(parts[i].url, { method: 'PUT', body })`, sem header `x-amz-checksum-*`, → `200` em cada parte.
  3. `POST /videos/{publicId}/upload/complete` → `202` com `status: "processing"`.
  4. Polling de `GET /videos/{publicId}` a cada 500 ms, até `status` ∈ {`ready`, `failed`} ou 60 s (estouro falha o teste).
- No grupo 1, o vídeo `V_ready` vem de `uploadAndProcess(tokenA, { fileName: 'Férias 2026.mp4', contentType: 'video/mp4', buffer: mp4Fixture })` e precisa terminar `ready`.

`afterEach`: `jest.restoreAllMocks()`. `afterAll`: `workerContext.close()` e depois `app.close()`, para fechar workers, filas e conexões ioredis.

#### 1.1. fluxo-ponta-a-ponta-ate-o-download

**Covers AC:** #1, #2
**Source:** auto
**Last sync:** 2026-11-05T02:54:25Z

**Steps:**
  1. GET /videos/{publicId} de `V_ready` com o token de A
    - expect: status `200` com `status: "ready"`, `title: "Férias 2026"` e `processing_error: null`
    - expect: `duration_seconds` é número entre 2,5 e 3,5
    - expect: as chaves de `metadata` são exatamente `width`, `height`, `video_codec`, `audio_codec`, `bit_rate`, `frame_rate` e `format_name`, com `width: 1920` e `height: 1080`
    - expect: `thumbnail_url` é string não nula, e `fetch(thumbnail_url)` responde `200` com `Content-Type: image/jpeg`
  2. GET /videos/{publicId}/stream com o token de A e GET direto na `url` com `Range: bytes=0-1023`
    - expect: `200` da API e `206` do storage, com 1024 bytes
  3. GET /videos/{publicId}/download com o token de A
    - expect: status `200` com `url` (host igual ao de `S3_PUBLIC_ENDPOINT`) e `expires_at` ≈ agora + 3600 s, com tolerância de 5 s
  4. GET direto na `url` de download (`fetch`)
    - expect: status `200` com `Content-Disposition: attachment; filename="F_rias 2026.mp4"; filename*=UTF-8''F%C3%A9rias%202026.mp4`, exatamente
    - expect: `Content-Length` igual ao tamanho da fixture, e o SHA-256 do corpo igual ao da fixture

#### 1.2. ttl-do-download-independe-da-duracao

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-05T02:54:25Z

**Steps:**
  1. Arrange `UPDATE videos SET duration_seconds = 7200 WHERE public_id = $1` e GET /videos/{publicId}/download com o token de A
    - expect: status `200` com `expires_at` ≈ agora + 3600 s, não 14400 s
  2. Arrange `UPDATE videos SET duration_seconds = NULL` e GET /videos/{publicId}/download
    - expect: `expires_at` ≈ agora + 3600 s
  3. Restaura o `duration_seconds` original de `V_ready`

#### 1.3. controle-de-acesso-em-video-ready

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-05T02:54:25Z

**Steps:**
  1. GET /videos/{publicId}/download de `V_ready` sem header `Authorization` (API Contracts → 401)
    - expect: status `401`
  2. GET /videos/{publicId}/download de `V_ready` com o token de B
    - expect: status `404` com body `{ statusCode: 404, error: "VIDEO_NOT_FOUND", message: "Video not found" }`
  3. GET /videos/{publicId}/download com o token de A e um `publicId` bem formado inexistente
    - expect: status `404` com body idêntico ao do passo 2
  4. GET /videos/abc/download com o token de A (API Contracts → 400)
    - expect: status `400` com `error: "VALIDATION_ERROR"`

### 2. Vídeo fora de `ready`

**Setup:** o mesmo app, o mesmo worker in-process e os mesmos usuários do grupo 1, sem nova limpeza. Cada cenário cria os próprios vídeos de A e não depende de contagem global.

#### 2.1. rascunho-e-processing-409-video-not-ready

**Covers AC:** #3, #4
**Source:** auto
**Last sync:** 2026-11-05T02:54:25Z

**Steps:**
  1. POST /videos com o token de A (`{ file_name: 'rascunho.mp4', file_size: 1024, content_type: 'video/mp4' }`), sem upload
  2. GET /videos/{publicId}/download com o token de A
    - expect: status `409` com body `{ statusCode: 409, error: "VIDEO_NOT_READY", message: "Video is not ready" }`
  3. GET /videos/{publicId}/download com o token de B
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"`, porque o dono é checado antes do estado
  4. Arrange `UPDATE videos SET status = 'processing' WHERE public_id = $1`, sem job enfileirado, e GET /videos/{publicId}/download com o token de A
    - expect: status `409` com `error: "VIDEO_NOT_READY"`

#### 2.2. arquivo-invalido-termina-em-failed-unsupported-media

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-05T02:54:25Z

**Steps:**
  1. `uploadAndProcess(tokenA, { fileName: 'aleatorio.mp4', contentType: 'video/mp4', buffer: randomBytesFixture })`: os bytes aleatórios são declarados como `video/mp4`
    - expect: `POST /videos` → `201`, PUT das partes → `200` e `POST .../upload/complete` → `202` com `status: "processing"`
    - expect: o polling termina com `status: "failed"`
  2. GET /videos/{publicId} com o token de A
    - expect: `200` com `status: "failed"`, `processing_error: "UNSUPPORTED_MEDIA"`, `metadata: null` e `thumbnail_url: null`
  3. GET /videos/{publicId}/download com o token de A
    - expect: status `409` com `error: "VIDEO_NOT_READY"`

### 3. Contrato OpenAPI das rotas de vídeo

**Setup:** nenhum além da leitura do `openapi.json` versionado (`path.join(__dirname, '..', 'openapi.json')`).

#### 3.1. openapi-tem-as-seis-operacoes-de-video

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-05T02:54:25Z

**Steps:**
  1. Lê o `openapi.json` e coleta as operações cujo `tags` contém `videos`
    - expect: exatamente 6 operações: `POST /videos`, `GET /videos/{publicId}`, `GET /videos/{publicId}/upload`, `POST /videos/{publicId}/upload/complete`, `GET /videos/{publicId}/stream` e `GET /videos/{publicId}/download`
    - expect: cada uma tem `security` contendo `{ 'access-token': [] }`
    - expect: `GET /videos/{publicId}/download` documenta as respostas `200`, `400`, `401`, `404` e `409`
