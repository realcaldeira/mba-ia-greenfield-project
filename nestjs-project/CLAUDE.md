# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, cache/queue, object storage) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

**Exception — `video-worker`:** unlike `nestjs-api` (an idle container that only runs the API after `npm run start:dev`), the `video-worker` service starts its own process (`command: ["npm", "run", "start:worker:dev"]`, `restart: unless-stopped`). `docker compose up -d` therefore always brings the worker up; that is expected, not a violation of the rule above.

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps      # nestjs-api, db, mailpit, redis, minio and video-worker must be "Up" (db, mailpit, redis and minio also "healthy")
docker compose ps -a   # also lists minio-init, a one-shot service that must show "Exited (0)"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`
- **Mailpit:** `curl -s -o /dev/null -w '%{http_code}' http://localhost:8025` — expect `200`
- **Redis:** `docker compose exec redis redis-cli ping` — expect `PONG`
- **MinIO:** `docker compose exec nestjs-api curl -f http://minio:9000/minio/health/live` — expect exit code `0` (HTTP `200`). From the host, `curl -f http://localhost:9000/minio/health/live` is equivalent, but see the corporate-proxy note in "Videos (Phase 03)"
- **minio-init:** `docker compose ps -a minio-init` — expect `Exited (0)` (the `streamtube` and `streamtube-test` buckets exist). A plain `docker compose ps` hides exited containers
- **video-worker:** `docker compose logs video-worker` — expect `Video worker started: queue "video-processing", prefix "streamtube", concurrency 1` (the worker is connected to the queue and consuming)

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers (the video-worker starts by itself)
docker compose up -d

# Rebuild the images after changing Dockerfile.dev (e.g., system packages such as ffmpeg)
docker compose up -d --build

# Install dependencies (first time only)
docker compose exec nestjs-api npm install
# The worker loaded its dependencies at startup: restart it after any npm install
docker compose restart video-worker

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services (`compose.yaml`):
- `nestjs-api` — NestJS API, port `3000`. Idle container (`tail -f /dev/null`); the API only runs after `npm run start:dev`
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `mailpit` — SMTP on port `1025`, web UI on `http://localhost:8025`
- `redis` — Redis 8 (`--maxmemory-policy noeviction`, AOF `--appendonly yes`, volume `redis-data`); port `6379` only inside the Compose network (not published to the host)
- `minio` — MinIO object storage (`pgsty/minio`), S3 API on port `9000`, web console on `http://localhost:9001` (user/password from `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`), volume `minio-data`
- `minio-init` — one-shot: creates the `streamtube` (dev) and `streamtube-test` (tests) buckets with `mc mb --ignore-existing`, then exits. `nestjs-api` and `video-worker` wait for it (`service_completed_successfully`)
- `video-worker` — video processing worker (BullMQ consumer + FFmpeg), same image and bind mount as `nestjs-api`, no published port, `stop_grace_period: 2m` so an active job can finish on `SIGTERM`

Both `nestjs-api` and `video-worker` build from `Dockerfile.dev` (`node:25.6.0-slim` + `ffmpeg`, which provides `ffmpeg` and `ffprobe`).

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL, Redis and MinIO are ready
docker compose exec db pg_isready -U streamtube
docker compose exec redis redis-cli ping
docker compose exec nestjs-api curl -f http://minio:9000/minio/health/live

# Check container logs
docker compose logs nestjs-api
docker compose logs db
docker compose logs video-worker

