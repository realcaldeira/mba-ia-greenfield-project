import { Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import queueConfig from '../config/queue.config';
import { VIDEO_PROCESSING_QUEUE } from '../queue/video-processing.constants';
import { WorkerModule } from './worker.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  // SIGTERM (docker compose stop/restart) closes the BullMQ workers, which
  // wait for the active job, and the queues before the process exits.
  // `useProcessExit` ends with code 0 instead of re-raising the signal (143).
  app.enableShutdownHooks([], { useProcessExit: true });

  const queue = app.get<ConfigType<typeof queueConfig>>(queueConfig.KEY);
  new Logger('VideoWorker').log(
    `Video worker started: queue "${VIDEO_PROCESSING_QUEUE}", prefix "${queue.prefix}", concurrency ${queue.workerConcurrency}`,
  );
}
void bootstrap();
