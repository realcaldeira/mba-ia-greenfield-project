import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { ChannelNotFoundException } from '../channels/channels.exceptions';
import { ChannelsService } from '../channels/channels.service';
import { QueueUnavailableException } from '../queue/queue.exceptions';
import { VideoProcessingProducer } from '../queue/video-processing.producer';
import type { Channel } from '../channels/entities/channel.entity';
import {
  MultipartUploadMissingException,
  MultipartUploadRejectedException,
  StorageUnavailableException,
} from '../storage/storage.exceptions';
import { StorageService } from '../storage/storage.service';
import type { InitiateUploadDto } from './dto/initiate-upload.dto';
import {
  Video,
  VideoProcessingError,
  VideoStatus,
  type VideoMetadata,
} from './entities/video.entity';
import {
  InvalidVideoStateException,
  UploadExpiredException,
  UploadIncompleteException,
  UploadSizeMismatchException,
  VideoNotFoundException,
} from './videos.exceptions';
import { VideosService } from './videos.service';

const USER_ID = 'user-1';
const CHANNEL_ID = 'channel-1';
const UPLOAD_ID = 'upload-1';
const TEN_GIB = 10737418240;
const PUBLIC_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

type QueryBuilderMock = {
  innerJoin: jest.Mock;
  where: jest.Mock;
  andWhere: jest.Mock;
  getOne: jest.Mock<Promise<Video | null>, []>;
};

type RepoMock = {
  create: jest.Mock<Video, [Partial<Video>]>;
  insert: jest.Mock<Promise<void>, [Video]>;
  update: jest.Mock<Promise<{ affected?: number }>, [object, object]>;
  findOneByOrFail: jest.Mock<Promise<Video>, [{ id: string }]>;
  createQueryBuilder: jest.Mock<QueryBuilderMock, [string]>;
};

type StorageMock = jest.Mocked<
  Pick<
    StorageService,
    | 'createMultipartUpload'
    | 'abortMultipartUpload'
    | 'presignUploadPart'
    | 'presignGetObject'
    | 'listParts'
    | 'headObject'
    | 'completeMultipartUpload'
    | 'deleteObject'
  >
>;

const METADATA: VideoMetadata = {
  width: 1920,
  height: 1080,
  video_codec: 'h264',
  audio_codec: 'aac',
  bit_rate: 4500000,
  frame_rate: 30,
  format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
};

function makeVideo(overrides: Partial<Video> = {}): Video {
  return Object.assign(new Video(), {
    id: 'video-uuid',
    public_id: 'AbCdEf_-123',
    channel_id: CHANNEL_ID,
    title: 'clip',
    original_filename: 'clip.mp4',
    mime_type: 'video/mp4',
    size_bytes: 1024,
    status: VideoStatus.DRAFT,
    processing_error: null,
    upload_id: UPLOAD_ID,
    upload_expires_at: new Date(Date.now() + 3600_000),
    duration_seconds: null,
    metadata: null,
    thumbnail_key: null,
    created_at: new Date('2026-11-05T12:00:00.000Z'),
    updated_at: new Date('2026-11-05T12:00:01.000Z'),
    ...overrides,
  });
}

function uniqueViolation(column: string): QueryFailedError {
  return Object.assign(new QueryFailedError('INSERT', [], new Error()), {
    code: '23505',
    detail: `Key (${column})=(x) already exists.`,
  });
}

function dto(overrides: Partial<InitiateUploadDto> = {}): InitiateUploadDto {
  return {
    file_name: 'clip.mp4',
    file_size: 1024,
    content_type: 'video/mp4',
    ...overrides,
  };
}

