---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-11-04T16:45:43-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-04T23:22:10-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-11-04T23:27:26-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-11-04T14:38:51-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-11-04T14:38:51-03:00"
  docs/phases/phase-02-auth/context.md: "2026-11-04T14:38:51-03:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-11-04T14:38:51-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-11-04T16:05:11-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Upload e Processamento de Vídeos

**Capabilities** (literal bullets, verbatim from project-plan.md):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** _Not specified._

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:**

- `nestjs-project` — (API, worker de vídeo e infraestrutura).

**Deferred subprojects:** `next-frontend` — "`next-frontend` diferido: a interface de vídeo fica para as Fases 04 e 05."

**Sequencing notes:** "Depende de: Fase 01, Fase 02" / "`next-frontend` diferido: a interface de vídeo fica para as Fases 04 e 05."

**Neighbors (for boundary detection only):**

- **Phase 02:** Fase 02 — Cadastro, Login e Gerenciamento de Conta (Depende de: Fase 01)
- **Phase 04:** Fase 04 — Gerenciamento de Vídeos e Canal (Depende de: Fase 02, Fase 03)

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Background Job Queue Technology | decided | A (BullMQ + Redis) | @nestjs/bullmq@^12.0.0, bullmq@^6.4.0 |
|     └─ Last revision: 2026-11-04 — Queue contract names: queue `video-processing`, job name `process-video`, paylo… | | | | | | |
| phase-03-videos/TD-02 | phase | Backend | Object Storage Access, Bucket and Key Layout | decided | A (AWS SDK v3 + single private bucket with per-video prefixes) | @aws-sdk/client-s3@^3.1154.0, @aws-sdk/s3-request-presigner@^3.1154.0 |
|     └─ Last revision: 2026-11-04 — MinIO image and buckets: the `minio` and `minio-init` Compose services use `pgs… | | | | | | |
| phase-03-videos/TD-03 | phase | Cross-layer | Large Video Upload Protocol (up to 10 GB) | decided | A (S3 multipart with presigned part URLs) | — |
|     └─ Last revision: 2026-11-04 — Completion retry after an enqueue failure: when `POST /videos/{publicId}/upload… | | | | | | |
| phase-03-videos/TD-04 | phase | Backend | Video Status Lifecycle and Processing Failure Policy | decided | A (Single processing-lifecycle enum with bounded retries) | — |
|     └─ Last revision: 2026-11-04 — Retry and expiry parameters: processing jobs use `attempts: 3` with exponential… | | | | | | |
| phase-03-videos/TD-05 | phase | Backend | Video Worker Runtime | decided | A (Same NestJS codebase, separate entrypoint and container) | — |
| phase-03-videos/TD-06 | phase | Backend | Media Probing and Thumbnail Generation | decided | A (Spawn ffprobe/ffmpeg against a presigned internal URL) | — |
|     └─ Last revision: 2026-11-04 — Metadata shape: `metadata` (jsonb) holds `width`, `height`, `video_codec`, `aud… | | | | | | |
| phase-03-videos/TD-07 | phase | Backend | Unique Video URL Identifier | decided | B (Random short public ID with unique index and retry) | — |
|     └─ Last revision: 2026-11-04 — Identifier format: `public_id` is exactly 11 characters of the base64url alphab… | | | | | | |
| phase-03-videos/TD-08 | phase | Cross-layer | Streaming and Download Delivery | decided | A (Presigned GET URL returned as JSON) | — |
|     └─ Last revision: 2026-11-04 — Download filename: the download URL is signed with `ResponseContentDisposition`… | | | | | | |
| phase-03-videos/TD-09 | phase | Backend | Video Access Control in Phase 03 | decided | A (Owner-only for every video endpoint) | — |
| phase-03-videos/TD-10 | phase | Backend | Rate Limiting on Video Endpoints | decided | A (`@SkipThrottle()` on the videos controller) | — |
| phase-03-videos/TD-11 | phase | Backend | Test Strategy for Storage, Queue and Worker | decided | A (Real MinIO, Redis and FFmpeg, isolated by test bucket and queue prefix) | — |
| phase-03-videos/TD-12 | phase | Backend | Storage Growth and Cleanup Policy | decided | A (Storage-side expiry + lazy draft expiry) | — |
|     └─ Last revision: 2026-11-04 — MinIO stale-upload expiry: the `minio` service sets `MINIO_API_STALE_UPLOADS_EX… | | | | | | |

_Source files:_

