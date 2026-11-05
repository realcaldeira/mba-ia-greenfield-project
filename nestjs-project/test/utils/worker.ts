import { Test, type TestingModule } from '@nestjs/testing';
import { WorkerModule } from '../../src/worker/worker.module';

// Boots the video worker in the Jest process, with no HTTP layer. It shares the
// test queue prefix, bucket and database forced by src/test/setup-test-env.ts,
// so processing always runs the current code and the dev `video-worker`
// container never sees the jobs. init() starts the BullMQ worker; close() stops
// it (waiting for the active job) and releases its Redis and DB connections.
export async function startInProcessWorker(): Promise<TestingModule> {
  const workerContext = await Test.createTestingModule({
    imports: [WorkerModule],
  }).compile();
  await workerContext.init();
  return workerContext;
}
