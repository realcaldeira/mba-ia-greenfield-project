import { randomBytes, randomUUID } from 'node:crypto';
import { S3Client } from '@aws-sdk/client-s3';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { emptyTestBucket } from '../test/storage';
import { S3_INTERNAL_CLIENT } from './storage.constants';
import {
  MultipartUploadMissingException,
  MultipartUploadRejectedException,
  StorageUnavailableException,
} from './storage.exceptions';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

// S3 rejects non-final parts smaller than 5 MiB.
const FIRST_PART_BYTES = 5 * 1024 * 1024;
const LAST_PART_BYTES = 1024;
const URL_TTL_SECONDS = 600;
// Never created by minio-init: every call against it answers NoSuchBucket.
const MISSING_BUCKET = 'streamtube-test-missing-bucket';

async function compileStorageModule(
  internalClient?: S3Client,
  bucket?: string,
): Promise<TestingModule> {
  const builder = Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
      StorageModule,
    ],
  });
  if (internalClient) {
    builder.overrideProvider(S3_INTERNAL_CLIENT).useValue(internalClient);
  }
  if (bucket) {
    builder
      .overrideProvider(storageConfig.KEY)
      .useValue({ ...storageConfig(), bucket });
  }
  return builder.compile();
}

function newVideoKey(): string {
  return `videos/${randomUUID()}/original`;
}

