> Part of the `testing-guide-nestjs-project` skill (see `../SKILL.md`).

# External System Strategies

How each external system is handled in tests. These strategies were confirmed with the team.

---

## PostgreSQL — Real (Docker)

**Strategy:** Real database via the Docker `db` service (already in `compose.yaml`).

**Connection config for tests:**
```typescript
{
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USERNAME ?? 'streamtube',
  password: process.env.DB_PASSWORD ?? 'streamtube',
  database: process.env.DB_DATABASE ?? 'streamtube',
  synchronize: true, // auto-create tables in test setup
}
```

**Test isolation:**
- Use `dataSource.query('DELETE FROM "table_name"')` to clean tables between tests
- Do NOT use `repository.delete({})` — throws `Empty criteria(s) are not allowed`
- Alternative: `repository.clear()` (truncates the table)
- For complex foreign key chains, delete in reverse dependency order or use `TRUNCATE ... CASCADE`
- Use `beforeEach` for cleanup to ensure each test starts with a clean state

**Entity setup:**
- Use `synchronize: true` in test DataSource to auto-create tables from entities
- For integration tests, import only the entities needed by the test — not all entities
- For E2E tests, import `AppModule` which includes all entities via their domain modules

---

## Object Storage — Real MinIO (Docker)

**Strategy:** Real S3-compatible storage via the Compose `minio` service in development and tests; AWS S3 in production (per `phase-03-videos/TD-02` and `phase-03-videos/TD-11`). A local-filesystem adapter is **not** used: it cannot exercise presigned multipart uploads, range (`206`) responses or the SDK checksum behavior, which are the contracts under test.

**Test isolation:**
- Tests use a dedicated bucket (e.g. `S3_BUCKET=streamtube-test`), created by the `minio-init` Compose service and forced by a Jest setup file loaded after `dotenv/config`.
- Inside the test container the public signing endpoint equals the internal one (`S3_PUBLIC_ENDPOINT` = `S3_ENDPOINT`), so presigned URLs are reachable from the tests.
- Clean the test bucket between tests with a helper that lists and deletes objects and aborts in-progress multipart uploads. The helper must **refuse to run** when the bucket name does not contain `test`.
- Never automate a multi-gigabyte transfer: real multipart tests use parts of 5 MiB (the S3 minimum) plus a small last part; the 10 GB limit is verified at validation level.

**Integration test shape:**
```typescript
describe('StorageService (integration)', () => {
  beforeEach(async () => {
    await emptyTestBucket(); // guarded: bucket name must contain "test"
  });

  it('should upload parts through presigned URLs and complete the object', async () => {
    const { uploadId } = await storageService.createMultipartUpload(key, 'video/mp4');
    const url = await storageService.presignUploadPart(key, uploadId, 1);
    await fetch(url, { method: 'PUT', body: partBuffer });

    await storageService.completeMultipartUpload(key, uploadId);

    const head = await storageService.headObject(key);
    expect(head.contentLength).toBe(partBuffer.length);
  });
});
```

---

## Message Queue — Real Redis + BullMQ (Docker)

**Strategy:** Real broker via the Compose `redis` service with BullMQ (per `phase-03-videos/TD-01` and `phase-03-videos/TD-11`).

**Test isolation:**
- Tests use a dedicated queue prefix (e.g. `QUEUE_PREFIX=streamtube-test`) forced by the Jest setup file, so the `video-worker` container (dev prefix) never consumes test jobs.
- Clean the test queue between tests with a guarded helper (`obliterate` only when the prefix contains `test`).
- For publisher tests: assert the job is enqueued with the correct name, data and `jobId`.
- For processor tests: call `processor.process(job)` directly with a job-shaped object — no broker round-trip — and assert the outcome in the database and storage.
- Close every `Queue`/`Worker` (`app.close()` / `module.close()`) in `afterAll`; open ioredis handles keep Jest alive.

**Setup pattern:**
```typescript
BullModule.forRootAsync({
  inject: [queueConfig.KEY],
  useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
    connection: { host: cfg.host, port: cfg.port },
    prefix: cfg.prefix, // streamtube-test in tests
  }),
}),
BullModule.registerQueue({ name: 'video-processing' }),
```

```typescript
it('should enqueue a processing job when the upload completes', async () => {
  await videosService.completeUpload(owner, publicId);

  const queue = module.get<Queue>(getQueueToken('video-processing'));
  const jobs = await queue.getJobs(['waiting']);
  expect(jobs.map((j) => j.data)).toEqual([{ videoId: video.id }]);
});
```

---

## Video Worker and FFmpeg — Real binaries

**Strategy:** `ffprobe`/`ffmpeg` are installed in the shared dev image and run for real in integration and e2e tests (per `phase-03-videos/TD-06` and `phase-03-videos/TD-11`).

- Generate fixtures at test time with `ffmpeg -f lavfi` into `os.tmpdir()` of the container (e.g. a few seconds of `testsrc` + `sine`, a faststart MP4, an MP4 with the moov atom at the end, random bytes, audio-only). Do not commit binary fixtures.
- Fail fast in `beforeAll` when `ffprobe -version` is not available (the image must be rebuilt after the Dockerfile change).
- E2E boots the worker module **in-process** (same test prefix and database) so processing always runs the current code; the `video-worker` container is verified separately by a liveness test (a worker is registered on the dev queue).
- The processor must be a no-op for a video that no longer exists, because test suites delete rows from the shared database.

---

## Email — Mailpit (Real SMTP Capture)

**Strategy:** Mailpit — a local SMTP server that captures all emails for inspection via its API. No emails are actually delivered.

**Setup:**
- Add Mailpit to `compose.yaml`:
```yaml
mailpit:
  image: axllent/mailpit
  ports:
    - "1025:1025"   # SMTP
    - "8025:8025"   # Web UI / API
```

**NestJS configuration:**
```typescript
// In mail module or config
{
  transport: {
    host: process.env.SMTP_HOST ?? 'localhost',
    port: Number(process.env.SMTP_PORT ?? 1025),
  },
}
```

**Integration test:**
```typescript
describe('MailService (integration)', () => {
  beforeEach(async () => {
    // Clear all captured emails via Mailpit API
    await fetch('http://localhost:8025/api/v1/messages', { method: 'DELETE' });
  });

  it('should send confirmation email', async () => {
    await mailService.sendConfirmation('user@test.com', 'token-123');

    // Query Mailpit API for captured emails
    const response = await fetch('http://localhost:8025/api/v1/messages');
    const data = await response.json();

    expect(data.messages).toHaveLength(1);
    expect(data.messages[0].To[0].Address).toBe('user@test.com');
    expect(data.messages[0].Subject).toContain('confirm');
  });
});
```

**Key points:**
- Mailpit captures ALL emails — no mocking, no side effects
- Use Mailpit's REST API (`http://localhost:8025/api/v1/messages`) to inspect sent emails
- Clear captured emails in `beforeEach` to ensure test isolation
- Web UI at `http://localhost:8025` for manual debugging
- Tests the full SMTP transport path — if the SMTP config is wrong, the test fails
