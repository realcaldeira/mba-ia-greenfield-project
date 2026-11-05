import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  // Internal endpoint used for server-side operations (Compose service name).
  endpoint: process.env.S3_ENDPOINT || 'http://minio:9000',
  // Endpoint used to sign the URLs handed to clients, as the client sees the storage.
  publicEndpoint: process.env.S3_PUBLIC_ENDPOINT || 'http://minio:9000',
  region: process.env.S3_REGION || 'us-east-1',
  bucket: process.env.S3_BUCKET || 'streamtube',
  // Required by the env validation schema; no default.
  accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
}));