# Tear down the entire environment
docker compose down
```

### Video worker scripts

```bash
npm run start:worker:dev    # what the video-worker service runs (watch mode)
npm run build:worker        # nest build --path tsconfig.worker.json → dist-worker/
npm run start:worker:prod   # node dist-worker/worker/main
```

- `start:worker:dev` = `nest build --path tsconfig.worker.json && (tsc -p tsconfig.worker.json --watch --preserveWatchOutput &) && exec node --enable-source-maps --watch dist-worker/worker/main`. The initial `nest build` applies the Nest CLI plugins and `deleteOutDir`; the background `tsc --watch` recompiles into `dist-worker/` on every change; `node --watch` restarts the worker when the compiled files change.
- `nest start --watch` is **not** used for the worker: under it, the Compose `SIGTERM` reached only npm's direct child, the Nest CLI does not forward the signal, and the app was killed without running its shutdown hooks (the BullMQ worker was not closed and npm exited with code 1). With `exec node --watch`, `node` is npm's direct child, forwards `SIGTERM` to the app, and the app closes the queue and exits with code `0` (`enableShutdownHooks([], { useProcessExit: true })` in `src/worker/main.ts`).
- `tsconfig.worker.json` extends `tsconfig.build.json` with `outDir: ./dist-worker`. `dist-worker/` is git-ignored, and the API build (`dist/`) and the worker build (`dist-worker/`) never delete each other.
- `npm run build:worker` uses `deleteOutDir`, so running it while the `video-worker` service is up removes the files the running worker watches: `node --watch` stops with `Cannot find module .../dist-worker/worker/main` and waits. Run `docker compose restart video-worker` afterwards.

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile the API to dist/
npm run start:prod                       # Run compiled build
npm run build:worker                     # Compile the video worker to dist-worker/

npm test                                 # Unit + integration tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
npm run openapi:export                   # Regenerate the versioned openapi.json
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose logs video-worker
docker compose exec db pg_isready -U streamtube
docker compose exec redis redis-cli ping
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand` (both `npm test` and `npm run test:e2e` already pass it):

```bash
docker compose exec nestjs-api npm test
docker compose exec nestjs-api npm run test:e2e
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

`npm run test:e2e` includes `test/video-worker.e2e-spec.ts`, which checks that the `video-worker` container is connected to the dev queue: the `video-worker` service must be running.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `start:worker:dev`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. The same applies to tests that hit MinIO, Redis or spawn `ffmpeg`/`ffprobe`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config, `rootDir: "src"`) and `test/jest-e2e.json` (`rootDir: "."`, i.e. `test/`) for the project's tests to work correctly:

- `setupFiles` — `dotenv/config` first, then `setup-test-env.ts`:
  - `package.json`: `["dotenv/config", "<rootDir>/test/setup-test-env.ts"]`
  - `test/jest-e2e.json`: `["dotenv/config", "<rootDir>/../src/test/setup-test-env.ts"]` (a relative `rootDir` resolves from the config file's directory, so `<rootDir>` is `test/`)
  - Without `dotenv/config`, `.env` is not loaded inside the Jest process: `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
  - `src/test/setup-test-env.ts` isolates the tests from the dev resources (see "Videos (Phase 03)" → Test isolation).
- `transformIgnorePatterns: ["/node_modules/(?!@nestjs/(bullmq|bull-shared)/)"]` plus a dedicated `transform` entry (`ts-jest` with `allowJs`, `module: commonjs`) for `/node_modules/@nestjs/(bullmq|bull-shared)/.+\.js$` — `@nestjs/bullmq` 12 and `@nestjs/bull-shared` 12 are ESM-only, and Jest's own `require` cannot load ESM. Only these two packages are transformed; the application runtime (Node 25 `require(esm)`) does not need it.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` (`package.json`) — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes. `test/jest-e2e.json` uses `.e2e-spec.ts$`.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces, `"`) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM="StreamTube" <noreply@streamtube.com>

# Right — wrap the whole value in single quotes (as in .env.example)
MAIL_FROM='"StreamTube" <noreply@streamtube.com>'
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

`.env.example` documents every variable. The Phase 03 blocks are `# Object Storage (MinIO)` (`S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`) and `# Queue (Redis + BullMQ)` (`REDIS_HOST`, `REDIS_PORT`, `QUEUE_PREFIX`, `QUEUE_BACKOFF_DELAY_MS`, `QUEUE_ENQUEUE_TIMEOUT_MS`, `VIDEO_WORKER_CONCURRENCY`). When a variable is added there, replicate it in the local `.env` (not versioned).

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/` (and `dist-worker/` for the worker build). Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/` (API) and `dist-worker/` (video worker).

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module
- Two entrypoints share the codebase: `src/main.ts` (HTTP API, `AppModule`) and `src/worker/main.ts` (video worker, `WorkerModule`, no HTTP layer). Shared configuration lives in `src/config/config-module.options.ts` and `src/database/typeorm-options.ts`

