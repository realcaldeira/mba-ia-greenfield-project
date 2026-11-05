---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-11-04
scope_description: "Backend foundation for video upload and processing: background job queue, S3-compatible object storage usage, direct multipart upload up to 10 GB, draft pre-registration and status lifecycle, FFmpeg worker runtime, metadata/thumbnail extraction, unique video URL, streaming/download delivery, access control, rate limiting, test strategy with real infrastructure, and storage growth policy."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that delivers the videos module (upload orchestration, status, streaming/download URLs), the new infrastructure in `nestjs-project/compose.yaml` (object storage, queue broker, video worker) and the FFmpeg-based worker.
- `next-frontend/` — Frontend deferred: the video player, upload UI and watch page belong to later phases (Fase 05 — "Player de vídeo com controles", "Botão de download do vídeo"); this phase is backend-only. Cross-layer TDs below (TD-03, TD-08) define the HTTP contract the future frontend will consume; no frontend implementation is decided here.

---

## TD-01: Background Job Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The architecture diagram (`docs/diagrams/software-arch.mermaid`) and `CLAUDE.md` list the Message Queue as "TBD". After an upload completes, the API must hand the heavy FFmpeg work to a separate worker without blocking the request, with retries for transient failures. The choice adds (or not) a new service to `compose.yaml`, a client library to `nestjs-project/package.json`, and fixes the producer/consumer programming model used by the worker (TD-05) and the failure policy (TD-04).

**Options:**

### Option A: BullMQ + Redis (`@nestjs/bullmq`)
- Redis-backed job queue with first-party NestJS integration (`BullModule.forRootAsync`, `registerQueue`, `@InjectQueue`, `WorkerHost` + `@OnWorkerEvent`). `@nestjs/bullmq@^12` declares peer support for `@nestjs/core ^11` and `bullmq ^6`.
- **Pros:** Retries with exponential backoff, `UnrecoverableError` to fail without retry, custom `jobId` deduplication ("the job will be ignored if the ID already exists"), stalled-job detection, per-worker concurrency — all built in. Already the example used by the project's own `micro-use-queues.md` and testing guide. Redis is a small container.
- **Cons:** Adds Redis as a new stateful dependency (needs `maxmemory-policy noeviction` and persistence). Jobs live outside PostgreSQL, so enqueue and DB update are not in one transaction.

### Option B: RabbitMQ (AMQP)
- Message broker with queues/exchanges; NestJS via `@nestjs/microservices` RMQ transport or `@golevelup/nestjs-rabbitmq`.
- **Pros:** Mature broker, language-agnostic consumers, strong delivery guarantees with acks, management UI.
- **Cons:** No built-in delayed retry/backoff — needs dead-letter exchanges and TTL queues configured by hand. Heavier container. The NestJS microservices transport has no job state, progress or deduplication; job-level semantics must be rebuilt.

### Option C: pg-boss (PostgreSQL-backed queue)
- Job queue stored in PostgreSQL tables, using `SKIP LOCKED`.
- **Pros:** No new infrastructure; enqueue can share a transaction with the video status update (transactional outbox for free).
- **Cons:** No first-party NestJS module. Adds polling load to the main database. Does not add a distinct queue service to the Compose stack, which the target architecture models as a separate container.

### Option D: AWS SQS (ElasticMQ locally)
- Managed queue in production, emulated locally by ElasticMQ.
- **Pros:** Zero-ops in AWS, pairs naturally with S3 in production.
- **Cons:** Visibility-timeout semantics and retries via redrive policies only; no job state API. Local emulation diverges from production; adds AWS-specific coupling the project does not have yet.

**Recommendation:** **Option A (BullMQ + Redis)** — It is the only option with first-party NestJS support and native retries, backoff, unrecoverable errors and `jobId` deduplication, which TD-04 relies on; the project's own best-practices skill and testing guide already assume it. The transactional gap is handled by an idempotent completion endpoint that re-enqueues with the same `jobId` (TD-03/TD-04) instead of an outbox table.

**Decision:** A (BullMQ + Redis)
**Libraries:** @nestjs/bullmq@^12.0.0, bullmq@^6.4.0

**Revisions:**
- 2026-11-04 — Queue contract names: queue `video-processing`, job name `process-video`, payload `{ "videoId": "<uuid>" }` and `jobId` equal to the video's uuid (BullMQ rejects IDs containing `:` or purely numeric), with Redis key prefix from `QUEUE_PREFIX` (`streamtube` in dev, `streamtube-test` in tests per TD-11); the producer connection sets `enableOfflineQueue: false` so a Redis outage fails `add()` immediately. Rationale: the queue, job and ID names are shared by the API producer, the worker consumer and the tests, so they are fixed here as one contract.

---

## TD-02: Object Storage Access, Bucket and Key Layout

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The storage service itself is given (S3-compatible: MinIO locally, S3 in production). What must be decided is how the backend talks to it and how objects are organized, because the same layout is used by the API (presigning), the worker (reading originals, writing thumbnails), `compose.yaml` (bucket bootstrap) and the env schema. Two facts constrain the choice: (1) the official `minio/minio` and `minio/mc` images were removed from Docker Hub in September 2026 and the upstream repository is archived, so the local image must come from a pinned community build (`pgsty/minio:RELEASE.2026-08-04T00-00-00Z`, which bundles `mc` and `curl`); (2) AWS SDK for JavaScript v3 ≥ 3.729 adds CRC32 checksums to PUT requests and presigned URLs by default, which S3-compatible servers reject unless the client sets `requestChecksumCalculation`/`responseChecksumValidation` to `WHEN_REQUIRED`.

