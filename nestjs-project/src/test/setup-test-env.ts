// Jest setup file, loaded after `dotenv/config` by both the unit/integration and
// the e2e configs. It isolates every suite from the development resources: tests
// only ever touch the `streamtube-test` bucket and the `streamtube-test` queue
// prefix, so the dev worker never consumes a test job.

const TEST_RESOURCE_MARKER = 'test';

process.env.S3_BUCKET = 'streamtube-test';
process.env.QUEUE_PREFIX = 'streamtube-test';
// Presigned URLs must be reachable from inside the test container.
process.env.S3_PUBLIC_ENDPOINT = process.env.S3_ENDPOINT ?? 'http://minio:9000';
// Keeps retry backoff short so failure paths finish quickly in tests.
process.env.QUEUE_BACKOFF_DELAY_MS = '10';

export function assertTestResource(name: string): void {
  if (!name.includes(TEST_RESOURCE_MARKER)) {
    throw new Error(
      `Refusing to touch "${name}": test helpers only operate on resources whose name contains "${TEST_RESOURCE_MARKER}"`,
    );
  }
}