## Videos (Phase 03)

Upload, processing and streaming of videos. Decisions: [`docs/decisions/technical-decisions-phase-03-videos.md`](../docs/decisions/technical-decisions-phase-03-videos.md) (TD-01 to TD-12). Plan and progress: [`docs/phases/phase-03-videos/`](../docs/phases/phase-03-videos/).

### Folder structure

```
src/
├── videos/          # VideosModule: controller (6 routes), VideosService, Video entity,
│                    # DTOs, public_id generator, upload validators, storage keys,
│                    # domain exceptions, constants (sizes, TTLs, MIME allowlist)
├── storage/         # StorageModule: StorageService (multipart, presigned URLs, objects)
│                    # with two S3Clients (internal and signing), StorageUnavailableException
├── queue/           # QueueModule (BullMQ connection, prefix, retries) and
│                    # VideoProcessingProducerModule/VideoProcessingProducer (API side)
├── worker/          # Video worker: main.ts (entrypoint), WorkerModule,
│                    # VideoProcessingConsumer and media/ (MediaProbeService, ThumbnailService,
│                    # ffprobe parser, process runner)
├── config/          # storage.config.ts, queue.config.ts, config-module.options.ts
├── database/        # typeorm-options.ts; migration 1793849825000-CreateVideos.ts
└── test/            # setup-test-env.ts, storage.ts, queue.ts, media-fixtures.ts, test-entities.ts
test/
├── utils/           # e2e-app.ts, auth.ts, videos.ts, worker.ts (shared e2e helpers)
├── videos-*.e2e-spec.ts
└── video-worker.e2e-spec.ts
```

### Endpoints

