import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListPartsCommand,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { Test } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { S3_INTERNAL_CLIENT, S3_SIGNING_CLIENT } from './storage.constants';
import {
  MultipartUploadMissingException,
  MultipartUploadRejectedException,
  StorageUnavailableException,
} from './storage.exceptions';
import { StorageService } from './storage.service';

function serviceError(
  name: string,
  httpStatusCode: number,
): S3ServiceException {
  return new S3ServiceException({
    name,
    $fault: httpStatusCode >= 500 ? 'server' : 'client',
    $metadata: { httpStatusCode },
    message: name,
  });
}

function connectionRefused(): Error {
  // Shape observed against an unreachable MinIO: plain Error, no HTTP status.
  return Object.assign(new Error('connect ECONNREFUSED 172.20.0.6:9000'), {
    code: 'ECONNREFUSED',
    $metadata: { attempts: 3, totalRetryDelay: 185 },
  });
}

describe('StorageService', () => {
  let service: StorageService;
  let send: jest.Mock<Promise<unknown>, [unknown]>;

  beforeEach(async () => {
    send = jest.fn<Promise<unknown>, [unknown]>();
    const moduleRef = await Test.createTestingModule({
      providers: [
        StorageService,
        { provide: S3_INTERNAL_CLIENT, useValue: { send } },
        { provide: S3_SIGNING_CLIENT, useValue: { send: jest.fn() } },
        {
          provide: storageConfig.KEY,
          useValue: { bucket: 'streamtube-test' },
        },
      ],
    }).compile();
    service = moduleRef.get(StorageService);
  });

  describe('unavailable storage', () => {
    it('should convert ECONNREFUSED into StorageUnavailableException', async () => {
      send.mockRejectedValue(connectionRefused());

      const promise = service.createMultipartUpload(
        'videos/id/original',
        'video/mp4',
      );

      await expect(promise).rejects.toBeInstanceOf(StorageUnavailableException);
      await expect(promise).rejects.toMatchObject({
        httpStatus: 503,
        errorCode: 'STORAGE_UNAVAILABLE',
      });
      expect(send.mock.calls[0][0]).toBeInstanceOf(
        CreateMultipartUploadCommand,
      );
    });

    it('should convert a socket timeout into StorageUnavailableException', async () => {
      send.mockRejectedValue(
        Object.assign(new Error('socket hang up'), { name: 'TimeoutError' }),
      );

      await expect(
        service.headObject('videos/id/original'),
      ).rejects.toBeInstanceOf(StorageUnavailableException);
    });

    it('should convert a 5xx response into StorageUnavailableException', async () => {
      send.mockRejectedValue(serviceError('InternalError', 500));

      await expect(
        service.listParts('videos/id/original', 'upload-id'),
      ).rejects.toBeInstanceOf(StorageUnavailableException);
    });

    it('should convert a 503 on a write into StorageUnavailableException', async () => {
      send.mockRejectedValue(serviceError('SlowDown', 503));

      await expect(
        service.putObject(
          'videos/id/thumbnail.jpg',
          Buffer.from('x'),
          'image/jpeg',
        ),
      ).rejects.toBeInstanceOf(StorageUnavailableException);
    });
  });

  describe('listParts pagination', () => {
    it('should follow NextPartNumberMarker only while the listing is truncated', async () => {
      send
        .mockResolvedValueOnce({
          IsTruncated: true,
          NextPartNumberMarker: '1',
          Parts: [{ PartNumber: 1, ETag: '"a"', Size: 5 }],
        })
        .mockResolvedValueOnce({
          // MinIO reports a non-empty marker on the last page.
          IsTruncated: false,
          NextPartNumberMarker: '0',
          Parts: [{ PartNumber: 2, ETag: '"b"', Size: 3 }],
        });

      const parts = await service.listParts('videos/id/original', 'upload-id');

      expect(parts).toEqual([
        { partNumber: 1, etag: '"a"', size: 5 },
        { partNumber: 2, etag: '"b"', size: 3 },
      ]);
      expect(send).toHaveBeenCalledTimes(2);
      const secondCall = send.mock.calls[1][0] as ListPartsCommand;
      expect(secondCall.input.PartNumberMarker).toBe('1');
    });
  });

  describe('not found', () => {
    it('should return null from headObject on NotFound when the bucket exists', async () => {
      send
        .mockRejectedValueOnce(serviceError('NotFound', 404))
        .mockResolvedValueOnce({});

      await expect(
        service.headObject('videos/id/original'),
      ).resolves.toBeNull();
      expect(send.mock.calls[0][0]).toBeInstanceOf(HeadObjectCommand);
      expect(send.mock.calls[1][0]).toBeInstanceOf(HeadBucketCommand);
    });

    it('should return null from headObject on NoSuchKey when the bucket exists', async () => {
      send
        .mockRejectedValueOnce(serviceError('NoSuchKey', 404))
        .mockResolvedValueOnce({});

      await expect(
        service.headObject('videos/id/original'),
      ).resolves.toBeNull();
    });

    it('should return null from listParts on NoSuchUpload', async () => {
      send.mockRejectedValue(serviceError('NoSuchUpload', 404));

      await expect(
        service.listParts('videos/id/original', 'upload-id'),
      ).resolves.toBeNull();
      expect(send.mock.calls[0][0]).toBeInstanceOf(ListPartsCommand);
    });

    it('should ignore a 404 when aborting a multipart upload', async () => {
      send.mockRejectedValue(serviceError('NoSuchUpload', 404));

      await expect(
        service.abortMultipartUpload('videos/id/original', 'upload-id'),
      ).resolves.toBeUndefined();
    });
  });

  describe('missing bucket and unexpected 404s', () => {
    it('should convert headObject NotFound into StorageUnavailableException when the bucket is missing', async () => {
      // HEAD 404s have no body: a missing bucket also surfaces as NotFound.
      send
        .mockRejectedValueOnce(serviceError('NotFound', 404))
        .mockRejectedValueOnce(serviceError('NotFound', 404));

      await expect(
        service.headObject('videos/id/original'),
      ).rejects.toBeInstanceOf(StorageUnavailableException);
      expect(send.mock.calls[1][0]).toBeInstanceOf(HeadBucketCommand);
    });

    it('should convert listParts NoSuchBucket into StorageUnavailableException', async () => {
      send.mockRejectedValue(serviceError('NoSuchBucket', 404));

      await expect(
        service.listParts('videos/id/original', 'upload-id'),
      ).rejects.toBeInstanceOf(StorageUnavailableException);
    });

    it('should convert any other listParts 404 into StorageUnavailableException', async () => {
      send.mockRejectedValue(serviceError('NotFound', 404));

      await expect(
        service.listParts('videos/id/original', 'upload-id'),
      ).rejects.toBeInstanceOf(StorageUnavailableException);
    });

    it('should convert abortMultipartUpload NoSuchBucket into StorageUnavailableException', async () => {
      send.mockRejectedValue(serviceError('NoSuchBucket', 404));

      await expect(
        service.abortMultipartUpload('videos/id/original', 'upload-id'),
      ).rejects.toBeInstanceOf(StorageUnavailableException);
    });

    it('should convert an unreachable storage on abortMultipartUpload into StorageUnavailableException', async () => {
      send.mockRejectedValue(connectionRefused());

      await expect(
        service.abortMultipartUpload('videos/id/original', 'upload-id'),
      ).rejects.toBeInstanceOf(StorageUnavailableException);
    });
  });

  describe('completeMultipartUpload rejected parts', () => {
    it.each(['EntityTooSmall', 'InvalidPart', 'InvalidPartOrder'])(
      'should convert %s into MultipartUploadRejectedException',
      async (code) => {
        send.mockRejectedValue(serviceError(code, 400));

        const promise = service.completeMultipartUpload(
          'videos/id/original',
          'upload-id',
          [{ partNumber: 1, etag: '"etag"' }],
        );

        await expect(promise).rejects.toBeInstanceOf(
          MultipartUploadRejectedException,
        );
        await expect(promise).rejects.toMatchObject({ reason: code });
        expect(send.mock.calls[0][0]).toBeInstanceOf(
          CompleteMultipartUploadCommand,
        );
      },
    );

    it('should convert NoSuchUpload on completion into MultipartUploadMissingException', async () => {
      send.mockRejectedValue(serviceError('NoSuchUpload', 404));

      await expect(
        service.completeMultipartUpload('videos/id/original', 'upload-id', [
          { partNumber: 1, etag: '"etag"' },
        ]),
      ).rejects.toBeInstanceOf(MultipartUploadMissingException);
    });

    it('should convert a 5xx on completion into StorageUnavailableException', async () => {
      send.mockRejectedValue(serviceError('InternalError', 500));

      await expect(
        service.completeMultipartUpload('videos/id/original', 'upload-id', [
          { partNumber: 1, etag: '"etag"' },
        ]),
      ).rejects.toBeInstanceOf(StorageUnavailableException);
    });
  });

  describe('other client errors', () => {
    it('should rethrow a 403 as is', async () => {
      const forbidden = serviceError('AccessDenied', 403);
      send.mockRejectedValue(forbidden);

      await expect(service.headObject('videos/id/original')).rejects.toBe(
        forbidden,
      );
    });

    it('should rethrow a 404 from a write that is not a read', async () => {
      const noSuchKey = serviceError('NoSuchKey', 404);
      send.mockRejectedValue(noSuchKey);

      await expect(
        service.completeMultipartUpload('videos/id/original', 'upload-id', [
          { partNumber: 1, etag: '"etag"' },
        ]),
      ).rejects.toBe(noSuchKey);
    });

    it('should rethrow an error unrelated to the storage call as is', async () => {
      const bug = new TypeError('unexpected');
      send.mockRejectedValue(bug);

      await expect(
        service.createMultipartUpload('videos/id/original', 'video/mp4'),
      ).rejects.toBe(bug);
    });
  });
});
