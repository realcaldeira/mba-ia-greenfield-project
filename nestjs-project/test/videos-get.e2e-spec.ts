import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { INestApplication } from '@nestjs/common';
import type { ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { DataSource } from 'typeorm';
import type { S3Client } from '@aws-sdk/client-s3';
import type { ApiErrorEnvelope } from '../src/common/openapi/api-error-envelope.dto';
import { S3_INTERNAL_CLIENT } from '../src/storage/storage.constants';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { emptyTestBucket } from '../src/test/storage';
import type { VideoResponseDto } from '../src/videos/dto/video-response.dto';
import { generatePublicId } from '../src/videos/public-id.util';
import { registerConfirmAndLogin, type LoggedInUser } from './utils/auth';
import { bodyOf, createE2eApp } from './utils/e2e-app';
import { createVideo, ISO_8601_PATTERN, videoRowOf } from './utils/videos';

const execFileAsync = promisify(execFile);

const VIDEO_RESPONSE_KEYS = [
  'created_at',
  'duration_seconds',
  'metadata',
  'mime_type',
  'processing_error',
  'public_id',
  'size_bytes',
  'status',
  'thumbnail_url',
  'title',
  'updated_at',
];

const VIDEO_NOT_FOUND = {
  statusCode: 404,
  error: 'VIDEO_NOT_FOUND',
  message: 'Video not found',
};

const METADATA = {
  width: 1920,
  height: 1080,
  video_codec: 'h264',
  audio_codec: 'aac',
  bit_rate: 4500000,
  frame_rate: 30,
  format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
};

async function generateJpeg(): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'videos-get-'));
  const file = join(dir, 'thumbnail.jpg');
  try {
    await execFileAsync('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=320x240:duration=1',
      '-frames:v',
      '1',
      '-c:v',
      'mjpeg',
      file,
    ]);
    return await readFile(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('videos-get', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let userA: LoggedInUser;
  let userB: LoggedInUser;

  beforeAll(async () => {
    ({ app, dataSource, throttlerStorage } = await createE2eApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await emptyTestBucket();
    throttlerStorage.storage.clear();
    userA = await registerConfirmAndLogin(app, 'owner-a@example.com');
    userB = await registerConfirmAndLogin(app, 'other-b@example.com');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function getVideo(publicId: string, user?: LoggedInUser) {
    const req = request(app.getHttpServer()).get(`/videos/${publicId}`);
    return user ? req.set('Authorization', `Bearer ${user.accessToken}`) : req;
  }

  // 1. GET /videos/{publicId} — status do vídeo, owner-only e lazy expiry

  it('dono-ve-rascunho-com-campos-fechados', async () => {
    const { public_id } = await createVideo(app, userA.accessToken);

    const res = await getVideo(public_id, userA).expect(200);

    const body = bodyOf<VideoResponseDto>(res);
    expect(Object.keys(body).sort()).toEqual(VIDEO_RESPONSE_KEYS);
    expect(body).toMatchObject({
      public_id,
      status: 'draft',
      metadata: null,
      processing_error: null,
      thumbnail_url: null,
      duration_seconds: null,
      size_bytes: 1024,
      mime_type: 'video/mp4',
    });
    expect(body.created_at).toMatch(ISO_8601_PATTERN);
    expect(body.updated_at).toMatch(ISO_8601_PATTERN);
    for (const field of [
      'id',
      'channel_id',
      'original_filename',
      'upload_id',
      'thumbnail_key',
    ]) {
      expect(body).not.toHaveProperty(field);
    }
    expect(Object.values(body).join('|')).not.toContain('videos/');
  });

  it('ready-com-thumbnail-url-assinada', async () => {
    const { public_id } = await createVideo(app, userA.accessToken);
    const { id } = await videoRowOf(dataSource, public_id);
    const thumbnailKey = `videos/${id}/thumbnail.jpg`;
    await app
      .get(StorageService)
      .putObject(thumbnailKey, await generateJpeg(), 'image/jpeg');
    await dataSource.query(
      `UPDATE videos SET status = 'ready', thumbnail_key = $2, duration_seconds = 3, metadata = $3
        WHERE id = $1`,
      [id, thumbnailKey, JSON.stringify(METADATA)],
    );

    const res = await getVideo(public_id, userA).expect(200);

    const body = bodyOf<VideoResponseDto>(res);
    expect(body.status).toBe('ready');
    expect(body.metadata).toEqual(METADATA);
    expect(typeof body.thumbnail_url).toBe('string');
    expect(new URL(body.thumbnail_url!).host).toBe(
      new URL(process.env.S3_PUBLIC_ENDPOINT!).host,
    );
    expect(body).not.toHaveProperty('thumbnail_key');

    const thumbnail = await fetch(body.thumbnail_url!);
    expect(thumbnail.status).toBe(200);
    expect(thumbnail.headers.get('content-type')).toBe('image/jpeg');
    const bytes = new Uint8Array(await thumbnail.arrayBuffer());
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);

    await dataSource.query(
      `UPDATE videos SET status = 'processing' WHERE id = $1`,
      [id],
    );
    const processing = await getVideo(public_id, userA).expect(200);
    expect(bodyOf<VideoResponseDto>(processing).thumbnail_url).toBeNull();
  });

  it('lazy-expiry-do-rascunho-vencido', async () => {
    const { public_id } = await createVideo(app, userA.accessToken);
    await dataSource.query(
      `UPDATE videos SET upload_expires_at = now() - interval '1 minute' WHERE public_id = $1`,
      [public_id],
    );

    const res = await getVideo(public_id, userA).expect(200);
    expect(bodyOf<VideoResponseDto>(res)).toMatchObject({
      status: 'failed',
      processing_error: 'UPLOAD_EXPIRED',
    });

    const row = await videoRowOf(dataSource, public_id);
    expect(row).toMatchObject({
      status: 'failed',
      processing_error: 'UPLOAD_EXPIRED',
    });

    const again = await getVideo(public_id, userA).expect(200);
    expect(bodyOf<VideoResponseDto>(again)).toMatchObject({
      status: 'failed',
      processing_error: 'UPLOAD_EXPIRED',
    });
  });

  it('lazy-expiry-com-storage-fora-503-e-video-ja-failed', async () => {
    const { public_id } = await createVideo(app, userA.accessToken);
    await dataSource.query(
      `UPDATE videos SET upload_expires_at = now() - interval '1 minute' WHERE public_id = $1`,
      [public_id],
    );
    // The AbortMultipartUpload of the expiry is the first storage call.
    jest
      .spyOn(app.get<S3Client>(S3_INTERNAL_CLIENT), 'send')
      .mockRejectedValueOnce(
        Object.assign(new Error('connect ECONNREFUSED'), {
          code: 'ECONNREFUSED',
        }) as never,
      );

    const res = await getVideo(public_id, userA).expect(503);
    expect(res.body).toEqual({
      statusCode: 503,
      error: 'STORAGE_UNAVAILABLE',
      message: 'Storage is unavailable',
    });

    expect(await videoRowOf(dataSource, public_id)).toMatchObject({
      status: 'failed',
      processing_error: 'UPLOAD_EXPIRED',
    });
    const again = await getVideo(public_id, userA).expect(200);
    expect(bodyOf<VideoResponseDto>(again)).toMatchObject({
      status: 'failed',
      processing_error: 'UPLOAD_EXPIRED',
    });
  });

  it('controle-de-acesso-owner-only', async () => {
    const { public_id } = await createVideo(app, userA.accessToken);

    await getVideo(public_id).expect(401);

    const notOwner = await getVideo(public_id, userB).expect(404);
    expect(notOwner.body).toEqual(VIDEO_NOT_FOUND);

    const unknown = await getVideo(generatePublicId(), userA).expect(404);
    expect(unknown.body).toEqual(notOwner.body);

    const owner = await getVideo(public_id, userA).expect(200);
    expect(bodyOf<VideoResponseDto>(owner).status).toBe('draft');
  });

  it('public-id-malformado-400', async () => {
    const short = await getVideo('abc', userA).expect(400);
    expect(bodyOf<ApiErrorEnvelope>(short).error).toBe('VALIDATION_ERROR');

    const long = await getVideo('abcdefghijkl', userA).expect(400);
    expect(bodyOf<ApiErrorEnvelope>(long).error).toBe('VALIDATION_ERROR');
  });
});
