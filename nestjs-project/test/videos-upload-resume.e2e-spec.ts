import { setTimeout as delay } from 'node:timers/promises';
import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplication } from '@nestjs/common';
import type { ThrottlerStorageService } from '@nestjs/throttler';
import type { Queue } from 'bullmq';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { DataSource } from 'typeorm';
import type { ApiErrorEnvelope } from '../src/common/openapi/api-error-envelope.dto';
import { VIDEO_PROCESSING_QUEUE } from '../src/queue/video-processing.constants';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { obliterateTestQueue } from '../src/test/queue';
import { emptyTestBucket } from '../src/test/storage';
import type { UploadSessionResponseDto } from '../src/videos/dto/upload-session-response.dto';
import type { VideoResponseDto } from '../src/videos/dto/video-response.dto';
import { generatePublicId } from '../src/videos/public-id.util';
import { registerConfirmAndLogin, type LoggedInUser } from './utils/auth';
import { bodyOf, createE2eApp } from './utils/e2e-app';
import { createVideo, putPart, videoRowOf } from './utils/videos';

const FIVE_MIB = 5 * 1024 * 1024;

const VIDEO_NOT_FOUND = {
  statusCode: 404,
  error: 'VIDEO_NOT_FOUND',
  message: 'Video not found',
};