describe('VideosService', () => {
  let service: VideosService;
  let repo: RepoMock;
  let storage: StorageMock;
  let channels: { findByUserId: jest.Mock };
  let queryBuilder: QueryBuilderMock;
  let producer: { enqueue: jest.Mock<Promise<void>, [string]> };

  beforeEach(async () => {
    queryBuilder = {
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn<Promise<Video | null>, []>().mockResolvedValue(null),
    };
    repo = {
      create: jest.fn<Video, [Partial<Video>]>((fields) =>
        Object.assign(new Video(), fields),
      ),
      insert: jest.fn<Promise<void>, [Video]>().mockResolvedValue(undefined),
      update: jest
        .fn<Promise<{ affected?: number }>, [object, object]>()
        .mockResolvedValue({ affected: 1 }),
      findOneByOrFail: jest.fn<Promise<Video>, [{ id: string }]>(),
      createQueryBuilder: jest
        .fn<QueryBuilderMock, [string]>()
        .mockReturnValue(queryBuilder),
    };
    storage = {
      createMultipartUpload: jest.fn().mockResolvedValue(UPLOAD_ID),
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
      presignUploadPart: jest.fn<
        Promise<string>,
        [string, string, number, number, number]
      >((key, _uploadId, partNumber) =>
        Promise.resolve(`http://minio:9000/${key}?partNumber=${partNumber}`),
      ),
      presignGetObject: jest
        .fn()
        .mockResolvedValue('http://minio:9000/signed-thumbnail'),
      listParts: jest.fn().mockResolvedValue([]),
      headObject: jest.fn().mockResolvedValue(null),
      completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
      deleteObject: jest.fn().mockResolvedValue(undefined),
    };
    producer = {
      enqueue: jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined),
    };
    channels = {
      findByUserId: jest.fn().mockResolvedValue({ id: CHANNEL_ID } as Channel),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: repo },
        { provide: StorageService, useValue: storage },
        { provide: ChannelsService, useValue: channels },
        { provide: VideoProcessingProducer, useValue: producer },
      ],
    }).compile();

    service = moduleRef.get(VideosService);
  });

  describe('initiateUpload', () => {
    it('should derive the title from the file name without its last extension', async () => {
      const session = await service.initiateUpload(
        USER_ID,
        dto({ file_name: 'aula.final.webm', content_type: 'video/webm' }),
      );

      expect(session.title).toBe('aula.final');
    });

    it('should truncate the derived title to 100 characters', async () => {
      const session = await service.initiateUpload(
        USER_ID,
        dto({ file_name: `${'a'.repeat(120)}.mp4` }),
      );

      expect(session.title).toBe('a'.repeat(100));
    });

    it('should keep the given title instead of deriving one', async () => {
      const session = await service.initiateUpload(
        USER_ID,
        dto({ title: 'Meu vídeo' }),
      );

      expect(session.title).toBe('Meu vídeo');
    });

    it('should open the multipart upload on the original key and persist a draft in the user channel', async () => {
      await service.initiateUpload(
        USER_ID,
        dto({ file_name: 'Minhas Férias.mp4', file_size: 134217728 }),
      );

      expect(channels.findByUserId).toHaveBeenCalledWith(USER_ID);
      const inserted = repo.insert.mock.calls[0][0];
      expect(storage.createMultipartUpload).toHaveBeenCalledWith(
        `videos/${inserted.id}/original`,
        'video/mp4',
      );
      expect(inserted).toMatchObject({
        channel_id: CHANNEL_ID,
        original_filename: 'Minhas Férias.mp4',
        mime_type: 'video/mp4',
        size_bytes: 134217728,
        status: VideoStatus.DRAFT,
        processing_error: null,
        upload_id: UPLOAD_ID,
      });
      expect(inserted.public_id).toMatch(PUBLIC_ID_PATTERN);
    });

    it('should retry the insert with a new public_id on a public_id collision', async () => {
      const seen: string[] = [];
      repo.insert.mockImplementation((video: Video) => {
        seen.push(video.public_id);
        return seen.length === 1
          ? Promise.reject(uniqueViolation('public_id'))
          : Promise.resolve(undefined);
      });

      const session = await service.initiateUpload(USER_ID, dto());

      expect(repo.insert).toHaveBeenCalledTimes(2);
      expect(seen[1]).not.toBe(seen[0]);
      expect(session.public_id).toBe(seen[1]);
      expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
    });

    it('should give up after 5 retries and abort the multipart upload', async () => {
      const collision = uniqueViolation('public_id');
      repo.insert.mockRejectedValue(collision);

      await expect(service.initiateUpload(USER_ID, dto())).rejects.toBe(
        collision,
      );

      expect(repo.insert).toHaveBeenCalledTimes(6);
      expect(storage.abortMultipartUpload).toHaveBeenCalledTimes(1);
    });

    it('should not retry on a unique violation of another column', async () => {
      const other = uniqueViolation('id');
      repo.insert.mockRejectedValue(other);

      await expect(service.initiateUpload(USER_ID, dto())).rejects.toBe(other);

      expect(repo.insert).toHaveBeenCalledTimes(1);
    });

    it('should persist nothing when the storage fails to open the upload', async () => {
      storage.createMultipartUpload.mockRejectedValue(
        new StorageUnavailableException(),
      );

      await expect(service.initiateUpload(USER_ID, dto())).rejects.toThrow(
        StorageUnavailableException,
      );

      expect(repo.insert).not.toHaveBeenCalled();
    });

    it('should abort the multipart upload and rethrow when the insert fails', async () => {
      const dbError = new Error('connection lost');
      repo.insert.mockRejectedValue(dbError);

      await expect(service.initiateUpload(USER_ID, dto())).rejects.toBe(
        dbError,
      );

      const key = storage.createMultipartUpload.mock.calls[0][0];
      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(key, UPLOAD_ID);
    });

    it('should rethrow the insert error unmasked and log when the abort also fails', async () => {
      const dbError = new Error('connection lost');
      repo.insert.mockRejectedValue(dbError);
      storage.abortMultipartUpload.mockRejectedValue(
        new StorageUnavailableException(),
      );
      const logError = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);

      await expect(service.initiateUpload(USER_ID, dto())).rejects.toBe(
        dbError,
      );

      expect(storage.abortMultipartUpload).toHaveBeenCalledTimes(1);
      expect(logError).toHaveBeenCalledWith(
        expect.stringContaining(
          `Could not abort multipart upload ${UPLOAD_ID}`,
        ),
        expect.any(String),
      );
      logError.mockRestore();
    });

    it('should throw ChannelNotFoundException and open no upload when the user has no channel', async () => {
      channels.findByUserId.mockResolvedValue(null);

      await expect(service.initiateUpload(USER_ID, dto())).rejects.toThrow(
        ChannelNotFoundException,
      );

      expect(storage.createMultipartUpload).not.toHaveBeenCalled();
      expect(repo.insert).not.toHaveBeenCalled();
    });

    it('should sign 160 part URLs for a 10 GiB upload', async () => {
      const session = await service.initiateUpload(
        USER_ID,
        dto({ file_size: TEN_GIB }),
      );

      expect(session.part_size).toBe(67108864);
      expect(session.part_count).toBe(160);
      expect(session.parts).toHaveLength(160);
      expect(session.parts[0].part_number).toBe(1);
      expect(session.parts[159].part_number).toBe(160);
      expect(session.uploaded_parts).toEqual([]);
      expect(storage.presignUploadPart).toHaveBeenCalledWith(
        expect.any(String),
        UPLOAD_ID,
        160,
        67108864,
        3600,
      );
    });

    it('should round the part count up for a partial last part', async () => {
      const session = await service.initiateUpload(
        USER_ID,
        dto({ file_size: 67108865 }),
      );

      expect(session.part_count).toBe(2);
      expect(storage.presignUploadPart).toHaveBeenCalledWith(
        expect.any(String),
        UPLOAD_ID,
        1,
        67108864,
        3600,
      );
      expect(storage.presignUploadPart).toHaveBeenCalledWith(
        expect.any(String),
        UPLOAD_ID,
        2,
        1,
        3600,
      );
    });

    it('should return the part URLs expiry one hour ahead and the 24 h upload window', async () => {
      const before = Date.now();

      const session = await service.initiateUpload(USER_ID, dto());

      const partsExpireAt = Date.parse(session.parts_expire_at);
      const uploadExpiresAt = Date.parse(session.upload_expires_at);
      expect(partsExpireAt - before).toBeGreaterThanOrEqual(3600_000);
      expect(partsExpireAt - before).toBeLessThan(3605_000);
      expect(uploadExpiresAt - before).toBeGreaterThanOrEqual(86_400_000);
      expect(uploadExpiresAt - before).toBeLessThan(86_405_000);
    });
  });

  describe('findOwnedOrFail', () => {
    it('should filter by public_id and the channel owner in a single query', async () => {
      const video = makeVideo();
      queryBuilder.getOne.mockResolvedValue(video);

      await expect(
        service.findOwnedOrFail(USER_ID, video.public_id),
      ).resolves.toBe(video);

      expect(queryBuilder.innerJoin).toHaveBeenCalledWith(
        'video.channel',
        'channel',
      );
      expect(queryBuilder.where).toHaveBeenCalledWith(
        'video.public_id = :publicId',
        { publicId: video.public_id },
      );
      expect(queryBuilder.andWhere).toHaveBeenCalledWith(
        'channel.user_id = :userId',
        { userId: USER_ID },
      );
    });

    it('should throw VideoNotFoundException when no owned video matches', async () => {
      await expect(
        service.findOwnedOrFail(USER_ID, 'AbCdEf_-123'),
      ).rejects.toThrow(VideoNotFoundException);
    });
  });

  describe('expireIfDue', () => {
    it('should turn an overdue draft into failed/UPLOAD_EXPIRED and abort the upload', async () => {
      const draft = makeVideo({
        upload_expires_at: new Date(Date.now() - 60_000),
      });
      const failed = makeVideo({
        status: VideoStatus.FAILED,
        processing_error: VideoProcessingError.UPLOAD_EXPIRED,
      });
      repo.findOneByOrFail.mockResolvedValue(failed);

      const result = await service.expireIfDue(draft);

      expect(repo.update).toHaveBeenCalledWith(
        { id: draft.id, status: VideoStatus.DRAFT },
        {
          status: VideoStatus.FAILED,
          processing_error: VideoProcessingError.UPLOAD_EXPIRED,
        },
      );
      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        `videos/${draft.id}/original`,
        UPLOAD_ID,
      );
      expect(result).toBe(failed);
    });

    it('should keep the video failed and propagate the error when the abort fails', async () => {
      const draft = makeVideo({
        upload_expires_at: new Date(Date.now() - 60_000),
      });
      const unavailable = new StorageUnavailableException();
      storage.abortMultipartUpload.mockRejectedValue(unavailable);

      await expect(service.expireIfDue(draft)).rejects.toBe(unavailable);

      expect(repo.update).toHaveBeenCalledWith(
        { id: draft.id, status: VideoStatus.DRAFT },
        {
          status: VideoStatus.FAILED,
          processing_error: VideoProcessingError.UPLOAD_EXPIRED,
        },
      );
      expect(repo.update.mock.invocationCallOrder[0]).toBeLessThan(
        storage.abortMultipartUpload.mock.invocationCallOrder[0],
      );
    });

    it('should not abort when the conditional update matched no draft', async () => {
      const draft = makeVideo({
        upload_expires_at: new Date(Date.now() - 60_000),
      });
      repo.update.mockResolvedValue({ affected: 0 });
      repo.findOneByOrFail.mockResolvedValue(
        makeVideo({ status: VideoStatus.PROCESSING }),
      );

      const result = await service.expireIfDue(draft);

      expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
      expect(result.status).toBe(VideoStatus.PROCESSING);
    });

    it('should leave a draft within its upload window untouched', async () => {
      const draft = makeVideo();

      await expect(service.expireIfDue(draft)).resolves.toBe(draft);

      expect(repo.update).not.toHaveBeenCalled();
      expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
    });

    it('should leave a non-draft video untouched even past the upload window', async () => {
      const processing = makeVideo({
        status: VideoStatus.PROCESSING,
        upload_expires_at: new Date(Date.now() - 60_000),
      });

      await expect(service.expireIfDue(processing)).resolves.toBe(processing);

      expect(repo.update).not.toHaveBeenCalled();
    });
  });

  describe('toVideoResponse', () => {
    it('should map exactly the 11 public fields, with ISO-8601 dates', async () => {
      const response = await service.toVideoResponse(makeVideo());

      expect(response).toEqual({
        public_id: 'AbCdEf_-123',
        title: 'clip',
        status: VideoStatus.DRAFT,
        size_bytes: 1024,
        mime_type: 'video/mp4',
        duration_seconds: null,
        metadata: null,
        processing_error: null,
        thumbnail_url: null,
        created_at: '2026-11-05T12:00:00.000Z',
        updated_at: '2026-11-05T12:00:01.000Z',
      });
    });

    it('should never expose the id, channel, file name, upload id or storage keys', async () => {
      const response = await service.toVideoResponse(
        makeVideo({
          status: VideoStatus.READY,
          thumbnail_key: 'videos/video-uuid/thumbnail.jpg',
        }),
      );

      for (const field of [
        'id',
        'channel_id',
        'original_filename',
        'upload_id',
        'thumbnail_key',
      ]) {
        expect(response).not.toHaveProperty(field);
      }
    });

    it('should presign the thumbnail of a ready video for the client for one hour', async () => {
      const response = await service.toVideoResponse(
        makeVideo({
          status: VideoStatus.READY,
          duration_seconds: 3,
          metadata: METADATA,
          thumbnail_key: 'videos/video-uuid/thumbnail.jpg',
        }),
      );

      expect(storage.presignGetObject).toHaveBeenCalledWith(
        'videos/video-uuid/thumbnail.jpg',
        { expiresIn: 3600, audience: 'client' },
      );
      expect(response.thumbnail_url).toBe('http://minio:9000/signed-thumbnail');
      expect(response.metadata).toEqual(METADATA);
      expect(response.duration_seconds).toBe(3);
    });

    it('should return a null thumbnail_url for a ready video without thumbnail', async () => {
      const response = await service.toVideoResponse(
        makeVideo({ status: VideoStatus.READY, thumbnail_key: null }),
      );

      expect(response.thumbnail_url).toBeNull();
      expect(storage.presignGetObject).not.toHaveBeenCalled();
    });

    it('should return a null thumbnail_url while processing, even with a thumbnail key', async () => {
      const response = await service.toVideoResponse(
        makeVideo({
          status: VideoStatus.PROCESSING,
          thumbnail_key: 'videos/video-uuid/thumbnail.jpg',
        }),
      );

      expect(response.thumbnail_url).toBeNull();
      expect(storage.presignGetObject).not.toHaveBeenCalled();
    });
  });

  describe('getUploadSession', () => {
    function ownVideo(video: Video): void {
      queryBuilder.getOne.mockResolvedValue(video);
    }

    it('should sign only the parts the storage has not received', async () => {
      ownVideo(makeVideo({ size_bytes: 3 * 67108864 }));
      storage.listParts.mockResolvedValue([
        { partNumber: 2, etag: '"b"', size: 67108864 },
        { partNumber: 1, etag: '"a"', size: 67108864 },
      ]);

      const session = await service.getUploadSession(USER_ID, 'AbCdEf_-123');

      expect(storage.listParts).toHaveBeenCalledWith(
        'videos/video-uuid/original',
        UPLOAD_ID,
      );
      expect(session.part_count).toBe(3);
      expect(session.uploaded_parts).toEqual([1, 2]);
      expect(session.parts.map((p) => p.part_number)).toEqual([3]);
      expect(storage.presignUploadPart).toHaveBeenCalledTimes(1);
    });

    it('should answer INVALID_VIDEO_STATE and keep the draft when the original is already assembled', async () => {
      ownVideo(makeVideo());
      storage.listParts.mockResolvedValue(null);
      storage.headObject.mockResolvedValue({ contentLength: 1024 });

      await expect(
        service.getUploadSession(USER_ID, 'AbCdEf_-123'),
      ).rejects.toThrow(InvalidVideoStateException);

      expect(storage.headObject).toHaveBeenCalledWith(
        'videos/video-uuid/original',
      );
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('should fail the draft with UPLOAD_EXPIRED when the upload and the object are gone', async () => {
      ownVideo(makeVideo());
      storage.listParts.mockResolvedValue(null);
      storage.headObject.mockResolvedValue(null);

      await expect(
        service.getUploadSession(USER_ID, 'AbCdEf_-123'),
      ).rejects.toThrow(UploadExpiredException);

      expect(repo.update).toHaveBeenCalledWith(
        { id: 'video-uuid', status: VideoStatus.DRAFT },
        {
          status: VideoStatus.FAILED,
          processing_error: VideoProcessingError.UPLOAD_EXPIRED,
        },
      );
    });

    it('should answer INVALID_VIDEO_STATE for a video in processing', async () => {
      ownVideo(makeVideo({ status: VideoStatus.PROCESSING }));

      await expect(
        service.getUploadSession(USER_ID, 'AbCdEf_-123'),
      ).rejects.toThrow(InvalidVideoStateException);

      expect(storage.listParts).not.toHaveBeenCalled();
    });

    it('should answer UPLOAD_EXPIRED for a draft past its upload window', async () => {
      ownVideo(makeVideo({ upload_expires_at: new Date(Date.now() - 60_000) }));
      repo.findOneByOrFail.mockResolvedValue(
        makeVideo({
          status: VideoStatus.FAILED,
          processing_error: VideoProcessingError.UPLOAD_EXPIRED,
        }),
      );

      await expect(
        service.getUploadSession(USER_ID, 'AbCdEf_-123'),
      ).rejects.toThrow(UploadExpiredException);

      expect(storage.listParts).not.toHaveBeenCalled();
    });

    it('should answer UPLOAD_EXPIRED for a video an earlier request already expired', async () => {
      ownVideo(
        makeVideo({
          status: VideoStatus.FAILED,
          processing_error: VideoProcessingError.UPLOAD_EXPIRED,
        }),
      );

      await expect(
        service.getUploadSession(USER_ID, 'AbCdEf_-123'),
      ).rejects.toThrow(UploadExpiredException);

      expect(repo.update).not.toHaveBeenCalled();
      expect(storage.listParts).not.toHaveBeenCalled();
    });

    it('should answer INVALID_VIDEO_STATE for a video failed for another reason', async () => {
      ownVideo(
        makeVideo({
          status: VideoStatus.FAILED,
          processing_error: VideoProcessingError.PROCESSING_FAILED,
        }),
      );

      await expect(
        service.getUploadSession(USER_ID, 'AbCdEf_-123'),
      ).rejects.toThrow(InvalidVideoStateException);
    });
  });

  describe('completeUpload', () => {
    const PART = 67108864;
    const KEY = 'videos/video-uuid/original';

    function ownVideo(video: Video): void {
      queryBuilder.getOne.mockResolvedValue(video);
    }

    function part(partNumber: number, size: number) {
      return { partNumber, etag: `"etag-${partNumber}"`, size };
    }

    it('should assemble a complete upload, move it to processing and enqueue it', async () => {
      ownVideo(makeVideo({ size_bytes: PART + 1024 }));
      storage.listParts.mockResolvedValue([part(2, 1024), part(1, PART)]);
      storage.headObject.mockResolvedValue({ contentLength: PART + 1024 });

      const result = await service.completeUpload(USER_ID, 'AbCdEf_-123');

      expect(result).toEqual({
        public_id: 'AbCdEf_-123',
        status: VideoStatus.PROCESSING,
      });
      expect(storage.completeMultipartUpload).toHaveBeenCalledWith(
        KEY,
        UPLOAD_ID,
        [
          { partNumber: 1, etag: '"etag-1"' },
          { partNumber: 2, etag: '"etag-2"' },
        ],
      );
      expect(repo.update).toHaveBeenCalledWith(
        { id: 'video-uuid', status: VideoStatus.DRAFT },
        { status: VideoStatus.PROCESSING },
      );
      expect(producer.enqueue).toHaveBeenCalledWith('video-uuid');
    });

    it('should answer UPLOAD_INCOMPLETE and keep the draft when a part is missing', async () => {
      ownVideo(makeVideo({ size_bytes: 2 * PART }));
      storage.listParts.mockResolvedValue([part(1, PART)]);

      await expect(
        service.completeUpload(USER_ID, 'AbCdEf_-123'),
      ).rejects.toThrow(UploadIncompleteException);

      expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
      expect(repo.update).not.toHaveBeenCalled();
      expect(producer.enqueue).not.toHaveBeenCalled();
    });

    it('should answer UPLOAD_INCOMPLETE for non-contiguous parts', async () => {
      ownVideo(makeVideo({ size_bytes: 2 * PART }));
      storage.listParts.mockResolvedValue([part(1, PART), part(3, PART)]);

      await expect(
        service.completeUpload(USER_ID, 'AbCdEf_-123'),
      ).rejects.toThrow(UploadIncompleteException);
    });

    it('should answer UPLOAD_SIZE_MISMATCH and keep the draft when the parts do not add up', async () => {
      ownVideo(makeVideo({ size_bytes: 2048 }));
      storage.listParts.mockResolvedValue([part(1, 1024)]);

      await expect(
        service.completeUpload(USER_ID, 'AbCdEf_-123'),
      ).rejects.toThrow(UploadSizeMismatchException);

      expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
      expect(repo.update).not.toHaveBeenCalled();
      expect(producer.enqueue).not.toHaveBeenCalled();
    });

    it('should delete the object and fail the video when the assembled size differs', async () => {
      ownVideo(makeVideo({ size_bytes: 1024 }));
      storage.listParts.mockResolvedValue([part(1, 1024)]);
      storage.headObject.mockResolvedValue({ contentLength: 1000 });

      await expect(
        service.completeUpload(USER_ID, 'AbCdEf_-123'),
      ).rejects.toThrow(UploadSizeMismatchException);

      expect(storage.deleteObject).toHaveBeenCalledWith(KEY);
      expect(repo.update).toHaveBeenCalledWith(
        { id: 'video-uuid', status: VideoStatus.DRAFT },
        {
          status: VideoStatus.FAILED,
          processing_error: VideoProcessingError.PROCESSING_FAILED,
        },
      );
      expect(producer.enqueue).not.toHaveBeenCalled();
    });

    it('should revert to draft and answer QUEUE_UNAVAILABLE when the enqueue fails', async () => {
      ownVideo(makeVideo({ size_bytes: 1024 }));
      storage.listParts.mockResolvedValue([part(1, 1024)]);
      storage.headObject.mockResolvedValue({ contentLength: 1024 });
      producer.enqueue.mockRejectedValue(new QueueUnavailableException());

      await expect(
        service.completeUpload(USER_ID, 'AbCdEf_-123'),
      ).rejects.toThrow(QueueUnavailableException);

      expect(repo.update).toHaveBeenNthCalledWith(
        1,
        { id: 'video-uuid', status: VideoStatus.DRAFT },
        { status: VideoStatus.PROCESSING },
      );
      expect(repo.update).toHaveBeenNthCalledWith(
        2,
        { id: 'video-uuid', status: VideoStatus.PROCESSING },
        { status: VideoStatus.DRAFT },
      );
    });

    it('should start processing from the assembled object when the multipart upload is gone', async () => {
      ownVideo(makeVideo({ size_bytes: 1024 }));
      storage.listParts.mockResolvedValue(null);
      storage.headObject.mockResolvedValue({ contentLength: 1024 });

      const result = await service.completeUpload(USER_ID, 'AbCdEf_-123');

      expect(result.status).toBe(VideoStatus.PROCESSING);
      expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
      expect(repo.update).toHaveBeenCalledWith(
        { id: 'video-uuid', status: VideoStatus.DRAFT },
        { status: VideoStatus.PROCESSING },
      );
      expect(producer.enqueue).toHaveBeenCalledWith('video-uuid');
    });

    it('should fail with UPLOAD_EXPIRED when the multipart upload and the object are gone', async () => {
      ownVideo(makeVideo());
      storage.listParts.mockResolvedValue(null);
      storage.headObject.mockResolvedValue(null);

      await expect(
        service.completeUpload(USER_ID, 'AbCdEf_-123'),
      ).rejects.toThrow(UploadExpiredException);

      expect(repo.update).toHaveBeenCalledWith(
        { id: 'video-uuid', status: VideoStatus.DRAFT },
        {
          status: VideoStatus.FAILED,
          processing_error: VideoProcessingError.UPLOAD_EXPIRED,
        },
      );
      expect(producer.enqueue).not.toHaveBeenCalled();
    });

    it('should only re-enqueue a video already in processing', async () => {
      ownVideo(makeVideo({ status: VideoStatus.PROCESSING }));

      const result = await service.completeUpload(USER_ID, 'AbCdEf_-123');

      expect(result.status).toBe(VideoStatus.PROCESSING);
      expect(storage.listParts).not.toHaveBeenCalled();
      expect(repo.update).not.toHaveBeenCalled();
      expect(producer.enqueue).toHaveBeenCalledWith('video-uuid');
    });

    it('should keep a processing video in processing when the re-enqueue fails', async () => {
      ownVideo(makeVideo({ status: VideoStatus.PROCESSING }));
      producer.enqueue.mockRejectedValue(new QueueUnavailableException());

      await expect(
        service.completeUpload(USER_ID, 'AbCdEf_-123'),
      ).rejects.toThrow(QueueUnavailableException);

      expect(repo.update).not.toHaveBeenCalled();
    });

    it.each([VideoStatus.READY, VideoStatus.FAILED])(
      'should answer INVALID_VIDEO_STATE for a %s video',
      async (status) => {
        ownVideo(makeVideo({ status }));

        await expect(
          service.completeUpload(USER_ID, 'AbCdEf_-123'),
        ).rejects.toThrow(InvalidVideoStateException);

        expect(producer.enqueue).not.toHaveBeenCalled();
      },
    );

    it('should answer UPLOAD_EXPIRED for a draft past its upload window', async () => {
      ownVideo(makeVideo({ upload_expires_at: new Date(Date.now() - 60_000) }));
      repo.findOneByOrFail.mockResolvedValue(
        makeVideo({
          status: VideoStatus.FAILED,
          processing_error: VideoProcessingError.UPLOAD_EXPIRED,
        }),
      );

      await expect(
        service.completeUpload(USER_ID, 'AbCdEf_-123'),
      ).rejects.toThrow(UploadExpiredException);

      expect(storage.listParts).not.toHaveBeenCalled();
      expect(producer.enqueue).not.toHaveBeenCalled();
    });

    it('should answer UPLOAD_EXPIRED for a video an earlier request already expired', async () => {
      ownVideo(
        makeVideo({
          status: VideoStatus.FAILED,
          processing_error: VideoProcessingError.UPLOAD_EXPIRED,
        }),
      );

      await expect(
        service.completeUpload(USER_ID, 'AbCdEf_-123'),
      ).rejects.toThrow(UploadExpiredException);

      expect(storage.listParts).not.toHaveBeenCalled();
      expect(producer.enqueue).not.toHaveBeenCalled();
    });

    describe('part sizes', () => {
      it('should answer UPLOAD_SIZE_MISMATCH and keep the draft when a non-last part is not part_size', async () => {
        // Same total as the declared size, but split differently from the URLs.
        ownVideo(makeVideo({ size_bytes: PART + 1024 }));
        storage.listParts.mockResolvedValue([
          part(1, PART - 1024),
          part(2, 2048),
        ]);

        await expect(
          service.completeUpload(USER_ID, 'AbCdEf_-123'),
        ).rejects.toThrow(UploadSizeMismatchException);

        expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
        expect(repo.update).not.toHaveBeenCalled();
        expect(producer.enqueue).not.toHaveBeenCalled();
      });

      it('should accept a last part smaller than part_size', async () => {
        ownVideo(makeVideo({ size_bytes: 2 * PART + 1 }));
        storage.listParts.mockResolvedValue([
          part(1, PART),
          part(2, PART),
          part(3, 1),
        ]);
        storage.headObject.mockResolvedValue({ contentLength: 2 * PART + 1 });

        await expect(
          service.completeUpload(USER_ID, 'AbCdEf_-123'),
        ).resolves.toMatchObject({ status: VideoStatus.PROCESSING });

        expect(storage.completeMultipartUpload).toHaveBeenCalledTimes(1);
      });

      it('should accept a last part of exactly part_size', async () => {
        ownVideo(makeVideo({ size_bytes: 2 * PART }));
        storage.listParts.mockResolvedValue([part(1, PART), part(2, PART)]);
        storage.headObject.mockResolvedValue({ contentLength: 2 * PART });

        await expect(
          service.completeUpload(USER_ID, 'AbCdEf_-123'),
        ).resolves.toMatchObject({ status: VideoStatus.PROCESSING });
      });
    });

    it('should answer UPLOAD_INCOMPLETE and keep the draft when the storage rejects the parts', async () => {
      ownVideo(makeVideo({ size_bytes: 1024 }));
      storage.listParts.mockResolvedValue([part(1, 1024)]);
      storage.completeMultipartUpload.mockRejectedValue(
        new MultipartUploadRejectedException('InvalidPart'),
      );

      await expect(
        service.completeUpload(USER_ID, 'AbCdEf_-123'),
      ).rejects.toThrow(UploadIncompleteException);

      expect(storage.headObject).not.toHaveBeenCalled();
      expect(repo.update).not.toHaveBeenCalled();
      expect(producer.enqueue).not.toHaveBeenCalled();
    });

    it('should propagate a storage outage on completion as is', async () => {
      ownVideo(makeVideo({ size_bytes: 1024 }));
      storage.listParts.mockResolvedValue([part(1, 1024)]);
      const unavailable = new StorageUnavailableException();
      storage.completeMultipartUpload.mockRejectedValue(unavailable);

      await expect(service.completeUpload(USER_ID, 'AbCdEf_-123')).rejects.toBe(
        unavailable,
      );
    });

    describe('when a concurrent completion consumed the multipart upload', () => {
      function loseCompletionRace(
        head: { contentLength: number } | null,
      ): void {
        ownVideo(makeVideo({ size_bytes: 1024 }));
        storage.listParts.mockResolvedValue([part(1, 1024)]);
        storage.completeMultipartUpload.mockRejectedValue(
          new MultipartUploadMissingException(),
        );
        storage.headObject.mockResolvedValue(head);
      }

      it('should start processing from the assembled object when the video is still draft', async () => {
        loseCompletionRace({ contentLength: 1024 });

        const result = await service.completeUpload(USER_ID, 'AbCdEf_-123');

        expect(result).toEqual({
          public_id: 'AbCdEf_-123',
          status: VideoStatus.PROCESSING,
        });
        expect(storage.headObject).toHaveBeenCalledTimes(1);
        expect(storage.headObject).toHaveBeenCalledWith(KEY);
        expect(storage.deleteObject).not.toHaveBeenCalled();
        expect(repo.update).toHaveBeenCalledWith(
          { id: 'video-uuid', status: VideoStatus.DRAFT },
          { status: VideoStatus.PROCESSING },
        );
        expect(producer.enqueue).toHaveBeenCalledWith('video-uuid');
      });

      it('should answer processing and re-enqueue when the other completion already moved it to processing', async () => {
        loseCompletionRace({ contentLength: 1024 });
        repo.update.mockResolvedValue({ affected: 0 });
        repo.findOneByOrFail.mockResolvedValue(
          makeVideo({ status: VideoStatus.PROCESSING }),
        );

        const result = await service.completeUpload(USER_ID, 'AbCdEf_-123');

        expect(result.status).toBe(VideoStatus.PROCESSING);
        expect(repo.update).toHaveBeenCalledTimes(1);
        expect(producer.enqueue).toHaveBeenCalledWith('video-uuid');
      });

      it('should fail with UPLOAD_EXPIRED without enqueueing when there is no assembled object', async () => {
        loseCompletionRace(null);

        await expect(
          service.completeUpload(USER_ID, 'AbCdEf_-123'),
        ).rejects.toThrow(UploadExpiredException);

        expect(repo.update).toHaveBeenCalledWith(
          { id: 'video-uuid', status: VideoStatus.DRAFT },
          {
            status: VideoStatus.FAILED,
            processing_error: VideoProcessingError.UPLOAD_EXPIRED,
          },
        );
        expect(producer.enqueue).not.toHaveBeenCalled();
      });
    });

    describe('when another request changed the draft before the transition', () => {
      function loseTransitionTo(current: Video): void {
        ownVideo(makeVideo({ size_bytes: 1024 }));
        storage.listParts.mockResolvedValue([part(1, 1024)]);
        storage.headObject.mockResolvedValue({ contentLength: 1024 });
        repo.update.mockResolvedValue({ affected: 0 });
        repo.findOneByOrFail.mockResolvedValue(current);
      }

      it('should answer UPLOAD_EXPIRED without enqueueing for an upload-expired video', async () => {
        loseTransitionTo(
          makeVideo({
            status: VideoStatus.FAILED,
            processing_error: VideoProcessingError.UPLOAD_EXPIRED,
          }),
        );

        await expect(
          service.completeUpload(USER_ID, 'AbCdEf_-123'),
        ).rejects.toThrow(UploadExpiredException);

        expect(repo.findOneByOrFail).toHaveBeenCalledWith({ id: 'video-uuid' });
        expect(producer.enqueue).not.toHaveBeenCalled();
      });

      it('should re-enqueue with the same job id and answer processing for a processing video', async () => {
        loseTransitionTo(makeVideo({ status: VideoStatus.PROCESSING }));

        const result = await service.completeUpload(USER_ID, 'AbCdEf_-123');

        expect(result).toEqual({
          public_id: 'AbCdEf_-123',
          status: VideoStatus.PROCESSING,
        });
        expect(producer.enqueue).toHaveBeenCalledWith('video-uuid');
        expect(repo.update).toHaveBeenCalledTimes(1);
      });

      it('should not revert a processing video it did not move when the re-enqueue fails', async () => {
        loseTransitionTo(makeVideo({ status: VideoStatus.PROCESSING }));
        producer.enqueue.mockRejectedValue(new QueueUnavailableException());

        await expect(
          service.completeUpload(USER_ID, 'AbCdEf_-123'),
        ).rejects.toThrow(QueueUnavailableException);

        expect(repo.update).toHaveBeenCalledTimes(1);
      });

      it.each([
        makeVideo({ status: VideoStatus.READY }),
        makeVideo({
          status: VideoStatus.FAILED,
          processing_error: VideoProcessingError.PROCESSING_FAILED,
        }),
        makeVideo({ status: VideoStatus.DRAFT }),
      ])(
        'should answer INVALID_VIDEO_STATE without enqueueing for a $status video',
        async (current) => {
          loseTransitionTo(current);

          await expect(
            service.completeUpload(USER_ID, 'AbCdEf_-123'),
          ).rejects.toThrow(InvalidVideoStateException);

          expect(producer.enqueue).not.toHaveBeenCalled();
        },
      );
    });
  });
});
