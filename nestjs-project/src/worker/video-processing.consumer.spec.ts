import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { type Job, UnrecoverableError } from 'bullmq';
import queueConfig from '../config/queue.config';
import type { ProcessVideoJobData } from '../queue/video-processing.constants';
import { StorageService } from '../storage/storage.service';
import {
  Video,
  VideoProcessingError,
  VideoStatus,
  type VideoMetadata,
} from '../videos/entities/video.entity';
import { MediaProbeService } from './media/media-probe.service';
import {
  MediaProcessingError,
  UnsupportedMediaError,
} from './media/media.errors';
import { ThumbnailService } from './media/thumbnail.service';
import { VideoProcessingConsumer } from './video-processing.consumer';

const METADATA: VideoMetadata = {
  width: 1920,
  height: 1080,
  video_codec: 'h264',
  audio_codec: 'aac',
  bit_rate: 586829,
  frame_rate: 30,
  format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
};
const SIGNED_URL = 'http://minio:9000/streamtube-test/signed';

function jobFor(
  videoId: string,
  attemptsMade = 0,
  attempts = 3,
): Job<ProcessVideoJobData> {
  return {
    data: { videoId },
    attemptsMade,
    opts: { attempts },
  } as Job<ProcessVideoJobData>;
}

describe('VideoProcessingConsumer', () => {
  let consumer: VideoProcessingConsumer;
  let findOne: jest.Mock;
  let update: jest.Mock;
  let presignGetObject: jest.Mock;
  let probe: jest.Mock;
  let generate: jest.Mock;
  let store: jest.Mock;
  let videoId: string;

  function videoIn(status: VideoStatus): Partial<Video> {
    return { id: videoId, status };
  }

  beforeEach(async () => {
    videoId = randomUUID();
    findOne = jest.fn();
    update = jest.fn().mockResolvedValue({ affected: 1 });
    presignGetObject = jest.fn().mockResolvedValue(SIGNED_URL);
    probe = jest
      .fn()
      .mockResolvedValue({ duration_seconds: 3, metadata: METADATA });
    generate = jest.fn().mockResolvedValue(Buffer.from([0xff, 0xd8]));
    store = jest
      .fn()
      .mockImplementation((id: string) =>
        Promise.resolve(`videos/${id}/thumbnail.jpg`),
      );

    const moduleRef = await Test.createTestingModule({
      providers: [
        VideoProcessingConsumer,
        { provide: getRepositoryToken(Video), useValue: { findOne, update } },
        { provide: StorageService, useValue: { presignGetObject } },
        { provide: MediaProbeService, useValue: { probe } },
        { provide: ThumbnailService, useValue: { generate, store } },
        { provide: queueConfig.KEY, useValue: { workerConcurrency: 2 } },
      ],
    }).compile();
    consumer = moduleRef.get(VideoProcessingConsumer);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('process', () => {
    it('should do nothing when the video does not exist', async () => {
      findOne.mockResolvedValue(null);

      await expect(consumer.process(jobFor(videoId))).resolves.toBeUndefined();

      expect(presignGetObject).not.toHaveBeenCalled();
      expect(probe).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    });

    it.each([VideoStatus.DRAFT, VideoStatus.READY, VideoStatus.FAILED])(
      'should do nothing when the video is %s instead of processing',
      async (status) => {
        findOne.mockResolvedValue(videoIn(status));

        await expect(
          consumer.process(jobFor(videoId)),
        ).resolves.toBeUndefined();

        expect(probe).not.toHaveBeenCalled();
        expect(generate).not.toHaveBeenCalled();
        expect(update).not.toHaveBeenCalled();
      },
    );

    it('should probe and generate the thumbnail from internal URLs of the original', async () => {
      findOne.mockResolvedValue(videoIn(VideoStatus.PROCESSING));

      await consumer.process(jobFor(videoId));

      expect(presignGetObject).toHaveBeenCalledTimes(2);
      for (const [key, options] of presignGetObject.mock.calls) {
        expect(key).toBe(`videos/${videoId}/original`);
        expect(options).toEqual({ expiresIn: 3600, audience: 'internal' });
      }
      expect(probe).toHaveBeenCalledWith(SIGNED_URL);
      expect(generate).toHaveBeenCalledWith(SIGNED_URL, 3);
      expect(store).toHaveBeenCalledWith(videoId, Buffer.from([0xff, 0xd8]));
    });

    it('should mark the video ready with the probe result and the thumbnail key, only from processing', async () => {
      findOne.mockResolvedValue(videoIn(VideoStatus.PROCESSING));

      await consumer.process(jobFor(videoId));

      expect(update).toHaveBeenCalledWith(
        { id: videoId, status: VideoStatus.PROCESSING },
        {
          status: VideoStatus.READY,
          duration_seconds: 3,
          metadata: METADATA,
          thumbnail_key: `videos/${videoId}/thumbnail.jpg`,
          processing_error: null,
        },
      );
    });

    it('should finish without error when the conditional update affects no row', async () => {
      findOne.mockResolvedValue(videoIn(VideoStatus.PROCESSING));
      update.mockResolvedValue({ affected: 0 });

      await expect(consumer.process(jobFor(videoId))).resolves.toBeUndefined();
    });

    it('should turn UnsupportedMediaError into UnrecoverableError(UNSUPPORTED_MEDIA)', async () => {
      findOne.mockResolvedValue(videoIn(VideoStatus.PROCESSING));
      probe.mockRejectedValue(new UnsupportedMediaError('no video stream'));

      const error = await consumer
        .process(jobFor(videoId))
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(UnrecoverableError);
      expect((error as Error).message).toBe('UNSUPPORTED_MEDIA');
      expect(generate).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    });

    it('should rethrow a transient probe error as-is for a retry', async () => {
      findOne.mockResolvedValue(videoIn(VideoStatus.PROCESSING));
      const transient = new MediaProcessingError('ffprobe', 'exit code 1');
      probe.mockRejectedValue(transient);

      await expect(consumer.process(jobFor(videoId))).rejects.toBe(transient);
      expect(update).not.toHaveBeenCalled();
    });

    it('should rethrow a transient thumbnail error as-is for a retry', async () => {
      findOne.mockResolvedValue(videoIn(VideoStatus.PROCESSING));
      const transient = new MediaProcessingError('ffmpeg', 'no frame');
      generate.mockRejectedValue(transient);

      await expect(consumer.process(jobFor(videoId))).rejects.toBe(transient);
      expect(update).not.toHaveBeenCalled();
    });
  });

  describe('onFailed', () => {
    it('should do nothing without a job', async () => {
      await consumer.onFailed(undefined, new Error('boom'));

      expect(update).not.toHaveBeenCalled();
    });

    it('should not update the video while attempts remain', async () => {
      await consumer.onFailed(jobFor(videoId, 1, 3), new Error('transient'));

      expect(update).not.toHaveBeenCalled();
    });

    it('should mark the video failed with PROCESSING_FAILED once attempts are exhausted', async () => {
      await consumer.onFailed(jobFor(videoId, 3, 3), new Error('transient'));

      expect(update).toHaveBeenCalledWith(
        { id: videoId, status: VideoStatus.PROCESSING },
        {
          status: VideoStatus.FAILED,
          processing_error: VideoProcessingError.PROCESSING_FAILED,
        },
      );
    });

    it('should mark the video failed with UNSUPPORTED_MEDIA on UnrecoverableError, even on the first attempt', async () => {
      await consumer.onFailed(
        jobFor(videoId, 1, 3),
        new UnrecoverableError('UNSUPPORTED_MEDIA'),
      );

      expect(update).toHaveBeenCalledWith(
        { id: videoId, status: VideoStatus.PROCESSING },
        {
          status: VideoStatus.FAILED,
          processing_error: VideoProcessingError.UNSUPPORTED_MEDIA,
        },
      );
    });

    it('should mark a job stalled past the limit as PROCESSING_FAILED', async () => {
      // BullMQ fails such a job with this UnrecoverableError (deferred failure).
      await consumer.onFailed(
        jobFor(videoId, 0, 3),
        new UnrecoverableError('job stalled more than allowable limit'),
      );

      expect(update).toHaveBeenCalledWith(
        { id: videoId, status: VideoStatus.PROCESSING },
        {
          status: VideoStatus.FAILED,
          processing_error: VideoProcessingError.PROCESSING_FAILED,
        },
      );
    });

    it('should treat a job without attempts configured as exhausted after one attempt', async () => {
      const job = jobFor(videoId, 1);
      job.opts = {};

      await consumer.onFailed(job, new Error('transient'));

      expect(update).toHaveBeenCalledTimes(1);
    });

    it('should only log an error raised while recording the failure', async () => {
      const logError = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      update.mockRejectedValue(new Error('database down'));

      await expect(
        consumer.onFailed(jobFor(videoId, 3, 3), new Error('transient')),
      ).resolves.toBeUndefined();

      expect(logError).toHaveBeenCalledWith(
        expect.stringContaining('database down'),
        expect.any(String),
      );
    });
  });

  describe('onApplicationBootstrap', () => {
    it('should apply the configured concurrency to the worker', () => {
      const worker = { concurrency: 1 };
      Object.defineProperty(consumer, 'worker', { value: worker });

      consumer.onApplicationBootstrap();

      expect(worker.concurrency).toBe(2);
    });
  });
});
