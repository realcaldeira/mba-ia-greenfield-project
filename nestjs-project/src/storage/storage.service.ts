import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  type HeadObjectCommandOutput,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { S3_INTERNAL_CLIENT, S3_SIGNING_CLIENT } from './storage.constants';
import {
  MultipartUploadMissingException,
  MultipartUploadRejectedException,
  StorageUnavailableException,
} from './storage.exceptions';

export interface UploadedPart {
  partNumber: number;
  etag: string;
  size: number;
}

export type CompletedPartRef = Pick<UploadedPart, 'partNumber' | 'etag'>;

// 'client': URLs handed to API clients (parts, stream, download, thumbnail).
// 'internal': URLs read from inside the Compose network (ffprobe/ffmpeg).
export type PresignAudience = 'client' | 'internal';

export interface PresignGetObjectOptions {
  expiresIn: number;
  audience: PresignAudience;
  responseContentDisposition?: string;
}

const HTTP_NOT_FOUND = 404;
const HTTP_SERVER_ERROR = 500;

// Errors raised before any HTTP response arrives (connection refused, DNS, socket timeouts).
const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
]);
const TIMEOUT_ERROR_NAMES = new Set(['TimeoutError', 'RequestTimeout']);

// SDK error names (the S3 error code) that mean "this resource does not exist"
// for one operation. Any other 404 (NoSuchBucket above all) is an outage or a
// misconfiguration, never a missing upload or object.
const MISSING_UPLOAD_ERRORS = ['NoSuchUpload'] as const;
// A HEAD 404 has no body, so the SDK names it `NotFound` (NoSuchKey covers a
// storage that does send the code).
const MISSING_OBJECT_ERRORS = ['NotFound', 'NoSuchKey'] as const;
const MISSING_BUCKET_ERROR = 'NoSuchBucket';
// CompleteMultipartUpload refusing the listed parts: client errors (4xx).
const REJECTED_PARTS_ERRORS = [
  'EntityTooSmall',
  'InvalidPart',
  'InvalidPartOrder',
] as const;

interface SdkErrorFields {
  name?: unknown;
  code?: unknown;
  $metadata?: { httpStatusCode?: number };
}

function httpStatusOf(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  return (err as SdkErrorFields).$metadata?.httpStatusCode;
}

function isUnavailable(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const status = httpStatusOf(err);
  if (status !== undefined) return status >= HTTP_SERVER_ERROR;

  const { name, code, $metadata } = err as SdkErrorFields;
  // The SDK attaches $metadata (attempts, retry delay) even when no response came back.
  return (
    $metadata !== undefined ||
    (typeof code === 'string' && NETWORK_ERROR_CODES.has(code)) ||
    (typeof name === 'string' && TIMEOUT_ERROR_NAMES.has(name))
  );
}

function errorNameOf(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const { name } = err as SdkErrorFields;
  return typeof name === 'string' ? name : undefined;
}

function hasErrorName(err: unknown, names: readonly string[]): boolean {
  const name = errorNameOf(err);
  return name !== undefined && names.includes(name);
}

@Injectable()
export class StorageService {
  private readonly bucket: string;