**Options:**

### Option A: AWS SDK v3 + single private bucket with per-video prefixes
- `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` with `forcePathStyle: true` and checksum mode `WHEN_REQUIRED`. One private bucket per environment; keys `videos/{videoId}/original` and `videos/{videoId}/thumbnail.jpg`. Two clients: an internal one (`S3_ENDPOINT`, e.g. `http://minio:9000`) for server operations and a signing one (`S3_PUBLIC_ENDPOINT`) that produces URLs reachable by the client (SigV4 signs the `host`, so the host cannot be rewritten after signing).
- **Pros:** Same SDK and code path for MinIO and S3 (production swap is config only). Per-video prefix keeps all objects of a video together (easy deletion and accounting). Private bucket + presigned URLs keeps access control in the API.
- **Cons:** Two client instances to configure. The checksum default must be overridden explicitly.

### Option B: MinIO JavaScript SDK (`minio` package)
- MinIO's own client, which also speaks S3.
- **Pros:** Simple API for presigned PUT/GET; bucket helpers.
- **Cons:** Production target is AWS S3, so the code would depend on a vendor SDK for the wrong vendor; the SDK's upstream is tied to a project whose community edition is archived. Multipart presign per part is less ergonomic than the AWS commands.

### Option C: AWS SDK v3 + one bucket per asset type
- Same SDK as A, but separate buckets for originals and thumbnails.
- **Pros:** Different lifecycle or public-read policies per bucket become possible (e.g., a CDN-backed thumbnails bucket).
- **Cons:** Doubles bucket bootstrap and env keys now for a benefit that only matters once thumbnails are public (Fase 05+). Thumbnails are not public in this phase (TD-09).

**Recommendation:** **Option A (AWS SDK v3 + single private bucket with per-video prefixes)** — It keeps MinIO→S3 a configuration change, matches the "S3 or MinIO" container in the target architecture, and the per-video prefix makes cleanup and storage accounting (TD-12) straightforward; buckets are created by a one-shot `minio-init` Compose service using the bundled `mc`.

**Decision:** A (AWS SDK v3 + single private bucket with per-video prefixes)
**Libraries:** @aws-sdk/client-s3@^3.1154.0, @aws-sdk/s3-request-presigner@^3.1154.0

**Revisions:**
- 2026-11-04 — Storage config (`registerAs` + Joi) carries two endpoints: `S3_ENDPOINT` (internal, `http://minio:9000`) is used by the API and the worker for every server-side operation, including signing the internal URLs the worker hands to FFmpeg (TD-06), and `S3_PUBLIC_ENDPOINT` is used only by a second `S3Client` that signs the URLs delivered to the client (TD-03 part URLs, TD-08 stream and download URLs); in the dev Compose and in tests `S3_PUBLIC_ENDPOINT` = `http://minio:9000` (reachable from inside the containers), and for a client running on the host the value is overridden to `http://localhost:9000`. Rationale: SigV4 signs the `host`, so a presigned URL is valid only for the host its client was configured with and cannot be rewritten after signing; a dedicated signing client keeps server traffic on the Compose network while the client-facing URLs carry a host the client can reach.
- 2026-11-04 — MinIO image and buckets: the `minio` and `minio-init` Compose services use `pgsty/minio:RELEASE.2026-08-04T00-00-00Z` (bundles `mc` and `curl`; the official `minio/minio` and `minio/mc` images were removed from Docker Hub in September 2026); `minio` is health-checked with `curl -f http://localhost:9000/minio/health/live`; `minio-init` is a one-shot service that creates the dev bucket `streamtube` and the test bucket `streamtube-test` with `mc mb --ignore-existing`, and the services that use the storage depend on it with `condition: service_completed_successfully`. Rationale: pinning a community build that is still pullable keeps the stack reproducible, and creating both buckets in Compose makes dev and tests start from the same known state.

---

## TD-03: Large Video Upload Protocol (up to 10 GB)

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** A 10 GB upload must not tie up the API ("sem impacto na performance") and, per the project plan's attention points, must "permita retomar em caso de falha de conexão". S3 limits matter: a single PUT is capped at 5 GB; multipart parts range from 5 MiB to 5 GiB, at most 10,000 parts. The protocol is cross-layer: the backend defines the handshake (initiate → upload parts → complete) and the future frontend implements the client side. Depends on TD-02 (storage access) and feeds TD-04 (draft is created at initiation).

**Options:**

### Option A: S3 multipart upload with presigned part URLs (client → storage directly)
- `POST /videos` creates the draft and the multipart upload and returns presigned `UploadPart` URLs; the client PUTs each part straight to the storage; `POST …/upload/complete` makes the server list the parts (no client-supplied ETags), check contiguity and total size, complete the upload and enqueue processing. A resume endpoint re-lists uploaded parts and re-signs only the missing ones.
- **Pros:** Video bytes never pass through the API process — CPU, memory and connections stay free. Native resumability per part. Works identically on MinIO and S3.
- **Cons:** More steps for the client; the browser client needs storage CORS exposing `ETag` (not needed here since the server lists parts). Abandoned uploads leave parts until the storage expires them (TD-12).

