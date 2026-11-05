import { randomUUID } from 'node:crypto';
import { basename, extname } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChannelNotFoundException } from '../channels/channels.exceptions';
import { ChannelsService } from '../channels/channels.service';
import { isUniqueViolation } from '../database/pg-errors';
import { QueueUnavailableException } from '../queue/queue.exceptions';
import { VideoProcessingProducer } from '../queue/video-processing.producer';
import {
  MultipartUploadMissingException,
  MultipartUploadRejectedException,
} from '../storage/storage.exceptions';
import { StorageService, type UploadedPart } from '../storage/storage.service';
import type { InitiateUploadDto } from './dto/initiate-upload.dto';
import type { MediaUrlResponseDto } from './dto/media-url-response.dto';
import type { UploadCompleteResponseDto } from './dto/upload-complete-response.dto';
import type { UploadSessionResponseDto } from './dto/upload-session-response.dto';
import type { VideoResponseDto } from './dto/video-response.dto';
import {
  Video,
  VideoProcessingError,
  VideoStatus,
} from './entities/video.entity';
import { buildAttachmentDisposition } from './content-disposition.util';
import { streamTtlSeconds } from './media-url.util';
import { generatePublicId } from './public-id.util';
import { partCount, partLength } from './upload-parts.util';
import { originalKey } from './video-storage-keys';
import {
  DOWNLOAD_TTL_SECONDS,
  PART_URL_TTL_SECONDS,
  THUMBNAIL_URL_TTL_SECONDS,
  UPLOAD_PART_SIZE_BYTES,
  UPLOAD_WINDOW_HOURS,
} from './videos.constants';
import {
  InvalidVideoStateException,
  UploadExpiredException,
  UploadIncompleteException,
  UploadSizeMismatchException,
  VideoNotFoundException,
  VideoNotReadyException,
} from './videos.exceptions';

const PUBLIC_ID_COLUMN = 'public_id';
const MAX_PUBLIC_ID_RETRIES = 5;
const TITLE_MAX_LENGTH = 100;
const MS_PER_SECOND = 1000;
const MS_PER_HOUR = 3600 * MS_PER_SECOND;

// Title fallback: the file name without its last extension, up to 100 chars.
function titleFromFileName(fileName: string): string {
  return basename(fileName, extname(fileName)).slice(0, TITLE_MAX_LENGTH);
}

function isUploadExpired(video: Video): boolean {
  return (
    video.status === VideoStatus.FAILED &&
    video.processing_error === VideoProcessingError.UPLOAD_EXPIRED
  );
}

function secondsFromNow(seconds: number): Date {
  return new Date(Date.now() + seconds * MS_PER_SECOND);
}

@Injectable()
export class VideosService {
  private readonly logger = new Logger(VideosService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storage: StorageService,
    private readonly videoProcessingProducer: VideoProcessingProducer,
  ) {}