- phase-03-videos — docs/decisions/technical-decisions-phase-03-videos.md (scope_type: phase, related_phases: [3])

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-02, phase-03-videos/TD-11, phase-03-videos/TD-12 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-11 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-03, phase-03-videos/TD-09, phase-03-videos/TD-10 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-04 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-04, phase-03-videos/TD-05, phase-03-videos/TD-06, phase-03-videos/TD-11 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-06 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-07 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-08, phase-03-videos/TD-09, phase-03-videos/TD-10 |
| Download do vídeo pelo usuário | phase-03-videos/TD-08, phase-03-videos/TD-09 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** It is the only option with first-party NestJS support and native retries, backoff, unrecoverable errors and `jobId` deduplication, which TD-04 relies on; the project's own best-practices skill and testing guide already assume it. The transactional gap is handled by an idempotent completion endpoint that re-enqueues with the same `jobId` (TD-03/TD-04) instead of an outbox table.
**Libraries:** @nestjs/bullmq@^12.0.0, bullmq@^6.4.0

**Revisions:**
- 2026-11-04 — Queue contract names: queue `video-processing`, job name `process-video`, payload `{ "videoId": "<uuid>" }` and `jobId` equal to the video's uuid (BullMQ rejects IDs containing `:` or purely numeric), with Redis key prefix from `QUEUE_PREFIX` (`streamtube` in dev, `streamtube-test` in tests per TD-11); the producer connection sets `enableOfflineQueue: false` so a Redis outage fails `add()` immediately. Rationale: the queue, job and ID names are shared by the API producer, the worker consumer and the tests, so they are fixed here as one contract.

### phase-03-videos/TD-02

**Recommendation:** It keeps MinIO→S3 a configuration change, matches the "S3 or MinIO" container in the target architecture, and the per-video prefix makes cleanup and storage accounting (TD-12) straightforward; buckets are created by a one-shot `minio-init` Compose service using the bundled `mc`.
**Libraries:** @aws-sdk/client-s3@^3.1154.0, @aws-sdk/s3-request-presigner@^3.1154.0

**Revisions:**
- 2026-11-04 — Storage config (`registerAs` + Joi) carries two endpoints: `S3_ENDPOINT` (internal, `http://minio:9000`) is used by the API and the worker for every server-side operation, including signing the internal URLs the worker hands to FFmpeg (TD-06), and `S3_PUBLIC_ENDPOINT` is used only by a second `S3Client` that signs the URLs delivered to the client (TD-03 part URLs, TD-08 stream and download URLs); in the dev Compose and in tests `S3_PUBLIC_ENDPOINT` = `http://minio:9000` (reachable from inside the containers), and for a client running on the host the value is overridden to `http://localhost:9000`. Rationale: SigV4 signs the `host`, so a presigned URL is valid only for the host its client was configured with and cannot be rewritten after signing; a dedicated signing client keeps server traffic on the Compose network while the client-facing URLs carry a host the client can reach.
- 2026-11-04 — MinIO image and buckets: the `minio` and `minio-init` Compose services use `pgsty/minio:RELEASE.2026-08-04T00-00-00Z` (bundles `mc` and `curl`; the official `minio/minio` and `minio/mc` images were removed from Docker Hub in September 2026); `minio` is health-checked with `curl -f http://localhost:9000/minio/health/live`; `minio-init` is a one-shot service that creates the dev bucket `streamtube` and the test bucket `streamtube-test` with `mc mb --ignore-existing`, and the services that use the storage depend on it with `condition: service_completed_successfully`. Rationale: pinning a community build that is still pullable keeps the stack reproducible, and creating both buckets in Compose makes dev and tests start from the same known state.

### phase-03-videos/TD-03

