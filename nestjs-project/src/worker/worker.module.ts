import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { configModuleOptions } from '../config/config-module.options';
import databaseConfig from '../config/database.config';
import { typeOrmOptionsFactory } from '../database/typeorm-options';
import { QueueModule } from '../queue/queue.module';
import { VIDEO_PROCESSING_QUEUE } from '../queue/video-processing.constants';
import { StorageModule } from '../storage/storage.module';
import { Channel } from '../channels/entities/channel.entity';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';
import { MediaProbeService } from './media/media-probe.service';
import { ThumbnailService } from './media/thumbnail.service';
import { VideoProcessingConsumer } from './video-processing.consumer';

// Root module of the video worker process (src/worker/main.ts): no HTTP layer,
// no controllers and no API domain modules. The queue keeps the default
// connection (offline queue enabled), unlike the API producer.
@Module({
  imports: [
    ConfigModule.forRoot(configModuleOptions),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [databaseConfig.KEY],
      useFactory: typeOrmOptionsFactory,
    }),
    // Channel and User are the targets of Video's relations: with
    // autoLoadEntities, TypeORM refuses to build the metadata without them.
    TypeOrmModule.forFeature([Video, Channel, User]),
    StorageModule,
    QueueModule,
    BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
  ],
  providers: [MediaProbeService, ThumbnailService, VideoProcessingConsumer],
})
export class WorkerModule {}