  // Opens the multipart upload first: when the storage fails, nothing is persisted.
  async initiateUpload(
    userId: string,
    dto: InitiateUploadDto,
  ): Promise<UploadSessionResponseDto> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new ChannelNotFoundException();
    }

    const id = randomUUID();
    const key = originalKey(id);
    const uploadId = await this.storage.createMultipartUpload(
      key,
      dto.content_type,
    );

    const video = this.videoRepository.create({
      id,
      channel_id: channel.id,
      title: dto.title ?? titleFromFileName(dto.file_name),
      original_filename: dto.file_name,
      mime_type: dto.content_type,
      size_bytes: dto.file_size,
      status: VideoStatus.DRAFT,
      processing_error: null,
      upload_id: uploadId,
      upload_expires_at: new Date(
        Date.now() + UPLOAD_WINDOW_HOURS * MS_PER_HOUR,
      ),
    });

    try {
      await this.insertWithUniquePublicId(video);
    } catch (insertError) {
      // Compensation: the insert error is the one the caller must see. A
      // failed abort is only logged (MinIO expires the upload after 24 h), and
      // the insert error is rethrown unmasked.
      try {
        await this.storage.abortMultipartUpload(key, uploadId);
      } catch (abortError) {
        this.logger.error(
          `Could not abort multipart upload ${uploadId} of ${key} after a failed insert: ${String(abortError)}`,
          abortError instanceof Error ? abortError.stack : undefined,
        );
      }
      throw insertError;
    }

    return this.buildUploadSession(video, []);
  }

  async getVideo(userId: string, publicId: string): Promise<VideoResponseDto> {
    const video = await this.expireIfDue(
      await this.findOwnedOrFail(userId, publicId),
    );
    return this.toVideoResponse(video);
  }

  // Resume: re-signs only the parts the storage has not received yet.
  async getUploadSession(
    userId: string,
    publicId: string,
  ): Promise<UploadSessionResponseDto> {
    const video = await this.findOwnedForUpload(userId, publicId);
    if (video.status !== VideoStatus.DRAFT) {
      throw new InvalidVideoStateException();
    }

    const key = originalKey(video.id);
    const parts = await this.storage.listParts(key, video.upload_id);
    if (parts) {
      return this.buildUploadSession(
        video,
        parts.map((part) => part.partNumber),
      );
    }

    // No multipart upload any more: an assembled original means there is
    // nothing left to send (a completion that failed to enqueue).
    if (await this.storage.headObject(key)) {
      throw new InvalidVideoStateException();
    }
    await this.expireUpload(video.id);
    throw new UploadExpiredException();
  }

  // Verifies the upload server-side (never trusting client ETags), assembles the
  // original and enqueues processing. Idempotent: safe to repeat after a 503.
  async completeUpload(
    userId: string,
    publicId: string,
  ): Promise<UploadCompleteResponseDto> {
    const video = await this.findOwnedForUpload(userId, publicId);
    if (
      video.status === VideoStatus.READY ||
      video.status === VideoStatus.FAILED
    ) {
      throw new InvalidVideoStateException();
    }

    if (video.status === VideoStatus.DRAFT) {
      const parts = await this.storage.listParts(
        originalKey(video.id),
        video.upload_id,
      );
      if (parts) {
        await this.assembleUpload(video, parts);
      } else {
        await this.resolveAssembledObject(video);
      }
    }

    await this.startProcessing(video);
    return { public_id: video.public_id, status: VideoStatus.PROCESSING };
  }

  // Inline playback URL (no disposition); the storage answers Range with 206.
  // Ownership is checked before the state, so a non-owner never learns it.
  async getStreamUrl(
    userId: string,
    publicId: string,
  ): Promise<MediaUrlResponseDto> {
    const video = await this.expireIfDue(
      await this.findOwnedOrFail(userId, publicId),
    );
    this.assertReady(video);

    const ttl = streamTtlSeconds(video.duration_seconds);
    const url = await this.storage.presignGetObject(originalKey(video.id), {
      expiresIn: ttl,
      audience: 'client',
    });
    return { url, expires_at: secondsFromNow(ttl).toISOString() };
  }

  // Download URL: fixed 1 h TTL, saved under the file name declared at upload.
  async getDownloadUrl(
    userId: string,
    publicId: string,
  ): Promise<MediaUrlResponseDto> {
    const video = await this.expireIfDue(
      await this.findOwnedOrFail(userId, publicId),
    );
    this.assertReady(video);

    const url = await this.storage.presignGetObject(originalKey(video.id), {
      expiresIn: DOWNLOAD_TTL_SECONDS,
      audience: 'client',
      responseContentDisposition: buildAttachmentDisposition(
        video.original_filename,
      ),
    });
    return {
      url,
      expires_at: secondsFromNow(DOWNLOAD_TTL_SECONDS).toISOString(),
    };
  }

  // One query for ownership: an unknown id and another owner's video are indistinguishable.
  async findOwnedOrFail(userId: string, publicId: string): Promise<Video> {
    const video = await this.videoRepository
      .createQueryBuilder('video')
      .innerJoin('video.channel', 'channel')
      .where('video.public_id = :publicId', { publicId })
      .andWhere('channel.user_id = :userId', { userId })
      .getOne();
    if (!video) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  // Lazy expiry: a draft read after its upload window becomes failed/UPLOAD_EXPIRED.
  // The state is written before the abort, so it stays right when the abort
  // fails; that failure propagates (STORAGE_UNAVAILABLE from the storage).
  async expireIfDue(video: Video): Promise<Video> {
    if (
      video.status !== VideoStatus.DRAFT ||
      video.upload_expires_at.getTime() > Date.now()
    ) {
      return video;
    }

    if (await this.expireUpload(video.id)) {
      await this.storage.abortMultipartUpload(
        originalKey(video.id),
        video.upload_id,
      );
    }
    return this.videoRepository.findOneByOrFail({ id: video.id });
  }

  // Pre-checks the listed parts before CompleteMultipartUpload; on a failed
  // pre-check the video stays draft so the client can re-send parts.
  private async assembleUpload(
    video: Video,
    parts: UploadedPart[],
  ): Promise<void> {
    const count = partCount(video.size_bytes);
    const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    const contiguous =
      sorted.length === count &&
      sorted.every((part, index) => part.partNumber === index + 1);
    if (!contiguous) {
      throw new UploadIncompleteException();
    }

    // Every part but the last is exactly part_size and the last at most
    // part_size: the parts must match the URLs handed out, not only the total.
    const lastIndex = sorted.length - 1;
    const partSizesMatch = sorted.every((part, index) =>
      index < lastIndex
        ? part.size === UPLOAD_PART_SIZE_BYTES
        : part.size <= UPLOAD_PART_SIZE_BYTES,
    );
    const totalSize = sorted.reduce((sum, part) => sum + part.size, 0);
    if (!partSizesMatch || totalSize !== video.size_bytes) {
      throw new UploadSizeMismatchException();
    }

    try {
      await this.storage.completeMultipartUpload(
        originalKey(video.id),
        video.upload_id,
        sorted.map(({ partNumber, etag }) => ({ partNumber, etag })),
      );
    } catch (err) {
      // The storage refused the parts (too small, unknown or out of order):
      // the client re-sends them; the video stays draft.
      if (err instanceof MultipartUploadRejectedException) {
        throw new UploadIncompleteException();
      }
      // A concurrent completion consumed the upload after the listing: the
      // assembled object decides, as on a retry after a failed enqueue, and
      // startProcessing answers for the transition the other request made.
      if (err instanceof MultipartUploadMissingException) {
        await this.resolveAssembledObject(video);
        return;
      }
      throw err;
    }
    await this.verifyAssembledObject(
      video,
      await this.storage.headObject(originalKey(video.id)),
    );
  }

  // Retry after a failed enqueue, or a completion that lost the race to a
  // concurrent one: the multipart upload is gone, so the assembled object
  // decides whether processing can start.
  private async resolveAssembledObject(video: Video): Promise<void> {
    const head = await this.storage.headObject(originalKey(video.id));
    if (!head) {
      await this.expireUpload(video.id);
      throw new UploadExpiredException();
    }
    await this.verifyAssembledObject(video, head);
  }

  // An assembled object of the wrong size cannot be recovered: it is deleted
  // and the video fails; the client starts a new upload.
  private async verifyAssembledObject(
    video: Video,
    head: { contentLength: number } | null,
  ): Promise<void> {
    if (head?.contentLength === video.size_bytes) {
      return;
    }
    await this.storage.deleteObject(originalKey(video.id));
    await this.transition(video.id, VideoStatus.DRAFT, {
      status: VideoStatus.FAILED,
      processing_error: VideoProcessingError.PROCESSING_FAILED,
    });
    throw new UploadSizeMismatchException();
  }

  // draft → processing, then enqueue (jobId = video id). A video already in
  // processing is only re-enqueued. A failed enqueue reverts to draft.
  private async startProcessing(video: Video): Promise<void> {
    if (video.status !== VideoStatus.DRAFT) {
      await this.videoProcessingProducer.enqueue(video.id);
      return;
    }

    const moved = await this.transition(video.id, VideoStatus.DRAFT, {
      status: VideoStatus.PROCESSING,
    });
    if (!moved) {
      // Another request changed the row since it was read: answer for the
      // state it is really in, and enqueue only when it is processing.
      await this.resumeAfterLostTransition(video.id);
      return;
    }

    try {
      await this.videoProcessingProducer.enqueue(video.id);
    } catch (err) {
      if (err instanceof QueueUnavailableException) {
        await this.transition(video.id, VideoStatus.PROCESSING, {
          status: VideoStatus.DRAFT,
        });
      }
      throw err;
    }
  }

  private async resumeAfterLostTransition(videoId: string): Promise<void> {
    const current = await this.videoRepository.findOneByOrFail({ id: videoId });
    if (isUploadExpired(current)) {
      throw new UploadExpiredException();
    }
    if (current.status !== VideoStatus.PROCESSING) {
      throw new InvalidVideoStateException();
    }
    // Idempotent: same jobId as the request that moved it to processing.
    await this.videoProcessingProducer.enqueue(videoId);
  }

  private assertReady(video: Video): void {
    if (video.status !== VideoStatus.READY) {
      throw new VideoNotReadyException();
    }
  }

  // Upload routes answer 410 for any upload-expired video, whichever request
  // expired it (this one through the lazy expiry or an earlier one).
  private async findOwnedForUpload(
    userId: string,
    publicId: string,
  ): Promise<Video> {
    const video = await this.expireIfDue(
      await this.findOwnedOrFail(userId, publicId),
    );
    if (isUploadExpired(video)) {
      throw new UploadExpiredException();
    }
    return video;
  }

  private async expireUpload(videoId: string): Promise<boolean> {
    return this.transition(videoId, VideoStatus.DRAFT, {
      status: VideoStatus.FAILED,
      processing_error: VideoProcessingError.UPLOAD_EXPIRED,
    });
  }

  async toVideoResponse(video: Video): Promise<VideoResponseDto> {
    const thumbnailUrl =
      video.status === VideoStatus.READY && video.thumbnail_key
        ? await this.storage.presignGetObject(video.thumbnail_key, {
            expiresIn: THUMBNAIL_URL_TTL_SECONDS,
            audience: 'client',
          })
        : null;

    return {
      public_id: video.public_id,
      title: video.title,
      status: video.status,
      size_bytes: video.size_bytes,
      mime_type: video.mime_type,
      duration_seconds: video.duration_seconds,
      metadata: video.metadata,
      processing_error: video.processing_error,
      thumbnail_url: thumbnailUrl,
      created_at: video.created_at.toISOString(),
      updated_at: video.updated_at.toISOString(),
    };
  }

  // Conditional status transition: only applies while the video is still in `from`.
  private async transition(
    id: string,
    from: VideoStatus,
    changes: Pick<Partial<Video>, 'status' | 'processing_error'>,
  ): Promise<boolean> {
    const result = await this.videoRepository.update(
      { id, status: from },
      changes,
    );
    return (result.affected ?? 0) > 0;
  }

  private async insertWithUniquePublicId(video: Video): Promise<void> {
    for (let attempt = 0; attempt <= MAX_PUBLIC_ID_RETRIES; attempt++) {
      video.public_id = generatePublicId();
      try {
        await this.videoRepository.insert(video);
        return;
      } catch (err) {
        if (
          !isUniqueViolation(err, { column: PUBLIC_ID_COLUMN }) ||
          attempt === MAX_PUBLIC_ID_RETRIES
        ) {
          throw err;
        }
      }
    }
  }

  // Signs one UploadPart URL for every part of 1..part_count not yet in the storage.
  private async buildUploadSession(
    video: Video,
    uploadedParts: number[],
  ): Promise<UploadSessionResponseDto> {
    const count = partCount(video.size_bytes);
    const uploaded = new Set(uploadedParts);
    const missing = Array.from(
      { length: count },
      (_, index) => index + 1,
    ).filter((partNumber) => !uploaded.has(partNumber));

    const key = originalKey(video.id);
    const parts = await Promise.all(
      missing.map(async (partNumber) => ({
        part_number: partNumber,
        url: await this.storage.presignUploadPart(
          key,
          video.upload_id,
          partNumber,
          partLength(video.size_bytes, partNumber),
          PART_URL_TTL_SECONDS,
        ),
      })),
    );

    return {
      public_id: video.public_id,
      title: video.title,
      status: video.status,
      part_size: UPLOAD_PART_SIZE_BYTES,
      part_count: count,
      uploaded_parts: [...uploaded]
        .filter((partNumber) => partNumber >= 1 && partNumber <= count)
        .sort((a, b) => a - b),
      parts,
      parts_expire_at: secondsFromNow(PART_URL_TTL_SECONDS).toISOString(),
      upload_expires_at: video.upload_expires_at.toISOString(),
    };
  }
}
