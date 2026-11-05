import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import {
  VIDEO_PROCESSING_ATTEMPTS,
  VIDEO_PROCESSING_QUEUE,
} from './video-processing.constants';
import { VideoProcessingProducerModule } from './video-processing-producer.module';
import { VideoProcessingProducer } from './video-processing.producer';

describe('VideoProcessingProducerModule', () => {
  it('should compile and resolve the video-processing queue with the shared config', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        VideoProcessingProducerModule,
      ],
    }).compile();

    const cfg = moduleRef.get<ConfigType<typeof queueConfig>>(queueConfig.KEY);
    const queue = moduleRef.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));

    expect(moduleRef.get(VideoProcessingProducer)).toBeInstanceOf(
      VideoProcessingProducer,
    );
    expect(queue).toBeInstanceOf(Queue);
    expect(queue.name).toBe(VIDEO_PROCESSING_QUEUE);
    expect(queue.opts.prefix).toBe(cfg.prefix);
    expect(queue.opts.connection).toMatchObject({
      host: cfg.host,
      port: cfg.port,
      enableOfflineQueue: false,
    });
    expect(queue.defaultJobOptions).toMatchObject({
      attempts: VIDEO_PROCESSING_ATTEMPTS,
      backoff: { type: 'exponential', delay: cfg.backoffDelayMs },
      removeOnComplete: true,
      removeOnFail: 1000,
    });

    await moduleRef.close();
  });
});
