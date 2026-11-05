---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.12
target_file: test/videos-get.e2e-spec.ts
---

# GET /videos/{publicId} Test Plan

## Application Overview

`GET /videos/{publicId}` mostra ao dono o ciclo de vida do vídeo (`draft` → `processing` → `ready` | `failed`), e é por aqui que o cliente descobre que o processamento terminou. A rota valida o formato do `publicId` antes de qualquer consulta (`400 VALIDATION_ERROR`) e faz a busca owner-only numa consulta só. Um ID desconhecido e um vídeo de outro dono caem no mesmo `404 VIDEO_NOT_FOUND`. Um `draft` com `upload_expires_at` vencido passa por lazy expiry e vira `failed`/`UPLOAD_EXPIRED` antes da resposta. A resposta tem 11 campos fechados (`VideoResponseDto`), com `thumbnail_url` pré-assinada só com o vídeo `ready`, e nunca expõe `id`, `channel_id`, `original_filename`, `upload_id`, `thumbnail_key` nem chave de storage.

## Test Scenarios

### 1. GET /videos/{publicId} — status do vídeo, owner-only e lazy expiry

**Setup:** `beforeAll`: `Test.createTestingModule({ imports: [AppModule] }).compile()` → `createNestApplication()` reproduzindo o `main.ts` (`ValidationPipe` com `whitelist`, `forbidNonWhitelisted` e `transform`; `DomainExceptionFilter` + `ValidationExceptionFilter`) → `app.init()`. Bucket e prefixo `streamtube-test` vêm do `src/test/setup-test-env.ts`. `beforeEach`: `cleanAllTables(dataSource)`, `emptyTestBucket()` e `throttlerStorage.storage.clear()`. Depois, o dono A e o outro usuário B são registrados, confirmados (spy do `MailService`, como em `test/auth.e2e-spec.ts`) e logados. Cada cenário cria o próprio vídeo de A com `POST /videos` (`{ file_name: 'clip.mp4', file_size: 1024, content_type: 'video/mp4' }`). Os estados que dependem do worker são montados com `UPDATE videos ... WHERE public_id = $1`, e o worker não é carregado nesta suíte. `afterAll`: `app.close()`.

#### 1.1. dono-ve-rascunho-com-campos-fechados

**Covers AC:** #1, #6
**Source:** auto
**Last sync:** 2026-11-05T02:54:25Z

**Steps:**
  1. GET /videos/{publicId} com o token de A, logo depois do `POST /videos`
    - expect: status `200`
    - expect: as chaves do body são exatamente `public_id`, `title`, `status`, `size_bytes`, `mime_type`, `duration_seconds`, `metadata`, `processing_error`, `thumbnail_url`, `created_at` e `updated_at`
    - expect: `status: "draft"`, `metadata: null`, `processing_error: null`, `thumbnail_url: null`, `duration_seconds: null`, `size_bytes: 1024` (número) e `mime_type: "video/mp4"`
    - expect: `created_at` e `updated_at` em ISO-8601
    - expect: o body não tem `id`, `channel_id`, `original_filename`, `upload_id` nem `thumbnail_key`, e nenhum valor contém `videos/`

#### 1.2. ready-com-thumbnail-url-assinada

**Covers AC:** #2, #6
**Source:** auto
**Last sync:** 2026-11-05T02:54:25Z

**Steps:**
  1. Arrange: gera um JPEG com `ffmpeg -f lavfi -i testsrc=size=320x240:duration=1 -frames:v 1 -c:v mjpeg` em `os.tmpdir()`, lê o `id` interno com `SELECT id FROM videos WHERE public_id = $1` e grava o JPEG com `app.get(StorageService).putObject('videos/<id>/thumbnail.jpg', jpeg, 'image/jpeg')` no bucket de teste
  2. Arrange: `UPDATE videos SET status = 'ready', thumbnail_key = 'videos/<id>/thumbnail.jpg', duration_seconds = 3, metadata = '<7 chaves>' WHERE id = $1`
  3. GET /videos/{publicId} com o token de A
    - expect: status `200` com `status: "ready"` e `thumbnail_url` string não nula, com o host de `S3_PUBLIC_ENDPOINT`
    - expect: o body continua sem `thumbnail_key`
  4. GET direto na `thumbnail_url` (`fetch`)
    - expect: status `200` com `Content-Type: image/jpeg` e corpo começando com os bytes `FF D8`
  5. Arrange: `UPDATE videos SET status = 'processing' WHERE id = $1` e GET /videos/{publicId}
    - expect: `thumbnail_url: null`, porque a URL só sai com o vídeo `ready`

#### 1.3. lazy-expiry-do-rascunho-vencido

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-05T02:54:25Z

**Steps:**
  1. Arrange: `UPDATE videos SET upload_expires_at = now() - interval '1 minute' WHERE public_id = $1`
  2. GET /videos/{publicId} com o token de A
    - expect: status `200` com `status: "failed"` e `processing_error: "UPLOAD_EXPIRED"`
  3. Consulta `SELECT status, processing_error FROM videos WHERE public_id = $1`
    - expect: `failed` e `UPLOAD_EXPIRED` gravados na linha
  4. Repete o GET /videos/{publicId}
    - expect: `200` com o mesmo `status: "failed"` e `processing_error: "UPLOAD_EXPIRED"`

#### 1.4. controle-de-acesso-owner-only

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-05T02:54:25Z

**Steps:**
  1. GET /videos/{publicId} do vídeo de A sem header `Authorization` (Authorization Matrix → Anonymous)
    - expect: status `401`
  2. GET /videos/{publicId} do vídeo de A com o token de B
    - expect: status `404` com body `{ statusCode: 404, error: "VIDEO_NOT_FOUND", message: "Video not found" }`
  3. GET /videos/{publicId} com o token de A e um `publicId` bem formado que não existe (`generatePublicId()` ausente do banco)
    - expect: status `404` com body idêntico ao do passo 2
  4. GET /videos/{publicId} do vídeo de A com o token de A
    - expect: `200` com `status: "draft"`, e a leitura de B não alterou o vídeo

#### 1.5. public-id-malformado-400

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-05T02:54:25Z

**Steps:**
  1. GET /videos/abc com o token de A
    - expect: status `400` com `error: "VALIDATION_ERROR"`
  2. GET /videos/abcdefghijkl (12 caracteres) com o token de A
    - expect: status `400` com `error: "VALIDATION_ERROR"`
