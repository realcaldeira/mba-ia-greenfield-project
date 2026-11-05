import {
  AbortMultipartUploadCommand,
  DeleteObjectsCommand,
  ListMultipartUploadsCommand,
  paginateListObjectsV2,
  S3Client,
} from '@aws-sdk/client-s3';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { assertTestResource } from './setup-test-env';

function createTestS3Client(cfg: ConfigType<typeof storageConfig>): S3Client {
  return new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

async function deleteAllObjects(
  client: S3Client,
  bucket: string,
): Promise<void> {
  for await (const page of paginateListObjectsV2(
    { client },
    { Bucket: bucket },
  )) {
    const objects = (page.Contents ?? []).flatMap((object) =>
      object.Key ? [{ Key: object.Key }] : [],
    );
    if (objects.length === 0) continue;

    await client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: objects, Quiet: true },
      }),
    );
  }
}

async function abortAllMultipartUploads(
  client: S3Client,
  bucket: string,
): Promise<void> {
  let keyMarker: string | undefined;
  let uploadIdMarker: string | undefined;
  let truncated = true;

  while (truncated) {
    const page = await client.send(
      new ListMultipartUploadsCommand({
        Bucket: bucket,
        KeyMarker: keyMarker,
        UploadIdMarker: uploadIdMarker,
      }),
    );

    for (const upload of page.Uploads ?? []) {
      if (!upload.Key || !upload.UploadId) continue;
      await client.send(
        new AbortMultipartUploadCommand({
          Bucket: bucket,
          Key: upload.Key,
          UploadId: upload.UploadId,
        }),
      );
    }

    truncated = page.IsTruncated === true;
    keyMarker = page.NextKeyMarker;
    uploadIdMarker = page.NextUploadIdMarker;
  }
}

// Empties the test bucket: deletes every object and aborts every in-progress
// multipart upload. Refuses to run against a bucket whose name lacks "test".
export async function emptyTestBucket(): Promise<void> {
  const cfg = storageConfig();
  assertTestResource(cfg.bucket);

  const client = createTestS3Client(cfg);
  try {
    await deleteAllObjects(client, cfg.bucket);
    await abortAllMultipartUploads(client, cfg.bucket);
  } finally {
    client.destroy();
  }
}