describe('videos-upload-resume', () => {
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

  function getUpload(publicId: string, user?: LoggedInUser) {
    const req = request(app.getHttpServer()).get(`/videos/${publicId}/upload`);
    return user ? req.set('Authorization', `Bearer ${user.accessToken}`) : req;
  }

  async function setStatus(publicId: string, status: string): Promise<void> {
    await dataSource.query(
      'UPDATE videos SET status = $2 WHERE public_id = $1',
      [publicId, status],
    );
  }

  // 1. GET /videos/{publicId}/upload — retomada do upload

  it('retomada-mostra-so-as-partes-que-faltam', async () => {
    const initiated = await createVideo(app, userA.accessToken, {
      file_name: 'aula.mp4',
      file_size: 134217728,
      content_type: 'video/mp4',
    });
    expect(initiated.part_count).toBe(2);

    const before = await getUpload(initiated.public_id, userA).expect(200);
    const untouched = bodyOf<UploadSessionResponseDto>(before);
    expect(untouched.uploaded_parts).toEqual([]);
    expect(untouched.parts.map((p) => p.part_number)).toEqual([1, 2]);

    const firstPart = await putPart(initiated.parts[0].url, FIVE_MIB);
    expect(firstPart.status).toBe(200);
    await delay(1100);

    const res = await getUpload(initiated.public_id, userA).expect(200);

    const resumed = bodyOf<UploadSessionResponseDto>(res);
    expect(resumed.uploaded_parts).toEqual([1]);
    expect(resumed.parts).toHaveLength(1);
    expect(resumed.parts[0].part_number).toBe(2);
    expect(new URL(resumed.parts[0].url).host).toBe(
      new URL(process.env.S3_PUBLIC_ENDPOINT!).host,
    );
    expect(Date.parse(resumed.parts_expire_at)).toBeGreaterThan(
      Date.parse(initiated.parts_expire_at),
    );
    expect(resumed).toMatchObject({
      public_id: initiated.public_id,
      part_size: 67108864,
      part_count: 2,
      status: 'draft',
    });

    const secondPart = await putPart(resumed.parts[0].url, 1024);
    expect(secondPart.status).toBe(200);
  });

  it('video-fora-de-draft-409', async () => {
    const { public_id } = await createVideo(app, userA.accessToken);
    await setStatus(public_id, 'processing');

    const processing = await getUpload(public_id, userA).expect(409);
    expect(processing.body).toEqual({
      statusCode: 409,
      error: 'INVALID_VIDEO_STATE',
      message: 'Video is not in a valid state for this operation',
    });

    await setStatus(public_id, 'ready');
    const ready = await getUpload(public_id, userA).expect(409);
    expect(bodyOf<ApiErrorEnvelope>(ready).error).toBe('INVALID_VIDEO_STATE');
  });

  it('multipart-ja-montado-continua-draft-409', async () => {
    const session = await createVideo(app, userA.accessToken);
    expect(session.part_count).toBe(1);
    expect((await putPart(session.parts[0].url, 1024)).status).toBe(200);

    jest
      .spyOn(queue, 'add')
      .mockRejectedValueOnce(new Error('Connection is closed.'));
    const completion = await request(app.getHttpServer())
      .post(`/videos/${session.public_id}/upload/complete`)
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .expect(503);
    expect(bodyOf<ApiErrorEnvelope>(completion).error).toBe(
      'QUEUE_UNAVAILABLE',
    );
    const { id, status } = await videoRowOf(dataSource, session.public_id);
    expect(status).toBe('draft');
    await expect(
      app.get(StorageService).headObject(`videos/${id}/original`),
    ).resolves.toEqual({ contentLength: 1024 });

    const res = await getUpload(session.public_id, userA).expect(409);
    expect(bodyOf<ApiErrorEnvelope>(res).error).toBe('INVALID_VIDEO_STATE');

    expect(await videoRowOf(dataSource, session.public_id)).toMatchObject({
      status: 'draft',
      processing_error: null,
    });
  });

  it('multipart-abortado-sem-objeto-410', async () => {
    const { public_id } = await createVideo(app, userA.accessToken);
    const { id, upload_id } = await videoRowOf(dataSource, public_id);
    await app
      .get(StorageService)
      .abortMultipartUpload(`videos/${id}/original`, upload_id);

    const res = await getUpload(public_id, userA).expect(410);
    expect(res.body).toEqual({
      statusCode: 410,
      error: 'UPLOAD_EXPIRED',
      message: 'Upload window has expired',
    });

    expect(await videoRowOf(dataSource, public_id)).toMatchObject({
      status: 'failed',
      processing_error: 'UPLOAD_EXPIRED',
    });

    const video = await request(app.getHttpServer())
      .get(`/videos/${public_id}`)
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .expect(200);
    expect(bodyOf<VideoResponseDto>(video)).toMatchObject({
      status: 'failed',
      processing_error: 'UPLOAD_EXPIRED',
    });
  });

  it('janela-de-upload-vencida-410', async () => {
    const { public_id } = await createVideo(app, userA.accessToken);
    await dataSource.query(
      `UPDATE videos SET upload_expires_at = now() - interval '1 minute' WHERE public_id = $1`,
      [public_id],
    );

    const res = await getUpload(public_id, userA).expect(410);
    expect(bodyOf<ApiErrorEnvelope>(res).error).toBe('UPLOAD_EXPIRED');

    expect(await videoRowOf(dataSource, public_id)).toMatchObject({
      status: 'failed',
      processing_error: 'UPLOAD_EXPIRED',
    });
  });

  it('video-ja-expirado-por-outra-requisicao-410', async () => {
    const { public_id } = await createVideo(app, userA.accessToken);
    await dataSource.query(
      `UPDATE videos SET upload_expires_at = now() - interval '1 minute' WHERE public_id = $1`,
      [public_id],
    );
    // GET /videos/{publicId} applies the lazy expiry first.
    await request(app.getHttpServer())
      .get(`/videos/${public_id}`)
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .expect(200);

    const res = await getUpload(public_id, userA).expect(410);
    expect(res.body).toEqual({
      statusCode: 410,
      error: 'UPLOAD_EXPIRED',
      message: 'Upload window has expired',
    });

    await dataSource.query(
      `UPDATE videos SET processing_error = 'PROCESSING_FAILED' WHERE public_id = $1`,
      [public_id],
    );
    const otherFailure = await getUpload(public_id, userA).expect(409);
    expect(bodyOf<ApiErrorEnvelope>(otherFailure).error).toBe(
      'INVALID_VIDEO_STATE',
    );
  });

  it('controle-de-acesso-owner-only', async () => {
    const { public_id } = await createVideo(app, userA.accessToken);

    await getUpload(public_id).expect(401);

    const notOwner = await getUpload(public_id, userB).expect(404);
    expect(notOwner.body).toEqual(VIDEO_NOT_FOUND);

    const unknown = await getUpload(generatePublicId(), userA).expect(404);
    expect(unknown.body).toEqual(notOwner.body);

    const malformed = await getUpload('abc', userA).expect(400);
    expect(bodyOf<ApiErrorEnvelope>(malformed).error).toBe('VALIDATION_ERROR');

    const owner = await getUpload(public_id, userA).expect(200);
    expect(bodyOf<UploadSessionResponseDto>(owner).status).toBe('draft');
  });
});
