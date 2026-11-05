import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import queueConfig from '../config/queue.config';
import { QueueUnavailableException } from './queue.exceptions';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
} from './video-processing.constants';
import { VideoProcessingProducer } from './video-processing.producer';

const VIDEO_ID = '3f0f7f6e-2d7a-4c37-9d1f-4f1c2a0b9e11';
const ENQUEUE_TIMEOUT_MS = 5000;

type ExistingJob = {
  getState: jest.Mock<Promise<string>, []>;
  remove: jest.Mock<Promise<void>, []>;
};

describe('VideoProcessingProducer', () => {
  let producer: VideoProcessingProducer;
  let add: jest.Mock<Promise<unknown>, unknown[]>;
  let getJob: jest.Mock<Promise<ExistingJob | undefined>, [string]>;

  beforeEach(async () => {
    add = jest.fn<Promise<unknown>, unknown[]>().mockResolvedValue({});
    getJob = jest
      .fn<Promise<ExistingJob | undefined>, [string]>()
      .mockResolvedValue(undefined);
    const moduleRef = await Test.createTestingModule({
      providers: [
        VideoProcessingProducer,
        {
          provide: getQueueToken(VIDEO_PROCESSING_QUEUE),
          useValue: { add, getJob },
        },
        {
          provide: queueConfig.KEY,
          useValue: { enqueueTimeoutMs: ENQUEUE_TIMEOUT_MS },
        },
      ],
    }).compile();
    producer = moduleRef.get(VideoProcessingProducer);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function existingJob(state: string): ExistingJob {
    return {
      getState: jest.fn<Promise<string>, []>().mockResolvedValue(state),
      remove: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
    };
  }

  it('should add the job keyed by the video id when none exists', async () => {
    await producer.enqueue(VIDEO_ID);

    expect(getJob).toHaveBeenCalledWith(VIDEO_ID);
    expect(add).toHaveBeenCalledWith(
      PROCESS_VIDEO_JOB,
      { videoId: VIDEO_ID },
      { jobId: VIDEO_ID },
    );
  });

  it.each(['failed', 'completed'])(
    'should remove a %s job with the same id before adding it again',
    async (state) => {
      const job = existingJob(state);
      getJob.mockResolvedValue(job);

      await producer.enqueue(VIDEO_ID);

      expect(job.remove).toHaveBeenCalledTimes(1);
      expect(add).toHaveBeenCalledTimes(1);
      expect(job.remove.mock.invocationCallOrder[0]).toBeLessThan(
        add.mock.invocationCallOrder[0],
      );
    },
  );

  it.each(['waiting', 'active', 'delayed'])(
    'should keep a %s job and add nothing',
    async (state) => {
      const job = existingJob(state);
      getJob.mockResolvedValue(job);

      await producer.enqueue(VIDEO_ID);

      expect(job.remove).not.toHaveBeenCalled();
      expect(add).not.toHaveBeenCalled();
    },
  );

  it('should convert a rejected add() into QueueUnavailableException', async () => {
    // What ioredis raises with enableOfflineQueue: false while Redis is down.
    add.mockRejectedValue(
      new Error(
        "Stream isn't writeable and enableOfflineQueue options is false",
      ),
    );

    const promise = producer.enqueue(VIDEO_ID);

    await expect(promise).rejects.toBeInstanceOf(QueueUnavailableException);
    await expect(promise).rejects.toMatchObject({
      httpStatus: 503,
      errorCode: 'QUEUE_UNAVAILABLE',
      message: 'Processing queue is unavailable',
    });
  });

  it('should convert a rejected getJob() into QueueUnavailableException', async () => {
    getJob.mockRejectedValue(new Error('Connection is closed.'));

    await expect(producer.enqueue(VIDEO_ID)).rejects.toBeInstanceOf(
      QueueUnavailableException,
    );
    expect(add).not.toHaveBeenCalled();
  });

  it('should give up with QueueUnavailableException when add() never settles', async () => {
    jest.useFakeTimers();
    // Redis down at boot: the queue waits for a connection that never comes.
    add.mockReturnValue(new Promise<unknown>(() => undefined));

    const promise = producer.enqueue(VIDEO_ID);
    const settled = expect(promise).rejects.toBeInstanceOf(
      QueueUnavailableException,
    );
    await jest.advanceTimersByTimeAsync(ENQUEUE_TIMEOUT_MS - 1);
    expect(jest.getTimerCount()).toBe(1);
    await jest.advanceTimersByTimeAsync(1);

    await settled;
    expect(jest.getTimerCount()).toBe(0);
  });

  it('should clear the timeout timer once the enqueue succeeds', async () => {
    jest.useFakeTimers();

    await producer.enqueue(VIDEO_ID);

    expect(add).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
});
