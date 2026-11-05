import { WorkerHost } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { ModulesContainer } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { createTestDataSource } from '../test/create-test-data-source';
import { ALL_ENTITIES } from '../test/test-entities';
import { VideosController } from './videos.controller';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

describe('VideosModule', () => {
  it('should compile with the controller and service, and no queue consumer', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        VideosModule,
      ],
    }).compile();

    expect(moduleRef.get(VideosService)).toBeInstanceOf(VideosService);
    expect(moduleRef.get(VideosController)).toBeInstanceOf(VideosController);

    // The API process must never consume jobs: no provider in the whole graph
    // may be a BullMQ consumer (every consumer extends WorkerHost).
    const consumers = [...moduleRef.get(ModulesContainer).values()]
      .flatMap((module) => [...module.providers.values()])
      .filter((wrapper) => wrapper.instance instanceof WorkerHost)
      .map((wrapper) => String(wrapper.name));
    expect(consumers).toEqual([]);

    await moduleRef.close();
  }, 30_000);
});
