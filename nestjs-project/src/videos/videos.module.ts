import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelsModule } from '../channels/channels.module';
import { VideoProcessingProducerModule } from '../queue/video-processing-producer.module';
import { StorageModule } from '../storage/storage.module';
import { Video } from './entities/video.entity';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';

// API side only: the VideoProcessingConsumer lives in the WorkerModule, never here.
@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    ChannelsModule,
    StorageModule,
    VideoProcessingProducerModule,
  ],
  controllers: [VideosController],
  providers: [VideosService],
})
export class VideosModule {}
