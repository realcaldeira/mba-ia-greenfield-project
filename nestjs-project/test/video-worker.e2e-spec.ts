import { Queue } from 'bullmq';
import queueConfig from '../src/config/queue.config';
import { VIDEO_PROCESSING_QUEUE } from '../src/queue/video-processing.constants';

// The `video-worker` container consumes the development queue. The test setup
// forces the test prefix on every suite, so the dev prefix is set here
// explicitly, read-only: the queue is only used to list connected workers.
const DEV_QUEUE_PREFIX = 'streamtube';

describe('video-worker', () => {
  it('should have at least one worker registered on the dev video-processing queue', async () => {
    const { host, port } = queueConfig();
    const queue = new Queue(VIDEO_PROCESSING_QUEUE, {
      connection: { host, port },
      prefix: DEV_QUEUE_PREFIX,
    });

    try {
      const workers = await queue.getWorkers();

      expect(workers.length).toBeGreaterThanOrEqual(1);
    } finally {
      await queue.close();
    }
  });
});
