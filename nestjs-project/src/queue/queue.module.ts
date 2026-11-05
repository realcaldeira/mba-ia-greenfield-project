import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import queueConfig from '../config/queue.config';
import { VIDEO_PROCESSING_ATTEMPTS } from './video-processing.constants';

// Shared BullMQ configuration (connection, prefix, retries) for the API and the worker.
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [queueConfig.KEY],
      useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
        connection: { host: cfg.host, port: cfg.port },
        prefix: cfg.prefix,
        defaultJobOptions: {
          attempts: VIDEO_PROCESSING_ATTEMPTS,
          backoff: { type: 'exponential', delay: cfg.backoffDelayMs },
          removeOnComplete: true,
          removeOnFail: 1000,
        },
      }),
    }),
  ],
})
export class QueueModule {}