describe('StorageService (integration)', () => {
  let moduleRef: TestingModule;
  let storage: StorageService;
  let cfg: ConfigType<typeof storageConfig>;

  beforeAll(async () => {
    moduleRef = await compileStorageModule();
    storage = moduleRef.get(StorageService);
    cfg = moduleRef.get(storageConfig.KEY);
  });

  afterAll(async () => {
    await emptyTestBucket();
    await moduleRef.close();
  });

  beforeEach(async () => {
    await emptyTestBucket();
  });

  async function putPart(url: string, body: Buffer): Promise<Response> {
    return fetch(url, { method: 'PUT', body: new Uint8Array(body) });
  }

  async function uploadObject(key: string, body: Buffer): Promise<void> {
    await storage.putObject(key, body, 'video/mp4');
  }

  describe('multipart upload', () => {
    it('should accept parts on presigned URLs, list them and assemble the object', async () => {
      const key = newVideoKey();
      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');

      const firstUrl = await storage.presignUploadPart(
        key,
        uploadId,
        1,
        FIRST_PART_BYTES,
        URL_TTL_SECONDS,
      );
      const lastUrl = await storage.presignUploadPart(
        key,
        uploadId,
        2,
        LAST_PART_BYTES,
        URL_TTL_SECONDS,
      );
      expect(firstUrl).not.toMatch(/x-amz-checksum|x-amz-sdk-checksum/i);

      const firstRes = await putPart(firstUrl, randomBytes(FIRST_PART_BYTES));
      const lastRes = await putPart(lastUrl, randomBytes(LAST_PART_BYTES));
      expect(firstRes.status).toBe(200);
      expect(lastRes.status).toBe(200);

      const parts = await storage.listParts(key, uploadId);
      expect(
        parts?.map(({ partNumber, size }) => ({ partNumber, size })),
      ).toEqual([
        { partNumber: 1, size: FIRST_PART_BYTES },
        { partNumber: 2, size: LAST_PART_BYTES },
      ]);
      expect(parts?.every((part) => part.etag.length > 0)).toBe(true);

      await storage.completeMultipartUpload(key, uploadId, parts!);

      await expect(storage.headObject(key)).resolves.toEqual({
        contentLength: FIRST_PART_BYTES + LAST_PART_BYTES,
      });
      await expect(storage.listParts(key, uploadId)).resolves.toBeNull();
    }, 30000);

    it('should throw MultipartUploadMissingException when the upload was already completed', async () => {
      const key = newVideoKey();
      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
      const url = await storage.presignUploadPart(
        key,
        uploadId,
        1,
        LAST_PART_BYTES,
        URL_TTL_SECONDS,
      );
      expect((await putPart(url, randomBytes(LAST_PART_BYTES))).status).toBe(
        200,
      );
      const parts = await storage.listParts(key, uploadId);
      await storage.completeMultipartUpload(key, uploadId, parts!);

      await expect(
        storage.completeMultipartUpload(key, uploadId, parts!),
      ).rejects.toBeInstanceOf(MultipartUploadMissingException);
      await expect(storage.headObject(key)).resolves.toEqual({
        contentLength: LAST_PART_BYTES,
      });
    });

    it('should return null from listParts after the upload is aborted, and abort again without error', async () => {
      const key = newVideoKey();
      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');

      await storage.abortMultipartUpload(key, uploadId);

      await expect(storage.listParts(key, uploadId)).resolves.toBeNull();
      await expect(
        storage.abortMultipartUpload(key, uploadId),
      ).resolves.toBeUndefined();
    });

    it('should sign part URLs for the public endpoint host', async () => {
      const key = newVideoKey();
      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');

      const url = await storage.presignUploadPart(
        key,
        uploadId,
        1,
        LAST_PART_BYTES,
        60,
      );

      expect(new URL(url).host).toBe(new URL(cfg.publicEndpoint).host);
    });

    it('should refuse a part whose body size differs from the signed length', async () => {
      const key = newVideoKey();
      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
      const url = await storage.presignUploadPart(
        key,
        uploadId,
        1,
        LAST_PART_BYTES,
        URL_TTL_SECONDS,
      );

      const larger = await putPart(url, randomBytes(LAST_PART_BYTES + 1));
      const smaller = await putPart(url, randomBytes(LAST_PART_BYTES - 1));

      expect(new URL(url).searchParams.get('X-Amz-SignedHeaders')).toContain(
        'content-length',
      );
      expect(larger.status).toBe(403);
      expect(smaller.status).toBe(403);
      await expect(storage.listParts(key, uploadId)).resolves.toEqual([]);
    });
  });

  describe('objects', () => {
    it('should return null from headObject for a missing key', async () => {
      await expect(storage.headObject(newVideoKey())).resolves.toBeNull();
    });

    it('should put an object and delete it idempotently', async () => {
      const key = `videos/${randomUUID()}/thumbnail.jpg`;
      await storage.putObject(key, randomBytes(2048), 'image/jpeg');
      await expect(storage.headObject(key)).resolves.toEqual({
        contentLength: 2048,
      });

      await storage.deleteObject(key);
      await expect(storage.headObject(key)).resolves.toBeNull();
      await expect(storage.deleteObject(key)).resolves.toBeUndefined();
    });
  });

  describe('presigned GET', () => {
    it('should answer a Range request with 206 and the requested bytes', async () => {
      const key = newVideoKey();
      const body = randomBytes(4096);
      await uploadObject(key, body);

      const url = await storage.presignGetObject(key, {
        expiresIn: URL_TTL_SECONDS,
        audience: 'client',
      });
      const res = await fetch(url, { headers: { Range: 'bytes=0-99' } });

      expect(res.status).toBe(206);
      const bytes = Buffer.from(await res.arrayBuffer());
      expect(bytes).toHaveLength(100);
      expect(bytes.equals(body.subarray(0, 100))).toBe(true);
      expect(new URL(url).host).toBe(new URL(cfg.publicEndpoint).host);
    });

    it('should return exactly the requested Content-Disposition', async () => {
      const key = newVideoKey();
      await uploadObject(key, randomBytes(128));
      const disposition =
        'attachment; filename="f_rias.mp4"; filename*=UTF-8\'\'f%C3%A9rias.mp4';

      const url = await storage.presignGetObject(key, {
        expiresIn: URL_TTL_SECONDS,
        audience: 'client',
        responseContentDisposition: disposition,
      });
      const res = await fetch(url);

      expect(res.status).toBe(200);
      expect(res.headers.get('content-disposition')).toBe(disposition);
      await res.arrayBuffer();
    });

    it('should sign internal URLs for the internal endpoint host', async () => {
      const key = newVideoKey();
      await uploadObject(key, randomBytes(128));

      const url = await storage.presignGetObject(key, {
        expiresIn: URL_TTL_SECONDS,
        audience: 'internal',
      });
      const res = await fetch(url);

      expect(new URL(url).host).toBe(new URL(cfg.endpoint).host);
      expect(res.status).toBe(200);
      await res.arrayBuffer();
    });
  });

  describe('unreachable storage', () => {
    it('should throw StorageUnavailableException when the storage refuses connections', async () => {
      const unreachable = new S3Client({
        endpoint: 'http://minio:1',
        region: cfg.region,
        forcePathStyle: true,
        credentials: {
          accessKeyId: cfg.accessKeyId,
          secretAccessKey: cfg.secretAccessKey,
        },
        maxAttempts: 1,
      });
      const offlineModule = await compileStorageModule(unreachable);
      const offlineStorage = offlineModule.get(StorageService);

      try {
        const promise = offlineStorage.createMultipartUpload(
          newVideoKey(),
          'video/mp4',
        );

        await expect(promise).rejects.toBeInstanceOf(
          StorageUnavailableException,
        );
        await expect(promise).rejects.toMatchObject({
          httpStatus: 503,
          errorCode: 'STORAGE_UNAVAILABLE',
        });
      } finally {
        await offlineModule.close();
      }
    });
  });

  describe('rejected parts on completion', () => {
    async function uploadParts(
      key: string,
      uploadId: string,
      sizes: number[],
    ): Promise<void> {
      for (const [index, size] of sizes.entries()) {
        const url = await storage.presignUploadPart(
          key,
          uploadId,
          index + 1,
          size,
          URL_TTL_SECONDS,
        );
        expect((await putPart(url, randomBytes(size))).status).toBe(200);
      }
    }

    it('should throw MultipartUploadRejectedException on EntityTooSmall', async () => {
      const key = newVideoKey();
      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
      await uploadParts(key, uploadId, [LAST_PART_BYTES, LAST_PART_BYTES]);
      const parts = await storage.listParts(key, uploadId);

      const promise = storage.completeMultipartUpload(key, uploadId, parts!);

      await expect(promise).rejects.toBeInstanceOf(
        MultipartUploadRejectedException,
      );
      await expect(promise).rejects.toMatchObject({ reason: 'EntityTooSmall' });
    });

    it('should throw MultipartUploadRejectedException on InvalidPart', async () => {
      const key = newVideoKey();
      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
      await uploadParts(key, uploadId, [LAST_PART_BYTES]);

      const promise = storage.completeMultipartUpload(key, uploadId, [
        { partNumber: 1, etag: '"0123456789abcdef0123456789abcdef"' },
      ]);

      await expect(promise).rejects.toMatchObject({
        name: MultipartUploadRejectedException.name,
        reason: 'InvalidPart',
      });
    });

    it('should throw MultipartUploadRejectedException on InvalidPartOrder', async () => {
      const key = newVideoKey();
      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
      await uploadParts(key, uploadId, [FIRST_PART_BYTES, LAST_PART_BYTES]);
      const parts = await storage.listParts(key, uploadId);

      const promise = storage.completeMultipartUpload(
        key,
        uploadId,
        [...parts!].reverse(),
      );

      await expect(promise).rejects.toMatchObject({
        name: MultipartUploadRejectedException.name,
        reason: 'InvalidPartOrder',
      });
    }, 30000);
  });

  describe('missing bucket', () => {
    let missingModule: TestingModule;
    let missingStorage: StorageService;

    beforeAll(async () => {
      missingModule = await compileStorageModule(undefined, MISSING_BUCKET);
      missingStorage = missingModule.get(StorageService);
    });

    afterAll(async () => {
      await missingModule.close();
    });

    it('should throw StorageUnavailableException from headObject instead of a missing object', async () => {
      const promise = missingStorage.headObject(newVideoKey());

      await expect(promise).rejects.toBeInstanceOf(StorageUnavailableException);
      await expect(promise).rejects.toMatchObject({
        httpStatus: 503,
        errorCode: 'STORAGE_UNAVAILABLE',
      });
    });

    it('should throw StorageUnavailableException from listParts instead of a missing upload', async () => {
      // A real upload id: MinIO validates the id before the bucket, so a
      // made-up one would answer NoSuchUpload.
      const key = newVideoKey();
      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');

      await expect(
        missingStorage.listParts(key, uploadId),
      ).rejects.toBeInstanceOf(StorageUnavailableException);
    });

    it('should throw StorageUnavailableException from abortMultipartUpload', async () => {
      const key = newVideoKey();
      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');

      await expect(
        missingStorage.abortMultipartUpload(key, uploadId),
      ).rejects.toBeInstanceOf(StorageUnavailableException);
    });
  });
});
