import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { DataSource } from 'typeorm';
import type { UploadCompleteResponseDto } from '../../src/videos/dto/upload-complete-response.dto';
import type { UploadSessionResponseDto } from '../../src/videos/dto/upload-session-response.dto';
import type { VideoResponseDto } from '../../src/videos/dto/video-response.dto';
import { VideoStatus } from '../../src/videos/entities/video.entity';
import { bodyOf } from './e2e-app';

export const PUBLIC_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
export const ISO_8601_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export interface InitiateUploadBody {
  file_name: string;
  file_size: number;
  content_type: string;
  title?: string;
}

export const SMALL_VIDEO: InitiateUploadBody = {
  file_name: 'clip.mp4',
  file_size: 1024,
  content_type: 'video/mp4',
};

export async function createVideo(
  app: INestApplication<App>,
  accessToken: string,
  body: InitiateUploadBody = SMALL_VIDEO,
): Promise<UploadSessionResponseDto> {
  const res = await request(app.getHttpServer())
    .post('/videos')
    .set('Authorization', `Bearer ${accessToken}`)
    .send(body)
    .expect(201);
  return bodyOf<UploadSessionResponseDto>(res);
}

// PUT straight to the storage on a presigned UploadPart URL, with no checksum header.
export async function putPart(url: string, size: number): Promise<Response> {
  return fetch(url, { method: 'PUT', body: new Uint8Array(size) });
}

export async function videoRowOf(
  dataSource: DataSource,
  publicId: string,
): Promise<{
  id: string;
  upload_id: string;
  status: string;
  processing_error: string | null;
}> {
  const rows: {
    id: string;
    upload_id: string;
    status: string;
    processing_error: string | null;
  }[] = await dataSource.query(
    'SELECT id, upload_id, status, processing_error FROM videos WHERE public_id = $1',
    [publicId],
  );
  return rows[0];
}

export async function countVideos(dataSource: DataSource): Promise<number> {
  const rows: { count: string }[] = await dataSource.query(
    'SELECT count(*) FROM videos',
  );
  return Number(rows[0].count);
}

// Asserts that an ISO-8601 instant is `seconds` from now, within `toleranceSeconds`.
export function expectSecondsFromNow(
  iso: string,
  seconds: number,
  toleranceSeconds = 5,
): void {
  expect(iso).toMatch(ISO_8601_PATTERN);
  const delta = (Date.parse(iso) - Date.now()) / 1000;
  expect(Math.abs(delta - seconds)).toBeLessThanOrEqual(toleranceSeconds);
}

export type OpenApiOperation = {
  tags?: string[];
  security?: Record<string, string[]>[];
  responses: Record<string, unknown>;
};

export type OpenApiDocument = {
  paths: Record<string, Record<string, OpenApiOperation>>;
};

// The versioned contract consumed by the frontend.
export function readVersionedOpenApi(): OpenApiDocument {
  return JSON.parse(
    readFileSync(join(__dirname, '..', '..', 'openapi.json'), 'utf-8'),
  ) as OpenApiDocument;
}

export interface UploadAndProcessInput {
  fileName: string;
  contentType: string;
  buffer: Buffer;
}

const PROCESSING_POLL_INTERVAL_MS = 500;
const PROCESSING_TIMEOUT_MS = 60_000;
const SETTLED_STATUSES: string[] = [VideoStatus.READY, VideoStatus.FAILED];

// The real client flow: POST /videos, PUT of every part straight to the storage
// on its presigned URL (no checksum header), upload/complete, then polling of
// GET /videos/{publicId} until the worker leaves the video ready or failed.
// Needs a worker consuming the test queue (see ./worker.ts).
export async function uploadAndProcess(
  app: INestApplication<App>,
  accessToken: string,
  { fileName, contentType, buffer }: UploadAndProcessInput,
): Promise<VideoResponseDto> {
  const session = await createVideo(app, accessToken, {
    file_name: fileName,
    file_size: buffer.length,
    content_type: contentType,
  });

  for (const part of session.parts) {
    const start = (part.part_number - 1) * session.part_size;
    const body = new Uint8Array(
      buffer.subarray(start, start + session.part_size),
    );
    const res = await fetch(part.url, { method: 'PUT', body });
    expect(res.status).toBe(200);
  }

  const completed = await request(app.getHttpServer())
    .post(`/videos/${session.public_id}/upload/complete`)
    .set('Authorization', `Bearer ${accessToken}`)
    .expect(202);
  expect(bodyOf<UploadCompleteResponseDto>(completed).status).toBe(
    VideoStatus.PROCESSING,
  );

  const deadline = Date.now() + PROCESSING_TIMEOUT_MS;
  for (;;) {
    const res = await request(app.getHttpServer())
      .get(`/videos/${session.public_id}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    const video = bodyOf<VideoResponseDto>(res);
    if (SETTLED_STATUSES.includes(video.status)) return video;
    if (Date.now() > deadline) {
      throw new Error(
        `Video ${session.public_id} still "${video.status}" after ${PROCESSING_TIMEOUT_MS} ms`,
      );
    }
    await new Promise((resolve) =>
      setTimeout(resolve, PROCESSING_POLL_INTERVAL_MS),
    );
  }
}

// TD-06 "Metadata shape": exactly these keys, sorted.
export const VIDEO_METADATA_KEYS = [
  'audio_codec',
  'bit_rate',
  'format_name',
  'frame_rate',
  'height',
  'video_codec',
  'width',
];

// GET straight to the storage on the thumbnail URL of a ready video.
export async function expectJpegAt(url: string | null): Promise<void> {
  expect(typeof url).toBe('string');
  const res = await fetch(url!);
  await res.arrayBuffer();
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('image/jpeg');
}