  constructor(
    @Inject(S3_INTERNAL_CLIENT) private readonly internalClient: S3Client,
    @Inject(S3_SIGNING_CLIENT) private readonly signingClient: S3Client,
    @Inject(storageConfig.KEY) config: ConfigType<typeof storageConfig>,
  ) {
    this.bucket = config.bucket;
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const { UploadId } = await this.call(() =>
      this.internalClient.send(
        new CreateMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          ContentType: contentType,
        }),
      ),
    );
    if (!UploadId) {
      throw new Error(`CreateMultipartUpload returned no UploadId for ${key}`);
    }
    return UploadId;
  }

  // Returns null when the multipart upload no longer exists (completed, aborted or expired).
  // Paginates by IsTruncated instead of paginateListParts: MinIO answers a
  // complete listing with NextPartNumberMarker "0", which the paginator follows forever.
  async listParts(
    key: string,
    uploadId: string,
  ): Promise<UploadedPart[] | null> {
    const parts: UploadedPart[] = [];
    let partNumberMarker: string | undefined;
    try {
      for (;;) {
        const page = await this.internalClient.send(
          new ListPartsCommand({
            Bucket: this.bucket,
            Key: key,
            UploadId: uploadId,
            PartNumberMarker: partNumberMarker,
          }),
        );
        for (const part of page.Parts ?? []) {
          parts.push({
            partNumber: part.PartNumber ?? 0,
            etag: part.ETag ?? '',
            size: part.Size ?? 0,
          });
        }
        if (page.IsTruncated !== true || !page.NextPartNumberMarker) break;
        partNumberMarker = page.NextPartNumberMarker;
      }
    } catch (err) {
      if (hasErrorName(err, MISSING_UPLOAD_ERRORS)) return null;
      throw this.mapReadError(err);
    }
    return parts;
  }

  // EntityTooSmall, InvalidPart and InvalidPartOrder become
  // MultipartUploadRejectedException: the parts are wrong, the storage is fine.
  // NoSuchUpload becomes MultipartUploadMissingException: the upload is gone
  // (consumed by a concurrent completion or aborted).
  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPartRef[],
  ): Promise<void> {
    try {
      await this.internalClient.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: parts.map(({ partNumber, etag }) => ({
              PartNumber: partNumber,
              ETag: etag,
            })),
          },
        }),
      );
    } catch (err) {
      const name = errorNameOf(err);
      if (name !== undefined && hasErrorName(err, REJECTED_PARTS_ERRORS)) {
        throw new MultipartUploadRejectedException(name);
      }
      if (hasErrorName(err, MISSING_UPLOAD_ERRORS)) {
        throw new MultipartUploadMissingException();
      }
      throw this.mapError(err);
    }
  }

  // Idempotent: an upload that no longer exists is already in the desired state.
  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    try {
      await this.internalClient.send(
        new AbortMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
        }),
      );
    } catch (err) {
      if (hasErrorName(err, MISSING_UPLOAD_ERRORS)) return;
      throw this.mapError(err);
    }
  }

  // Returns null only when the key is missing from an existing bucket.
  async headObject(key: string): Promise<{ contentLength: number } | null> {
    let head: HeadObjectCommandOutput;
    try {
      head = await this.internalClient.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
    } catch (err) {
      if (!hasErrorName(err, MISSING_OBJECT_ERRORS)) {
        throw this.mapReadError(err);
      }
      // The bodiless HEAD 404 is `NotFound` for a missing key and for a
      // missing bucket alike; HeadBucket tells them apart.
      await this.assertBucketExists();
      return null;
    }
    return { contentLength: head.ContentLength ?? 0 };
  }

  // Idempotent: deleting a missing key succeeds on S3-compatible storage.
  async deleteObject(key: string): Promise<void> {
    await this.call(() =>
      this.internalClient.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
      ),
    );
  }

  async putObject(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.call(() =>
      this.internalClient.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          ContentLength: body.length,
        }),
      ),
    );
  }

  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresIn: number,
  ): Promise<string> {
    return getSignedUrl(
      this.signingClient,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn },
    );
  }

  async presignGetObject(
    key: string,
    options: PresignGetObjectOptions,
  ): Promise<string> {
    const client =
      options.audience === 'client' ? this.signingClient : this.internalClient;
    return getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: options.responseContentDisposition,
      }),
      { expiresIn: options.expiresIn },
    );
  }

  private async call<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (err) {
      throw this.mapError(err);
    }
  }

  private async assertBucketExists(): Promise<void> {
    try {
      await this.internalClient.send(
        new HeadBucketCommand({ Bucket: this.bucket }),
      );
    } catch (err) {
      throw this.mapReadError(err);
    }
  }

  // Unreachable storage, 5xx and a missing bucket become STORAGE_UNAVAILABLE;
  // other errors keep their identity.
  private mapError(err: unknown): unknown {
    return isUnavailable(err) || hasErrorName(err, [MISSING_BUCKET_ERROR])
      ? new StorageUnavailableException()
      : err;
  }

  // For reads whose expected "missing" answer was already handled: any other
  // 404 means the storage is not the one configured, not a missing resource.
  private mapReadError(err: unknown): unknown {
    return httpStatusOf(err) === HTTP_NOT_FOUND
      ? new StorageUnavailableException()
      : this.mapError(err);
  }
}