All routes require the JWT access token (`Authorization: Bearer`), are owner-only (another user's video answers `404 VIDEO_NOT_FOUND`) and are exempt from the global throttler (`@SkipThrottle()`). `publicId` is the 11-character base64url `public_id` (`^[A-Za-z0-9_-]{11}$`).

| Method & route | Success | Purpose |
|----------------|---------|---------|
| `POST /videos` | `201` | Creates the `draft` and the multipart upload; returns one presigned `PUT` URL per part |
| `GET /videos/{publicId}` | `200` | Video status, metadata and presigned `thumbnail_url` (only when `ready`) |
| `GET /videos/{publicId}/upload` | `200` | Resumes the upload: lists the received parts and re-signs only the missing ones |
| `POST /videos/{publicId}/upload/complete` | `202` | Checks the parts, assembles the original and enqueues the processing; idempotent |
| `GET /videos/{publicId}/stream` | `200` | `{ url, expires_at }` — presigned `GET` for inline playback (`Range` → `206`); only `ready` |
| `GET /videos/{publicId}/download` | `200` | `{ url, expires_at }` — presigned `GET` with `Content-Disposition: attachment` and the original file name; only `ready` |

The error codes per route are in the OpenAPI (`openapi.json`; `npm run openapi:export` rebuilds it) and in the plan's Error Catalog.

### Upload flow (presigned multipart — bytes never pass through the API)

1. `POST /videos` with `file_name`, `file_size` (1 to 10 GiB = `10737418240` bytes), `content_type` (`video/mp4`, `video/quicktime`, `video/webm`, `video/x-matroska`, with a matching extension) and an optional `title`. A user without a channel gets `404 CHANNEL_NOT_FOUND`. The API creates the `draft` row and a multipart upload in the storage, and answers with `part_size` (64 MiB), `part_count` (at most 160), one presigned URL per part (valid 1 h, `parts_expire_at`) and `upload_expires_at` (24 h window).
2. The client `PUT`s each part **directly to the storage** on its presigned URL.
3. If the connection drops, `GET /videos/{publicId}/upload` returns `uploaded_parts` and fresh URLs only for the missing parts.
4. `POST /videos/{publicId}/upload/complete`: the API lists the parts in the storage (no client ETags), checks contiguity (`409 UPLOAD_INCOMPLETE`), the part sizes (every part but the last exactly `part_size`, the last at most `part_size`) and the total size (`409 UPLOAD_SIZE_MISMATCH`), completes the multipart upload (parts the storage rejects — `EntityTooSmall`, `InvalidPart`, `InvalidPartOrder` — answer `409 UPLOAD_INCOMPLETE`; the video stays `draft` in all these cases), re-checks the object with `HeadObject`, moves the video to `processing` and enqueues the job. `503 QUEUE_UNAVAILABLE` (enqueue failed or took longer than `QUEUE_ENQUEUE_TIMEOUT_MS`) puts the video back in `draft`, and the same call can be repeated without re-sending any part. If another request changed the row between the read and the `draft → processing` transition, the answer follows the row's real state: `processing` → re-enqueue and `202`; `failed`/`UPLOAD_EXPIRED` → `410`; anything else → `409 INVALID_VIDEO_STATE`. Two concurrent completions of the same upload: the one whose `CompleteMultipartUpload` finds the upload already consumed (`NoSuchUpload`) takes the same path as the retry after a `503` — `HeadObject` of the original: present with the declared size → `draft → processing` (or the `processing` the other call already wrote) and `202`; missing → `failed`/`UPLOAD_EXPIRED` and `410`.

### Status lifecycle

`draft` → `processing` → `ready` | `failed` (`VideoStatus` in `src/videos/entities/video.entity.ts`).

- `draft` → `failed` with `processing_error = UPLOAD_EXPIRED` when the 24 h upload window passes (lazy expiry, applied on read) or the storage no longer has the upload. The state is written before the multipart upload is aborted; if the abort fails, the request answers `503 STORAGE_UNAVAILABLE` but the video is already `failed`. From then on both upload routes (`GET .../upload`, `POST .../upload/complete`) answer `410 UPLOAD_EXPIRED` for that video, whichever request expired it.
- The expiry never deletes an object: an original already assembled (a `draft` left by `503 QUEUE_UNAVAILABLE` that then expires) stays in the storage. Originals of `failed` videos are retained by decision (`phase-03-videos/TD-12`); removing them is a management action of Phase 04.
- `draft` → `failed` with `PROCESSING_FAILED` when the assembled object's size differs from the declared one (the object is deleted; the client must start a new upload).
- `draft` → `processing` on a successful completion (back to `draft` if the enqueue fails).
- `processing` → `ready` when the worker writes `duration_seconds`, `metadata` and the thumbnail.
- `processing` → `failed` with `UNSUPPORTED_MEDIA` (ffprobe rejects the file; no retry) or `PROCESSING_FAILED` (retries exhausted or job stalled past the limit).

### Queue and worker

- Redis + BullMQ (`@nestjs/bullmq`). Queue `video-processing`, job `process-video` with data `{ videoId }` and `jobId = videoId`. `VideoProcessingProducer.enqueue` first looks up the job with that id: `waiting`/`active`/`delayed` → kept (a repeated completion does not create a second job); `failed`/`completed` → removed and added again, so repeating `upload/complete` recovers a video left in `processing` by a job whose failure was not written. The whole enqueue is bounded by `QUEUE_ENQUEUE_TIMEOUT_MS` (default `5000`): with Redis down at boot, `add()` would otherwise wait forever; the timeout becomes `503 QUEUE_UNAVAILABLE`. Key prefix from `QUEUE_PREFIX` (`streamtube` in dev). 3 attempts with exponential backoff (`QUEUE_BACKOFF_DELAY_MS`); constants in `src/queue/video-processing.constants.ts`.
- The API only produces (`VideoProcessingProducer`); the consumer (`VideoProcessingConsumer`, `@Processor('video-processing')`) lives only in `WorkerModule`, started by `src/worker/main.ts` in the `video-worker` container. Concurrency from `VIDEO_WORKER_CONCURRENCY` (default `1`).
- Processing: the worker signs an internal URL of the original and runs `ffprobe` (duration and metadata, container allowlist `mp4`/`mov`/`matroska`/`webm`) and `ffmpeg` (JPEG thumbnail), both spawned without a shell and with a 120 s timeout, then marks the video `ready`. Unsupported media raises `UnrecoverableError` (no retry); final failures are written by `@OnWorkerEvent('failed')`.
- FFmpeg comes from `Dockerfile.dev` (`apt install ... ffmpeg`). After changing the Dockerfile, run `docker compose up -d --build`.

### Storage

- MinIO, accessed with the AWS SDK v3 (`forcePathStyle`). One private bucket per environment: `S3_BUCKET` (`streamtube` in dev). Keys per video: `videos/{videoId}/original` and `videos/{videoId}/thumbnail.jpg` (`src/videos/video-storage-keys.ts`; `videoId` is the internal uuid, not the `public_id`).
- `StorageService` maps the SDK error names: only `NoSuchUpload` (ListParts/AbortMultipartUpload) and `NotFound`/`NoSuchKey` (HeadObject, confirmed by a `HeadBucket`, since a HEAD 404 has no body and a missing bucket is also `NotFound`) mean "missing"; `NoSuchBucket`, any other 404 on those reads, 5xx and network errors become `503 STORAGE_UNAVAILABLE`; `EntityTooSmall`/`InvalidPart`/`InvalidPartOrder` on `CompleteMultipartUpload` become `MultipartUploadRejectedException`, and `NoSuchUpload` there becomes `MultipartUploadMissingException`.
- Two endpoints, two `S3Client`s: `S3_ENDPOINT` (server-side operations and the worker's internal URLs; `http://minio:9000`) and `S3_PUBLIC_ENDPOINT` (signs the URLs handed to clients, as the client reaches the storage; `http://minio:9000` in `.env.example`, `http://localhost:9000` for a client running on the host).
- TTLs (`src/videos/videos.constants.ts`): part URLs 1 h; stream `clamp(2 × duration_seconds, 1 h, 12 h)` (1 h without a duration); download 1 h; thumbnail 1 h. MinIO expires abandoned multipart uploads after 24 h (`MINIO_API_STALE_UPLOADS_EXPIRY=24h`).

### Test isolation

- `src/test/setup-test-env.ts` (loaded by both Jest configs) forces `S3_BUCKET=streamtube-test`, `QUEUE_PREFIX=streamtube-test`, `S3_PUBLIC_ENDPOINT=S3_ENDPOINT` (URLs reachable from inside the container) and `QUEUE_BACKOFF_DELAY_MS=10`. The dev `video-worker` (prefix `streamtube`) never consumes a test job, and tests never touch the dev bucket.
- Helpers: `emptyTestBucket()` (`src/test/storage.ts`) and `obliterateTestQueue()` (`src/test/queue.ts`) refuse any bucket or prefix that does not contain `test`. `generateMediaFixtures()` (`src/test/media-fixtures.ts`) creates small media files with `ffmpeg` in a temp dir; no binary fixture is versioned.
- E2E suites that need processing start the worker **in-process** (`startInProcessWorker()` in `test/utils/worker.ts`: `WorkerModule` + `init()`), so the jobs run the current code under the test prefix. Only `test/video-worker.e2e-spec.ts` looks at the `video-worker` container (dev prefix).
- Storage, queue and FFmpeg are real in integration and e2e tests (MinIO, Redis, `ffmpeg`); only unit specs mock them.

### Corporate proxy on the host

On machines with a corporate proxy/VPN client, `localhost:9000` on the host can be intercepted (empty reply, `curl` exit `52`) even though MinIO is healthy; the console on `localhost:9001` keeps working. Run storage smoke tests inside the Docker network instead (`docker compose exec nestjs-api curl -f http://minio:9000/minio/health/live`), and keep `S3_PUBLIC_ENDPOINT=http://minio:9000` for anything that runs in the containers.

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
