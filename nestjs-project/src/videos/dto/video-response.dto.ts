import { ApiProperty } from '@nestjs/swagger';
import { VideoProcessingError, VideoStatus } from '../entities/video.entity';

export class VideoMetadataDto {
  @ApiProperty({ example: 1920 })
  width: number;

  @ApiProperty({ example: 1080 })
  height: number;

  @ApiProperty({ example: 'h264' })
  video_codec: string;

  @ApiProperty({ type: String, nullable: true, example: 'aac' })
  audio_codec: string | null;

  @ApiProperty({ type: Number, nullable: true, example: 4500000 })
  bit_rate: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 29.97 })
  frame_rate: number | null;

  @ApiProperty({ example: 'mov,mp4,m4a,3gp,3g2,mj2' })
  format_name: string;
}

export class VideoResponseDto {
  @ApiProperty({ example: 'AbCdEf_-123', pattern: '^[A-Za-z0-9_-]{11}$' })
  public_id: string;

  @ApiProperty({ example: 'My trip' })
  title: string;

  @ApiProperty({ enum: VideoStatus, enumName: 'VideoStatus' })
  status: VideoStatus;

  @ApiProperty({ example: 104857600 })
  size_bytes: number;

  @ApiProperty({ example: 'video/mp4' })
  mime_type: string;

  @ApiProperty({ type: Number, nullable: true, example: 12.5 })
  duration_seconds: number | null;

  @ApiProperty({ type: VideoMetadataDto, nullable: true })
  metadata: VideoMetadataDto | null;

  @ApiProperty({
    enum: VideoProcessingError,
    enumName: 'VideoProcessingError',
    nullable: true,
  })
  processing_error: VideoProcessingError | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Presigned GET of the thumbnail, only for ready videos',
  })
  thumbnail_url: string | null;

  @ApiProperty({ format: 'date-time', example: '2026-11-05T12:00:00.000Z' })
  created_at: string;

  @ApiProperty({ format: 'date-time', example: '2026-11-05T12:00:00.000Z' })
  updated_at: string;
}