### Option B: tus resumable upload protocol served by the API
- A tus server (`@tus/server` + `@tus/s3-store`) mounted in NestJS receives PATCH chunks and streams them to S3.
- **Pros:** Standardized resumable protocol with mature clients (tus-js-client, Uppy).
- **Cons:** All 10 GB flow through the API process (network and event loop pressure on the same process that serves the REST API). Extra library with its own HTTP layer outside Nest's controllers, guards and filters.

### Option C: Chunked upload through the API streaming to storage
- Client sends chunks to a Nest endpoint (busboy/multer streaming), which pipes each chunk to an S3 multipart part.
- **Pros:** Single endpoint for the client; the API sees every byte (could validate on the fly).
- **Cons:** Same throughput problem as B; resumability must be hand-rolled; API instances must scale with upload bandwidth.

**Recommendation:** **Option A (S3 multipart with presigned part URLs)** — It is the only option where the API never carries the video bytes, which is the literal requirement, and resumability comes from the storage itself; parameters: maximum size 10 GiB = 10,737,418,240 bytes (product constant, validated at initiation and re-checked with `HeadObject` at completion), part size 64 MiB (160 parts at the limit), part URL TTL 1 h, upload window 24 h (aligned with MinIO's stale-upload expiry), declared MIME allowlist `video/mp4`, `video/quicktime`, `video/webm`, `video/x-matroska` (final validation by ffprobe, TD-06), completion idempotent.

**Decision:** A (S3 multipart with presigned part URLs)

**Revisions:**
- 2026-11-04 — Control plane and data plane split: the control calls (initiate upload, resume, complete, request stream/download URLs) go through the API and, once the frontend lands, through the BFF Route Handlers under `app/api/**`, per `phase-02-auth-frontend/TD-05`; the data plane (part PUTs and media GETs on presigned URLs) goes directly between browser and storage, never through the BFF; the bucket CORS (frontend origin, `PUT`/`GET` methods; no `ETag` exposure, since completion lists the parts server-side) is configured in the phase that brings `next-frontend`. Rationale: keeping the video bytes out of the servers (API and BFF) is the premise of this TD and of TD-08, and relaying up to 10 GiB through a Route Handler would void it; every state-changing call still crosses `app/api/**`, so the inherited strict-BFF precedent holds for the control plane, and the exception is limited to byte transfer authorized by a URL the API signed.
- 2026-11-04 — Upload error contract (envelope of `phase-02-auth/TD-07`): `POST /videos` → `400 VALIDATION_ERROR` (declared size above 10 GiB, MIME/extension outside the allowlist, invalid title) and `503 STORAGE_UNAVAILABLE` (storage unreachable); `GET /videos/{publicId}/upload` → `409 INVALID_VIDEO_STATE` when the video is not `draft` and `410 UPLOAD_EXPIRED` when `upload_expires_at` has passed or the storage reports the upload gone (the video becomes `failed`); `POST /videos/{publicId}/upload/complete` → `202` with `status: processing` (also when it was already `processing`, re-enqueuing with the same `jobId`), `409 UPLOAD_INCOMPLETE` (missing or non-contiguous parts), `409 UPLOAD_SIZE_MISMATCH` (assembled size differs from the declared size), `409 INVALID_VIDEO_STATE` (`ready` or `failed`), `410 UPLOAD_EXPIRED`, `503 QUEUE_UNAVAILABLE` (enqueue failed; the status returns to `draft` so the client can retry) and `503 STORAGE_UNAVAILABLE`; every video route answers `404 VIDEO_NOT_FOUND` for unknown or non-owned IDs (TD-09) and `400 VALIDATION_ERROR` for a malformed `publicId`. Rationale: the protocol has several client-visible failure points; fixing their codes here gives the plan an Error Catalog traceable to a TD and gives the client a retry rule per code (409/410 need a new action, 503 can be retried as-is).
- 2026-11-04 — Upload input contract and object key: `POST /videos` takes `file_name` (1–255 chars; extension must match the declared MIME: `.mp4`→`video/mp4`, `.mov`→`video/quicktime`, `.webm`→`video/webm`, `.mkv`→`video/x-matroska`), `file_size` (integer, 1 to 10,737,418,240 bytes), `content_type` (one of those four MIME types) and an optional `title` (trimmed, 1–100 chars); without `title` the draft takes the file name without its extension, truncated to 100 chars; the video belongs to the authenticated user's channel (`channel_id`); the original object key is `videos/{videoId}/original`; completion compares the sizes reported by `ListParts` with the declared size **before** `CompleteMultipartUpload`, so `409 UPLOAD_SIZE_MISMATCH` and `409 UPLOAD_INCOMPLETE` leave the video in `draft` (the client re-uploads the offending parts within the window), and the post-completion `HeadObject` check marks the video `failed` with `PROCESSING_FAILED` if the assembled object still disagrees; `GET /videos/{publicId}/upload` also answers `503 STORAGE_UNAVAILABLE` when `ListParts` cannot reach the storage. Rationale: the plan needs the exact request fields, limits and key to be traceable, and validating sizes before assembling keeps a wrong part recoverable instead of producing a corrupt original.
- 2026-11-04 — Size mismatch outcome: `POST /videos/{publicId}/upload/complete` answers `409 UPLOAD_SIZE_MISMATCH` in both size checks; when the pre-completion check (`ListParts` sizes vs declared size) fails, the video stays `draft` and the client re-uploads the offending parts within the upload window; when the post-completion `HeadObject` check fails, the assembled object is deleted, the video becomes `failed` with `processing_error` `PROCESSING_FAILED`, and the client must start a new upload. Rationale: one error code keeps the client contract simple, while the video `status` returned by `GET /videos/{publicId}` tells the owner whether the same upload can still be fixed.
- 2026-11-04 — Completion retry after an enqueue failure: when `POST /videos/{publicId}/upload/complete` finds the video in `draft` but the storage no longer has the multipart upload (it was already assembled before a `503 QUEUE_UNAVAILABLE`), it checks the object with `HeadObject`: if the object exists with the declared size, it skips assembling, moves the video to `processing`, enqueues and answers `202`; if there is no object, it answers `410 UPLOAD_EXPIRED` and the video becomes `failed`. In that same state `GET /videos/{publicId}/upload` answers `409 INVALID_VIDEO_STATE`, because there are no parts left to upload. Rationale: a retry after a queue outage must succeed without re-uploading bytes that are already stored, which is what makes `503 QUEUE_UNAVAILABLE` safely retryable.
- 2026-11-05 — Part length bound to the signature: each part URL is signed with `ContentLength` equal to the exact part length (`part_size` for every part but the last, the remainder for the last) and `content-length` as a signed header, so the storage answers `403` to a body of any other size. Rationale: without it a client holding the URLs could store up to the storage's per-part limit on each of them, far beyond the declared `file_size`, until the 24 h stale-upload expiry (TD-12); the completion pre-check (`UPLOAD_SIZE_MISMATCH`) stays as defence in depth. A per-user limit on concurrent drafts is left for a later phase.

---

## TD-04: Video Status Lifecycle and Processing Failure Policy

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** The video is pre-registered as a draft when the upload starts and must reach a terminal state after processing. The status column is read by the API (what the owner may do next), written by the API (completion) and by the worker (result), and drives the retry policy of the queue (TD-01). Fase 04 introduces "fluxo de rascunho e publicação"; this phase's status must not collide with it.

**Options:**

### Option A: Single processing-lifecycle enum with bounded retries
- `status` enum `draft → processing → ready | failed`, plus `processing_error`. The API moves `draft → processing` on completion (conditional update); the worker moves `processing → ready` or `→ failed`. Transient errors are retried (3 attempts, exponential backoff); invalid media throws `UnrecoverableError` and fails at once; the final `failed` state is written from the worker's `failed` event (also fired for stalled jobs). An expired draft (upload window passed) becomes `failed` lazily when touched.
- **Pros:** One column, easy to query; every state is reachable and terminal states are explicit; publication (Fase 04) can be added as a separate axis (`visibility`, `published_at`) without renaming states.
- **Cons:** "draft" here means "upload not finished", which must be documented to avoid confusion with Fase 04's editorial draft.

### Option B: Two columns — `upload_status` and `processing_status`
- Independent state machines for the upload and for processing.
- **Pros:** Each axis is precise; no overloaded "draft".
- **Cons:** Invalid combinations become representable (e.g., processing `ready` with upload `pending`); more conditions in every query; the challenge expects a single "rascunho → processando → pronto/erro" cycle.

### Option C: Status column + processing attempts table
- Option A's enum plus a `video_processing_attempts` table recording each attempt and error.
- **Pros:** Full audit trail of failures.
- **Cons:** Duplicates what BullMQ already keeps for failed jobs; an extra table and migration with no consumer in this phase.

**Recommendation:** **Option A (single enum with bounded retries)** — It matches the required cycle one-to-one, keeps the state in the database as the source of truth, and leaves publication as an orthogonal Fase 04 concern; the job processor always rethrows so BullMQ can retry — the "catch and log without rethrow" allowance for background tasks applies only to the `failed` event handler.

**Decision:** A (Single processing-lifecycle enum with bounded retries)

**Revisions:**
- 2026-11-04 — Status exposure and failure reasons: the owner reads the lifecycle through `GET /videos/{publicId}` (`public_id`, `title`, `status`, `size_bytes`, `mime_type`, `duration_seconds`, `metadata`, `processing_error`, `thumbnail_url`, `created_at`, `updated_at`; storage keys and the multipart upload ID are never exposed), which is how a client learns that processing finished; `processing_error` holds a domain code — `UNSUPPORTED_MEDIA` (probing rejected the file: no video stream or container outside the allowlist), `PROCESSING_FAILED` (retries exhausted or job stalled) or `UPLOAD_EXPIRED` (draft past its upload window). Rationale: the status cycle must be observable by the owner to be useful, and a short code set lets the future frontend explain failures without parsing log text.
- 2026-11-04 — Retry and expiry parameters: processing jobs use `attempts: 3` with exponential backoff and a base delay of 1000 ms (configurable through env so tests can use a small value); the lazy expiry of TD-12 runs on every owner read of a `draft` (`GET /videos/{publicId}` and the upload routes), turning a draft past `upload_expires_at` into `failed` with `UPLOAD_EXPIRED` before answering. Rationale: fixing the numbers and the places where expiry is evaluated makes the lifecycle deterministic and testable.

---

## TD-05: Video Worker Runtime

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** The target architecture has a "Video Worker (FFmpeg)" container separate from the API. The decision fixes where the consumer code lives, how it is started in Compose, and how it shares entities, config and storage code with the API.

**Options:**

### Option A: Same NestJS codebase, separate entrypoint and container
- `src/worker/main.ts` boots `NestFactory.createApplicationContext(WorkerModule)` (no HTTP server); a `video-worker` Compose service runs it from the same image as the API, which gains the `ffmpeg` package. The worker compiles to its own output directory so its watch process never deletes the API's `dist/` (`deleteOutDir: true`).
- **Pros:** Reuses entities, config modules, storage service and conventions without a shared package; isolates CPU-heavy FFmpeg work from the API process; scales independently.
- **Cons:** The image carries FFmpeg for both services; the worker starts automatically with Compose, an explicit exception to the "never start the app" rule in `nestjs-project/CLAUDE.md`.

### Option B: Worker inside the API process
- Register the BullMQ processor in `AppModule`; the API process also consumes jobs.
- **Pros:** No extra container or entrypoint.
- **Cons:** FFmpeg runs alongside HTTP traffic — the opposite of "sem impacto na performance"; contradicts the separate worker container in the architecture.

### Option C: Separate worker project
- A new subproject (e.g., plain Node or Python) consuming the queue.
- **Pros:** Strong isolation; language freedom for media tooling.
- **Cons:** Duplicates entity/config/storage code or requires a shared package; a third subproject with its own lint/test/DoD for one job type.

**Recommendation:** **Option A (same codebase, separate entrypoint and container)** — It satisfies the architecture's separate worker with the least duplication; concurrency defaults to 1 (configurable) to fit the local Docker VM, and the container uses `restart: unless-stopped` with a graceful stop period.

**Decision:** A (Same NestJS codebase, separate entrypoint and container)

---

## TD-06: Media Probing and Thumbnail Generation

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The worker must extract duration and metadata and produce a thumbnail from a frame, for originals of up to 10 GB, without exhausting the worker's disk or memory. The npm wrapper most used for this, `fluent-ffmpeg`, is deprecated ("Package no longer supported"). FFmpeg's HTTP protocol is seekable when the server answers range requests, which S3/MinIO do.

**Options:**

### Option A: Spawn `ffprobe`/`ffmpeg` directly, reading the original through a presigned internal URL
- `child_process.spawn` without a shell: `ffprobe -v error -show_format -show_streams -of json <url>` and `ffmpeg -ss T -i <url> -frames:v 1 -vf scale='min(1280,iw)':-2 -f image2pipe -vcodec mjpeg pipe:1`; the URL is signed right before each spawn with a TTL longer than the process timeout. Output parsed as `unknown` and narrowed by a type guard.
- **Pros:** No dependency; FFmpeg seeks with range requests, so only headers, the index (moov atom, even at the end of the file) and one frame are read — never the 10 GB. Thumbnail streams to memory and is uploaded with `PutObject`.
- **Cons:** Argument building and output parsing are hand-written (small, unit-testable).

### Option B: `fluent-ffmpeg` wrapper
- Fluent builder over the same binaries.
- **Pros:** Familiar API, many examples.
- **Cons:** Deprecated and unmaintained; adds a dependency for a handful of arguments.

### Option C: Download the original to a temporary file, then probe
- Stream the object to local disk and run FFmpeg on the file.
- **Pros:** Simplest FFmpeg invocation; no URL expiry concern.
- **Cons:** Requires up to 10 GB of free disk per concurrent job and the time to copy the whole file before reading a few megabytes.

**Recommendation:** **Option A (spawn binaries against a presigned URL)** — It avoids copying 10 GB and a deprecated dependency; policy: thumbnail at T = min(10% of duration, 5 s) with fallback T = 0, JPEG, width ≤ 1280 px, key `videos/{videoId}/thumbnail.jpg`; metadata persisted as `duration_seconds` plus a typed `metadata` JSON (width, height, video/audio codec, bit rate, frame rate, container format); a file without a video stream fails as unsupported media; no transcoding in this phase (formats the browser cannot play are a documented limitation).

**Decision:** A (Spawn ffprobe/ffmpeg against a presigned internal URL)

**Revisions:**
- 2026-11-04 — Thumbnail delivery: when the video is `ready`, `GET /videos/{publicId}` includes `thumbnail_url`, a presigned GET for `videos/{videoId}/thumbnail.jpg` signed with the public endpoint (TD-02) and a 3600 s TTL; in other states, or when no thumbnail exists, `thumbnail_url` is `null`. Rationale: thumbnails live in the same private bucket, so they follow the same presigned-URL delivery as TD-08 instead of a public bucket (rejected in TD-02 Option C).
- 2026-11-04 — Metadata shape: `metadata` (jsonb) holds `width`, `height`, `video_codec`, `audio_codec` (null when there is no audio stream), `bit_rate`, `frame_rate` and `format_name`, all read from ffprobe; `duration_seconds` stays a separate column. Rationale: a fixed key set gives the API response and future phases (Fase 04 panel, Fase 05 player) a stable shape without parsing ffprobe output again.
- 2026-11-05 — Input hardening before parsing: every `ffprobe` and `ffmpeg` run receives `-protocol_whitelist http,https,tcp,tls` and `-format_whitelist mov,mp4,matroska,webm` before the input URL, and ffprobe's `Format not on whitelist` is classified as `UNSUPPORTED_MEDIA` (no retry), like `Invalid data found when processing input`. Rationale: the original is user-controlled, and the container allowlist checked on the probe output runs only after a demuxer already parsed the file; a playlist-like file (HLS, concat) saved as `.mp4` would make the worker open the URLs or local files it lists (SSRF / local file read). Restricting demuxers and protocols up front keeps the presigned storage URL as the only thing the worker can open; the post-probe allowlist stays as defence in depth.

---

## TD-07: Unique Video URL Identifier

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** The project plan asks for "uma URL curta e única que nunca conflite com outro vídeo". The identifier appears in every video route, in API responses and, later, in the watch page URL (Fase 05), so it is a contract across API, database and frontend.

**Options:**

### Option A: UUID primary key in the URL
- Use `videos.id` (uuid v4) as the path parameter.
- **Pros:** Already generated; no extra column.
- **Cons:** 36 characters — not "curta"; exposes the internal key.

### Option B: Random short public ID with unique index and retry
- `public_id` of 11 URL-safe characters (base64url of 8 random bytes from `crypto.randomBytes`, ~2^64 space), `UNIQUE` index, insert retried on unique violation `23505` (same pattern as channel nicknames, without a wrapping transaction).
- **Pros:** Short, non-enumerable, no new dependency; collisions are astronomically rare and still handled.
- **Cons:** One more column and index; a retry loop to test.

### Option C: Slug from title plus random suffix
- e.g., `meu-video-x7k2`.
- **Pros:** Human-readable URLs.
- **Cons:** Titles are optional and editable (Fase 04) — the URL would drift or go stale; longer; still needs a random suffix and retry.

### Option D: Sqids/Hashids encoding of a sequence
- Encode an incrementing integer into a short string.
- **Pros:** Short and collision-free by construction.
- **Cons:** Reversible encoding of a sequence leaks volume/order; needs a new dependency and a sequence column.

**Recommendation:** **Option B (random short public ID)** — It meets "curta e única" with no dependency and no enumeration leak; all video routes use `/videos/{publicId}` and the uuid stays internal (foreign keys and storage keys).

**Decision:** B (Random short public ID with unique index and retry)

**Revisions:**
- 2026-11-04 — Identifier format: `public_id` is exactly 11 characters of the base64url alphabet (`[A-Za-z0-9_-]{11}`), produced from 8 bytes of `crypto.randomBytes`; a `:publicId` path parameter that does not match this pattern answers `400 VALIDATION_ERROR` before any lookup. Rationale: fixing length and alphabet makes the route validation and the column definition (`varchar(11)`, unique) traceable to the TD.

---

## TD-08: Streaming and Download Delivery

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Playback must start without downloading the whole file, which requires HTTP range requests (`206 Partial Content`), and the user must be able to download the original. The architecture diagram already draws "Frontend → Object Storage: Streams". The future frontend consumes the API through a BFF that uses `fetch`, which follows redirects by default. Depends on TD-02 and TD-09.

**Options:**

### Option A: API authorizes and returns a short-lived presigned GET URL as JSON
- `GET /videos/{publicId}/stream` and `/download` return `200 { url, expires_at }`; the storage serves the bytes and answers `Range` with `206`. The download URL carries `response-content-disposition: attachment` with an RFC 5987 filename.
- **Pros:** API never carries video bytes; range support is native to S3/MinIO; works with bearer-token clients and BFFs (no redirect surprises); matches the diagram.
- **Cons:** URLs expire (stream TTL must cover the playback: max(1 h, 2 × duration), capped); requires the public signing endpoint from TD-02.

### Option B: API proxies bytes with range support
- The API reads `Range`, calls `GetObject` with that range and pipes the body back with `206`, `Content-Range`, `Accept-Ranges`.
- **Pros:** Stable URL; access checked on every request.
- **Cons:** Every byte of every playback crosses the API — the bottleneck TD-03 avoids for uploads; each seek is an authenticated API call.

### Option C: API responds `302` to the presigned URL
- Same as A, but as a redirect.
- **Pros:** Works directly in `<video src>` when auth is cookie-based.
- **Cons:** `fetch` in the BFF and Swagger UI follow the redirect and pull the video through the server; same-origin proxies may forward `Authorization` to the storage, which then rejects a request with two auth mechanisms.

### Option D: Adaptive streaming (HLS/DASH)
- Transcode to renditions and serve playlists.
- **Pros:** Adaptive bitrate, broad device support.
- **Cons:** Requires transcoding (hours of CPU for long videos) and multiplies storage; not required by the phase.

**Recommendation:** **Option A (presigned GET URL returned as JSON)** — It satisfies range-based streaming and download with the storage doing the byte serving, keeps the API out of the data path as in TD-03, and gives the future frontend an explicit, non-redirecting contract; HLS/DASH is out of scope (no transcoding this phase).

**Decision:** A (Presigned GET URL returned as JSON)

**Revisions:**
- 2026-11-04 — Separate TTLs: stream TTL = clamp(2 × `duration_seconds`, 3600 s, 43200 s), download TTL = 3600 s, and both responses return `expires_at`. Rationale: the player sends each Range request as a new signed request throughout playback, so the stream URL must outlive the playback (twice the duration, floored at 1 h and capped at 12 h, which also bounds how long a copied link to an owner-only video, TD-09, keeps working); a download's signature is checked when the transfer starts and a long download continues after expiry, so 1 h is enough.
- 2026-11-04 — Video state gate: `GET /videos/{publicId}/stream` and `GET /videos/{publicId}/download` return `200 { url, expires_at }` only when the video is `ready` (the success state of TD-04); in `draft`, `processing` or `failed` they respond `409` with the domain code `VIDEO_NOT_READY` in the envelope inherited from `phase-02-auth/TD-07`; a `ready` video whose probing did not report `duration_seconds` uses the 3600 s floor for the stream TTL; the owner check of TD-09 runs first, so a non-owner gets `404 VIDEO_NOT_FOUND` in any state and learns nothing about the video. Rationale: `ready` is the only state in which the original object is complete and accepted by the probing of TD-06 — in `draft` the multipart upload is not assembled yet, in `processing` the media is still unvalidated (TD-03's MIME allowlist is only declared) and `failed` covers media rejected by the probing, processing that exhausted its retries and expired drafts — so signing a URL in any other state would hand out bytes the platform has not accepted, and one rule for both endpoints keeps the contract simple; `409` says the request conflicts with the video's current state, which the owner can retry once processing ends, and leaves `404` to TD-09; the 3600 s floor keeps the TTL formula defined when the container reports no duration, without inventing one; checking ownership before state keeps IDs non-probeable, since a `409` to a non-owner would reveal that the video exists and which state it is in.
- 2026-11-04 — Download filename: the download URL is signed with `ResponseContentDisposition` set to `attachment; filename="<ASCII fallback>"; filename*=UTF-8''<percent-encoded original name>` (RFC 6266 / RFC 5987), using the original file name declared at initiation (TD-03) and persisted as `original_filename`; the stream URL carries no disposition and plays inline. Rationale: the storage key uses the internal uuid, so without an explicit disposition the browser would save a meaningless name; the original name is the only user-provided name available in this phase (title editing is Fase 04), and the dual `filename`/`filename*` form keeps non-ASCII names intact while older clients get a safe fallback.

---

## TD-09: Video Access Control in Phase 03

**Scope:** Backend

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Every route is protected by the global JWT guard unless marked `@Public()`. Public/unlisted visibility is Fase 04 and anonymous viewing is Fase 05, so this phase must state who may see a video now. Ownership goes through the user's channel (1:1).

**Options:**

### Option A: Owner-only for every video endpoint
- The video is resolved together with its channel's `user_id`; a non-owner gets `404 VIDEO_NOT_FOUND` (existence is not revealed).
- **Pros:** No visibility rules invented ahead of Fase 04/05; probing other users' IDs reveals nothing.
- **Cons:** Nobody but the owner can watch until Fase 04/05 opens access — acceptable since nothing is published yet.

### Option B: Any authenticated user may read and stream `ready` videos
- Owner-only for upload operations; reads open to any logged-in user.
- **Pros:** Closer to the final product.
- **Cons:** Effectively decides visibility (public by default) before Fase 04, where visibility is specified.

### Option C: Public streaming for `ready` videos
- `@Public()` on stream/download.
- **Pros:** Works with `<video src>` without credentials.
- **Cons:** Anticipates Fase 05's anonymous access and Fase 04's unlisted rule; exposes unpublished content.

**Recommendation:** **Option A (owner-only)** — It is the only option that does not pre-empt decisions explicitly assigned to Fases 04 and 05; returning 404 for non-owners keeps IDs non-probeable.

**Decision:** A (Owner-only for every video endpoint)

---

## TD-10: Rate Limiting on Video Endpoints

**Scope:** Backend

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Reprodução via streaming (sem necessidade de download completo)"

**Context:** `phase-02-auth/TD-08` chose `@nestjs/throttler` intending to scope it to auth routes, but `APP_GUARD` registrations are global regardless of the module, so every route is limited to 10 requests per minute. A legitimate client polls video status after completion and may call the resume endpoint several times during a long upload.

**Options:**

### Option A: Exempt the videos controller (`@SkipThrottle()`)
- Video routes are authenticated and owner-scoped; throttling stays on auth routes, as `phase-02-auth/TD-08` intended.
- **Pros:** Aligns behavior with the inherited decision's intent; no 429 during normal upload/polling.
- **Cons:** No per-user cap on video endpoints in this phase.

### Option B: Dedicated higher limits for video routes
- `@Throttle({ default: { limit: N, ttl } })` on the controller.
- **Pros:** Still bounded.
- **Cons:** Picks numbers without usage data; per-IP in-memory counters penalize users behind NAT.

### Option C: Keep the global 10/min
- No change.
- **Pros:** Nothing to do.
- **Cons:** Status polling and resume hit 429 quickly; contradicts the inherited TD's intent.

**Recommendation:** **Option A (`@SkipThrottle()` on the videos controller)** — It restores the scope `phase-02-auth/TD-08` intended and avoids arbitrary limits; the divergence between that TD's text and the global guard is recorded here.

**Decision:** A (`@SkipThrottle()` on the videos controller)

---

## TD-11: Test Strategy for Storage, Queue and Worker

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de armazenamento de arquivos (vídeos e thumbnails)", "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** The testing guide (`testing-guide-nestjs-project`, `references/external-systems.md`) currently prescribes a local-filesystem storage adapter for tests and a real broker for queues. Integration and e2e suites share the development database and run in the `nestjs-api` container, while a `video-worker` container consumes the same Redis. The strategy is cross-component: Jest setup, Compose services, env keys and the guide must agree.

**Options:**

### Option A: Real MinIO, Redis and FFmpeg, isolated by test bucket and queue prefix
- A Jest setup file sets a test bucket and a test queue prefix (and makes the public signing endpoint equal to the internal one); e2e boots the worker module in-process so it consumes only the test prefix and always runs the current code; a liveness test asserts the `video-worker` container is connected to the dev queue. Fixtures are generated with `ffmpeg -f lavfi` at test time; helpers refuse to clean anything whose name lacks `test`.
- **Pros:** Exercises the real S3 API (multipart, presign, range), real queue semantics and real FFmpeg — what the phase must prove; no competition with the Compose worker.
- **Cons:** Slower suites; tests require the Compose stack up and the image rebuilt with FFmpeg; the guide must be updated.

### Option B: Local-filesystem storage adapter (guide as is) + real Redis
- Storage behind an interface with a filesystem implementation in tests.
- **Pros:** Fast, no MinIO needed in tests.
- **Cons:** Cannot test presigned multipart, range responses or checksum behavior — the core of TD-03/TD-08; contradicts "não mocke o que dá para testar de verdade".

### Option C: Testcontainers per suite
- Spin dedicated MinIO/Redis containers from tests.
- **Pros:** Full isolation.
- **Cons:** Needs Docker access from inside the test container; conflicts with the project's "everything via Compose" convention.

**Recommendation:** **Option A (real infrastructure with test bucket and queue prefix)** — It is the only option that actually verifies the upload, streaming and processing contracts; the guide's storage section is updated to match, and no 10 GB transfer is automated (the size limit is verified at validation level).

**Decision:** A (Real MinIO, Redis and FFmpeg, isolated by test bucket and queue prefix)

---

## TD-12: Storage Growth and Cleanup Policy

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The plan's attention points ask to "planejar o crescimento e os custos de armazenamento desde o início". Abandoned multipart uploads keep their parts until aborted; MinIO expires stale multipart uploads after `MINIO_API_STALE_UPLOADS_EXPIRY` (default 24 h, checked every 6 h) and does not honor `AbortIncompleteMultipartUpload` lifecycle rules, while S3 relies on that lifecycle rule.

**Options:**

### Option A: Storage-side expiry + lazy draft expiry, originals kept, no renditions
- MinIO: explicit `MINIO_API_STALE_UPLOADS_EXPIRY=24h`; S3 (production): lifecycle `AbortIncompleteMultipartUpload` after 1 day. The API marks drafts past `upload_expires_at` as `failed` when touched. Originals of `failed` videos are retained (deletion is a Fase 04 management action). `size_bytes` is stored for accounting/quotas later.
- **Pros:** No scheduler or extra job; bytes and states converge; storage cost is one original plus one small thumbnail per video.
- **Cons:** Drafts never touched again stay `draft` in the database (bytes are gone); a report query must treat them as expired.

### Option B: Scheduled cleanup job
- A repeatable BullMQ job aborts expired uploads and marks drafts `failed`.
- **Pros:** Database state always current.
- **Cons:** Extra job, schedule and tests for something storage expiry already does.

**Recommendation:** **Option A (storage-side expiry + lazy draft expiry)** — It bounds storage growth without new moving parts; a scheduled job and tiering/CDN are recorded as production follow-ups.

**Decision:** A (Storage-side expiry + lazy draft expiry)

**Revisions:**
- 2026-11-04 — MinIO stale-upload expiry: the `minio` service sets `MINIO_API_STALE_UPLOADS_EXPIRY=24h` explicitly (not relying on the server default), matching the 24 h upload window of TD-03. Rationale: the window the API enforces and the moment the storage discards the parts must be the same value, stated in one place.
---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Background Job Queue Technology | BullMQ + Redis | A (BullMQ + Redis) |
| TD-02 | Backend | Object Storage Access, Bucket and Key Layout | AWS SDK v3 + single private bucket, per-video prefixes | A (AWS SDK v3 + single private bucket with per-video prefixes) |
| TD-03 | Cross-layer | Large Video Upload Protocol (up to 10 GB) | S3 multipart with presigned part URLs | A (S3 multipart with presigned part URLs) |
| TD-04 | Backend | Video Status Lifecycle and Processing Failure Policy | Single enum with bounded retries | A (Single processing-lifecycle enum with bounded retries) |
| TD-05 | Backend | Video Worker Runtime | Same codebase, separate entrypoint and container | A (Same NestJS codebase, separate entrypoint and container) |
| TD-06 | Backend | Media Probing and Thumbnail Generation | Spawn ffprobe/ffmpeg against presigned URL | A (Spawn ffprobe/ffmpeg against a presigned internal URL) |
| TD-07 | Backend | Unique Video URL Identifier | Random 11-char public ID + unique index | B (Random short public ID with unique index and retry) |
| TD-08 | Cross-layer | Streaming and Download Delivery | Presigned GET URL returned as JSON | A (Presigned GET URL returned as JSON) |
| TD-09 | Backend | Video Access Control in Phase 03 | Owner-only, 404 for non-owners | A (Owner-only for every video endpoint) |
| TD-10 | Backend | Rate Limiting on Video Endpoints | `@SkipThrottle()` on videos controller | A (`@SkipThrottle()` on the videos controller) |
| TD-11 | Backend | Test Strategy for Storage, Queue and Worker | Real MinIO/Redis/FFmpeg with test bucket and prefix | A (Real MinIO, Redis and FFmpeg, isolated by test bucket and queue prefix) |
| TD-12 | Backend | Storage Growth and Cleanup Policy | Storage-side expiry + lazy draft expiry | A (Storage-side expiry + lazy draft expiry) |
