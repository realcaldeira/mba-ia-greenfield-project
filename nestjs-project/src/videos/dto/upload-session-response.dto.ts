import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../entities/video.entity';

export class UploadPartUrlDto {
  @ApiProperty({ example: 1 })
  part_number: number;

  @ApiProperty({ description: 'Presigned UploadPart PUT URL' })
  url: string;
}

export class UploadSessionResponseDto {
  @ApiProperty({ example: 'AbCdEf_-123', pattern: '^[A-Za-z0-9_-]{11}$' })
  public_id: string;

  @ApiProperty({ example: 'My trip' })
  title: string;

  @ApiProperty({
    enum: VideoStatus,
    enumName: 'VideoStatus',
    example: VideoStatus.DRAFT,
  })
  status: VideoStatus;

  @ApiProperty({ example: 67108864 })
  part_size: number;

  @ApiProperty({ example: 2 })
  part_count: number;

  @ApiProperty({ type: [Number], example: [] })
  uploaded_parts: number[];

  @ApiProperty({ type: [UploadPartUrlDto] })
  parts: UploadPartUrlDto[];

  @ApiProperty({ format: 'date-time', example: '2026-11-05T13:00:00.000Z' })
  parts_expire_at: string;

  @ApiProperty({ format: 'date-time', example: '2026-11-06T12:00:00.000Z' })
  upload_expires_at: string;
}
