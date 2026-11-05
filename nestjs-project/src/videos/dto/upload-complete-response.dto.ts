import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../entities/video.entity';

export class UploadCompleteResponseDto {
  @ApiProperty({ example: 'AbCdEf_-123', pattern: '^[A-Za-z0-9_-]{11}$' })
  public_id: string;

  @ApiProperty({
    enum: VideoStatus,
    enumName: 'VideoStatus',
    example: VideoStatus.PROCESSING,
  })
  status: VideoStatus;
}
