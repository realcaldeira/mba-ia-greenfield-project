import { ApiProperty } from '@nestjs/swagger';

export class MediaUrlResponseDto {
  @ApiProperty({ description: 'Presigned GET URL of the original video' })
  url: string;

  @ApiProperty({ format: 'date-time', example: '2026-11-05T13:00:00.000Z' })
  expires_at: string;
}
