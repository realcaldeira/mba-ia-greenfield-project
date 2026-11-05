import type { S3Client } from '@aws-sdk/client-s3';
import type { INestApplication } from '@nestjs/common';
import type { ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { DataSource } from 'typeorm';
import type { ApiErrorEnvelope } from '../src/common/openapi/api-error-envelope.dto';
import { S3_INTERNAL_CLIENT } from '../src/storage/storage.constants';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { emptyTestBucket } from '../src/test/storage';
import type { UploadSessionResponseDto } from '../src/videos/dto/upload-session-response.dto';
import { registerConfirmAndLogin, type LoggedInUser } from './utils/auth';
import { bodyOf, createE2eApp } from './utils/e2e-app';
import {
  countVideos,
  createVideo,
  expectSecondsFromNow,
  PUBLIC_ID_PATTERN,
  putPart,
  readVersionedOpenApi,
  type InitiateUploadBody,
} from './utils/videos';

const VALID_BODY: InitiateUploadBody = {
  file_name: 'clip.mp4',
  file_size: 1024,
  content_type: 'video/mp4',
};

describe('videos-create', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let userA: LoggedInUser;

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
    await registerConfirmAndLogin(app, 'other-b@example.com');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function postVideo(body: object, accessToken = userA.accessToken) {
    return request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send(body);
  }

  // 1. POST /videos — pré-cadastro do rascunho e início do multipart

  it('cria-rascunho-com-urls-de-partes', async () => {
    const publicHost = new URL(process.env.S3_PUBLIC_ENDPOINT!).host;

    const res = await postVideo({
      file_name: 'Minhas Férias.mp4',
      file_size: 134217728,
      content_type: 'video/mp4',
    }).expect(201);

    const body = bodyOf<UploadSessionResponseDto>(res);
    expect(body).toMatchObject({
      status: 'draft',
      title: 'Minhas Férias',
      part_size: 67108864,
      part_count: 2,
      uploaded_parts: [],
    });
    expect(body.parts.map((p) => p.part_number)).toEqual([1, 2]);
    for (const part of body.parts) {
      expect(new URL(part.url).host).toBe(publicHost);
    }
    expect(body.public_id).toMatch(PUBLIC_ID_PATTERN);
    expectSecondsFromNow(body.parts_expire_at, 3600);
    expectSecondsFromNow(body.upload_expires_at, 24 * 3600);
    for (const field of ['id', 'channel_id', 'upload_id']) {
      expect(body).not.toHaveProperty(field);
    }
    expect(JSON.stringify({ ...body, parts: [] })).not.toContain('videos/');

    const rows: Record<string, unknown>[] = await dataSource.query(
      `SELECT v.*, c.user_id, c.id AS owner_channel_id,
              extract(epoch FROM (v.upload_expires_at - v.created_at)) AS window_seconds
         FROM videos v JOIN channels c ON c.id = v.channel_id
        WHERE v.public_id = $1`,
      [body.public_id],
    );
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.user_id).toBe(userA.id);
    expect(row.channel_id).toBe(row.owner_channel_id);
    expect(row).toMatchObject({
      original_filename: 'Minhas Férias.mp4',
      mime_type: 'video/mp4',
      size_bytes: '134217728',
      status: 'draft',
      processing_error: null,
    });
    expect(String(row.upload_id).length).toBeGreaterThan(0);
    expect(
      Math.abs(Number(row.window_seconds) - 24 * 3600),
    ).toBeLessThanOrEqual(1);

    const put = await putPart(body.parts[0].url, 1024);
    expect(put.status).toBe(200);
    expect(put.headers.get('etag')).toBeTruthy();
  });

  it('limite-de-tamanho-10-gib', async () => {
    const atLimit = await postVideo({
      file_name: 'grande.mp4',
      file_size: 10737418240,
      content_type: 'video/mp4',
    }).expect(201);
    const session = bodyOf<UploadSessionResponseDto>(atLimit);
    expect(session.part_count).toBe(160);
    expect(session.parts).toHaveLength(160);

    const overLimit = await postVideo({
      file_name: 'grande.mp4',
      file_size: 10737418241,
      content_type: 'video/mp4',
    }).expect(400);
    expect(bodyOf<ApiErrorEnvelope>(overLimit)).toMatchObject({
      statusCode: 400,
      error: 'VALIDATION_ERROR',
    });

    const empty = await postVideo({
      file_name: 'grande.mp4',
      file_size: 0,
      content_type: 'video/mp4',
    }).expect(400);
    expect(bodyOf<ApiErrorEnvelope>(empty).error).toBe('VALIDATION_ERROR');

    expect(await countVideos(dataSource)).toBe(1);
  });

  it('validacao-de-mime-e-extensao', async () => {
    const rejected: object[] = [
      { file_name: 'clip.mov', file_size: 1024, content_type: 'video/mp4' },
      {
        file_name: 'clip.avi',
        file_size: 1024,
        content_type: 'video/x-msvideo',
      },
      { file_size: 1024, content_type: 'video/mp4' },
      { ...VALID_BODY, foo: 'bar' },
      { ...VALID_BODY, title: '   ' },
    ];
    for (const body of rejected) {
      const res = await postVideo(body).expect(400);
      expect(bodyOf<ApiErrorEnvelope>(res).error).toBe('VALIDATION_ERROR');
    }

    await postVideo({
      file_name: 'CLIP.MKV',
      file_size: 1024,
      content_type: 'video/x-matroska',
    }).expect(201);

    expect(await countVideos(dataSource)).toBe(1);
  });

  it('titulo-derivado-do-nome-do-arquivo', async () => {
    const lastExtension = await createVideo(app, userA.accessToken, {
      file_name: 'aula.final.webm',
      file_size: 1024,
      content_type: 'video/webm',
    });
    expect(lastExtension.title).toBe('aula.final');

    const longName = await createVideo(app, userA.accessToken, {
      file_name: `${'a'.repeat(120)}.mp4`,
      file_size: 1024,
      content_type: 'video/mp4',
    });
    expect(longName.title).toBe('a'.repeat(100));

    const trimmed = await createVideo(app, userA.accessToken, {
      file_name: 'x.mp4',
      file_size: 1024,
      content_type: 'video/mp4',
      title: '  Meu vídeo  ',
    });
    expect(trimmed.title).toBe('Meu vídeo');
  });

  it('public-id-unico-sem-throttling', async () => {
    const statuses: number[] = [];
    const publicIds: string[] = [];
    for (let n = 1; n <= 11; n++) {
      const res = await postVideo({ ...VALID_BODY, file_name: `v${n}.mp4` });
      statuses.push(res.status);
      publicIds.push(bodyOf<UploadSessionResponseDto>(res).public_id);
    }

    expect(statuses).toEqual(Array(11).fill(201));
    expect(new Set(publicIds).size).toBe(11);
    for (const publicId of publicIds) {
      expect(publicId).toMatch(PUBLIC_ID_PATTERN);
    }

    const [counts]: { distinct: string; total: string }[] =
      await dataSource.query(
        'SELECT count(DISTINCT public_id) AS distinct, count(*) AS total FROM videos',
      );
    expect(Number(counts.distinct)).toBe(11);
    expect(Number(counts.total)).toBe(11);
  });

  it('sem-token-401', async () => {
    await request(app.getHttpServer())
      .post('/videos')
      .send(VALID_BODY)
      .expect(401);
    await postVideo(VALID_BODY, 'token-invalido').expect(401);

    expect(await countVideos(dataSource)).toBe(0);
  });

  it('storage-indisponivel-503', async () => {
    jest
      .spyOn(app.get<S3Client>(S3_INTERNAL_CLIENT), 'send')
      .mockRejectedValueOnce(
        Object.assign(new Error('connect ECONNREFUSED'), {
          code: 'ECONNREFUSED',
        }) as never,
      );

    const res = await postVideo(VALID_BODY).expect(503);

    expect(res.body).toEqual({
      statusCode: 503,
      error: 'STORAGE_UNAVAILABLE',
      message: 'Storage is unavailable',
    });
    expect(await countVideos(dataSource)).toBe(0);
  });

  it('usuario-sem-canal-404-channel-not-found', async () => {
    await dataSource.query('DELETE FROM channels WHERE user_id = $1', [
      userA.id,
    ]);
    const createUpload = jest.spyOn(
      app.get<S3Client>(S3_INTERNAL_CLIENT),
      'send',
    );

    const res = await postVideo(VALID_BODY).expect(404);

    expect(res.body).toEqual({
      statusCode: 404,
      error: 'CHANNEL_NOT_FOUND',
      message: 'Channel not found',
    });
    expect(createUpload).not.toHaveBeenCalled();
    expect(await countVideos(dataSource)).toBe(0);
  });

  it('openapi-documenta-post-videos', () => {
    const operation = readVersionedOpenApi().paths['/videos'].post;

    expect(Object.keys(operation.responses)).toEqual(
      expect.arrayContaining(['201', '400', '401', '404', '503']),
    );
    expect(operation.tags).toContain('videos');
    expect(operation.security).toContainEqual({ 'access-token': [] });
  });
});
