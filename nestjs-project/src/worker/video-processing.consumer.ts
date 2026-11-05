import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { type Job, UnrecoverableError } from 'bullmq';
import { Repository } from 'typeorm';
import queueConfig from '../config/queue.config';
import {
  type ProcessVideoJobData,
  VIDEO_PROCESSING_QUEUE,
} from '../queue/video-processing.constants';
import { StorageService } from '../storage/storage.service';
import {
  Video,
  VideoProcessingError,
  VideoStatus,
} from '../videos/entities/video.entity';
import { originalKey } from '../videos/video-storage-keys';
import { MediaProbeService } from './media/media-probe.service';
import { UnsupportedMediaError } from './media/media.errors';
import type { ProbeResult } from './media/probe-parser';
import { ThumbnailService } from './media/thumbnail.service';

// TTL of the internal URL ffprobe/ffmpeg read the original from (TD-06).
const ORIGINAL_URL_TTL_SECONDS = 3600;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Consumes `process-video` jobs in the video worker process only: it must never
// be registered in the API module graph.
@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessingConsumer
  extends WorkerHost
  implements OnApplicationBootstrap
{
  private readonly logger = new Logger(VideoProcessingConsumer.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storage: StorageService,
    private readonly mediaProbe: MediaProbeService,
    private readonly thumbnails: ThumbnailService,
    @Inject(queueConfig.KEY)
    private readonly queue: ConfigType<typeof queueConfig>,
  ) {
    super();
  }

  // The worker exists only after onModuleInit (BullMQ registration).
  onApplicationBootstrap(): void {
    this.worker.concurrency = this.queue.workerConcurrency;
  }

  // Always rethrows: a failure becomes a retry (transient errors) or a final
  // failure (UnrecoverableError); the final state is written by onFailed.
  async process(job: Job<ProcessVideoJobData>): Promise<void> {
    const { videoId } = job.data;
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
    });

    // At-least-once delivery: a missing video (deleted rows) or one that left
    // `processing` through another path makes the job a no-op.
    if (!video || video.status !== VideoStatus.PROCESSING) {
      this.logger.log(
        `Skipping video ${videoId}: ${video ? `status is ${video.status}` : 'not found'}`,
      );
      return;
    }

    const probe = await this.probeOriginal(video.id);
    const jpeg = await this.thumbnails.generate(
      await this.signOriginal(video.id),
      probe.duration_seconds,
    );
    const thumbnailKey = await this.thumbnails.store(video.id, jpeg);

    const result = await this.videoRepository.update(
      { id: video.id, status: VideoStatus.PROCESSING },
      {
        status: VideoStatus.READY,
        duration_seconds: probe.duration_seconds,
        metadata: probe.metadata,
        thumbnail_key: thumbnailKey,
        processing_error: null,
      },
    );
    if (!result.affected) {
      this.logger.log(
        `Video ${video.id} left processing before it became ready; nothing updated`,
      );
    }
  }

  // Last stop of a failed attempt. Writes `failed` only when no retry is left:
  // UnrecoverableError (unsupported media, or a job stalled past the limit) or
  // exhausted attempts. It is an event handler, so it logs instead of rethrowing.
  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<ProcessVideoJobData> | undefined,
    error: Error,
  ): Promise<void> {
    if (!job) return;

    try {
      const unrecoverable = error instanceof UnrecoverableError;
      const exhausted =
        unrecoverable || job.attemptsMade >= (job.opts.attempts ?? 1);
      if (!exhausted) return;

      const processingError =
        unrecoverable &&
        error.message === (VideoProcessingError.UNSUPPORTED_MEDIA as string)
          ? VideoProcessingError.UNSUPPORTED_MEDIA
          : VideoProcessingError.PROCESSING_FAILED;

      const result = await this.videoRepository.update(
        { id: job.data.videoId, status: VideoStatus.PROCESSING },
        { status: VideoStatus.FAILED, processing_error: processingError },
      );
      this.logger.warn(
        `Video ${job.data.videoId} failed after ${job.attemptsMade} attempt(s) with ${processingError}: ${error.message}` +
          (result.affected ? '' : ' (already out of processing; not updated)'),
      );
    } catch (err) {
      this.logger.error(
        `Could not record the failure of video ${job.data.videoId}: ${messageOf(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
    }
  }

  private async probeOriginal(videoId: string): Promise<ProbeResult> {
    try {
      return await this.mediaProbe.probe(await this.signOriginal(videoId));
    } catch (err) {
      if (err instanceof UnsupportedMediaError) {
        this.logger.warn(`Video ${videoId}: ${err.message}`);
        throw new UnrecoverableError(VideoProcessingError.UNSUPPORTED_MEDIA);
      }
      throw err;
    }
  }

  // Signed right before each ffprobe/ffmpeg run, by the internal client.
  private async signOriginal(videoId: string): Promise<string> {
    return this.storage.presignGetObject(originalKey(videoId), {
      expiresIn: ORIGINAL_URL_TTL_SECONDS,
      audience: 'internal',
    });
  }
}
