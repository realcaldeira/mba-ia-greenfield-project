import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplication } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { TestingModule } from '@nestjs/testing';
import type { ThrottlerStorageService } from '@nestjs/throttler';
import type { Queue } from 'bullmq';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { DataSource } from 'typeorm';
import type { ApiErrorEnvelope } from '../src/common/openapi/api-error-envelope.dto';
import storageConfig from '../src/config/storage.config';
import { VIDEO_PROCESSING_QUEUE } from '../src/queue/video-processing.constants';
import { cleanAllTables } from '../src/test/create-test-data-source';
import {
  generateMediaFixtures,
  removeMediaFixtures,
  type MediaFixtures,
} from '../src/test/media-fixtures';
import { obliterateTestQueue } from '../src/test/queue';
import { emptyTestBucket } from '../src/test/storage';
import type { MediaUrlResponseDto } from '../src/videos/dto/media-url-response.dto';
import type { VideoResponseDto } from '../src/videos/dto/video-response.dto';
import { generatePublicId } from '../src/videos/public-id.util';
import { registerConfirmAndLogin, type LoggedInUser } from './utils/auth';
import { bodyOf, createE2eApp } from './utils/e2e-app';
import {
  createVideo,
  expectJpegAt,
  expectSecondsFromNow,
  readVersionedOpenApi,
  uploadAndProcess,
  VIDEO_METADATA_KEYS,
} from './utils/videos';
import { startInProcessWorker } from './utils/worker';

const VIDEO_NOT_FOUND = {
  statusCode: 404,
  error: 'VIDEO_NOT_FOUND',
  message: 'Video not found',
};

const VIDEO_OPERATIONS = [
  'GET /videos/{publicId}',
  'GET /videos/{publicId}/download',
  'GET /videos/{publicId}/stream',
  'GET /videos/{publicId}/upload',
  'POST /videos',
  'POST /videos/{publicId}/upload/complete',
];

const EXPECTED_DISPOSITION =
  'attachment; filename="F_rias 2026.mp4"; filename*=UTF-8\'\'F%C3%A9rias%202026.mp4';

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

