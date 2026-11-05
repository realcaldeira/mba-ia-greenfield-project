import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { getQueueToken } from '@nestjs/bullmq';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
} from '../queue/video-processing.constants';
import { StorageService } from '../storage/storage.service';
import { cleanAllTables } from '../test/create-test-data-source';
import {
  generateMediaFixtures,
  removeMediaFixtures,
  type MediaFixtures,
} from '../test/media-fixtures';
import { obliterateTestQueue } from '../test/queue';
import { emptyTestBucket } from '../test/storage';
import { User } from '../users/entities/user.entity';
import {
  Video,
  VideoProcessingError,
  VideoStatus,
} from '../videos/entities/video.entity';
import { generatePublicId } from '../videos/public-id.util';
import { originalKey, thumbnailKey } from '../videos/video-storage-keys';
import { MediaProbeService } from './media/media-probe.service';
import { VideoProcessingConsumer } from './video-processing.consumer';
import { WorkerModule } from './worker.module';

const METADATA_KEYS = [
  'audio_codec',
  'bit_rate',
  'format_name',
  'frame_rate',
  'height',
  'video_codec',
  'width',
];
const WAIT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 100;

async function waitFor<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = WAIT_TIMEOUT_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) {
      throw new Error(`Condition not met within ${timeoutMs} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

interface WorkerHarness {
  moduleRef: TestingModule;
  dataSource: DataSource;
  videos: Repository<Video>;
  storage: StorageService;
  queue: Queue;
}

// Boots the worker in-process: WorkerModule under the test prefix and bucket,
// with init() so BullMQ starts consuming and the concurrency is applied.
async function startWorker(): Promise<WorkerHarness> {
  const moduleRef = await Test.createTestingModule({
    imports: [WorkerModule],
  }).compile();
  await moduleRef.init();
  const dataSource = moduleRef.get(DataSource);
  return {
    moduleRef,
    dataSource,
    videos: dataSource.getRepository(Video),
    storage: moduleRef.get(StorageService),
    queue: moduleRef.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE)),
  };
}

async function resetState(harness: WorkerHarness): Promise<void> {
  await obliterateTestQueue(harness.queue);
  await cleanAllTables(harness.dataSource);
  await emptyTestBucket();
}

let counter = 0;
async function createChannel(dataSource: DataSource): Promise<Channel> {
  const n = ++counter;
  const user = await dataSource.getRepository(User).save({
    email: `video_worker_${n}_${Date.now()}@example.com`,
    password: 'hashed',
  });
  return dataSource.getRepository(Channel).save({
    name: `Worker Channel ${n}`,
    nickname: `worker_${n}_${Date.now()}`,
    user_id: user.id,
  });
}

async function insertVideo(
  harness: WorkerHarness,
  channel: Channel,
  status: VideoStatus,
): Promise<Video> {
  const video = harness.videos.create({
    id: randomUUID(),
    public_id: generatePublicId(),
    channel_id: channel.id,
    title: 'Worker test video',
    original_filename: 'video.mp4',
    mime_type: 'video/mp4',
    size_bytes: 1,
    status,
    processing_error: null,
    upload_id: 'completed-upload',
    upload_expires_at: new Date(Date.now() + 3600_000),
  });
  await harness.videos.insert(video);
  return video;
}

async function uploadOriginal(
  harness: WorkerHarness,
  video: Video,
  path: string,
): Promise<void> {
  await harness.storage.putObject(
    originalKey(video.id),
    await readFile(path),
    'video/mp4',
  );
}

async function enqueue(harness: WorkerHarness, video: Video): Promise<void> {
  await harness.queue.add(
    PROCESS_VIDEO_JOB,
    { videoId: video.id },
    { jobId: video.id },
  );
}

async function waitUntilSettled(
  harness: WorkerHarness,
  video: Video,
): Promise<Video> {
  return waitFor(
    () => harness.videos.findOneByOrFail({ id: video.id }),
    (row) => row.status !== VideoStatus.PROCESSING,
  );
}

describe('VideoProcessingConsumer (integration)', () => {
  let fixtures: MediaFixtures;

  beforeAll(async () => {
    fixtures = await generateMediaFixtures();
  }, 60_000);

  afterAll(async () => {
    if (fixtures) await removeMediaFixtures(fixtures);
  });

  describe('with the default concurrency', () => {
    let harness: WorkerHarness;
    let channel: Channel;

    beforeAll(async () => {
      harness = await startWorker();
    }, 60_000);

    afterAll(async () => {
      if (!harness) return;
      await resetState(harness);
      await harness.moduleRef.close();
    });

    beforeEach(async () => {
      await resetState(harness);
      channel = await createChannel(harness.dataSource);
    });

    it('should take a valid MP4 to ready with duration, the seven metadata keys and a stored thumbnail', async () => {
      const video = await insertVideo(harness, channel, VideoStatus.PROCESSING);
      await uploadOriginal(harness, video, fixtures.faststartMp4);

      await enqueue(harness, video);
      const row = await waitUntilSettled(harness, video);

      expect(row.status).toBe(VideoStatus.READY);
      expect(row.processing_error).toBeNull();
      expect(row.duration_seconds).toBeCloseTo(fixtures.durationSeconds, 1);
      expect(Object.keys(row.metadata ?? {}).sort()).toEqual(METADATA_KEYS);
      expect(row.metadata).toMatchObject({ width: 1920, height: 1080 });
      expect(row.thumbnail_key).toBe(thumbnailKey(video.id));
      await expect(
        harness.storage.headObject(thumbnailKey(video.id)),
      ).resolves.toEqual({ contentLength: expect.any(Number) as number });
    });

    it('should fail audio-only media with UNSUPPORTED_MEDIA after a single attempt', async () => {
      const video = await insertVideo(harness, channel, VideoStatus.PROCESSING);
      await uploadOriginal(harness, video, fixtures.audioOnly);

      await enqueue(harness, video);
      const row = await waitUntilSettled(harness, video);

      expect(row.status).toBe(VideoStatus.FAILED);
      expect(row.processing_error).toBe(VideoProcessingError.UNSUPPORTED_MEDIA);
      const job = await harness.queue.getJob(video.id);
      expect(job?.attemptsMade).toBe(1);
      await expect(
        harness.storage.headObject(thumbnailKey(video.id)),
      ).resolves.toBeNull();
    });

    it('should retry a missing original three times and then fail with PROCESSING_FAILED', async () => {
      const video = await insertVideo(harness, channel, VideoStatus.PROCESSING);

      await enqueue(harness, video);
      const row = await waitUntilSettled(harness, video);

      expect(row.status).toBe(VideoStatus.FAILED);
      expect(row.processing_error).toBe(VideoProcessingError.PROCESSING_FAILED);
      const job = await harness.queue.getJob(video.id);
      expect(job?.attemptsMade).toBe(3);
    });

    it('should complete a job for a video that is already ready without changing the row', async () => {
      const video = await insertVideo(harness, channel, VideoStatus.READY);
      await uploadOriginal(harness, video, fixtures.faststartMp4);
      const before = await harness.videos.findOneByOrFail({ id: video.id });

      await enqueue(harness, video);
      // removeOnComplete: the job disappears once it completes.
      await waitFor(
        () => harness.queue.getJob(video.id),
        (job) => job === undefined,
      );

      const after = await harness.videos.findOneByOrFail({ id: video.id });
      expect(after).toEqual(before);
      await expect(
        harness.storage.headObject(thumbnailKey(video.id)),
      ).resolves.toBeNull();
    });

    it('should complete a job for a video that no longer exists', async () => {
      const videoId = randomUUID();

      await harness.queue.add(
        PROCESS_VIDEO_JOB,
        { videoId },
        { jobId: videoId },
      );

      await expect(
        waitFor(
          () => harness.queue.getJob(videoId),
          (job) => job === undefined,
        ),
      ).resolves.toBeUndefined();
    });
  });

  describe('with VIDEO_WORKER_CONCURRENCY=2', () => {
    let harness: WorkerHarness;
    let previousConcurrency: string | undefined;

    beforeAll(async () => {
      previousConcurrency = process.env.VIDEO_WORKER_CONCURRENCY;
      process.env.VIDEO_WORKER_CONCURRENCY = '2';
      harness = await startWorker();
      await resetState(harness);
    }, 60_000);

    afterAll(async () => {
      if (previousConcurrency === undefined) {
        delete process.env.VIDEO_WORKER_CONCURRENCY;
      } else {
        process.env.VIDEO_WORKER_CONCURRENCY = previousConcurrency;
      }
      jest.restoreAllMocks();
      if (!harness) return;
      await resetState(harness);
      await harness.moduleRef.close();
    });

    it('should process two jobs at the same time', async () => {
      const consumer = harness.moduleRef.get(VideoProcessingConsumer);
      const probeService = harness.moduleRef.get(MediaProbeService);
      // The thumbnail still runs for real on the original; only the probe is held.
      const probeResult = {
        duration_seconds: fixtures.durationSeconds,
        metadata: {
          width: 1920,
          height: 1080,
          video_codec: 'h264',
          audio_codec: 'aac',
          bit_rate: 586829,
          frame_rate: 30,
          format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
        },
      };
      let active = 0;
      let maxActive = 0;
      // Holds each probe until a second one is running (or 5 s pass), so the
      // overlap is observable whatever the scheduling.
      jest.spyOn(probeService, 'probe').mockImplementation(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await waitFor(
          () => Promise.resolve(maxActive),
          (value) => value >= 2,
          5_000,
        ).catch(() => undefined);
        active--;
        return probeResult;
      });
      const channel = await createChannel(harness.dataSource);
      const videos = [
        await insertVideo(harness, channel, VideoStatus.PROCESSING),
        await insertVideo(harness, channel, VideoStatus.PROCESSING),
      ];
      for (const video of videos) {
        await uploadOriginal(harness, video, fixtures.faststartMp4);
      }

      for (const video of videos) await enqueue(harness, video);
      const rows = await Promise.all(
        videos.map((video) => waitUntilSettled(harness, video)),
      );

      expect(consumer.worker.concurrency).toBe(2);
      expect(maxActive).toBe(2);
      expect(rows.map((row) => row.status)).toEqual([
        VideoStatus.READY,
        VideoStatus.READY,
      ]);
    });
  });
});
