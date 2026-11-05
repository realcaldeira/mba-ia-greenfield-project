import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplication } from '@nestjs/common';
import type { ThrottlerStorageService } from '@nestjs/throttler';
import type { Job, Queue } from 'bullmq';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { DataSource } from 'typeorm';
import type { ApiErrorEnvelope } from '../src/common/openapi/api-error-envelope.dto';
import { VIDEO_PROCESSING_QUEUE } from '../src/queue/video-processing.constants';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { obliterateTestQueue } from '../src/test/queue';
import { emptyTestBucket } from '../src/test/storage';
import type { VideoResponseDto } from '../src/videos/dto/video-response.dto';
import { generatePublicId } from '../src/videos/public-id.util';
import { registerConfirmAndLogin, type LoggedInUser } from './utils/auth';
import { bodyOf, createE2eApp } from './utils/e2e-app';
import { createVideo, putPart, videoRowOf } from './utils/videos';

const PART_SIZE = 67108864;
const FIVE_MIB = 5 * 1024 * 1024;

const VIDEO_NOT_FOUND = {
  statusCode: 404,
  error: 'VIDEO_NOT_FOUND',
  message: 'Video not found',
};

describe('videos-upload-complete', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let queue: Queue;
  let userA: LoggedInUser;
  let userB: LoggedInUser;

  beforeAll(async () => {
    ({ app, dataSource, throttlerStorage } = await createE2eApp());
    queue = app.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  afterAll(async () => {
    await obliterateTestQueue(queue);
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await emptyTestBucket();
    await obliterateTestQueue(queue);
    throttlerStorage.storage.clear();
    userA = await registerConfirmAndLogin(app, 'owner-a@example.com');
    userB = await registerConfirmAndLogin(app, 'other-b@example.com');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function complete(publicId: string, user?: LoggedInUser) {
    const req = request(app.getHttpServer()).post(
      `/videos/${publicId}/upload/complete`,
    );
    return user ? req.set('Authorization', `Bearer ${user.accessToken}`) : req;
  }

  async function jobsOf(videoId: string): Promise<Job[]> {
    const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
    return jobs.filter((job) => job.id === videoId);
  }

  // Creates a video of `size` bytes and uploads a single part with all its bytes.
  async function uploadedSmallVideo(size = 1024) {
    const session = await createVideo(app, userA.accessToken, {
      file_name: 'clip.mp4',
      file_size: size,
      content_type: 'video/mp4',
    });
    expect((await putPart(session.parts[0].url, size)).status).toBe(200);
    return session;
  }

  // 1. POST /videos/{publicId}/upload/complete — conclusão e enfileiramento

  it('conclusao-monta-o-original-e-enfileira', async () => {
    const session = await createVideo(app, userA.accessToken, {
      file_name: 'duas-partes.mp4',
      file_size: PART_SIZE + 1024,
      content_type: 'video/mp4',
    });
    expect(session.part_count).toBe(2);
    expect((await putPart(session.parts[0].url, PART_SIZE)).status).toBe(200);
    expect((await putPart(session.parts[1].url, 1024)).status).toBe(200);

    const res = await complete(session.public_id, userA).expect(202);
    expect(res.body).toEqual({
      public_id: session.public_id,
      status: 'processing',
    });

    const { id, status } = await videoRowOf(dataSource, session.public_id);
    expect(status).toBe('processing');
    const jobs = await jobsOf(id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe('process-video');
    expect(jobs[0].data).toEqual({ videoId: id });
    expect(jobs[0].id).toBe(id);

    await expect(
      app.get(StorageService).headObject(`videos/${id}/original`),
    ).resolves.toEqual({ contentLength: PART_SIZE + 1024 });

    const video = await request(app.getHttpServer())
      .get(`/videos/${session.public_id}`)
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .expect(200);
    expect(bodyOf<VideoResponseDto>(video).status).toBe('processing');
  }, 60_000);

  it('partes-faltando-409-upload-incomplete', async () => {
    const session = await createVideo(app, userA.accessToken, {
      file_name: 'clip.mp4',
      file_size: PART_SIZE + 1024,
      content_type: 'video/mp4',
    });
    expect((await putPart(session.parts[0].url, PART_SIZE)).status).toBe(200);

    const res = await complete(session.public_id, userA).expect(409);
    expect(res.body).toEqual({
      statusCode: 409,
      error: 'UPLOAD_INCOMPLETE',
      message: 'Upload has missing or non-contiguous parts',
    });

    const video = await request(app.getHttpServer())
      .get(`/videos/${session.public_id}`)
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .expect(200);
    expect(bodyOf<VideoResponseDto>(video).status).toBe('draft');

    const { id } = await videoRowOf(dataSource, session.public_id);
    expect(await jobsOf(id)).toHaveLength(0);
  });

  it('tamanho-divergente-recusado-pelo-storage-409-upload-incomplete', async () => {
    const session = await createVideo(app, userA.accessToken, {
      file_name: 'clip.mp4',
      file_size: 2048,
      content_type: 'video/mp4',
    });
    // The part URL signs content-length 2048: a 1024-byte body never lands.
    expect((await putPart(session.parts[0].url, 1024)).status).toBe(403);

    const res = await complete(session.public_id, userA).expect(409);
    expect(bodyOf<ApiErrorEnvelope>(res).error).toBe('UPLOAD_INCOMPLETE');

    const row = await videoRowOf(dataSource, session.public_id);
    expect(row).toMatchObject({ status: 'draft', processing_error: null });
    expect(await jobsOf(row.id)).toHaveLength(0);
  });

  it('partes-fora-do-part-size-recusadas-pelo-storage-409-upload-incomplete', async () => {
    const size = PART_SIZE + 1024;
    const session = await createVideo(app, userA.accessToken, {
      file_name: 'clip.mp4',
      file_size: size,
      content_type: 'video/mp4',
    });
    // Same total, valid for S3, but not the 64 MiB split signed into the URLs:
    // the storage refuses both bodies, so nothing beyond the declared size lands.
    expect((await putPart(session.parts[0].url, FIVE_MIB)).status).toBe(403);
    expect((await putPart(session.parts[1].url, size - FIVE_MIB)).status).toBe(
      403,
    );

    const res = await complete(session.public_id, userA).expect(409);
    expect(res.body).toEqual({
      statusCode: 409,
      error: 'UPLOAD_INCOMPLETE',
      message: 'Upload has missing or non-contiguous parts',
    });

    const row = await videoRowOf(dataSource, session.public_id);
    expect(row).toMatchObject({ status: 'draft', processing_error: null });
    expect(await jobsOf(row.id)).toHaveLength(0);
    await expect(
      app.get(StorageService).headObject(`videos/${row.id}/original`),
    ).resolves.toBeNull();
  }, 60_000);

  it('fila-indisponivel-503-e-retry-sem-reenviar-partes', async () => {
    const session = await uploadedSmallVideo();
    jest
      .spyOn(queue, 'add')
      .mockRejectedValueOnce(new Error('Connection is closed.'));

    const failed = await complete(session.public_id, userA).expect(503);
    expect(failed.body).toEqual({
      statusCode: 503,
      error: 'QUEUE_UNAVAILABLE',
      message: 'Processing queue is unavailable',
    });
    const row = await videoRowOf(dataSource, session.public_id);
    expect(row.status).toBe('draft');
    expect(await jobsOf(row.id)).toHaveLength(0);

    const retried = await complete(session.public_id, userA).expect(202);
    expect(retried.body).toMatchObject({ status: 'processing' });
    expect(await jobsOf(row.id)).toHaveLength(1);
    await expect(
      app.get(StorageService).headObject(`videos/${row.id}/original`),
    ).resolves.toEqual({ contentLength: 1024 });
  });

  it('conclusao-repetida-em-processing-idempotente', async () => {
    const session = await uploadedSmallVideo();
    const first = await complete(session.public_id, userA).expect(202);
    expect(first.body).toMatchObject({ status: 'processing' });

    const again = await complete(session.public_id, userA).expect(202);
    expect(again.body).toEqual({
      public_id: session.public_id,
      status: 'processing',
    });

    const row = await videoRowOf(dataSource, session.public_id);
    const jobs = await jobsOf(row.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe(row.id);
    expect(row.status).toBe('processing');
  });

  it('video-ready-ou-failed-409-invalid-video-state', async () => {
    const { public_id } = await createVideo(app, userA.accessToken);
    await dataSource.query(
      `UPDATE videos SET status = 'ready' WHERE public_id = $1`,
      [public_id],
    );

    const ready = await complete(public_id, userA).expect(409);
    expect(bodyOf<ApiErrorEnvelope>(ready).error).toBe('INVALID_VIDEO_STATE');

    await dataSource.query(
      `UPDATE videos SET status = 'failed', processing_error = 'PROCESSING_FAILED' WHERE public_id = $1`,
      [public_id],
    );
    const failed = await complete(public_id, userA).expect(409);
    expect(bodyOf<ApiErrorEnvelope>(failed).error).toBe('INVALID_VIDEO_STATE');

    const { id } = await videoRowOf(dataSource, public_id);
    expect(await jobsOf(id)).toHaveLength(0);
  });

  it('janela-de-upload-vencida-410', async () => {
    const session = await uploadedSmallVideo();
    await dataSource.query(
      `UPDATE videos SET upload_expires_at = now() - interval '1 minute' WHERE public_id = $1`,
      [session.public_id],
    );

    const res = await complete(session.public_id, userA).expect(410);
    expect(res.body).toEqual({
      statusCode: 410,
      error: 'UPLOAD_EXPIRED',
      message: 'Upload window has expired',
    });

    const row = await videoRowOf(dataSource, session.public_id);
    expect(row).toMatchObject({
      status: 'failed',
      processing_error: 'UPLOAD_EXPIRED',
    });
    expect(await jobsOf(row.id)).toHaveLength(0);
  });

  it('video-ja-expirado-por-outra-requisicao-410', async () => {
    const session = await uploadedSmallVideo();
    await dataSource.query(
      `UPDATE videos SET upload_expires_at = now() - interval '1 minute' WHERE public_id = $1`,
      [session.public_id],
    );
    // GET /videos/{publicId} applies the lazy expiry first.
    await request(app.getHttpServer())
      .get(`/videos/${session.public_id}`)
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .expect(200);

    const res = await complete(session.public_id, userA).expect(410);
    expect(res.body).toEqual({
      statusCode: 410,
      error: 'UPLOAD_EXPIRED',
      message: 'Upload window has expired',
    });

    const row = await videoRowOf(dataSource, session.public_id);
    expect(row).toMatchObject({
      status: 'failed',
      processing_error: 'UPLOAD_EXPIRED',
    });
    expect(await jobsOf(row.id)).toHaveLength(0);
  });

  it('controle-de-acesso-owner-only', async () => {
    const session = await uploadedSmallVideo();

    await complete(session.public_id).expect(401);

    const notOwner = await complete(session.public_id, userB).expect(404);
    expect(notOwner.body).toEqual(VIDEO_NOT_FOUND);

    const unknown = await complete(generatePublicId(), userA).expect(404);
    expect(unknown.body).toEqual(notOwner.body);

    const malformed = await complete('abc', userA).expect(400);
    expect(bodyOf<ApiErrorEnvelope>(malformed).error).toBe('VALIDATION_ERROR');

    const row = await videoRowOf(dataSource, session.public_id);
    expect(row.status).toBe('draft');
    expect(await jobsOf(row.id)).toHaveLength(0);
  });
});
