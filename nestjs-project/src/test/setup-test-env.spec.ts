import { S3Client } from '@aws-sdk/client-s3';
import type { Queue } from 'bullmq';
import { obliterateTestQueue } from './queue';
import { assertTestResource } from './setup-test-env';
import { emptyTestBucket } from './storage';

describe('setup-test-env', () => {
  it('should force the test bucket', () => {
    expect(process.env.S3_BUCKET).toBe('streamtube-test');
  });

  it('should force the test queue prefix', () => {
    expect(process.env.QUEUE_PREFIX).toBe('streamtube-test');
  });

  it('should sign presigned URLs against the internal storage endpoint', () => {
    expect(process.env.S3_PUBLIC_ENDPOINT).toBe(process.env.S3_ENDPOINT);
  });

  it('should shorten the queue retry backoff', () => {
    expect(process.env.QUEUE_BACKOFF_DELAY_MS).toBe('10');
  });
});

describe('assertTestResource', () => {
  it('should accept a resource name containing "test"', () => {
    expect(() => assertTestResource('streamtube-test')).not.toThrow();
  });

  it.each(['streamtube', ''])(
    'should refuse the resource name "%s"',
    (name) => {
      expect(() => assertTestResource(name)).toThrow(/Refusing to touch/);
    },
  );
});

describe('test resource guards', () => {
  const originalBucket = process.env.S3_BUCKET;

  afterEach(() => {
    process.env.S3_BUCKET = originalBucket;
    jest.restoreAllMocks();
  });

  it('should refuse to empty a non-test bucket before calling the storage', async () => {
    process.env.S3_BUCKET = 'streamtube';
    const send = jest.spyOn(S3Client.prototype, 'send');

    await expect(emptyTestBucket()).rejects.toThrow(
      /Refusing to touch "streamtube"/,
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('should refuse to obliterate a queue without a test prefix', async () => {
    const obliterate = jest.fn();
    const queue = {
      opts: { prefix: 'streamtube' },
      obliterate,
    } as unknown as Queue;

    await expect(obliterateTestQueue(queue)).rejects.toThrow(
      /Refusing to touch "streamtube"/,
    );
    expect(obliterate).not.toHaveBeenCalled();
  });

  it('should force-obliterate a queue with the test prefix', async () => {
    const obliterate = jest.fn().mockResolvedValue(undefined);
    const queue = {
      opts: { prefix: 'streamtube-test' },
      obliterate,
    } as unknown as Queue;

    await obliterateTestQueue(queue);

    expect(obliterate).toHaveBeenCalledWith({ force: true });
  });
});
