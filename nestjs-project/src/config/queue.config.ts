import { registerAs } from '@nestjs/config';

export default registerAs('queue', () => ({
  host: process.env.REDIS_HOST || 'redis',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  // Redis key prefix; tests force a dedicated prefix so the dev worker never consumes their jobs.
  prefix: process.env.QUEUE_PREFIX || 'streamtube',
  backoffDelayMs: parseInt(process.env.QUEUE_BACKOFF_DELAY_MS || '1000', 10),
  // Upper bound of one enqueue: with Redis down at boot, add() would wait forever.
  enqueueTimeoutMs: parseInt(
    process.env.QUEUE_ENQUEUE_TIMEOUT_MS || '5000',
    10,
  ),
  workerConcurrency: parseInt(process.env.VIDEO_WORKER_CONCURRENCY || '1', 10),
}));
