import type { Queue } from 'bullmq';
import { assertTestResource } from './setup-test-env';

// Removes every job of the given queue. Refuses to run when the queue's Redis
// prefix lacks "test", so it can never wipe the development queue.
export async function obliterateTestQueue(queue: Queue): Promise<void> {
  assertTestResource(queue.opts.prefix ?? '');
  await queue.obliterate({ force: true });
}
