---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.13
target_file: test/videos-upload-resume.e2e-spec.ts
---

# GET /videos/{publicId}/upload Test Plan

## Application Overview

`GET /videos/{publicId}/upload` retoma um upload interrompido ou renova URLs de parte vencidas. As partes já recebidas são descobertas no storage por `ListParts`, e só as que faltam são reassinadas, com `parts_expire_at` renovado. A rota só vale para vídeo em `draft`. Fora de `draft`, ou em `draft` com o objeto original já montado (o caso de um `503 QUEUE_UNAVAILABLE` na conclusão), responde `409 INVALID_VIDEO_STATE`. Com o multipart sumido do storage e sem objeto, ou com a janela de 24 h vencida, responde `410 UPLOAD_EXPIRED`, e o vídeo passa a `failed`/`UPLOAD_EXPIRED`. A checagem de formato do `publicId` e a de dono vêm antes de tudo.

## Test Scenarios

### 1. GET /videos/{publicId}/upload — retomada do upload

**Setup:** `beforeAll`: `Test.createTestingModule({ imports: [AppModule] }).compile()` → `createNestApplication()` reproduzindo o `main.ts` (`ValidationPipe` com `whitelist`, `forbidNonWhitelisted` e `transform`; `DomainExceptionFilter` + `ValidationExceptionFilter`) → `app.init()`. Bucket e prefixo `streamtube-test` e `S3_PUBLIC_ENDPOINT = S3_ENDPOINT` vêm do `src/test/setup-test-env.ts`. `queue = app.get(getQueueToken('video-processing'))`. `beforeEach`: `cleanAllTables(dataSource)`, `emptyTestBucket()`, `obliterateTestQueue(queue)` e `throttlerStorage.storage.clear()`. Depois, o dono A e o outro usuário B são registrados, confirmados (spy do `MailService`, como em `test/auth.e2e-spec.ts`) e logados. As partes são enviadas com `fetch(parts[i].url, { method: 'PUT', body })`, sem header `x-amz-checksum-*`. O worker não é carregado nesta suíte. `afterEach`: `jest.restoreAllMocks()`. `afterAll`: `app.close()`.

#### 1.1. retomada-mostra-so-as-partes-que-faltam

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-05T02:54:25Z

**Steps:**
  1. POST /videos com o token de A e `{ file_name: 'aula.mp4', file_size: 134217728, content_type: 'video/mp4' }`
    - expect: `201` com `part_count: 2`, e o `parts_expire_at` da iniciação é guardado
  2. GET /videos/{publicId}/upload antes de qualquer PUT
    - expect: `200` com `uploaded_parts: []` e `parts` com `part_number` `1` e `2`
  3. PUT de 5 MiB na `url` da parte 1 e espera de 1,1 s
    - expect: status `200` do storage
  4. GET /videos/{publicId}/upload com o token de A
    - expect: status `200` com `uploaded_parts: [1]`
    - expect: `parts` com uma única entrada, `part_number: 2`, com `url` de host igual ao de `S3_PUBLIC_ENDPOINT`
    - expect: `parts_expire_at` posterior ao `parts_expire_at` da iniciação
    - expect: `public_id`, `part_size: 67108864`, `part_count: 2` e `status: "draft"` iguais aos da iniciação
  5. PUT de 1 KiB na `url` renovada da parte 2
    - expect: status `200`, e a URL reassinada é aceita pelo storage

#### 1.2. video-fora-de-draft-409

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-05T02:54:25Z

**Steps:**
  1. POST /videos (`file_size: 1024`) e arrange `UPDATE videos SET status = 'processing' WHERE public_id = $1`
  2. GET /videos/{publicId}/upload com o token de A
    - expect: status `409` com body `{ statusCode: 409, error: "INVALID_VIDEO_STATE", message: "Video is not in a valid state for this operation" }`
  3. Arrange `UPDATE videos SET status = 'ready'` e repete o GET
    - expect: status `409` com `error: "INVALID_VIDEO_STATE"`

#### 1.3. multipart-ja-montado-continua-draft-409

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-05T02:54:25Z

**Steps:**
  1. POST /videos com `file_size: 1024`, então `part_count: 1`, e PUT de 1024 bytes na parte 1
    - expect: `201` e depois `200` do storage
  2. Simula o Redis fora: `jest.spyOn(queue, 'add').mockRejectedValueOnce(new Error('Connection is closed.'))` e POST /videos/{publicId}/upload/complete
    - expect: `503` com `error: "QUEUE_UNAVAILABLE"`
    - expect: `SELECT status FROM videos` → `draft`, e `app.get(StorageService).headObject('videos/<id>/original')` retorna `contentLength: 1024`
  3. GET /videos/{publicId}/upload com o token de A
    - expect: status `409` com `error: "INVALID_VIDEO_STATE"`, porque não há partes a reenviar
  4. Consulta `SELECT status, processing_error FROM videos WHERE public_id = $1`
    - expect: `draft` e `null`, e o vídeo continua em `draft`

#### 1.4. multipart-abortado-sem-objeto-410

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-05T02:54:25Z

**Steps:**
  1. POST /videos (`file_size: 1024`) e leitura de `id` e `upload_id` com `SELECT id, upload_id FROM videos WHERE public_id = $1`
  2. Aborta o multipart direto no storage: `app.get(StorageService).abortMultipartUpload('videos/<id>/original', upload_id)`
  3. GET /videos/{publicId}/upload com o token de A
    - expect: status `410` com body `{ statusCode: 410, error: "UPLOAD_EXPIRED", message: "Upload window has expired" }`
  4. Consulta `SELECT status, processing_error FROM videos WHERE public_id = $1`
    - expect: `failed` e `UPLOAD_EXPIRED`
  5. GET /videos/{publicId} com o token de A
    - expect: `200` com `status: "failed"` e `processing_error: "UPLOAD_EXPIRED"`

#### 1.5. janela-de-upload-vencida-410

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-05T02:54:25Z

**Steps:**
  1. POST /videos (`file_size: 1024`) e arrange `UPDATE videos SET upload_expires_at = now() - interval '1 minute' WHERE public_id = $1`
  2. GET /videos/{publicId}/upload com o token de A
    - expect: status `410` com `error: "UPLOAD_EXPIRED"`
  3. Consulta `SELECT status, processing_error FROM videos WHERE public_id = $1`
    - expect: `failed` e `UPLOAD_EXPIRED` (lazy expiry)

#### 1.6. controle-de-acesso-owner-only

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-05T02:54:25Z

**Steps:**
  1. POST /videos com o token de A e GET /videos/{publicId}/upload sem header `Authorization` (API Contracts → 401)
    - expect: status `401`
  2. GET /videos/{publicId}/upload do vídeo de A com o token de B
    - expect: status `404` com body `{ statusCode: 404, error: "VIDEO_NOT_FOUND", message: "Video not found" }`
  3. GET /videos/{publicId}/upload com o token de A e um `publicId` bem formado inexistente
    - expect: status `404` com body idêntico ao do passo 2
  4. GET /videos/abc/upload com o token de A (API Contracts → 400)
    - expect: status `400` com `error: "VALIDATION_ERROR"`
  5. GET /videos/{publicId}/upload do vídeo de A com o token de A
    - expect: `200` com `status: "draft"`, e as chamadas de B não alteraram o vídeo
