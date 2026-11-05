import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import storageConfig from '../../config/storage.config';
import { S3_INTERNAL_CLIENT } from '../../storage/storage.constants';
import { StorageModule } from '../../storage/storage.module';
import { StorageService } from '../../storage/storage.service';
import {
  generateMediaFixtures,
  removeMediaFixtures,
  type MediaFixtures,
} from '../../test/media-fixtures';
import { emptyTestBucket } from '../../test/storage';
import { originalKey } from '../../videos/video-storage-keys';
import { MediaProcessingError } from './media.errors';
import * as processRunner from './process-runner';
import { ThumbnailService } from './thumbnail.service';

const SMALL_WIDTH = 640;
const SMALL_HEIGHT = 360;

describe('ThumbnailService (integration)', () => {
  let moduleRef: TestingModule;
  let thumbnails: ThumbnailService;
  let storage: StorageService;
  let fixtures: MediaFixtures;
  let smallVideo: string;

  async function urlFor(path: string): Promise<string> {
    const key = originalKey(randomUUID());
    await storage.putObject(key, await readFile(path), 'video/mp4');
    return storage.presignGetObject(key, {
      expiresIn: 3600,
      audience: 'internal',
    });
  }

  // Reads the dimensions of the generated JPEG with ffprobe.
  async function dimensionsOf(
    jpeg: Buffer,
  ): Promise<{ width: number; height: number }> {
    const path = join(fixtures.dir, `${randomUUID()}.jpg`);
    await writeFile(path, jpeg);
    const result = await processRunner.runProcess(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'stream=width,height',
        '-of',
        'csv=p=0',
        path,
      ],
      { timeoutMs: 10_000 },
    );
    const [width, height] = result.stdout.toString().trim().split(',');
    return { width: Number(width), height: Number(height) };
  }

  beforeAll(async () => {
    fixtures = await generateMediaFixtures();
    smallVideo = join(fixtures.dir, 'small.mp4');
    await processRunner.runProcess(
      'ffmpeg',
      [
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        `testsrc=size=${SMALL_WIDTH}x${SMALL_HEIGHT}:rate=30:duration=2`,
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        smallVideo,
      ],
      { timeoutMs: 30_000 },
    );

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
      providers: [ThumbnailService],
    }).compile();
    thumbnails = moduleRef.get(ThumbnailService);
    storage = moduleRef.get(StorageService);
    await emptyTestBucket();
  }, 60_000);

  afterAll(async () => {
    await emptyTestBucket();
    await moduleRef?.close();
    if (fixtures) await removeMediaFixtures(fixtures);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should generate a 1280 px wide JPEG with the aspect ratio preserved from a 1920x1080 video', async () => {
    const url = await urlFor(fixtures.faststartMp4);

    const jpeg = await thumbnails.generate(url, fixtures.durationSeconds);

    expect([...jpeg.subarray(0, 2)]).toEqual([0xff, 0xd8]);
    await expect(dimensionsOf(jpeg)).resolves.toEqual({
      width: 1280,
      height: 720,
    });
  });

  it('should keep the original width of a video narrower than 1280 px', async () => {
    const url = await urlFor(smallVideo);

    const jpeg = await thumbnails.generate(url, 2);

    await expect(dimensionsOf(jpeg)).resolves.toEqual({
      width: SMALL_WIDTH,
      height: SMALL_HEIGHT,
    });
  });

  it('should fall back to the frame at t = 0 when the duration points past the real end', async () => {
    const url = await urlFor(fixtures.faststartMp4);
    const firstFrame = await thumbnails.generate(url, null);
    const run = jest.spyOn(processRunner, 'runProcess');

    // 120 s → t = 5 s, past the end of the 3 s file.
    const jpeg = await thumbnails.generate(url, 120);

    const seekTimes = run.mock.calls.map(
      ([, args]) => args[args.indexOf('-ss') + 1],
    );
    expect(seekTimes).toEqual(['5', '0']);
    expect(jpeg.equals(firstFrame)).toBe(true);
  });

  it('should fail with a transient error when no frame can be extracted even at t = 0', async () => {
    const url = await storage.presignGetObject(originalKey(randomUUID()), {
      expiresIn: 3600,
      audience: 'internal',
    });

    await expect(thumbnails.generate(url, 3)).rejects.toBeInstanceOf(
      MediaProcessingError,
    );
  });

  it('should store the JPEG at videos/{id}/thumbnail.jpg with Content-Type image/jpeg', async () => {
    const videoId = randomUUID();
    const jpeg = await thumbnails.generate(
      await urlFor(fixtures.faststartMp4),
      fixtures.durationSeconds,
    );

    const key = await thumbnails.store(videoId, jpeg);

    expect(key).toBe(`videos/${videoId}/thumbnail.jpg`);
    const cfg = moduleRef.get<ConfigType<typeof storageConfig>>(
      storageConfig.KEY,
    );
    const head = await moduleRef
      .get<S3Client>(S3_INTERNAL_CLIENT)
      .send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: key }));
    expect(head.ContentType).toBe('image/jpeg');
    expect(head.ContentLength).toBe(jpeg.length);
  });
});
