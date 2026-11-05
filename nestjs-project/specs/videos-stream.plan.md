---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.15
target_file: test/videos-stream.e2e-spec.ts
---

# GET /videos/{publicId}/stream Test Plan

## Application Overview

`GET /videos/{publicId}/stream` entrega ao dono uma URL de GET pré-assinada do original (`videos/{videoId}/original`) para reprodução inline. O player usa essa URL com requisições `Range`, e o storage responde `206` sem a API no caminho dos bytes. A URL não leva `Content-Disposition`, e o TTL acompanha a duração: `clamp(2 × duration_seconds, 3600, 43200)` s, ou 3600 s com `duration_seconds = null`. A checagem de dono vem antes da de estado. Não-dono e ID inexistente dão `404 VIDEO_NOT_FOUND` em qualquer estado, e um vídeo fora de `ready` dá `409 VIDEO_NOT_READY`. Esta suíte produz o vídeo `ready` pelo fluxo HTTP real (upload multipart por URL pré-assinada, conclusão, job na fila, worker com ffprobe/ffmpeg), conforme `phase-03-videos/TD-11`.

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
- No grupo 1, o vídeo `V_ready` vem de `uploadAndProcess(tokenA, { fileName: 'demo.mp4', contentType: 'video/mp4', buffer: mp4Fixture })` e precisa terminar `ready`.

`afterEach`: `jest.restoreAllMocks()`. `afterAll`: `workerContext.close()` e depois `app.close()`, para fechar workers, filas e conexões ioredis.

#### 1.1. fluxo-ponta-a-ponta-ate-o-stream

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-05T02:54:25Z

**Steps:**
  1. GET /videos/{publicId} de `V_ready` com o token de A
    - expect: status `200` com `status: "ready"` e `processing_error: null`
    - expect: `duration_seconds` é número entre 2,5 e 3,5
    - expect: as chaves de `metadata` são exatamente `width`, `height`, `video_codec`, `audio_codec`, `bit_rate`, `frame_rate` e `format_name`, com `width: 1920`, `height: 1080` e `audio_codec` não nulo
    - expect: `thumbnail_url` é string não nula, e `fetch(thumbnail_url)` responde `200` com `Content-Type: image/jpeg`
  2. GET /videos/{publicId}/stream com o token de A
    - expect: status `200` com `url` (host igual ao de `S3_PUBLIC_ENDPOINT`) e `expires_at` em ISO-8601
  3. GET direto na `url` com header `Range: bytes=0-1023`
    - expect: status `206`, `Content-Range: bytes 0-1023/<tamanho da fixture>` e corpo de exatamente 1024 bytes, iguais aos 1024 primeiros bytes da fixture
    - expect: a resposta não traz `Content-Disposition: attachment`
  4. GET /videos/{publicId}/download com o token de A e GET direto na `url` devolvida
    - expect: `200` da API, e o storage responde com `Content-Disposition` começando por `attachment;`, o que mostra que só a URL de download leva disposition

#### 1.2. ttl-do-stream-acompanha-a-duracao

**Covers AC:** #1, #2
**Source:** auto
**Last sync:** 2026-11-05T02:54:25Z

**Steps:**
  1. GET /videos/{publicId}/stream de `V_ready` com a duração real (~3 s)
    - expect: `expires_at` ≈ agora + 3600 s (piso), com tolerância de 5 s
  2. Arrange `UPDATE videos SET duration_seconds = 600 WHERE public_id = $1` e GET /videos/{publicId}/stream
    - expect: status `200` com `url` e `expires_at` ≈ agora + 3600 s
  3. Arrange `UPDATE videos SET duration_seconds = 7200` e GET /videos/{publicId}/stream
    - expect: `expires_at` ≈ agora + 14400 s
  4. Arrange `UPDATE videos SET duration_seconds = NULL` e GET /videos/{publicId}/stream
    - expect: `expires_at` ≈ agora + 3600 s
  5. Restaura o `duration_seconds` original de `V_ready`

#### 1.3. controle-de-acesso-em-video-ready

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-05T02:54:25Z

**Steps:**
  1. GET /videos/{publicId}/stream de `V_ready` sem header `Authorization` (API Contracts → 401)
    - expect: status `401`
  2. GET /videos/{publicId}/stream de `V_ready` com o token de B
    - expect: status `404` com body `{ statusCode: 404, error: "VIDEO_NOT_FOUND", message: "Video not found" }`, sem revelar que o vídeo está `ready`
  3. GET /videos/{publicId}/stream com o token de A e um `publicId` bem formado inexistente
    - expect: status `404` com body idêntico ao do passo 2
  4. GET /videos/abc/stream com o token de A (API Contracts → 400)
    - expect: status `400` com `error: "VALIDATION_ERROR"`

### 2. Vídeo fora de `ready`

**Setup:** o mesmo app, o mesmo worker in-process e os mesmos usuários do grupo 1, sem nova limpeza. Cada cenário cria os próprios vídeos de A e não depende de contagem global.

#### 2.1. rascunho-e-processing-409-video-not-ready

**Covers AC:** #4, #5
**Source:** auto
**Last sync:** 2026-11-05T02:54:25Z

**Steps:**
  1. POST /videos com o token de A (`{ file_name: 'rascunho.mp4', file_size: 1024, content_type: 'video/mp4' }`), sem upload
  2. GET /videos/{publicId}/stream com o token de A
    - expect: status `409` com body `{ statusCode: 409, error: "VIDEO_NOT_READY", message: "Video is not ready" }`
  3. GET /videos/{publicId}/stream com o token de B
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"`, porque o dono é checado antes do estado
  4. Arrange `UPDATE videos SET status = 'processing' WHERE public_id = $1`, sem job enfileirado, para que o worker não toque no vídeo, e GET /videos/{publicId}/stream com o token de A
    - expect: status `409` com `error: "VIDEO_NOT_READY"`

#### 2.2. arquivo-invalido-termina-em-failed-unsupported-media

**Covers AC:** #4, #5
**Source:** auto
**Last sync:** 2026-11-05T02:54:25Z

**Steps:**
  1. `uploadAndProcess(tokenA, { fileName: 'aleatorio.mp4', contentType: 'video/mp4', buffer: randomBytesFixture })`: os bytes aleatórios são declarados como `video/mp4`
    - expect: `POST /videos` → `201`, PUT das partes → `200` e `POST .../upload/complete` → `202` com `status: "processing"`
    - expect: o polling termina com `status: "failed"`
  2. GET /videos/{publicId} com o token de A
    - expect: `200` com `status: "failed"`, `processing_error: "UNSUPPORTED_MEDIA"`, `duration_seconds: null`, `metadata: null` e `thumbnail_url: null`
  3. GET /videos/{publicId}/stream com o token de A
    - expect: status `409` com `error: "VIDEO_NOT_READY"`
  4. GET /videos/{publicId}/stream com o token de B
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"`
