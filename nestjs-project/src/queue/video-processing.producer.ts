import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { JobState, Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import { QueueUnavailableException } from './queue.exceptions';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
  type ProcessVideoJobData,
} from './video-processing.constants';

// A job still to run: adding the same jobId again would be a no-op anyway.
const PENDING_JOB_STATES: ReadonlySet<JobState | 'unknown'> = new Set([
  'waiting',
  'delayed',
  'active',
  'prioritized',
  'waiting-children',
]);
// A finished job kept in Redis (removeOnFail keeps failed ones) would make the
// next add() with the same jobId a silent no-op; it is replaced instead.
const FINISHED_JOB_STATES: ReadonlySet<JobState | 'unknown'> = new Set([
  'failed',
  'completed',
]);

class EnqueueTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Enqueue did not finish within ${timeoutMs} ms`);
    this.name = EnqueueTimeoutError.name;
  }
}

// Bounds `operation` by `timeoutMs`; the timer is always cleared. A late
// rejection of `operation` stays handled by Promise.race.
async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new EnqueueTimeoutError(timeoutMs)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

@Injectable()
export class VideoProcessingProducer {
  private readonly logger = new Logger(VideoProcessingProducer.name);

  constructor(
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly queue: Queue<ProcessVideoJobData>,
    @Inject(queueConfig.KEY)
    private readonly config: ConfigType<typeof queueConfig>,
  ) {}

  // jobId = videoId. A job still pending (waiting, delayed, active) is kept, so
  // a repeated completion does not add a second one; a failed or completed job
  // is removed and added again, which lets a repeated completion recover a
  // video left in processing. Redis down or slow → QueueUnavailableException.
  async enqueue(videoId: string): Promise<void> {
    try {
      await withTimeout(this.addOrKeep(videoId), this.config.enqueueTimeoutMs);
    } catch (err) {
      this.logger.error(
        `Failed to enqueue ${PROCESS_VIDEO_JOB} for video ${videoId}`,
        err instanceof Error ? err.stack : String(err),
      );
      throw new QueueUnavailableException();
    }
  }

  private async addOrKeep(videoId: string): Promise<void> {
    const existing = await this.queue.getJob(videoId);
    if (existing) {
      const state = await existing.getState();
      if (PENDING_JOB_STATES.has(state)) {
        return;
      }
      if (FINISHED_JOB_STATES.has(state)) {
        await existing.remove();
      }
    }
    await this.queue.add(PROCESS_VIDEO_JOB, { videoId }, { jobId: videoId });
  }
}
