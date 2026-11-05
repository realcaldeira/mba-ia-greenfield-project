import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';
import { MatchesContentTypeExtension } from '../validators/matches-content-type-extension.validator';
import {
  ALLOWED_VIDEO_CONTENT_TYPES,
  VIDEO_MAX_SIZE_BYTES,
  type VideoContentType,
} from '../videos.constants';

@MatchesContentTypeExtension()
export class InitiateUploadDto {
  /** Original file name; its extension must match content_type. */
  @IsString()
  @Length(1, 255)
  file_name: string;

  /** Declared size in bytes, up to 10 GiB. */
  @IsInt()
  @Min(1)
  @Max(VIDEO_MAX_SIZE_BYTES)
  file_size: number;

  /** Declared MIME type. */
  @IsIn(ALLOWED_VIDEO_CONTENT_TYPES)
  content_type: VideoContentType;

  /** Video title; defaults to the file name without its extension. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(1, 100)
  title?: string;
}
