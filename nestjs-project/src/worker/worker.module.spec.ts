import { getQueueToken, WorkerHost } from '@nestjs/bullmq';
import type { ConfigType } from '@nestjs/config';
import { ModulesContainer } from '@nestjs/core';
import { Test, type TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import databaseConfig from '../config/database.config';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { VIDEO_PROCESSING_QUEUE } from '../queue/video-processing.constants';
import { StorageService } from '../storage/storage.service';
import { Video } from '../videos/entities/video.entity';
import { VideoProcessingConsumer } from './video-processing.consumer';
import { WorkerModule } from './worker.module';

describe('WorkerModule', () => {
  let moduleRef: TestingModule;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
  }, 30_000);

  afterAll(async () => {
    await moduleRef.close();
  });

  it('should load the shared config namespaces with the test overrides', () => {
    const queue = moduleRef.get<ConfigType<typeof queueConfig>>(
      queueConfig.KEY,
    );
    const storage = moduleRef.get<ConfigType<typeof storageConfig>>(
      storageConfig.KEY,
    );

    expect(moduleRef.get(databaseConfig.KEY)).toBeDefined();
    expect(queue.prefix).toBe('streamtube-test');
    expect(storage.bucket).toBe('streamtube-test');
  });

  it('should open the TypeORM connection and resolve the Video repository', () => {
    expect(moduleRef.get(DataSource).isInitialized).toBe(true);
    expect(moduleRef.get(getRepositoryToken(Video))).toBeInstanceOf(Repository);
  });

  it('should resolve the StorageService', () => {
    expect(moduleRef.get(StorageService)).toBeInstanceOf(StorageService);
  });

  it('should resolve the video-processing queue with the shared prefix and the default connection', () => {
    const cfg = moduleRef.get<ConfigType<typeof queueConfig>>(queueConfig.KEY);
    const queue = moduleRef.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));

    expect(queue).toBeInstanceOf(Queue);
    expect(queue.name).toBe(VIDEO_PROCESSING_QUEUE);
    expect(queue.opts.prefix).toBe(cfg.prefix);
    expect(queue.opts.connection).toMatchObject({
      host: cfg.host,
      port: cfg.port,
    });
    // Only the API producer disables the offline queue.
    expect(queue.opts.connection).not.toHaveProperty('enableOfflineQueue');
  });

  it('should register the VideoProcessingConsumer as the only queue consumer', () => {
    const consumers = [...moduleRef.get(ModulesContainer).values()]
      .flatMap((module) => [...module.providers.values()])
      .filter((wrapper) => wrapper.instance instanceof WorkerHost)
      .map((wrapper) => wrapper.instance);

    expect(consumers).toEqual([moduleRef.get(VideoProcessingConsumer)]);
  });

  it('should register no controller in the whole module graph', () => {
    const controllers = [...moduleRef.get(ModulesContainer).values()]
      .flatMap((module) => [...module.controllers.values()])
      .map((wrapper) => String(wrapper.name));

    expect(controllers).toEqual([]);
  });
});
