import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import queueConfig from '../config/queue.config';
import { QueueModule } from './queue.module';
import { VIDEO_PROCESSING_QUEUE } from './video-processing.constants';
import { VideoProcessingProducer } from './video-processing.producer';

// API side only: with the offline queue disabled, add() fails at once when
// Redis is down instead of waiting for a reconnection. The worker keeps the default connection.
@Module({
  imports: [
    QueueModule,
    BullModule.registerQueueAsync({
      name: VIDEO_PROCESSING_QUEUE,
      inject: [queueConfig.KEY],
      useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
        connection: {
          host: cfg.host,
          port: cfg.port,
          enableOfflineQueue: false,
        },
      }),
    }),
  ],
  providers: [VideoProcessingProducer],
  exports: [VideoProcessingProducer],
})
export class VideoProcessingProducerModule {}
