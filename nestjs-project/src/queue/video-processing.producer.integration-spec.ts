import { randomUUID } from 'node:crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { Queue, UnrecoverableError, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import queueConfig from '../config/queue.config';
import { obliterateTestQueue } from '../test/queue';
import { QueueUnavailableException } from './queue.exceptions';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_ATTEMPTS,
  VIDEO_PROCESSING_QUEUE,
} from './video-processing.constants';
import { VideoProcessingProducerModule } from './video-processing-producer.module';
import { VideoProcessingProducer } from './video-processing.producer';

const DEV_PREFIX = 'streamtube';
// Resolves nowhere (RFC 2606): the connection never becomes ready.
const UNREACHABLE_REDIS_HOST = 'redis.invalid';

describe('VideoProcessingProducer (integration)', () => {
  let moduleRef: TestingModule;
  let producer: VideoProcessingProducer;
  let queue: Queue;
  let cfg: ConfigType<typeof queueConfig>;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        VideoProcessingProducerModule,
      ],
    }).compile();
    producer = moduleRef.get(VideoProcessingProducer);
    queue = moduleRef.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    cfg = moduleRef.get(queueConfig.KEY);
    await queue.waitUntilReady();
  });

  afterAll(async () => {
    await obliterateTestQueue(queue);
    await moduleRef.close();
  });

  beforeEach(async () => {
    await obliterateTestQueue(queue);
  });

  it('should add a waiting process-video job keyed by the video id', async () => {
    const videoId = randomUUID();

    await producer.enqueue(videoId);

    const job = await queue.getJob(videoId);
    expect(job).toBeDefined();
    expect(job!.id).toBe(videoId);
    expect(job!.name).toBe(PROCESS_VIDEO_JOB);
    expect(job!.data).toEqual({ videoId });
    expect(job!.opts.attempts).toBe(VIDEO_PROCESSING_ATTEMPTS);
    expect(job!.opts.backoff).toEqual({
      type: 'exponential',
      delay: cfg.backoffDelayMs,
    });
    await expect(job!.getState()).resolves.toBe('waiting');
  });

  it('should keep a single job when the same video is enqueued twice', async () => {
    const videoId = randomUUID();

    await producer.enqueue(videoId);
    await producer.enqueue(videoId);

    const waiting = await queue.getWaiting();
    expect(waiting.map((job) => job.id)).toEqual([videoId]);
    await expect(queue.count()).resolves.toBe(1);
  });

  it('should write under the test prefix and never under the dev prefix', async () => {
    const videoId = randomUUID();

    await producer.enqueue(videoId);

    expect(cfg.prefix).toBe('streamtube-test');
    await expect(queue.getJob(videoId)).resolves.toBeDefined();

    // Plain Redis reads (EXISTS/KEYS): instantiating a bullmq Queue on the dev
    // prefix would itself write its meta hash there.
    const redis = new Redis({ host: cfg.host, port: cfg.port });
    try {
      await expect(
        redis.exists(`${cfg.prefix}:${VIDEO_PROCESSING_QUEUE}:${videoId}`),
      ).resolves.toBe(1);
      await expect(redis.keys(`${DEV_PREFIX}:*${videoId}*`)).resolves.toEqual(
        [],
      );
    } finally {
      redis.disconnect();
    }
  });

  // Runs one job of the test queue with `processor`, then stops the worker.
  async function runOnce(
    processor: () => Promise<void>,
    event: 'completed' | 'failed',
  ): Promise<void> {
    const worker = new Worker(VIDEO_PROCESSING_QUEUE, processor, {
      connection: { host: cfg.host, port: cfg.port },
      prefix: cfg.prefix,
    });
    try {
      await new Promise<void>((resolve) => worker.once(event, () => resolve()));
    } finally {
      await worker.close();
    }
  }

  it('should replace a failed job with the same id so the video can be processed again', async () => {
    const videoId = randomUUID();
    await producer.enqueue(videoId);
    await runOnce(() => {
      throw new UnrecoverableError('boom');
    }, 'failed');
    const failed = await queue.getJob(videoId);
    await expect(failed!.getState()).resolves.toBe('failed');

    await producer.enqueue(videoId);

    const job = await queue.getJob(videoId);
    await expect(job!.getState()).resolves.toBe('waiting');
    expect(job!.attemptsMade).toBe(0);
    expect(job!.failedReason).toBeFalsy();
    await expect(queue.getFailedCount()).resolves.toBe(0);
  });

  it('should replace a completed job kept in Redis', async () => {
    const videoId = randomUUID();
    await queue.add(
      PROCESS_VIDEO_JOB,
      { videoId },
      { jobId: videoId, removeOnComplete: false },
    );
    await runOnce(() => Promise.resolve(), 'completed');
    const completed = await queue.getJob(videoId);
    await expect(completed!.getState()).resolves.toBe('completed');

    await producer.enqueue(videoId);

    const job = await queue.getJob(videoId);
    await expect(job!.getState()).resolves.toBe('waiting');
    await expect(queue.getCompletedCount()).resolves.toBe(0);
  });

  it('should keep a delayed job instead of adding a second one', async () => {
    const videoId = randomUUID();
    await queue.add(
      PROCESS_VIDEO_JOB,
      { videoId },
      { jobId: videoId, delay: 60_000 },
    );

    await producer.enqueue(videoId);

    const job = await queue.getJob(videoId);
    await expect(job!.getState()).resolves.toBe('delayed');
    await expect(queue.count()).resolves.toBe(1);
  });

  it('should throw QueueUnavailableException within the timeout when Redis cannot be reached', async () => {
    const timeoutMs = 300;
    const unreachable = new Queue(VIDEO_PROCESSING_QUEUE, {
      connection: {
        host: UNREACHABLE_REDIS_HOST,
        port: cfg.port,
        enableOfflineQueue: false,
      },
      prefix: cfg.prefix,
    });
    // ioredis keeps retrying and the queue re-emits each connection error.
    unreachable.on('error', () => undefined);
    const offlineModule = await Test.createTestingModule({
      providers: [
        VideoProcessingProducer,
        {
          provide: getQueueToken(VIDEO_PROCESSING_QUEUE),
          useValue: unreachable,
        },
        {
          provide: queueConfig.KEY,
          useValue: { ...cfg, enqueueTimeoutMs: timeoutMs },
        },
      ],
    }).compile();
    const offlineProducer = offlineModule.get(VideoProcessingProducer);

    try {
      const startedAt = Date.now();

      await expect(
        offlineProducer.enqueue(randomUUID()),
      ).rejects.toBeInstanceOf(QueueUnavailableException);

      expect(Date.now() - startedAt).toBeLessThan(timeoutMs + 1000);
    } finally {
      // close() drops a connection still initializing; disconnect() would wait for it.
      await unreachable.close();
      await offlineModule.close();
    }
  });
});
