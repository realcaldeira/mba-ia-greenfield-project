---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.14
target_file: test/videos-upload-complete.e2e-spec.ts
---

# POST /videos/{publicId}/upload/complete Test Plan

## Application Overview

`POST /videos/{publicId}/upload/complete` confere o upload no servidor, sem confiar em `ETag` do cliente, monta o original e publica o job `process-video` na fila `video-processing` com `jobId` igual ao uuid do vídeo. Com o vídeo em `draft`, a rota roda `ListParts`, faz a pré-checagem de partes contíguas (`409 UPLOAD_INCOMPLETE`) e da soma dos tamanhos (`409 UPLOAD_SIZE_MISMATCH`), roda `CompleteMultipartUpload` e `HeadObject`, faz a transição `draft → processing` e o `add()` do job. Se o `add()` falhar, o vídeo volta a `draft` e a resposta é `503 QUEUE_UNAVAILABLE`, e a repetição conclui pelo `HeadObject`, sem reenviar bytes. Com o vídeo já em `processing`, a conclusão é idempotente: re-enfileira com o mesmo `jobId` e responde `202`. Vídeo `ready`/`failed` dá `409 INVALID_VIDEO_STATE`, e janela vencida dá `410 UPLOAD_EXPIRED`.

## Test Scenarios

### 1. POST /videos/{publicId}/upload/complete — conclusão e enfileiramento

**Setup:** `beforeAll`: `Test.createTestingModule({ imports: [AppModule] }).compile()` → `createNestApplication()` reproduzindo o `main.ts` (`ValidationPipe` com `whitelist`, `forbidNonWhitelisted` e `transform`; `DomainExceptionFilter` + `ValidationExceptionFilter`) → `app.init()`. Bucket e prefixo `streamtube-test` e `S3_PUBLIC_ENDPOINT = S3_ENDPOINT` vêm do `src/test/setup-test-env.ts`. `queue = app.get(getQueueToken('video-processing'))`. O `WorkerModule` **não** é carregado nesta suíte, para que os jobs fiquem na fila e possam ser inspecionados; o `video-worker` de dev usa o prefixo `streamtube` e não consome o prefixo de teste. `beforeEach`: `cleanAllTables(dataSource)`, `emptyTestBucket()`, `obliterateTestQueue(queue)` e `throttlerStorage.storage.clear()`. Depois, o dono A e o outro usuário B são registrados, confirmados (spy do `MailService`, como em `test/auth.e2e-spec.ts`) e logados. As partes são enviadas com `fetch(parts[i].url, { method: 'PUT', body })`, sem header `x-amz-checksum-*`. Jobs do vídeo: `queue.getJobs(['waiting', 'delayed', 'active'])` filtrado por `id`. `afterEach`: `jest.restoreAllMocks()`. `afterAll`: `app.close()`.

#### 1.1. conclusao-monta-o-original-e-enfileira

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-05T02:54:25Z

**Steps:**
  1. POST /videos com o token de A e `{ file_name: 'duas-partes.mp4', file_size: 67109888, content_type: 'video/mp4' }` (64 MiB + 1 KiB)
    - expect: `201` com `part_count: 2`
  2. PUT de 67108864 bytes na `url` da parte 1 e de 1024 bytes na `url` da parte 2
    - expect: `200` do storage nas duas
  3. POST /videos/{publicId}/upload/complete com o token de A
    - expect: status `202` com body exatamente `{ public_id: <publicId>, status: "processing" }`
  4. Lê `id` com `SELECT id, status FROM videos WHERE public_id = $1` e inspeciona a fila
    - expect: `status = 'processing'`
    - expect: um único job do vídeo, com `name = 'process-video'`, `data = { videoId: <id> }` e `id = <id>`
  5. `app.get(StorageService).headObject('videos/<id>/original')`
    - expect: `contentLength: 67109888`
  6. GET /videos/{publicId} com o token de A
    - expect: `200` com `status: "processing"`

#### 1.2. partes-faltando-409-upload-incomplete

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-05T02:54:25Z

**Steps:**
  1. POST /videos com `file_size: 67109888` (`part_count: 2`) e PUT de 67108864 bytes só na parte 1
  2. POST /videos/{publicId}/upload/complete com o token de A
    - expect: status `409` com body `{ statusCode: 409, error: "UPLOAD_INCOMPLETE", message: "Upload has missing or non-contiguous parts" }`
  3. GET /videos/{publicId} com o token de A
    - expect: `200` com `status: "draft"`
  4. Inspeciona a fila
    - expect: nenhum job para o vídeo

#### 1.3. tamanho-divergente-recusado-pelo-storage-409-upload-incomplete

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-05T02:54:25Z

