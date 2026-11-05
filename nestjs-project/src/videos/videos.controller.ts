import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { MediaUrlResponseDto } from './dto/media-url-response.dto';
import { PublicIdParamDto } from './dto/public-id-param.dto';
import { UploadCompleteResponseDto } from './dto/upload-complete-response.dto';
import { UploadSessionResponseDto } from './dto/upload-session-response.dto';
import { VideoResponseDto } from './dto/video-response.dto';
import { VideosService } from './videos.service';

const PUBLIC_ID_PARAM = {
  name: 'publicId',
  description: 'Public video identifier',
  schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{11}$' },
} as const;

@ApiTags('videos')
@ApiBearerAuth('access-token')
@SkipThrottle()
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      "Registers the video as a draft in the caller's channel and opens a multipart upload in the storage. Returns one presigned PUT URL per 64 MiB part; the bytes go straight to the storage.",
  })
  @ApiBody({ type: InitiateUploadDto })
  @ApiResponse({
    status: 201,
    description: 'Draft created and multipart upload started',
    type: UploadSessionResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'The caller has no channel (CHANNEL_NOT_FOUND)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 503,
    description: 'Storage is unavailable (STORAGE_UNAVAILABLE)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async initiateUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: InitiateUploadDto,
  ): Promise<UploadSessionResponseDto> {
    return this.videosService.initiateUpload(user.sub, dto);
  }

  @Get(':publicId')
  @ApiOperation({
    summary: 'Get a video',
    description:
      "Returns the lifecycle of one of the caller's videos. A draft past its upload window is marked failed/UPLOAD_EXPIRED before the response. The thumbnail URL is presigned only for ready videos.",
  })
  @ApiParam(PUBLIC_ID_PARAM)
  @ApiResponse({
    status: 200,
    description: 'Video found',
    type: VideoResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Malformed publicId',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Unknown video or owned by another user (VIDEO_NOT_FOUND)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 503,
    description:
      'Storage is unavailable while aborting the upload of an expired draft (STORAGE_UNAVAILABLE); the video is already failed/UPLOAD_EXPIRED',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getVideo(
    @CurrentUser() user: JwtPayload,
    @Param() params: PublicIdParamDto,
  ): Promise<VideoResponseDto> {
    return this.videosService.getVideo(user.sub, params.publicId);
  }

  @Get(':publicId/upload')
  @ApiOperation({
    summary: 'Resume a video upload',
    description:
      'Lists the parts the storage already received and returns fresh presigned PUT URLs only for the missing ones. Only for drafts within their upload window.',
  })
  @ApiParam(PUBLIC_ID_PARAM)
  @ApiResponse({
    status: 200,
    description: 'Upload session with the missing parts',
    type: UploadSessionResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Malformed publicId',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Unknown video or owned by another user (VIDEO_NOT_FOUND)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description:
      'Video is not a draft (and not upload-expired), or its original is already assembled (INVALID_VIDEO_STATE)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 410,
    description:
      'Upload window expired, multipart upload gone from the storage, or video already failed/UPLOAD_EXPIRED (UPLOAD_EXPIRED)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 503,
    description:
      'Storage is unavailable (STORAGE_UNAVAILABLE): ListParts, HeadObject, or the abort of an expired draft',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getUploadSession(
    @CurrentUser() user: JwtPayload,
    @Param() params: PublicIdParamDto,
  ): Promise<UploadSessionResponseDto> {
    return this.videosService.getUploadSession(user.sub, params.publicId);
  }

  @Post(':publicId/upload/complete')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Complete a video upload',
    description:
      'Checks the uploaded parts in the storage, assembles the original and enqueues its processing. Idempotent: repeating it on a video already in processing re-enqueues the same job, and after a 503 QUEUE_UNAVAILABLE it can be repeated without re-sending any part. Concurrent calls on the same upload are safe: the one that finds the upload already assembled checks the original and answers 202 (410 UPLOAD_EXPIRED when there is no original).',
  })
  @ApiParam(PUBLIC_ID_PARAM)
  @ApiResponse({
    status: 202,
    description: 'Upload accepted; processing enqueued',
    type: UploadCompleteResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Malformed publicId',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Unknown video or owned by another user (VIDEO_NOT_FOUND)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description:
      'UPLOAD_INCOMPLETE: missing or non-contiguous parts, or parts the storage rejects on assembly (video stays draft). UPLOAD_SIZE_MISMATCH: a part other than the last is not part_size, the last exceeds it, or the uploaded size differs from the declared one (draft on the pre-check; failed/PROCESSING_FAILED when the assembled object differs). INVALID_VIDEO_STATE: video is ready, or failed for a reason other than UPLOAD_EXPIRED.',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 410,
    description:
      'Upload window expired, multipart upload and object gone from the storage, or video already failed/UPLOAD_EXPIRED (UPLOAD_EXPIRED)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 503,
    description:
      'QUEUE_UNAVAILABLE: the enqueue failed or did not finish within QUEUE_ENQUEUE_TIMEOUT_MS (video back to draft; repeat the same call). STORAGE_UNAVAILABLE: storage unreachable, including the abort of an expired draft.',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param() params: PublicIdParamDto,
  ): Promise<UploadCompleteResponseDto> {
    return this.videosService.completeUpload(user.sub, params.publicId);
  }

  @Get(':publicId/stream')
  @ApiOperation({
    summary: 'Get a streaming URL',
    description:
      'Returns a presigned GET URL of the original for inline playback; the storage serves Range requests with 206. The URL lives clamp(2 × duration, 1 h, 12 h), or 1 h without a duration. Only for ready videos.',
  })
  @ApiParam(PUBLIC_ID_PARAM)
  @ApiResponse({
    status: 200,
    description: 'Presigned streaming URL',
    type: MediaUrlResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Malformed publicId',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description:
      'Unknown video or owned by another user, in any state (VIDEO_NOT_FOUND)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is draft, processing or failed (VIDEO_NOT_READY)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 503,
    description:
      'Storage is unavailable while aborting the upload of an expired draft (STORAGE_UNAVAILABLE); the video is already failed/UPLOAD_EXPIRED',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getStreamUrl(
    @CurrentUser() user: JwtPayload,
    @Param() params: PublicIdParamDto,
  ): Promise<MediaUrlResponseDto> {
    return this.videosService.getStreamUrl(user.sub, params.publicId);
  }

  @Get(':publicId/download')
  @ApiOperation({
    summary: 'Get a download URL',
    description:
      'Returns a presigned GET URL of the original, valid for 1 h, that saves the file under the name declared at upload (ASCII fallback plus RFC 5987 filename*). Only for ready videos.',
  })
  @ApiParam(PUBLIC_ID_PARAM)
  @ApiResponse({
    status: 200,
    description: 'Presigned download URL',
    type: MediaUrlResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Malformed publicId',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description:
      'Unknown video or owned by another user, in any state (VIDEO_NOT_FOUND)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is draft, processing or failed (VIDEO_NOT_READY)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 503,
    description:
      'Storage is unavailable while aborting the upload of an expired draft (STORAGE_UNAVAILABLE); the video is already failed/UPLOAD_EXPIRED',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getDownloadUrl(
    @CurrentUser() user: JwtPayload,
    @Param() params: PublicIdParamDto,
  ): Promise<MediaUrlResponseDto> {
    return this.videosService.getDownloadUrl(user.sub, params.publicId);
  }
}
