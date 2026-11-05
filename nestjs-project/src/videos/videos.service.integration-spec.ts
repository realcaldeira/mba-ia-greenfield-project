import { getQueueToken } from '@nestjs/bullmq';
import { randomBytes } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { type Queue, UnrecoverableError, Worker } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { QueueUnavailableException } from '../queue/queue.exceptions';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
} from '../queue/video-processing.constants';
import { StorageUnavailableException } from '../storage/storage.exceptions';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { obliterateTestQueue } from '../test/queue';
import { emptyTestBucket } from '../test/storage';
import { ALL_ENTITIES } from '../test/test-entities';
import { User } from '../users/entities/user.entity';
import {
  Video,
  VideoProcessingError,
  VideoStatus,
} from './entities/video.entity';
import { buildAttachmentDisposition } from './content-disposition.util';
import { originalKey } from './video-storage-keys';
import {
  UploadExpiredException,
  UploadIncompleteException,
  UploadSizeMismatchException,
  VideoNotFoundException,
  VideoNotReadyException,
} from './videos.exceptions';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

const HOUR_MS = 3600_000;
const PART_SIZE = 67108864;
const FIVE_MIB = 5 * 1024 * 1024;

describe('VideosService (integration)', () => {
  let moduleRef: TestingModule;
  let service: VideosService;
  let storage: StorageService;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let queue: Queue;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        VideosModule,
      ],
    }).compile();
    service = moduleRef.get(VideosService);
    storage = moduleRef.get(StorageService);
    dataSource = moduleRef.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    queue = moduleRef.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
  }, 30_000);

  afterAll(async () => {
    await cleanAllTables(dataSource);
    await emptyTestBucket();
    await obliterateTestQueue(queue);
    await moduleRef.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await emptyTestBucket();
    await obliterateTestQueue(queue);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function putPart(
    video: Video,
    partNumber: number,
    size: number,
  ): Promise<void> {
    const url = await storage.presignUploadPart(
      originalKey(video.id),
      video.upload_id,
      partNumber,
      size,
      600,
    );
    const res = await fetch(url, { method: 'PUT', body: new Uint8Array(size) });
    expect(res.status).toBe(200);
  }

  let counter = 0;
  async function createUserWithChannel(): Promise<{
    user: User;
    channel: Channel;
  }> {
    const n = ++counter;
    const user = await dataSource.getRepository(User).save({
      email: `videos_service_${n}@example.com`,
      password: 'hashed',
    });
    const channel = await dataSource.getRepository(Channel).save({
      name: `Channel ${n}`,
      nickname: `videos_svc_${n}`,
      user_id: user.id,
    });
    return { user, channel };
  }

  async function createDraft(
    userId: string,
    fileSize = 1024,
    fileName = 'clip.mp4',
  ): Promise<Video> {
    const session = await service.initiateUpload(userId, {
      file_name: fileName,
      file_size: fileSize,
      content_type: 'video/mp4',
    });
    return videoRepository.findOneByOrFail({ public_id: session.public_id });
  }

  describe('initiateUpload', () => {
    it('should persist the draft with the Data Model fields in the user channel', async () => {
      const { user, channel } = await createUserWithChannel();

      const session = await service.initiateUpload(user.id, {
        file_name: 'Minhas Férias.mp4',
        file_size: 134217728,
        content_type: 'video/mp4',
      });

      const video = await videoRepository.findOneByOrFail({
        public_id: session.public_id,
      });
      expect(video).toMatchObject({
        channel_id: channel.id,
        title: 'Minhas Férias',
        original_filename: 'Minhas Férias.mp4',
        mime_type: 'video/mp4',
        size_bytes: 134217728,
        status: VideoStatus.DRAFT,
        processing_error: null,
        duration_seconds: null,
        metadata: null,
        thumbnail_key: null,
      });
      expect(video.upload_id.length).toBeGreaterThan(0);
      const window =
        video.upload_expires_at.getTime() - video.created_at.getTime();
      expect(Math.abs(window - 24 * HOUR_MS)).toBeLessThanOrEqual(1000);
      expect(session.upload_expires_at).toBe(
        video.upload_expires_at.toISOString(),
      );
    });

    it('should open an empty multipart upload on the original key', async () => {
      const { user } = await createUserWithChannel();

      const session = await service.initiateUpload(user.id, {
        file_name: 'clip.mp4',
        file_size: 1024,
        content_type: 'video/mp4',
      });

      const video = await videoRepository.findOneByOrFail({
        public_id: session.public_id,
      });
      await expect(
        storage.listParts(originalKey(video.id), video.upload_id),
      ).resolves.toEqual([]);
    });

    it('should hand out a part URL the storage accepts', async () => {
      const { user } = await createUserWithChannel();
      const session = await service.initiateUpload(user.id, {
        file_name: 'clip.mp4',
        file_size: 1024,
        content_type: 'video/mp4',
      });

      const res = await fetch(session.parts[0].url, {
        method: 'PUT',
        body: new Uint8Array(1024),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('etag')).toBeTruthy();
      const video = await videoRepository.findOneByOrFail({
        public_id: session.public_id,
      });
      const parts = await storage.listParts(
        originalKey(video.id),
        video.upload_id,
      );
      expect(parts).toEqual([
        expect.objectContaining({ partNumber: 1, size: 1024 }),
      ]);
    });
  });

  describe('initiateUpload compensation', () => {
    // Captures the upload id the service opens, calling through to MinIO.
    function captureUploadId(): () => string {
      let uploadId = '';
      const create = storage.createMultipartUpload.bind(
        storage,
      ) as StorageService['createMultipartUpload'];
      jest
        .spyOn(storage, 'createMultipartUpload')
        .mockImplementation(async (key: string, contentType: string) => {
          uploadId = await create(key, contentType);
          return uploadId;
        });
      return () => uploadId;
    }

    function failInsert(error: Error): void {
      jest
        .spyOn(
          moduleRef.get<Repository<Video>>(getRepositoryToken(Video)),
          'insert',
        )
        .mockRejectedValue(error);
    }

    it('should abort the multipart upload and persist nothing when the insert fails', async () => {
      const { user } = await createUserWithChannel();
      const uploadIdOf = captureUploadId();
      const abort = jest.spyOn(storage, 'abortMultipartUpload');
      const dbError = new Error('connection lost');
      failInsert(dbError);

      await expect(
        service.initiateUpload(user.id, {
          file_name: 'clip.mp4',
          file_size: 1024,
          content_type: 'video/mp4',
        }),
      ).rejects.toBe(dbError);

      expect(abort).toHaveBeenCalledTimes(1);
      const [key] = abort.mock.calls[0];
      await expect(storage.listParts(key, uploadIdOf())).resolves.toBeNull();
      await expect(videoRepository.count()).resolves.toBe(0);
    });

    it('should rethrow the insert error, not the abort error, when both fail', async () => {
      const { user } = await createUserWithChannel();
      const uploadIdOf = captureUploadId();
      const abort = jest
        .spyOn(storage, 'abortMultipartUpload')
        .mockRejectedValue(new StorageUnavailableException());
      const dbError = new Error('connection lost');
      failInsert(dbError);

      await expect(
        service.initiateUpload(user.id, {
          file_name: 'clip.mp4',
          file_size: 1024,
          content_type: 'video/mp4',
        }),
      ).rejects.toBe(dbError);

      // The upload is left for the storage-side 24 h expiry.
      const [key] = abort.mock.calls[0];
      await expect(storage.listParts(key, uploadIdOf())).resolves.toEqual([]);
      await expect(videoRepository.count()).resolves.toBe(0);
    });
  });

  describe('findOwnedOrFail', () => {
    it("should find the owner's video by its public id", async () => {
      const { user } = await createUserWithChannel();
      const draft = await createDraft(user.id);

      const found = await service.findOwnedOrFail(user.id, draft.public_id);

      expect(found.id).toBe(draft.id);
    });

    it("should throw VideoNotFoundException for another channel's video", async () => {
      const owner = await createUserWithChannel();
      const other = await createUserWithChannel();
      const draft = await createDraft(owner.user.id);

      await expect(
        service.findOwnedOrFail(other.user.id, draft.public_id),
      ).rejects.toThrow(VideoNotFoundException);
    });
  });

  describe('expireIfDue', () => {
    it('should persist failed/UPLOAD_EXPIRED for an overdue draft and abort its upload', async () => {
      const { user } = await createUserWithChannel();
      const draft = await createDraft(user.id);
      await videoRepository.update(draft.id, {
        upload_expires_at: new Date(Date.now() - 60_000),
      });
      const overdue = await videoRepository.findOneByOrFail({ id: draft.id });

      const result = await service.expireIfDue(overdue);

      expect(result).toMatchObject({
        status: VideoStatus.FAILED,
        processing_error: VideoProcessingError.UPLOAD_EXPIRED,
      });
      await expect(
        videoRepository.findOneByOrFail({ id: draft.id }),
      ).resolves.toMatchObject({
        status: VideoStatus.FAILED,
        processing_error: VideoProcessingError.UPLOAD_EXPIRED,
      });
      await expect(
        storage.listParts(originalKey(draft.id), draft.upload_id),
      ).resolves.toBeNull();
    });

    it('should keep the video failed/UPLOAD_EXPIRED when the abort fails, and propagate the error', async () => {
      const { user } = await createUserWithChannel();
      const draft = await createDraft(user.id);
      await videoRepository.update(draft.id, {
        upload_expires_at: new Date(Date.now() - 60_000),
      });
      const overdue = await videoRepository.findOneByOrFail({ id: draft.id });
      jest
        .spyOn(storage, 'abortMultipartUpload')
        .mockRejectedValueOnce(new StorageUnavailableException());

      await expect(service.expireIfDue(overdue)).rejects.toThrow(
        StorageUnavailableException,
      );

      await expect(
        videoRepository.findOneByOrFail({ id: draft.id }),
      ).resolves.toMatchObject({
        status: VideoStatus.FAILED,
        processing_error: VideoProcessingError.UPLOAD_EXPIRED,
      });
      // The next upload request already sees the expired video.
      await expect(
        service.getUploadSession(user.id, draft.public_id),
      ).rejects.toThrow(UploadExpiredException);
    });

    it('should not overwrite a video that already left draft', async () => {
      const { user } = await createUserWithChannel();
      const draft = await createDraft(user.id);
      await videoRepository.update(draft.id, {
        upload_expires_at: new Date(Date.now() - 60_000),
      });
      // In-memory copy still says draft; the row moved on to processing meanwhile.
      const stale = await videoRepository.findOneByOrFail({ id: draft.id });
      await videoRepository.update(draft.id, {
        status: VideoStatus.PROCESSING,
      });

      const result = await service.expireIfDue(stale);

      expect(result.status).toBe(VideoStatus.PROCESSING);
      expect(result.processing_error).toBeNull();
      await expect(
        videoRepository.findOneByOrFail({ id: draft.id }),
      ).resolves.toMatchObject({
        status: VideoStatus.PROCESSING,
        processing_error: null,
      });
      await expect(
        storage.listParts(originalKey(draft.id), draft.upload_id),
      ).resolves.toEqual([]);
    });
  });

  describe('getUploadSession', () => {
    it('should list the received part and re-sign only the missing one', async () => {
      const { user } = await createUserWithChannel();
      const draft = await createDraft(user.id, 134217728);
      const firstUrl = await storage.presignUploadPart(
        originalKey(draft.id),
        draft.upload_id,
        1,
        5 * 1024 * 1024,
        600,
      );
      const put = await fetch(firstUrl, {
        method: 'PUT',
        body: new Uint8Array(5 * 1024 * 1024),
      });
      expect(put.status).toBe(200);

      const session = await service.getUploadSession(user.id, draft.public_id);

      expect(session.uploaded_parts).toEqual([1]);
      expect(session.parts.map((part) => part.part_number)).toEqual([2]);
    });

    it('should fail the draft with UPLOAD_EXPIRED after the upload is aborted in the storage', async () => {
      const { user } = await createUserWithChannel();
      const draft = await createDraft(user.id);
      await storage.abortMultipartUpload(
        originalKey(draft.id),
        draft.upload_id,
      );

      await expect(
        service.getUploadSession(user.id, draft.public_id),
      ).rejects.toThrow(UploadExpiredException);

      await expect(
        videoRepository.findOneByOrFail({ id: draft.id }),
      ).resolves.toMatchObject({
        status: VideoStatus.FAILED,
        processing_error: VideoProcessingError.UPLOAD_EXPIRED,
      });
    });
  });

  describe('completeUpload', () => {
    it('should assemble two uploaded parts, move to processing and enqueue the job', async () => {
      const { user } = await createUserWithChannel();
      const draft = await createDraft(user.id, PART_SIZE + 1024);
      await putPart(draft, 1, PART_SIZE);
      await putPart(draft, 2, 1024);

      const result = await service.completeUpload(user.id, draft.public_id);

      expect(result).toEqual({
        public_id: draft.public_id,
        status: VideoStatus.PROCESSING,
      });
      await expect(
        videoRepository.findOneByOrFail({ id: draft.id }),
      ).resolves.toMatchObject({ status: VideoStatus.PROCESSING });
      const job = await queue.getJob(draft.id);
      expect(job).toBeDefined();
      expect(job!.name).toBe(PROCESS_VIDEO_JOB);
      expect(job!.data).toEqual({ videoId: draft.id });
      expect(queue.opts.prefix).toBe('streamtube-test');
      await expect(storage.headObject(originalKey(draft.id))).resolves.toEqual({
        contentLength: PART_SIZE + 1024,
      });
    }, 60_000);

    it('should revert to draft when the enqueue fails and conclude on retry from the assembled object', async () => {
      const { user } = await createUserWithChannel();
      const draft = await createDraft(user.id, 1024);
      await putPart(draft, 1, 1024);
      jest
        .spyOn(queue, 'add')
        .mockRejectedValueOnce(new Error('Connection is closed.'));

      await expect(
        service.completeUpload(user.id, draft.public_id),
      ).rejects.toThrow(QueueUnavailableException);

      await expect(
        videoRepository.findOneByOrFail({ id: draft.id }),
      ).resolves.toMatchObject({ status: VideoStatus.DRAFT });
      await expect(
        storage.listParts(originalKey(draft.id), draft.upload_id),
      ).resolves.toBeNull();

      const result = await service.completeUpload(user.id, draft.public_id);

      expect(result.status).toBe(VideoStatus.PROCESSING);
      await expect(
        videoRepository.findOneByOrFail({ id: draft.id }),
      ).resolves.toMatchObject({ status: VideoStatus.PROCESSING });
      const job = await queue.getJob(draft.id);
      expect(job?.data).toEqual({ videoId: draft.id });
    });
  });

  describe('completeUpload safeguards', () => {
    it('should answer UPLOAD_SIZE_MISMATCH and keep the draft when the parts do not follow part_size', async () => {
      const { user } = await createUserWithChannel();
      const size = PART_SIZE + 1024;
      const draft = await createDraft(user.id, size);
      // Two valid S3 parts whose total matches, split differently from the URLs.
      await putPart(draft, 1, FIVE_MIB);
      await putPart(draft, 2, size - FIVE_MIB);

      await expect(
        service.completeUpload(user.id, draft.public_id),
      ).rejects.toThrow(UploadSizeMismatchException);

      await expect(
        videoRepository.findOneByOrFail({ id: draft.id }),
      ).resolves.toMatchObject({
        status: VideoStatus.DRAFT,
        processing_error: null,
      });
      const parts = await storage.listParts(
        originalKey(draft.id),
        draft.upload_id,
      );
      expect(parts?.map((part) => part.partNumber)).toEqual([1, 2]);
      await expect(queue.getJob(draft.id)).resolves.toBeUndefined();
    }, 60_000);

    it('should answer UPLOAD_INCOMPLETE and keep the draft when the storage rejects the parts', async () => {
      const { user } = await createUserWithChannel();
      const draft = await createDraft(user.id, 1024);
      await putPart(draft, 1, 1024);
      // A part re-sent between ListParts and the completion: stale ETag.
      const listParts = storage.listParts.bind(
        storage,
      ) as StorageService['listParts'];
      jest
        .spyOn(storage, 'listParts')
        .mockImplementationOnce(async (key: string, uploadId: string) => {
          const parts = await listParts(key, uploadId);
          return parts!.map((part) => ({
            ...part,
            etag: '"0123456789abcdef0123456789abcdef"',
          }));
        });

      await expect(
        service.completeUpload(user.id, draft.public_id),
      ).rejects.toThrow(UploadIncompleteException);

      await expect(
        videoRepository.findOneByOrFail({ id: draft.id }),
      ).resolves.toMatchObject({ status: VideoStatus.DRAFT });
      await expect(
        storage.listParts(originalKey(draft.id), draft.upload_id),
      ).resolves.toHaveLength(1);
      await expect(queue.getJob(draft.id)).resolves.toBeUndefined();
    });

    // Another request changes the row between the read and the transition:
    // the HeadObject of the assembled object is where it happens.
    function changeRowDuringHead(changes: Partial<Video>): void {
      const headObject = storage.headObject.bind(
        storage,
      ) as StorageService['headObject'];
      jest
        .spyOn(storage, 'headObject')
        .mockImplementationOnce(async (key: string) => {
          const head = await headObject(key);
          const videoId = key.split('/')[1];
          await videoRepository.update(videoId, changes);
          return head;
        });
    }

    it('should re-enqueue and answer processing when another request already moved the draft to processing', async () => {
      const { user } = await createUserWithChannel();
      const draft = await createDraft(user.id, 1024);
      await putPart(draft, 1, 1024);
      changeRowDuringHead({ status: VideoStatus.PROCESSING });

      const result = await service.completeUpload(user.id, draft.public_id);

      expect(result.status).toBe(VideoStatus.PROCESSING);
      const job = await queue.getJob(draft.id);
      expect(job?.data).toEqual({ videoId: draft.id });
    });

    it('should answer UPLOAD_EXPIRED without enqueueing when another request expired the draft', async () => {
      const { user } = await createUserWithChannel();
      const draft = await createDraft(user.id, 1024);
      await putPart(draft, 1, 1024);
      changeRowDuringHead({
        status: VideoStatus.FAILED,
        processing_error: VideoProcessingError.UPLOAD_EXPIRED,
      });

      await expect(
        service.completeUpload(user.id, draft.public_id),
      ).rejects.toThrow(UploadExpiredException);

      await expect(
        videoRepository.findOneByOrFail({ id: draft.id }),
      ).resolves.toMatchObject({
        status: VideoStatus.FAILED,
        processing_error: VideoProcessingError.UPLOAD_EXPIRED,
      });
      await expect(queue.getJob(draft.id)).resolves.toBeUndefined();
    });

    it('should recover a video left in processing by a failed job when the completion is repeated', async () => {
      const { user } = await createUserWithChannel();
      const draft = await createDraft(user.id, 1024);
      await putPart(draft, 1, 1024);
      await service.completeUpload(user.id, draft.public_id);
      // A worker whose failure was never written: the video stays processing
      // and the failed job keeps the jobId in Redis.
      const cfg = queueConfig();
      const worker = new Worker(
        VIDEO_PROCESSING_QUEUE,
        () => Promise.reject(new UnrecoverableError('lost')),
        { connection: { host: cfg.host, port: cfg.port }, prefix: cfg.prefix },
      );
      try {
        await new Promise<void>((resolve) =>
          worker.once('failed', () => resolve()),
        );
      } finally {
        await worker.close();
      }
      const failedJob = await queue.getJob(draft.id);
      await expect(failedJob!.getState()).resolves.toBe('failed');

      const result = await service.completeUpload(user.id, draft.public_id);

      expect(result.status).toBe(VideoStatus.PROCESSING);
      const job = await queue.getJob(draft.id);
      await expect(job!.getState()).resolves.toBe('waiting');
      expect(job!.attemptsMade).toBe(0);
    });
  });

  describe('completeUpload racing a concurrent completion', () => {
    // The other request completes the multipart upload right after this one
    // listed the parts, so this CompleteMultipartUpload gets a real
    // NoSuchUpload from the storage. `afterComplete` is what the other request
    // did next.
    function completeConcurrentlyAfterListing(
      afterComplete: (video: { id: string }) => Promise<void> = async () => {},
    ): void {
      const listParts = storage.listParts.bind(
        storage,
      ) as StorageService['listParts'];
      jest
        .spyOn(storage, 'listParts')
        .mockImplementationOnce(async (key: string, uploadId: string) => {
          const parts = await listParts(key, uploadId);
          await storage.completeMultipartUpload(
            key,
            uploadId,
            parts!.map(({ partNumber, etag }) => ({ partNumber, etag })),
          );
          await afterComplete({ id: key.split('/')[1] });
          return parts;
        });
    }

    it('should move the draft to processing from the assembled object', async () => {
      const { user } = await createUserWithChannel();
      const draft = await createDraft(user.id, 1024);
      await putPart(draft, 1, 1024);
      completeConcurrentlyAfterListing();
      const completeSpy = jest.spyOn(storage, 'completeMultipartUpload');

      const result = await service.completeUpload(user.id, draft.public_id);

      expect(result).toEqual({
        public_id: draft.public_id,
        status: VideoStatus.PROCESSING,
      });
      // The concurrent completion and this one, rejected with NoSuchUpload.
      expect(completeSpy).toHaveBeenCalledTimes(2);
      await expect(
        videoRepository.findOneByOrFail({ id: draft.id }),
      ).resolves.toMatchObject({ status: VideoStatus.PROCESSING });
      const job = await queue.getJob(draft.id);
      expect(job?.data).toEqual({ videoId: draft.id });
      await expect(storage.headObject(originalKey(draft.id))).resolves.toEqual({
        contentLength: 1024,
      });
    });

    it('should answer processing when the other completion already moved the video to processing', async () => {
      const { user } = await createUserWithChannel();
      const draft = await createDraft(user.id, 1024);
      await putPart(draft, 1, 1024);
      completeConcurrentlyAfterListing(async ({ id }) => {
        await videoRepository.update(id, { status: VideoStatus.PROCESSING });
      });

      const result = await service.completeUpload(user.id, draft.public_id);

      expect(result.status).toBe(VideoStatus.PROCESSING);
      await expect(
        videoRepository.findOneByOrFail({ id: draft.id }),
      ).resolves.toMatchObject({
        status: VideoStatus.PROCESSING,
        processing_error: null,
      });
      const job = await queue.getJob(draft.id);
      expect(job?.data).toEqual({ videoId: draft.id });
    });

    it('should fail the draft with UPLOAD_EXPIRED when there is no assembled object', async () => {
      const { user } = await createUserWithChannel();
      const draft = await createDraft(user.id, 1024);
      await putPart(draft, 1, 1024);
      completeConcurrentlyAfterListing(async ({ id }) => {
        await storage.deleteObject(originalKey(id));
      });

      await expect(
        service.completeUpload(user.id, draft.public_id),
      ).rejects.toThrow(UploadExpiredException);

      await expect(
        videoRepository.findOneByOrFail({ id: draft.id }),
      ).resolves.toMatchObject({
        status: VideoStatus.FAILED,
        processing_error: VideoProcessingError.UPLOAD_EXPIRED,
      });
      await expect(queue.getJob(draft.id)).resolves.toBeUndefined();
    });
  });

  // A ready video as the worker leaves it: original in the storage, status ready.
  async function createReadyVideo(
    userId: string,
    original: Buffer,
    durationSeconds: number | null = 3,
    fileName = 'clip.mp4',
  ): Promise<Video> {
    const draft = await createDraft(userId, original.length, fileName);
    await storage.putObject(originalKey(draft.id), original, 'video/mp4');
    await videoRepository.update(draft.id, {
      status: VideoStatus.READY,
      duration_seconds: durationSeconds,
    });
    return videoRepository.findOneByOrFail({ id: draft.id });
  }

  describe('getStreamUrl', () => {
    it('should sign a URL the storage serves with 206 for a Range request', async () => {
      const { user } = await createUserWithChannel();
      const original = randomBytes(4096);
      const ready = await createReadyVideo(user.id, original);

      const { url } = await service.getStreamUrl(user.id, ready.public_id);

      const res = await fetch(url, { headers: { Range: 'bytes=0-1023' } });
      expect(res.status).toBe(206);
      expect(res.headers.get('content-range')).toBe('bytes 0-1023/4096');
      const body = Buffer.from(await res.arrayBuffer());
      expect(body.equals(original.subarray(0, 1024))).toBe(true);
      expect(res.headers.get('content-disposition')).toBeNull();
    });

    it.each([VideoStatus.DRAFT, VideoStatus.PROCESSING, VideoStatus.FAILED])(
      'should throw VideoNotReadyException for a %s video',
      async (status) => {
        const { user } = await createUserWithChannel();
        const draft = await createDraft(user.id);
        await videoRepository.update(draft.id, { status });

        await expect(
          service.getStreamUrl(user.id, draft.public_id),
        ).rejects.toThrow(VideoNotReadyException);
      },
    );
  });

  describe('getDownloadUrl', () => {
    it('should sign a URL the storage answers with the attachment disposition', async () => {
      const { user } = await createUserWithChannel();
      const original = randomBytes(2048);
      const ready = await createReadyVideo(
        user.id,
        original,
        3,
        'Férias 2026.mp4',
      );

      const { url } = await service.getDownloadUrl(user.id, ready.public_id);

      const res = await fetch(url);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-disposition')).toBe(
        buildAttachmentDisposition('Férias 2026.mp4'),
      );
      expect(Buffer.from(await res.arrayBuffer()).equals(original)).toBe(true);
    });

    it('should throw VideoNotReadyException for a video in processing', async () => {
      const { user } = await createUserWithChannel();
      const draft = await createDraft(user.id);
      await videoRepository.update(draft.id, {
        status: VideoStatus.PROCESSING,
      });

      await expect(
        service.getDownloadUrl(user.id, draft.public_id),
      ).rejects.toThrow(VideoNotReadyException);
    });
  });
});