**Steps:**
  1. POST /videos com `file_size: 2048` (`part_count: 1`) e PUT de 1024 bytes na parte 1
    - expect: o storage recusa o PUT com `403`, porque a URL da parte assina `content-length: 2048`
  2. POST /videos/{publicId}/upload/complete com o token de A
    - expect: status `409` com `error: "UPLOAD_INCOMPLETE"`, porque nenhuma parte foi gravada
  3. Consulta `SELECT status, processing_error FROM videos WHERE public_id = $1`
    - expect: `draft` e `null`
  4. Inspeciona a fila
    - expect: nenhum job para o vídeo

#### 1.4. fila-indisponivel-503-e-retry-sem-reenviar-partes

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-05T02:54:25Z

**Steps:**
  1. POST /videos com `file_size: 1024` e PUT de 1024 bytes na parte 1
  2. Simula o Redis parado: `jest.spyOn(queue, 'add').mockRejectedValueOnce(new Error('Connection is closed.'))`. A instância é a mesma injetada no `VideoProcessingProducer`, e o mapeamento para `QueueUnavailableException` roda de verdade
  3. POST /videos/{publicId}/upload/complete com o token de A
    - expect: status `503` com body `{ statusCode: 503, error: "QUEUE_UNAVAILABLE", message: "Processing queue is unavailable" }`
    - expect: `SELECT status FROM videos` → `draft`, e nenhum job na fila
  4. Com o Redis "de volta" (o spy só rejeita uma vez), repete o POST /videos/{publicId}/upload/complete, sem nenhum novo PUT
    - expect: status `202` com `status: "processing"`
    - expect: um único job do vídeo na fila e `headObject('videos/<id>/original')` com `contentLength: 1024`

#### 1.5. conclusao-repetida-em-processing-idempotente

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-05T02:54:25Z

**Steps:**
  1. POST /videos com `file_size: 1024`, PUT de 1024 bytes e POST /videos/{publicId}/upload/complete
    - expect: `202` com `status: "processing"`
  2. Repete o POST /videos/{publicId}/upload/complete com o token de A
    - expect: status `202` com body `{ public_id: <publicId>, status: "processing" }`
  3. Inspeciona a fila
    - expect: exatamente um job com `id = <uuid do vídeo>`, porque o mesmo `jobId` não duplica
  4. Consulta `SELECT status FROM videos WHERE public_id = $1`
    - expect: `processing`

#### 1.6. video-ready-ou-failed-409-invalid-video-state

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-05T02:54:25Z

**Steps:**
  1. POST /videos com `file_size: 1024` e arrange `UPDATE videos SET status = 'ready' WHERE public_id = $1`
  2. POST /videos/{publicId}/upload/complete com o token de A
    - expect: status `409` com `error: "INVALID_VIDEO_STATE"`
  3. Arrange `UPDATE videos SET status = 'failed', processing_error = 'PROCESSING_FAILED'` e repete a conclusão
    - expect: status `409` com `error: "INVALID_VIDEO_STATE"`
  4. Inspeciona a fila
    - expect: nenhum job para o vídeo

#### 1.7. janela-de-upload-vencida-410

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-11-05T02:54:25Z

**Steps:**
  1. POST /videos com `file_size: 1024`, PUT de 1024 bytes e arrange `UPDATE videos SET upload_expires_at = now() - interval '1 minute' WHERE public_id = $1`
  2. POST /videos/{publicId}/upload/complete com o token de A
    - expect: status `410` com body `{ statusCode: 410, error: "UPLOAD_EXPIRED", message: "Upload window has expired" }`
  3. Consulta `SELECT status, processing_error FROM videos WHERE public_id = $1`
    - expect: `failed` e `UPLOAD_EXPIRED`, e nenhum job na fila

#### 1.8. controle-de-acesso-owner-only

**Covers AC:** #8
**Source:** auto
**Last sync:** 2026-11-05T02:54:25Z

**Steps:**
  1. POST /videos com o token de A, PUT de 1024 bytes e POST /videos/{publicId}/upload/complete sem header `Authorization` (API Contracts → 401)
    - expect: status `401`
  2. POST /videos/{publicId}/upload/complete do vídeo de A com o token de B
    - expect: status `404` com body `{ statusCode: 404, error: "VIDEO_NOT_FOUND", message: "Video not found" }`
  3. POST /videos/{publicId}/upload/complete com o token de A e um `publicId` bem formado inexistente
    - expect: status `404` com body idêntico ao do passo 2
  4. POST /videos/abc/upload/complete com o token de A (API Contracts → 400)
    - expect: status `400` com `error: "VALIDATION_ERROR"`
  5. Consulta o vídeo de A e a fila
    - expect: `status = 'draft'` e nenhum job, porque as chamadas rejeitadas não concluíram nada