describe('videos-download', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let workerContext: TestingModule;
  let queue: Queue;
  let fixtures: MediaFixtures;
  let mp4Fixture: Buffer;
  let randomBytesFixture: Buffer;
  let publicEndpointHost: string;
  let userA: LoggedInUser;
  let userB: LoggedInUser;
  let readyPublicId: string;
  let readyDuration: number | null;

  beforeAll(async () => {
    ({ app, dataSource, throttlerStorage } = await createE2eApp());
    workerContext = await startInProcessWorker();
    queue = app.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    await cleanAllTables(dataSource);
    await emptyTestBucket();
    await obliterateTestQueue(queue);
    throttlerStorage.storage.clear();
    // Fails fast when FFmpeg is missing from the image.
    fixtures = await generateMediaFixtures();
    mp4Fixture = await readFile(fixtures.faststartMp4);
    randomBytesFixture = await readFile(fixtures.randomBytes);
    publicEndpointHost = new URL(
      app.get<ConfigType<typeof storageConfig>>(storageConfig.KEY)
        .publicEndpoint,
    ).host;

    userA = await registerConfirmAndLogin(app, 'owner-a@example.com');
    userB = await registerConfirmAndLogin(app, 'other-b@example.com');
    const ready = await uploadAndProcess(app, userA.accessToken, {
      fileName: 'Férias 2026.mp4',
      contentType: 'video/mp4',
      buffer: mp4Fixture,
    });
    expect(ready.status).toBe('ready');
    readyPublicId = ready.public_id;
    readyDuration = ready.duration_seconds;
  }, 120_000);

  afterAll(async () => {
    // The worker first: it waits for its active job and closes its own
    // Redis and DB connections before the API goes down.
    await workerContext?.close();
    await app?.close();
    if (fixtures) await removeMediaFixtures(fixtures);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function getVideo(publicId: string, user: LoggedInUser) {
    return request(app.getHttpServer())
      .get(`/videos/${publicId}`)
      .set('Authorization', `Bearer ${user.accessToken}`);
  }

  function getStream(publicId: string, user: LoggedInUser) {
    return request(app.getHttpServer())
      .get(`/videos/${publicId}/stream`)
      .set('Authorization', `Bearer ${user.accessToken}`);
  }

  function getDownload(publicId: string, user?: LoggedInUser) {
    const req = request(app.getHttpServer()).get(
      `/videos/${publicId}/download`,
    );
    return user ? req.set('Authorization', `Bearer ${user.accessToken}`) : req;
  }

  async function setDuration(seconds: number | null): Promise<void> {
    await dataSource.query(
      'UPDATE videos SET duration_seconds = $2 WHERE public_id = $1',
      [readyPublicId, seconds],
    );
  }

  // 1. Vídeo `ready` produzido pelo fluxo real

  it('fluxo-ponta-a-ponta-ate-o-download', async () => {
    const videoRes = await getVideo(readyPublicId, userA).expect(200);
    const video = bodyOf<VideoResponseDto>(videoRes);
    expect(video.status).toBe('ready');
    expect(video.title).toBe('Férias 2026');
    expect(video.processing_error).toBeNull();
    expect(video.duration_seconds).toBeGreaterThanOrEqual(2.5);
    expect(video.duration_seconds).toBeLessThanOrEqual(3.5);
    expect(Object.keys(video.metadata ?? {}).sort()).toEqual(
      VIDEO_METADATA_KEYS,
    );
    expect(video.metadata).toMatchObject({ width: 1920, height: 1080 });
    await expectJpegAt(video.thumbnail_url);

    const streamRes = await getStream(readyPublicId, userA).expect(200);
    const ranged = await fetch(bodyOf<MediaUrlResponseDto>(streamRes).url, {
      headers: { Range: 'bytes=0-1023' },
    });
    const rangedBody = await ranged.arrayBuffer();
    expect(ranged.status).toBe(206);
    expect(rangedBody.byteLength).toBe(1024);

    const downloadRes = await getDownload(readyPublicId, userA).expect(200);
    const download = bodyOf<MediaUrlResponseDto>(downloadRes);
    expect(new URL(download.url).host).toBe(publicEndpointHost);
    expectSecondsFromNow(download.expires_at, 3600);

    const file = await fetch(download.url);
    const fileBody = Buffer.from(await file.arrayBuffer());
    expect(file.status).toBe(200);
    expect(file.headers.get('content-disposition')).toBe(EXPECTED_DISPOSITION);
    expect(file.headers.get('content-length')).toBe(String(mp4Fixture.length));
    expect(sha256(fileBody)).toBe(sha256(mp4Fixture));
  });

  it('ttl-do-download-independe-da-duracao', async () => {
    try {
      await setDuration(7200);
      const long = await getDownload(readyPublicId, userA).expect(200);
      expectSecondsFromNow(bodyOf<MediaUrlResponseDto>(long).expires_at, 3600);

      await setDuration(null);
      const unknown = await getDownload(readyPublicId, userA).expect(200);
      expectSecondsFromNow(
        bodyOf<MediaUrlResponseDto>(unknown).expires_at,
        3600,
      );
    } finally {
      await setDuration(readyDuration);
    }
  });

  it('controle-de-acesso-em-video-ready', async () => {
    await getDownload(readyPublicId).expect(401);

    const notOwner = await getDownload(readyPublicId, userB).expect(404);
    expect(notOwner.body).toEqual(VIDEO_NOT_FOUND);

    const unknown = await getDownload(generatePublicId(), userA).expect(404);
    expect(unknown.body).toEqual(notOwner.body);

    const malformed = await getDownload('abc', userA).expect(400);
    expect(bodyOf<ApiErrorEnvelope>(malformed).error).toBe('VALIDATION_ERROR');
  });

  // 2. Vídeo fora de `ready`

  it('rascunho-e-processing-409-video-not-ready', async () => {
    const { public_id } = await createVideo(app, userA.accessToken, {
      file_name: 'rascunho.mp4',
      file_size: 1024,
      content_type: 'video/mp4',
    });

    const draft = await getDownload(public_id, userA).expect(409);
    expect(draft.body).toEqual({
      statusCode: 409,
      error: 'VIDEO_NOT_READY',
      message: 'Video is not ready',
    });

    const notOwner = await getDownload(public_id, userB).expect(404);
    expect(bodyOf<ApiErrorEnvelope>(notOwner).error).toBe('VIDEO_NOT_FOUND');

    await dataSource.query(
      `UPDATE videos SET status = 'processing' WHERE public_id = $1`,
      [public_id],
    );
    const processing = await getDownload(public_id, userA).expect(409);
    expect(bodyOf<ApiErrorEnvelope>(processing).error).toBe('VIDEO_NOT_READY');
  });

  it('arquivo-invalido-termina-em-failed-unsupported-media', async () => {
    const processed = await uploadAndProcess(app, userA.accessToken, {
      fileName: 'aleatorio.mp4',
      contentType: 'video/mp4',
      buffer: randomBytesFixture,
    });
    expect(processed.status).toBe('failed');

    const videoRes = await getVideo(processed.public_id, userA).expect(200);
    expect(bodyOf<VideoResponseDto>(videoRes)).toMatchObject({
      status: 'failed',
      processing_error: 'UNSUPPORTED_MEDIA',
      metadata: null,
      thumbnail_url: null,
    });

    const owner = await getDownload(processed.public_id, userA).expect(409);
    expect(bodyOf<ApiErrorEnvelope>(owner).error).toBe('VIDEO_NOT_READY');
  });

  // 3. Contrato OpenAPI das rotas de vídeo

  it('openapi-tem-as-seis-operacoes-de-video', () => {
    const { paths } = readVersionedOpenApi();
    const videoOperations = Object.entries(paths).flatMap(([path, methods]) =>
      Object.entries(methods)
        .filter(([, operation]) => operation.tags?.includes('videos'))
        .map(([method, operation]) => ({
          name: `${method.toUpperCase()} ${path}`,
          operation,
        })),
    );

    expect(videoOperations.map(({ name }) => name).sort()).toEqual(
      VIDEO_OPERATIONS,
    );
    for (const { operation } of videoOperations) {
      expect(operation.security).toContainEqual({ 'access-token': [] });
    }
    expect(
      Object.keys(paths['/videos/{publicId}/download'].get.responses),
    ).toEqual(expect.arrayContaining(['200', '400', '401', '404', '409']));
  });
});
