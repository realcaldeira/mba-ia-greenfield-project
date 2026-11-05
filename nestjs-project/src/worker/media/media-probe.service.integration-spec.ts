import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import storageConfig from '../../config/storage.config';
import { StorageModule } from '../../storage/storage.module';
import { StorageService } from '../../storage/storage.service';
import {
  generateMediaFixtures,
  removeMediaFixtures,
  type MediaFixtures,
} from '../../test/media-fixtures';
import { emptyTestBucket } from '../../test/storage';
import { originalKey } from '../../videos/video-storage-keys';
import { UnsupportedMediaError } from './media.errors';
import { MediaProbeService } from './media-probe.service';

const METADATA_KEYS = [
  'audio_codec',
  'bit_rate',
  'format_name',
  'frame_rate',
  'height',
  'video_codec',
  'width',
];

describe('MediaProbeService (integration)', () => {
  let moduleRef: TestingModule;
  let probeService: MediaProbeService;
  let storage: StorageService;
  let fixtures: MediaFixtures;

  // Uploads a fixture as a video original and returns the internal presigned
  // URL ffprobe reads from, as the worker does.
  async function urlFor(path: string, contentType: string): Promise<string> {
    const key = originalKey(randomUUID());
    await storage.putObject(key, await readFile(path), contentType);
    return storage.presignGetObject(key, {
      expiresIn: 3600,
      audience: 'internal',
    });
  }

  beforeAll(async () => {
    fixtures = await generateMediaFixtures();
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
      providers: [MediaProbeService],
    }).compile();
    probeService = moduleRef.get(MediaProbeService);
    storage = moduleRef.get(StorageService);
    await emptyTestBucket();
  }, 60_000);

  afterAll(async () => {
    await emptyTestBucket();
    await moduleRef?.close();
    if (fixtures) await removeMediaFixtures(fixtures);
  });

  it('should read the duration and the seven metadata keys of a faststart MP4', async () => {
    const url = await urlFor(fixtures.faststartMp4, 'video/mp4');

    const result = await probeService.probe(url);

    expect(result.duration_seconds).toBeCloseTo(fixtures.durationSeconds, 1);
    expect(Object.keys(result.metadata).sort()).toEqual(METADATA_KEYS);
    expect(result.metadata).toEqual({
      width: 1920,
      height: 1080,
      video_codec: 'h264',
      audio_codec: 'aac',
      bit_rate: expect.any(Number) as number,
      frame_rate: 30,
      format_name: expect.stringContaining('mp4') as string,
    });
  });

  it('should read an MP4 with the moov atom at the end through the URL with the same result', async () => {
    const faststart = await probeService.probe(
      await urlFor(fixtures.faststartMp4, 'video/mp4'),
    );

    const moovAtEnd = await probeService.probe(
      await urlFor(fixtures.moovAtEndMp4, 'video/mp4'),
    );

    expect(moovAtEnd.duration_seconds).toBeCloseTo(
      faststart.duration_seconds!,
      1,
    );
    expect(moovAtEnd.metadata).toEqual({
      ...faststart.metadata,
      bit_rate: expect.any(Number) as number,
    });
  });

  it('should read the metadata of a .mov file', async () => {
    const result = await probeService.probe(
      await urlFor(fixtures.mov, 'video/quicktime'),
    );

    expect(result.metadata).toMatchObject({
      width: 1920,
      height: 1080,
      video_codec: 'h264',
      audio_codec: 'aac',
    });
    expect(result.metadata.format_name).toContain('mov');
  });

  it('should read the metadata of a .webm file', async () => {
    const result = await probeService.probe(
      await urlFor(fixtures.webm, 'video/webm'),
    );

    expect(result.duration_seconds).toBeCloseTo(fixtures.durationSeconds, 0);
    expect(result.metadata).toMatchObject({
      width: 1920,
      height: 1080,
      video_codec: 'vp8',
      audio_codec: 'opus',
      format_name: 'matroska,webm',
    });
  });

  it('should reject audio-only media with UnsupportedMediaError', async () => {
    const url = await urlFor(fixtures.audioOnly, 'video/mp4');

    await expect(probeService.probe(url)).rejects.toBeInstanceOf(
      UnsupportedMediaError,
    );
  });

  it('should reject random bytes with UnsupportedMediaError', async () => {
    const url = await urlFor(fixtures.randomBytes, 'video/mp4');

    await expect(probeService.probe(url)).rejects.toBeInstanceOf(
      UnsupportedMediaError,
    );
  });

  it('should reject an HLS playlist disguised as MP4 before it opens the URLs it lists', async () => {
    const playlist = [
      '#EXTM3U',
      '#EXT-X-TARGETDURATION:1',
      '#EXTINF:1,',
      'file:///etc/passwd',
      '#EXTINF:1,',
      'http://redis:6379/segment.ts',
      '#EXT-X-ENDLIST',
      '',
    ].join('\n');
    const key = originalKey(randomUUID());
    await storage.putObject(key, Buffer.from(playlist), 'video/mp4');
    const url = await storage.presignGetObject(key, {
      expiresIn: 3600,
      audience: 'internal',
    });

    await expect(probeService.probe(url)).rejects.toBeInstanceOf(
      UnsupportedMediaError,
    );
  });

  it('should fail with a transient error, not UnsupportedMediaError, when the key does not exist', async () => {
    const url = await storage.presignGetObject(originalKey(randomUUID()), {
      expiresIn: 3600,
      audience: 'internal',
    });

    const error = await probeService.probe(url).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(UnsupportedMediaError);
  });
});