**Recommendation:** It is the only option where the API never carries the video bytes, which is the literal requirement, and resumability comes from the storage itself; parameters: maximum size 10 GiB = 10,737,418,240 bytes (product constant, validated at initiation and re-checked with `HeadObject` at completion), part size 64 MiB (160 parts at the limit), part URL TTL 1 h, upload window 24 h (aligned with MinIO's stale-upload expiry), declared MIME allowlist `video/mp4`, `video/quicktime`, `video/webm`, `video/x-matroska` (final validation by ffprobe, TD-06), completion idempotent.
**Libraries:** —

**Revisions:**
- 2026-11-04 — Control plane and data plane split: the control calls (initiate upload, resume, complete, request stream/download URLs) go through the API and, once the frontend lands, through the BFF Route Handlers under `app/api/**`, per `phase-02-auth-frontend/TD-05`; the data plane (part PUTs and media GETs on presigned URLs) goes directly between browser and storage, never through the BFF; the bucket CORS (frontend origin, `PUT`/`GET` methods; no `ETag` exposure, since completion lists the parts server-side) is configured in the phase that brings `next-frontend`. Rationale: keeping the video bytes out of the servers (API and BFF) is the premise of this TD and of TD-08, and relaying up to 10 GiB through a Route Handler would void it; every state-changing call still crosses `app/api/**`, so the inherited strict-BFF precedent holds for the control plane, and the exception is limited to byte transfer authorized by a URL the API signed.
- 2026-11-04 — Upload error contract (envelope of `phase-02-auth/TD-07`): `POST /videos` → `400 VALIDATION_ERROR` (declared size above 10 GiB, MIME/extension outside the allowlist, invalid title) and `503 STORAGE_UNAVAILABLE` (storage unreachable); `GET /videos/{publicId}/upload` → `409 INVALID_VIDEO_STATE` when the video is not `draft` and `410 UPLOAD_EXPIRED` when `upload_expires_at` has passed or the storage reports the upload gone (the video becomes `failed`); `POST /videos/{publicId}/upload/complete` → `202` with `status: processing` (also when it was already `processing`, re-enqueuing with the same `jobId`), `409 UPLOAD_INCOMPLETE` (missing or non-contiguous parts), `409 UPLOAD_SIZE_MISMATCH` (assembled size differs from the declared size), `409 INVALID_VIDEO_STATE` (`ready` or `failed`), `410 UPLOAD_EXPIRED`, `503 QUEUE_UNAVAILABLE` (enqueue failed; the status returns to `draft` so the client can retry) and `503 STORAGE_UNAVAILABLE`; every video route answers `404 VIDEO_NOT_FOUND` for unknown or non-owned IDs (TD-09) and `400 VALIDATION_ERROR` for a malformed `publicId`. Rationale: the protocol has several client-visible failure points; fixing their codes here gives the plan an Error Catalog traceable to a TD and gives the client a retry rule per code (409/410 need a new action, 503 can be retried as-is).
- 2026-11-04 — Upload input contract and object key: `POST /videos` takes `file_name` (1–255 chars; extension must match the declared MIME: `.mp4`→`video/mp4`, `.mov`→`video/quicktime`, `.webm`→`video/webm`, `.mkv`→`video/x-matroska`), `file_size` (integer, 1 to 10,737,418,240 bytes), `content_type` (one of those four MIME types) and an optional `title` (trimmed, 1–100 chars); without `title` the draft takes the file name without its extension, truncated to 100 chars; the video belongs to the authenticated user's channel (`channel_id`); the original object key is `videos/{videoId}/original`; completion compares the sizes reported by `ListParts` with the declared size **before** `CompleteMultipartUpload`, so `409 UPLOAD_SIZE_MISMATCH` and `409 UPLOAD_INCOMPLETE` leave the video in `draft` (the client re-uploads the offending parts within the window), and the post-completion `HeadObject` check marks the video `failed` with `PROCESSING_FAILED` if the assembled object still disagrees; `GET /videos/{publicId}/upload` also answers `503 STORAGE_UNAVAILABLE` when `ListParts` cannot reach the storage. Rationale: the plan needs the exact request fields, limits and key to be traceable, and validating sizes before assembling keeps a wrong part recoverable instead of producing a corrupt original.
- 2026-11-04 — Size mismatch outcome: `POST /videos/{publicId}/upload/complete` answers `409 UPLOAD_SIZE_MISMATCH` in both size checks; when the pre-completion check (`ListParts` sizes vs declared size) fails, the video stays `draft` and the client re-uploads the offending parts within the upload window; when the post-completion `HeadObject` check fails, the assembled object is deleted, the video becomes `failed` with `processing_error` `PROCESSING_FAILED`, and the client must start a new upload. Rationale: one error code keeps the client contract simple, while the video `status` returned by `GET /videos/{publicId}` tells the owner whether the same upload can still be fixed.
- 2026-11-04 — Completion retry after an enqueue failure: when `POST /videos/{publicId}/upload/complete` finds the video in `draft` but the storage no longer has the multipart upload (it was already assembled before a `503 QUEUE_UNAVAILABLE`), it checks the object with `HeadObject`: if the object exists with the declared size, it skips assembling, moves the video to `processing`, enqueues and answers `202`; if there is no object, it answers `410 UPLOAD_EXPIRED` and the video becomes `failed`. In that same state `GET /videos/{publicId}/upload` answers `409 INVALID_VIDEO_STATE`, because there are no parts left to upload. Rationale: a retry after a queue outage must succeed without re-uploading bytes that are already stored, which is what makes `503 QUEUE_UNAVAILABLE` safely retryable.

### phase-03-videos/TD-04

**Recommendation:** It matches the required cycle one-to-one, keeps the state in the database as the source of truth, and leaves publication as an orthogonal Fase 04 concern; the job processor always rethrows so BullMQ can retry — the "catch and log without rethrow" allowance for background tasks applies only to the `failed` event handler.
**Libraries:** —

**Revisions:**
- 2026-11-04 — Status exposure and failure reasons: the owner reads the lifecycle through `GET /videos/{publicId}` (`public_id`, `title`, `status`, `size_bytes`, `mime_type`, `duration_seconds`, `metadata`, `processing_error`, `thumbnail_url`, `created_at`, `updated_at`; storage keys and the multipart upload ID are never exposed), which is how a client learns that processing finished; `processing_error` holds a domain code — `UNSUPPORTED_MEDIA` (probing rejected the file: no video stream or container outside the allowlist), `PROCESSING_FAILED` (retries exhausted or job stalled) or `UPLOAD_EXPIRED` (draft past its upload window). Rationale: the status cycle must be observable by the owner to be useful, and a short code set lets the future frontend explain failures without parsing log text.
- 2026-11-04 — Retry and expiry parameters: processing jobs use `attempts: 3` with exponential backoff and a base delay of 1000 ms (configurable through env so tests can use a small value); the lazy expiry of TD-12 runs on every owner read of a `draft` (`GET /videos/{publicId}` and the upload routes), turning a draft past `upload_expires_at` into `failed` with `UPLOAD_EXPIRED` before answering. Rationale: fixing the numbers and the places where expiry is evaluated makes the lifecycle deterministic and testable.

### phase-03-videos/TD-05

**Recommendation:** It satisfies the architecture's separate worker with the least duplication; concurrency defaults to 1 (configurable) to fit the local Docker VM, and the container uses `restart: unless-stopped` with a graceful stop period.
**Libraries:** —

### phase-03-videos/TD-06

**Recommendation:** It avoids copying 10 GB and a deprecated dependency; policy: thumbnail at T = min(10% of duration, 5 s) with fallback T = 0, JPEG, width ≤ 1280 px, key `videos/{videoId}/thumbnail.jpg`; metadata persisted as `duration_seconds` plus a typed `metadata` JSON (width, height, video/audio codec, bit rate, frame rate, container format); a file without a video stream fails as unsupported media; no transcoding in this phase (formats the browser cannot play are a documented limitation).
**Libraries:** —

**Revisions:**
- 2026-11-04 — Thumbnail delivery: when the video is `ready`, `GET /videos/{publicId}` includes `thumbnail_url`, a presigned GET for `videos/{videoId}/thumbnail.jpg` signed with the public endpoint (TD-02) and a 3600 s TTL; in other states, or when no thumbnail exists, `thumbnail_url` is `null`. Rationale: thumbnails live in the same private bucket, so they follow the same presigned-URL delivery as TD-08 instead of a public bucket (rejected in TD-02 Option C).
- 2026-11-04 — Metadata shape: `metadata` (jsonb) holds `width`, `height`, `video_codec`, `audio_codec` (null when there is no audio stream), `bit_rate`, `frame_rate` and `format_name`, all read from ffprobe; `duration_seconds` stays a separate column. Rationale: a fixed key set gives the API response and future phases (Fase 04 panel, Fase 05 player) a stable shape without parsing ffprobe output again.

### phase-03-videos/TD-07

**Recommendation:** It meets "curta e única" with no dependency and no enumeration leak; all video routes use `/videos/{publicId}` and the uuid stays internal (foreign keys and storage keys).
**Libraries:** —

**Revisions:**
- 2026-11-04 — Identifier format: `public_id` is exactly 11 characters of the base64url alphabet (`[A-Za-z0-9_-]{11}`), produced from 8 bytes of `crypto.randomBytes`; a `:publicId` path parameter that does not match this pattern answers `400 VALIDATION_ERROR` before any lookup. Rationale: fixing length and alphabet makes the route validation and the column definition (`varchar(11)`, unique) traceable to the TD.

### phase-03-videos/TD-08

**Recommendation:** It satisfies range-based streaming and download with the storage doing the byte serving, keeps the API out of the data path as in TD-03, and gives the future frontend an explicit, non-redirecting contract; HLS/DASH is out of scope (no transcoding this phase).
**Libraries:** —

**Revisions:**
- 2026-11-04 — Separate TTLs: stream TTL = clamp(2 × `duration_seconds`, 3600 s, 43200 s), download TTL = 3600 s, and both responses return `expires_at`. Rationale: the player sends each Range request as a new signed request throughout playback, so the stream URL must outlive the playback (twice the duration, floored at 1 h and capped at 12 h, which also bounds how long a copied link to an owner-only video, TD-09, keeps working); a download's signature is checked when the transfer starts and a long download continues after expiry, so 1 h is enough.
- 2026-11-04 — Video state gate: `GET /videos/{publicId}/stream` and `GET /videos/{publicId}/download` return `200 { url, expires_at }` only when the video is `ready` (the success state of TD-04); in `draft`, `processing` or `failed` they respond `409` with the domain code `VIDEO_NOT_READY` in the envelope inherited from `phase-02-auth/TD-07`; a `ready` video whose probing did not report `duration_seconds` uses the 3600 s floor for the stream TTL; the owner check of TD-09 runs first, so a non-owner gets `404 VIDEO_NOT_FOUND` in any state and learns nothing about the video. Rationale: `ready` is the only state in which the original object is complete and accepted by the probing of TD-06 — in `draft` the multipart upload is not assembled yet, in `processing` the media is still unvalidated (TD-03's MIME allowlist is only declared) and `failed` covers media rejected by the probing, processing that exhausted its retries and expired drafts — so signing a URL in any other state would hand out bytes the platform has not accepted, and one rule for both endpoints keeps the contract simple; `409` says the request conflicts with the video's current state, which the owner can retry once processing ends, and leaves `404` to TD-09; the 3600 s floor keeps the TTL formula defined when the container reports no duration, without inventing one; checking ownership before state keeps IDs non-probeable, since a `409` to a non-owner would reveal that the video exists and which state it is in.
- 2026-11-04 — Download filename: the download URL is signed with `ResponseContentDisposition` set to `attachment; filename="<ASCII fallback>"; filename*=UTF-8''<percent-encoded original name>` (RFC 6266 / RFC 5987), using the original file name declared at initiation (TD-03) and persisted as `original_filename`; the stream URL carries no disposition and plays inline. Rationale: the storage key uses the internal uuid, so without an explicit disposition the browser would save a meaningless name; the original name is the only user-provided name available in this phase (title editing is Fase 04), and the dual `filename`/`filename*` form keeps non-ASCII names intact while older clients get a safe fallback.

### phase-03-videos/TD-09

**Recommendation:** It is the only option that does not pre-empt decisions explicitly assigned to Fases 04 and 05; returning 404 for non-owners keeps IDs non-probeable.
**Libraries:** —

### phase-03-videos/TD-10

**Recommendation:** It restores the scope `phase-02-auth/TD-08` intended and avoids arbitrary limits; the divergence between that TD's text and the global guard is recorded here.
**Libraries:** —

### phase-03-videos/TD-11

**Recommendation:** It is the only option that actually verifies the upload, streaming and processing contracts; the guide's storage section is updated to match, and no 10 GB transfer is automated (the size limit is verified at validation level).
**Libraries:** —

### phase-03-videos/TD-12

**Recommendation:** It bounds storage growth without new moving parts; a scheduled job and tiering/CDN are recorded as production follow-ups.
**Libraries:** —

**Revisions:**
- 2026-11-04 — MinIO stale-upload expiry: the `minio` service sets `MINIO_API_STALE_UPLOADS_EXPIRY=24h` explicitly (not relying on the server default), matching the 24 h upload window of TD-03. Rationale: the window the API enforces and the moment the storage discards the parts must be the same value, stated in one place.

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS. Building a custom module recreates solved functionality; third-party packages carry maintenance risk.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively. Using a different tool for env validation vs. request validation is reasonable — env config is validated once at startup, DTOs are validated per-request. Zod is elegant but adds a third validation paradigm to the project.

**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — The project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, and natural scalability. The `registerAs()` factory is dual-purpose: DI token inside NestJS and plain importable function for `data-source.ts`. Initial files for Phase 01: `src/config/database.config.ts`, `src/config/app.config.ts`.

**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — Natural outcome of choosing `@nestjs/config` with `registerAs`. The factory is already callable by design. `data-source.ts` imports it, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.

**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** Argon2id — For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. The native build dependency is a one-time Docker setup cost. The project has no legacy constraints favoring bcrypt. OWASP minimum: 19MiB memory, 2 iterations.

**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Option A (@nestjs/passport) — The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login. Aligns with official NestJS docs, making onboarding and maintenance easier.

**Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller; social login is not on the near-term roadmap, so the plugin-architecture benefit did not justify the extra abstraction layer.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Option A (Refresh Token Rotation) — Provides the strongest security model with automatic theft detection. The DB write overhead is acceptable for a video platform (auth refresh is infrequent vs. video operations). PostgreSQL is already in the stack, so no new infrastructure needed. Race conditions can be mitigated with a short grace period for the old token.

**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Option B (Random Opaque Tokens in DB) — Revocability is important: when a user requests a new password reset, previous tokens should be invalidated. The DB table is trivial to implement, and the tokens table can also serve future needs (e.g., API keys). Keeps email tokens decoupled from the JWT auth system.

**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Option A (@nestjs-modules/mailer) — Best NestJS integration with minimal boilerplate. Supports SMTP (matching the architecture diagram), works with MailHog/Mailpit for local development without external dependencies, and scales to any SMTP provider in production. Template engine support (Handlebars) simplifies email formatting. No vendor lock-in.

**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity. The custom filter cost is low — two small files.

**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — Native NestJS integration is decisive: the guard system allows scoping rate limiting to `AuthModule` only via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions. The project is single-instance with no distributed requirements, so in-memory storage is sufficient. Using express-rate-limit would bypass NestJS's DI and guard lifecycle for no clear benefit.

**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** Option B (Opaque) — Since DB lookup is mandatory (TD-03), JWT signature adds no security value. Opaque tokens are shorter, leak no data, and are simpler to generate.

**Note:** Decision deliberately diverged from the Recommendation — JWT was kept to reuse the access-token signing/verification infrastructure (`@nestjs/jwt`), trading token size and base64-readability for a single token format across the codebase.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** Option A — The platform is a video sharing service with URL-based channel handles. A strict `[a-z0-9_]` allowlist is the simplest and most portable choice: no extra dependencies, no edge cases around hyphen positioning, and the `user_<random>` fallback provides a valid handle even for extreme email prefixes. Hyphens can always be added in a future iteration if user feedback justifies it.

**Libraries:** —

### phase-02-auth-frontend/TD-01

**Recommendation:** Three reasons. (1) **Architectural fit.** The strict-BFF model in `next-frontend-config-base/TD-03` already nominates the Route Handler as the only NestJS caller; cookie-based sessions are the natural match, and Auth.js's framework adds layers between the BFF and the cookie that buy nothing because the backend is the auth authority — Auth.js's value (DB adapters, OAuth providers, magic-link, `getServerSession` helpers) is mostly unused in this configuration. (2) **Smaller blast radius.** A ~50-LOC session helper is grep-friendly, debuggable, and test-friendly via the existing MSW+BFF integration test pattern; a misconfigured Auth.js callback is a longer fault-isolation loop. (3) **Compatibility with Next.js 16 / React 19.** Built-in `next/headers` `cookies()` is the canonical primitive both runtimes already use; Auth.js v5 versions track Next.js majors with a lag, adding compatibility risk that Option A does not have. Option C is rejected as unsafe (`localStorage` for refresh tokens) and architecturally regressive (loses RSC personalization).
**Libraries:** —

### phase-02-auth-frontend/TD-02

**Recommendation:** Three reasons. (1) **Defense in depth on the cookie content** — `httpOnly` blocks JS, encryption blocks accidental log/proxy inspection; the marginal cost is one ~3KB dep. (2) **Single cookie to manage** simplifies logout (one `session.destroy()` call) and avoids the orphan-cookie failure mode of Option A. (3) **Room to carry minimal user metadata** (`userId`, `email`, `channelSlug`) lets `app/layout.tsx` RSC render the authenticated chrome (avatar, channel name) without a per-render `/auth/me` round-trip — Phase 04+ gains compound here. Option A is a viable downgrade if the team rejects `iron-session` for any reason; the migration A→B (or B→A) is a one-Route-Handler refactor with no test changes downstream because the BFF interface is unchanged. Option C is rejected: it solves a problem (server-side revocation) the project does not have at the cost of infrastructure the project does not own.
**Libraries:** iron-session

### phase-02-auth-frontend/TD-03

**Recommendation:** The single-flight detail is non-trivial and goes in the helper from day one — tested by MSW with a "two concurrent intercepted upstream calls; one refresh expected" assertion. Option B's client-driven pattern is rejected because it doesn't replace Option A (RSC still needs server-side refresh) — adopting B means doing both. Option C's pre-emptive timer is rejected because the failure modes (multiple tabs, sleep/wake) outweigh the latency saving and force a `"use client"` shell near the root.
**Libraries:** —

### phase-02-auth-frontend/TD-04

**Recommendation:** Three reasons. (1) **Decoupled from TD-05** — works with Route Handlers OR Server Actions; the form code does not change if TD-05 is revisited later. (2) **Aligned with shadcn's canonical form primitive** — the project already commits to `radix-nova` shadcn (`components.json`); `npx shadcn@latest add form` produces react-hook-form wrappers; choosing react-hook-form means using the supported primitive instead of hand-rolling around it. (3) **Zod-first developer ergonomics match the rest of the FE foundation** — `next-frontend-config-base/TD-01` chose Zod 4 for env; the same schemas-as-source-of-truth pattern carries to forms with zero new validator paradigm. Option B is rejected for impedance with shadcn's primitive and for over-investing in progressive-enhancement that the strict-BFF model does not require. Option C is rejected for the per-field boilerplate and the loss of client-side feedback on a project that values quick, type-safe form iteration.
**Libraries:** react-hook-form, @hookform/resolvers

### phase-02-auth-frontend/TD-05

**Recommendation:** Three reasons. (1) **Strict-BFF alignment.** `next-frontend-config-base/TD-03` named Route Handlers as the BFF surface; Option A keeps every mutation visible under `app/api/**`. (2) **Test scaffold already exists** — `next-frontend/CLAUDE.md` § Testing and `next-frontend-msw-foundation` were authored for Route-Handlers-as-functions; Option A reuses them with zero invention. (3) **Single mutation surface** — Phase 02 sets the precedent for Phases 03–07; uniformity beats per-mutation idiom-picking when the cost of inconsistency compounds (Option C). Option B has real ergonomic appeal for the simplest forms but fragments the BFF surface and forces test-pattern reinvention; if the team later wants progressive enhancement for specific forms, the migration A→B is per-form and doesn't require touching unrelated routes — A is the safer default and the cheaper baseline.
**Libraries:** —

### phase-02-auth-frontend/TD-06

**Recommendation:** Two reinforcing reasons. (1) **No first-render flicker, no round-trip** — the session is delivered in the same response as the page HTML; the Client Provider hydrates with the correct initial state; users never see "Login" briefly turn into their avatar. (2) **No new BFF endpoint** — the cookie is the source of truth, RSC reads it, the Provider broadcasts it; the BFF surface stays minimal. The `router.refresh()` requirement after mid-session mutations is a small price (one line in the relevant mutation handler) for the structural benefits. Option B is rejected for the double-read-and-flicker; Option C is dominated by Option B and rejected.
**Libraries:** —

### phase-02-auth-frontend/TD-07

**Recommendation:** Three reasons. (1) **First-paint-correct** — the user sees the right outcome on the first paint, no skeleton, no flicker. (2) **Single integration pattern across both flows** — confirmation is RSC-only; reset is RSC + Client form (TD-04, TD-05 patterns reused) — both share the "RSC owns the token, Client Component owns the input" split. (3) **Email-prefetch behavior** is solved at the backend's idempotent-confirmation level (a small note for `/plan-build` to confirm; not a separate TD). Option B's Route-Handler-as-link-target adds redirects for no clean gain. Option C is dominated.
**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** é a única opção que preserva as decisões anteriores (`class-validator` em TD-06 de phase-02-auth) sem re-platform; o CLI plugin com `classValidatorShim: true` aproveita os decoradores `class-validator` existentes para inferir schemas, mantendo o boilerplate baixo. Nestia tem mérito técnico real mas o custo de migração do stack de validação inviabiliza-a sem uma decisão upstream de supersede de TD-06. Manual authoring é descartado.
**Libraries:** @nestjs/swagger

**Revisions:**
- 2026-05-12 — Esclarece que o CLI plugin (`classValidatorShim: true`) cobre apenas inferência de schemas de DTOs a partir de `class-validator`; documentação de operações, respostas tipadas por status code, contratos de erro (alinhados ao envelope de phase-02-auth/TD-07) e exemplos exigem decoradores explícitos (`@ApiOperation`, `@ApiResponse`, `@ApiBody`, `@ApiParam`, `@ApiQuery`, `@ApiExtraModels`). _Rationale:_ openapi.json gerado pelo bootstrap atual está genérico — sem detalhes de parâmetros, schemas de retorno por status, nem contratos de erro — porque a base instalada se apoiou só na introspecção automática. Esta revisão fixa que enriquecimento via decoradores explícitos faz parte da Option A escolhida, não é trabalho fora do escopo do TD.

### openapi-docs-nestjs/TD-02

**Recommendation:** o custo marginal sobre Option A é apenas um npm script (~15 linhas) e o benefício é uma fundação correta para futura integração FE (codegen offline) sem perder a UI interativa que dev/QA usam. Option B sozinho pune a experiência de desenvolvimento em dev/local; Option A sozinho compromete o pipeline de codegen futuro. Combinar é dominante.
**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** alinha com a postura defensiva já estabelecida em phase 02 e não compromete consumidores legítimos (o `openapi.json` commitado em TD-02 cumpre o papel de "spec consultável fora da UI"). Re-abrir como Option A ou C é trivial no futuro se um caso de uso de API pública aparecer.
**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Joi schema `src/config/env.validation.ts` validates env in `ConfigModule.forRoot`; `validationOptions: { allowUnknown: true, abortEarly: false }`. _(from phase 01)_
- Inject config via `ConfigType<typeof xxxConfig>` + `@Inject(xxxConfig.KEY)`; factory also callable as plain function outside DI (TypeORM CLI). _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- DB connection params come from a single `databaseConfig` factory — never duplicated between `AppModule` and `data-source.ts`. _(from phase 01)_
- `TypeOrmModule.forRootAsync`: `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory`; `autoLoadEntities: true`, `synchronize: false`. _(from phase 01)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| "Confirmação de conta via e-mail com link de ativação" | deferred | phase-02-auth-frontend | deferred_to_next_phase — UI landing screen de-scoped 2026-05-14; FE confirmation flow (TD-07) picked up by a future phase. BE side unchanged in `phase-02-auth`. |
| "Logout" | deferred | phase-02-auth-frontend | deferred_to_next_phase — logout button lives inside authenticated chrome (typically Phase 04). Phase 02 still implements POST `/api/auth/logout` (BFF route handler + `session.destroy()`) so the contract is ready when the chrome lands. |
| "Recuperação de senha (destination screen / set-new-password)" | deferred | phase-02-auth-frontend | deferred_to_next_phase — `/forgot-password` ships this phase sending the e-mail; the reset-password destination screen is absent from Figma → link destination remains a 404 until a later phase delivers the screen via `/screen-inventory` extension run. Documented as a known gap. |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth-frontend | a tela de confirmação da conta não será implementada nesta fase corrente, será adiada — the umbrella bullet's full coverage requires the confirmação and reset-password destination screens; both are deferred per Non-UI rows above. The 3 ship-this-phase telas (signup, login, forgot-password) are inventoried and covered by their own verbs; the umbrella bullet itself is deferred to the phase that lands the missing screens. |

## UI Inventory

_No screen inventory — UI↔API sync deferred. Run /screen-inventory 3 and then rerun /plan-context 3 to activate UI checks._

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

### nestjs-project

_Source: `testing-guide-nestjs-project` Skill — § 3. Feature Implementation Checklist._

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit: branch logic (mock repo) + Integration: DB contract |
| Service with DB only (no branching) | Integration: DB contract |
| Service with configured lib (JWT, cache) | Unit: real lib with test config |
| Service with side-effect dep (email, storage, queue) | Integration: real service from Compose (Mailpit, MinIO, Redis) |
| Module with configured imports | Unit: compilation test |
| Controller | E2E only — do NOT write unit tests |
| DTO | E2E: one validation wiring test per endpoint |
| Guard (delegates to service for business logic) | E2E + Unit if complex internal logic |
| Guard (simple, delegates to Passport) | E2E only |
| Strategy (Passport) | E2E via guard |
| Pipe (custom transformation/validation) | Unit |
| Interceptor (response transform, logging) | Unit and/or E2E |
| Exception Filter | Unit + E2E |
| Middleware | E2E |

### next-frontend

_Deferred subproject — testing requirements will be defined when `next-frontend` enters scope (Fases 04 e 05); the `testing-guide-next-frontend` Skill exists but is not consumed by this phase._
